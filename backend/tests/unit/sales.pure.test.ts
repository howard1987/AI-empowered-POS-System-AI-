/**
 * Q-02 特征测试基座 · 收银计价纯函数（sales.pure.ts）表驱动用例
 * 运行：npm run test:unit
 * 锁住现行为（特征测试）：行计价按分（V4.13.1/RV-01）、FIFO 批次分配（含软模式负批次挂起）、
 * 整单优惠按行小比分摊（尾差进最后一行有余额的行）——P-03/Q-01 资金路径重构的安全网。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calcLineCents, fifoAllocate, apportionOrderDiscount, orderDiscountRedLine, calcOrderDiscountCents, applyRoundRule, aggregateBatchDeductions, type BatchRow } from '../../src/modules/sales.pure.ts';

/* ═══════════ calcLineCents · 行计价按分 ═══════════ */

describe('calcLineCents · 行计价按分（RV-01）', () => {
  const base = { lineAmountOverride: null, priceChanged: false, levelDiscountOn: false, levelCtx: null, basePrice: 0 };
  it('表驱动：金额/覆盖/等级折扣/浮点各场景', () => {
    const cases: { name: string; inp: any; lineCents: number; lineDiscountCents: number }[] = [
      // 普通整数价 × 整数数量
      { name: '3.5×3 = 10.50', inp: { ...base, unitPrice: 3.5, baseQty: 3 }, lineCents: 1050, lineDiscountCents: 0 },
      // 称重小数数量：25.6 × 0.35kg
      { name: '25.6×0.35kg = 8.96（无浮点尾差）', inp: { ...base, unitPrice: 25.6, baseQty: 0.35 }, lineCents: 896, lineDiscountCents: 0 },
      // 经典浮点陷阱：0.1×3 必须 = 30 分而非 30.000000000000004
      { name: '0.1×3 = 0.30（0.1+0.2 类尾差被取整分消灭）', inp: { ...base, unitPrice: 0.1, baseQty: 3 }, lineCents: 30, lineDiscountCents: 0 },
      // 包装定价覆盖：行金额直接按覆盖（55 元箱价×2）
      { name: '覆盖金额 110 → 11000 分（不按单价×数量）', inp: { ...base, unitPrice: 9, baseQty: 2, lineAmountOverride: 110 }, lineCents: 11000, lineDiscountCents: 0 },
      // 等级折扣：基线 10、成交 9.5（95折）×2 → 金额 1900 分，差额 round(2×50)=100 分
      { name: '等级95折：10→9.5×2，差额 1.00', inp: { ...base, unitPrice: 9.5, baseQty: 2, levelDiscountOn: true, levelCtx: { discount: 0.95 }, basePrice: 10 }, lineCents: 1900, lineDiscountCents: 100 },
      // 改价行不吃等级折扣差额
      { name: '改价行：同上但 priceChanged → 差额 0', inp: { ...base, unitPrice: 9.5, baseQty: 2, priceChanged: true, levelDiscountOn: true, levelCtx: { discount: 0.95 }, basePrice: 10 }, lineCents: 1900, lineDiscountCents: 0 },
      // 等级折扣未启用 / 折扣=1（无折扣）
      { name: 'levelDiscountOn=false → 差额 0', inp: { ...base, unitPrice: 9.5, baseQty: 2, levelCtx: { discount: 0.95 }, basePrice: 10 }, lineCents: 1900, lineDiscountCents: 0 },
      { name: 'discount=1 → 差额 0', inp: { ...base, unitPrice: 9.5, baseQty: 2, levelDiscountOn: true, levelCtx: { discount: 1 }, basePrice: 10 }, lineCents: 1900, lineDiscountCents: 0 },
      // 覆盖金额时即使有等级折扣也不计差额（与原内联条件一致）
      { name: '覆盖金额 + 等级折扣 → 差额 0', inp: { ...base, unitPrice: 9, baseQty: 2, lineAmountOverride: 18, levelDiscountOn: true, levelCtx: { discount: 0.95 }, basePrice: 10 }, lineCents: 1800, lineDiscountCents: 0 },
    ];
    for (const c of cases) {
      const r = calcLineCents(c.inp);
      assert.equal(r.lineCents, c.lineCents, c.name);
      assert.equal(r.lineDiscountCents, c.lineDiscountCents, c.name);
    }
  });
});

/* ═══════════ fifoAllocate · FIFO 批次分配 ═══════════ */

