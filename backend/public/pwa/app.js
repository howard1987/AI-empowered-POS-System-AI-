'use strict';
/* 员工移动端 PWA · 核心（app.js）：登录 / 路由 / 底部 Tab / 我的 / 离线队列
 * 对端：后端同源 API（/auth /purchase /inventory /sales /pos /members /upload） */
const LS = { token: 'pwa_token', api: 'pwa_api_base', queue: 'pwa_queue' };
const API_BASE = localStorage.getItem(LS.api) || '';   // 同源默认空串；跨机调试可改
let TOKEN = localStorage.getItem(LS.token) || '';
let ME = null;                                          // {staffId, empNo, name, perms, storeId}
const View = {};                                        // 各模块视图注册表（work/checkout/docs/me 挂载于此）

// ── 工具 ──
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n ?? 0).toFixed(2);
const dt = s => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? String(s)
  : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hasPerm = c => !!(ME && ME.perms && ME.perms.includes(c));

// ── V4.24.0 桌面端（EXE 壳）模式识别与登录页适配 ──
//  EXE 壳加载 /pwa/?desktop=1 且 preload 注入 window.DesktopShell → 登录页进入「电脑端」形态：
//   顶部标题栏（最小化/最大化/关闭）+ 居中卡片（账号/工号/密码，密码框内小眼睛）+ 底部「交接班记录」圆入口；
//   退出收银台 = 退出登录回登录页（不再落手机工作台）。
//  浏览器/PWA 手机端不带这两个标记，版式与行为完全不变。
const IS_DESKTOP = !!((window.DesktopShell && window.DesktopShell.isDesktop) || /[?&]desktop=1/.test(location.search));
window.IS_DESKTOP = IS_DESKTOP;   // 供 cashier.js 等模块判断（顶层 const 不在 window 上，须显式挂）
if (IS_DESKTOP) {
  document.documentElement.classList.add('desktop-mode');
  const h1 = $('#lgTitle'); if (h1) h1.textContent = '收银员登录';
  const sub = $('#lgSub'); if (sub) sub.textContent = '社区超市 · 收银 / 挂单 / 交接班';
  const bar = $('#lgBarTitle'); if (bar) bar.textContent = '收银台';
  const ver = $('#lgVer'); if (ver) ver.textContent = '桌面端';
  // ⑤ 标题栏窗口按钮：最小化 / 最大化 / 关闭（替代原「关闭程序」按钮，与系统窗口行为一致）
  const winAct = k => () => { try { window.DesktopShell && DesktopShell[k] && DesktopShell[k](); } catch { /* 浏览器无壳忽略 */ } };
  const bMin = $('#lgMin'), bMax = $('#lgMax'), bClose = $('#lgClose');
  if (bMin) bMin.onclick = winAct('winMinimize');
  if (bMax) bMax.onclick = winAct('winMaximize');
  if (bClose) bClose.onclick = () => { if (confirm('确认关闭收银程序？')) winAct('winClose')(); };
  // 底部圆入口：交接班记录（本机留痕，登录前也能核对）
  const sh = $('#lgShifts'); if (sh) sh.onclick = openLocalShiftLog;
}

// ── V4.22.3 EXE 壳窗口形态：登录页 = 卡片小窗（不置顶、可切换其他程序）；收银台 = 全屏铺满（不置顶） ──
function setShellMode(mode) {
  try { window.DesktopShell && window.DesktopShell.setShellMode && window.DesktopShell.setShellMode(mode); } catch { /* 浏览器/手机端无壳 */ }
}

// ── 请求（统一响应 {code,msg,data}；code=0 成功）──
async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
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
  if (r.code !== 0) throw new Error(r.msg || ('请求失败 #' + r.code));
  return r.data;
}
/** 解包列表：兼容直接数组 / {items:[]} / {data:[]} 三种返回 */
function unwrap(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.items)) return d.items;
  if (d && Array.isArray(d.data)) return d.data;
  return d || [];
}

// ── 提示 ──
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ── V4.14.2 样式化确认/输入弹窗（替代原生 confirm/prompt）；V4.18.2 桌面级视觉重做：
//    标题带语义图标、正文分层、按钮右对齐紧凑化（不再用手机端 .btn 全宽巨按钮）──
function pcShell(title, bodyHtml, opts = {}) {
  const danger = !!opts.danger;
  const ico = danger
    ? '<span class="pc-ico bad"><svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z"/></svg></span>'
    : '<span class="pc-ico"><svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></span>';
  return `<div class="sheet pc-card">
    <div class="pc-head">${ico}<h3>${esc(title)}</h3></div>
    <div class="pc-body">${bodyHtml || ''}</div>
    <div class="pc-actions">__BTNS__</div></div>`;
}
function pcBtn(id, label, kind) {
  return `<button class="pc-btn ${kind}" id="${id}">${esc(label)}</button>`;
}
function pwaConfirm(title, html, opts = {}) {
  return new Promise(res => {
    const m = document.createElement('div');
    m.className = 'modal-mask';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(15,25,18,.5);z-index:9998;display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(2px)';
    m.innerHTML = pcShell(title, html, opts).replace('__BTNS__',
      pcBtn('pcNo', '取消', 'ghost') + pcBtn('pcYes', opts.okText || '确认', opts.danger ? 'bad' : 'pri'));
    document.body.appendChild(m);
    const done = v => { m.remove(); document.removeEventListener('keydown', onKey, true); res(v); };
    m.querySelector('#pcNo').onclick = () => done(false);
    m.querySelector('#pcYes').onclick = () => done(true);
    m.onclick = e => { if (e.target === m) done(false); };
    // V4.19.0：opts.enterOk=true 时回车=确认（用于「收款成功→新的一单」键盘流；危险确认不启用）
    const onKey = e => {
      if (e.key !== 'Enter' || !opts.enterOk) return;
      e.preventDefault(); e.stopPropagation();
      m.querySelector('#pcYes').click();
    };
    if (opts.enterOk) document.addEventListener('keydown', onKey, true);
  });
}
function pwaPrompt(title, placeholder, opts = {}) {
  return new Promise(res => {
    const m = document.createElement('div');
    m.className = 'modal-mask';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(15,25,18,.5);z-index:9998;display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(2px)';
    m.innerHTML = pcShell(title, `<div class="field"><input id="ppIn" placeholder="${esc(placeholder || '')}"></div>${opts.hint ? `<div class="pc-hint">${esc(opts.hint)}</div>` : ''}`, opts)
      .replace('__BTNS__', pcBtn('ppNo', '取消', 'ghost') + pcBtn('ppYes', opts.okText || '确定', opts.danger ? 'bad' : 'pri'));
    document.body.appendChild(m);
    const inp = m.querySelector('#ppIn');
    setTimeout(() => inp.focus(), 60);
    const done = v => { m.remove(); res(v); };
    m.querySelector('#ppNo').onclick = () => done(null);
    m.querySelector('#ppYes').onclick = () => done(inp.value);
    inp.onkeydown = e => { if (e.key === 'Enter') m.querySelector('#ppYes').click(); };
    m.onclick = e => { if (e.target === m) done(null); };
  });
}

