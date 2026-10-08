/**
 * V5.0.17 会员成长值引擎（会员等级重设计核心）
 *
 * 设计口径（老板 2026-10-07 拍板）：
 *   成长值 = 累计实付充值本金 × 充值倍率 + 直接买单实付消费金额 × 消费倍率
 *   不计成长：① 储值余额消费（花余额买单）② 分红抵扣 ③ 积分抵扣
 *              ④ 优惠券抵扣部分（只算顾客实掏的钱）⑤ 赠送余额/活动补贴/赠款
 *              ⑥ 管理员指定的排除商品/分类（香烟等）⑦ 命中特价/折扣的活动商品
 *   等级：普通 → 银卡 → 金卡，按成长值判定
 *      · 升级：累计成长值 ≥ 升级门槛 → 立即生效
 *      · 保级：滚动考核周期（默认近 6 个月）成长值 ≥ 保级门槛（略低于升级门槛）
 *      · 缓冲：近周期成长值不达保级线 → 进入保护缓冲期（默认 30 天），期内保留全部权益；
 *               期内补足成长即退出缓冲；到期仍不达标才正式下调
 *   退货：按退款额占原单实付比例扣回成长值，扣减后触发同一套保级/缓冲判定
 */
import { cx, r2 } from '../common/db';
import { curStore } from '../common/context';
import { SettingsService } from './settings.module';

export class MemberGrowthService {
  private settings = new SettingsService();

  private async num(key: string, dflt: number): Promise<number> {
    try { const v = await this.settings.getNum(key, dflt); return Number.isFinite(v) ? v : dflt; }
    catch { return dflt; }
  }
  /** 读取 id 数组类设置（排除商品/分类） */
  private async idArr(key: string): Promise<number[]> {
    try {
      const raw = await this.settings.getVal(key);
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(obj) ? [...new Set(obj.map(Number).filter((n: any) => Number.isFinite(n) && n > 0))] : [];
    } catch { return []; }
  }
  private async enabled(): Promise<boolean> {
    try { return (await this.settings.getNum('member.growth.enabled', 1)) === 1; } catch { return true; }
  }

  /** 充值成长值：仅本金计成长，赠送（gift/活动补贴）不计 */
  async earnRecharge(c: any, o: { memberId: number; principal: number; refType?: string; refId?: number; remark?: string }): Promise<number> {
    if (!(Number(o.memberId) > 0) || !(Number(o.principal) > 0)) return 0;
    if (!(await this.enabled())) return 0;
    const rate = await this.num('member.growth.recharge_rate', 1);
    const growth = r2(Number(o.principal) * rate);
    if (!(growth > 0)) return 0;
    await cx(c,
      `INSERT INTO member_growth_records (store_id, member_id, direction, growth_value, base_amount, rate, biz_type, ref_type, ref_id, remark)
       VALUES (${curStore()},$1,'加',$2,$3,$4,'充值',$5,$6,$7)`,
      [o.memberId, growth, r2(o.principal), rate, o.refType || 'recharge', o.refId || null, o.remark || null]);
    await cx(c, `UPDATE members SET growth_total = growth_total + $2, updated_at=now() WHERE id=$1`, [o.memberId, growth]);
    return growth;
  }