describe('fifoAllocate · FIFO 批次分配', () => {
  const b = (id: number, remain: number, cost: number): BatchRow => ({ id, remain_qty: remain, inbound_cost: cost });
  it('跨批：100@2.5 + 50@3.0，需 120 → 100+20，成本 310', () => {
    const r = fifoAllocate([b(1, 100, 2.5), b(2, 50, 3.0)], 120, false);
    assert.deepEqual(r.allocs, [{ batchId: 1, qty: 100, cost: 2.5 }, { batchId: 2, qty: 20, cost: 3.0 }]);
    assert.equal(r.cost, 310);
    assert.equal(r.shortage, null);
  });
  it('恰好吃尽：需 100 → 只取第一批', () => {
    const r = fifoAllocate([b(1, 100, 2.5), b(2, 50, 3.0)], 100, false);
    assert.deepEqual(r.allocs, [{ batchId: 1, qty: 100, cost: 2.5 }]);
    assert.equal(r.cost, 250);
  });
  it('硬模式不足：allocs 只吃现有、shortage=null（50001 由调用方抛）', () => {
    const r = fifoAllocate([b(1, 50, 2.0)], 80, false);
    assert.deepEqual(r.allocs, [{ batchId: 1, qty: 50, cost: 2.0 }]);
    assert.equal(r.cost, 100);
    assert.equal(r.shortage, null);
  });
  it('软模式不足（有批次）：末位批次挂差额 30，basis=batch:1，成本按其进价累计', () => {
    const r = fifoAllocate([b(1, 50, 2.0)], 80, true);
    assert.deepEqual(r.allocs, [{ batchId: 1, qty: 50, cost: 2.0 }, { batchId: 1, qty: 30, cost: 2.0 }]);
    assert.equal(r.cost, 160);
    assert.deepEqual(r.shortage, { qty: 30, basis: 'batch:1' });
  });
  it('软模式无任何批次：basis=none，成本 0（调用方进挂起成本队列）', () => {
    const r = fifoAllocate([], 5, true);
    assert.deepEqual(r.allocs, []);
    assert.equal(r.cost, 0);
    assert.deepEqual(r.shortage, { qty: 5, basis: 'none' });
  });
  it('称重小数：批 0.35kg，需 0.5 → 取 0.35 + 挂 0.15（r3 口径）', () => {
    const r = fifoAllocate([b(7, 0.35, 20)], 0.5, true);
    assert.deepEqual(r.allocs, [{ batchId: 7, qty: 0.35, cost: 20 }, { batchId: 7, qty: 0.15, cost: 20 }]);
    assert.deepEqual(r.shortage, { qty: 0.15, basis: 'batch:7' });
  });
  it('need=0 → 空分配', () => {
    const r = fifoAllocate([b(1, 100, 2.5)], 0, false);
    assert.deepEqual(r.allocs, []);
    assert.equal(r.cost, 0);
  });
});

/* ═══════════ apportionOrderDiscount · 整单优惠分摊 ═══════════ */

describe('apportionOrderDiscount · 整单优惠按行小比分摊', () => {
  it('整除场景：行 [30,50,20] 基 100 优惠 10 → [3,5,2]', () => {
    const lines = [{ lineAmount: 30 }, { lineAmount: 50 }, { lineAmount: 20 }];
    apportionOrderDiscount(lines, 10, 100);
    assert.deepEqual(lines.map(l => l.promoAlloc), [3, 5, 2]);
    assert.deepEqual(lines.map(l => l.lineAmount), [27, 45, 18]);
  });
  it('尾差进最后一行：[33.33,33.33,33.34] 优惠 10 → [3.33,3.33,3.34]，合计=10', () => {
    const lines = [{ lineAmount: 33.33 }, { lineAmount: 33.33 }, { lineAmount: 33.34 }];
    apportionOrderDiscount(lines, 10, 100);
    assert.deepEqual(lines.map(l => l.promoAlloc), [3.33, 3.33, 3.34]);
    const sum = Math.round(lines.reduce((s, l) => s + (l.promoAlloc || 0), 0) * 100);
    assert.equal(sum, 1000);
  });
  it('单行分摊超行金额被钳到行金额（原行为：不回改已累计值）', () => {
    const lines = [{ lineAmount: 2 }, { lineAmount: 2 }];
    apportionOrderDiscount(lines, 10, 4);   // 行1: 10*2/4=5→钳2；行2(末): 10-5=5→钳2
    assert.deepEqual(lines.map(l => l.promoAlloc), [2, 2]);
    assert.deepEqual(lines.map(l => l.lineAmount), [0, 0]);
  });
  it('0 元行按 0 分摊；尾差进最后一行「有余额」的行', () => {
    const lines = [{ lineAmount: 0 }, { lineAmount: 50 }, { lineAmount: 0 }, { lineAmount: 50 }];
    apportionOrderDiscount(lines, 10, 100);
    assert.deepEqual(lines.map(l => l.promoAlloc), [0, 5, 0, 5]);   // 末行=索引3
  });
  it('性质校验：随机分摊 ΣpromoAlloc ≤ off 且各行金额不透支为负', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 50; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      const lines = Array.from({ length: n }, () => ({ lineAmount: Math.round(rnd() * 50000) / 100 }));
      const base = Math.round(lines.reduce((s, l) => s + l.lineAmount, 0) * 100) / 100;
      if (base <= 0) continue;
      const off = Math.round(rnd() * base * 100) / 100;
      apportionOrderDiscount(lines, off, base);
      const sum = lines.reduce((s, l) => s + (l.promoAlloc || 0), 0);
      assert.ok(sum <= off + 1e-9, `off=${off} sum=${sum}`);
      for (const l of lines) assert.ok(l.lineAmount >= 0 - 1e-9, '行金额不得为负');
    }
  });
});

