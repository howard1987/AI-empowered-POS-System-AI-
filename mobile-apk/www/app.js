'use strict';
/* 员工移动端 PWA · 核心（app.js）：登录 / 路由 / 底部 Tab / 我的 / 离线队列
 * 对端：后端同源 API（/auth /purchase /inventory /sales /pos /members /upload） */
const LS = { token: 'pwa_token', api: 'pwa_api_base', queue: 'pwa_queue', srvHist: 'pwa_api_hist' };
/* V5.0.9 服务器地址（登录页可配）
 * 关键修复①——此前 API_BASE 是「模块加载时求值一次的 const」，导致在登录页写入新地址后
 * 所有请求仍打到旧地址（配置形同虚设）。现改为每次调用时动态读取，
 * 使「登录时配置服务器地址」真正生效（APK 内置资源时 origin≠服务器，必须依赖此项）。
 * 归一化：去空白、去尾部斜杠；空串=同源（浏览器直接访问后端时）。
 *
 * 关键修复②（TDZ 崩溃）——SRV_DEFAULT 原声明在登录页初始化 IIFE 之后，而该 IIFE 会调用
 * initServerAddr()→srvValue() 读取它；const 不会像函数声明那样提升，未捕获的
 * ReferenceError 会终止整个脚本，导致登录按钮等全部监听器都没绑定（页面看着正常、
 * 点任何按钮都无反应）。故必须声明在本 IIFE 之前。
 *
 * 默认值说明：原默认 mDNS 域名 pos-server.local 实测在 Windows/本网络下无法解析
 *（Resolve-DnsName 与 ping 均失败），已弃用。改为「空 = 同源」：
 *   · 浏览器直接访问 https://<服务器IP>:3443/pwa/ → 空值即同源，零配置可用；
 *   · APK（origin=https://localhost）→ 需首次填写一次，之后持久化，不必再改。 */
const SRV_DEFAULT = '';
function currentApiBase() {
  let v = '';
  try { v = String(localStorage.getItem(LS.api) || '').trim(); } catch { v = ''; }
  return v.replace(/\/+$/, '');
}
let TOKEN = localStorage.getItem(LS.token) || '';
let ME = null;                                          // {staffId, empNo, name, perms, storeId}
const View = {};                                        // 各模块视图注册表（work/checkout/docs/me 挂载于此）

// ── 工具 ──
const $ = s => document.querySelector(s);

/* V5.0.11f 视口高度同步（真机 OPPO A1x 5G / Android 13 实测）
 * 问题：该机 WebView 不支持 CSS `dvh`（CSS.supports('height','100dvh') === false），
 *   导致 `#app{height:100dvh}` 整条失效 → 高度退回 auto → 撑到内容高 1413px →
 *   页面整体滚动 → #tabbar（作业/单据/消息/我的）被顶到 1356px、超出 895px 视口而"消失"，
 *   商品列表也穿过 fixed 结算条继续显示。
 * 措施：CSS 已加 `height:100vh` 回退；这里再用 JS 把真实视口高写进 `--app-h`，
 *   兼顾地址栏收放 / WebView 高度变化（CSS 的 @supports not 分支会消费这个变量）。
 * 必须放在模块顶层早期执行，且在 resize / visualViewport 变化时更新。 */
