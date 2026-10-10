/**
 * V5.0.19i（Q-07 低危卫生）：统一分页解析。
 * 收敛全模块散落的 Math.min/Math.max 手写钳制——此前上限 50/100/200/2000/5000 不一致、
 * 部分站点还漏了下限钳制（如 device.module 旧 `Math.min(Number(limit) || 50, 200)` 可传 0/负数）。
 * 各端点通过参数保留自己的默认值与上限（迁移时数值逐一相等，行为不变）。
 */
/** size 解析：非法/缺省 → defSize；钳制 [1, maxSize] */
export function sizeOf(raw: any, defSize: number, maxSize: number): number {
  return Math.min(Math.max(1, Math.floor(Number(raw) || defSize)), maxSize);
}
/** page 解析：非法/缺省 → 1；钳制 ≥1 */
export function pageOf(raw: any): number {
  return Math.max(1, Math.floor(Number(raw) || 1));
}
/** OFFSET 快捷式 */
export function offsetOf(page: number, size: number): number {
  return (page - 1) * size;
}
/** 一站式：从 query 对象解析 { page, size, offset }（兼容 size/pageSize 两种参数名） */
export function parsePaging(qp: any, defSize = 20, maxSize = 200): { page: number; size: number; offset: number } {
  const page = pageOf(qp?.page);
  const size = sizeOf(qp?.size ?? qp?.pageSize, defSize, maxSize);
  return { page, size, offset: offsetOf(page, size) };
}