/* ═══════════ aggregateBatchDeductions · 批次扣减聚合（P-03 前置） ═══════════ */

describe('aggregateBatchDeductions · 同批次多条 alloc 聚合', () => {
  it('同批次双 alloc（FIFO 跨批 + 软挂同批）合并净扣减', () => {
    const allocs = [{ batchId: 1, qty: 50, cost: 2 }, { batchId: 2, qty: 20, cost: 3 }, { batchId: 1, qty: 30, cost: 2 }];
    assert.deepEqual(aggregateBatchDeductions(allocs), [{ batchId: 1, qty: 80 }, { batchId: 2, qty: 20 }]);
  });
  it('保持首次出现顺序；空输入 → 空', () => {
    assert.deepEqual(aggregateBatchDeductions([{ batchId: 5, qty: 1, cost: 9 }, { batchId: 3, qty: 2, cost: 9 }]),
      [{ batchId: 5, qty: 1 }, { batchId: 3, qty: 2 }]);
    assert.deepEqual(aggregateBatchDeductions([]), []);
  });
  it('称重小数聚合后仍按 r3 口径', () => {
    assert.deepEqual(aggregateBatchDeductions([{ batchId: 1, qty: 0.35, cost: 20 }, { batchId: 1, qty: 0.15, cost: 20 }]),
      [{ batchId: 1, qty: 0.5 }]);
  });
});

/* ═══════════ orderDiscountRedLine · 整单折扣双红线 ═══════════ */

describe('orderDiscountRedLine · 整单折扣双红线（最低折扣/最低卖价+进价兜底）', () => {
  it('表驱动：红线判定各场景', () => {
    const cases: { name: string; p: any; unitPrice: number; rate: number; floorRate: number; want: any }[] = [
      { name: '显式 min_price=8：9 元打 8 折 → 折后 7.2 < 8 → 越线',
        p: { min_price: 8, sell_price: 10, cost_price: 5 }, unitPrice: 9, rate: 80, floorRate: 0.8,
        want: { priceSet: 8, minP: 8, minD: 0, belowDisc: false, belowPrice: true } },
      { name: '未设 min_price：按售价×floorRate（10×0.8=8）',
        p: { sell_price: 10, cost_price: 0 }, unitPrice: 9, rate: 70, floorRate: 0.8,
        want: { priceSet: 0, minP: 8, minD: 0, belowDisc: false, belowPrice: true } },
      { name: 'minPrice 别名同样生效（camelCase 字段）',
        p: { minPrice: 8.5, sell_price: 10, cost_price: 0 }, unitPrice: 9, rate: 80, floorRate: 0.8,
        want: { priceSet: 8.5, minP: 8.5, minD: 0, belowDisc: false, belowPrice: true } },
      { name: '进价高于最低卖价线：红线=max(5,9)=9',
        p: { min_price: 5, sell_price: 10, cost_price: 9 }, unitPrice: 9, rate: 95, floorRate: 0.8,
        want: { priceSet: 5, minP: 9, minD: 0, belowDisc: false, belowPrice: true } },
      { name: '低于商品最低折扣率：85 < 90（同时折后 7.65 也低于 floor 8 → 双红线命中）',
        p: { min_discount_rate: 90, sell_price: 10 }, unitPrice: 9, rate: 85, floorRate: 0.8,
        want: { priceSet: 0, minP: 8, minD: 90, belowDisc: true, belowPrice: true } },
      { name: '全部合规：90 折、折后 8.1 ≥ 红线',
        p: { min_price: 5, sell_price: 10, cost_price: 0, min_discount_rate: 80 }, unitPrice: 9, rate: 90, floorRate: 0.8,
        want: { priceSet: 5, minP: 5, minD: 80, belowDisc: false, belowPrice: false } },
      { name: '容差边界：折后恰 = 红线 − 0.005 → 不算越线（严格 <）',
        p: { min_price: 10, sell_price: 10, cost_price: 0 }, unitPrice: 10, rate: 99.95, floorRate: 0.8,
        want: { priceSet: 10, minP: 10, minD: 0, belowDisc: false, belowPrice: false } },
    ];
    for (const c of cases) {
      const r = orderDiscountRedLine(c.p, c.unitPrice, c.rate, c.floorRate);
      assert.deepEqual(
        { priceSet: r.priceSet, minP: r.minP, minD: r.minD, belowDisc: r.belowDisc, belowPrice: r.belowPrice },
        c.want, c.name);
    }
  });
});

