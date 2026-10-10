import { Module, Controller, Post, Get, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, r2, r3, audit, seqLock } from '../common/db';
import { consumeBatchesMany } from './sales.fifo';
import { orderDiscountRedLine, calcOrderDiscountCents, applyRoundRule } from './sales.pure';   // Q-02：折扣/抹零纯函数（单测锁行为）
import { computeCheckoutLines } from './sales.checkout.pricing';   // Q-01：定价域服务（单测+结账E2E 兜底）
import { processCheckoutPayments } from './sales.checkout.payments';   // Q-01：支付域服务（单测+结账E2E 兜底）
import { persistCheckoutOrder } from './sales.checkout.persist';   // Q-01：落单域服务（单测+结账E2E 兜底）
import { finalizeCheckoutAssets } from './sales.checkout.assets';   // Q-01：资产域服务（单测+结账E2E 兜底）
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms, JWT_SECRET } from '../common/auth';
import * as jwt from 'jsonwebtoken';
import { SettingsService } from './settings.module';
import { syncMemberLevel } from './members.module';
import { memberGrowth } from './member-growth.service';   // V5.0.17：消费成长值
import { applyPromotions, grantPostCheckoutRewards } from './promotions.module';
import { applyCoupons, couponStockAfter, logCoupon } from './coupons.module';   // V5.0 多选核销 + 核销出库流水
import { enqueueSync, nodeIdentity } from '../common/outbox';  // V5.0.0 批次4A：同事务上行入队（hq/单店 no-op）
import { SyncStoreService } from './sync-store.service'; // V5.0.0：结算后事件触发立即推送
import { isChainStoreNode, hqMemberPost, offlineBalanceCredit, HQ_UNREACHABLE_CODE } from './member-chain.module'; // V5.0.0 批次5+P2-1：会员资产权威账本在总部；断网挂账
import { curStore, curScope } from '../common/context';   // V4.28.0：销售列表/明细按数据范围收敛（审计 F-04）

/** L-04：结账事务内已成功的总部扣款记录（本地事务回滚时用于补偿撤销，防「HQ 已扣、本地无单」资损） */
export interface HqDebitRec {
  asset: 'balance' | 'dividend' | 'points';
  cardNo: string;
  orderNo: string;
  storeId: number;
  operatorId: number | string;
  amount?: number;   // balance / dividend（元）
  points?: number;   // points 抵扣
}

/**
 * L-04 两阶段补偿：本地事务回滚（本地无单）后，撤销已成功的总部扣款。
 * 余额/分红 → 总部 /hq/member/credit（原路退，按 orderNo 幂等）；积分 → /hq/member/points 负向冲回。
 * 补偿失败（总部仍不可达等）仅留审计转人工对账，绝不静默吞掉资损。
 */
async function reverseHqDebits(debits: HqDebitRec[]): Promise<void> {
  for (const d of debits) {
    try {
      if (d.asset === 'points') {
        await hqMemberPost('points', { cardNo: d.cardNo, orderNo: d.orderNo, points: -(d.points ?? 0) });
      } else {
        await hqMemberPost('credit', { cardNo: d.cardNo, orderNo: d.orderNo, asset: d.asset, amount: d.amount });
      }
    } catch (err: any) {
      await audit(d.storeId, d.operatorId as any, '收银', 'hq_debit_compensation_failed', 'sales_order', null,
        { asset: d.asset, orderNo: d.orderNo, error: String(err?.message ?? err).slice(0, 300) }).catch(() => {});
    }
  }
}

interface CheckoutItem { productId: number; qty: number; unitName?: string; unitPrice?: number;
  lineRemark?: string; manualEntry?: boolean; manualBarcode?: string;
  customEntry?: boolean; gift?: boolean; name?: string; discRate?: number;
  promoGift?: boolean; promoGiftId?: number; }   // V4.18.1 P15：开放键临时行 / 赠品行；V4.25.3 单品折扣 discRate；V4.28.9 促销自动赠品行（免授权，结算强校验活动）
interface CheckoutDto {
  items: CheckoutItem[];
  memberId?: number;
  payments: { channel: string; amount: number; auto?: boolean; externalNo?: string;
    gatewayOutTradeNo?: string }[]; // gatewayOutTradeNo：V4.13.2 通道适配层我方单号（扫码支付必须能对上通道成功应答）
  isEmergency?: boolean;
  channel?: string;
  remark?: string;
  couponId?: number; // member_coupons.id（5.9 券核销，兼容旧单券）
  couponIds?: number[]; // V5.0 一单多券核销（收银员多选）
  shiftId?: number;  // 交接班：班次归属（shifts 表，5.2.5）
  selfCheckout?: boolean; // 顾客扫码购（6.4.2）：无收银员归属、余额自动付清、不出改价/应急
  deliveryFee?: number;   // 线上配送费（方向4 在线商城：服务端定价后并入应收）
  clientRef?: string;     // 客户端幂等单号（PWA 离线队列生成，同 ref 重发返回原单）
  manualRound?: number;   // V4.18.0 P14 手动抹零（元）：需 pos.price.manual 权限，服务端留痕
  orderDiscount?: number;     // V4.18.3 P15 批2 整单折扣金额（元）：预设规则免权限，自定义需 pos.discount.custom + 留痕
  discountRate?: number;      // 折数（95=95折）：服务端比对预设规则判定是否免权限 + 逐行最低售价校验
  discountReason?: string;    // 折扣原因（如：员工折扣/会员日/审批人），必须填写
  tableId?: number;           // V4.21.0 P16 批2 台位档案：堂食落单挂台位（自动转「使用中」）
  priceAuthTicket?: string;   // V4.25.5 店长授权票据（改价/折扣/赠品的现场授权，POST /auth/authorize 换取，120 秒有效）
  creditAmount?: number;      // 会员挂账金额（元）：当场不支付、转 member_credits 账期欠款；需 pos.credit.enabled 开 + 指定会员，Σ(支付+挂账)=应收
  guestPhone?: string;        // V5.0.15 挂单/外卖顾客联系电话
}

/** 金额元 → 整数分（V4.13.1 支付边界统一：杜绝浮点 0.1+0.2 类错账；对外口径仍为元） */
export const toCents = (yuan: number | string): number => Math.round(Number(yuan) * 100);

