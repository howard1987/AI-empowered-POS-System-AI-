/**
 * 优惠券模块（设计方案 5.9 券管理：券模板、发券、领取、核销、过期）
 *   - 类型：满减券（threshold+discount=金额）/ 折扣券（discount=折扣率 0~1）/ 兑换券（scope 内一件免费）/ 次卡（discount=总次数，按次核销 5.3）
 *   - 记账口径（sales_orders 注释）：应收 = goods - promo - coupon - member_discount + round
 *     券在促销之后计算，门槛按商品原价货值（goods_amount）判定
 *   - 核销留痕：member_coupons.status/used_at/used_order_id + sales_orders.coupon_amount/coupon_id
 *   - 有效消费口径不受影响：券抵扣不是"本金+现金"，天然不计入活跃窗口（5.1.16）
 */
import { Body, Controller, Get, Module, Param, Post, Query, Req } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { audit, q, r2, tx } from '../common/db';
import type { PoolClient } from 'pg';

const cx = (c: PoolClient, sql: string, params: any[] = []) => c.query(sql, params).then(r => r.rows);

export interface SaleLineLike { p: { id: number }; unitPrice: number; lineAmount: number; }

/** 过期判定（expire_at 为 DATE；pg DATE 返回 Date 对象，按本地日期比对） */
function isExpired(expireAt: any): boolean {
  if (expireAt == null) return false;
  const e: any = expireAt;
  const expStr = e instanceof Date
    ? `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`
    : String(e).slice(0, 10);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return expStr < today;
}

/** 单券金额计算（纯函数：不读状态、不写库；门槛/范围不满足或类型非法时抛错） */
export function couponAmountOf(mc: any, goodsAmount: number, promoAmount: number, lines: SaleLineLike[]): number {
  if (mc.type === '满减券') {
    if (goodsAmount < Number(mc.threshold)) throw new BizException(50042, `未达门槛：货值 ${r2(goodsAmount)} < ${r2(Number(mc.threshold))}`);
    return Math.min(r2(Number(mc.discount)), r2(goodsAmount - promoAmount)); // 券在促销之后，封顶于（货值-促销）
  }
  if (mc.type === '折扣券') {
    const rate = Number(mc.discount);
    if (!(rate > 0 && rate < 1)) throw new BizException(40003, '折扣券折扣率必须在 0~1 之间');
    if (mc.threshold && goodsAmount < Number(mc.threshold)) throw new BizException(50042, `未达门槛：货值 ${r2(goodsAmount)} < ${r2(Number(mc.threshold))}`);
    return r2((goodsAmount - promoAmount) * (1 - rate));
  }
  if (mc.type === '兑换券') {
    const scopeIds: number[] = (mc.scope?.productIds || []).map(Number);
    const matched = lines.filter(ln => scopeIds.includes(Number(ln.p.id)));
    if (!matched.length) throw new BizException(50043, '订单中不含兑换券适用商品');
    return Math.min(...matched.map(ln => ln.unitPrice)); // 免费兑换一件（取适用商品中最低价一件，保守口径）
  }
  if (mc.type === '次卡') {
    const total = Number(mc.discount);
    const used = Number(mc.times_used ?? 0);
    if (!(total > 0)) throw new BizException(40003, '次卡总次数配置非法');
    if (used >= total) throw new BizException(50045, `次卡次数已用完（${used}/${total}）`);
    return 0; // 次卡不抵扣金额（会员价已在计价层生效），仅计次
  }
  throw new BizException(40003, '不支持的券类型');
}

/** 多券使用模式（营销 ▸ 促销与优惠叠加：manual/single/auto） */
export async function couponMode(c: PoolClient): Promise<'single' | 'auto' | 'manual'> {
  const r = await cx(c, `SELECT value FROM system_settings WHERE setting_key='coupon.mode'`);
  const v = r[0]?.value;
  return (v === 'single' || v === 'auto' || v === 'manual') ? v : 'manual';
}

