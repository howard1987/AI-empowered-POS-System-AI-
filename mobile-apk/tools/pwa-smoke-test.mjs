// PWA smoke test (V5.0.9) - drives real Chromium over CDP to validate the login page.
// Why: `node --check` only validates syntax; it cannot catch a TDZ ReferenceError.
// The V5.0.9 breakage was exactly that: SRV_DEFAULT was declared AFTER the init IIFE,
// so the uncaught error terminated the whole script and no click handler was ever bound
// (page looked fine, every button was dead). So we must load it for real and assert
// that the handlers are actually attached.
// Usage: node pwa-smoke-test.mjs [baseUrl]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'https://192.168.1.139:3443/pwa/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, ok, x = '') => { console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (x ? '  ' + x : '')); if (!ok) fail++; };

const profile = mkdtempSync(join(tmpdir(), 'pwa-smoke-'));
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, '--ignore-certificate-errors', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const done = () => { try { child.kill(); rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', done);

let ver = null;
for (let i = 0; i < 40 && !ver; i++) {
  await sleep(500);
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) ver = await r.json(); } catch {}
}
if (!ver) { console.error('cannot reach CDP'); process.exit(2); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map(); const lis = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method) for (const f of lis) f(m);
};
const send = (method, params = {}, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const exc = [], reqs = [];
lis.push(m => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') exc.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
});
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};
const finish = () => { console.log('\nresult: ' + (fail === 0 ? 'all passed' : fail + ' failed')); done(); process.exit(fail ? 1 : 0); };

console.log('\n[PWA smoke test] ' + BASE + '\n');
await send('Page.navigate', { url: BASE }, sessionId);
await sleep(4500);

check('login page rendered', await ev("!!document.querySelector('#lgForm')").catch(() => false) === true);
check('no uncaught exception during load', exc.length === 0, exc.slice(0, 2).join(' | '));
check('#lgGo login button has click handler (TDZ regression)', await ev("typeof document.querySelector('#lgGo').onclick === 'function'") === true);
check('#lgEye password toggle bound', await ev("typeof document.querySelector('#lgEye').onclick === 'function'") === true);
check('server-address toggle bound', await ev("typeof document.querySelector('#lgSrvToggle').onclick === 'function'") === true);

const b4 = await ev("document.querySelector('#lgSrvBody').style.display");
await ev("document.querySelector('#lgSrvToggle').click()"); await sleep(250);
const af = await ev("document.querySelector('#lgSrvBody').style.display");
check('toggle expands collapsed panel', b4 === 'none' && af !== 'none', 'before=' + JSON.stringify(b4) + ' after=' + JSON.stringify(af));
await ev("document.querySelector('#lgSrvToggle').click()"); await sleep(250);
check('toggle collapses again', await ev("document.querySelector('#lgSrvBody').style.display") === 'none');

const dflt = await ev("(typeof SRV_DEFAULT === 'undefined') ? 'undefined' : SRV_DEFAULT");
check('SRV_DEFAULT is no longer the dead mDNS host', dflt === '', 'SRV_DEFAULT=' + JSON.stringify(dflt));
const lab = await ev("(document.querySelector('#lgSrvLabel')||{}).textContent || ''");
check('no stale mDNS host in label', !/pos-server\.local/.test(String(lab)), 'label=' + JSON.stringify(lab));

reqs.length = 0;
await ev("document.querySelector('#lgSrv').value='';document.querySelector('#lgNo').value='smoketest';document.querySelector('#lgPw').value='x';document.querySelector('#lgGo').click();'ok'");
await sleep(2500);
const lr = reqs.find(u => /\/auth\/login/.test(u));
check('clicking login really issues /auth/login (handler alive)', !!lr, lr || 'no request captured');
if (lr) check('empty address resolves to same origin', lr.startsWith(BASE.replace(/\/pwa\/$/, '')), lr);

await ev("document.querySelector('#lgSrvToggle').click();document.querySelector('#lgSrv').value='192.168.1.139:3443';document.querySelector('#lgSrv').oninput();document.querySelector('#lgSrv').onchange();'ok'");
await sleep(300);
const stored = await ev("localStorage.getItem('pwa_api_base')");
check('address normalized + persisted (auto https)', stored === 'https://192.168.1.139:3443', 'stored=' + stored);
const hist = await ev("localStorage.getItem('pwa_api_hist')");
check('address saved to history (quick switch when IP changes)', /192\.168\.1\.139/.test(String(hist)), 'hist=' + hist);

await ev("document.querySelector('#lgSrvTest').click()"); await sleep(2500);
const tip = await ev("(document.querySelector('#lgSrvTip')||{}).textContent || ''");
check('test button yields a clear verdict', /连接正常|无法连接|HTTP|请先填写/.test(String(tip)), 'tip=' + JSON.stringify(tip));
check('no uncaught exception overall', exc.length === 0, exc.slice(0, 2).join(' | '));
finish();
