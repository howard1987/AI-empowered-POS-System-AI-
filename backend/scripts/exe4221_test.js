/**
 * V4.22.1 EXE 壳 E2E（真实启动 portable EXE + CDP）：
 *   A 首次启动（无配置）→ 服务器配置向导 → 测试连接/保存并启动 → 收银台 PWA 加载
 *   B 坏地址 → 断连错误页（原因可见、重试不白屏）
 *   C win7 轨 ia32 portable 可启动（向导出现）
 * 前置：后端已运行 3100；本机无 EXE 实例。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = 'D:/Software/POS_system/超市收银系统-初版代码/frontend-desktop';
const EXE_MODERN = path.join(ROOT, 'dist-modern', '超市收银系统-4.22.1-x64-portable.exe');
const EXE_WIN7 = path.join(ROOT, 'dist-win7-build', '超市收银系统-4.22.1-win7-ia32-portable.exe');
const CFG = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming'), '超市收银系统', 'desktop-config.json');
const DBG = 9333;

let passed = 0, failed = 0;
const ck = (name, ok, extra) => { console.log((ok ? '  \u2713 ' : '  \u2717 FAIL ') + name + (extra ? '  | ' + String(extra).slice(0, 100) : '')); ok ? passed++ : failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); });

function killExe() {
  try {
    execSync('powershell -NoProfile -Command "Get-Process -Name \'\u8d85\u5e02\u6536\u94f6\u7cfb\u7edf\' -ErrorAction SilentlyContinue | Stop-Process -Force"', { timeout: 15000 });
  } catch { /* 无实例 */ }
  return sleep(1500);
}

// ── 极简 CDP 客户端 ──
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let mid = 0; const pend = new Map();
    ws.onopen = () => res({
      send: (method, params = {}) => new Promise((r2, j2) => {
        const id = ++mid; pend.set(id, { r2, j2 });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (pend.has(id)) { pend.delete(id); j2(new Error('cdp timeout ' + method)); } }, 20000);
      }),
      close: () => { try { ws.close(); } catch { /* noop */ } },
    });
    ws.onerror = e => rej(new Error('ws error'));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j2(new Error(m.error.message)) : p.r2(m.result); }
    };
  });
}
async function evalIn(ws, expr) {
  const r = await ws.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result && r.result.value;
}

async function findTarget(match, timeoutMs, pollMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await getJson(`http://127.0.0.1:${DBG}/json/list`);
      const t = (Array.isArray(list) ? list : []).find(x => x.type === 'page' && String(x.url).includes(match));
      if (t) return t;
    } catch { /* 未就绪 */ }
    await sleep(pollMs);
  }
  return null;
}

async function launch(exe) {
  await killExe();
  spawn(exe, [`--remote-debugging-port=${DBG}`], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {   // portable 解压可能较慢
    try { await getJson(`http://127.0.0.1:${DBG}/json/version`); return true; } catch { await sleep(1000); }
  }
  return false;
}

(async () => {
  console.log('== V4.22.1 EXE 壳 E2E ==');
  // 前置：后端在线
  let up = false;
  for (let i = 0; i < 15; i++) { try { await getJson('http://127.0.0.1:3100/health'); up = true; break; } catch { await sleep(1000); } }
  ck('前置 后端 3100 在线', up);

  try { fs.unlinkSync(CFG); } catch { /* 首跑本来就没有 */ }
  ck('A0 已清除本机配置（模拟首次启动）', !fs.existsSync(CFG));

  // ── A 首次启动 → 配置向导 ──
  ck('A1 启动 modern portable', await launch(EXE_MODERN));
  const setupT = await findTarget('setup.html', 30000);
  ck('A2 首次启动进入配置向导（非白屏）', !!setupT, setupT && setupT.url);
  if (setupT) {
    const ws = await connect(setupT.webSocketDebuggerUrl);
    await ws.send('Runtime.enable');
    ck('A3 向导元素与桥就绪', await evalIn(ws, '!!document.querySelector("#srv") && !!window.DesktopShell && DesktopShell.isDesktop === true'));
    const probe = await evalIn(ws, 'DesktopShell.testServer("http://127.0.0.1:3100")');
    ck('A4 测试连接返回成功', !!(probe && probe.ok), JSON.stringify(probe));
    const saved = await evalIn(ws, 'DesktopShell.saveServer("http://127.0.0.1:3100")');
    ck('A5 保存配置', !!(saved && saved.ok));
    await evalIn(ws, 'DesktopShell.applyAndStart()');
    ws.close();
  }
  const pwaT = await findTarget('/pwa/?desktop=1', 25000);
  ck('A6 保存并启动 → 收银台加载', !!pwaT, pwaT && pwaT.url);
  if (pwaT) {
    const ws = await connect(pwaT.webSocketDebuggerUrl);
    await ws.send('Runtime.enable');
    await sleep(2500);   // 等页面脚本跑起来
    const st = await evalIn(ws, '({ ready: document.readyState, shell: !!(window.DesktopShell && DesktopShell.isDesktop), text: (document.body.innerText || "").length })');
    ck('A7 收银台页就绪（readyComplete + EXE 壳标记 + 有内容）', !!(st && st.ready === 'complete' && st.shell && st.text > 20), JSON.stringify(st));
    ws.close();
  }

  // ── B 坏地址 → 断连错误页 ──
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify({ ui: 'pwa', server: 'http://127.0.0.1:39999' }, null, 2));
  ck('B1 启动（坏地址配置）', await launch(EXE_MODERN));
  const errT = await findTarget('neterr.html', 30000);
  ck('B2 断连显示错误页（非白屏）', !!errT, errT && errT.url);
  if (errT) {
    const ws = await connect(errT.webSocketDebuggerUrl);
    await ws.send('Runtime.enable');
    const info = await evalIn(ws, '({ reason: document.querySelector("#reason").textContent, srv: document.querySelector("#srv").textContent })');
    ck('B3 错误原因可见（服务器地址+原因）', !!(info && info.reason && info.srv.includes('39999')), JSON.stringify(info));
    await evalIn(ws, 'DesktopShell.retryConnect()');
    await sleep(4000);
    const still = await findTarget('neterr.html', 8000);
    ck('B4 重试失败仍留错误页（不白屏不崩溃）', !!still);
    ws.close();
  }
  await killExe();

  // ── C win7 轨 ia32 portable ──
  try { fs.unlinkSync(CFG); } catch { /* noop */ }
  ck('C1 启动 win7 ia32 portable', await launch(EXE_WIN7));
  const setupW7 = await findTarget('setup.html', 30000);
  ck('C2 win7 轨启动进入向导（ia32 在 x64 可运行性验证）', !!setupW7, setupW7 && setupW7.url);
  await killExe();

  // 收尾：好配置留给本机下次直接进收银台
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify({ ui: 'pwa', server: 'http://127.0.0.1:3100' }, null, 2));
  console.log(`\n== PASS=${passed} FAIL=${failed} ==`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
