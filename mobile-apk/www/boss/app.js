'use strict';
/* 老板移动端 · 老板看板（app.js）：登录 / 概览 / 审批 / 报表 / 设置
 * 对端：同源 API（/auth /reports /purchase /inventory /ai /dividend）· 响应式 Web，手机浏览器即开（8.3） */
const LS = { token: 'boss_token' };
let TOKEN = localStorage.getItem(LS.token) || '';
let ME = null;   // {staffId, empNo, name, roles[], perms[], storeName}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n ?? 0).toFixed(2);
const fmt = n => Number(n ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
/* V5.0.14f：按执行价计算的利润率文本（进价缺失/非正 → '—'） */
const marginTxt = (price, cost) => (Number(price) > 0 && Number(cost) > 0)
  ? Math.round((Number(price) - Number(cost)) / Number(price) * 1000) / 10 + '%'
  : '—';
const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** 时间显示：MM-DD HH:mm（移动端窄屏友好） */
const dt = s => { if (!s) return '—'; const d = new Date(s); return isNaN(d.getTime()) ? String(s).slice(0, 16).replace('T', ' ')
  : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const isManager = () => !!ME && (ME.roles || []).some(r => r === '超级管理员' || r === '店长' || r === '老板');

/** API 基址（V5.0.11）：必须「每次请求时动态读取」，不能像原来那样用模块加载时的常量。
 *  原因：老板端原本部署在 https://<服务器>/boss/，与 API 同源，故 API_BASE 写死为空串。
 *  但打进 APK 后前端资源内置在 https://localhost，而 API 在 https://<服务器IP>:3443，
 *  同源假设不成立 —— 请求会打到 https://localhost/auth/me，被本地服务器的 SPA 回退
 *  返回 index.html（实测报「网络异常（HTTP 200）」，因为 res.json() 解析 HTML 失败）。
 *  现在与员工移动端共用同一个地址配置（localStorage.pwa_api_base，在登录页填写一次）。
 *  浏览器直开时为空串 = 同源，行为不变。 */
/** 员工移动端（收银端）地址解析。
 *  两种部署下路径不同，不能写死：
 *    · 服务器部署：老板端在 /boss/，员工端在 /pwa/   → ../pwa/index.html
 *    · APK 内置  ：老板端在 /boss/，员工端在根目录   → ../index.html
 *  也不能只看 HTTP 状态码：APK 的本地服务器对未知路径会回退返回 index.html（200），
 *  写死任何一个都会在另一种部署下 404（实测跳到 https://localhost/pwa/index.html → 网页无法打开）。
 *  故逐个候选拉取页面内容，用员工端登录页的专属元素 id 作为特征来判定。 */
async function resolvePwaUrl() {
  const cands = ['../index.html', '../pwa/index.html'];
  for (const u of cands) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (!r.ok) continue;
      const html = await r.text();
      if (html.indexOf('lgNo') >= 0) return u;   // 员工端登录页特征元素
    } catch (e) { /* 试下一个 */ }
  }
  return '../index.html';
}
function apiBase() {
  let v = '';
  try {
    v = String(localStorage.getItem('boss_api_base') || localStorage.getItem('pwa_api_base') || '').trim();
  } catch (e) { v = ''; }
  return v.replace(/\/+$/, '');
}
async function api(method, path, body) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: {
      ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({ code: -1, msg: '网络异常（HTTP ' + res.status + '）', data: null }));
}
async function call(method, path, body) {
  const r = await api(method, path, body);
  if (r.code !== 0) {
    // V5.0.11：挂上业务码，老板端才能像员工端一样按 40307（设备未授权）等分支处理
    const e = new Error(r.msg || ('请求失败 #' + r.code));
    e.bizCode = Number(r.code) || 0;
    throw e;
  }
  return r.data;
}
function unwrap(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.items)) return d.items;
  if (d && Array.isArray(d.data)) return d.data;
  return d || [];
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ── Tab 路由 + V4.9.8 子页面返回栈 ──
let CURRENT_TAB = 'overview';
const stack = [];                       // [{title, fn, args}]
const TAB_TITLE = { overview: '👔 老板看板', approve: '✅ 审批', reports: '📈 报表', settings: '⚙️ 设置', notices: '🔔 消息' };
const TAB_FN = { overview: () => View.overview, approve: () => View.approve, reports: () => View.reports, settings: () => View.settings, notices: () => View.notices };

function openTab(tabId) {
  CURRENT_TAB = tabId;
  stack.length = 0;
  document.querySelectorAll('#tabbar .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tabId));
  const view = $('#view'); if (view) { view.style.transform = ''; view.style.transition = ''; }
  renderStack();
}
function initTabSwipe() {
  const view = $('#view');
  if (!view || view.dataset.swipe) return;
  view.dataset.swipe = '1';
  const TABS = ['overview', 'approve', 'reports', 'notices', 'settings'];
  const exclude = el => el.closest('.tw, canvas, input, textarea, select, .chipbar');
  let sx = 0, sy = 0, st = 0, horiz = false, dx = 0, blocked = false;
  view.addEventListener('touchstart', e => {
    if (stack.length) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now();
    horiz = false; dx = 0; blocked = !!exclude(e.target);
    view.style.transition = 'none';
  }, { passive: true });
  view.addEventListener('touchmove', e => {
    if (stack.length || blocked) return;
    const t = e.touches[0];
    dx = t.clientX - sx; const dy = t.clientY - sy;
    if (!horiz) { if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) horiz = true; else return; }
    view.style.transform = `translateX(${dx * 0.35}px)`;
  }, { passive: true });
  view.addEventListener('touchend', e => {
    if (stack.length || !horiz || blocked) { view.style.transform = ''; blocked = false; return; }
    const elapsed = Math.max(1, Date.now() - st);
    const fast = Math.abs(dx) / elapsed > 0.30 && Math.abs(dx) > 45;
    const idx = TABS.indexOf(CURRENT_TAB);
    view.style.transition = 'transform .18s ease-out';
    if (fast && idx >= 0) {
      const dir = dx < 0 ? 1 : -1;
      const next = TABS[idx + dir];
      if (next) {
        const tw = view.offsetWidth;
        view.style.transform = `translateX(${dir < 0 ? -tw : tw}px)`;
        setTimeout(() => openTab(next), 180);
        return;
      }
    }
    view.style.transform = 'translateX(0)';
    setTimeout(() => { view.style.transform = ''; view.style.transition = ''; }, 180);
  });
}
/* ═══ V5.0.14b Android 物理返回键（与员工端同优先级）═══
 *  真机投诉：老板端按返回键直接退出/无效。原因：Capacitor 壳无 backButton 监听时走
 *  WebView 默认历史回退，而老板端历史栈语义与页面状态不同步。
 *  统一动作（与员工端 backAction 同优先级）：
 *    关最上层弹窗 → 子页出栈 → 非概览回「概览」→ 概览页 2 秒内双击退出应用 */
