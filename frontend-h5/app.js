// ─── H5 会员端（对端：后端 /m/* 会员自助端点）───
const API = {
  base: localStorage.getItem('h5_api_base') || 'http://localhost:3100',
  token: localStorage.getItem('h5_token') || '',
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => Number(n ?? 0).toFixed(2);
// V5.0.19i（F-08）：补单引号转义（与 admin/pwa/boss 的 esc 对齐；属性值拼接防绕过）
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function call(method, path, body) {
  const res = await fetch(API.base + path, {
    method,
    headers: {
      ...(API.token ? { authorization: 'Bearer ' + API.token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({ code: -1, msg: 'HTTP ' + res.status, data: null }));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 2200);
}

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? String(s) : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 登录态 ──
function showAuth() { $('#auth').hidden = false; $('#main').hidden = true; }
function showMain() { $('#auth').hidden = true; $('#main').hidden = false; refreshMe(); }

function logout() {
  API.token = ''; localStorage.removeItem('h5_token');
  showAuth();
}

// ── 认证页 ──
$$('.tab').forEach(b => b.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('on', x === b));
  $('#fLogin').hidden = b.dataset.t !== 'login';
  $('#fRegister').hidden = b.dataset.t !== 'register';
  $('#fInit').hidden = b.dataset.t !== 'init';
});

$('#fLogin').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await call('POST', '/m/login', { phone: f.get('phone'), password: f.get('password') });
  if (r.code === 0) { API.token = r.data.token; localStorage.setItem('h5_token', API.token); showMain(); }
  else toast(r.msg || '登录失败');
};

$('#fRegister').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await call('POST', '/m/register', {
    phone: f.get('phone'), name: f.get('name') || undefined,
    password: f.get('password'), privacyAgreed: f.get('privacyAgreed') === 'on',
  });
  if (r.code === 0) { API.token = r.data.token; localStorage.setItem('h5_token', API.token); toast('注册成功'); showMain(); }
  else toast(r.msg || '注册失败');
};

$('#fInit').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await call('POST', '/m/password/init', {
    phone: f.get('phone'), idCardTail: f.get('idCardTail'), password: f.get('password'),
  });
  if (r.code === 0) { toast('设置成功，请登录'); $$('.tab')[0].click(); $('#fLogin [name=phone]').value = f.get('phone'); }
  else toast(r.msg || '设置失败');
};

// ── 首页资产 ──
let ME = null;
async function refreshMe() {
  const r = await call('GET', '/m/me');
  if (r.code === 40100 || r.code === -1) return logout();
  if (r.code !== 0) return toast(r.msg || '加载失败');
  ME = r.data;
  const { member: m, assets: a } = ME;
  $('#hName').textContent = m.name || m.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
  $('#hLevel').textContent = m.level;
  $('#hCard').textContent = '卡号 ' + m.cardNo;
  $('#aBalance').textContent = money(a.balance);
  $('#aSplit').textContent = `本金 ${money(Math.min(a.principalTotal, a.balance))} + 赠送 ${money(a.giftBalance)}`;
  $('#aDividend').textContent = money(a.dividendBalance);
  $('#aPoints').textContent = money(a.dividendBalance);
  $('#aPoints2').textContent = a.points;
  $('#aDivCum').textContent = '累计 ¥' + money(a.dividendCumulative);
  const tips = [];
  if (a.dividendCapped) tips.push('已达分红封顶（30%），当前仅累计积分');
  if (m.invalidAt) tips.push(`最后有效消费日 ${m.lastActiveDate || '—'}，分红权益失效日 ${m.invalidAt}`);
  else tips.push('分红是消费让利回馈：不可提现、不可转赠，仅限消费抵用 · 30 天未有效消费将停发');
  $('#aTip').textContent = tips.join('；');
  const memName = m.name || m.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
  $('#scanMem').innerHTML = `${esc(memName)} · <b>${esc(m.level)}</b> · 余额 <b>¥${money(a.balance)}</b> · 可用分红 <b>¥${money(a.dividendBalance)}</b>`;
  loadFlows();
  loadSales();
  $('#memberMeta').innerHTML =
    `手机号 ${esc(m.phone)} · 状态 ${esc(m.status)}<br>` +
    `分红权重 ${money(a.dividendWeight)} · 累计本金 ${money(a.principalTotal)}（口径B：赠送不计分红权重）`;
}

// ── 流水 ──
$$('.stab').forEach(b => b.onclick = () => {
  $$('.stab').forEach(x => x.classList.toggle('on', x === b));
  loadFlows();
});

