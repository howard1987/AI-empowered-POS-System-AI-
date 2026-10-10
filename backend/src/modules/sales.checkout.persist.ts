/**
 * 结账落单域（Q-01 第三切片：checkout 按聚合拆服务 · 行为不变）
 *
 * 从 sales.module checkout 原样搬移「台位占用 → 单号/主单 → 券实例核销 → 明细/批次/库存落账」段：
 *   台位归属校验（V4.21.0）/ seqLock 发号 / sales_orders 24 列主单 / 次卡·一次性券核销留痕（V5.0）/
 *   P-03 批量化落账（sale_items 多值插入 + consumeBatchesMany 恒 3 语句 + 库存合并扣减，同商品多行逐行语义）。
 *
 * 依赖以 ctx 注入；金额口径、错误码、SQL 与搬移前逐字一致。
 * 安全网：backend/tests/unit 41 单测 + tools/e2e-p03-checkout.mjs 35 项真实结账断言（含挂账）。
 */
import { BizException } from '../common/http';
import { cx, r2, seqLock } from '../common/db';
import type { AuthUser } from '../common/auth';
import { consumeBatchesMany } from './sales.fifo';
import { couponStockAfter, logCoupon } from './coupons.module';

export interface PersistCtx {
  /** 结账事务客户端 */
  c: any;
  user: AuthUser;
  dto: any;
  /** 定价域产物 */
  lines: any[];
  goodsAmount: number;
  /** 促销引擎产物（promoAmount + 整单级活动 id） */
  promo: { promoAmount: number; orderPromoId: number | null };
  couponAmount: number;
  /** 应收（元，已过促销/券/折扣/抹零/配送费） */
  payable: number;
  costTotal: number;
  profit: number;
  levelDiscountTotal: number;
  roundAmount: number;
  shiftId: number | null;
  couponIdUsed: number | null;
  couponIdsUsed: number[];
  orderDiscountCents: number;
  deliveryFee: number;
  /** 收银员 id（扫码购自助=null） */
  operatorId: number | null;
}

export interface PersistResult {
  orderId: number;
  orderNo: string;
  tableId: number | null;
  tableName: string | null;
}

