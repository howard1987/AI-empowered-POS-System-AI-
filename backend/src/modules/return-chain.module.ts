/**
 * V5.0.0 连锁 批次4B（M4-12~M4-17, M4-19 后端）· 跨店退货 / 门店往来 / 进价差异单 / 供应商退货收口
 *
 * 方案依据：§5.7（退货 R6/R9 三门店字段）、§5.7.9（供应商退货 谁的货谁管）、
 *          §5.8.1~5.8.3（对账按 L1 结算 + 差异单两出口 补差 pickup / 冲差 writeoff）
 *
 * 单店零回归：
 *   · 跨店接口查/建的数据在单店库不存在 → 空列表 / 明确报错，不影响既有流程
 *   · 差异单生成、往来台账只在 chainEnabled() 且总部视野下触发（挂在对账生成里）
 *   · 供应商退货只「补列 + 补两个收口端点」，原单店退货流程不动
 */
import { Module, Controller, Get, Post, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, audit, r2, r3 } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { curStore } from '../common/context';
import { chainEnabled, hqStoreId, isHqStore } from '../common/scope';
import { publish } from '../common/outbox';
import { COST_REF } from '../common/sql';
import { seqLock } from '../common/db';
import { SettingsService } from './settings.module';

/* ═══════════════════════ 跨店退货（R6/R9，方案 §5.7） ═══════════════════════ */

class CrossReturnService {
  private settings = new SettingsService();

  /** ① 查原单（门店收银台在线调用）：返回原单 + 可退明细（已退数量已扣减） */
  async lookup(user: AuthUser, orderNo: string) {
    const no = String(orderNo ?? '').trim();
    if (!no) throw new BizException(40003, 'orderNo 必填');
    const ord = (await q(
      `SELECT o.id, o.order_no, o.store_id, o.created_at, o.payable_amount, o.status,
              m.name AS member_name, m.card_no
         FROM sales_orders o LEFT JOIN members m ON m.id = o.member_id
        WHERE o.order_no=$1 LIMIT 1`, [no]))[0];
    if (!ord) throw new BizException(40404, '原单不存在（跨店退货须在线查总部）', 404);
    if (ord.status !== '已完成') throw new BizException(50071, `原单状态(${ord.status})不允许退货`);
    const items = await q(
      `SELECT si.id AS sale_item_id, si.product_id, p.name AS product_name, p.barcode,
              si.unit_name, si.qty, si.unit_price, si.line_amount,
              COALESCE((SELECT SUM(ri.qty) FROM sale_refund_items ri
                         JOIN sale_refunds rf ON rf.id = ri.refund_id
                        WHERE ri.sale_item_id = si.id
                          AND rf.status IN ('已退款','待审核','创建中')), 0) AS refunded_qty
         FROM sale_items si JOIN products p ON p.id = si.product_id
        WHERE si.order_id=$1 ORDER BY si.id`, [ord.id]);
    const hq = await hqStoreId();
    return {
      orderId: Number(ord.id), orderNo: ord.order_no,
      originStoreId: Number(ord.store_id), originIsHq: Number(ord.store_id) === Number(hq),
      soldAt: ord.created_at, memberName: ord.member_name ?? null, cardNo: ord.card_no ?? null,
      items: items.map((x: any) => ({
        saleItemId: Number(x.sale_item_id), productId: Number(x.product_id),
        name: x.product_name, barcode: x.barcode, unitName: x.unit_name,
        qty: Number(x.qty), unitPrice: Number(x.unit_price), lineAmount: Number(x.line_amount),
        refundedQty: Number(x.refunded_qty), refundable: r3(Number(x.qty) - Number(x.refunded_qty)),
      })).filter((x: any) => x.refundable > 0),
      requestingStoreId: user.storeId,
      sameStore: Number(ord.store_id) === Number(user.storeId),
    };
  }