/**
 * 收银结账核心（方案 5.2 FIFO / 7 收银 / 8.5.1 应急收银）：
 *   1) 服务端计价（手工改价需 pos.price.manual 权限并留痕；等级折扣开关 member.level_discount，会员价优先）
 *   2) FIFO 扣批次（事务 + FOR UPDATE 行锁防并发超卖），sale_item_batches 可追溯每件成本
 *   3) 多支付组合（余额/分红/积分抵扣联动资产流水）
 *      - 余额支付按口径B 拆分本金/赠送（5.1.2，按比例）
 *      - 分红抵扣/积分抵扣部分不计入有效消费（5.1.16 漏洞封堵）
 *   4) 有效消费窗口：本金+现金部分 ≥ 单笔门槛才入账（V4.3.2 双门槛）
 *   5) 会员权益：积分 = 应付 × 等级倍率；结账后同步会员等级（5.1.12）
 */
export class SalesService {
  private settings = new SettingsService();

  async checkout(user: AuthUser, dto: CheckoutDto) {
    if (!Array.isArray(dto.items) || !dto.items.length) throw new BizException(40003, '销售明细不能为空');
    if (!Array.isArray(dto.payments ?? [])) throw new BizException(40003, '支付方式格式错误');

    // ── V4.25.5 店长现场授权：凡涉及「改价 / 单品折扣 / 赠品 / 整单折扣」，必须携带有效授权票据 ──
    //   票据由 POST /auth/authorize（店长工号 + 授权码）签发，120 秒有效、scope=price；
    //   作用仅为「授权本次价格操作」，不切换登录身份；无票据直接拒绝（50035）。
    const needsPriceAuth = (dto.items as any[]).some(it => it && !(it.custom || it.customEntry)
      && (it.unitPrice !== undefined || it.discRate !== undefined || it.gift))
      || (Number(dto.orderDiscount) > 0);
    let priceAuthorizer: { id: number; empNo: string; name: string } | null = null;
    let ticketJti: string | null = null;   // S-08：票据一次性消费标记（签发端已带 jti）
    if (needsPriceAuth) {
      const tk = String((dto as any).priceAuthTicket || '');
      if (!tk) throw new BizException(50035, '改价/折扣需店长现场授权：请在弹出框输入店长工号与授权码');
      try {
        const pl: any = jwt.verify(tk, JWT_SECRET);
        if (pl?.scope !== 'price' || !pl?.sub) throw new Error('bad scope');
        priceAuthorizer = { id: Number(pl.sub), empNo: String(pl.empNo || ''), name: String(pl.name || '') };
        ticketJti = pl.jti ? String(pl.jti) : null;
      } catch {
        throw new BizException(50036, '店长授权已过期或无效，请重新授权（授权有效期 120 秒）');
      }
    }
    // 授权留痕：记录「操作人 + 授权人 + 本次涉及的价格操作」（与授权事件 auth.price_authorize 互为对照）
    if (priceAuthorizer) {
      await audit(user.storeId, user.sub, '收银', '价格操作授权留痕', 'sales_order', null, {
        operator: `${user.empNo}(${user.name})`,
        authorizedBy: `${priceAuthorizer.empNo}(${priceAuthorizer.name})`,
        authorizedById: priceAuthorizer.id,
        lines: (dto.items as any[])
          .filter(it => it && (it.unitPrice !== undefined || it.discRate !== undefined || it.gift))
          .map(it => ({ productId: it.productId, unitPrice: it.unitPrice ?? null, discRate: it.discRate ?? null, gift: !!it.gift })),
        orderDiscount: dto.orderDiscount ?? null,
        discountRate: dto.discountRate ?? null,
      });
    }

    if (dto.isEmergency) {
      if (!user.perms.includes('pos.emergency')) throw new BizException(42001, '无应急收银权限（pos.emergency）', 403);
      const cap = await this.settings.getNum('ops.emergency_amount_cap', 500);
      // 金额上限在金额算出后校验
      var emergencyCap = cap;
    }

    const hqDebits: HqDebitRec[] = [];
    let out: any = null;
    try {
    out = await tx(async c => {
      // ── 0- 离线补传幂等（8.5.1）：同 clientRef 重发直接返回原单，不重复入账 ──
      //    数据库另有 ux_sales_client_ref 部分唯一索引兜底并发双击
      if (dto.clientRef) {
        const dup = await cx(c,
          `SELECT id, order_no, payable_amount FROM sales_orders WHERE client_ref=$1`, [dto.clientRef]);
        if (dup.length) {
          return { orderId: Number(dup[0].id), orderNo: dup[0].order_no,
                   payable: Number(dup[0].payable_amount), idempotent: true };
        }
      }

      // S-08：授权票据一次性消费——jti 抢占（随本事务提交/回滚），防 120s 窗口内重放二次改价
      if (ticketJti) {
        await cx(c, `DELETE FROM auth_ticket_used WHERE used_at < now() - interval '1 day'`);
        const usedIns = await cx(c,
          `INSERT INTO auth_ticket_used (jti) VALUES ($1) ON CONFLICT (jti) DO NOTHING RETURNING jti`, [ticketJti]);
        if (!usedIns.length) throw new BizException(50036, '该店长授权票据已被使用（票据一次性有效），请重新授权后再结算');
      }

      // ── 0- 扫码购无收银员归属（6.4.2 自助结算）：流水/审计的 employee_id 置空 ──
      const operatorId = dto.selfCheckout ? null : user.sub;

      // ── 0- 交接班归属校验（5.2.5：仅本人「进行中」班次可挂账 → 50066） ──
      let shiftId: number | null = null;
      if (dto.shiftId) {
        const shs = await cx(c, `SELECT id, status, cashier_id FROM shifts WHERE id=$1`, [dto.shiftId]);
        const sh = shs[0];
        if (!sh) throw new BizException(50066, '班次不存在', 404);
        if (sh.status !== '进行中') throw new BizException(50066, `班次已${sh.status}，不可挂账`);
        if (Number(sh.cashier_id) !== Number(user.sub)) throw new BizException(50066, '不能使用他人班次');
        shiftId = Number(sh.id);
      } else if (!dto.selfCheckout) {
        // 移动收银未传班次 → 自动挂接本人进行中班次（交接班对账不漏单）；无开班则留空留痕
        const my = await cx(c,
          `SELECT id FROM shifts WHERE store_id=$1 AND cashier_id=$2 AND status='进行中' ORDER BY id DESC LIMIT 1`,
          [user.storeId, user.sub]);
        if (my.length) shiftId = Number(my[0].id);
      }

      // ── 应急新鲜度硬闸（V4.6.3）：价目表超 72h 未更新禁止应急收银（50036） ──
      if (dto.isEmergency) {
        const snap = await cx(c,
          `SELECT generated_at FROM pricebook_snapshots WHERE store_id=$1 ORDER BY id DESC LIMIT 1`,
          [user.storeId]);
        const limitH = await this.settings.getNum('pos.pricebook_fresh_hours', 72);
        if (!snap.length) {
          throw new BizException(50036, '价目表从未下发，禁止应急收银（请先联网同步价目表）');
        }
        const ageH = (Date.now() - new Date(snap[0].generated_at).getTime()) / 3600000;
        if (ageH > limitH) {
          throw new BizException(50036, `价目表已 ${Math.floor(ageH)} 小时未更新（上限 ${limitH}），禁止应急收银`);
        }
      }
      // ── 0. 会员等级上下文（等级折扣开关 + 积分倍率，5.1.12/5.3） ──
      const levelDiscountOn = (await this.settings.getNum('member.level_discount', 0)) === 1;
      let levelCtx: { discount: number; pointRate: number; levelId: number | null } | null = null;
      if (dto.memberId) {
        const lv = await cx(c,
          `SELECT COALESCE(l.discount, 1)::float8 AS discount, COALESCE(l.point_rate, 1)::float8 AS point_rate, m.level_id
             FROM members m LEFT JOIN member_levels l ON l.id = m.level_id
            WHERE m.id=$1 AND m.deleted_at IS NULL`, [dto.memberId]);
        if (!lv.length) throw new BizException(40404, '会员不存在', 404);
        levelCtx = { discount: Number(lv[0].discount), pointRate: Number(lv[0].point_rate), levelId: lv[0].level_id };
      }

      // ── V5.0.15：最低售价兜底比率（商品未设 min_price 时的红线 = 售价 × 本比率）──
      //    原实现硬编码 0.6（6 折）。超市综合毛利普遍 ≤20%（成本约占售价 80%），
      //    6 折意味着每卖一件亏约 20% —— 红线形同虚设，改价/折扣几乎不受约束。
      //    现改为可配置 sales.floor_guard_rate（默认 0.8 = 最多打 8 折，保护 20% 毛利空间）；
      //    红线最终仍取 max(兜底价, 进价)，有成本数据时以不亏本为准。
      //    注意：设置项不存在时 getNum 返回 null，直接 Math.max(0.01, null) 会得到 0.01（红线≈形同虚设），
      //    故必须做有限性校验并回退到 0.8。
      const rawRate = Number(await this.settings.getNum('sales.floor_guard_rate', 0.8));
      const floorRate = Number.isFinite(rawRate) && rawRate > 0
        ? Math.min(1, Math.max(0.01, rawRate)) : 0.8;

      // ── 1. 逐行计价 + FIFO 批次分配 ──（Q-01：定价域拆至 sales.checkout.pricing.ts，行为逐字保留；
      //   原块内 isBranch 未被调用的死代码观察已随迁并在彼处标记，待拍板后再启用）
      const { lines, goodsCents, costCents, levelDiscCents } = await computeCheckoutLines({
        c, user, dto, settings: this.settings, levelDiscountOn, levelCtx, floorRate,
      });

      // ── 1.5 促销引擎（5.4 T12）：行级特价/第二件半价 → 整单级满减/满折，跨层叠加；
      //      整单优惠按行小比分摊到 sale_items（退货按行原路退）；会员价冲突取更优 ──
      const promo = await applyPromotions(c, user.storeId, lines, dto.memberId);   // V4.28.9e：会员专享活动按会员过滤
      // RV-01 按分计算：应收链路（促销→券→抹零→配送费）全程整数分，汇总回除为元供落库/审计
      const goodsAmount = goodsCents / 100;
      const costTotal = costCents / 100;
      const levelDiscountTotal = levelDiscCents / 100;
      let payableCents = goodsCents - toCents(promo.promoAmount);
      // ── 1.6 优惠券核销（5.9 V5.0 多选）：促销后计算，门槛按货值；逐张校验并累加 ──
      let couponAmount = 0;
      let couponIdsUsed: number[] = [];
      const cpIds = Array.isArray(dto.couponIds)
        ? dto.couponIds.map(Number).filter(x => x > 0) : [];
      if (dto.couponId && !cpIds.includes(Number(dto.couponId))) cpIds.push(Number(dto.couponId)); // 兼容旧字段
      // V5.0 叠加规则统一裁决：coupon.mode（single/auto/manual）+ 每券 stackable
      const cpRes = await applyCoupons(c, dto.memberId ?? 0, cpIds, goodsAmount, promo.promoAmount, lines);
      couponAmount = cpRes.amount;
      couponIdsUsed = cpRes.usedIds;
      payableCents -= toCents(couponAmount);
      const couponIdUsed = couponIdsUsed.length ? couponIdsUsed[0] : null;
      // ── 1.7c 整单折扣（V4.18.3 P15 批2 §13.1）
      //    V5.0.15 顺序修正：原实现是「先抹零 → 再整单折扣」，与注释及业务直觉相反 ——
      //    折扣应该作用在「未抹零的应收」上，抹零是最后一步的找零处理（先打折、再抹零）。
      //    例：应收 19.98，打 95 折 → 18.98，再抹角 → 18.90（而旧顺序会先抹成 19.90 再打折 → 18.90，
      //    在「元」等粗粒度规则下两者差异可达数元）。
      //    预设规则（settings pos.discount.presets）套用免权限；自定义折扣率需 pos.discount.custom + 留痕；
      //    逐行校验折后单价不得低于最低售价（min_price>0 时），防整单折扣绕过行级改价红线 ──
      //    预设规则（settings pos.discount.presets）套用免权限；自定义折扣率需 pos.discount.custom + 留痕；
      //    逐行校验折后单价不得低于最低售价（min_price>0 时），防整单折扣绕过行级改价红线 ──
      let orderDiscountCents = 0;
      if (dto.orderDiscount && dto.orderDiscount > 0) {
        const reason = String(dto.discountReason || '').trim();
        if (!reason) throw new BizException(40003, '整单折扣必须填写原因（留痕要求）');
        const rate = Number(dto.discountRate);
        if (!(rate > 0 && rate < 100)) throw new BizException(40003, '整单折扣折数必须在 0~100 之间（如 95=95折）');
        let presetOk = false;
        try {
          const raw = await this.settings.getVal('pos.discount.presets');
          const presets = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
          if (Array.isArray(presets) && presets.some((p: any) => Number(p?.rate) === rate)) presetOk = true;
        } catch { /* 预设解析失败按全自定义处理 */ }
        if (!presetOk && !(user.perms.includes('*') || user.perms.includes('pos.discount.custom'))) {
          throw new BizException(42003, `折扣 ${rate} 折非预设规则，自定义折扣需授权（pos.discount.custom）`, 403);
        }
        // V4.25.3 逐行双红线校验：① 整单折扣率 ≥ 商品最低折扣 min_discount_rate；② 折后单价 ≥ 最低卖价 min_price
        //  任一越线：店长（pos.emergency.manual）可放行并留痕；否则拒绝整单折扣
        const isBossDiscount = user.perms.includes('*') || user.perms.includes('pos.emergency.manual');
        for (const ln of lines) {
          const lnName = String((ln.p as any)?.name ?? '商品');
          // V4.25.4 进价兜底：红线价 = max(最低卖价线, 最新进价)；最低卖价线未设时按「售价 × floorRate」
          // Q-02：红线计算抽至 sales.pure.orderDiscountRedLine（纯函数+单测）；放行/拒绝与留痕留在事务内
          const rl = orderDiscountRedLine(ln.p as any, ln.unitPrice, rate, floorRate);
          const { minP, minD, costP, priceSet, belowDisc, belowPrice } = rl;
          if (belowDisc || belowPrice) {
            if (!isBossDiscount) {
              throw new BizException(40003, belowDisc
                ? `「${lnName}」最低折扣 ${minD} 折，整单折扣 ${rate} 折被拒绝（需店长放行）`
                : (costP > priceSet
                  ? `「${lnName}」折后单价 ${(ln.unitPrice * rate / 100).toFixed(2)} 低于进价 ${costP}，整单折扣被拒绝（不得低于进价销售）`
                  : `「${lnName}」折后单价 ${(ln.unitPrice * rate / 100).toFixed(2)} 低于最低售价 ${minP}，整单折扣被拒绝`));
            }
            await audit(user.storeId, user.sub, '收银', '整单折扣低于红线放行', 'sales_order', null,
              { product: lnName, rate, minDiscRate: minD, minPrice: minP, costPrice: costP });
          }
        }
        // Q-02：折扣封顶（应收保底 1 分）抽至 sales.pure.calcOrderDiscountCents
        orderDiscountCents = calcOrderDiscountCents(dto.orderDiscount, payableCents);
        if (orderDiscountCents > 0) {
          payableCents -= orderDiscountCents;
          await audit(user.storeId, user.sub, '收银', '整单折扣', 'sales_order', null,
            { rate, amount: orderDiscountCents / 100, reason, preset: presetOk });
        }
      }
      // ── 1.7 抹零（5.2 收银设置 pos.round_rule：分/角/5角/元，向下去零；抹掉金额记 round_amount ≥0）──
      // V5.0.15：移至整单折扣之后 —— 先打折，再对折后金额抹零
      // RV-01：单位直接用分，向下去零 = 对 ruc 取余，整数运算零尾差
      const roundRule = String((await this.settings.getVal('pos.round_rule')) ?? '分');
      // Q-02：自动抹零抽至 sales.pure.applyRoundRule（纯函数+单测；先打折后抹零，整数取余零尾差）
      const rr = applyRoundRule(payableCents, roundRule);
      let roundCents = rr.roundCents;
      payableCents = rr.payableCents;
      // ── 1.7b 手动抹零（V4.18.0 P14 抹零双轨）：收银员界面抹零至元/角，需 pos.price.manual 权限并留痕 ──
      let manualRoundCents = 0;
      if (dto.manualRound && dto.manualRound > 0) {
        if (!user.perms.includes('pos.price.manual')) {
          throw new BizException(42003, '手动抹零需改价权限（pos.price.manual）', 403);
        }
        manualRoundCents = toCents(dto.manualRound);
        if (manualRoundCents > payableCents) throw new BizException(40003, '手动抹零金额不能超过应收');
        payableCents -= manualRoundCents;
        await audit(user.storeId, user.sub, '收银', '手动抹零', 'sales_order', null,
          { manualRound: dto.manualRound, roundRule });
      }
      // ── 1.7c 促销赠品行强校验（V4.28.9）：免店长授权的促销赠品行，必须逐活动验证——
      //    ① 对应「消费后奖励-送赠品」活动真实存在且进行中（防伪造 promoGift 免授权白拿）；
      //    ② 活动配置的赠品商品与行商品一致；③ 实付 ≥ 活动门槛；
      //    ④ 数量上限：每个活动的赠品行数量必须 ≤ 活动配置 giftQty（V4.28.9b——
      //       "满100送A×2"就只送 2 个，多出的必须按正常价销售，赠品数量与后台设置严格一致）。
      //    任一不满足 → 拒绝结账（此时未支付，收银员移除/校准赠品行即可，无资金损失）。──
      const pgByAct = new Map<number, { qty: number; name: string }>();
      for (const ln of lines.filter((ln: any) => ln.promoGift)) {
        const pr = (await cx(c,
          `SELECT id, name, status, start_at, end_at, rules FROM promotions
            WHERE id=$1 AND store_id=${user.storeId}`, [ln.promoGiftId]))[0];
        const rules = (pr?.rules && typeof pr.rules === 'object') ? pr.rules : {};
        const active = pr && pr.status === '进行中'
          && new Date(pr.start_at).getTime() <= Date.now() && new Date(pr.end_at).getTime() >= Date.now();
        if (!active || String(rules.rewardType) !== 'gift'
          || Number(rules.giftProductId) !== Number(ln.p.id)) {
          throw new BizException(40003,
            `促销赠品行无效（活动不存在 / 已结束 / 赠品商品不符）：${ln.p.name}——请移除该赠品行后重新结算`);
        }
        if (Number(rules.threshold) > 0 && payableCents / 100 < Number(rules.threshold)) {
          throw new BizException(40003,
            `未达「${pr.name}」活动门槛（单笔实付满 ${Number(rules.threshold)} 元），当前应收 ${(payableCents / 100).toFixed(2)} 元：请继续加购或移除促销赠品行`);
        }
        const agg = pgByAct.get(Number(ln.promoGiftId)) || { qty: 0, name: ln.p.name };
        agg.qty += Number(ln.baseQty) || 0;
        pgByAct.set(Number(ln.promoGiftId), agg);
        const capQty = Math.max(1, Number(rules.giftQty) || 1);
        if (agg.qty > capQty) {
          throw new BizException(40003,
            `「${pr.name}」赠品数量超限：活动设置赠 ${capQty} 个「${agg.name}」，购物车 0 元赠品行共 ${agg.qty} 个——` +
            `超出的 ${agg.qty - capQty} 个请按正常价销售（收银台重新结算会自动拆分校准）`);
        }
      }

      // ── 1.7d 整单成交价下限闸（V4.28.1 P0-1）：促销/券/会员价/整单折扣/抹零叠加后，
      //    应收货值不得低于 Σ(行红线价×数量)——红线价与改价同口径 max(最低卖价, 进价)。
      //    开关 sales.price_floor_guard（默认开）；击穿时需店长现场授权票据（scope=price，
      //    与改价授权同通道），并全额审计留痕。堵住"优惠叠加静默击穿进价"的最后缺口。 ──
      if ((await this.settings.getNum('sales.price_floor_guard', 1)) === 1 && payableCents > 0) {
        let floorCents = 0;
        // ── V4.28.9 促销赠品行豁免：0 元促销赠品行不计入下限（活动门槛已在 1.7c 强校验）──
        // ── V4.28.6 临期豁免：在库临期批次（≤ ai.pricing.expiry_days 天到期）的商品不计入下限——
        //    临期自动折扣允许低于进价去化（sales.floor_guard_expiry_exempt，默认开），其余商品照常拦截 ──
        let expiryIds = new Set<number>();
        if ((await this.settings.getBool('sales.floor_guard_expiry_exempt', true))) {
          const expDays = Number(await this.settings.getNum('ai.pricing.expiry_days', 30) ?? 30);
          const linePids = [...new Set(lines.map((ln: any) => Number((ln.p as any)?.id)).filter(Boolean))];
          if (linePids.length) {
            const er = await cx(c,
              `SELECT DISTINCT product_id FROM batches
                WHERE store_id=${user.storeId} AND status='在库' AND remain_qty > 0
                  AND expiry_date <= CURRENT_DATE + $1::int AND product_id = ANY($2::bigint[])`,
              [expDays, linePids]);
            expiryIds = new Set(er.map((x: any) => Number(x.product_id)));
          }
        }
        for (const ln of lines) {
          if ((ln as any).promoGift) continue;                      // 促销赠品行：0 元，不计入下限（门槛已在 1.7c 校验）
          if (expiryIds.has(Number((ln.p as any)?.id))) continue;   // 临期商品：不设下限
          const priceSet = Number((ln.p as any)?.min_price ?? 0) || 0;
          const sellP = Number((ln.p as any)?.sell_price) || 0;
          const costP = Number((ln.p as any)?.cost_price) || 0;
          const minP = Math.max(priceSet > 0 ? priceSet : Math.round(sellP * floorRate * 100) / 100, costP);
          if (minP > 0) floorCents += Math.round(minP * 100) * Number(ln.baseQty || 0);
        }
        if (payableCents < floorCents) {
          const tk = String((dto as any).priceAuthTicket || '');
          let authorizer = '';
          try {
            const pl: any = jwt.verify(tk, JWT_SECRET);
            if (pl?.scope === 'price' && pl?.sub) authorizer = `${String(pl.empNo || '')}(${String(pl.name || '')})`;
          } catch { /* 无票/过期 → 拦截 */ }
          if (!authorizer) {
            throw new BizException(50038,
              `整单应收 ${(payableCents / 100).toFixed(2)} 元低于商品最低售价合计 ${(floorCents / 100).toFixed(2)} 元` +
              `（优惠叠加击穿红线）：需店长现场授权（输入店长工号与授权码）后才能收款`);
          }
          await audit(user.storeId, user.sub, '收银', '整单成交价低于红线（店长授权放行）', 'sales_order', null,
            { payable: payableCents / 100, floor: floorCents / 100, authorizer });
        }
      }

      // 应收为 0（全抹零）时允许零支付结账；否则必须至少一种支付方式
      if (payableCents > 0 && !(dto.payments ?? []).length) throw new BizException(40003, '至少一种支付方式');

      // ── 1.8 线上配送费（方向4 在线商城）：服务端定价后并入应收，留痕 delivery_fee ──
      const deliveryFeeCents = dto.deliveryFee && dto.deliveryFee > 0 ? toCents(dto.deliveryFee) : 0;
      payableCents += deliveryFeeCents;

      if (dto.isEmergency && emergencyCap && payableCents > toCents(emergencyCap)) {
        throw new BizException(50032, `应急收索单笔上限 ${emergencyCap} 元（ops.emergency_amount_cap）`);
      }
      const payable = payableCents / 100;
      const roundAmount = (roundCents + manualRoundCents) / 100;
      const deliveryFee = deliveryFeeCents / 100;
      const profit = (payableCents - costCents) / 100;

      // ── 2/3. 落单域：台位 + 单号/主单 + 券核销 + 明细/批次/库存 ──
      //   （Q-01：拆至 sales.checkout.persist.ts，行为逐字保留；P-03 批量化落账随迁）
      const { orderId, orderNo, tableId, tableName } = await persistCheckoutOrder({
        c, user, dto, lines, goodsAmount, promo, couponAmount, payable, costTotal, profit,
        levelDiscountTotal, roundAmount, shiftId, couponIdUsed, couponIdsUsed,
        orderDiscountCents, deliveryFee, operatorId,
      });
      // ── 4. 支付 ──（Q-01：支付域拆至 sales.checkout.payments.ts，行为逐字保留；
      //   creditCents 自赊账通道停用起恒 0、4.95 挂账块为死路径——原样随迁）
      const { validSpendCents, creditCents, payLog } = await processCheckoutPayments({
        c, user, dto, settings: this.settings, orderId, orderNo, payableCents, operatorId, hqDebits,
      });
      const validSpend = validSpendCents / 100;
      // ── 5/6. 资产域：会员权益 + 消费后奖励 + 审计 + 负库存标记 + 上行入队 ──
      //   （Q-01：拆至 sales.checkout.assets.ts，行为逐字保留；返回即 tx 闭包结果）
      return await finalizeCheckoutAssets({
        c, user, dto, settings: this.settings, orderId, orderNo, payable, validSpend,
        levelDiscountTotal, promo, couponAmount, goodsAmount, costTotal, profit, roundAmount,
        orderDiscountCents, deliveryFee, shiftId, operatorId, tableId, tableName,
        lines, levelCtx, payLog,
      });
    });
    } catch (e: any) {
      // L-04：本地事务回滚（本地无单）后，撤销已成功的总部扣款，避免 HQ 已扣而本地无单的资损
      if (hqDebits.length) { try { await reverseHqDebits(hqDebits); } catch { /* 失败已记入 reverseHqDebits 内审计 */ } }
      throw e;
    }
    // V5.0.0 批次4A：事务已提交 → 事件触发门店节点立即上行（hq/单店节点内部 no-op）
    SyncStoreService.kick();
    return out;
  }

