/**
 * P3-1 · 请求级店铺上下文（AsyncLocalStorage）
 *   背景：单店假设下 54 处 VALUES (1,…) 与 61 处 audit(1,…) 硬编码 store_id。
 *   方案：main 中间件为每个请求建立可变 holder；AuthGuard/MemberGuard 认证成功后写入
 *   storeId/empId；同请求内的 curStore()/curEmp() 即可取到权威归属，随链路自动传递。
 *   无上下文（启动任务/定时 job/CLI 脚本）回退 store=1、emp=null——与历史行为完全一致。
 *
 *   多店扩张时：只需保证写路径经守卫（已全覆盖）或在入口显式 setCtx()，
 *   原 63 个模块的 SQL 不再需要逐处传参。
 *
 * V5.0.0 连锁改造（批次1）扩展：新增 **数据范围**（读路径可见范围）两个字段
 *   dataScope   'self' 仅本店 / 'region' 本区域 / 'all' 全部门店（总部）
 *   scopeStores region/self 时预解析出的可见门店 id 集合；'all' = null 表示不限制
 *   取值规则与 pems 同策略：**登录时解析一次打入 JWT**，守卫写入上下文，请求内零查库。
 * ⚠️ 无上下文（job/CLI）默认 dataScope='all'（不限制）—— 保持历史行为，避免后台任务被误拦。
 */
import { AsyncLocalStorage } from 'async_hooks';

/** 数据范围（读路径可见范围）：self 仅本店 / region 本区域 / all 全部门店 */
export type DataScope = 'self' | 'region' | 'all';

export interface StoreCtx {
  storeId: number;                          // 权威归属门店（写路径默认值）
  empId: number | null;
  dataScope: DataScope;                     // 新增：读路径可见范围
  scopeStores: number[] | null;             // 新增：可见门店 id 集合（null = 不限制）
}
const als = new AsyncLocalStorage<StoreCtx>();

/** 由 main 中间件调用：为本次请求建立上下文（含后续 guard 可改写的 holder） */
export function runWithStoreCtx<T>(fn: () => T): T {
  // 默认 all（不限制）：无认证上下文时（job/CLI/兜底）与历史行为一致，不产生额外拦截
  return als.run({ storeId: 0, empId: null, dataScope: 'all', scopeStores: null }, fn);
}
/**
 * 守卫/服务内注入当前上下文（对同一 holder 对象赋值，沿 async 链可见）
 * 兼容旧调用：setCtx(storeId, empId) —— 不传 ds/ss 时保持 all（不限制）
 */
export function setCtx(
  storeId: number,
  empId: number | null,
  dataScope?: DataScope | null,
  scopeStores?: number[] | null,
): void {
  const h = als.getStore();
  if (!h) return;
  h.storeId = Number.isInteger(storeId) && storeId > 0 ? storeId : 1;
  h.empId = Number.isInteger(empId) ? empId : null;
  const ds: DataScope = dataScope === 'self' || dataScope === 'region' || dataScope === 'all' ? dataScope : 'all';
  h.dataScope = ds;
  h.scopeStores = ds === 'all'
    ? null
    : (Array.isArray(scopeStores) ? scopeStores.map(Number).filter(n => Number.isInteger(n) && n > 0) : null);
  // self 且未显式给集合 → 至少含本店（防止 scopeStores=null 被误判为「不限制」）
  if (ds === 'self' && !h.scopeStores?.length) h.scopeStores = [h.storeId];
}
/** SQL 模板安全插值用：永远返回校验过的整数字面量（无注入面） */
export function curStore(): number {
  const s = als.getStore()?.storeId;
  return Number.isInteger(s) && (s as number) > 0 ? (s as number) : 1;
}
/** 审计操作人：无上下文返回 null（历史上部分 job 硬编 empId=1，此处如实记 null） */
export function curEmp(): number | null {
  const e = als.getStore()?.empId;
  return Number.isInteger(e) ? (e as number) : null;
}
/** V5.0.0：当前请求的数据范围（读路径可见范围），无上下文默认 all */
export function curScope(): { dataScope: DataScope; scopeStores: number[] | null; storeId: number } {
  const h = als.getStore();
  return {
    storeId: Number.isInteger(h?.storeId) && (h?.storeId as number) > 0 ? (h!.storeId as number) : 1,
    dataScope: h?.dataScope ?? 'all',
    scopeStores: h?.scopeStores ?? null,
  };
}
/** V5.0.0：本请求是否具备跨店（总部级）视野 */
export function isCrossStore(): boolean {
  return curScope().dataScope !== 'self';
}
