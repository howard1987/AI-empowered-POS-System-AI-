import { Injectable, OnModuleInit, OnModuleDestroy, Module } from '@nestjs/common';
import { pool, q, q1, tx, cx, audit, r2 } from '../common/db';
import { SettingsService } from './settings.module';
import { notifyStaff } from '../common/notices';
import { sumHardCostMonthly } from './dividend.module';
import { cleanupAuditLogs, runOpeningNotice } from './d3.care'; // VQA-D3：审计保留期清理 + 开业日广播

/**
 * 销售侧定时任务（V4.14.2，零依赖 setInterval，模式同 marketing/aibrain）：
 *
 *  ① RV-03/05 关单补偿：状态「待付款」（USERPAYING/在线单未回支付结果）且超时的订单，
 *     若关联支付单非 PENDING/SUCCESS（确认未支付），关单为「已取消」并回冲批次/库存流水（ref_type='close' 留痕）。
 *     超时分钟数取设置 sales.close_order_minutes（默认 5，0=关闭该 job）。
 *
 *  ② RV-09 日结快照：每日 00:05 固化**昨日**汇总（单数/现金/扫码/余额/分红抵扣/毛利/差异）
 *     落 daily_settlement（按 settle_date 唯一，重跑不重复），防止事后补单影响历史报表；
 *     同时按批次口径重算 inventory_current（RV-04 汇总表漂移校准）。
 */

@Injectable()
export class SalesJobsService implements OnModuleInit, OnModuleDestroy {
  private settings = new SettingsService();
  private timer: any;
  private lastCloseRun = '';   // 关单去重（每分钟一次即可，按 minute key）
  private lastSettleRun = '';  // 日结去重（按日期）
  private lastCareRun = '';      // VQA-D3 每日治理去重（按日期）

  onModuleInit() {
    this.timer = setInterval(() => {
      this.runCloseOrders().catch(e => { console.error('[关单job] 执行失败:', e.message); try { notifyStaff(1, 'job_error', `[关单job] ${String(e.message).slice(0, 140)}`, {}, 'sys.settings', 'job:关单').catch(() => { }); } catch { } });
      this.maybeDailySettle().catch(e => { console.error('[日结job] 执行失败:', e.message); try { notifyStaff(1, 'job_error', `[日结job] ${String(e.message).slice(0, 140)}`, {}, 'sys.settings', 'job:日结').catch(() => { }); } catch { } });
      this.maybeDailyCare().catch(e => { console.error('[D3治理job] 执行失败:', e.message); try { notifyStaff(1, 'job_error', `[D3治理job] ${String(e.message).slice(0, 140)}`, {}, 'sys.settings', 'job:D3治理').catch(() => { }); } catch { } });
    }, 60_000);
    // VQA-P0 补偿：服务（重）启动即补齐昨日快照——00:05 窗口错过也能追平，settle_date 唯一幂等
    this.maybeDailySettle(true).catch(e => { console.error('[日结job] 启动补偿失败:', e.message); try { notifyStaff(1, 'job_error', `[日结job/启动补偿] ${String(e.message).slice(0, 140)}`, {}, 'sys.settings', 'job:日结boot').catch(() => { }); } catch { } });
    // VQA-D3：开业日广播补跑（batch_key 幂等，重复启动不重发）
    runOpeningNotice().catch(e => { console.error('[开业广播] 失败:', e.message); });
    console.log('[销售jobs] 关单补偿 + 日结快照 + D3治理 定时器已启动（每分钟检查）');
  }
  onModuleDestroy() { clearInterval(this.timer); }

  /** ③ VQA-D3 每日治理窗口（00:10 后首个 tick）：审计日志超期归档清理 */
  private async maybeDailyCare() {
    const now = new Date();
    if (now.getHours() !== 0 || now.getMinutes() < 10) return;
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (this.lastCareRun === dayKey) return;
    this.lastCareRun = dayKey;
    const r = await cleanupAuditLogs();
    if (!r.skipped && r.moved) console.log(`[D3治理] 审计日志归档清理 ${r.moved} 行`);
  }

