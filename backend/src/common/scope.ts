/**
 * V5.0.0 连锁改造（批次1）· 数据范围（data_scope）统一入口
 *
 * 背景（方案 §2.6）：连锁下「读列表/报表」必须按可见门店范围过滤，「按 id 操作他店数据」必须断言授权。
 * 手写范围条件必然有遗漏 → 本文件是**唯一入口**：
 *   读路径：storeFilter('o.store_id', n)   → 拼 SQL 片段 + 参数
 *   写路径：assertStoreAllowed(storeId)    → 越权抛 403
 *   报表：  resolveReportStores(请求值)     → 解析出最终的门店 id 数组（null = 不限制）
 *
 * ⚠️ 单店零回归的关键机制：
 *   本节点**没有 org_type='hq' 的总部行**时 → `chainEnabled()` 为 false：
 *     · storeFilter 返回空片段（等同改造前：不加额外条件）
 *     · assertStoreAllowed 空操作
 *     · 设置作用域校验跳过
 *   即「单店部署 = 连锁逻辑整体休眠」，行为与改造前 100% 一致（方案 §0.2 决策五）。
 *
 * ⚠️ 前端隐藏菜单不算安全措施：所有校验以服务端为准（方案 §2.6.4 三道闸）。
 */
import { q1 } from './db';
import { BizException } from './http';
import { curScope, type DataScope } from './context';

// ─────────────────────────────────────────────────────────────
// 连锁启用判定（缓存 60s：避免每请求查库；总部行创建后最多 60s 生效）
// ─────────────────────────────────────────────────────────────
let chainCache: { on: boolean; exp: number } = { on: false, exp: 0 };

/** 本节点是否处于「连锁模式」= 库中存在总部组织行（org_type='hq' 且未闭店） */
export async function chainEnabled(): Promise<boolean> {
  const now = Date.now();
  if (chainCache.exp > now) return chainCache.on;
  let on = false;
  try {
    const r = await q1<{ ok: number }>(
      `SELECT 1 AS ok FROM stores WHERE org_type = 'hq' AND COALESCE(status,1) <> 2 LIMIT 1`);
    on = !!r;
  } catch {
    on = false;   // 表未迁移/库不可达 → 视为单店（不启用任何连锁约束，绝不阻塞业务）
  }
  chainCache = { on, exp: now + 60_000 };
  return on;
}

/** 供写入路径（建总部行/建门店）后立即刷新判定，免等 60s */
export function resetChainCache(): void { chainCache = { on: false, exp: 0 }; }

// ─────────────────────────────────────────────────────────────
// 读路径：门店过滤 SQL 片段
// ─────────────────────────────────────────────────────────────
export interface ScopeFilter { sql: string; params: any[]; next: number }

/**
 * 生成「门店范围」SQL 片段与参数。
 * 用法：
 *   const f = storeFilter('o.store_id', params.length + 1);
 *   sql += f.sql; params.push(...f.params);
 *   // 后续占位符编号从 f.next 继续
 *
 * @param col      门店列名（**必须带表别名**，如 'o.store_id'；JOIN 场景省略别名会歧义）
 * @param startIdx 该片段首个占位符的编号（1-based）
 */
export function storeFilter(col: string, startIdx: number): ScopeFilter {
  const sc = curScope();
  if (sc.dataScope === 'all') return { sql: '', params: [], next: startIdx };
  if (sc.dataScope === 'region') {
    const ids = sc.scopeStores ?? [];
    if (!ids.length) return { sql: ' AND 1=0', params: [], next: startIdx };  // 无可见门店 → 空集
    return { sql: ` AND ${col} = ANY($${startIdx}::bigint[])`, params: [ids], next: startIdx + 1 };
  }
  return { sql: ` AND ${col} = $${startIdx}`, params: [sc.storeId], next: startIdx + 1 };
}

/** 同步版（不含 await）——判断当前是否「跨店视野」 */
export function crossStore(): boolean { return curScope().dataScope !== 'self'; }

/** 当前可见门店 id 集合；null = 不限制（总部） */
export function visibleStores(): number[] | null {
  const sc = curScope();
  if (sc.dataScope === 'all') return null;
  return sc.scopeStores ?? (sc.dataScope === 'self' ? [sc.storeId] : []);
}

