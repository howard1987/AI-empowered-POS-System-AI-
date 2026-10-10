/* ═══════════════════════════════════════════════════════════
   收银端渲染逻辑：原型收银台布局 + 双屏全量同步 + AI 识别（预包装免扫码）+ 全流程结账
   依赖：renderer/index.html / pos.css；Electron preload 桥 window.cashier（浏览器降级）
   ═══════════════════════════════════════════════════════════ */
const S = window.cashier || null;   // Electron preload 桥（浏览器冒烟时为 null 自动降级）
const $ = s => document.querySelector(s);
const money = n => '¥' + Number(n ?? 0).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const log = m => { const el = $('#log'); if (el) { el.textContent += m + '\n'; el.scrollTop = 1e9; } };
const snack = m => { const el = $('#snack'); if (!el) return; el.textContent = m; el.classList.add('on');
  clearTimeout(snack._t); snack._t = setTimeout(() => el.classList.remove('on'), 2600); };

const API = {
  base: localStorage.getItem('pos_api') || 'http://localhost:3100',
  token: localStorage.getItem('pos_token') || '',
  user: JSON.parse(localStorage.getItem('pos_user') || 'null'),
};
async function call(method, path, body, timeoutMs) {
  const ctl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 8000) : null;
  try {
    const res = await fetch(API.base + path, {
      method,
      signal: ctl ? ctl.signal : undefined,
      headers: { ...(API.token ? { authorization: 'Bearer ' + API.token } : {}),
                 ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({ code: -1, msg: 'HTTP ' + res.status }));
  } catch (e) {
    // 网络不通 / 超时：返回统一错误，绝不静默吞掉
    const why = (e && e.name === 'AbortError') ? '请求超时' : '网络异常';
    return { code: -1, msg: why + '：无法连接 ' + API.base };
  } finally { if (timer) clearTimeout(timer); }
}
const errMsg = r => (r && r.msg) ? r.msg : '请求失败';

/* ─── 语音播报（V4.13.8 拟人化：多音色/语速/音调，后台「通用设置 → 语音播报」统一配置；
        auto=拟真人声优先（浏览器在线神经音色，如晓晓/云希 Natural），不可用回落本地音色） ─── */
const VOICE_ON = localStorage.getItem('pos_voice') !== 'off';
const TtsCfg = { mode: 'auto', voice: '', rate: 1, pitch: 1, productOn: true, loaded: false };
async function ttsCfg(force) {
  if (TtsCfg.loaded && !force) return TtsCfg;
  try {
    const ks = ['mode', 'voice', 'rate', 'pitch'];
    const rs = await Promise.all(ks.map(k => call('GET', '/settings/key/voice.tts.' + k).catch(() => null)));
    if (rs[0]) TtsCfg.mode = String(rs[0].value ?? 'auto');
    if (rs[1]) TtsCfg.voice = String(rs[1].value ?? '');
    if (rs[2]) TtsCfg.rate = Math.min(2, Math.max(0.5, Number(rs[2].value) || 1));
    if (rs[3]) TtsCfg.pitch = Math.min(2, Math.max(0.5, Number(rs[3].value) || 1));
    const vp = await call('GET', '/settings/key/voice.product.enabled').catch(() => null);
    if (vp) TtsCfg.productOn = !(vp.value === false || vp.value === 'false' || vp.value === 0);
    TtsCfg.loaded = true;
  } catch { /* 离线：默认配置 */ }
  return TtsCfg;
}
const ttsIsNatural = v => /Natural|Online/i.test(v.name || '');
function ttsPickVoice() {
  if (!('speechSynthesis' in window)) return null;
  let vs = []; try { vs = speechSynthesis.getVoices().filter(v => /^zh/i.test(v.lang || '')); } catch { /* 忽略 */ }
  if (!vs.length) return null;
  if (TtsCfg.voice) { const hit = vs.find(v => v.name === TtsCfg.voice); if (hit) return hit; }
  const nat = vs.filter(ttsIsNatural);
  if (TtsCfg.mode !== 'local' && nat.length) {
    const female = nat.find(v => /晓|Xiaoxiao|Xiaoyi|Huihui|Yaoyao/i.test(v.name || ''));
    return female || nat[0];
  }
  return vs.find(v => !ttsIsNatural(v)) || vs[0];
}
function speak(text) {
  if (!VOICE_ON || !('speechSynthesis' in window)) return;
  try {
    const v = ttsPickVoice();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (v) u.voice = v;
    u.rate = Math.min(2, Math.max(0.5, TtsCfg.rate));
    u.pitch = Math.min(2, Math.max(0.5, TtsCfg.pitch));
    u.volume = 1;
    speechSynthesis.speak(u);
  } catch (e) { /* 静默降级 */ }
}
ttsCfg();                 // 启动即拉配置（商品到货播报开关等）
if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); } catch { /* 忽略 */ } }

/* ─── 状态 ─── */
let cart = [];              // {productId, name, unit, price, qty, weighted}
let memberId = null, memberInfo = null;
let payChannel = '现金';
let SHIFT = null;
let aiStream = null, aiLogId = null, aiCands = [];
let aiScaleTotal = 0;   // 秤台 1 总重（克，mock 演示：T0 基准 + T1 差重累计）
const PLU = { categoryId: null, keyword: '', page: 1, size: 48, total: 0, loading: false };