async function loadFlows() {
  const tab = ($('.stab.on') || {}).dataset?.t || 'balance';
  const r = await call('GET', `/m/flows?tab=${tab}&limit=30`);
  const box = $('#flowList');
  if (r.code !== 0) { box.innerHTML = '<div class="empty">加载失败</div>'; return; }
  const items = r.data.items || [];
  if (!items.length) { box.innerHTML = '<div class="empty">暂无记录</div>'; return; }
  box.innerHTML = items.map(f => {
    if (tab === 'points') {
      const plus = f.direction === '加';
      return `<div class="row"><div class="l"><b>${esc(f.biz_type)}</b><span class="muted">${fmtTime(f.created_at)}</span></div>
        <div class="amt ${plus ? 'in' : 'out'}">${plus ? '+' : '−'}${f.points} 分</div></div>`;
    }
    if (tab === 'dividend') {
      const plus = ['计提', '发放', '补偿'].includes(f.record_type);
      return `<div class="row"><div class="l"><b>${esc(f.record_type)}${f.expire_at ? ` · ${esc(f.expire_at)} 失效` : ''}</b>
        <span class="muted">${fmtTime(f.created_at)}${f.remark ? ' · ' + esc(f.remark) : ''}</span></div>
        <div class="amt ${plus ? 'in' : 'out'}">${plus ? '+' : '−'}¥${money(f.amount)}</div></div>`;
    }
    const plus = f.direction === '入';
    const parts = Number(f.principal_part) ? `（本金 ${money(f.principal_part)}）` : '';
    return `<div class="row"><div class="l"><b>${esc(f.biz_type)}${parts}</b><span class="muted">${fmtTime(f.created_at)}</span></div>
      <div class="amt ${plus ? 'in' : 'out'}">${plus ? '+' : '−'}¥${money(f.amount)}</div></div>`;
  }).join('');
}

// ── 消费记录 ──
async function loadSales() {
  const r = await call('GET', '/m/sales');
  const box = $('#salesList');
  if (r.code !== 0) { box.innerHTML = '<div class="empty">加载失败</div>'; return; }
  const items = r.data.items || [];
  if (!items.length) { box.innerHTML = '<div class="empty">还没有消费记录</div>'; return; }
  box.innerHTML = items.map(o => `<div class="row">
    <div class="l"><b>${esc(o.order_no)}</b>
      <span class="muted">${fmtTime(o.created_at)} · ${esc(o.channel)}${Number(o.promo_amount) ? ' · 优惠 ¥' + money(o.promo_amount) : ''}</span></div>
    <div class="amt">¥${money(o.payable_amount)}</div></div>`).join('');
}

// ── 我的 ──
const VIEWS = ['vFlows', 'vScan', 'vRecharge', 'vSales', 'vMall', 'vOrders', 'vMe'];
$$('.nav-b').forEach(b => b.onclick = () => {
  $$('.nav-b').forEach(x => x.classList.toggle('on', x === b));
  const v = 'v' + b.dataset.v[0].toUpperCase() + b.dataset.v.slice(1);
  VIEWS.forEach(id => { $('#' + id).hidden = id !== v; });
  if (b.dataset.v === 'recharge') loadRecharge();
  if (b.dataset.v === 'mall') enterMall();
  if (b.dataset.v === 'orders') loadOrders();
  if (b.dataset.v === 'me') loadAddrs();
});

// ── 首页快捷入口（原型 21 宫格 → 对应页签） ──
$$('.e-card').forEach(b => b.onclick = () => {
  const nav = $$('.nav-b').find(x => x.dataset.v === b.dataset.jump);
  if (nav) nav.click();
});

// ── 扫码购（6.4.2 自助收银：条码加清单 → 余额结算 → 离场核销码） ──
const CART = new Map(); // productId → { p, qty }
const priceOf = p => (ME?.member?.id && p.memberPrice != null) ? Number(p.memberPrice) : Number(p.sellPrice);

function addToCart(p) {
  if (Number(p.status) !== 1) return toast('该商品已停售');
  const hit = CART.get(Number(p.id));
  CART.set(Number(p.id), { p, qty: (hit ? hit.qty : 0) + 1 });
  renderCart();
}