  /** ① 关单补偿 */
  private async runCloseOrders() {
    const minutes = await SettingsService.cachedNum('sales.close_order_minutes', 5);
    if (!(minutes > 0)) return;   // 0 = 关闭该 job
    const minuteKey = new Date().toISOString().slice(0, 16);
    if (this.lastCloseRun === minuteKey) return;
    this.lastCloseRun = minuteKey;

    const candidates = await q(
      `SELECT o.id, o.order_no, o.store_id, o.created_at
         FROM sales_orders o
        WHERE o.status = '待付款' AND o.created_at < now() - ($1 || ' minutes')::interval
        ORDER BY o.id LIMIT 50`, [String(minutes)]);
    for (const o of candidates) {
      try {
        await closeOneOrder(o.id, o.store_id, o.order_no, minutes);
      } catch (e) { console.error(`[关单job] 订单#${o.id} 关单失败:`, e.message); }
    }
    if (candidates.length) console.log(`[关单job] 本轮关单 ${candidates.length} 单（超时 ${minutes} 分钟）`);
  }

  /** ② 日结快照（昨日）+ inventory_current 校准 */
  /** force=true：启动补偿，跳过 00:05 窗口（仍受 settle_date 唯一幂等保护） */
  private async maybeDailySettle(force = false) {
    const now = new Date();
    if (!force && (now.getHours() !== 0 || now.getMinutes() < 5)) return;   // 每日 00:05 后首个 tick
    const dayKey = now.toISOString().slice(0, 10);
    if (this.lastSettleRun === dayKey) return;
    this.lastSettleRun = dayKey;

    const exists = await q1(`SELECT id FROM daily_settlement WHERE settle_date = CURRENT_DATE - 1`);
    if (exists && !force) return;
    await q(`INSERT INTO daily_settlement
              (settle_date, store_id, order_count, cash_amount, scan_amount, balance_amount,
               dividend_amount, points_amount, sales_total, cost_total, profit_total, detail)
              SELECT CURRENT_DATE - 1, store_id,
                     count(*)::int,
                     COALESCE(SUM(cash),0), COALESCE(SUM(scan),0), COALESCE(SUM(balance),0),
                     COALESCE(SUM(dividend),0), COALESCE(SUM(points),0),
                     COALESCE(SUM(payable_amount),0), COALESCE(SUM(cost_amount),0), COALESCE(SUM(profit_amount),0),
                     MAX(det.detail::text)::jsonb
                FROM sales_orders o
                LEFT JOIN LATERAL (
                  SELECT COALESCE(SUM(amount) FILTER (WHERE channel='现金'),0) AS cash,
                         COALESCE(SUM(amount) FILTER (WHERE channel IN ('微信','支付宝')),0) AS scan,
                         COALESCE(SUM(amount) FILTER (WHERE channel IN ('余额','预存余额')),0) AS balance,
                         COALESCE(SUM(amount) FILTER (WHERE channel='分红抵扣'),0) AS dividend,
                         COALESCE(SUM(amount) FILTER (WHERE channel IN ('积分','积分抵扣')),0) AS points,
                         jsonb_object_agg(channel, amount) AS detail
                    FROM sale_payments sp WHERE sp.order_id = o.id AND sp.amount <> 0
                ) pay ON true
                LEFT JOIN LATERAL (
                  SELECT jsonb_object_agg(ch.channel, ch.amt) AS detail
                    FROM (SELECT sp2.channel, SUM(sp2.amount) AS amt
                            FROM sale_payments sp2 JOIN sales_orders o3 ON o3.id = sp2.order_id
                           WHERE o3.store_id = o.store_id AND o3.status = '已完成'
                             AND o3.created_at::date = CURRENT_DATE - 1 AND sp2.amount <> 0
                           GROUP BY sp2.channel) ch
                ) det ON true
               WHERE o.status = '已完成' AND COALESCE(o.pay_paid_at, o.created_at)::date = CURRENT_DATE - 1
               GROUP BY o.store_id
               ON CONFLICT (settle_date, store_id) DO NOTHING`, []);
    // RV-04 校准：按批次口径重算汇总表（V4.14.6：修正行数留痕到 daily_settlement.stock_drift_fixed）
    const drift = await q(
      `UPDATE inventory_current c SET qty_total = b.total, updated_at = now()
         FROM (SELECT store_id, product_id, SUM(remain_qty)::numeric AS total
                 FROM batches GROUP BY store_id, product_id) b
        WHERE c.store_id = b.store_id AND c.product_id = b.product_id AND c.qty_total <> b.total
        RETURNING c.product_id`, []);
    await q(`UPDATE daily_settlement SET stock_drift_fixed=$1 WHERE settle_date=CURRENT_DATE - 1`, [drift.length]);
    // ── P3-2：净利 = 毛利 − 门店硬消耗日摊（store.cost.* 月值 ÷ 当月天数；store_settings 门店覆盖生效）──
    try {
      const yd = new Date(now); yd.setDate(yd.getDate() - 1);
      const days = new Date(yd.getFullYear(), yd.getMonth() + 1, 0).getDate() || 30;
      const monthly = await sumHardCostMonthly();
      const hard = r2(monthly / days);
      await q(`UPDATE daily_settlement SET hard_cost_daily=$1, net_profit = profit_total - $1
                WHERE settle_date = CURRENT_DATE - 1`, [hard]);
      console.log(`[日结job] 净利口径：月硬消耗 ${monthly} ÷ ${days} 天 = 日摊 ${hard}`);
    } catch (e: any) { console.error('[日结job] 净利硬消耗计算失败（不影响快照）:', e?.message); }
    console.log(`[日结job] 已固化昨日 daily_settlement 快照 + inventory_current 校准完成（漂移修正 ${drift.length} 行）`);
  }
}