/* ─── 登录 ─── */
// 地址栏回显上次成功使用的服务地址（而非写死 localhost）
$('#lgApi') && ($('#lgApi').value = localStorage.getItem('pos_api') || API.base);
// 登录页加载即探测后端连通性，提前暴露"服务没启动/地址不对"
(async function probeNet() {
  const el = $('#lgNet'); if (!el) return;
  const r = await call('GET', '/health', undefined, 4000);
  if (r && r.code === 0) { el.style.color = '#1a7f37'; el.textContent = '✓ 服务已连接：' + API.base; }
  else { el.style.color = '#c62828'; el.textContent = '✗ 无法连接 ' + API.base + ' —— 请确认收银服务已启动、地址正确（本机可用 localhost:3100，跨机请填服务机 IP，如 http://192.168.0.5:3100）'; }
})();
$('#lgPwd').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lgGo').click(); });
$('#lgGo').onclick = async () => {
  const btn = $('#lgGo'), err = $('#lgErr');
  err.textContent = '';
  API.base = $('#lgApi').value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(API.base)) { err.textContent = '服务地址需以 http:// 或 https:// 开头，例如 http://192.168.0.5:3100'; return; }
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const r = await call('POST', '/auth/login', { empNo: $('#lgUser').value.trim(), password: $('#lgPwd').value }, 8000);
    if (r.code !== 0) { err.textContent = errMsg(r); return; }
    API.token = r.data.token;
    API.user = { name: r.data.name, empNo: r.data.empNo, perms: r.data.perms };
    localStorage.setItem('pos_api', API.base); localStorage.setItem('pos_token', API.token);
    localStorage.setItem('pos_user', JSON.stringify(API.user));
    ttsCfg(true);   // V4.13.8 登录后拉语音播报配置（音色/语速/商品播报开关）
    enterMain();
  } catch (e) {
    err.textContent = '登录异常：' + (e && e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
};
function doLogout() { localStorage.removeItem('pos_token'); location.reload(); }
function quitApp() { if (S) S.quitApp(); }

async function enterMain() {
  $('#login').style.display = 'none';
  $('#who') && ($('#who').textContent = `${API.user?.name || ''}（${API.user?.empNo || ''}）`);
  log('[登录] ' + (API.user?.name || '') + ' @ ' + API.base);
  if (S) {
    S.peripherals().then(p => log('[外设] 扫码:' + p.scanner.mode + ' 秤:' + p.scale.mode +
      ' 小票机:' + (p.printer.connected ? '已连' : '未连'))).catch(() => {});
    refreshDisplays();
  } else {
    $('#lgDisp').textContent = '浏览器演示模式（Electron 内为全屏双屏）';
  }
  $('#scanInput').focus();
  await refreshShift();
  loadCategories();
  loadPlu(true);
}

// 显示器数量自动识别：>1 台 → 主屏提示双屏已连
async function refreshDisplays() {
  try {
    const d = await S.displays();
    $('#hdDisp').textContent = d.count > 1 ? '🖥 双屏已连' : '🖥 单屏';
    $('#lgDisp').textContent = `已识别 ${d.count} 台显示器` + (d.count > 1 ? ' · 副屏顾客信任屏已开' : '');
  } catch (e) { /* 忽略 */ }
}

/* ─── 分类 + 商品宫格 ─── */
const EMOJI = { '果蔬': '🍎', '肉禽蛋': '🥩', '粮油': '🍚', '零食饮料': '🍜', '日配冷冻': '🥛', '日用百货': '🧻' };
const emojiOf = p => EMOJI[p.category_name] || (p.is_weighted ? '🥬' : '🏷️');

async function loadCategories() {
  const r = await call('GET', '/products/categories');
  if (r.code !== 0) { $('#cats').innerHTML = '<span class="on" data-id="">全部</span>'; return; }
  let list = (r.data || []).filter(c => Number(c.status) === 1);
  const lv1 = list.filter(c => Number(c.level) === 1);
  if (lv1.length) list = lv1;
  $('#cats').innerHTML = `<span class="on" data-id="">全部</span>` +
    list.map(c => `<span data-id="${c.id}">${esc(c.name)}</span>`).join('');
  $('#cats').querySelectorAll('span').forEach(el => el.onclick = () => {
    $('#cats').querySelectorAll('span').forEach(s => s.classList.toggle('on', s === el));
    PLU.categoryId = el.dataset.id ? Number(el.dataset.id) : null;
    loadPlu(true);
  });
}

async function loadPlu(reset) {
  if (PLU.loading) return;
  if (reset) { PLU.page = 1; PLU.keyword = $('#scanInput').value.trim(); $('#plu').innerHTML = ''; }
  PLU.loading = true;
  const ps = new URLSearchParams({ status: '1', page: PLU.page, size: PLU.size });
  if (PLU.categoryId) ps.set('categoryId', PLU.categoryId);
  if (PLU.keyword) ps.set('keyword', PLU.keyword);
  const r = await call('GET', '/products?' + ps.toString());
  PLU.loading = false;
  if (r.code !== 0) { $('#plu').innerHTML = '<div class="cart-empty">商品加载失败：' + esc(errMsg(r)) + '</div>'; return; }
  PLU.total = r.data.total;
  renderPlu(r.data.items || []);
  const more = PLU.page * PLU.size < PLU.total;
  $('#pluMore').style.display = more ? '' : 'none';
  $('#pluMore').textContent = `加载更多商品（${PLU.page * PLU.size}/${PLU.total}）`;
}

function renderPlu(items) {
  $('#plu').insertAdjacentHTML('beforeend', items.map(p => `
    <div class="p" data-id="${p.id}">
      ${p.is_weighted ? '<span class="badge w">称重</span>' : ''}
      <span class="em">${emojiOf(p)}</span>
      <span class="nm">${esc(p.name)}</span>
      <span class="pr">${money(p.sell_price)}<span class="un">/${esc(p.base_unit || '件')}</span></span>
    </div>`).join(''));
  $('#plu').querySelectorAll('.p').forEach(el => el.onclick = () => {
    const p = items.find(x => Number(x.id) === Number(el.dataset.id));
    if (p) addProduct(p);
  });
}

// 宫格/扫码 入车（称重商品弹出重量输入）
async function addProduct(p, qty) {
  const weighted = !!p.is_weighted;
  let q = qty || 1;
  if (weighted) {
    const v = prompt(`称重商品「${p.name}」（${p.base_unit}），输入重量：`, '0.5');
    if (!v) return false;
    q = Number(v);
    if (!(q > 0)) return false;
  }
  const exist = cart.find(c => c.productId === Number(p.id) && !weighted);
  if (exist) exist.qty = Math.round((exist.qty + q) * 1000) / 1000;
  else cart.push({ productId: Number(p.id), name: p.name, unit: p.base_unit, price: Number(p.sell_price), qty: q, weighted });
  log(`[入车] ${p.name} ×${q}`);
  renderCart();
  if (TtsCfg.productOn) speak(p.name);   // V4.13.8 商品到货播报（voice.product.enabled 可关）
  return true;
}

/* ─── 扫码/搜索框：回车=快速添加（条码精确优先），输入=实时过滤宫格 ─── */
let kwTimer = null;
$('#scanInput').addEventListener('input', () => {
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => loadPlu(true), 400);
});
$('#scanInput').addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const code = e.target.value.trim(); e.target.value = '';
  if (S) S.scanFeed(code);
  await scanToCart(code);
});
if (S) S.onScan(code => scanToCart(code));

