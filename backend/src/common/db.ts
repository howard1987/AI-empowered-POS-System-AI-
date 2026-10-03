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
  max: 10,
  // 连接超时 5s：DB 未就绪时快速失败，避免业务请求/健康检查被挂死；pg-pool 会自动重建连接。
  connectionTimeoutMillis: 5000,
  // 统一会话时区（本地部署单店为中国门店）：CURRENT_DATE / ::date / now() 均按东八区，
  // 避免 UTC 集群下凌晨时段「今日」落到昨天的口径漂移
  options: '-c TimeZone=Asia/Shanghai',
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
 * P2-M9：单号发号——事务级 advisory lock 串行化同前缀取号，杜绝并发 count(*)+1 撞 UNIQUE
 * 返回 [{n}] 形状以兼容既有 seq[0].n 用法；table/col 仅允许内部字面量（防注入）
 */
export async function seqLock(c: PoolClient, table: string, col: string, pattern: string): Promise<{ n: number }[]> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(col)) throw new Error('seqLock 仅允许内部表/列名');
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`seq:${table}:${pattern}`]);
  const r = await c.query(`SELECT count(*)+1 AS n FROM ${table} WHERE ${col} LIKE $1`, [pattern]);
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

/** 审计留痕（十 权限与数据安全：敏感操作全量记录） */
export async function audit(
  storeId: number | null, employeeId: number | null,
  module: string, action: string,
  targetType?: string, targetId?: number, detail?: any,
): Promise<void> {
  const cli = txStore.getStore(); // P3-2
  await (cli ?? pool).query(
    `INSERT INTO audit_logs (store_id, employee_id, module, action, target_type, target_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [storeId, employeeId, module, action, targetType ?? null, targetId ?? null, detail ? JSON.stringify(detail) : null],
  );
}