let exitArmedAt = 0;
function backAction() {
  const modals = document.querySelectorAll('.modal');
  if (modals.length) { modals[modals.length - 1].remove(); return; }
  if (stack.length) { stack.pop(); renderStack(); return; }
  if (CURRENT_TAB !== 'overview') { openTab('overview'); return; }
  const now = Date.now();
  if (now - exitArmedAt < 2000) {
    exitArmedAt = 0;
    try { window.Capacitor.Plugins.App.exitApp(); } catch { /* 浏览器无此插件 */ }
    return;
  }
  exitArmedAt = now;
  toast('再按一次返回键退出应用');
}
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('backButton', () => backAction());
} else {
  // 浏览器端：popstate 与页面状态对齐（哨兵防一按就离开站点）
  window.addEventListener('popstate', () => {
    backAction();
    try { history.pushState({ bossSentinel: 1 }, ''); } catch { /* 忽略 */ }
  });
  try { history.pushState({ bossSentinel: 1 }, ''); } catch { /* 忽略 */ }
}
// ── VQA 体检项：老板端消息中心（缺纸/秤离线/对账差异等服务端告警的触达出口）──
async function refreshNoticesBadge() {
  try {
    if (!TOKEN) return;
    const d = await call('GET', '/finance/notices/unread');
    setNoticesBadge(Number(d.n || d.count || 0));
  } catch { /* 未登录/无权限静默 */ }
}
function setNoticesBadge(n) {
  const b = $('#tabNoticesN');
  if (!b) return;
  b.textContent = String(n);
  b.classList.toggle('hidden', !n);
}
/** 进子页面（报表明细 / 单据详情）：压栈 + 压 history，手机返回键可直接回退 */
function push(title, fn, args) {
  stack.push({ title, fn, args });
  try { history.pushState({ bossDepth: stack.length }, ''); } catch { /* 忽略 */ }
  renderStack();
}
function popView() {
  if (!stack.length) return false;
  stack.pop();
  renderStack();
  return true;
}
/** 同层刷新（切换区间/搜索）：替换栈顶，不新增返回层级 */
function replace(title, fn, args) {
  if (stack.length) stack[stack.length - 1] = { title, fn, args };
  return renderStack();
}
async function renderStack() {
  const v = $('#view');
  $('#hdBack').classList.toggle('hidden', !stack.length);
  if (stack.length) {
    const top = stack[stack.length - 1];
    $('#hdTitle').textContent = top.title;
    $('#hdSub').textContent = '‹ 返回上级';
    try { await top.fn(v, top.args); }
    catch (e) { v.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><button class="btn ghost" style="margin:12px auto 0;width:auto;padding:8px 22px" id="rtRetry">重试</button></div>`; $('#rtRetry').onclick = () => renderStack(); }
    return;
  }
  $('#hdTitle').textContent = TAB_TITLE[CURRENT_TAB] || '老板看板';
  $('#hdSub').textContent = `${ME ? ME.name + ' · ' : ''}${nowHM()} 更新 · 下拉可刷新`;
  renderTab();
}
async function renderTab() {
  const v = $('#view');
  try { await TAB_FN[CURRENT_TAB]()(v); }
  catch (e) {
    v.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><button class="btn ghost" style="margin:12px auto 0;width:auto;padding:8px 22px" onclick="openTab('${CURRENT_TAB}')">重试</button></div>`;
  }
}
$('#hdBack').onclick = () => {
  if (history.state && history.state.bossDepth) history.back();
  else { popView(); if (!stack.length) renderTab(); }
};
window.addEventListener('popstate', () => { if (stack.length) popView(); });
document.querySelectorAll('#tabbar .tab').forEach(b => b.onclick = () => openTab(b.dataset.tab));
initTabSwipe();

// ── 认证 ──
// V5.0.11 设备身份：与员工端同一套算法，但老板端页面只加载本文件，故此处自带实现。
// 两端必须保持完全一致——
//   ① IndexedDB 库名固定为 'pos_device_key'（同源共享同一把设备密钥，避免切换应用时被判成"设备码被复制"）；
//   ② 设备码也共享（本地键 boss_device_code ↔ pwa_device_code 互为兜底）；
//   ③ 签名载荷拼接顺序必须与服务端 deviceSignPayload() 完全一致。
// 私钥 extractable:false 并存于 IndexedDB（结构化克隆可存 CryptoKey），拷到别的机器无法使用。
const DEV_KEY_STORE = 'pos_device_key';
let _devKeyCache;
function b64FromBuf(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function openDevKeyDb() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
    const rq = indexedDB.open(DEV_KEY_STORE, 1);
    rq.onupgradeneeded = () => { try { rq.result.createObjectStore('kv'); } catch { } };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error || new Error('idb open failed'));
  });
}
async function idbGet(k) { const db = await openDevKeyDb(); return new Promise((res, rej) => { const t = db.transaction('kv','readonly').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
async function idbSet(k, v) { const db = await openDevKeyDb(); return new Promise((res, rej) => { const t = db.transaction('kv','readwrite').objectStore('kv').put(v, k); t.onsuccess = () => res(true); t.onerror = () => rej(t.error); }); }
async function deviceKey() {
  if (_devKeyCache !== undefined) return _devKeyCache;
  try {
    if (!window.crypto || !crypto.subtle) { _devKeyCache = null; return null; }
    /* V5.0.14f：维持原始 CryptoKey 持久化（与员工端同口径，真机实测稳定）。 */
    let pair = await idbGet('pair');
    if (!pair || !pair.privateKey) {
      pair = await crypto.subtle.generateKey(
        { name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' },
        false, ['sign','verify']);
      await idbSet('pair', pair);
    }
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    _devKeyCache = {
      pubKeyB64: b64FromBuf(spki),
      sign: async (p) => b64FromBuf(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(p))),
    };
  } catch (e) { _devKeyCache = null; }   // 隐私模式等：降级为仅设备码
  return _devKeyCache;
}
function deviceType() {
  try {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      return (cap.Plugins && cap.Plugins.NativeScanner) ? 'mobile' : 'pad';
    }
  } catch { }
  const ua = navigator.userAgent || '';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'pad';
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'pad';
  if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
  return 'pc';
}
/* V5.0.14b：设备码持久化升级（与员工端同口径）——权威源 = IndexedDB（与设备私钥同库，
 * 最抗 WebView 存储回收/清理），localStorage 作迁移兜底。旧版只存 localStorage，
 * 被清空后会随机生成**新设备码** → 服务端视为未登记设备 → 每次登录都要重新配对
 * （真机投诉「授权状态不被记住」的根因）。 */
async function deviceCode() {
  let c = '';
  try { c = String((await idbGet('device_code')) || '').trim(); } catch { c = ''; }
  if (!c) {
    // 迁移：老版本只存 localStorage，读到就升级进 IndexedDB
    try { c = String(localStorage.getItem('pwa_device_code') || localStorage.getItem('boss_device_code') || '').trim(); } catch { c = ''; }
  }
  if (!c) {
    const pfx = deviceType() === 'pc' ? 'PC' : deviceType() === 'pad' ? 'PAD' : 'MB';
    const b = new Uint8Array(4); (crypto || {}).getRandomValues && crypto.getRandomValues(b);
    c = pfx + '-' + Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  try { localStorage.setItem('boss_device_code', c); } catch { }
  try { localStorage.setItem('pwa_device_code', c); } catch { }
  try { await idbSet('device_code', c); } catch { }
  return c;
}
function devNonce() {
  const b = new Uint8Array(12); (crypto || {}).getRandomValues && crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
}
async function bossDeviceCred(empNo, recovery, pair) {
  const code = await deviceCode();
  const dev = { code, type: deviceType() };
  if (recovery) dev.recovery = String(recovery).trim();
  if (pair) dev.pair = String(pair).trim().toUpperCase();   // V5.0.11b 配对码
  // V5.0.11e：APK 上报 Android 设备名（vivo X100），浏览器拿不到则留空由后端按 UA 识别
  try {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      const p = cap.Plugins && cap.Plugins.NativeScanner;
      if (p && typeof p.deviceName === 'function') {
        const r = await p.deviceName();
        const n = String((r && r.name) || '').trim();
        if (n) dev.name = n;
      }
    }
  } catch { /* 原生不可用则退回 UA 识别 */ }
  const key = await deviceKey();
  if (key) {
    try {
      const ts = Date.now(), nonce = devNonce();
      dev.pubkey = key.pubKeyB64; dev.ts = ts; dev.nonce = nonce;
      dev.sig = await key.sign(`${empNo}|${code}|${ts}|${nonce}`);
    } catch { }
  }
  return dev;
}
async function login(empNo, password, recovery, pair) {
  const d = await call('POST', '/auth/login', { empNo, password, device: await bossDeviceCred(empNo, recovery, pair) });
  TOKEN = d.token;
  localStorage.setItem(LS.token, TOKEN);
  await loadMe();
  showMain();
}
/** V5.0.11b 老板端配对码对话框（与员工端同一流程，样式沿用本页 .modal/.sheet 约定） */
async function showBossPairDialog(msg, empNo) {
  const code = await deviceCode();
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet" style="width:min(430px,94vw)">
    <h3>该设备未授权</h3>
    <div class="hint" style="margin:0 0 10px">${(msg || '该设备未授权，暂无法登录，请联系管理员进行授权').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
    <div class="kv"><span class="k">本机设备码</span><span class="v" style="font-family:ui-monospace,Consolas,monospace;font-weight:700">${code.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span></div>
    <div class="hint" style="margin:8px 0 10px">请把上面的<b>设备码</b>告诉管理员，由其在「系统设置 → 设备管理」为本设备生成<b>配对码</b>。</div>
    <div class="field"><label>配对码</label>
      <input id="bpPair" type="text" autocomplete="off" autocapitalize="characters" maxlength="12"
             placeholder="例如 K7M2XP9A" style="font-family:ui-monospace,Consolas,monospace;letter-spacing:2px;text-transform:uppercase"></div>
    <div id="bpErr" class="hint" style="margin:-4px 0 8px;color:var(--bad);min-height:16px"></div>
    <button class="btn ok" id="bpGo" style="width:100%">配对并登录</button>
    <details style="margin-top:10px">
      <summary class="hint" style="cursor:pointer">管理员被锁在门外？用应急恢复码</summary>
      <div class="field" style="margin-top:6px"><input id="bpRec" type="password" autocomplete="off" placeholder="应急恢复码"></div>
      <button class="btn ghost" id="bpRecGo" style="width:100%">用恢复码重试</button>
    </details>
    <button class="btn ghost" id="bpX" style="width:100%;margin-top:8px">关闭</button></div>`;
  document.body.appendChild(m);
  const errBox = m.querySelector('#bpErr');
  const inp = m.querySelector('#bpPair');
  inp.oninput = () => { inp.value = inp.value.replace(/\s+/g, '').toUpperCase(); };
  setTimeout(() => { try { inp.focus(); } catch { /* noop */ } }, 50);
  m.querySelector('#bpX').onclick = () => m.remove();
  const retry = async (pair, rec) => {
    const btn = m.querySelector('#bpGo');
    btn.disabled = true; errBox.textContent = '';
    try {
      await login(empNo, $('#lgPw').value, rec, pair);
      m.remove();
      toast('配对成功，已授权本设备');
    } catch (e) {
      if (e && e.bizCode === 40307) { m.remove(); setTimeout(() => showBossPairDialog(e.message, empNo), 0); return; }
      errBox.textContent = (e && e.message) || String(e);
      try { inp.focus(); inp.select(); } catch { /* noop */ }
    } finally { btn.disabled = false; }
  };
  m.querySelector('#bpGo').onclick = () => {
    const p = (inp.value || '').trim();
    if (!p) { errBox.textContent = '请输入管理员提供的配对码'; return; }
    retry(p, '');
  };
  m.querySelector('#bpRecGo').onclick = () => {
    const r = (m.querySelector('#bpRec').value || '').trim();
    if (!r) { errBox.textContent = '请输入应急恢复码'; return; }
    retry('', r);
  };
}
async function loadMe() {
  const d = await call('GET', '/auth/me');
  ME = { staffId: d.staffId, empNo: d.empNo, name: d.name, storeName: d.storeName || '本店', roles: d.roles || [], perms: d.perms || [] };
  if (!isManager()) toast('当前账号非老板/店长角色，部分数据可能不可见');
  return ME;
}
function logout() {
  TOKEN = ''; ME = null;
  /* V5.0.14b：统一登录入口 —— 退出后回员工端初始登录页（由账号角色判定进哪个端），
   * 不再停留在老板端自己的登录页。同会话的员工端登录态一并清除（单一会话口径）。 */
  try { localStorage.removeItem('pwa_token'); } catch { }
  try { localStorage.removeItem('pwa_post_login'); } catch { }
  resolvePwaUrl().then(u => { location.replace(u || location.pathname); });
}
function showMain() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#hdStore').textContent = (ME.storeName || '本店') + ' · ' + nowHM();
  openTab('overview');
}
$('#lgGo').onclick = async () => {
  const err = $('#authErr');
  err.textContent = '';
  try {
    await login($('#lgNo').value.trim(), $('#lgPw').value);
    toast('登录成功');
  } catch (e) {
    // V5.0.11b 设备未授权 → 弹配对码框（老板手机换机时同样要走配对）
    if (e && e.bizCode === 40307) {
      err.textContent = '该设备未授权，暂无法登录，请联系管理员进行授权';
      showBossPairDialog(e.message, $('#lgNo').value.trim());
      return;
    }
    err.textContent = e.message;
  }
};
$('#lgNo').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lgPw').focus(); });
$('#lgPw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lgGo').click(); });

// ── 数据聚合：今日经营 + 待办数 ──
let CACHE = null;   // {overview, dashboard, approveN}
async function loadData() {
  if (CACHE) return CACHE;
  const [ov, db] = await Promise.all([
    call('GET', '/reports/overview'),
    call('GET', '/reports/dashboard'),
  ]);
  CACHE = { overview: ov, dashboard: db, approveN: null };
  return CACHE;
}
async function loadApproveCount() {
  try {
    const [inb, ret, loss, po, cnt] = await Promise.all([
      call('GET', '/purchase/inbounds?status=' + encodeURIComponent('未审核')),
      call('GET', '/purchase/returns'),
      call('GET', '/inventory/losses?status=' + encodeURIComponent('待审核')),
      call('GET', '/purchase/orders?status=' + encodeURIComponent('待审批')),
      call('GET', '/inventory/counts'),
    ]);
    return unwrap(inb).length
      + unwrap(ret).filter(r => r.status === '待审核').length
      + unwrap(loss).length
      + unwrap(po).length
      + unwrap(cnt).filter(r => ['进行中', '待差异处理'].includes(r.status)).length;
  } catch { return 0; }
}
async function setApproveBadge(n) {
  const b = $('#tabApproveN');
  b.textContent = String(n);
  b.classList.toggle('hidden', !n);
  const e = $('#eApproveN');
  if (e) { e.textContent = String(n); e.classList.toggle('hidden', !n); }
}

// ── 概览（原型 s-owner：实时提醒 + 今日经营 + 分红 + 宫格）──
const View = {};
View.overview = async function (v) {
  const c = await loadData();
  const ov = c.overview, db = c.dashboard;
  const today = ov.today || {};
  const avgTicket = Number(db.current?.avgTicket ?? 0);
  const stock = ov.stock || {};

  // 实时提醒聚合
  const alerts = [];
  const approveN = c.approveN ?? await loadApproveCount();
  c.approveN = approveN;
  setApproveBadge(approveN);
  if (approveN > 0) alerts.push({ dot: '🔵', txt: `${approveN} 张单据待审批（入库/退货/报损）`, pill: 'blue', tag: '待办', type: 'approve' });
  if (Number(stock.expiringSoon) > 0) alerts.push({ dot: '🟠', txt: `${stock.expiringSoon} 个批次临期预警`, pill: 'orange', tag: '临期', type: 'expiring' });
  if (Number(stock.lowStock) > 0) alerts.push({ dot: '🟡', txt: `${stock.lowStock} 个商品低于安全库存`, pill: 'yellow', tag: '补货', type: 'lowstock' });
  try {
    const fr = await call('GET', '/reports/fraud');
    const s = fr.summary || {};
    if (Number(s.refundCount) > 0 || Number(s.cancelCount) > 0 || Number(s.negProfitCount) > 0) {
      const parts = [];
      if (Number(s.refundCount) > 0) parts.push(`退款 ${s.refundCount} 笔`);
      if (Number(s.cancelCount) > 0) parts.push(`取消 ${s.cancelCount} 单`);
      if (Number(s.negProfitCount) > 0) parts.push(`负毛利 ${s.negProfitCount} 笔`);
      alerts.push({ dot: '🔴', txt: `今日防损提示：${parts.join(' · ')}`, pill: 'red', tag: '防损', type: 'fraud' });
    }
  } catch { /* 防损数据缺失不阻塞 */ }
  try {
    const tasks = unwrap(await call('GET', '/ai/tasks'));
    const running = tasks.filter(t => t.status === '进行中').length;
    if (running > 0) alerts.push({ dot: '🤖', txt: `${running} 个 AI 采集任务进行中`, pill: 'blue', tag: 'AI', type: 'ai' });
  } catch { /* AI 状态缺失不阻塞 */ }
  try {
    const rcv = await call('GET', '/big-customers/receivables-overview');
    if (Number(rcv.totalUnpaid) > 0) {
      const over = Number(rcv.unpaid90) > 0 ? `（超 90 天 ¥${fmt(rcv.unpaid90)}）` : '';
      alerts.push({ dot: '💰', txt: `${rcv.unpaidCustomers} 位大客户未收 ¥${fmt(rcv.totalUnpaid)}${over}`, pill: Number(rcv.unpaid90) > 0 ? 'red' : 'orange', tag: '应收', type: 'receivable' });
    }
  } catch { /* 大客户模块未启用不阻塞 */ }
  if (!alerts.length) alerts.push({ dot: '🟢', txt: '暂无异常提醒，一切正常', pill: 'green', tag: '正常', type: 'ok' });

  v.innerHTML = `
    <div class="alert-card" id="bPosEntry" style="cursor:pointer;">
      <b>🛒 进入收银台</b>
      <div style="font-size:11.5px;opacity:.85;margin-top:4px;">扫码 / 搜索商品 · 挂单 · 交接班　—— 快速切换到收银通道</div>
    </div>

    <div class="alert-card" id="ovAlerts" style="cursor:pointer;margin-top:10px;">
      <b>⚡ 实时提醒（${alerts.length}）<span style="float:right;font-weight:400;font-size:11.5px;color:var(--ink-3)">明细 ›</span></b>
      ${alerts.slice(0, 3).map(a => `
        <div class="al-line" data-atype="${a.type || ''}" style="${a.type && a.type !== 'ok' ? 'cursor:pointer' : ''}"><span>${a.dot} ${esc(a.txt)}</span><span class="pill ${a.pill}">${a.tag}</span></div>`).join('')}
      ${alerts.length > 3 ? `<div class="al-line"><span style="color:var(--ink-3)">…共 ${alerts.length} 条，点击查看全部</span></div>` : ''}
    </div>

    <div class="sec">今日经营（${fmt(today.salesTotal ?? 0)} 元）<span id="ovTodayMore" style="float:right;cursor:pointer;color:var(--pri);font-weight:400">明细 ›</span></div>
    <div class="kpis" id="ovToday" style="cursor:pointer;">
      <div class="kpi"><div class="l">营业额</div><div class="v g num">¥${fmt(today.salesTotal ?? 0)}</div></div>
      <div class="kpi"><div class="l">毛利额</div><div class="v o num">¥${fmt(today.profitTotal ?? 0)}</div></div>
      <div class="kpi"><div class="l">订单数</div><div class="v num">${today.orderCount ?? 0} 单</div></div>
      <div class="kpi"><div class="l">客单价</div><div class="v num">¥${fmt(avgTicket)}</div></div>
    </div>

    <div class="sec">💰 今日分红</div>
    <div class="div-card" id="ovDividend" style="cursor:pointer;">
      <b>分红池<span style="float:right;font-weight:400;font-size:11.5px;color:var(--ink-3)">明细 ›</span></b>
      <div class="dv-line"><span>计提（净利 5% 入池）</span><b class="num">¥${fmt(ov.dividend?.poolTotal ?? 0)}</b></div>
      <div class="dv-line"><span>会员已抵扣</span><b class="num">¥${fmt(ov.dividend?.givenTotal ?? 0)}</b></div>
      <div class="hint" style="margin-top:8px">分红是消费让利回馈：按实付计提 · 仅限消费抵用 · 有封顶与时效（合规口径已锁定）</div>
    </div>

    <div class="sec">快捷入口</div>
    <div class="egrid">
      <button class="e-card" id="ePos"><div class="eic">🛒</div><b>进入收银台</b><small>扫码收银 · 挂单 · 交接班</small></button>
      <button class="e-card" id="eApprove"><div class="eic">✅</div><b>审批 <span class="pill red" id="eApproveN" style="display:none"></span></b><small>退货 / 入库 / 报损审核</small></button>
      <button class="e-card" id="eReports"><div class="eic">📈</div><b>报表中心</b><small>日报 / 周报 / ABC</small></button>
      <button class="e-card" id="eAi"><div class="eic">🤖</div><b>AI 模型</b><small id="eAiSub">查看训练与版本</small></button>
      <button class="e-card" id="eCam"><div class="eic">🏪</div><b>远程监控</b><small>收银台摄像头（授权）</small></button>
    </div>`;

  // V5.0.13：概览三卡点击 → 明细子页（push，可返回）
  $('#ovAlerts').onclick = () => push('⚡ 实时提醒', View.ovAlerts, { alerts });
  /* V5.0.14：提醒的明细——单条提醒直接下钻到「具体是谁」：
   * 如「N 个商品低于安全库存」→ 逐个列出商品/规格/现存量/安全库存。 */
  v.querySelectorAll('#ovAlerts [data-atype]').forEach(el => {
    const t = el.dataset.atype;
    if (!t || t === 'ok') return;
    el.onclick = e => { e.stopPropagation(); push('提醒明细', View.alertDetail, { type: t }); };
  });
  $('#ovTodayMore').onclick = e => { e.stopPropagation(); push('今日经营明细', View.ovToday, { today, avgTicket }); };
  $('#ovToday').onclick = () => push('今日经营明细', View.ovToday, { today, avgTicket });
  $('#ovDividend').onclick = () => push('今日分红', View.ovDividend, { ov });

  // V5.0.11：快速切换到收银通道。老板端与员工移动端是同源的两个应用，共用 localStorage，
  // 故把 token 与设备码同步过去即可免密进入，无需二次登录。
  /* V5.0.13b 统一入口：概览大卡（#bPosEntry，此前只有 cursor:pointer 没绑事件=点了没反应）
   * 与快捷入口（#ePos）共用 goCheckout；跳转前打 sessionStorage.pwa_from_boss 会话标记——
   * 员工端返回键在根页见此标记时跳回老板看板（而不是退出应用），看板⇄收银台往返闭环。 */
  const goCheckout = async () => {
    const btn = $('#ePos');
    if (btn) { btn.disabled = true; }
    try { localStorage.setItem('pwa_token', TOKEN); } catch { }
    try { const dc = localStorage.getItem('boss_device_code'); if (dc) localStorage.setItem('pwa_device_code', dc); } catch { }
    try { localStorage.setItem('pwa_post_login', 'checkout'); } catch { }   // 让 PWA 登录后直接落收银台
    try { sessionStorage.setItem('pwa_from_boss', '1'); } catch { }         // V5.0.13b：员工端返回键据此回看板
    location.href = await resolvePwaUrl();
  };
  $('#bPosEntry').onclick = goCheckout;
  $('#ePos').onclick = goCheckout;
  $('#eApprove').onclick = () => openTab('approve');
  $('#eReports').onclick = () => openTab('reports');
  $('#eAi').onclick = async () => {
    try {
      const [models, tasks] = await Promise.all([
        call('GET', '/ai/models'), call('GET', '/ai/tasks'),
      ]);
      const m = unwrap(models), t = unwrap(tasks);
      const running = t.filter(x => x.status === '进行中').length;
      toast(`AI 模型 ${m.length} 个 · 进行中任务 ${running} 个${m.length ? ' · 版本管理在后台' : '（尚无已发布模型，训练中）'}`);
    } catch { toast('AI 模型数据暂不可用'); }
  };
  $('#eCam').onclick = () => toast('远程监控需在后台授权收银台摄像头');
  setApproveBadge(approveN);
};

/* ── V5.0.13 概览明细子页：实时提醒 / 今日经营 / 今日分红 ── */
View.ovAlerts = async function (v, arg) {
  const a = arg.alerts || [];
  v.innerHTML = `
    <div class="hint">实时提醒按门店当前状态实时聚合。待办审批在底部「审批」处理；报表与趋势在「报表」查看。</div>
    ${a.map(x => `<div class="row"><div style="font-size:18px">${x.dot}</div>
      <div class="grow"><div class="t">${esc(x.txt)}</div></div>
      <span class="pill ${x.pill}">${x.tag}</span></div>`).join('')}`;
};
View.ovToday = async function (v, arg) {
  const t = arg.today || {};
  v.innerHTML = `
    <div class="card">
      <div class="kv"><span class="k">营业额</span><span class="v num">¥${fmt(t.salesTotal ?? 0)}</span></div>
      <div class="kv"><span class="k">毛利额</span><span class="v num">¥${fmt(t.profitTotal ?? 0)}</span></div>
      <div class="kv"><span class="k">订单数</span><span class="v num">${t.orderCount ?? 0} 单</span></div>
      <div class="kv"><span class="k">客单价</span><span class="v num">¥${fmt(arg.avgTicket ?? 0)}</span></div>
    </div>
    <div class="hint">7 日趋势 / 分类占比 / 热力格请见底部「报表」；每笔订单明细在「报表 → 营业日报」。</div>
    <button class="btn" style="margin-top:12px" onclick="openTab('reports')">📈 打开报表中心</button>`;
};
View.ovDividend = async function (v, arg) {
  const dv = (arg.ov || {}).dividend || {};
  v.innerHTML = `
    <div class="div-card">
      <b>分红池（今日）</b>
      <div class="dv-line"><span>计提（净利 5% 入池）</span><b class="num">¥${fmt(dv.poolTotal ?? 0)}</b></div>
      <div class="dv-line"><span>会员已抵扣</span><b class="num">¥${fmt(dv.givenTotal ?? 0)}</b></div>
    </div>
    <div class="card" style="margin-top:10px">
      <div class="kv"><span class="k">计提规则</span><span class="v">按实付金额 · 净利 5% 入池</span></div>
      <div class="kv"><span class="k">使用范围</span><span class="v">仅限会员消费抵用</span></div>
      <div class="kv"><span class="k">封顶 / 时效</span><span class="v">有封顶与时效（合规口径已锁定）</span></div>
    </div>
    <div class="hint">历史分红记录与会员抵扣明细请在收银后台「分红管理」中查看。</div>`;
};

/* ── V5.0.14 提醒下钻明细：按提醒类型拉「具体是谁」的清单 ──
 *  lowstock → /inventory/summary?onlyShort=1（商品/规格/现存量/安全库存/缺口）
 *  expiring → /inventory/expiry-alerts（批次/剩余/到期日/处置状态）
 *  fraud    → /reports/fraud 的按收银员明细
 *  ai       → /ai/tasks 进行中清单
 *  receivable → /big-customers/receivables-overview 的 top 客户
 *  approve  → 直接切到「审批」Tab（那里本就是完整清单） */
View.alertDetail = async function (v, arg) {
  const t = arg.type;
  const loading = `<div class="empty">加载中…</div>`;
  if (t === 'approve') { openTab('approve'); return; }
  v.innerHTML = loading;
  try {
    if (t === 'lowstock') {
      const rows = await call('GET', '/inventory/summary?onlyShort=1');
      const items = (Array.isArray(rows) ? rows : (rows.items || [])).filter(x => x.is_low);
      v.innerHTML = `<div class="hint">共 ${items.length} 个商品低于安全库存（建议尽快补货；供应商列供叫货参考）</div>` +
        tbl(['商品', '规格', '现存量', '安全库存', '缺口', '供应商'],
          items.map(x => {
            const gap = Math.max(0, Number(x.min_stock || 0) - Number(x.qty_total || 0));
            return [esc(x.name || ''), esc(x.spec || ''), `${x.qty_total ?? 0}${x.base_unit || ''}`,
                    `${x.min_stock ?? 0}`, `<b style="color:var(--red)">${gap}</b>`, esc(x.supplier_name || '—')];
          }));
    } else if (t === 'expiring') {
      const rows = await call('GET', '/inventory/expiry-alerts');
      const items = Array.isArray(rows) ? rows : (rows.items || []);
      v.innerHTML = `<div class="hint">共 ${items.length} 个批次临期（橙 ≤3 天优先处置；超时未处置有处罚标记）</div>` +
        tbl(['商品', '批次', '剩余', '到期日', '剩天', '处置'],
          items.map(x => [esc(x.product_name || ''), esc(x.batch_no || ''),
                          `${x.remain_qty}${x.base_unit || ''}`, esc(String(x.expiry_date || '').slice(0, 10)),
                          `<b style="color:${x.warn_level === '橙' ? 'var(--red)' : 'var(--ink)'}">${x.days_left}天(${esc(x.warn_level)})</b>`,
                          esc(x.disposal_status || '未处理')]));
    } else if (t === 'fraud') {
      const r = await call('GET', '/reports/fraud');
      const items = (r.byCashier || []).filter(x => Number(x.cancelCount) > 0 || Number(x.refundCount) > 0 || Number(x.negProfitCount) > 0);
      v.innerHTML = `<div class="hint">今日按收银员异常明细（取消/退款/负毛利；用于差错复核而非追责）</div>` +
        tbl(['收银员', '单数', '取消', '退款笔', '退款额', '负毛利笔'],
          items.map(x => [esc(x.name || ''), x.orderCount, x.cancelCount, x.refundCount,
                          `¥${fmt(x.refundAmount)}`, x.negProfitCount]));
    } else if (t === 'ai') {
      const tasks = await call('GET', '/ai/tasks');
      const items = (Array.isArray(tasks) ? tasks : []).filter(x => x.status === '进行中');
      v.innerHTML = `<div class="hint">进行中的 AI 训练/采集任务（样本采集进度在「AI 训练采集」页可看）</div>` +
        tbl(['任务', '状态', '创建时间'],
          items.map(x => [esc(x.name || x.kind || ''), esc(x.status || ''), esc(String(x.created_at || '').replace('T', ' ').slice(5, 16))]));
    } else if (t === 'receivable') {
      const r = await call('GET', '/big-customers/receivables-overview');
      const items = r.top || [];
      v.innerHTML = `<div class="hint">未收 TOP5 大客户（合计 ¥${fmt(r.totalUnpaid)}，超90天 ¥${fmt(r.unpaid90)}）；台账详情在后台「大客户」模块</div>` +
        tbl(['客户', '未收金额', '其中超90天'],
          items.map(x => [esc(x.name || ''), `¥${fmt(x.unpaid)}`,
                          x.over90 > 0 ? `<b style="color:var(--red)">¥${fmt(x.over90)}</b>` : '—']));
    } else {
      v.innerHTML = '<div class="empty">该提醒暂无可下钻的明细</div>';
    }
  } catch (e) {
    v.innerHTML = `<div class="empty">明细加载失败：${esc(e.message || e)}</div>`;
  }
};

/* ── 审批单据类型元数据（详情接口 / 通过 / 驳回）── */
const DOC_META = {
  in: { icon: '📦', name: '采购入库', detail: id => `/purchase/inbounds/${id}`,
        pass: id => ['POST', `/purchase/inbounds/${id}/audit`, undefined], reject: id => `/purchase/inbounds/${id}/reject`,
        amount: o => o.total_amount, no: o => o.inbound_no },
  ret: { icon: '↩️', name: '采购退货', detail: id => `/purchase/returns/${id}`,
        pass: id => ['POST', `/purchase/returns/${id}/audit`, undefined], reject: id => `/purchase/returns/${id}/reject`,
        amount: o => o.total_amount ?? o.amount, no: o => o.return_no },
  loss: { icon: '📷', name: '报损单', detail: id => `/inventory/losses/${id}`,
        pass: id => ['POST', `/inventory/losses/${id}/audit`, undefined], reject: id => `/inventory/losses/${id}/reject`,
        amount: o => o.total_cost, no: o => o.loss_no },
  count: { icon: '🧮', name: '盘点单', detail: id => `/inventory/counts/${id}`,
        pass: id => ['POST', `/inventory/counts/${id}/audit`, undefined], reject: id => `/inventory/counts/${id}/reject`,
        amount: () => null, no: o => o.count_no },
  po: { icon: '📋', name: '采购订单', detail: id => `/purchase/orders/${id}`,
        pass: id => ['POST', `/purchase/orders/${id}/approve`, {}], reject: id => `/purchase/orders/${id}/void`,
        amount: o => o.total_amount, no: o => o.po_no, needSign: true },
};

View.approve = async function (v) {
  const [inb, ret, loss, po, cnt] = await Promise.all([
    call('GET', '/purchase/inbounds?status=' + encodeURIComponent('未审核')).catch(() => []),
    call('GET', '/purchase/returns').catch(() => []),
    call('GET', '/inventory/losses?status=' + encodeURIComponent('待审核')).catch(() => []),
    call('GET', '/purchase/orders?status=' + encodeURIComponent('待审批')).catch(() => []),
    call('GET', '/inventory/counts').catch(() => []),
  ]);
  const rows = [];
  unwrap(inb).forEach(r => rows.push({ type: 'in', id: Number(r.id), st: r.status, no: r.inbound_no, name: '供应商：' + (r.supplier_name || '—'), extra: `${r.item_count ?? 0} 项`, time: r.created_at }));
  unwrap(ret).filter(r => r.status === '待审核').forEach(r => rows.push({ type: 'ret', id: Number(r.id), st: r.status, no: r.return_no, name: '供应商：' + (r.supplier_name || '—'), extra: money(r.total_amount ?? r.amount ?? 0) + (r.evidence_path ? ' · 📷有凭证' : ' · ⚠️无凭证'), time: r.created_at }));
  unwrap(loss).forEach(r => rows.push({ type: 'loss', id: Number(r.id), st: r.status, no: r.loss_no, name: '报损：' + (r.reason_type || ''), extra: money(r.total_cost ?? 0), time: r.created_at }));
  unwrap(cnt).filter(r => ['进行中', '待差异处理'].includes(r.status)).forEach(r => rows.push({ type: 'count', id: Number(r.id), st: r.status, no: r.count_no, name: '范围：' + (r.scope || '全仓'), extra: `${r.item_count ?? 0} 项`, time: r.created_at }));
  unwrap(po).forEach(r => rows.push({ type: 'po', id: Number(r.id), st: r.status, no: r.po_no, name: '供应商：' + (r.supplier_name || '—'), extra: `${r.item_count ?? 0} 项 · ¥${money(r.total_amount ?? 0)}`, time: r.created_at }));
  rows.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  setApproveBadge(rows.length);
  v.innerHTML = `
    <div class="sec">待办审批（${rows.length}）· 点单据可查看详情并通过 / 驳回</div>
    ${rows.length ? rows.map((r, i) => `
      <div class="row" data-ap="${i}">
        <div style="font-size:20px">${DOC_META[r.type].icon}</div>
        <div class="grow">
          <div class="t">${esc(r.no)} <span class="pill orange">${esc(r.st)}</span></div>
          <div class="s">${DOC_META[r.type].name} · ${esc(r.name)} · ${esc(r.extra)}<br>${dt(r.time)}</div>
        </div>
        <span class="pill gray">处理 ›</span>
      </div>`).join('')
    : '<div class="empty">暂无待审批单据 ✅</div>'}
    <div class="hint">手机端审批与后台同权限、同留痕；驳回必须填原因。采购订单审批需电子签名。</div>`;
  v.querySelectorAll('[data-ap]').forEach(el => el.onclick = () => {
    const r = rows[Number(el.dataset.ap)];
    push(DOC_META[r.type].name, View.approveDetail, { type: r.type, id: r.id });
  });
};

/* ── 单据详情 + 通过 / 驳回 ── */
View.approveDetail = async function (v, arg) {
  const meta = DOC_META[arg.type];
  const d = await call('GET', meta.detail(arg.id));
  const o = d.order || d;
  const items = d.items || [];
  const canAct = ['未审核', '待审核', '进行中', '待差异处理', '待审批'].includes(o.status);
  const dt2 = s => s ? String(s).slice(0, 16).replace('T', ' ') : '—';
  const rows = items.map(it => {
    const qty = Number(it.qty ?? it.arrived_qty ?? 0);
    const price = Number(it.unit_cost ?? it.price ?? it.unit_price ?? 0);
    if (arg.type === 'count') {
      return [esc(it.product_name), `${n0(it.book_qty ?? it.system_qty ?? 0)} → ${n0(it.actual_qty ?? 0)}`,
        (Number(it.actual_qty ?? 0) - Number(it.book_qty ?? it.system_qty ?? 0)) || 0, '', ''];
    }
    return [esc(it.product_name), n0(qty), esc(it.batch_no || '—'), n2(price), n2(qty * price)];
  });
  const head = arg.type === 'count'
    ? ['商品', '账面→实盘', '差异', '', '']
    : ['商品', '数量', '批次', '单价', '金额'];
  const total = items.length;   // 明细笔数（金额以服务端口径为准）
  v.innerHTML = `
    <div class="card">
      <div class="kv"><span class="k">单号</span><span class="v">${esc(meta.no(o))}</span></div>
      <div class="kv"><span class="k">类型</span><span class="v">${meta.icon} ${meta.name}</span></div>
      ${o.supplier_name ? `<div class="kv"><span class="k">供应商</span><span class="v">${esc(o.supplier_name)}</span></div>` : ''}
      <div class="kv"><span class="k">状态</span><span class="v"><span class="pill ${canAct ? 'orange' : 'green'}">${esc(o.status)}</span></span></div>
      ${meta.amount(o) != null ? `<div class="kv"><span class="k">金额</span><span class="v num">¥${money(meta.amount(o))}</span></div>` : ''}
      ${o.employee_name || o.maker_name ? `<div class="kv"><span class="k">制单人</span><span class="v">${esc(o.employee_name || o.maker_name)}</span></div>` : ''}
      <div class="kv"><span class="k">创建时间</span><span class="v">${esc(dt2(o.created_at))}</span></div>
      ${o.remark ? `<div class="kv"><span class="k">备注</span><span class="v">${esc(o.remark)}</span></div>` : ''}
      ${o.reject_reason ? `<div class="kv"><span class="k">驳回原因</span><span class="v" style="color:var(--red)">${esc(o.reject_reason)}</span></div>` : ''}
    </div>
    <div class="sec">明细（${items.length} 项）</div>
    ${tbl(head, rows, ['合计', '', '', '', '¥' + money(meta.amount(o) ?? 0)])}
    ${o.evidence_path ? `<div class="sec">退货凭证</div><div class="card"><img src="${esc(o.evidence_path)}" style="width:100%;border-radius:10px"></div>` : ''}
    ${o.photo_path ? `<div class="sec">报损照片</div><div class="card"><img src="${esc(o.photo_path)}" style="width:100%;border-radius:10px"></div>` : ''}
    ${o.sign_image_path ? `<div class="sec">电子签名</div><div class="card"><img src="${esc(o.sign_image_path)}" style="width:100%;border-radius:10px;background:#fff"></div>` : ''}
    ${canAct ? `<div class="acts">
      <button class="btn bad" id="apReject">✖ 驳回</button>
      <button class="btn" id="apPass">✔ 通过</button>
    </div>` : '<div class="hint">该单据已处理，无需再操作。</div>'}
    <div class="hint">通过后单据按后台同口径入库/出库并留痕；驳回后门店可整改重提。</div>`;

  const busy = b => { const p = $('#apPass'), r = $('#apReject'); if (p) p.disabled = b; if (r) r.disabled = b; };
  $('#apPass') && ($('#apPass').onclick = async () => {
    if (!confirm(`确认通过 ${meta.no(o)}？通过后不可撤销。`)) return;
    if (meta.needSign) return signSheet('审批签名', dataUrl => doPass(dataUrl));
    return doPass();
  });
  async function doPass(signature) {
    busy(true);
    try {
      const [m, p, body] = meta.pass(arg.id);
      const payload = meta.needSign ? { signature } : body;
      const r = await call(m, p, payload);
      toast('✅ 已通过：' + (r.status || ''));
      stack.length = 0; openTab('approve');
    } catch (e) { toast(e.message); busy(false); }
  }
  $('#apReject') && ($('#apReject').onclick = async () => {
    const reason = prompt('驳回原因（必填，将留痕并可被门店查看）：') || '';
    if (!reason.trim()) { toast('驳回必须填写原因'); return; }
    busy(true);
    try {
      await call('POST', meta.reject(arg.id), { reason: reason.trim() });
      toast('已驳回');
      stack.length = 0; openTab('approve');
    } catch (e) { toast(e.message); busy(false); }
  });
};

/* ── 签名弹层（采购订单审批须审批人电子签名）── */
function signSheet(title, onOk) {
  const m = document.createElement('div');
  m.className = 'sheet-mask';
  m.innerHTML = `<div class="sheet">
    <button class="sheet-back" id="sgBack">‹ 返回</button>
    <h3>✍️ ${esc(title)}</h3>
    <div class="hint">${esc(ME.name || '')} 请在下方框内签名，作为审批留痕。</div>
    <div class="signwrap"><canvas id="sgCv"></canvas></div>
    <div class="acts">
      <button class="btn ghost" id="sgClear">清除</button>
      <button class="btn" id="sgOk">确认签名</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  const cv = m.querySelector('#sgCv'), ctx = cv.getContext('2d');
  const fit = () => { const r = cv.getBoundingClientRect(); cv.width = r.width * 2; cv.height = 150 * 2; ctx.scale(2, 2); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#22301f'; };
  fit();
  let drawing = false, has = false;
  const pos = e => { const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - r.left, t.clientY - r.top]; };
  const down = e => { e.preventDefault(); drawing = true; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); };
  const move = e => { if (!drawing) return; e.preventDefault(); const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); has = true; };
  const up = () => { drawing = false; };
  cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  m.querySelector('#sgClear').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); has = false; };
  m.querySelector('#sgBack').onclick = () => { m.remove(); };
  m.querySelector('#sgOk').onclick = () => {
    if (!has) { toast('请先签名'); return; }
    m.remove();
    onOk(cv.toDataURL('image/png'));
  };
}