  /**
   * 支付状态机 CAS 结算（V4.13.1，对比报告 P0-4.3/4.2；pay_service 通知/查单兜底共用的唯一收钱迁移）：
   * unpaid→paid 必须带 rowcount 判定 + 应收金额逐分校验——通知金额与本地应收不一致时拒绝入账。
   * 返回 false = 状态已迁移过（幂等应答）或金额不符（拒绝 + 告警由调用方处理）。
   */
  async settlePaidCas(orderId: number, expectPayableYuan: number): Promise<boolean> {
    const r = await q(
      `UPDATE sales_orders SET pay_status='paid', pay_paid_at=now()
        WHERE id=$1 AND pay_status='unpaid' AND ROUND(payable_amount*100)=$2 RETURNING id`,
      [orderId, toCents(expectPayableYuan)]);
    return r.length > 0;
  }
}

// ─── Controller ───
@Controller('sales')
class SalesController {
  private svc = new SalesService();

  @RequirePerms('pos.sell')
  @Post('checkout')
  checkout(@Body() dto: CheckoutDto, @CurrentUser() user: AuthUser) {
    return this.svc.checkout(user, dto);
  }

  /** 决策④：负库存「挂起成本」工作队列（盘点/财务回填；挂起记录由结账软模式写入） */
  @RequirePerms('stock.count.audit', 'stock.count.task', 'recon.confirm')
  @Get('pending-shortages')
  async pendingShortages() {
    return q(
      `SELECT p.id, p.store_id AS "storeId", p.product_id AS "productId", pr.name AS "productName",
              p.order_id AS "orderId", p.qty, p.cost_basis AS "costBasis", p.status, p.created_at AS "createdAt"
         FROM pending_cost_adjusts p JOIN products pr ON pr.id = p.product_id
        WHERE p.status = '挂起' ORDER BY p.id DESC LIMIT 200`);
  }