  /** ② 申请跨店退货（总部生成权威单；跨店必须在线） */
  async apply(user: AuthUser, dto: { orderNo: string; storeId?: number; items: { saleItemId: number; qty: number }[]; reason?: string }) {
    const lookup = await this.lookup(user, dto.orderNo);
    const acceptStore = Number(dto.storeId ?? user.storeId);
    if (lookup.sameStore) throw new BizException(50074, '原单即本店销售，请走本店退货，无需跨店');
    if (!Array.isArray(dto.items) || !dto.items.length) throw new BizException(40003, '退货明细不能为空');

    return tx(async c => {
      // 逐行重算金额（服务端唯一权威；unit = line_amount / qty 按比例）
      let amount = 0;
      const rows: { saleItemId: number; qty: number; amount: number }[] = [];
      for (const it of dto.items) {
        const li = lookup.items.find((x: any) => x.saleItemId === Number(it.saleItemId));
        if (!li) throw new BizException(50072, `明细行#${it.saleItemId}不属于该原单或不可退`);
        const qty = r3(Number(it.qty));
        if (!(qty > 0) || qty > li.refundable) {
          throw new BizException(50072, `${li.name} 可退数量不足（可退 ${li.refundable}）`);
        }
        const unit = Number(li.lineAmount) / Number(li.qty);
        const amt = r2(unit * qty);
        amount += amt;
        rows.push({ saleItemId: li.saleItemId, qty, amount: amt });
      }
      amount = r2(amount);
      if (amount <= 0) throw new BizException(40003, '退货金额计算为 0');

      const ymd = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, '');
      const seq = await seqLock(c, 'sale_refunds', 'refund_no', `TK-${ymd}-%`);
      const refundNo = `TK-${ymd}-${String(seq[0].n).padStart(4, '0')}`;
      const ins = await cx(c,
        `INSERT INTO sale_refunds (store_id, refund_no, order_id, amount, reason, restock, employee_id,
                                   status, refund_channel, origin_store_id, bind_store_id, is_cross_store,
                                   authorize_type, source_node, settle_status)
         VALUES ($1,$2,$3,$4,$5,false,$6,'待审核','原路退',$7,$7,true,'pending','HQ','none')
         RETURNING id`,
        [acceptStore, refundNo, lookup.orderId, amount, dto.reason ?? '跨店退货', user.sub,
         lookup.originStoreId]);
      const refundId = Number(ins[0].id);
      for (const rw of rows) {
        await cx(c, `INSERT INTO sale_refund_items (refund_id, sale_item_id, qty, amount) VALUES ($1,$2,$3,$4)`,
          [refundId, rw.saleItemId, rw.qty, rw.amount]);
      }
      await audit(curStore(), user.sub, '销售', '跨店退货申请', 'sale_refund', refundId,
        { refundNo, orderNo: dto.orderNo, acceptStore, originStore: lookup.originStoreId, amount });
      return { refundId, refundNo, amount, status: '待审核',
               originStoreId: lookup.originStoreId, acceptStoreId: acceptStore };
    });
  }

  /** ③ 总部审核（P1 必须总部授权；通过 → 下行受理店 + 现金记账往来） */
  async audit(user: AuthUser, id: number, approve: boolean) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM sale_refunds WHERE id=$1 FOR UPDATE`, [id]);
      const rf = rs[0];
      if (!rf) throw new BizException(40404, '退货单不存在', 404);
      if (!rf.is_cross_store) throw new BizException(50074, '非跨店退货单，请走门店退款审核');
      if (rf.status !== '待审核') throw new BizException(50073, `退货单状态(${rf.status})不允许审核`);
      if (!approve) {
        await cx(c, `UPDATE sale_refunds SET status='已驳回' WHERE id=$1`, [id]);
        await audit(curStore(), user.sub, '销售', '跨店退货驳回', 'sale_refund', id, {});
        return { id, status: '已驳回' };
      }
      // 现金退款默认关闭（§5.7.5：防受理店当日钱箱短款）；打开后强制记门店往来
      const channel = String(rf.refund_channel ?? '原路退');
      if (channel.includes('现金')) {
        const cashOk = await this.settings.getBool('chain.return.cross_cash', false);
        if (!cashOk) throw new BizException(50077, '跨店现金退款默认关闭（chain.return.cross_cash），请用原路退或会员余额');
      }
      await cx(c,
        `UPDATE sale_refunds SET status='已退款', authorize_type='hq', authorize_by=$2, authorize_at=now(),
                settle_status=$3
          WHERE id=$1`,
        [id, user.sub, channel.includes('现金') ? 'pending' : 'none']);
      // 现金 → 门店往来台账：受理店(B) 代付，原销店(A) 受益
      if (channel.includes('现金')) {
        await cx(c,
          `INSERT INTO store_intercompany_ledger (biz_type, biz_ref, from_store_id, to_store_id, amount, remark)
           VALUES ('return_cash',$1,$2,$3,$4,'跨店退货现金代付') ON CONFLICT DO NOTHING`,
          [rf.refund_no, Number(rf.store_id), Number(rf.origin_store_id), Number(rf.amount)]);
      }
      // 下行受理店：建「待收货」任务（明细快照随行）
      const items = await cx(c,
        `SELECT ri.qty, ri.amount, p.id AS product_id, p.name, p.barcode, ${COST_REF('p')} AS hq_cost
           FROM sale_refund_items ri
           JOIN sale_items si ON si.id = ri.sale_item_id
           JOIN products p ON p.id = si.product_id
          WHERE ri.refund_id=$1`, [id]);
      const ord = await cx(c, `SELECT order_no FROM sales_orders WHERE id=$1`, [rf.order_id]);
      await publish('cross_returns', id, {
        store_id: Number(rf.store_id), hq_refund_id: id, refund_no: rf.refund_no,
        origin_store_id: Number(rf.origin_store_id), order_no: String(ord[0]?.order_no ?? ''),
        amount: Number(rf.amount), status: '待收货',
        payload: {
          items: items.map((x: any) => ({ productId: Number(x.product_id), name: x.name,
            barcode: x.barcode, qty: Number(x.qty), amount: Number(x.amount), hqCost: Number(x.hq_cost) })),
        },
      }, 'store', [Number(rf.store_id)]);
      await audit(curStore(), user.sub, '销售', '跨店退货审核', 'sale_refund', id,
        { refundNo: rf.refund_no, amount: Number(rf.amount), channel });
      return { id, status: '已退款', published: true };
    });
  }

  /** 总部侧跨店退货单列表（待审核在前） */
  async list(user: AuthUser, only: string) {
    const rows = await q(
      `SELECT r.id, r.refund_no, r.store_id, s1.name AS accept_store, r.origin_store_id,
              s2.name AS origin_store, r.order_id, o.order_no, r.amount, r.status,
              r.refund_channel, r.authorize_type, r.authorize_at, r.recv_status, r.created_at
         FROM sale_refunds r
         LEFT JOIN stores s1 ON s1.id = r.store_id
         LEFT JOIN stores s2 ON s2.id = r.origin_store_id
         LEFT JOIN sales_orders o ON o.id = r.order_id
        WHERE r.is_cross_store
        ORDER BY (r.status='待审核') DESC, r.id DESC LIMIT 200`);
    return rows.map((x: any) => ({
      ...x, id: Number(x.id), store_id: Number(x.store_id), origin_store_id: Number(x.origin_store_id),
      amount: Number(x.amount),
    }));
  }
}

@Controller('hq/return')
class CrossReturnController {
  private svc = new CrossReturnService();

  /** 查原单（门店收银台「跨店退货」入口，需退款发起权限） */
  @RequirePerms('pos.refund.apply')
  @Get('lookup')
  lookup(@Query('orderNo') orderNo: string, @CurrentUser() user: AuthUser) {
    return this.svc.lookup(user, orderNo);
  }

  /** 申请跨店退货（总部生成权威单，待总部审核） */
  @RequirePerms('pos.refund.apply')
  @Post('apply')
  apply(@Body() b: { orderNo: string; storeId?: number; items: { saleItemId: number; qty: number }[]; reason?: string },
        @CurrentUser() user: AuthUser) {
    return this.svc.apply(user, b);
  }

  /** 总部审核列表 */
  @RequirePerms('hq.return.audit')
  @Get('tasks')
  tasks(@CurrentUser() user: AuthUser, @Query('only') only?: string) {
    return this.svc.list(user, only ?? '');
  }

  /** 总部审核（approve=false 驳回） */
  @RequirePerms('hq.return.audit')
  @Post(':id/audit')
  audit(@Param('id', ParseIntPipe) id: number,
        @Body() b: { approve: boolean },
        @CurrentUser() user: AuthUser) {
    return this.svc.audit(user, id, b.approve !== false);
  }
}

/* ═══════════════════════ 受理门店侧：跨店退货任务（本地收货） ═══════════════════════ */

@Controller('cross-returns')
class StoreCrossReturnController {
  /** 本店待收货任务列表（下行 sync 自动落 cross_return_tasks） */
  @RequirePerms('pos.refund.apply')
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await q(
      `SELECT id, hq_refund_id, refund_no, origin_store_id, order_no, amount, status,
              payload, recv_at, recv_remark, created_at
         FROM cross_return_tasks WHERE store_id=$1
        ORDER BY (status='待收货') DESC, id DESC LIMIT 100`, [user.storeId]);
    return rows.map((x: any) => ({ ...x, id: Number(x.id), amount: Number(x.amount) }));
  }

  /** 收货回执：new_batch 按总部基准进价新建批次入库 / no_restock 不入库（仅回执） */
  @RequirePerms('pos.refund.apply', 'stock.manage')
  @Post(':id/recv')
  async recv(@Param('id', ParseIntPipe) id: number,
             @Body() b: { mode: 'new_batch' | 'no_restock'; remark?: string },
             @CurrentUser() user: AuthUser) {
    const mode = b.mode === 'no_restock' ? 'no_restock' : 'new_batch';
    return tx(async c => {
      const ts = await cx(c, `SELECT * FROM cross_return_tasks WHERE id=$1 AND store_id=$2 FOR UPDATE`,
        [id, user.storeId]);
      const t = ts[0];
      if (!t) throw new BizException(40404, '任务不存在', 404);
      if (t.status !== '待收货') throw new BizException(50078, `任务状态(${t.status})不允许收货`);
      const pay = typeof t.payload === 'string' ? JSON.parse(t.payload) : (t.payload ?? {});
      if (mode === 'new_batch') {
        for (const it of (pay.items ?? [])) {
          if (!(Number(it.qty) > 0) || !it.productId) continue;
          await cx(c,
            `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date,
                                  production_date, expiry_date, inbound_cost, inbound_qty, remain_qty, status)
             VALUES ($1,$2,0,$3, CURRENT_DATE, CURRENT_DATE, '2099-12-31', $4,$5,$5,'在库')`,
            [user.storeId, Number(it.productId), `KR-${String(t.refund_no)}`, Number(it.hqCost ?? 0),
             Number(it.qty)]);
          await cx(c,
            `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost,
                                      ref_type, ref_id, employee_id)
             SELECT $1,$2,id,'入库',$3,$4,'return_sale',$5,$6 FROM batches
              WHERE batch_no=$3 AND store_id=$1 ORDER BY id DESC LIMIT 1`,
            [user.storeId, Number(it.productId), `KR-${String(t.refund_no)}`,
             Number(it.hqCost ?? 0), id, user.sub]);
        }
      }
      await cx(c, `UPDATE cross_return_tasks SET status=$2, recv_by=$3, recv_at=now(), recv_remark=$4 WHERE id=$1`,
        [id, mode === 'new_batch' ? '已入库' : '不入库', user.sub, String(b.remark ?? '').slice(0, 200) || null]);
      // 上行回执（门店节点生效；hq/单店 no-op）
      const { enqueueSync } = await import('../common/outbox');
      await enqueueSync(c, 'cross_return_ack', id, {
        refundNo: t.refund_no, mode,
        remark: String(b.remark ?? '').slice(0, 200) || null,
        recvAt: new Date().toISOString(),
      });
      await audit(user.storeId, user.sub, '销售', '跨店退货收货', 'cross_return_task', id,
        { refundNo: t.refund_no, mode });
      return { id, status: mode === 'new_batch' ? '已入库' : '不入库' };
    });
  }
}

/* ═══════════════════════ 门店往来台账（R6，方案 §5.7.3-③） ═══════════════════════ */

@Controller('hq/ledger')
class LedgerController {
  @RequirePerms('hq.ledger.view', 'hq.ledger.settle')
  @Get()
  async list(@Query('status') status: string) {
    const rows = await q(
      `SELECT l.*, s1.name AS from_store, s2.name AS to_store
         FROM store_intercompany_ledger l
         JOIN stores s1 ON s1.id = l.from_store_id
         JOIN stores s2 ON s2.id = l.to_store_id
        WHERE ($1 = '' OR l.status = $1)
        ORDER BY (l.status='pending') DESC, l.id DESC LIMIT 200`, [String(status ?? '')]);
    const pendingAmt = rows.filter((x: any) => x.status === 'pending')
      .reduce((s: number, x: any) => s + Number(x.amount), 0);
    return { items: rows.map((x: any) => ({ ...x, id: Number(x.id), amount: Number(x.amount) })),
             pendingAmount: r2(pendingAmt) };
  }

  /** 结清确认（P1 人工对冲：线下两店钱货两讫后总部确认） */
  @RequirePerms('hq.ledger.settle')
  @Post(':id/settle')
  async settle(@Param('id', ParseIntPipe) id: number,
               @Body() b: { remark?: string },
               @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM store_intercompany_ledger WHERE id=$1 FOR UPDATE`, [id]);
      if (!rs[0]) throw new BizException(40404, '往来记录不存在', 404);
      if (rs[0].status === 'settled') return { id, status: 'settled', dedup: true };
      await cx(c, `UPDATE store_intercompany_ledger SET status='settled', settled_by=$2, settled_at=now(), remark=$3 WHERE id=$1`,
        [id, user.sub, String(b.remark ?? rs[0].remark ?? '').slice(0, 200) || null]);
      // 跨店退货现金代付结清 → 同步退货单 settle_status
      if (rs[0].biz_type === 'return_cash') {
        await cx(c, `UPDATE sale_refunds SET settle_status='settled' WHERE refund_no=$1`, [rs[0].biz_ref]);
      }
      await audit(curStore(), user.sub, '财务', '门店往来结清', 'intercompany', id,
        { amount: Number(rs[0].amount), bizRef: rs[0].biz_ref });
      return { id, status: 'settled' };
    });
  }
}