(function syncViewportHeight() {
  const setH = () => {
    const h = (window.visualViewport && Math.round(window.visualViewport.height))
      || window.innerHeight || document.documentElement.clientHeight;
    if (h > 0) {
      document.documentElement.style.setProperty('--app-h', h + 'px');
      /* V5.0.11j：--vhs = 真实视口高（px）。
       * 该机 WebView 不支持 CSS `dvh`，原先散落各处的 max-height:NNdvh / 88dvh 全部失效，
       * 直接后果就是**扫码取景框 video 没有任何高度限制** → 启动扫码后画面撑满全屏、
       * 关闭按钮被顶出可视区（真机反馈）。现统一改为 calc(var(--vhs,100vh)*0.46) 这类写法，
       * 由这里的真实视口高驱动，dvh 支持与否都正确。 */
      document.documentElement.style.setProperty('--vhs', h + 'px');
    }
    // 结算条 fixed 在 Tab 栏之上，bottom 需跟随 Tab 栏实测高度（否则露缝）
    const tb = document.getElementById('tabbar');
    if (tb) {
      const t = Math.round(tb.getBoundingClientRect().height);
      if (t > 0) document.documentElement.style.setProperty('--tabbar-h', t + 'px');
    }
  };
  setH();
  window.addEventListener('resize', setH);
  window.addEventListener('orientationchange', () => setTimeout(setH, 120));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', setH);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setH);
  // Tab 栏是登录后才有的，且单据/作业切页会重排 —— 用 ResizeObserver 持续跟随
  try {
    const ob = new ResizeObserver(setH);
    document.addEventListener('DOMContentLoaded', () => {
      const tb = document.getElementById('tabbar');
      if (tb) ob.observe(tb);
    });
  } catch { /* 老 WebView 无 ResizeObserver，resize 兜底即可 */ }
})();
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
  const res = await fetch(currentApiBase() + path, {
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
    // V5.0.11：把业务码挂到错误对象上，前端才能按码分支处理
    // （如 40307 设备未授权 → 弹设备码 + 恢复码对话框）。此前只抛 message，只能靠正则猜。
    const e = new Error(r.msg || ('请求失败 #' + r.code));
    e.bizCode = Number(r.code) || 0;
    throw e;
  }
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
  /* V5.0.11k：清掉上一页留在 #view 上的内联样式。
   * 真机 bug：移动收银（View.checkout）会给共享的 #view 设 overflow:hidden / display:flex，
   * 而 renderStack 只重绘 innerHTML 不清容器自身样式 → 之后打开的每个页面（如经营活动）
   * 都继承 overflow:hidden，内容再长也滚不动（真机 PHJ110 实测 computed overflowY=hidden）。 */
  v.style.cssText = '';
  v.scrollTop = 0;
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
  const changed = tabId !== CURRENT_TAB;
  CURRENT_TAB = tabId;
  CURRENT_ARG = arg || null;
  document.querySelectorAll('#tabbar .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tabId));
  stack.length = 0;
  renderStack();
  // V5.0.11i：切 Tab 也压一条 history，浏览器端可在「上一个标签」间回退
  // V5.0.12g：原生壳由 @capacitor/app 插件接管返回键，不再使用 history 哨兵（哨兵栈永远耗不尽=退不出）
  if (changed && !isNativeApp()) { try { history.pushState({ pwaTab: tabId }, ''); } catch { /* 非安全上下文忽略 */ } }
}
/** 子页面入栈：浏览器端同步压一条 history；原生壳由返回键插件直接出栈 */
function push(title, fn, args) {
  stack.push({ title, fn, args });
  if (!isNativeApp()) { try { history.pushState({ pwaDepth: stack.length }, ''); } catch { /* 非安全上下文忽略 */ } }
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
  // V5.0.12g：原生壳走返回键插件同款逻辑；浏览器端有 history 记录则走浏览器返回
  if (isNativeApp() && window.Capacitor?.Plugins?.App) { backAction(); return; }
  if (history.state && history.state.pwaDepth) history.back();
  else popView();
};

/* ═══ V5.0.11i Android 物理返回键 ═══
 * 现象（真机反馈）：按返回键直接退出应用回桌面，而不是回到上一页/上一个标签。
 * 原因：Capacitor 的 Activity 在 WebView **无历史可退**时直接 finish()，
 *   而我们只在 push()（子页）和切 Tab 时压 history，根标签页没有压哨兵条目，
 *   于是一按就退出。
 * 方案（不依赖 @capacitor/app 插件，纯 history 即可）：
 *   ① 根页面常驻一条「哨兵」history 条目，保证 WebView 永远有历史可退 → 不会直接退出；
 *   ② 返回键优先级：关弹窗 → 子页出栈 → 非首个标签回「作业」→ 根页双击才退出（与系统习惯一致）。
 *   ③ 不用 pushState 伪造 Tab 栈（切标签已各自压条目），避免与 popstate 双重出栈。 */
const FIRST_TAB = 'work';
let exitArmedAt = 0;          // 双击退出的时间戳
function armBackSentinel() {
  // V5.0.12g：原生壳由 @capacitor/app 接管返回键，不再需要 history 哨兵（浏览器端保留）
  if (isNativeApp()) return;
  try {
    history.pushState({ pwaSentinel: 1 }, '');
    exitArmedAt = 0;
  } catch { /* 忽略 */ }
}
/** 关闭最上层自定义弹窗（.modal / .modal-mask）。返回 true 表示已消费本次返回键 */
function closeTopModal() {
  const masks = [...document.querySelectorAll('.modal-mask')].filter(m => m.offsetHeight > 0);
  const modals = [...document.querySelectorAll('body > .modal')].filter(m => m.offsetHeight > 0);
  // 优先关最上层的（后插入的在数组末尾）
  const top = masks[masks.length - 1] || modals[modals.length - 1];
  if (!top) return false;
  // 有「取消/关闭」按钮就直接点它，保持各弹窗自己的收尾逻辑（如恢复滚动）
  const btn = top.querySelector('#amX, #ppClose, [data-close], .doc-foot .btn');
  if (btn) { btn.click(); return true; }
  top.remove();
  return true;
}
/* V5.0.13b：从老板看板进收银台（boss 端跳转前打 sessionStorage.pwa_from_boss）。
 * 根页/任何深度的返回 → 跳回老板看板（从哪来回哪去，单次返回闭环），而不是退出应用；
 * 标记用后即清，正常登录（非看板进入）的返回行为完全不受影响。 */
function backToBossIfFromBoss() {
  let from = false;
  try { from = sessionStorage.getItem('pwa_from_boss') === '1'; } catch { }
  if (!from) return false;
  try { sessionStorage.removeItem('pwa_from_boss'); } catch { }
  location.href = BOSS_APP_URL;
  return true;
}
/* V5.0.12g 返回键统一动作（浏览器 popstate 与原生 backButton 共用）：
 * 优先级：关弹窗 → 看板来的回看板 → 子页出栈 → 非首个标签回「作业」→ 根页 2 秒内再按退出。
 * 退出动作：原生壳直接 App.exitApp()（旧哨兵方案历史栈只增不减，真机永远退不出）。 */
function backAction() {
  if (closeTopModal()) return;
  if (backToBossIfFromBoss()) return;   // V5.0.13b：看板进入的会话，返回键=回看板（压栈的收银台页一并离开）
  if (stack.length) { popView(); return; }
  if (CURRENT_TAB !== FIRST_TAB) { openTab(FIRST_TAB); return; }
  const now = Date.now();
  if (now - exitArmedAt < 2000) {
    exitArmedAt = 0;
    try { window.Capacitor.Plugins.App.exitApp(); } catch { /* 浏览器无此插件，忽略 */ }
    return;
  }
  exitArmedAt = now;
  toast('再按一次返回键退出应用');
}
if (isNativeApp() && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  // 原生壳：@capacitor/app 插件接管物理返回键（插件无监听时才走系统默认）
  window.Capacitor.Plugins.App.addListener('backButton', () => backAction());
} else {
  // 浏览器端：history 哨兵方案（保证 SPA 不会一按返回就离开站点）
  window.addEventListener('popstate', () => {
    if (closeTopModal()) { armBackSentinel(); return; }
    if (stack.length) { popView(); armBackSentinel(); return; }
    if (CURRENT_TAB !== FIRST_TAB) { openTab(FIRST_TAB); armBackSentinel(); return; }
    if (backToBossIfFromBoss()) return;   // V5.0.13b：浏览器端同样回看板（popstate 已消耗一条历史，导航覆盖之）
    const now = Date.now();
    if (now - exitArmedAt < 2000) return;      // 第二次按：浏览器端无法退出应用，仅停止回退
    exitArmedAt = now;
    try { history.pushState({ pwaSentinel: 1 }, ''); } catch { /* 忽略 */ }
    toast('再按一次返回键退出应用');
  });
}
document.querySelectorAll('#tabbar .tab').forEach(b => b.onclick = () => openTab(b.dataset.tab));

// V5.0.5：PWA 手机端底部 Tab 支持左右滑动换页（桌面端不启用；避免误触输入框/按钮/横向滚动容器）
if (!IS_DESKTOP) {
  const TABS = ['work', 'docs', 'msg', 'me'];
  const view = $('#view');
  let sx = 0, sy = 0, tracking = false;
  view.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { tracking = false; return; }
    if (e.target.closest && e.target.closest('input,textarea,select,button,a,[contenteditable],[data-noswipe]')) { tracking = false; return; }
    tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  view.addEventListener('touchend', e => {
    if (!tracking) return; tracking = false;
    const t = e.changedTouches[0]; if (!t) return;
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;  // 仅明显水平滑动才换页
    const i = TABS.indexOf(CURRENT_TAB);
    if (i < 0) return;
    const ni = dx < 0 ? i + 1 : i - 1;   // 左滑=下一页，右滑=上一页
    if (ni >= 0 && ni < TABS.length) openTab(TABS[ni]);
  }, { passive: true });
}

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
/* ══════════════ V5.0.11 设备身份（P0 设备码 + P1 硬件签名）══════════════
 *
 * 为什么不能只用 deviceCode：它由客户端自报并存本地，改一下就能伪造，
 * 「知道账密 + 随便一个设备码」即可登录。所以再加一层不可伪造的证明：
 * 客户端持有一对**不可导出**的私钥（WebCrypto extractable:false / APK 走 Android Keystore），
 * 每次登录用它对「工号|设备码|时间戳|随机串」签名，服务端用登记的公钥验签。
 * 设备码被抄到另一台电脑/手机也签不出有效签名 → 登不进去。
 *
 * 密钥持久化：WebCrypto 私钥不可导出，故只能存 IndexedDB（非结构化克隆可存 CryptoKey）。
 * 存不下时降级为「只有设备码」（P1 不生效但 P0 仍有效），并标记 hasSig=false。
 */
const DEV_KEY_STORE = 'pos_device_key';
let _devKeyCache;      // undefined=未取 | null=不可用 | {pubKeyB64, sign(payload)}

/** base64 ← ArrayBuffer */
function b64FromBuf(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function bufFromB64(b64) {
  const s = atob(String(b64 || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 打开（或创建）设备密钥库 */
function openDevKeyDb() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
    const rq = indexedDB.open(DEV_KEY_STORE, 1);
    rq.onupgradeneeded = () => { try { rq.result.createObjectStore('kv'); } catch { } };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error || new Error('idb open failed'));
  });
}
async function idbGet(key) {
  const db = await openDevKeyDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => rej(tx.error);
  });
}
async function idbSet(key, val) {
  const db = await openDevKeyDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    tx.onsuccess = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

/** 取设备密钥。APK 内优先用 Android Keystore（硬件内不可导出，防伪造最强）；
 *  浏览器用 WebCrypto non-extractable。两者签名格式一致（RSA-SHA256 / PKCS#1 v1.5），服务端一套验签通吃。 */
async function deviceKey() {
  if (_devKeyCache !== undefined) return _devKeyCache;
  // ① APK：走原生 Keystore
  try {
    const cap = window.Capacitor;
    const ns = cap && cap.Plugins && cap.Plugins.NativeScanner;
    if (ns && typeof ns.deviceIdentity === 'function' && typeof ns.deviceSign === 'function') {
      const id = await ns.deviceIdentity();
      if (id && id.pubkey) {
        _devKeyCache = {
          pubKeyB64: String(id.pubkey),
          sign: async (payload) => {
            const r = await ns.deviceSign({ text: payload });
            return String(r && r.sig || '');
          },
        };
        return _devKeyCache;
      }
    }
  } catch (e) { /* Keystore 不可用 → 降级 WebCrypto */ }
  // ② 浏览器：WebCrypto
  try {
    if (!window.crypto || !crypto.subtle) { _devKeyCache = null; return null; }
    /* V5.0.14f：维持原始 CryptoKey 持久化方案（真机实测该密钥跨冷启动稳定——
     * today 的「公钥漂移」实为 JWK 实验引入的新钥匙，非旧方案缺陷）。
     * 防漂移保障：配对成功时服务端自动换绑公钥（auth.module pair 分支）。 */
    let pair = await idbGet('pair');
    if (!pair || !pair.privateKey) {
      pair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        false, ['sign', 'verify']);
      await idbSet('pair', pair);
    }
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    _devKeyCache = {
      pubKeyB64: b64FromBuf(spki),
      sign: async (payload) => b64FromBuf(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(payload))),
    };
  } catch (e) {
    // IndexedDB 不可用（隐私模式/老 WebView）→ 降级：P1 关闭，P0 设备码仍生效
    _devKeyCache = null;
  }
  return _devKeyCache;
}

