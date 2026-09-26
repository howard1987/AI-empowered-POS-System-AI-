/**
 * M5a · 动态定价（临期 / 滞销 合并调价建议，含成本底线）
 *   GET  /ai/pricing/suggestions —— 生成建议（规则引擎，零依赖）：
 *     临期：在库批次剩余保质期 ≤ ai.pricing.expiry_days（默认 30 天），按紧急度折价
 *           ≤7 天 5 折 · ≤15 天 7 折 · 其余 8.5 折
 *     滞销：近 ai.pricing.stale_days（默认 60）天无销售 且 在库量 ≥ stale_qty（默认 30）件
 *     成本底线：建议价 ≥ 进价 × (1 + ai.pricing.min_margin)（默认 5%），无进价时不低于 1 元
 *   POST /ai/pricing/apply —— 勾选建议 → 生成调价草稿（price_changes，status=pending，待审核生效）
 *   执行权在人：建议仅生成草稿，审核流与人工调价一致（pos.price.manual 审核）
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { PRODUCT_VISIBLE } from '../common/sql';   // V5.0.0 商品可售可见性
import { BizException } from '../common/http';
import { q, tx, audit } from '../common/db';

async function getSetting(key: string, fb: any = null): Promise<any> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
  return r.length ? r[0].value : fb;
}

/** 商品最近进价基线（默认供应商，无则 0） */
const LAST_COST = `COALESCE((SELECT price FROM supplier_product_prices spp
   WHERE spp.product_id = p.id AND spp.supplier_id = p.supplier_default_id
   ORDER BY spp.id DESC LIMIT 1), 0)`;

@Controller('ai/pricing')
export class AiPricingController {
  /** 生成调价建议：临期 + 滞销（同一商品已临期则不重复进滞销） */
  @Get('suggestions')
  @RequirePerms('ai.decision')
  async suggestions(@CurrentUser() u: AuthUser) {
    const expiryDays = Number(await getSetting('ai.pricing.expiry_days', 30) ?? 30);
    const staleDays = Number(await getSetting('ai.pricing.stale_days', 60) ?? 60);
    const staleQty = Number(await getSetting('ai.pricing.stale_qty', 30) ?? 30);
    const minMargin = Number(await getSetting('ai.pricing.min_margin', 0.05) ?? 0.05);
    // V4.28.6：临期档位允许低于进价（去化优先）——开=临期建议不设成本底线；滞销类始终维持成本底线
    const expiryBelowCost = String(await getSetting('ai.pricing.expiry_below_cost', true)) !== 'false';
    // V4.28.7：临期折扣档位统一读「临期自动折扣档位」（promo.expiry_auto_discount，[{days,pct}]，
    //  pct 为百分数 80=8 折；营销与线上组同一键，收银自动折扣与 AI 调价建议共用一份数据源）。
    //  非法/未配置回落内置默认档；pct<=0 或 >=100 的档位丢弃防 0 元/负价。
    let tiers: { maxDays: number; rate: number }[] = [];
    try {
      const raw = await getSetting('promo.expiry_auto_discount', null);
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(arr)) {
        tiers = arr
          .map((t: any) => ({ maxDays: Number(t?.days), rate: Number(t?.pct) / 100 }))
          .filter(t => Number.isFinite(t.maxDays) && t.maxDays >= 0 && t.rate > 0 && t.rate < 1)
          .sort((a, b) => a.maxDays - b.maxDays);
      }
    } catch { /* 格式错误回落默认档 */ }
    if (!tiers.length) tiers = [{ maxDays: 1, rate: 0.7 }, { maxDays: 3, rate: 0.8 }];
    /** 命中最先满足 days≤maxDays 的档；超出全部档位按最深折扣兜底 */
    const rateFor = (days: number) => (tiers.find(t => days <= t.maxDays) ?? tiers[tiers.length - 1]).rate;

    // ── 临期：在库批次剩余保质期 ≤ 阈值，按批次聚到商品 ──
    const exp = await q(
      `SELECT b.product_id, p.name, p.barcode, p.sell_price,
              COALESCE(SUM(b.remain_qty),0) AS stock,
              MIN(b.expiry_date) AS nearest_expiry,
              (MIN(b.expiry_date) - CURRENT_DATE) AS days_left,
              ${LAST_COST} AS last_cost
         FROM batches b JOIN products p ON p.id = b.product_id
        WHERE b.store_id=$1 AND b.status='在库' AND b.remain_qty > 0
          AND b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int
        GROUP BY b.product_id, p.id, p.name, p.barcode, p.sell_price, p.supplier_default_id
        ORDER BY days_left ASC LIMIT 200`, [u.storeId, expiryDays]);

    // ── 滞销：近 N 天无销售 且 在库量 ≥ 阈值（排除已临期商品）──
    const stale = await q(
      `SELECT p.id AS product_id, p.name, p.barcode, p.sell_price, ic.qty_total AS stock,
              ${LAST_COST} AS last_cost
         FROM products p JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = $1
        WHERE ${PRODUCT_VISIBLE('$1')} AND p.status=1 AND p.deleted_at IS NULL
          AND ic.qty_total >= $2
          AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales_orders so ON so.id = si.order_id
                           WHERE so.store_id=$1 AND si.product_id = p.id AND so.status='已完成'
                             AND so.created_at >= CURRENT_DATE - $3::int)
          AND NOT EXISTS (SELECT 1 FROM batches b
                           WHERE b.product_id = p.id AND b.status='在库' AND b.remain_qty > 0
                             AND b.expiry_date <= CURRENT_DATE + $4::int)
        ORDER BY ic.qty_total DESC LIMIT 200`, [u.storeId, staleQty, staleDays, expiryDays]);