// ── 报表（原型：7 日柱图 + 分类占比 + 汇总）──
View.reports = async function (v) {
  const c = await loadData();
  const db = c.dashboard;
  const trend = (db.trend || []).slice(-7);
  const maxV = Math.max(1, ...trend.map(t => Number(t.salesTotal) || 0));
  const cat = (db.categoryShare || []).slice(0, 5);
  const catTotal = cat.reduce((s, x) => s + Number(x.revenue || 0), 0) || 1;
  const p1 = Math.min(100, (cat[0] ? Number(cat[0].revenue) / catTotal * 100 : 0));
  const p2 = Math.min(100 - p1, (cat[1] ? Number(cat[1].revenue) / catTotal * 100 : 0));
  const cur = db.current || {};
  v.innerHTML = `
    <div class="sec">近 7 日营业额（元）</div>
    <div class="card" style="padding:12px 12px 10px">
      <div class="bars">
        ${trend.map(t => {
          const h = Math.max(2, Math.round(Number(t.salesTotal) / maxV * 100));
          const raw = String(t.bizDate || '');
          const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + 'Z');
          const lb = isNaN(d.getTime()) ? '—' : `${d.getMonth() + 1}/${d.getDate()}`;
          const todayLb = new Date();
          const isHot = lb === `${todayLb.getMonth() + 1}/${todayLb.getDate()}`;
          return `<div class="b"><div class="vl num">${Number(t.salesTotal) ? Math.round(t.salesTotal) : ''}</div><div class="bar${isHot ? ' hot' : ''}" style="height:${h}%"></div><div class="lb">${lb}</div></div>`;
        }).join('')}
      </div>
      <div class="hint" style="margin-top:8px">总营业额 ¥${fmt(trend.reduce((s, t) => s + Number(t.salesTotal || 0), 0))} · 共 ${trend.reduce((s, t) => s + Number(t.orderCount || 0), 0)} 单</div>
    </div>

    <div class="sec">今日分类销售占比</div>
    <div class="card" style="padding:14px">
      <div class="ring-wrap">
        <div class="ring" style="--p1:${p1.toFixed(1)}%;--p2:${p2.toFixed(1)}%"><div class="rc"><b class="num">¥${fmt(cur.salesTotal ?? 0)}</b><small>总销售额</small></div></div>
        <div class="ring-legend">
          ${cat.length ? cat.slice(0, 5).map((x, i) => {
            const colors = ['#20663f', '#e8912d', '#2a6f8e', '#b5544a', '#8a7ba8'];
            return `<div class="rl"><i style="background:${colors[i % 5]}"></i>${esc(x.name)}<b class="num">${Math.round(Number(x.revenue) / catTotal * 100)}%</b></div>`;
          }).join('') : '<div class="empty" style="padding:6px 0">暂无分类数据</div>'}
        </div>
      </div>
    </div>

    <div class="sec">今日汇总</div>
    <div class="card">
      <div class="kv"><span class="k">营业额 / 毛利</span><span class="v num">¥${fmt(cur.salesTotal ?? 0)} / ¥${fmt(cur.profitTotal ?? 0)}</span></div>
      <div class="kv"><span class="k">订单数 / 客单价</span><span class="v num">${cur.orderCount ?? 0} 单 / ¥${fmt(cur.avgTicket ?? 0)}</span></div>
      <div class="kv"><span class="k">新增会员</span><span class="v num">${cur.newMembers ?? 0} 人</span></div>
      <div class="kv"><span class="k">分红计提 / 抵扣</span><span class="v num">¥${fmt(cur.dividendGiven ?? 0)} / ¥${fmt(cur.dividendUsed ?? 0)}</span></div>
    </div>

    <div class="sec">本月营业热力格</div>
    <div class="card" id="heatBox" style="padding:12px"><div class="empty">加载中…</div></div>

    <div class="sec">📑 报表明细（点开可看表格）</div>
    <div class="egrid">
      <button class="e-card" id="rDaily"><div class="eic">📅</div><b>营业日报</b><small>按日：单量/营业额/毛利</small></button>
      <button class="e-card" id="rAbc"><div class="eic">🏷️</div><b>ABC 分类</b><small>销量贡献与分级</small></button>
      <button class="e-card" id="rSku"><div class="eic">📦</div><b>商品销售明细</b><small>可搜商品名</small></button>
      <button class="e-card" id="rMem"><div class="eic">👥</div><b>会员消费榜</b><small>消费/毛利/资产</small></button>
      <button class="e-card" id="rInv"><div class="eic">🧮</div><b>进销存报表</b><small>期初期末/出入库</small></button>
      <button class="e-card" id="rEmp"><div class="eic">🧑‍💼</div><b>员工业绩</b><small>销售额/毛利排行</small></button>
      <button class="e-card" id="rAiQ"><div class="eic">🤖</div><b>AI 识别质量</b><small>纠正率/闭环率/层级分布</small></button>
      <button class="e-card" id="rQa"><div class="eic">🗣️</div><b>经营问答</b><small>一键问毛利/热销/库存</small></button>
      <button class="e-card" id="rRecon"><div class="eic">💰</div><b>账单对账</b><small>微信/支付宝 CSV 核对</small></button>
      <button class="e-card" id="rBrain"><div class="eic">🧠</div><b>AI 建议</b><small>选品/补货/定价待处理</small></button>
      <button class="e-card" id="rLeak"><div class="eic">🛡️</div><b>漏扫告警</b><small>自助收银差异复核</small></button>
    </div>
    <div class="hint">明细默认「近 7 日」，进入后可切换今日 / 本月 / 近 30 日。</div>`;
  renderHeatMonth($('#heatBox'));
  $('#rDaily').onclick = () => push('营业日报', View.repDaily);
  $('#rAbc').onclick = () => push('ABC 分类', View.repAbc);
  $('#rSku').onclick = () => push('商品销售明细', View.repSku);
  $('#rMem').onclick = () => push('会员消费榜', View.repMember);
  $('#rInv').onclick = () => push('进销存报表', View.repInv);
  $('#rEmp').onclick = () => push('员工业绩', View.repEmp);
  $('#rAiQ').onclick = () => push('AI 识别质量', View.aiQuality);
  $('#rQa').onclick = () => push('🗣️ 经营问答', View.brainQa);
  $('#rRecon').onclick = () => push('💰 账单对账', View.billRecon);
  $('#rBrain').onclick = () => push('🧠 AI 建议', View.brainSugg);
  $('#rLeak').onclick = () => push('🛡️ 漏扫告警', View.antiLeak);
};

