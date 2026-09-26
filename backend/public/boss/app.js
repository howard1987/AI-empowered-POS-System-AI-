'use strict';
/* 老板移动端 · 老板看板（app.js）：登录 / 概览 / 审批 / 报表 / 设置
 * 对端：同源 API（/auth /reports /purchase /inventory /ai /dividend）· 响应式 Web，手机浏览器即开（8.3） */
const LS = { token: 'boss_token' };
const API_BASE = '';
let TOKEN = localStorage.getItem(LS.token) || '';
let ME = null;   // {staffId, empNo, name, roles[], perms[], storeName}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n ?? 0).toFixed(2);
const fmt = n => Number(n ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** 时间显示：MM-DD HH:mm（移动端窄屏友好） */
const dt = s => { if (!s) return '—'; const d = new Date(s); return isNaN(d.getTime()) ? String(s).slice(0, 16).replace('T', ' ')
  : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const isManager = () => !!ME && (ME.roles || []).some(r => r === '超级管理员' || r === '店长' || r === '老板');

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
// V4.21.1 收银机授权：本机设备码（首次生成后持久化；老板手机/PAD 同样纳管，ADMIN 账号服务端豁免）
function deviceCode() {
  let c = localStorage.getItem('boss_device_code');
  if (!c) {
    const b = new Uint8Array(4); (crypto || {}).getRandomValues && crypto.getRandomValues(b);
    c = 'D' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    localStorage.setItem('boss_device_code', c);
  }
  return c;
}
async function login(empNo, password) {
  const d = await call('POST', '/auth/login', { empNo, password, deviceCode: deviceCode() });
  TOKEN = d.token;
  localStorage.setItem(LS.token, TOKEN);
  await loadMe();
  showMain();
}
async function loadMe() {
  const d = await call('GET', '/auth/me');
  ME = { staffId: d.staffId, empNo: d.empNo, name: d.name, storeName: d.storeName || '本店', roles: d.roles || [], perms: d.perms || [] };
  if (!isManager()) toast('当前账号非老板/店长角色，部分数据可能不可见');
  return ME;
}
function logout() {
  TOKEN = ''; ME = null;
  localStorage.removeItem(LS.token);
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
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
  } catch (e) { err.textContent = e.message; }
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
  if (approveN > 0) alerts.push({ dot: '🔵', txt: `${approveN} 张单据待审批（入库/退货/报损）`, pill: 'blue', tag: '待办' });
  if (Number(stock.expiringSoon) > 0) alerts.push({ dot: '🟠', txt: `${stock.expiringSoon} 个批次临期预警`, pill: 'orange', tag: '临期' });
  if (Number(stock.lowStock) > 0) alerts.push({ dot: '🟡', txt: `${stock.lowStock} 个商品低于安全库存`, pill: 'yellow', tag: '补货' });
  try {
    const fr = await call('GET', '/reports/fraud');
    const s = fr.summary || {};
    if (Number(s.refundCount) > 0 || Number(s.cancelCount) > 0 || Number(s.negProfitCount) > 0) {
      const parts = [];
      if (Number(s.refundCount) > 0) parts.push(`退款 ${s.refundCount} 笔`);
      if (Number(s.cancelCount) > 0) parts.push(`取消 ${s.cancelCount} 单`);
      if (Number(s.negProfitCount) > 0) parts.push(`负毛利 ${s.negProfitCount} 笔`);
      alerts.push({ dot: '🔴', txt: `今日防损提示：${parts.join(' · ')}`, pill: 'red', tag: '防损' });
    }
  } catch { /* 防损数据缺失不阻塞 */ }
  try {
    const tasks = unwrap(await call('GET', '/ai/tasks'));
    const running = tasks.filter(t => t.status === '进行中').length;
    if (running > 0) alerts.push({ dot: '🤖', txt: `${running} 个 AI 采集任务进行中`, pill: 'blue', tag: 'AI' });
  } catch { /* AI 状态缺失不阻塞 */ }
  try {
    const rcv = await call('GET', '/big-customers/receivables-overview');
    if (Number(rcv.totalUnpaid) > 0) {
      const over = Number(rcv.unpaid90) > 0 ? `（超 90 天 ¥${fmt(rcv.unpaid90)}）` : '';
      alerts.push({ dot: '💰', txt: `${rcv.unpaidCustomers} 位大客户未收 ¥${fmt(rcv.totalUnpaid)}${over}`, pill: Number(rcv.unpaid90) > 0 ? 'red' : 'orange', tag: '应收' });
    }
  } catch { /* 大客户模块未启用不阻塞 */ }
  if (!alerts.length) alerts.push({ dot: '🟢', txt: '暂无异常提醒，一切正常', pill: 'green', tag: '正常' });

  v.innerHTML = `
    <div class="alert-card">
      <b>⚡ 实时提醒（${alerts.length}）</b>
      ${alerts.map(a => `
        <div class="al-line"><span>${a.dot} ${esc(a.txt)}</span><span class="pill ${a.pill}">${a.tag}</span></div>`).join('')}
    </div>

    <div class="sec">今日经营（${fmt(today.salesTotal ?? 0)} 元）</div>
    <div class="kpis">
      <div class="kpi"><div class="l">营业额</div><div class="v g num">¥${fmt(today.salesTotal ?? 0)}</div></div>
      <div class="kpi"><div class="l">毛利额</div><div class="v o num">¥${fmt(today.profitTotal ?? 0)}</div></div>
      <div class="kpi"><div class="l">订单数</div><div class="v num">${today.orderCount ?? 0} 单</div></div>
      <div class="kpi"><div class="l">客单价</div><div class="v num">¥${fmt(avgTicket)}</div></div>
    </div>

    <div class="sec">💰 今日分红</div>
    <div class="div-card">
      <b>分红池</b>
      <div class="dv-line"><span>计提（净利 5% 入池）</span><b class="num">¥${fmt(ov.dividend?.poolTotal ?? 0)}</b></div>
      <div class="dv-line"><span>会员已抵扣</span><b class="num">¥${fmt(ov.dividend?.givenTotal ?? 0)}</b></div>
      <div class="hint" style="margin-top:8px">分红是消费让利回馈：按实付计提 · 仅限消费抵用 · 有封顶与时效（合规口径已锁定）</div>
    </div>

    <div class="sec">快捷入口</div>
    <div class="egrid">
      <button class="e-card" id="eApprove"><div class="eic">✅</div><b>审批 <span class="pill red" id="eApproveN" style="display:none"></span></b><small>退货 / 入库 / 报损审核</small></button>
      <button class="e-card" id="eReports"><div class="eic">📈</div><b>报表中心</b><small>日报 / 周报 / ABC</small></button>
      <button class="e-card" id="eAi"><div class="eic">🤖</div><b>AI 模型</b><small id="eAiSub">查看训练与版本</small></button>
      <button class="e-card" id="eCam"><div class="eic">🏪</div><b>远程监控</b><small>收银台摄像头（授权）</small></button>
    </div>`;

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
    const breaks = [];
    for (let i = 1; i <= 5; i++) breaks.push(vals[Math.min(vals.length - 1, Math.floor((vals.length - 1) * i / 5))] || 0);
    const level = v => { const n = Number(v) || 0; if (n <= 0) return 0; for (let i = 0; i < breaks.length; i++) if (n <= breaks[i]) return i + 1; return 5; };
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
  const speakAnswer = txt => { if (window.PwaTTS && txt) PwaTTS.say(txt, { rate: 1.02 }); };
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
    $('#qaBox').innerHTML = `<div class="empty">思考中：${esc(q)}…</div>`;
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
  const rows = [];
  (p.items || []).forEach(i => rows.push([esc(i.name || ('商品' + i.productId)), n0(i.stock ?? i.qty ?? 0), n0(i.suggestQty ?? i.qtyWindow ?? 0), esc(i.suggest || i.reason || '')]));
  (p.members || []).forEach(m => rows.push([esc(m.name || ('会员' + m.id)), '余额 ¥' + money(m.balance), '沉默 ' + (m.silentDays || 30) + ' 天', '']));
  (p.expand || []).forEach(x => rows.push([esc(x.category) + '（扩容）', '收入占比 ' + x.revShare + '%', 'SKU 占比 ' + x.skuShare + '%', '建议扩充该品类 SKU']));
  v.innerHTML = `
    <div class="card">
      <div class="kv"><span class="k">域 / 状态</span><span class="v">${esc(arg.domain)} · ${esc(arg.status)}</span></div>
      <div class="kv"><span class="k">置信度</span><span class="v num">${arg.confidence ? Math.round(Number(arg.confidence) * 100) + '%' : '—'}</span></div>
      ${arg.reason && arg.reason.rule ? `<div class="kv"><span class="k">依据</span><span class="v" style="font-size:12.5px">${esc(arg.reason.rule)}${arg.reason.note ? ' · ' + esc(arg.reason.note) : ''}</span></div>` : ''}
    </div>
    <div class="sec">建议明细</div>
    ${rows.length ? tbl(['名称', '库存/余额', '建议量/占比', '说明'], rows) : '<div class="empty">无明细</div>'}
    ${arg.status === '待处理' ? `<div class="acts">
      <button class="btn bad" id="sgRej">✖ 否决</button>
      <button class="btn" id="sgExec">✔ 执行</button>
    </div>
    <div class="hint">执行 = 补货域生成采购单、其余域标记留痕；否决请填原因（训练信号）。</div>`
      : '<div class="hint">该建议已处理。</div>'}`;
  if (arg.status === '待处理') {
    $('#sgExec').onclick = async () => {
      if (!confirm('确认执行该建议？')) return;
      try { const r = await call('POST', `/brain/suggestions/${arg.id}/execute`, {}); toast('✅ ' + (r.note || '已执行')); stack.length = 0; openTab('reports'); }
      catch (e) { toast(e.message); }
    };
    $('#sgRej').onclick = async () => {
      const reason = prompt('否决原因（必填，留痕作训练信号）：') || '';
      if (!reason.trim()) { toast('否决必须填写原因'); return; }
      try { await call('POST', `/brain/suggestions/${arg.id}/reject`, { reason: reason.trim() }); toast('已否决'); stack.length = 0; openTab('reports'); }
      catch (e) { toast(e.message); }
    };
  }
};

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
    }).join('')}`;
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
})();

// ── VQA 体检项：老板端消息中心视图（View 声明后挂载）──
View.notices = async function (v) {
  const items = await call('GET', '/finance/notices');
  const list = Array.isArray(items) ? items : (items.items || items.list || []);
  if (!list.length) { v.innerHTML = '<div class="empty">暂无消息；设备缺纸、秤离线、对账差异等告警会出现在这里</div>'; return; }
  v.innerHTML = list.map(n => {
    const unread = !(n.read_by || []).length;
    const when = String(n.created_at || '').replace('T', ' ').slice(5, 16);
    return `<div class="card" style="margin-bottom:10px;${unread ? 'border-left:3px solid var(--red);' : 'opacity:.62;'}">
      <div style="font-weight:700;font-size:13.5px">${esc(n.text || n.title || n.kind)}${unread ? ' <span style="color:var(--red);font-size:11px">未读</span>' : ''}</div>
      <div style="color:var(--ink-2);font-size:11.5px;margin-top:2px">${esc(when)} · ${esc(n.kind || '')}
        ${unread ? `<button class="btn ghost" style="width:auto;padding:3px 12px;font-size:11.5px;float:right" data-nid="${n.id}">标记已读</button>` : ''}
      </div></div>`;
  }).join('');
  v.querySelectorAll('[data-nid]').forEach(btn => btn.onclick = async () => {
    try { await call('POST', `/finance/notices/${btn.dataset.nid}/read`, {}); renderTab(); refreshNoticesBadge(); }
    catch (e) { toast(e.message); }
  });
};
setInterval(refreshNoticesBadge, 60000);