/** 关单单笔：CAS 关单 + 回冲批次/库存流水（留痕 ref_type='close'） */
async function closeOneOrder(orderId: number, storeId: number, orderNo: string, minutes: number) {
  const pay = await q1(`SELECT status FROM pay_gateway_txns WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [orderId]);
  if (pay && ['PENDING', 'SUCCESS'].includes(String(pay.status))) return;   // 通道确认支付中/已支付 → 不关（走支付回调）
  await tx(async c => {
  const updated = await cx(c,
    `UPDATE sales_orders SET status='已取消', updated_at=now()
      WHERE id=$1 AND status='待付款' RETURNING id`, [orderId]);
  if (!updated.length) return;   // CAS：已被并发处理（P2-M5：取消与回冲同事务，不再出现半回冲状态）
  // 回冲批次与库存（仅该单预占过的批次）
  const rows = await cx(c,
    `SELECT sib.batch_id, sib.qty, sib.unit_cost, si.product_id
       FROM sale_item_batches sib JOIN sale_items si ON si.id = sib.sale_item_id
      WHERE si.order_id = $1`, [orderId]);
  for (const r of rows) {
    await cx(c, `UPDATE batches SET remain_qty = remain_qty + $2,
               status = CASE WHEN status='售罄' AND remain_qty + $2 > 0 THEN '在库' ELSE status END
             WHERE id = $1`, [r.batch_id, r.qty]);
    await cx(c, `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id)
             VALUES ($1,$2,$3,'入库',$4,$5,'close',$6)`, [storeId, r.product_id, r.batch_id, r.qty, r.unit_cost, orderId]);
    await cx(c, `UPDATE inventory_current SET qty_total = qty_total + $2, updated_at = now()
              WHERE store_id = $1 AND product_id = $3`, [storeId, r.qty, r.product_id]);
  }
  // V4.17.0：审计移入 CAS 成功分支（原实现在事务外引用 rows 会 ReferenceError，且 CAS 失败也误记审计）
  await audit(storeId, 1, '收银', 'sale.close.timeout', 'sales_order', orderId,
    { orderNo, timeoutMinutes: minutes, restoredLines: rows.length });
  });
}

@Module({ providers: [SalesJobsService] })
export class SalesJobsModule {}
