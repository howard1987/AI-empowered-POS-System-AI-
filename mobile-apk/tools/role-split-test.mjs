// 角色分流测试（V5.0.11）
// 验证：/auth/me 返回角色 + PWA 与「已有老板端」的分流/跳转/登录态共享
// 用法: ADMIN_PW=<密码> node role-split-test.mjs
import { readFileSync } from 'node:fs';
import https from 'node:https';

const ROOT = 'D:/Software/POS_system/\u8d85\u5e02\u6536\u94f6\u7cfb\u7edf-\u521d\u7248\u4ee3\u7801/backend/';
const PUB = ROOT + 'public/';
const PW = PUB + 'pwa/';
const CA = readFileSync(ROOT + 'certs/ca.pem', 'utf8');

function req(method, path, body, token) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) { headers.authorization = 'Bearer ' + token; }
    const r = https.request({ host: '192.168.1.139', port: 3443, path, method, ca: CA, headers }, resp => {
      let b = ''; resp.on('data', d => b += d); resp.on('end', () => res({ code: resp.statusCode, body: b }));
    });
    r.on('error', e => res({ code: 'ERR', body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
const BOSS_ROLES = ['\u8d85\u7ea7\u7ba1\u7406\u5458', '\u5e97\u957f', '\u8001\u677f'];
function isBoss(me) {
  if (!me) return false;
  const rs = Array.isArray(me.roles) ? me.roles : [];
  if (rs.some(r => BOSS_ROLES.includes(String(r)))) return true;
  if (Array.isArray(me.perms)) { if (me.perms.includes('*')) return true; }
  return false;
}
let fail = 0;
const ck = (n, ok, x) => { const s = (ok ? '  PASS  ' : '  FAIL  ') + n; console.log(x ? (s + '  ' + x) : s); if (!ok) fail++; };

console.log('\n=== 1. /auth/me \u662f\u5426\u8fd4\u56de roles ===');
const lg = await req('POST', '/auth/login', { empNo: 'ADMIN', password: process.env.ADMIN_PW, deviceCode: 'splittest' });
let token = '';
try { const j = JSON.parse(lg.body); if (j.data) { token = j.data.token; } if (!token) { token = j.token; } } catch (e) {}
if (!token) {
  console.log('  (\u672a\u63d0\u4f9b\u6709\u6548\u7ba1\u7406\u5458\u5bc6\u7801\uff0c\u8df3\u8fc7\u63a5\u53e3\u6821\u9a8c\uff1b\u9759\u6001\u6821\u9a8c\u7ee7\u7eed)');
} else {
  const rawm = JSON.parse((await req('GET', '/auth/me', null, token)).body);
  const m = rawm.data ? rawm.data : rawm;
  console.log('  \u5b57\u6bb5: ' + Object.keys(m).join(', '));
  ck('/auth/me \u542b roles \u5b57\u6bb5', Array.isArray(m.roles), JSON.stringify(m.roles));
  ck('ADMIN \u89d2\u8272\u547d\u4e2d\u7ba1\u7406\u5c42', Array.isArray(m.roles) ? m.roles.some(r => BOSS_ROLES.includes(r)) : false);
  ck('isBoss(ADMIN) = true\uff08\u8fdb\u8001\u677f\u7aef\uff09', isBoss(m) === true);
}

console.log('\n=== 2. \u5458\u5de5\u8d26\u53f7\u5e94\u8fdb\u5458\u5de5\u79fb\u52a8\u7aef ===');
if (process.env.STAFF_PW) {
  const sl = await req('POST', '/auth/login', { empNo: process.env.STAFF_NO || 'SYY0001', password: process.env.STAFF_PW, deviceCode: 'splittest' });
  let stok = '';
  try { const j = JSON.parse(sl.body); if (j.data) { stok = j.data.token; } if (!stok) { stok = j.token; } } catch (e) {}
  if (stok) {
    const raws = JSON.parse((await req('GET', '/auth/me', null, stok)).body);
    const s = raws.data ? raws.data : raws;
    console.log('  QA-CASH \u89d2\u8272: ' + JSON.stringify(s.roles));
    ck('QA-CASH \u542b\u6536\u94f6\u5458\u89d2\u8272', Array.isArray(s.roles) ? s.roles.includes('\u6536\u94f6\u5458') : false);
    ck('isBoss(\u6536\u94f6\u5458) = false', isBoss(s) === false);
  } else { console.log('  (\u5458\u5de5\u5bc6\u7801\u9519\u8bef\uff0c\u8df3\u8fc7)'); }
} else { console.log('  (\u672a\u63d0\u4f9b STAFF_PW\uff0c\u8df3\u8fc7)'); }

console.log('\n=== 3. PWA \u4fa7\u5206\u6d41\u4e0e\u767b\u5f55\u6001\u5171\u4eab ===');
const app = readFileSync(PW + 'app.js', 'utf8');
const co = readFileSync(PW + 'checkout.js', 'utf8');
const idx = readFileSync(PW + 'index.html', 'utf8');
ck('app.js \u6709 isBoss() \u5224\u5b9a', app.includes('function isBoss()'));
ck('app.js \u89d2\u8272\u89c4\u5219\u4e0e\u8001\u677f\u7aef\u4e00\u81f4', app.includes("BOSS_ROLES = ['\u8d85\u7ea7\u7ba1\u7406\u5458', '\u5e97\u957f', '\u8001\u677f']"));
ck('app.js \u8001\u677f\u7aef\u5730\u5740\u5b9a\u4e49', app.includes("BOSS_APP_URL = 'boss/index.html'"));
ck('app.js showMain \u8001\u677f\u8df3\u8f6c', app.includes("if (isBoss() && post !== 'checkout') { gotoBossApp(); return; }"));
ck('app.js \u540c\u6b65 token \u7ed9\u8001\u677f\u7aef', app.includes("setItem('boss_token'"));
ck('app.js \u540c\u6b65\u8bbe\u5907\u7801\u7ed9\u8001\u677f\u7aef', app.includes("setItem('boss_device_code'"));
ck('app.js \u5b58\u5728\u843d\u70b9\u6807\u8bb0', app.includes('pwa_post_login'));
ck('app.js \u5458\u5de5\u56db\u9875\u7b7e\u672a\u6539\u52a8', ['work','docs','msg','me'].every(t => idx.includes('data-tab="' + t + '"')));
ck('app.js \u5df2\u4e0d\u5f15\u7528\u65b0\u5efa boss.js', !idx.includes('boss.js'));
ck('checkout.js \u542b\u300c\u8fd4\u56de\u8001\u677f\u7aef\u300d', co.includes('ckBackBoss'));
ck('checkout.js \u8fd4\u56de\u6309\u94ae\u4ec5\u8001\u677f\u53ef\u89c1', co.includes('isBoss()'));
ck('checkout.js \u8fd4\u56de\u65f6\u540c\u6b65 token', co.includes("setItem('boss_token'"));

console.log('\n=== 4. \u5df2\u6709\u8001\u677f\u7aef\u5e94\u7528\uff08backend/public/boss\uff09===');
let bj = '', bh = '';
try { bj = readFileSync(PUB + 'boss/app.js', 'utf8'); bh = readFileSync(PUB + 'boss/index.html', 'utf8'); } catch (e) {}
ck('\u8001\u677f\u7aef\u5e94\u7528\u5b58\u5728', bh.length > 0);
ck('\u8001\u677f\u7aef\u539f\u6709\u9875\u7b7e\u672a\u88ab\u6539\u52a8', bh.includes('data-tab="overview"') ? true : bh.includes("data-tab='overview'"));
ck('\u6982\u89c8\u9875\u52a0\u300c\u8fdb\u5165\u6536\u94f6\u53f0\u300d\u5361\u7247', bj.includes('id="bPosEntry"'));
ck('\u5feb\u6377\u5165\u53e3\u52a0\u300c\u8fdb\u5165\u6536\u94f6\u53f0\u300d', bj.includes('id="ePos"'));
ck('\u8df3\u8f6c\u5230\u5458\u5de5\u79fb\u52a8\u7aef', bj.includes('../pwa/index.html'));
ck('\u540c\u6b65 token \u7ed9 PWA', bj.includes("setItem('pwa_token'"));
ck('\u540c\u6b65\u8bbe\u5907\u7801\u7ed9 PWA', bj.includes("setItem('pwa_device_code'"));
ck('\u6807\u8bb0\u843d\u70b9\u4e3a\u6536\u94f6', bj.includes("'checkout'"));
ck('\u8001\u677f\u7aef isManager \u89c4\u5219\u672a\u88ab\u6539\u52a8', bj.includes("r === '\u8d85\u7ea7\u7ba1\u7406\u5458' || r === '\u5e97\u957f' || r === '\u8001\u677f'"));

console.log('\n\u7ed3\u679c: ' + (fail === 0 ? '\u5168\u90e8\u901a\u8fc7' : fail + ' \u9879\u5931\u8d25'));
process.exit(fail ? 1 : 0);