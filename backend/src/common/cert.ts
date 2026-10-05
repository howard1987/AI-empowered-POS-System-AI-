/**
 * 局域网 HTTPS 证书（V5.0.10 改为「固定 CA + 随 IP 重签叶子」）
 *
 * 为何必须改：原实现用 selfsigned 直接签一张自签名叶子证书，IP 变化时整张证书被重签、字节全变。
 * 而 APK 把证书固定为信任锚点（network_security_config.xml -> res/raw/pos_server_cert.pem），
 * 于是「服务器换 IP -> 重签证书」会立刻让已装机 APK 的 TLS 校验失败，必须重新出包。
 * 对「路由器重启 / DHCP 重新分配 IP」这种高频场景不可接受。
 *
 * 现在：
 *   certs/ca.key.pem + certs/ca.pem  本地根 CA，只在首次运行生成一次，20 年有效，之后永不重签。
 *                                    APK 固定的就是这张 CA 证书。
 *   certs/key.pem   + certs/cert.pem 服务器叶子证书，由该 CA 签发，SAN 含当前所有网卡 IP，
 *                                    1 年有效；IP 变化时只重签叶子，秒级完成。
 *   客户端只需信任 CA，CA 永不变化 => 叶子怎么重签都不影响已装机 APK，无需重打包。
 *
 * 浏览器端：私有 CA 签发的证书浏览器仍提示不受信任（与现在的自签名证书表现一致，
 *   点「高级 -> 继续前往」即可）。若想在 PC 上彻底消除警告，可把 ca.pem 装进
 *   受信任的根证书颁发机构（一次性操作）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// node-forge：纯 JS 的完整 X.509 工具，可「用已有 CA 签叶子」，selfsigned 不具备该能力
const forge = require('node-forge');

/** 局域网 mDNS 域名：所有设备用域名访问，IP 变化无需改配置 */
export const MDNS_HOST = process.env.MDNS_HOST || 'pos-server.local';

/** 取本机局域网 IPv4（二维码地址要让手机可达）：优先 192.168/10 段，跳过 127/169.254/100.x(CGNAT 虚拟网卡) */
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

export interface CertInfo { regenerated: boolean; ips: string[]; dir: string; caCreated?: boolean; error?: string }

const DAY = 24 * 3600 * 1000;
/** CA 20 年：覆盖设备整个生命周期，杜绝「需要重装 APK」的情况 */
const CA_DAYS = 365 * 20;
/** 叶子 1 年：IP 变化时重签成本极低，不必追求长有效期 */
const LEAF_DAYS = 365;

/** 生成（或读取）本地根 CA。首次运行落盘，之后直接复用，绝不重签。 */
function ensureCa(dir: string): { caCert: any; caKey: any; created: boolean } {
  const caKeyPath = path.join(dir, 'ca.key.pem');
  const caCertPath = path.join(dir, 'ca.pem');
  if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
    return {
      caCert: forge.pki.certificateFromPem(fs.readFileSync(caCertPath, 'utf8')),
      caKey: forge.pki.privateKeyFromPem(fs.readFileSync(caKeyPath, 'utf8')),
      created: false,
    };
  }
  // node-forge 纯 JS 的 RSA 密钥生成较慢，给出提示避免被误认为卡死
  console.log('[证书] 首次运行：正在生成本地根 CA（20 年有效，只需生成这一次，约需数秒）…');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - DAY);   // 容忍轻微时钟偏差
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * DAY);
  const attrs = [{ name: 'commonName', value: 'POS-LAN Root CA' },
                 { name: 'organizationName', value: 'POS LAN' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);                                  // 自签：自己就是 issuer
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(caCertPath, forge.pki.certificateToPem(cert));
  console.log('[证书] 本地根 CA 已生成：certs/ca.pem（APK 固定的就是这张）');
  return { caCert: cert, caKey: keys.privateKey, created: true };
}

/** 软件组网（overlay network）网卡 IP：Tailscale / ZeroTier / Headscale 等
 *  为什么必须单独收录：lanIPv4All() 会排除 100.*（那是 CGNAT 段），但 Tailscale 恰恰用
 *  100.64.0.0/10 做虚拟网段。收银手机在装不了路由器、也不在同一局域网时（企业 VPN 隔离、
 *  4G、不同门店），靠的正是这条加密隧道。若证书 SAN 里没有这个 IP，APK 就会 hostname mismatch。
 *  收录它 ⇒ 装好 Tailscale 即插即用，不需要任何路由器配置。 */
export function overlayIPv4All(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const ip = ni.address;
      // 100.64.0.0/10 是 CGNAT/RFC6598 段，Tailscale 与 ZeroTier 的默认虚拟网段都落在其中
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) && !out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

/** 证书 SAN 里额外要写入的域名，来自环境变量 EXTRA_SANS="a.example.com,b.example.com"
 *  用于接入 Tailscale MagicDNS（形如 pos-server.<tailnet>.ts.net）等场景 */
