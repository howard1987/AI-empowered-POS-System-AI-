import { API, setAuth, get, post, toast, esc, dt, ensureBase } from './api.js';
import * as home from './screens/home.js';
import * as dashboard from './screens/dashboard.js';
import * as report from './screens/report.js';
import * as products from './screens/products.js';
import * as stock from './screens/stock.js';
import * as ops from './screens/ops.js';
import * as opsMod from './screens/ops.js';
import * as members from './screens/members.js';
import * as sales from './screens/sales.js';
import * as salesitems from './screens/salesitems.js';
import * as shifts from './screens/shifts.js';
import * as counter from './screens/counter.js';
import * as promotions from './screens/promotions.js';
import * as coupons from './screens/coupons.js';
import * as dividend from './screens/dividend.js';
import * as purchase from './screens/purchase.js';
import * as settings from './screens/settings.js';
import * as returns from './screens/returns.js';
import * as recon from './screens/recon.js';
import * as ai from './screens/ai.js';
import * as staff from './screens/staff.js';
import * as suppliers from './screens/suppliers.js';
import * as po from './screens/po.js';
import * as prices from './screens/prices.js';
import * as scaleTx from './screens/scale-transmission.js?v=20260915b';
import * as bundles from './screens/bundles.js';
import * as marketing from './screens/marketing.js';
import * as bigcustomer from './screens/bigcustomer.js';
import * as brain from './screens/brain.js';
import * as models from './screens/models.js';
import * as pricing from './screens/pricing.js';
import * as fraud from './screens/fraud.js';
import * as profiles from './screens/profiles.js';

