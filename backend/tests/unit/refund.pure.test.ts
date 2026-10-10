/**
 * Q-02 特征测试基座 · 退款分摊纯函数（refund.pure.ts）表驱动用例
 * 运行：npm run test:unit
 * 锁住现行为：退款金额按行分摊（权重=退货数量×成交单价，尾差进最后一行、Σ恒=应退）、
 * 支付原路退按渠道分摊（前面渠道按占比取整分，末渠道尾差兜底≥0）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apportionRefundCents, apportionRefundByChannel } from '../../src/modules/refund.pure.ts';

describe('apportionRefundCents · 退款按行分摊（整数分）', () => {
  it('表驱动：权重/尾差/钳制各场景', () => {
    const cases: { name: string; weights: number[]; amount: number; want: number[] }[] = [
      { name: '整除：权重[30,50,20] 退¥100 → [3000,5000,2000]', weights: [30, 50, 20], amount: 10000, want: [3000, 5000, 2000] },
      { name: '除不尽：均权 3 行退 100 分 → [33,33,34]（尾差进末行）', weights: [1, 1, 1], amount: 100, want: [33, 33, 34] },
      { name: '0 权重行不参与：[0,50,50] 100 分 → [0,50,50]', weights: [0, 50, 50], amount: 100, want: [0, 50, 50] },
      { name: '首行权重独大被钳：[1000,1] 退 10 分 → [10,0]', weights: [1000, 1], amount: 10, want: [10, 0] },
      { name: '应退 0 → 全 0', weights: [10, 20], amount: 0, want: [0, 0] },
      { name: '单行：直接全额', weights: [5], amount: 100, want: [100] },
      { name: 'totalW=0（全 0 权重）→ 除末行兜底外全 0', weights: [0, 0], amount: 100, want: [0, 100] },
    ];
    for (const c of cases) {
      assert.deepEqual(apportionRefundCents(c.weights, c.amount), c.want, c.name);
    }
  });
  it('空行集 → 空数组', () => {
    assert.deepEqual(apportionRefundCents([], 100), []);
  });
  it('性质校验：Σ 恒等于应退（应退≥0），各行 ≥0', () => {
    let seed = 2026;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 50; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      const weights = Array.from({ length: n }, () => Math.round(rnd() * 10000) / 100);
      const amount = Math.floor(rnd() * 5000000);
      const rows = apportionRefundCents(weights, amount);
      const sum = rows.reduce((s, x) => s + x, 0);
      assert.equal(sum, amount, `weights=${weights} amount=${amount} → ${rows}`);
      for (const x of rows) assert.ok(x >= 0);
    }
  });
});

describe('apportionRefundByChannel · 支付原路退按渠道分摊', () => {
  it('表驱动：占比取整分 + 末渠道尾差兜底', () => {
    const cases: { name: string; channels: number[]; total: number; ratio: number; want: number[] }[] = [
      // 订单收款 余额30+扫码70（分），退 20% = 2000 分
      { name: '两渠道 20%：[3000,7000] 退 2000 → [600,1400]', channels: [3000, 7000], total: 2000, ratio: 0.2, want: [600, 1400] },
      { name: '单渠道：末渠道直接拿全额（单渠道 ratio 因子按 0 计）', channels: [5000], total: 2000, ratio: 0.4, want: [2000] },
      { name: 'round(.5) 进位尾差：[1001,1001] 退 1000 半额 → [501,499]', channels: [1001, 1001], total: 1000, ratio: 0.5, want: [501, 499] },
      { name: '三渠道：[2000,3000,5000] 退 4000 (0.4) → [800,1200,2000]', channels: [2000, 3000, 5000], total: 4000, ratio: 0.4, want: [800, 1200, 2000] },
      { name: '全额退：末渠道多出部分钳 0 → [100,0]', channels: [100, 100], total: 100, ratio: 1, want: [100, 0] },
      { name: 'ratio=0：非末渠道 0，末渠道拿全额', channels: [100, 200], total: 50, ratio: 0, want: [0, 50] },
    ];
    for (const c of cases) {
      assert.deepEqual(apportionRefundByChannel(c.channels, c.total, c.ratio), c.want, c.name);
    }
  });
  it('空渠道 → 空', () => {
    assert.deepEqual(apportionRefundByChannel([], 100, 0.5), []);
  });
  it('性质校验：各行 ≥0，末渠道 = max(total−Σ前面,0)', () => {
    let seed = 55;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 50; i++) {
      const n = 1 + Math.floor(rnd() * 4);
      const channels = Array.from({ length: n }, () => Math.floor(rnd() * 1000000));
      const payable = Math.max(channels.reduce((s, x) => s + x, 0), 1);
      const ratio = Math.min(rnd(), 1);   // 合法业务里 ratio = 退/实付 ≤ 1
      const rows = apportionRefundByChannel(channels, Math.floor(payable * ratio), ratio);
      const used = rows.slice(0, -1).reduce((s, x) => s + x, 0);
      if (rows.length) {
        assert.equal(rows[rows.length - 1], Math.max(Math.floor(payable * ratio) - used, 0), `channels=${channels} ratio=${ratio}`);
      }
      for (const x of rows) assert.ok(x >= 0);
    }
  });
});
