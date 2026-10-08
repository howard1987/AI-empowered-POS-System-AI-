import { RequirePerms } from '../common/auth';
/**
 * M4a · 智能防损看板（规则引擎：异常折扣 / 异常退货 / 收银差异）
 *   GET /ai/fraud/dashboard —— 汇总 + 收银员/供应商维度 + 近7日趋势 + 告警列表
 *   阈值可配（settings）：
 *     ai.fraud.discount_floor 异常折扣率阈值（折扣金额/原价，默认 0.3）
 *     ai.fraud.discount_n     单收银员异常折扣行最小样本数（默认 3，防误报）
 *     ai.fraud.return_floor   异常退货率阈值（退货单量/销售单量，默认 0.1）
 *     ai.fraud.cash_gap       收银差异绝对值阈值（元，默认 10）
 */
import { Controller, Get, Query } from '@nestjs/common';
import { q } from '../common/db';
import { curStore, curEmp } from '../common/context';

async function getSetting(key: string, fb: any = null): Promise<any> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
  return r.length ? r[0].value : fb;
}

const DONE = `so.status IN ('已完成','部分退款')`;

@Controller('ai/fraud')
export class FraudController {
  /** 防损看板：今日/近7日 异常折扣、近30日 退货率、收银差异、趋势、告警 */
  @RequirePerms('report.view.all')
  @Get('dashboard')
  async dashboard() {
    const floor = Number(await getSetting('ai.fraud.discount_floor', 0.3) ?? 0.3);
    const minN = Number(await getSetting('ai.fraud.discount_n', 3) ?? 3);
    const returnFloor = Number(await getSetting('ai.fraud.return_floor', 0.1) ?? 0.1);
    const cashGap = Number(await getSetting('ai.fraud.cash_gap', 10) ?? 10);

    // ── 异常折扣（近7天：手工改价 或 折扣率超阈值）──
    const disc = await q(
      `SELECT COUNT(*)::int AS lines, COUNT(DISTINCT so.id)::int AS bills,
              COALESCE(SUM((si.origin_price - si.unit_price) * si.qty),0) AS amt
         FROM sale_items si JOIN sales_orders so ON so.id = si.order_id
        WHERE so.store_id=$1 AND ${DONE} AND so.created_at >= CURRENT_DATE - 7
          AND (si.price_changed OR (si.origin_price > si.unit_price
               AND (si.origin_price - si.unit_price) / NULLIF(si.origin_price,0) > $2))`, [1, floor]);
    const discByCashier = await q(
      `SELECT so.cashier_id, COALESCE(e.name,'未知收银员') AS name, COUNT(*)::int AS lines,
              COUNT(DISTINCT so.id)::int AS bills,
              COALESCE(SUM((si.origin_price - si.unit_price) * si.qty),0) AS amt
         FROM sale_items si JOIN sales_orders so ON so.id = si.order_id
         LEFT JOIN employees e ON e.id = so.cashier_id
        WHERE so.store_id=$1 AND ${DONE} AND so.created_at >= CURRENT_DATE - 7
          AND (si.price_changed OR (si.origin_price > si.unit_price
               AND (si.origin_price - si.unit_price) / NULLIF(si.origin_price,0) > $2))
        GROUP BY so.cashier_id, e.name
       HAVING COUNT(*) >= $3 ORDER BY amt DESC LIMIT 5`, [1, floor, minN]);

    // ── 退货（近30天：销售退款率 + 采购退货按供应商 TOP）──
    const ret = await q(
      `SELECT (SELECT COUNT(*)::int FROM sale_refunds WHERE store_id=$1 AND created_at >= CURRENT_DATE - 30) AS refund_bills,
              (SELECT COALESCE(SUM(amount),0) FROM sale_refunds WHERE store_id=$1 AND created_at >= CURRENT_DATE - 30) AS refund_amt,
              (SELECT COUNT(*)::int FROM sales_orders WHERE store_id=$1 AND created_at >= CURRENT_DATE - 30 AND status='已完成') AS sale_bills`, [1]);
    const refundRate = Number(ret[0]?.sale_bills) > 0 ? Number(ret[0].refund_bills) / Number(ret[0].sale_bills) : 0;
    const retBySupplier = await q(
      `SELECT s.name, COUNT(*)::int AS bills, COALESCE(SUM(pr.total_amount),0) AS amt
         FROM purchase_returns pr JOIN suppliers s ON s.id = pr.supplier_id
        WHERE pr.store_id=$1 AND pr.created_at >= CURRENT_DATE - 30
        GROUP BY s.name ORDER BY bills DESC LIMIT 5`, [1]);

    // ── 收银差异（近30天已交班，|diff| 超阈值）──
    const cash = await q(
      `SELECT sh.pos_no, COALESCE(e.name,'未知') AS name, sh.closed_at, sh.diff_amount, sh.cash_total
         FROM shifts sh LEFT JOIN employees e ON e.id = sh.cashier_id
        WHERE sh.store_id=$1 AND sh.status='已交班' AND ABS(sh.diff_amount) > $2
        ORDER BY sh.closed_at DESC LIMIT 10`, [1, cashGap]);

    // ── 近7日趋势（每日：异常折扣行 / 退款单 / 收银差异单）──
    const trend = await q(
      `SELECT d::date AS d,
              (SELECT COUNT(*)::int FROM sale_items si JOIN sales_orders so ON so.id=si.order_id
                WHERE so.store_id=$1 AND ${DONE} AND COALESCE(so.pay_paid_at, so.created_at)::date=d
                  AND (si.price_changed OR (si.origin_price > si.unit_price
                       AND (si.origin_price - si.unit_price) / NULLIF(si.origin_price,0) > $2))) AS disc_lines,
              (SELECT COUNT(*)::int FROM sale_refunds WHERE store_id=$1 AND created_at::date=d) AS refund_bills,
              (SELECT COUNT(*)::int FROM shifts WHERE store_id=$1 AND status='已交班' AND opened_at::date=d AND ABS(diff_amount) > $3) AS cash_gaps
         FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, interval '1 day') d`, [1, floor, cashGap]);

    // ── 告警列表 ──
    const alerts: any[] = [];
    if (Number(disc[0]?.lines) > 0) alerts.push({
      type: 'discount', level: Number(disc[0].lines) >= minN * 2 ? 'high' : 'medium',
      title: `近7天异常折扣 ${disc[0].lines} 行 / ${disc[0].bills} 单`,
      detail: `合计让利 ¥${Number(disc[0].amt).toFixed(2)}（阈值：折扣率 > ${floor * 100}% 或手工改价）`,
    });
    if (refundRate > returnFloor) alerts.push({
      type: 'return', level: 'high',
      title: `近30天退货率 ${(refundRate * 100).toFixed(1)}% 超阈值`,
      detail: `退款 ${ret[0]?.refund_bills ?? 0} 单 / ¥${Number(ret[0]?.refund_amt ?? 0).toFixed(2)}（阈值：> ${returnFloor * 100}%）`,
    });
    if (cash.length) alerts.push({
      type: 'cashgap', level: cash.some(c => Math.abs(Number(c.diff_amount)) >= cashGap * 3) ? 'high' : 'medium',
      title: `近30天 ${cash.length} 个班次收银差异超 ¥${cashGap}`,
      detail: cash.slice(0, 3).map(c => `${c.name}(${c.pos_no}) ${Number(c.diff_amount).toFixed(2)}`).join('、'),
    });

    return {
      thresholds: { discountFloor: floor, minN, returnFloor, cashGap },
      summary: {
        discLines: Number(disc[0]?.lines ?? 0), discBills: Number(disc[0]?.bills ?? 0),
        discAmt: Number(disc[0]?.amt ?? 0),
        refundBills: Number(ret[0]?.refund_bills ?? 0), refundAmt: Number(ret[0]?.refund_amt ?? 0),
        refundRate, cashGapCount: cash.length,
      },
      byCashier: discByCashier.map(r => ({ cashierId: r.cashier_id, name: r.name, lines: Number(r.lines), bills: Number(r.bills), amt: Number(r.amt) })),
      bySupplier: retBySupplier.map(r => ({ supplier: r.name, bills: Number(r.bills), amt: Number(r.amt) })),
      cashGaps: cash.map(c => ({ posNo: c.pos_no, name: c.name, closedAt: c.closed_at, diff: Number(c.diff_amount), cashTotal: Number(c.cash_total) })),
      trend: trend.map(t => ({ date: t.d, discLines: Number(t.disc_lines), refundBills: Number(t.refund_bills), cashGaps: Number(t.cash_gaps) })),
      alerts,
    };
  }

