/**
 * 结账资产域（Q-01 第四切片：checkout 按聚合拆服务 · 行为不变）
 *
 * 从 sales.module checkout 原样搬移「会员权益 + 消费后奖励 + 结账审计 + 负库存标记 + 上行入队」段：
 *   积分按等级倍率计提 / 有效消费活跃窗口（V4.3.2 双门槛）/ 消费成长值（V5.0.17）/ 等级同步 /
 *   消费后奖励 SAVEPOINT 隔离（V4.14.1）/ sale.checkout 审计 / 负库存挂起标记（决策④）/
 *   sync_outbox 同事务上行（批次4A + M5-5 窗口快照 + P2-2 逐批明细）。
 *
 * 依赖以 ctx 注入；金额口径、返回结构、错误处理与搬移前逐字一致。
 * 安全网：backend/tests/unit 41 单测 + tools/e2e-p03-checkout.mjs 35 项真实结账断言（含挂账）。
 */
import { audit, cx, r2 } from '../common/db';
import { enqueueSync } from '../common/outbox';
import type { AuthUser } from '../common/auth';
import type { SettingsService } from './settings.module';
import { memberGrowth } from './member-growth.service';
import { syncMemberLevel } from './members.module';
import { grantPostCheckoutRewards } from './promotions.module';

export interface AssetsCtx {
  /** 结账事务客户端 */
  c: any;
  user: AuthUser;
  dto: any;
  settings: SettingsService;
  orderId: number;
  orderNo: string;
  payable: number;
  /** 有效消费（元，支付域产物） */
  validSpend: number;
  levelDiscountTotal: number;
  promo: { promoAmount: number; orderPromoId: number | null };
  couponAmount: number;
  goodsAmount: number;
  costTotal: number;
  profit: number;
  roundAmount: number;
  orderDiscountCents: number;
  deliveryFee: number;
  shiftId: number | null;
  operatorId: number | null;
  tableId: number | null;
  tableName: string | null;
  /** 定价域产物 */
  lines: any[];
  levelCtx: { discount: number; pointRate: number; levelId: number | null } | null;
  /** 支付域产物（上行快照用） */
  payLog: { channel: string; amount: number; externalNo: string | null }[];
}

