/**
 * 极简内存限流器（V4.14.4 安全加固：登录/密保答案爆破防护）
 * 场景：本地单实例部署，进程内 Map 足够。重启即清零——已知取舍（见安全审计报告）。
 * 三类用法：
 *   allow(key, max, windowMs)      固定窗口计数（IP 维度频控）
 *   failAndLock(key, max, lockMs)  连续失败计数，达标即锁定（账号维度爆破锁）
 *   lockedFor(key) / clearFailures(key)
 */
type Slot = { count: number; resetAt: number; lockedUntil: number };

const buckets = new Map<string, Slot>();

function sweep(now: number) {
  if (buckets.size < 512) return;
  for (const [k, v] of buckets) if (v.resetAt < now && v.lockedUntil < now) buckets.delete(k);
}

/** 固定窗口：windowMs 内超过 max 次返回 false（不消耗已计数） */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs, lockedUntil: 0 });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

/** 记一次失败；达到 max 次锁定 lockMs。返回剩余锁定分钟数（0=尚未触发锁定） */
export function failAndLock(key: string, max: number, lockMs: number): number {
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, resetAt: now + lockMs, lockedUntil: 0 };
  b.count++;
  if (b.count >= max) b.lockedUntil = now + lockMs;
  buckets.set(key, b);
  return b.lockedUntil > now ? Math.max(1, Math.ceil((b.lockedUntil - now) / 60000)) : 0;
}

/** 剩余锁定秒数（0=未锁） */
export function lockedFor(key: string): number {
  const b = buckets.get(key);
  if (!b || !b.lockedUntil) return 0;
  return Math.max(0, Math.ceil((b.lockedUntil - Date.now()) / 1000));
}

/** 登录成功后清除失败计数 */
export function clearFailures(key: string) {
  buckets.delete(key);
}

/** 从请求取客户端 IP（内网直连场景取 socket 地址即可，兼容代理头） */
export function clientIp(req: any): string {
  // P2-M1：默认取真实 socket 地址；仅显式 TRUST_PROXY=1（部署于本机反代之后）才信任 X-Forwarded-For 首段
  if (process.env.TRUST_PROXY === '1') {
    const xff = req?.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown');
}