/** 设备类型：APK 走原生身份（Keystore），浏览器按 UA 判定 */
function deviceType() {
  try {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      const p = cap.Plugins && cap.Plugins.NativeScanner;
      return p ? 'mobile' : 'pad';
    }
  } catch { }
  const ua = navigator.userAgent || '';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'pad';
  if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
  return 'pc';
}

/** V5.0.11e 设备显示名：优先取 Android 系统里用户设置的设备名（如 vivo X100）。
 *  浏览器拿不到（隐私保护 API），返回 '' 让后端退到 UA 机型识别。 */
async function deviceName() {
  try {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      const p = cap.Plugins && cap.Plugins.NativeScanner;
      if (p && typeof p.deviceName === 'function') {
        const r = await p.deviceName();
        const n = String((r && r.name) || '').trim();
        if (n) return n;
      }
    }
  } catch { /* 原生不可用就退回 UA 识别 */ }
  return '';
}

/** 设备码前缀标明来源，便于管理员在后台一眼分辨（PC-/MB-/PAD-）
 *  V5.0.14b 持久化升级：**权威源 = IndexedDB**（与设备私钥同库，最抗 WebView 存储回收/清理），
 *  localStorage 只作迁移兜底。旧版只存 localStorage —— 被清空后会随机生成**新设备码**，
 *  服务端视为未登记设备 → 每次登录都要重新配对（真机投诉「授权状态不被记住」的根因）。 */