/* ═══════════════════════ 进价差异单（R17 两出口，方案 §5.8.2/§5.8.3） ═══════════════════════ */

@Controller('hq/variances')
class VarianceController {
  private settings = new SettingsService();

  /** 差异单列表 + 敞口看板（§5.8.3-⑥） */
  @RequirePerms('hq.variance.manage', 'hq.cost.manage')
  @Get()
  async list(@Query('status') status: string, @Query('supplierId') supplierId: string) {
    const rows = await q(
      `SELECT v.*, s.name AS supplier_name
         FROM cost_variance_sheets v JOIN suppliers s ON s.id = v.supplier_id
        WHERE ($1 = '' OR v.status = $1)
          AND ($2 = '' OR v.supplier_id::text = $2)
        ORDER BY (v.status IN ('open','negotiating','disputed')) DESC, v.id DESC LIMIT 200`,
      [String(status ?? ''), String(supplierId ?? '')]);
    const dash = (await q(
      `SELECT
         COALESCE(SUM(variance_amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS month_new,
         COALESCE(SUM(variance_amount) FILTER (WHERE action='pickup'   AND status IN ('picked_up','carried')), 0) AS picked_up,
         COALESCE(SUM(variance_amount) FILTER (WHERE action='writeoff' AND status='written_off'), 0) AS written_off,
         COALESCE(SUM(variance_amount) FILTER (WHERE status IN ('open','negotiating','disputed')), 0) AS exposure,
         COALESCE(AVG(EXTRACT(EPOCH FROM (closed_at - created_at))/86400) FILTER (WHERE closed_at IS NOT NULL), 0) AS avg_close_days,
         COUNT(*) FILTER (WHERE status IN ('open','negotiating','disputed') AND created_at < now() - interval '60 days') AS overdue_cnt
        FROM cost_variance_sheets`))[0];
    const items = rows.map((x: any) => ({
      ...x, id: Number(x.id), supplier_id: Number(x.supplier_id),
      invoice_amount: Number(x.invoice_amount), settle_amount: Number(x.settle_amount),
      variance_amount: Number(x.variance_amount), writeoff_amount: x.writeoff_amount != null ? Number(x.writeoff_amount) : null,
      qty_total: Number(x.qty_total), item_count: Number(x.item_count),
    }));
    return { items, dashboard: {
      monthNew: r2(Number(dash.month_new)), pickedUp: r2(Number(dash.picked_up)),
      writtenOff: r2(Number(dash.written_off)), exposure: r2(Number(dash.exposure)),
      avgCloseDays: Math.round(Number(dash.avg_close_days) * 10) / 10, overdueCnt: Number(dash.overdue_cnt),
    } };
  }