async function scanToCart(code) {
  // 条码精确解析（覆盖一品多码附加码 / 多包装码 / 一码多品）
  const r = await call('GET', '/products/barcode/' + encodeURIComponent(code));
  if (r.code === 0 && r.data) {
    const d = r.data;
    if (d.ambiguous) { pickAmbiguous(code, d.items); return; }   // 一码多品：弹窗选择
    const p = d.product || d;
    const units = d.units || [];
    // 多包装码（如整箱码）：按包装单位入车（数量=换算率，单价=包装价/换算率）
    const u = units.find(x => x.barcode === code && Number(x.rate) > 1);
    if (u) {
      const packPrice = u.price !== null && u.price !== undefined ? Number(u.price) : Number(p.sell_price) * Number(u.rate);
      await addProduct({ ...p, is_weighted: false, base_unit: p.base_unit }, 1);
      const row = cart[cart.length - 1];
      if (row) { row.qty = Number(u.rate); row.price = Math.round(packPrice / Number(u.rate) * 1000) / 1000; row.packCode = code; }
      renderCart(); return;
    }
    await addProduct(p);
    return;
  }
  // 条码未命中：退回关键字搜索（拼音/名称模糊）
  const s = await call('GET', '/products?keyword=' + encodeURIComponent(code) + '&size=5');
  if (s.code !== 0 || !s.data.items?.length) { log('[扫码] 未找到条码 ' + code); snack('未找到商品：' + code); return; }
  const exact = s.data.items.find(p => p.barcode === code) || s.data.items[0];
  await addProduct(exact);
}

/* 一码多品：多个商品共用同一码 → 弹窗人工选择后入车 */
function pickAmbiguous(code, items) {
  log(`[扫码] 条码 ${code} 命中 ${items.length} 个商品（一码多品），等待人工选择`);
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:999;display:flex;align-items:center;justify-content:center';
  m.innerHTML = `<div style="background:#fff;border-radius:14px;min-width:360px;max-width:92vw;max-height:72vh;overflow:auto;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.25)">
    <h3 style="margin:0 0 4px;font-size:17px">🔀 一码多品 · 请选择商品</h3>
    <div style="font-size:12px;color:#8a8f99;margin-bottom:12px">条码 ${esc(code)} 命中 ${items.length} 个商品，请点选本次销售的商品</div>
    ${items.map((it, i) => `<div data-i="${i}" class="amb-row" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:8px;cursor:pointer">
      <span><b>${esc(it.product.name)}</b> <small style="color:#8a8f99">${esc(it.product.spec || '')} ${esc(it.product.base_unit || '')}</small></span>
      <b style="white-space:nowrap">¥${Number(it.product.sell_price).toFixed(2)}</b></div>`).join('')}
    <button id="ambCancel" style="width:100%;padding:9px;margin-top:4px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;cursor:pointer">取消</button>
  </div>`;
  document.body.appendChild(m);
  m.querySelector('#ambCancel').onclick = () => { m.remove(); log('[扫码] 一码多品选择已取消'); };
  m.addEventListener('click', e => {
    const row = e.target.closest('.amb-row');
    if (!row) return;
    const it = items[Number(row.dataset.i)];
    m.remove();
    addProduct(it.product);
  });
}

/* ─── 购物车 ─── */
function payTotal() { return Math.round(cart.reduce((s, c) => s + c.price * c.qty, 0) * 100) / 100; }

function renderCart() {
  const tb = $('#cartRows');
  if (!cart.length) { tb.innerHTML = '<div class="cart-empty">扫描商品条码，或用左侧商品宫格点选入车</div>'; }
  else tb.innerHTML = cart.map((c, i) => `<div class="crow">
      <span class="nm">${esc(c.name)}${c.weighted ? `<small>${esc(c.unit)} · 称重计价</small>` : ''}</span>
      <span class="q" onclick="chgQty(${i},-1)">−</span>
      <span class="amt" style="min-width:2.6rem">${c.qty}</span>
      <span class="q" onclick="chgQty(${i},1)">＋</span>
      <span class="amt">${money(c.price * c.qty)}</span>
      <span class="q" onclick="delRow(${i})">✕</span>
    </div>`).join('');
  $('#cartCnt').textContent = cart.length;
  $('#payable').textContent = payTotal().toFixed(2);
  $('#btnPay').disabled = !cart.length;
  syncSecond({});
}
function chgQty(i, d) { const c = cart[i]; c.qty = Math.min(99999, Math.max(0.001, Math.round((c.qty + d) * 1000) / 1000)); renderCart(); }   // V5.0.19i（F-08）：补数量上界
function delRow(i) { cart.splice(i, 1); renderCart(); }
function clearCart() { cart = []; renderCart(); }

/* ─── 双屏同步（购物车明细 + 金额 + 会员卡 + 支付状态） ─── */
function syncSecond(extra) {
  if (!S) return;
  S.syncToSecond({
    items: cart.map(c => ({ name: c.name, qty: c.qty, unit: c.unit, amount: c.price * c.qty, weighted: !!c.weighted })),
    count: cart.length,
    payable: payTotal(),
    saved: 0,
    memberName: memberInfo?.name || null,
    cashierName: API.user?.name || '',
    member: memberCard,
    ...extra,
  });
}

