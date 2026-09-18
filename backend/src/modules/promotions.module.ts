import { Module, Controller, Post, Get, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { q, q1, cx, r2, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';

/**
 * 促销引擎（T12，方案 5.4；V4.14.1 新增 定时打折/捆绑销售/消费后奖励/满件折扣）：
 *   分层：商品级（特价/第二件半价/定时打折）→ 范围级（满件折扣/捆绑销售）→ 整单级（满减/满折）；同层取一（默认取对顾客更优，promo.take_best），
 *         跨层叠加（promo.stack_layers，关=只生效一层、行级优先）。会员价与促销价冲突默认取更优（5.4）。
 *   rules JSONB 结构：
 *     满减        { tiers: [{ threshold: 100, off: 20 }] }        整单级，取满足档位中 off 最大
 *     折扣(满折)  { threshold: 200, rate: 0.8 }                   整单级
 *     特价        { specialPrice: 3.5 }                           行级（时段价：活动起止即时段）
 *     第二件半价  {}                                              行级，同商品每 2 件省 1 件半价
 *     定时打折    { startTime: '20:00', endTime: '22:00', rate: 0.7 }   行级：每日时间窗内范围内商品打折（如晚 8 点后生鲜 7 折）
 *     捆绑销售    { items: [{productId, qty}], bundlePrice: 12 }   组合价：购物车同时含 A+B 时按组合价计（A10+B5 → 12）
 *     满件折扣    { minQty: 5, rate: 0.8 }                         范围级：同范围内合计满 N 件总价打折（雪糕/火锅季）
 *     消费后奖励  { threshold: 100, rewardType: 'coupon'|'gift', couponTemplateId?, giftName? }  结账后发奖（见 grantPostCheckoutRewards）
 *   scope JSONB：{ productIds: [], categoryIds: [] }；空/null=全部商品
 *   整单级优惠按行小比分摊到 sale_items.line_amount（尾差进最后一行）→ 退货按行原路退
 */

const PROMO_KINDS = ['满减', '折扣', '第二件半价', '特价', '定时打折', '捆绑销售', '消费后奖励', '满件折扣'];

function scopeMatchProduct(scope: any, p: any): boolean {
  if (!scope) return true;
  const pids: number[] = (scope.productIds ?? []).map(Number);
  const cids: number[] = (scope.categoryIds ?? []).map(Number);
  if (!pids.length && !cids.length) return true;
  return pids.includes(Number(p.id)) || (p.category_id != null && cids.includes(Number(p.category_id)));
}

function validateRules(kind: string, rules: any) {
  if (!rules || typeof rules !== 'object') throw new BizException(40003, '促销 rules 必须为对象');
  if (kind === '满减') {
    const tiers = rules.tiers;
    if (!Array.isArray(tiers) || !tiers.length ||
        tiers.some((t: any) => !(Number(t.threshold) > 0) || !(Number(t.off) > 0))) {
      throw new BizException(40003, '满减需 rules.tiers = [{threshold, off}]，且均大于 0');
    }
  } else if (kind === '折扣') {
    const rate = Number(rules.rate);
    if (!(rate > 0 && rate < 1)) throw new BizException(40003, '满折需 rules.rate ∈ (0,1)，如 0.8 = 8 折');
  } else if (kind === '特价') {
    if (!(Number(rules.specialPrice) > 0)) throw new BizException(40003, '特价需 rules.specialPrice > 0');
  } else if (kind === '第二件半价') {
    // 无参数
  } else if (kind === '定时打折') {
    if (!/^\d{1,2}:\d{2}$/.test(String(rules.startTime || '')) || !/^\d{1,2}:\d{2}$/.test(String(rules.endTime || ''))) {
      throw new BizException(40003, '定时打折需 rules.startTime/endTime（HH:mm，如 20:00 / 22:00）');
    }
    const rate = Number(rules.rate);
    if (!(rate > 0 && rate < 1)) throw new BizException(40003, '定时打折需 rules.rate ∈ (0,1)，如 0.7 = 7 折');
  } else if (kind === '捆绑销售') {
    const items = rules.items;
    if (!Array.isArray(items) || items.length < 2 ||
        items.some((x: any) => !(Number(x.productId) > 0) || !(Number(x.qty) >= 1))) {
      throw new BizException(40003, '捆绑销售需 rules.items ≥ 2 个商品 [{productId, qty}]');
    }
    if (!(Number(rules.bundlePrice) > 0)) throw new BizException(40003, '捆绑销售需 rules.bundlePrice > 0（组合价）');
  } else if (kind === '消费后奖励') {
    if (!(Number(rules.threshold) > 0)) throw new BizException(40003, '消费后奖励需 rules.threshold > 0（消费满多少元）');
    if (!['coupon', 'gift'].includes(String(rules.rewardType))) throw new BizException(40003, '消费后奖励需 rules.rewardType = coupon（发购物券）或 gift（赠商品）');
    if (rules.rewardType === 'coupon' && !(Number(rules.couponTemplateId) > 0)) throw new BizException(40003, '发券奖励需 rules.couponTemplateId（券模板 ID）');
    if (rules.rewardType === 'gift' && !String(rules.giftName || '').trim()) throw new BizException(40003, '赠品奖励需 rules.giftName（赠品名称）');
  } else if (kind === '满件折扣') {
    if (!(Number(rules.minQty) >= 2)) throw new BizException(40003, '满件折扣需 rules.minQty ≥ 2（满多少件）');
    const rate = Number(rules.rate);
    if (!(rate > 0 && rate < 1)) throw new BizException(40003, '满件折扣需 rules.rate ∈ (0,1)，如 0.8 = 8 折');
  } else {
    throw new BizException(40003, `暂不支持的促销类型：${kind}（一期支持 满减/折扣/特价/第二件半价）`);
  }
}

/** 促销引擎入口：在行计价（会员价/等级折扣/手工改价）之后调用，原地修改 lines */
export async function applyPromotions(c: any, storeId: number, lines: any[]) {
  for (const ln of lines) { ln.promoId = null; ln.promoAlloc = 0; ln.linePromoDisc = 0; }
  const settings = new SettingsService();
  const takeBest = (await settings.getNum('promo.take_best', 1)) === 1;
  const stackLayers = (await settings.getNum('promo.stack_layers', 1)) === 1;

  const promos: any[] = await cx(c,
    `SELECT * FROM promotions
      WHERE store_id=$1 AND status='进行中' AND start_at <= now() AND end_at >= now()`, [storeId]);
  if (!promos.length) return { promoAmount: 0, orderPromoId: null };

  // ── 1. 行级：特价 / 第二件半价 / 定时打折（同层取一，默认取对顾客更优） ──
  let lineDiscountTotal = 0;
  const lineLevel = promos.filter(p => p.kind === '特价' || p.kind === '第二件半价' || p.kind === '定时打折');
  for (const ln of lines) {
    let best: { id: number; discount: number; special?: number } | null = null;
    let first: { id: number; discount: number; special?: number } | null = null;
    for (const pr of lineLevel) {
      if (!scopeMatchProduct(pr.scope, ln.p)) continue;
      let discount = 0;
      let special: number | undefined;
      if (pr.kind === '特价') {
        const sp = r2(Number(pr.rules?.specialPrice));
        if (sp > 0 && sp < ln.unitPrice) { discount = r2((ln.unitPrice - sp) * ln.baseQty); special = sp; }
      } else if (pr.kind === '定时打折') {   // V4.14.1：每日时间窗内打折（如晚 8 点后生鲜 7 折）
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        const [h1, m1] = String(pr.rules?.startTime || '').split(':').map(Number);
        const [h2, m2] = String(pr.rules?.endTime || '').split(':').map(Number);
        const s1 = (h1 || 0) * 60 + (m1 || 0), s2 = (h2 || 0) * 60 + (m2 || 0);
        const inWin = s1 <= s2 ? (cur >= s1 && cur <= s2) : (cur >= s1 || cur <= s2);   // 跨零点窗口
        const rate = Number(pr.rules?.rate);
        if (inWin && rate > 0 && rate < 1 && ln.lineAmount > 0) discount = r2(ln.lineAmount * (1 - rate));
      } else { // 第二件半价
        const pairs = Math.floor(ln.baseQty / 2);
        if (pairs >= 1) discount = r2(pairs * ln.unitPrice * 0.5);
      }
      if (discount <= 0) continue;
      const cand = { id: pr.id, discount, special };
      if (!first) first = cand;
      if (!best || discount > best.discount) best = cand;
    }
    const chosen = takeBest ? best : first;
    if (chosen) {
      if (chosen.special !== undefined) ln.unitPrice = chosen.special;
      ln.lineAmount = r2(ln.lineAmount - chosen.discount);
      ln.promoId = chosen.id;
      ln.linePromoDisc = chosen.discount;
      lineDiscountTotal = r2(lineDiscountTotal + chosen.discount);
    }
  }

  // ── 1.5 V4.14.1 范围级：捆绑销售 / 满件折扣（多行联动；同层取一） ──
  const groupPromos = promos.filter(p => p.kind === '捆绑销售' || p.kind === '满件折扣');
  if (groupPromos.length) {
    let bestGroup: { id: number; off: number; targets: any[] } | null = null;
    for (const pr of groupPromos) {
      if (pr.kind === '捆绑销售') {
        const items = (pr.rules?.items || []).map((x: any) => ({ pid: Number(x.productId), qty: Math.max(1, Number(x.qty) || 1) }));
        const bp = Number(pr.rules?.bundlePrice);
        if (!items.length || !(bp > 0)) continue;
        // 组合可达次数 = 各所需商品可用数量向上取整的最小值
        let occ = Infinity;
        for (const it of items) {
          const ln = lines.find((l: any) => Number(l.p.id) === it.pid);
          const avail = ln ? Math.floor((Number(ln.baseQty) || 0) / it.qty) : 0;
          occ = Math.min(occ, avail);
        }
        if (!isFinite(occ) || occ < 1) continue;
        // 每次组合的让利 = 所需数量按现价合计 - 组合价；逐次计（上限=组合行金额合计）
        let off = 0;
        for (let k = 0; k < occ; k++) {
          const part = items.reduce((s: number, it: any) => {
            const ln = lines.find((l: any) => Number(l.p.id) === it.pid);
            return s + (ln ? ln.unitPrice * it.qty : 0);
          }, 0);
          const per = r2(part - bp);
          if (per <= 0) break;
          off = r2(off + per);
        }
        if (off <= 0) continue;
        const targets = items.map((it: any) => Number(it.pid));
        if (!bestGroup || off > bestGroup.off) bestGroup = { id: pr.id, off, targets };
      } else { // 满件折扣：范围内合计满 N 件总价打折
        const minQty = Number(pr.rules?.minQty || 0);
        const rate = Number(pr.rules?.rate);
        const scoped = lines.filter((ln: any) => ln.lineAmount > 0 && scopeMatchProduct(pr.scope, ln.p));
        const totalQty = scoped.reduce((s: number, ln: any) => s + (Number(ln.baseQty) || 0), 0);
        if (!(minQty >= 2) || !(rate > 0 && rate < 1) || !scoped.length || totalQty < minQty) continue;
        const scopeBase = r2(scoped.reduce((s: number, ln: any) => s + ln.lineAmount, 0));
        const off = r2(scopeBase * (1 - rate));
        if (off <= 0) continue;
        const targets = scoped.map((ln: any) => Number(ln.p.id));
        if (!bestGroup || off > bestGroup.off) bestGroup = { id: pr.id, off, targets };
      }
    }
    if (bestGroup && (stackLayers || lineDiscountTotal === 0)) {
      // 分摊到目标行（按行金额占比，尾差进最后一行）
      const involved = lines.filter((ln: any) => bestGroup!.targets.includes(Number(ln.p.id)) && ln.lineAmount > 0);
      const invBase = r2(involved.reduce((s: number, ln: any) => s + ln.lineAmount, 0));
      if (invBase > 0) {
        let off = Math.min(bestGroup.off, invBase);
        let allocated = 0;
        involved.forEach((ln: any, i: number) => {
          let alloc = i === involved.length - 1 ? r2(off - allocated) : r2(off * ln.lineAmount / invBase);
          allocated = r2(allocated + alloc);
          if (alloc > ln.lineAmount) alloc = ln.lineAmount;
          ln.promoId = bestGroup!.id;
          ln.linePromoDisc = r2((ln.linePromoDisc || 0) + alloc);
          ln.lineAmount = r2(ln.lineAmount - alloc);
        });
        lineDiscountTotal = r2(lineDiscountTotal + off);
      }
    }
  }

  // ── 2. 整单级：满减 / 满折（跨层叠加开关关闭时行级已优惠则跳过） ──
  const base = r2(lines.reduce((s, ln) => s + ln.lineAmount, 0));
  let orderPromoId: number | null = null;
  let orderOff = 0;
  const orderLevel = promos.filter(p => p.kind === '满减' || p.kind === '折扣');
  if (stackLayers || lineDiscountTotal === 0) {
    let bestOrder: { id: number; off: number } | null = null;
    let firstOrder: { id: number; off: number } | null = null;
    for (const pr of orderLevel) {
      // scope 限定时，整单需包含至少一行命中范围（5.4 分层）；
      // V4.16.4：带范围时门槛按「范围内商品金额」计（品类满减=该品类实满），优惠仍按整单行分摊
      const scopedLines = pr.scope ? lines.filter((ln: any) => ln.lineAmount > 0 && scopeMatchProduct(pr.scope, ln.p)) : lines;
      if (pr.scope && !scopedLines.length) continue;
      const effBase = pr.scope ? r2(scopedLines.reduce((s: number, ln: any) => s + ln.lineAmount, 0)) : base;
      let off = 0;
      if (pr.kind === '满减') {
        for (const t of (pr.rules?.tiers ?? [])) {
          const th = Number(t.threshold), o = Number(t.off);
          if (effBase >= th && o > off) off = o;    // 只取满足档位中减额最大的一档，绝不叠加（210 命中 100-20/200-50 → 只减 50）
        }
      } else { // 满折
        const th = Number(pr.rules?.threshold ?? 0);
        const rate = Number(pr.rules?.rate);
        if (rate > 0 && rate < 1 && effBase >= th) off = r2(effBase * (1 - rate));
      }
      off = Math.min(r2(off), base);
      if (off <= 0) continue;
      const cand = { id: pr.id, off };
      if (!firstOrder) firstOrder = cand;
      if (!bestOrder || off > bestOrder.off) bestOrder = cand;
    }
    const chosenOrder = takeBest ? bestOrder : firstOrder;
    if (chosenOrder) {
      orderPromoId = chosenOrder.id;
      orderOff = chosenOrder.off;
      // 按行小比分摊（尾差进最后一行有余额的行）
      let allocated = 0;
      let lastIdx = -1;
      lines.forEach((ln, i) => { if (ln.lineAmount > 0) lastIdx = i; });
      lines.forEach((ln, i) => {
        let alloc: number;
        if (i === lastIdx) {
          alloc = r2(chosenOrder.off - allocated);
        } else {
          alloc = r2(chosenOrder.off * ln.lineAmount / base);
          allocated = r2(allocated + alloc);
        }
        if (alloc > ln.lineAmount) alloc = ln.lineAmount;
        ln.promoAlloc = alloc;
        ln.lineAmount = r2(ln.lineAmount - alloc);
      });
    }
  }

  return { promoAmount: r2(lineDiscountTotal + orderOff), orderPromoId };
}

/** V4.14.1 消费后奖励：结账事务内调用——按进行中的「消费后奖励」活动给会员发购物券 / 登记赠品。
 *  发券受券模板总量池 / 每人限领约束；赠品追加到订单备注留痕（店员现场赠送）。返回发放清单供前端播报。 */
export async function grantPostCheckoutRewards(c: any, storeId: number, memberId: number, payable: number, orderId: number) {
  if (!memberId || !(payable > 0)) return [];
  const promos = await cx(c,
    `SELECT * FROM promotions
      WHERE store_id=$1 AND status='进行中' AND start_at <= now() AND end_at >= now() AND kind='消费后奖励'`, [storeId]);
  const out: any[] = [];
  for (const pr of promos) {
    const rules = pr.rules || {};
    const th = Number(rules.threshold || 0);
    if (!(th > 0) || payable < th) continue;
    if (String(rules.rewardType) === 'coupon' && Number(rules.couponTemplateId) > 0) {
      const cp = await cx(c, `SELECT id, name, valid_days, per_member, total_qty, status FROM coupons WHERE id=$1`, [Number(rules.couponTemplateId)]);
      if (!cp.length || String(cp[0].status) !== '启用') continue;
      const totalIssued = await cx(c, `SELECT count(*)::int AS n FROM member_coupons WHERE coupon_id=$1`, [cp[0].id]);
      if (Number(cp[0].total_qty) > 0 && Number(totalIssued[0].n) >= Number(cp[0].total_qty)) continue;
      const mine = await cx(c, `SELECT count(*)::int AS n FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [cp[0].id, memberId]);
      if (Number(cp[0].per_member) > 0 && Number(mine[0].n) >= Number(cp[0].per_member)) continue;
      const exp = new Date(Date.now() + Number(cp[0].valid_days || 30) * 86400000).toISOString().slice(0, 10);
      const ins = await cx(c,
        `INSERT INTO member_coupons (coupon_id, member_id, expire_at) VALUES ($1,$2,$3) RETURNING id`,
        [cp[0].id, memberId, exp]);
      out.push({ promoId: pr.id, type: 'coupon', name: cp[0].name, memberCouponId: Number(ins[0].id) });
    } else if (String(rules.rewardType) === 'gift' && String(rules.giftName || '').trim()) {
      await cx(c, `UPDATE sales_orders SET remark = COALESCE(remark,'') || $2 WHERE id=$1`,
        [orderId, `｜消费后奖励赠品：${String(rules.giftName)}（活动#${pr.id}）`]);
      out.push({ promoId: pr.id, type: 'gift', name: String(rules.giftName) });
    }
  }
  return out;
}

// ─── Service: 活动管理 ───
class PromotionsService {
  async create(user: AuthUser, dto: any) {
    // V4.8.21 模板一键建活动：templateId 提供默认 name/kind/rules（显式传入优先）
    if (dto.templateId) {
      const tpl = await q1(`SELECT * FROM promotion_templates WHERE id=$1`, [Number(dto.templateId)]);
      if (!tpl) throw new BizException(40404, '促销模板不存在', 404);
      dto = { ...dto, name: dto.name || `${tpl.name}`, kind: dto.kind || tpl.kind,
              rules: dto.rules || tpl.rules_template };
    }
    if (!dto.name || String(dto.name).length > 64) throw new BizException(40003, '活动名称必填（≤64 字）');
    if (!PROMO_KINDS.includes(dto.kind)) throw new BizException(40003, `无效促销类型：${dto.kind}`);
    validateRules(dto.kind, dto.rules);
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || startAt >= endAt) {
      throw new BizException(40003, '活动起止时间无效（startAt 必须早于 endAt）');
    }
    const status = dto.startNow ? '进行中' : '排期';
    const rows = await q(
      `INSERT INTO promotions (store_id, name, kind, rules, scope, start_at, end_at, status, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9) RETURNING *`,
      [user.storeId, dto.name, dto.kind, JSON.stringify(dto.rules),
       dto.scope ? JSON.stringify(dto.scope) : null, startAt, endAt, status, user.sub]);
    await audit(user.storeId, user.sub, '促销', 'promotion.create', 'promotion', rows[0].id,
      { name: dto.name, kind: dto.kind, status });
    return rows[0];
  }

  async changeStatus(user: AuthUser, id: number, action: 'start' | 'stop') {
    const cur = await q1(`SELECT * FROM promotions WHERE id=$1`, [id]);
    if (!cur) throw new BizException(40404, '促销活动不存在', 404);
    const from = cur.status;
    const to = action === 'start' ? '进行中' : '已停用';
    const allowed = action === 'start' ? ['排期', '已停用'] : ['排期', '进行中'];
    if (!allowed.includes(from)) {
      throw new BizException(50035, `状态不允许该操作（当前 ${from}）`);
    }
    const rows = await q(`UPDATE promotions SET status=$2 WHERE id=$1 RETURNING *`, [id, to]);
    await audit(user.storeId, user.sub, '促销', action === 'start' ? 'promotion.start' : 'promotion.stop',
      'promotion', id, { from, to });
    return rows[0];
  }
}

// ─── Controller ───
@Controller('promotions')
class PromotionsController {
  private svc = new PromotionsService();

  @RequirePerms('promo.manage')
  @Post()
  create(@Body() dto: any, @CurrentUser() user: AuthUser) { return this.svc.create(user, dto); }

  @RequirePerms('promo.manage')
  @Post(':id/start')
  start(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.changeStatus(user, id, 'start');
  }

  @RequirePerms('promo.manage')
  @Post(':id/stop')
  stop(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.changeStatus(user, id, 'stop');
  }

  @Get()
  async list(
    @Query('status') status?: string, @Query('kind') kind?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page = '1', @Query('size') size = '20',
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    // V4.14.0 P3：名称关键字模糊查询
    const kw = (keyword || '').trim();
    const items = await q(
      `SELECT * FROM promotions
        WHERE ($1::text IS NULL OR status::text = $1)
          AND ($2::text IS NULL OR kind::text = $2)
          AND ($3 = '' OR name ILIKE '%'||$3||'%')
        ORDER BY id DESC LIMIT $4 OFFSET $5`, [status || null, kind || null, kw, sz, (pn - 1) * sz]);
    return { page: pn, size: sz, items };
  }

  /** 促销活动模板（V4.8.21：一键按模板建活动） */
  @Get('templates')
  async templates() {
    return q(`SELECT * FROM promotion_templates ORDER BY id`);
  }

  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const promo = await q1(`SELECT * FROM promotions WHERE id=$1`, [id]);
    if (!promo) throw new BizException(40404, '促销活动不存在', 404);
    // 活动效果：命中的订单数 / 让利总额 / 行级命中行数
    const effect = await q1(
      `SELECT (SELECT count(*)::int FROM sales_orders WHERE promo_id=$1) AS order_hits,
              (SELECT COALESCE(SUM(promo_amount),0) FROM sales_orders WHERE promo_id=$1) AS order_saved,
              (SELECT count(*)::int FROM sale_items WHERE promo_id=$1) AS line_hits`,
      [id]);
    return { promo, effect };
  }
}

@Module({ controllers: [PromotionsController] })
export class PromotionsModule {}
