import { q, q1 } from '../common/db';
import { notifyStaff } from '../common/notices';
/**
 * VQA-D3 · 死键治理承载模块（d3.care）
 *   ① cleanupAuditLogs —— auth.audit_retention（审计日志保留期）此前为零引用死键：
 *      现每日 00:10 由销售 jobs 调起，超期审计行整体迁移 audit_logs_archive（迁移123 建表）后从主表删除；
 *      保留期 0 / 非法值 = 关闭清理。审计日志是合规资产，只归档不蒸发。
 *   ② runOpeningNotice —— init.opening_note（开业初始说明）此前无消费方：
 *      开业日（init.opening_date）当天向全员广播一次（notices 表，batch_key 幂等），
 *      员工端铃铛与老板端消息中心皆可见；服务启动时也补跑一次（错过 00 点窗口也能当天送达）。
 */
async function sGet(k: string): Promise<any> {
  const r = await q1<{ value: any }>(`SELECT value FROM system_settings WHERE setting_key=$1`, [k]);
  return r?.value;
}
const unq = (v: any) => String(v ?? '').replace(/"/g, '').trim();

/** ① 审计日志保留期清理：返回 { skipped?, days?, moved, batches } */
export async function cleanupAuditLogs(): Promise<{ skipped?: boolean; days?: number; moved?: number; batches?: number }> {
  const days = Number(unq(await sGet('auth.audit_retention')));
  if (!Number.isFinite(days) || days <= 0) return { skipped: true, days };
  const cut = await q1<{ t: Date }>(`SELECT (now() - ($1 || ' days')::interval) AS t`, [String(days)]);
  // P-06 修复：原单条 DELETE…RETURNING 一次搬全量（首跑几十万行） → 长事务 + WAL 洪峰，可能拖垮 DB。
  // 改为每批 LIMIT 5000 循环、每批独立小事务（PG DELETE 无 LIMIT，用 id IN (子查询 LIMIT) 实现分批）。
  const CHUNK = 5000;
  let total = 0, batches = 0;
  while (true) {
    const moved = await q(
      `WITH x AS (
           DELETE FROM audit_logs
            WHERE id IN (SELECT id FROM audit_logs WHERE created_at < $1 LIMIT $2)
           RETURNING id, store_id, employee_id, module, action, target_type, target_id, detail, ip, created_at)
       INSERT INTO audit_logs_archive (id, store_id, employee_id, module, action, target_type, target_id, detail, ip, created_at)
       SELECT * FROM x RETURNING id`, [cut!.t, CHUNK]);
    total += moved.length;
    batches++;
    if (moved.length < CHUNK) break;
  }
  if (total) console.log(`[审计清理] 迁移超期审计日志 ${total} 行 → audit_logs_archive（保留期 ${days} 天，${batches} 批）`);
  return { moved: total, batches };
}

/** ② 开业日全员广播（batch_key 幂等，同日重复调用不重发） */
export async function runOpeningNotice(): Promise<{ sent?: boolean; skipped?: boolean; reason?: string; date?: string }> {
  const note = unq(await sGet('init.opening_note'));
  if (!note) return { skipped: true, reason: '未填写开业说明' };
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const odate = unq(await sGet('init.opening_date')).slice(0, 10);
  if (!odate || odate !== today) return { skipped: true, reason: `今日(${today})非开业日(${odate || '未设置'})` };
  await notifyStaff(1, 'opening', `开业公告：${note.slice(0, 120)}`, { note, date: today }, 'pos.sell', 'opening:' + today);
  return { sent: true, date: today };
}
