import { Module, Controller, Post, Get, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, r2, r3, audit, seqLock } from '../common/db';
import { consumeBatches } from './sales.fifo';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms, JWT_SECRET } from '../common/auth';
import * as jwt from 'jsonwebtoken';
import { SettingsService } from './settings.module';
import { syncMemberLevel } from './members.module';
import { applyPromotions, grantPostCheckoutRewards } from './promotions.module';
import { applyCoupons, couponStockAfter, logCoupon } from './coupons.module';   // V5.0 多选核销 + 核销出库流水
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价：结算按当前门店取价
import { COST_REF } from '../common/sql';              // V5.0.0 R8：进价口径 L1 优先（红线兜底）
import { enqueueSync, nodeIdentity } from '../common/outbox';  // V5.0.0 批次4A：同事务上行入队（hq/单店 no-op）
import { SyncStoreService } from './sync-store.service'; // V5.0.0：结算后事件触发立即推送
import { isChainStoreNode, hqMemberPost, offlineBalanceCredit, HQ_UNREACHABLE_CODE } from './member-chain.module'; // V5.0.0 批次5+P2-1：会员资产权威账本在总部；断网挂账
import { curStore, curScope } from '../common/context';   // V4.28.0：销售列表/明细按数据范围收敛（审计 F-04）

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
    const needsPriceAuth = (dto.items as any[]).some(it => it && !it.custom
      && (it.unitPrice !== undefined || it.discRate !== undefined || it.gift))
      || (Number(dto.orderDiscount) > 0);
    let priceAuthorizer: { id: number; empNo: string; name: string } | null = null;
    if (needsPriceAuth) {
      const tk = String((dto as any).priceAuthTicket || '');
      if (!tk) throw new BizException(50035, '改价/折扣需店长现场授权：请在弹出框输入店长工号与授权码');
      try {
        const pl: any = jwt.verify(tk, JWT_SECRET);
        if (pl?.scope !== 'price' || !pl?.sub) throw new Error('bad scope');
        priceAuthorizer = { id: Number(pl.sub), empNo: String(pl.empNo || ''), name: String(pl.name || '') };
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

    const out = await tx(async c => {
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

      // ── 1. 逐行计价 + FIFO 批次分配（内存先算，写库在后） ──
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
        await storePrice.overlayOne(user.storeId, p);
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
          //    ① 折扣率 ≥ 商品最低折扣 min_discount_rate；② 折后单价 ≥ 商品最低卖价 min_price（未设按售价 6 折兜底）
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
            ? Number(p.min_price) : r2(Number(p.sell_price) * 0.6);
          // V4.25.4 进价兜底：折后价不得低于进价（未设最低卖价时进价即最终红线）
          const costP = Number((p as any).cost_price) || 0;
          const floorP = Math.max(minSalePrice, costP);
          const belowDisc = minDiscRate > 0 && dRate < minDiscRate;
          const belowPrice = floorP > 0 && unitPrice < floorP;
          if (belowDisc || belowPrice) {
            if (!user.perms.includes('pos.emergency.manual')) {
              throw new BizException(50034, belowDisc
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
          //    最低卖价线 = 商品 min_price，未设时按售价 6 成；进价取最新供应商进价（取不到按 0 = 不启用）
          const minP = p.min_price !== null && p.min_price !== undefined && p.min_price !== ''
            ? Number(p.min_price) : r2(Number(p.sell_price) * 0.6);
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
        const lineCents = lineAmountOverride !== null ? toCents(lineAmountOverride) : Math.round(toCents(unitPrice) * baseQty);
        const lineDiscountCents = lineAmountOverride === null && levelDiscountOn && levelCtx && levelCtx.discount < 1 && !priceChanged
          ? Math.round(baseQty * toCents(basePrice - unitPrice)) : 0;
        levelDiscCents += lineDiscountCents;
        const lineAmount = lineCents / 100;
        const lineDiscount = lineDiscountCents / 100;

        // FIFO 批次分配：FOR UPDATE 行锁 = 服务端唯一权威（前端库存/金额拦截仅体验层，一切以本事务落账为准·决策④）
        // 硬拦（默认）：库存不足 50001 直接拒绝；软模式（stock.negative_sales=开）：差额挂末位批次记负 + 进挂起成本队列，不硬拦
        const allocs: { batchId: number; qty: number; cost: number }[] = [];
        let lineCost = 0;
        let shortageHold: { qty: number; basis: string } | null = null;
        if (p.track_inventory) {
          const batches = await cx(c,
            `SELECT id, remain_qty, inbound_cost FROM batches
              WHERE store_id=$1 AND product_id=$2 AND status='在库' AND remain_qty > 0
              ORDER BY expiry_date, inbound_date, id
              FOR UPDATE`, [user.storeId, p.id]);
          let totalAvail = 0;
          for (const b of batches) totalAvail += Number(b.remain_qty);
          const allowNeg = totalAvail < baseQty && !branchNegLock
            && (await this.settings.getBool('stock.negative_sales', false));
          if (totalAvail < baseQty && !allowNeg) {
            throw new BizException(50001, `${p.name} 库存不足（现有 ${totalAvail}，需 ${baseQty}）`);
          }
          let need = baseQty;
          for (const b of batches) {
            if (need <= 0) break;
            const take = Math.min(Number(b.remain_qty), need);
            allocs.push({ batchId: b.id, qty: r3(take), cost: Number(b.inbound_cost) });
            lineCost += take * Number(b.inbound_cost);
            need = r3(need - take);
          }
          // 决策④：FIFO 吃完仍有差额 → 支持「负批次挂起」——末位批次挂负数并暂计其成本；
          // 无任何在库批次时绝不按 0 成本静默吞掉：差额全额进入 pending_cost_adjusts 挂起队列，待盘点/财务回填真实成本
          if (need > 1e-9 && allowNeg) {
            const last = batches[batches.length - 1];
            let basis = 'none';
            if (last) {
              allocs.push({ batchId: last.id, qty: r3(need), cost: Number(last.inbound_cost) });
              lineCost += need * Number(last.inbound_cost);
              basis = `batch:${last.id}`;
            }
            shortageHold = { qty: r3(need), basis };
            await audit(user.storeId, user.sub, '收银', '负库存售卖', 'product', Number(p.id),
              { name: p.name, stock: totalAvail, sold: baseQty, shortage: r3(need), costBasis: basis });
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
                     manualBarcode: it.manualEntry ? (it.manualBarcode ?? null) : null, shortage: shortageHold });
      }

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
      // ── 1.7 抹零（5.2 收银设置 pos.round_rule：分/角/5角/元，向下去零；抹掉金额记 round_amount ≥0）──
      // RV-01：单位直接用分，向下去零 = 对 ruc 取余，整数运算零尾差
      const roundRule = String((await this.settings.getVal('pos.round_rule')) ?? '分');
      const roundUnitC: Record<string, number> = { '分': 1, '角': 10, '5角': 50, '元': 100 };
      const ruc = roundUnitC[roundRule];
      let roundCents = 0;
      if (ruc && ruc > 1 && payableCents > 0) {
        roundCents = payableCents % ruc;
        payableCents -= roundCents;
      }
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
      // ── 1.7c 整单折扣（V4.18.3 P15 批2 §13.1）：促销/券之后、抹零之前冲减应收；
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
          // V4.25.4 进价兜底：红线价 = max(最低卖价线, 最新进价)；最低卖价线未设时按售价 6 成
          const priceSet = Number((ln.p as any)?.min_price ?? (ln.p as any)?.minPrice ?? 0) || 0;
          const sellP = Number((ln.p as any)?.sell_price) || 0;
          const costP = Number((ln.p as any)?.cost_price) || 0;
          const minP = Math.max(priceSet > 0 ? priceSet : Math.round(sellP * 0.6 * 100) / 100, costP);
          const minD = Number((ln.p as any)?.min_discount_rate) || 0;
          const belowDisc = minD > 0 && rate < minD;
          const belowPrice = minP > 0 && ln.unitPrice * (rate / 100) < minP - 0.005;
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
        orderDiscountCents = Math.min(toCents(dto.orderDiscount), payableCents - 1);
        if (orderDiscountCents > 0) {
          payableCents -= orderDiscountCents;
          await audit(user.storeId, user.sub, '收银', '整单折扣', 'sales_order', null,
            { rate, amount: orderDiscountCents / 100, reason, preset: presetOk });
        }
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
          const minP = Math.max(priceSet > 0 ? priceSet : Math.round(sellP * 0.6 * 100) / 100, costP);
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

      // ── 2. 台位归属校验（V4.21.0 P16 批2）：堂食落单即占用（停用台位拒收） ──
      let tableId: number | null = null;
      let tableName: string | null = null;
      if (dto.tableId) {
        const tbs = await cx(c, `SELECT id, name, status FROM dining_tables WHERE id=$1 AND store_id=$2`, [dto.tableId, user.storeId]);
        if (!tbs.length) throw new BizException(40404, '台位不存在');
        if (tbs[0].status === '停用') throw new BizException(40005, '该台位已停用，请先在台位管理恢复');
        tableId = Number(tbs[0].id);
        tableName = tbs[0].name;
      }

      // ── 2. 单号 + 主单 ──
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const seq = await seqLock(c, 'sales_orders', 'order_no', `XS-${ymd}-%`);
      const orderNo = `XS-${ymd}-${String(seq[0].n).padStart(4, '0')}`;
      const order = await cx(c,
        `INSERT INTO sales_orders (store_id, order_no, channel, is_emergency, member_id, cashier_id, status,
                                   goods_amount, promo_amount, coupon_amount, payable_amount, cost_amount,
                                   profit_amount, member_discount, round_amount, shift_id, promo_id, coupon_id,
                                   remark, delivery_fee, client_ref, order_discount, pay_status, pay_paid_at, table_id,
                                   coupon_ids, guest_phone)
         VALUES ($1,$2,$3,$4,$5,$6,'已完成',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'paid',now(),$22,$23,$24) RETURNING id`,
        [user.storeId, orderNo, dto.channel || '收银台', !!dto.isEmergency, dto.memberId ?? null, operatorId,
         goodsAmount, promo.promoAmount, couponAmount, payable, costTotal, profit, levelDiscountTotal,
         roundAmount, shiftId, promo.orderPromoId, couponIdUsed, dto.remark ?? null, deliveryFee,
         dto.clientRef ?? null, orderDiscountCents / 100, tableId,
         couponIdsUsed.length ? JSON.stringify(couponIdsUsed) : null, dto.guestPhone ?? null]);
      const orderId = order[0].id;
      if (tableId) {
        // 落单即占用（预留/空闲 → 使用中；使用中幂等无碍）
        await cx(c, `UPDATE dining_tables SET status='使用中', updated_at=now() WHERE id=$1`, [tableId]);
      }
      // ── 1.6b 券实例核销留痕 + 核销出库流水（V5.0）──
      for (const mcId of couponIdsUsed) {
        const usedCpn = await cx(c,
          `SELECT cp.type, cp.id AS coupon_id, cp.store_id, mc.member_id, mc.times_used, cp.discount
             FROM member_coupons mc JOIN coupons cp ON cp.id=mc.coupon_id WHERE mc.id=$1`, [mcId]);
        if (!usedCpn.length) continue;
        const uc = usedCpn[0];
        if (uc.type === '次卡') {
          // 次卡计次核销（5.3）：累加次数；用尽才置「已使用」并记核销出库
          const total = Number(uc.discount), used = Number(uc.times_used ?? 0) + 1;
          const finished = used >= total;
          await cx(c,
            `UPDATE member_coupons SET times_used=$2, used_at=now(), used_order_id=$3${finished ? ", status='已使用'" : ''} WHERE id=$1`,
            [mcId, used, orderId]);
          if (finished) {
            const sa = await couponStockAfter(c, Number(uc.coupon_id));
            await logCoupon(c, { storeId: Number(uc.store_id), couponId: Number(uc.coupon_id), memberCouponId: mcId,
              moveType: '核销出库', qty: -1, memberId: Number(uc.member_id), operatorId, docNo: orderNo,
              stockAfter: sa, remark: '结算核销(次卡完毕)' });
          }
        } else {
          // 一次性券：用后即销
          await cx(c,
            `UPDATE member_coupons SET status='已使用', used_at=now(), used_order_id=$2 WHERE id=$1`,
            [mcId, orderId]);
          const sa = await couponStockAfter(c, Number(uc.coupon_id));
          await logCoupon(c, { storeId: Number(uc.store_id), couponId: Number(uc.coupon_id), memberCouponId: mcId,
            moveType: '核销出库', qty: -1, memberId: Number(uc.member_id), operatorId, docNo: orderNo,
            stockAfter: sa, remark: '结算核销' });
        }
      }

      // ── 3. 明细 + 批次消耗 + 库存流水 ──
      for (const ln of lines) {
        const item = await cx(c,
          `INSERT INTO sale_items (order_id, product_id, unit_name, qty, unit_price, origin_price,
                                   line_amount, line_cost, line_profit, price_changed, line_remark, promo_id,
                                   supplier_id, biz_mode, manual_barcode, custom_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [orderId, ln.p.id, ln.unitName, ln.baseQty, ln.unitPrice, ln.originPrice,
           ln.lineAmount, ln.lineCost, r2(ln.lineAmount - ln.lineCost), ln.priceChanged, ln.lineRemark, ln.promoId,
           ln.p.supplier_default_id ?? null, ln.p.biz_mode ?? '购销', ln.manualBarcode ?? null, (ln as any).customName ?? null]);
        if (ln.shortage) {
          // 决策④：无批次/末位批次之外的差额挂起记录——成本回填工作队列（盘点/财务经 GET /sales/pending-shortages 处理）
          await cx(c,
            `INSERT INTO pending_cost_adjusts (store_id, product_id, order_id, sale_item_id, qty, cost_basis)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [user.storeId, ln.p.id, orderId, item[0].id, ln.shortage.qty, ln.shortage.basis]);
        }
        await consumeBatches(c, {
          storeId: user.storeId, productId: ln.p.id, saleItemId: item[0].id,
          orderId, allocs: ln.allocs, employeeId: operatorId,
        });
        if (ln.p.track_inventory) {
          await cx(c,
            `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now()
              WHERE store_id=$1 AND product_id=$3`, [user.storeId, ln.baseQty, ln.p.id]);
        }
      }

      // ── 4. 支付（多支付组合；有效消费只按「本金+现金类」部分计，5.1.16）──
      // RV-01 按分计算：支付/拆分全程整数分，通道逐分比对、余额本赠拆分、合计比对零浮点误差
      let paidCents = 0;
      let validSpendCents = 0; // 有效消费（分）：储值本金 + 现金/扫码；分红/积分/赠送部分不计
      // V4.18.3 P15 批2：积分抵现单笔上限（pos.points.max_pct %，0/缺省=不启用上限）
      const ptsMaxPct = await this.settings.getNum('pos.points.max_pct', 20);
      const ptsCapCents = ptsMaxPct > 0 ? Math.floor(payableCents * ptsMaxPct / 100) : payableCents;
      let ptsUsedCents = 0;
      let creditCents = 0;     // V4.18.3 P15 批2：赊账（会员挂账）合计 → 落单后建 member_credits 欠款
      const payLog: { channel: string; amount: number; externalNo: string | null }[] = []; // V5.0.0：上行快照
      // V5.0.0 批次5（M5-4）：连锁门店节点会员卡号缓存（一次结账只查一次）
      let chainCardNo: string | null = null;
      for (const pay of (dto.payments ?? [])) {
        let amountCents = toCents(pay.amount);
        // 扫码购自助结算（6.4.2）：auto 通道自动按应收付清（余额/微信/支付宝直付 VQA-D3 泛化）
        if (pay.auto) {
          amountCents = payableCents - paidCents;
          if (!(amountCents > 0)) continue;
        }
        if (!(amountCents > 0)) throw new BizException(40003, '支付金额必须大于 0');
        // ── V4.13.2 通道成功应答校验：带 gatewayOutTradeNo 的支付必须对上网关 SUCCESS 且金额逐分一致的单，
        //    防止店员谎报到账/截图造假（成熟做法的等价保障：只有真通道应答才能落单）──
        let gatewayTxnId: string | null = null;
        if (pay.gatewayOutTradeNo) {
          const txns = await cx(c,
            `SELECT * FROM pay_gateway_txns WHERE out_trade_no=$1 AND status='SUCCESS' AND store_id=$2 FOR UPDATE`,
            [String(pay.gatewayOutTradeNo).trim(), user.storeId]);
          const txn = txns[0];
          if (!txn) throw new BizException(40902, '支付通道流水不存在或未成功，禁止结账（请先完成通道扣款）');
          if (Number(txn.amount_cents) !== amountCents)
            throw new BizException(40902, `通道扣款金额(${Number(txn.amount_cents) / 100})与支付金额(${amountCents / 100})不一致`);
          if (Number(txn.order_id)) throw new BizException(40902, '该通道流水已关联其他订单');
          gatewayTxnId = txn.transaction_id;
        }
        let balanceFlowId: number | null = null;
        let dividendFlowId: number | null = null;
        let pointsFlowId: number | null = null;
        let hqTicket: string | null = null;   // V5.0.0 批次5：总部资产扣款凭证（MCF 单号，随 external_no 留痕）
        if (pay.channel === '余额') {
          if (!dto.memberId) throw new BizException(50030, '余额支付必须指定会员');
          if (await isChainStoreNode()) {
            // ── 批次5（M5-4，R3）：连锁门店节点 —— 余额权威账本在总部，在线扣款拿 ticket 作支付凭证；
            //    总部不可达 → 明确报错（事务回滚，收银员可改其他支付方式继续结账，不阻断收银）；
            //    本地不重复记账（镜像由总部 member_mirror 下行覆盖）；本金/赠送拆分以总部返回为准。
            if (!chainCardNo) {
              const mcs = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
              chainCardNo = mcs[0]?.card_no ?? null;
            }
            if (!chainCardNo) throw new BizException(50030, '会员卡号缺失，无法余额支付');
            let d: any;
            try {
              d = await hqMemberPost('debit', { cardNo: chainCardNo, orderNo, asset: 'balance', amount: amountCents / 100 });
            } catch (e: any) {
              // ── P2-1（§3.5.4）：总部「网络不可达」（50071）且门店开启挂账 + 限额内 → 先记账后清算；
              //    业务拒绝（余额不足等）与限额超限照旧阻断，收银员改用其他支付方式。
              if (Number(e?.bizCode) !== HQ_UNREACHABLE_CODE) throw e;
              const off = await offlineBalanceCredit(c, {
                storeId: user.storeId, memberId: dto.memberId, cardNo: chainCardNo,
                orderNo, amountCents, nodeCode: (await nodeIdentity())?.nodeCode,
              });
              hqTicket = off.ticket;
              validSpendCents += amountCents;   // 挂账全额暂按本金计有效消费（清算后总部拆分为准，报表口径近似）
            }
            if (d) {
              hqTicket = String(d.ticket);
              validSpendCents += Math.round(Number(d.principalPart ?? 0) * 100);   // 本金部分进有效消费（5.1.16）
            }
          } else {
          const accs = await cx(c, `SELECT * FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [dto.memberId]);
          const acc = accs[0];
          if (!acc || Math.round(Number(acc.balance) * 100) < amountCents)
            throw new BizException(50030, `会员余额不足（余额 ${acc ? acc.balance : 0}）`);
          // 口径B 本金/赠送按比例拆分（5.1.2）：principal_part 进有效消费，赠送部分不计（RV-01 按分）
          const totalBalC = Math.round(Number(acc.balance) * 100);
          const principalBalC = Math.round(Number(acc.principal_balance ?? acc.balance) * 100);
          let principalCents = totalBalC > 0 ? Math.round(amountCents * principalBalC / totalBalC) : 0;
          if (principalCents > amountCents) principalCents = amountCents;
          if (principalCents > principalBalC) principalCents = principalBalC;
          const giftCents = amountCents - principalCents;
          const afterCents = totalBalC - amountCents;
          const fl = await cx(c,
            `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                        biz_type, ref_type, ref_id, balance_after, employee_id)
             VALUES ($1,$2,'出',$3,$4,$5,'消费','sale',$6,$7,$8) RETURNING id`,
            [user.storeId, dto.memberId, amountCents / 100, principalCents / 100, giftCents / 100, orderId, afterCents / 100, operatorId]);
          balanceFlowId = fl[0].id;
          await cx(c,
            `UPDATE member_accounts SET balance=$2, principal_balance = principal_balance - $3,
                    gift_balance = gift_balance - $4, updated_at=now()
              WHERE member_id=$1`, [dto.memberId, afterCents / 100, principalCents / 100, giftCents / 100]);
          validSpendCents += principalCents;
          }
        } else if (pay.channel === '分红抵扣') {
          if (!dto.memberId) throw new BizException(50033, '分红抵扣必须指定会员');
          if (await isChainStoreNode()) {
            // ── 批次5：分红账本在总部（分红引擎只在总部跑），扣减在线执行，防跨店双花
            if (!chainCardNo) {
              const mcs = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
              chainCardNo = mcs[0]?.card_no ?? null;
            }
            if (!chainCardNo) throw new BizException(50033, '会员卡号缺失，无法分红抵扣');
            const d = await hqMemberPost('debit', { cardNo: chainCardNo, orderNo, asset: 'dividend', amount: amountCents / 100 });
            hqTicket = String(d.ticket);
          } else {
          const accs = await cx(c, `SELECT * FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [dto.memberId]);
          const acc = accs[0];
          if (!acc || Math.round(Number(acc.dividend_balance) * 100) < amountCents) {
            throw new BizException(50033, `分红余额不足（余额 ${acc ? acc.dividend_balance : 0}，仅限消费抵扣 5.7）`);
          }
          await cx(c, `UPDATE member_accounts SET dividend_balance = dividend_balance - $2, updated_at=now() WHERE member_id=$1`,
            [dto.memberId, amountCents / 100]);
          const df = await cx(c,
            `INSERT INTO dividend_records (store_id, member_id, record_type, amount, ref_type, ref_id, operator_id)
             VALUES ($1,$2,'抵扣',$3,'sale',$4,$5) RETURNING id`,
            [user.storeId, dto.memberId, amountCents / 100, orderId, user.sub]);
          dividendFlowId = df[0].id;
          // 分红支付不计有效消费（5.1.16：堵「只花分红、本金永不动」漏洞）
          }
        } else if (pay.channel === '积分抵扣') {
          if (!dto.memberId) throw new BizException(50034, '积分抵扣必须指定会员');
          // V4.18.3 P15 批2：比例优先用收银台键 pos.points.rate（每 1 元所需积分），缺省回落 points.redeem_rate；
          //          单笔上限 pos.points.max_pct（%应收），超出直接拒绝（§13 定稿：比例可设+单笔上限）
          if (ptsUsedCents + amountCents > ptsCapCents) {
            throw new BizException(50034, `积分抵现超出单笔上限（≤应收的 ${ptsMaxPct}%），本单最多可抵 ${ptsCapCents / 100} 元`);
          }
          const rate = await this.settings.getNum('pos.points.rate', 0);
          const effRate = rate > 0 ? rate : await this.settings.getNum('points.redeem_rate', 100); // 多少积分 = 1 元
          const need = Math.ceil((amountCents / 100) * effRate);
          if (await isChainStoreNode()) {
            // ── 批次5：积分账本在总部（R4），兑换在线扣减，防跨店双花；本地只落支付凭证
            if (!chainCardNo) {
              const mcs = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
              chainCardNo = mcs[0]?.card_no ?? null;
            }
            if (!chainCardNo) throw new BizException(50034, '会员卡号缺失，无法积分抵扣');
            const d = await hqMemberPost('debit', { cardNo: chainCardNo, orderNo, asset: 'points', points: need });
            hqTicket = String(d.ticket);
          } else {
          const ms = await cx(c, `SELECT points FROM members WHERE id=$1 FOR UPDATE`, [dto.memberId]);
          const cur = ms.length ? Number(ms[0].points) : 0;
          if (cur < need) throw new BizException(50034, `积分不足（需 ${need} 分，可用 ${cur} 分）`);
          await cx(c, `UPDATE members SET points = points - $2, updated_at=now() WHERE id=$1`, [dto.memberId, need]);
          await cx(c, `UPDATE member_accounts SET points = points - $2, updated_at=now() WHERE member_id=$1`, [dto.memberId, need]);
          const pf = await cx(c,
            `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
             VALUES ($1,'减',$2,'兑换','sale',$3,$4) RETURNING id`,
            [dto.memberId, need, orderId, cur - need]);
          pointsFlowId = pf[0].id;
          }
          ptsUsedCents += amountCents;
          // 积分抵扣部分不计有效消费
        } else if (pay.channel === '赊账') {
          // ── P2-3（2026-09-18 老板口径定版）：会员结账余额不足 → 组合支付（余额抵扣 + 现金/微信/支付宝
          //    当场结清），不得赊账。会员「赊账」支付通道停用；历史欠款（member_credits）销账/关闭
          //    端点保留（/pos/credits/*）；大客户团购应收（bigcustomer 赊账）是 B2B 业务，不在本口径内。
          throw new BizException(40003,
            '会员赊账已停用：余额不足请用组合支付（余额抵扣一部分 + 现金/微信/支付宝当场结清），不产生欠款');
        } else {
          validSpendCents += amountCents; // 现金/扫码等真实货币支付
        }
        await cx(c,
          `INSERT INTO sale_payments (order_id, channel, amount, balance_flow_id, dividend_flow_id, points_flow_id, external_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orderId, pay.channel, amountCents / 100, balanceFlowId, dividendFlowId, pointsFlowId, pay.externalNo ?? gatewayTxnId]);
        // V4.13.2：通道流水回填关联销售单（对账/追溯链路）
        if (pay.gatewayOutTradeNo) {
          await cx(c, `UPDATE pay_gateway_txns SET order_id=$1 WHERE out_trade_no=$2 AND order_id IS NULL AND store_id=$3`,
            [orderId, String(pay.gatewayOutTradeNo).trim(), user.storeId]);
        }
        payLog.push({ channel: String(pay.channel), amount: amountCents / 100, externalNo: hqTicket ?? gatewayTxnId ?? pay.externalNo ?? null });
        paidCents += amountCents;
      }
      // ── 4.9 支付合计 == 应收（RV-01：全程整数分累计，逐分比对零浮点误差） ──
      const validSpend = validSpendCents / 100;
      if (paidCents !== payableCents)
        throw new BizException(50031, `支付合计(${paidCents / 100})与应收(${payableCents / 100})不一致`);

      // ── 4.95 会员挂账落欠款（V4.18.3 P15 批2 §13.2 B2）：一笔挂账=一笔独立欠款，账期/原因留痕 ──
      if (creditCents > 0 && dto.memberId) {
        const dueDays = await this.settings.getNum('pos.credit.due_days', 30);
        await cx(c,
          `INSERT INTO member_credits (store_id, member_id, order_id, amount, due_date, reason, creator_id)
           VALUES ($1,$2,$3,$4,(CURRENT_DATE + ($5::int)), $6, $7)`,
          [user.storeId, dto.memberId, orderId, creditCents / 100, dueDays, dto.remark ?? null, operatorId]);
        await audit(user.storeId, operatorId ?? user.sub, '收银', '会员挂账', 'sales_order', orderId,
          { amount: creditCents / 100, dueDays });
      }

      // ── 5. 会员权益：积分（等级倍率 5.3）+ 有效消费窗口（V4.3.2 双门槛）+ 等级同步（5.1.12） ──
      let levelResult: any = null;
      let pointsEarned = 0;
      if (dto.memberId) {
        pointsEarned = Math.floor(payable * (levelCtx?.pointRate ?? 1));
        const ms = await cx(c,
          `UPDATE members SET points = points + $2, last_active_date = CURRENT_DATE, updated_at=now()
            WHERE id=$1 RETURNING points`, [dto.memberId, pointsEarned]);
        await cx(c,
          `UPDATE member_accounts SET points = points + $2, updated_at=now() WHERE member_id=$1`,
          [dto.memberId, pointsEarned]);
        await cx(c,
          `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
           VALUES ($1,'加',$2,'消费','sale',$3,$4)`,
          [dto.memberId, pointsEarned, orderId, Number(ms[0]?.points ?? 0)]);

        const minSingle = await this.settings.getNum('dividend.min_single', 5);
        const minWindow = await this.settings.getNum('dividend.min_window', 50);
        const windowDays = await this.settings.getNum('dividend.window_days', 30);
        if (validSpend >= minSingle) {
          // 优先累加未达标的活跃窗口；同日已有窗口（含已达标）原地累加，避免唯一键冲突；
          // 既无未达标窗口也无同日窗口时才开新窗口
          const ws = await cx(c,
            `SELECT * FROM member_activity_windows
              WHERE member_id=$1 AND qualified=false AND window_start >= CURRENT_DATE - $2::int
              ORDER BY id DESC LIMIT 1 FOR UPDATE`, [dto.memberId, windowDays]);
          let win = ws.length ? ws[0] : null;
          if (!win) {
            const sameDay = await cx(c,
              `SELECT * FROM member_activity_windows
                WHERE member_id=$1 AND window_start=CURRENT_DATE FOR UPDATE`, [dto.memberId]);
            win = sameDay.length ? sameDay[0] : null;
          }
          if (win) {
            const valid = r2(Number(win.valid_total) + validSpend);
            await cx(c,
              `UPDATE member_activity_windows SET valid_total=$2, qualified = qualified OR $3,
                      window_end = GREATEST(window_end, CURRENT_DATE), updated_at=now()
                WHERE id=$1`, [win.id, valid, valid >= minWindow]);
          } else {
            await cx(c,
              `INSERT INTO member_activity_windows (member_id, window_start, window_end, valid_total, qualified)
               VALUES ($1, CURRENT_DATE, CURRENT_DATE + $2::int, $3, $4)`,
              [dto.memberId, windowDays, validSpend, validSpend >= minWindow]);
          }
        }
        levelResult = await syncMemberLevel(c, dto.memberId);
      }

      // V4.14.1 消费后奖励：满阈值发购物券/登记赠品（事务内，失败不阻断收银）
      let rewards: any[] = [];
      if (dto.memberId) {
        try { rewards = await grantPostCheckoutRewards(c, user.storeId, Number(dto.memberId), payable, orderId, user.sub); } catch { rewards = []; }
      }

      await audit(user.storeId, operatorId, '收银',
        dto.isEmergency ? 'sale.checkout.emergency' : dto.selfCheckout ? 'sale.checkout.self' : 'sale.checkout',
        'sales_order', orderId, { orderNo, payable, costTotal, profit, validSpend, levelDiscount: levelDiscountTotal,
          promoAmount: promo.promoAmount, orderPromoId: promo.orderPromoId, channel: dto.channel || '收银台',
          deliveryFee, tableId: tableId ?? undefined, tableName: tableName ?? undefined });

      // 决策④：负库存挂起标记——软模式差额不再静默；negativeHold/pendingShortages 供收银端提示与盘点工作台拉取
      const negLines = lines.filter((l: any) => l.shortage);

      // ── 6. 上行入队（V5.0.0 批次4A）：与业务【同事务】，崩溃/断电也不丢数据（方案 §4.3.1）。
      //    总部/单店节点（node_role='hq'）内部 no-op，sync_outbox 恒空 = 单店零回归。
      //    队列表异常时让它抛出 → 与业务一起回滚（保持「业务成功 ⇔ 变更入队」原子性）。
      let memberCard: string | null = null;
      if (dto.memberId) {
        const mc = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
        memberCard = mc[0]?.card_no ?? null;
      }
      // 批次5（M5-5）：活跃窗口快照随单上行（分红资格判定窗口总部可见）
      let windowSnap: any = null;
      if (dto.memberId) {
        windowSnap = (await cx(c,
          `SELECT window_start, window_end, valid_total, qualified FROM member_activity_windows
            WHERE member_id=$1 ORDER BY id DESC LIMIT 1`, [dto.memberId]))[0] ?? null;
      }
      // ── P2-2（§4.2 明细链补齐）：逐批出库明细随单上行（批次号跨库对齐，总部落 sync_sale_batches 对账）──
      const batchIds = [...new Set(lines.flatMap((ln: any) => (ln.allocs ?? []).map((a: any) => Number(a.batchId))))].filter(Boolean);
      const bnoMap = new Map<number, string>();
      if (batchIds.length) {
        for (const r of await cx(c, `SELECT id, batch_no FROM batches WHERE id = ANY($1::bigint[])`, [batchIds])) {
          bnoMap.set(Number(r.id), String(r.batch_no));
        }
      }
      await enqueueSync(c, 'sale_order', orderId, {
        orderNo, channel: dto.channel || '收银台', payable, goodsAmount,
        costAmount: costTotal, profit, roundAmount, orderDiscount: orderDiscountCents / 100,
        deliveryFee, remark: dto.remark ?? null, isEmergency: !!dto.isEmergency,
        memberCard, shiftNo: shiftId ?? null, createdAt: new Date().toISOString(),
        pointsEarned, validSpend,   // 批次5（M5-5）：总部累加积分/total_consume（R4 连锁累计）
        items: lines.map((ln: any) => ({
          goodsNo: ln.p.goods_no, barcode: ln.p.barcode ?? '', name: ln.p.name,
          unitName: ln.unitName, qty: ln.baseQty, unitPrice: ln.unitPrice,
          lineAmount: ln.lineAmount, lineCost: ln.lineCost,
          batches: (ln.allocs ?? []).map((a: any) => ({
            batchNo: bnoMap.get(Number(a.batchId)) ?? '', qty: a.qty, unitCost: a.cost,
          })).filter((x: any) => x.batchNo),
        })),
        payments: payLog,
      });

      return { orderId, orderNo, goodsAmount, promoAmount: promo.promoAmount, couponAmount, payable, costTotal, profit,
               roundAmount, orderDiscount: orderDiscountCents / 100, shiftId, points: dto.memberId ? pointsEarned : 0, validSpend, level: levelResult, rewards,
               tableId: tableId ?? undefined, tableName: tableName ?? undefined,
               negativeHold: negLines.length > 0,
               pendingShortages: negLines.map((l: any) => ({ productId: Number(l.p.id), name: l.p.name, qty: l.shortage.qty, basis: l.shortage.basis })) };
    });
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
  async pickingList(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return q(
      `SELECT o.id, o.order_no, o.channel, o.pickup_mode, o.created_at, o.picking_status,
              o.payable_amount, o.member_id,
              (SELECT count(*) FROM sale_items i WHERE i.order_id = o.id)::int AS item_count,
              m.name AS member_name, m.phone
         FROM sales_orders o LEFT JOIN members m ON m.id = o.member_id
        WHERE o.store_id=$1 AND o.status='已完成'
          AND o.channel IN ('小程序','H5','外卖','大客户团购')
          AND ($2::text IS NULL OR o.picking_status = $2)
        ORDER BY o.id DESC LIMIT 100`,
      [user.storeId, status || null]);
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
