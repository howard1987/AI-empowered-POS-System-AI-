/**
 * 智能决策中心引擎（9.8 五步闭环：数据沉淀 → 知识构建 → 智能决策 → 效果回收 → 再训练）
 *   - 轻量规则引擎：纯 SQL + 统计（零依赖、可解释、数据不出店）；Ollama 本地大模型为可选底座（ai.llm.enabled）
 *   - 9 项应用：补货 / 会员推送 / 销售预测 / 定价促销 / 损耗临期 / 购物篮关联 / 自然语言问答 / 防损基线 / AI 日报
 *   - 建议一律"辅助决策"：下单权/定价权/发送权在人（5.2.8 边界）；否决也是训练信号（reject_reason 留痕）
 *   - 去重：同域每天只产出一批「待处理」建议（当日循环），执行/否决后次日可再生成
 */
import { q, q1, r2, tx, cx, audit } from '../common/db';
import { BizException } from '../common/http';
import { getWeather, factorsOf } from './weather.service';
import { PRODUCT_VISIBLE } from '../common/sql';   // V5.0.0 商品可售可见性（连锁：门店只看已下发）

const SQL_ORDER_DONE = `status IN ('已完成','部分退款')`;
const fmtD = (v: any): string => {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};

export class AibrainEngine {
  /* ── 公共工具 ── */
  private static async setting(key: string, fb: any = null): Promise<any> {
    const r = await q1<{ value: any }>(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
    return r ? r.value : fb;
  }

  /** 当天该域是否已有一批「待处理」建议（当日去重，避免重复堆积） */
  private static async hasPending(storeId: number, domain: string): Promise<boolean> {
    const r = await q1(`SELECT 1 FROM ai_suggestions
      WHERE store_id=$1 AND domain=$2 AND status='待处理' AND created_at::date=CURRENT_DATE LIMIT 1`, [storeId, domain]);
    return !!r;
  }

  private static async suggest(storeId: number, domain: string, payload: any,
                               reason: any, confidence?: number, bizRefType?: string | null, bizRefId?: number | null) {
    const ins = await q(
      `INSERT INTO ai_suggestions (store_id, domain, payload, reason, confidence, biz_ref_type, biz_ref_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [storeId, domain, JSON.stringify(payload), JSON.stringify(reason),
       confidence ?? null, bizRefType ?? null, bizRefId ?? null]);
    return Number(ins[0].id);
  }

  /* ═══ P7 决策自动化：成熟度统计（分域采纳率，连续达标周数达标 → 解锁全自动） ═══ */
  static async maturity(storeId: number) {
    const th = (await this.setting('ai.decision.maturity', null)) || { minAcceptRate: 70, minWeeks: 2, minDecided: 5 };
    const out: any[] = [];
    for (const domain of ['补货', '定价']) {
      const rows = await q<any>(
        `SELECT date_trunc('week', decided_at)::date AS wk,
                count(*)::int AS decided, count(*) FILTER (WHERE status='已执行')::int AS accepted
           FROM ai_suggestions
          WHERE store_id=$1 AND domain=$2 AND status IN ('已执行','已否决') AND decided_at >= now() - interval '28 days'
          GROUP BY 1 ORDER BY 1`, [storeId, domain]);
      const weeks = rows.map(r => ({ week: fmtD(r.wk), decided: Number(r.decided),
                                     rate: Number(r.decided) > 0 ? r2(Number(r.accepted) / Number(r.decided) * 100) : null }));
      const decided = weeks.reduce((a, w) => a + w.decided, 0);
      const acceptRate = decided > 0
        ? r2(weeks.reduce((a, w) => a + w.decided * ((w.rate ?? 0) / 100), 0) / decided * 100) : null;
      // 连续达标周：从最近一周往回数（该周有决策且采纳率 ≥ 门槛）
      let consec = 0;
      for (let i = weeks.length - 1; i >= 0; i--) {
        const w = weeks[i];
        if (w.decided > 0 && (w.rate ?? 0) >= Number(th.minAcceptRate ?? 70)) consec++;
        else break;
      }
      const unlocked = decided >= Number(th.minDecided ?? 5)
        && (acceptRate ?? 0) >= Number(th.minAcceptRate ?? 70)
        && consec >= Number(th.minWeeks ?? 2);
      out.push({ domain, decided, acceptRate, weeks, consecutiveWeeks: consec, unlocked });
    }
    return { thresholds: th, domains: out };
  }

  /* ═══ P7 决策自动化：执行建议（人工执行与全自动共用；userId=null 表示系统自动执行） ═══
   *  补货 → 生成采购单（source=补货建议）；定价 → 按确认价改售价。
   *  全程记 rollback_json 回滚快照（定价=改前原价清单；补货=采购单号），支持一键回滚。 */
  static async executeSuggestion(storeId: number, id: number, userId: number | null,
                                 override?: any, learning?: { title?: string; content?: string }):
                                 Promise<{ ok: boolean; note: string; bizRefId: number | null }> {
    return tx(async c => {
      const r = await cx(c, `SELECT * FROM ai_suggestions WHERE id=$1 FOR UPDATE`, [id]);
      if (!r.length) throw new BizException(40404, '建议不存在', 404);
      const s = r[0];
      if (s.status !== '待处理') throw new BizException(40003, `建议已${s.status}，不能重复处理`);
      const ov = override && typeof override === 'object' ? override : null;
      let bizRefType: string | null = s.biz_ref_type ?? null;
      let bizRefId: number | null = s.biz_ref_id ? Number(s.biz_ref_id) : null;
      let rollbackJson: any = null;
      let execNote = '';
      if (s.domain === '补货') {
        const items: any[] = ov?.items ?? s.payload?.items ?? [];
        if (!items.length) throw new BizException(40003, '补货建议无明细，无法生成采购单');
        const sup = await cx(c, `SELECT id FROM suppliers WHERE store_id=$1 ORDER BY id LIMIT 1`, [storeId]);
        if (!sup.length) throw new BizException(40404, '尚未建档供应商，请先在采购模块添加', 404);
        const day = fmtD(new Date()).replace(/-/g, '');
        const seq = await cx(c, `SELECT count(*)+1 AS n FROM purchase_orders WHERE po_no LIKE $1`, [`CG-${day}-%`]);
        const poNo = `CG-${day}-${String(Number(seq[0].n)).padStart(3, '0')}`;
        const totalQty = r2(items.reduce((a, i) => a + Number(i.actualQty ?? i.suggestQty ?? 0), 0));
        const po = await cx(c,
          `INSERT INTO purchase_orders (store_id, po_no, supplier_id, status, source, suggest_meta, total_amount, total_qty, remark)
           VALUES ($1,$2,$3,'已下单','补货建议',$4,NULL,$5,$6) RETURNING id`,
          [storeId, poNo, Number(sup[0].id), JSON.stringify(s.reason ?? {}), totalQty,
           `由智能决策中心补货建议执行生成（建议 #${s.id}${userId == null ? '，系统自动执行' : ''}）`]);
        bizRefType = 'purchase_order';
        bizRefId = Number(po[0].id);
        rollbackJson = { poId: bizRefId, poNo };
        for (const it of items) {
          await cx(c,
            `INSERT INTO purchase_order_items (po_id, product_id, order_qty, price, suggest_factor)
             SELECT $1,$2,$3,p.sell_price,jsonb_build_object('suggestId',$4::int) FROM products p WHERE p.id=$2`,
            [bizRefId, Number(it.productId), Number(it.actualQty ?? it.suggestQty ?? 0), s.id]);
        }
        execNote = `已生成采购单 ${poNo}（${items.length} 项 / ${totalQty} 件）`;
      } else if (s.domain === '定价') {
        const items: any[] = ov?.items ?? s.payload?.items ?? [];
        let changed = 0; const skip: string[] = []; const rollbackItems: any[] = [];
        for (const it of items) {
          const ap = Number(it.actualPrice ?? it.suggestPrice ?? NaN);
          const orig = Number(it.sellPrice ?? 0);
          if (!Number.isFinite(ap) || ap <= 0 || ap >= orig) { skip.push(String(it.name || it.productId)); continue; }
          const cur = await cx(c, `SELECT sell_price FROM products WHERE id=$1`, [Number(it.productId)]);
          rollbackItems.push({ productId: Number(it.productId), name: it.name, oldPrice: Number(cur[0]?.sell_price ?? orig), newPrice: r2(ap) });
          await cx(c, `UPDATE products SET sell_price=$2, updated_at=now() WHERE id=$1`, [Number(it.productId), r2(ap)]);
          changed++;
        }
        rollbackJson = rollbackItems.length ? { items: rollbackItems } : null;
        execNote = changed
          ? `已按确认价更新 ${changed} 个商品售价${skip.length ? `；${skip.length} 项未改（${skip.slice(0, 3).join('、')}${skip.length > 3 ? ' 等' : ''}）` : ''}`
          : '无有效改价行（实际价未低于原售价），仅留痕';
      } else if (s.domain === '营销推送') {
        execNote = '已按建议人群标记（发送权在人，可至营销模块确认触达）';
      } else {
        execNote = '建议已执行（供决策留痕）';
      }
      if (ov) await cx(c, `UPDATE ai_suggestions SET payload = payload || $2::jsonb WHERE id=$1`, [id, JSON.stringify({ final: ov })]);
      await cx(c,
        `UPDATE ai_suggestions SET status='已执行', decided_by=$2, decided_at=now(), biz_ref_type=$3, biz_ref_id=$4,
                auto_executed=$5, rollback_json=$6::jsonb WHERE id=$1`,
        [id, userId, bizRefType, bizRefId, userId == null, rollbackJson ? JSON.stringify(rollbackJson) : null]);
      // 执行学习进知识库（人工执行时由前端回传学习摘要；自动执行不产生学习摘要）
      const learn = learning?.content?.trim();
      if (learn) {
        const title = (learning?.title || `建议 #${s.id} 执行学习`).slice(0, 128);
        const doc = await cx(c,
          `INSERT INTO ai_kb_documents (store_id, title, source_type, content_text, status)
           VALUES ($1,$2,'执行学习',$3,'已收录') RETURNING id`, [storeId, title, learn.slice(0, 20000)]);
        for (let i = 1, no = 1; i <= learn.length; i += 500, no++) {
          await cx(c, `INSERT INTO ai_kb_chunks (document_id, chunk_no, content) VALUES ($1,$2,$3)
                       ON CONFLICT (document_id, chunk_no) DO NOTHING`, [Number(doc[0].id), no, learn.slice(i - 1, i - 1 + 500)]);
        }
      }
      return { ok: true, note: execNote, bizRefId };
    });
  }

  /** ═══ P7 决策自动化：建议生成后按三档开关处置 ═══
   *  手动确认/半自动 → 保持「待处理」（半自动=草稿待确认，即现状流程）；
   *  全自动 且 成熟度解锁 → 直接执行（留痕 auto_executed=true + rollback_json 可一键回滚）；
   *  全自动 但 未解锁 → 回写提示，本轮保持人工确认。 */
  static async autoMaybe(storeId: number, suggestionId: number, domain: string): Promise<void> {
    try {
      const modes = (await this.setting('ai.decision.modes', null)) || {};
      if (String(modes[domain] ?? '手动确认') !== '全自动') return;
      const mat = await this.maturity(storeId);
      const d = mat.domains.find((x: any) => x.domain === domain);
      if (!d?.unlocked) {
        await q(`UPDATE ai_suggestions SET reason = reason || $2::jsonb WHERE id=$1`,
          [suggestionId, JSON.stringify({ autoNote: `已设「全自动」，但成熟度未解锁（采纳率 ${d?.acceptRate ?? '—'}%、连续达标 ${d?.consecutiveWeeks ?? 0} 周），本轮保持人工确认` })]);
        return;
      }
      const r = await this.executeSuggestion(storeId, suggestionId, null);
      await q(`UPDATE ai_suggestions SET payload = payload || $2::jsonb WHERE id=$1`,
        [suggestionId, JSON.stringify({ autoExecNote: r.note })]);
    } catch (e: any) {
      console.error('[决策中心] 自动执行失败:', e.message);   // 自动执行失败不阻断建议生成
    }
  }

  /** ═══ P7 决策自动化回滚：全自动（或人工）执行后一键撤销 ═══
   *  定价 → 按回滚快照还原原售价；补货 → 取消未到货采购单；已开始到货则提示人工处理。 */
  static async rollbackSuggestion(storeId: number, id: number, userId: number): Promise<{ ok: boolean; note: string }> {
    const s = await q1<any>(`SELECT * FROM ai_suggestions WHERE id=$1 AND store_id=$2`, [id, storeId]);
    if (!s) throw new BizException(40404, '建议不存在', 404);
    if (s.status !== '已执行') throw new BizException(40003, '仅「已执行」建议可回滚');
    if (s.rolled_back_at) throw new BizException(40003, '该建议已回滚，不可重复回滚');
    const rb = s.rollback_json ?? {};
    let note = '';
    if (s.domain === '定价' && Array.isArray(rb.items) && rb.items.length) {
      for (const it of rb.items) {
        await q(`UPDATE products SET sell_price=$2, updated_at=now() WHERE id=$1`, [Number(it.productId), Number(it.oldPrice)]);
      }
      note = `已还原 ${rb.items.length} 个商品原售价`;
    } else if (s.domain === '补货' && rb.poId) {
      const r = await q(`UPDATE purchase_orders SET status='已取消' WHERE id=$1 AND status='已下单' RETURNING po_no`, [Number(rb.poId)]);
      note = r.length ? `已取消采购单 ${r[0].po_no}（未到货）` : '采购单已开始到货，无法自动取消（请人工在采购模块处理）';
    } else {
      note = '无回滚快照（早期建议未记录回滚数据），请人工核对处理';
    }
    await q(`UPDATE ai_suggestions SET rolled_back_at=now() WHERE id=$1`, [id]);
    await audit(storeId, userId, 'AI', 'brain.suggest.rollback', 'ai_suggestion', id, { domain: s.domain, note });
    return { ok: true, note };
  }

  /* ═══ 1. 📦 智能补货（预测版 5.2.8）：安全库存法 + 在途扣减 + 覆盖天数 ═══ */
  static async restock(storeId: number): Promise<{ count: number; items: any[] }> {
    if (await this.hasPending(storeId, '补货')) return { count: 0, items: [] };
    const coverage = Number(await this.setting('ai.restock.coverage_days', 7) ?? 7);
    const safety = Number(await this.setting('ai.restock.safety_days', 1.5) ?? 1.5);
    const sales = await q<any>(
      `SELECT si.product_id AS pid, p.name, p.sell_price, COALESCE(SUM(si.qty),0) AS qty,
              COUNT(DISTINCT so.created_at::date) AS active_days
         FROM sale_items si
         JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE} AND so.created_at >= CURRENT_DATE - $2::int
         JOIN products p ON p.id=si.product_id AND p.status=1
        WHERE so.store_id=$1
        GROUP BY si.product_id, p.name, p.sell_price`, [storeId, coverage]);
    if (!sales.length) return { count: 0, items: [] };
    const ids = sales.map(s => s.pid);
    const stock = await q<any>(
      `SELECT product_id, COALESCE(qty_total,0) AS q FROM inventory_current WHERE store_id=$1 AND product_id = ANY($2::bigint[])`,
      [storeId, ids]);
    const stockMap = new Map(stock.map(s => [Number(s.product_id), Number(s.q)]));
    const transit = await q<any>(
      `SELECT i.product_id AS pid, COALESCE(SUM(i.order_qty - i.arrived_qty),0) AS q
         FROM purchase_order_items i
         JOIN purchase_orders po ON po.id=i.po_id AND po.status IN ('已下单','到货中') AND po.store_id=$1
        WHERE i.product_id = ANY($2::bigint[])
        GROUP BY i.product_id`, [storeId, ids]);
    const transitMap = new Map(transit.map(t => [Number(t.pid), Number(t.q)]));
    // P8 销量预测联动补货：未来 7 天预测销量优先作日均参考（无预测数据回落移动平均）
    const fc = await q<any>(
      `SELECT product_id, SUM(predict_qty) AS q7 FROM forecast_snapshots
        WHERE store_id=$1 AND horizon_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7
        GROUP BY product_id`, [storeId]);
    const fcMap = new Map(fc.map((f: any) => [Number(f.product_id), Number(f.q7)]));

    const items: any[] = [];
    for (const s of sales) {
      const avg = Number(s.qty) / coverage;
      const f7 = fcMap.get(Number(s.pid)) ?? 0;
      const effAvg = f7 > 0 ? f7 / coverage : avg;   // 预测版日均：预测 7 天量 ÷ 覆盖天数
      if (effAvg < 0.5) continue; // 冷门商品不打扰
      const st = stockMap.get(Number(s.pid)) ?? 0;
      const tr = transitMap.get(Number(s.pid)) ?? 0;
      const target = effAvg * (coverage + safety);
      const suggestQty = Math.ceil(target - st - tr);
      if (suggestQty <= 0) continue; // 库存+在途充足
      const daysLeft = (st + tr) / effAvg;
      items.push({ productId: Number(s.pid), name: s.name, sellPrice: Number(s.sell_price),
                   stock: st, inTransit: tr, avgDaily: r2(effAvg), forecast7: f7 > 0 ? r2(f7) : null, activeDays: Number(s.active_days),
                   daysLeft: r2(daysLeft), suggestQty, confidence: r2(Math.min(0.95, Math.max(0.5, 1 - effAvg * 0.1))) });
    }
    if (!items.length) return { count: 0, items: [] };
    const sid = await this.suggest(storeId, '补货', { rule: '安全库存法', coverageDays: coverage, safetyDays: safety,
      forecastLinked: fcMap.size > 0, count: items.length, items },
      { rule: fcMap.size ? `预测优先：未来7天预测销量×(${coverage}+${safety}) − 库存 − 在途（无预测商品回落日均×周期）`
                        : `日均销×(${coverage}+${safety}) − 库存 − 在途`, coverageDays: coverage, safetyDays: safety, note: '可售天数低于覆盖周期即建议' },
      0.85, 'purchase_order', null);
    await this.autoMaybe(storeId, sid, '补货');   // P7：全自动档直接执行（含成熟度门禁）
    return { count: items.length, items };
  }

  /* ═══ 2. 🎯 会员精准推送：沉默唤醒（N 天无有效消费 + 有余额或未用券；V4.16.5 阈值/人数设置化） ═══ */
  static async memberTouch(storeId: number): Promise<{ count: number; members: any[] }> {
    if (await this.hasPending(storeId, '营销推送')) return { count: 0, members: [] };
    const silentDays = Math.max(7, Math.min(180, Number(await this.setting('ai.touch.silent_days', 30)) || 30));
    const limit = Math.max(5, Math.min(100, Number(await this.setting('ai.touch.limit', 20)) || 20));
    const rows = await q<any>(
      `SELECT m.id, m.name, m.phone, COALESCE(ma.balance,0) AS balance,
              COALESCE(ma.dividend_balance,0) AS dividend_balance
         FROM members m
         LEFT JOIN member_accounts ma ON ma.member_id=m.id
        WHERE m.store_id=$1 AND m.status='正常' AND m.deleted_at IS NULL
          AND (m.last_active_date IS NULL OR m.last_active_date < CURRENT_DATE - $2::int)
          AND (COALESCE(ma.balance,0) > 0 OR COALESCE(ma.dividend_balance,0) > 0
               OR EXISTS (SELECT 1 FROM member_coupons mc WHERE mc.member_id=m.id AND mc.status='未使用'))
        ORDER BY COALESCE(ma.balance,0) DESC LIMIT $3`, [storeId, silentDays, limit]);
    if (!rows.length) return { count: 0, members: [] };
    const members = rows.map(m => ({ id: Number(m.id), name: m.name, phone: m.phone,
                                     balance: Number(m.balance), dividendBalance: Number(m.dividend_balance),
                                     silentDays }));
    await this.suggest(storeId, '营销推送', { rule: '沉默唤醒', silentDays, count: members.length, members },
      { rule: `${silentDays} 天无有效消费且有余额/未用券`, silentDays, note: '建议发放满减唤醒券（发送权在人）' },
      0.7, 'member_touch', null);
    return { count: members.length, members };
  }

  /* ═══ 3. 📈 销售预测：星期系数 + 近 14 日趋势 → 未来 7 天（写 forecast_snapshots 并回填 MAE） ═══ */
  static async forecast(storeId: number): Promise<{ products: number; snapshots: number; maeBackfilled: number; byCategory: any[]; backtest?: { lead: number; n: number; mape: number }[]; engine?: string; note?: string }> {
    const history = Number(await this.setting('ai.forecast.history_days', 90) ?? 90);
    // V4.13 ⑥ 预测引擎开关：lgbm（数据门槛 + 服务可达才生效，失败自动回落 baseline）
    const engine = String(await this.setting('ai.forecast.engine', 'baseline') ?? 'baseline');
    if (engine === 'lgbm') {
      const r = await this.lgbmForecast(storeId, history);
      if (r) return r;
    }
    const sales = await q<any>(
      `SELECT si.product_id AS pid, so.created_at::date AS d, SUM(si.qty) AS qty
         FROM sale_items si
         JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
        WHERE so.store_id=$1 AND so.created_at >= CURRENT_DATE - $2::int
        GROUP BY si.product_id, so.created_at::date`, [storeId, history]);
    if (!sales.length) return { products: 0, snapshots: 0, maeBackfilled: 0, byCategory: [] };

    // 按商品聚合日销序列
    const byProd = new Map<number, { d: string; qty: number }[]>();
    for (const s of sales) {
      const k = Number(s.pid);
      if (!byProd.has(k)) byProd.set(k, []);
      byProd.get(k)!.push({ d: fmtD(s.d), qty: Number(s.qty) });
    }
    // 星期基准：统计窗口内各星期几的日均
    const wdSum = new Array(7).fill(0), wdCnt = new Array(7).fill(0);
    for (const s of sales) {
      const wd = new Date(s.d).getDay();
      wdSum[wd] += Number(s.qty); wdCnt[wd]++;
    }
    const wdAvg = wdSum.map((v, i) => wdCnt[i] ? v / wdCnt[i] : 0);
    const globalMean = wdSum.reduce((a, b) => a + b, 0) / Math.max(1, wdCnt.reduce((a, b) => a + b, 0));

    // 回填历史快照 MAE
    const backfilled = await q(
      `UPDATE forecast_snapshots f SET actual_qty = COALESCE(agg.q, 0),
              mae_after = ROUND(ABS(COALESCE(agg.q,0) - f.predict_qty)::numeric, 4)
         FROM (SELECT si.product_id, so.created_at::date AS d, SUM(si.qty) AS q
                 FROM sale_items si JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
                WHERE so.store_id=$1
                GROUP BY si.product_id, so.created_at::date) agg
        WHERE f.store_id=$1 AND agg.product_id=f.product_id AND agg.d=f.horizon_date
          AND f.actual_qty IS NULL AND f.horizon_date < CURRENT_DATE RETURNING f.id`, [storeId]);
    const maeBackfilled = backfilled.length;

    // 未来 7 天逐商品预测
    let snap = 0, prodCount = 0;
    const catAgg = new Map<number, { name: string; qty: number }>();
    const names = await q<any>(`SELECT id, name, category_id FROM products WHERE store_id=$1`, [storeId]);
    const catNames = await q<any>(`SELECT id, name FROM categories`);
    const catNameMap = new Map(catNames.map(c => [Number(c.id), c.name]));
    const nameMap = new Map(names.map(n => [Number(n.id), n]));
    // V4.16.3 多因子预测：门店/商圈地点系数 × 天气客流系数（未来 7 天），基线 = 星期×趋势×地点×天气
    const locFactor = Math.max(0.2, Math.min(3, Number(await this.setting('ai.forecast.location_factor', 1)) || 1));
    const wxWeight = Math.max(0, Math.min(1, Number(await this.setting('ai.forecast.weather_weight', 0.3)) || 0));
    const wxTraffic = new Map<string, number>();
    if (wxWeight > 0) {
      const w = await getWeather(storeId).catch((): any => null);
      const days: any[] = w?.days ?? [];
      const fcs: any[] = w?.factors ?? [];
      days.forEach((d, i) => { wxTraffic.set(fmtD(d?.date), Number(fcs[i]?.traffic) || 1); });
    }
    for (const [pid, seq] of byProd) {
      if (seq.length < 7) continue; // 样本不足不预测
      const sorted = seq.sort((a, b) => a.d < b.d ? -1 : 1);
      const recent = sorted.slice(-14), prev = sorted.slice(-28, -14);
      const avg = (arr: { qty: number }[]) => arr.length ? arr.reduce((a, b) => a + b.qty, 0) / arr.length : 0;
      const trend = Math.min(1.5, Math.max(0.5, avg(recent) / Math.max(1e-6, avg(prev))));
      // 该商品星期系数：用该商品自身日销按星期统计
      const wsum = new Array(7).fill(0), wcnt = new Array(7).fill(0);
      for (const s of sorted) { const wd = new Date(s.d).getDay(); wsum[wd] += s.qty; wcnt[wd]++; }
      const mean = sorted.reduce((a, b) => a + b.qty, 0) / sorted.length;
      const cv = mean > 0 ? Math.sqrt(sorted.reduce((a, b) => a + (b.qty - mean) ** 2, 0) / sorted.length) / mean : 1;
      const conf = Math.min(0.99, Math.max(0.3, 1 - cv));
      const prod = nameMap.get(pid);
      const catId = prod?.category_id ? Number(prod.category_id) : null;
      let catQty = 0;
      for (let i = 1; i <= 7; i++) {
        const d = new Date(); d.setDate(d.getDate() + i);
        const wd = d.getDay();
        const base = wcnt[wd] ? wsum[wd] / wcnt[wd] : wdAvg[wd] * (mean / Math.max(1e-6, globalMean));
        const traffic = wxTraffic.get(fmtD(d)) ?? 1;
        const wx = r2(1 - wxWeight + wxWeight * traffic);
        const pred = Math.max(0, base * trend * locFactor * wx);
        await q(
          `INSERT INTO forecast_snapshots (store_id, product_id, horizon_date, predict_qty, confidence, factors)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (product_id, horizon_date)
           DO UPDATE SET predict_qty=EXCLUDED.predict_qty, confidence=EXCLUDED.confidence,
                         factors=EXCLUDED.factors, store_id=EXCLUDED.store_id`,
          [storeId, pid, fmtD(d), r2(pred), r2(conf),
           JSON.stringify({ weekday: wd, trend: r2(trend), loc: locFactor, weather: wx, traffic, historyDays: history })]);
        snap++; catQty += pred;
      }
      if (catId) {
        const c = catAgg.get(catId) ?? { name: catNameMap.get(catId) ?? '未分类', qty: 0 };
        c.qty += catQty; catAgg.set(catId, c);
      }
      prodCount++;
    }
    const byCategory = [...catAgg.entries()].map(([id, v]) => ({ categoryId: id, name: v.name, qty: r2(v.qty) }))
      .sort((a, b) => b.qty - a.qty);
    // V4.16.3 预测回测：近 14 天已回填实际销量的快照，按「提前天数」算 MAPE（越低越准）
    const backtest = await q<any>(
      `SELECT (f.horizon_date - f.created_at::date) AS lead, COUNT(*) AS n,
              ROUND(AVG(ABS(f.actual_qty - f.predict_qty) / NULLIF(f.actual_qty,0)) * 100, 1) AS mape
         FROM forecast_snapshots f
        WHERE f.store_id=$1 AND f.actual_qty IS NOT NULL AND f.actual_qty > 0
          AND f.horizon_date >= CURRENT_DATE - 14
        GROUP BY 1 ORDER BY 1`, [storeId]);
    return { products: prodCount, snapshots: snap, maeBackfilled, byCategory, backtest: backtest.map((b: any) => ({ lead: Number(b.lead), n: Number(b.n), mape: Number(b.mape) })) };
  }

  /* ═══ 3b. LightGBM 预测引擎（V4.13 ⑥：功能常备、默认关；数据 ≥ min_days 且本地服务可达才生效） ═══
   *  本地 Python 微服务（backend/ai-forecast-svc/）：POST /predict {series} → {predictions:[{productId,horizonDate,qty,confidence}]}
   *  任一环节失败（未部署/超时/数据门槛未到）→ 返回 null，调用方回落 baseline 规则引擎（永不阻断预测主链路） */
  private static async lgbmForecast(storeId: number, historyDays: number): Promise<{ products: number; snapshots: number; maeBackfilled: number; byCategory: any[]; engine: string; note: string } | null> {
    try {
      const minDays = Number(await this.setting('ai.forecast.lgbm.min_days', 56) ?? 56);
      const totalDays = await q1<{ n: string }>(
        `SELECT count(DISTINCT so.created_at::date) AS n FROM sales_orders so
          WHERE so.store_id=$1 AND ${SQL_ORDER_DONE}`, [storeId]);
      if (Number(totalDays?.n ?? 0) < minDays) return null;   // 数据门槛未到 → baseline（防过拟合空转）
      const base = String(await this.setting('ai.forecast.lgbm.url', 'http://localhost:9101') ?? 'http://localhost:9101');
      const series = await q<any>(
        `SELECT si.product_id AS pid, so.created_at::date AS d, SUM(si.qty) AS qty
           FROM sale_items si JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
          WHERE so.store_id=$1 AND so.created_at >= CURRENT_DATE - $2::int
          GROUP BY si.product_id, so.created_at::date`, [storeId, historyDays]);
      if (!series.length) return null;
      const ctl = AbortSignal.timeout(15000);
      const res = await fetch(`${base.replace(/\/$/, '')}/predict`, {
        method: 'POST', signal: ctl, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ horizonDays: 7, series: series.map(s => ({ productId: Number(s.pid), date: fmtD(s.d), qty: Number(s.qty) })) }),
      });
      if (!res.ok) return null;
      const j: any = await res.json();
      const preds: any[] = Array.isArray(j?.predictions) ? j.predictions : [];
      if (!preds.length) return null;
      const names = await q<any>(`SELECT id, name, category_id FROM products WHERE store_id=$1`, [storeId]);
      const catNames = await q<any>(`SELECT id, name FROM categories`);
      const catNameMap = new Map(catNames.map((c: any) => [Number(c.id), c.name]));
      const nameMap = new Map(names.map((n: any) => [Number(n.id), n]));
      const catAgg = new Map<number, { name: string; qty: number }>();
      let snap = 0, prodCount = 0;
      const seenPid = new Set<number>();
      for (const p of preds) {
        const pid = Number(p.productId);
        if (!pid || !p.horizonDate) continue;
        await q(
          `INSERT INTO forecast_snapshots (store_id, product_id, horizon_date, predict_qty, confidence, factors)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (product_id, horizon_date)
           DO UPDATE SET predict_qty=EXCLUDED.predict_qty, confidence=EXCLUDED.confidence,
                         factors=EXCLUDED.factors, store_id=EXCLUDED.store_id`,
          [storeId, pid, fmtD(p.horizonDate), r2(Number(p.qty) || 0), r2(Math.min(0.99, Math.max(0.3, Number(p.confidence) || 0.8))),
           JSON.stringify({ engine: 'lgbm', model: j?.model ?? null })]);
        snap++;
        if (!seenPid.has(pid)) { seenPid.add(pid); prodCount++; }
        const prod = nameMap.get(pid);
        const catId = prod?.category_id ? Number(prod.category_id) : null;
        if (catId) {
          const c = catAgg.get(catId) ?? { name: catNameMap.get(catId) ?? '未分类', qty: 0 };
          c.qty += Number(p.qty) || 0; catAgg.set(catId, c);
        }
      }
      const byCategory = [...catAgg.entries()].map(([id, v]) => ({ categoryId: id, name: v.name, qty: r2(v.qty) }))
        .sort((a, b) => b.qty - a.qty);
      return { products: prodCount, snapshots: snap, maeBackfilled: 0, byCategory,
               engine: 'lgbm', note: `LightGBM 引擎生效（全店流水 ${Number(totalDays?.n ?? 0)} 天 ≥ 门槛 ${minDays} 天）` };
    } catch { return null; }   // 服务不可达/超时 → 回落 baseline
  }

  /* ═══ 4. 🏷️ 定价与促销建议：慢动销 + 高库存 → 折扣建议（只建议不自动改价） ═══ */
  static async pricing(storeId: number): Promise<{ count: number; items: any[] }> {
    if (await this.hasPending(storeId, '定价')) return { count: 0, items: [] };
    const rows = await q<any>(
      `SELECT p.id AS pid, p.name, p.sell_price, COALESCE(ic.qty_total,0) AS stock,
              (SELECT b.inbound_cost FROM batches b WHERE b.product_id=p.id AND b.remain_qty>0
                ORDER BY b.inbound_date DESC, b.id DESC LIMIT 1) AS last_cost,
              COALESCE((SELECT SUM(si.qty) FROM sale_items si JOIN sales_orders so ON so.id=si.order_id
                         AND ${SQL_ORDER_DONE} AND so.created_at >= CURRENT_DATE - 7
                        WHERE si.product_id=p.id), 0) AS qty7,
              COALESCE((SELECT SUM(si.qty) FROM sale_items si JOIN sales_orders so ON so.id=si.order_id
                         AND ${SQL_ORDER_DONE} AND so.created_at >= CURRENT_DATE - 30
                        WHERE si.product_id=p.id), 0) AS qty30
         FROM products p
         LEFT JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
        WHERE ${PRODUCT_VISIBLE('$1')} AND p.status=1`, [storeId]);
    const items: any[] = [];
    for (const r of rows) {
      const stock = Number(r.stock);
      const qty7 = Number(r.qty7), qty30 = Number(r.qty30);
      const avg = qty30 / 30;
      const turnoverDays = avg > 0 ? stock / avg : (stock > 0 ? 90 : 0);
      const slow = (qty7 === 0 && stock >= 20) || (avg > 0 && turnoverDays > 45) || (qty30 === 0 && stock >= 10);
      if (!slow || stock === 0) continue;
      const discount = qty7 === 0 && stock >= 20 ? 0.85 : 0.9;
      const suggestPrice = r2(Number(r.sell_price) * discount);
      if (suggestPrice >= Number(r.sell_price)) continue;
      items.push({ productId: Number(r.pid), name: r.name, sellPrice: Number(r.sell_price), cost: Number(r.last_cost) || null, stock,
                   qty7, turnoverDays: avg > 0 ? r2(turnoverDays) : null, discount, suggestPrice,
                   reason: qty7 === 0 && stock >= 20 ? '7 天零动销且库存偏高' : `周转 ${r2(turnoverDays)} 天偏慢` });
    }
    if (!items.length) return { count: 0, items: [] };
    const sid = await this.suggest(storeId, '定价', { rule: '慢动销折扣建议', count: items.length, items },
      { rule: '价格弹性 + 损耗成本（只建议不自动改价）', note: '建议折扣档 8.5/9 折' }, 0.6);
    await this.autoMaybe(storeId, sid, '定价');   // P7：全自动档直接执行（含成熟度门禁，回滚快照已记录）
    return { count: items.length, items };
  }

  /* ═══ 5. ⏰ 损耗与临期预测：在库批次 ≤15 天到期 → 打折去化/退货建议 ═══ */
  static async expiryLoss(storeId: number): Promise<{ count: number; items: any[] }> {
    if (await this.hasPending(storeId, '防损')) return { count: 0, items: [] };
    const rows = await q<any>(
      `SELECT b.id, b.product_id, b.batch_no, b.expiry_date, b.remain_qty, b.inbound_cost,
              p.name, p.sell_price
         FROM batches b JOIN products p ON p.id=b.product_id
        WHERE b.store_id=$1 AND b.status='在库' AND b.remain_qty>0
          AND b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 15
        ORDER BY b.expiry_date LIMIT 50`, [storeId]);
    if (!rows.length) return { count: 0, items: [] };
    const today = new Date();
    const items = rows.map(b => {
      const daysLeft = Math.round((new Date(b.expiry_date).getTime() - today.getTime()) / 86400000);
      return { batchId: Number(b.id), productId: Number(b.product_id), productName: b.name,
               batchNo: b.batch_no, expiryDate: fmtD(b.expiry_date), daysLeft,
               remainQty: Number(b.remain_qty), cost: Number(b.inbound_cost),
               sellPrice: Number(b.sell_price), suggestPrice: r2(Number(b.sell_price) * 0.8), discount: 0.8 };
    });
    await this.suggest(storeId, '防损', { rule: '临期损耗预警', daysLeft: 15, count: items.length, items },
      { rule: '保质期节奏 + 损耗曲线', note: '建议 8 折促销去化或联系供应商退货' }, 0.8);
    return { count: items.length, items };
  }

  /* ═══ 6. 🧺 购物篮关联推荐：近 90 天同单共现 → 置信度/提升度规则（收银台"顺便带一件"） ═══ */
  static async assocRules(storeId: number): Promise<{ ruleCount: number; totalOrders: number }> {
    const minConf = Number(await this.setting('ai.assoc.min_conf', 0.2) ?? 0.2);
    const N = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM sales_orders WHERE store_id=$1 AND ${SQL_ORDER_DONE} AND created_at >= CURRENT_DATE - 90`, [storeId]);
    const totalOrders = Number(N?.n ?? 0);
    if (totalOrders < 20) return { ruleCount: 0, totalOrders };
    const freq = await q<any>(
      `SELECT si.product_id AS pid, count(DISTINCT si.order_id) AS f
         FROM sale_items si JOIN sales_orders so ON so.id=si.order_id
          AND ${SQL_ORDER_DONE} AND so.created_at >= CURRENT_DATE - 90
        WHERE so.store_id=$1
        GROUP BY si.product_id HAVING count(DISTINCT si.order_id) >= 10`, [storeId]);
    const freqMap = new Map(freq.map(f => [Number(f.pid), Number(f.f)]));
    const ids = [...freqMap.keys()];
    if (ids.length < 2) return { ruleCount: 0, totalOrders };
    const pairs = await q<any>(
      `SELECT a.product_id AS x, b.product_id AS y, count(DISTINCT a.order_id) AS xy
         FROM sale_items a
         JOIN sale_items b ON a.order_id=b.order_id AND a.product_id < b.product_id
         JOIN sales_orders so ON so.id=a.order_id AND ${SQL_ORDER_DONE} AND so.created_at >= CURRENT_DATE - 90
        WHERE so.store_id=$1 AND a.product_id = ANY($2::bigint[]) AND b.product_id = ANY($2::bigint[])
        GROUP BY a.product_id, b.product_id HAVING count(DISTINCT a.order_id) >= 3`, [storeId, ids]);
    const names = await q<any>(`SELECT id, name FROM products WHERE id = ANY($1::bigint[])`,
      [[...new Set(pairs.flatMap(p => [Number(p.x), Number(p.y)]))]]);
    const nameMap = new Map(names.map(n => [Number(n.id), n.name]));
    const rules = pairs.map(p => {
      const x = Number(p.x), y = Number(p.y), xy = Number(p.xy);
      const conf = xy / (freqMap.get(x) ?? 1);
      const lift = (xy * totalOrders) / ((freqMap.get(x) ?? 1) * (freqMap.get(y) ?? 1));
      return { x, y, xName: nameMap.get(x) ?? '', yName: nameMap.get(y) ?? '', xy, conf: r2(conf), lift: r2(lift) };
    }).filter(r => r.conf >= minConf).sort((a, b) => b.conf - a.conf).slice(0, 500);
    await q(
      `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
       VALUES ('AI赋能','ai.assoc_rules','购物篮关联规则缓存',$1::jsonb,'{}'::jsonb,'json','近 90 天小票共现（自动重建）')
       ON CONFLICT (setting_key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ rules, totalOrders, generatedAt: new Date().toISOString() })]);
    return { ruleCount: rules.length, totalOrders };
  }

  /** 读取关联规则缓存（收银台"顺便带一件"提示 / 单商品推荐） */
  static async assocFor(productId: number): Promise<{ xName?: string; recs: any[] }> {
    const v = await this.setting('ai.assoc_rules', null);
    const rules: any[] = v?.rules ?? [];
    const recs = rules
      .filter(r => Number(r.x) === Number(productId) || Number(r.y) === Number(productId))
      .map(r => Number(r.x) === Number(productId)
        ? { productId: r.y, name: r.yName, conf: r.conf, lift: r.lift }
        : { productId: r.x, name: r.xName, conf: r.conf, lift: r.lift })
      .sort((a, b) => b.conf - a.conf).slice(0, 5);
    return { recs };
  }

  /* ═══ 7. 💬 自然语言经营问答：关键词路由 → SQL → 文本；Ollama 可选增强 ═══ */
  static async qa(storeId: number, question: string): Promise<{ answer: string; engine: string; route: string; kbHit: boolean }> {
    const kw = (question || '').trim();
    if (!kw) return { answer: '请输入您想了解的经营问题，如"今天毛利多少"、"哪些商品缺货"、"下周销量预测"。', engine: 'rule', route: 'help', kbHit: false };
    const today = fmtD(new Date());
    const routes: { k: RegExp; name: string; fn: () => Promise<string[]> }[] = [
      /* 单商品查询（V4.16.0 P9）放最前：问题有明确锚点（^...$），避免被"销售/卖了"宽泛路由抢先 */
      { k: /^(?:看看|查一下|查询)?(.{2,16}?)(?:近?30天)?(?:的)?(?:卖了多少|销量如何|销量怎么样|销量)$/, name: '单商品查询', fn: async () => {
        const m = kw.match(/^(?:看看|查一下|查询)?(.{2,16}?)(?:近?30天)?(?:的)?(?:卖了多少|销量如何|销量怎么样|销量)$/);
        const kw2 = (m?.[1] || '').trim();
        if (!kw2) return ['请说明商品名称，如"红富士苹果卖了多少"。'];
        const rows = await q<any>(
          `SELECT p.id, p.name, COALESCE(SUM(si.qty) FILTER (WHERE so.created_at >= CURRENT_DATE - 30),0) AS q30,
                  COALESCE(ic.qty_total,0) AS stock
             FROM products p
             LEFT JOIN sale_items si ON si.product_id=p.id
             LEFT JOIN sales_orders so ON so.id=si.order_id AND so.status IN ('已完成','部分退款')
             LEFT JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
            WHERE ${PRODUCT_VISIBLE('$1')} AND p.name ILIKE '%'||$2||'%'
            GROUP BY p.id, p.name, ic.qty_total ORDER BY q30 DESC LIMIT 3`, [storeId, kw2]);
        if (!rows.length) return [`没有找到名称含「${kw2}」的商品（可先在商品档案确认名称）。`];
        return rows.map(r => `「${r.name}」近 30 天销量 ${Number(r.q30).toFixed(0)} 件，当前库存 ${Number(r.stock)} 件。`);
      } },
      /* V4.16.1 天气问答：关键词明确（天气/气温/下雨），放前面避免被宽泛路由截 */
      { k: /天气|气温|下雨|下雪|降温|几度|冷不冷|热不热/, name: '天气', fn: async () => {
        const w = await getWeather(storeId);
        if (!w.days.length) return [w.note || '暂无天气数据（检查外网连通性，或在设置-AI赋能配置天气城市）。'];
        const f = w.factors;
        const lines = f.slice(0, 3).map((x, i) => {
          const label = i === 0 ? '今天' : i === 1 ? '明天' : '后天';
          return `${label}（${x.date.slice(5)}）${x.condText} ${x.tempRange}`;
        });
        const tips = f.slice(0, 2).map(x => x.tip).filter(t => t && !t.includes('天气平稳'));
        return [`【${w.city}天气】${lines.join('；')}。${tips.length ? '经营提示：' + tips.join('；') + '。' : ''}${w.stale ? '（当前为缓存数据）' : ''}`];
      } },
      { k: /毛利|利润(?!排|榜)|赚(?!钱榜)/, name: '毛利', fn: async () => {
        const r = await q1<any>(
          `SELECT COALESCE(SUM(profit_amount),0) AS p, COUNT(*) AS n FROM sales_orders
            WHERE store_id=$1 AND ${SQL_ORDER_DONE} AND created_at::date=$2`, [storeId, today]);
        const m = await q1<any>(
          `SELECT COALESCE(SUM(profit_amount),0) AS p FROM sales_orders
            WHERE store_id=$1 AND ${SQL_ORDER_DONE} AND created_at::date >= date_trunc('month', CURRENT_DATE)`, [storeId]);
        return [`今日（${today}）毛利 ¥${Number(r?.p).toFixed(2)}（${r?.n ?? 0} 单）；本月累计毛利 ¥${Number(m?.p).toFixed(2)}。`];
      } },
      { k: /销售|营业额|流水|营收|卖了/, name: '销售', fn: async () => {
        const r = await q1<any>(
          `SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS s, COALESCE(AVG(payable_amount),0) AS a
             FROM sales_orders WHERE store_id=$1 AND ${SQL_ORDER_DONE} AND created_at::date=$2`, [storeId, today]);
        return [`今日销售额 ¥${Number(r?.s).toFixed(2)}，${r?.n ?? 0} 单，客单价 ¥${Number(r?.a).toFixed(2)}。`];
      } },
      { k: /排行|热销|卖得最好|TOP|top/, name: '热销榜', fn: async () => {
        const rows = await q<any>(
          `SELECT p.name, SUM(si.qty) AS qty FROM sale_items si
             JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE} AND so.created_at >= CURRENT_DATE - 7
             JOIN products p ON p.id=si.product_id
            WHERE so.store_id=$1 GROUP BY p.name ORDER BY qty DESC LIMIT 5`, [storeId]);
        return rows.length ? ['近 7 天热销 TOP5：' + rows.map((r, i) => `${i + 1}.${r.name}(${Number(r.qty)}${r.unit_name ?? ''})`).join('；')]
          : ['近 7 天暂无销售数据。'];
      } },
      { k: /库存|缺货|没货|低库存/, name: '库存', fn: async () => {
        const rows = await q<any>(
          `SELECT p.name, COALESCE(ic.qty_total,0) AS q FROM products p
             LEFT JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
            WHERE ${PRODUCT_VISIBLE('$1')} AND p.status=1 AND COALESCE(ic.qty_total,0) <= 5
            ORDER BY q LIMIT 8`, [storeId]);
        return rows.length ? ['低库存商品：' + rows.map(r => `${r.name}(${Number(r.q)}件)`).join('；')] : ['暂无低库存商品。'];
      } },
      { k: /会员|新增/, name: '会员', fn: async () => {
        const r = await q1<any>(
          `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at::date=$2) AS add_today
             FROM members WHERE store_id=$1 AND deleted_at IS NULL`, [storeId, today]);
        return [`会员总数 ${r?.total ?? 0} 人，今日新增 ${r?.add_today ?? 0} 人。`];
      } },
      { k: /临期|过期|保质/, name: '临期', fn: async () => {
        const rows = await q<any>(
          `SELECT p.name, b.batch_no, b.expiry_date, b.remain_qty FROM batches b
             JOIN products p ON p.id=b.product_id
            WHERE b.store_id=$1 AND b.status='在库' AND b.remain_qty>0
              AND b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 15 LIMIT 8`, [storeId]);
        return rows.length ? ['15 天内临期批次：' + rows.map(r => `${r.name}(${fmtD(r.expiry_date)} 到期，余${Number(r.remain_qty)})`).join('；')]
          : ['当前无 15 天内临期批次。'];
      } },
      { k: /补货|采购|建议单/, name: '补货建议', fn: async () => {
        const rows = await q<any>(
          `SELECT payload FROM ai_suggestions WHERE store_id=$1 AND domain='补货' AND status='待处理'
            ORDER BY created_at DESC LIMIT 1`, [storeId]);
        const items = rows[0]?.payload?.items ?? [];
        return items.length ? [`待处理补货建议 ${items.length} 条（安全库存法）：如 ${items.slice(0, 5).map((i: any) => `${i.name} +${i.suggestQty}`).join('、')} 等。`]
          : ['当前无待处理补货建议。'];
      } },
      { k: /日报|摘要|今天怎么样|今天如何|汇报/, name: '日报', fn: async () => {
        const r = await q1<any>(
          `SELECT content_text FROM ai_kb_documents WHERE store_id=$1 AND source_type='经营日报自动生成'
            ORDER BY created_at DESC LIMIT 1`, [storeId]);
        return r?.content_text ? [r.content_text] : ['今日 AI 日报尚未生成（每日 23:59 自动生成，可手动生成）。'];
      } },
      { k: /退货|退款/, name: '退款', fn: async () => {
        const r = await q1<any>(
          `SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS s FROM sales_orders
            WHERE store_id=$1 AND status IN ('已退款','部分退款') AND created_at::date=$2`, [storeId, today]);
        return [`今日退款 ${r?.n ?? 0} 单，金额 ¥${Number(r?.s).toFixed(2)}。`];
      } },
      { k: /关联|搭配|一起买|推荐/, name: '关联推荐', fn: async () => {
        const v = await this.setting('ai.assoc_rules', null);
        const n = v?.rules?.length ?? 0;
        return [`购物篮关联规则 ${n} 条（置信度≥阈值，近 90 天重建），可在商品资料查看"顺便带一件"推荐。`];
      } },
      /* ── V4.16.0 P9 问答扩面：总览/时段/滞销/利润Top/单商品/在途/损耗/对账 ── */
      { k: /总览|概况|经营情况|生意/, name: '经营总览', fn: async () => {
        const [t, y] = await Promise.all([
          q1<any>(`SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS s, COALESCE(SUM(profit_amount),0) AS p,
                          COALESCE(AVG(payable_amount),0) AS a FROM sales_orders
                    WHERE store_id=$1 AND ${SQL_ORDER_DONE} AND created_at::date=$2`, [storeId, today]),
          q1<any>(`SELECT COALESCE(SUM(payable_amount),0) AS s FROM sales_orders
                    WHERE store_id=$1 AND ${SQL_ORDER_DONE} AND created_at::date=CURRENT_DATE-1`, [storeId]),
        ]);
        const vs = Number(y?.s) > 0 ? ((Number(t?.s) - Number(y?.s)) / Number(y?.s) * 100) : (Number(t?.s) > 0 ? 100 : 0);
        return [`今日销售额 ¥${Number(t?.s).toFixed(2)}（${t?.n ?? 0} 单，较昨日 ${vs >= 0 ? '+' : ''}${vs.toFixed(1)}%），毛利 ¥${Number(t?.p).toFixed(2)}，客单价 ¥${Number(t?.a).toFixed(2)}。`];
      } },
      { k: /时段|高峰|分时|几点.*卖|卖.*几点/, name: '分时销售', fn: async () => {
        const rows = await q<any>(
          `SELECT EXTRACT(HOUR FROM created_at)::int AS h, COUNT(*)::int AS n, COALESCE(SUM(payable_amount),0) AS s
             FROM sales_orders WHERE store_id=$1 AND ${SQL_ORDER_DONE} AND created_at::date=$2
            GROUP BY 1 ORDER BY 1`, [storeId, today]);
        if (!rows.length) return ['今日暂无销售流水。'];
        const top = rows.reduce((a, b) => Number(b.s) > Number(a.s) ? b : a);
        return [`今日分时销售：${rows.map(r => `${r.h}点 ¥${Number(r.s).toFixed(0)}(${r.n}单)`).join('、')}。高峰在 ${top.h} 点（¥${Number(top.s).toFixed(2)}），可据此安排排班与补货节奏。`];
      } },
      { k: /滞销|卖不动|积压/, name: '滞销分析', fn: async () => {
        const rows = await q<any>(
          `SELECT p.name, COALESCE(ic.qty_total,0) AS stock
             FROM products p LEFT JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
            WHERE ${PRODUCT_VISIBLE('$1')} AND p.status=1 AND COALESCE(ic.qty_total,0) >= 10
              AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales_orders so ON so.id=si.order_id
                               AND ${SQL_ORDER_DONE} AND so.created_at >= CURRENT_DATE - 30 WHERE si.product_id=p.id)
            ORDER BY stock DESC LIMIT 8`, [storeId]);
        return rows.length ? [`近 30 天零动销且库存 ≥10 的滞销商品：` + rows.map(r => `${r.name}(${Number(r.stock)}件)`).join('、') + `。可在决策中心运行「定价建议」生成折扣清货方案。`]
          : ['近 30 天无"零动销且高库存"的滞销商品。'];
      } },
      { k: /利润排行|最赚钱|利润top|利润榜/i, name: '利润排行', fn: async () => {
        const rows = await q<any>(
          `SELECT p.name, COALESCE(SUM(si.line_profit),0) AS pf, COALESCE(SUM(si.qty),0) AS q
             FROM sale_items si JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
             JOIN products p ON p.id=si.product_id
            WHERE so.store_id=$1 AND so.created_at >= CURRENT_DATE - 30
            GROUP BY p.name HAVING SUM(si.line_profit) > 0 ORDER BY pf DESC LIMIT 5`, [storeId]);
        return rows.length ? ['近 30 天利润 TOP5：' + rows.map((r, i) => `${i + 1}.${r.name}（毛利 ¥${Number(r.pf).toFixed(2)} / ${Number(r.q)}件）`).join('；')]
          : ['近 30 天暂无毛利数据（需销售流水含成本）。'];
      } },
      { k: /在途|采购中|还没到|到货/, name: '在途采购', fn: async () => {
        const rows = await q<any>(
          `SELECT p.name, COALESCE(SUM(i.order_qty - i.arrived_qty),0) AS pending
             FROM purchase_order_items i
             JOIN purchase_orders po ON po.id=i.po_id AND po.status IN ('已下单','到货中') AND po.store_id=$1
             JOIN products p ON p.id=i.product_id
            WHERE i.order_qty > i.arrived_qty
            GROUP BY p.name HAVING SUM(i.order_qty - i.arrived_qty) > 0 ORDER BY pending DESC LIMIT 8`, [storeId]);
        return rows.length ? ['在途采购（未到货量）：' + rows.map(r => `${r.name} +${Number(r.pending)}`).join('、') + '。']
          : ['当前无在途采购（或全部已到货）。'];
      } },
      { k: /损耗|报损/, name: '损耗分析', fn: async () => {
        const r = await q1<any>(
          `SELECT COUNT(*)::int AS n, COALESCE(SUM(i.qty),0) AS q, COALESCE(SUM(i.qty*i.unit_cost),0) AS amt
             FROM loss_items i JOIN loss_records l ON l.id=i.loss_id
            WHERE l.store_id=$1 AND l.created_at >= CURRENT_DATE - 30`, [storeId]);
        const rows = await q<any>(
          `SELECT p.name, SUM(i.qty) AS q FROM loss_items i JOIN loss_records l ON l.id=i.loss_id
             JOIN products p ON p.id=i.product_id
            WHERE l.store_id=$1 AND l.created_at >= CURRENT_DATE - 30
            GROUP BY p.name ORDER BY q DESC LIMIT 5`, [storeId]);
        const top = rows.length ? '，报损最多：' + rows.map(x => `${x.name}(${Number(x.q)})`).join('、') : '';
        return [`近 30 天报损 ${r?.n ?? 0} 单，共 ${Number(r?.q ?? 0).toFixed(0)} 件，损失成本约 ¥${Number(r?.amt ?? 0).toFixed(2)}${top}。`];
      } },
      { k: /对账|对不上|渠道差异/, name: '智能对账', fn: async () => {
        const r = await this.reconInsight(storeId);
        return [r.text];
      } },
    ];
    const hit = routes.find(r => r.k.test(kw));
    let lines: string[];
    if (hit) { try { lines = await hit.fn(); } catch { lines = ['查询时发生错误，请稍后重试。']; } }
    else {
      lines = [`抱歉，暂时无法理解"${kw.slice(0, 20)}"。可尝试问：今天销售如何 / 毛利多少 / 哪些商品缺货 / 近7天热销排行 / 会员新增。`];
    }
    // 知识库关键词命中（经营文档/日报全文检索，无向量降级为关键词；
    // 去疑问词尾缀 + 双向 ILIKE：问题含标题（如"排班规则是什么"命中《排班规则》）也能检索）
    let kbHit = false, kbText = '';
    const cleanKw = kw.replace(/[？?。！!，,、\s]/g, '').replace(/(是什么|怎么办|怎么做|如何|怎么|吗|呢|一下|介绍)$/, '').slice(0, 12);
    const kb = await q1<any>(
      `SELECT title, LEFT(content_text, 200) AS c FROM ai_kb_documents
        WHERE store_id=$1 AND (
          title ILIKE '%'||$2||'%' OR content_text ILIKE '%'||$2||'%'
          OR $2 ILIKE '%'||title||'%'
        )
        ORDER BY created_at DESC LIMIT 1`, [storeId, cleanKw || kw.slice(0, 12)]);
    if (kb) { kbHit = true; kbText = `\n\n📚 知识库参考《${kb.title}》：${kb.c}…`; }
    let answer = lines.join('\n') + kbText;

    // Ollama 预留（ai.llm.enabled=on 且服务可达才启用；失败自动降级规则答案）
    const llmOn = Boolean(await this.setting('ai.llm.enabled', false));
    if (llmOn) {
      try {
        const base = String(await this.setting('ai.llm.base', 'http://localhost:11434'));
        const model = String(await this.setting('ai.llm.model', 'qwen2.5:7b'));
        const ctl = AbortSignal.timeout(10000);
        const res = await fetch(`${base}/api/generate`, {
          method: 'POST', signal: ctl,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: `你是社区超市店长助手。基于以下店内数据用中文自然回答，简洁 3 句内：\n${lines.join('\n')}${kbText}`, stream: false }),
        });
        if (res.ok) {
          const j: any = await res.json();
          if (j?.response) return { answer: j.response.trim(), engine: 'ollama', route: hit?.name ?? 'llm', kbHit };
        }
      } catch { /* Ollama 不可达 → 降级规则答案 */ }
    }
    return { answer, engine: 'rule', route: hit?.name ?? 'fallback', kbHit };
  }

  /* ═══ 8. 🛡️ 防损异常学习：收银行为基线（取消率/退款率/负毛利单率）→ 超阈值员工预警 ═══ */
  static async fraudBaseline(storeId: number): Promise<{ count: number; byCashier: any[] }> {
    const window = Number(await this.setting('ai.fraud.window_days', 30) ?? 30);
    const rows = await q<any>(
      `SELECT so.cashier_id, e.name AS cashier_name, COUNT(*) AS orders,
              COUNT(*) FILTER (WHERE so.status='已取消') AS cancelled,
              COUNT(*) FILTER (WHERE so.status IN ('已退款','部分退款')) AS refunded,
              COUNT(*) FILTER (WHERE so.profit_amount < 0) AS neg
         FROM sales_orders so LEFT JOIN employees e ON e.id=so.cashier_id
        WHERE so.store_id=$1 AND so.created_at >= CURRENT_DATE - $2::int AND so.cashier_id IS NOT NULL
        GROUP BY so.cashier_id, e.name`, [storeId, window]);
    if (!rows.length) return { count: 0, byCashier: [] };
    const stat = rows.map(r => {
      const n = Math.max(1, Number(r.orders));
      return { id: Number(r.cashier_id), name: r.cashier_name || '未知收银员', orders: n,
               cancelRate: Number(r.cancelled) / n, refundRate: Number(r.refunded) / n,
               negRate: Number(r.neg) / n };
    });
    const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const avgCancel = mean(stat.map(s => s.cancelRate));
    const avgRefund = mean(stat.map(s => s.refundRate));
    const avgNeg = mean(stat.map(s => s.negRate));
    const tCancel = Math.max(0.05, avgCancel + 0.02), tRefund = Math.max(0.05, avgRefund + 0.02), tNeg = Math.max(0.03, avgNeg + 0.02);
    const abnormal = stat.filter(s => s.cancelRate > tCancel || s.refundRate > tRefund || s.negRate > tNeg)
      .map(s => ({ ...s, cancelRate: r2(s.cancelRate * 100), refundRate: r2(s.refundRate * 100), negRate: r2(s.negRate * 100) }));
    await q(
      `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
       VALUES ('AI赋能','ai.fraud_baseline','防损基线缓存',$1::jsonb,'{}'::jsonb,'json','收银行为基线（自动学习）')
       ON CONFLICT (setting_key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ windowDays: window, baselines: { cancel: r2(tCancel * 100), refund: r2(tRefund * 100), neg: r2(tNeg * 100) }, byCashier: stat })]);
    if (abnormal.length && !(await this.hasPending(storeId, '防损'))) {
      await this.suggest(storeId, '防损', { rule: '收银异常基线', windowDays: window, count: abnormal.length, items: abnormal },
        { rule: '正常收银行为基线 + 2pp 阈值', baselines: { cancel: r2(tCancel * 100), refund: r2(tRefund * 100), neg: r2(tNeg * 100) } }, 0.75);
    }
    return { count: abnormal.length, byCashier: stat };
  }

  /* ═══ 9. 📰 AI 日报摘要：当日全指标 + 异常事件 → "老板能看懂的话" → 知识库归档 ═══ */
  static async dailyReport(storeId: number, dateStr?: string): Promise<{ date: string; created: boolean; text?: string }> {
    const d = dateStr || fmtD(new Date());
    const exist = await q1(`SELECT id FROM ai_kb_documents WHERE store_id=$1 AND title=$2`, [storeId, `AI日报 ${d}`]);
    if (exist) return { date: d, created: false };
    const [today, yday] = await Promise.all([
      q1<any>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS sales, COALESCE(SUM(profit_amount),0) AS profit,
                COALESCE(AVG(payable_amount),0) AS avg_ticket,
                COUNT(*) FILTER (WHERE status IN ('已退款','部分退款')) AS refunded,
                COALESCE(SUM(CASE WHEN status IN ('已退款','部分退款') THEN payable_amount ELSE 0 END),0) AS refund_amt,
                COUNT(*) FILTER (WHERE profit_amount<0) AS neg
           FROM sales_orders WHERE store_id=$1 AND created_at::date=$2 AND status <> '挂单'`, [storeId, d]),
      q1<any>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS sales, COALESCE(SUM(profit_amount),0) AS profit
           FROM sales_orders WHERE store_id=$1 AND created_at::date=$2 AND status <> '挂单'`,
        [storeId, fmtD(new Date(new Date(d).getTime() - 86400000))]),
    ]);
    const newMembers = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM members WHERE store_id=$1 AND created_at::date=$2`, [storeId, d]);
    const expiry = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM batches WHERE store_id=$1 AND status='在库' AND remain_qty>0
        AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 15`, [storeId]);
    const lowStock = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM products p LEFT JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
        WHERE ${PRODUCT_VISIBLE('$1')} AND p.status=1 AND COALESCE(ic.qty_total,0) <= 5`, [storeId]);
    const pendingSugg = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM ai_suggestions WHERE store_id=$1 AND status='待处理'`, [storeId]);

    const n = Number(today?.n ?? 0);
    const sales = Number(today?.sales ?? 0), profit = Number(today?.profit ?? 0);
    const refunded = Number(today?.refunded ?? 0), refundAmt = Number(today?.refund_amt ?? 0), neg = Number(today?.neg ?? 0);
    const ySales = Number(yday?.sales ?? 0);
    const vs = ySales > 0 ? ((sales - ySales) / ySales) * 100 : (sales > 0 ? 100 : 0);
    const refundRate = n > 0 ? (refunded / n) * 100 : 0;
    const expN = Number(expiry?.n ?? 0), lowN = Number(lowStock?.n ?? 0), sugN = Number(pendingSugg?.n ?? 0);

    const lines: string[] = [];
    lines.push(`【AI 日报 ${d}】`);
    lines.push(`今日销售额 ¥${sales.toFixed(2)}（较昨日 ${vs >= 0 ? '+' : ''}${vs.toFixed(1)}%），毛利 ¥${profit.toFixed(2)}，${n} 单，客单价 ¥${Number(today?.avg_ticket ?? 0).toFixed(2)}；新增会员 ${newMembers?.n ?? 0} 人。`);
    const warns: string[] = [];
    if (neg > 0) warns.push(`负毛利单 ${neg} 单`);
    if (refundRate > 5) warns.push(`退款率 ${refundRate.toFixed(1)}%（¥${refundAmt.toFixed(2)}）`);
    if (expN > 0) warns.push(`${expN} 批商品 15 天内临期`);
    if (lowN > 0) warns.push(`${lowN} 个商品低库存`);
    lines.push(warns.length ? `⚠️ 需关注：${warns.join('、')}。` : '✅ 无显著异常。');
    if (sugN > 0) lines.push(`💡 智能决策中心有 ${sugN} 条建议待处理，建议今日处理（执行/否决均可，否决也会帮助学习）。`);
    else lines.push('💡 今日无待处理智能建议。');
    const text = lines.join('\n');
    await q(
      `INSERT INTO ai_kb_documents (store_id, title, source_type, content_text, status)
       VALUES ($1,$2,'经营日报自动生成',$3,'已收录')`, [storeId, `AI日报 ${d}`, text]);
    // 切块入知识库（每 500 字一块，embedding 降级 TEXT 占位）
    for (let i = 0, no = 1; i < text.length; i += 500, no++) {
      await q(`INSERT INTO ai_kb_chunks (document_id, chunk_no, content)
               SELECT id, $2, $3 FROM ai_kb_documents WHERE store_id=$1 AND title=$4
               ON CONFLICT (document_id, chunk_no) DO NOTHING`,
        [storeId, no, text.slice(i, i + 500), `AI日报 ${d}`]);
    }
    return { date: d, created: true, text };
  }

  /* ═══ 🔁 效果回收：已执行的补货建议，用近 7 天实际销量回填误差（建议→执行→结果） ═══ */
  static async effectRecovery(storeId: number): Promise<number> {
    const rows = await q<any>(
      `SELECT id, payload FROM ai_suggestions
        WHERE store_id=$1 AND domain='补货' AND status='已执行' AND effect IS NULL AND decided_at <= now() - interval '3 days'
        LIMIT 20`, [storeId]);
    let done = 0;
    for (const s of rows) {
      const items: any[] = s.payload?.items ?? [];
      if (!items.length) continue;
      const ids = items.map(i => i.productId);
      const sold = await q<any>(
        `SELECT si.product_id AS pid, SUM(si.qty) AS q FROM sale_items si
           JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
          WHERE so.store_id=$1 AND si.product_id = ANY($2::bigint[])
            AND so.created_at >= CURRENT_DATE - 7 GROUP BY si.product_id`, [storeId, ids]);
      const soldMap = new Map(sold.map(x => [Number(x.pid), Number(x.q)]));
      const suggestTotal = items.reduce((a, i) => a + Number(i.suggestQty), 0);
      const actualTotal = items.reduce((a, i) => a + (soldMap.get(Number(i.productId)) ?? 0), 0);
      const errorPct = suggestTotal > 0 ? Math.abs(actualTotal - suggestTotal) / suggestTotal : null;
      await q(`UPDATE ai_suggestions SET effect=$2, effect_at=now() WHERE id=$1`,
        [s.id, JSON.stringify({ windowDays: 7, suggestQty: suggestTotal, actualSold: r2(actualTotal),
                                errorPct: errorPct != null ? r2(errorPct * 100) : null })]);
      done++;
    }
    return done;
  }

  /* ═══ 10. 🧮 AI 选品建议（V4.13 ③）：动销/周转打分 → 淘汰清仓清单 + 品类扩容建议 ═══
   *  淘汰：观察窗口零动销且库存偏高 / 周转天数超阈值且动销低迷 → 建议清仓折扣或停补淘汰（决策权在人）
   *  扩容：品类收入占比显著高于其 SKU 占比（>1.8 倍且 >12%）→ 建议扩充该品类 SKU 结构 */
  static async assortment(storeId: number): Promise<{ eliminated: number; expand: number; items: any[]; note?: string }> {
    if (!Boolean(await this.setting('ai.assortment.enabled', true))) return { eliminated: 0, expand: 0, items: [], note: '开关未开启' };
    if (await this.hasPending(storeId, '选品')) return { eliminated: 0, expand: 0, items: [] };
    const win = Number(await this.setting('ai.assortment.window_days', 30) ?? 30);
    const maxTurnover = Number(await this.setting('ai.assortment.max_turnover_days', 60) ?? 60);
    const rows = await q<any>(
      `WITH sold AS (
         SELECT si.product_id AS pid, SUM(si.qty) AS qty_w, COUNT(DISTINCT so.created_at::date) AS sell_days
           FROM sale_items si JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
            AND so.created_at >= CURRENT_DATE - $2::int
          WHERE so.store_id=$1 GROUP BY si.product_id
       )
       SELECT p.id AS pid, p.name, c.name AS cat_name, p.sell_price,
              COALESCE(ic.qty_total,0) AS stock,
              COALESCE(s.qty_w,0) AS qty_w, COALESCE(s.sell_days,0) AS sell_days
         FROM products p
         LEFT JOIN sold s ON s.pid=p.id
         LEFT JOIN categories c ON c.id=p.category_id
         LEFT JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
        WHERE ${PRODUCT_VISIBLE('$1')} AND p.status=1`, [storeId, win]);
    if (!rows.length) return { eliminated: 0, expand: 0, items: [] };

    // ① 淘汰清单：窗口零动销且库存 ≥10，或周转天数 > 阈值且动销天数 ≤2
    const eliminated = rows.filter(r => {
      const stock = Number(r.stock);
      if (stock <= 0) return false;
      const qtyW = Number(r.qty_w), sellDays = Number(r.sell_days);
      if (qtyW === 0 && stock >= 10) return true;
      const avg = qtyW / win;
      const turnoverDays = avg > 0 ? stock / avg : 999;
      return turnoverDays > maxTurnover && sellDays <= 2;
    }).map(r => {
      const stock = Number(r.stock), qtyW = Number(r.qty_w);
      const avg = qtyW / win;
      const turnoverDays = avg > 0 ? Math.round(stock / avg) : null;
      return { productId: Number(r.pid), name: r.name, category: r.cat_name || '未分类',
               sellPrice: Number(r.sell_price), stock, qtyWindow: qtyW, sellDays: Number(r.sell_days),
               turnoverDays, suggest: qtyW === 0 ? '清仓 8 折去化后停补淘汰' : '停止补货，售罄后评估淘汰',
               confidence: r2(Math.min(0.9, 0.5 + (qtyW === 0 ? 0.25 : 0.15))) };
    }).sort((a, b) => b.stock - a.stock).slice(0, 50);

    // ② 品类扩容：收入占比 vs SKU 占比失衡
    const totalRev = rows.reduce((a, r) => a + Number(r.qty_w) * Number(r.sell_price), 0);
    const totalSku = rows.length;
    const catAgg = new Map<string, { rev: number; skus: number }>();
    for (const r of rows) {
      const k = r.cat_name || '未分类';
      const c = catAgg.get(k) ?? { rev: 0, skus: 0 };
      c.rev += Number(r.qty_w) * Number(r.sell_price);
      c.skus += 1;
      catAgg.set(k, c);
    }
    const expand = [...catAgg.entries()]
      .map(([name, v]) => ({ category: name, revShare: totalRev > 0 ? r2(v.rev / totalRev * 100) : 0,
                             skuShare: r2(v.skus / totalSku * 100) }))
      .filter(x => x.revShare > 12 && x.revShare > x.skuShare * 1.8)
      .sort((a, b) => b.revShare - a.revShare).slice(0, 5);

    if (!eliminated.length && !expand.length) return { eliminated: 0, expand: 0, items: [] };
    await this.suggest(storeId, '选品',
      { rule: '动销周转打分', windowDays: win, eliminated, expand },
      { rule: `窗口 ${win} 天动销/周转 + 品类结构（收入占比 vs SKU 占比 >1.8）`,
        note: '淘汰 = 清仓/停补建议（执行权在人）；扩容 = 建议采购扩充该品类 SKU' },
      0.7);
    return { eliminated: eliminated.length, expand: expand.length, items: eliminated };
  }

  /* ═══ 11. 🗓 节假日/周末备货（P8）：内置节日表 + 提前 N 天 → 分品类备货量清单建议 ═══
   *  备货量参考 = 未来 7 天预测 × (节日系数 − 1)，向上取整（在正常补货之外的节日增量）；
   *  无节日时周五生成周末轻提醒（周末系数 1.2）；hasPending 按日去重不轰炸。 */
  static async holidayStock(storeId: number): Promise<{ count: number; festival?: string; daysLeft?: number; categories: any[]; note?: string }> {
    if (await this.hasPending(storeId, '备货')) return { count: 0, categories: [] };
    const lead = Number(await this.setting('ai.holiday.lead_days', 14) ?? 14);
    // 内置节日表：农历节日按 2026/2027 公历日期硬编码（跨年时更新此表即可）
    const nowY = new Date().getFullYear();
    const FESTIVALS: { name: string; y?: number; m: number; d: number; factor: number; date: Date }[] = [
      { name: '元旦', m: 1, d: 1, factor: 1.3 },
      { name: '春节', y: 2026, m: 2, d: 17, factor: 1.8 }, { name: '春节', y: 2027, m: 2, d: 6, factor: 1.8 },
      { name: '清明', m: 4, d: 5, factor: 1.2 },
      { name: '五一', m: 5, d: 1, factor: 1.4 },
      { name: '端午', y: 2026, m: 6, d: 19, factor: 1.3 }, { name: '端午', y: 2027, m: 6, d: 9, factor: 1.3 },
      { name: '中秋', y: 2026, m: 9, d: 25, factor: 1.5 }, { name: '中秋', y: 2027, m: 9, d: 15, factor: 1.5 },
      { name: '国庆', m: 10, d: 1, factor: 1.4 },
    ].map(f => ({ ...f, date: new Date(f.y ?? nowY, f.m - 1, f.d) }));
    // V4.16.3 自定义节日表（外部导入入口 ai.holiday.custom）：与内置合并，同名以自定义为准
    const custom = await this.setting('ai.holiday.custom', []);
    if (Array.isArray(custom)) {
      for (const c of custom) {
        const m = Number(c?.m), d = Number(c?.d);
        if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) continue;
        const name = String(c?.name || '').trim() || '自定义节日';
        const factor = Math.max(1, Math.min(3, Number(c?.factor) || 1.2));
        const date = new Date(Number(c?.y) || nowY, m - 1, d);
        const entry = { name, y: Number(c?.y) || undefined, m, d, factor, date };
        const i = FESTIVALS.findIndex(f => f.name === name);
        if (i >= 0) FESTIVALS[i] = entry; else FESTIVALS.push(entry);
      }
    }
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const soon = FESTIVALS
      .map(f => ({ ...f, daysLeft: Math.round((f.date.getTime() - today0.getTime()) / 86400000) }))
      .filter(f => f.daysLeft >= 0 && f.daysLeft <= lead)
      .sort((a, b) => a.daysLeft - b.daysLeft);
    const isWeekendReminder = !soon.length;
    if (isWeekendReminder && today0.getDay() !== 5) return { count: 0, categories: [], note: '近期无节日，且今日非周五（周末提醒周五生成）' };
    const festival = soon[0]?.name ?? '周末';
    const factor = soon[0]?.factor ?? 1.2;
    const daysLeft = soon[0]?.daysLeft;
    // 分品类未来 7 天预测（无预测数据则提示先跑销量预测）
    const rows = await q<any>(
      `SELECT COALESCE(c.name,'未分类') AS cat, SUM(f.predict_qty) AS q
         FROM forecast_snapshots f JOIN products p ON p.id=f.product_id
         LEFT JOIN categories c ON c.id=p.category_id
        WHERE f.store_id=$1 AND f.horizon_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7
        GROUP BY 1 ORDER BY q DESC`, [storeId]);
    if (!rows.length) return { count: 0, categories: [], note: '暂无销量预测数据（先在决策中心运行「销量预测」）' };
    const categories = rows.slice(0, 8).map((r: any) => {
      const base7 = Number(r.q);
      const extra = base7 * (factor - 1);
      return { category: r.cat, base7: r2(base7), factor, extraQty: Math.ceil(extra) };
    }).filter((x: any) => x.extraQty > 0);
    if (!categories.length) return { count: 0, categories: [], note: '节日增量不足 1 件，无需额外备货' };
    const sid = await this.suggest(storeId, '备货',
      { rule: isWeekendReminder ? '周末备货提醒' : '节假日备货清单', festival, daysLeft, factor, count: categories.length, categories },
      { rule: `未来7天分品类预测 × (${factor} − 1) 向上取整 = 节日/周末增量备货量`, festival, daysLeft,
        note: `${festival}${daysLeft != null ? ` ${daysLeft} 天后` : ''}（提前 ${lead} 天提醒）；建议量为正常补货之外的增量` },
      0.7);
    await this.autoMaybe(storeId, sid, '备货');
    return { count: categories.length, festival, daysLeft, categories };
  }

  /* ═══ V4.16.1 天气因素备货（P10）：雨天客流↓·高温冷饮↑·骤冷速冻火锅↑ → 分品类增量建议 ═══ */
  static async weatherStock(storeId: number): Promise<{ count: number; days?: any[]; categories?: any[]; note?: string }> {
    // 当日去重：同规则已有待处理建议则不重复生成（与节假日备货共用「备货」域，按 rule 区分）
    const dup = await q1(`SELECT 1 FROM ai_suggestions
      WHERE store_id=$1 AND domain='备货' AND payload->>'rule'='天气因素备货'
        AND status='待处理' AND created_at::date=CURRENT_DATE LIMIT 1`, [storeId]);
    if (dup) return { count: 0, note: '今日天气备货建议已生成（待处理清单中查看）' };
    const w = await getWeather(storeId);
    if (!w.days.length) return { count: 0, note: w.note || '暂无天气数据' };
    const f = factorsOf(w.days);
    const hasFactor = f.some(x => x.traffic < 1 || x.boosts.length);
    if (!hasFactor) return { count: 0, note: '未来三天天气平稳（无雨/无极端温度），无需天气备货' };
    // 有预测数据 → 分品类量化；无预测 → 文字建议（同样落建议留痕）
    const rows = await q<any>(
      `SELECT COALESCE(c.name,'未分类') AS cat, SUM(f.predict_qty) AS q
         FROM forecast_snapshots f JOIN products p ON p.id=f.product_id
         LEFT JOIN categories c ON c.id=p.category_id
        WHERE f.store_id=$1 AND f.horizon_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 3
        GROUP BY 1`, [storeId]);
    const catRows = rows.map((r: any) => ({ cat: String(r.cat), base: Number(r.q) }));
    const matchBoost = (cat: string): { factor: number; label: string } | null => {
      let best: { factor: number; label: string } | null = null;
      for (const x of f) for (const b of x.boosts) {
        if (b.keywords.some(k => cat.includes(k)) && (!best || b.factor > best.factor)) best = { factor: b.factor, label: b.label };
      }
      return best;
    };
    const dayNote = f.slice(0, 3).map((x, i) => `${i === 0 ? '今天' : i === 1 ? '明天' : '后天'}${x.condText} ${x.tempRange}（${x.tip}）`).join('；');
    let categories: any[] = [], payloadItems: any[] = [];
    if (catRows.length) {
      categories = catRows.map(r => {
        const boost = matchBoost(r.cat);
        const factor = boost ? boost.factor : 1;
        const extra = r.base * (factor - 1) * (f[0].traffic < 1 ? f[0].traffic : 1);
        return { category: r.cat, base3: Math.round(r.base * 10) / 10, weatherFactor: factor,
                 extraQty: Math.ceil(extra), note: boost ? boost.label : '客流下降，整体酌减' };
      }).filter((x: any) => x.extraQty > 0);
      payloadItems = categories;
      if (!categories.length) return { count: 0, days: f, note: '未来三天有天气波动，但命中品类预测增量不足 1 件' };
    }
    const flowNote = f[0].traffic < 1 ? `雨天/雪天到店客流约降至 ${Math.round(f[0].traffic * 100)}%` : '客流基本正常';
    const note = `未来三天：${dayNote}。${flowNote}。${payloadItems.length ? '按品类预测 × 天气系数给出增量（下单权在人）。' : '建议关注雨天速食、高温冷饮、降温速冻火锅等品类，人工酌情加订。'}`;
    const sid = await this.suggest(storeId, '备货',
      { rule: '天气因素备货', city: w.city, provider: w.provider, days: f, traffic: f[0].traffic,
        count: payloadItems.length, items: payloadItems, categories: payloadItems },
      { rule: '天气系数：雨/雪 客流×0.9、高温≥32℃ 冷饮×1.3、骤降≥8℃或≤5℃ 速冻火锅×1.25；品类按名称关键词命中',
        note }, 0.65);
    await this.autoMaybe(storeId, sid, '备货');
    return { count: payloadItems.length, days: f, categories: payloadItems, note };
  }

  /* ═══ V4.16.3 会员 AI 画像：SQL 聚合（常购/品类/时段/价格带/流失前兆）+ Ollama 人话建模 ═══
   *  近 180 天消费 TOP N 会员逐人聚合 → member_portraits 缓存；Ollama 开启则生成一人一段画像（数据不出店），失败回落规则文案 */
  static async memberPortraits(storeId: number): Promise<{ count: number; engine: string; items: any[] }> {
    if (!(await this.setting('ai.member.portrait.enabled', true))) return { count: 0, engine: 'off', items: [] };
    const top = Math.max(1, Math.min(200, Number(await this.setting('ai.member.portrait.top', 30)) || 30));
    const heads = await q<any>(
      `SELECT m.id, m.name, m.card_no, COALESCE(ma.balance,0) AS balance,
              COUNT(so.id) AS orders, COALESCE(SUM(so.payable_amount),0) AS spend,
              COALESCE(AVG(so.payable_amount),0) AS avg_ticket,
              MAX(so.created_at) AS last_at
         FROM members m
         LEFT JOIN member_accounts ma ON ma.member_id=m.id
         JOIN sales_orders so ON so.member_id=m.id AND so.status IN ('已完成','部分退款')
        WHERE m.store_id=$1 AND m.deleted_at IS NULL AND so.created_at >= CURRENT_DATE - 180
        GROUP BY m.id, m.name, m.card_no, ma.balance
        ORDER BY spend DESC LIMIT $2`, [storeId, top]);
    if (!heads.length) return { count: 0, engine: 'rule', items: [] };
    const llmOn = Boolean(await this.setting('ai.llm.enabled', false));
    let engine = 'rule', base = '', model = '';
    if (llmOn) {
      base = String(await this.setting('ai.llm.base', 'http://localhost:11434'));
      model = String(await this.setting('ai.llm.model', 'qwen2.5:7b'));
    }
    const items: any[] = [];
    for (const h of heads) {
      const mid = Number(h.id);
      // 常购商品 TOP3 + 品类偏好 + 到店时段 + 价格带 + 消费趋势（近30天 vs 前30天）
      const favItems = await q<any>(
        `SELECT p.name, SUM(si.qty) AS qty, SUM(si.line_amount) AS amt
           FROM sale_items si JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
           LEFT JOIN products p ON p.id=si.product_id
          WHERE so.member_id=$1 AND so.created_at >= CURRENT_DATE - 180
          GROUP BY p.name ORDER BY qty DESC LIMIT 3`, [mid]);
      const favCats = await q<any>(
        `SELECT COALESCE(c.name,'未分类') AS cat, SUM(si.qty) AS qty
           FROM sale_items si JOIN sales_orders so ON so.id=si.order_id AND ${SQL_ORDER_DONE}
           JOIN products p ON p.id=si.product_id
           LEFT JOIN categories c ON c.id=p.category_id
          WHERE so.member_id=$1 AND so.created_at >= CURRENT_DATE - 180
          GROUP BY 1 ORDER BY qty DESC LIMIT 3`, [mid]);
      const hours = await q<any>(
        `SELECT EXTRACT(HOUR FROM so.created_at)::int AS h, COUNT(*) AS n
           FROM sales_orders so WHERE so.member_id=$1 AND so.created_at >= CURRENT_DATE - 180 AND so.status IN ('已完成','部分退款')
          GROUP BY 1 ORDER BY n DESC LIMIT 1`, [mid]);
      const trendRow = await q1<{ cur: string; prev: string }>(
        `SELECT COALESCE(SUM(so.payable_amount) FILTER (WHERE so.created_at >= CURRENT_DATE - 30),0) AS cur,
                COALESCE(SUM(so.payable_amount) FILTER (WHERE so.created_at < CURRENT_DATE - 30),0) AS prev
           FROM sales_orders so WHERE so.member_id=$1 AND so.created_at >= CURRENT_DATE - 60 AND ${SQL_ORDER_DONE}`, [mid]);
      const daysIdle = Math.round((Date.now() - new Date(h.last_at).getTime()) / 86400000);
      const favHour = Number(hours[0]?.h ?? -1);
      const hourLabel = favHour < 0 ? '—' : favHour < 11 ? '上午' : favHour < 14 ? '中午' : favHour < 18 ? '下午' : '晚间';
      const priceBand = Number(h.avg_ticket) >= 80 ? '高客单（80+）' : Number(h.avg_ticket) >= 40 ? '中客单（40~80）' : '日常小额';
      const cur = Number(trendRow?.cur ?? 0), prev = Number(trendRow?.prev ?? 0);
      const trend = prev <= 0 ? (cur > 0 ? '新客/回升' : '持平') : cur / prev >= 1.15 ? '上升' : cur / prev <= 0.85 ? '下滑' : '平稳';
      const churnRisk = daysIdle >= 30 || trend === '下滑';
      const payload = {
        orders: Number(h.orders), spend: r2(Number(h.spend)), avgTicket: r2(Number(h.avg_ticket)),
        balance: r2(Number(h.balance)), daysIdle, favHour: hourLabel, priceBand, trend, churnRisk,
        favItems: favItems.map((f: any) => ({ name: f.name || '散称/已删商品', qty: r2(Number(f.qty)) })),
        favCats: favCats.map((f: any) => ({ cat: f.cat, qty: r2(Number(f.qty)) })),
      };
      let text = `近180天消费 ${payload.orders} 单 / ¥${payload.spend}，客单价 ¥${payload.avgTicket}（${payload.priceBand}）。` +
        `常买：${payload.favItems.map(f => `${f.name}×${f.qty}`).join('、') || '—'}；偏好品类：${payload.favCats.map(f => f.cat).join('、') || '—'}；` +
        `习惯${hourLabel}到店；近30天消费${trend}；距上次消费 ${daysIdle} 天${churnRisk ? '（⚠️ 有流失前兆，建议唤醒）' : ''}。`;
      if (llmOn) {
        try {
          const ctl = AbortSignal.timeout(15000);
          const res = await fetch(`${base.replace(/\/$/, '')}/api/generate`, {
            method: 'POST', signal: ctl, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, stream: false,
              prompt: `你是社区超市店长助手。根据以下会员消费数据写一段 80 字内的中文人话画像（消费习惯/偏好/流失风险/一句营销建议），不要罗列数字以外的东西：\n${JSON.stringify(payload)}` }),
          });
          if (res.ok) { const j: any = await res.json(); if (j?.response) { text = j.response.trim(); engine = 'ollama'; } }
        } catch { /* Ollama 不可达 → 保留规则文案 */ }
      }
      await q(
        `INSERT INTO member_portraits (store_id, member_id, payload, text, engine, generated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (store_id, member_id)
         DO UPDATE SET payload=EXCLUDED.payload, text=EXCLUDED.text, engine=EXCLUDED.engine, generated_at=now()`,
        [storeId, mid, JSON.stringify(payload), text, engine]);
      items.push({ memberId: mid, name: h.name, cardNo: h.card_no, engine, text, ...payload });
    }
    return { count: items.length, engine, items };
  }

  static async memberPortraitOne(storeId: number, memberId: number): Promise<any> {
    const r = await q1<any>(`SELECT * FROM member_portraits WHERE store_id=$1 AND member_id=$2`, [storeId, memberId]);
    if (!r) return null;
    return { memberId, engine: r.engine, text: r.text, ...r.payload, generatedAt: r.generated_at };
  }

  /* ═══ 12. 🔍 智能对账（P9）：支付渠道对账异常 + 进销存差异（批次在库合计 vs 现存量）→ 人话解读 ═══ */
  static async reconInsight(storeId: number) {
    const runs = await q<any>(
      `SELECT batch_no, channel, bill_date, bill_total, matched_total, local_total, diff_rows
         FROM bill_recon_runs WHERE store_id=$1 AND diff_rows > 0
        ORDER BY id DESC LIMIT 5`, [storeId]);
    const gaps = await q<any>(
      `SELECT p.id, p.name, COALESCE(ic.qty_total,0) AS stock, COALESCE(b.bqty,0) AS batch_qty
         FROM products p
         JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
         JOIN (SELECT product_id, SUM(remain_qty) AS bqty FROM batches WHERE store_id=$1 AND status='在库' GROUP BY product_id) b ON b.product_id=p.id
        WHERE ${PRODUCT_VISIBLE('$1')} AND ABS(COALESCE(ic.qty_total,0) - COALESCE(b.bqty,0)) > 0.001
        ORDER BY p.id LIMIT 10`, [storeId]);
    const lines: string[] = [];
    if (runs.length) {
      lines.push('【支付渠道对账】近 ' + runs.length + ' 笔账单存在差异：' + runs.map((r: any) => {
        const d = new Date(r.bill_date);
        const ds = isNaN(d.getTime()) ? String(r.bill_date).slice(0, 10) : fmtD(d);
        return `${r.channel} ${ds} 差异 ${Number(r.diff_rows)} 行（账单 ¥${Number(r.bill_total ?? 0).toFixed(2)} vs 系统 ¥${Number(r.local_total ?? 0).toFixed(2)}）`;
      }).join('；') + '。差异行可在「财务 → 渠道对账」逐笔核对处理。');
    } else {
      lines.push('【支付渠道对账】近期账单与系统流水全部匹配，无差异。✅');
    }
    if (gaps.length) {
      lines.push('【进销存差异】发现 ' + gaps.length + ' 个商品「批次在库合计 ≠ 现存量」：'
        + gaps.slice(0, 5).map((g: any) => `${g.name}(现存 ${Number(g.stock)} / 批次 ${Number(g.batch_qty)})`).join('、')
        + (gaps.length > 5 ? ' 等' : '') + '。建议核对近期出入库单据，或做一次盘点校正。');
    } else {
      lines.push('【进销存差异】全部商品「批次在库合计 = 现存量」，账实一致。✅');
    }
    return { text: lines.join('\n\n'), reconDiffRuns: runs.length, stockGaps: gaps.length,
             gaps: gaps.map((g: any) => ({ productId: Number(g.id), name: g.name, stock: Number(g.stock), batchQty: Number(g.batch_qty) })) };
  }

  /* ═══ V4.16.5 ① 节日表一键联网更新：权威节假日 API（timor.tech，免 Key）拉取当年+次年 ═══
   *  公历+农历法定节日 → 归一化名称+默认客流系数 → 合并进 ai.holiday.custom（同名同年覆盖，自定义项保留） */
  static async holidaySyncNet(storeId: number): Promise<{ fetched: number; merged: number; years: number[]; items: any[]; note?: string }> {
    const nowY = new Date().getFullYear();
    const FACTORS: Record<string, number> = {
      '元旦': 1.3, '春节': 1.8, '清明': 1.2, '五一': 1.4, '劳动节': 1.4,
      '端午': 1.3, '中秋': 1.5, '国庆': 1.4, '元旦节': 1.3, '清明节': 1.2, '端午节': 1.3, '中秋节': 1.5, '国庆节': 1.4,
    };
    const CN_NAME: Record<string, string> = { '清明节': '清明', '劳动节': '五一', '端午节': '端午', '中秋节': '中秋', '国庆节': '国庆', '元旦节': '元旦' };
    const items: any[] = [];
    const years = [nowY, nowY + 1];
    for (const y of years) {
      let j: any = null;
      try {
        const res = await fetch(`https://timor.tech/api/holiday/year/${y}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) j = await res.json();
      } catch { /* 网络失败静默，下方统一报错 */ }
      if (!j || Number(j.code) !== 0 || !j.holiday) continue;
      for (const [md, h] of Object.entries<any>(j.holiday)) {
        const rawName = String(h?.name || '').trim();
        if (/班/.test(rawName)) continue;                     // 调休补班日不是备货节日
        const name = CN_NAME[rawName] || rawName;
        const m = Number(String(md).split('-')[0]), d = Number(String(md).split('-')[1]);
        if (!name || !m || !d) continue;
        const factor = FACTORS[rawName] || FACTORS[name] || 1.2;
        items.push({ name, y, m, d, factor, date: h?.date || `${y}-${String(md).padStart(4, '0')}` });
      }
    }
    if (!items.length) return { fetched: 0, merged: 0, years, items: [], note: '联网拉取失败（检查外网/代理），内置节日表与手工自定义不受影响' };
    // 合并：同年同名以联网为准；不同名自定义条目保留（补班类条目一律清除——不是备货节日）
    const custom = await this.setting('ai.holiday.custom', []);
    const base = Array.isArray(custom) ? custom.filter((c: any) => c && c.name && !/班/.test(String(c.name))) : [];
    const key = (c: any) => `${c.name}@${c.y || ''}`;
    const netKeys = new Set(items.map(key));
    const merged = [...base.filter((c: any) => !netKeys.has(key(c))), ...items];
    await q(
      `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
       VALUES ('AI赋能','ai.holiday.custom','自定义节日表',$1::jsonb,'[]'::jsonb,'json','外部导入入口：JSON 数组（联网更新/手工编辑共用）')
       ON CONFLICT (setting_key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(merged)]);
    return { fetched: items.length, merged: merged.length, years, items };
  }

  /* ═══ V4.16.5 ② 天气-销量历史对齐回归（P12 收口）：
   *  sediment：每日把 weather_cache 中「今日及以前」的实测预报沉淀到 weather_daily（本地持续积累）
   *  calibrate：沉淀 ≥30 天后，按「雨雪/高温/低温/平常」分桶算 销售比率（回归比率），写入
   *             ai.weather.calibration → factorsOf 优先用学习系数替代固定 0.9/0.8/1.3 ═══ */
  static async weatherSediment(storeId: number): Promise<{ days: number }> {
    const rows = await q<any>(
      `INSERT INTO weather_daily (store_id, wdate, temp_max, temp_min, precip_mm, cond_text, wind_max, source)
       SELECT store_id, forecast_date, temp_max, temp_min, precip_mm, cond_text, wind_max, 'cache'
         FROM weather_cache
        WHERE store_id=$1 AND forecast_date <= CURRENT_DATE
        ON CONFLICT (store_id, wdate) DO UPDATE
          SET temp_max=EXCLUDED.temp_max, temp_min=EXCLUDED.temp_min, precip_mm=EXCLUDED.precip_mm,
              cond_text=EXCLUDED.cond_text, wind_max=EXCLUDED.wind_max, source='cache'
       RETURNING id`, [storeId]);
    return { days: rows.length };
  }

  static async weatherCalibrate(storeId: number): Promise<{ calibrated: boolean; days: number; buckets?: any; note: string }> {
    const rows = await q<any>(
      `SELECT w.wdate, w.temp_max, w.temp_min, w.precip_mm, w.cond_text,
              COALESCE(agg.amt, 0) AS amt
         FROM weather_daily w
         LEFT JOIN (SELECT so.created_at::date AS d, SUM(so.payable_amount) AS amt
                      FROM sales_orders so WHERE so.store_id=$1 AND ${SQL_ORDER_DONE}
                      GROUP BY 1) agg ON agg.d = w.wdate
        WHERE w.store_id=$1 AND w.wdate >= CURRENT_DATE - 120 AND w.wdate < CURRENT_DATE
        ORDER BY w.wdate`, [storeId]);
    const valid = rows.filter((r: any) => r.wdate && Number(r.amt) >= 0 && r.amt !== null);
    if (valid.length < 30) {
      return { calibrated: false, days: valid.length,
               note: `本地天气-销售对齐已沉淀 ${valid.length} 天（≥30 天自动开启回归校准；每日随预测自动沉淀，开业后持续积累即可）` };
    }
    const amts = valid.map((r: any) => Number(r.amt));
    const overall = amts.reduce((a: number, b: number) => a + b, 0) / amts.length;
    if (overall <= 0) return { calibrated: false, days: valid.length, note: '销售数据为 0，无法回归' };
    const bucket = (pred: (r: any) => boolean) => {
      const xs = valid.filter(pred).map((r: any) => Number(r.amt));
      return xs.length >= 5 ? Math.max(0.5, Math.min(1.6, xs.reduce((a, b) => a + b, 0) / xs.length / overall)) : undefined;
    };
    const isR = (r: any) => /雨|雪/.test(String(r.cond_text || '')) || Number(r.precip_mm) >= 0.1;
    const isS = (r: any) => /雪/.test(String(r.cond_text || ''));
    const isHot = (r: any) => r.temp_max != null && Number(r.temp_max) >= 32;
    const isCold = (r: any) => (r.temp_min != null && Number(r.temp_min) <= 5) || (r.temp_max != null && Number(r.temp_max) <= 8);
    const buckets: any = {
      rain: bucket(isR), snow: bucket(isS),
      hot: bucket(r => isHot(r) && !isR(r)), cold: bucket(r => isCold(r) && !isR(r) && !isHot(r)),
      clear: bucket(r => !isR(r) && !isHot(r) && !isCold(r)),
    };
    const cal = { ...buckets, days: valid.length, calibratedAt: new Date().toISOString().slice(0, 10) };
    await q(
      `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
       VALUES ('AI赋能','ai.weather.calibration','天气客流系数回归校准',$1::jsonb,'null'::jsonb,'json','本地天气-销量历史对齐回归结果：rain/snow/hot/cold/clear 各桶销售比率；≥30 天自动校准')
       ON CONFLICT (setting_key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(cal)]);
    return { calibrated: true, days: valid.length, buckets: cal, note: '已按本地沉淀数据回归校准天气客流系数（雨天/雪天/高温/低温/平常）' };
  }

  /* ═══ V4.16.5 ③ 会员画像营销引擎消费：画像分群 → 可执行营销清单（决策中心一键生成） ═══
   *  分群：流失前兆(30 天未消费)→沉默唤醒；高价值(TOP20% 客单)→专属维护；价格敏感(低价格带)→特价推送 */
  static async memberMarketing(storeId: number): Promise<{ count: number; segments: any[]; note?: string }> {
    const rows = await q<any>(
      `SELECT DISTINCT ON (mp.member_id) mp.member_id, m.name, m.phone, mp.payload
         FROM member_portraits mp JOIN members m ON m.id=mp.member_id
        WHERE mp.store_id=$1 AND m.status='正常' AND m.deleted_at IS NULL
        ORDER BY mp.member_id, mp.generated_at DESC`, [storeId]);
    if (!rows.length) return { count: 0, segments: [], note: '暂无会员画像（先在会员页生成 AI 画像）' };
    const seen = new Set<number>(); const segs: Record<string, any[]> = { churn: [], vip: [], price: [] };
    const spends: number[] = rows.map((r: any) => Number(r.payload?.spend ?? 0));
    const vipLine = spends.length >= 5 ? spends.slice().sort((a, b) => b - a)[Math.floor(spends.length * 0.2)] : 0;
    for (const r of rows) {
      const id = Number(r.member_id);
      if (seen.has(id)) continue; seen.add(id);
      const p = r.payload || {};
      const mem = { id, name: r.name, phone: r.phone ? String(r.phone).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '', spend: Number(p.spend ?? 0), orders: Number(p.orders ?? 0) };
      if (p.churnRisk || Number(p.daysIdle ?? 0) >= 30) segs.churn.push({ ...mem, action: '发满减唤醒券 / 店内提醒' });
      else if (vipLine > 0 && mem.spend >= vipLine) segs.vip.push({ ...mem, action: '新品优先通知 / 专属折扣' });
      else if (String(p.priceBand || '') === '日常小额') segs.price.push({ ...mem, action: '特价商品短信/到店告知' });
    }
    const segments = [
      { key: 'churn', name: '流失前兆唤醒', members: segs.churn.slice(0, 20) },
      { key: 'vip', name: '高价值维护', members: segs.vip.slice(0, 20) },
      { key: 'price', name: '价格敏感推送', members: segs.price.slice(0, 20) },
    ].filter(s => s.members.length);
    if (!segments.length) return { count: 0, segments: [], note: '画像会员暂无营销分群命中（数据正常时每日刷新自动更新）' };
    const count = segments.reduce((a, s) => a + s.members.length, 0);
    await this.suggest(storeId, '营销推送', { rule: '会员画像营销', count, segments: segments.map(s => ({ name: s.name, count: s.members.length })) },
      { rule: 'AI 画像分群：流失前兆唤醒 / 高价值维护 / 价格敏感推送', note: '名单见决策中心「会员画像营销」，发送权在人' }, 0.75, 'member_touch', null);
    return { count, segments };
  }

  /* ═══ 🧭 全量刷新（手动 / 每日 06:00 定时）：8 项应用一次闭环（日报 23:59 单独跑） ═══ */
  static async refresh(storeId: number): Promise<Record<string, any>> {
    const steps: [string, () => Promise<any>][] = [
      ['restock', () => this.restock(storeId)],
      ['memberTouch', () => this.memberTouch(storeId)],
      ['forecast', () => this.forecast(storeId)],
      ['pricing', () => this.pricing(storeId)],
      ['expiryLoss', () => this.expiryLoss(storeId)],
      ['assocRules', () => this.assocRules(storeId)],
      ['fraudBaseline', () => this.fraudBaseline(storeId)],
      ['effectRecovery', () => this.effectRecovery(storeId)],
      ['assortment', () => this.assortment(storeId)],
      ['holidayStock', () => this.holidayStock(storeId)],
      ['weatherStock', () => this.weatherStock(storeId)],
      ['memberPortraits', () => this.memberPortraits(storeId)],
      ['weatherSediment', () => this.weatherSediment(storeId)],          // V4.16.5 天气历史本地沉淀
      ['weatherCalibrate', () => this.weatherCalibrate(storeId)],        // V4.16.5 天气回归校准（≥30 天自动）
      ['memberMarketing', () => this.memberMarketing(storeId)],          // V4.16.5 画像营销分群
    ];
    const out: Record<string, any> = {};
    for (const [name, fn] of steps) {
      try { out[name] = await fn(); }
      catch (e: any) { out[name] = { error: e.message }; console.error(`[决策中心] ${name} 失败:`, e.message); }
    }
    await q(
      `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
       VALUES ('AI赋能','ai.last_refresh','最近一次全量刷新日期',$1::jsonb,'null'::jsonb,'string','决策中心学习闭环执行标记')
       ON CONFLICT (setting_key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify(fmtD(new Date()))]);
    return out;
  }

  /* ═══ 📊 学习资产看板（决策中心一屏 KPI） ═══ */
  static async overview(storeId: number): Promise<any> {
    const mae = await q1<any>(`SELECT ROUND(AVG(mae_after),4) AS v FROM forecast_snapshots WHERE store_id=$1 AND mae_after IS NOT NULL`, [storeId]);
    const fwd = await q<any>(
      `SELECT c.name AS category, SUM(f.predict_qty) AS qty FROM forecast_snapshots f
         JOIN products p ON p.id=f.product_id LEFT JOIN categories c ON c.id=p.category_id
        WHERE f.store_id=$1 AND f.horizon_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7
        GROUP BY c.name ORDER BY qty DESC`, [storeId]);
    const sugg = await q<any>(
      `SELECT domain, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status='已执行') AS executed,
              COUNT(*) FILTER (WHERE status='已否决') AS rejected,
              COUNT(*) FILTER (WHERE status='待处理') AS pending
         FROM ai_suggestions WHERE store_id=$1 GROUP BY domain ORDER BY domain`, [storeId]);
    const decided = sugg.reduce((a, s) => a + Number(s.executed) + Number(s.rejected), 0);
    const accepted = sugg.reduce((a, s) => a + Number(s.executed), 0);
    const assoc = await this.setting('ai.assoc_rules', null);
    const kb = await q1<{ n: string }>(`SELECT count(*) AS n FROM ai_kb_documents WHERE store_id=$1`, [storeId]);
    const daily = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM ai_kb_documents WHERE store_id=$1 AND source_type='经营日报自动生成'`, [storeId]);
    const recog = await q1<any>(
      `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE corrected) AS c FROM ai_recognition_logs WHERE store_id=$1`, [storeId]);
    const lastRefresh = await this.setting('ai.last_refresh', null);
    return {
      mae: mae?.v != null ? Number(mae.v) : null,
      forecasts: { byCategory: fwd, horizon: '未来 7 天' },
      suggestions: sugg,
      acceptRate: decided > 0 ? r2(accepted / decided * 100) : null,
      assocRules: Array.isArray(assoc?.rules) ? assoc.rules.length : 0,
      kbDocs: Number(kb?.n ?? 0),
      dailyReports: Number(daily?.n ?? 0),
      recognition: { total: Number(recog?.n ?? 0), corrected: Number(recog?.c ?? 0),
                     rate: Number(recog?.n ?? 0) > 0 ? r2(Number(recog?.c ?? 0) / Number(recog?.n ?? 0) * 100) : null },
      lastRefresh: lastRefresh || null,
    };
  }
}
