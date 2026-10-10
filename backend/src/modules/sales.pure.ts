/**
 * 收银计价纯函数核（Q-02 特征测试基座 · 第二抽离件）
 *
 * 设计约束：本文件【零 import】（与 coupons.pure.ts 同纪律）——不引 Nest/DB/副作用模块，
 *   单测可毫秒级 import。本地 r2/r3/toCents 与 common/db、sales.module 的同名函数同义；
 *   若改舍入口径必须同步这里与对应测试。
 *
 * 抽离自（特征测试锁现行为，为 P-03/Q-01 资金路径重构提供安全网）：
 *   - calcLineCents          ← sales.module checkout 行计价（V4.13.1/RV-01 按分计算）
 *   - fifoAllocate           ← sales.module checkout FIFO 批次分配（含软模式负批次挂起）
 *   - apportionOrderDiscount ← promotions.module 整单级优惠按行小比分摊（尾差进最后一行）
 */

/** 金额元 → 整数分（同 sales.module toCents） */
const toCents = (yuan: number | string): number => Math.round(Number(yuan) * 100);
/** 金额四舍五入到分（同 common/db r2） */
const r2 = (n: number) => Math.round(n * 100) / 100;
/** 数量四舍五入到 3 位（称重 0.001kg，同 common/db r3） */
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/* ═══════════════ 行计价（按分） ═══════════════ */

export interface CalcLineInput {
  /** 本行成交单价（元）——改价/会员价/等级折扣后价 */
  unitPrice: number;
  /** 本行基础数量（称重行可为小数） */
  baseQty: number;
  /** 包装定价行金额覆盖（一品多包装），无覆盖传 null */
  lineAmountOverride: number | null;
  /** 本行是否手工改价（改价行不吃等级折扣差额） */
  priceChanged: boolean;
  /** 等级折扣是否启用（收银上下文：levelDiscountOn && levelCtx 存在） */
  levelDiscountOn: boolean;
  /** 等级折扣上下文（null = 无） */
  levelCtx: { discount: number } | null;
  /** 基线价（改价前原价，等级折扣差额 = (basePrice − unitPrice)×数量） */
  basePrice: number;
}

/**
 * 行金额/行优惠按分计算（原 checkout 内联逻辑，逐字保留）：
 *   lineCents = 覆盖金额 ? toCents(覆盖) : round(toCents(单价) × 数量)
 *   折扣差额 = 仅「未覆盖金额 且 等级折扣启用且 <1 且 未改价」时：round(数量 × toCents(基线价−成交价))
 */
export function calcLineCents(inp: CalcLineInput): { lineCents: number; lineDiscountCents: number } {
  const lineCents = inp.lineAmountOverride !== null
    ? toCents(inp.lineAmountOverride)
    : Math.round(toCents(inp.unitPrice) * inp.baseQty);
  const lineDiscountCents = inp.lineAmountOverride === null && inp.levelDiscountOn
    && inp.levelCtx && inp.levelCtx.discount < 1 && !inp.priceChanged
    ? Math.round(inp.baseQty * toCents(inp.basePrice - inp.unitPrice))
    : 0;
  return { lineCents, lineDiscountCents };
}

/* ═══════════════ FIFO 批次分配 ═══════════════ */

export interface BatchRow { id: number; remain_qty: number; inbound_cost: number }
export interface BatchAlloc { batchId: number; qty: number; cost: number }
export interface FifoResult {
  allocs: BatchAlloc[];
  /** 成本累计（元，未舍入——调用方按分 Math.round(x*100)） */
  cost: number;
  /** 软模式负批次挂起（调用方负责 audit 与落账）；无短缺为 null */
  shortage: { qty: number; basis: string } | null;
}

/**
 * FIFO 批次分配（按 expiry_date, inbound_date, id 排序后的批次行，调用方负责排序与 FOR UPDATE）：
 *   逐批 take = min(remain, need)，数量 r3，成本按 take×inbound_cost 累计；
 *   吃完仍有差额且 allowNeg（软模式）：末位批次挂正数差额（下游扣为负），basis=batch:<id>，
 *   无任何批次时 basis='none'（成本按 0，调用方进挂起成本队列）。
 */
export function fifoAllocate(batches: BatchRow[], need: number, allowNeg: boolean): FifoResult {
  const allocs: BatchAlloc[] = [];
  let cost = 0;
  for (const b of batches) {
    if (need <= 0) break;
    const take = Math.min(Number(b.remain_qty), need);
    allocs.push({ batchId: b.id, qty: r3(take), cost: Number(b.inbound_cost) });
    cost += take * Number(b.inbound_cost);
    need = r3(need - take);
  }
  let shortage: { qty: number; basis: string } | null = null;
  if (need > 1e-9 && allowNeg) {
    const last = batches[batches.length - 1];
    let basis = 'none';
    if (last) {
      allocs.push({ batchId: last.id, qty: r3(need), cost: Number(last.inbound_cost) });
      cost += need * Number(last.inbound_cost);
      basis = `batch:${last.id}`;
    }
    shortage = { qty: r3(need), basis };
  }
  return { allocs, cost, shortage };
}