/* ═══════════ calcOrderDiscountCents · 折扣封顶（应收保底 1 分） ═══════════ */

describe('calcOrderDiscountCents · 整单折扣封顶', () => {
  it('折扣 < 应收：原样按分', () => {
    assert.equal(calcOrderDiscountCents(5, 2000), 500);
    assert.equal(calcOrderDiscountCents('5', 2000), 500);      // 字符串金额同样按分
  });
  it('折扣 ≥ 应收：封顶到 应收−1分（永不 0 元/负数单）', () => {
    assert.equal(calcOrderDiscountCents(25, 2000), 1999);
  });
  it('应收 0 / 1 分：折扣额 ≤ 0 → 调用方 if(>0) 自然跳过', () => {
    assert.equal(calcOrderDiscountCents(5, 0), -1);
    assert.equal(calcOrderDiscountCents(5, 1), 0);
  });
});

/* ═══════════ applyRoundRule · 自动抹零（先打折后抹零） ═══════════ */

describe('applyRoundRule · 自动抹零（分/角/5角/元向下去零）', () => {
  it('表驱动：各规则抹零', () => {
    const cases: { name: string; payable: number; rule: string; round: number; after: number }[] = [
      { name: '角：1234 → 抹 4 分 → 1230', payable: 1234, rule: '角', round: 4, after: 1230 },
      { name: '5角：1280 → 抹 30 分 → 1250', payable: 1280, rule: '5角', round: 30, after: 1250 },
      { name: '元：1234 → 抹 34 分 → 1200', payable: 1234, rule: '元', round: 34, after: 1200 },
      { name: '恰为整数元：1200 → 不抹', payable: 1200, rule: '元', round: 0, after: 1200 },
      { name: '规则=分：不抹', payable: 1234, rule: '分', round: 0, after: 1234 },
      { name: '未知规则：不抹（原行为）', payable: 1234, rule: 'half', round: 0, after: 1234 },
      { name: '应收 0：不抹', payable: 0, rule: '元', round: 0, after: 0 },
    ];
    for (const c of cases) {
      const r = applyRoundRule(c.payable, c.rule);
      assert.equal(r.roundCents, c.round, c.name);
      assert.equal(r.payableCents, c.after, c.name);
    }
  });
  it('性质校验：抹零只减不加、结果为规则粒度的整数倍', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rules = ['分', '角', '5角', '元', 'unknown'];
    const unitMap: Record<string, number> = { '分': 1, '角': 10, '5角': 50, '元': 100, 'unknown': 1 };
    for (let i = 0; i < 50; i++) {
      const payable = Math.floor(rnd() * 1000000);
      const rule = rules[Math.floor(rnd() * rules.length)];
      const r = applyRoundRule(payable, rule);
      assert.ok(r.payableCents <= payable);
      assert.ok(r.payableCents % unitMap[rule] === 0, `rule=${rule} after=${r.payableCents}`);
      assert.ok(payable - r.payableCents < unitMap[rule]);
    }
  });
});
