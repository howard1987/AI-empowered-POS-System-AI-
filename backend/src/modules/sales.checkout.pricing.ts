/**
 * 结账定价域（Q-01 第一切片：checkout 按聚合拆服务 · 行为不变）
 *
 * 从 sales.module checkout 原样搬移「逐行计价 + FIFO 批次分配」段：
 *   开放键临时行（V4.18.1）/ 门店覆盖价（V4.26.5）/ 单位换算（V4.4.3）/ 手输商品（V4.6.3）/
 *   手工赠品 / 单品折扣双红线（V4.25.3-4）/ 手工改价红线 / 包装定价 / 会员价 / 等级折扣 /
 *   行金额按分（RV-01）/ FIFO 软硬库存模式（D4/决策④）。
 *
 * 依赖以 ctx 注入；金额口径、错误码、审计、权限判定与搬移前逐字一致。
 * 安全网：backend/tests/unit 41 单测 + tools/e2e-p03-checkout.mjs 28 项真实结账断言。
 */
import { BizException } from '../common/http';
import { audit, cx, r2, r3 } from '../common/db';
import type { AuthUser } from '../common/auth';
import type { SettingsService } from './settings.module';
import { COST_REF } from '../common/sql';
import { storePrice } from './store-price.service';
import { calcLineCents, fifoAllocate } from './sales.pure';

/** 元→整数分（与 sales.module toCents 同义；本地定义避免与宿主模块成环） */
const toCents = (yuan: number | string): number => Math.round(Number(yuan) * 100);

export interface PricingCtx {
  /** 结账事务客户端 */
  c: any;
  user: AuthUser;
  dto: any;
  settings: SettingsService;
  /** 会员等级折扣开关（member.level_discount） */
  levelDiscountOn: boolean;
  levelCtx: { discount: number; pointRate: number; levelId: number | null } | null;
  /** 最低售价兜底比率（sales.floor_guard_rate，已钳制） */
  floorRate: number;
}

export interface PricingResult {
  lines: any[];
  goodsCents: number;
  costCents: number;
  levelDiscCents: number;
}