async function deviceCode() {
  const t = deviceType();
  let c = '';
  try { c = String((await idbGet('device_code')) || '').trim(); } catch { c = ''; }
  if (!c) {
    // 迁移：老版本只存 localStorage，读到就升级进 IndexedDB
    try { c = String(localStorage.getItem('pwa_device_code') || localStorage.getItem('boss_device_code') || '').trim(); } catch { c = ''; }
  }
  if (!c) {
    const pfx = t === 'pc' ? 'PC' : t === 'pad' ? 'PAD' : 'MB';
    const b = new Uint8Array(4); (crypto || {}).getRandomValues && crypto.getRandomValues(b);
    c = pfx + '-' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  try { localStorage.setItem('pwa_device_code', c); } catch { }
  try { localStorage.setItem('boss_device_code', c); } catch { }
  try { await idbSet('device_code', c); } catch { }
  return c;
}

/** 随机串（防重放） */
function devNonce() {
  const b = new Uint8Array(12); (crypto || {}).getRandomValues && crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

/** 组装登录用的设备凭据（含 P1 签名）。
 *  payload 的拼接顺序必须与服务端 deviceSignPayload() 完全一致，改任一侧都会导致验签失败。 */
async function deviceCred(empNo, recovery, pair) {
  const code = await deviceCode();
  const dev = { code, type: deviceType() };
  if (recovery) dev.recovery = String(recovery).trim();
  // V5.0.11b 配对码：只在设备「待授权」且用户输入了配对码时才带上
  if (pair) dev.pair = String(pair).trim().toUpperCase();
  // V5.0.11e 设备显示名：APK 能拿到 Android 设备名（vivo X100），浏览器拿不到则留空由后端按 UA 识别
  try { const dn = await deviceName(); if (dn) dev.name = dn; } catch { /* noop */ }
  const key = await deviceKey();
  if (key) {
    try {
      const ts = Date.now();
      const nonce = devNonce();
      const payload = `${empNo}|${code}|${ts}|${nonce}`;
      dev.pubkey = key.pubKeyB64;
      dev.ts = ts;
      dev.nonce = nonce;
      dev.sig = await key.sign(payload);
    } catch { /* 签名失败则只带公钥，服务端会走 TOFU 登记 */ }
  }
  return dev;
}
async function login(empNo, password, recovery, pair) {
  commitServerAddr();   // V5.0.9：确保任何登录路径（密码/PIN/建管理员）都先按当前地址发起请求
  const d = await call('POST', '/auth/login', { empNo, password, device: await deviceCred(empNo, recovery, pair) });
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
  ME = { staffId: d.staffId, empNo: d.empNo, name: d.name, storeId: d.storeId, perms: d.perms || [], roles: d.roles || [] };
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
      navigator.sendBeacon(currentApiBase() + '/display/push', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch(currentApiBase() + '/display/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
    }
  } catch { }
}
// 关闭/刷新页面时同样清空副屏（直接点 ✕ 退出浏览器不走 logout 路径）
window.addEventListener('beforeunload', clearCustomerDisplay);
/* ══ V5.0.11 角色分流：老板端 / 员工移动端 ══
 *
 * 项目里早就有独立的「老板端」应用：backend/public/boss/（老板看板：概览/审批/报表/消息/设置），
 * 后台首页「👔 老板端登录」二维码就是指向 /boss/index.html 的。本次需求不是新建一个页面，
 * 而是让 APK 里的老板登录后能正确进入那个已有的老板端，并加上「进入收银通道」的快捷入口。
 *
 * 分流依据：角色名。判定规则与老板端 boss/app.js 的 isManager() 保持一致（超级管理员/店长/老板），
 * 两处必须同步修改，否则会出现「PWA 认为是老板、老板端认为不是」的不一致。
 * 兜底：perms 含 '*'（超级管理员通配）时也判为老板，用于后端未升级、roles 为空的场景。 */
const BOSS_ROLES = ['超级管理员', '店长', '老板'];
function isBoss() {
  if (!ME) return false;
  const rs = Array.isArray(ME.roles) ? ME.roles : [];
  if (rs.some(r => BOSS_ROLES.includes(String(r)))) return true;
  return Array.isArray(ME.perms) && ME.perms.includes('*');
}

/** 老板端应用地址（同源；APK 内为 https://localhost/boss/，浏览器为 https://<服务器>/boss/）
 *  V5.0.11k 修复：不能写死相对路径 'boss/index.html' —— 浏览器端 PWA 挂在 /pwa/ 下，
 *  相对解析成 /pwa/boss/index.html 而 Nest 的老板端挂在 /boss/ → 40400 Cannot GET。
 *  与老板端 resolvePwaUrl() 同思路按部署形态解析（APK 资源在根目录，浏览器在 /pwa/）。 */
const BOSS_APP_URL = /\/pwa\//.test(location.pathname) ? '../boss/index.html' : 'boss/index.html';
/** 员工移动端地址（当前页） */
const PWA_APP_URL = 'index.html';

/** 把 PWA 的登录态与设备码同步给老板端，使其免登录直接进入 */
function syncAuthToBossApp() {
  try {
    if (TOKEN) localStorage.setItem('boss_token', TOKEN);
    const dc = localStorage.getItem('pwa_device_code');
    // 设备码必须一起同步：老板端首次登录会做设备授权校验，用新码可能被判为「未授权设备」
    if (dc) localStorage.setItem('boss_device_code', dc);
  } catch { /* 隐私模式忽略 */ }
}
/** 把老板端的登录态同步回员工端（老板从看板点「进入收银台」时用） */
function syncAuthFromBossApp() {
  try {
    const t = localStorage.getItem('boss_token');
    if (t) localStorage.setItem('pwa_token', t);
    const dc = localStorage.getItem('boss_device_code');
    if (dc) localStorage.setItem('pwa_device_code', dc);
  } catch { /* 隐私模式忽略 */ }
}
function gotoBossApp() {
  syncAuthToBossApp();
  try { localStorage.setItem('pwa_post_login', 'boss'); } catch { }
  location.replace(BOSS_APP_URL);
}
function gotoPwaApp(goCheckout) {
  syncAuthFromBossApp();
  try { localStorage.setItem('pwa_post_login', goCheckout ? 'checkout' : 'work'); } catch { }
  location.replace(PWA_APP_URL);
}
/** 进入收银通道：手机端用移动收银，电脑/桌面壳用全屏收银台 */
function enterCheckout() {
  const isPhone = !IS_DESKTOP && window.matchMedia('(max-width:768px)').matches;
  if (isPhone && View.checkout) {
    push('移动收银', View.checkout);
  } else if (window.CashierShell) {
    window.CashierShell.maybeEnter();
  } else if (View.checkout) {
    push('移动收银', View.checkout);
  }
}

function showMain() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // 老板从老板端点「进入收银台」回来时带的落点标记（一次性消费）
  let post = '';
  try { post = localStorage.getItem('pwa_post_login') || ''; localStorage.removeItem('pwa_post_login'); } catch { }
  // V5.0.11：老板 → 跳到已有的老板端应用（老板看板）；员工 → 留在员工移动端
  if (isBoss() && post !== 'checkout') { gotoBossApp(); return; }
  setShellMode('cashier');   // V4.22.3：EXE 壳进全屏收银台（盖任务栏，但不置顶 → Alt+Tab 可切其他程序）
  openTab('work');
  // V5.0.6：手机端（小屏）登录后直落 checkout.js 移动收银；电脑/平板/桌面壳进入 cashier.js 全屏收银台
  const isPhone = !IS_DESKTOP && window.matchMedia('(max-width:768px)').matches;
  // V5.0.11i：进入主界面时补一条返回哨兵，保证 Android 返回键永远有历史可退（否则一按就退出应用）
  armBackSentinel();
  if (isPhone && View.checkout) {
    push('移动收银', View.checkout);
  } else if (window.CashierShell) {
    window.CashierShell.maybeEnter();
  }
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
  initServerAddr();
  refreshLoginForm();
})();

