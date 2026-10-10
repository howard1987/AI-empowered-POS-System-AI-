/**
 * V5.0.0 连锁 · 同步层总部端（方案 §4.2 / §4.3 / §4.4 / §4.9 / §4.10，M4-1~M4-3/M4-10）
 *
 * 端点一览：
 *   【节点鉴权（非 JWT）】
 *   POST /sync/push          门店批量上行（≤500 条/批，逐条幂等，rejected 带原因）
 *   GET  /sync/pull          门店按 version 增量拉下行变更（target 过滤到本店）
 *   POST /sync/pull/ack      门店确认已应用版本（推进总部侧 in_version 水位）
 *   POST /sync/heartbeat     节点存活 + 本地统计（每日对账的"门店口径"）
 *   GET  /sync/bootstrap/*   新店全量引导（meta/stores/products/...，游标分页）
 *   【JWT（后台）】
 *   GET  /sync/status        节点看板（水位/延迟/待传/最近批次日志）
 *   POST /sync/replay        对指定门店重放指定版本区间（一键重推）
 *   GET  /sync/consistency   实时对数（总部实际 vs 门店上报）
 *   GET/POST /sync/self      本节点身份读取/配置向导（门店端配置页用）
 *
 * 鉴权（方案 §4.9 简化版，P1 落地）：
 *   Authorization: Node <node_code>:<token>  +  X-Sync-Ts（±300s 防重放）
 *   token 与 stores.node_secret 明文比对（timingSafeEqual）；P2 可升级 bcrypt/轮换。
 *
 * 【单店零回归】单店库 sync_nodes 只有 is_self 的 hq 行：
 *   push/pull 永远 401（没有门店节点）→ 同步端点事实上不可达；对账 job 无门店可查 → 空跑。
 */
import {
  Module, Controller, Get, Post, Body, Query, Param, Req, UseGuards,
  Injectable, OnModuleInit, Logger,
} from '@nestjs/common';
import { q, q1, tx, cx, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms, Public } from '../common/auth';
import { nodeIdentity, resetNodeCache } from '../common/outbox';
// 批次5：NodeGuard 抽到公共文件（会员资产端点共用节点鉴权，避免循环 import）
import { NodeGuard } from '../common/node-guard';
import { publishMemberMirror } from './member-chain.module';
import { SyncStoreService } from './sync-store.service';

export { NodeGuard };   // 兼容旧引用路径

/* ═══════════════════════ 上行落库（总部侧 applyUpstream） ═══════════════════════ */

/**
 * P1 落地范围与简化（已在方案文档「方案编号→实际落地」标注）：
 *   · 上行 payload 为自包含业务快照（业务键定位），不做本地 id ↔ 总部 id 翻译；
 *   · 批次明细（sale_item_batches/逐批 stock_flows）暂不上行 —— 成本金额已随单汇总，
 *     逐批一致性由每日对数（§4.10）兜底，P2 再补明细链；
 *   · members/会员资产同步属批次5（M5-*），本版不收。
 */