/** 台位/主单/券核销/明细批次库存落账（行为与拆分前完全一致） */
export async function persistCheckoutOrder(ctx: PersistCtx): Promise<PersistResult> {
  const { c, user, dto, lines, goodsAmount, promo, couponAmount, payable, costTotal, profit,
          levelDiscountTotal, roundAmount, shiftId, couponIdUsed, couponIdsUsed,
          orderDiscountCents, deliveryFee, operatorId } = ctx;
  // ── 2. 台位归属校验（V4.21.0 P16 批2）：堂食落单即占用（停用台位拒收） ──
  let tableId: number | null = null;
  let tableName: string | null = null;
  if (dto.tableId) {
    const tbs = await cx(c, `SELECT id, name, status FROM dining_tables WHERE id=$1 AND store_id=$2`, [dto.tableId, user.storeId]);
    if (!tbs.length) throw new BizException(40404, '台位不存在');
    if (tbs[0].status === '停用') throw new BizException(40005, '该台位已停用，请先在台位管理恢复');
    tableId = Number(tbs[0].id);
    tableName = tbs[0].name;
  }

  // ── 2. 单号 + 主单 ──
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const seq = await seqLock(c, 'sales_orders', 'order_no', `XS-${ymd}-%`);
  const orderNo = `XS-${ymd}-${String(seq[0].n).padStart(4, '0')}`;
  const order = await cx(c,
    `INSERT INTO sales_orders (store_id, order_no, channel, is_emergency, member_id, cashier_id, status,
                               goods_amount, promo_amount, coupon_amount, payable_amount, cost_amount,
                               profit_amount, member_discount, round_amount, shift_id, promo_id, coupon_id,
                               remark, delivery_fee, client_ref, order_discount, pay_status, pay_paid_at, table_id,
                               coupon_ids, guest_phone)
     VALUES ($1,$2,$3,$4,$5,$6,'已完成',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'paid',now(),$22,$23,$24) RETURNING id`,
    [user.storeId, orderNo, dto.channel || '收银台', !!dto.isEmergency, dto.memberId ?? null, operatorId,
     goodsAmount, promo.promoAmount, couponAmount, payable, costTotal, profit, levelDiscountTotal,
     roundAmount, shiftId, promo.orderPromoId, couponIdUsed, dto.remark ?? null, deliveryFee,
     dto.clientRef ?? null, orderDiscountCents / 100, tableId,
     couponIdsUsed.length ? JSON.stringify(couponIdsUsed) : null, dto.guestPhone ?? null]);
  const orderId = order[0].id;
  if (tableId) {
    // 落单即占用（预留/空闲 → 使用中；使用中幂等无碍）
    await cx(c, `UPDATE dining_tables SET status='使用中', updated_at=now() WHERE id=$1`, [tableId]);
  }
  // ── 1.6b 券实例核销留痕 + 核销出库流水（V5.0）──
  for (const mcId of couponIdsUsed) {
    const usedCpn = await cx(c,
      `SELECT cp.type, cp.id AS coupon_id, cp.store_id, mc.member_id, mc.times_used, cp.discount
         FROM member_coupons mc JOIN coupons cp ON cp.id=mc.coupon_id WHERE mc.id=$1`, [mcId]);
    if (!usedCpn.length) continue;
    const uc = usedCpn[0];
    if (uc.type === '次卡') {
      // 次卡计次核销（5.3）：累加次数；用尽才置「已使用」并记核销出库
      const total = Number(uc.discount), used = Number(uc.times_used ?? 0) + 1;
      const finished = used >= total;
      await cx(c,
        `UPDATE member_coupons SET times_used=$2, used_at=now(), used_order_id=$3${finished ? ", status='已使用'" : ''} WHERE id=$1`,
        [mcId, used, orderId]);
      if (finished) {
        const sa = await couponStockAfter(c, Number(uc.coupon_id));
        await logCoupon(c, { storeId: Number(uc.store_id), couponId: Number(uc.coupon_id), memberCouponId: mcId,
          moveType: '核销出库', qty: -1, memberId: Number(uc.member_id), operatorId, docNo: orderNo,
          stockAfter: sa, remark: '结算核销(次卡完毕)' });
      }
    } else {
      // 一次性券：用后即销
      await cx(c,
        `UPDATE member_coupons SET status='已使用', used_at=now(), used_order_id=$2 WHERE id=$1`,
        [mcId, orderId]);
      const sa = await couponStockAfter(c, Number(uc.coupon_id));
      await logCoupon(c, { storeId: Number(uc.store_id), couponId: Number(uc.coupon_id), memberCouponId: mcId,
        moveType: '核销出库', qty: -1, memberId: Number(uc.member_id), operatorId, docNo: orderNo,
        stockAfter: sa, remark: '结算核销' });
    }
  }

  // ── 3. 明细 + 批次消耗 + 库存流水 ──
  // P-03 批量化：原每行 1 条 INSERT + 每 alloc 3 条批次语句 + 每行 1 条库存扣减（30 行购物车 ≈ 150 条语句）
  // → sale_items 多值插入 1 条 + 批次落账 3 条（consumeBatchesMany）+ 库存扣减 1 条（同商品多行保留原逐行语义）。
  // 金额/数量口径、pending_cost_adjusts、50001 文案与软/硬模式语义全部不变。
  const itemIds: number[] = [];
  if (lines.length) {
    const ins = await c.query(
      `INSERT INTO sale_items (order_id, product_id, unit_name, qty, unit_price, origin_price,
                               line_amount, line_cost, line_profit, price_changed, line_remark, promo_id,
                               supplier_id, biz_mode, manual_barcode, custom_name)
       SELECT $1, u.product_id, u.unit_name, u.qty, u.unit_price, u.origin_price,
              u.line_amount, u.line_cost, u.line_profit, u.price_changed, u.line_remark, u.promo_id,
              u.supplier_id, u.biz_mode, u.manual_barcode, u.custom_name
         FROM unnest($2::bigint[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[],
                     $7::numeric[], $8::numeric[], $9::numeric[], $10::boolean[], $11::text[], $12::bigint[],
                     $13::bigint[], $14::text[], $15::text[], $16::text[]) AS u(product_id, unit_name, qty,
                   unit_price, origin_price, line_amount, line_cost, line_profit, price_changed,
                   line_remark, promo_id, supplier_id, biz_mode, manual_barcode, custom_name)
       RETURNING id`, [orderId,
      lines.map((ln: any) => ln.p.id), lines.map((ln: any) => ln.unitName), lines.map((ln: any) => ln.baseQty),
      lines.map((ln: any) => ln.unitPrice), lines.map((ln: any) => ln.originPrice),
      lines.map((ln: any) => ln.lineAmount), lines.map((ln: any) => ln.lineCost),
      lines.map((ln: any) => r2(ln.lineAmount - ln.lineCost)), lines.map((ln: any) => ln.priceChanged),
      lines.map((ln: any) => ln.lineRemark), lines.map((ln: any) => ln.promoId),
      lines.map((ln: any) => ln.p.supplier_default_id ?? null), lines.map((ln: any) => ln.p.biz_mode ?? '购销'),
      lines.map((ln: any) => ln.manualBarcode ?? null), lines.map((ln: any) => (ln as any).customName ?? null)]);
    // RETURNING id 按插入顺序返回（unnest 数组序）；E2E 行序断言兜底
    for (const r of ins.rows) itemIds.push(Number(r.id));
  }
  const itemIdOf = (i: number) => itemIds[i];
  for (let i = 0; i < lines.length; i++) {
    const ln: any = lines[i];
    if (ln.shortage) {
      // 决策④：无批次/末位批次之外的差额挂起记录——成本回填工作队列（盘点/财务经 GET /sales/pending-shortages 处理）
      await cx(c,
        `INSERT INTO pending_cost_adjusts (store_id, product_id, order_id, sale_item_id, qty, cost_basis)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [user.storeId, ln.p.id, orderId, itemIdOf(i), ln.shortage.qty, ln.shortage.basis]);
    }
  }
  // 批次落账：N 行 × M alloc → 恒 3 条语句（sale_item_batches / batches / stock_flows）
  await consumeBatchesMany(c, lines.map((ln: any, i: number) => ({
    storeId: user.storeId, productId: ln.p.id, saleItemId: itemIdOf(i),
    orderId, allocs: ln.allocs, employeeId: operatorId,
  })));
  // 库存扣减：同商品只出现一次的行合并为一条 UPDATE（硬模式条件逐行保留，缺行即抛 50001 → 事务回滚）；
  // 同商品多行保持原「逐行顺序扣减」语义（软/硬混合时与原行为完全一致）。
  const trackLines = lines.filter((ln: any) => ln.p.track_inventory);
  const dupIds = new Set<number>();
  {
    const cnt = new Map<number, number>();
    for (const ln of trackLines) {
      const pid = Number(ln.p.id);
      cnt.set(pid, (cnt.get(pid) ?? 0) + 1);
      if (cnt.get(pid)! > 1) dupIds.add(pid);
    }
  }
  const batchInv = trackLines.filter((ln: any) => !dupIds.has(Number(ln.p.id)));
  const seqInv = trackLines.filter((ln: any) => dupIds.has(Number(ln.p.id)));
  if (batchInv.length) {
    const upd = await c.query(
      `UPDATE inventory_current ic SET qty_total = ic.qty_total - v.qty, updated_at=now()
         FROM unnest($2::bigint[], $3::numeric[], $4::boolean[]) AS v(pid, qty, soft)
        WHERE ic.store_id = $1 AND ic.product_id = v.pid AND (v.soft OR ic.qty_total >= v.qty)
       RETURNING ic.product_id`, [user.storeId,
      batchInv.map((ln: any) => ln.p.id), batchInv.map((ln: any) => ln.baseQty), batchInv.map((ln: any) => !!ln.allowNeg)]);
    const done = new Set(upd.rows.map((r: any) => Number(r.product_id)));
    for (const ln of batchInv) {
      if (!done.has(Number(ln.p.id))) throw new BizException(50001, `${ln.p.name} 库存不足，无法完成销售`);
    }
  }
  for (const ln of seqInv) {
    // D4 修复：库存台账 inventory_current 是唯一被扣减的账本，必须与超卖闸同口径且原子扣减。
    // 硬模式（默认）：UPDATE ... WHERE qty_total >= $2 原子校验并加行锁，影响行数=0 即库存不足 → 回滚，杜绝负库存；
    // 软模式（stock.negative_sales=开）：保留原语义，允许记账为负。
    if (ln.allowNeg) {
      await cx(c,
        `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now()
          WHERE store_id=$1 AND product_id=$3`, [user.storeId, ln.baseQty, ln.p.id]);
    } else {
      // 注意：cx 仅返回 rows，会丢失 rowCount；此处直接 c.query 以准确判断扣减是否生效
      const upd = await c.query(
        `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now()
          WHERE store_id=$1 AND product_id=$3 AND qty_total >= $2`, [user.storeId, ln.baseQty, ln.p.id]);
      if (Number(upd.rowCount ?? 0) === 0) {
        throw new BizException(50001, `${ln.p.name} 库存不足，无法完成销售`);
      }
    }
  }
  return { orderId, orderNo, tableId, tableName };
}