/* ══ V5.0.9 服务器地址设置（登录页可配）══
 * 行为：浏览器同源访问时留空即可（零配置）；APK 首次使用时填写一次并持久化。
 * SRV_DEFAULT 已上移到文件顶部（避免 TDZ，见那里的说明），此处不再重复声明。 */
function srvValue() {
  let v = '';
  try { v = String(localStorage.getItem(LS.api) || '').trim(); } catch { v = ''; }
  // 启动自愈：历史版本可能在手机输入法下存进碎片地址，直接丢弃并回到「最近可用地址」，
  // 否则用户会被一个必然失败的地址挡住，且看不出原因。
  if (v && !srvValid(v)) {
    v = srvHistory()[0] || '';
    try { v ? localStorage.setItem(LS.api, v) : localStorage.removeItem(LS.api); } catch { /* 忽略 */ }
  }
  return v || SRV_DEFAULT;   // 空 = 未配置过 → 同源（浏览器直接访问后端时）
}
/** 归一化用户输入：补 https://、去尾部斜杠；空串表示「同源」 */
function srvNormalize(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}
/** 校验归一化后的地址是否可用（空 = 同源，放行）
 *  V5.0.10：真机实测发现手机输入法可把地址框填成碎片（如 'https://3443:931.1291//:https.291'），
 *  而此前无校验直接落盘，导致登录必然失败且毫无提示。故此处做基本合法性检查。 */