async function applyUpstream(c: any, storeId: number, nodeCode: string, ch: any): Promise<void> {
  const p = ch.payload ?? {};
  switch (ch.entity) {

    case 'sale_order': {
      // 商品解析：goods_no 优先，条码兜底；解析失败整单拒绝（留在门店重试）
      let memberId: number | null = null;
      if (p.memberCard) {
        const mb = await cx(c, `SELECT id FROM members WHERE card_no=$1 LIMIT 1`, [String(p.memberCard)]);
        memberId = mb[0] ? Number(mb[0].id) : null;
      }
      const ins = await cx(c,
        `INSERT INTO sales_orders (store_id, order_no, channel, is_emergency, member_id, status,
                                   goods_amount, payable_amount, cost_amount, profit_amount, round_amount, remark, created_at)
         VALUES ($1,$2,$3,$4,$5,'已完成',$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (order_no) DO NOTHING RETURNING id`,
        [storeId, String(p.orderNo ?? '').slice(0, 32), String(p.channel ?? '收银台').slice(0, 20),
         !!p.isEmergency, memberId,
         Number(p.goodsAmount ?? 0), Number(p.payable ?? 0), Number(p.costAmount ?? 0),
         Number(p.profit ?? 0), Number(p.roundAmount ?? 0),
         String(p.remark ?? '').slice(0, 128) || null, p.createdAt ? new Date(p.createdAt) : new Date()]);
      const orderId = ins[0]?.id
        ? Number(ins[0].id)
        : Number((await cx(c, `SELECT id, store_id FROM sales_orders WHERE order_no=$1`, [String(p.orderNo)]))[0]?.id);
      const inserted = !!ins[0]?.id;   // 批次5：仅新单做会员累加（幂等重放不重复计）
      if (!orderId) throw new Error('销售单落库失败');
      // 跨店单号撞车防护：门店本地自增序号可能在两家店生成同号（如 XS-20260918-0001）。
      // 首个先到先得；后来者整单拒绝（rejected 留在门店重试），绝不把明细挂到别家单上。
      const owner = (await cx(c, `SELECT store_id FROM sales_orders WHERE id=$1`, [orderId]))[0];
      if (owner && Number(owner.store_id) !== storeId) {
        throw new Error(`单号 ${p.orderNo} 已被门店${owner.store_id}占用（跨店撞号，需启用门店单号前缀）`);
      }
      for (const it of (p.items ?? [])) {
        const prod = await cx(c,
          `SELECT id FROM products WHERE goods_no=$1 OR ($2 <> '' AND barcode=$2) LIMIT 1`,
          [String(it.goodsNo ?? ''), String(it.barcode ?? '')]);
        if (!prod[0]) throw new Error(`商品 ${it.goodsNo || it.name} 未同步，整单重试`);
        await cx(c,
          `INSERT INTO sale_items (order_id, product_id, unit_name, qty, unit_price, origin_price, line_amount, line_cost, line_profit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [orderId, Number(prod[0].id), String(it.unitName ?? '基本').slice(0, 8), Number(it.qty ?? 0),
           Number(it.unitPrice ?? 0), Number(it.originPrice ?? it.unitPrice ?? 0),
           Number(it.lineAmount ?? 0), Number(it.lineCost ?? 0),
           Number((Number(it.lineAmount ?? 0) - Number(it.lineCost ?? 0)).toFixed(2))]);
      }
      for (const pm of (p.payments ?? [])) {
        await cx(c,
          `INSERT INTO sale_payments (order_id, channel, amount, external_no)
           VALUES ($1,$2,$3,$4)`,
          [orderId, String(pm.channel ?? '现金').slice(0, 20), Number(pm.amount ?? 0),
           pm.externalNo ? String(pm.externalNo).slice(0, 64) : null]);
      }
      // ── P2-2（§4.2 明细链补齐）：逐批出库明细落总部 sync_sale_batches（对账专用快照，无 batches FK）──
      //   幂等：idem_key = 原变更 idemKey:bd:序号；重放/重试均 ON CONFLICT 短路
      let bdi = 0;
      for (const it of (p.items ?? [])) {
        for (const bd of (it.batches ?? [])) {
          if (!bd?.batchNo) continue;
          await cx(c,
            `INSERT INTO sync_sale_batches (store_id, order_no, goods_no, batch_no, qty, unit_cost, idem_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idem_key) DO NOTHING`,
            [storeId, String(p.orderNo ?? ''), String(it.goodsNo ?? ''), String(bd.batchNo).slice(0, 48),
             Number(bd.qty ?? 0), Number(bd.unitCost ?? 0), `${ch.idemKey}:bd:${bdi}`]);
          bdi++;
        }
      }
      // ── 批次5（M5-5）：会员总部账本累加（R3/R4 权威账本在总部）──
      //   积分：门店算好的 pointsEarned 随单上行 → 总部累加（权威），门店本地只是镜像；
      //   total_consume：跨店累计消费（有效消费口径）随单累加，供连锁升级/分红权重使用；
      //   last_active_date：全连锁任一店消费即算有效（§5.2.3）。
      if (memberId && inserted) {
        const pts = Math.max(0, Math.round(Number(p.pointsEarned ?? 0)));
        const vs = Math.max(0, Number(p.validSpend ?? 0));
        if (pts > 0) {
          const ms = await cx(c,
            `UPDATE members SET points = points + $2, last_active_date = CURRENT_DATE, updated_at=now()
              WHERE id=$1 RETURNING points`, [memberId, pts]);
          await cx(c, `UPDATE member_accounts SET points = points + $2, updated_at=now() WHERE member_id=$1`,
            [memberId, pts]);
          await cx(c,
            `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
             VALUES ($1,'加',$2,'消费','sale',$3,$4)`,
            [memberId, pts, orderId, Number(ms[0]?.points ?? 0)]);
        } else {
          await cx(c, `UPDATE members SET last_active_date = CURRENT_DATE, updated_at=now() WHERE id=$1`, [memberId]);
        }
        if (vs > 0) {
          await cx(c, `UPDATE members SET total_consume = total_consume + $2, updated_at=now() WHERE id=$1`,
            [memberId, vs]);
        }
        // 活跃窗口镜像（分红资格总部判定用；门店按 (member, window_start) 原地累加）
        if (p.window?.start) {
          await cx(c,
            `INSERT INTO member_activity_windows (member_id, window_start, window_end, valid_total, qualified)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (member_id, window_start) DO UPDATE SET
                  window_end = GREATEST(member_activity_windows.window_end, EXCLUDED.window_end),
                  valid_total = EXCLUDED.valid_total,
                  qualified = member_activity_windows.qualified OR EXCLUDED.qualified, updated_at=now()`,
            [memberId, String(p.window.start).slice(0, 10), String(p.window.end ?? p.window.start).slice(0, 10),
             Number(p.window.valid ?? 0), !!p.window.qualified]);
        }
        await publishMemberMirror(memberId).catch(() => {});
      }
      return;
    }

    case 'sale_refund': {
      const ord = await cx(c, `SELECT id FROM sales_orders WHERE order_no=$1 AND store_id=$2 LIMIT 1`,
        [String(p.orderNo ?? ''), storeId]);
      if (!ord[0]) throw new Error(`原单 ${p.orderNo} 未同步，重试`);
      const ins = await cx(c,
        `INSERT INTO sale_refunds (store_id, refund_no, order_id, amount, reason, restock, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (refund_no) DO NOTHING RETURNING id`,
        [storeId, String(p.refundNo ?? '').slice(0, 32), Number(ord[0].id), Number(p.amount ?? 0),
         String(p.reason ?? '').slice(0, 128) || null, p.restock !== false,
         p.createdAt ? new Date(p.createdAt) : new Date()]);
      if (ins[0]) {
        for (const it of (p.items ?? [])) {
          // 匹配优先级：productId（商品总部化后门店/总部同 id）→ goodsNo 兜底
          let si: any[] = [];
          if (it.productId != null) {
            si = await cx(c, `SELECT id FROM sale_items WHERE order_id=$1 AND product_id=$2 ORDER BY id LIMIT 1`,
              [Number(ord[0].id), Number(it.productId)]);
          }
          if (!si[0] && it.goodsNo) {
            si = await cx(c,
              `SELECT si.id FROM sale_items si JOIN products pr ON pr.id = si.product_id
                WHERE si.order_id=$1 AND pr.goods_no=$2 ORDER BY si.id LIMIT 1`,
              [Number(ord[0].id), String(it.goodsNo)]);
          }
          if (si[0]) {
            await cx(c,
              `INSERT INTO sale_refund_items (refund_id, sale_item_id, qty, amount) VALUES ($1,$2,$3,$4)`,
              [Number(ins[0].id), Number(si[0].id), Number(it.qty ?? 0), Number(it.amount ?? 0)]);
          }
        }
      }
      return;
    }

    case 'shift': {
      const emp = p.cashierId ? await cx(c, `SELECT id FROM employees WHERE id=$1`, [Number(p.cashierId)]) : [];
      await cx(c,
        `INSERT INTO shifts (store_id, cashier_id, pos_no, opened_at, closed_at, opening_float,
                             cash_total, cash_counted, diff_amount, order_count, refund_count, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'已交班')`,
        [storeId, emp[0] ? Number(emp[0].id) : (await hqFallbackEmp(c)), String(p.posNo ?? 'POS-01').slice(0, 32),
         p.openedAt ? new Date(p.openedAt) : new Date(), p.closedAt ? new Date(p.closedAt) : new Date(),
         Number(p.openingFloat ?? 0), Number(p.cashTotal ?? 0), Number(p.cashCounted ?? 0),
         Number(p.diffAmount ?? 0), Number(p.orderCount ?? 0), Number(p.refundCount ?? 0)]);
      return;
    }

    case 'price_change': {
      const ins = await cx(c,
        `INSERT INTO price_changes (store_id, pc_no, effective_date, remark, item_count, diff_total, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (pc_no) DO NOTHING RETURNING id`,
        [storeId, String(p.pcNo ?? '').slice(0, 32),
         p.effectiveDate ? new Date(p.effectiveDate) : new Date(),
         String(p.remark ?? '').slice(0, 200) || null, Number(p.itemCount ?? 0),
         Number(p.diffTotal ?? 0), p.createdAt ? new Date(p.createdAt) : new Date()]);
      if (ins[0]) {
        for (const it of (p.items ?? [])) {
          const prod = await cx(c, `SELECT id FROM products WHERE goods_no=$1 LIMIT 1`, [String(it.goodsNo ?? '')]);
          if (prod[0]) {
            await cx(c,
              `INSERT INTO price_change_items (change_id, product_id, old_price, new_price) VALUES ($1,$2,$3,$4)`,
              [Number(ins[0].id), Number(prod[0].id), Number(it.oldPrice ?? 0), Number(it.newPrice ?? 0)]);
          }
        }
      }
      return;
    }

    case 'product': {
      // 门店自建品上行（R2）：落为 store_id=来源门店 的商品；goods_no 撞总部 → 拒绝，走人工「疑似重复」
      const dup = await cx(c, `SELECT id, store_id FROM products WHERE goods_no=$1`, [String(p.goodsNo ?? '')]);
      if (dup[0]) {
        if (Number(dup[0].store_id) === storeId) return;   // 幂等：本店已收
        throw new Error(`货号 ${p.goodsNo} 已存在（疑似重复，请走总部收编流程）`);
      }
      await cx(c,
        `INSERT INTO products (store_id, goods_no, name, barcode, base_unit, spec, category_id,
                               sell_price, member_price, min_price, biz_mode, track_inventory, is_weighted, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [storeId, String(p.goodsNo ?? '').slice(0, 32), String(p.name ?? '').slice(0, 64),
         p.barcode ? String(p.barcode).slice(0, 32) : null,
         String(p.baseUnit ?? '基本').slice(0, 8), p.spec ? String(p.spec).slice(0, 32) : null,
         p.categoryId ? Number(p.categoryId) : null,
         Number(p.sellPrice ?? 0), p.memberPrice != null ? Number(p.memberPrice) : null,
         p.minPrice != null ? Number(p.minPrice) : null,
         String(p.bizMode ?? '购销').slice(0, 12), p.trackInventory !== false,
         !!p.isWeighted, Number(p.status ?? 1)]);
      return;
    }

    case 'store_product': {
      await cx(c,
        `INSERT INTO store_products (store_id, product_id, is_listed, min_stock, source)
         VALUES ($1,$2,$3,$4,'store')
         ON CONFLICT (store_id, product_id)
         DO UPDATE SET is_listed=EXCLUDED.is_listed, min_stock=EXCLUDED.min_stock, updated_at=now()`,
        [storeId, Number(p.productId), p.isListed !== false, p.minStock != null ? Number(p.minStock) : 0]);
      return;
    }

    case 'inventory': {
      for (const it of (p.items ?? [])) {
        await cx(c,
          `INSERT INTO inventory_current (store_id, product_id, qty_total)
           VALUES ($1,$2,$3)
           ON CONFLICT (store_id, product_id)
           DO UPDATE SET qty_total=EXCLUDED.qty_total, updated_at=now()`,
          [storeId, Number(it.productId), Number(it.qtyTotal ?? 0)]);
      }
      return;
    }

    case 'cross_return_ack': {
      // 批次4B：受理店收货回执（M4-13 ⑤）——更新总部权威单的收货状态
      await cx(c,
        `UPDATE sale_refunds SET recv_status=$2, recv_remark=$3, sync_version=sync_version+1
          WHERE refund_no=$1 AND is_cross_store`,
        [String(p.refundNo ?? ''), p.mode === 'no_restock' ? '不入库' : '已入库',
         String(p.remark ?? '').slice(0, 200) || null]);
      return;
    }

    /* ── V4.28.2 P0-5：进销存单据上行补齐（报损 / 盘点 / 调拨）——总部台账合并 ── */

    case 'loss': {
      // 门店报损单上行：loss_no 幂等。明细 batch_id 为门店本地批次（跨库不可复刻）→ 总部只落单头，
      // 总额/单号权威；逐件明细随 payload 留痕（sync_changes/sync_inbox 可查）
      const dup = await cx(c, `SELECT id FROM loss_records WHERE loss_no=$1`, [String(p.lossNo ?? '')]);
      if (dup[0]) return;
      await cx(c,
        `INSERT INTO loss_records (store_id, loss_no, reason_type, total_cost, status)
         VALUES ($1,$2,$3,$4,'已审核')`,
        [storeId, String(p.lossNo ?? '').slice(0, 32), String(p.reasonType ?? '损耗').slice(0, 16),
         Number(p.totalCost ?? 0)]);
      return;
    }

    case 'stock_count': {
      // 门店盘点单上行：count_no 幂等。明细商品按总部主档存在性过滤（门店自建品未收编则跳过该行）
      const dup = await cx(c, `SELECT id FROM inventory_counts WHERE count_no=$1`, [String(p.countNo ?? '')]);
      if (dup[0]) return;
      const ins = await cx(c,
        `INSERT INTO inventory_counts (store_id, count_no, scope, status)
         VALUES ($1,$2,$3,'已审核') RETURNING id`,
        [storeId, String(p.countNo ?? '').slice(0, 32), String(p.scope ?? '全仓').slice(0, 64)]);
      const cid = Number(ins[0].id);
      for (const it of (p.items ?? [])) {
        const prod = await cx(c, `SELECT id FROM products WHERE id=$1`, [Number(it.productId)]);
        if (!prod[0]) continue;
        await cx(c,
          `INSERT INTO inventory_count_items (count_id, product_id, book_qty, actual_qty) VALUES ($1,$2,$3,$4)`,
          [cid, Number(it.productId), Number(it.bookQty ?? 0), Number(it.actualQty ?? 0)]);
      }
      return;
    }

    case 'stock_transfer': {
      // 门店调拨单上行：transfer_no 幂等。明细 batch_id 为门店本地批次不可复刻 → 总部只落单头
      const dup = await cx(c, `SELECT id FROM stock_transfers WHERE transfer_no=$1`, [String(p.transferNo ?? '')]);
      if (dup[0]) return;
      const OK_STATUS = ['待确认', '待审核', '待发货', '在途', '已入库', '驳回', '已取消'];
      const st = OK_STATUS.includes(String(p.status)) ? String(p.status) : '在途';
      await cx(c,
        `INSERT INTO stock_transfers (transfer_no, from_store_id, to_store_id, status, reason, total_cost)
         VALUES ($1,$2,$3,$4::transfer_status_t,$5,$6)`,
        [String(p.transferNo ?? '').slice(0, 32), Number(p.fromStoreId ?? storeId) || storeId,
         p.toStoreId ? Number(p.toStoreId) : null, st,
         String(p.reason ?? '').slice(0, 128) || null, Number(p.totalCost ?? 0)]);
      return;
    }

    default:
      throw new Error(`暂不支持的上行实体 ${ch.entity}（P2）`);
  }
}

async function hqFallbackEmp(c: any): Promise<number> {
  const e = await cx(c, `SELECT id FROM employees ORDER BY id LIMIT 1`);
  return e[0] ? Number(e[0].id) : 1;
}

/* ═══════════ P2-2：hq_sales_daily 物化视图去抖刷新（push 后 10s 合并；对账 job 收尾也刷） ═══════════ */
let mvRefreshTimer: NodeJS.Timeout | null = null;
export function scheduleDailyRefresh(): void {
  if (mvRefreshTimer) return;
  mvRefreshTimer = setTimeout(() => {
    mvRefreshTimer = null;
    q(`SELECT refresh_hq_sales_daily()`).catch(() => {});
  }, 10_000);
  (mvRefreshTimer as any)?.unref?.();
}

/* ═══════════════════════ 控制器 ═══════════════════════ */

@Controller('sync')
export class SyncController {
  /** 门店批量上行 */
  @Public()
  @UseGuards(NodeGuard)
  @Post('push')
  async push(@Req() req: any, @Body() body: any) {
    const { nodeCode, storeId } = req.syncNode;
    const batch = Array.isArray(body?.batch) ? body.batch.slice(0, 500) : [];
    const accepted: string[] = [];
    const rejected: { idemKey: string; reason: string }[] = [];
    let watermark = 0;

    for (const ch of batch) {
      const idemKey = String(ch.idemKey ?? '').slice(0, 128);
      watermark = Math.max(watermark, Number(ch.seq ?? 0));
      if (!idemKey) { rejected.push({ idemKey: '', reason: '缺少 idemKey' }); continue; }
      // 幂等短路：同 idemKey 已应用过 → 直接应答 accepted，不再重放业务落库
      //（否则 sale_order 的明细/支付没有唯一键，重推会插重复行）
      const done = await q1(`SELECT 1 FROM sync_inbox WHERE idem_key=$1 AND status='applied' LIMIT 1`, [idemKey]);
      if (done) { accepted.push(idemKey); continue; }
      try {
        await tx(async (c: any) => {
          await applyUpstream(c, storeId, nodeCode, ch);
          await c.query(
            `INSERT INTO sync_inbox (from_node, entity, entity_id, op, payload, version, idem_key, status, applied_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,0,$6,'applied',now())
             ON CONFLICT (idem_key) DO NOTHING`,
            [nodeCode, String(ch.entity ?? '').slice(0, 32), ch.entityId ?? null,
             String(ch.op ?? 'upsert').slice(0, 8), JSON.stringify(ch.payload ?? {}), idemKey]);
        });
        accepted.push(idemKey);
      } catch (e: any) {
        rejected.push({ idemKey, reason: String(e?.message ?? e).slice(0, 300) });
      }
    }

    await q(
      `UPDATE sync_nodes SET out_watermark = GREATEST(out_watermark,$2), last_ok_at=now(),
              last_seen_at=now(), fail_count=0
        WHERE node_code=$1`, [nodeCode, watermark]).catch(() => {});
    if (rejected.length) {
      await q(`UPDATE sync_nodes SET fail_count = fail_count + 1 WHERE node_code=$1`, [nodeCode]).catch(() => {});
    }
    // P2-2：有新单落总部 → 去抖刷新 hq_sales_daily 物化视图（10s 合并多次推送，近实时报表）
    if (accepted.length) scheduleDailyRefresh();
    return { accepted, rejected, watermark };
  }

  /** 增量拉取（target 过滤：all / 指定本店） */
  @Public()
  @UseGuards(NodeGuard)
  @Get('pull')
  async pull(@Req() req: any, @Query('since') since: string, @Query('limit') limit: string) {
    const { nodeCode, storeId } = req.syncNode;
    const s = Math.max(0, Number(since ?? 0));
    const lim = Math.min(Math.max(1, Number(limit ?? 500)), 500);
    const rows = await q<any>(
      `SELECT version, entity, entity_id, op, payload, created_at
         FROM sync_changes
        WHERE version > $1
          AND (target = 'all'
               OR (target IN ('store','stores') AND target_ids @> ARRAY[$2::bigint]))
        ORDER BY version LIMIT $3`, [s, storeId, lim]);
    const latest = await q1<{ v: string }>(`SELECT COALESCE(MAX(version),0) AS v FROM sync_changes`);
    await q(`UPDATE sync_nodes SET last_seen_at=now() WHERE node_code=$1`, [nodeCode]).catch(() => {});
    return {
      changes: rows.map(r => ({
        version: Number(r.version), entity: r.entity,
        entityId: r.entity_id != null ? Number(r.entity_id) : null,
        op: r.op,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        idemKey: `HQ:${r.version}`,
        bizPhysical: new Date(r.created_at).getTime(),
      })),
      latest: Number(latest?.v ?? 0),
    };
  }

  /** 门店确认应用水位 */
  @Public()
  @UseGuards(NodeGuard)
  @Post('pull/ack')
  async pullAck(@Req() req: any, @Body() body: any) {
    const { nodeCode } = req.syncNode;
    const ver = Math.max(0, Number(body?.version ?? 0));
    await q(`UPDATE sync_nodes SET in_version = GREATEST(in_version,$2), last_ok_at=now() WHERE node_code=$1 AND is_self=false`,
      [nodeCode, ver]);
    return { ok: true, version: ver };
  }

  /** 心跳 + 本地统计（每日对账的门店口径） */
  @Public()
  @UseGuards(NodeGuard)
  @Post('heartbeat')
  async heartbeat(@Req() req: any, @Body() body: any) {
    const { nodeCode } = req.syncNode;
    await q(
      `UPDATE sync_nodes SET last_seen_at=now(), last_ok_at=now(),
              last_report = $2::jsonb, fail_count = 0
        WHERE node_code=$1 AND is_self=false`,
      [nodeCode, JSON.stringify({ ...(body?.report ?? {}), ts: new Date().toISOString() })]);
    return { serverTime: new Date().toISOString() };
  }

  /** 新店引导 · 元信息（水位基点） */
  @Public()
  @UseGuards(NodeGuard)
  @Get('bootstrap/meta')
  async bootstrapMeta() {
    const latest = await q1<{ v: string }>(`SELECT COALESCE(MAX(version),0) AS v FROM sync_changes`);
    return { version: Number(latest?.v ?? 0) };
  }

  /** 新店引导 · 分类型快照（游标分页，幂等可重放） */
  @Public()
  @UseGuards(NodeGuard)
  @Get('bootstrap/:type')
  async bootstrap(@Req() req: any, @Param() pm: any, @Query('cursor') cursor: string, @Query('limit') limit: string) {
    const { storeId } = req.syncNode;
    const type = String(pm?.type ?? '');
    const cur = Math.max(0, Number(cursor ?? 0));
    const lim = Math.min(Math.max(1, Number(limit ?? 1000)), 2000);
    const defs: Record<string, { sql: string; strip?: string[] }> = {
      stores:       { sql: `SELECT * FROM stores WHERE id > $2 AND (org_type='hq' OR id=$1) ORDER BY id LIMIT $3`, strip: ['node_secret'] },
      categories:   { sql: `SELECT * FROM categories WHERE id > $2 ORDER BY id LIMIT $3` },
      products:     { sql: `SELECT * FROM products WHERE id > $2 ORDER BY id LIMIT $3` },
      suppliers:    { sql: `SELECT * FROM suppliers WHERE id > $2 ORDER BY id LIMIT $3` },
      member_levels:{ sql: `SELECT * FROM member_levels WHERE id > $2 ORDER BY id LIMIT $3` },
      promotions:   { sql: `SELECT * FROM promotions WHERE id > $2 ORDER BY id LIMIT $3` },
      coupons:      { sql: `SELECT * FROM coupons WHERE id > $2 ORDER BY id LIMIT $3` },
      roles:        { sql: `SELECT * FROM roles WHERE id > $2 ORDER BY id LIMIT $3` },
      // V4.28.0 安全修复（审计 F-01）：员工只下发本店人员，且剥离全部凭证哈希/令牌版本——
      //   防止任一门店节点离线爆破店长授权码后全链提权
      employees:    { sql: `SELECT * FROM employees WHERE id > $2 AND (store_id=$1 OR store_id IS NULL) ORDER BY id LIMIT $3`,
                      strip: ['password_hash', 'pin_hash', 'auth_code_hash',
                              'sec_answer1_hash', 'sec_answer2_hash', 'sec_answer3_hash', 'token_version'] },
      // 门店维数据只给本店
      store_products: { sql: `SELECT * FROM store_products WHERE id > $2 AND store_id=$1 ORDER BY id LIMIT $3` },
      prices:         { sql: `SELECT * FROM product_store_prices WHERE id > $2 AND store_id=$1 ORDER BY id LIMIT $3` },
      // V4.28.0：secret 类设置（加密落库的密文）绝不下发节点
      settings:       { sql: `SELECT id, setting_key, value, value_type, default_value FROM system_settings WHERE id > $2 AND scope='hq' AND value_type<>'secret' ORDER BY id LIMIT $3` },
    };
    const def = defs[type];
    if (!def) throw new BizException(40404, `未知的引导类型 ${type}`);
    const rows = await q<any>(def.sql, [storeId, cur, lim]);
    const strip = def.strip ?? [];
    return {
      items: rows.map(r => {
        const o: any = {};
        for (const k of Object.keys(r)) if (!strip.includes(k)) o[k] = r[k];
        return o;
      }),
      nextCursor: rows.length === lim ? Number(rows[rows.length - 1].id) : null,
    };
  }

  /* ── 后台（JWT） ── */

  /** 节点看板 */
  @RequirePerms('hq.sync.view')
  @Get('status')
  async status() {
    const latest = Number((await q1<{ v: string }>(`SELECT COALESCE(MAX(version),0) AS v FROM sync_changes`))?.v ?? 0);
    const nodes = await q<any>(
      `SELECT n.node_code, n.store_id, s.name AS store_name, s.store_no, n.node_role,
              n.out_watermark, n.in_version, n.last_seen_at, n.last_ok_at, n.fail_count, n.status,
              n.last_report,
              (${latest} - n.in_version) AS behind,
              (SELECT COUNT(*) FROM sync_outbox o WHERE o.status='dead') AS dead_total,
              (SELECT COUNT(*) FROM sync_outbox o WHERE o.status IN ('pending','failed')) AS pending_local
         FROM sync_nodes n LEFT JOIN stores s ON s.id = n.store_id
        ORDER BY n.is_self DESC, s.store_no NULLS LAST`);
    const runs = await q<any>(
      `SELECT node_code, direction, started_at, ended_at, sent, recv, failed, duration_ms, msg
         FROM sync_runs ORDER BY id DESC LIMIT 30`);
    const dead = await q<any>(
      `SELECT id, node_code, entity, entity_id, retry, last_error, created_at
         FROM sync_outbox WHERE status='dead' ORDER BY id DESC LIMIT 50`);
    const pending = await q1<{ n: string }>(
      `SELECT COUNT(*) AS n FROM sync_outbox WHERE status IN ('pending','failed')`);
    return { latest, nodes, runs, dead, pendingLocal: Number(pending?.n ?? 0) };
  }

  /** 一键重推：把指定版本区间重放为目标门店专属的新版本行 */
  @RequirePerms('hq.sync.manage')
  @Post('replay')
  async replay(@CurrentUser() user: AuthUser, @Body() body: any) {
    const storeId = Number(body?.storeId ?? 0);
    const from = Math.max(1, Number(body?.from ?? 0));
    const to = Number(body?.to ?? 0) || Number.MAX_SAFE_INTEGER;
    if (!storeId) throw new BizException(40003, '缺少目标门店');
    const r = await q1<{ n: string }>(
      `WITH ins AS (
         INSERT INTO sync_changes (entity, entity_id, op, payload, target, target_ids)
         SELECT entity, entity_id, op, payload, 'store', ARRAY[$1::bigint]
           FROM sync_changes WHERE version >= $2 AND version <= $3
         RETURNING 1)
       SELECT COUNT(*) AS n FROM ins`, [storeId, from, to]);
    await audit(storeId, user.sub, '总部', 'sync.replay', 'store', storeId, { from, to, count: Number(r?.n ?? 0) });
    return { replayed: Number(r?.n ?? 0) };
  }

  /** 实时对数（总部实际 vs 门店末次上报） */
  @RequirePerms('hq.sync.view')
  @Get('consistency')
  async consistency() {
    // L-16：昨日口径统一由 DB 会话时区（Asia/Shanghai）计算——原 JS UTC 推导在本地 00:00-08:00 间错位一天
    const yest = (await q1<{ d: string }>(`SELECT (CURRENT_DATE - 1)::text AS d`))!.d;
    const hq = await q<any>(
      `SELECT store_id, COUNT(*) AS orders, COALESCE(SUM(payable_amount),0) AS amount
         FROM sales_orders WHERE created_at::date = $1::date GROUP BY store_id`, [yest]);
    const nodes = await q<any>(
      `SELECT node_code, store_id, last_report FROM sync_nodes WHERE is_self=false`);
    const out = nodes.map((n: any) => {
      const rep = typeof n.last_report === 'string' ? JSON.parse(n.last_report) : (n.last_report ?? {});
      const h = hq.find((x: any) => Number(x.store_id) === Number(n.store_id));
      return {
        nodeCode: n.node_code, storeId: n.store_id, date: yest,
        reportDate: rep.date ?? null,
        hqOrders: Number(h?.orders ?? 0), hqAmount: Number(h?.amount ?? 0),
        nodeOrders: Number(rep.orders ?? 0), nodeAmount: Number(rep.amount ?? 0),
        diffOrders: Number(h?.orders ?? 0) - Number(rep.orders ?? 0),
        diffAmount: Number((Number(h?.amount ?? 0) - Number(rep.amount ?? 0)).toFixed(2)),
      };
    });
    return { date: yest, rows: out };
  }

  /* ── 本节点配置（门店端配置向导；JWT） ── */

  @RequirePerms('settings.update')
  @Get('self')
  async self() {
    const id = await nodeIdentity(true);
    const pending = await q1<{ n: string }>(
      `SELECT COUNT(*) AS n FROM sync_outbox WHERE status IN ('pending','failed')`);
    return { identity: id, pendingLocal: Number(pending?.n ?? 0) };
  }

  /** 配置向导：写入本节点身份（nodeCode/token/hqBase 三要素，总部「门店管理→生成密钥」发下来） */
  @RequirePerms('settings.update')
  @Post('self')
  async setSelf(@CurrentUser() user: AuthUser, @Body() body: any) {
    const nodeCode = String(body?.nodeCode ?? '').trim();
    const token = String(body?.token ?? '').trim();
    const hqBase = String(body?.hqBase ?? '').trim().replace(/\/$/, '');
    if (!nodeCode || !token || !hqBase) throw new BizException(40003, '节点编码 / 节点密钥 / 总部地址 均必填');
    const cur = await nodeIdentity(true);
    await tx(async (c: any) => {
      // 幂等：无自身行则建（store 行，store_id 指向本库的门店行）
      const selfStore = await cx(c, `SELECT id FROM stores WHERE org_type='store' ORDER BY id LIMIT 1`);
      await c.query(
        `INSERT INTO sync_nodes (node_code, store_id, name, node_role, is_self, status, self_token, hq_base, in_version)
         VALUES ($1, $2, '本节点', 'store', true, '启用', $3, $4, 0)
         ON CONFLICT (node_code) DO UPDATE
           SET is_self=true, self_token=EXCLUDED.self_token, hq_base=EXCLUDED.hq_base, status='启用'`,
        [nodeCode, selfStore[0] ? Number(selfStore[0].id) : null, token.slice(0, 128), hqBase.slice(0, 160)]);
    });
    resetNodeCache();
    await audit(null, user.sub, '同步', '本节点配置', 'sync_node', undefined, { nodeCode, hqBase });
    return { ok: true };
  }
}

/* ═══════════════════════ 每日对账 job（M4-10，方案 §4.10） ═══════════════════════ */

@Injectable()
export class SyncReconJob implements OnModuleInit {
  private readonly logger = new Logger('sync-recon');
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay = '';
  onModuleInit() {
    this.timer = setInterval(() => this.maybeRun(), 60_000);
  }
  private async maybeRun() {
    const now = new Date();
    const key = now.toISOString().slice(0, 10);
    if (now.getHours() !== 2 || now.getMinutes() !== 30 || this.lastRunDay === key) return;
    this.lastRunDay = key;
    try { await this.run(); } catch (e: any) { this.logger.error(`每日对账失败: ${e?.message ?? e}`); }
  }

  /** 对昨日：门店上报 vs 总部实际；差异≠0 落 sync_recon_daily（同日重跑覆盖） */
  async run(): Promise<void> {
    // L-16：与 consistency 同口径——昨日由 DB 会话时区计算（本地 00:00-08:00 不再错位）
    const yDate = (await q1<{ d: string }>(`SELECT (CURRENT_DATE - 1)::text AS d`))!.d;
    const hq = await q<any>(
      `SELECT store_id, COUNT(*) AS orders, COALESCE(SUM(payable_amount),0) AS amount
         FROM sales_orders WHERE created_at::date = $1::date GROUP BY store_id`, [yDate]);
    const nodes = await q<any>(`SELECT node_code, store_id, last_report FROM sync_nodes WHERE is_self=false`);
    for (const n of nodes) {
      const rep = typeof n.last_report === 'string' ? JSON.parse(n.last_report) : (n.last_report ?? {});
      const h = hq.find((x: any) => Number(x.store_id) === Number(n.store_id));
      const rows: [string, number, number][] = [
        ['count', Number(h?.orders ?? 0), Number(rep.orders ?? 0)],
        ['amount', Number(h?.amount ?? 0), Number(rep.amount ?? 0)],
      ];
      for (const [kind, hqV, nodeV] of rows) {
        const diff = Number((hqV - nodeV).toFixed(4));
        if (diff === 0) {
          await q(`DELETE FROM sync_recon_daily WHERE recon_date=$1 AND store_id=$2 AND kind=$3`,
            [yDate, n.store_id, kind]).catch(() => {});
          continue;
        }
        await q(
          `INSERT INTO sync_recon_daily (recon_date, store_id, node_code, kind, hq_value, node_value, diff, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (recon_date, store_id, kind)
           DO UPDATE SET hq_value=EXCLUDED.hq_value, node_value=EXCLUDED.node_value,
                         diff=EXCLUDED.diff, detail=EXCLUDED.detail, status='异常', created_at=now()`,
          [yDate, n.store_id, n.node_code, kind, hqV, nodeV, diff,
           JSON.stringify({ reportTs: rep.ts ?? null })]).catch(() => {});
      }
    }

    // V5.0.0 批次4B（M4-20）：进价差异单账龄 SLA 清扫（30 天转交涉 / 90 天默认按冲差强制结案）
    try {
      const a = await q(
        `UPDATE cost_variance_sheets SET status='negotiating'
          WHERE status='open' AND created_at < now() - interval '30 days' RETURNING id`);
      const b = await q(
        `UPDATE cost_variance_sheets
            SET action='writeoff', status='written_off', writeoff_amount=variance_amount,
                audit_remark=COALESCE(audit_remark,'') || '（超90天强制冲差结案）', closed_at=now()
          WHERE status IN ('open','negotiating','disputed') AND created_at < now() - interval '90 days'
            AND action IS NULL RETURNING id`);
      if (a.length || b.length) {
        this.logger.log(`差异单 SLA 清扫：转交涉 ${a.length} 单，强制冲差 ${b.length} 单`);
      }
    } catch (e: any) {
      this.logger.warn(`差异单 SLA 清扫失败（表未建或非连锁库）: ${e?.message ?? e}`);
    }

    // V5.0.0 批次5（§5.2.2 失败处理）：会员「有扣款无订单」清扫 ——
    //   门店余额扣款成功但本地落单失败（回滚）→ 总部对账 job 发现孤儿扣款 → 标记 pending_order；
    //   P2-1：超 3 天仍无订单 → 自动冲正（reverseOrphanDebits）
    try {
      const orphans = await q(
        `UPDATE member_cross_store_flows f SET status='pending_order'
          WHERE f.asset IN ('balance','dividend','points') AND f.direction='出' AND f.status='done' AND f.ref_no IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.order_no = f.ref_no AND o.store_id = f.store_id)
          RETURNING f.txn_no`);
      if (orphans.length) this.logger.warn(`会员孤儿扣款 ${orphans.length} 笔已标记 pending_order: ${orphans.map((r: any) => r.txn_no).join(',')}`);
      const rv = await reverseOrphanDebits();
      if (rv.reversed) this.logger.warn(`孤儿扣款自动冲正 ${rv.reversed} 笔: ${rv.txns.join(',')}`);
    } catch (e: any) {
      this.logger.warn(`会员孤儿扣款清扫失败（表未建）: ${e?.message ?? e}`);
    }

    // ── P2-2（§4.10）：逐批明细链完整性 —— 对昨日有明细的订单核对「Σ(qty×unit_cost) = 单头 cost_amount」
    //    （相对偏差 > 0.011 元 视为断链/串价）；按店落 sync_recon_daily kind='batch'，差平自动清除
    try {
      const bad = await q<any>(
        `WITH det AS (
           SELECT store_id, order_no, SUM(qty * unit_cost) AS detail_cost
             FROM sync_sale_batches GROUP BY store_id, order_no)
         SELECT o.store_id, o.order_no, COALESCE(o.cost_amount,0) AS cost_amount, det.detail_cost
           FROM sales_orders o JOIN det ON det.order_no = o.order_no AND det.store_id = o.store_id
          WHERE o.created_at::date = $1::date
            AND ABS(det.detail_cost - COALESCE(o.cost_amount,0)) > 0.011`, [yDate]);
      const byStore = new Map<number, { hq: number; node: number; orders: string[] }>();
      for (const r of bad) {
        const k = Number(r.store_id);
        const g = byStore.get(k) ?? { hq: 0, node: 0, orders: [] };
        g.hq += Number(r.cost_amount); g.node += Number(r.detail_cost);
        if (g.orders.length < 20) g.orders.push(String(r.order_no));
        byStore.set(k, g);
      }
      for (const [storeId2, g] of byStore) {
        await q(
          `INSERT INTO sync_recon_daily (recon_date, store_id, node_code, kind, hq_value, node_value, diff, detail)
           VALUES ($1,$2,(SELECT node_code FROM sync_nodes WHERE store_id=$2 AND is_self=false LIMIT 1),'batch',$3,$4,$5,$6::jsonb)
           ON CONFLICT (recon_date, store_id, kind)
           DO UPDATE SET hq_value=EXCLUDED.hq_value, node_value=EXCLUDED.node_value,
                         diff=EXCLUDED.diff, detail=EXCLUDED.detail, status='异常', created_at=now()`,
          [yDate, storeId2, Number(g.hq.toFixed(4)), Number(g.node.toFixed(4)),
           Number((g.hq - g.node).toFixed(4)), JSON.stringify({ mismatchOrders: g.orders })]);
      }
      // 差平（明细修复/重推后）自动清除
      const okRows = await q<any>(
        `WITH det AS (
           SELECT store_id, order_no, SUM(qty * unit_cost) AS detail_cost
             FROM sync_sale_batches GROUP BY store_id, order_no)
         SELECT o.store_id
           FROM sales_orders o JOIN det ON det.order_no = o.order_no AND det.store_id = o.store_id
          WHERE o.created_at::date = $1::date
            AND ABS(det.detail_cost - COALESCE(o.cost_amount,0)) <= 0.011
          GROUP BY o.store_id`, [yDate]);
      const okSet = new Set(okRows.map((r: any) => Number(r.store_id)));
      const left = await q<any>(
        `SELECT DISTINCT store_id FROM sync_recon_daily WHERE recon_date=$1 AND kind='batch'`, [yDate]);
      for (const r of left) {
        if (!okSet.has(Number(r.store_id))) continue;
        // 该店仍有差弢单 → 保留；全部差平 → 清除
        const stillBad = byStore.get(Number(r.store_id));
        if (!stillBad) {
          await q(`DELETE FROM sync_recon_daily WHERE recon_date=$1 AND store_id=$2 AND kind='batch'`,
            [yDate, r.store_id]);
        }
      }
      if (bad.length) this.logger.warn(`逐批明细链核对：昨日 ${bad.length} 单成本与明细不符，已落差异`);
    } catch (e: any) {
      this.logger.warn(`逐批明细链核对失败（表未建/无数据）: ${e?.message ?? e}`);
    }

    // P2-2：对账收尾刷一次日报物化（跨店报表数据新鲜度兜底）
    try { await q(`SELECT refresh_hq_sales_daily()`); } catch (e: any) {
      this.logger.warn(`hq_sales_daily 刷新失败: ${e?.message ?? e}`);
    }
  }
}

/* ═══════════════════════ P2-1：孤儿扣款自动冲正（SLA 3 天，幂等） ═══════════════════════ */

/**
 * 对标记 pending_order 超过 3 天仍无对应订单的连锁扣款流水，总部侧自动冲正：
 *   回加对应资产（余额按原本金/赠送拆分回加；分红/积分直加）
 *   + 插反向流水（ref_no=原单号:RV，idem_key 追加 :reversal 幂等）
 *   + 原流水 status='reversed'。
 * 单店库 flows 恒空 → 天然 no-op，零回归。
 */
export async function reverseOrphanDebits(): Promise<{ reversed: number; txns: string[] }> {
  const rows = await q<any>(
    `SELECT * FROM member_cross_store_flows
      WHERE status='pending_order' AND direction='出' AND asset IN ('balance','dividend','points')
        AND created_at < now() - interval '3 days'
      ORDER BY id LIMIT 100`);
  if (!rows.length) return { reversed: 0, txns: [] };
  const txns: string[] = [];
  for (const f of rows) {
    try {
      await tx(async c => {
        // 锁原流水并复查状态（防并发 job 双冲）
        const cur = await cx(c, `SELECT status FROM member_cross_store_flows WHERE id=$1 FOR UPDATE`, [f.id]);
        if (cur[0]?.status !== 'pending_order') return;
        const memberId = Number(f.member_id);
        const amt = Number(f.amount ?? 0);
        if (f.asset === 'balance') {
          await cx(c,
            `UPDATE member_accounts SET balance = balance + $2,
                    principal_balance = principal_balance + $3, gift_balance = gift_balance + $4, updated_at=now()
              WHERE member_id=$1`,
            [memberId, amt, Number(f.principal_part ?? 0), Number(f.gift_part ?? 0)]);
          await cx(c,
            `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                        biz_type, ref_type, ref_no, balance_after)
             VALUES ($1,$2,'入',$3,$4,$5,'孤儿冲正','cross_flow',$6,
                     COALESCE((SELECT balance FROM member_accounts WHERE member_id=$7),0))`,
            [f.store_id, memberId, amt, Number(f.principal_part ?? 0), Number(f.gift_part ?? 0),
             `${f.ref_no}:RV`, memberId]);
        } else if (f.asset === 'dividend') {
          await cx(c, `UPDATE member_accounts SET dividend_balance = dividend_balance + $2, updated_at=now() WHERE member_id=$1`,
            [memberId, amt]);
          await cx(c,
            `INSERT INTO dividend_records (store_id, member_id, record_type, amount, remark)
             VALUES ($1,$2,'调整',$3,$4)`,
            [f.store_id, memberId, amt, `孤儿冲正:${f.ref_no}`]);
        } else {
          await cx(c, `UPDATE members SET points = points + $2, updated_at=now() WHERE id=$1`, [memberId, Number(f.points ?? 0)]);
          await cx(c, `UPDATE member_accounts SET points = points + $2, updated_at=now() WHERE member_id=$1`, [memberId, Number(f.points ?? 0)]);
          await cx(c,
            `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
             VALUES ($1,'加',$2,'孤儿冲正','cross_flow',NULL,
                     COALESCE((SELECT points FROM members WHERE id=$3),0))`,
            [memberId, Number(f.points ?? 0), memberId]);
        }
        // 反向台账流水（幂等：idem_key 追加 :reversal）
        const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM member_cross_store_flows`);
        const d = new Date();
        const txnNo = `MCF${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(seq[0].n).padStart(4, '0')}`;
        await cx(c,
          `INSERT INTO member_cross_store_flows (txn_no, store_id, node_code, member_id, asset, direction,
                      amount, points, principal_part, gift_part, ref_no, biz_type, status, idem_key)
           VALUES ($1,$2,$3,$4,$5,'入',$6,$7,$8,$9,$10,'孤儿冲正','done',$11)`,
          [txnNo, f.store_id, f.node_code, memberId, f.asset, amt, Number(f.points ?? 0),
           Number(f.principal_part ?? 0), Number(f.gift_part ?? 0), `${f.ref_no}:RV`, `${f.idem_key}:reversal`]);
        await cx(c, `UPDATE member_cross_store_flows SET status='reversed' WHERE id=$1`, [f.id]);
        txns.push(txnNo);
      });
      // 冲正后镜像下行（余额/积分回加同步到门店）
      const mv = await import('./member-chain.module');
      try { await mv.publishMemberMirror(Number(f.member_id)); } catch { /* 镜像失败不影响冲正 */ }
    } catch (e: any) {
      // 单笔失败不阻断其余冲正（下轮 job 重试）
      continue;
    }
  }
  return { reversed: txns.length, txns };
}

/* ═══════════════════════ Module ═══════════════════════ */

@Module({
  controllers: [SyncController],
  providers: [NodeGuard, SyncStoreService, SyncReconJob],
  exports: [SyncStoreService],
})
export class SyncModule {}