// ── 头部 / 子视图栈 ──
let CURRENT_TAB = 'work';
let CURRENT_ARG = null;
const stack = [];
function renderStack() {
  const v = $('#view');
  $('#hdBack').classList.toggle('hidden', !stack.length);
  if (stack.length) {
    const top = stack[stack.length - 1];
    $('#hdTitle').textContent = top.title;
    top.fn(v, top.args);
  } else {
    $('#hdTitle').textContent = { work: '作业', docs: '单据', msg: '消息', me: '我的' }[CURRENT_TAB];
    ({ work: View.work, docs: View.docs, msg: View.msg, me: View.me }[CURRENT_TAB])(v, CURRENT_ARG);
  }
}
function openTab(tabId, arg) {
  CURRENT_TAB = tabId;
  CURRENT_ARG = arg || null;
  document.querySelectorAll('#tabbar .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tabId));
  stack.length = 0;
  renderStack();
}
/** 子页面入栈：同步压一条 history，手机物理返回键 / 侧滑返回可直接回上一层 */
function push(title, fn, args) {
  stack.push({ title, fn, args });
  try { history.pushState({ pwaDepth: stack.length }, ''); } catch { /* 非安全上下文忽略 */ }
  renderStack();
}
/** 出栈：物理返回键与顶部「‹」共用同一入口 */
function popView() {
  if (!stack.length) return false;
  stack.pop();
  renderStack();
  return true;
}
$('#hdBack').onclick = () => {
  // 有 history 记录则走浏览器返回（保持前进/后退一致），否则直接出栈
  if (history.state && history.state.pwaDepth) history.back();
  else popView();
};
window.addEventListener('popstate', () => { if (stack.length) popView(); });
document.querySelectorAll('#tabbar .tab').forEach(b => b.onclick = () => openTab(b.dataset.tab));

/* ── V4.9.8 弹层返回兜底：任何弹窗若没有关闭/取消入口，自动注入顶部「‹ 返回」条 ──
 * 解决"部分功能模块弹层进得去出不来"（如缺货登记、AI 识别、扫码、一码多品选择）。 */
const CLOSE_RE = /(关闭|取消|返回|✕|×|完成)/;
function ensureModalBack(m) {
  if (!m || m.dataset.mb) return;
  m.dataset.mb = '1';
  const sheet = m.querySelector('.sheet') || m;
  const has = Array.prototype.some.call(sheet.querySelectorAll('button,a'),
    b => CLOSE_RE.test((b.textContent || '').trim()) || /(close|cancel|back)/i.test(b.id || ''));
  if (has) return;
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;margin:-2px 0 8px';
  const btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.textContent = '‹ 返回';
  btn.onclick = () => m.remove();
  bar.appendChild(btn);
  sheet.insertBefore(bar, sheet.firstChild);
}
new MutationObserver(muts => {
  for (const mut of muts) for (const n of mut.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.classList && n.classList.contains('modal')) ensureModalBack(n);
    n.querySelectorAll && n.querySelectorAll('.modal').forEach(ensureModalBack);
  }
}).observe(document.body, { childList: true, subtree: true });

// ── 离线暂存队列（8.5.1：断电断网 → 本地暂存 → 恢复自动续传）──
function queueList() { try { return JSON.parse(localStorage.getItem(LS.queue) || '[]'); } catch { return []; } }
function enqueueOffline(payload) {
  const q = queueList();
  q.push({ ...payload, queuedAt: new Date().toISOString() });
  localStorage.setItem(LS.queue, JSON.stringify(q));
}
async function flushQueue() {
  const q = queueList();
  if (!q.length) return 0;
  let ok = 0;
  const remain = [];
  for (const it of q) {
    try {
      if (it.kind === 'refund') {
        // V4.19.0 P15.5 #3 离线退货：现金退款暂存单补传（clientRef 幂等，服务端同 ref 返回原单）
        await call('POST', '/refunds', {
          orderId: it.orderId, items: it.items, reason: it.reason, restock: it.restock !== false,
          clientRef: it.clientRef,
        });
        ok++;
      } else {
        await call('POST', '/sales/checkout', {
          items: it.items, payments: it.payments, channel: it.channel,
          isEmergency: it.isEmergency, memberId: it.memberId, remark: it.remark || '离线补传',
          clientRef: it.clientRef,   // 幂等：服务端同 ref 返回原单，重试不重复入账
        });
        ok++;
      }
    } catch (e) {
      // V4.19.0：补传失败不再无限重试刷屏——记设备埋点+消息收纳，仍保留队列
      try {
        if (window.PwaDevices) window.PwaDevices.report('sync', '', 'sync_fail', 'warn', { clientRef: it.clientRef, msg: String(e && e.message || e).slice(0, 120) }, it.clientRef);
      } catch { /* noop */ }
      if (window.CsMsg) window.CsMsg(`补传失败（保留重试）：${String(e && e.message || e).slice(0, 60)}`, 'warn');
      remain.push(it);
    }
  }
  if (ok) toast(`离线补传成功 ${ok} 单`);
  localStorage.setItem(LS.queue, JSON.stringify(remain));
  return ok;
}
window.addEventListener('online', flushQueue);