  @RequirePerms('stock.count.audit', 'recon.confirm')
  @Post('pending-shortages/:id/resolve')
  async resolveShortage(@Param('id', ParseIntPipe) id: number,
                        @Body() b: { unitCost?: number; note?: string }, @CurrentUser() user: AuthUser) {
    const uc = Number(b.unitCost);
    if (!(uc > 0)) throw new BizException(40003, '回填单位成本 unitCost 必须大于 0');
    const r = await q1<any>(
      `UPDATE pending_cost_adjusts SET status='已回填', unit_cost=$2, note=$3, resolved_by=$4, resolved_at=now()
        WHERE id=$1 AND status='挂起' RETURNING id, product_id, qty, order_id`,
      [id, uc, b.note ?? null, user.sub]);
    if (!r) throw new BizException(40404, '挂起记录不存在或已回填', 404);
    await audit(user.storeId, user.sub, '库存', 'pending_cost.adjust.resolve', 'product', Number(r.product_id),
      { pendingId: Number(r.id), qty: Number(r.qty), unitCost: uc, orderId: Number(r.order_id) });
    return { ok: true, id, unitCost: uc };
  }

  @Get()
  async list(
    @Query('page') page = '1', @Query('size') size = '20',
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('cashierId') cashierId?: string, @Query('keyword') keyword?: string,
    @Query('supplierId') supplierId?: string, @Query('channel') channel?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    const kw = (keyword || '').trim();
    const ch = (channel || '').trim();
    // V4.28.0 安全修复（F-04）：按数据范围收敛门店（总部 all 可看全链，其余仅本店）
    const storeCond = curScope().dataScope === 'all' ? '' : ` AND o.store_id = ${Number(user?.storeId || 0)}`;
    const where = `($1::date IS NULL OR o.created_at::date >= $1::date)
          AND ($2::date IS NULL OR o.created_at::date <= $2::date)
          AND ($3::bigint IS NULL OR o.cashier_id = $3::bigint)
          AND ($4 = '' OR EXISTS (SELECT 1 FROM sale_items si4 JOIN products p4 ON p4.id = si4.product_id
                WHERE si4.order_id = o.id AND (p4.name ILIKE '%'||$4||'%' OR p4.barcode = $4)))
          AND ($5::bigint IS NULL OR EXISTS (SELECT 1 FROM sale_items si5 JOIN products p5 ON p5.id = si5.product_id
                WHERE si5.order_id = o.id AND p5.supplier_default_id = $5::bigint))
          AND ($6 = '' OR o.channel::text = $6)${storeCond}`;
    const params = [from || null, to || null, cashierId || null, kw, supplierId || null, ch] as any[];
    const items = await q(
      `SELECT o.*, m.name AS member_name, e.name AS cashier_name
         FROM sales_orders o
         LEFT JOIN members m ON m.id = o.member_id
         LEFT JOIN employees e ON e.id = o.cashier_id
        WHERE ${where}
        ORDER BY o.id DESC LIMIT $7 OFFSET $8`,
      [...params, sz, (pn - 1) * sz]);
    const total = Number((await q1<{ n: string }>(
      `SELECT count(*)::int AS n FROM sales_orders o WHERE ${where}`, params))?.n ?? 0);
    // V5.0.1：查询范围汇总（前端固定「合计」行数据源：货值/促销/券/抹零/应收/毛利）
    const s = await q1<any>(
      `SELECT COALESCE(SUM(o.goods_amount),0) AS goods, COALESCE(SUM(o.promo_amount),0) AS promo,
              COALESCE(SUM(o.coupon_amount),0) AS coupon, COALESCE(SUM(o.round_amount),0) AS rnd,
              COALESCE(SUM(o.payable_amount),0) AS payable, COALESCE(SUM(o.profit_amount),0) AS profit
         FROM sales_orders o WHERE ${where}`, params);
    return { page: pn, size: sz, total, items,
      sums: { goods: Number(s?.goods ?? 0), promo: Number(s?.promo ?? 0), coupon: Number(s?.coupon ?? 0),
              round: Number(s?.rnd ?? 0), payable: Number(s?.payable ?? 0), profit: Number(s?.profit ?? 0) } };
  }