/* ═══════════════ 批次扣减聚合（P-03 批量化的纯前置） ═══════════════ */

/**
 * 同批次多条 alloc 聚合扣减量（保持首次出现顺序）。
 * 必要性：`UPDATE batches ... FROM unnest(...)` 对同一批次 id 只命中一次，
 * 原「逐条 UPDATE 顺序扣减」必须先合并为单条净扣减量（末态等价：售罄判定只看最终余量）。
 */
export function aggregateBatchDeductions(allocs: { batchId: number; qty: number }[]): { batchId: number; qty: number }[] {
  const m = new Map<number, number>();
  for (const a of allocs) m.set(Number(a.batchId), r3((m.get(Number(a.batchId)) ?? 0) + Number(a.qty)));
  return [...m.entries()].map(([batchId, qty]) => ({ batchId, qty: r3(qty) }));
}

/* ═══════════════ 整单折扣 / 抹零（应收链路尾段） ═══════════════ */

export interface DiscountRedLine {
  /** 红线价 = max(最低卖价线, 进价)；最低卖价线未设按「售价×floorRate」 */
  minP: number;
  /** 商品最低折扣（0=未设） */
  minD: number;
  costP: number;
  /** 商品显式设置的最低卖价（0=未设；调用方用它区分「低于进价/低于最低售价」文案） */
  priceSet: number;
  /** 折扣率低于最低折扣 */
  belowDisc: boolean;
  /** 折后单价低于红线价（−0.005 容差与原实现一致） */
  belowPrice: boolean;
}

/**
 * 整单折扣逐行双红线计算（checkout 内联逻辑逐字保留）：
 *   ① 折扣率 ≥ 商品 min_discount_rate；② 折后单价 ≥ max(min_price, 进价)。
 *   命中任一 → 调用方决定「店长放行并留痕」还是拒绝。
 */
export function orderDiscountRedLine(
  p: { min_price?: any; minPrice?: any; sell_price?: any; cost_price?: any; min_discount_rate?: any },
  unitPrice: number,
  rate: number,
  floorRate: number,
): DiscountRedLine {
  const priceSet = Number(p?.min_price ?? p?.minPrice ?? 0) || 0;
  const sellP = Number(p?.sell_price) || 0;
  const costP = Number(p?.cost_price) || 0;
  const minP = Math.max(priceSet > 0 ? priceSet : Math.round(sellP * floorRate * 100) / 100, costP);
  const minD = Number(p?.min_discount_rate) || 0;
  const belowDisc = minD > 0 && rate < minD;
  const belowPrice = minP > 0 && unitPrice * (rate / 100) < minP - 0.005;
  return { minP, minD, costP, priceSet, belowDisc, belowPrice };
}

/**
 * 整单折扣额按分封顶：min(折扣金额, 应收−1分) —— 应收永远保留至少 1 分，杜绝 0 元/负数单。
 * 折扣超过应收时返回负值 → 调用方 `if (orderDiscountCents > 0)` 自然跳过（与原实现一致）。
 */
export function calcOrderDiscountCents(discountYuan: number | string, payableCents: number): number {
  return Math.min(toCents(discountYuan), payableCents - 1);
}

/**
 * 自动抹零（pos.round_rule：分/角/5角/元，向下去零）：
 *   未知规则视为「分」（不抹）；仅在 payable > 0 且粒度 >1 分时生效。整数取余，零浮点尾差。
 */
export function applyRoundRule(payableCents: number, rule: string): { roundCents: number; payableCents: number } {
  const roundUnitC: Record<string, number> = { '分': 1, '角': 10, '5角': 50, '元': 100 };
  const ruc = roundUnitC[rule];
  let roundCents = 0;
  if (ruc && ruc > 1 && payableCents > 0) {
    roundCents = payableCents % ruc;
    payableCents -= roundCents;
  }
  return { roundCents, payableCents };
}

/* ═══════════════ 整单优惠分摊 ═══════════════ */

/**
 * 整单级优惠按行小比分摊（promotions.module applyPromotions 内联逻辑，逐字保留）：
 *   逐行 alloc = r2(off × 行金额 / base)，尾差进最后一行有余额的行；alloc 不得超过行金额。
 *   【会改写入参】行上写 promoAlloc，行金额扣减 alloc（与原行为一致，调用方依赖此副作用）。
 *   off/base 为 0/负、或全部行金额 ≤0 时按原逻辑自然退化（alloc=0 或尾差负值原样写入）。
 */
export function apportionOrderDiscount(
  lines: { lineAmount: number; promoAlloc?: number }[],
  off: number,
  base: number,
): void {
  let allocated = 0;
  let lastIdx = -1;
  lines.forEach((ln, i) => { if (ln.lineAmount > 0) lastIdx = i; });
  lines.forEach((ln, i) => {
    let alloc: number;
    if (i === lastIdx) {
      alloc = r2(off - allocated);
    } else {
      alloc = r2(off * ln.lineAmount / base);
      allocated = r2(allocated + alloc);
    }
    if (alloc > ln.lineAmount) alloc = ln.lineAmount;
    ln.promoAlloc = alloc;
    ln.lineAmount = r2(ln.lineAmount - alloc);
  });
}