function extraSans(): string[] {
  return String(process.env.EXTRA_SANS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

/** 用 CA 签一张叶子证书：SAN 覆盖 localhost + mDNS 域名 + 局域网 IP + 软件组网虚拟 IP + 额外域名 */
function signLeaf(caCert: any, caKey: any, ips: string[], overlay: string[], extra: string[]) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * DAY);
  cert.setSubject([{ name: 'commonName', value: 'POS-LAN' },
                   { name: 'organizationName', value: 'POS LAN' }]);
  cert.setIssuer(caCert.subject.attributes);             // 由 CA 签发
  // 注意：node-forge 对 SAN 的 IP 条目要求用 `ip` 属性（DNS 才用 `value`）。
  // 若沿用 selfsigned 那种 { type:7, value:ip } 写法，node-forge 会静默丢弃整条 SAN，
  // 表现为「证书里没有任何 altnames」，客户端报 hostname mismatch。
  const seen = new Set<string>();
  const dns: string[] = [];
  const ipList: string[] = [];
  const pushDns = (v: string) => { const k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); dns.push(v); } };
  const pushIp = (v: string) => { if (v && !seen.has(v)) { seen.add(v); ipList.push(v); } };
  pushDns('localhost');
  pushDns(MDNS_HOST);
  extra.forEach(pushDns);
  pushIp('127.0.0.1');
  ips.forEach(pushIp);
  overlay.forEach(pushIp);
  const altNames: any[] = [
    ...dns.map(v => ({ type: 2, value: v })),
    ...ipList.map(v => ({ type: 7, ip: v })),
  ];
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** 启动时确保证书与当前 IP 一致；返回结果供日志输出。失败只告警不阻断（HTTPS 可不启用）。
 *  baseDir 必传（dist 编译层级不同相对路径易错），由 main.ts 用 join(__dirname,'..','certs') 给出。 */
export async function ensureLanCert(baseDir?: string): Promise<CertInfo> {
  const dir = baseDir || path.join(process.cwd(), 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const metaPath = path.join(dir, 'meta.json');
  const ips = lanIPv4All();
  const overlay = overlayIPv4All();
  const extra = extraSans();
  try {
    // CA 优先：不存在则生成一次（它永不变，后续所有叶子都由它签）
    const { caCert, caKey, created } = ensureCa(dir);

    let need = !(fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath));
    let reason = need ? '证书缺失' : '';
    if (!need) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const same = Array.isArray(meta.ips) && meta.ips.length === ips.length
          && [...meta.ips].sort().join(',') === [...ips].sort().join(',');
        // 软件组网虚拟 IP / 额外 SAN 也要纳入比对：装了 Tailscale 后这些会变，
        // 不重签就会在手机上 hostname mismatch
        const sameOverlay = (meta.overlay || []).length === overlay.length
          && [...(meta.overlay || [])].sort().join(',') === [...overlay].sort().join(',');
        const sameExtra = (meta.extra || []).length === extra.length
          && [...(meta.extra || [])].sort().join(',') === [...extra].sort().join(',');
        // caId 用于识别「CA 被重建/更换」的情况：此时旧叶子即使 IP 没变也必须重签
        const caOk = !meta.caThumbprint || meta.caThumbprint === caCertThumbprint(caCert);
        if (!same) { need = true; reason = `IP 已变化（证书记录 [${(meta.ips || []).join(',')}] → 当前 [${ips.join(',') || '无'}]）`; }
        else if (!sameOverlay) { need = true; reason = '软件组网虚拟 IP 已变化（Tailscale/ZeroTier 等）'; }
        else if (!sameExtra) { need = true; reason = 'EXTRA_SANS 已变化'; }
        else if (!caOk) { need = true; reason = '根 CA 已更换，叶子证书需重新签发'; }
      } catch { need = true; reason = 'meta.json 损坏'; }
    }
    if (!need) return { regenerated: false, ips, dir, caCreated: created };

    const leaf = signLeaf(caCert, caKey, ips, overlay, extra);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, leaf.keyPem);
    fs.writeFileSync(certPath, leaf.certPem);
    fs.writeFileSync(metaPath, JSON.stringify({
      ips, overlay, extra, generatedAt: new Date().toISOString(),
      caThumbprint: caCertThumbprint(caCert), caSubject: 'POS-LAN Root CA',
    }, null, 2));
    console.log(`[证书] 叶子证书已签发（${reason}）· SAN: ${['localhost', ...extra, '127.0.0.1', ...ips, ...overlay].join(', ')}`);
    if (created) console.log('[证书] APK 信任锚请指向 certs/ca.pem（CA 20 年有效，重签叶子不影响已装机应用）');
    return { regenerated: true, ips, dir, caCreated: created };
  } catch (e: any) {
    console.warn(`[证书] 处理失败（HTTPS 可能无法启用）: ${e?.message}`);
    return { regenerated: false, ips, dir, error: e?.message };
  }
}

/** CA 指纹（SHA-256 十六进制前 16 位）：写入 meta.json 用于检测 CA 是否被更换 */
function caCertThumbprint(caCert: any): string {
  return forge.md.sha256.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(caCert)).getBytes()).digest().toHex().slice(0, 16);
}
