/**
 * V5.0.0 连锁 · HLC 混合逻辑时钟（方案 §4.7）
 *
 * 背景：多节点异步链路里，门店 A 时钟快 5 分钟、门店 B 慢 3 分钟，同一会员先后消费
 *       按 created_at 排序会【颠倒】。跨店先后判断（会员消费顺序、库存流水顺序、
 *       批次消耗顺序、对账次序）必须用逻辑时钟，不能用物理时间。
 *
 * 方案：
 *   hlc = <physical_ms, counter, node_code>
 *   · 本地事件： physical = max(now, last.physical)；相等则 counter+1，否则 counter=0
 *   · 收到远端： physical = max(now, last.physical, remote.physical)，counter 按 HLC 规则推进
 *   · 排序：     (physical, node_code, seq) 字典序 → 全局唯一全序
 *
 * ⚠️ 落库实现（与方案文字的一处实现修正，已在方案文档标注）：
 *   方案原文排序键写作 `(biz_ts, seq, node_code)`，但 `seq` 取自 `sync_seq` 序列 ——
 *   它是【节点内】单调的（每个节点的库各自从 1 开始），跨节点比较时 seq 会撞。
 *   故本条排序键定为 **`(biz_ts, node_code, seq)`**：先物理时间、再节点（离散化抖动）、
 *   最后节点内序号。既保证因果序（同节点严格递增），又保证跨节点稳定可比。
 *
 * 持久化：`sync_hlc` 单行表 + `UPDATE ... RETURNING`，多进程 / 重启 / 断电后不回退。
 *        写入一律在【业务事务内】，与业务数据同生共死。
 */
import type { PoolClient } from 'pg';
import { cx, q1 } from './db';

export interface HlcStamp {
  physical: number;   // 毫秒时间戳
  counter: number;    // 同毫秒内计数
}
export interface HlcTickResult extends HlcStamp {
  seq: number;        // 节点内单调序号（nextval('sync_seq')）
}

/** 本进程内的时钟缓存：减少每笔业务一次 UPDATE 的开销（DB 仍是权威） */
let local: HlcStamp = { physical: 0, counter: 0 };

/** 用 DB 行初始化进程内缓存（启动时 / 缓存落后时调用） */
export async function hlcWarmup(): Promise<HlcStamp> {
  const r = await q1<{ physical: string; counter: string }>(
    `SELECT physical, counter FROM sync_hlc WHERE id = 1`);
  if (r) local = { physical: Number(r.physical), counter: Number(r.counter) };
  return { ...local };
}

/**
 * 本地事件推进：返回本次事件的 (physical, counter, seq)。
 * ⚠️ 必须在业务事务内调用（传 c），保证「业务成功 ⇔ 时钟推进」原子。
 * 传入 c 为 null 时走连接池（适合无事务的 job）。
 */
export async function hlcTick(c: PoolClient | null, ms?: number): Promise<HlcTickResult> {
  const now = Number.isFinite(ms as number) ? (ms as number) : Date.now();
  const sql = `
    WITH up AS (
      UPDATE sync_hlc
         SET physical = GREATEST(physical, $1),
             counter  = CASE WHEN $1 > physical THEN 0 ELSE counter + 1 END,
             updated_at = now()
       WHERE id = 1
       RETURNING physical, counter
    )
    SELECT physical, counter, nextval('sync_seq') AS seq FROM up`;
  const rows = c ? await cx(c, sql, [now]) : await q1<any>(sql, [now]).then(r => (r ? [r] : []));
  const r = rows[0];
  if (!r) {
    // 极端兜底：sync_hlc 行缺失（迁移未跑）→ 退化为进程内时钟，至少不炸业务
    local = { physical: Math.max(now, local.physical), counter: local.counter + 1 };
    return { ...local, seq: Date.now() };
  }
  local = { physical: Number(r.physical), counter: Number(r.counter) };
  return { physical: local.physical, counter: local.counter, seq: Number(r.seq) };
}

/**
 * 收到远端事件时推进本地时钟（HLC receive 规则）。
 * 门店 pull 到总部变更 / 总部 push 收到门店变更时调用，保证「总部看到的顺序」不因门店时钟偏差而错乱。
 */
export async function hlcReceive(c: PoolClient | null, remotePhysical: number, remoteCounter: number): Promise<HlcStamp> {
  const now = Date.now();
  const sql = `
    WITH up AS (
      UPDATE sync_hlc
         SET physical = GREATEST(physical, $1, $2),
             counter  = CASE
                          WHEN GREATEST(physical, $1, $2) = physical AND GREATEST(physical, $1, $2) = $1
                            THEN GREATEST(counter, $3) + 1
                          WHEN GREATEST(physical, $1, $2) = physical
                            THEN counter + 1
                          ELSE $3 + 1
                        END,
             updated_at = now()
       WHERE id = 1
       RETURNING physical, counter
    )
    SELECT physical, counter FROM up`;
  const rows = c ? await cx(c, sql, [now, remotePhysical, remoteCounter]) : await q1<any>(sql, [now, remotePhysical, remoteCounter]).then(r => (r ? [r] : []));
  if (rows[0]) local = { physical: Number(rows[0].physical), counter: Number(rows[0].counter) };
  return { ...local };
}

/** 本进程缓存快照（只读，诊断用） */
export function hlcLocal(): HlcStamp { return { ...local }; }

/**
 * 全序比较：先 physical，再 node_code，最后 seq。
 * 返回 <0 = a 在前；>0 = b 在前；0 = 完全同一事件。
 */
export function hlcCmp(
  a: { physical: number; nodeCode: string; seq: number },
  b: { physical: number; nodeCode: string; seq: number },
): number {
  if (a.physical !== b.physical) return a.physical - b.physical;
  if (a.nodeCode !== b.nodeCode) return a.nodeCode < b.nodeCode ? -1 : 1;
  return a.seq - b.seq;
}

/** 排序键字符串（落日志 / 前端展示用，形如 1737000000123|S001-ab12cd|42） */
export function hlcKey(physical: number, nodeCode: string, seq: number): string {
  return `${physical}|${nodeCode}|${seq}`;
}

/** 毫秒 → PG timestamptz 参数（用 Date 由 pg 驱动序列化，避免时区歧义） */
export function tsOf(physical: number): Date { return new Date(physical); }
