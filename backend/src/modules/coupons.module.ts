/**
 * 优惠券模块（设计方案 5.9 券管理：券模板、发券、领取、核销、过期）
 *   - 类型：满减券（threshold+discount=金额）/ 折扣券（discount=折扣率 0~1）/ 兑换券（scope 内一件免费）/ 次卡（discount=总次数，按次核销 5.3）
 *   - 记账口径（sales_orders 注释）：应收 = goods - promo - coupon - member_discount + round
 *     券在促销之后计算，门槛按商品原价货值（goods_amount）判定
 *   - 核销留痕：member_coupons.status/used_at/used_order_id + sales_orders.coupon_amount/coupon_id
 *   - 有效消费口径不受影响：券抵扣不是"本金+现金"，天然不计入活跃窗口（5.1.16）
 */
import { Body, Controller, Get, Module, Param, Post, Req } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { audit, q, r2, tx } from '../common/db';
import type { PoolClient } from 'pg';

const cx = (c: PoolClient, sql: string, params: any[] = []) => c.query(sql, params).then(r => r.rows);

export interface SaleLineLike { p: { id: number }; unitPrice: number; lineAmount: number; }

/** 收银核销入口（sales.module 在促销层之后调用；事务内 FOR UPDATE 防并发重复核销） */
export async function applyCoupon(
  c: PoolClient, memberId: number, mcId: number,
  goodsAmount: number, promoAmount: number, lines: SaleLineLike[],
): Promise<{ amount: number; memberCouponId: number; name: string }> {
  if (!memberId) throw new BizException(40003, '使用优惠券必须关联会员');
  const rows = await cx(c,
    `SELECT mc.id, mc.status, mc.expire_at, mc.times_used, cp.name, cp.type, cp.threshold, cp.discount, cp.scope, cp.status AS tpl_status
       FROM member_coupons mc JOIN coupons cp ON cp.id = mc.coupon_id
      WHERE mc.id = $1 AND mc.member_id = $2 FOR UPDATE OF mc`, [mcId, memberId]);
  if (!rows.length) throw new BizException(50040, '优惠券不存在或不属于该会员');
  const mc = rows[0];
  if (mc.status === '已使用') throw new BizException(50041, '该券已使用');
  if (mc.status === '已过期') throw new BizException(50041, '该券已过期');
  // 过期兜底（过期扫描未跑时也拦截）：expire_at 为 DATE（pg 返回 Date 对象，取本地日期比对）
  const e: any = mc.expire_at;
  const expStr = e instanceof Date
    ? `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`
    : String(e).slice(0, 10);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (expStr < today) throw new BizException(50041, `该券已于 ${expStr} 过期`);
  if (mc.tpl_status !== 1) throw new BizException(50044, '券模板已停用');

  // 叠加开关
  const stackRow = await cx(c, `SELECT value FROM system_settings WHERE setting_key='coupon.stack_with_promo'`);
  const stack = !stackRow.length || Number(stackRow[0].value) === 1; // JSONB 数值返回 JS number
  if (!stack && promoAmount > 0) throw new BizException(50046, '当前设置：优惠券不与促销活动叠加');

  let amount = 0;
  if (mc.type === '满减券') {
    if (goodsAmount < Number(mc.threshold)) throw new BizException(50042, `未达门槛：货值 ${r2(goodsAmount)} < ${r2(Number(mc.threshold))}`);
    amount = Math.min(r2(Number(mc.discount)), r2(goodsAmount - promoAmount));
  } else if (mc.type === '折扣券') {
    const rate = Number(mc.discount);
    if (!(rate > 0 && rate < 1)) throw new BizException(40003, '折扣券折扣率必须在 0~1 之间');
    if (mc.threshold && goodsAmount < Number(mc.threshold)) throw new BizException(50042, `未达门槛：货值 ${r2(goodsAmount)} < ${r2(Number(mc.threshold))}`);
    amount = r2((goodsAmount - promoAmount) * (1 - rate));
  } else if (mc.type === '兑换券') {
    const scopeIds: number[] = (mc.scope?.productIds || []).map(Number);
    const matched = lines.filter(ln => scopeIds.includes(Number(ln.p.id)));
    if (!matched.length) throw new BizException(50043, '订单中不含兑换券适用商品');
    amount = Math.min(...matched.map(ln => ln.unitPrice)); // 免费兑换一件（取适用商品中最低价一件，保守口径）
  } else if (mc.type === '次卡') {
    // 计次核销（5.3 P2-3c）：discount=总次数，每单核销 1 次；次卡不抵扣金额（会员价已在计价层生效）
    const total = Number(mc.discount);
    const used = Number(mc.times_used ?? 0);
    if (!(total > 0)) throw new BizException(40003, '次卡总次数配置非法');
    if (used >= total) throw new BizException(50045, `次卡次数已用完（${used}/${total}）`);
    amount = 0;
  } else {
    throw new BizException(40003, '不支持的券类型');
  }
  return { amount, memberCouponId: mc.id, name: mc.name };
}