// ── 本月营业热力格 ──
async function renderHeatMonth(box, metric = 'salesTotal') {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth();
  const first = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const last = `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`;
  const label = { salesTotal: '营业额', orderCount: '订单数' }[metric];
  try {
    const d = await call('GET', `/reports/daily?from=${first}&to=${last}`);
    const days = d.days || [];
    const map = {};
    days.forEach(x => { map[String(x.bizDate).slice(0, 10)] = x; });
    const vals = days.filter(x => Number(x[metric]) > 0).map(x => Number(x[metric])).sort((a, b) => a - b);
    /* V5.0.13：颜色按「占当月最高值的比例」自动分 5 档（相对归一化）。
     * 之前用五分位切点：只有 1 天数据时切点退化（当日永远是最浅一档）。
     * 现在：今日=历史最高 → 颜色最深；最高 3000、今日 1450 → 占比 48% → 中间档。 */
    const mx = Math.max(1, ...vals);
    const level = v => { const n = Number(v) || 0; if (n <= 0) return 0; return Math.min(5, Math.max(1, Math.ceil(n / mx * 5))); };
    const firstDay = new Date(y, m, 1);
    const pad = (firstDay.getDay() + 6) % 7;
    const dim = new Date(y, m + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < pad; i++) cells += '<div class="heat-cell other"></div>';
    for (let day = 1; day <= dim; day++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const data = map[ds];
      const lv = level(data ? data[metric] : 0);
      const sub = data && Number(data[metric]) ? `<span class="sub">${metric === 'salesTotal' ? Math.round(data[metric]) : Number(data[metric])}</span>` : '';
      cells += `<div class="heat-cell l${lv}" data-d="${ds}"><span>${day}</span>${sub}</div>`;
    }
    box.innerHTML = `
      <div class="heat-head"><span class="t">${m + 1}月 · ${label}分布</span><div class="heat-metric">
        <button class="${metric === 'salesTotal' ? 'on' : ''}" data-m="salesTotal">营业额</button>
        <button class="${metric === 'orderCount' ? 'on' : ''}" data-m="orderCount">订单数</button>
      </div></div>
      <div class="heat-wd"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
      <div class="heat-grid">${cells}</div>
      <div class="heat-legend"><span>低</span><i></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><i class="l5"></i><span>高</span></div>`;
    box.querySelectorAll('.heat-metric button').forEach(b => b.onclick = () => renderHeatMonth(box, b.dataset.m));
    box.querySelectorAll('.heat-cell[data-d]').forEach(c => c.onclick = () => showHeatDay(c.dataset.d, map[c.dataset.d], metric));
  } catch (e) {
    box.innerHTML = `<div class="empty">热力格加载失败：${esc(e.message)}</div>`;
  }
}
function showHeatDay(date, data, metric) {
  const d = data || {};
  const avg = d.orderCount ? (Number(d.salesTotal || 0) / Number(d.orderCount)) : 0;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-mask';
  wrap.innerHTML = `<div class="sheet sheet-day" style="max-height:70vh">
    <button class="sheet-back" onclick="this.closest('.sheet-mask').remove()">关闭</button>
    <h3>${date} 营业详情</h3>
    <div class="card" style="margin-top:10px">
      <div class="kv"><span class="k">营业额</span><span class="v num">¥${fmt(d.salesTotal)}</span></div>
      <div class="kv"><span class="k">订单数</span><span class="v num">${n0(d.orderCount)} 单</span></div>
      <div class="kv"><span class="k">成本</span><span class="v num">¥${fmt(d.costTotal)}</span></div>
      <div class="kv"><span class="k">毛利</span><span class="v num">¥${fmt(d.profitTotal)}</span></div>
      <div class="kv"><span class="k">客单价</span><span class="v num">¥${fmt(avg)}</span></div>
    </div>
  </div>`;
  wrap.onclick = e => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
}

