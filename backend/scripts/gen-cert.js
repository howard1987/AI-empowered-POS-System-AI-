/**
 * 一次性生成局域网自签名证书（持久到 backend/certs/，勿删）：
 *   node scripts/gen-cert.js [局域网IP]
 * SAN 默认覆盖 192.168.0.5（服务器 IP）/ localhost / 127.0.0.1，换 IP 后重跑。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');

const extraIp = process.argv[2] || '';
const attrs = [{ name: 'commonName', value: 'POS-LAN' }];
const altNames = [
  { type: 2, value: 'localhost' },              // DNS
  { type: 7, value: '127.0.0.1' },              // IP
];
// 自动带上本机所有 IPv4（跳过 CGNAT 段）
for (const list of Object.values(os.networkInterfaces())) {
  for (const ni of list || []) {
    if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('100.')) {
      altNames.push({ type: 7, value: ni.address });
    }
  }
}
if (extraIp && !altNames.some(a => a.value === extraIp)) altNames.push({ type: 7, value: extraIp });

(async () => {
const pems = await selfsigned.generate(attrs, {
  days: 3650,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [{ name: 'subjectAltName', altNames }],
});

const dir = path.join(__dirname, '..', 'certs');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'key.pem'), pems.private || pems.key);
fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
console.log('✓ 证书已生成:', dir);
console.log('  SAN:', altNames.map(a => a.value).join(', '));
})().catch(e => { console.error('生成失败:', e.message); process.exit(1); });