  /** V4.22.0 销售明细：销售商品行级流水（行=单据×商品），分页 + 时间段/关键字/收银员/渠道过滤 + 合计 */
  @Get('items')
  async items(
    @Query('page') page = '1', @Query('size') size = '20',
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('cashierId') cashierId?: string, @Query('keyword') keyword?: string,
    @Query('channel') channel?: string, @Query('categoryId') categoryId?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 20));
    const kw = (keyword || '').trim();
    const ch = (channel || '').trim();
    // V4.28.0 安全修复（F-04）：门店收敛 + 成本/毛利仅对财务相关权限可见
    const storeCond = curScope().dataScope === 'all' ? '' : ` AND o.store_id = ${Number(user?.storeId || 0)}`;
    const canCost = !!user && (user.perms.includes('*')
      || user.perms.some(p => p.startsWith('recon.') || p.startsWith('sys.') || p === 'finance.billrecon'));
    const costSel = canCost
      ? 'si.line_cost AS "lineCost", (si.line_amount - si.line_cost) AS "lineProfit"'
      : 'NULL::numeric AS "lineCost", NULL::numeric AS "lineProfit"';
    const where = `o.status = '已完成'
          AND ($1::date IS NULL OR o.created_at::date >= $1::date)
          AND ($2::date IS NULL OR o.created_at::date <= $2::date)
          AND ($3::bigint IS NULL OR o.cashier_id = $3::bigint)
          AND ($4 = '' OR p.name ILIKE '%'||$4||'%' OR p.barcode = $4)
          AND ($5 = '' OR o.channel::text = $5)
          AND ($6::bigint IS NULL OR p.category_id = $6::bigint)${storeCond}`;
    const params = [from || null, to || null, cashierId || null, kw, ch, categoryId || null] as any[];
    const items = await q(
      `SELECT si.id, si.order_id AS "orderId", o.order_no, o.channel::text AS channel, o.created_at,
              si.product_id AS "productId", p.name AS "productName", p.barcode, p.base_unit AS unit,
              p.category_id AS "categoryId", pc.name AS "categoryName",
              si.qty, si.unit_price AS "unitPrice", si.line_amount AS "lineAmount",
              ${costSel},
              e.name AS "cashierName", m.name AS "memberName"
         FROM sale_items si
         JOIN sales_orders o ON o.id = si.order_id
         JOIN products p ON p.id = si.product_id
         LEFT JOIN categories pc ON pc.id = p.category_id
         LEFT JOIN employees e ON e.id = o.cashier_id
         LEFT JOIN members m ON m.id = o.member_id
        WHERE ${where}
        ORDER BY o.id DESC, si.id ASC LIMIT $7 OFFSET $8`,
      [...params, sz, (pn - 1) * sz]);
    const sum = await q1<any>(
      `SELECT count(*)::int AS n, COALESCE(SUM(si.qty),0) AS qty, COALESCE(SUM(si.line_amount),0) AS amount
         FROM sale_items si
         JOIN sales_orders o ON o.id = si.order_id
         JOIN products p ON p.id = si.product_id
        WHERE ${where}`, params);
    let sumProfit = 0, sumCost = 0;
    if (canCost) {
      const ps = await q1<any>(
        `SELECT COALESCE(SUM(si.line_amount - si.line_cost),0) AS profit,
                COALESCE(SUM(si.line_cost),0) AS cost
           FROM sale_items si JOIN sales_orders o ON o.id = si.order_id JOIN products p ON p.id = si.product_id
          WHERE ${where}`, params);
      sumProfit = Number(ps?.profit ?? 0);
      sumCost = Number(ps?.cost ?? 0);
    }
    return { page: pn, size: sz, total: Number(sum?.n ?? 0),
      sumQty: Number(sum?.qty ?? 0), sumAmount: Number(sum?.amount ?? 0), sumProfit, sumCost, items };
  }

  /* ═══════════ 配货拣货（6.11 拣货单：线上订单 → 扫码校验 → 缺货登记 → 完成） ═══════════ */
  @Get('picking')
  async pickingList(@CurrentUser() user: AuthUser,
                    @Query('status') status?: string, @Query('page') page?: string, @Query('size') size?: string) {
    const pageSize = Math.min(Math.max(Number(size) || 15, 1), 200);
    const pg = Math.max(Number(page) || 1, 1);
    const where = `WHERE o.store_id=$1 AND o.status='已完成'
          AND o.channel IN ('小程序','H5','外卖','大客户团购')
          AND ($2::text IS NULL OR o.picking_status = $2)`;
    const params: any[] = [user.storeId, status || null];
    const tot = await q1(`SELECT count(*)::int AS n FROM sales_orders o ${where}`, params);
    const rows = await q(
      `SELECT o.id, o.order_no, o.channel, o.pickup_mode, o.created_at, o.picking_status,
              o.payable_amount, o.member_id,
              (SELECT count(*) FROM sale_items i WHERE i.order_id = o.id)::int AS item_count,
              m.name AS member_name, m.phone
         FROM sales_orders o LEFT JOIN members m ON m.id = o.member_id
        ${where}
        ORDER BY o.id DESC LIMIT $3 OFFSET $4`,
      [...params, pageSize, (pg - 1) * pageSize]);
    return { items: rows, total: Number(tot?.n || 0), page: pg, size: pageSize };
  }

  @Get('picking/:id')
  async pickingDetail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const order = await q1(`SELECT * FROM sales_orders WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!order) throw new BizException(40404, '拣货订单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit
         FROM sale_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id=$1 ORDER BY i.id`, [id]);
    const shortages = await q(
      `SELECT s.*, p.name AS product_name FROM picking_shortages s
         JOIN products p ON p.id = s.product_id WHERE s.order_id=$1 ORDER BY s.id`, [id]);
    return { order, items, shortages };
  }

  /** 订单详情（含明细/批次成本/支付，可追溯）。V4.28.0（F-04）：按数据范围断言门店，堵 IDOR */
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const order = await q1(`SELECT * FROM sales_orders WHERE id=$1`, [id]);
    if (!order) throw new BizException(40404, '订单不存在', 404);
    if (curScope().dataScope !== 'all' && Number(order.store_id) !== Number(curStore())) {
      throw new BizException(40301, '无权查看其他门店的订单', 403);
    }
    const items = await q(
      `SELECT i.*, p.name AS product_name,
              (SELECT json_agg(json_build_object('batch', b.batch_no, 'qty', sib.qty, 'cost', sib.unit_cost))
                 FROM sale_item_batches sib JOIN batches b ON b.id = sib.batch_id
                WHERE sib.sale_item_id = i.id) AS batch_trace
         FROM sale_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id=$1 ORDER BY i.id`, [id]);
    const payments = await q(`SELECT * FROM sale_payments WHERE order_id=$1 ORDER BY id`, [id]);
    return { order, items, payments };
  }

  /** 离场核销码校验（扫码购出口抽检 6.4.2）：>100 元必检，其余 10% 概率抽检；核销即置 code_verified_at */
  @RequirePerms('pos.sell')
  @Post('verify-code')
  async verifyCode(@Body() b: { code?: string }, @CurrentUser() user: AuthUser) {
    const code = String(b.code || '').trim();
    if (!code) throw new BizException(40003, '核销码必填');
    const order = await q1(
      `SELECT * FROM sales_orders
        WHERE store_id=$1 AND channel='扫码购' AND delivery_code=$2 AND code_verified_at IS NULL
        ORDER BY id DESC LIMIT 1`, [user.storeId, code]);
    if (!order) throw new BizException(50050, '核销码无效或已核销');
    const amount = Number(order.payable_amount);
    const needCheck = amount > 100 ? '必检' : (Math.random() < 0.1 ? '抽检' : '放行');
    await q(`UPDATE sales_orders SET code_verified_at=now(), updated_at=now() WHERE id=$1`, [order.id]);
    const items = await q(
      `SELECT p.name, i.qty, i.unit_price, i.line_amount
         FROM sale_items i JOIN products p ON p.id=i.product_id
        WHERE i.order_id=$1 ORDER BY i.id`, [order.id]);
    await audit(user.storeId, user.sub, '收银', 'sale.verify.code', 'sales_order', order.id,
      { orderNo: order.order_no, code, amount, needCheck });
    return { orderId: Number(order.id), orderNo: order.order_no, memberId: order.member_id ? Number(order.member_id) : null,
             amount, itemCount: items.length, items, needCheck, verifiedAt: new Date() };
  }

  /** 拣货开始（待拣货 → 拣货中） */
  @Post('picking/:id/start')
  async pickingStart(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const r = await q(
      `UPDATE sales_orders SET picking_status='拣货中', updated_at=now()
        WHERE id=$1 AND store_id=$2 AND picking_status IN ('待拣货','拣货中') RETURNING id`, [id, user.storeId]);
    if (!r.length) throw new BizException(50090, '订单不在待拣货状态，无法开始拣货');
    await audit(user.storeId, user.sub, '进销存', 'picking.start', 'sales_order', id, {});
    return { ok: true };
  }

  /** 拣货完成（可携带缺货登记 → 状态置 已拣货/缺货；拣货人/时间留痕） */
  @Post('picking/:id/complete')
  async pickingComplete(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { shortages?: { productId: number; qty: number; reason?: string }[] },
    @CurrentUser() user: AuthUser,
  ) {
    return tx(async c => {
      const rs = await cx(c,
        `SELECT id, order_no, pickup_mode FROM sales_orders WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id, user.storeId]);
      if (!rs.length) throw new BizException(40404, '拣货订单不存在', 404);
      const hasShort = Array.isArray(b.shortages) && b.shortages.length > 0;
      if (hasShort) {
        for (const s of b.shortages) {
          const qty = r3(Number(s.qty));
          if (!(qty > 0)) throw new BizException(40003, '缺货数量必须大于 0');
          await cx(c,
            `INSERT INTO picking_shortages (order_id, product_id, qty, reason) VALUES ($1,$2,$3,$4)`,
            [id, s.productId, qty, s.reason ?? null]);
        }
      }
      // 配送/外卖订单拣货完成即装车出发（方向4 在线业务：dispatched_at 置位 → 配送中）
      const orderRow = rs[0];
      const finalStatus = hasShort ? '缺货' : '已拣货';
      if (orderRow.pickup_mode !== '自提' && !hasShort) {
        await cx(c,
          `UPDATE sales_orders SET picking_status=$2, picked_by=$3, picked_at=now(), dispatched_at=now(), updated_at=now()
            WHERE id=$1`, [id, finalStatus, user.sub]);
      } else {
        await cx(c,
          `UPDATE sales_orders SET picking_status=$2, picked_by=$3, picked_at=now(), updated_at=now()
            WHERE id=$1`, [id, finalStatus, user.sub]);
      }
      await audit(user.storeId, user.sub, '进销存', 'picking.complete', 'sales_order', id,
        { orderNo: rs[0].order_no, shortageCount: hasShort ? b.shortages!.length : 0 });
      return { ok: true, status: hasShort ? '缺货' : '已拣货' };
    });
  }

  /** 配送码核销（V4.2：扫顾客当面出示的 8 位码 → 核销 + 签收照片，区别于扫码购离场抽检 verify-code） */
  @RequirePerms('pos.sell')
  @Post('delivery/verify')
  async deliveryVerify(@Body() b: { code?: string; photo?: string }, @CurrentUser() user: AuthUser) {
    const code = String(b.code || '').trim();
    if (!code) throw new BizException(40003, '核销码必填');
    const order = await q1(
      `SELECT o.*, m.name AS member_name, m.phone
         FROM sales_orders o LEFT JOIN members m ON m.id = o.member_id
        WHERE o.store_id=$1 AND o.pickup_mode='配送' AND o.channel <> '扫码购'
          AND o.delivery_code=$2 AND o.code_verified_at IS NULL
        ORDER BY o.id DESC LIMIT 1`, [user.storeId, code]);
    if (!order) throw new BizException(50050, '核销码无效或已核销');
    await q(`UPDATE sales_orders SET code_verified_at=now(), code_verified_by=$2,
        delivery_photo=$3, updated_at=now() WHERE id=$1`, [order.id, user.sub, b.photo ?? null]);
    await audit(user.storeId, user.sub, '收银', 'delivery.verify', 'sales_order', Number(order.id),
      { orderNo: order.order_no, code, photo: !!b.photo });
    return { orderId: Number(order.id), orderNo: order.order_no, memberName: order.member_name ?? null,
             amount: Number(order.payable_amount), verifiedAt: new Date() };
  }

  /** 自提核销（方向4 在线业务：线上自提单 → 顾客出示 6 位自提码 → 门店核销交付） */
  @RequirePerms('pos.sell')
  @Post('pickup/verify')
  async pickupVerify(@Body() b: { code?: string }, @CurrentUser() user: AuthUser) {
    const code = String(b.code || '').trim();
    if (!code) throw new BizException(40003, '自提码必填');
    const order = await q1(
      `SELECT o.*, m.name AS member_name, m.phone
         FROM sales_orders o LEFT JOIN members m ON m.id = o.member_id
        WHERE o.store_id=$1 AND o.pickup_mode='自提' AND o.channel IN ('小程序','H5','外卖')
          AND o.delivery_code=$2 AND o.code_verified_at IS NULL AND o.status='已完成'
        ORDER BY o.id DESC LIMIT 1`, [user.storeId, code]);
    if (!order) throw new BizException(50050, '自提码无效或已核销');
    await q(`UPDATE sales_orders SET code_verified_at=now(), code_verified_by=$2,
        picking_status='已拣货', updated_at=now() WHERE id=$1`, [order.id, user.sub]);
    await audit(user.storeId, user.sub, '收银', 'pickup.verify', 'sales_order', Number(order.id),
      { orderNo: order.order_no, code });
    const items = await q(
      `SELECT p.name, i.qty, i.unit_price FROM sale_items i JOIN products p ON p.id=i.product_id
        WHERE i.order_id=$1 ORDER BY i.id`, [order.id]);
    return { orderId: Number(order.id), orderNo: order.order_no, memberName: order.member_name ?? null,
             amount: Number(order.payable_amount), itemCount: items.length, items, verifiedAt: new Date() };
  }
}

@Module({ controllers: [SalesController] })
export class SalesModule {}