    const suggestions: any[] = [];
    const seen = new Set<number>();
    const push = (r: any, type: string, reason: string, rate: number, daysLeft: number | null, belowCostOk = false) => {
      const productId = Number(r.product_id);
      if (seen.has(productId)) return;
      const sellPrice = Number(r.sell_price);
      const lastCost = Number(r.last_cost ?? 0);
      // V4.28.6：belowCostOk（临期档位）→ 不设成本底线，仅保底 0.01 元防 0 元价；滞销类维持进价×(1+min_margin)
      const floor = belowCostOk ? 0.01
        : (lastCost > 0 ? Math.round(lastCost * (1 + minMargin) * 100) / 100 : 1);
      let suggested = Math.round(sellPrice * rate * 100) / 100;
      if (suggested < floor) suggested = floor;
      if (suggested >= sellPrice) return;          // 无降价空间（已低于底线或折扣不划算）
      seen.add(productId);
      suggestions.push({
        id: `${type}-${productId}`, type,
        productId, name: String(r.name), barcode: String(r.barcode || ''),
        sellPrice, suggestedPrice: suggested, floorPrice: floor,
        stock: Number(r.stock), daysLeft, lastCost,
        reason, atFloor: suggested === floor,
        impact: Math.round((sellPrice - suggested) * Number(r.stock) * 100) / 100,
      });
    };
    for (const r of exp as any[]) {
      const days = Number(r.days_left);
      push(r, 'expiry', `临期 ${days} 天（批次 ${String(r.nearest_expiry).slice(0, 10)}）` + (expiryBelowCost ? '·可低于进价' : ''),
        rateFor(days), days, expiryBelowCost);
    }
    for (const r of stale as any[]) {
      push(r, 'stale', `滞销：${staleDays} 天无销售 · 在库 ${r.stock} 件`, 0.8, null);
    }
    return {
      thresholds: { expiryDays, staleDays, staleQty, minMargin,
                    expiryTiers: tiers.map(t => ({ maxDays: t.maxDays, rate: Math.round(t.rate * 100) })) },
      count: suggestions.length,
      impactTotal: Math.round(suggestions.reduce((s, x) => s + x.impact, 0) * 100) / 100,
      suggestions,
    };
  }

  /** 应用建议 → 生成调价草稿（待审核；应用时重新计算，防止价格已变） */
  @Post('apply')
  @RequirePerms('ai.decision')
  async apply(@Body() b: { ids: string[] }, @CurrentUser() u: AuthUser) {
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
    if (!ids.length) throw new BizException(40003, '请勾选至少一条调价建议');
    const sug = await this.suggestions(u);
    const want = new Map(sug.suggestions.map((s: any) => [s.id, s]));
    const items: { productId: number; newPrice: number }[] = [];
    for (const id of ids) {
      const s = want.get(id);
      if (s) items.push({ productId: s.productId, newPrice: s.suggestedPrice });
    }
    if (!items.length) throw new BizException(40003, '所选建议已失效（价格变化），请刷新后重试');

    return tx(async c => {
      const cx = (sql: string, p: any[] = []) => c.query(sql, p).then((x: any) => x.rows);
      const prod = await cx(`SELECT id, name, sell_price FROM products WHERE id = ANY($1) FOR UPDATE`, [items.map(i => i.productId)]);
      const byId = new Map<number, any>(prod.map((r: any) => [Number(r.id), r] as [number, any]));
      const norm = items.filter(i => byId.has(i.productId)).filter(i => Number(byId.get(i.productId).sell_price) !== Number(i.newPrice));
      if (!norm.length) throw new BizException(40003, '所选商品现售价已与建议价一致，无需调价');
      let diffTotal = 0;
      for (const it of norm) diffTotal += Number(it.newPrice) - Number(byId.get(it.productId).sell_price);
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const seq = await cx(`SELECT count(*)+1 AS n FROM price_changes WHERE pc_no LIKE $1`, [`TJ-${ym}-%`]);
      const no = `TJ-${ym}-${String(seq[0].n).padStart(3, '0')}`;
      const head = await cx(
        `INSERT INTO price_changes (pc_no, effective_date, remark, item_count, diff_total, created_by, price_type, status)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, 'sale', 'pending') RETURNING id, pc_no`,
        [no, `AI动态定价（${norm.length} 项：临期/滞销）`, norm.length, diffTotal.toFixed(2), u.sub ?? null]);
      const cid = Number(head[0].id);
      for (const it of norm) {
        const p = byId.get(it.productId);
        await cx(
          `INSERT INTO price_change_items (change_id, product_id, old_price, new_price)
           VALUES ($1,$2,$3,$4)`,
          [cid, it.productId, Number(p.sell_price), it.newPrice]);
      }
      await audit(u.storeId, u.sub, 'AI', 'ai.pricing.apply', 'price_change', cid,
        { pcNo: no, count: norm.length, diff: diffTotal.toFixed(2) });
      return { ok: true, changeId: cid, pcNo: no, itemCount: norm.length, diffTotal: Math.round(diffTotal * 100) / 100,
               status: 'pending', note: `已生成调价草稿 ${no}（待审核生效）` };
    });
  }
}