// ── V4.9.8 报表明细（移动端表格）──
const dstr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const RANGES = {
  '今日': () => { const t = dstr(new Date()); return [t, t]; },
  '近7日': () => { const e = new Date(), s = new Date(); s.setDate(s.getDate() - 6); return [dstr(s), dstr(e)]; },
  '本月': () => { const n = new Date(); return [dstr(new Date(n.getFullYear(), n.getMonth(), 1)), dstr(n)]; },
  '近30日': () => { const e = new Date(), s = new Date(); s.setDate(s.getDate() - 29); return [dstr(s), dstr(e)]; },
};
function rangeBar(cur, onPick) {
  return `<div class="chipbar">${Object.keys(RANGES).map(k =>
    `<button class="chip ${k === cur ? 'on' : ''}" data-r="${k}">${k}</button>`).join('')}</div>`;
}
function bindRange(v, cur, redraw) {
  v.querySelectorAll('.chipbar [data-r]').forEach(c => c.onclick = () => redraw(c.dataset.r));
}
function tbl(head, rows, foot) {
  const cell = (c, i) => `<td class="${i ? 'n' : ''}">${c}</td>`;
  return `<div class="tw"><table class="tb">
    <thead><tr>${head.map((h, i) => `<th${i ? '' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('')
      : `<tr><td colspan="${head.length}" style="text-align:center;color:var(--ink-3);padding:18px 0">该区间暂无数据</td></tr>`}</tbody>
    ${foot ? `<tfoot><tr>${foot.map(cell).join('')}</tr></tfoot>` : ''}
  </table></div>`;
}
const n2 = n => Number(n ?? 0).toFixed(2);
const n0 = n => Math.round(Number(n ?? 0)).toLocaleString('zh-CN');

// ── V4.11.3 AI 识别质量（M4 长期闭环）：纠正率=准确率代理，低置信件闭环率=候选确认处理覆盖 ──
const AI_LAYER_NAME = {
  barcode: '📊 条码', clip: '⚡ 向量检索', 'clip-multi': '⚡ 多件检索', 'clip-cand': '🔎 候选确认',
  vl: '🧠 VL 兜底', dhash: '🔍 dHash', onnx: '📦 ONNX', sample: '🗃️ 样本匹配', mock: '🧪 模拟',
};
View.aiQuality = async function (v) {
  v.innerHTML = `<div class="hint">统计口径：近 30 天识别日志。识别后店员确认无改动视为准确；「未识别日志」不计入纠正率。</div>
    <div id="aiqBox" style="margin-top:8px"><div class="empty">加载中…</div></div>`;
  try {
    const d = await call('GET', '/ai/quality');
    const s = d.summary || {};
    if (!s.total) {
      $('#aiqBox').innerHTML = `<div class="empty">近 30 天暂无识别记录<br><span style="font-size:12px;color:var(--ink-3)">店员使用 AI 拍识别后此处自动出数</span></div>`;
      return;
    }
    const acc = Math.round((s.ok || 0) / s.total * 100);
    const closedRate = s.lowConf ? Math.round((s.lowConfClosed || 0) / s.lowConf * 100) : null;
    const trend = d.trend || [], maxT = Math.max(1, ...trend.map(t => Number(t.total) || 0));
    const distRows = (list, nameFn) => {
      const max = Math.max(1, ...list.map(x => Number(x.n) || 0));
      return list.map(x => `<div class="kv"><span class="k">${nameFn(x)}</span>
        <span class="v num" style="flex:1;text-align:right">${n0(x.n)} 次</span>
        <span style="display:inline-block;width:${Math.max(4, Math.round(Number(x.n) / max * 72))}px;height:8px;background:var(--pri,#20663f);border-radius:4px;margin-left:6px"></span></div>`).join('');
    };
    $('#aiqBox').innerHTML = `
      <div class="card">
        <div class="kv"><span class="k">识别总数（30 天）</span><span class="v num">${n0(s.total)} 次</span></div>
        <div class="kv"><span class="k">店员无改动（准确率代理）</span><span class="v num">${acc}%</span></div>
        <div class="kv"><span class="k">人工纠正</span><span class="v num">${n0(s.corrected)} 次</span></div>
        <div class="kv"><span class="k">低置信件 / 已闭环</span><span class="v num">${n0(s.lowConf)} / ${n0(s.lowConfClosed)}${closedRate === null ? '' : ' · 闭环率 ' + closedRate + '%'}</span></div>
        <div class="kv"><span class="k">平均识别时延</span><span class="v num">${n0(s.avgMs)} ms</span></div>
      </div>
      <div class="sec">识别量趋势（绿=当日全部无改动）</div>
      <div class="card" style="padding:12px 12px 10px">
        <div class="bars">
          ${trend.slice(-14).map(t => {
            const h = Math.max(2, Math.round(Number(t.total) / maxT * 100));
            const clean = Number(t.corrected) === 0;
            return `<div class="b"><div class="vl num">${n0(t.total)}</div><div class="bar${clean ? '' : ' hot'}" style="height:${h}%"></div><div class="lb">${esc(t.day)}</div></div>`;
          }).join('')}
        </div>
        <div class="hint" style="margin-top:8px">橙色日存在人工纠正（建议核对当日样本质量）</div>
      </div>
      <div class="sec">识别层级分布</div>
      <div class="card" style="padding:12px">${distRows(d.layerDist || [], x => AI_LAYER_NAME[x.layer] || esc(x.layer)) || '<div class="empty">无数据</div>'}</div>
      <div class="sec">使用场景分布</div>
      <div class="card" style="padding:12px">${distRows(d.sceneDist || [], x => esc(x.scene || '未知')) || '<div class="empty">无数据</div>'}</div>
      <div class="sec">纠正 TOP 品类（30 天）</div>
      <div class="card" style="padding:6px 12px">
        ${(d.corrTop || []).length ? tbl(['商品', '纠正次数'], d.corrTop.map(x => [esc(x.name || `商品${x.productId}`), n0(x.n)]))
          : '<div class="empty" style="padding:10px 0">暂无纠正记录 —— 准确率良好</div>'}
      </div>
      <div class="sec">最近识别记录</div>
      <div class="card" style="padding:6px 12px">
        ${tbl(['时间', '场景', '层级', '件数', '时延', '状态'],
          (d.recent || []).map(x => [dt(x.createdAt), esc(x.scene || '—'),
            AI_LAYER_NAME[x.layer] || esc(x.layer || '—'), n0(x.items), n0(x.latencyMs) + 'ms',
            x.corrected ? '<span class="pill yellow">已纠正</span>' : '<span class="pill green">正常</span>']))}
      </div>`;
  } catch (e) { $('#aiqBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
};

View.repDaily = async function (v, arg) {
  const cur = (arg && arg.range) || '近7日';
  const [from, to] = RANGES[cur]();
  v.innerHTML = `${rangeBar(cur)}
    <div class="hint">区间 ${from} ~ ${to}</div>
    <div id="rdBox" style="margin-top:8px"><div class="empty">加载中…</div></div>`;
  bindRange(v, cur, r => replace('营业日报', View.repDaily, { range: r }));
  try {
    const d = await call('GET', `/reports/daily?from=${from}&to=${to}`);
    const days = (d.days || []).slice().reverse();
    const sum = days.reduce((s, x) => ({
      o: s.o + Number(x.orderCount || 0), s: s.s + Number(x.salesTotal || 0),
      c: s.c + Number(x.costTotal || 0), p: s.p + Number(x.profitTotal || 0),
    }), { o: 0, s: 0, c: 0, p: 0 });
    $('#rdBox').innerHTML = tbl(['日期', '订单', '营业额', '成本', '毛利'],
      days.map(x => [String(x.bizDate).slice(0, 10), n0(x.orderCount), n2(x.salesTotal), n2(x.costTotal), n2(x.profitTotal)]),
      ['合计', n0(sum.o), n2(sum.s), n2(sum.c), n2(sum.p)]);
  } catch (e) { $('#rdBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
};

View.repAbc = async function (v, arg) {
  const cur = (arg && arg.range) || '近7日';
  const [from, to] = RANGES[cur]();
  v.innerHTML = `${rangeBar(cur)}<div class="hint">区间 ${from} ~ ${to} · A=累计 80% 以内，B=95% 以内，C=其余</div>
    <div id="raBox" style="margin-top:8px"><div class="empty">加载中…</div></div>`;
  bindRange(v, cur, r => replace('ABC 分类', View.repAbc, { range: r }));
  try {
    const d = await call('GET', `/reports/abc?from=${from}&to=${to}`);
    const items = d.items || [];
    $('#raBox').innerHTML = tbl(['商品', '销量', '销售额', '毛利', '累计%', '级'],
      items.map(x => [esc(x.name), n0(x.qty), n2(x.revenue), n2(x.profit), n2(x.cum_pct),
        x.className === 'A' ? '<span class="pill green">A</span>' : x.className === 'B' ? '<span class="pill yellow">B</span>' : '<span class="pill gray">C</span>']),
      ['合计 ' + items.length + ' 个', n0(items.reduce((s, x) => s + Number(x.qty || 0), 0)),
        n2(items.reduce((s, x) => s + Number(x.revenue || 0), 0)),
        n2(items.reduce((s, x) => s + Number(x.profit || 0), 0)), '', '']);
  } catch (e) { $('#raBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
};

View.repSku = async function (v, arg) {
  const st = arg || {};
  const cur = st.range || '近7日', kw = st.kw || '';
  const [from, to] = RANGES[cur]();
  v.innerHTML = `${rangeBar(cur)}
    <div class="dbar"><input id="skKw" placeholder="搜商品名 / 条码" value="${esc(kw)}"><button class="btn" id="skGo" style="width:auto;padding:10px 16px">搜索</button></div>
    <div id="skBox" style="margin-top:8px"><div class="empty">加载中…</div></div>`;
  bindRange(v, cur, r => replace('商品销售明细', View.repSku, { range: r, kw }));
  const load = async keyword => {
    View.repSku(v, { range: cur, kw: keyword });
    const inp = $('#skKw'); if (inp) inp.focus();
  };
  $('#skGo').onclick = () => load(($('#skKw').value || '').trim());
  $('#skKw').addEventListener('keydown', e => { if (e.key === 'Enter') load(e.target.value.trim()); });
  try {
    const d = await call('GET', `/reports/sale-detail?from=${from}&to=${to}&keyword=${encodeURIComponent(kw)}`);
    const items = d.items || [], t = d.total || {};
    $('#skBox').innerHTML = tbl(['商品', '销量', '销售额', '毛利', '毛利率'],
      items.slice(0, 100).map(x => [esc(x.name), n0(x.qty), n2(x.revenue), n2(x.profit),
        (Number(x.revenue) ? (Number(x.profit) / Number(x.revenue) * 100).toFixed(1) : '0.0') + '%']),
      [`合计 ${items.length} 个`, n0(t.qty), n2(t.revenue), n2(t.profit),
        (Number(t.revenue) ? (Number(t.profit) / Number(t.revenue) * 100).toFixed(1) : '0.0') + '%']);
  } catch (e) { $('#skBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
};

View.repMember = async function (v, arg) {
  const cur = (arg && arg.range) || '近7日';
  const [from, to] = RANGES[cur]();
  v.innerHTML = `${rangeBar(cur)}<div class="hint">区间 ${from} ~ ${to} · 按消费额降序</div>
    <div id="rmBox" style="margin-top:8px"><div class="empty">加载中…</div></div>`;
  bindRange(v, cur, r => replace('会员消费榜', View.repMember, { range: r }));
  try {
    const d = await call('GET', `/reports/member?from=${from}&to=${to}&limit=60`);
    const rows = d.items || d.rows || (Array.isArray(d) ? d : []);
    $('#rmBox').innerHTML = tbl(['会员', '单数', '消费额', '毛利', '余额', '分红'],
      rows.map(x => [esc(x.name || ('卡 ' + (x.card_no || ''))), n0(x.orderCount), n2(x.salesTotal),
        n2(x.profitTotal), n2(x.balance), n2(x.dividendBalance)]),
      ['合计 ' + rows.length + ' 人', n0(rows.reduce((s, x) => s + Number(x.orderCount || 0), 0)),
        n2(rows.reduce((s, x) => s + Number(x.salesTotal || 0), 0)),
        n2(rows.reduce((s, x) => s + Number(x.profitTotal || 0), 0)), '', '']);
  } catch (e) { $('#rmBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
};

View.repInv = async function (v, arg) {
  const cur = (arg && arg.range) || '近7日';
  const [from, to] = RANGES[cur]();
  v.innerHTML = `${rangeBar(cur)}<div class="hint">区间 ${from} ~ ${to} · 期初/入库/出库/销售</div>
    <div id="riBox" style="margin-top:8px"><div class="empty">加载中…</div></div>`;
  bindRange(v, cur, r => replace('进销存报表', View.repInv, { range: r }));
  try {
    const d = await call('GET', `/reports/inventory?from=${from}&to=${to}`);
    const items = d.items || [];
    $('#riBox').innerHTML = tbl(['商品', '期初', '入库', '出库', '销售额', '毛利'],
      items.slice(0, 100).map(x => [esc(x.name), n0(x.open_qty), n0(x.in_qty), n0(x.out_qty), n2(x.sale_amount), n2(x.sale_profit)]),
      ['合计 ' + items.length + ' 个', n0(items.reduce((s, x) => s + Number(x.open_qty || 0), 0)),
        n0(items.reduce((s, x) => s + Number(x.in_qty || 0), 0)),
        n0(items.reduce((s, x) => s + Number(x.out_qty || 0), 0)),
        n2(items.reduce((s, x) => s + Number(x.sale_amount || 0), 0)),
        n2(items.reduce((s, x) => s + Number(x.sale_profit || 0), 0))]);
  } catch (e) { $('#riBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
};

View.repEmp = async function (v, arg) {
  const cur = (arg && arg.range) || '近7日';
  const [from, to] = RANGES[cur]();
  v.innerHTML = `${rangeBar(cur)}<div class="hint">区间 ${from} ~ ${to}</div>
    <div id="reBox" style="margin-top:8px"><div class="empty">加载中…</div></div>`;
  bindRange(v, cur, r => replace('员工业绩', View.repEmp, { range: r }));
  try {
    const d = await call('GET', `/reports/employee?from=${from}&to=${to}`);
    const rows = d.items || d.rows || (Array.isArray(d) ? d : []);
    $('#reBox').innerHTML = tbl(['员工', '单数', '销售额', '毛利', '客单价'],
      rows.map(x => [esc(x.name || x.employee_name || ('#' + (x.employee_id || ''))), n0((x.orderCount || x.order_count)),
        n2(x.salesTotal ?? x.sales_total), n2(x.profitTotal ?? x.profit_total), n2((x.avgTicket ?? x.avg_ticket))]),
      ['合计 ' + rows.length + ' 人', n0(rows.reduce((s, x) => s + Number((x.orderCount || x.order_count) || 0), 0)),
        n2(rows.reduce((s, x) => s + Number((x.salesTotal ?? x.sales_total) || 0), 0)),
        n2(rows.reduce((s, x) => s + Number((x.profitTotal ?? x.profit_total) || 0), 0)), '']);
  } catch (e) { $('#reBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
};

// ── V4.13 ④ 经营问答（预置问题一键问 + 自由输入）──
// V4.13.8 拟人语音：答案自动朗读（voice.assistant.enabled 可关），🔊 重听；音色/语速后台「语音播报」小节统一配置
View.brainQa = async function (v) {
  v.innerHTML = `<div id="qaBox"><div class="empty">加载中…</div></div>`;
  let presets = [];
  try { presets = (await call('GET', '/brain/qa/presets')).items || []; } catch { /* 静默 */ }
  let speakOn = null;   // null=未读设置；true/false=智能客服朗读开关
  const ensureSpeakCfg = async () => {
    if (speakOn !== null) return speakOn;
    try {
      const d = await call('GET', '/settings/key/voice.assistant.enabled');
      speakOn = d && (d.value === true || d.value === 'true' || d.value === 1);
    } catch { speakOn = false; }
    return speakOn;
  };
  /* V5.0.13：朗读双通道——PwaTTS 失败/缺失时回落浏览器 speechSynthesis，并给状态反馈
   * （此前「听一遍」点了没反应：PwaTTS 异常被吞，无任何提示） */
  const speakAnswer = txt => {
    if (!txt) return;
    try {
      if (window.PwaTTS && typeof PwaTTS.say === 'function') { PwaTTS.say(txt, { rate: 1.02 }); toast('🔊 正在朗读…'); return; }
      throw new Error('no PwaTTS');
    } catch {
      try {
        const u = new SpeechSynthesisUtterance(txt);
        u.lang = 'zh-CN'; u.rate = 1.02;
        speechSynthesis.cancel(); speechSynthesis.speak(u);
        toast('🔊 正在朗读…');
      } catch { toast('本机没有可用的中文语音'); }
    }
  };
  const render = (answer, engine) => {
    $('#qaBox').innerHTML = `
      <div class="chipbar">${presets.map((p, i) =>
        `<button class="chip" data-q="${i}">${p.icon} ${esc(p.q.replace(/[？?]/g, ''))}</button>`).join('')}</div>
      <div class="dbar"><input id="qaKw" placeholder="也可直接输入问题，如：本月哪类商品卖得好"><button class="btn" id="qaGo" style="width:auto;padding:10px 16px">提问</button></div>
      ${answer ? `<div class="card" style="margin-top:10px;white-space:pre-wrap;font-size:14.5px;line-height:1.8">${esc(answer)}
        <span style="float:right"><button class="btn" id="qaSpeak" title="朗读回答" style="width:auto;padding:4px 10px;font-size:12px">🔊 听一遍</button></span>
        ${engine ? `<div style="margin-top:8px;font-size:11.5px;color:var(--ink-3)">引擎：${esc(engine)}</div>` : ''}</div>` : ''}
      <div class="hint">问题由本地规则引擎 + 店内数据即时作答（数据不出店）；可选开启本地大模型润色。</div>`;
    $('#qaBox').querySelectorAll('[data-q]').forEach(b => b.onclick = () => ask(presets[Number(b.dataset.q)].q));
    $('#qaGo').onclick = () => ask(($('#qaKw').value || '').trim());
    $('#qaKw').addEventListener('keydown', e => { if (e.key === 'Enter') ask(e.target.value.trim()); });
    const sp = $('#qaSpeak');
    if (sp) sp.onclick = () => speakAnswer(answer);
  };
  const ask = async q => {
    if (!q) { toast('请输入问题'); return; }
    $('#qaBox').innerHTML = `<div class="empty">⏳ 正在回答：${esc(q)}…<br><span style="font-size:12px;color:var(--ink-3)">本地大模型推理约需 10~60 秒（CPU），请稍候；数据全程不出店</span></div>`;
    try {
      const d = await call('POST', '/brain/qa', { question: q });
      render(d.answer, d.engine === 'ollama' ? '本地大模型' : '规则引擎' + (d.route ? ' · ' + d.route : ''));
      if (d.answer && await ensureSpeakCfg()) speakAnswer(d.answer);  // V4.13.8 自动朗读
    } catch (e) { render('查询失败：' + e.message); }
  };
  render();
};

// ── V4.13 ② 账单对账（微信/支付宝 CSV 导入 → 自动对齐 → 差异清单）──
View.billRecon = async function (v) {
  v.innerHTML = `
    <div class="sec">导入账单</div>
    <div class="card">
      <div class="seg" id="rcCh"><button data-ch="微信" class="on">微信</button><button data-ch="支付宝">支付宝</button></div>
      <div class="field" style="margin-top:10px"><label>选择账单 CSV（微信「微信支付账单明细」/ 支付宝「交易明细证明」导出原件；也可直接粘贴文本）</label>
        <input id="rcFile" type="file" accept=".csv,.txt" style="font-size:12px">
        <textarea id="rcCsv" rows="4" placeholder="或把账单文本粘贴到这里…" style="width:100%;margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:12px;user-select:text"></textarea>
      </div>
      <button class="btn" id="rcGo">💰 导入并自动对账</button>
      <div class="hint" id="rcMsg" style="margin-top:8px">对齐规则：平台单号精确命中 → 金额相等 + 时间 ±5 分钟；差异行进入下方清单，可逐行忽略。</div>
    </div>
    <div class="sec">对账批次（最近 50 次）</div>
    <div id="rcRuns"><div class="empty">加载中…</div></div>`;
  let channel = '微信';
  $('#rcCh').querySelectorAll('button').forEach(b => b.onclick = () => {
    channel = b.dataset.ch;
    $('#rcCh').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#rcFile').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { $('#rcCsv').value = await f.text(); toast('已读取文件，可点导入'); } catch (err) { toast('文件读取失败：' + err.message); }
  };
  $('#rcGo').onclick = async () => {
    const csv = ($('#rcCsv').value || '').trim();
    if (!csv) { toast('请先选择文件或粘贴账单文本'); return; }
    $('#rcGo').disabled = true; $('#rcMsg').textContent = '对账中…';
    try {
      const d = await call('POST', '/finance/recon/bill/import', { channel, csv });
      $('#rcMsg').innerHTML = `<span style="color:var(--ok)">✅ 导入 ${d.importedRows} 行（跳过 ${d.skipped}）· 已对上 ${d.matched} 行 ¥${money(d.matchedTotal)} · 本地合计 ¥${money(d.localTotal)} · <b>差异 ${Number(d.diff_rows ?? 0)} 行</b></span>`;
      loadRuns();
    } catch (e) { $('#rcMsg').innerHTML = `<span style="color:var(--bad)">❌ ${esc(e.message)}</span>`; }
    $('#rcGo').disabled = false;
  };
  const loadRuns = async () => {
    try {
      const d = await call('GET', '/finance/recon/runs');
      const rows = d.items || [];
      $('#rcRuns').innerHTML = rows.length ? tbl(['批次', '渠道', '账单日', '行数', '账单额', '已对上', '本地额', '差异', '时间'],
        rows.map(r => [esc(r.batch_no), esc(r.channel), String(r.bill_date || '—').slice(0, 10), n0(r.bill_rows),
          n2(r.bill_total), n2(r.matched_total), n2(r.local_total),
          Number(r.diff_rows) > 0 ? `<span class="pill red">${n0(r.diff_rows)}</span>` : '<span class="pill green">0</span>', dt(r.created_at)]))
        : '<div class="empty">暂无对账记录：开业收到真实账单后导入即可</div>';
      $('#rcRuns').querySelectorAll('tbody tr').forEach((tr, i) => tr.onclick = () => push('对账详情', View.reconRun, { id: rows[i].id }));
    } catch (e) { $('#rcRuns').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  };
  loadRuns();
};

View.reconRun = async function (v, arg) {
  v.innerHTML = `<div id="rrBox"><div class="empty">加载中…</div></div>`;
  let d;
  try { d = await call('GET', '/finance/recon/runs/' + arg.id); }
  catch (e) { $('#rrBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const r = d.run, bills = d.bills || [], rev = d.reverseDiffs || [];
  $('#rrBox').innerHTML = `
    <div class="card">
      <div class="kv"><span class="k">批次</span><span class="v">${esc(r.batch_no)}（${esc(r.channel)}）</span></div>
      <div class="kv"><span class="k">账单 / 已对上 / 本地</span><span class="v num">¥${money(r.bill_total)} / ¥${money(r.matched_total)} / ¥${money(r.local_total)}</span></div>
      <div class="kv"><span class="k">行数（对上 / 差异 / 本地有平台无）</span><span class="v num">${n0(r.matched_rows)} / ${Number(r.diff_rows) > 0 ? `<b style="color:var(--red)">${n0(r.diff_rows)}</b>` : '0'} / ${rev.length > 0 ? `<b style="color:var(--red)">${n0(rev.length)}</b>` : '0'}</span></div>
      <div class="kv"><span class="k">时间</span><span class="v">${dt(r.created_at)}</span></div>
    </div>
    <div class="sec">账单明细（点差异行可忽略）</div>
    ${tbl(['状态', '平台单号', '金额', '支付时间', '说明'],
      bills.map(b => [b.match_status === '已匹配' ? '<span class="pill green">已匹配</span>'
        : b.match_status === '金额差异' ? '<span class="pill red">金额差异</span>'
        : b.match_status === '疑似重复' ? '<span class="pill yellow">疑似重复</span>'
        : b.match_status === '已忽略' ? '<span class="pill gray">已忽略</span>'
        : '<span class="pill gray">未匹配</span>',
        esc(String(b.external_no)), n2(b.amount), dt(b.pay_time), esc(b.match_note || '')]))}
    ${rev.length ? `
    <div class="sec" style="color:var(--red)">⚠️ 反方向差异：本地已收、平台账单无对应行（${rev.length} 笔 · ¥${money(rev.reduce((s, x) => s + Number(x.amount), 0))}）</div>
    ${tbl(['单号', '金额', '收款时间', '流水号'],
      rev.map(x => [esc(x.orderNo), `<b style="color:var(--red)">${n2(x.amount)}</b>`, dt(x.createdAt), esc(x.externalNo || '—')]))}
    <div class="hint">反方向差异疑似：顾客扫码未实际到账（截图造假）/ 现金伪装扫码 / 私码收款未进对公账户 / 平台账单漏行——逐笔人工核实后处理。</div>` : ''}
    <div class="hint">「金额差异」= 账单有收入但本地找不到等额等时收款：先核对是否漏单/私收，再考虑时间窗口设置；「疑似重复」= 平台重复行（退款拆行）。</div>`;
  $('#rrBox').querySelectorAll('tbody tr').forEach((tr, i) => {
    const b = bills[i];
    if (b.match_status !== '金额差异' && b.match_status !== '疑似重复') return;
    tr.style.cursor = 'pointer';
    tr.onclick = async () => {
      if (!confirm(`忽略该账单行？\n${b.external_no} ¥${money(b.amount)}`)) return;
      try { await call('POST', `/finance/recon/bills/${b.id}/ignore`, {}); toast('已忽略'); renderStack(); }
      catch (e) { toast(e.message); }
    };
  });
};

// ── V4.13 ③ AI 建议（决策中心建议流：选品/补货/定价/营销，执行或否决留痕）──
View.brainSugg = async function (v) {
  v.innerHTML = `<div id="bsBox"><div class="empty">加载中…</div></div>`;
  let d;
  try { d = await call('GET', '/brain/suggestions?size=30'); }
  catch (e) { $('#bsBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const items = d.items || [];
  const DOM_ICON = { '补货': '📦', '定价': '🏷️', '营销推送': '🎯', '防损': '🛡️', '选品': '🧮', '促销': '🎁', '其他': '📌' };
  $('#bsBox').innerHTML = items.length ? items.map(s => {
    const p = s.payload || {};
    const brief = s.domain === '补货' ? `${(p.items || []).length} 个商品待补`
      : s.domain === '选品' ? `淘汰 ${(p.eliminated || []).length} 个 · 扩容 ${(p.expand || []).length} 类`
      : s.domain === '定价' ? `${(p.items || []).length} 个商品慢动销`
      : s.domain === '营销推送' ? `${(p.members || []).length} 位沉默会员`
      : `${(p.items || []).length} 项`;
    return `<div class="row" data-s="${s.id}">
      <div style="font-size:20px">${DOM_ICON[s.domain] || '📌'}</div>
      <div class="grow">
        <div class="t">#${s.id} ${esc(s.domain)} <span class="pill ${s.status === '待处理' ? 'orange' : s.status === '已执行' ? 'green' : 'gray'}">${esc(s.status)}</span></div>
        <div class="s">${esc(brief)} · 置信度 ${s.confidence ? Math.round(Number(s.confidence) * 100) + '%' : '—'} · ${dt(s.created_at)}${s.reject_reason ? ' · 否决：' + esc(s.reject_reason) : ''}</div>
      </div>
      <span class="pill gray">详情 ›</span>
    </div>`;
  }).join('') : '<div class="empty">暂无建议：可到收银后台决策中心「全量刷新」生成</div>';
  $('#bsBox').querySelectorAll('[data-s]').forEach(el => el.onclick = () => {
    const s = items.find(x => Number(x.id) === Number(el.dataset.s));
    push(`建议 #${s.id}`, View.brainSuggDetail, { id: s.id, domain: s.domain, status: s.status, payload: s.payload, reason: s.reason, confidence: s.confidence });
  });
};