/** 券 vs 促销叠加开关（coupon.stack_with_promo） */
async function couponStackWithPromo(c: PoolClient): Promise<boolean> {
  const r = await cx(c, `SELECT value FROM system_settings WHERE setting_key='coupon.stack_with_promo'`);
  return !r.length || Number(r[0].value) === 1; // JSONB 数值返回 JS number
}

/** 单券校验（状态/过期/模板停用/券vs促销叠加），返回券实例（已 FOR UPDATE） */
async function validateMc(c: PoolClient, memberId: number, mcId: number, promoAmount: number): Promise<any> {
  const rows = await cx(c,
    `SELECT mc.id, mc.status, mc.expire_at, mc.times_used, cp.name, cp.type, cp.threshold, cp.discount, cp.scope, cp.status AS tpl_status
       FROM member_coupons mc JOIN coupons cp ON cp.id = mc.coupon_id
      WHERE mc.id = $1 AND mc.member_id = $2 FOR UPDATE OF mc`, [mcId, memberId]);
  if (!rows.length) throw new BizException(50040, '优惠券不存在或不属于该会员');
  const mc = rows[0];
  if (mc.status === '已使用') throw new BizException(50041, '该券已使用');
  if (mc.status === '已过期') throw new BizException(50041, '该券已过期');
  if (isExpired(mc.expire_at)) throw new BizException(50041, `该券已于过期日失效`);
  if (mc.tpl_status !== 1) throw new BizException(50044, '券模板已停用');
  if (!(await couponStackWithPromo(c)) && promoAmount > 0) throw new BizException(50046, '当前设置：优惠券不与促销活动叠加');
  return mc;
}

/** 收银核销入口（单券；sales.module 在促销层之后调用；事务内 FOR UPDATE 防并发重复核销） */
export async function applyCoupon(
  c: PoolClient, memberId: number, mcId: number,
  goodsAmount: number, promoAmount: number, lines: SaleLineLike[],
): Promise<{ amount: number; memberCouponId: number; name: string }> {
  if (!memberId) throw new BizException(40003, '使用优惠券必须关联会员');
  const mc = await validateMc(c, memberId, mcId, promoAmount);
  const amount = couponAmountOf(mc, goodsAmount, promoAmount, lines);
  return { amount, memberCouponId: mc.id, name: mc.name };
}

/**
 * 多券核销入口（V5.0 叠加规则统一裁决）：
 *   - mode=single：一单仅用 1 张，取 requested（或会员全部可用）中抵扣最大者
 *   - mode=manual：收银员手动多选；若选了任意「不可叠加」券，则仅该券可用（互斥）
 *   - mode=auto ：忽略收银员选择，系统自动从会员可用券中挑可叠加组合求总抵扣最大
 *                   不可叠加券只能单独用 → 与「全部可叠加券之和」择优
 * 返回 { amount, usedIds, names }；仅返回真正核销的券实例 id（供 sales.module 写留痕）。
 */