// ── 认证 ──
// V4.21.1 收银机授权：本机设备码（首次生成后持久化；设备授权开启后管理员按码审批白名单）
function deviceCode() {
  let c = localStorage.getItem('pwa_device_code');
  if (!c) {
    const b = new Uint8Array(4); (crypto || {}).getRandomValues && crypto.getRandomValues(b);
    c = 'D' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    localStorage.setItem('pwa_device_code', c);
  }
  return c;
}
async function login(empNo, password) {
  const d = await call('POST', '/auth/login', { empNo, password, deviceCode: deviceCode() });
  return loginWith(d.token);
}
/** V4.24.0：拿到 token 后的统一落地（密码登录 / PIN 登录 / 首次建管理员共用） */
async function loginWith(token) {
  TOKEN = String(token || '');
  localStorage.setItem(LS.token, TOKEN);
  await loadMe();
  showMain();
  return ME;
}
async function loadMe() {
  const d = await call('GET', '/auth/me');
  ME = { staffId: d.staffId, empNo: d.empNo, name: d.name, storeId: d.storeId, perms: d.perms || [] };
  $('#hdUser').textContent = ME.name;
  // V4.16.5 门头动态化：小票抬头优先「商店信息-商店名称」（后台可改），留空回退门店档案名
  try {
    const s = await call('GET', '/settings/key/store.info.name');
    const nm = String(s?.value || '').replace(/^"|"$/g, '').trim();
    const storeName = nm || String(d.storeName || '').trim();
    if (storeName) localStorage.setItem('pwa_store_name', storeName);
  } catch { /* 静默：打印时回退模板抬头 */ }
  applyDesktopSettings();   // V4.24.0 ⑦：同步「强 Kiosk 置顶」开关到 EXE 壳（无壳环境自动忽略）
  return ME;
}
/** V4.24.0 ⑦：后台「全屏强制置顶（强 Kiosk）」开关 → 通知 EXE 壳立即生效；浏览器端无壳忽略 */
async function applyDesktopSettings() {
  if (!window.DesktopShell || !DesktopShell.setKioskTopmost) return;
  try {
    const s = await call('GET', '/settings/key/' + encodeURIComponent('pos.desktop.kiosk_topmost'));
    const v = s ? s.value : null;
    DesktopShell.setKioskTopmost(v === true || String(v) === 'true' || String(v) === '1');
  } catch { /* 读不到按默认（关：可切走） */ }
}
function logout() {
  // V4.25.8：退出登录时同步清空副屏（避免下次登录显示旧购物车/会员）
  clearCustomerDisplay();
  TOKEN = ''; ME = null;
  localStorage.removeItem(LS.token);
  try { sessionStorage.removeItem('pwa_cashier_exited'); } catch { }   // V4.18.0：新登录重新直落收银台
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  setShellMode('login');   // V4.22.3：EXE 壳收回全屏 → 回到卡片大小登录窗（不置顶，可切换其他程序）
  refreshLoginForm();      // V4.24.0：回登录页时按「记住的工号 / PIN 模式」复原表单
}
/** V4.25.8：退出/关闭收银端时清空顾客副屏（购物车、会员、支付引导全部复位） */
function clearCustomerDisplay() {
  try {
    const payload = JSON.stringify({ status: 'idle', items: [], payable: 0, saved: 0, member: null, guide: '欢迎光临' });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(API_BASE + '/display/push', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch(API_BASE + '/display/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
    }
  } catch { }
}
// 关闭/刷新页面时同样清空副屏（直接点 ✕ 退出浏览器不走 logout 路径）
window.addEventListener('beforeunload', clearCustomerDisplay);
function showMain() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  setShellMode('cashier');   // V4.22.3：EXE 壳进全屏收银台（盖任务栏，但不置顶 → Alt+Tab 可切其他程序）
  openTab('work');
  // V4.18.0 P14：登录/恢复会话后直落新收银台（开关 pos.cashier.new_ui=0 回退旧「作业-收银」）
  if (window.CashierShell) window.CashierShell.maybeEnter();
}

// ══ V4.24.0 ⑨ 登录页：只记工号 + 记住 PIN ══
//  设计（老板拍板：后端 PIN 登录）：本机只留「工号」，不发密码；用户勾选「记住 PIN」后，
//  登录成功时用刚输入的密码作凭证把 PIN 写到服务端（bcrypt 存 pin_hash），下次直接 工号 + PIN 免密登录。
//  安全：本机 localStorage 绝不落密码明文（旧版 pwa_login_remember 会在启动时清除）。
const LS_LOGIN_NO = 'pwa_login_no';
const LS_PIN_ON = 'pwa_login_pin_on';
let authMode = 'pw';          // 'pw' = 密码登录 | 'pin' = PIN 免密登录
function readLoginNo() { try { return localStorage.getItem(LS_LOGIN_NO) || ''; } catch { return ''; } }
function pinEnabled() { try { return localStorage.getItem(LS_PIN_ON) === '1'; } catch { return false; } }
function setPinEnabled(on) { try { on ? localStorage.setItem(LS_PIN_ON, '1') : localStorage.removeItem(LS_PIN_ON); } catch { /* 隐私模式忽略 */ } }
function rememberNo(no) { try { localStorage.setItem(LS_LOGIN_NO, String(no || '').trim()); } catch { /* 忽略 */ } }

/** 登录 / PIN 两种形态互切：改标签、占位、输入模式与辅助行可见性 */
function setAuthMode(mode) {
  authMode = mode === 'pin' ? 'pin' : 'pw';
  const pin = authMode === 'pin';
  const lbl = $('#lgPwLabel'), pw = $('#lgPw'), modeLink = $('#lgMode'), pinRow = $('#lgPinRow'), pinSet = $('#lgPinSet');
  if (lbl) lbl.textContent = pin ? 'PIN' : '密码';
  if (pw) {
    pw.value = '';
    pw.type = 'password';
    pw.placeholder = pin ? 'PIN（4~8 位数字）' : '登录密码';
    pw.setAttribute('autocomplete', pin ? 'off' : 'current-password');
    if (pin) { pw.setAttribute('inputmode', 'numeric'); pw.setAttribute('maxlength', '8'); }
    else { pw.removeAttribute('inputmode'); pw.removeAttribute('maxlength'); }
  }
  if ($('#lgEye')) { $('#lgEye').textContent = '👁'; $('#lgEye').classList.remove('on'); }
  if (pinRow) pinRow.style.display = pin ? 'none' : '';
  if (pinSet) pinSet.style.display = (!pin && $('#lgPin') && $('#lgPin').checked) ? '' : 'none';
  if (modeLink) {
    modeLink.classList.toggle('hidden', !pin && !pinEnabled());   // 未启用 PIN 时不显示「用 PIN 登录」
    modeLink.textContent = pin ? '用密码登录' : '用 PIN 快速登录';
  }
  if ($('#lgGo')) $('#lgGo').textContent = pin ? 'PIN 登 录' : '登 录';
}
/** 回登录页 / 启动时复原表单：工号（始终记住）+ PIN 模式（曾启用过才进 PIN 模式） */
function refreshLoginForm() {
  const no = $('#lgNo');
  if (no && !no.value) no.value = readLoginNo();
  const box = $('#lgPin'); if (box) box.checked = pinEnabled();
  setAuthMode(pinEnabled() && readLoginNo() ? 'pin' : 'pw');
}
// 密码框内小眼睛（密码 / PIN / 注册密码 三处共用）
function bindEye(btnSel, inpSel) {
  const b = $(btnSel), i = $(inpSel);
  if (!b || !i) return;
  b.onclick = () => {
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    b.classList.toggle('on', show);
    b.textContent = show ? '🙈' : '👁';
    b.setAttribute('aria-label', show ? '隐藏' : '显示');
    try { i.focus(); } catch { /* noop */ }
  };
}
(function initLoginForm() {
  try { localStorage.removeItem('pwa_login_remember'); } catch { /* 旧版存过密码本机，一律清除 */ }   // V4.24.0 安全：不再本机存密码
  bindEye('#lgEye', '#lgPw');
  bindEye('#lgPinEye', '#lgPinVal');
  bindEye('#rgEye', '#rgPw');
  const box = $('#lgPin');
  if (box) box.onchange = () => {
    const set = $('#lgPinSet');
    if (set) set.style.display = box.checked ? '' : 'none';
    if (box.checked) { const el = $('#lgPinVal'); if (el) try { el.focus(); } catch { /* noop */ } }
  };
  const modeLink = $('#lgMode');
  if (modeLink) modeLink.onclick = () => setAuthMode(authMode === 'pin' ? 'pw' : 'pin');
  refreshLoginForm();
})();

