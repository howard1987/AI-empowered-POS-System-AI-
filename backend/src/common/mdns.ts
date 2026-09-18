/**
 * 局域网 mDNS 域名广播：
 * 服务器在局域网内应答 <MDNS_HOST>（默认 pos-server.local）的 A 记录查询 → 当前 IP。
 * 手机 / 收银机 / 后台一律用域名访问（https://pos-server.local:3443），服务器 IP 怎么变都无需改配置。
 * 兼容性：Windows 10+/iOS/macOS 原生支持 mDNS 解析；Android Chrome 80+ 支持 .local 域名。
 */
import { lanIPv4, MDNS_HOST } from './cert';

let mdns: any = null;

/** 启动 mDNS 应答 + 主动宣告；失败只告警不阻断（设备仍可用 IP 直连） */
export function startMdns(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const createMdns = require('multicast-dns');
    if (mdns) return MDNS_HOST; // 已启动（防重复调用）
    mdns = createMdns({ loopback: false, interface: lanIPv4() });

    // 应答 A / AAAA 查询：pos-server.local → 本机当前局域网 IP
    mdns.on('query', (q: any) => {
      const name = (q.questions || []).map((x: any) => String(x.name || '').toLowerCase());
      if (!name.includes(MDNS_HOST)) return;
      const ip = lanIPv4();
      if (ip === '127.0.0.1') return; // 无局域网 IP 时不应答
      mdns.respond({ answers: [{ name: MDNS_HOST, type: 'A', ttl: 120, data: ip }] });
    });

    // 主动宣告（gratuitous ARP 类似机制，让设备缓存热身），启动 + 每 60s 刷一次
    const announce = () => {
      const ip = lanIPv4();
      if (ip === '127.0.0.1') return;
      mdns.respond({ answers: [{ name: MDNS_HOST, type: 'A', ttl: 120, data: ip }] });
    };
    announce();
    const timer = setInterval(announce, 60_000);
    timer.unref?.();

    console.log(`[mDNS] 局域网域名已广播：${MDNS_HOST} → ${lanIPv4()}（手机/收银机可用 https://${MDNS_HOST}:3443 访问）`);
    return MDNS_HOST;
  } catch (e: any) {
    console.warn(`[mDNS] 启动失败（不影响 IP 直连）: ${e?.message}`);
    return '';
  }
}