/** 菜单（三级树：分组 → 一级 → 二级 → 三级；叶子挂屏；title 为面包屑名） */
const MENU = [
  { grp: '经营' },
  { key: 'home', title: '后台首页', icon: '🏠', mod: home },
  { key: 'dashboard', title: '经营看板', icon: '📊', mod: dashboard },
  { key: 'report', title: '报表中心', icon: '📈', mod: report },
  { grp: '商品与库存' },
  { key: 'products', title: '商品档案', icon: '📦', mod: products },
  { key: 'suppliers', title: '供应商管理', icon: '🏭', mod: suppliers },
  {
    key: 'purchase', title: '采购管理', icon: '🚚', children: [
      { key: 'purchase/po', title: '采购订单', icon: '📋', mod: { render: (v) => po.render(v) } },
      { key: 'purchase/in', title: '采购入库', icon: '🚚', mod: { render: (v) => purchase.render(v) } },
      { key: 'purchase/ret', title: '采购退货', icon: '↩️', mod: { render: (v) => returns.render(v) } },
    ],
  },
  { key: 'prices', title: '调价管理', icon: '💱', mod: prices },
  { key: 'scale-tx', title: '生鲜管理', icon: '⚖️', mod: scaleTx },
  { key: 'bundles', title: '组合拆分', icon: '🧩', mod: bundles },
  {
    key: 'inventory', title: '库存管理', icon: '🏷️', children: [
      { key: 'inventory/stock', title: '库存批次', icon: '🏷️', mod: { render: (v) => stock.render(v) } },
      {
        key: 'inventory/ops', title: '库存作业', icon: '🧾', children: [
          { key: 'inventory/ops/count', title: '盘点', icon: '📝', mod: { render: (v) => ops.render(v, { type: 'count' }) } },
          { key: 'inventory/ops/loss', title: '报损', icon: '📷', mod: { render: (v) => ops.render(v, { type: 'loss' }) } },
          { key: 'inventory/ops/transfer', title: '调拨', icon: '🔄', mod: { render: (v) => ops.render(v, { type: 'transfer' }) } },
        ],
      },
    ],
  },
  { key: 'recon', title: '对账结算', icon: '📑', mod: recon },
  { grp: '收银' },
  {
    key: 'sales', title: '销售管理', icon: '🧾', children: [
      { key: 'sales/orders', title: '销售单据', icon: '🧾', mod: { render: (v) => sales.render(v) } },
      { key: 'sales/items', title: '销售明细', icon: '📋', mod: { render: (v) => salesitems.render(v) } },
    ],
  },
  { key: 'counter', title: '挂单/价目表', icon: '🛎️', mod: counter },
  { key: 'shifts', title: '交接班', icon: '⏱️', mod: shifts },
  { key: 'bigcustomer', title: '大客户与团购', icon: '🏬', mod: bigcustomer },
  { key: 'fraud', title: '智能防损', icon: '🛡️', mod: fraud },
  { grp: '会员与营销' },
  { key: 'members', title: '会员管理', icon: '👥', mod: members },
  { key: 'dividend', title: '分红引擎', icon: '💰', mod: dividend },
  { key: 'marketing', title: '营销引擎', icon: '🎯', mod: marketing },
  { key: 'profiles', title: '会员画像', icon: '🎭', mod: profiles },
  { key: 'promotions', title: '促销活动', icon: '🎉', mod: promotions },
  { key: 'coupons', title: '优惠券', icon: '🎟️', mod: coupons },
  { grp: 'AI 智能' },
  { key: 'brain', title: '智能决策中心', icon: '🧠', mod: brain },
  { key: 'ai', title: 'AI 训练台', icon: '🤖', mod: ai },
  { key: 'models', title: 'AI 模型管理', icon: '🛰️', mod: models },
  { key: 'pricing', title: 'AI 动态定价', icon: '💹', mod: pricing },
  // V5.0.0 连锁：总部专属分组（hqOnly → 门店账号自动隐藏，服务端另有权限闸）
  { grp: '总部', hqOnly: true },
  { key: 'hq/stores', title: '门店管理', icon: '🏪', hqOnly: true, mod: { render: (v) => import('./screens/hq-stores.js').then(m => m.render(v)) } },
  { key: 'hq/costs', title: '进价管理', icon: '💰', hqOnly: true, mod: { render: (v) => import('./screens/hq-costs.js').then(m => m.render(v)) } },
  // V5.0.0 批次4B：跨店退货审核 / 门店往来 / 进价差异单（R6/R9/R17）
  { key: 'hq/trade', title: '退货与往来', icon: '↩️', hqOnly: true, mod: { render: (v) => import('./screens/hq-trade.js').then(m => m.render(v)) } },
  // V5.0.0 批次5：会员跨店资产流水（R3/R4，权限 hq.member.crossview）
  { key: 'hq/members', title: '会员跨店', icon: '👤', hqOnly: true, mod: { render: (v) => import('./screens/hq-members.js').then(m => m.render(v)) } },
  // V5.0.0 批次6：门店维度报表聚合（日报/排行/对比/库存/在途/退货双维度/往来/进价/会员/同步）
  { key: 'hq/reports', title: '门店报表', icon: '📊', hqOnly: true, mod: { render: (v) => import('./screens/hq-reports.js').then(m => m.render(v)) } },
  // V5.0.0 批次4A：数据同步（总部=节点看板；门店=本机配置与队列。双形态页面，不放 hqOnly）
  { key: 'sync', title: '数据同步', icon: '🔄', mod: { render: (v) => import('./screens/hq-sync.js').then(m => m.render(v)) } },
  { grp: '系统' },
  { key: 'staff', title: '员工与权限', icon: '🔐', mod: staff },
  { key: 'print', title: '打印中心', icon: '🖨️', mod: { render: (v) => import('./screens/print.js').then(m => m.render(v)) } },
  { key: 'signatures', title: '授权管理', icon: '🔏', mod: { render: (v) => import('./screens/signatures.js').then(m => m.render(v)) } },
  { key: 'settings', title: '系统设置', icon: '⚙️', mod: settings },
];

const nav = document.getElementById('nav');
const view = document.getElementById('view');

/** 叶子索引：key → { item, chain }（chain 为从顶层到该叶子的路径，供展开与面包屑） */
const LEAF = {};
(function indexMenu() {
  const walk = (list, chain) => list.forEach(m => {
    if (m.children) walk(m.children, chain.concat(m));
    else if (m.mod) LEAF[m.key] = { item: m, chain: chain.concat(m) };
  });
  walk(MENU, []);
})();