// ══ V4.24.0 ⑥ 启动自检：库里有没有管理员（不写死 ADMIN/admin123）══
//  无 → 提示「未检测到管理员，请先创建管理员账号」并切到注册表单（建完直接进收银台）
//  有 → 提示「检测到管理员账户 XXX，请使用管理员密码进行登录」并预填工号
function switchAuthPane(reg) {
  const f = $('#lgForm'), r = $('#lgReg'), foot = $('#lgFoot');
  if (f) f.classList.toggle('hidden', !!reg);
  if (r) r.classList.toggle('hidden', !reg);
  if (foot) foot.classList.toggle('hidden', !!reg);
}
async function initBootstrap() {
  try {
    const b = await call('GET', '/auth/bootstrap');
    const st = $('#lgStore');
    if (b && b.storeName) { if (st) st.value = b.storeName; localStorage.setItem('pwa_store_name', b.storeName); }
    else if (st) st.value = localStorage.getItem('pwa_store_name') || '本店';
    const notice = $('#lgNotice');
    if (b && !b.hasAdmin) {
      if (notice) { notice.className = 'lg-notice warn'; notice.style.display = ''; notice.innerHTML = '⚠ 未检测到管理员，请先创建管理员账号'; }
      const rs = $('#rgStore'); if (rs && !rs.value) rs.value = String(b.storeName || '').replace(/^"|"$/g, '');
      switchAuthPane(true);
      const rn = $('#rgNo'); if (rn) try { rn.focus(); } catch { /* noop */ }
    } else if (b) {
      if (notice) {
        notice.className = 'lg-notice ok'; notice.style.display = '';
        notice.innerHTML = `检测到管理员账户 <b>${esc(b.adminEmpNo)}</b>${b.adminName ? '（' + esc(b.adminName) + '）' : ''}，请使用管理员密码进行登录`;
      }
      switchAuthPane(false);
      const no = $('#lgNo'); if (no && !no.value) no.value = b.adminEmpNo || '';
    }
  } catch { /* 服务器不可达：保持默认表单（错误在登录时提示），不阻断 */ }
}

$('#lgGo').onclick = async () => {
  const err = $('#authErr');
  err.textContent = '';
  const no = ($('#lgNo').value || '').trim();
  if (!no) { err.textContent = '请输入工号'; return; }
  const btn = $('#lgGo');
  btn.disabled = true;
  try {
    if (authMode === 'pin') {
      // 免密登录：工号 + PIN（PIN 在服务端 bcrypt 校验，本机不存任何密码）
      const pin = ($('#lgPw').value || '').trim();
      if (!pin) { err.textContent = '请输入 PIN'; return; }
      const d = await call('POST', '/auth/pin-login', { empNo: no, pin, deviceCode: deviceCode() });
      rememberNo(no);
      await loginWith(d.token);
      toast('PIN 登录成功');
    } else {
      const pw = $('#lgPw').value;
      await login(no, pw);          // 内含 showMain()（切全屏收银态）
      rememberNo(no);
      // 记住 PIN：登录成功后再写（绝不存密码本身）；未勾选则清掉本机免密标记
      const box = $('#lgPin');
      if (box && box.checked) {
        const pv = (($('#lgPinVal') || {}).value || '').trim();
        if (/^\d{4,8}$/.test(pv)) {
          try {
            await call('POST', '/auth/pin', { password: pw, pin: pv });
            setPinEnabled(true);
            toast('已记住 PIN：下次可直接用 PIN 免密登录');
          } catch (e) {
            setPinEnabled(false);
            toast('PIN 设置失败：' + (e.message || e) + '（下次仍需输密码）');
          }
        } else {
          setPinEnabled(false);
          toast(pv ? 'PIN 需 4~8 位数字，本次未启用免密登录' : '未填写 PIN，本次未启用免密登录');
        }
      } else {
        setPinEnabled(false);
      }
      toast('登录成功');
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    err.textContent = msg;
    // PIN 失效（未设置 / 被清）→ 自动退回密码模式，避免用户卡在 PIN 界面
    if (authMode === 'pin' && /未设置 PIN/.test(msg)) { setAuthMode('pw'); err.textContent = '该工号未设置 PIN，请用密码登录'; }
  } finally {
    btn.disabled = false;
  }
};
$('#lgNo').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lgPw').focus(); });
$('#lgPw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lgGo').click(); });

// ══ V4.24.0 ⑥ 创建首个管理员（库中无管理员时）══
$('#rgGo').onclick = async () => {
  const err = $('#authErr');
  err.textContent = '';
  const empNo = ($('#rgNo').value || '').trim();
  const name = ($('#rgName').value || '').trim();
  const pw = $('#rgPw').value, pw2 = $('#rgPw2').value;
  if (!empNo || !name || !pw) { err.textContent = '工号、姓名、密码均为必填'; return; }
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(empNo)) { err.textContent = '工号仅支持 2~32 位字母/数字/下划线/中划线'; return; }
  if (pw !== pw2) { err.textContent = '两次输入的密码不一致'; return; }
  const btn = $('#rgGo');
  btn.disabled = true;
  try {
    const d = await call('POST', '/auth/bootstrap-admin', {
      empNo, name, password: pw,
      storeName: ($('#rgStore').value || '').trim(),
      deviceCode: deviceCode(),
    });
    rememberNo(d.empNo || empNo);
    await loginWith(d.token);
    toast(`管理员 ${d.empNo || empNo} 已创建，欢迎使用`);
  } catch (e) {
    err.textContent = e && e.message ? e.message : String(e);
  } finally {
    btn.disabled = false;
  }
};