  /** 消费成长值：非排除商品金额 × (现金类实付 / 应收) × 消费倍率
   *  · 现金类实付 = 现金/微信/支付宝（余额·分红抵扣·积分抵扣天然被排除在外）
   *  · 券抵扣已在 payable 中扣除，不进入实付，故只算顾客实掏的钱
   *  · 按比例分摊：整单部分余额+部分现金时，只有现金那部分对应金额计成长 */
  async earnConsume(c: any, o: { memberId: number; orderId: number }): Promise<number> {
    if (!(Number(o.memberId) > 0)) return 0;
    if (!(await this.enabled())) return 0;
    const rate = await this.num('member.growth.consume_rate', 0.8);
    const exProd = await this.idArr('member.growth.exclude_products');
    const exCat = await this.idArr('member.growth.exclude_categories');
    const exPromo = (await this.num('member.growth.exclude_promo', 1)) === 1;
    const g = await cx(c,
      `SELECT COALESCE(SUM(si.line_amount),0) AS amt,
              COALESCE(MAX(o2.payable_amount),0) AS payable
         FROM sale_items si
         JOIN products p ON p.id = si.product_id
         JOIN sales_orders o2 ON o2.id = si.order_id
        WHERE si.order_id = $1
          AND NOT ($2::bigint[] @> ARRAY[p.id])
          AND NOT (p.category_id = ANY($3::bigint[]))
          AND NOT ($4 AND si.promo_id IS NOT NULL)
          AND NOT (COALESCE(si.line_remark,'') LIKE '赠品%')`,
      [o.orderId, exProd, exCat, exPromo]);
    const nonExcluded = Number(g[0]?.amt || 0);
    const payable = Number(g[0]?.payable || 0);
    if (!(nonExcluded > 0) || !(payable > 0)) return 0;
    const pay = await cx(c,
      `SELECT COALESCE(SUM(amount),0) AS n FROM sale_payments
        WHERE order_id=$1 AND channel::text IN ('现金','微信','支付宝')`, [o.orderId]);
    const cashPaid = Number(pay[0]?.n || 0);
    if (!(cashPaid > 0)) return 0;                    // 纯余额/分红/积分买单 → 不计成长
    const base = r2(Math.min(nonExcluded * cashPaid / payable, nonExcluded));
    const growth = r2(base * rate);
    if (!(growth > 0)) return 0;
    await cx(c,
      `INSERT INTO member_growth_records (store_id, member_id, direction, growth_value, base_amount, rate, biz_type, ref_type, ref_id, remark)
       VALUES (${curStore()},$1,'加',$2,$3,$4,'消费','sale',$5,'实付消费成长值')`,
      [o.memberId, growth, base, rate, o.orderId]);
    await cx(c, `UPDATE members SET growth_total = growth_total + $2, updated_at=now() WHERE id=$1`, [o.memberId, growth]);
    return growth;
  }
  /** 退货扣回成长值：按退款额占原单实付比例扣减（退款后等级判定由 syncLevel 统一处理）
   *  幂等：同一订单按「已扣减比例」控制，累计扣减不超过原单已发放的成长值 */
  async revokeConsume(c: any, o: { memberId: number; orderId: number; refundAmount: number; orderPayable: number }): Promise<number> {
    if (!(Number(o.memberId) > 0) || !(Number(o.refundAmount) > 0)) return 0;
    if (!(await this.enabled())) return 0;
    const payable = Number(o.orderPayable || 0);
    if (!(payable > 0)) return 0;
    // 原单已发放成长值（加项，biz_type='消费'）
    const earned = await cx(c,
      `SELECT COALESCE(SUM(growth_value),0) AS n FROM member_growth_records
        WHERE member_id=$1 AND ref_type='sale' AND ref_id=$2 AND direction='加' AND biz_type='消费'`,
      [o.memberId, o.orderId]);
    const totalEarned = Number(earned[0]?.n || 0);
    if (!(totalEarned > 0)) return 0;
    // 已扣减合计（减项）
    const revoked = await cx(c,
      `SELECT COALESCE(SUM(growth_value),0) AS n FROM member_growth_records
        WHERE member_id=$1 AND ref_type='sale' AND ref_id=$2 AND direction='减' AND biz_type='退货'`,
      [o.memberId, o.orderId]);
    const revokedTotal = Number(revoked[0]?.n || 0);
    const ratio = Math.min(Number(o.refundAmount) / payable, 1);
    let back = r2(totalEarned * ratio) - revokedTotal;
    if (!(back > 0)) return 0;
    back = r2(Math.min(back, totalEarned - revokedTotal));   // 双重封顶：不超原单已发放
    await cx(c,
      `INSERT INTO member_growth_records (store_id, member_id, direction, growth_value, base_amount, rate, biz_type, ref_type, ref_id, remark)
       VALUES (${curStore()},$1,'减',$2,$3,0,'退货','sale',$4,'退货扣回成长值')`,
      [o.memberId, back, r2(Number(o.refundAmount)), o.orderId]);
    await cx(c, `UPDATE members SET growth_total = growth_total - $2, updated_at=now() WHERE id=$1`, [o.memberId, back]);
    return back;
  }

  /** 滚动考核周期内的成长值（含扣减）。months 默认取 member.growth.period_months（6） */
  async recentGrowth(c: any, memberId: number, months?: number): Promise<number> {
    const m = months && months > 0 ? months : await this.num('member.growth.period_months', 6);
    const r = await cx(c,
      `SELECT COALESCE(SUM(CASE WHEN direction='加' THEN growth_value ELSE -growth_value END),0) AS s
         FROM member_growth_records
        WHERE member_id=$1 AND created_at >= (CURRENT_DATE - ($2 || ' months')::interval)`,
      [memberId, String(m)]);
    return r2(Number(r[0]?.s || 0));
  }