/* ── V5.0.0 连锁：总部/门店菜单裁剪（前端体验层；真正的安全闸在服务端 data_scope） ── */
/** 当前账号是否具备总部视野：hq 标记 / dataScope='all' / 持有任一 hq.* 权限点 */
function isHqUser() {
  const u = API.user || {};
  if (u.hq === true || u.dataScope === 'all') return true;
  if (u.hq === false) return (u.perms || []).some(p => String(p).startsWith('hq.'));
  return (u.perms || []).some(p => String(p).startsWith('hq.'));
}
/** 菜单项是否对当前账号可见（hqOnly 项：分组与其下所有项一并隐藏） */
function menuVisible(m) { return !m.hqOnly || isHqUser(); }

function buildNav() {
  const leaf = (m, depth) =>
    `<a href="#/${m.key}" data-key="${m.key}" style="padding-left:${14 + depth * 15}px">${m.icon} ${m.title}</a>`;
  const branch = (m, depth) => m.children
    ? `<div class="nav-parent" data-parent="${m.key}" style="padding-left:${10 + depth * 15}px">
         <span class="nav-arrow">▸</span><span>${m.icon} ${m.title}</span></div>
       <div class="nav-children" data-children="${m.key}" style="display:none">
         ${m.children.filter(menuVisible).map(c => branch(c, depth + 1)).join('')}
       </div>`
    : leaf(m, depth);
  nav.innerHTML = MENU.filter(menuVisible).map(m => m.grp
    ? `<div class="grp${m.hqOnly ? ' grp-hq' : ''}">${m.grp}${m.hqOnly ? ' · 总部' : ''}</div>`
    : branch(m, 0)).join('');
  // 父级点击：展开/收起
  nav.querySelectorAll('.nav-parent').forEach(p => p.onclick = () => {
    const box = nav.querySelector(`[data-children="${p.dataset.parent}"]`);
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : '';
    const arrow = p.querySelector('.nav-arrow');
    if (arrow) arrow.textContent = open ? '▸' : '▾';
  });
}