// ══ V4.24.0 底部圆入口：本机交接班记录（登录前也能核对；完整报表登录后在「班次」看）══
const LS_SHIFT_LOG = 'pwa_shift_log';
/** 收银台开班 / 交班时调用，本机留痕最近 50 条 */
function logShiftLocal(entry) {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_SHIFT_LOG) || '[]');
    arr.unshift({ ...entry, at: Date.now() });
    localStorage.setItem(LS_SHIFT_LOG, JSON.stringify(arr.slice(0, 50)));
  } catch { /* 隐私模式忽略 */ }
}
window.logShiftLocal = logShiftLocal;
function openLocalShiftLog() {
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem(LS_SHIFT_LOG) || '[]'); } catch { rows = []; }
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet" style="width:min(470px,94vw)">
    <h3>🧾 本机交接班记录<button class="mini-btn" id="lgLogX" style="float:right">关闭</button></h3>
    <div style="max-height:52vh;overflow:auto">
      ${rows.length ? rows.slice(0, 30).map(r => `<div class="kv"><span class="k">#${esc(r.shiftId || '—')} ${esc(r.cashier || '')} · ${esc(r.kind || '')}</span>
        <span class="v" style="font-weight:600">${esc(r.text || '')}<br><span style="font-weight:400;color:var(--ink-3);font-size:12px">${new Date(r.at).toLocaleString('zh-CN')}</span></span></div>`).join('')
        : '<div class="empty">本机暂无交接班记录<br>（开班 / 交班后这里会自动留痕）</div>'}
    </div>
    <div class="hint">仅本机留痕，用于登录前快速核对；完整班次报表请登录后在收银台「班次」中查看。</div></div>`;
  document.body.appendChild(m);
  m.querySelector('#lgLogX').onclick = () => m.remove();
}

// 启动自检（放在最后：等 call/esc/deviceCode 等函数与 DOM 都就绪）
initBootstrap();

// ── V4.13.9 B8a 忘记密码：工号 → 密保问题 → 答对自助重置；未设密保提示找管理员重置 ──
$('#lgForgot') && ($('#lgForgot').onclick = async () => {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet">
    <h3>🔑 忘记密码 · 密保找回</h3>
    <div id="fpStep1">
      <div class="field"><label>员工工号</label><input id="fpNo" type="text" value="${esc($('#lgNo').value || '')}" placeholder="输入你的工号"></div>
      <button class="btn ok" id="fpNext" style="width:100%">获取密保问题</button>
    </div>
    <div id="fpStep2" class="hidden"></div>
    <button class="btn ghost" id="fpClose" style="width:100%;margin-top:10px">关闭</button></div>`;
  document.body.appendChild(m);
  m.querySelector('#fpClose').onclick = () => m.remove();
  m.querySelector('#fpNext').onclick = async () => {
    const empNo = m.querySelector('#fpNo').value.trim();
    if (!empNo) { m.querySelector('#authErr2')?.remove(); m.querySelector('#fpNext').insertAdjacentHTML('beforebegin', '<div class="err" id="authErr2">请输入工号</div>'); return; }
    try {
      const d = await call('GET', '/auth/security-questions/' + encodeURIComponent(empNo));
      const qs = d.questions || [];
      m.querySelector('#fpStep1').classList.add('hidden');
      m.querySelector('#fpStep2').classList.remove('hidden');
      m.querySelector('#fpStep2').innerHTML = `
        <div class="hint" style="margin-bottom:8px">${esc(d.name || '')}（${esc(empNo)}），请回答密保问题：</div>
        ${qs.map(q => `<div class="field"><label>${esc(q.question)}</label><input type="text" data-fp="${q.idx}" placeholder="答案"></div>`).join('')}
        <div class="field"><label>新密码</label><input id="fpPw" type="password" placeholder="新密码"></div>
        <div class="hint" id="fpPol" style="margin:-4px 0 8px">密码规则加载中…</div>
        <button class="btn ok" id="fpGo" style="width:100%">重置密码</button>`;
      pwdPolicy().then(p2 => { const h = m.querySelector('#fpPol'); if (h) h.textContent = `密码规则：${p2.label}`; });
      m.querySelector('#fpGo').onclick = async () => {
        const answers = qs.map(q => m.querySelector(`[data-fp="${q.idx}"]`).value);
        const np = m.querySelector('#fpPw').value;
        if (answers.some(a => !a.trim())) { toast('请回答全部密保问题'); return; }
        const pol2 = await pwdPolicy();
        const pwErr = pwdCheck(np, pol2);
        if (pwErr) { toast(pwErr); return; }
        try {
          await call('POST', '/auth/forgot-password', { empNo, answers, newPassword: np });
          toast('密码已重置，请用新密码登录');
          m.remove();
        } catch (e) { toast(e.message); }
      };
    } catch (e) { toast(e.message); }
  };
});

// ── V4.14.1：密码强度策略（读后台 auth.password_policy 设置，前端同口径校验）──
let PWD_POLICY = null;
async function pwdPolicy() {
  if (PWD_POLICY) return PWD_POLICY;
  PWD_POLICY = { minLen: 6, needLetter: false, needNum: false, needUpper: false, needSymbol: false, label: '至少 6 位' };
  try {
    const s = await call('GET', '/settings/key/' + encodeURIComponent('auth.password_policy'));
    const raw = String(s.value || '').replace(/^"|"$/g, '');
    const map = {
      '6位以上': { minLen: 6, needLetter: false, needNum: false, needUpper: false, needSymbol: false, label: '6 位及以上' },
      '8位字母数字': { minLen: 8, needLetter: true, needNum: true, needUpper: false, needSymbol: false, label: '至少 8 位，须同时包含字母和数字' },
      '8位字母数字符号': { minLen: 8, needLetter: true, needNum: true, needUpper: false, needSymbol: true, label: '至少 8 位，须包含字母、数字和特殊符号' },
      '10位强密码': { minLen: 10, needLetter: true, needNum: true, needUpper: true, needSymbol: false, label: '至少 10 位，须包含大小写字母和数字' },
    };
    if (map[raw]) PWD_POLICY = map[raw];
  } catch { /* 策略读取失败用兜底 */ }
  return PWD_POLICY;
}
function pwdCheck(p, pol) {
  if (!p || p.length < pol.minLen) return `密码至少 ${pol.minLen} 位`;
  if (pol.needLetter && !/[A-Za-z]/.test(p)) return '密码须包含字母';
  if (pol.needNum && !/\d/.test(p)) return '密码须包含数字';
  if (pol.needUpper && !/[A-Z]/.test(p)) return '密码须包含大写字母';
  if (pol.needSymbol && !/[^A-Za-z0-9]/.test(p)) return '密码须包含特殊符号';
  return '';
}

// ── V4.14.1：日期选择框全局增强——点击即弹日期选择器（选择框默认为空，不预填）──
document.addEventListener('click', e => {
  const el = e.target;
  if (el && el.tagName === 'INPUT' && el.type === 'date' && typeof el.showPicker === 'function') {
    try { el.showPicker(); } catch { /* 浏览器要求用户手势内，点击本身就是手势 */ }
  }
});