function srvValid(n) {
  if (!n) return true;                       // 留空 = 同源，允许
  let u;
  try { u = new URL(n); } catch { return false; }
  if (!u.hostname) return false;
  // 主机名只允许字母数字、点、下划线、连字符，或方括号 IPv6；端口必须是数字
  if (!/^[A-Za-z0-9._-]+$|^\[[0-9A-Fa-f:]+\]$/.test(u.hostname)) return false;
  if (u.port && !/^\d{1,5}$/.test(u.port)) return false;
  return true;
}
/** 服务器地址历史（最多 3 条）：服务器 IP 随路由/DHCP 变动后，可一键切回此前可用的地址
 *  V5.0.10 真机实测修复：历史里曾残留手机输入法产生的碎片地址（如
 *  'https://3443:931.1291//:https.291'），而启动自愈直接取 history[0] 又把它写了回去，
 *  形成「脏值自我复活」。故读取与写入两侧都过滤非法值。 */
function srvHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(LS.srvHist) || '[]');
    if (!Array.isArray(a)) return [];
    return a.filter(x => typeof x === 'string' && x && srvValid(x));
  } catch { return []; }
}
function srvHistoryPush(u) {
  if (!u || !srvValid(u)) return;
  try {
    localStorage.setItem(LS.srvHist, JSON.stringify([u].concat(srvHistory().filter(x => x !== u)).slice(0, 3)));
  } catch { /* 隐私模式忽略 */ }
}
/** 是否运行在原生壳（APK）内：此时 origin=https://localhost，无法靠同源找到服务器 */
function isNativeApp() {
  try { return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()); }
  catch { return false; }
}
/** 落盘服务器地址。非法值一律拒绝并保留上一个可用值——手机输入法很容易把地址框填成碎片，
 *  若静默保存会导致登录必然失败且无任何提示。返回是否成功。 */
