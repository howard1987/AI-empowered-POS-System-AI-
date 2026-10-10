import { Pool, PoolClient } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';

/** P3-2：事务感知的审计写入——tx() 内部调用 audit() 自动复用同一连接，业务回滚则审计一并回滚（一致性口径） */
const txStore = new AsyncLocalStorage<PoolClient>();
export function currentTxCli(): PoolClient | undefined { return txStore.getStore(); }

/**
 * 数据库连接池（初版直用 pg + 参数化 SQL，与 db/001_init.sql 基线一一对应；
 * 后续如引入 TypeORM 需先评审执行文件第 5 节迁移规范）
 */
// P4 安全：移除硬编码弱口令默认连接串。缺少 DATABASE_URL 时拒绝以弱口令默认值启动，强制运维显式配置。
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[db] 致命：缺少 DATABASE_URL 环境变量，拒绝以弱口令默认值启动。请在 .env 配置 DATABASE_URL（如 postgres://user:pass@host:5432/db）');
  process.exit(1);
}
export const pool = new Pool({
  connectionString: DATABASE_URL,
  // V5.0.15 QA-P1 修复：原 max=10，在多收银台并发结账 + 高峰期叠加查询时连接被抢光，
  // 后续请求 5s 拿不到连接即 `timeout exceeded when trying to connect` → 用户看到「系统错误」。
  // 实测 10 个并发 checkout 就能复现（2 单失败）。超市高峰（3~8 台收银机 + 会员/库存查询）
  // 瞬时并发可达数十，故默认放宽到 40，可用 POS_PG_POOL_MAX 覆盖（PG 默认 max_connections=100）。
  max: Math.max(10, Number(process.env.POS_PG_POOL_MAX || 40)),
  // 连接超时 5s → 15s：高峰期宁可排队也不要直接失败（结账是长事务，多等几秒远好过报系统错误）
  connectionTimeoutMillis: Math.max(5000, Number(process.env.POS_PG_POOL_TIMEOUT_MS || 15000)),
  // 空闲连接及时回收，避免长期占用 PG 的 max_connections
  idleTimeoutMillis: 30000,
  // 统一会话时区（本地部署单店为中国门店）：CURRENT_DATE / ::date / now() 均按东八区，
  // 避免 UTC 集群下凌晨时段「今日」落到昨天的口径漂移
  // Q-06 超时护栏：单条语句 30s / 事务内空闲 60s —— 防"失控查询/忘提交的事务"
  // 长期占着连接把 40 连接的池拖光（报表全表扫、调试断点挂事务都会触发）。
  // 30s 远大于正常结账单语句耗时（P-03 批量化后为毫秒级），不会误伤业务。
  options: '-c TimeZone=Asia/Shanghai -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
});

// 会话时区兜底（部分驱动版本不支持 startup options 时保证生效）
pool.on('connect', (c: PoolClient) => { c.query("SET TIME ZONE 'Asia/Shanghai'").catch(() => {}); });

// 空闲连接异常兜底：PG 重启/网络瞬断时 pg-pool 会向池发 'error' 事件，
// 不挂监听会作为 unhandled 'error' 直接把整个后端进程打崩（本次 54329 瞬断即此因）。
// 挂上后仅记日志，坏连接由池自动丢弃重建，业务请求重试即可。
pool.on('error', (err: Error) => {
  console.error('[db-pool] 空闲连接异常（已丢弃，不影响后续请求）:', err.message);
});

/** 查询多行（注意：NUMERIC 列返回字符串，用时需 Number() 转换） */
export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

/** 查询单行 */
export async function q1<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const r = await pool.query(sql, params);
  return r.rows[0] as T | undefined;
}

/** 事务：异常自动回滚 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await txStore.run(c, () => fn(c));
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * P-01：原子发号——用 doc_seq 计数器替代「全局事务级 advisory 锁 + 每笔 LIKE count(*)+1」。
 * 语义与原实现完全一致（返回同前缀下「当前行数 + 1」），但：
 *   - 首次见到某 (table,col,pattern) 时按表内匹配行数初始化计数器，之后纯 O(1) 自增；
 *   - INSERT … ON CONFLICT DO UPDATE 保证并发安全，无需 advisory lock（消除高并发取号串行化与慢前缀扫描）。
 * 返回 [{n}] 形状以兼容既有 seq[0].n 用法；table/col 仅允许内部字面量（防注入）。
 */
export async function seqLock(c: PoolClient, table: string, col: string, pattern: string): Promise<{ n: number }[]> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(col)) throw new Error('seqLock 仅允许内部表/列名');
  const key = `seq:${table}:${col}:${pattern}`;
  const r = await c.query(
    `INSERT INTO doc_seq (k, n)
       VALUES ($1, (SELECT COALESCE(count(*),0)::int FROM ${table} WHERE ${col} LIKE $2) + 1)
     ON CONFLICT (k) DO UPDATE SET n = doc_seq.n + 1
     RETURNING n`,
    [key, pattern]);
  return r.rows as { n: number }[];
}

/** 事务内查询快捷函数 */
export function cx(c: PoolClient, sql: string, params: any[] = []): Promise<any[]> {
  return c.query(sql, params).then(r => r.rows);
}

/** 金额四舍五入到分 */
export const r2 = (n: number) => Math.round(n * 100) / 100;
/** 数量四舍五入到 3 位（称重 0.001kg） */
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** 权重/比例保留 4 位 */
export const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** 审计留痕（十 权限与数据安全：敏感操作全量记录）。返回是否写入成功。
 *
 *  V5.0.19e 加固：改为「失败告警但不抛异常」。
 *  旧行为是向上抛错，而调用方普遍写成 `await audit(...).catch(() => { })` —— 写不进去时
 *  既没有日志也没有报错，留痕被静默吞掉（2026-10-09 事故里就出现过 `audit_logs_pkey`
 *  主键冲突的未处理异常，留痕到底有没有落库无人知晓）。
 *  现在：写失败一定落一条 ERROR 日志（含模块/动作），业务继续；需要强校验的调用方
 *  可自行判断返回值（清库/恢复等场景另有不可删的 data_reset_history 兜底留痕）。 */
export async function audit(
  storeId: number | null, employeeId: number | null,
  module: string, action: string,
  targetType?: string, targetId?: number, detail?: any,
): Promise<boolean> {
  const cli = txStore.getStore(); // P3-2
  try {
    await (cli ?? pool).query(
      `INSERT INTO audit_logs (store_id, employee_id, module, action, target_type, target_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [storeId, employeeId, module, action, targetType ?? null, targetId ?? null, detail ? JSON.stringify(detail) : null],
    );
    return true;
  } catch (e: any) {
    console.error(`[审计留痕失败] ${module}/${action}（target=${targetType ?? '-'}/${targetId ?? '-'}）: ${e?.message || e}`);
    return false;
  }
}