View.brainSuggDetail = async function (v, arg) {
  const p = arg.payload || {};
  const isPricing = arg.domain === '定价';
  const rows = [];
  const inputs = [];   // V5.0.13 定价域：可手动调整的执行价（下标 → productId）
  if (isPricing) {
    /* 定价域专用表：现价 / 建议价（可改）/ 价差 / 进价 / 利润率 —— 执行时按确认价真改售价
     * V5.0.14f：按用户要求加「进价」「利润率（按执行价计）」列；利润率随执行价手动调整实时重算 */
    (p.items || []).forEach((i, k) => {
      const sp = Number(i.sellPrice || 0), sug = Number(i.suggestPrice || 0), cost = Number(i.cost || 0);
      const marginHtml = `<span class="num" id="pxmargin-${k}">${marginTxt(sug, cost)}</span>`;
      rows.push([`<span style="word-break:break-all">${esc(i.name || ('商品' + i.productId))}</span>`,
        `<span class="num">¥${money(sp)}</span>`,
        `<input class="num" data-px="${k}" type="number" step="0.01" min="0.01" value="${sug.toFixed(2)}"
           style="width:100%;max-width:96px;box-sizing:border-box;padding:7px 4px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;text-align:right;user-select:text">`,
        `<span class="num" id="pxdiff-${k}" style="color:${sug < sp ? 'var(--orange)' : 'var(--ink-3)'}">${sp ? (sug - sp >= 0 ? '+' : '') + (sug - sp).toFixed(2) : '—'}</span>`,
        `<span class="num">${cost > 0 ? '¥' + money(cost) : '—'}</span>`,
        marginHtml,
        `<span style="font-size:11.5px">${esc(i.turnoverDays != null ? `周转${i.turnoverDays}天` : (i.reason || i.suggest || ''))}</span>`]);
      inputs.push({ k, productId: Number(i.productId), sellPrice: sp, name: i.name || ('商品' + i.productId) });
    });
    if (inputs.length) {
      v.innerHTML = `<div id="suggRoot">
        <div class="card">
          <div class="kv"><span class="k">域 / 状态</span><span class="v">${esc(arg.domain)} · ${esc(arg.status)}</span></div>
          <div class="kv"><span class="k">置信度</span><span class="v num">${arg.confidence ? Math.round(Number(arg.confidence) * 100) + '%' : '—'}</span></div>
          ${arg.reason && arg.reason.rule ? `<div class="kv"><span class="k">依据</span><span class="v" style="font-size:12.5px;font-weight:400">${esc(arg.reason.rule)}${arg.reason.note ? ' · ' + esc(arg.reason.note) : ''}</span></div>` : ''}
        </div>
        <div class="sec">建议明细（确认价可手动调整，蓝色为降价；利润率=（执行价−进价）÷执行价）</div>
        <div class="tw"><table class="tb" style="table-layout:fixed;font-size:12px;white-space:normal">
          <colgroup><col style="width:20%"><col style="width:11%"><col style="width:21%"><col style="width:11%"><col style="width:12%"><col style="width:12%"><col style="width:13%"></colgroup>
          <thead><tr><th>名称</th><th>现价</th><th>执行价</th><th>价差</th><th>进价</th><th>利润率</th><th>依据</th></tr></thead>
          <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'n' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <div class="hint">执行后按上方「执行价」<b>真实修改商品售价</b>（可随时在建议列表一键回滚还原原价）；改小数请保留两位。</div>
        <div class="acts">
          <button class="btn bad" id="sgRej">✖ 否决</button>
          <button class="btn" id="sgExec">✔ 按执行价改价</button>
        </div></div>`;
      bindActions(v, arg, () => {
        const items = inputs.map(x => {
          const el = v.querySelector(`[data-px="${x.k}"]`);
          const actual = Math.max(0.01, Number(el && el.value) || x.sellPrice);
          return { productId: x.productId, name: x.name, sellPrice: x.sellPrice, suggestPrice: Number((p.items[x.k] || {}).suggestPrice) || actual, actualPrice: actual };
        });
        return { payload: { ...(p || {}), items } };
      });
      // 价差 + 利润率实时联动（利润率=（执行价−进价）÷执行价，随手动调整实时重算）
      inputs.forEach(x => {
        const el = v.querySelector(`[data-px="${x.k}"]`);
        if (!el) return;
        const cost = Number((p.items[x.k] || {}).cost || 0);
        el.addEventListener('input', () => {
          const nv = Number(el.value) || 0;
          const d = v.querySelector(`#pxdiff-${x.k}`);
          const diff = nv - x.sellPrice;
          if (d) { d.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2); d.style.color = diff < 0 ? 'var(--orange)' : 'var(--ink-3)'; }
          const m = v.querySelector(`#pxmargin-${x.k}`);
          if (m) { m.textContent = marginTxt(nv, cost); m.style.color = nv > 0 && cost > 0 && nv < cost ? 'var(--red)' : ''; }
        });
      });
      return;
    }
  }
  const rows2 = [];
  (p.items || []).forEach(i => rows2.push([esc(i.name || ('商品' + i.productId)), n0(i.stock ?? i.qty ?? 0), n0(i.suggestQty ?? i.qtyWindow ?? 0), esc(i.suggest || i.reason || '')]));
  (p.members || []).forEach(mm => rows2.push([esc(mm.name || ('会员' + mm.id)), '余额 ¥' + money(mm.balance), '沉默 ' + (mm.silentDays || 30) + ' 天', '']));
  (p.expand || []).forEach(x => rows2.push([esc(x.category) + '（扩容）', '收入占比 ' + x.revShare + '%', 'SKU 占比 ' + x.skuShare + '%', '建议扩充该品类 SKU']));
  v.innerHTML = `<div id="suggRoot">
    <div class="card">
      <div class="kv"><span class="k">域 / 状态</span><span class="v">${esc(arg.domain)} · ${esc(arg.status)}</span></div>
      <div class="kv"><span class="k">置信度</span><span class="v num">${arg.confidence ? Math.round(Number(arg.confidence) * 100) + '%' : '—'}</span></div>
      ${arg.reason && arg.reason.rule ? `<div class="kv"><span class="k">依据</span><span class="v" style="font-size:12.5px">${esc(arg.reason.rule)}${arg.reason.note ? ' · ' + esc(arg.reason.note) : ''}</span></div>` : ''}
    </div>
    <div class="sec">建议明细</div>
    ${rows2.length ? tbl(['名称', '库存/余额', '建议量/占比', '说明'], rows2) : '<div class="empty">无明细</div>'}
    ${arg.status === '待处理' ? `<div class="acts">
      <button class="btn bad" id="sgRej">✖ 否决</button>
      <button class="btn" id="sgExec">✔ 执行</button>
    </div>
    <div class="hint">${execHint(arg.domain, p)}</div>`
      : '<div class="hint">该建议已处理。</div>'}</div>`;
  if (arg.status === '待处理') bindActions(v, arg, null);
};

/* V5.0.13：分域执行/否决说明（此前所有域都显示同一句，无法判断"执行"到底会做什么） */
function execHint(domain, p) {
  const n = (p && ((p.items || []).length || (p.members || []).length || (p.expand || []).length)) || 0;
  const map = {
    '补货': `执行 = 按建议量生成 ${n ? n + ' 项' : ''}采购订单（进入待审批，可一键回滚）`,
    '定价': '执行 = 按建议折扣真实修改商品售价（可在明细中调整执行价，支持一键回滚还原）',
    '营销推送': `执行 = 生成营销触达任务（${n || 0} 位目标会员，由后台推送）`,
    '选品': '执行 = 标记选品结论留痕（淘汰/扩容建议交后台复核）',
    '促销': '执行 = 生成促销方案草稿（待后台配置生效）',
    '防损': '执行 = 标记防损结论留痕（训练信号）',
    '备货': `执行 = 按建议量生成备货单（${n ? n + ' 项' : ''}）`,
  };
  return (map[domain] || '执行 = 标记留痕（训练信号）') + '；否决请填原因（训练信号）。';
}

/** 执行/否决绑定（payload 定制：定价域把手动调整的执行价带回） */
function bindActions(v, arg, payloadFn) {
  $('#sgExec').onclick = async () => {
    if (!confirm('确认执行该建议？')) return;
    try {
      const body = payloadFn ? payloadFn() : {};
      const r = await call('POST', `/brain/suggestions/${arg.id}/execute`, body);
      toast('✅ ' + (r.note || '已执行')); stack.length = 0; openTab('reports');
    } catch (e) { toast(e.message); }
  };
  $('#sgRej').onclick = async () => {
    const reason = prompt('否决原因（必填，留痕作训练信号）：') || '';
    if (!reason.trim()) { toast('否决必须填写原因'); return; }
    try { await call('POST', `/brain/suggestions/${arg.id}/reject`, { reason: reason.trim() }); toast('已否决'); stack.length = 0; openTab('reports'); }
    catch (e) { toast(e.message); }
  };
}

