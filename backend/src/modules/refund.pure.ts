/**
 * 退款分摊纯函数（Q-02 特征测试基座 · 第三抽离件）
 *
 * 设计约束：零 import（与 coupons.pure/sales.pure 同纪律）。
 * 抽离自 refund.module.ts（逐字保留现行为，特征测试锁住）：
 *   - apportionRefundCents      ← calcRows 退款金额按行分摊（权重=退货数量×成交单价，尾差进最后一行）
 *   - apportionRefundByChannel  ← executeInTx 支付原路退按渠道分摊（尾差进最后一渠道）
 */

/**
 * 退款金额按行分摊（整数分，权重 = 退货数量 × 成交单价）：
 *   ① 逐行 round(amountCents × w/totalW)，最后一行先拿原始尾差兜底；
 *   ② 再逐行扣除已分摊（min 钳制），合计恒等于 amountCents 且 ≥0。
 *   空权重数组 → 空数组；totalW=0 → 除末行外全 0。
 */
export function apportionRefundCents(weights: number[], amountCents: number): number[] {
  const totalW = weights.reduce((s, x) => s + x, 0);
  const rowCents = weights.map((w, i) => {
    if (i === weights.length - 1) return amountCents;      // 最后一行兜底尾差
    return totalW > 0 ? Math.round(amountCents * (w / totalW)) : 0;
  });
  let used = 0;
  for (let i = 0; i < rowCents.length - 1; i++) { rowCents[i] = Math.min(rowCents[i], amountCents - used); used += rowCents[i]; }
  if (rowCents.length) rowCents[rowCents.length - 1] = Math.max(amountCents - used, 0);
  return rowCents;
}

/**
 * 支付原路退按渠道分摊（整数分，ratio = 退款额/实付，≤1）：
 *   非末渠道 = round(渠道金额分 × ratio)；末渠道 = max(退款总额 − 已分摊, 0)（尾差兜底）。
 *   单渠道特例：ratio 因子按 0 计（末渠道直接拿全额）——与原内联 `pays.length > 1 ? ratio : 0` 一致。
 */
export function apportionRefundByChannel(channelCents: number[], totalCents: number, ratio: number): number[] {
  return channelCents.map((cent, i) => {
    if (i === channelCents.length - 1) {
      const prev = channelCents.slice(0, i)
        .reduce((s, c) => s + Math.round(c * (channelCents.length > 1 ? ratio : 0)), 0);
      return Math.max(totalCents - prev, 0);
    }
    return Math.round(cent * ratio);
  });
}
