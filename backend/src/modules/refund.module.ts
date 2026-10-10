import { Module, Controller, Get, Post, Body, Param, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, r2, r3, audit, seqLock } from '../common/db';
import { BizException } from '../common/http';

/** Q-05：资金降级路径留痕（2026-10-10）
 *  退款链路有多处「失败不阻断退货」的降级分支（促销重算、积分回补/冲减、时限配置解析）。
 *  降级语义本身是对的（宁可少退也不能卡住退货），但原先 `catch {}` 把异常完全吞掉：
 *  金额口径悄悄变化无从排查 —— 顾客投诉"退少了"时日志里一片空白。
 *  现在：降级行为保持不变（照样不阻断），但必须写一条带单号上下文的 WARN。 */
function degrade(tag: string, ctx: Record<string, any>, e: any): void {
  try {
    console.warn(`[资金降级] ${tag} | ctx=${JSON.stringify(ctx).slice(0, 200)} | err=${String(e?.message ?? e).slice(0, 200)}`);
  } catch { /* 留痕本身绝不能影响业务 */ }
}
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { PayGatewayService } from './pay.gateway';
import { enqueueSync } from '../common/outbox';            // V5.0.0 批次4A：同事务上行入队
import { SyncStoreService } from './sync-store.service';   // V5.0.0：事件触发立即推送
import { isChainStoreNode, hqMemberPost } from './member-chain.module'; // V5.0.0 批次5：会员资产权威账本在总部（R3/R4）
import { applyPromotions } from './promotions.module';  // V5.0.15：退款时重算促销活动
import { apportionRefundCents, apportionRefundByChannel } from './refund.pure';   // Q-02：退款分摊纯函数（单测锁行为）
import { memberGrowth } from './member-growth.service';   // V5.0.17：退货扣回成长值
import { syncMemberLevel } from './members.module';         // V5.0.17：扣减后重判等级（保级/缓冲）

/** 元→分（RV-01 按分计算；与 sales.module 同一定义） */
const toCents = (yuan: number | string): number => Math.round(Number(yuan) * 100);

/** L-19（拍板 2026-10-09）：退款金额行级重算——单店/跨店退货共用同一口径。
 *  订单级净额：退前剩余实付（实付−已退）− 退后应收（剩余商品重跑促销 + 券不回退同额抵扣 + 抹零重算），
 *  再按「退货数量×成交单价」权重分摊到行（尾差进最后一行）。跨店退货在总部侧复用本函数（applyPromotions 按原单 store_id 取活动）。 */
export async function calcRefundRows(c: any, settings: SettingsService, order: any, items: { saleItemId: number; qty: number; line: any }[]) {
    // 本单之前已退（按行）
    const prevByLine = new Map<number, number>();
    const prevRows = await cx(c,
      `SELECT ri.sale_item_id, COALESCE(SUM(ri.qty),0) AS n
         FROM sale_refund_items ri JOIN sale_refunds r ON r.id = ri.refund_id
        WHERE r.order_id=$1 AND r.status IN ('已退款','待审核','创建中')
        GROUP BY ri.sale_item_id`, [order.id]);
    for (const r of prevRows) prevByLine.set(Number(r.sale_item_id), Number(r.n));
    // 本单之前已退金额（用于计算「退前剩余实付」）
    const prevAmt = await cx(c,
      `SELECT COALESCE(SUM(amount),0) AS n FROM sale_refunds
        WHERE order_id=$1 AND status IN ('待审核','创建中')`, [order.id]);
    // R-NEW-2（2026-10-10 验收修复）：L-09 回冲后 payable_amount 是净额，「已退款」已从中扣除；
    // 基数只扣未回冲（待审核/创建中），否则二次退款被双重扣减恒算 0 → 40003 拒退。
    const prevRefundCents = toCents(Number(prevAmt[0]?.n || 0));

    const thisBack = new Map<number, number>();
    for (const it of items) thisBack.set(Number(it.saleItemId), Number(it.qty));

    // 原单全部明细 + 商品信息（用于重建剩余商品并重算促销）
    const rows = await cx(c,
      `SELECT si.id, si.product_id, si.qty, si.unit_price, si.origin_price,
              p.sell_price, p.category_id, p.name, p.barcode, p.member_price,
              p.member_discount, p.min_price, p.min_discount_rate
         FROM sale_items si JOIN products p ON p.id = si.product_id
        WHERE si.order_id=$1`, [order.id]);

    // 构造「退后剩余」行
    const lines: any[] = [];
    let remainGoodsCents = 0;
    for (const row of rows) {
      const already = prevByLine.get(Number(row.id)) || 0;
      const back = thisBack.get(Number(row.id)) || 0;
      const remain = Number(row.qty) - already - back;
      if (remain <= 0) continue;
      lines.push({
        p: {
          id: row.product_id, category_id: row.category_id, sell_price: row.sell_price,
          name: row.name, barcode: row.barcode, member_price: row.member_price,
          member_discount: row.member_discount, min_price: row.min_price,
          min_discount_rate: row.min_discount_rate,
        },
        baseQty: remain,
        unitPrice: Number(row.unit_price),
        originPrice: Number(row.origin_price),
        lineAmount: Number(row.unit_price) * remain,
      });
      remainGoodsCents += Math.round(Number(row.unit_price) * remain * 100);
    }

    // 重算促销：退后不满足门槛则促销归零
    let newPromoCents = 0;
    if (lines.length) {
      try {
        const promo = await applyPromotions(c, order.store_id, lines, order.member_id);
        newPromoCents = toCents(Number(promo?.promoAmount || 0));
      } catch (e) {   // Q-05：降级保留（按无促销→保守少退），但必须留痕
        degrade('促销重算失败，按无促销处理（保守少退）', { orderNo: order.order_no }, e);
      }
      newPromoCents = Math.min(newPromoCents, remainGoodsCents);
    }

    // 券不回退：券额在两边同额抵扣
    const couponCents = toCents(order.coupon_amount);

    // 抹零按退后应收重算
    const roundRule = String((await settings.getVal('pos.round_rule')) ?? '分');
    const roundUnitC: Record<string, number> = { '分': 1, '角': 10, '5角': 50, '元': 100 };
    const ruc = roundUnitC[roundRule] || 1;
    let afterPayableCents = Math.max(remainGoodsCents - newPromoCents - couponCents, 0);
    if (ruc > 1 && afterPayableCents > 0) afterPayableCents -= (afterPayableCents % ruc);

    // 退前剩余实付 − 退后应收 = 应退
    const basePaidCents = toCents(order.payable_amount) - prevRefundCents;
    let amountCents = Math.max(basePaidCents - afterPayableCents, 0);

    // 按行分摊：以「退货数量 × 成交单价」为权重，尾差进最后一行
    // Q-02：抽至 refund.pure.apportionRefundCents（纯函数+单测锁行为）
    const weights = items.map(it => Number(it.qty) * Number(it.line.unit_price || 0));
    const rowCents = apportionRefundCents(weights, amountCents);

    return { rowAmts: rowCents.map(x => x / 100), amount: amountCents / 100 };
  }