function renderCart() {
  const box = $('#scCart');
  const items = [...CART.values()];
  const total = items.reduce((s, { p, qty }) => s + priceOf(p) * qty, 0);
  $('#scCount').textContent = items.reduce((s, x) => s + x.qty, 0) + ' 件' + (total ? ' · 合计 ¥' + money(total) : '');
  if (!items.length) { box.innerHTML = '<div class="empty">清单为空，扫一扫添加商品</div>'; $('#scTotal').textContent = '¥0.00'; return; }
  box.innerHTML = items.map(({ p, qty }) => {
    const price = priceOf(p);
    return `<div class="p-item">
      <span class="em">${esc(String(p.name || '品')[0])}</span>
      <div class="grow">
        <div class="pi-name">${esc(p.name)}</div>
        <div class="pi-sub">¥${money(price)}/${esc(p.baseUnit || '件')}${Number(p.status) !== 1 ? ' · 已停售' : ''}</div>
      </div>
      <div class="q">
        <span data-dec="${p.id}">−</span><b class="num">${qty}</b><span data-inc="${p.id}">＋</span>
      </div>
      <div class="pr">¥${money(price * qty)}</div>
      <button type="button" class="del" data-del="${p.id}">✕</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => { addToCart(CART.get(Number(b.dataset.inc)).p); });
  box.querySelectorAll('[data-dec]').forEach(b => {
    b.onclick = () => {
      const id = Number(b.dataset.dec);
      const hit = CART.get(id);
      if (hit.qty <= 1) CART.delete(id); else hit.qty -= 1;
      renderCart();
    };
  });
  box.querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { CART.delete(Number(b.dataset.del)); renderCart(); }; });
  $('#scTotal').textContent = '¥' + money(total);
}

async function searchProducts(kw, exact) {
  if (!kw) return [];
  const r = await call('GET', '/m/pricebook?kw=' + encodeURIComponent(kw));
  if (r.code !== 0) { toast(r.msg || '查询失败'); return []; }
  const items = (r.data?.items || []).filter(p => !exact || p.barcode === kw);
  if (exact && !items.length) toast('未找到该条码商品');
  return items;
}

$('#scBarcode').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const kw = e.target.value.trim();
  if (!kw) return;
  const items = await searchProducts(kw, true);
  if (items[0]) { addToCart(items[0]); e.target.value = ''; }
});
// ── 手机相机扫条码（BarcodeDetector 原生支持则弹相机，否则提示手输） ──
$('#scCam').onclick = async () => {
  if (!('BarcodeDetector' in window)) return toast('当前浏览器不支持扫码，请手动输入条码');
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet">
    <div style="display:flex;align-items:center;margin-bottom:10px">
      <b style="flex:1;font-size:15px">📷 对准商品条码</b>
      <button type="button" class="primary sm" id="scCamClose" style="flex:0 0 auto">关闭</button>
    </div>
    <video id="scCamVideo" playsinline muted style="width:100%;border-radius:10px;background:#000;max-height:46dvh;object-fit:cover"></video>
    <p class="hint" style="text-align:center;margin-top:8px">识别成功自动加入清单，未识别可手输条码</p></div>`;
  document.body.appendChild(m);
  const video = m.querySelector('#scCamVideo');
  let stream = null, raf = 0;
  const stop = () => { cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach(t => t.stop()); m.remove(); };
  m.querySelector('#scCamClose').onclick = stop;
  const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch { stop(); return toast('无法打开摄像头，请手动输入条码'); }
  video.srcObject = stream;
  await video.play();
  const tick = async () => {
    try {
      if (video.readyState >= 2) {
        const codes = await detector.detect(video);
        if (codes.length && codes[0].rawValue) {
          const raw = codes[0].rawValue;
          stop();
          const items = await searchProducts(raw, true);
          if (items[0]) { addToCart(items[0]); return toast(`已加入：${items[0].name}`); }
          return toast(`未找到条码商品：${raw}`);
        }
      }
      raf = requestAnimationFrame(tick);
    } catch { raf = requestAnimationFrame(tick); }
  };
  tick();
};
$('#scGo').onclick = async () => {
  const kw = $('#scKw').value.trim();
  const items = await searchProducts(kw, false);
  const box = $('#scResults');
  if (!items.length) { box.innerHTML = '<div class="empty">无匹配商品</div>'; return; }
  box.innerHTML = items.map(p => `<button type="button" class="p-item prod" data-id="${p.id}">
    <span class="em">${esc(String(p.name || '品')[0])}</span>
    <div class="grow"><div class="pi-name">${esc(p.name)}</div>
      <div class="pi-sub">${esc(p.barcode)} · ¥${money(priceOf(p))}/${esc(p.baseUnit || '件')}</div></div>
    <span class="pr" style="color:var(--pri);font-size:13px;min-width:auto">加入</span></button>`).join('');
  box.querySelectorAll('.prod').forEach(b => b.onclick = () => addToCart(items.find(x => Number(x.id) === Number(b.dataset.id))));
};
$('#scAgain').onclick = () => {
  CART.clear(); renderCart();
  $('#scDone').hidden = true; $('#scPay').disabled = false;
  $('#scBarcode').value = ''; $('#scKw').value = ''; $('#scResults').innerHTML = '';
};
$('#scPay').onclick = async () => {
  const items = [...CART.values()].map(({ p, qty }) => ({ productId: Number(p.id), qty }));
  if (!items.length) return toast('清单为空');
  $('#scPay').disabled = true;
  const r = await call('POST', '/m/self-checkout', { items });
  $('#scPay').disabled = false;
  if (r.code !== 0) { toast(r.msg || '结算失败（余额不足请先充值）'); return; }
  const d = r.data;
  $('#scCode').textContent = d.leaveCode;
  $('#scDoneInfo').textContent = `订单 ${d.orderNo} · ${d.itemsCount || items.reduce((s, x) => s + x.qty, 0)} 件 · 实付 ¥${money(d.payable)} · 请到出口出示核销码`;
  $('#scDone').hidden = false;
  CART.clear(); renderCart();
  refreshMe();
};

// ── 充值（H5 发起 → 收银台代收） ──
let SEL_PLAN = null;

async function loadRecharge() {
  const [rp, ro] = await Promise.all([
    call('GET', '/m/recharge/plans'),
    call('GET', '/m/recharge-orders'),
  ]);
  if (rp.code === 40100 || rp.code === 401 || ro.code === 40100 || ro.code === 401) return logout();
  // 档位卡片
  const plans = rp.data?.plans || [];
  const g = $('#rechargePlans');
  if (!plans.length) g.innerHTML = '<div class="empty">门店暂未配置充值档位，可直接输入自定义金额</div>';
  else g.innerHTML = plans.map(p => `
    <button type="button" class="plan${SEL_PLAN === Number(p.id) ? ' on' : ''}" data-id="${p.id}">
      <b>充 ${money(p.principal)}</b><span>${Number(p.gift) > 0 ? '送 ' + money(p.gift) : '无赠送'}</span>
    </button>`).join('');
  g.querySelectorAll('.plan').forEach(b => b.onclick = () => {
    const id = Number(b.dataset.id);
    SEL_PLAN = SEL_PLAN === id ? null : id;
    g.querySelectorAll('.plan').forEach(x => x.classList.toggle('on', Number(x.dataset.id) === SEL_PLAN));
  });
  // 充值单列表
  const items = ro.data?.items || [];
  const box = $('#rechargeList');
  if (!items.length) { box.innerHTML = '<div class="empty">暂无充值单</div>'; return; }
  box.innerHTML = items.map(o => `<div class="row">
    <div class="l"><b>${esc(o.order_no)}</b>
      <span class="muted">${fmtTime(o.created_at)} · 充 ${money(o.principal)}${Number(o.gift) ? ' 送 ' + money(o.gift) : ''}${o.pay_channel ? ' · ' + esc(o.pay_channel) : ''}</span></div>
    <div class="amt ${o.status === '已入账' ? 'in' : o.status === '待支付' ? '' : 'out'}">
      ${esc(o.status)}${o.status === '待支付' ? ` <button type="button" class="mini-cancel" data-id="${o.id}">取消</button>` : ''}
    </div></div>`).join('');
  box.querySelectorAll('.mini-cancel').forEach(b => b.onclick = async () => {
    const r = await call('POST', `/m/recharge-orders/${b.dataset.id}/cancel`);
    if (r.code === 0) { toast('已取消，可重新发起'); loadRecharge(); }
    else toast(r.msg || '取消失败');
  });
}

$('#fRecharge').onsubmit = async e => {
  e.preventDefault();
  const amount = Number(new FormData(e.target).get('amount'));
  let body;
  if (SEL_PLAN) body = { planId: SEL_PLAN };
  else {
    if (!(amount > 0)) return toast('请选择档位或输入充值金额');
    body = { principal: amount };
  }
  const r = await call('POST', '/m/recharge-orders', body);
  if (r.code === 0) {
    toast(`充值单 ${r.data.order_no} 已发起，请到收银台付款（充 ${money(r.data.principal)}${Number(r.data.gift) ? ' 送 ' + money(r.data.gift) : ''}）`);
    e.target.reset(); SEL_PLAN = null;
    loadRecharge();
  } else toast(r.msg || '发起失败');
};

$('#fPwd').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await call('POST', '/m/password', { old: f.get('old'), new: f.get('new') });
  if (r.code === 0) { toast('密码已修改'); e.target.reset(); }
  else toast(r.msg || '修改失败');
};

$('#btnLogout').onclick = logout;

// ═══════════ 在线商城（方向4：分类/搜索/加购/下单/配送） ═══════════
const MCART = new Map(); // productId → { p, qty }（商城独立购物车）
let MSET = { serving: 1, fee: 3, freeAbove: 50, radiusKm: 0 };
const MALL = { cat: null, kw: '', page: 1, size: 30 };

const mallPrice = p => (p.memberPrice != null ? Number(p.memberPrice) : Number(p.sellPrice));
const mallStock = p => Number(p.stock ?? 0);

async function enterMall() {
  loadMallSettings();
  loadMallCats();
  loadMallProducts();
  renderMBar();
}

async function loadMallSettings() {
  const r = await call('GET', '/m/mall/settings');
  if (r.code !== 0) return;
  MSET = r.data;
  const tip = $('#mallTip');
  if (tip) tip.textContent = MSET.freeAbove > 0 ? `满 ${MSET.freeAbove} 免配送费` : (MSET.serving === 1 ? '自提/配送/外卖' : '到店自提');
  // V4.16.5 门头动态化：店名/电话读后台「商店信息」设置（后台可改，不再写死）
  const st = MSET.store || {};
  const hd = document.querySelector('.hd-store');
  if (hd && st.name) hd.textContent = '🛒 ' + st.name;
  const foot = $('#hStoreFoot');
  if (foot) foot.textContent = [st.name, st.address, st.phone ? '☎ ' + st.phone : ''].filter(Boolean).join(' · ');
}

async function loadMallCats() {
  const r = await call('GET', '/m/mall/categories');
  const box = $('#mallCats');
  if (r.code !== 0) { box.innerHTML = ''; return; }
  const cats = r.data?.items || [];
  const chip = (id, name, on) => `<button type="button" class="mchip${on ? ' on' : ''}" data-id="${id}">${esc(name)}</button>`;
  box.innerHTML = chip('', '全部', MALL.cat === null || MALL.cat === '') +
    cats.map(c => chip(c.id, c.name + (Number(c.prod_count) > 0 ? ` ·${c.prod_count}` : ''), String(MALL.cat) === String(c.id))).join('');
  box.querySelectorAll('.mchip').forEach(b => b.onclick = () => {
    MALL.cat = b.dataset.id === '' ? null : b.dataset.id;
    MALL.page = 1;
    loadMallCats();
    loadMallProducts();
  });
}

async function loadMallProducts() {
  const q = new URLSearchParams({ page: String(MALL.page), size: String(MALL.size) });
  if (MALL.cat) q.set('cat', MALL.cat);
  if (MALL.kw) q.set('kw', MALL.kw);
  const r = await call('GET', '/m/mall/products?' + q.toString());
  const box = $('#mallList');
  if (r.code !== 0) { box.innerHTML = '<div class="empty">加载失败</div>'; return; }
  const items = r.data?.items || [];
  if (!items.length) { box.innerHTML = '<div class="empty">暂无在售商品</div>'; return; }
  box.innerHTML = items.map(p => {
    const price = mallPrice(p), stock = mallStock(p);
    const inCart = MCART.get(Number(p.id))?.qty || 0;
    const soldOut = Number(p.trackInventory) === 1 && stock <= 0;
    return `<div class="mcard${soldOut ? ' off' : ''}">
      ${p.photoPath
        ? `<img class="mc-img" src="${API.base}${esc(p.photoPath)}" loading="lazy" alt="" onerror="this.outerHTML='<div class=\\'mc-em\\'>${esc(String(p.name || '品')[0])}</div>'">`
        : `<div class="mc-em">${esc(String(p.name || '品')[0])}</div>`}
      <div class="mc-name">${esc(p.name)}</div>
      <div class="mc-sub">${esc(p.spec || p.baseUnit || '件')}${p.trackInventory ? ` · 库存 ${stock}` : ''}</div>
      <div class="mc-foot">
        <b class="mc-price">¥${money(price)}</b>
        ${soldOut ? '<span class="mc-out">缺货</span>' : `<button type="button" class="mc-add" data-id="${p.id}">${inCart ? '＋' + inCart : '加入'}</button>`}
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.mc-add').forEach(b => b.onclick = () => {
    const p = items.find(x => Number(x.id) === Number(b.dataset.id));
    madd(p);
  });
}

function madd(p) {
  if (!p) return;
  const id = Number(p.id);
  if (mallStock(p) <= 0 && Number(p.trackInventory) === 1) return toast('该商品暂时缺货');
  const hit = MCART.get(id);
  // V5.0.19i（F-08）：数量上界 9999（原无上界，连点可造天文数字提交）
  MCART.set(id, { p, qty: Math.min((hit ? hit.qty : 0) + 1, 9999) });
  renderMBar();
}

function mdec(id) {
  const hit = MCART.get(id);
  if (hit.qty <= 1) MCART.delete(id); else hit.qty -= 1;
  renderMBar();
}

function renderMBar() {
  const items = [...MCART.values()];
  const count = items.reduce((s, x) => s + x.qty, 0);
  const total = items.reduce((s, { p, qty }) => s + mallPrice(p) * qty, 0);
  $('#mBar').hidden = !count;
  if (!count) return;
  $('#mCount').textContent = count + ' 件';
  $('#mTotal').textContent = '¥' + money(total);
}

$('#mallGo').onclick = () => { MALL.kw = $('#mallKw').value.trim(); MALL.page = 1; loadMallProducts(); };
$('#mallKw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#mallGo').click(); });

// ── 订单确认弹层 ──
let CK = { mode: '自提', addrId: null, addrs: [] };

function ckFee(goods) {
  if (CK.mode === '自提') return 0;
  return goods >= MSET.freeAbove ? 0 : MSET.fee;
}

function openCheckout() {
  const items = [...MCART.values()];
  if (!items.length) return toast('购物车为空');
  const goods = items.reduce((s, { p, qty }) => s + mallPrice(p) * qty, 0);
  CK.mode = '自提';
  CK.addrId = null;
  buildCkSheet();
  // 异步刷新地址（配送/外卖才需要）
  loadCkAddrs();
}

function buildCkSheet() {
  const items = [...MCART.values()];
  const goods = items.reduce((s, { p, qty }) => s + mallPrice(p) * qty, 0);
  const fee = ckFee(goods);
  const m = document.createElement('div');
  m.className = 'modal';
  m.id = 'ckModal';
  m.innerHTML = `<div class="sheet">
    <div class="sheet-h"><b>确认订单</b><button type="button" class="primary sm" data-close>✕</button></div>
    <div class="ck-items" id="ckItems">${items.map(({ p, qty }) => `
      <div class="ck-i"><div class="grow"><b>${esc(p.name)}</b><span class="muted">¥${money(mallPrice(p))} × ${qty}</span></div>
        <div class="q"><span data-dec="${p.id}">−</span><b class="num">${qty}</b><span data-inc="${p.id}">＋</span></div>
        <b class="pr">¥${money(mallPrice(p) * qty)}</b></div>`).join('')}</div>
    <div class="ck-mode">
      <button type="button" data-mode="自提" class="on">到店自提</button>
      <button type="button" data-mode="配送"${MSET.serving !== 1 ? ' disabled' : ''}>配送</button>
      <button type="button" data-mode="外卖"${MSET.serving !== 1 ? ' disabled' : ''}>外卖</button>
    </div>
    <div id="ckAddrBox" hidden>
      <div class="ck-t">收货地址</div>
      <div id="ckAddrs" class="ck-addrs"></div>
      <button type="button" class="ck-new" id="ckAddrNew">＋ 新增收货地址</button>
    </div>
    <input id="ckRemark" class="ck-remark" placeholder="订单备注（选填）">
    <div class="ck-tot">
      <div class="ck-line">商品小计 <b>¥${money(goods)}</b></div>
      <div class="ck-line" id="ckFeeLine">配送费 <b>¥${money(fee)}</b>${fee === 0 && CK.mode !== '自提' ? '（免邮）' : ''}</div>
      <div class="ck-line big">应付 <b>¥${money(goods + fee)}</b></div>
      <div class="hint" id="ckModeTip">${CK.mode === '自提' ? '提交后生成 6 位自提码，到店出示核销' : '未满 ' + MSET.freeAbove + ' 元收配送费 ¥' + MSET.fee}</div>
    </div>
    <button class="primary" id="ckSubmit">余额支付 · 提交订单</button>
  </div>`;
  document.body.appendChild(m);
  m.querySelector('[data-close]').onclick = () => m.remove();
  // 数量增减
  m.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => { madd(MCART.get(Number(b.dataset.inc)).p); buildCkSheet(); });
  m.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => { mdec(Number(b.dataset.dec)); if (!MCART.size) { m.remove(); renderMBar(); return; } buildCkSheet(); });
  // 配送方式
  m.querySelectorAll('.ck-mode [data-mode]').forEach(b => b.onclick = () => {
    if (b.disabled) return;
    CK.mode = b.dataset.mode;
    m.querySelectorAll('.ck-mode [data-mode]').forEach(x => x.classList.toggle('on', x === b));
    buildCkSheet();
    if (CK.mode !== '自提') loadCkAddrs();
  });
  $('#ckAddrNew')?.addEventListener('click', () => addrEditor(null, () => loadCkAddrs()));
  // 提交
  m.querySelector('#ckSubmit').onclick = () => submitOrder(m);
}

async function loadCkAddrs() {
  const r = await call('GET', '/m/addresses');
  if (r.code !== 0) return;
  CK.addrs = r.data?.items || [];
  CK.addrId = CK.addrs.find(a => a.is_default)?.id ?? CK.addrs[0]?.id ?? null;
  const box = $('#ckAddrs');
  const wrap = $('#ckAddrBox');
  if (CK.mode === '自提' || !CK.addrs.length) { wrap.hidden = CK.mode === '自提'; box.innerHTML = ''; return; }
  wrap.hidden = false;
  box.innerHTML = CK.addrs.map(a => `<button type="button" class="ck-addr${Number(a.id) === Number(CK.addrId) ? ' on' : ''}" data-id="${a.id}">
    <b>${esc(a.contact)} · ${esc(a.phone)}</b><span>${esc(a.address)}${a.is_default ? ' · 默认' : ''}</span></button>`).join('');
  box.querySelectorAll('.ck-addr').forEach(b => b.onclick = () => {
    CK.addrId = Number(b.dataset.id);
    box.querySelectorAll('.ck-addr').forEach(x => x.classList.toggle('on', x === b));
  });
}

async function submitOrder(m) {
  const items = [...MCART.values()];
  if (!items.length) return toast('购物车为空');
  if (CK.mode !== '自提' && !CK.addrId) return toast('请选择收货地址');
  const btn = m.querySelector('#ckSubmit');
  btn.disabled = true;
  const r = await call('POST', '/m/orders', {
    items: items.map(({ p, qty }) => ({ productId: Number(p.id), qty })),
    pickupMode: CK.mode,
    addressId: CK.addrId || undefined,
    remark: m.querySelector('#ckRemark').value.trim() || undefined,
  });
  btn.disabled = false;
  if (r.code !== 0) { toast(r.msg || '下单失败（余额不足请先充值）'); return; }
  const d = r.data;
  MCART.clear(); renderMBar(); m.remove();
  refreshMe(); loadOrders();
  if (CK.mode === '自提') {
    // 成功页：6 位自提码
    const ok = document.createElement('div');
    ok.className = 'modal';
    ok.innerHTML = `<div class="sheet">
      <div class="ec-t">✅ 下单成功 · 到店自提</div>
      <div class="ec-code" style="letter-spacing:8px">${d.pickupCode || '------'}</div>
      <div class="ec-tip">订单 ${esc(d.orderNo)} · 应付 ¥${money(d.payable)}（余额已支付）<br>请到门店出示此 6 位自提码核销取货</div>
      <button class="primary" id="ckDone">完成</button></div>`;
    document.body.appendChild(ok);
    ok.querySelector('#ckDone').onclick = () => ok.remove();
  } else {
    toast(`下单成功 ${d.orderNo} · 实付 ¥${money(d.payable)}${d.deliveryFee ? '（含配送费 ¥' + money(d.deliveryFee) + '）' : ''}`);
    loadMallProducts();
  }
}

$('#mGo').onclick = openCheckout;

// ═══════════ 在线订单（方向4：列表/详情/取消） ═══════════
const ST_CLS = { '待拣货': 'tag g', '拣货中': 'tag y', '配送中': 'tag y', '待自提': 'tag g', '已自提': 'tag g', '已送达': 'tag g', '已取消': 'tag r', '部分缺货': 'tag y' };

async function loadOrders() {
  const r = await call('GET', '/m/orders');
  const box = $('#ordersList');
  if (r.code !== 0) { box.innerHTML = '<div class="empty">加载失败</div>'; return; }
  const items = r.data?.items || [];
  if (!items.length) { box.innerHTML = '<div class="empty">还没有在线订单，去商城逛逛吧</div>'; return; }
  box.innerHTML = items.map(o => {
    const cls = ST_CLS[o.statusText] || 'tag';
    const cancelable = o.status === '已完成' && o.picking_status === '待拣货';
    return `<div class="ocard">
      <div class="oc-top"><div class="l"><b>${esc(o.order_no)}</b>
        <span class="muted">${fmtTime(o.created_at)} · ${esc(o.pickup_mode || o.channel)}${o.item_count ? ' · ' + o.item_count + ' 件' : ''}</span></div>
        <div class="r"><span class="${cls}">${esc(o.statusText)}</span></div></div>
      <div class="oc-foot">
        <div class="l">${Number(o.delivery_fee) ? `<span class="muted">含配送费 ¥${money(o.delivery_fee)}</span>` : ''}
          ${o.delivery_code && (o.statusText === '待拣货' || o.statusText === '待自提') ? `<span class="muted">自提码 <b class="num">${esc(o.delivery_code)}</b></span>` : ''}</div>
        <div class="r"><b class="amt">¥${money(o.payable_amount)}</b>
          ${cancelable ? `<button type="button" class="oc-cancel" data-id="${o.id}">取消</button>` : ''}
          <button type="button" class="oc-detail" data-id="${o.id}">详情</button></div>
      </div>
      <div class="oc-detail-box" id="ocd-${o.id}" hidden></div>
    </div>`;
  }).join('');
  box.querySelectorAll('.oc-cancel').forEach(b => b.onclick = () => cancelOrder(Number(b.dataset.id)));
  box.querySelectorAll('.oc-detail').forEach(b => b.onclick = () => toggleOrderDetail(Number(b.dataset.id), b));
}

async function toggleOrderDetail(id, btn) {
  const box = $('#ocd-' + id);
  if (!box.hidden) { box.hidden = true; return; }
  const r = await call('GET', `/m/orders/${id}`);
  if (r.code !== 0) { toast(r.msg || '加载失败'); return; }
  const { order, items } = r.data;
  box.innerHTML = `
    <div class="oc-items">${(items || []).map(i => `<div class="ck-i"><div class="grow"><b>${esc(i.name)}</b><span class="muted">¥${money(i.unit_price)} × ${i.qty}</span></div><b class="pr">¥${money(i.line_amount)}</b></div>`).join('')}</div>
    <div class="ck-tot">
      <div class="ck-line">商品小计 <b>¥${money(order.goods_amount)}</b></div>
      ${Number(order.promo_amount) ? `<div class="ck-line">优惠 <b>−¥${money(order.promo_amount)}</b></div>` : ''}
      ${Number(order.delivery_fee) ? `<div class="ck-line">配送费 <b>¥${money(order.delivery_fee)}</b></div>` : ''}
      <div class="ck-line big">实付 <b>¥${money(order.payable_amount)}</b></div>
      ${order.cancel_reason ? `<div class="hint">取消原因：${esc(order.cancel_reason)}</div>` : ''}
      ${order.receiver ? `<div class="hint">收货：${esc(order.receiver)} ${esc(order.receiver_phone)}<br>${esc(order.receiver_address)}</div>` : ''}
    </div>`;
  box.hidden = false;
}

async function cancelOrder(id) {
  if (!confirm('确定取消该订单？将原路退回余额并恢复库存')) return;
  const r = await call('POST', `/m/orders/${id}/cancel`);
  if (r.code === 0) { toast(`已取消 · 退款 ¥${money(r.data.refundAmount)}`); refreshMe(); loadOrders(); }
  else toast(r.msg || '取消失败');
}

// ═══════════ 收货地址（我的 + 下单弹层共用） ═══════════
async function loadAddrs() {
  const r = await call('GET', '/m/addresses');
  const box = $('#addrList');
  if (r.code !== 0) { box.innerHTML = ''; return; }
  const items = r.data?.items || [];
  if (!items.length) { box.innerHTML = '<div class="empty" style="padding:14px 0">暂无地址，下单配送时需先添加</div>'; return; }
  box.innerHTML = items.map(a => `<div class="row" style="align-items:flex-start">
    <div class="l"><b>${esc(a.contact)} · ${esc(a.phone)}</b>
      <span class="muted">${esc(a.address)}${a.is_default ? ' · <b style="color:var(--pri)">默认</b>' : ''}</span></div>
    <div style="display:flex;gap:6px;flex:0 0 auto">
      ${a.is_default ? '' : `<button type="button" class="mini-cancel" data-set="${a.id}">设默认</button>`}
      <button type="button" class="mini-cancel" data-edit="${a.id}">编辑</button>
      <button type="button" class="mini-cancel" data-del="${a.id}">删除</button>
    </div></div>`).join('');
  box.querySelectorAll('[data-set]').forEach(b => b.onclick = async () => {
    const r = await call('PUT', `/m/addresses/${b.dataset.set}`, { isDefault: true });
    if (r.code === 0) { loadAddrs(); } else toast(r.msg || '操作失败');
  });
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => addrEditor(Number(b.dataset.edit), loadAddrs));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('删除该地址？')) return;
    const r = await call('DELETE', `/m/addresses/${b.dataset.del}`);
    if (r.code === 0) { loadAddrs(); } else toast(r.msg || '删除失败');
  });
}

function addrEditor(id, onDone) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet">
    <div class="sheet-h"><b>${id ? '编辑地址' : '新增地址'}</b><button type="button" class="primary sm" data-close>✕</button></div>
    <form id="addrForm" style="display:flex;flex-direction:column;gap:10px">
      <input name="contact" placeholder="联系人" maxlength="20" required>
      <input name="phone" type="tel" placeholder="手机号" maxlength="11" required>
      <input name="address" placeholder="详细地址（小区/街道/门牌号）" required>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--mut)">
        <input name="isDefault" type="checkbox"> 设为默认地址</label>
      <button class="primary" type="submit">保存</button>
    </form></div>`;
  document.body.appendChild(m);
  m.querySelector('[data-close]').onclick = () => m.remove();
  if (id) {
    const cur = CK.addrs.find(a => Number(a.id) === id);
    if (cur) {
      m.querySelector('[name=contact]').value = cur.contact;
      m.querySelector('[name=phone]').value = cur.phone;
      m.querySelector('[name=address]').value = cur.address;
      m.querySelector('[name=isDefault]').checked = !!cur.is_default;
    }
  }
  m.querySelector('#addrForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      contact: f.get('contact'), phone: f.get('phone'),
      address: f.get('address'), isDefault: f.get('isDefault') === 'on',
    };
    const r = id
      ? await call('PUT', `/m/addresses/${id}`, body)
      : await call('POST', '/m/addresses', body);
    if (r.code === 0) { m.remove(); toast('地址已保存'); onDone && onDone(); }
    else toast(r.msg || '保存失败');
  };
}

$('#addrAdd').onclick = () => addrEditor(null, loadAddrs);

// ── 启动 ──
if (API.token) showMain(); else showAuth();
