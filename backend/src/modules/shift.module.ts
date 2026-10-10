import { Module, Controller, Get, Post, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { q, q1, r2, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { enqueueSync } from '../common/outbox';            // V5.0.0 批次4A：交班上行
import { SyncStoreService } from './sync-store.service';

/**
 * 交接班（方案 5.2.5 班次管理 / shifts 表 001 基线；V4.18.4 批3 增强）：
 *   open        开班：同一收银员同时仅允许一个「进行中」班次（备用金登记 + 写钱箱备用金流水）
 *   current     当前班次 + 实时汇总（现金/扫码/余额/挂账/积分应收、单数、退款、钱箱存取）——关班盘点差异的对照依据
 *   close       关班：应答=备用金+现金收入-现金退款±存取；实点 vs 应答 → diff_amount 差异留痕；超容差强制填原因
 *   cashbox     钱箱过程管理：存入/取出必选原因留痕（换零/取现/备用金补充/对账调整）
 *   open-drawer 无交易开钱箱（对钱/放零）：pos.cashbox.open 权限 + 留痕（E1 弹箱失败也调此留痕）
 *   list/detail 班次报表（分页，含收银员）
 * 收银结账可携带 shiftId（sales_orders.shift_id），班次汇总按此聚合；归属口径=支付完成时间（B4）。
 */
const CASHBOX_REASONS = ['换零', '取现', '备用金补充', '对账调整'];

class ShiftService {
  settings = new SettingsService();

  /** 班次实时汇总（sale_payments 按 channel 聚合 + 退款冲减现金 + 钱箱存取应答口径） */
  async summary(shiftId: number, storeId: number) {
    const sh = await q1<any>(`SELECT opening_float FROM shifts WHERE id=$1`, [shiftId]);
    const sales = await q1<any>(
      `SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(CASE WHEN p.channel='现金' THEN p.amount END), 0)::float8 AS cash_sales,
              COALESCE(SUM(CASE WHEN p.channel IN ('微信','支付宝') THEN p.amount END), 0)::float8 AS scan_sales,
              COALESCE(SUM(CASE WHEN p.channel='余额' THEN p.amount END), 0)::float8 AS balance_sales,
              COALESCE(SUM(CASE WHEN p.channel='赊账' THEN p.amount END), 0)::float8 AS credit_sales,
              COALESCE(SUM(CASE WHEN p.channel='积分抵扣' THEN p.amount END), 0)::float8 AS points_sales
         FROM sale_payments p JOIN sales_orders o ON o.id = p.order_id
        WHERE o.shift_id=$1 AND o.store_id=$2`, [shiftId, storeId]);
    const refunds = await q1<any>(
      `SELECT COUNT(*)::int AS refund_count,
              COALESCE(SUM(r.amount), 0)::float8 AS refund_cash
         FROM sale_refunds r JOIN sales_orders o ON o.id = r.order_id
        WHERE o.shift_id=$1 AND o.store_id=$2 AND r.refund_channel='现金' AND r.status='已退款'`,
      [shiftId, storeId]);
    // 钱箱过程流水（批3：存入/取出必选原因留痕）
    const cb = await q1<any>(
      `SELECT COALESCE(SUM(CASE WHEN type='存入' THEN amount END), 0)::float8 AS cash_in,
              COALESCE(SUM(CASE WHEN type='取出' THEN amount END), 0)::float8 AS cash_out,
              COUNT(*)::int AS flow_count
         FROM cashbox_flows WHERE shift_id=$1`, [shiftId]);
    // V5.0.15 修复：现金充值也必须计入钱箱应答。
    //   会员充值收款（pos.module.ts collectRecharge）只更新 member_accounts + balance_flows，
    //   既不写 sale_payments 也不写 cashbox_flows —— 于是这笔现金「进了钱箱却没有出处」，
    //   交班时实点现金会比应答凭空多出充值金额，收银员被迫填虚假差异原因。
    //   这里按 shift_id 汇总本班「已入账 + 现金」的充值本金（赠送金不是真金白银，不计）。
    const rc = await q1<any>(
      `SELECT COALESCE(SUM(principal), 0)::float8 AS recharge_cash,
              COUNT(*)::int AS recharge_count
         FROM recharge_orders
        WHERE shift_id=$1 AND status='已入账' AND pay_channel='现金'`, [shiftId]);
    const floatAmt = r2(Number(sh?.opening_float) || 0);
    const cashTotal = r2((sales?.cash_sales ?? 0) - (refunds?.refund_cash ?? 0)); // 现金收入 = 现销 - 现金退款
    // 应答金额（钱箱里「应该有」的现金）= 备用金 + 现金收入 + 现金充值 ± 存取（§13 B3 交接班应答）
    const cashboxTotal = r2(floatAmt + cashTotal + (rc?.recharge_cash ?? 0)
      + (cb?.cash_in ?? 0) - (cb?.cash_out ?? 0));
    return {
      openingFloat: floatAmt,
      orderCount: sales?.order_count ?? 0,
      cashSales: r2(sales?.cash_sales ?? 0),
      scanSales: r2(sales?.scan_sales ?? 0),
      balanceSales: r2(sales?.balance_sales ?? 0),
      creditSales: r2(sales?.credit_sales ?? 0),
      pointsSales: r2(sales?.points_sales ?? 0),
      refundCount: refunds?.refund_count ?? 0,
      refundCash: r2(refunds?.refund_cash ?? 0),
      cashTotal,
      rechargeCash: r2(rc?.recharge_cash ?? 0),
      rechargeCount: rc?.recharge_count ?? 0,
      cashboxIn: r2(cb?.cash_in ?? 0),
      cashboxOut: r2(cb?.cash_out ?? 0),
      cashboxFlows: cb?.flow_count ?? 0,
      cashboxTotal,
    };
  }
}

@Controller('shifts')
class ShiftController {
  private svc = new ShiftService();

  /** 开班（备用金登记；同一收银员仅一个进行中班次 → 50065）
   *  V4.25.0：新增 shiftNo（班次号，如 1/A/早班/晚班）；登录即开班框预填收银员/机号/班次号/备用金 */
  @RequirePerms('shift.manage')
  @Post('open')
  async open(
    @Body() body: { posNo?: string; shiftNo?: string; openingFloat?: number },
    @CurrentUser() user: AuthUser,
  ) {
    const exists = await q1(`SELECT id FROM shifts WHERE cashier_id=$1 AND status='进行中'`, [user.sub]);
    if (exists) throw new BizException(50065, '您已有进行中的班次，请先交班');
    const s = await q1<any>(
      `INSERT INTO shifts (store_id, cashier_id, pos_no, shift_no, opening_float)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [user.storeId, user.sub, body.posNo || 'POS-01', (String(body.shiftNo || '').trim() || null), r2(Number(body.openingFloat) || 0)]);
    // 批3：开班备用金同步落钱箱流水（口径起点）
    if (Number(body.openingFloat) > 0) {
      await q(`INSERT INTO cashbox_flows (store_id, shift_id, emp_id, type, amount, reason)
               VALUES ($1,$2,$3,'备用金',$4,'开班备用金')`,
        [user.storeId, s!.id, user.sub, r2(Number(body.openingFloat))]);
    }
    await audit(user.storeId, user.sub, '交接班', 'shift.open', 'shift', s!.id,
      { posNo: body.posNo || 'POS-01', shiftNo: body.shiftNo || '', openingFloat: body.openingFloat ?? 0 });
    return s;
  }

  /** 当前班次 + 实时汇总（无进行中班次返回 shift:null） */
  @RequirePerms('shift.manage')
  @Get('current')
  async current(@CurrentUser() user: AuthUser) {
    const s = await q1<any>(
      `SELECT sh.*, e.name AS cashier_name FROM shifts sh
         JOIN employees e ON e.id = sh.cashier_id
        WHERE sh.cashier_id=$1 AND sh.status='进行中'`, [user.sub]);
    if (!s) return { shift: null, summary: null };
    return { shift: s, summary: await this.svc.summary(s.id, user.storeId) };
  }

  /** 关班：应答=备用金+现金收入±存取；实点 vs 应答 → 差异留痕；超容差强制填原因（批3） */
  @RequirePerms('shift.manage')
  @Post(':id/close')
  async close(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { cashCounted: number; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (body.cashCounted === undefined || body.cashCounted === null) throw new BizException(40003, '缺少现金实盘金额 cashCounted');
    const s = await q1<any>(`SELECT * FROM shifts WHERE id=$1`, [id]);
    if (!s) throw new BizException(50066, '班次不存在', 404);
    if (Number(s.cashier_id) !== Number(user.sub)) throw new BizException(50066, '只能关闭本人班次');
    if (s.status !== '进行中') throw new BizException(50066, `班次已${s.status}，不可重复交班`);
    const sum = await this.svc.summary(id, user.storeId);
    const counted = r2(Number(body.cashCounted));
    const diff = r2(counted - sum.cashboxTotal);
    // 批3：超容差强制填差异原因（pos.shift.diff_tolerance，0=不容差）
    const tolerance = await this.svc.settings.getNum('pos.shift.diff_tolerance', 5);
    const reason = (body.reason || '').trim().slice(0, 200);
    if (Math.abs(diff) > tolerance && !reason)
      throw new BizException(50061, `差异 ¥${Math.abs(diff).toFixed(2)} 超过容差 ¥${tolerance.toFixed(2)}，必须填写差异原因`);
    // L-13 修复：CAS 条件收口 —— 仅「进行中」可关班；并发/重复关班影响行数为 0 → 明确报错，
    // 杜绝二次 close 覆盖首次钱箱应答（cash_counted/diff 被无声改写）。
    const closed = await q1<any>(
      `UPDATE shifts SET closed_at=now(), cash_total=$2, cash_counted=$3, diff_amount=$4,
                          order_count=$5, refund_count=$6, status='已交班', close_reason=$7
        WHERE id=$1 AND status='进行中' RETURNING *`,
      [id, sum.cashboxTotal, counted, diff, sum.orderCount, sum.refundCount, reason || null]);
    if (!closed) throw new BizException(50060, '班次不存在或已交班，请刷新后重试');
    await audit(user.storeId, user.sub, '交接班', 'shift.close', 'shift', id,
      { cashboxTotal: sum.cashboxTotal, cashCounted: counted, diff, reason: reason || null,
        orderCount: sum.orderCount, tolerance });
    // V5.0.0 批次4A：交班上行（总部/单店 no-op；非事务路径用连接池直写）
    try {
      await enqueueSync(null, 'shift', id, {
        posNo: s.pos_no, cashierId: Number(s.cashier_id), openedAt: s.opened_at, closedAt: closed?.closed_at,
        openingFloat: Number(s.opening_float ?? 0), cashTotal: sum.cashboxTotal, cashCounted: counted,
        diffAmount: diff, orderCount: sum.orderCount, refundCount: sum.refundCount,
      });
      SyncStoreService.kick();
    } catch (e) { console.error('[outbox] shift 入队失败:', (e as any)?.message); }
    return { shift: closed, summary: sum };
  }

  /** 班次报表（分页） */
  @RequirePerms('shift.manage')
  @Get()
  async list(@Query('page') page = '1', @Query('size') size = '20') {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    const items = await q(
      `SELECT sh.*, e.name AS cashier_name
         FROM shifts sh JOIN employees e ON e.id = sh.cashier_id
        ORDER BY sh.id DESC LIMIT $1 OFFSET $2`, [sz, (pn - 1) * sz]);
    return { page: pn, size: sz, items };
  }

  /** 钱箱流水（本班进行中班次；批3 过程管理） */
  @RequirePerms('shift.manage')
  @Get('cashbox')
  async cashboxList(@CurrentUser() user: AuthUser) {
    const s = await q1<any>(`SELECT id FROM shifts WHERE cashier_id=$1 AND status='进行中'`, [user.sub]);
    if (!s) return { shiftId: null, flows: [] };
    const flows = await q(
      `SELECT f.id, f.type, f.amount::float8 AS amount, f.reason, f.order_id AS "orderId", f.created_at AS "createdAt",
              e.name AS emp_name
         FROM cashbox_flows f LEFT JOIN employees e ON e.id = f.emp_id
        WHERE f.shift_id=$1 ORDER BY f.id DESC LIMIT 200`, [s.id]);
    return { shiftId: Number(s.id), flows };
  }

  /** 钱箱存入/取出（必选原因留痕；须有进行中班次 → 50066） */
  @RequirePerms('shift.manage')
  @Post('cashbox')
  async cashboxAdd(
    @Body() body: { type: string; amount: number; reason: string },
    @CurrentUser() user: AuthUser,
  ) {
    const type = body.type === '存入' || body.type === '取出' ? body.type : null;
    if (!type) throw new BizException(40003, 'type 必须为 存入/取出');
    const amount = r2(Number(body.amount));
    if (!(amount > 0)) throw new BizException(40003, '金额必须大于 0');
    const reason = (body.reason || '').trim().slice(0, 100);
    if (!CASHBOX_REASONS.includes(reason)) throw new BizException(40003, `必须选择原因：${CASHBOX_REASONS.join('/')}`);
    const s = await q1<any>(`SELECT id FROM shifts WHERE cashier_id=$1 AND status='进行中'`, [user.sub]);
    if (!s) throw new BizException(50066, '没有进行中的班次：请先开班');
    const f = await q1<any>(
      `INSERT INTO cashbox_flows (store_id, shift_id, emp_id, type, amount, reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, type, amount, reason, created_at`,
      [user.storeId, s.id, user.sub, type, amount, reason]);
    await audit(user.storeId, user.sub, '交接班', 'cashbox.' + type, 'shift', s.id,
      { amount, reason, flowId: f!.id });
    return f;
  }

  /** 无交易开钱箱留痕（对钱/放零；pos.cashbox.open 权限；前端弹箱成功/失败均调此留痕） */
  @RequirePerms('pos.cashbox.open')
  @Post('open-drawer')
  async openDrawer(@Body() body: { reason?: string; failed?: boolean }, @CurrentUser() user: AuthUser) {
    const s = await q1<any>(`SELECT id FROM shifts WHERE cashier_id=$1 AND status='进行中'`, [user.sub]);
    await audit(user.storeId, user.sub, '收银', body?.failed ? '无交易开箱失败' : '无交易开钱箱', 'shift', s?.id ?? null,
      { reason: (body?.reason || '').slice(0, 100), shiftId: s?.id ?? null });
    return { ok: true };
  }

  /** 班次详情（含当日订单清单入口按 shift_id 过滤 /sales 列表） */
  @RequirePerms('shift.manage')
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const s = await q1<any>(
      `SELECT sh.*, e.name AS cashier_name FROM shifts sh
         JOIN employees e ON e.id = sh.cashier_id WHERE sh.id=$1`, [id]);
    if (!s) throw new BizException(50066, '班次不存在', 404);
    return { shift: s, summary: await this.svc.summary(id, s.store_id) };
  }
}

@Module({ controllers: [ShiftController] })
export class ShiftModule {}