// ─────────────────────────────────────────────────────────────
// 写路径：越权断言
// ─────────────────────────────────────────────────────────────
/**
 * 断言目标门店在授权范围内（写路径）。越权 → 403。
 * @param storeId 目标门店 id
 * @param what    业务描述（用于报错文案，如「该门店的调价单」）
 */
export function assertStoreAllowed(storeId: number | string | null | undefined, what = '该门店数据'): void {
  const sc = curScope();
  if (sc.dataScope === 'all') return;                 // 总部：不限制
  const id = Number(storeId);
  if (!Number.isInteger(id) || id <= 0) {
    // 未指定归属 → 视为本店（与历史默认一致，不报错）
    return;
  }
  const allow = sc.scopeStores ?? [sc.storeId];
  if (!allow.includes(id)) {
    throw new BizException(40301, `无权操作${what}（超出你的数据范围）`, 403);
  }
}

/**
 * 解析「报表/列表」请求的门店范围 → 最终门店 id 数组；null = 不限制（全部门店合计）。
 * 语义（方案 §2.6.2 表）：
 *   dataScope='self'   → 强制本店（忽略传入）
 *   dataScope='region' → 限本区域（与传入值取交集）
 *   dataScope='all'    → 可传 storeId（单店）/ 传 'all' 或不传（全部门店合计）
 */
export function resolveReportStores(requested?: string | number | Array<string | number> | null): number[] | null {
  const sc = curScope();
  const raw = requested === undefined || requested === null || requested === '' ? null : requested;
  const isAll = raw === 'all' || raw === 'ALL' || raw === '*';
  const asked: number[] = isAll || raw === null
    ? []
    : (Array.isArray(raw) ? raw : String(raw).split(','))
        .map(x => Number(String(x).trim()))
        .filter(n => Number.isInteger(n) && n > 0);

  if (sc.dataScope === 'self') return [sc.storeId];          // 强制本店
  if (sc.dataScope === 'region') {
    const allow = sc.scopeStores ?? [];
    return asked.length ? allow.filter(id => asked.includes(id)) : allow;
  }
  // all
  return asked.length ? Array.from(new Set(asked)) : null;   // null = 不限制
}

/** 门店范围中文标签（前端展示/日志用） */
export function scopeLabel(ds?: DataScope): string {
  const d = ds ?? curScope().dataScope;
  return d === 'all' ? '全部门店' : d === 'region' ? '本区域' : '本店';
}

// ─────────────────────────────────────────────────────────────
// 总部/门店归属解析（供商品下发、调拨、同步节点等使用）
// ─────────────────────────────────────────────────────────────
let hqCache: { id: number | null; exp: number } = { id: null, exp: 0 };

/**
 * 解析总部（总部仓）门店 id。
 * 单店部署**没有 org_type='hq' 行**时，回落为本节点门店（org_type 顶层最小 id）——
 * 这与「单店即总部」的语义一致，保证所有总部侧能力在单店下照常可用。
 */
export async function hqStoreId(): Promise<number> {
  const now = Date.now();
  if (hqCache.exp > now && hqCache.id !== null) return hqCache.id;
  let id: number | null = null;
  try {
    const r = await q1<{ id: string }>(
      `SELECT id FROM stores WHERE org_type = 'hq' AND COALESCE(status,1) <> 2 ORDER BY id LIMIT 1`);
    if (r) id = Number(r.id);
  } catch { /* 表未迁移 → 回落 */ }
  if (!id) {
    // 单店回落：本节点门店（curStore()），保证「单店即总部」
    id = curScope().storeId;
  }
  hqCache = { id, exp: now + 60_000 };
  return id;
}

/** 清总部 id 缓存（建/改总部行后调用） */
export function resetHqCache(): void { hqCache = { id: null, exp: 0 }; }

/** 该门店是否为总部/总部仓 */
export async function isHqStore(storeId: number): Promise<boolean> {
  try {
    const r = await q1<{ org_type: string }>(`SELECT org_type FROM stores WHERE id=$1`, [Number(storeId)]);
    return r?.org_type === 'hq';
  } catch { return false; }
}

/** 断言当前请求具备总部视野（跨店）。用于「总部专属」写操作的第二道闸。 */
export async function assertHqScope(what = '该总部操作'): Promise<void> {
  if (!(await chainEnabled())) return;              // 单店：放行（单店即总部）
  const sc = curScope();
  if (sc.dataScope !== 'all') {
    throw new BizException(40302, `无权执行${what}（需总部权限）`, 403);
  }
}