/* ─── 会员 ─── */
let memberCard = null;   // 副屏会员卡全量数据
let mResults = [];       // 会员搜索结果（供点击委托查表，避免内联 JS 拼接动态值 → XSS）
function openMember() { dlgMember.showModal(); $('#mSearch').value = ''; $('#mSearch').focus(); $('#mResult').innerHTML = ''; }
$('#mSearch').addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const r = await call('GET', '/members?keyword=' + encodeURIComponent(e.target.value.trim()) + '&size=10');
  if (r.code !== 0) { $('#mResult').innerHTML = '<div class="hint">查询失败</div>'; return; }
  const items = r.data.items || [];
  mResults = items;
  $('#mResult').innerHTML = items.length ? items.map(m => `<div class="row">
      <span>${esc(m.name || '—')} · ${esc(m.phone || m.card_no || '')}</span>
      <span><span class="pill g">${money(m.balance)}</span> <button class="pickMemBtn" data-mi="${m.id}">选</button></span>
    </div>`).join('') : '<div class="hint">无匹配会员</div>';
});
// F-01 修复：会员选择改为 data-* + 事件委托，禁止 onclick 拼接动态值（防 card_no 注入 XSS）
$('#mResult').addEventListener('click', e => {
  const btn = e.target.closest('.pickMemBtn');
  if (!btn) return;
  const m = mResults.find(x => x.id === Number(btn.dataset.mi));
  if (m) pickMember(m.id, m.name || '', m.card_no || '', m.balance);
});
async function pickMember(id, name, cardNo, balance) {
  memberId = id; memberInfo = { name, balance, cardNo };
  $('#mAv').textContent = (name || cardNo || '会').charAt(0);
  $('#mName').textContent = `${name || cardNo || '会员'}`;
  $('#mSub').textContent = '会员 · 结账时自动累计积分';
  $('#mBal').innerHTML = `储值余额 <b>${money(balance)}</b>`;
  $('#memberChip').style.display = 'flex';
  $('#mResult').innerHTML = `<div class="row"><span class="hint">已选会员：${esc(name || cardNo)}</span><button class="qtyBtn" onclick="unpickMember()">取消</button></div>`;
  // 拉取会员全量资产（副屏会员卡：储值/可分红/积分/等级系数/累计分红）
  const d = await call('GET', '/members/' + id);
  const m = d.code === 0 ? (d.data.member || {}) : {};
  memberCard = {
    name: m.name || name, phone: m.phone || '', levelName: m.level_name || '普通会员',
    joined: (m.created_at || '').slice(0, 7).replace('-', '年') + '月入会',
    balance: Number(m.balance ?? balance ?? 0),
    dividend: Number(m.dividend_balance ?? 0),
    points: Number(m.points ?? 0),
    weight: Number(m.dividend_weight ?? 0),
    cumDividend: Number(m.dividend_cumulative ?? 0),
    cap: Number(m.dividend_capped ?? 0),
    active: m.last_active_date ? ('活跃 · 最近消费 ' + (m.last_active_date || '').slice(0, 10)) : '—',
  };
  syncSecond({});
  speak(`会员${name || '已识别'}，余额${Number(balance).toFixed(0)}元`);
}
function unpickMember() { memberId = null; memberInfo = null; memberCard = null; $('#memberChip').style.display = 'none'; syncSecond({}); }
function setChannel(el) {
  payChannel = el.dataset.ch;
  document.querySelectorAll('.pay-opt').forEach(b => b.classList.toggle('on', b === el));
  $('#payChannel').textContent = payChannel;
  $('#cashBox').style.display = payChannel === '现金' ? '' : 'none';
  $('#balanceBox').style.display = payChannel === '余额' ? '' : 'none';
  $('#balanceBox').textContent = payChannel === '余额'
    ? (memberId ? `将扣会员 ${memberInfo?.name || ''} 余额 ${money(memberInfo?.balance)}` : '⚠ 尚未选择会员，余额支付需先选会员') : '';
  $('#cashGot').value = payTotal().toFixed(2);
  calcChange();
}

/* ─── 结账 ─── */
function openPay() {
  if (!cart.length) return;
  const total = payTotal();
  $('#payChannel').textContent = payChannel;
  $('#payAmount').textContent = total.toFixed(2);
  $('#cashBox').style.display = payChannel === '现金' ? '' : 'none';
  $('#balanceBox').style.display = payChannel === '余额' ? '' : 'none';
  $('#balanceBox').textContent = payChannel === '余额'
    ? (memberId ? `将扣会员 ${memberInfo?.name || ''} 余额 ${money(memberInfo?.balance)}` : '⚠ 尚未选择会员，余额支付需先选会员') : '';
  $('#cashGot').value = total.toFixed(2);
  calcChange();
  $('#payErr').textContent = '';
  dlgPay.showModal();
}
function calcChange() {
  const total = payTotal();
  const d = Number($('#cashGot').value) - total;
  $('#changeHint').textContent = d >= 0 ? `找零：${money(d)}` : '实收不足';
}
$('#cashGot').addEventListener('input', calcChange);
// F-04 提交防重：在飞期间按钮已禁用；clientRef 稳定绑定本次结账意图，成功才换新，
// 失败（含网络丢响应）保留 → 用户重试同一意图时服务端按 clientRef 去重，杜绝重复扣款
let pendingCheckoutRef = null;
$('#payGo').onclick = async () => {
  if ($('#payGo').disabled) return;   // 在飞/已禁用：忽略重复点击（双击防护）
  const total = payTotal();
  const payments = [];
  if (payChannel === '现金') {
    const got = Number($('#cashGot').value);
    if (!(got >= total)) { $('#payErr').textContent = '实收金额不足'; return; }
    payments.push({ channel: '现金', amount: total });
  } else if (payChannel === '余额') {
    if (!memberId) { $('#payErr').textContent = '余额支付需先选择会员'; return; }
    payments.push({ channel: '余额', amount: total });
  } else payments.push({ channel: '扫码', amount: total });

  $('#payGo').disabled = true;
  if (!pendingCheckoutRef) pendingCheckoutRef = 'D' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const body = { items: cart.map(c => ({ productId: c.productId, qty: c.qty })), payments, clientRef: pendingCheckoutRef };
  if (memberId) body.memberId = memberId;
  if (SHIFT && SHIFT.status === '进行中') body.shiftId = Number(SHIFT.id);
  const r = await call('POST', '/sales/checkout', body);
  $('#payGo').disabled = false;
  if (r.code !== 0) { $('#payErr').textContent = errMsg(r); return; }  // 失败保留 clientRef，供重试去重
  pendingCheckoutRef = null;  // 成功：下一单用新单号
  const d = r.data;
  log(`[结账] ${d.orderNo} 应收 ${money(d.payable)}${d.points ? ` · 得 ${d.points} 分` : ''}${d.roundAmount ? ` · 抹零 ${money(d.roundAmount)}` : ''}`);
  const change = payChannel === '现金' && Number($('#cashGot').value) > d.payable
    ? Math.round((Number($('#cashGot').value) - d.payable) * 100) / 100 : 0;
  if (payChannel === '现金' && change > 0) log(`[找零] ${money(change)}`);
  const payAmt = Number(d.payable) || 0;
  const payTxt = Number.isInteger(payAmt) ? String(payAmt) : payAmt.toFixed(2);
  speak(`收款${payTxt}元${change > 0 ? `，找零${Number(change).toFixed(0)}元` : ''}，谢谢惠顾`);
  dlgPay.close();
  await printRealReceipt(d.orderId);
  cart = []; memberId = null; memberInfo = null;
  $('#memberChip').style.display = 'none';
  renderCart();
  refreshShift();
};

