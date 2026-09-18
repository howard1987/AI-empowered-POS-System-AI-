/**
 * 局域网 HTTPS 证书自动跟随动态 IP：
 * - lanIPv4/lanIPv4All：实时探测本机网卡（二维码地址、证书 SAN 都用它）
 * - ensureLanCert()：启动时比对 certs/meta.json 记录的 IP 列表与本机当前 IP 列表，
 *   不一致（换网段/换路由器/DHCP 重新分配）或证书缺失 → 自动重新签发自签名证书。
 *   服务器重启后 IP 变了也没关系：重启后端服务即自动跟上，二维码随之指向新 IP。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/** 局域网 mDNS 域名：所有设备用域名访问，IP 变化无需改配置 */
export const MDNS_HOST = process.env.MDNS_HOST || 'pos-server.local';

/** 取本机局域网 IPv4（二维码地址要让手机可达）：优先 192.168/10 段，跳过 127/169.254/100.64-127(CGNAT 虚拟网卡) */
export function lanIPv4(): string {
  const cands = lanIPv4All();
  const score = (ip: string) => ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2
    : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0;
  return cands.sort((a, b) => score(b) - score(a))[0] || '127.0.0.1';
}

/** 本机所有可用局域网 IPv4（排除环回/链路本地/CGNAT） */
export function lanIPv4All(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const ip = ni.address;
      if (ip.startsWith('169.254.') || ip.startsWith('100.')) continue;
      if (!out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

export interface CertInfo { regenerated: boolean; ips: string[]; dir: string; error?: string }

/** 启动时确保证书与当前 IP 一致；返回结果供日志输出。失败只告警不阻断（HTTPS 可不启用）。
 *  baseDir 必传（dist 编译层级不同相对路径易错），由 main.ts 用 join(__dirname,'..','certs') 给出。 */
export async function ensureLanCert(baseDir?: string): Promise<CertInfo> {
  const dir = baseDir || path.join(process.cwd(), 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const metaPath = path.join(dir, 'meta.json');
  const ips = lanIPv4All();
  try {
    let need = !(fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath));
    let reason = need ? '证书缺失' : '';
    if (!need) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const same = Array.isArray(meta.ips) && meta.ips.length === ips.length
          && [...meta.ips].sort().join(',') === [...ips].sort().join(',');
        if (!same) { need = true; reason = `IP 已变化（证书记录 [${(meta.ips || []).join(',')}] → 当前 [${ips.join(',') || '无'}]）`; }
      } catch { need = true; reason = 'meta.json 损坏'; }
    }
    if (!need) return { regenerated: false, ips, dir };

    const selfsigned = require('selfsigned');
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 2, value: MDNS_HOST },           // mDNS 域名（手机/收银机域名访问的主入口）
      { type: 7, value: '127.0.0.1' },
      ...ips.map((ip: string) => ({ type: 7, value: ip })),
    ];
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'POS-LAN' }], {
      days: 3650, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, pems.private || pems.key);
    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(metaPath, JSON.stringify({ ips, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`[证书] 已重新签发（${reason}）· SAN: ${['localhost', '127.0.0.1', ...ips].join(', ')}`);
    return { regenerated: true, ips, dir };
  } catch (e: any) {
    console.warn(`[证书] 处理失败（HTTPS 可能无法启用）: ${e?.message}`);
    return { regenerated: false, ips, dir, error: e?.message };
  }
}
