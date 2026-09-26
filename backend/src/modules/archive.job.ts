/**
 * V4.28.5 🟠-3 流水/日志归档任务
 *
 * 背景：stock_flows（每笔销售逐行写流水）与 ai_recognition_logs（识别期间 1.6s/帧持续写入）是
 * 系统增长最快的两张表，主表无限膨胀会拖慢库存查询、盘点、难例挖掘。审计日志（audit_logs）的
 * 归档在 123/d3.care.ts 已落地，本模块补齐另两张表，同一口径：
 *   · 每日 03:40 执行（收银闲时）；按 settings 月数保留热数据，0=该表不归档
 *   · 批次事务迁移：DELETE ... RETURNING → INSERT archive（单语句原子，锁窗口 = 批大小）
 *   · 每夜单表上限 100 万行（防首次归档长事务），剩余次日继续追
 *   · 幂等：迁移行 id 不变，归档表不重复（同 id 只会迁移一次——主表删了就不会再选中）
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { q, q1 } from '../common/db';

const BATCH = 5_000;
const MAX_BATCHES_PER_RUN = 200;   // 单表单夜上限 100 万行

/** 单表归档一轮：返回迁移行数 */
async function archiveTable(table: string, archive: string, columns: string[], cutoff: string): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const r: any = await q(
      `WITH victim AS (
         SELECT id FROM ${table} WHERE created_at < $1 ORDER BY id LIMIT ${BATCH}
       ), moved AS (
         DELETE FROM ${table} v USING victim WHERE v.id = victim.id RETURNING v.*
       )
       INSERT INTO ${archive} (${columns.join(',')}, archived_at)
       SELECT ${columns.join(',')}, now() FROM moved RETURNING id`,
      [cutoff]);
    const moved = r.length || 0;
    total += moved;
    if (moved < BATCH) break;
  }
  return total;
}

const FLOW_COLS = ['id', 'store_id', 'product_id', 'batch_id', 'direction', 'qty', 'unit_cost',
  'ref_type', 'ref_id', 'ref_item_id', 'employee_id', 'created_at'];
const RECOG_COLS = ['id', 'store_id', 'device_id', 'image_path', 'raw_result', 'used_fallback',
  'fallback_model', 'corrected', 'corrected_json', 'order_id', 'latency_ms', 'created_at'];

/** 执行一轮归档（手动触发 / 定时共用） */
export async function runArchiveOnce(): Promise<any> {
  const out: any = { ranAt: new Date().toISOString(), tables: {} };
  const flowRow = await q1(`SELECT value FROM system_settings WHERE setting_key='ops.archive.flow_months'`);
  const flowMonths = Number(flowRow?.value ?? 12) || 0;
  if (flowMonths > 0) {
    const n = await archiveTable('stock_flows', 'stock_flows_archive', FLOW_COLS,
      new Date(Date.now() - flowMonths * 30 * 86400_000).toISOString());
    out.tables.stock_flows = { months: flowMonths, moved: n };
    if (n > 0) console.log(`[归档] stock_flows 迁移 ${n} 行 → stock_flows_archive（保留 ${flowMonths} 个月）`);
  }
  const recogRow = await q1(`SELECT value FROM system_settings WHERE setting_key='ops.archive.recog_months'`);
  const recogMonths = Number(recogRow?.value ?? 6) || 0;
  if (recogMonths > 0) {
    const n = await archiveTable('ai_recognition_logs', 'ai_recognition_logs_archive', RECOG_COLS,
      new Date(Date.now() - recogMonths * 30 * 86400_000).toISOString());
    out.tables.ai_recognition_logs = { months: recogMonths, moved: n };
    if (n > 0) console.log(`[归档] ai_recognition_logs 迁移 ${n} 行 → ai_recognition_logs_archive（保留 ${recogMonths} 个月）`);
  }
  return out;
}

@Injectable()
export class ArchiveJob implements OnModuleInit, OnModuleDestroy {
  private timer: any;
  private lastRunDay = '';
  onModuleInit() {
    this.timer = setInterval(() => {
      try {
        const now = new Date();
        if (now.getHours() !== 3 || now.getMinutes() < 40 || this.lastRunDay === now.toISOString().slice(0, 10)) return;
        this.lastRunDay = now.toISOString().slice(0, 10);
        runArchiveOnce().catch((e: any) => console.error('[归档] 执行失败（不影响业务）:', e?.message));
      } catch { /* 静默：归档绝不影响收银 */ }
    }, 60_000);
    console.log('[归档] 流水/识别日志归档定时器已启动（每日 03:40，ops.archive.* 可配月数/关闭）');
  }
  onModuleDestroy() { clearInterval(this.timer); }
}