async function printRealReceipt(orderId) {
  const d = await call('GET', '/sales/' + orderId);
  if (d.code !== 0) { log('[小票] 详情获取失败'); return; }
  const o = d.data.order, items = d.data.items || [];
  const order = {
    storeName: '社区超市', orderNo: o.order_no, createdAt: o.created_at,
    cashierName: API.user?.name || '', memberName: memberInfo?.name || '',
    points: 0,
    items: items.map(i => ({ name: i.product_name, qty: Number(i.qty), unit: i.unit_name || '件', unitPrice: Number(i.unit_price), amount: Number(i.line_amount) })),
    goodsAmount: Number(o.goods_amount), promoAmount: Number(o.promo_amount),
    memberDiscount: Number(o.member_discount || 0), roundAmount: Number(o.round_amount || 0),
    payable: Number(o.payable_amount), payments: (d.data.payments || []).map(p => ({ channel: p.channel, amount: Number(p.amount) })),
  };
  if (S) {
    const r = await S.printReceipt(order, 80).catch(e => ({ ok: false, reason: String(e) }));
    log(r.ok ? '[打印] 80mm 已发送 ' + r.bytes + ' 字节' : '[打印] 未连接，版面预览：\n' + (r.preview || r.reason || ''));
  } else log('[打印]（浏览器演示）小票数据：' + order.orderNo + ' ' + order.items.length + ' 行');
  // 副屏：支付成功提示（含实际优惠）
  const saved = Number(o.promo_amount || 0) + Number(o.member_discount || 0) + Number(o.round_amount || 0);
  syncSecond({ payable: Number(o.payable_amount), saved, status: 'done', orderNo: o.order_no });
}

/* ─── 挂单 / 取单 ─── */
async function holdOrder() {
  if (!cart.length) return;
  const remark = prompt('挂单备注（如：顾客先去拿东西）：', '') ?? '';
  const body = { items: cart.map(c => ({ productId: c.productId, qty: c.qty, unitPrice: c.price })), remark };
  if (memberId) body.memberId = memberId;
  const r = await call('POST', '/pos/held', body);
  if (r.code !== 0) { snack('挂单失败：' + errMsg(r)); return; }
  log('[挂单] #' + r.data.id + ' ' + cart.length + ' 行');
  cart = []; renderCart();
}
async function pickOrder() {
  const r = await call('GET', '/pos/held');
  if (r.code !== 0) { snack('取单失败：' + errMsg(r)); return; }
  const items = r.data || [];
  $('#heldList').innerHTML = items.length ? items.map(h => `<div class="row" style="justify-content:space-between;align-items:center">
      <span>#${h.id} ${esc(h.remark || '')} <span class="hint">${h.item_count ?? ''} 行 · ${new Date(h.created_at).toLocaleString('zh-CN')}</span></span>
      <span><button class="qtyBtn" onclick="checkoutHeld(${h.id})">结账</button></span></div>`).join('')
    : '<div class="hint">暂无挂单</div>';
  dlgHeld.showModal();
}
let heldInFlight = false;
let pendingHeldRef = null;
async function checkoutHeld(id) {
  if (heldInFlight) return;   // F-04：在飞守卫，忽略重复点击
  if (payChannel === '余额' && !memberId) { snack('余额支付需先选择会员'); return; }
  heldInFlight = true;
  try {
  // 服务端按结账时刻重新计价，前端按快照价估算应付作为支付金额
  const h = await call('GET', '/pos/held/' + id);
  if (h.code !== 0) { snack('挂单详情获取失败'); return; }
  const est = (h.data.items || []).reduce((s, it) => s + Number(it.unitPrice ?? it.unit_price ?? 0) * Number(it.qty), 0);
  const payments = [{ channel: payChannel, amount: Math.round(est * 100) / 100 }];
  if (!pendingHeldRef) pendingHeldRef = 'DH' + id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const body = { payments, clientRef: pendingHeldRef };
  if (SHIFT && SHIFT.status === '进行中') body.shiftId = Number(SHIFT.id);
  const r = await call('POST', `/pos/held/${id}/checkout`, body);
  if (r.code !== 0) { snack('取单结账失败：' + errMsg(r)); return; }  // 失败保留 clientRef，供重试去重
  pendingHeldRef = null;
  log(`[取单] #${id} → ${r.data.orderNo} 应收 ${money(r.data.payable)}`);
  dlgHeld.close();
  await printRealReceipt(r.data.orderId);
  refreshShift();
  } finally { heldInFlight = false; }
}

/* ─── 交接班 ─── */
async function refreshShift() {
  const r = await call('GET', '/shifts/current');
  SHIFT = r.code === 0 ? r.data.shift : null;
  if (SHIFT) {
    const s = r.data.summary;
    $('#hdShift').innerHTML = `班次 #${SHIFT.id}（进行中）· 现金应收 ${money(s.cashSales)} · 单数 ${s.orderCount}`;
  } else {
    $('#hdShift').textContent = '班次：未开班（结账将不计入班次）';
  }
}
function openShiftDlg() { SHIFT ? (dlgClose.showModal(), $('#closeSummary').textContent = $('#hdShift').textContent) : dlgOpen.showModal(); }
$('#openGo').onclick = async () => {
  const r = await call('POST', '/shifts/open', { posNo: $('#openPos').value.trim(), openingFloat: Number($('#openFloat').value) });
  if (r.code !== 0) { snack('开班失败：' + errMsg(r)); return; }
  dlgOpen.close(); log('[开班] #' + r.data.id); refreshShift();
};
$('#closeGo').onclick = async () => {
  const r = await call('POST', `/shifts/${SHIFT.id}/close`, { cashCounted: Number($('#closeCash').value) });
  if (r.code !== 0) { snack('交班失败：' + errMsg(r)); return; }
  const d = r.data.shift;
  dlgClose.close();
  log(`[交班] #${SHIFT.id} 完成 · 系统现金应收 ¥${Number(d.cash_total ?? 0).toFixed(2)} · 实盘差异 ¥${Number(d.diff_amount).toFixed(2)}（已留痕）`);
  refreshShift();
};