  /** 等级判定（成长值口径）：升级立即 / 不达保级线进缓冲 / 缓冲到期下调
   *  返回 { changed, from, to, levelName, growthTotal, recent, graceStarted, graceDaysLeft, reason } */
  async syncLevel(c: any, memberId: number, operatorId: number | null = null): Promise<any> {
    const levels = await cx(c,
      `SELECT id, name, sort_no, upgrade_growth, keep_growth FROM member_levels ORDER BY sort_no, id`);
    if (!levels.length) return { changed: false, reason: '无等级配置' };
    const row = await cx(c,
      `SELECT level_id, COALESCE(growth_total,0) AS growth_total, level_below_since
         FROM members WHERE id=$1 FOR UPDATE`, [memberId]);
    if (!row[0]) return { changed: false, reason: '会员不存在' };
    const growthTotal = Number(row[0].growth_total || 0);
    const periods = await this.num('member.growth.period_months', 6);
    const recent = await this.recentGrowth(c, memberId, periods);
    const topUp = levels.filter((l: any) => growthTotal >= Number(l.upgrade_growth));
    const targetUp = topUp.length ? topUp[topUp.length - 1] : levels[0];
    // 首次初始化：level_id 为空或指向已删除档位 → 按成长值写入起始档（至少普通会员）
    const curLevel = row[0].level_id ? levels.find((l: any) => Number(l.id) === Number(row[0].level_id)) : null;
    if (!curLevel) {
      await cx(c, `UPDATE members SET level_id=$2, level_below_since=NULL, updated_at=now() WHERE id=$1`, [memberId, targetUp.id]);
      await this.log(c, memberId, 0, targetUp.id, operatorId, `初始化等级（成长值 ${growthTotal}）`);
      return { changed: true, from: null, to: targetUp.name, levelName: targetUp.name, growthTotal, recent, initialized: true };
    }
    // ① 升级（累计成长值达标）——立即生效，清缓冲
    if (Number(targetUp.sort_no) > Number(curLevel.sort_no)) {
      await cx(c, `UPDATE members SET level_id=$2, level_below_since=NULL, updated_at=now() WHERE id=$1`, [memberId, targetUp.id]);
      await this.log(c, memberId, curLevel.id, targetUp.id, operatorId, `成长值升级（累计 ${growthTotal} ≥ ${targetUp.upgrade_growth}）`);
      return { changed: true, from: curLevel.name, to: targetUp.name, levelName: targetUp.name, growthTotal, recent };
    }
    // ② 保级：近周期成长值 ≥ 当前档保级门槛 → 维持，清缓冲
    if (recent >= Number(curLevel.keep_growth)) {
      if (row[0].level_below_since) await cx(c, `UPDATE members SET level_below_since=NULL WHERE id=$1`, [memberId]);
      return { changed: false, levelName: curLevel.name, growthTotal, recent, inGrace: false };
    }
    // ③ 需降级 → 缓冲期机制
    const keepOk = levels.filter((l: any) => recent >= Number(l.keep_growth));
    const targetKeep = keepOk.length ? keepOk[keepOk.length - 1] : levels[0];
    // 历史 key 为 member.level_grace_days（下划线）；V5.0.17 迁移 171 已删除误插入的点号版本，此处读统一 key
    const graceDays = await this.num('member.level_grace_days', 30);
    if (!row[0].level_below_since) {   // 首次发现不达保级线 → 进入缓冲
      await cx(c, `UPDATE members SET level_below_since=CURRENT_DATE WHERE id=$1`, [memberId]);
      await this.log(c, memberId, curLevel.id, curLevel.id, operatorId, `进入等级保护缓冲期（近${periods}月成长 ${recent} < 保级线 ${curLevel.keep_growth}，缓冲 ${graceDays} 天）`);
      return { changed: false, levelName: curLevel.name, growthTotal, recent, graceStarted: true, graceDays };
    }
    const days = Math.floor((Date.now() - new Date(row[0].level_below_since).getTime()) / 86400000);
    if (days >= graceDays) {   // 缓冲期结束仍不达标 → 正式下调
      await cx(c, `UPDATE members SET level_id=$2, level_below_since=NULL, updated_at=now() WHERE id=$1`, [memberId, targetKeep.id]);
      await this.log(c, memberId, curLevel.id, targetKeep.id, operatorId, `缓冲期结束仍未达标，近${periods}月成长 ${recent}，下调至 ${targetKeep.name}`);
      return { changed: true, from: curLevel.name, to: targetKeep.name, levelName: targetKeep.name, growthTotal, recent, downgraded: true };
    }
    return { changed: false, levelName: curLevel.name, growthTotal, recent, inGrace: true, graceDaysLeft: graceDays - days };
  }

  /** 等级变更留痕（复用 member_level_log；reason 列仅 VARCHAR(32)，超长需截断） */
  private async log(c: any, memberId: number, fromId: number, toId: number, operatorId: number | null, reason: string) {
    try {
      await cx(c,
        `INSERT INTO member_level_log (member_id, from_level_id, to_level_id, reason, operator_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [memberId, fromId || null, toId || null, String(reason).slice(0, 32), operatorId]);
    } catch { /* 留痕失败不阻断主流程 */ }
  }
}

export const memberGrowth = new MemberGrowthService();