export async function applyCoupons(
  c: PoolClient, memberId: number,
  requestedMcIds: number[], goodsAmount: number, promoAmount: number, lines: SaleLineLike[],
): Promise<{ amount: number; usedIds: number[]; names: string[] }> {
  /* V5.0.11g P0 结账阻断修复（真机收银实测发现）：
   *  原先 `if (!memberId) throw '使用优惠券必须关联会员'` 位于函数最开头，
   *  而 sales.module 的 checkout 是**无条件**调用 applyCoupons 的（并非「有券才调」），
   *  于是「无会员 + 未选任何券」的普通现金单也会撞上这句校验 → 直接结不了账。
   *  现场表现：扫一瓶水、选现金、结账报「使用优惠券必须关联会员」，
   *  让人误以为这瓶水被关联了优惠券，实际是校验被无条件触发。
   *  正确语义：只有**确实要核销券**（传了券 id）而没关联会员时才报错；
   *  无会员且无券 → 正常按原价结账，抵扣 0。 */
  const wantIds = (requestedMcIds || []).map(Number).filter(x => x > 0);
  if (!memberId && !wantIds.length) return { amount: 0, usedIds: [], names: [] };
  if (!memberId) throw new BizException(40003, '使用优惠券必须关联会员');
  const mode = await couponMode(c);
  if (!(await couponStackWithPromo(c)) && promoAmount > 0) throw new BizException(50046, '当前设置：优惠券不与促销活动叠加');

  // 取会员全部未使用券（FOR UPDATE 防并发），含 stackable
  const rows = await cx(c,
    `SELECT mc.id, mc.status, mc.expire_at, mc.times_used,
            cp.name, cp.type, cp.threshold, cp.discount, cp.scope, cp.status AS tpl_status, cp.stackable
       FROM member_coupons mc JOIN coupons cp ON cp.id = mc.coupon_id
      WHERE mc.member_id = $1 AND mc.status = '未使用' FOR UPDATE OF mc`, [memberId]);

  // 过滤模板停用/过期；按类型算金额（门槛/范围不满足 → 该券不可用，金额 0 剔除；次卡金额 0 但可用）
  const scored: { mc: any; amount: number }[] = [];
  for (const mc of rows) {
    if (mc.tpl_status !== 1) continue;
    if (isExpired(mc.expire_at)) continue;
    let amt = 0;
    try { amt = couponAmountOf(mc, goodsAmount, promoAmount, lines); }
    catch { amt = 0; }
    if (amt > 0 || mc.type === '次卡') scored.push({ mc, amount: amt });
  }

  const byReq = (ids: number[]) => ids
    .map(id => scored.find(x => Number(x.mc.id) === Number(id)))
    .filter(Boolean) as { mc: any; amount: number }[];

  let chosen: { mc: any; amount: number }[] = [];
  if (mode === 'single') {
    const pool = requestedMcIds?.length ? byReq(requestedMcIds) : scored;
    const best = pool.sort((a, b) => b.amount - a.amount)[0];
    if (best) chosen = [best];
  } else if (mode === 'manual') {
    const sel = byReq(requestedMcIds || []);
    const nonStack = sel.filter(x => x.mc.stackable === false);
    if (nonStack.length) {
      const bestNon = nonStack.sort((a, b) => b.amount - a.amount)[0]; // 互斥券之间也只取最优一张
      chosen = [bestNon];
    } else {
      chosen = sel; // 全部可叠加：直接累加
    }
    if (requestedMcIds?.length && !chosen.length) throw new BizException(50042, '所选优惠券均不可用（门槛/范围不满足或叠加规则冲突）');
  } else { // auto：系统自动组合最优
    const nonStack = scored.filter(x => x.mc.stackable === false).sort((a, b) => b.amount - a.amount)[0];
    const nonStackAmt = nonStack ? nonStack.amount : -1;
    const stackables = scored.filter(x => x.mc.stackable !== false);
    const stackSum = stackables.reduce((s, x) => s + x.amount, 0);
    chosen = stackSum >= nonStackAmt ? stackables : (nonStack ? [nonStack] : []);
  }

  const amount = r2(chosen.reduce((s, x) => s + x.amount, 0));
  const usedIds = chosen.map(x => Number(x.mc.id));
  const names = chosen.map(x => x.mc.name);
  return { amount, usedIds, names };
}

/** 券可用库存 = total_qty − 已核销 − 已过期 − 已作废（total_qty 为空=不限量，返回 0 表示不控库存） */
export async function couponStockAfter(c: PoolClient, couponId: number): Promise<number> {
  const r = await cx(c,
    `SELECT cp.total_qty
        - count(*) FILTER (WHERE mc.status='已使用')::int
        - count(*) FILTER (WHERE mc.status='已过期')::int
        - count(*) FILTER (WHERE mc.status='已作废')::int AS n
       FROM coupons cp LEFT JOIN member_coupons mc ON mc.coupon_id = cp.id
      WHERE cp.id=$1 GROUP BY cp.total_qty`, [couponId]);
  return r.length ? Number(r[0].n) : 0;
}