/** 逐行计价 + FIFO 批次分配（写库在后；行为与拆分前完全一致） */
export async function computeCheckoutLines(ctx: PricingCtx): Promise<PricingResult> {
  const { c, dto, settings, levelDiscountOn, levelCtx, floorRate } = ctx;
  const user = ctx.user;
  let goodsCents = 0, costCents = 0, levelDiscCents = 0; // RV-01 按分计算：累计一律整数分
  const lines: any[] = [];
  // V5.0.0 批次4B（M4-16）：连锁门店（非总部仓）禁用负库存软模式 —— 服务端非负库存拦截。
  // 懒计算 + 单次缓存（chainEnabled 60s 缓存；isHqStore 每单一次）；单店部署恒 false 零回归
  let branchNegLock: boolean | null = null;
  const isBranch = async (): Promise<boolean> => {
    if (branchNegLock === null) {
      try {
        const { chainEnabled, isHqStore } = await import('../common/scope');
        branchNegLock = (await chainEnabled()) && !(await isHqStore(user.storeId));
      } catch { branchNegLock = false; }
    }
    return branchNegLock;
  };
  for (const it of dto.items) {
    // ── V4.18.1 P15 开放键临时行：无码杂货手输 品名+价格+备注，不建档案不碰库存 ──
    // product_id NOT NULL 口径 → 落占位商品（barcode='OPENKEY'，track_inventory=false，成本 0），
    // 真实品名记 sale_items.custom_name，既有报表/退货/对账 JOIN 零破坏
    if ((it as any).customEntry) {
      const cname = String((it as any).name || '').trim();
      if (!cname) throw new BizException(40003, '开放键行必须提供品名');
      if (!(Number(it.unitPrice) > 0)) throw new BizException(40003, '开放键行单价必须大于 0');
      if (!(Number(it.qty) > 0)) throw new BizException(40003, '开放键行数量必须大于 0');
      const pps = await cx(c,
        `SELECT * FROM products WHERE store_id=$1 AND barcode='OPENKEY' AND deleted_at IS NULL ORDER BY id LIMIT 1`, [user.storeId]);
      const op = pps[0] ?? (await cx(c,
        `INSERT INTO products (store_id, goods_no, name, barcode, sell_price, base_unit, track_inventory, status, min_price)
         VALUES ($1, 'OPENKEY-' || $1, '开放键临时行', 'OPENKEY', 0, '件', false, 1, 0) RETURNING *`, [user.storeId]))[0];
      const oQty = r3(Number(it.qty));
      const oPrice = r2(Number(it.unitPrice));
      const oCents = Math.round(toCents(oPrice) * oQty);
      goodsCents += oCents;
      lines.push({ customName: cname, p: op, unitName: '件', baseQty: oQty, unitPrice: oPrice, originPrice: oPrice,
                   lineAmount: oCents / 100, lineCost: 0, allocs: [], priceChanged: true,
                   lineRemark: it.lineRemark ?? null, manualBarcode: null, shortage: null });
      continue;
    }
    // V4.25.4 + V5.0.0：随行取「标准进价 L1」——进价是改价/折扣的最终兜底红线（无最低卖价时也不得低于进价销售）
    //   R8：L1（products.standard_cost）优先，为空回落旧口径（供应商最新报价）→ 存量商品零回归
    const ps = await cx(c,
      `SELECT p.*, ${COST_REF('p')} AS cost_price
         FROM products p WHERE p.id=$1 AND p.deleted_at IS NULL`, [it.productId]);
    const p = ps[0];
    if (!p) throw new BizException(40404, `商品#${it.productId} 不存在`, 404);
    // V4.26.5 按门店隔离价格：结算前用门店覆盖价改写 p.sell_price / p.member_price，
    //   下游全部逻辑（原价/会员价/折扣红线/进价兜底）自动同口径；未设门店价的门店完全不受影响。
    // L-15：事务内取价走同连接（cx），不再全局 q() 抢第二连接
    await storePrice.overlayOne(user.storeId, p, c);
    if (p.status !== 1) throw new BizException(50020, `${p.name} 已停售`);

    // 单位换算（V4.4.3 多单位）
    let rate = 1;
    let unitName: string = it.unitName || p.base_unit;
    let packPrice: number | null = null; // 一品多包装：该单位的单位售价（如箱价55）
    if (it.unitName && it.unitName !== p.base_unit) {
      const us = await cx(c, `SELECT * FROM product_units WHERE product_id=$1 AND unit_name=$2`, [p.id, it.unitName]);
      if (!us.length) throw new BizException(50022, `${p.name} 不存在单位「${it.unitName}」`);
      rate = Number(us[0].rate);
      packPrice = us[0].price === null || us[0].price === undefined ? null : Number(us[0].price);
    }
    const baseQty = r3(Number(it.qty) * rate);
    if (!(baseQty > 0)) throw new BizException(40003, `${p.name} 数量必须大于 0`);

    // 应急手输商品（V4.6.3：价目表未命中仅店长授权手输；条码记入行备注留痕，恢复后补录）
    if (it.manualEntry) {
      if (!dto.isEmergency) throw new BizException(50037, '手输商品仅限应急收银模式');
      if (!user.perms.includes('pos.emergency.manual')) {
        throw new BizException(42003, '无应急手输权限（pos.emergency.manual，仅店长）', 403);
      }
      if (!it.manualBarcode) throw new BizException(40003, '手输商品必须提供条码（manualBarcode）');
    }
    // 计价（服务端权威价）：手工改价 > 包装单位售价 > 商品会员价 > 等级折扣（开关） > 零售价
    let priceChanged = false;
    let unitPrice: number;
    let originPrice: number;
    let basePrice: number;
    let lineAmountOverride: number | null = null; // 包装定价时行金额按包装价精确（避免换算摊分尾差）
    // ── V4.18.1 P15 赠品行：0 元出库，库存照扣/成本照记；需 pos.price.manual 权限 + 留痕（§13 A3 手工赠）──
    //  V4.28.9 促销赠品行（promoGift）：由「消费后奖励-送赠品」活动自动添加，0 元同一出库通道；
    //  免店长授权（活动配置即授权），但结算时强校验活动有效性 + 门槛达标（防伪造免授权白拿，见 1.7 区）。
    const isPromoGift = !!(it as any).promoGift;
    const isGift = !!(it as any).gift || isPromoGift;
    if ((it as any).gift && !isPromoGift) {
      if (!user.perms.includes('pos.price.manual')) {
        throw new BizException(42003, '手工赠品行需改价权限（pos.price.manual）', 403);
      }
      await audit(user.storeId, user.sub, '收银', '手工赠品', 'product', Number(p.id),
        { name: p.name, qty: baseQty, reason: it.lineRemark ?? '' });
    }
    if (isGift) {
      originPrice = Number(p.sell_price); basePrice = originPrice; unitPrice = 0; priceChanged = true;
    } else if ((it as any).discRate !== undefined && (it as any).discRate !== null && Number((it as any).discRate) > 0) {
      // ── V4.25.3 单品折扣（行级）：按折扣率打折，双红线校验 ──
      //    ① 折扣率 ≥ 商品最低折扣 min_discount_rate；② 折后单价 ≥ 商品最低卖价 min_price
      //      （未设 min_price 时按「售价 × sales.floor_guard_rate」兜底，V5.0.15 起可配置，默认 8 折）
      //    任一越线：店长（pos.emergency.manual）可放行并留痕；否则拒绝
      if (!user.perms.includes('pos.price.manual')) {
        throw new BizException(42002, '单品折扣需改价权限（pos.price.manual）', 403);
      }
      const dRate = Number((it as any).discRate);
      if (!(dRate > 0 && dRate < 100)) throw new BizException(40003, '单品折扣折数必须在 0~100 之间（如 88=88折）');
      if (dRate < 1) throw new BizException(40003, `折数须为百分数（如 95=95折），收到 ${dRate} 将按 ${dRate}%成交，已拒绝`);
      originPrice = Number(p.sell_price);
      basePrice = originPrice;
      unitPrice = r2(basePrice * dRate / 100);
      // VQA-2（DEF-15 / Q5 裁决）：会员价生效时单品折扣取「折后价 vs 会员价」更优单享，禁止折上折、禁止折扣旁路会员价
      if (dto.memberId != null && (p as any).member_discount !== null && (p as any).member_discount !== undefined && Number((p as any).member_discount) > 0) {
        const mc = (p as any).member_price !== null && (p as any).member_price !== undefined && (p as any).member_price !== ''
          ? Number((p as any).member_price) : r2(Number(p.sell_price) * Number((p as any).member_discount));
        if (Number.isFinite(mc) && mc > 0 && mc < unitPrice) unitPrice = r2(mc);
      }
      priceChanged = true;
      const minDiscRate = Number((p as any).min_discount_rate) || 0;
      const minSalePrice = p.min_price !== null && p.min_price !== undefined && p.min_price !== ''
        ? Number(p.min_price) : r2(Number(p.sell_price) * floorRate);
      // V4.25.4 进价兜底：折后价不得低于进价（未设最低卖价时进价即最终红线）
      const costP = Number((p as any).cost_price) || 0;
      const floorP = Math.max(minSalePrice, costP);
      const belowDisc = minDiscRate > 0 && dRate < minDiscRate;
      const belowPrice = floorP > 0 && unitPrice < floorP;
      if (belowDisc || belowPrice) {
        if (!user.perms.includes('pos.emergency.manual')) {
          throw new BizException(40003, belowDisc
            ? `${p.name} 折扣 ${dRate} 折低于最低折扣 ${minDiscRate} 折（需店长放行）`
            : (costP > minSalePrice
              ? `${p.name} 折后单价 ¥${unitPrice} 低于进价 ¥${costP}（不得低于进价销售；需店长放行）`
              : `${p.name} 折后单价 ¥${unitPrice} 低于最低售价 ¥${minSalePrice}（需店长放行）`));
        }
        await audit(user.storeId, user.sub, '收银', '低于最低折扣/售价放行', 'product', Number(p.id),
          { name: p.name, discRate: dRate, unitPrice, minSalePrice, minDiscRate, costPrice: costP, floor: floorP });
      }
    } else if (it.unitPrice !== undefined && it.unitPrice !== null) {
      // 应急手输走 pos.emergency.manual（店长授权），普通改价走 pos.price.manual
      if (it.manualEntry) {
        if (!(Number(it.unitPrice) > 0)) throw new BizException(40003, '手输商品单价必须大于 0');
      } else if (!user.perms.includes('pos.price.manual')) {
        throw new BizException(42002, '无手工改价权限（pos.price.manual）', 403);
      }
      originPrice = Number(p.sell_price);
      unitPrice = Number(it.unitPrice);
      basePrice = Number(p.sell_price);
      priceChanged = true;
      // ── V4.18.0 P14 最低售价硬拦 + V4.25.4 进价兜底：改价不得低于 max(最低卖价线, 最新进价) ──
      //    最低卖价线 = 商品 min_price，未设时按「售价 × sales.floor_guard_rate」（V5.0.15 起可配置，默认 8 折）；
      //    进价取最新供应商进价（取不到按 0 = 不启用）
      const minP = p.min_price !== null && p.min_price !== undefined && p.min_price !== ''
        ? Number(p.min_price) : r2(Number(p.sell_price) * floorRate);
      const costP = Number((p as any).cost_price) || 0;
      const floorP = Math.max(minP, costP);
      if (floorP > 0 && unitPrice < floorP) {
        if (!user.perms.includes('pos.emergency.manual')) {
          throw new BizException(50033, costP > minP
            ? `${p.name} 改价 ¥${unitPrice} 低于进价 ¥${costP}（不得低于进价销售；需店长放行）`
            : `${p.name} 改价 ¥${unitPrice} 低于最低售价 ¥${minP}（需店长放行）`);
        }
        await audit(user.storeId, user.sub, '收银', '低于最低售价/进价放行', 'product', Number(p.id),
          { name: p.name, unitPrice, minPrice: minP, costPrice: costP, floor: floorP });
      }
    } else if (packPrice !== null && packPrice > 0) {
      // 包装定价（一品多包装：如箱价55，行金额精确=包装价×件数）
      basePrice = r2(Number(p.sell_price) * rate);
      originPrice = basePrice;
      unitPrice = r2(packPrice / rate); // 记录用摊分单价（仅入库展示）
      lineAmountOverride = r2(packPrice * Number(it.qty));
    } else if (dto.memberId && p.member_discount !== null && p.member_discount !== undefined && Number(p.member_discount) > 0) {
      // 会员价门控（V4.9.3）：会员折扣=是（>0）才参与会员价；未设会员价时按 售价×折扣 兜底
      originPrice = Number(p.sell_price); basePrice = Number(p.sell_price);
      unitPrice = p.member_price !== null && p.member_price !== undefined
        ? Number(p.member_price) : r2(Number(p.sell_price) * Number(p.member_discount));
    } else {
      basePrice = Number(p.sell_price);
      unitPrice = basePrice; originPrice = basePrice;
      if (levelDiscountOn && levelCtx && levelCtx.discount < 1) {
        unitPrice = r2(basePrice * levelCtx.discount); // 等级折扣（9.8折等，5.1.12）
      }
    }
    // RV-01 按分计算：单价先取整分，×数量后取整——行金额无浮点尾差；落库前回除为元
    // Q-02：抽至 sales.pure.calcLineCents（零依赖纯函数 + 表驱动单测锁行为）
    const { lineCents, lineDiscountCents } = calcLineCents({
      unitPrice, baseQty, lineAmountOverride, priceChanged, levelDiscountOn, levelCtx, basePrice,
    });
    levelDiscCents += lineDiscountCents;
    const lineAmount = lineCents / 100;
    const lineDiscount = lineDiscountCents / 100;
    void lineDiscount;   // 保留原变量（历史口径；行级折扣差额由 levelDiscCents 汇总）

    // FIFO 批次分配：FOR UPDATE 行锁 = 服务端唯一权威（前端库存/金额拦截仅体验层，一切以本事务落账为准·决策④）
    // 硬拦（默认）：库存不足 50001 直接拒绝；软模式（stock.negative_sales=开）：差额挂末位批次记负 + 进挂起成本队列，不硬拦
    const allocs: { batchId: number; qty: number; cost: number }[] = [];
    let lineCost = 0;
    let shortageHold: { qty: number; basis: string } | null = null;
    let allowNeg = false; // 本行是否允许负库存售卖（软模式），落账时决定库存扣减是否硬兜底
    if (p.track_inventory) {
      // D4 更深修复①：库存权威口径统一为 inventory_current（与落账同一本账），同事务 FOR UPDATE 锁行；
      //   原超卖闸读 batches.remain_qty、落账写 inventory_current 为两本独立账，漂移时闸门放行而台账扣穿 → 负库存。
      const inv = await cx(c,
        `SELECT qty_total FROM inventory_current WHERE store_id=$1 AND product_id=$2 FOR UPDATE`,
        [user.storeId, p.id]);
      const totalAvail = inv.length ? Number(inv[0].qty_total) : 0;
      // ⚠️ 已拍板（2026-10-09，方案 A）：维持「全连锁统一开关」语义——stock.negative_sales scope='hq'
      // 由总部统一下发、门店不可改（40304），分支店无独立差异。原 isBranch() 死代码（分支永远硬模式
      // 的更强约束）不再激活；连锁需要分支差异时再改 !(await isBranch())。
      allowNeg = totalAvail < baseQty && !branchNegLock
        && (await settings.getBool('stock.negative_sales', false));
      if (totalAvail < baseQty && !allowNeg) {
        throw new BizException(50001, `${p.name} 库存不足（现有 ${totalAvail}，需 ${baseQty}）`);
      }
      // FIFO 批次分配：仍从 batches 取物理批次与成本（批次为不可变血缘源）；
      //   与台账短暂漂移时，落账以 inventory_current 原子扣减（见 write 阶段）为准，不会扣穿为负。
      const batches = await cx(c,
        `SELECT id, remain_qty, inbound_cost FROM batches
          WHERE store_id=$1 AND product_id=$2 AND status='在库' AND remain_qty > 0
          ORDER BY expiry_date, inbound_date, id
          FOR UPDATE`, [user.storeId, p.id]);
      // Q-02：FIFO 分配抽至 sales.pure.fifoAllocate（纯函数 + 单测锁行为）。
      // 决策④：软模式差额由末位批次挂起（basis=batch:<id>；无批次 basis='none'），
      //   差额进 pending_cost_adjusts 挂起队列；审计留在事务内。
      const fifo = fifoAllocate(batches as any[], baseQty, allowNeg);
      allocs.push(...fifo.allocs);
      lineCost += fifo.cost;
      if (fifo.shortage) {
        shortageHold = fifo.shortage;
        await audit(user.storeId, user.sub, '收银', '负库存售卖', 'product', Number(p.id),
          { name: p.name, stock: totalAvail, sold: baseQty, shortage: fifo.shortage.qty, costBasis: fifo.shortage.basis });
      }
    } else {
      // 不记库存商品：成本取最近一次进价
      const last = await cx(c,
        `SELECT unit_cost FROM inbound_order_items WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [p.id]);
      const cost = last.length ? Number(last[0].unit_cost) : 0;
      lineCost = baseQty * cost;
    }
    const lineCostCents = Math.round(lineCost * 100); // RV-01 成本按分累计
    lineCost = lineCostCents / 100;
    goodsCents += lineCents;
    costCents += lineCostCents;
    const finalRemark = it.manualEntry
      ? `手输:${it.manualBarcode}${it.lineRemark ? ' ' + it.lineRemark : ''}`
      : (isPromoGift ? `赠品(促销)${it.lineRemark ? ':' + it.lineRemark : ''}` : (isGift ? `赠品${it.lineRemark ? ':' + it.lineRemark : ''}` : (it.lineRemark ?? null)));
    lines.push({ p, unitName, baseQty, unitPrice, originPrice, lineAmount, lineCost, allocs, priceChanged, lineRemark: finalRemark,
                 promoGift: isPromoGift, promoGiftId: isPromoGift ? Number((it as any).promoGiftId) || null : null,
                 manualBarcode: it.manualEntry ? (it.manualBarcode ?? null) : null, shortage: shortageHold, allowNeg });
  }
  return { lines, goodsCents, costCents, levelDiscCents };
}
