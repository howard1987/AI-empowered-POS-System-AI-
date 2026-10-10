import { q } from '../common/db';
/**
 * 高危操作留痕（V5.0.19e · 2026-10-09 事故加固）
 *
 * 背景：业务库被清空（1893 单 → 0）后，audit_logs 里查不到任何「系统初始化」留痕，
 *       无法追溯是谁、何时、清了什么 —— 因为清库本身会把 audit_logs 一起清掉，
 *       而补写留痕又依赖 audit_logs 这张「会被自己清掉」的表。
 *
 * 方案：高危操作（清库 reset / 恢复 restore）额外写一张**独立且不可删**的
 *       data_reset_history（迁移 195 建表，带禁止 UPDATE/DELETE 规则，且不在任何清空清单内）。
 *       写入失败只告警不中断业务（但清库场景由调用方在清库前校验写入成功）。
 *
 * ⚠ 为什么单独一个文件：admin.reset 需要调用 admin.backup 的 doBackup，
 *   而 admin.backup 的恢复接口又需要写本留痕 —— 互相 import 会形成循环依赖，
 *   故把留痕抽成两侧都可安全引用的零依赖模块。
 */
export interface DangerLog {
  op: 'reset' | 'restore';
  storeId?: number | null;
  employeeId?: number | null;
  empNo?: string | null;
  empName?: string | null;
  ip?: string | null;
  keep?: string[];
  clearGroups?: string[];
  tables?: number;
  rowsCleared?: number;
  backupName?: string | null;   // 执行前自动备份目录名（唯一可回滚凭据）
  detail?: any;
}

/** 写入高危操作史。返回是否成功（清库前必须校验：写不进留痕就拒绝清库）。 */
export async function logDangerousOp(l: DangerLog): Promise<boolean> {
  try {
    await q(
      `INSERT INTO data_reset_history
         (op, store_id, employee_id, emp_no, emp_name, ip, keep, clear_groups,
          tables, rows_cleared, backup_name, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12::jsonb)`,
      [l.op, l.storeId ?? null, l.employeeId ?? null, l.empNo ?? null, l.empName ?? null, l.ip ?? null,
       l.keep ?? [], l.clearGroups ?? [], l.tables ?? 0, l.rowsCleared ?? 0, l.backupName ?? null,
       l.detail ? JSON.stringify(l.detail) : null]);
    console.log(`[高危操作留痕] ${l.op} 已记入 data_reset_history（备份=${l.backupName || '无'}，清空 ${l.rowsCleared ?? 0} 行）`);
    return true;
  } catch (e: any) {
    console.error(`[高危操作留痕失败] ${l.op}: ${e?.message || e}`);
    return false;
  }
}