  /** 差异单明细（老板要的表格：商品名称/条码/总部进价/供应商进价/差异值/差异金额…） */
  @RequirePerms('hq.variance.manage', 'hq.cost.manage', 'product.view')
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const head = (await q(
      `SELECT v.*, s.name AS supplier_name
         FROM cost_variance_sheets v JOIN suppliers s ON s.id = v.supplier_id WHERE v.id=$1`, [id]))[0];
    if (!head) throw new BizException(40404, '差异单不存在', 404);
    const items = await q(
      `SELECT i.*, st.name AS store_name
         FROM cost_variance_items i LEFT JOIN stores st ON st.id = i.store_id
        WHERE i.sheet_id=$1 ORDER BY i.gap_amount DESC, i.id`, [id]);
    return { ...head, id: Number(head.id), supplier_id: Number(head.supplier_id),
      invoice_amount: Number(head.invoice_amount), settle_amount: Number(head.settle_amount),
      variance_amount: Number(head.variance_amount), writeoff_amount: head.writeoff_amount != null ? Number(head.writeoff_amount) : null,
      items: items.map((x: any) => ({
        ...x, id: Number(x.id), productId: Number(x.product_id),
        qty: Number(x.qty), settlePrice: Number(x.settle_price), actualPrice: Number(x.actual_price),
        gap: Number(x.gap), gapAmount: Number(x.gap_amount),
      })) };
  }

  /** 两个出口（都必须审核留痕；方案 §5.8.3-①②） */
  @RequirePerms('hq.variance.manage')
  @Post(':id/action')
  async action(@Param('id', ParseIntPipe) id: number,
               @Body() b: { action: 'pickup' | 'writeoff'; auditRemark?: string; responsibility?: string },
               @CurrentUser() user: AuthUser) {
    const act = String(b.action ?? '');
    if (!['pickup', 'writeoff'].includes(act)) throw new BizException(40003, 'action 必须是 pickup / writeoff');
    if (act === 'writeoff' && !String(b.auditRemark ?? '').trim()) {
      throw new BizException(40003, '冲差必须填写审核理由（audit_remark）');
    }
    return tx(async c => {
      const vs = await cx(c, `SELECT * FROM cost_variance_sheets WHERE id=$1 FOR UPDATE`, [id]);
      const v = vs[0];
      if (!v) throw new BizException(40404, '差异单不存在', 404);
      if (!['open', 'negotiating', 'disputed'].includes(String(v.status))) {
        throw new BizException(50079, `差异单状态(${v.status})不允许出口处置`);
      }
      if (act === 'writeoff') {
        // 冲差：审核落库，不再参与对账（差异落「进货价差」，供应商收不到这笔差额）
        await cx(c,
          `UPDATE cost_variance_sheets SET action='writeoff', status='written_off', writeoff_amount=variance_amount,
                  audited_by=$2, audited_at=now(), audit_remark=$3, responsibility=$4, closed_by=$2, closed_at=now()
            WHERE id=$1`,
          [id, user.sub, String(b.auditRemark).slice(0, 200),
           ['store', 'hq', 'supplier'].includes(String(b.responsibility)) ? b.responsibility : null]);
      } else {
        // 补差：总部认这笔价 → 等下期对账单生成时自动挂 doc_type='variance_pickup'
        await cx(c,
          `UPDATE cost_variance_sheets SET action='pickup', status='picked_up',
                  audited_by=$2, audited_at=now(), audit_remark=$3, due_at = now() + interval '60 days'
            WHERE id=$1`, [id, user.sub, String(b.auditRemark ?? '').slice(0, 200) || null]);
        // 🔴 补差联动 L1（§5.8.3-④）：默认把 L1 上调至本次实价，避免同一差异无限重复生成
        const raiseL1 = await this.settings.getBool('chain.variance.pickup_raise_l1', true);
        if (raiseL1) {
          const its = await cx(c,
            `SELECT DISTINCT ON (product_id) product_id, actual_price, settle_price, product_name
               FROM cost_variance_items WHERE sheet_id=$1 AND actual_price > settle_price`, [id]);
          for (const it of its) {
            const cur = await cx(c, `SELECT standard_cost FROM products WHERE id=$1`, [Number(it.product_id)]);
            const curL1 = cur[0]?.standard_cost != null ? Number(cur[0].standard_cost) : null;
            if (curL1 == null || Number(it.actual_price) > curL1) {
              await cx(c, `UPDATE products SET standard_cost=$2 WHERE id=$1`,
                [Number(it.product_id), Number(it.actual_price)]);
              await cx(c,
                `INSERT INTO product_standard_cost_logs (product_id, old_cost, new_cost, delta, source, ref_doc_no, ref_id, reason, operator_id)
                 VALUES ($1,$2,$3,$4,'variance_pickup',$5,$6,$7,$8)`,
                [Number(it.product_id), curL1, Number(it.actual_price),
                 r2(Number(it.actual_price) - curL1), String(v.cvd_no), Number(v.id),
                 `差异单补差上调（${v.cvd_no}）`, user.sub]);
            }
          }
        }
      }
      await audit(curStore(), user.sub, '财务', `差异单${act === 'pickup' ? '补差' : '冲差'}`, 'cost_variance', id,
        { cvdNo: v.cvd_no, amount: Number(v.variance_amount), remark: b.auditRemark ?? null });
      return { id, action: act, status: act === 'pickup' ? 'picked_up' : 'written_off' };
    });
  }

  /** 转交涉（open → negotiating） */
  @RequirePerms('hq.variance.manage')
  @Post(':id/negotiate')
  async negotiate(@Param('id', ParseIntPipe) id: number,
                  @Body() b: { remark?: string },
                  @CurrentUser() user: AuthUser) {
    const r = await q(
      `UPDATE cost_variance_sheets SET status='negotiating', audit_remark=$2 WHERE id=$1 AND status='open' RETURNING id`,
      [id, String(b.remark ?? '').slice(0, 200) || null]);
    if (!r.length) throw new BizException(50079, '仅「待处理」状态可转交涉');
    await audit(curStore(), user.sub, '财务', '差异单转交涉', 'cost_variance', id, {});
    return { id, status: 'negotiating' };
  }

  /** 账龄 SLA 清扫（30 天转交涉 / 90 天默认按冲差强制结案；由每日对账 job 调用） */
  async sweepOverdue(): Promise<{ negotiated: number; forceClosed: number }> {
    const a = await q(
      `UPDATE cost_variance_sheets SET status='negotiating'
        WHERE status='open' AND created_at < now() - interval '30 days' RETURNING id`);
    const b = await q(
      `UPDATE cost_variance_sheets
          SET action='writeoff', status='written_off', writeoff_amount=variance_amount,
              audit_remark=COALESCE(audit_remark,'') || '（超90天强制冲差结案）', closed_at=now()
        WHERE status IN ('open','negotiating','disputed') AND created_at < now() - interval '90 days'
        RETURNING id`);
    return { negotiated: a.length, forceClosed: b.length };
  }
}