/**
 * 销售退款闭环（方案 5.2.6 售后 / sale_refunds 表 001 基线 + 008 状态列）：
 *   create   按原销售明细行原路退（qty ≤ 原行 − 已退）；整单级优惠（促销/券/抹零）按行小比分摊回冲；
 *            金额 ≤ 免审限额（sales.refund.limit）→ 事务内直接执行；超过 → 「待审核」
 *   execute  退款执行（创建直退与审核通过共用）：
 *            1) restock → 按原销售批次回加（sale_item_batches 反向 + batches.remain_qty + stock_flows return_sale）
 *               ＋成本回冲（V5.0.15）：按「退回批次数量 × 该批次单位成本」同步冲减
 *               sale_items.line_cost/line_profit 与 sales_orders.cost_amount/profit_amount，
 *               并在 sale_refunds.cost_amount 留痕；不回冲会让退货后毛利虚高、分红基数失真
 *            2) 支付原路退：余额回加（本金/赠送按原流水比例拆分）/ 分红抵扣冲回 / 积分抵扣回加 / 现金扫码留痕（班次 refund_cash 冲减）
 *            3) 会员积分按退款比例扣回（消费所得积分）
 *            4) 有效消费窗口冲减（未达标窗口 valid_total 扣减，堵「退款保活跃」漏洞 5.1.16）
 *   audit    限额之上审核：通过 → 执行；驳回 → 状态「已驳回」（留痕不执行）
 * 错误码：50070 订单/退款单不存在（404）· 50071 状态不允许 · 50072 可退数量不足 · 50073 审核权限/状态机
 */

export interface RefundItemDto { saleItemId: number; qty: number; }

export class RefundService {
  private settings = new SettingsService();
  private paygw = new PayGatewayService();

  /**
   * 计算按行退款金额（V5.0.15 新口径：券不回退 + 活动重新计算）
   *
   *   ① **优惠券不回退**：券是一次性核销商品，退款既不退还券、也不回补券额。
   *      券额在「退前应实付」与「退后新应收」两边同样抵扣，差额中自然抵消。
   *   ② **促销活动重新计算**：按「退后剩余商品」重跑促销引擎 ——
   *      若退后不再满足满减门槛，则整单促销归零，按活动前实价重算。
   *      例：A50 + B30 + C15 + D10 = 105，满 100 减 5 → 实付 100；
   *          退 C(15) 后剩 90，不满足门槛 → 促销归零 → 退后应收 90 → 应退 100 − 90 = **10 元**
   *          （旧口径按货值比例回冲满减，会退约 14.29 元，等于让顾客白拿 4.29 元优惠）。
   *   ③ 抹零按退后应收重新计算（规则同 pos.round_rule）。
   *   ④ 退款金额 = 退前剩余实付 − 退后剩余应收，再按行分摊（尾差进最后一行）。
   *      「退前剩余实付」= 原实付 − 本单之前已退金额，故多次部分退款同样正确。
   */
  private async calcRows(c: any, order: any, items: { saleItemId: number; qty: number; line: any }[]) {
    return calcRefundRows(c, this.settings, order, items);
  }