/** 写一条券出入库流水（对标商品 stock_flows，全链路可查） */
export async function logCoupon(c: PoolClient, b: {
  storeId: number; couponId: number; memberCouponId?: number | null; moveType: string;
  qty: number; memberId?: number | null; operatorId?: number | null;
  docNo?: string | null; stockAfter: number; remark?: string;
}) {
  await cx(c,
    `INSERT INTO coupon_stock_log (store_id, coupon_id, member_coupon_id, move_type, qty, member_id, operator_id, related_doc_no, stock_after, remark)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [b.storeId, b.couponId, b.memberCouponId ?? null, b.moveType, b.qty, b.memberId ?? null,
     b.operatorId ?? null, b.docNo ?? null, b.stockAfter, b.remark ?? null]);
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
    // V5.0 大类码：营销活动精确匹配键（按门店唯一；空=自动生成 CP+序号）
    const code = b.code ? String(b.code).trim().toUpperCase() : '';
    if (code && !/^[A-Z0-9_-]{2,32}$/.test(code)) throw new BizException(40003, '大类码须为 2~32 位字母/数字/下划线/连字符');
    return tx(async c => {
      if (code) {
        const hit = await cx(c, `SELECT 1 FROM coupons WHERE store_id=$1 AND code=$2`, [user.storeId, code]);
        if (hit.length) throw new BizException(50049, '该大类码已被占用，请换一个');
      }
      const stackable = b.stackable === false ? false : true; // 默认可叠加
      const rows = await cx(c,
        `INSERT INTO coupons (store_id, name, type, threshold, discount, valid_days, total_qty, per_member, scope, status, code, stackable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11) RETURNING *`,
        [user.storeId, name, type, threshold, discount, validDays,
         b.totalQty != null ? Number(b.totalQty) : null, perMember,
         b.scope ? JSON.stringify(b.scope) : null, code || null, stackable]);
      const cp = rows[0];
      // V5.0.2 空大类码自动生成：类型前缀-日期-当日序号（满减MJ/折扣ZK/兑换DH/次卡CK），如 MJ-2026092701
      if (!cp.code) {
        const PFX = ({ '满减券': 'MJ', '折扣券': 'ZK', '兑换券': 'DH', '次卡': 'CK' } as Record<string, string>)[cp.type] || 'CP';
        const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const seqRow = await cx(c, `SELECT count(*)+1 AS n FROM coupons WHERE store_id=$1 AND code LIKE $2`,
          [user.storeId, `${PFX}-${ymd}%`]);
        const auto = `${PFX}-${ymd}${String(Number(seqRow[0].n)).padStart(2, '0')}`;
        await cx(c, `UPDATE coupons SET code=$2 WHERE id=$1 AND code IS NULL`, [cp.id, auto]);
        cp.code = auto;
      }
      // V5.0 入库流水：创建即入库总量（不限量 total_qty 为空则不控库存，不记流水）
      const totalQty = Number(cp.total_qty || 0);
      if (totalQty > 0) {
        await logCoupon(c, { storeId: user.storeId, couponId: Number(cp.id), moveType: '入库', qty: totalQty,
          operatorId: user.sub, docNo: 'CP' + cp.id, stockAfter: totalQty, remark: `创建入库 ${totalQty} 张` });
      }
      return cp;
    });
  }

  /** 券模板列表（含核销统计） */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return q(
      `SELECT cp.id, cp.code, cp.name, cp.type, cp.threshold, cp.discount, cp.valid_days,
              cp.total_qty, cp.issued_qty, cp.per_member, cp.scope, cp.status, cp.stackable,
              cp.created_at,
              cp.total_qty - cp.issued_qty AS in_stock,
              count(mc.id) FILTER (WHERE mc.status='未使用')::int AS unused_count,
              count(mc.id) FILTER (WHERE mc.status='已使用')::int AS used_count,
              count(mc.id) FILTER (WHERE mc.status='已过期')::int AS expired_count,
              count(mc.id) FILTER (WHERE mc.status='已作废')::int AS voided_count,
              (cp.total_qty IS NOT NULL) AS stock_controlled
         FROM coupons cp LEFT JOIN member_coupons mc ON mc.coupon_id = cp.id
        WHERE cp.store_id = $1
        GROUP BY cp.id ORDER BY cp.created_at DESC, cp.id DESC`, [user.storeId]);
  }

  /** 发券：指定会员或全员（total_qty 池 + per_member 限领，事务 FOR UPDATE 防超发）
   *  V5.0.3：支持每人多张 qty（≤per_member 限额；限领 1 张的券 qty 无效按 1 发） */
  @Post(':id/issue')
  @RequirePerms('coupon.manage')
  issue(@Param('id') id: string, @Body() b: { memberIds?: number[]; all?: boolean; qty?: number }, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const cps = await cx(c, `SELECT * FROM coupons WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id, user.storeId]);
      if (!cps.length) throw new BizException(40004, '券模板不存在');
      const cp = cps[0];
      if (cp.status !== 1) throw new BizException(50044, '券模板已停用');
      const qty = Math.min(Math.max(1, Number(b.qty) || 1), Math.max(1, Number(cp.per_member) || 1));

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
        if (owned[0].n + qty > cp.per_member) continue; // 超出限领的不再发
        toIssue.push(mid);
      }
      const newCount = toIssue.length * qty;
      if (cp.total_qty != null && cp.issued_qty + newCount > cp.total_qty) {
        throw new BizException(50038, `发放总量不足：剩余 ${cp.total_qty - cp.issued_qty} 张，需 ${newCount} 张`);
      }
      const d = new Date();
      const exp = new Date(d.getFullYear(), d.getMonth(), d.getDate() + cp.valid_days);
      const expStr = `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}-${String(exp.getDate()).padStart(2, '0')}`;
      // VQA-C4：批量发券合并为 2 条 SQL（原每人 2 次往返）——多会员群发券不再线性放大事务时长
      //   V5.0.3：generate_series 展开每人 qty 张
      const insRows = toIssue.length ? await cx(c,
        `INSERT INTO member_coupons (coupon_id, member_id, expire_at, operator_id, issue_source)
             SELECT $1, m, $3, $4, '手动' FROM unnest($2::bigint[]) m, generate_series(1, $5::int) RETURNING id`,
        [id, toIssue, expStr, user.sub, qty]) : [];
      if (insRows.length) {
        // V5.0.2：小码按大类码拆分流水号——{大类码}-0001 起 4 位递增（如 MJ-2026092701-0001）
        //   （V5.0.3 修复：窗口函数不能直接用于 UPDATE SET，改经子查询编号）
        const seqRow = await cx(c,
          `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '^.*-', ''), '')::int), 0) AS n
             FROM member_coupons WHERE coupon_id=$1 AND code LIKE $2`, [id, `${cp.code}-%`]);
        await cx(c,
          `UPDATE member_coupons mc SET code = $2 || '-' || lpad((t.rn + $3)::text, 4, '0')
             FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
                     FROM member_coupons WHERE id = ANY($1::bigint[]) AND code IS NULL) t
             WHERE mc.id = t.id`,
          [insRows.map(r => r.id), cp.code, Number(seqRow[0].n)]);
      }
      
      await cx(c, `UPDATE coupons SET issued_qty = issued_qty + $2 WHERE id=$1`, [id, newCount]);
      // V5.0 发放出库流水（调拨：在库→会员持有，可用库存不变；逐实例留痕见 member_coupons）
      const sa = await couponStockAfter(c, Number(id));
      await logCoupon(c, { storeId: user.storeId, couponId: Number(id), moveType: '发放出库', qty: 0,
        operatorId: user.sub, docNo: 'ISSUE-' + id, stockAfter: sa, remark: `手动发放 ${newCount} 张` });
      return { issued: newCount, skipped: memberIds.length - newCount, expireAt: expStr };
    });
  }

  /** 会员自助领取（小程序/API 通道；同样受总量池与限领约束）
   *  P2-M10：员工代会员领取需持发券/收银/建档类权限，防任意人占领限量券 */
  @RequirePerms('coupon.manage', 'pos.sell', 'member.register')
  @Post('claim')
  async claim(@Body() b: { couponId: number; memberId: number }, @CurrentUser() user: AuthUser) {
    return this.doClaim(b, user);
  }
  private async doClaim(b: { couponId: number; memberId: number }, user?: AuthUser) {
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
        `INSERT INTO member_coupons (coupon_id, member_id, expire_at, operator_id, issue_source) VALUES ($1,$2,$3,$4,'自领') RETURNING *`,
        [b.couponId, b.memberId, expStr, user?.sub ?? null]);
      // V4.19.0 券码手输：发券即生成券码（V5.0.2 按 {大类码}-4位流水）
      {
        const seqRow = await cx(c,
          `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '^.*-', ''), '')::int), 0) AS n
             FROM member_coupons WHERE coupon_id=$1 AND code LIKE $2`, [b.couponId, `${cp.code}-%`]);
        await cx(c, `UPDATE member_coupons SET code=$2 WHERE id=$1 AND code IS NULL`,
          [ins[0].id, `${cp.code}-${String(Number(seqRow[0].n) + 1).padStart(4, '0')}`]);
      }
      await cx(c, `UPDATE coupons SET issued_qty = issued_qty + 1 WHERE id=$1`, [b.couponId]);
      // V5.0 发放出库流水
      const sa = await couponStockAfter(c, Number(b.couponId));
      await logCoupon(c, { storeId: Number(cp.store_id), couponId: Number(b.couponId), memberCouponId: Number(ins[0].id),
        moveType: '发放出库', qty: 0, memberId: Number(b.memberId), operatorId: user?.sub ?? null,
        docNo: 'CLAIM-' + b.couponId, stockAfter: sa, remark: '会员自助领取' });
      return ins[0];
    });
  }

  /** 会员券包 */
  @Get('member/:memberId')
  memberCoupons(@Param('memberId') memberId: string) {
    return q(
      `SELECT mc.*, cp.name, cp.type, cp.threshold, cp.discount, cp.scope, cp.stackable
         FROM member_coupons mc JOIN coupons cp ON cp.id = mc.coupon_id
        WHERE mc.member_id = $1 ORDER BY mc.status, mc.expire_at`, [memberId]);
  }

  /** 券实例列表（按模板）：用于退券/溯源——谁领取、状态、时间、关联单据 */
  @Get(':id/instances')
  @RequirePerms('coupon.manage')
  async instances(@Param('id') id: string, @Query('status') status: string, @CurrentUser() user: AuthUser) {
    return q(
      `SELECT mc.id, mc.code, mc.status, mc.received_at, mc.used_at, mc.used_order_id, mc.issue_source,
              mc.member_id, m.name AS member_name, m.phone AS member_phone
         FROM member_coupons mc LEFT JOIN members m ON m.id = mc.member_id
        WHERE mc.coupon_id = $1 AND ($2::text IS NULL OR mc.status = $2)
        ORDER BY mc.id DESC LIMIT 500`, [id, status && status !== '全部' ? status : null]);
  }

  /** V4.19.0 券码手输（A2 后半，P15.5 #8）：纸质券码手输核销——按券码定位券实例，校验归属会员+未使用 */
  @RequirePerms('pos.sell')
  @Post('lookup-code')
  async lookupCode(@Body() b: { code?: string; memberId?: number }, @CurrentUser() user: AuthUser) {
    const code = String(b.code || '').trim().toUpperCase();
    // V5.0.2：兼容 MC+8位 与新格式 大类码-日期-4位流水（如 MJ-2026092701-0001）
    if (!/^(MC\d{8}|[A-Z]{2,4}-\d{8,12}-\d{4})$/.test(code))
      throw new BizException(40003, '券码格式应为 MC+8位数字 或 大类码-日期-4位流水（印在券面）');
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
        WHERE status='未使用' AND expire_at < CURRENT_DATE RETURNING id, coupon_id, member_id`);
    if (r.length) {
      const ids = r.map(x => Number(x.id));
      // V5.0 过期出库流水（不可逆；可用库存 −1）
      await cx(c,
        `INSERT INTO coupon_stock_log (store_id, coupon_id, member_coupon_id, move_type, qty, member_id, related_doc_no, stock_after, remark)
         SELECT cp.store_id, mc.coupon_id, mc.id, '过期出库', -1, mc.member_id, 'EXPIRE-SCAN',
                cp.total_qty
                  - (SELECT count(*) FROM member_coupons x WHERE x.coupon_id=mc.coupon_id AND x.status='已使用')::int
                  - (SELECT count(*) FROM member_coupons x WHERE x.coupon_id=mc.coupon_id AND x.status='已过期')::int
                  - (SELECT count(*) FROM member_coupons x WHERE x.coupon_id=mc.coupon_id AND x.status='已作废')::int,
                '到期自动核销出库'
           FROM member_coupons mc JOIN coupons cp ON cp.id=mc.coupon_id
          WHERE mc.id = ANY($1::bigint[])`, [ids]);
    }
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
      const finished = usedNext >= total;
      await cx(c, `UPDATE member_coupons SET times_used=$2, used_at=now()${finished ? ", status='已使用'" : ''} WHERE id=$1`, [id, usedNext]);
      if (finished) {
        // V5.0 次卡核销完毕 → 核销出库（不可逆）
        const sa = await couponStockAfter(c, Number(mc.coupon_id));
        await logCoupon(c, { storeId: user.storeId, couponId: Number(mc.coupon_id), memberCouponId: id,
          moveType: '核销出库', qty: -1, memberId: Number(mc.member_id), operatorId: user.sub,
          docNo: 'TIMES-' + id, stockAfter: sa, remark: '次卡核销完毕' });
      }
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

  /** 退券（仅未使用）：商家召回未使用券 → 作废 + 退库(+1 可用库存)；已使用/已过期不退（一次性商品） */
  @Post(':id/void')
  @RequirePerms('coupon.manage')
  async voidCoupon(@Param('id') id: string, @Body() b: { memberCouponId: number; remark?: string }, @CurrentUser() user: AuthUser) {
    const mcId = Number(b.memberCouponId);
    if (!(mcId > 0)) throw new BizException(40003, 'memberCouponId 必填');
    return tx(async c => {
      const rows = await cx(c,
        `SELECT mc.id, mc.coupon_id, mc.member_id, mc.status, cp.store_id
           FROM member_coupons mc JOIN coupons cp ON cp.id=mc.coupon_id WHERE mc.id=$1 FOR UPDATE OF mc`, [mcId]);
      if (!rows.length) throw new BizException(40004, '券不存在');
      const mc = rows[0];
      if (Number(mc.store_id) !== Number(user.storeId)) throw new BizException(50040, '券不属于本店');
      if (mc.status === '已使用') throw new BizException(50041, '该券已使用（一次性商品，不退券）');
      if (mc.status === '已过期') throw new BizException(50041, '该券已过期，无需退券');
      if (mc.status === '已作废') throw new BizException(50041, '该券已作废');
      await cx(c, `UPDATE member_coupons SET status='已作废', used_at=now() WHERE id=$1`, [mcId]);
      // V5.0 退库流水：未使用券召回 → 可用库存 +1
      const sa = await couponStockAfter(c, Number(mc.coupon_id));
      await logCoupon(c, { storeId: user.storeId, couponId: Number(mc.coupon_id), memberCouponId: mcId,
        moveType: '退库', qty: 1, memberId: Number(mc.member_id), operatorId: user.sub,
        docNo: 'VOID-' + mcId, stockAfter: sa, remark: b.remark || '商家召回作废' });
      return { ok: true, status: '已作废' };
    });
  }
}

@Module({ controllers: [CouponsController] })
export class CouponsModule {}