function loginView() {
  document.getElementById('side').style.display = 'none';
  document.getElementById('topbar').style.display = 'none';
  view.innerHTML = `
  <div class="login-wrap"><div class="login-box">
    <h1>社区超市收银系统</h1>
    <div class="sub">本地部署 · 会员即股东 · V4.25.0 Web 管理后台</div>
    <div class="login-err" id="lgErr"></div>
    <div id="lgNotice" style="display:none;font-size:12px;padding:7px 10px;border-radius:8px;margin-bottom:12px"></div>
    <div id="lgForm">
      <label>服务地址</label><input id="lgBase" value="${esc(API.base)}">
      <label>工号</label><input id="lgNo" value="" autocomplete="username">
      <label>密码</label><input id="lgPw" type="password" value="" autocomplete="current-password">
      <button class="btn pri" id="lgGo">登 录</button>
    </div>
    <div id="lgReg" class="hidden">
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:10px">本机数据库尚未初始化管理员。请设置你自己的工号与密码，该账号将绑定「超级管理员」角色并拥有全部权限。</div>
      <label>门店名称</label><input id="rgStore" type="text" maxlength="60" placeholder="如：乐美鲜祥成家园店">
      <label>管理员工号</label><input id="rgNo" type="text" maxlength="32" placeholder="自定义，如 BOSS / 0001">
      <label>姓名</label><input id="rgName" type="text" maxlength="30" placeholder="管理员姓名">
      <label>登录密码</label><input id="rgPw" type="password" placeholder="至少 8 位，含字母与数字" autocomplete="new-password">
      <button class="btn pri" id="rgGo">创建管理员并登录</button>
    </div>
    <a href="javascript:void(0)" id="lgSwitch" class="hidden" style="display:none;margin-top:12px;text-align:center;font-size:12px;color:var(--pri);cursor:pointer"></a>
  </div></div>`;

  const showPane = p => {
    const form = document.getElementById('lgForm');
    const reg = document.getElementById('lgReg');
    const sw = document.getElementById('lgSwitch');
    // V4.25.8: explicit three-state so pending hides both forms.
    if (p === 'pending') {
      form.classList.add('hidden');
      reg.classList.add('hidden');
      sw.classList.add('hidden'); sw.style.display = 'none';
    } else {
      const login = p === 'login';
      form.classList.toggle('hidden', !login);
      reg.classList.toggle('hidden', login);
      sw.classList.remove('hidden'); sw.style.display = 'block';
      sw.textContent = login ? '没有管理员？去创建管理员账号' : '已有管理员？返回登录';
    }
  };

  view.querySelector('#lgGo').onclick = async () => {
    const base = view.querySelector('#lgBase').value.trim().replace(/\/$/, '');
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)
        && !confirm('即将把后台数据发送到非本机地址：\n' + base + '\n登录信息与业务数据将发往该地址，确认继续？')) return;
    localStorage.setItem('api_base', base); API.base = base;
    const empNo = view.querySelector('#lgNo').value.trim();
    const r = await post('/auth/login', { empNo, password: view.querySelector('#lgPw').value, deviceCode: webDeviceCode() });
    if (r.code !== 0) { view.querySelector('#lgErr').textContent = r.msg || '登录失败'; return; }
    setAuth(r.data.token, { name: r.data.name, empNo, perms: r.data.perms,
      storeId: r.data.storeId, dataScope: r.data.dataScope, scopeStores: r.data.scopeStores, hq: r.data.hq });
    location.hash = '#/home';
    route();
  };
  view.querySelector('#lgPw').addEventListener('keydown', e => { if (e.key === 'Enter') view.querySelector('#lgGo').click(); });

  // V4.25.0 ②：首次运行创建管理员（与收银端同一套 bootstrap；不写死 ADMIN/admin123）
  view.querySelector('#rgGo').onclick = async () => {
    const base = view.querySelector('#lgBase').value.trim().replace(/\/$/, '');
    localStorage.setItem('api_base', base); API.base = base;
    const empNo = view.querySelector('#rgNo').value.trim();
    const name = view.querySelector('#rgName').value.trim();
    const pw = view.querySelector('#rgPw').value;
    if (!empNo || !name || !pw) { view.querySelector('#lgErr').textContent = '工号、姓名、密码均为必填'; return; }
    const btn = view.querySelector('#rgGo'); btn.disabled = true;
    try {
      const r = await post('/auth/bootstrap-admin', { empNo, name, password: pw, storeName: view.querySelector('#rgStore').value.trim(), deviceCode: webDeviceCode() });
      if (r.code !== 0) { view.querySelector('#lgErr').textContent = r.msg || '创建失败'; btn.disabled = false; return; }
      setAuth(r.data.token, { name: r.data.name, empNo, perms: r.data.perms,
        storeId: r.data.storeId, dataScope: r.data.dataScope, scopeStores: r.data.scopeStores, hq: r.data.hq });
      location.hash = '#/home'; route();
    } catch (e) {
      view.querySelector('#lgErr').textContent = (e && e.msg) || (e && e.message) || '创建失败';
      btn.disabled = false;
    }
  };
  view.querySelector('#lgSwitch').onclick = () => showPane(document.getElementById('lgForm').classList.contains('hidden') ? 'login' : 'reg');

  // 启动自检：库里有没有管理员（无 → 引导创建；有 → 提示用其密码登录并预填工号）
  // V4.25.8: hide both forms until bootstrap result arrives, so red-box register form
  // is only shown when DB truly contains no admin.
  showPane('pending');
  document.getElementById('lgNotice').style.display = '';
  document.getElementById('lgNotice').textContent = '正在检测系统初始化状态，请稍候...';
  (async () => {
    try {
      // V4.26.2：先同步确认后端地址可用（静态站点 8088 不提供接口，历史版本会把 8088 存进
      // localStorage.api_base 导致所有请求 403），再自检，避免用错地址拿结果。
      await ensureBase();
      // V4.26.2 关键修复：get() 返回完整响应 {code,msg,data}，业务字段在 .data 里。
      // 原写法 `b.hasAdmin` 恒为 undefined → `!b.hasAdmin` 恒真 → 登录页永远判定
      // 「未检测到管理员」并显示创建表单（自 V4.25.8 改版引入，与后端/数据库无关）。
      let b = (await get('/auth/bootstrap')).data;
      // V4.26.2 防暂态误报：后端启动/切换瞬间可能偶发误报「无管理员」，间隔 1.2s 复查一次，
      // 两次都返回无管理员才引导创建，避免误导出第二个管理员账号。
      if (b && !b.hasAdmin) {
        await new Promise(r => setTimeout(r, 1200));
        try { const b2 = (await get('/auth/bootstrap')).data; if (b2 && b2.hasAdmin) b = b2; } catch { }
      }
      // 诊断可见：把实际请求的后端地址显示在提示里，便于一眼看出请求发到了哪
      const at = `<br><span style="opacity:.75;font-size:12px">后端地址：${esc(API.base)}</span>`;
      const notice = document.getElementById('lgNotice');
      if (b && !b.hasAdmin) {
        notice.style.display = ''; notice.style.background = '#fff7e6'; notice.style.color = '#a86a00';
        notice.innerHTML = '⚠ 未检测到管理员，请先创建管理员账号' + at;
        showPane('reg');
        try { document.getElementById('rgNo').focus(); } catch { }
      } else if (b) {
        notice.style.display = ''; notice.style.background = '#eafaf0'; notice.style.color = '#1a8a4f';
        notice.innerHTML = '检测到管理员账户 <b>' + esc(b.adminEmpNo) + '</b>' + (b.adminName ? '（' + esc(b.adminName) + '）' : '') + '，请使用其密码登录' + at;
        showPane('login');
        const no = document.getElementById('lgNo'); if (no && !no.value) no.value = b.adminEmpNo || '';
        const st = document.getElementById('rgStore'); if (st && !st.value) st.value = String(b.storeName || '').replace(/^"|"$/g, '');
        try { document.getElementById('lgPw').focus(); } catch { }
      }
    } catch {
      // 服务器不可达：保守显示登录表单（不显示创建管理员红框）
      const notice = document.getElementById('lgNotice');
      notice.style.display = ''; notice.style.background = '#fff0f0'; notice.style.color = '#b71c1c';
      notice.innerHTML = '⚠ 服务暂不可达，请确认后端已启动后刷新页面'
        + `<br><span style="opacity:.75;font-size:12px">后端地址：${esc(API.base)}</span>`;
      showPane('login');
    }
  })();
}