function commitServerAddr() {
  const input = $('#lgSrv');
  if (!input) return true;
  const n = srvNormalize(input.value);
  if (!srvValid(n)) {
    const tip = $('#lgSrvTip');
    if (tip) { tip.className = 'lg-srv-tip bad'; tip.textContent = '✘ 地址格式不正确，请形如 https://192.168.1.139:3443'; }
    // 回退到最近一次可用的地址，避免把脏值写进去
    const keep = srvHistory()[0] || '';
    input.value = keep;
    try { keep ? localStorage.setItem(LS.api, keep) : localStorage.removeItem(LS.api); } catch { /* 忽略 */ }
    const lab = $('#lgSrvLabel');
    if (lab) lab.textContent = keep ? ('服务器：' + keep.replace(/^https?:\/\//i, '')) : '服务器地址';
    return false;
  }
  input.value = n || SRV_DEFAULT;
  try { n ? localStorage.setItem(LS.api, n) : localStorage.removeItem(LS.api); } catch { /* 隐私模式忽略 */ }
  if (n) srvHistoryPush(n);
  const lab = $('#lgSrvLabel');
  if (lab) lab.textContent = n ? ('服务器：' + n.replace(/^https?:\/\//i, '')) : '服务器地址';
  return true;
}
function initServerAddr() {
  const toggle = $('#lgSrvToggle'), body = $('#lgSrvBody'), input = $('#lgSrv'), tip = $('#lgSrvTip'), test = $('#lgSrvTest');
  if (!toggle || !body || !input) return;
  input.value = srvValue();
  const syncLabel = () => {
    const v = input.value.trim();
    const lab = $('#lgSrvLabel');
    if (lab) lab.textContent = v ? ('服务器：' + v.replace(/^https?:\/\//i, '')) : '服务器地址';
  };
  // 地址历史快捷 chip（IP 变了不用重新输入）
  const histBox = $('#lgSrvHist');
  const renderHist = () => {
    if (!histBox) return;
    const list = srvHistory();
    histBox.textContent = '';
    if (!list.length) { histBox.style.display = 'none'; return; }
    histBox.style.display = '';
    list.forEach(u => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lg-srv-chip';
      b.textContent = u.replace(/^https?:\/\//i, '');
      b.title = u;
      b.onclick = () => { input.value = u; input.oninput(); input.onchange(); };
      histBox.appendChild(b);
    });
  };
  renderHist();
  // 原生壳内无法自动发现服务器：未配置时直接展开并给出明确指引
  if (!input.value && isNativeApp()) {
    body.style.display = '';
    toggle.setAttribute('aria-expanded', 'true');
    if (tip) tip.textContent = '首次使用请填写服务器地址，例如 https://192.168.1.139:3443（填写一次后会记住）。';
  }
  syncLabel();
  toggle.onclick = () => {
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    toggle.setAttribute('aria-expanded', String(open));
    if (open) { try { input.focus(); input.select(); } catch { /* noop */ } }
  };
  input.oninput = syncLabel;
  input.onchange = () => {
    commitServerAddr();          // 统一走带校验的落盘逻辑，非法值会被拒绝
    syncLabel();
    renderHist();
  };
  if (test) test.onclick = async () => {
    const n = srvNormalize(input.value) || SRV_DEFAULT;
    if (!n && isNativeApp()) {
      if (tip) { tip.className = 'lg-srv-tip bad'; tip.textContent = '✘ 请先填写服务器地址：本应用内无法自动发现服务器。'; }
      return;
    }
    if (tip) { tip.className = 'lg-srv-tip'; tip.textContent = '正在测试 ' + (n || '当前页面同源地址') + ' …'; }
    test.disabled = true;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(n + '/health', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const j = await r.json().catch(() => null);
      if (tip) {
        const ok = r.ok && j && j.code === 0;
        tip.className = 'lg-srv-tip ' + (ok ? 'ok' : 'bad');
        tip.textContent = ok
          ? '✔ 连接正常（数据库：' + ((j.data && j.data.db) || 'ok') + '）'
          : '✘ HTTP ' + r.status + '：地址可能不对或服务未启动';
        if (ok) { srvHistoryPush(n); renderHist(); }
      }
    } catch (e) {
      if (tip) { tip.className = 'lg-srv-tip bad'; tip.textContent = '✘ 无法连接：' + ((e && e.name === 'AbortError') ? '超时（6s）' : (e && e.message) || '网络错误'); }
    } finally { test.disabled = false; }
  };
}

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

/** V5.0.11b 设备未授权（40307）→ 弹出「配对码」对话框。
 *
 * 流程（对应业务）：未授权设备登录 → 提示未授权 + 显示本机设备码 → 联系管理员
 * → 管理员在「系统设置 → 设备管理」为该设备生成配对码 → 用户在此输入 →
 * 码正确即配对成功并完成授权，随即登录；码错误则提示原因，可反复重试。
 *
 * 另保留「应急恢复码」入口：管理员把自己锁在门外时的兜底（与配对码相互独立）。 */
async function showDeviceAuthDialog(msg, empNo) {
  const code = await deviceCode();
  const typeText = deviceType() === 'pc' ? '电脑端' : deviceType() === 'pad' ? '平板' : '移动端';
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet" style="width:min(430px,94vw)">
    <h3>该设备未授权</h3>
    <div class="hint" style="margin:0 0 10px">${esc(msg || '该设备未授权，暂无法登录，请联系管理员进行授权')}</div>
    <div class="kv"><span class="k">本机设备码</span><span class="v" id="dvCode" style="font-family:ui-monospace,Consolas,monospace;font-weight:700;letter-spacing:.5px">${esc(code)}</span></div>
    <div class="kv"><span class="k">设备类型</span><span class="v">${typeText}</span></div>
    <div class="hint" style="margin:8px 0 10px">
      本设备已自动上报到管理后台。请把上面的<b>设备码</b>告诉管理员，
      由管理员在「系统设置 → 设备管理」中为它生成<b>配对码</b>，然后填在下面完成配对。
    </div>
    <div class="field"><label>配对码（向管理员获取）</label>
      <input id="dvPair" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
             maxlength="12" placeholder="例如 K7M2XP9A" style="font-family:ui-monospace,Consolas,monospace;letter-spacing:2px;text-transform:uppercase"></div>
    <div id="dvErr" class="hint" style="margin:-4px 0 8px;color:var(--bad);min-height:16px"></div>
    <button class="btn ok" id="dvGo" style="width:100%">配对并登录</button>
    <details style="margin-top:10px">
      <summary class="hint" style="cursor:pointer">管理员被锁在门外？用应急恢复码</summary>
      <div class="field" style="margin-top:6px"><input id="dvRec" type="password" autocomplete="off" placeholder="应急恢复码"></div>
      <button class="btn ghost" id="dvRecGo" style="width:100%">用恢复码重试</button>
    </details>
    <button class="btn ghost" id="dvX" style="width:100%;margin-top:8px">关闭</button></div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  const errBox = m.querySelector('#dvErr');
  m.querySelector('#dvX').onclick = close;
  // 配对码输入框：自动大写 + 去掉空格，方便照着管理员念的码直接粘贴
  const pairInput = m.querySelector('#dvPair');
  pairInput.oninput = () => {
    pairInput.value = pairInput.value.replace(/\s+/g, '').toUpperCase();
  };
  setTimeout(() => { try { pairInput.focus(); } catch { /* noop */ } }, 50);

  /** 统一重试入口：把配对码/恢复码带进登录请求重试一次 */
  const retry = async (pair, rec) => {
    const btn = m.querySelector('#dvGo');
    btn.disabled = true;
    errBox.textContent = '';
    try {
      if (authMode === 'pin') {
        const pin = ($('#lgPw').value || '').trim();
        const d = await call('POST', '/auth/pin-login', { empNo, pin, device: await deviceCred(empNo, rec, pair) });
        rememberNo(empNo);
        await loginWith(d.token);
      } else {
        await login(empNo, $('#lgPw').value, rec, pair);
        rememberNo(empNo);
      }
      close();
      toast('配对成功，已授权本设备');
    } catch (e) {
      const m2 = (e && e.message) || String(e);
      if (e && e.bizCode === 40307) { close(); setTimeout(() => showDeviceAuthDialog(m2, empNo), 0); return; }
      errBox.textContent = m2;
      try { pairInput.focus(); pairInput.select(); } catch { /* noop */ }
    } finally {
      btn.disabled = false;
    }
  };
  m.querySelector('#dvGo').onclick = () => {
    const p = (pairInput.value || '').trim();
    if (!p) { errBox.textContent = '请输入管理员提供的配对码'; return; }
    retry(p, '');
  };
  m.querySelector('#dvRecGo').onclick = () => {
    const r = (m.querySelector('#dvRec').value || '').trim();
    if (!r) { errBox.textContent = '请输入应急恢复码'; return; }
    retry('', r);
  };
}

$('#lgGo').onclick = async () => {
  const err = $('#authErr');
  err.textContent = '';
  const no = ($('#lgNo').value || '').trim();
  if (!no) { err.textContent = '请输入工号'; return; }
  // V5.0.9：登录前先落盘服务器地址——否则本次请求仍会用旧地址（APK/换服务器场景必踩）
  commitServerAddr();
  const btn = $('#lgGo');
  btn.disabled = true;
  try {
    if (authMode === 'pin') {
      // 免密登录：工号 + PIN（PIN 在服务端 bcrypt 校验，本机不存任何密码）
      const pin = ($('#lgPw').value || '').trim();
      if (!pin) { err.textContent = '请输入 PIN'; return; }
      commitServerAddr();   // V5.0.9：PIN 登录同样先落盘服务器地址
      const d = await call('POST', '/auth/pin-login', { empNo: no, pin, device: await deviceCred(no) });
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
    const bc = (e && e.bizCode) || 0;
    // V5.0.11b 设备未授权：弹出配对码对话框（显示设备码 + 输入配对码）
    if (bc === 40307) {
      err.textContent = '该设备未授权，暂无法登录，请联系管理员进行授权';
      showDeviceAuthDialog(msg, no);
      return;
    }
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
      deviceCode: await deviceCode(),
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
  'stock.count.audit': '盘点审核', 'stock.count.task': '盘点任务管理', 'stock.loss.create': '报损登记', 'stock.loss.audit': '报损审核', 'stock.transfer': '调拨执行', 'stock.transfer.audit': '调拨确认',
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
  // V5.0.9（APK/Capacitor）：原生壳内跳过 Service Worker。三个原因：
  //   ① 资源已随 APK 内置，离线能力由文件系统提供，SW 多余；
  //   ② SW 在 WebView 自定义 scheme 下易出问题：缓存陈旧、controllerchange 反复 reload；
  //   ③ sw.js 的预缓存清单含 '../tts.js'，它位于 APK 的 web 根之外，必然 404，
  //      而 cache.addAll 是全有或全无，会直接导致 SW 安装失败。
  // 复用顶层的 isNativeApp()（V5.0.9 修正：此前此处另建同名 const，易与登录页那份冲突）
  try {
    if (!isNativeApp() && 'serviceWorker' in navigator && !location.search.includes('nosw=1')) {
      await navigator.serviceWorker.register('./sw.js');
      // V5.0.6：新版本 Service Worker 接管后自动刷新一次，确保手机端立刻用上新界面（避免扫旧码/旧缓存）
      navigator.serviceWorker.addEventListener('controllerchange', () => { try { location.reload(); } catch { /* 忽略 */ } });
    }
  } catch { /* 非安全上下文，忽略 */ }
  // 扫码登录：链接带 #qr=<ticket>（后台设置页生成）→ 一次性换 token 免密登录
  const mQr = location.hash.match(/qr=([0-9a-f]+)/i);
  if (mQr) {
    history.replaceState(null, '', location.pathname);   // 立刻清掉票据，防截图/转发泄露
    try {
      // 扫码登录：票据里已含身份，但设备签名载荷需要工号，故用「记住的工号」或空串
      //（服务端仅在已登记公钥的设备上才强制验签；空工号会导致验签失败 → 40313，
      //  此时用户手动输一次工号密码登录即可完成公钥登记，属预期兜底路径）
      const knownNo = (readLoginNo() || $('#lgNo')?.value || '').trim();
      const d = await call('POST', '/auth/qr-login', { ticket: mQr[1], device: await deviceCred(knownNo) });
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
