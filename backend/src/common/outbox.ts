/**
 * V5.0.0 连锁 · 同步发件箱 / 下行发布（方案 §4.3.1 / §4.4）
 *
 * 两个核心 API：
 *   enqueueSync(c, entity, entityId, payload, op, bizTsMs)
 *     —— 门店侧【同事务】入队（与业务写同一个 c.query 事务）。
 *        崩溃/断电时业务回滚则变更一并回滚，恢复后自动补传 —— 离线可靠性的根本保证。
 *
 *   publish(entity, entityId, payload, target, targetIds)
 *     —— 总部侧下行发布（写 sync_changes，version 全局单调 = 天然水位）。
 *
 * 【单店零回归铁律】本节点身份由 sync_nodes(is_self=true) 决定：
 *   · node_role='hq'（总部 / 单店）→ enqueueSync 直接 no-op，sync_outbox 恒空
 *   · 未注册（sync_nodes 无 is_self 行）→ 同样 no-op（同步层休眠）
 *   · node_role='store'（门店节点）→ 正常入队
 * 身份缓存 30 秒；配置向导改库后调用 resetNodeCache() 立即生效。
 */
import type { PoolClient } from 'pg';
import { q1, pool } from './db';
import { hlcTick } from './hlc';

/** 允许上行的实体白名单（超出即拒绝——防止业务代码手滑把大表整表入队） */
export const SYNC_ENTITIES = [
  'sale_order',        // 结算单（含 items/payments/batches 全量，随单上行）
  'sale_refund',       // 退货单（含明细）
  'shift',             // 班次（交班后）
  'inventory',         // 库存快照（商品最新 qty_total，LWW）
  'stock_flow',        // 库存流水（报损/盘点/调拨等独立变动）
  'batch',             // 批次增量（入库/调拨/报损）
  'loss',              // 报损单
  'stock_count',       // 盘点单
  'stock_transfer',    // 调拨单（含明细）
  'price_change',      // 门店调价单（门店只上行售价单，R8）
  'member',            // 会员档案（注册/修改）
  'member_credit_flow',// 会员余额/积分镜像事件（P2 离线挂账用，预留）
  'product',           // 门店自建品（R2）
  'store_product',     // 门店上下架台账
  'store_product_request', // 门店申请上架（R2）
  'cost_diff_request', // 进价差异申请（R8）
  'cross_return_ack',  // 跨店退货受理回执（R6）
  'intercompany_flow', // 门店往来台账事件（R6）
] as const;
export type SyncEntity = typeof SYNC_ENTITIES[number];

export interface NodeIdentity {
  nodeCode: string;
  role: 'hq' | 'store';
  enabled: boolean;
  storeId: number | null;
  name: string | null;
  hqBase: string | null;      // 门店节点：推往的总部基地址
  selfToken: string | null;   // 门店节点：明文令牌
}

const IDENT_TTL_MS = 30_000;
let identCache: { at: number; val: NodeIdentity | null } = { at: 0, val: null };

/** 本节点身份（缓存 30s）。null = 未注册（同步层休眠） */
export async function nodeIdentity(force = false): Promise<NodeIdentity | null> {
  if (!force && Date.now() - identCache.at < IDENT_TTL_MS) return identCache.val;
  const r = await q1<any>(
    `SELECT node_code, store_id, name, node_role, status, hq_base, self_token
       FROM sync_nodes WHERE is_self LIMIT 1`);
  const val: NodeIdentity | null = r
    ? {
        nodeCode: String(r.node_code),
        role: r.node_role === 'hq' ? 'hq' : 'store',
        enabled: r.status === '启用',
        storeId: r.store_id != null ? Number(r.store_id) : null,
        name: r.name ?? null,
        hqBase: r.hq_base ?? null,
        selfToken: r.self_token ?? null,
      }
    : null;
  identCache = { at: Date.now(), val };
  return val;
}

/** 配置变更后清缓存（配置向导 / 密钥轮换后调用） */
export function resetNodeCache(): void { identCache = { at: 0, val: identCache.val }; }

/**
 * 上行入队（门店侧，同事务）。
 * @param c  业务事务连接（PoolClient）。传 null = 用连接池自开（仅用于无事务场景，不推荐）
 * @returns 入队成功返回 true；本节点不需要上行（hq/未注册/未启用）返回 false
 */
export async function enqueueSync(
  c: PoolClient | null,
  entity: SyncEntity,
  entityId: number | null,
  payload: unknown,
  op: 'upsert' | 'append' | 'delete' = 'upsert',
  bizTsMs?: number,
): Promise<boolean> {
  const id = await nodeIdentity();
  // 总部（含单店）或未注册节点：不发件——单店零回归的关键（sync_outbox 恒空）
  if (!id || id.role === 'hq') return false;
  if (!id.enabled) return false;

  const json = JSON.stringify(payload ?? {});
  if (json.length > 2 * 1024 * 1024) {
    // 单条 ≤2MB（方案 §4.2 限流）；超限说明调用方把整表塞进来了 → 拒绝并留痕
    console.error(`[outbox] payload 超限被拒: entity=${entity} id=${entityId} size=${json.length}`);
    return false;
  }
  const tick = await hlcTick(c, bizTsMs);
  const idemKey = `${id.nodeCode}:${entity}:${entityId ?? 0}:${tick.seq}`;
  const sql = `
    INSERT INTO sync_outbox (node_code, entity, entity_id, op, payload, biz_ts, seq, hlc_counter, idem_key)
    VALUES ($1,$2,$3,$4,$5::jsonb, to_timestamp($6::bigint / 1000.0), $7, $8, $9)
    ON CONFLICT (idem_key) DO NOTHING`;
  const params = [id.nodeCode, entity, entityId ?? null, op, json, tick.physical, tick.seq, tick.counter, idemKey];
  if (c) await c.query(sql, params);
  else await pool.query(sql, params);
  return true;
}

/**
 * 下行发布（总部侧）：写 sync_changes，返回全局 version。
 * 业务入口（商品主档保存 / 门店价调整 / 设置下发 / 角色账号变更 / 调拨 / 跨店退货……）调用。
 * 门店节点调用无效（返回 null）——门店无权广播。
 */
export async function publish(
  entity: string,
  entityId: number | null,
  payload: unknown,
  target: 'all' | 'store' | 'stores' = 'all',
  targetIds?: number[],
): Promise<number | null> {
  const id = await nodeIdentity();
  if (!id || id.role !== 'hq') return null;
  const r = await q1<{ version: string }>(
    `INSERT INTO sync_changes (entity, entity_id, op, payload, target, target_ids)
     VALUES ($1,$2,'upsert',$3::jsonb,$4,$5) RETURNING version`,
    [entity, entityId ?? null, JSON.stringify(payload ?? {}), target,
     targetIds?.length ? targetIds.map(Number) : null]);
  return r ? Number(r.version) : null;
}

/** 删除型发布（强制下架 / 停用等） */
export async function publishDelete(
  entity: string,
  entityId: number,
  target: 'all' | 'store' | 'stores' = 'all',
  targetIds?: number[],
): Promise<number | null> {
  const id = await nodeIdentity();
  if (!id || id.role !== 'hq') return null;
  const r = await q1<{ version: string }>(
    `INSERT INTO sync_changes (entity, entity_id, op, payload, target, target_ids)
     VALUES ($1,$2,'delete',$3::jsonb,$4,$5) RETURNING version`,
    [entity, entityId, JSON.stringify({}), target, targetIds?.length ? targetIds.map(Number) : null]);
  return r ? Number(r.version) : null;
}
