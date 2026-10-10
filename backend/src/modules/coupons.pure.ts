/**
 * 优惠券纯函数（Q-02 特征测试基座 · 第一个抽离件）
 *
 * 设计约束：本文件【零 import】——不引 Nest、不引 DB、不引任何带模块级副作用的模块，
 *   使单元测试可以毫秒级 import 而不触发依赖树（教训：dist/modules/* 会拖起整个 Nest/DB 初始化）。
 *   本地 r2 与 common/db 的 r2 同义（金额四舍五入到分）；若改 r2 口径必须同步这里。
 *
 * 抽离自 coupons.module.ts applyCoupons（V5.0.15 QA-P0 / L-05 修复后的现行为）：
 *   - chooseCoupons    ：多券使用模式裁决（single 取最优一张 / manual 互斥裁决 / auto 组合择优）
 *   - sumChosenCoupons ：叠加封顶求和（L-05：累计抵扣永不超过「货值−促销」，保证应付 ≥ 0）
 */

/** 金额四舍五入到分（与 common/db r2 同义，纯文件内不得 import） */
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface CouponScore {
  /** 券实例（member_coupons JOIN 模板行，至少含 id/name/stackable） */
  mc: any;
  /** 该券在本单可抵扣的金额（couponAmountOf 已按门槛/范围/封顶算好） */
  amount: number;
}

/**
 * 多券使用模式裁决（纯函数，不改写入参）
 *  - single：有指定券则在其中取最优一张；否则在全量可用池取最优一张
 *  - manual：选中集合里存在不可叠加券 → 只用其中最优一张；否则全选累加
 *  - auto  ：可叠加券合计 ≥ 最优不可叠加券 → 用全部可叠加券；否则用最优不可叠加券；都没有 → 空数组
 */
export function chooseCoupons(
  scored: CouponScore[],
  mode: 'single' | 'auto' | 'manual',
  requestedMcIds?: number[],
): CouponScore[] {
  const byReq = (ids: number[]) => ids
    .map(id => scored.find(x => Number(x.mc.id) === Number(id)))
    .filter(Boolean) as CouponScore[];

  let chosen: CouponScore[] = [];
  if (mode === 'single') {
    const pool = requestedMcIds?.length ? byReq(requestedMcIds) : scored;
    const best = [...pool].sort((a, b) => b.amount - a.amount)[0];
    if (best) chosen = [best];
  } else if (mode === 'manual') {
    const sel = byReq(requestedMcIds || []);
    const nonStack = sel.filter(x => x.mc.stackable === false);
    if (nonStack.length) {
      const bestNon = [...nonStack].sort((a, b) => b.amount - a.amount)[0]; // 互斥券之间也只取最优一张
      chosen = [bestNon];
    } else {
      chosen = sel; // 全部可叠加：直接累加
    }
  } else { // auto：系统自动组合最优
    const nonStack = scored.filter(x => x.mc.stackable === false).sort((a, b) => b.amount - a.amount)[0];
    const nonStackAmt = nonStack ? nonStack.amount : -1;
    const stackables = scored.filter(x => x.mc.stackable !== false);
    const stackSum = stackables.reduce((s, x) => s + x.amount, 0);
    chosen = stackSum >= nonStackAmt ? stackables : (nonStack ? [nonStack] : []);
  }
  return chosen;
}

/**
 * 叠加封顶求和（L-05 修复的核心不变量，纯函数）：
 *   逐张对「货值−促销」后的剩余额封顶再累加 → 累计抵扣永不超过 (goodsAmount − promoAmount)，
 *   保证 payable ≥ 0。例：两张 ¥60 满减券用于 ¥100 货 → 60 + 40 = 100，应付归零且可结账。
 *   传入 amount 为负/剩余为负时按 0 处理；顺序即 chosen 数组顺序（先到先封顶）。
 */
export function sumChosenCoupons(chosen: CouponScore[], goodsAmount: number, promoAmount: number): number {
  let couponRemain = Math.max(0, r2(goodsAmount - promoAmount));
  const total = chosen.reduce((s, x) => {
    const applied = Math.max(0, Math.min(r2(x.amount), couponRemain));
    couponRemain = r2(couponRemain - applied);
    return s + applied;
  }, 0);
  return r2(total);
}