@Controller('coupons')
export class CouponsController {

  /** 创建券模板（coupon.manage） */
  @Post()
  @RequirePerms('coupon.manage')
  create(@Body() b: any, @CurrentUser() user: AuthUser) {
    const name = String(b.name || '').trim();
    if (!name || name.length > 32) throw new BizException(40003, '券名称必填且 ≤32 字');
    const type = String(b.type || '');
    if (!['满减券', '折扣券', '兑换券', '次卡'].includes(type)) throw new BizException(40003, '券类型非法（满减券/折扣券/兑换券/次卡）');
    const threshold = b.threshold != null ? Number(b.threshold) : null;
    const discount = b.discount != null ? Number(b.discount) : null;
    const validDays = Number(b.validDays || 30);
    if (!(validDays >= 1 && validDays <= 365)) throw new BizException(40003, '领取后有效天数须在 1~365');
    const perMember = Number(b.perMember || 1);
    if (!(perMember >= 1)) throw new BizException(40003, '每人限领数须 ≥1');
    if (type === '满减券') {
      if (!(threshold && threshold > 0)) throw new BizException(40003, '满减券必须设置门槛');
      if (!(discount && discount > 0)) throw new BizException(40003, '满减券必须设置面额');
      if (discount >= threshold) throw new BizException(40003, '满减面额不得 ≥ 门槛');
    }
    if (type === '折扣券' && !(discount && discount > 0 && discount < 1)) {
      throw new BizException(40003, '折扣券折扣率必须在 0~1 之间（如 0.8 = 8 折）');
    }
    if (b.totalQty != null && !(Number(b.totalQty) >= 1)) throw new BizException(40003, '发放总量须 ≥1');
    return tx(async c => {
      const rows = await cx(c,
        `INSERT INTO coupons (store_id, name, type, threshold, discount, valid_days, total_qty, per_member, scope, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING *`,
        [user.storeId, name, type, threshold, discount, validDays,
         b.totalQty != null ? Number(b.totalQty) : null, perMember,
         b.scope ? JSON.stringify(b.scope) : null]);
      return rows[0];
    });
  }