// ── V4.13 ① 漏扫告警（自助收银差异复核闭环）──
View.antiLeak = async function (v) {
  v.innerHTML = `<div id="alBox"><div class="empty">加载中…</div></div>`;
  let d;
  try { d = await call('GET', '/antileak/alerts'); }
  catch (e) { $('#alBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const items = d.items || [];
  $('#alBox').innerHTML = `
    <div class="hint">口径：会员扫码购/自助结算时，AI 识别件数 vs 结算件数、称重理论重 vs 实秤重，差异即暂停。待复核 = 顾客强推通过的单，请人工核对；已拦截 = 已被系统拦下未成单。</div>
    ${items.length ? items.map(a => {
      const diffs = (a.detail && a.detail.diffs) || [];
      return `<div class="row">
        <div style="font-size:20px">${a.status === '待复核' ? '🔔' : a.status === '已拦截' ? '⛔' : '✔️'}</div>
        <div class="grow">
          <div class="t">#${a.id} ${esc(a.kind)} <span class="pill ${a.status === '待复核' ? 'red' : a.status === '已拦截' ? 'yellow' : 'green'}">${esc(a.status)}</span></div>
          <div class="s">${esc(a.member_name || '会员' + (a.member_id || '?'))}${a.member_phone ? ' · ' + esc(a.member_phone) : ''} · ${dt(a.created_at)}<br>
            ${diffs.map(x => esc(`${x.name}：${x.note || (x.expected + ' → ' + x.actual)}`)).join('<br>')}</div>
        </div>
        ${a.status === '待复核' ? `<button class="mini-btn" data-ok="${a.id}">放行</button><button class="mini-btn danger" data-no="${a.id}">拦截</button>` : ''}
      </div>`;
    }).join('') : '<div class="empty">暂无漏扫告警 ✅</div>'}`;
  $('#alBox').querySelectorAll('[data-ok]').forEach(b => b.onclick = () => handle(b.dataset.ok, '已放行'));
  $('#alBox').querySelectorAll('[data-no]').forEach(b => b.onclick = () => handle(b.dataset.no, '已拦截'));
  async function handle(id, status) {
    const note = status === '已拦截' ? (prompt('拦截说明（可选）：') || '') : '';
    try { await call('POST', `/antileak/alerts/${id}/handle`, { status, note }); toast('已' + status); renderStack(); }
    catch (e) { toast(e.message); }
  }
};

// ── V4.13 智能能力开关（短期用不上的先关着，功能常备、数据量起来再开）──
View.capSwitches = async function (v) {
  v.innerHTML = `<div id="csBox"><div class="empty">加载中…</div></div>`;
  // V4.13.4 分组归并后「智能能力」并入 AI赋能：改按能力键名前缀过滤，不再依赖分组名
  const CAP_PREFIX = ['antileak.', 'finance.billrecon.', 'ai.assortment.', 'voice.price.', 'ai.forecast.'];
  let rows;
  try { rows = (await call('GET', '/settings')).filter(s => CAP_PREFIX.some(p => s.setting_key.startsWith(p))); }
  catch (e) { $('#csBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const BOOL_KEYS = ['antileak.selfcheckout.enabled', 'antileak.count.strict', 'finance.billrecon.enabled',
                     'ai.assortment.enabled', 'voice.price.enabled'];
  $('#csBox').innerHTML = `
    <div class="hint">六项智能能力的总开关：漏扫校验/账单对账/选品建议已默认开启（开业即用）；语音查价与 LightGBM 预测默认关闭——语音等店员试用反馈，LGBM 等全店流水 ≥ 数据门槛后再打开，功能常备不欠账。</div>
    ${rows.map(s => {
      const isBool = BOOL_KEYS.includes(s.setting_key) || s.value_type === 'bool';
      const on = s.value === true || s.value === 'true';
      return `<div class="row">
        <div class="grow">
          <div class="t">${esc(s.display_name)}</div>
          <div class="s" style="font-size:11.5px">${esc(s.setting_key)} · ${esc(s.remark || '')}</div>
        </div>
        ${isBool
          ? `<button class="mini-btn ${on ? '' : 'ghost'}" data-k="${esc(s.setting_key)}" data-v="${on ? 'off' : 'on'}">${on ? '✅ 已开启' : '⭕ 已关闭'}</button>`
          : `<input data-num="${esc(s.setting_key)}" value="${esc(String(s.value ?? ''))}" style="width:110px;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:13px;user-select:text" /><button class="mini-btn" data-save="${esc(s.setting_key)}">保存</button>`}
      </div>`;
    }).join('')}
    ${rows.some(s => s.setting_key === 'voice.price.enabled') ? `
    <div class="sec">语音查价 · 播报音色</div>
    <div class="card" id="vpBox"><div class="empty">加载中…</div></div>` : ''}`;
  $('#csBox').querySelectorAll('[data-k]').forEach(b => b.onclick = async () => {
    const key = b.dataset.k, to = b.dataset.v === 'on';
    try {
      await call('PUT', '/settings/' + key, { value: to, reason: '老板端智能能力开关' });
      toast(to ? '已开启' : '已关闭'); renderStack();
    } catch (e) { toast(e.message); }
  });
  $('#csBox').querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const key = b.dataset.save, inp = $(`#csBox [data-num="${key}"]`);
    const raw = String(inp.value).trim();
    const val = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    try { await call('PUT', '/settings/' + key, { value: val, reason: '老板端智能能力开关' }); toast('已保存'); }
    catch (e) { toast(e.message); }
  });

  /* V5.0.14：语音查价 · 播报音色选择。
   *  统一走 voice.tts.voice（收款播报/语音查价/经营告警共用同一 TTS 引擎，不另设分场景键）。
   *  选项：跟随默认（引擎自动择优拟真人声）/ 引擎语音（服务端 piper 神经语音）/ 本机枚举到的中文音色。 */
  if ($('#vpBox')) (async () => {
    const TTS = window.PwaTTS;
    const box = $('#vpBox');
    if (!TTS) { box.innerHTML = '<div class="empty">语音组件未加载（tts.js）</div>'; return; }
    let cur = '';
    try { const d = await call('GET', '/settings/key/voice.tts.voice'); cur = String(d?.value ?? ''); } catch { /* 默认跟随 */ }
    await TTS.loadCfg(true);                       // 触发本机音色枚举 + 服务端引擎探测
    const info = TTS.voiceInfo();
    const svr = await TTS.ensureServerProbe();
    const opts = [
      { v: '', t: '跟随默认（自动择优拟真人声）' },
      { v: TTS.ENGINE_VOICE, t: `引擎语音（服务端神经语音${svr.available ? ' · 已就绪' : ' · 未就绪，将回落本机音色'}）` },
      ...info.all.map(v => ({ v: v.name, t: `${v.natural ? '✨' : ''}${v.name}${v.local ? '' : '（在线）'}` })),
    ];
    box.innerHTML = `
      <div class="row">
        <div class="grow">
          <div class="t">播报音色</div>
          <div class="s" style="font-size:11.5px">当前生效：${esc(info.current || '（无本机中文音色）')}${svr.available ? ' · 服务端引擎可用' : ''}；作用于收款播报 / 语音查价 / 经营告警（统一引擎）</div>
        </div>
      </div>
      <div class="row">
        <select id="vpSel" style="flex:1;min-width:0;padding:9px;border:1px solid var(--line);border-radius:8px;font-size:13px">
          ${opts.map(o => `<option value="${esc(o.v)}" ${o.v === cur ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}
        </select>
        <button class="mini-btn" id="vpSave">保存</button>
        <button class="mini-btn ghost" id="vpTest">🔊 试听</button>
      </div>`;
    $('#vpSave').onclick = async () => {
      try {
        await call('PUT', '/settings/voice.tts.voice', { value: $('#vpSel').value, reason: '老板端智能能力开关-播报音色' });
        toast('音色已保存'); await TTS.loadCfg(true);
      } catch (e) { toast(e.message); }
    };
    $('#vpTest').onclick = async () => {
      // 试听当前下拉所选（先存再听，避免「听到的是旧配置」的困惑）
      try { await call('PUT', '/settings/voice.tts.voice', { value: $('#vpSel').value, reason: '试听前保存' }); } catch { /* 离线也能试听本机音色 */ }
      await TTS.loadCfg(true);
      /* V5.0.14c：试听失败要给用户反馈——服务端合成失败会自动回落本机音色，
       * 本机音色不可用时 onFail 上报（Android WebView 本机中文音色常为空，
       * 提示改选「引擎语音」由服务端合成播报）。 */
      TTS.say('语音查价试听：益达口香糖，售价九元五角', {
        onFail: (err) => toast(`试听无声（${err || '本机音色不可用'}）：请改选「引擎语音」，由服务端合成播报`),
      });
      toast('试听中…若无声音请看提示');
    };
  })();
};

// ── 设置 ──
View.settings = async function (v) {
  v.innerHTML = `
    <div class="row" style="padding:18px">
      <div style="width:54px;height:54px;border-radius:50%;background:var(--pri);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700">${esc((ME.name || '老')[0])}</div>
      <div class="grow">
        <div style="font-size:17px;font-weight:700">${esc(ME.name)}</div>
        <div style="font-size:12.5px;color:var(--ink-3);margin-top:2px">工号 ${esc(ME.empNo)}</div>
      </div>
      <button class="btn ghost" style="width:auto;padding:8px 16px;font-size:13px" id="sLogout">退出</button>
    </div>
    <div class="card">
      <div class="kv"><span class="k">角色</span><span class="v">${(ME.roles || []).map(esc).join(' · ') || '—'}</span></div>
      <div class="kv"><span class="k">门店</span><span class="v">${esc(ME.storeName || '—')}</span></div>
      <div class="kv"><span class="k">数据刷新</span><span class="v">下拉刷新 · 每页自动加载</span></div>
    </div>
    <div class="sec">说明</div>
    <div class="card hint" style="margin-top:0">
      老板移动端（8.3）：手机浏览器即开，随时随地看店。<br>
      局域网直连店内服务器；在外经云端接入层隧道访问。<br>
      敏感操作（审批 / 发布 / 回滚）在收银后台完成并留痕。
    </div>
    <div class="sec">高危操作</div>
    <div class="card">
      <div class="kv" id="sPay" style="cursor:pointer"><span class="k">💳 支付通道设置</span><span class="v">微信/支付宝 API 配置（密钥加密）›</span></div>
      <div class="kv"><span class="k">说明</span><span class="v" style="font-size:12px;color:var(--ink-3)">填齐 API 配置并启用渠道、模式切「real」即真通道收款；密钥加密落库只显尾号</span></div>
      <div class="kv" id="sDev" style="cursor:pointer"><span class="k">🖥️ 收银机授权</span><span class="v" id="sDevStat">加载中…</span></div>
      <div class="kv"><span class="k">说明</span><span class="v" style="font-size:12px;color:var(--ink-3)">开启后仅白名单设备可登录员工账号（超管豁免）；新设备首登自动登记待审批</span></div>
      <div class="kv" id="sCap" style="cursor:pointer"><span class="k">🧠 智能能力开关</span><span class="v">漏扫/对账/选品/语音/预测 ›</span></div>
      <div class="kv"><span class="k">说明</span><span class="v" style="font-size:12px;color:var(--ink-3)">短期用不上的先关着：数据量起来后再打开（语音/LGBM 默认关）</span></div>
      <div class="kv" id="sReset" style="cursor:pointer"><span class="k">🏗️ 系统初始化</span><span class="v" style="color:#b5544a">开业前清库 ›</span></div>
      <div class="kv"><span class="k">说明</span><span class="v" style="font-size:12px;color:var(--ink-3)">调试后一键清空数据，回到初始化状态（留痕审计）</span></div>
    </div>`;
  $('#sLogout').onclick = () => { if (confirm('确认退出登录？')) logout(); };
  $('#sPay').onclick = () => push('💳 支付通道设置', View.paySettings);
  $('#sCap').onclick = () => push('🧠 智能能力开关', View.capSwitches);
  $('#sReset').onclick = () => push('🏗️ 系统初始化', View.sysReset);
  $('#sDev').onclick = () => push('🖥️ 收银机授权', View.deviceAuth);
  // 角标：待授权设备数
  try {
    const dev = await call('GET', '/pos-devices');
    const pend = (dev || []).filter(x => x.status === '待授权').length;
    $('#sDevStat').textContent = pend > 0 ? `${pend} 台待审批 ›` : '白名单管理 ›';
    if (pend > 0) $('#sDevStat').style.color = '#b5544a';
  } catch { $('#sDevStat').textContent = '白名单管理 ›'; }
};

// ── V4.21.1 收银机授权：设备白名单（待授权/已授权/已停用）+ 开关 ──
View.deviceAuth = async function (v) {
  v.innerHTML = `<div id="daBox"><div class="empty">加载中…</div></div>`;
  const render = async () => {
    let items, sw;
    try {
      [items, sw] = await Promise.all([call('GET', '/pos-devices'), call('GET', '/settings/key/pos.device.auth')]);
    } catch (e) { $('#daBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
    const on = sw && (sw.value === true || sw.value === 'true');
    const CN = { '待授权': ['⏳', '#b5544a'], '已授权': ['✅', '#2e7d54'], '已停用': ['⛔', '#888'] };
    $('#daBox').innerHTML = `
      <div class="card">
        <div class="kv"><span class="k">设备授权（白名单）</span>
          <span class="v"><button class="mini-btn ${on ? '' : 'ghost'}" id="daSw">${on ? '✅ 已开启' : '⭕ 未开启'}</button></span></div>
        <div class="hint" style="padding:0 12px 10px">开启后员工账号只能从已授权设备登录（ADMIN 超管豁免，保证审批入口不被锁）。
        新设备首次登录自动登记为「待授权」，把它的<b>设备码</b>在这里审批通过即可。浏览器无法读取 MAC 地址（属隐私数据且可伪造），设备码+UA 白名单更可靠。</div>
      </div>
      ${items.length ? items.map(d => { const [ic, col] = CN[d.status] || ['·', '#333']; return `
      <div class="card" style="padding:10px 12px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:20px">${ic}</div>
          <div class="grow">
            <div style="font-weight:600">${esc(d.deviceName || '未命名设备')} <span style="font-size:11px;color:${col}">${d.status}</span></div>
            <div style="font-size:12px;color:var(--ink-3)">设备码 <b style="color:var(--ink-2);user-select:all">${esc(d.deviceCode)}</b>
              ${d.lastSeenAt ? ' · 最近活跃 ' + esc(String(d.lastSeenAt).slice(0, 16).replace('T', ' ')) : ''}${d.lastIp ? ' · IP ' + esc(d.lastIp) : ''}</div>
            ${d.ua ? `<div style="font-size:10.5px;color:var(--ink-3);margin-top:2px;word-break:break-all">${esc(String(d.ua).slice(0, 90))}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          ${d.status !== '已授权' ? `<button class="mini-btn" data-ap="${d.id}" data-code="${esc(d.deviceCode)}">✅ 通过${d.status === '待授权' ? '授权' : '恢复'}</button>` : `<button class="mini-btn ghost" data-nm="${d.id}" data-code="${esc(d.deviceCode)}">✏️ 命名</button>`}
          ${d.status !== '已停用' ? `<button class="mini-btn ghost" data-bl="${d.id}">⛔ 停用</button>` : ''}
          <button class="mini-btn ghost" data-del="${d.id}">🗑 删除</button>
        </div>
      </div>`; }).join('') : '<div class="empty">暂无设备登记（开启授权后，新设备登录时会自动登记）</div>'}`;
    $('#daSw').onclick = async () => {
      try { await call('PUT', '/settings/pos.device.auth', { value: !on, reason: '收银机授权开关' }); toast(!on ? '设备授权已开启：新设备登录须审批' : '设备授权已关闭'); render(); }
      catch (e) { toast(e.message); }
    };
    $('#daBox').querySelectorAll('[data-ap]').forEach(b => b.onclick = async () => {
      const nm = prompt('设备名称（如：1号收银机，可留空）', '');
      if (nm === null) return;
      try { await call('POST', '/pos-devices/' + b.dataset.ap + '/approve', { name: nm }); toast('已通过授权：' + b.dataset.code); render(); }
      catch (e) { toast(e.message); }
    });
    $('#daBox').querySelectorAll('[data-nm]').forEach(b => b.onclick = async () => {
      const nm = prompt('设备名称（如：1号收银机）', '');
      if (nm === null) return;
      try { await call('POST', '/pos-devices/' + b.dataset.nm + '/approve', { name: nm }); toast('已更新设备名'); render(); }
      catch (e) { toast(e.message); }
    });
    $('#daBox').querySelectorAll('[data-bl]').forEach(b => b.onclick = async () => {
      if (!confirm('停用后该设备将无法登录员工账号，确认？')) return;
      try { await call('POST', '/pos-devices/' + b.dataset.bl + '/status', { status: '已停用' }); toast('已停用'); render(); }
      catch (e) { toast(e.message); }
    });
    $('#daBox').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('删除登记后，该设备下次登录会重新进入待授权，确认删除？')) return;
      try { await call('DELETE', '/pos-devices/' + b.dataset.del); toast('已删除'); render(); }
      catch (e) { toast(e.message); }
    });
  };
  await render();
};

// ── V4.13.3 支付通道设置：模式三态 + 微信/支付宝 API 配置（密钥加密落库、界面只显尾号、留空不改）──
View.paySettings = async function (v) {
  v.innerHTML = `<div id="psBox"><div class="empty">加载中…</div></div>`;
  let rows;
  try { rows = await call('GET', '/settings?group=' + encodeURIComponent('支付')); }
  catch (e) { $('#psBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const S = k => rows.find(r => r.setting_key === k) || {};
  const secRows = rows.filter(r => !['pay.gateway.mode', 'pay.wechat.gateway', 'pay.alipay.gateway'].includes(r.setting_key));
  const field = r => {
    const key = esc(r.setting_key);
    if (r.setting_key === 'pay.gateway.mode') {
      const cur = String(r.value ?? 'mock');
      const opts = [['off', '记账式收款（手记流水+二次确认）'], ['mock', '模拟通道（联调用）'], ['real', '真实通道（下方配置填齐后启用）']];
      return `<select id="ps_${key}" style="width:100%;padding:10px;font-size:14px;border:1px solid var(--line);border-radius:9px;background:#fff">
        ${opts.map(([v, t]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${v} · ${t}</option>`).join('')}</select>`;
    }
    if (r.value_type === 'secret') {
      const configured = r.value && r.value !== '未配置';
      return `<input id="ps_${key}" type="password" autocomplete="new-password" placeholder="${configured ? '输入新密钥覆盖' : '未配置：输入后保存'}"
        style="width:100%;padding:10px;font-size:14px;border:1px solid var(--line);border-radius:9px;font-family:monospace">
        <div style="font-size:11px;color:var(--ink-3);margin-top:3px">AES-256-GCM 加密落库 · ${configured ? '当前 ' + esc(String(r.value)) : '尚未配置'} · 留空保存 = 不修改</div>`;
    }
    if (r.value_type === 'bool') {
      const on = r.value === true || r.value === 'true';
      return `<button class="mini-btn ${on ? '' : 'ghost'}" data-sw="${key}">${on ? '✅ 已启用' : '⭕ 未启用'}</button>`;
    }
    return `<input id="ps_${key}" value="${esc(String(r.value ?? ''))}" style="width:100%;padding:10px;font-size:14px;border:1px solid var(--line);border-radius:9px">`;
  };
  const block = (title, keys) => `
    <div class="sec">${title}</div>
    <div class="card">${keys.map(k => { const r = S(k); return `
      <div style="margin-bottom:12px"><div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(r.display_name || k)}</div>
      ${field(r)}<div style="font-size:11px;color:var(--ink-3);margin-top:2px">${esc(r.remark || '')}</div></div>`; }).join('')}
      <button class="btn ok" id="psSave${title === '通道模式' ? 'Mode' : title.includes('微信') ? 'Wx' : 'Ali'}" style="width:100%;margin-top:4px">保存${title}</button>
    </div>`;
  $('#psBox').innerHTML = `
    <div class="hint">三步启用真通道：① 模式切 <b>real</b> ② 对应渠道填齐 API 配置并启用 ③ 收银台直接扫顾客付款码（成功信号自动落单）。密钥仅本人可见尾号，员工端与日志均不出现明文。</div>
    ${block('通道模式', ['pay.gateway.mode'])}
    ${block('微信支付（V3 付款码支付）', ['pay.wechat.enabled', 'pay.wechat.mchid', 'pay.wechat.appid',
      'pay.wechat.cert_serial', 'pay.wechat.apiv3_key', 'pay.wechat.private_key', 'pay.wechat.gateway'])}
    ${block('支付宝（当面付）', ['pay.alipay.enabled', 'pay.alipay.app_id', 'pay.alipay.private_key',
      'pay.alipay.public_key', 'pay.alipay.gateway'])}`;
  $('#psBox').querySelectorAll('[data-sw]').forEach(b => b.onclick = async () => {
    const on = b.textContent.includes('已启用');
    try { await call('PUT', '/settings/' + b.dataset.sw, { value: !on, reason: '老板端支付设置' }); toast(on ? '已关闭' : '已启用'); renderStack(); }
    catch (e) { toast(e.message); }
  });
  const bindSave = (btnId, keys) => {
    const btn = $('#psBox #' + btnId);
    if (!btn) return;
    btn.onclick = async () => {
      let n = 0;
      for (const k of keys) {
        const r = S(k);
        const el = $('#ps_' + k.replace(/\./g, '\\.'));
        if (!el) continue;
        const raw = String(el.value ?? '').trim();
        if (r.value_type === 'secret') { if (!raw) continue; await call('PUT', '/settings/' + k, { value: raw, reason: '老板端支付设置' }); el.value = ''; }
        else if (raw !== String(r.value ?? '')) { await call('PUT', '/settings/' + k, { value: raw, reason: '老板端支付设置' }); }
        else continue;
        n++;
      }
      toast(n ? `已保存 ${n} 项` : '无修改');
      renderStack();
    };
  };
  bindSave('psSaveMode', ['pay.gateway.mode']);
  bindSave('psSaveWx', ['pay.wechat.mchid', 'pay.wechat.appid', 'pay.wechat.cert_serial', 'pay.wechat.apiv3_key', 'pay.wechat.private_key', 'pay.wechat.gateway']);
  bindSave('psSaveAli', ['pay.alipay.app_id', 'pay.alipay.private_key', 'pay.alipay.public_key', 'pay.alipay.gateway']);
};

// ── 表名中文映射（系统初始化展示用）──
const TABLE_CN = {
  // 交易与结算
  sales_orders:'销售订单', sale_items:'销售明细', sale_payments:'销售支付', sale_refunds:'销售退款', sale_refund_items:'退款明细',
  sale_item_batches:'销售批次', return_batch_allocs:'退货批次分配', settlements:'结算单', shifts:'班次', held_orders:'挂单',
  recharge_orders:'充值订单', print_jobs:'打印任务',
  // 库存与单据
  batches:'批次', stock_flows:'库存流水', inventory_current:'当前库存', inbound_orders:'入库单', inbound_order_items:'入库明细',
  purchase_orders:'采购订单', purchase_order_items:'采购明细', purchase_returns:'采购退货', purchase_return_items:'采购退货明细',
  loss_records:'报损单', loss_items:'报损明细', reconciliations:'对账单', reconciliation_items:'对账明细', inventory_counts:'盘点单',
  inventory_count_items:'盘点明细', stocktake_tasks:'盘点任务', stocktake_task_items:'盘点任务明细', stock_transfers:'调拨单',
  stock_transfer_items:'调拨明细', bundle_ops:'组合装操作', bundle_op_items:'组合装操作明细', expiry_disposals:'临期处理',
  picking_shortages:'拣货缺货', consign_recons:'代销对账', consign_recon_items:'代销对账明细', price_changes:'价格变更',
  price_change_items:'价格变更明细', pricebook_snapshots:'价格本快照',
  // 会员与分红
  members:'会员', member_accounts:'会员账户', member_profiles:'会员资料', member_activity_windows:'会员活动窗口',
  member_addresses:'会员地址', member_coupons:'会员优惠券', member_level_log:'会员等级日志', points_flows:'积分流水',
  balance_flows:'余额流水', dividend_periods:'分红周期', dividend_records:'分红记录', big_customer_payments:'大客户回款',
  coupons:'优惠券', promotions:'促销活动', marketing_rules:'营销规则', marketing_touches:'营销触达',
  // 供应商往来
  supplier_ledger:'供应商台账', supplier_fees:'供应商费用',
  // AI 数据
  ai_recognition_logs:'AI识别日志', ai_samples:'AI样本', ai_name_embs:'AI名称向量', ai_tasks:'AI任务',
  ai_suggestions:'AI建议', forecast_snapshots:'预测快照', ai_kb_documents:'AI知识库文档', ai_kb_chunks:'AI知识库片段',
  // 操作日志
  audit_logs:'审计日志', setting_change_logs:'设置变更日志',
  // 可保留档案
  categories:'分类', products:'商品', product_barcodes:'商品条码', product_units:'商品单位', product_bundles:'组合装',
  product_bundle_items:'组合装明细', product_aliases:'商品别名', suppliers:'供应商', supplier_product_prices:'供应商供货价',
  supplier_fee_agreements:'供应商费用协议', supplier_fee_types:'供应商费用类型', member_levels:'会员等级',
  big_customers:'大客户', big_customer_prices:'大客户价格', promotion_templates:'促销模板',
  // 设备与模板
  devices:'设备', printers:'打印机', print_templates:'打印模板', signature_templates:'签名模板',
  // 系统骨架
  stores:'门店', employees:'员工', roles:'角色', permission_points:'权限点', role_permissions:'角色权限',
  employee_roles:'员工角色', system_settings:'系统设置', ai_models:'AI模型',
};

// ── V4.12 系统初始化（开业前清库）：白名单分组预览 → 二次确认 → 单事务 TRUNCATE ──
View.sysReset = async function (v) {
  v.innerHTML = `<div id="srBox"><div class="empty">加载中…</div></div>`;
  let PRE = null;
  try { PRE = await call('GET', '/admin/reset/preview'); }
  catch (e) { $('#srBox').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const n0c = n => Number(n || 0).toLocaleString('zh-CN');
  const tcn = n => TABLE_CN[n] || n;
  const grp = (label, items, key) => `
    <div class="sec">${label}</div>
    <div class="card" style="padding:8px 12px">
      <div style="display:flex;flex-wrap:wrap;gap:4px 10px">
        ${items.filter(x => x.n > 0).map(x => `<span style="font-size:11.5px;color:var(--ink-3)">${esc(tcn(x.name))}<b class="num" style="color:var(--ink-2)">&nbsp;${n0c(x.n)}</b></span>`).join('') || '<span style="font-size:12px;color:var(--ink-3)">均为空</span>'}
      </div>
    </div>`;
  $('#srBox').innerHTML = `
    <div class="card" style="border:1px solid #e6b8b3;background:#fdf3f2">
      <div style="font-weight:700;color:#b5544a;margin-bottom:4px">⚠️ 不可恢复的清空操作</div>
      <div style="font-size:12.5px;line-height:1.7;color:var(--ink-2)">
        将清空调试期间产生的全部业务数据（交易 / 库存单据 / 会员分红 / AI 样本 / 日志）。<br>
        <b>不会清除</b>：登录账号、角色权限、系统配置、AI 模型文件。<br>
        建议先在收银后台做一次<b>数据备份</b>再执行。
      </div>
    </div>
    <div class="sec">清空模式</div>
    <div class="card" style="padding:10px 12px">
      <label style="display:flex;gap:8px;align-items:flex-start;padding:6px 0">
        <input type="radio" name="srMode" value="full" checked style="margin-top:3px">
        <span><b>出厂全清</b><br><small style="color:var(--ink-3)">商品档案、供应商、客户、会员等级配置一并清空，软件回到全新状态</small></span>
      </label>
      <label style="display:flex;gap:8px;align-items:flex-start;padding:6px 0">
        <input type="radio" name="srMode" value="keep-master" style="margin-top:3px">
        <span><b>保留基础档案</b><br><small style="color:var(--ink-3)">保留商品 / 供应商 / 客户档案与价格（开业档案已建好时选这个），其余照清</small></span>
      </label>
      <label style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px dashed var(--line,#eee);margin-top:4px">
        <input type="checkbox" id="srDev">
        <span>同时清空设备与打印模板配置（${n0c(PRE.deviceTotal)} 行）<br><small style="color:var(--ink-3)">收银机 / 扫码枪 / 打印机需重新配对</small></span>
      </label>
    </div>
    ${PRE.groups.map(g => grp(g.label, g.tables, g.key)).join('')}
    <div class="sec">永不清除（系统骨架）</div>
    <div class="card" style="padding:8px 12px">
      <div style="display:flex;flex-wrap:wrap;gap:4px 10px">
        ${PRE.keepAlways.map(x => `<span style="font-size:11.5px;color:#1a7a3a">${esc(tcn(x.name))}<b class="num">&nbsp;${n0c(x.n)}</b></span>`).join('')}
      </div>
    </div>
    <div class="card" style="margin-top:10px">
      <div class="kv"><span class="k">合计清空</span><span class="v num" id="srTotal">—</span></div>
      <div class="kv"><span class="k">基础档案</span><span class="v num" id="srMaster">${n0c(PRE.masterTotal)} 行（随模式）</span></div>
    </div>
    <div class="card">
      <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:6px">请输入「<b style="color:#b5544a">初始化</b>」以解锁执行按钮：</div>
      <input id="srConfirm" placeholder="输入：初始化" style="width:100%;padding:10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:15px">
      <button class="btn" id="srGo" disabled style="width:100%;margin-top:10px;background:#b5544a">🏗️ 执行系统初始化</button>
      <div class="hint" id="srMsg" style="margin-top:8px"></div>
    </div>`;
  const totalEl = $('#srTotal'), masterEl = $('#srMaster'), goBtn = $('#srGo'), msg = $('#srMsg'), cf = $('#srConfirm');
  const modeOf = () => v.querySelector('input[name=srMode]:checked')?.value || 'full';
  const refreshTotal = () => {
    const m = modeOf();
    totalEl.textContent = `${n0c(PRE.total + (m === 'full' ? PRE.masterTotal : 0) + ($('#srDev').checked ? PRE.deviceTotal : 0))} 行`;
    masterEl.textContent = m === 'full' ? `${n0c(PRE.masterTotal)} 行（将清空）` : `${n0c(PRE.masterTotal)} 行（将保留）`;
  };
  v.querySelectorAll('input[name=srMode]').forEach(r => r.onchange = refreshTotal);
  $('#srDev').onchange = refreshTotal;
  cf.oninput = () => { goBtn.disabled = cf.value.trim() !== '初始化'; };
  refreshTotal();
  goBtn.onclick = async () => {
    if (cf.value.trim() !== '初始化') return;
    if (!confirm('最后确认：数据清空后不可恢复，确定执行系统初始化？')) return;
    goBtn.disabled = true; goBtn.textContent = '初始化中…';
    try {
      const d = await call('POST', '/admin/reset/execute', { mode: modeOf(), clearDevices: $('#srDev').checked, confirm: cf.value.trim() });
      msg.innerHTML = `<span style="color:#1a7a3a">✅ ${esc(d.notice)}（清空 ${d.tables} 张表 / ${n0c(d.rowsCleared)} 行，已留痕审计）</span>`;
      toast('系统初始化完成');
      goBtn.textContent = '已完成';
    } catch (e) {
      msg.innerHTML = `<span style="color:#b5544a">❌ ${esc(e.message)}</span>`;
      goBtn.disabled = false; goBtn.textContent = '🏗️ 执行系统初始化';
    }
  };
};

// ── 启动 ──
(async function boot() {
  // 扫码登录：链接带 #qr=<ticket>（后台快捷入口「老板端登录」生成）→ 一次性换 token 免密登录
  const mQr = location.hash.match(/qr=([0-9a-f]+)/i);
  if (mQr) {
    history.replaceState(null, '', location.pathname);   // 立刻清掉票据，防截图/转发泄露
    try {
      const d = await call('POST', '/auth/qr-login', { ticket: mQr[1], device: await bossDeviceCred('') });
      TOKEN = d.token;
      localStorage.setItem(LS.token, TOKEN);
    } catch (e) {
      const el = $('#authErr'); if (el) el.textContent = '扫码登录失败：' + e.message;
    }
  }
  if (TOKEN) {
    try { await loadMe(); showMain(); }
    catch { logout(); }
  } else if (!mQr) {
    /* V5.0.14b：统一登录入口 —— 老板端不再保留独立登录页（取消），无登录态一律
     * 回员工端初始登录页，由账号角色判定进哪个端。探测失败（两候选都不通）时
     * 才退回本页登录表单兜底。 */
    const u = await resolvePwaUrl();
    if (u) { location.replace(u); return; }
  }
})();

// ── VQA 体检项：老板端消息中心视图（View 声明后挂载）──
/* V5.0.13b：批量已读 / 批量删除（已读消息）。
 *  · 常驻工具栏：「全部已读」一键全读；「删除已读」一键清掉所有本人已读的（confirm 后走 /finance/notices/delete-read）；
 *  · 「多选」进入勾选模式：卡片带复选框，底部操作条支持 全选 / 批量已读 / 删除所选（未读混入时服务端自动剔除并提示）。
 *  · 顺带修：后端返回 createdAt（驼峰），旧代码读 created_at → 时间列一直为空。 */
View.notices = async function (v) {
  const items = await call('GET', '/finance/notices');
  const list = Array.isArray(items) ? items : (items.items || items.list || []);
  if (!list.length) { v.innerHTML = '<div class="empty">暂无消息；设备缺纸、秤离线、对账差异等告警会出现在这里</div>'; return; }
  const unreadN = list.filter(n => !n.read).length;
  const readN = list.length - unreadN;
  let pickMode = false;
  const sel = new Set();
  const whenOf = n => String(n.createdAt || n.created_at || '').replace('T', ' ').slice(5, 16);

  const render = () => {
    const unreadNow = list.filter(n => !n.read).length;
    const readNow = list.length - unreadNow;
    v.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px">
        <button class="btn ghost" id="nReadAll" style="width:auto;padding:6px 14px;font-size:12.5px;margin:0" ${unreadNow ? '' : 'disabled'}>📕 全部已读（${unreadNow}）</button>
        <button class="btn ghost" id="nDelRead" style="width:auto;padding:6px 14px;font-size:12.5px;margin:0" ${readNow ? '' : 'disabled'}>🗑 删除已读（${readNow}）</button>
        <button class="btn ghost" id="nPick" style="width:auto;padding:6px 14px;font-size:12.5px;margin:0">${pickMode ? '✕ 退出多选' : '☑ 多选'}</button>
      </div>
      ${list.map(n => {
        const unread = !n.read;
        const checked = sel.has(n.id);
        return `<div class="card" data-nrow="${n.id}" style="margin-bottom:10px;display:flex;gap:8px;align-items:flex-start;${unread ? 'border-left:3px solid var(--red);' : 'opacity:.62;'}${pickMode ? 'cursor:pointer;' : ''}">
          ${pickMode ? `<input type="checkbox" data-nchk="${n.id}" ${checked ? 'checked' : ''} style="width:18px;height:18px;margin-top:2px;flex:none">` : ''}
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13.5px">${esc(n.text || n.title || n.kind)}${unread ? ' <span style="color:var(--red);font-size:11px">未读</span>' : ''}</div>
            <div style="color:var(--ink-2);font-size:11.5px;margin-top:2px">${esc(whenOf(n))} · ${esc(n.kind || '')}
              ${!pickMode && unread ? `<button class="btn ghost" style="width:auto;padding:3px 12px;font-size:11.5px;float:right" data-nid="${n.id}">标记已读</button>` : ''}
            </div>
          </div></div>`;
      }).join('')}
      ${pickMode ? `<div style="position:sticky;bottom:0;display:flex;gap:8px;padding:10px 0;background:var(--bg,#fff);">
        <button class="btn ghost" id="nSelAll" style="width:auto;padding:6px 14px;font-size:12.5px;margin:0;flex:1">全选</button>
        <button class="btn ghost" id="nBatchRead" style="width:auto;padding:6px 14px;font-size:12.5px;margin:0;flex:1" ${sel.size ? '' : 'disabled'}>批量已读（${sel.size}）</button>
        <button class="btn" id="nBatchDel" style="width:auto;padding:6px 14px;font-size:12.5px;margin:0;flex:1" ${sel.size ? '' : 'disabled'}>🗑 删除所选</button>
      </div>` : ''}`;

    const readAll = $('#nReadAll');
    if (readAll) readAll.onclick = async () => {
      try { const r = await call('POST', '/finance/notices/read-all', {}); toast(`已全部标记已读（${r.updated || 0} 条）`); await reload(); }
      catch (e) { toast(e.message); }
    };
    const delRead = $('#nDelRead');
    if (delRead) delRead.onclick = async () => {
      if (!confirm(`删除全部已读消息（${readNow} 条）？未读消息不受影响。`)) return;
      try { const r = await call('POST', '/finance/notices/delete-read', {}); toast(`已删除 ${r.deleted || 0} 条已读消息`); await reload(); }
      catch (e) { toast(e.message); }
    };
    $('#nPick').onclick = () => { pickMode = !pickMode; sel.clear(); render(); };
    v.querySelectorAll('[data-nid]').forEach(btn => btn.onclick = async e => {
      e.stopPropagation();
      try { await call('POST', `/finance/notices/${btn.dataset.nid}/read`, {}); await reload(); }
      catch (err) { toast(err.message); }
    });
    if (pickMode) {
      v.querySelectorAll('[data-nrow]').forEach(row => row.onclick = () => {
        const id = Number(row.dataset.nrow);
        sel.has(id) ? sel.delete(id) : sel.add(id);
        render();
      });
      $('#nSelAll').onclick = () => {
        if (sel.size === list.length) sel.clear(); else list.forEach(n => sel.add(n.id));
        render();
      };
      $('#nBatchRead').onclick = async () => {
        if (!sel.size) return;
        try {
          const r = await call('POST', '/finance/notices/read-batch', { ids: [...sel] });
          toast(`已标记已读 ${r.updated || 0} 条`);
          sel.clear(); pickMode = false; await reload();
        } catch (e) { toast(e.message); }
      };
      $('#nBatchDel').onclick = async () => {
        const ids = [...sel];
        const selUnread = list.filter(n => sel.has(n.id) && !n.read).length;
        const tip = selUnread ? `所选 ${ids.length} 条中有 ${selUnread} 条未读（未读不会删除），确认删除其余已读消息？` : `删除所选 ${ids.length} 条已读消息？`;
        if (!confirm(tip)) return;
        try {
          const r = await call('POST', '/finance/notices/delete-read', { ids });
          toast(`已删除 ${r.deleted || 0} 条${r.skipped ? `（${r.skipped} 条未读已跳过）` : ''}`);
          sel.clear(); pickMode = false; await reload();
        } catch (e) { toast(e.message); }
      };
    }
  };
  const reload = async () => { await View.notices(v); refreshNoticesBadge(); };
  render();
};
setInterval(refreshNoticesBadge, 60000);