/** V4.21.2：本机设备码（首次生成后持久化 localStorage；收银机授权白名单用） */
function webDeviceCode() {
  let dc = '';
  try { dc = localStorage.getItem('pos_device_code') || ''; } catch { }
  if (!dc || !/^D[0-9A-F]{8}$/.test(dc)) {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    dc = 'D' + [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    try { localStorage.setItem('pos_device_code', dc); } catch { }
  }
  return dc;
}

/* ── V4.25.7 多标签页导航条：打开过的页面列成标签，可关闭/切换（首页固定；刷新后保留） ── */
const TAB_HOME = { key: 'home', title: '首页', icon: '🏠' };
const TAB_STORE = 'admin_open_tabs_v1';
let openTabs = [];                     // [{key,title,icon}]
function loadTabs() {
  try {
    const raw = JSON.parse(localStorage.getItem(TAB_STORE) || '{}');
    openTabs = Array.isArray(raw.tabs) ? raw.tabs.filter(t => t && t.key && LEAF[t.key]) : [];
  } catch { openTabs = []; }
  if (!openTabs.some(t => t.key === 'home')) openTabs.unshift({ ...TAB_HOME });
}
function saveTabs() { try { localStorage.setItem(TAB_STORE, JSON.stringify({ tabs: openTabs })); } catch { /* 忽略 */ } }
function renderTabs(activeKey) {
  const box = document.getElementById('tabbar');
  if (!box) return;
  if (!openTabs.length) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  box.innerHTML = openTabs.map(t => `<span class="tab${t.key === activeKey ? ' on' : ''}" data-k="${esc(t.key)}" title="${esc(t.title)}"><span class="dot"></span><span>${esc(t.icon || '')} ${esc(t.title)}</span>${t.key === 'home' ? '' : `<span class="x" data-close="${esc(t.key)}" title="关闭此标签">✕</span>`}</span>`).join('');
  box.querySelectorAll('.tab').forEach(el => el.onclick = e => {
    const closeK = e.target.closest('[data-close]') && e.target.closest('[data-close]').dataset.close;
    if (closeK) { e.stopPropagation(); closeTab(closeK, activeKey); return; }
    const k = el.dataset.k;
    if (k !== activeKey) { location.hash = '#/' + k; route(); }
  });
}
function closeTab(k, activeKey) {
  const i = openTabs.findIndex(t => t.key === k);
  if (i < 0) return;
  openTabs.splice(i, 1);
  saveTabs();
  if (k === activeKey) {
    const next = openTabs[Math.min(i, openTabs.length - 1)] || openTabs[0] || TAB_HOME;
    location.hash = '#/' + next.key;
    route();
  } else {
    renderTabs(activeKey);
  }
}
/** 打开（或激活）标签：菜单里点进来的页面都会留一个标签 */
function openTab(hit, key) {
  const t = { key, title: hit.item.title || key, icon: hit.item.icon || '' };
  const ex = openTabs.find(x => x.key === key);
  if (ex) { ex.title = t.title; ex.icon = t.icon; } else openTabs.push(t);
  saveTabs();
}
function clearTabs() {
  openTabs = [];
  try { localStorage.removeItem(TAB_STORE); } catch { /* 忽略 */ }
  const box = document.getElementById('tabbar');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

/* ── V5.0.0：老会话（升级前登录、localStorage 里没有 hq/dataScope）补全一次 ──
   否则升级后总部账号会看不到「总部」分组（菜单按 hqOnly 裁剪，缺字段即视为非总部）。 */
let menuScopeRefreshed = false;
async function refreshMenuScope() {
  if (menuScopeRefreshed) return;
  menuScopeRefreshed = true;
  if (!API.token || !API.user) return;
  if (API.user.hq !== undefined && API.user.dataScope !== undefined) return;   // 已是新结构
  try {
    const d = (await get('/auth/me')).data;
    if (!d) return;
    API.user = { ...API.user, storeId: d.storeId, dataScope: d.dataScope,
                 scopeStores: d.scopeStores ?? null, hq: !!d.hq, perms: d.perms || API.user.perms };
    try { localStorage.setItem('user', JSON.stringify(API.user)); } catch { /* 忽略 */ }
    buildNav();     // 菜单按新身份重建
  } catch { /* 静默：保持默认菜单，不阻塞页面 */ }
}

async function route() { if (!API.token) { loginView(); sideShow.style.display = 'none';
    { const tb = document.getElementById('tabbar'); if (tb) tb.style.display = 'none'; }
    return; }
  document.getElementById('side').style.display = 'flex';
  document.getElementById('topbar').style.display = 'flex';
  applySide();
  await refreshMenuScope();     // V5.0.0 连锁：补全数据范围后再渲染菜单/高亮
  document.getElementById('who').textContent = `${API.user?.name || ''}（${API.user?.empNo || ''}）`;
  initNotices(); // V4.14.6 RV-07：站内提醒铃铛
  loadGlassSetting(); // V4.26.3 液态玻璃总开关（读 ui.glass.enabled → html.no-glass）
  const rawKey = (location.hash || '#/home').replace(/^#\//, '').split('?')[0] || 'home';
  // 旧路由归并：库存批次/库存作业 → 库存管理叶子；采购订单/入库/退货 → 采购管理叶子；联营对账 → 对账结算
  const MERGE = {
    stock: 'inventory/stock', ops: 'inventory/ops/count', inventory: 'inventory/stock',
    po: 'purchase/po', returns: 'purchase/ret', purchase: 'purchase/po', consign: 'recon',
  };
  const key = MERGE[rawKey] || rawKey;
  let hit = LEAF[key] || LEAF['home'];
  // V5.0.0：门店账号手输总部路由 → 回首页（服务端同样会 403，双保险）
  if (hit.item.hqOnly && !isHqUser()) { hit = LEAF['home']; if (key !== 'home') location.hash = '#/home'; }
  // V4.25.7：登记/激活标签条
  if (!openTabs.length) loadTabs();
  openTab(hit, hit.item.key);
  renderTabs(hit.item.key);
  nav.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.key === hit.item.key));
  // 先全部收起，再展开命中叶子的祖先链
  nav.querySelectorAll('.nav-children').forEach(box => { box.style.display = 'none'; });
  nav.querySelectorAll('.nav-arrow').forEach(x => { x.textContent = '▸'; });
  hit.chain.forEach(m => {
    if (m.children) {
      const box = nav.querySelector(`[data-children="${m.key}"]`);
      if (box) box.style.display = '';
      const arrow = nav.querySelector(`[data-parent="${m.key}"] .nav-arrow`);
      if (arrow) arrow.textContent = '▾';
    }
  });
  document.getElementById('crumb').textContent = hit.chain.map(x => `${x.icon || ''} ${x.title}`).join(' / ');
  // V4.9.7 页面状态保留：已渲染过的页面缓存 DOM 节点，切回时原样恢复（不重新 render）
  const cached = viewCache.get(key);
  if (cached) {
    view.innerHTML = '';
    view.appendChild(cached);
    decorateDeep(cached);
    return;
  }
  const host = document.createElement('div');
  view.innerHTML = '';
  view.appendChild(host);
  try {
    await hit.item.mod.render(host);
    viewCache.set(key, host);
    decorateDeep(host);
  } catch (e) {
    if (e && e.code !== undefined) return; // must() 已 toast
    view.innerHTML = `<div class="empty">屏幕渲染异常：${esc(String(e.message || e))}</div>`;
  }
}

/* ── V4.9.7 全局增强 ── */
import { decorateModal } from './ui.js';
import { enhancePick } from './pick-panel.js';   // V4.9.14 全局自绘下拉
import { enhanceColResize } from './col-resize.js';   // V4.26.2 Excel 式表格列宽拖拽
import { installBackToTop, anchorNav, loadGlassSetting, applyGlass } from './ui-polish.js';   // V4.26.3 UI 精修层
const viewCache = new Map();   // 路由 key → 已渲染 DOM 节点（页面自由切换不丢状态）
// 1) 弹窗自动挂「最小化/最大化/关闭」窗口按钮（含后续动态创建的弹窗）
function decorateDeep(root) {
  root.querySelectorAll('.modal-mask').forEach(decorateModal);
  enhancePick(root);                             // V4.9.14 动态节点自动转自绘下拉
  enhanceColResize(root);                        // V4.26.2 表格列宽可调（拖动/双击自适应/右键恢复）
  autoAnchors(root);                             // V4.26.3 长页面锚点导航（声明式，见下）
}
/* V4.26.3 声明式锚点导航：页面只要给容器加 data-anchor-scope，内部小节加 data-anchor，
   即自动生成吸顶胶囊条 + 滚动高亮；anchorNav 内部有 data-anchored 防重，重复调用安全。 */
function autoAnchors(root) {
  if (!root?.querySelectorAll) return;
  const scopes = root.matches?.('[data-anchor-scope]') ? [root, ...root.querySelectorAll('[data-anchor-scope]')]
    : root.querySelectorAll('[data-anchor-scope]');
  scopes.forEach(sc => anchorNav(sc, {
    scope: sc,
    item: sc.dataset.anchorItem || '[data-anchor]',
    label: sc.dataset.anchorLabel || undefined,
    prefix: sc.dataset.anchorPrefix || 'anc',
  }));
}
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.classList?.contains('modal-mask')) decorateModal(n);
    n.querySelectorAll?.('.modal-mask').forEach(decorateModal);
    enhancePick(n);                              // V4.9.14 新增节点内的 select / input[list]
    enhanceColResize(n);                         // V4.26.2 新增节点内的表格自动可拖拽列宽
    autoAnchors(n);                              // V4.26.3 动态渲染出的长列表也自动挂锚点
  }
}).observe(document.body, { childList: true, subtree: true });
enhancePick(document);                           // V4.9.14 首屏静态下拉一次性增强
installBackToTop();                              // V4.26.3 返回顶部（全局一次）
// 2) 所有日期输入框：点击即弹出日期选择器
document.addEventListener('click', e => {
  const t = e.target;
  if (t && t.tagName === 'INPUT' && t.type === 'date' && t.showPicker) {
    try { t.showPicker(); } catch { /* 浏览器不支持时忽略 */ }
  }
}, true);