  /** 券模板列表（含核销统计） */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return q(
      `SELECT cp.*,
              count(mc.id) FILTER (WHERE mc.status='未使用')::int AS unused_count,
              count(mc.id) FILTER (WHERE mc.status='已使用')::int AS used_count,
              count(mc.id) FILTER (WHERE mc.status='已过期')::int AS expired_count
         FROM coupons cp LEFT JOIN member_coupons mc ON mc.coupon_id = cp.id
        WHERE cp.store_id = $1
        GROUP BY cp.id ORDER BY cp.id DESC`, [user.storeId]);
  }

  /** 发券：指定会员或全员（total_qty 池 + per_member 限领，事务 FOR UPDATE 防超发） */
  @Post(':id/issue')
  @RequirePerms('coupon.manage')
  issue(@Param('id') id: string, @Body() b: { memberIds?: number[]; all?: boolean }, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const cps = await cx(c, `SELECT * FROM coupons WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id, user.storeId]);
      if (!cps.length) throw new BizException(40004, '券模板不存在');
      const cp = cps[0];
      if (cp.status !== 1) throw new BizException(50044, '券模板已停用');

      let memberIds: number[];
      if (b.all) {
        const ms = await cx(c, `SELECT id FROM members WHERE status='正常' AND deleted_at IS NULL`);
        memberIds = ms.map(m => Number(m.id));
      } else {
        memberIds = (b.memberIds || []).map(Number);
      }
      memberIds = [...new Set(memberIds)];
      if (!memberIds.length) throw new BizException(40003, '未指定发放对象');

      // 总量池校验（发放量 = 新增领取数，只数本次新增的资格，不限已领）
      const toIssue: number[] = [];
      for (const mid of memberIds) {
        const owned = await cx(c,
          `SELECT count(*)::int AS n FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [id, mid]);
        if (owned[0].n >= cp.per_member) continue; // 限领内的不再重复发
        toIssue.push(mid);
      }
      const newCount = toIssue.length;
      if (cp.total_qty != null && cp.issued_qty + newCount > cp.total_qty) {
        throw new BizException(50038, `发放总量不足：剩余 ${cp.total_qty - cp.issued_qty} 张，需 ${newCount} 张`);
      }
      const d = new Date();
      const exp = new Date(d.getFullYear(), d.getMonth(), d.getDate() + cp.valid_days);
      const expStr = `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}-${String(exp.getDate()).padStart(2, '0')}`;
      for (const mid of toIssue) {
        const ins = await cx(c,
          `INSERT INTO member_coupons (coupon_id, member_id, expire_at) VALUES ($1,$2,$3) RETURNING id`, [id, mid, expStr]);
        // V4.19.0 券码手输：发券即生成券码（MC+8位序号，纸质券可印码，收银台手输核销）
        await cx(c, `UPDATE member_coupons SET code='MC'||lpad(id::text,8,'0') WHERE id=$1 AND code IS NULL`, [ins[0].id]);
      }
      await cx(c, `UPDATE coupons SET issued_qty = issued_qty + $2 WHERE id=$1`, [id, newCount]);
      return { issued: newCount, skipped: memberIds.length - newCount, expireAt: expStr };
    });
  }

  /** 会员自助领取（小程序/API 通道；同样受总量池与限领约束）
   *  P2-M10：员工代会员领取需持发券/收银/建档类权限，防任意人占领限量券 */
  @RequirePerms('coupon.manage', 'pos.sell', 'member.register')
  @Post('claim')
  async claim(@Body() b: { couponId: number; memberId: number }) {
    return this.doClaim(b);
  }
  private async doClaim(b: { couponId: number; memberId: number }) {
    return tx(async c => {
      const cps = await cx(c, `SELECT * FROM coupons WHERE id=$1 AND status=1 FOR UPDATE`, [b.couponId]);
      if (!cps.length) throw new BizException(40004, '券模板不存在或已停用');
      const cp = cps[0];
      const owned = await cx(c,
        `SELECT count(*)::int AS n FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [b.couponId, b.memberId]);
      if (owned[0].n >= cp.per_member) throw new BizException(50039, `已达每人限领上限（${cp.per_member} 张）`);
      if (cp.total_qty != null && cp.issued_qty + 1 > cp.total_qty) throw new BizException(50038, '券已领完');
      const d = new Date();
      const exp = new Date(d.getFullYear(), d.getMonth(), d.getDate() + cp.valid_days);
      const expStr = `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}-${String(exp.getDate()).padStart(2, '0')}`;
      const ins = await cx(c,
        `INSERT INTO member_coupons (coupon_id, member_id, expire_at) VALUES ($1,$2,$3) RETURNING *`,
        [b.couponId, b.memberId, expStr]);
      // V4.19.0 券码手输：发券即生成券码
      await cx(c, `UPDATE member_coupons SET code='MC'||lpad(id::text,8,'0') WHERE id=$1 AND code IS NULL`, [ins[0].id]);
      await cx(c, `UPDATE coupons SET issued_qty = issued_qty + 1 WHERE id=$1`, [b.couponId]);
      return ins[0];
    });
  }

  /** 会员券包 */
  @Get('member/:memberId')
  memberCoupons(@Param('memberId') memberId: string) {
    return q(
      `SELECT mc.*, cp.name, cp.type, cp.threshold, cp.discount, cp.scope
         FROM member_coupons mc JOIN coupons cp ON cp.id = mc.coupon_id
        WHERE mc.member_id = $1 ORDER BY mc.status, mc.expire_at`, [memberId]);
  }

  /** V4.19.0 券码手输（A2 后半，P15.5 #8）：纸质券码手输核销——按券码定位券实例，校验归属会员+未使用 */
  @RequirePerms('pos.sell')
  @Post('lookup-code')
  async lookupCode(@Body() b: { code?: string; memberId?: number }, @CurrentUser() user: AuthUser) {
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^MC\d{8}$/.test(code)) throw new BizException(40003, '券码格式应为 MC + 8 位数字（印在纸质券上）');
    const rows = await q(
      `SELECT mc.id, mc.member_id, mc.status, mc.expire_at, mc.times_used, cp.name, cp.type, cp.threshold, cp.discount, cp.scope
         FROM member_coupons mc JOIN coupons cp ON cp.id = mc.coupon_id
        WHERE mc.code = $1 AND cp.store_id = $2`, [code, user.storeId]);
    if (!rows.length) throw new BizException(50040, '券码不存在（请核对纸质券上的券码）');
    const mc = rows[0];
    if (b.memberId && Number(mc.member_id) !== Number(b.memberId)) {
      throw new BizException(50040, '该券不属于当前会员（券与会员绑定）');
    }
    if (mc.status === '已使用') throw new BizException(50041, '该券已使用');
    if (mc.status === '已过期') throw new BizException(50041, '该券已过期');
    const e: any = mc.expire_at;
    const expStr = e instanceof Date
      ? `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`
      : String(e).slice(0, 10);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (expStr < today) throw new BizException(50041, `该券已于 ${expStr} 过期`);
    return {
      mcId: Number(mc.id), name: mc.name, type: mc.type,
      threshold: Number(mc.threshold) || 0, discount: Number(mc.discount) || 0, expireAt: expStr,
    };
  }

  /** 过期扫描（每日跑批 + 可手动触发）：未使用且已过有效日 → 已过期 */
  @Post('expire-scan')
  expireScan() {
    return tx(async c => this.doExpireScan(c));
  }
  private async doExpireScan(c: PoolClient) {
    const r = await cx(c,
      `UPDATE member_coupons SET status='已过期'
        WHERE status='未使用' AND expire_at < CURRENT_DATE RETURNING id`);
    return { expired: r.length };
  }

  /** 移动端次卡核销（5.3：员工报手机号查会员 → 选次卡 → 核销一次）
   *  times_used+1（与收银 applyCoupon 一致：不置"已使用"，用尽以剩余次数=0 表示）；留痕 audit_logs */
  @Post('verify-times')
  async verifyTimes(@Body() b: { memberCouponId: number; remark?: string }, @CurrentUser() user: AuthUser) {
    const id = Number(b.memberCouponId);
    if (!(id > 0)) throw new BizException(40003, 'memberCouponId 必填');
    return tx(async c => {
      const rows = await cx(c,
        `SELECT mc.id, mc.member_id, mc.status, mc.expire_at, mc.times_used,
                cp.name, cp.type, cp.discount, cp.status AS tpl_status
           FROM member_coupons mc JOIN coupons cp ON cp.id = mc.coupon_id
          WHERE mc.id = $1 FOR UPDATE OF mc`, [id]);
      if (!rows.length) throw new BizException(40004, '次卡不存在');
      const mc = rows[0];
      if (mc.type !== '次卡') throw new BizException(40003, '仅次卡支持独立按次核销');
      if (mc.status === '已过期') throw new BizException(50041, '该卡已过期');
      if (mc.status !== '未使用') throw new BizException(50041, `该卡状态为「${mc.status}」`);
      const e: any = mc.expire_at;
      const expStr = e instanceof Date
        ? `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`
        : String(e).slice(0, 10);
      const d = new Date();
      const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (expStr < todayStr) throw new BizException(50041, `该卡已于 ${expStr} 过期`);
      if (mc.tpl_status !== 1) throw new BizException(50044, '券模板已停用');
      const total = Number(mc.discount);
      const used = Number(mc.times_used ?? 0);
      if (!(total > 0)) throw new BizException(40003, '次卡总次数配置非法');
      if (used >= total) throw new BizException(50045, `次卡次数已用完（${used}/${total}）`);
      const usedNext = used + 1;
      await cx(c, `UPDATE member_coupons SET times_used=$2, used_at=now() WHERE id=$1`, [id, usedNext]);
      await audit(user.storeId, user.sub, '优惠券', '次卡核销', 'member_coupon', id,
        { memberId: Number(mc.member_id), name: mc.name, timesUsed: usedNext, total, remain: total - usedNext, remark: b.remark ?? null });
      return { ok: true, name: mc.name, used: usedNext, total, remain: total - usedNext, finished: usedNext >= total };
    });
  }

  /** 停用/启用模板（停用后不可再发/不可核销，已领出的券同步作废提示 50044） */
  @Post(':id/status')
  @RequirePerms('coupon.manage')
  setStatus(@Param('id') id: string, @Body() b: { status: number }) {
    return tx(async c => {
      if (![0, 1].includes(Number(b.status))) throw new BizException(40003, 'status 仅 0/1');
      const r = await cx(c, `UPDATE coupons SET status=$2 WHERE id=$1 RETURNING id`, [id, Number(b.status)]);
      if (!r.length) throw new BizException(40004, '券模板不存在');
      return { ok: true };
    });
  }
}

@Module({ controllers: [CouponsController] })
export class CouponsModule {}