  /** 退款执行（事务内）：批次回加 + 支付原路退 + 积分扣回 + 活跃窗口冲减 */
  private async executeInTx(c: any, refundId: number, user: AuthUser) {
    const rf = (await cx(c, `SELECT * FROM sale_refunds WHERE id=$1 FOR UPDATE`, [refundId]))[0];
    if (!rf) throw new BizException(50070, '退款单不存在', 404);
    if (rf.status !== '待审核' && rf.status !== '创建中') throw new BizException(50071, `退款单状态(${rf.status})不允许执行`);
    const order = (await cx(c, `SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE`, [rf.order_id]))[0];
    const _origPaidAgg = await cx(c,
      `SELECT COALESCE(SUM(amount),0) AS n FROM sale_refunds WHERE order_id=$1 AND status='已退款' AND id<>$2`, [rf.order_id, refundId]);
    // R-NEW-2：比例分母用原始成交额（净应付 + 已回冲累计），避免分母缩小导致积分/分红多扣
    const origPayable = Number(order.payable_amount) + Number(_origPaidAgg[0]?.n || 0);
    const refundRatio = origPayable > 0 ? Math.min(Number(rf.amount) / origPayable, 1) : 0;

    // P0-F4 执行前重校验：其它退款单（含待审核/创建中）与本单叠加后，行数量与单金额均不得超原单
    const rowsNow = await cx(c,
      `SELECT ri.sale_item_id, ri.qty, si.qty AS line_qty,
              (SELECT COALESCE(SUM(ri2.qty),0)
                 FROM sale_refund_items ri2 JOIN sale_refunds r2 ON r2.id = ri2.refund_id
                WHERE ri2.sale_item_id = ri.sale_item_id AND r2.id <> $2
                  AND r2.status IN ('已退款','待审核','创建中')) AS other_qty
         FROM sale_refund_items ri JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE ri.refund_id = $1`, [refundId, refundId]);
    for (const it of rowsNow) {
      if (r3(Number(it.qty) + Number(it.other_qty)) > r3(Number(it.line_qty))) {
        throw new BizException(50074,
          `明细行#${it.sale_item_id}叠加其它在途/已退款单后超出原行数量（行${it.line_qty}，他单已占${it.other_qty}，本单${it.qty}），本单不可执行`);
      }
    }
    // R-NEW-2：净额口径下「已退款」已回冲，在途累计只含待审核/创建中
    const otherAmt = (await cx(c,
      `SELECT COALESCE(SUM(amount),0) AS n FROM sale_refunds
        WHERE order_id=$1 AND id<>$2 AND status IN ('待审核','创建中')`,
      [rf.order_id, refundId]))[0];
    if (Number(otherAmt.n) + Number(rf.amount) > Number(order.payable_amount) + 0.005) {
      throw new BizException(50075,
        `订单累计退款（含在途 ${otherAmt.n} + 本单 ${rf.amount}）超出实付 ${order.payable_amount}，拒绝执行`);
    }

    // 1) 回库存：按原销售批次逐批回加（sale_item_batches 为原行批次消耗，按行销量比例拆回各批次）
    if (rf.restock) {
      const items = await cx(c,
        `SELECT ri.sale_item_id, ri.qty, sib.batch_id, sib.qty AS orig_qty, sib.unit_cost, si.qty AS line_qty, si.line_amount AS line_amount
           FROM sale_refund_items ri
           JOIN sale_items si ON si.id = ri.sale_item_id
           JOIN sale_item_batches sib ON sib.sale_item_id = si.id
          WHERE ri.refund_id=$1`, [refundId]);
      const touched = new Set<number>();
      // V5.0.15 QA-P0：退货成本回冲。此前只回加库存、不回冲成本，导致退货后
      //   sale_items.line_cost / sales_orders.cost_amount 原封不动 → 毛利虚高，
      //   而毛利同时驱动「销售明细报表(行级)」「日报/AI 脑(单级快照)」与「分红基数」，口径全部失真。
      //   这里按与回库存完全相同的分摊口径（退回批次数量 × 该批次单位成本）累计，保证两者一致。
      const costByLine = new Map<number, number>();
      const revByLine = new Map<number, number>();   // L-09：退回商品对应收入（行单价 × 退回量），与成本回冲同口径
      for (const it of items) {
        // 该批次原消耗占行销量比例 × 退款量 = 回加量
        const backQty = r3(Number(it.line_qty) > 0
          ? Number(it.qty) * Number(it.orig_qty) / Number(it.line_qty) : it.qty);
        if (backQty <= 0) continue;
        await cx(c,
          `UPDATE batches SET remain_qty = remain_qty + $2 WHERE id=$1`,
          [it.batch_id, backQty]);
        const bRow = (await cx(c, `SELECT store_id, product_id FROM batches WHERE id=$1`, [it.batch_id]))[0];
        await cx(c,
          `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, ref_type, ref_id, ref_item_id, employee_id)
           VALUES ($1,$2,$3,'入库',$4,'return_sale',$5,$6,$7)`,
          [bRow.store_id, bRow.product_id, it.batch_id, backQty, refundId, it.sale_item_id, user.sub]);
        touched.add(it.batch_id);
        const sid = Number(it.sale_item_id);
        // 成本回冲累计到行（同一 sale_item 可能横跨多个批次）
        const backCost = r3(backQty * Number(it.unit_cost));
        if (backCost > 0) costByLine.set(sid, r3((costByLine.get(sid) || 0) + backCost));
        // L-09：收入按退回量 × 行单价同额回冲（此前只冲成本不冲收入 → 全额退货后毛利=全部销售额、分红/提成基数虚高）
        const revBack = r3(Number(it.line_qty) > 0 ? backQty * Number(it.line_amount) / Number(it.line_qty) : 0);
        if (revBack > 0) revByLine.set(sid, r3((revByLine.get(sid) || 0) + revBack));
      }
      // 1.1) 行级：line_cost / line_amount 冲减 + line_profit 重算（口径与 checkout 一致：line_amount − line_cost）
      for (const [sid, backCost] of costByLine) {
        const revBack = revByLine.get(sid) || 0;
        await cx(c,
          `UPDATE sale_items
              SET line_cost = GREATEST(COALESCE(line_cost,0) - $2, 0),
                  line_amount = GREATEST(COALESCE(line_amount,0) - $3, 0),
                  line_profit = GREATEST(COALESCE(line_amount,0) - $3, 0) - GREATEST(COALESCE(line_cost,0) - $2, 0)
            WHERE id=$1`, [sid, backCost, revBack]);
      }
      // 1.2) 单级：cost_amount / payable_amount 冲减 + profit_amount 重算（口径与 checkout 一致：payable − cost）
      const totalBack = r3(Array.from(costByLine.values()).reduce((s, x) => s + x, 0));
      const totalRevBack = r3(Array.from(revByLine.values()).reduce((s, x) => s + x, 0));
      if (totalBack > 0 || totalRevBack > 0) {
        await cx(c,
          `UPDATE sales_orders
              SET cost_amount = GREATEST(COALESCE(cost_amount,0) - $2, 0),
                  payable_amount = GREATEST(COALESCE(payable_amount,0) - $3, 0),
                  profit_amount = GREATEST(COALESCE(payable_amount,0) - $3, 0) - GREATEST(COALESCE(cost_amount,0) - $2, 0)
            WHERE id=$1`, [rf.order_id, totalBack, totalRevBack]);
        await cx(c, `UPDATE sale_refunds SET cost_amount=$2 WHERE id=$1`, [refundId, totalBack]);
      }
      // 汇总即时库存（按本次涉及商品重算）
      await cx(c,
        `UPDATE inventory_current ic SET qty_total = sub.total, updated_at=now()
           FROM (SELECT b.product_id, SUM(b.remain_qty) AS total FROM batches b
                  JOIN sale_refund_items ri ON ri.refund_id=$1
                  JOIN sale_items si ON si.id = ri.sale_item_id
                 WHERE b.product_id = si.product_id AND b.store_id = $2 GROUP BY b.product_id) sub
          WHERE ic.product_id = sub.product_id AND ic.store_id=$2`, [refundId, rf.store_id]);
    }

    // 2) 支付原路退：按退款占比分摊到原单各支付渠道（RV-01 按分：逐渠道取整分，尾差进最后一行）
    const pays = await cx(c, `SELECT * FROM sale_payments WHERE order_id=$1 ORDER BY id`, [rf.order_id]);
    const backRatio = refundRatio;
    const rfCents = toCents(rf.amount);
    const memberId = order.member_id;
    // V5.0.0 批次5（R3/R4）：连锁门店节点 → 会员资产回补走总部（权威账本在总部），本地不重复记账
    const chainNode = await isChainStoreNode();
    let chainCardNo: string | null = null;
    if (chainNode && memberId) {
      const mc = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [memberId]);
      chainCardNo = mc[0]?.card_no ?? null;
    }
    // Q-02：渠道分摊抽至 refund.pure.apportionRefundByChannel（纯函数+单测；前面渠道按占比取整分，末渠道尾差兜底）
    const channelBackCents = apportionRefundByChannel(pays.map((p: any) => toCents(p.amount)), rfCents, backRatio);
    for (let i = 0; i < pays.length; i++) {
      const pay = pays[i];
      const backCents = channelBackCents[i];
      if (backCents <= 0) continue;
      const back = backCents / 100;
      if (pay.channel === '余额') {
        if (!memberId) continue;
        if (chainNode && chainCardNo) {
          // ── L-04（2026-10-10 验收修复）：余额回补原为无补偿裸调用 —— 通道成功后本地回滚即资损。
          //    与积分侧同款降级：失败不阻断退货，但必须 WARN 可追溯（V-50b 总部余额快照对账兜底）。
          try {
            await hqMemberPost('credit', { cardNo: chainCardNo, orderNo: order.order_no,
              refundNo: rf.refund_no, asset: 'balance', amount: back });
          } catch (e) {
            degrade('总部余额回补失败（不阻断退货，余额可能少回补）',
              { orderNo: order.order_no, refundNo: rf.refund_no, amount: back }, e);
          }
          continue;
        }
        // 按原流水本金/赠送比例回加（口径B 拆分一致性，按分）
        const fl = (await cx(c, `SELECT * FROM balance_flows WHERE id=$1`, [pay.balance_flow_id]))[0];
        const flAmtC = fl ? toCents(fl.amount) : 0;
        const principalCents = fl && flAmtC > 0 ? Math.round(backCents * toCents(fl.principal_part) / flAmtC) : 0;
        const giftCents = backCents - principalCents;
        const accs = await cx(c, `SELECT balance FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [memberId]);
        const afterCents = Math.round(Number(accs[0]?.balance ?? 0) * 100) + backCents;
        await cx(c,
          `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                      biz_type, ref_type, ref_id, balance_after, employee_id)
           VALUES ($1,$2,'入',$3,$4,$5,'退款','sale_refund',$6,$7,$8)`,
          [rf.store_id, memberId, back, principalCents / 100, giftCents / 100, refundId, afterCents / 100, user.sub]);
        await cx(c,
          `UPDATE member_accounts SET balance = balance + $2, principal_balance = principal_balance + $3,
                  gift_balance = gift_balance + $4, updated_at=now() WHERE member_id=$1`,
          [memberId, back, principalCents / 100, giftCents / 100]);
      } else if (pay.channel === '分红抵扣') {
        if (!memberId) continue;
        const accs = await cx(c, `SELECT dividend_balance FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [memberId]);
        await cx(c,
          `INSERT INTO dividend_records (store_id, member_id, record_type, amount, ref_type, ref_id, operator_id)
           VALUES ($1,$2,'冲回',$3,'sale_refund',$4,$5)`,
          [rf.store_id, memberId, back, refundId, user.sub]);
        await cx(c,
          `UPDATE member_accounts SET dividend_balance = dividend_balance + $2, updated_at=now() WHERE member_id=$1`,
          [memberId, back]);
      } else if (pay.channel === '积分抵扣') {
        if (!memberId) continue;
        if (chainNode && chainCardNo) {
          // ── 批次5：积分账本在总部；本地无 points_flow（连锁模式扣减在总部）→
          //    总部按原「连锁消费」流水 × 退货比例推算回补积分（推不出则跳过，不阻断退货）
          try {
            await hqMemberPost('credit', { cardNo: chainCardNo, orderNo: order.order_no,
              refundNo: rf.refund_no, asset: 'points', ratio: backRatio });
          } catch (e) {   // Q-05：降级保留（不阻断退货），但积分回补缺失必须可追溯
            degrade('总部积分回补失败（不阻断退货，积分可能少回补）',
              { orderNo: order.order_no, refundNo: rf.refund_no, ratio: backRatio }, e);
          }
          continue;
        }
        const pf = (await cx(c, `SELECT points FROM points_flows WHERE id=$1`, [pay.points_flow_id]))[0];
        const backPoints = pf ? Math.floor(Number(pf.points) * backRatio) : 0;
        if (backPoints > 0) {
          const ms = await cx(c, `SELECT points FROM members WHERE id=$1 FOR UPDATE`, [memberId]);
          await cx(c, `UPDATE members SET points = points + $2, updated_at=now() WHERE id=$1`, [memberId, backPoints]);
          await cx(c, `UPDATE member_accounts SET points = points + $2, updated_at=now() WHERE member_id=$1`, [memberId, backPoints]);
          await cx(c,
            `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
             VALUES ($1,'加',$2,'退款','sale_refund',$3,$4)`,
            [memberId, backPoints, refundId, Number(ms[0]?.points ?? 0) + backPoints]);
        }
      } else if (pay.channel === '微信' || pay.channel === '支付宝') {
        // V4.13.2 通道原路退：支付流水号能匹配网关 SUCCESS 单 → 调适配器原路退并回写
        // （微信返微信/支付宝返支付宝）；匹配不到（记账式手记流水）→ 仍走留痕
        const cents = (y: any) => Math.round(Number(y) * 100);
        // L-04 残余风险（2026-10-10 文档化）：通道退款发生在事务内 —— 本地回滚时通道已退而本地无记录，
        //        差异由 V-50b 对账兜底；两阶段化（通道退款事务外 + 回写 CAS）见验收报告 L-04 专项。
        await this.paygw.refundInTx(c, { channel: pay.channel, externalNo: pay.external_no ?? null,
          refundCents: cents(back), refundNo: rf.refund_no });
      }
      // 现金：只留痕（班次 refund_cash 按 refund_channel='现金' 冲减）
    }

    // 3) 消费所得积分按退款比例扣回
    if (memberId) {
      const earned = (await cx(c,
        `SELECT points FROM points_flows WHERE member_id=$1 AND direction='加' AND biz_type='消费'
           AND ref_type='sale' AND ref_id=$2 LIMIT 1`, [memberId, rf.order_id]))[0];
      if (earned) {
        const cut = Math.min(Math.floor(Number(earned.points) * refundRatio), Number(earned.points));
        if (cut > 0) {
          if (chainNode && chainCardNo) {
            // ── 批次5：消费所得积分冲减走总部（负数=减）；失败不阻断退货
            try {
              await hqMemberPost('credit', { cardNo: chainCardNo, orderNo: order.order_no,
                refundNo: rf.refund_no, asset: 'points', points: -cut });
              } catch (e) {   // Q-05：降级保留，但积分冲减缺失必须可追溯（否则会员多占积分）
                degrade('总部积分冲减失败（不阻断退货，积分可能未扣回）',
                  { orderNo: order.order_no, refundNo: rf.refund_no, points: -cut }, e);
              }
          } else {
          const ms = await cx(c, `SELECT points FROM members WHERE id=$1 FOR UPDATE`, [memberId]);
          await cx(c, `UPDATE members SET points = points - $2, updated_at=now() WHERE id=$1`, [memberId, cut]);
          await cx(c, `UPDATE member_accounts SET points = points - $2, updated_at=now() WHERE member_id=$1`, [memberId, cut]);
          await cx(c,
            `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
             VALUES ($1,'减',$2,'退款冲减','sale_refund',$3,$4)`,
            [memberId, cut, refundId, Math.max(Number(ms[0]?.points ?? 0) - cut, 0)]);
          }
        }
      }
      // 4) 有效消费窗口冲减 + **重新判定资格**
      //    V5.0.15 修复两个漏洞：
      //    ① 原实现只查 qualified=false 的窗口 —— 已达标窗口压根不会被冲减，
      //       会员"消费达标拿资格 → 立刻退款"仍能参加分红（真漏洞）；
      //    ② 结账侧用 `qualified = qualified OR ...` 单向置真，退款后不会回退。
      //    现改为：冲减覆盖订单日期的窗口，并按门槛**重新判定** qualified，
      //      退款后累计不足 dividend.min_window 的，取消分红资格。
      const minWindow = await this.settings.getNum('dividend.min_window', 50);
      // 日期一律交给 PG 用会话时区（Asia/Shanghai）转换，避免 JS 侧 String(Date) 拼出
      // "Wed Oct 07" 这类非法日期串导致 22P02（实测踩到）
      const winRows = await cx(c,
        `SELECT * FROM member_activity_windows
          WHERE member_id=$1
            AND ($2::timestamptz IS NULL
                 OR (window_start <= ($2::timestamptz)::date AND window_end >= ($2::timestamptz)::date))
          ORDER BY id DESC FOR UPDATE`, [memberId, order.created_at ?? null]);
      for (const win of winRows) {
        const before = Number(win.valid_total || 0);
        const after = Math.max(r2(before - before * refundRatio), 0);
        const qualified = after >= Number(minWindow);
        await cx(c,
          `UPDATE member_activity_windows SET valid_total=$2, qualified=$3, updated_at=now()
            WHERE id=$1`, [win.id, after, qualified]);
        if (Boolean(win.qualified) && !qualified) {
          await audit(rf.store_id, user.sub, '会员', 'member.window_unqualified',
            'member_activity_window', Number(win.id),
            { memberId, windowId: Number(win.id), before, after, minWindow, reason: '退款后未达活跃门槛' });
        }
      }
    }

    // ── V4.28.4 P1-11 分红回冲：退款按比例冲减该订单带来的会员分红计提 ──
    //    归属期 = 订单日次日计提的分红期（每日分红计提昨日净利；补跑容差查其后 4 天内最近一期）；
    //    冲减额 = 该会员该期计提额 × 退款占比，跨多次部分退款累计不超计提额；再以当前余额封顶
    //    （分红已花掉则冲完即止，不产生负债）。落 dividend_records('冲减'，负额) +
    //    回写 sale_refunds.dividend_reversed（字段预留至此接通）。失败不阻断退款主链路。
    let clawback = 0;
    if (order.member_id && refundRatio > 0) {
      try {
        const orderDate = order.created_at ? String(order.created_at).slice(0, 10) : '';
        if (orderDate) {
          const nd = new Date(orderDate + 'T00:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1);
          const from = nd.toISOString().slice(0, 10);
          nd.setUTCDate(nd.getUTCDate() + 4);
          const period = (await cx(c,
            `SELECT id FROM dividend_periods WHERE biz_date >= $1 AND biz_date <= $2 ORDER BY biz_date LIMIT 1`,
            [from, nd.toISOString().slice(0, 10)]))[0];
          if (period) {
            const memberId = Number(order.member_id);
            const acc = (await cx(c,
              `SELECT COALESCE(SUM(amount),0) AS s FROM dividend_records
                WHERE member_id=$1 AND period_id=$2 AND record_type='计提' AND amount > 0`,
              [memberId, Number(period.id)]))[0];
            const rev = (await cx(c,
              `SELECT COALESCE(SUM(amount),0) AS s FROM dividend_records
                WHERE member_id=$1 AND period_id=$2 AND record_type='冲减'`,
              [memberId, Number(period.id)]))[0];
            const accrued = Math.round(Number(acc.s) * 100);      // 分
            const already = -Math.round(Number(rev.s) * 100);      // 已冲减累计（存负额）
            const target = Math.round(accrued * refundRatio);
            clawback = Math.max(0, Math.min(target, accrued - already)) / 100;
            if (clawback > 0) {
              const ab = (await cx(c,
                `SELECT dividend_balance FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [memberId]))[0];
              const balance = Number(ab?.dividend_balance ?? 0);
              if (balance < clawback) clawback = Math.max(0, balance);   // 余额不足：冲到零为止
            }
            if (clawback > 0) {
              await cx(c,
                `INSERT INTO dividend_records (store_id, member_id, period_id, record_type, amount, ref_type, ref_id, operator_id, remark)
                 VALUES (${Number(rf.store_id)},$1,$2,'冲减',$3,'sale_refund',$4,$5,$6)`,
                [memberId, Number(period.id), -clawback, refundId, user.sub,
                 `退款回冲 ${String(rf.refund_no)}（占比 ${(refundRatio * 100).toFixed(1)}%）`]);
              await cx(c,
                `UPDATE member_accounts SET dividend_balance = dividend_balance - $2,
                    dividend_cumulative = dividend_cumulative - $2, updated_at = now()
                  WHERE member_id=$1`, [memberId, clawback]);
            }
          }
        }
      } catch (e: any) {
        console.error('[分红回冲] 失败（不阻断退款）：', e?.message);
        clawback = 0;
      }
    }
    // ── V5.0.17：退货按退款占比扣回成长值（扣减后触发等级保级/缓冲判定）──
    if (order.member_id) {
      try {
        const backGrowth = await memberGrowth.revokeConsume(c, {
          memberId: Number(order.member_id), orderId: Number(rf.order_id),
          refundAmount: Number(rf.amount), orderPayable: Number(order.payable_amount),
        });
        if (backGrowth > 0) await syncMemberLevel(c, Number(order.member_id));
      } catch (e: any) {
        console.error('[成长值回冲] 失败（不阻断退货）：', e?.message);
      }
    }
    await cx(c, `UPDATE sale_refunds SET status='已退款', employee_id=$2, dividend_reversed=$3 WHERE id=$1`,
      [refundId, user.sub, clawback]);

    // ── V4.13.1 支付状态机同步（CAS）：累计退款逐分比对——满额 unpaid/ paid→refunded，部分→part_refunded ──
    // V5.0.18：status 同步——此前只更新 pay_status，订单 status 永远停在「已完成」，
    //   而报表/AI/连锁按 status IN ('已退款','部分退款') 统计退款 → 恒为 0（口径与实现脱节）。
    //   现按累计退款金额同步单据状态（与 pay_status 同一判定口径）。
    const refundedAgg = await cx(c,
      `SELECT COALESCE(SUM(amount),0) AS t FROM sale_refunds WHERE order_id=$1 AND status='已退款'`, [rf.order_id]);
    const refundedSum = Math.round(Number(refundedAgg[0]?.t ?? 0) * 100);
    const payableCents = Math.round(Number(order.payable_amount) * 100);
    // R-NEW-2：净额口径满额 ⇔ 剩余净应付归零（原判定部分回冲后恒真，首笔部分退款即被误置「已退款」）
    const newOrderStatus = payableCents <= 0 ? '已退款' : '部分退款';
    if (payableCents <= 0) // R-NEW-2：满额 ⇔ 净应付归零（原 refundedSum>=净应付 在部分回冲后恒真）
      await cx(c, `UPDATE sales_orders SET pay_status='refunded', status='已退款' WHERE id=$1 AND pay_status IN ('paid','part_refunded')`, [rf.order_id]);
    else
      await cx(c, `UPDATE sales_orders SET pay_status='part_refunded', status='部分退款' WHERE id=$1 AND pay_status='paid'`, [rf.order_id]);
    // 兜底：pay_status CAS 未命中（如历史单 pay_status 异常）时仍保证 status 正确
    await cx(c, `UPDATE sales_orders SET status=$2 WHERE id=$1 AND status='已完成'`, [rf.order_id, newOrderStatus]);

    await audit(rf.store_id, user.sub, '销售', 'sale.refund.execute', 'sale_refund', refundId,
      { orderId: rf.order_id, amount: Number(rf.amount), restock: rf.restock });
    return { refundId, amount: Number(rf.amount), status: '已退款' };
  }

  /** 创建退款单（免审直退 / 超限额待审核）V4.19.0：clientRef 幂等（离线暂存补传防重，同 ref 返回原单） */
  async create(user: AuthUser, dto: { orderId: number; items: RefundItemDto[]; reason?: string; restock?: boolean; clientRef?: string }) {
    if (!dto.orderId) throw new BizException(40003, '缺少订单 ID');
    if (!Array.isArray(dto.items) || !dto.items.length) throw new BizException(40003, '退款明细不能为空');
    const restock = dto.restock !== false;
    const limit = await this.settings.getNum('sales.refund.limit', 200);

    return tx(async c => {
      // ── V4.19.0 C2 离线退货幂等：同 clientRef 重发直接返回原退款单，不重复退款 ──
      if (dto.clientRef) {
        const dup = await cx(c, `SELECT id, refund_no, amount, status FROM sale_refunds WHERE client_ref=$1`, [dto.clientRef]);
        if (dup.length) {
          const r = dup[0];
          return { refundId: Number(r.id), refundNo: r.refund_no, amount: Number(r.amount), status: r.status, dedup: true };
        }
      }
      const orders = await cx(c, `SELECT * FROM sales_orders WHERE id=$1 AND store_id=$2 FOR UPDATE`,
        [dto.orderId, user.storeId]);
      const order = orders[0];
      if (!order) throw new BizException(50070, '订单不存在', 404);
      // V5.0.18：部分退款后的订单 status 变为「部分退款」，仍需支持继续退剩余部分；
//   「已退款」（累计退满）与未完成单照旧拒绝。
if (!['已完成', '部分退款'].includes(order.status)) throw new BizException(50071, `订单状态(${order.status})不允许退款`);
      // VQA-GAP01：退货时限自原单创建日起算 N 个自然日。
      // V5.0.15：改为**逐行按商品分类**判定 —— 生鲜当天变质却仍可退 7 天不合理，
      //   百货日化本可放宽却被一并卡死。配置 refund.window_by_category（JSON：分类名 → 天数），
      //   命中商品自身分类或其父分类即采用；未命中回退 sales.refund.window_days（默认 7）。
      //   0 = 不限（沿用旧行为）。逐行判定：同一单里的百货行可退、生鲜行超期，只拒绝生鲜行。
      const defaultWin = await this.settings.getNum('sales.refund.window_days', 7);
      let catWin: Record<string, number> = {};
      try {
        const raw = await this.settings.getVal('sales.refund.window_by_category')
          ?? await this.settings.getVal('refund.window_by_category');   // 旧键兜底（迁移 166 前/未迁移库）
        const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
        if (obj && typeof obj === 'object') catWin = obj as Record<string, number>;
      } catch (e) {   // Q-05：降级保留（全部行按默认时限），但配置失效会改变可退范围，必须留痕
        degrade('退货时限分类配置解析失败，全部行按默认时限判定',
          { orderNo: order.order_no, defaultWin }, e);
      }
      const orderAgeDays = order.created_at
        ? Math.floor((Date.now() - new Date(order.created_at).getTime()) / 86400000) : 0;
      // P2-M8：赊账/挂账渠道订单走大客户对账冲减，禁止在线原路退（防止应收口径漂移）
      const creditPay = await cx(c,
        `SELECT COALESCE(SUM(amount),0) AS n FROM sale_payments WHERE order_id=$1 AND channel::text IN ('赊账','挂账')`, [dto.orderId]);
      if (Number(creditPay[0].n) > 0) throw new BizException(50076, '赊账/挂账订单请通过「大客户对账」冲减退款，不支持直接原路退（P2-M8）');

      // 行校验 + 可退数量（原行 − 已退累计）
      const its: { saleItemId: number; qty: number; line: any }[] = [];
      for (const it of dto.items) {
        const line = (await cx(c, `SELECT * FROM sale_items WHERE id=$1 AND order_id=$2`,
          [it.saleItemId, dto.orderId]))[0];
        if (!line) throw new BizException(50070, `明细行#${it.saleItemId}不属于该订单`, 404);
        const refunded = await cx(c,
          `SELECT COALESCE(SUM(ri.qty),0) AS n FROM sale_refund_items ri
             JOIN sale_refunds r ON r.id = ri.refund_id
            WHERE ri.sale_item_id=$1 AND r.status IN ('已退款','待审核','创建中')`, [it.saleItemId]);
        const refundable = r3(Number(line.qty) - Number(refunded[0].n));
        if (!(it.qty > 0) || r3(it.qty) > refundable) {
          throw new BizException(50072, `明细行#${it.saleItemId}可退数量不足（可退 ${refundable}）`);
        }
        // 逐行退货时限：按商品分类（自身分类 → 父分类 → 默认）取允许天数
        const catRow = (await cx(c,
          `SELECT c.name AS cat_name, pc.name AS parent_name
             FROM products p
             LEFT JOIN categories c  ON c.id = p.category_id
             LEFT JOIN categories pc ON pc.id = c.parent_id
            WHERE p.id=$1`, [line.product_id]))[0] ?? {};
        const win = Number(catWin[String(catRow.cat_name ?? '')]
          ?? catWin[String(catRow.parent_name ?? '')]
          ?? defaultWin) || 0;
        if (win > 0 && orderAgeDays > win) {
          const catLabel = String(catRow.cat_name || catRow.parent_name || '默认');
          throw new BizException(50077,
            `「${catLabel}」类商品退货时限 ${win} 天，原单创建于 ${orderAgeDays} 天前已超期；生鲜等短保商品请走报损/对账通道`, 400);
        }
        its.push({ saleItemId: it.saleItemId, qty: r3(it.qty), line });
      }

      // 单号 + 金额
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const seq = await seqLock(c, 'sale_refunds', 'refund_no', `TK-${ymd}-%`);
      const refundNo = `TK-${ymd}-${String(seq[0].n).padStart(4, '0')}`;
      // V5.0.15：calcRows 改为「券不回退 + 活动重算」口径，需要事务连接来重跑促销引擎
      const { rowAmts, amount } = await this.calcRows(c, order, its);
      if (amount <= 0) throw new BizException(40003, '退款金额计算为 0，请核对明细');

      // 主渠道：取原单金额最大支付渠道（refund_channel 供班次现金冲减判断）
      const pays = await cx(c, `SELECT channel, amount FROM sale_payments WHERE order_id=$1 ORDER BY amount DESC`, [dto.orderId]);
      const refundChannel = pays.length ? String(pays[0].channel) : '现金';

      const needsAudit = amount > limit;
      // V5.0.0 批次4B（M4-12/R9）：退货单补「三个门店字段」——同店退货业务零改动，只把字段补齐
      let sourceNode = 'LOCAL';
      try {
        const { nodeIdentity } = await import('../common/outbox');
        const nid = await nodeIdentity();
        if (nid) sourceNode = nid.nodeCode;
      } catch { /* 同步层未启用 */ }
      const rf = await cx(c,
        `INSERT INTO sale_refunds (store_id, refund_no, order_id, amount, reason, restock, employee_id, status, refund_channel, client_ref,
                                   origin_store_id, bind_store_id, is_cross_store, source_node)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$1,$1,false,$11) RETURNING id`,
        [user.storeId, refundNo, dto.orderId, amount, dto.reason ?? null, restock, user.sub,
         needsAudit ? '待审核' : '创建中', refundChannel, dto.clientRef ?? null, sourceNode]);
      const refundId = Number(rf[0].id);
      for (let i = 0; i < its.length; i++) {
        await cx(c,
          `INSERT INTO sale_refund_items (refund_id, sale_item_id, qty, amount) VALUES ($1,$2,$3,$4)`,
          [refundId, its[i].saleItemId, its[i].qty, rowAmts[i]]);
      }

      // V5.0.0 批次4A：同事务上行入队（hq/单店节点 no-op）
      await enqueueSync(c, 'sale_refund', refundId, {
        refundNo, orderNo: order.order_no, amount, reason: dto.reason ?? null, restock,
        createdAt: new Date().toISOString(),
        items: its.map((x, i) => ({ productId: Number(x.line.product_id), qty: x.qty, amount: rowAmts[i] })),
      });

      if (needsAudit) {
        await audit(user.storeId, user.sub, '销售', 'sale.refund.create', 'sale_refund', refundId,
          { orderId: dto.orderId, amount, needsAudit: true });
        return { refundId, refundNo, amount, status: '待审核', msg: `退款金额 ${amount} 超过免审限额 ${limit}，已转入审核` };
      }
      const exec = await this.executeInTx(c, refundId, user);
      return { refundId, refundNo, amount: exec.amount, status: exec.status };
    }).then(async r => { SyncStoreService.kick(); return r; });
  }

  /** 退款审核：通过 → 执行；驳回 → 留痕 */
  async auditRefund(user: AuthUser, id: number, approve: boolean) {
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM sale_refunds WHERE id=$1 FOR UPDATE`, [id]);
      const rf = rows[0];
      if (!rf) throw new BizException(50070, '退款单不存在', 404);
      if (rf.status !== '待审核') throw new BizException(50073, `退款单状态(${rf.status})不需要审核`);
      if (!approve) {
        await cx(c, `UPDATE sale_refunds SET status='已驳回', audited_by=$2 WHERE id=$1`, [id, user.sub]);
        await audit(rf.store_id, user.sub, '销售', 'sale.refund.reject', 'sale_refund', id, { amount: Number(rf.amount) });
        return { refundId: id, status: '已驳回' };
      }
      await cx(c, `UPDATE sale_refunds SET audited_by=$2 WHERE id=$1`, [id, user.sub]);
      return await this.executeInTx(c, id, user);
    }).then(async r => { SyncStoreService.kick(); return r; });
  }

  /** 退款单列表（含明细行数） */
  async list(storeId: number) {
    const rows = await q(
      `SELECT r.*, o.order_no,
              (SELECT count(*) FROM sale_refund_items ri WHERE ri.refund_id = r.id)::int AS item_count
         FROM sale_refunds r JOIN sales_orders o ON o.id = r.order_id
        WHERE r.store_id=$1 ORDER BY r.id DESC LIMIT 200`, [storeId]);
    return rows.map(r => ({
      ...r, id: Number(r.id), order_id: Number(r.order_id),
      amount: Number(r.amount), dividend_reversed: Number(r.dividend_reversed),
    }));
  }

  /** 退款单详情（含明细行） */
  async detail(storeId: number, id: number) {
    const rf = await q1<any>(
      `SELECT r.*, o.order_no FROM sale_refunds r JOIN sales_orders o ON o.id = r.order_id
        WHERE r.id=$1 AND r.store_id=$2`, [id, storeId]);
    if (!rf) throw new BizException(50070, '退款单不存在', 404);
    const items = await q(
      `SELECT ri.*, si.product_id, si.qty AS orig_qty, si.unit_price, si.line_amount
         FROM sale_refund_items ri JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE ri.refund_id=$1`, [id]);
    return { ...rf, id: Number(rf.id), order_id: Number(rf.order_id), amount: Number(rf.amount),
             items: items.map(x => ({ ...x, qty: Number(x.qty), amount: Number(x.amount) })) };
  }
}

@Controller('refunds')
class RefundController {
  private svc = new RefundService();

  /** 创建退款单（免审直退 / 超限额待审核 → 50073 审核后执行；P0-F4：挂发起退款权限点）
   *  V4.19.0：clientRef 幂等（收银台离线暂存补传，同 ref 返回原单不重复退款） */
  @RequirePerms('pos.refund.apply')
  @Post()
  async create(
    @Body() body: { orderId: number; items: RefundItemDto[]; reason?: string; restock?: boolean; clientRef?: string },
    @CurrentUser() user: AuthUser,
  ) { return this.svc.create(user, body); }

  /** 退款单列表 */
  @Get()
  async list(@CurrentUser() user: AuthUser) { return this.svc.list(user.storeId); }

  /** 退款单详情（含明细行） */
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.detail(user.storeId, id);
  }

  /** 审核（限额之上）：approve=false 驳回 / true 通过并执行 */
  @RequirePerms('sales.refund.audit')
  @Post(':id/audit')
  async audit(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { approve: boolean },
    @CurrentUser() user: AuthUser,
  ) { return this.svc.auditRefund(user, id, body.approve !== false); }
}

@Module({ controllers: [RefundController] })
export class RefundModule {}