document.getElementById('btnLogout').onclick = () => { setAuth('', null); clearTabs(); location.hash = '#/login'; route(); };

// 侧栏折叠/展开（《 收起 · 》 展开，记忆到 localStorage，登录前后均可用）
const sideEl = document.getElementById('side');
const sideShow = document.getElementById('sideShow');
function applySide() {
  const collapsed = localStorage.getItem('side_collapsed') === '1';
  document.body.classList.toggle('side-collapsed', collapsed);
  sideShow.style.display = collapsed ? 'block' : 'none';
}
document.getElementById('sideHide').onclick = () => { localStorage.setItem('side_collapsed', '1'); applySide(); };
sideShow.onclick = () => { localStorage.setItem('side_collapsed', '0'); applySide(); };
applySide();

window.addEventListener('hashchange', route);
buildNav();
let noticeTimer = null;   // 提前声明（route() 首调 initNotices 会引用，放下面会 TDZ 报错）
route();

// 连通性探测：未登录时也提示后端是否可达
get('/health').then(r => { if (r.code !== 0 && r.status !== undefined && !API.token) toast('后端不可达，请检查服务地址', false); }).catch(() => {});

/* ═══════════ V4.14.6 RV-07：站内提醒铃铛（对账差异等告警触达） ═══════════ */
function initNotices() {
  const wrap = document.getElementById('noticeWrap');
  if (!wrap || wrap.dataset.inited) return;
  wrap.dataset.inited = '1';
  wrap.style.display = '';
  document.getElementById('btnNotices').onclick = () => {
    const panel = document.getElementById('noticePanel');
    if (panel.style.display === 'none' || !panel.style.display) openNotices();
    else panel.style.display = 'none';
  };
  // 点击面板外关闭
  document.addEventListener('click', e => {
    const panel = document.getElementById('noticePanel');
    if (panel && panel.style.display !== 'none' && !wrap.contains(e.target)) panel.style.display = 'none';
  });
  refreshNoticeBadge();
  clearInterval(noticeTimer);
  noticeTimer = setInterval(refreshNoticeBadge, 60000);
}