/** 会员权益/奖励/审计/上行（行为与拆分前完全一致），返回 checkout 最终响应 */
export async function finalizeCheckoutAssets(ctx: AssetsCtx): Promise<any> {
  const { c, user, dto, settings, orderId, orderNo, payable, validSpend, levelDiscountTotal, promo,
          couponAmount, goodsAmount, costTotal, profit, roundAmount, orderDiscountCents, deliveryFee,
          shiftId, operatorId, tableId, tableName, lines, levelCtx } = ctx;
  const payLog = ctx.payLog;
  // ── 5. 会员权益：积分（等级倍率 5.3）+ 有效消费窗口（V4.3.2 双门槛）+ 等级同步（5.1.12） ──
  let levelResult: any = null;
  let pointsEarned = 0;
  if (dto.memberId) {
    // L-20（拍板 2026-10-09）：积分计提基数改为**有效消费口径**（储值本金+现金类实付，5.1.16）——
    // 原 payable 含券/积分/分红抵扣部分，存在「用积分/分红支付反赚积分」的套利空间。
    pointsEarned = Math.floor(validSpend * (levelCtx?.pointRate ?? 1));
    const ms = await cx(c,
      `UPDATE members SET points = points + $2, last_active_date = CURRENT_DATE, updated_at=now()
        WHERE id=$1 RETURNING points`, [dto.memberId, pointsEarned]);
    await cx(c,
      `UPDATE member_accounts SET points = points + $2, updated_at=now() WHERE member_id=$1`,
      [dto.memberId, pointsEarned]);
    await cx(c,
      `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
       VALUES ($1,'加',$2,'消费','sale',$3,$4)`,
      [dto.memberId, pointsEarned, orderId, Number(ms[0]?.points ?? 0)]);

    const minSingle = await settings.getNum('dividend.min_single', 5);
    const minWindow = await settings.getNum('dividend.min_window', 50);
    const windowDays = await settings.getNum('dividend.window_days', 30);
    if (validSpend >= minSingle) {
      // 优先累加未达标的活跃窗口；同日已有窗口（含已达标）原地累加，避免唯一键冲突；
      // 既无未达标窗口也无同日窗口时才开新窗口
      const ws = await cx(c,
        `SELECT * FROM member_activity_windows
          WHERE member_id=$1 AND qualified=false AND window_start >= CURRENT_DATE - $2::int
          ORDER BY id DESC LIMIT 1 FOR UPDATE`, [dto.memberId, windowDays]);
      let win = ws.length ? ws[0] : null;
      if (!win) {
        const sameDay = await cx(c,
          `SELECT * FROM member_activity_windows
            WHERE member_id=$1 AND window_start=CURRENT_DATE FOR UPDATE`, [dto.memberId]);
        win = sameDay.length ? sameDay[0] : null;
      }
      if (win) {
        const valid = r2(Number(win.valid_total) + validSpend);
        await cx(c,
          `UPDATE member_activity_windows SET valid_total=$2, qualified = qualified OR $3,
                  window_end = GREATEST(window_end, CURRENT_DATE), updated_at=now()
            WHERE id=$1`, [win.id, valid, valid >= minWindow]);
      } else {
        await cx(c,
          `INSERT INTO member_activity_windows (member_id, window_start, window_end, valid_total, qualified)
           VALUES ($1, CURRENT_DATE, CURRENT_DATE + $2::int, $3, $4)`,
          [dto.memberId, windowDays, validSpend, validSpend >= minWindow]);
      }
    }
    // V5.0.17：消费成长值（仅非排除商品的现金实付部分；余额/分红/积分抵扣与券抵扣不计）
    await memberGrowth.earnConsume(c, { memberId: Number(dto.memberId), orderId });
    levelResult = await syncMemberLevel(c, dto.memberId);
  }

  // V4.14.1 消费后奖励：满阈值发购物券/登记赠品。原 try/catch 只吞异常，但奖励内若有真实 SQL 失败，
  // PG 事务已 abort → 后续 audit/COMMIT 全部失败 → 整单结账失败（与注释「失败不阻断收银」相悖）。
  // 改用 SAVEPOINT 隔离：奖励失败只回滚奖励自身写入，主事务仍正常提交。
  let rewards: any[] = [];
  if (dto.memberId) {
    try {
      await c.query('SAVEPOINT sp_rewards');
      rewards = await grantPostCheckoutRewards(c, user.storeId, Number(dto.memberId), payable, orderId, user.sub);
      await c.query('RELEASE SAVEPOINT sp_rewards');
    } catch (e: any) {
      await c.query('ROLLBACK TO SAVEPOINT sp_rewards').catch(() => {});
      rewards = [];
      console.warn(`[checkout] 消费后奖励发放失败（已隔离，不影响结账）: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  await audit(user.storeId, operatorId, '收银',
    dto.isEmergency ? 'sale.checkout.emergency' : dto.selfCheckout ? 'sale.checkout.self' : 'sale.checkout',
    'sales_order', orderId, { orderNo, payable, costTotal, profit, validSpend, levelDiscount: levelDiscountTotal,
      promoAmount: promo.promoAmount, orderPromoId: promo.orderPromoId, channel: dto.channel || '收银台',
      deliveryFee, tableId: tableId ?? undefined, tableName: tableName ?? undefined });

  // 决策④：负库存挂起标记——软模式差额不再静默；negativeHold/pendingShortages 供收银端提示与盘点工作台拉取
  const negLines = lines.filter((l: any) => l.shortage);

  // ── 6. 上行入队（V5.0.0 批次4A）：与业务【同事务】，崩溃/断电也不丢数据（方案 §4.3.1）。
  //    总部/单店节点（node_role='hq'）内部 no-op，sync_outbox 恒空 = 单店零回归。
  //    队列表异常时让它抛出 → 与业务一起回滚（保持「业务成功 ⇔ 变更入队」原子性）。
  let memberCard: string | null = null;
  if (dto.memberId) {
    const mc = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
    memberCard = mc[0]?.card_no ?? null;
  }
  // 批次5（M5-5）：活跃窗口快照随单上行（分红资格判定窗口总部可见）
  let windowSnap: any = null;
  if (dto.memberId) {
    windowSnap = (await cx(c,
      `SELECT window_start, window_end, valid_total, qualified FROM member_activity_windows
        WHERE member_id=$1 ORDER BY id DESC LIMIT 1`, [dto.memberId]))[0] ?? null;
  }
  void windowSnap;   // M5-5 预留：快照字段随 payload 扩展时启用（保留查询以维持原时序）
  // ── P2-2（§4.2 明细链补齐）：逐批出库明细随单上行（批次号跨库对齐，总部落 sync_sale_batches 对账）──
  const batchIds = [...new Set(lines.flatMap((ln: any) => (ln.allocs ?? []).map((a: any) => Number(a.batchId))))].filter(Boolean);
  const bnoMap = new Map<number, string>();
  if (batchIds.length) {
    for (const r of await cx(c, `SELECT id, batch_no FROM batches WHERE id = ANY($1::bigint[])`, [batchIds])) {
      bnoMap.set(Number(r.id), String(r.batch_no));
    }
  }
  await enqueueSync(c, 'sale_order', orderId, {
    orderNo, channel: dto.channel || '收银台', payable, goodsAmount,
    costAmount: costTotal, profit, roundAmount, orderDiscount: orderDiscountCents / 100,
    deliveryFee, remark: dto.remark ?? null, isEmergency: !!dto.isEmergency,
    memberCard, shiftNo: shiftId ?? null, createdAt: new Date().toISOString(),
    pointsEarned, validSpend,   // 批次5（M5-5）：总部累加积分/total_consume（R4 连锁累计）
    items: lines.map((ln: any) => ({
      goodsNo: ln.p.goods_no, barcode: ln.p.barcode ?? '', name: ln.p.name,
      unitName: ln.unitName, qty: ln.baseQty, unitPrice: ln.unitPrice,
      lineAmount: ln.lineAmount, lineCost: ln.lineCost,
      batches: (ln.allocs ?? []).map((a: any) => ({
        batchNo: bnoMap.get(Number(a.batchId)) ?? '', qty: a.qty, unitCost: a.cost,
      })).filter((x: any) => x.batchNo),
    })),
    payments: payLog,
  });

  return { orderId, orderNo, goodsAmount, promoAmount: promo.promoAmount, couponAmount, payable, costTotal, profit,
           roundAmount, orderDiscount: orderDiscountCents / 100, shiftId, points: dto.memberId ? pointsEarned : 0, validSpend, level: levelResult, rewards,
           tableId: tableId ?? undefined, tableName: tableName ?? undefined,
           negativeHold: negLines.length > 0,
           pendingShortages: negLines.map((l: any) => ({ productId: Number(l.p.id), name: l.p.name, qty: l.shortage.qty, basis: l.shortage.basis })) };
}