// ── 我的（View.me）──
const PERM_NAMES = {
  'pos.sell': '收银结账', 'pos.price.manual': '手工改价', 'pos.emergency.manual': '应急手输价',
  'pos.hold': '挂单', 'pos.hang': '挂单/取单', 'pos.refund': '退款', 'pos.refund.apply': '发起退款', 'pos.refund.audit': '退款审核',
  'pos.emergency': '应急收银',
  'stock.inbound.audit': '入库审核', 'stock.return.audit': '退货审核',
  'stock.count.audit': '盘点审核', 'stock.count.task': '盘点任务管理', 'stock.loss.create': '报损登记', 'stock.transfer': '调拨',
  'purchase.po.approve': '采购审批', 'recon.confirm': '对账确认', 'recon.settle.audit': '结算审核', 'settle.pay.close': '关闭付款流程',
  'staff.manage': '员工与权限管理', 'member.manage': '会员管理', 'report.view': '报表查看', 'report.view.all': '全店报表查看',
  'member.register': '会员注册', 'member.balance.recharge': '储值收款', 'member.balance.adjust': '储值人工调整',
  'member.dividend.adjust': '分红人工调整', 'member.info.view': '会员信息查看', 'member.export': '会员数据导出',
  'promo.manage': '促销活动管理', 'marketing.manage': '营销引擎管理', 'coupon.manage': '优惠券管理',
  'shift.manage': '交接班管理', 'sales.refund.audit': '退款审核', 'bigcustomer.manage': '大客户与团购管理',
  'ai.train.launch': '发起AI训练', 'ai.suggestion.decide': '智能建议执行/否决', 'ai.decision': '智能决策中心',
  'sys.settings': '系统设置修改', 'sys.user.manage': '员工与角色管理', 'sys.data.backup': '备份恢复操作',
  'device.manage': '设备管理', 'printer.manage': '打印中心', 'print.template': '打印模板编辑',
};
let PERM_MAP = null;   // V4.13.9 B8：服务端 permission_points 全量中文名缓存
async function permName(code) {
  if (!PERM_MAP) {
    try {
      const rows = unwrap(await call('GET', '/auth/permissions'));
      PERM_MAP = {};
      (rows || []).forEach(r => { PERM_MAP[r.code] = r.name; });
    } catch { PERM_MAP = {}; }
  }
  return PERM_MAP[code] || PERM_NAMES[code] || code;
}
View.me = async function (v) {
  const q = queueList();
  // V4.14.1：密码强度策略（后台 auth.password_policy 设置，前端同口径校验）
  const pol = await pwdPolicy();
  v.innerHTML = `
    <div class="card" style="display:flex;align-items:center;gap:14px;padding:18px">
      <div style="width:56px;height:56px;border-radius:50%;background:var(--pri);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700">${esc((ME.name || '员')[0])}</div>
      <div style="flex:1">
        <div style="font-size:17px;font-weight:700">${esc(ME.name)}</div>
        <div style="font-size:13px;color:var(--ink-3);margin-top:2px">工号 ${esc(ME.empNo)}</div>
      </div>
      <button class="mini-btn" id="mePwd">🔑修改密码</button>
      <button class="mini-btn danger" id="meLogout">退出</button>
    </div>
    <div class="sec">离线状态</div>
    <div class="card">
      <div class="kv"><span class="k">网络</span><span class="v" style="color:${navigator.onLine ? 'var(--ok)' : 'var(--bad)'}">${navigator.onLine ? '在线' : '离线'}</span></div>
      <div class="kv"><span class="k">离线暂存单据</span><span class="v">${q.length} 单</span></div>
      <div class="kv"><span class="k">价格表缓存</span><span class="v" id="mePb"></span></div>
    </div>
    <div class="sec">设备管理</div>
    <div class="card" id="meDev"><span class="pill gray">加载中…</span></div>
    <div class="sec">电子签名（手机手写板）</div>
    <div class="card" id="meSign"><div class="hint" style="margin:0">加载中…</div></div>
    <div class="sec">权限点</div>
    <div class="card" style="display:flex;flex-wrap:wrap;gap:6px" id="mePerms"><span class="pill gray">加载中…</span></div>
    <div class="sec">说明</div>
    <div class="card hint" style="margin-top:0">
      移动收银支持断网离线暂存，恢复联网自动补传；<br>
      访问本页即可在手机浏览器「添加到主屏幕」使用。
    </div>`;
  $('#meLogout').onclick = () => { if (confirm('确认退出登录？')) logout(); };
  // V4.13.9 B8：我的页修改密码
  $('#mePwd').onclick = () => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>🔑 修改密码</h3>
      <div class="field"><label>旧密码</label><input id="pwdOld" type="password" autocomplete="current-password"></div>
      <div class="field"><label>新密码</label><input id="pwdNew" type="password" autocomplete="new-password" placeholder="${esc(pol.label)}"></div>
      <div class="hint" style="margin:-4px 0 8px">密码规则（后台「权限与安全 · 密码强度策略」）：${esc(pol.label)}</div>
      <div class="field"><label>确认新密码</label><input id="pwdNew2" type="password" autocomplete="new-password"></div>
      <button class="btn ok" id="pwdGo" style="width:100%">确认修改</button>
      <button class="btn ghost" id="pwdClose" style="width:100%;margin-top:8px">取消</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#pwdClose').onclick = () => m.remove();
    m.querySelector('#pwdGo').onclick = async () => {
      const o = m.querySelector('#pwdOld').value, n = m.querySelector('#pwdNew').value, n2 = m.querySelector('#pwdNew2').value;
      if (!o || !n) { toast('请填写旧密码与新密码'); return; }
      const err = pwdCheck(n, pol);
      if (err) { toast(err); return; }
      if (n !== n2) { toast('两次输入的新密码不一致'); return; }
      try {
        await call('POST', '/auth/change-password', { oldPassword: o, newPassword: n });
        toast('密码已修改');
        m.remove();
      } catch (e) { toast(e.message); }
    };
  };
  // V4.13.9 B8：权限点显示中文（服务端全量映射优先，本地表兑底）
  (async () => {
    const box = $('#mePerms');
    if (!box) return;
    const pills = await Promise.all(ME.perms.map(c => permName(c)));
    box.innerHTML = ME.perms.length
      ? ME.perms.map((c, i) => `<span class="pill blue">${esc(pills[i])}</span>`).join('')
      : '<span class="pill gray">无业务权限</span>';
  })();
  const pb = $('#mePb');
  try {
    const info = await View.pricebookInfo();
    const fresh = info.ageHours === null ? '未同步' : `${info.ageHours}h 前 · ${info.fresh ? '新鲜' : '过期'}`;
    pb.innerHTML = `${info.version ? 'v' + info.version.slice(0, 6) : '—'} · ${info.count ?? 0} 条 · ${fresh}`;
  } catch { pb.textContent = '不可用'; }

  // ── V4.15.3 设备管理：电子秤 / 钱箱 / 小票机（自收银页迁入，集中连接与测试） ──
  const devBox = $('#meDev');
  if (devBox) {
    // V4.15.8：手机/平板浏览器无 Web Serial——串口类能力（电子秤读重/钱箱直连/小票机串口直驱）仅电脑端提供；
    //          手机端走网口：小票机/钱箱（RJ11 接网口打印机）用网口直发，电子秤重量在购物车手输
    const serialOk = !!navigator.serial;
    const mobileLike = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const pcSerial = serialOk && !mobileLike;   // 串口能力仅电脑 Chrome/Edge
    const scaleConn = typeof Scale !== 'undefined' && Scale.connected();
    const drawerConn = typeof window.PwaReceipt !== 'undefined' && window.PwaReceipt.drawerConnected && window.PwaReceipt.drawerConnected();
    const prnConn = typeof window.PwaPrinters !== 'undefined' && window.PwaPrinters.printerConnected();
    const usbOk = !!navigator.usb;   // V4.18.6 USB 小票机直驱（WebUSB：电脑 Chrome/Edge + 安卓 Chrome）
    const usbConn = usbOk && typeof window.PwaPrinters !== 'undefined' && window.PwaPrinters.usbConnected && window.PwaPrinters.usbConnected();
    // V4.18.7b 系统驱动直发：默认机 USB+绑定打印机名（POS-80 等已装驱动机器，WebUSB 不可见的场景）
    let usbDef = null;
    try {
      const dp = typeof window.PwaPrinters !== 'undefined' ? await window.PwaPrinters.defaultPrinter() : null;
      if (dp && String(dp.conn_type) === 'USB' && String(dp.conn_addr || '').trim()) usbDef = dp;
    } catch { /* noop */ }
    const devRow = (ic, name, stPill, btn) => `<div class="kv" style="align-items:center;gap:10px">
      <span class="k">${ic} ${name}</span>
      <span class="v" style="display:flex;align-items:center;gap:8px">${stPill}${btn ? `<button class="mini-btn" ${btn.id} ${pcSerial || btn.noSerial ? '' : 'disabled'}>${btn.text}</button>` : ''}</span></div>`;
    devBox.innerHTML =
      devRow('⚖', '电子秤',
        pcSerial ? (scaleConn ? '<span class="pill green">已连接</span>' : '<span class="pill gray">未连接</span>') : '<span class="pill gray">手输重量</span>',
        pcSerial ? { id: 'id="devScale"', text: scaleConn ? '断开' : '连接' } : null) +
      devRow('💵', '钱箱',
        pcSerial ? (drawerConn ? '<span class="pill green">已连接</span>' : '<span class="pill gray">未连接</span>') : '<span class="pill gray">网口联动</span>',
        pcSerial ? { id: 'id="devDrawer"', text: drawerConn ? '测试弹箱' : '连接' } : { id: 'id="devDrawerNet"', text: '网口弹箱', noSerial: true }) +
      (pcSerial ? devRow('🧾', '小票机',
        prnConn ? '<span class="pill green">串口直驱</span>' : '<span class="pill gray">未连接</span>',
        { id: 'id="devPrn"', text: prnConn ? '测试打印' : '连接' }) : '') +
      devRow('📄', '网口小票机', '<span class="pill gray">后台配置</span>',
        { id: 'id="devNetPrn"', text: '测试打印', noSerial: true }) +
      (usbOk ? devRow('🔌', 'USB 小票机',
        (usbDef ? '<span class="pill green">系统驱动：' + usbDef.conn_addr + '</span>'
          : usbConn ? '<span class="pill green">USB直驱</span>' : '<span class="pill gray">未绑定</span>'),
        { id: 'id="devPrnUsb"', text: usbDef ? '测试打印' : '绑定本机打印机', noSerial: true }) : '');
    if (!pcSerial) devBox.insertAdjacentHTML('beforeend', mobileLike
      ? '<div class="hint" style="margin:6px 0 0">手机端不支持串口（Web Serial）：小票机/钱箱请用网口设备，在后台「打印中心」配置 IP:9100 后即可在此测试；钱箱 RJ11 接在网口小票机上即可「网口弹箱」；电子秤重量请在购物车手输。</div>'
      : '<div class="hint" style="margin:6px 0 0">此浏览器不支持串口（Web Serial）：请用电脑 Chrome/Edge 连接串口设备，或使用网口设备。</div>');
    if (pcSerial) $('#devScale').onclick = async () => {
      if (typeof Scale === 'undefined') { toast('读重组件未加载'); return; }
      if (Scale.connected()) { Scale.disconnect(); toast('电子秤已断开'); View.me(v); return; }
      try {
        const d = await Scale.connect();
        toast(`电子秤已连接（${d.baud}bps）：称重商品在收银车点 ⚖ 自动读重`);
        View.me(v);
      } catch (e) { toast('电子秤连接失败：' + (e.message || e)); }
    };
    const kickNet = async () => {
      if (typeof window.PwaPrinters === 'undefined') { toast('打印组件未加载'); return; }
      try {
        const r = await window.PwaPrinters.kickDrawer();
        toast(`已发弹箱指令（${r.printer} · 网口）：请确认钱箱弹开`, true);
      } catch (e) { toast('网口弹箱失败：' + (e.message || e)); }
    };
    if (pcSerial) $('#devDrawer').onclick = async () => {
      if (typeof window.PwaReceipt === 'undefined') { toast('钱箱组件未加载'); return; }
      if (window.PwaReceipt.drawerConnected()) {
        try { await window.PwaReceipt.testDrawer(); toast('已发送弹箱指令：请确认钱箱弹开'); }
        catch (e) { toast('弹箱失败：' + (e.message || e)); }
        return;
      }
      try {
        await window.PwaReceipt.connectDrawer();
        toast('钱箱已连接：现金收款结账后自动弹箱');
        View.me(v);
      } catch (e) { toast('钱箱连接失败：' + (e.message || e)); }
    };
    if ($('#devDrawerNet')) $('#devDrawerNet').onclick = kickNet;
    if ($('#devPrn')) $('#devPrn').onclick = async () => {
      if (typeof window.PwaPrinters === 'undefined') { toast('打印组件未加载'); return; }
      if (window.PwaPrinters.printerConnected()) {
        try {
          const r = await window.PwaPrinters.testDirect();
          toast(`测试小票已直驱打印（${r.printer} · 串口）`, true);
        } catch (e) { toast('打印失败：' + (e.message || e)); }
        return;
      }
      try {
        await window.PwaPrinters.connectPrinter();
        toast('小票机已连接（串口直驱）：结账自动出票，免系统驱动');
        View.me(v);
      } catch (e) { toast('小票机连接失败：' + (e.message || e)); }
    };
    if ($('#devPrnUsb')) $('#devPrnUsb').onclick = async () => {
      if (typeof window.PwaPrinters === 'undefined') { toast('打印组件未加载'); return; }
      // 已绑定系统打印机：直接测试（后端 winspool RAW 直发）
      if (usbDef) {
        try {
          const r = await window.PwaPrinters.testDirect();
          toast(`测试小票已直发「${usbDef.conn_addr}」（系统驱动）`, true);
        } catch (e) { toast('打印失败：' + (e.message || e)); }
        return;
      }
      if (window.PwaPrinters.usbConnected && window.PwaPrinters.usbConnected()) {
        try {
          const r = await window.PwaPrinters.testDirect();
          toast(`测试小票已直驱打印（${r.printer} · USB）`, true);
        } catch (e) { toast('打印失败：' + (e.message || e)); }
        return;
      }
      // 绑定流程：列本机 Windows 打印机 → 选择 → 建 USB 打印机记录并设默认
      try {
        const list = await call('GET', '/printers/os-list');
        const items = (list && list.items) || [];
        if (!items.length) { toast('未枚举到本机打印机：请确认小票机驱动已安装'); return; }
        const m = document.createElement('div');
        m.className = 'modal';
        m.innerHTML = `<div class="sheet"><h3>🔌 绑定 USB 小票机（系统驱动）</h3>
          <div class="hint">已装 Windows 驱动的 USB 小票机（如 POS-80）会出现在下面，选它即可——收银出票经驱动直发，无需其他配置。</div>
          <div style="max-height:40vh;overflow:auto;margin:8px 0">${items.map((p, i) =>
            `<label style="display:flex;gap:8px;align-items:center;padding:8px 4px;border-bottom:1px solid rgba(0,0,0,.06)">
              <input type="radio" name="osprn" value="${i}" ${i === 0 ? 'checked' : ''}>
              <span>${p.online ? '🟢' : '⚪'} ${p.name}${p.port ? ` <span style="color:var(--mut)">（${p.port}）</span>` : ''}</span></label>`).join('')}</div>
          <div style="display:flex;gap:8px"><button class="btn ok" id="osBind" style="flex:1">绑定并设为默认</button>
          <button class="mini-btn" id="osCancel">取消</button></div></div>`;
        document.body.appendChild(m);
        m.querySelector('#osCancel').onclick = () => m.remove();
        m.querySelector('#osBind').onclick = async () => {
          const pick = items[Number(m.querySelector('input[name=osprn]:checked').value)];
          try {
            // 复用已有 USB+同名绑定记录，否则新建
            const all = await call('GET', '/printers');
            const exist = (Array.isArray(all) ? all : []).find(p => String(p.conn_type) === 'USB' && String(p.conn_addr || '').trim() === pick.name);
            const pid = exist ? exist.id
              : (await call('POST', '/printers', { name: pick.name, connType: 'USB', connAddr: pick.name, widthMm: 80, printerType: '小票' })).id;
            await call('PUT', `/printers/${pid}/default`, {});
            toast(`已绑定「${pick.name}」并设为默认小票机`, true);
            m.remove();
            View.me(v);
          } catch (e) { toast('绑定失败：' + (e.message || e)); }
        };
      } catch (e) { toast('枚举打印机失败：' + (e.message || e)); }
    };
    $('#devNetPrn').onclick = async () => {
      if (typeof window.PwaPrinters === 'undefined') { toast('打印组件未加载'); return; }
      try {
        const r = await window.PwaPrinters.testDirect();
        toast(`测试小票已网口直发（${r.printer}）`, true);
      } catch (e) {
        toast('网口直发失败：' + (e.message || e) + '。网口小票机在后台「打印中心」配置 IP:9100 并设为默认');
      }
    };
  }

  // ── V4.15.3 电子签名：电脑端「📱 手机采集」发起的待签字请求，手机屏幕手写回传 ──
  async function loadSignReq() {
    const box = $('#meSign');
    if (!box) return;
    try {
      const d = await call('GET', '/sign-remote/pending');
      const list = (d && d.items) || [];
      if (!list.length) {
        box.innerHTML = '<div class="hint" style="margin:0">暂无待签字请求。电脑端点「📱 手机采集」后，请求会自动出现在这里——手机屏幕即可当手写板用。</div>';
        return;
      }
      box.innerHTML = list.map(s => `
        <div class="row" style="margin:0 0 8px">
          <div class="grow">
            <div class="t">${esc(s.title)} <span class="pill orange">取件码 ${esc(s.req_no)}</span></div>
            <div class="s">${esc(s.biz_ref || '')}${s.person_hint ? ' · 应签人：' + esc(s.person_hint) : ''} · ${dt(s.created_at)}</div>
          </div>
          <button class="mini-btn ok" data-rs="${s.id}" style="color:#fff;background:var(--ok)">✍️去签字</button>
        </div>`).join('');
      box.querySelectorAll('[data-rs]').forEach(b => b.onclick = () => {
        const hit = list.find(x => Number(x.id) === Number(b.dataset.rs));
        if (!hit) return;
        if (typeof SignPad === 'undefined') { toast('签名组件未加载'); return; }
        const isCollect = String(hit.biz_ref || '').startsWith('预采集');   // V4.16.5：预采集=连采3遍样本
        const getDetail = () => call('GET', '/sign-remote?id=' + hit.id);
        if (isCollect && SignPad.openCollect) {
          SignPad.openCollect({
            reqId: hit.id, reqNo: hit.req_no, title: hit.title,
            personHint: hit.person_hint || ME.name || '', bizRef: hit.biz_ref || '', samples: 3,
            getDetail,
            onSubmit: sd => call('POST', `/sign-remote/${hit.id}/submit`, { personName: sd.personName, images: sd.images }),
          });
        } else {
          SignPad.open({
            title: hit.title,
            hint: `取件码 ${hit.req_no}${hit.biz_ref ? ' · ' + hit.biz_ref : ''}：请本人填写姓名并在下方手写签名，提交后自动回传电脑端`,
            defaultName: hit.person_hint || ME.name || '',
            roleTitle: '签字人',
            onSave: sd => {
              call('POST', `/sign-remote/${hit.id}/submit`, { personName: sd.personName, image: sd.image })
                .then(() => { toast('✅ 签名已提交，等待后台预览签收'); loadSignReq(); })
                .catch(e => toast(e.message));
            },
          });
        }
      });
    } catch (e) {
      box.innerHTML = `<div class="hint" style="margin:0">签名请求加载失败：${esc(e.message || '')}（30 分钟内有效，过期自动清除）</div>`;
    }
  }
  await loadSignReq();
  if (window.__meSignTimer) clearInterval(window.__meSignTimer);
  window.__meSignTimer = setInterval(() => {
    if (document.querySelector('#meSign')) loadSignReq();
    else clearInterval(window.__meSignTimer);
  }, 15000);
};

// ── 启动 ──
(async function boot() {
  // 注册 Service Worker（需 localhost 或 https；局域网 http 下自动降级为在线模式）
  // ?nosw=1 调试旁路：跳过 SW 注册（自动化测试/排障用，正常使用不受影响）
  try {
    if ('serviceWorker' in navigator && !location.search.includes('nosw=1')) {
      await navigator.serviceWorker.register('./sw.js');
    }
  } catch { /* 非安全上下文，忽略 */ }
  // 扫码登录：链接带 #qr=<ticket>（后台设置页生成）→ 一次性换 token 免密登录
  const mQr = location.hash.match(/qr=([0-9a-f]+)/i);
  if (mQr) {
    history.replaceState(null, '', location.pathname);   // 立刻清掉票据，防截图/转发泄露
    try {
      const d = await call('POST', '/auth/qr-login', { ticket: mQr[1], deviceCode: deviceCode() });
      TOKEN = d.token;
      localStorage.setItem(LS.token, TOKEN);
    } catch (e) {
      const el = $('#authErr'); if (el) el.textContent = '扫码登录失败：' + e.message;
    }
  }
  if (TOKEN) {
    try { await loadMe(); showMain(); }
    catch { logout(); }
  }
  flushQueue();
})();