async function refreshNoticeBadge() {
  try {
    const r = await get('/finance/notices/unread');
    const b = document.getElementById('noticeBadge');
    if (!b) return;
    const n = Number(r?.data?.count ?? 0);
    b.style.display = n > 0 ? '' : 'none';
    b.textContent = n > 99 ? '99+' : String(n);
  } catch { /* 后端不可达等：静默 */ }
}

async function openNotices() {
  const panel = document.getElementById('noticePanel');
  panel.style.display = '';
  panel.innerHTML = '<div style="padding:18px;color:#8a8577;font-size:13px">加载中…</div>';
  try {
    const r = await get('/finance/notices');
    const items = r?.data?.items ?? [];
    panel.innerHTML = items.length ? items.map(x => `
      <div class="notice-item" data-id="${x.id}" data-kind="${esc(x.kind)}"
        style="padding:10px 14px;border-bottom:1px solid #eee8dc;cursor:pointer;background:${x.read ? '#faf8f2' : '#fff'}">
        <div style="font-size:13px;${x.read ? 'color:#6b665a' : 'font-weight:600;color:#1a1a1a'}">${esc(x.title)}</div>
        <div style="font-size:11px;color:#8a8577;margin-top:3px">${dt(x.createdAt)}${x.read ? ' · 已读' : ''}</div>
      </div>`).join('') : '<div style="padding:20px;color:#8a8577;font-size:13px;text-align:center">🎉 暂无提醒</div>';
    panel.querySelectorAll('.notice-item').forEach(el => el.onclick = async () => {
      try { await post(`/finance/notices/${el.dataset.id}/read`); } catch { /* 已读失败不阻断 */ }
      el.style.background = '#faf8f2';
      const t = el.querySelector('div'); t.style.fontWeight = ''; t.style.color = '#6b665a';
      const meta = el.querySelectorAll('div')[1];
      if (meta) meta.textContent += ' · 已读';
      refreshNoticeBadge();
      if (el.dataset.kind === 'recon_diff') { location.hash = '#/recon'; panel.style.display = 'none'; }
    });
  } catch (e) {
    panel.innerHTML = `<div style="padding:20px;color:#b04a3a;font-size:13px;text-align:center">${esc(e?.msg || '加载失败')}</div>`;
  }
}
