/**
 * P1-H2 · 出站请求安全护栏（SSRF 收口）
 * 部署背景：单店局域网，Ollama/预测服务等合法目标位于 loopback 或内网 —— 因此策略为：
 *   ① 仅允许 http/https，禁止 URL 内嵌凭据与非常规协议（file:/gopher: 等）；
 *   ② 硬性封禁云元数据端点与链路本地地址（169.254.0.0/16、100.100.100.200、fe80::、::1 以外特殊用途段）；
 *   ③ 报错脱敏：对外只回「目标服务不可达」，明细写服务端日志——全回显探测面关闭；
 *   ④ 需要更严格网络隔离的部署可在网关层（防火墙）补充，本层为应用纵深。
 */
const BLOCKED_IPV4_PREFIX = ['169.254.', '100.100.', '0.', '224.', '239.', '255.'];
const BLOCKED_HOSTS = new Set(['metadata', 'metadata.google.internal', 'metadata.internal', 'instance-data']);

export class UnsafeTargetError extends Error {}

const isIPv4 = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/** 校验并返回安全 URL；不安全抛 UnsafeTargetError */
export function assertSafeBaseUrl(raw: string, opts: { loopbackOnly?: boolean } = {}): URL {
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw new UnsafeTargetError('URL 格式不合法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeTargetError('仅允许 http/https');
  if (u.username || u.password) throw new UnsafeTargetError('禁止 URL 内嵌凭据');
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.internal')) throw new UnsafeTargetError('目标被禁止');
  if (isIPv4(host) && BLOCKED_IPV4_PREFIX.some(p => host.startsWith(p))) throw new UnsafeTargetError('目标被禁止');
  if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) throw new UnsafeTargetError('目标被禁止');
  if (opts.loopbackOnly && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new UnsafeTargetError('该服务仅允许本机地址');
  return u;
}

/** 对外统一脱敏错误（服务端日志保留明细） */
export function safeProbeError(e: unknown): string {
  console.warn('[netguard] 出站探测失败（已对客户端脱敏）:', (e as any)?.message || e);
  return '目标服务不可达（详情见服务端日志）';
}