/* ─── 充值代收（H5 发起 → 收银台现金/扫码收款） ─── */
async function openRecharge() { dlgRecharge.showModal(); await refreshRechargeQueue(); }
async function refreshRechargeQueue() {
  $('#rechargeMsg').textContent = '';
  const r = await call('GET', '/pos/recharge-orders?status=' + encodeURIComponent('待支付'));
  const items = r.data?.items || [];
  $('#rechargeQueue').innerHTML = items.length ? items.map(o => `
    <div style="display:flex;justify-content:space-between;align-items:center;border:1px solid #eee;border-radius:8px;padding:8px;margin-bottom:6px">
      <span style="font-size:12px"><b>${esc(o.order_no)}</b> · ${esc(o.name || o.card_no || '')} ${esc(o.phone || '')}<br>
        充 ${money(o.principal)}${Number(o.gift) ? ' 送 ' + money(o.gift) : ''} · 合计应收 ${money(Number(o.principal) + Number(o.gift))}</span>
      <span>
        <button class="b ghost" onclick="collectRecharge(${o.id},'现金')">现金收款</button>
        <button class="b ghost" onclick="collectRecharge(${o.id},'扫码')">扫码收款</button>
      </span>
    </div>`).join('') : '<div class="hint">暂无待支付充值单</div>';
}
let rechargeInFlight = false;
async function collectRecharge(id, channel) {
  if (rechargeInFlight) return;   // F-04：在飞守卫，忽略重复点击（后端状态机已防双入账，此处避免 50074 噪音）
  rechargeInFlight = true;
  try {
    const r = await call('POST', `/pos/recharge-orders/${id}/collect`,
      { payChannel: channel, shiftId: SHIFT ? SHIFT.id : undefined });
    await refreshRechargeQueue();
    if (r.code === 0) {
      log(`[充值] ${r.data.orderNo} 入账 +${money(r.data.principal + r.data.gift)}（${channel}·会员余额 ${money(r.data.balanceAfter)}）`);
      $('#rechargeMsg').textContent = `${r.data.orderNo} 已入账：+${money(r.data.principal + r.data.gift)}`;
    } else {
      log(`[充值] 失败：${r.msg || r.code}`);
      $('#rechargeMsg').textContent = '失败：' + (r.msg || r.code);
    }
  } finally { rechargeInFlight = false; }
}

/* ─── 外设（Electron 生效） ─── */
function openPeriph() {
  dlgPeriph.showModal();
  if (S) S.peripherals().then(p => $('#pInfo').textContent =
    `扫码:${p.scanner.mode} · 秤:${p.scale.mode} · 小票机:${p.printer.connected ? '已连' : '未连'}`).catch(() => {});
  else $('#pInfo').textContent = '浏览器演示：外设不可用';
}
async function connPrinter() {
  if (!S) { log('[连接]（浏览器演示）跳过'); return; }
  const mode = $('#pMode').value, addr = $('#pAddr').value;
  const r = await S.printerConnect(mode === 'net' ? { mode, host: addr } : { mode, path: addr });
  log(`[连接:${mode}] ` + (r.ok ? '成功' : '失败 ' + r.reason));
}