  /** ── V4.14.0 L：防损下钻——异常折扣单（近 N 天，点击单号可查订单详情） ── */
  @RequirePerms('report.view.all')
  @Get('disc-orders')
  async discOrders(@Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 7, 1), 90);
    const floor = Number(await getSetting('ai.fraud.discount_floor', 0.3) ?? 0.3);
    return { items: await q(
      `SELECT so.id, so.order_no, e.name AS cashier_name, so.created_at, so.payable_amount,
              COUNT(*)::int AS disc_lines,
              ROUND(COALESCE(SUM((si.origin_price - si.unit_price) * si.qty),0),2) AS disc_amt
         FROM sale_items si JOIN sales_orders so ON so.id = si.order_id
         LEFT JOIN employees e ON e.id = so.cashier_id
        WHERE so.store_id=${curStore()} AND ${DONE} AND so.created_at >= CURRENT_DATE - $1::int
          AND (si.price_changed OR (si.origin_price > si.unit_price
               AND (si.origin_price - si.unit_price) / NULLIF(si.origin_price,0) > $2))
        GROUP BY so.id, e.name
        ORDER BY so.id DESC LIMIT 50`, [d, floor]) };
  }

  /** 防损下钻——退款单（近 N 天，orderId 可跳订单详情） */
  @RequirePerms('report.view.all')
  @Get('refund-orders')
  async refundOrders(@Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return { items: await q(
      `SELECT rf.id, rf.amount, rf.status, rf.reason, rf.created_at,
              so.id AS order_id, so.order_no, so.payable_amount, e.name AS cashier_name
         FROM sale_refunds rf JOIN sales_orders so ON so.id = rf.order_id
         LEFT JOIN employees e ON e.id = so.cashier_id
        WHERE rf.store_id=${curStore()} AND rf.created_at >= CURRENT_DATE - $1::int
        ORDER BY rf.id DESC LIMIT 50`, [d]) };
  }

  /** 防损下钻——采购退货单（按供应商近 N 天，docId 可跳退货单详情） */
  @RequirePerms('report.view.all')
  @Get('return-orders')
  async returnOrders(@Query('supplier') supplier?: string, @Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    const kw = (supplier || '').trim();
    return { items: await q(
      `SELECT pr.id, pr.return_no, pr.total_amount, pr.status, pr.created_at, s.name AS supplier_name,
              (SELECT count(*) FROM purchase_return_items i WHERE i.return_id = pr.id)::int AS item_count
         FROM purchase_returns pr JOIN suppliers s ON s.id = pr.supplier_id
        WHERE pr.store_id=${curStore()} AND pr.created_at >= CURRENT_DATE - $1::int
          AND ($2 = '' OR s.name = $2)
        ORDER BY pr.id DESC LIMIT 50`, [d, kw]) };
  }
}