/* ═══════════════════════ 供应商退货收口（M4-17，谁的货谁管） ═══════════════════════ */

@Controller('hq/purchase-returns')
class HqPurchaseReturnController {
  /** 全部门店退厂单列表（总部视角） */
  @RequirePerms('hq.preturn.audit', 'recon.confirm')
  @Get()
  async list(@Query('status') status: string) {
    const rows = await q(
      `SELECT r.*, s.name AS store_name, sup.name AS supplier_name
         FROM purchase_returns r
         JOIN stores s ON s.id = r.store_id
         JOIN suppliers sup ON sup.id = r.supplier_id
        WHERE ($1 = '' OR r.status::text = $1)
        ORDER BY r.id DESC LIMIT 200`, [String(status ?? '')]);
    return rows.map((x: any) => ({ ...x, id: Number(x.id), store_id: Number(x.store_id),
      supplier_id: Number(x.supplier_id), total_amount: x.total_amount != null ? Number(x.total_amount) : null }));
  }

  /**
   * 发货确认：货从门店出 → 记「供应商退货货值转移」门店往来（总部受益），
   * 防门店报表凭空掉一块毛利（§5.7.9 四条规则之 2）
   */
  @RequirePerms('hq.preturn.audit')
  @Post(':id/ship')
  async ship(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE`, [id]);
      const r = rs[0];
      if (!r) throw new BizException(40404, '退厂单不存在', 404);
      if (r.status !== '已审核') throw new BizException(50080, `退厂单状态(${r.status})须先审核通过再发货`);
      if (r.ship_at) return { id, dedup: true };
      await cx(c, `UPDATE purchase_returns SET ship_at=now(), ship_by=$2 WHERE id=$1`, [id, user.sub]);
      const hq = await hqStoreId();
      if (Number(r.store_id) !== Number(hq) && Number(r.total_amount) > 0) {
        await cx(c,
          `INSERT INTO store_intercompany_ledger (biz_type, biz_ref, from_store_id, to_store_id, amount, remark)
           VALUES ('supplier_return',$1,$2,$3,$4,'供应商退货货值转移（总部结清）') ON CONFLICT DO NOTHING`,
          [r.return_no, Number(r.store_id), Number(hq), Number(r.total_amount)]);
      }
      await audit(curStore(), user.sub, '采购', '供应商退货发货', 'purchase_return', id,
        { returnNo: r.return_no, amount: Number(r.total_amount) });
      return { id, status: '已发货' };
    });
  }

  /** 总部结清（冲应付 / 供应商收款）→ 往来台账同步结清 */
  @RequirePerms('hq.preturn.audit')
  @Post(':id/settle')
  async settle(@Param('id', ParseIntPipe) id: number,
               @Body() b: { settleType: string; settleRef?: string; remark?: string },
               @CurrentUser() user: AuthUser) {
    if (!b.settleType) throw new BizException(40003, 'settleType 必填（冲应付/供应商退款/换货）');
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE`, [id]);
      const r = rs[0];
      if (!r) throw new BizException(40404, '退厂单不存在', 404);
      if (!r.ship_at) throw new BizException(50080, '退厂单尚未发货确认，不能结清');
      await cx(c, `UPDATE purchase_returns SET settle_type=$2, settle_ref=$3, remark=COALESCE(remark,'') || $4 WHERE id=$1`,
        [id, String(b.settleType).slice(0, 12), String(b.settleRef ?? '').slice(0, 32) || null,
         b.remark ? `；结清：${String(b.remark).slice(0, 80)}` : '']);
      await cx(c, `UPDATE store_intercompany_ledger SET status='settled', settled_by=$2, settled_at=now()
                    WHERE biz_type='supplier_return' AND biz_ref=$1 AND status='pending'`,
        [r.return_no, user.sub]);
      await audit(curStore(), user.sub, '采购', '供应商退货结清', 'purchase_return', id,
        { returnNo: r.return_no, settleType: b.settleType });
      return { id, settled: true };
    });
  }
}

@Module({
  controllers: [CrossReturnController, StoreCrossReturnController, LedgerController,
                VarianceController, HqPurchaseReturnController],
})
export class ReturnChainModule {}