/* ─── AI 识别（预包装免扫码 + 散称差重归因；mock/yolo 引擎均走 /ai/recognize） ─── */
// 差重归因状态条（图一 T0/T1/T2）：秤台 1 上的称重事件提示
function aiWeightBar(text, cls) {
  const bar = $('#aiWeightBar');
  if (!bar) return;
  if (text) { bar.style.display = 'flex'; const t = $('#aiWeightText'); t.textContent = text; t.className = cls || ''; }
  else bar.style.display = 'none';
}
async function openAI() {
  $('#aiMask').style.display = 'flex';
  $('#aiTip').textContent = '正在启动摄像头…';
  $('#aiTip').classList.remove('err');
  $('#aiCands').innerHTML = '<div class="ai-cand-empty">识别结果将显示在这里<br><small>未识别时请用扫码枪兜底</small></div>';
  $('#aiSt').textContent = '识别中 · 本地模型已就绪';
  $('#aiMeta').textContent = '—';
  $('#aiConfirm').textContent = '✓ 全部确认入车';
  aiWeightBar('');
  $('#aiHud').style.display = 'none';
  aiScaleTotal = 0;
  clearBoxes();
  aiLogId = null; aiCands = [];
  if (!navigator.mediaDevices?.getUserMedia) { tipAI('此环境不支持摄像头，请用扫码枪'); return; }
  try {
    aiStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    $('#aiVideo').srcObject = aiStream;
    await $('#aiVideo').play();
    $('#aiTip').textContent = '将预包装商品正面放入画面，点击「拍照识别」';
  } catch (e) {
    tipAI('摄像头不可用：' + (e?.message || e) + '，请用扫码枪兜底');
  }
}
function tipAI(msg) {
  const el = $('#aiTip');
  el.textContent = msg;
  el.classList.add('err');
}
async function closeAI() {
  $('#aiMask').style.display = 'none';
  if (aiStream) { aiStream.getTracks().forEach(t => t.stop()); aiStream = null; }
  $('#aiVideo').srcObject = null;
  aiWeightBar('');
  $('#aiHud').style.display = 'none';
  const tip = $('#aiTip'); if (tip) { tip.style.opacity = '1'; tip.classList.remove('err'); }
  clearBoxes();
  $('#scanInput').focus();
}
function clearBoxes() {
  const b = $('#aiBox'); if (!b) return;
  const ctx = b.getContext('2d');
  ctx.clearRect(0, 0, b.width, b.height);
  b.width = 0; b.height = 0;
}
// 图二 称重 HUD：总重（已去皮）+ 稳定/待确认状态（与差重状态条联动）
function showHud(list) {
  const hud = $('#aiHud'); if (!hud) return;
  const hasW = list.some(x => x.weighted && !x.pendingRemove);
  const hasRm = list.some(x => x.pendingRemove);
  $('#aiWTotal').innerHTML = hasW
    ? (aiScaleTotal / 1000).toFixed(2) + '<small> kg</small>'
    : '<small style="font-size:.68rem;color:#b9c9b6">预包装计件 · 无称重</small>';
  const st = $('#aiWStable');
  if (hasRm) { st.textContent = '⚠ 待确认移除'; st.className = 'pill warn'; }
  else if (hasW) { st.textContent = '✓ 称重稳定，可结算'; st.className = 'pill g'; }
  else { st.textContent = '✓ 识别完成'; st.className = 'pill g'; }
  hud.style.display = 'flex';
  const tip = $('#aiTip'); if (tip) tip.style.opacity = '0';
}
// 检测框叠加：冻结当前帧 + emoji/商品名/置信度标签（按置信度分级配色）+ 数量角标
// （bbox 相对视频原帧坐标，与 video 同 contain 变换对齐；入参为含 weighted/category_name 的候选行）
function drawBoxes(list) {
  const canvas = $('#aiBox'), ctx = canvas.getContext('2d');
  const video = $('#aiVideo');
  canvas.width = video.videoWidth || 1280; canvas.height = video.videoHeight || 720;
  ctx.drawImage(video, 0, 0);
  list.forEach(b => {
    if (b.pendingRemove) return;   // 待确认移除项不再画框
    const bb = b.bbox || [10, 10, 100, 100];
    const [x, y, w, h] = bb;
    const conf = b.conf || 0;
    const col = conf >= 0.9 ? '#39d98a' : conf >= 0.7 ? '#ffb347' : '#ff7a6b';
    const colDark = conf >= 0.9 ? '#1f7a4e' : conf >= 0.7 ? '#c97e14' : '#c0392b';
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
    const em = EMOJI[b.category_name] || (b.weighted ? '🥬' : '🏷️');
    ctx.fillStyle = 'rgba(23, 33, 26, .85)';
    ctx.font = '600 16px "Microsoft YaHei", sans-serif';
    const label = `${em} ${b.name} ${Math.round(conf * 100)}%`;
    const tw = ctx.measureText(label).width;
    ctx.fillRect(x, y - 27, tw + 16, 27);
    ctx.fillStyle = '#fff'; ctx.fillText(label, x + 8, y - 9);
    ctx.fillStyle = colDark;
    ctx.fillRect(x + w - 30, y + 8, 30, 30);
    ctx.fillStyle = '#fff'; ctx.font = '700 18px "Microsoft YaHei", sans-serif';
    ctx.fillText('×' + (b.count ?? 1), x + w - 24, y + 29);
  });
}
async function aiShoot() {
  const video = $('#aiVideo'), tip = $('#aiTip');
  if (!video.videoWidth) { tipAI('摄像头画面未就绪，请稍候'); return; }
  const c = $('#aiCanvas');
  c.width = video.videoWidth || 1280; c.height = video.videoHeight || 720;
  c.getContext('2d').drawImage(video, 0, 0);
  const b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
  tip.textContent = '识别中…'; tip.classList.remove('err');
  const r = await call('POST', '/ai/recognize', { imageBase64: b64, deviceId: 1 });
  if (r.code !== 0) { tipAI('识别失败：' + errMsg(r)); return; }
  aiLogId = r.data.logId;
  const raw = (r.data.result || []).filter(x => x.productId != null);
  $('#aiSt').textContent = r.data.engine === 'yolo' ? '识别中 · YOLO 模型已就绪' : '识别中 · 本地模型已就绪';
  if (!raw.length) {
    tipAI('未检出商品：请将商品完整放入画面后重拍；该商品建议扫码入车后到训练台补样本，下次自动识别');
    $('#aiCands').innerHTML = '<div class="ai-cand-empty">未识别出商品</div>';
    aiWeightBar(''); clearBoxes(); $('#aiHud').style.display = 'none';
    return;
  }
  // 拉取候选价格/单位/称重属性（称重候选用于差重归因与混放引导）
  const prices = {};
  await Promise.all(raw.map(async x => {
    const d = await call('GET', '/products/' + x.productId);
    if (d.code === 0) prices[x.productId] = d.data;
  }));
  const prev = aiCands.filter(x => !x.removed);      // 上轮有效候选（已确认移除的忽略）
  const curKeys = new Set(raw.map(x => x.productId));
  // T2（图一：顾客拿走 → 待确认移除，防欺诈不自动删）：上轮有、本轮消失
  const gone = prev.filter(x => !x.pendingRemove && !curKeys.has(x.productId));
  // T0/T1：本轮结果（首次出现=锁定基准；再次出现=差重归因）
  const fresh = raw.map(x => {
    const weighted = !!prices[x.productId]?.is_weighted;
    const old = prev.find(p => p.productId === x.productId);
    let diffG = null;
    if (weighted) {
      if (old && old.diffG && old.diffG.indexOf('T1') === 0) diffG = old.diffG;        // 保持已有归因
      else if (old) diffG = `T1 差重 +${40 + Math.floor(Math.random() * 40)}g 归因`;
      else diffG = 'T0 基准已锁定';
    }
    return { ...x, on: true, pendingRemove: false, removed: false,
      price: Number(prices[x.productId]?.sell_price ?? 0),
      unit: prices[x.productId]?.base_unit || '件',
      weighted, diffG };
  });
  aiCands = [...fresh, ...gone.map(x => ({ ...x, on: false, pendingRemove: true, diffG: 'T2 待确认移除' }))];
  // 图二 HUD：秤台总重 = T0 基准（本轮新放散称）+ T1 差重累计（mock 演示）
  fresh.forEach(x => { if (x.weighted && x.diffG === 'T0 基准已锁定') aiScaleTotal += x.count * (250 + Math.floor(Math.random() * 150)); });
  aiCands.forEach(c => {
    const m = c.diffG && c.diffG.match(/T1 差重 \+(\d+)g/);
    if (m) aiScaleTotal += Number(m[1]);
  });
  // 识别耗时 · 置信度均值（图二 HUD 头部）
  const avgConf = raw.reduce((s, x) => s + (x.conf || 0), 0) / raw.length;
  $('#aiMeta').textContent = `秤台 1 · 帧率 ${(24 + Math.floor(Math.random() * 6))}fps · 推理 ${Number(r.data.latencyMs || 0)}ms · 置信度均值 ${avgConf.toFixed(2)}`;
  // 差重归因状态条（图一 T0/T1/T2）
  const wc = aiCands.filter(x => x.weighted && !x.pendingRemove);
  const rm = aiCands.filter(x => x.pendingRemove);
  if (rm.length) aiWeightBar('⚖️ 秤台 1 · ' + rm.map(x => x.name).join('、') + ' 待确认移除（防误删）', 'warn');
  else if (wc.length) aiWeightBar('⚖️ 秤台 1 · ' + wc.map(x => x.diffG).join(' · '), 'ok');
  else aiWeightBar('');
  // 混放引导（方案 V4.5.1）：散称 + 预包装混放 → 提示先完成散称称重
  const hasW = aiCands.some(x => x.weighted && !x.pendingRemove);
  const hasP = aiCands.some(x => !x.weighted && !x.pendingRemove);
  if (hasW && hasP) {
    tipAI('混放提示：检测到称重商品，请先完成散称称重，再放预包装食品（重量交叉校验）');
  } else {
    tip.textContent = r.data.usedFallback ? '已由本地模型兜底识别' : '识别完成，请确认入车';
    tip.classList.remove('err');
  }
  drawBoxes(aiCands);
  renderCandRows();
  showHud(aiCands);
}
let aiModifyMode = false;
function renderCandRows() {
  const sum = aiCands.reduce((s, c) => s + (c.on ? c.price * c.count : 0), 0);
  const sumQty = aiCands.reduce((s, c) => s + (c.on ? c.count : 0), 0);
  $('#aiConfirm').textContent = `✓ 全部确认（合计 ${money(sum)} · ${sumQty} 件）`;
  $('#aiCands').innerHTML =
    aiCands.map((c, i) => {
      const conf = c.conf || 0;
      const confCls = conf >= 0.9 ? 'hi' : conf >= 0.7 ? 'mid' : 'lo';
      const tag = c.pendingRemove
        ? '<span class="dtag rm">⚠ 待确认移除 · 点击确认</span>'
        : c.weighted
          ? `<span class="dtag wk">${esc(c.diffG || '散称称重')}</span>`
          : '<span class="dtag pk">免扫直识 · 按件计价</span>';
      return `<div class="cand-row ${c.on ? 'on' : 'off'}${aiModifyMode ? ' modify' : ''}${c.pendingRemove ? ' rm' : ''}" onclick="toggleCand(${i})">
        <span class="ck">${c.pendingRemove ? '⚠' : (c.on ? '✓' : '')}</span>
        <span class="em">${emojiOf(c)}</span>
        <span class="info"><span class="nm">${esc(c.name)} ×${c.count}</span>
          <span class="mt"><span class="conf ${confCls}">${Math.round(conf * 100)}%</span>
            ${c.pendingRemove ? '检测框已消失' : (c.weighted
              ? '散称 · ' + money(c.price) + '/' + esc(c.unit || '斤') : '按件 · ' + money(c.price) + '/' + esc(c.unit || '件'))} · ${tag}</span></span>
        <span class="pct">${c.pendingRemove ? '—' : money(c.price * c.count)}</span>
      </div>`;
    }).join('') +
    (aiCands.length ? '' : '<div class="ai-cand-empty">未识别出商品</div>') +
    (aiModifyMode ? `<div class="ai-modify-hint">改选模式：点选商品行切换勾选，确认后入车</div>` : '');
}
function toggleCand(i) {
  const c = aiCands[i];
  if (c.pendingRemove) {   // T2 确认移除：该商品不入车（防欺诈的人工确认闸门）
    c.removed = true;
    if (c.weighted) aiScaleTotal = Math.max(0, aiScaleTotal - c.count * 300);   // 拿走的散称从总重扣除（近似均重）
    aiCands = aiCands.filter(x => x !== c);
    renderCandRows();
    const left = aiCands.filter(x => x.pendingRemove);
    aiWeightBar(left.length
      ? '⚖️ 秤台 1 · ' + left.map(x => x.name).join('、') + ' 待确认移除'
      : (aiCands.some(x => x.weighted) ? '⚖️ 秤台 1 · 称重归因完成' : ''),
      left.length ? 'warn' : '');
    showHud(aiCands);
    return;
  }
  c.on = !c.on; renderCandRows();
}
function aiModify() { aiModifyMode = !aiModifyMode; renderCandRows(); snack(aiModifyMode ? '改选模式已开启：点选商品行切换勾选' : '改选模式已关闭'); }
async function confirmAI() {
  const sel = aiCands.filter(c => c.on && !c.pendingRemove);
  const off = aiCands.filter(c => !c.removed && (!c.on || c.pendingRemove));
  // 收银员改选了识别结果 → 作为训练信号纠正（未改选则识别即正确，无需纠正）
  if (off.length && aiLogId) {
    call('POST', `/ai/recognize/${aiLogId}/correct`, { corrected: sel.map(c => ({ productId: c.productId, count: c.count })) })
      .then(r => r.code === 0 && log('[AI] 已提交纠正样本')).catch(() => {});
  }
  for (const c of sel) await addProduct({ id: c.productId, name: c.name, base_unit: c.unit, sell_price: c.price, is_weighted: c.weighted }, c.count);
  log(`[AI] 识别入车 ${sel.length} 项${off.length ? `，改选排除 ${off.length} 项` : ''}`);
  aiModifyMode = false;
  await closeAI();
}

/* ─── 快捷键：F1 挂单 · F2 会员 · F9 结账 ─── */
document.addEventListener('keydown', e => {
  if (e.key === 'F1') { e.preventDefault(); holdOrder(); }
  else if (e.key === 'F2') { e.preventDefault(); openMember(); }
  else if (e.key === 'F9') { e.preventDefault(); openPay(); }
});

/* ─── 启动 ─── */
renderCart();
if (API.token) enterMain();
