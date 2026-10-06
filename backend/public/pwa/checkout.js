'use strict';
/* 员工移动端 PWA · 移动收银（checkout.js，8.5.1 应急收银）
 * 价目表全量缓存（IndexedDB，版本哈希增量，24h 标黄 / 72h 过期禁应急）→ 扫码/搜索 →
 * 购物车 → 现金/扫码/余额结账（POST /sales/checkout，channel=移动收银|应急收银）
 * 断网离线暂存本地队列，恢复联网自动补传（app.js flushQueue） */

// ── 价目表缓存（IndexedDB 全量常备；刻意不缓存库存/会员等易变数据）──
const Pricebook = {
  db: null, items: [], byBarcode: new Map(), version: '', updatedAt: null, ready: false, scale: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const rq = indexedDB.open('pwa_pricebook', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('pb');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return this.db;
  },
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('pb', mode);
      const st = tx.objectStore('pb');
      let result;
      const r = fn(st);
      // IDBRequest（读）：onsuccess 捕获 result；写操作无需返回值
      if (r instanceof IDBRequest) {
        r.onsuccess = () => { result = r.result; };
        r.onerror = () => rej(r.error);
      }
      tx.oncomplete = () => res(result);
      tx.onerror = () => rej(tx.error);
    });
  },
  async load() {
    try {
      const items = await this._tx('readonly', st => st.get('items'));
      this.items = Array.isArray(items) ? items : [];
      this.version = await this._tx('readonly', st => st.get('version')) || '';
      this.updatedAt = await this._tx('readonly', st => st.get('updatedAt')) || null;
      this.scale = await this._tx('readonly', st => st.get('scale')) || null;
      this.reindex();
      this.ready = true;
    } catch { this.ready = false; }
    return this;
  },
  /** V4.9.8：条码全量索引（主码 + 辅助/称重码 + 包装码），离线扫码不再只认主条码 */
  reindex() {
    this.byBarcode = new Map();
    const put = (code, it) => {
      const k = this.normCode(code);
      if (k && !this.byBarcode.has(k)) this.byBarcode.set(k, it);
    };
    for (const it of this.items) {
      const codes = Array.isArray(it.barcodes) && it.barcodes.length ? it.barcodes : [it.barcode];
      (codes || []).forEach(c => put(c, it));
      put(it.barcode, it);
    }
  },
  /** 条码归一化：全角转半角、去空白、统一大写（与服务端 /products/barcode 同口径） */
  normCode(c) {
    return String(c ?? '')
      .replace(/[\uFF10-\uFF19]/g, x => String.fromCharCode(x.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, '')
      .toUpperCase();
  },
  async sync() {
    const d = await call('GET', '/pos/pricebook');
    if (d && d.scale) {
      this.scale = d.scale;
      await this._tx('readwrite', st => st.put(d.scale, 'scale')).catch(() => { });
    }
    if (d.version !== this.version) {
      await this._tx('readwrite', st => {
        st.put(d.items, 'items');
        st.put(d.version, 'version');
        st.put(new Date().toISOString(), 'updatedAt');
      });
      await this.load();
    } else if (!this.updatedAt) {
      await this._tx('readwrite', st => st.put(new Date().toISOString(), 'updatedAt'));
      this.updatedAt = new Date().toISOString();
    }
    return this;
  },
  /** 命中顺序：全码精确（含辅助码/包装码/二维码）→ 主码精确 → 名称/拼音/条码包含
   *  V4.9.8：精确匹配统一走归一化索引；包含匹配仅对 ≥4 位关键字生效，避免短码误命中 */
  find(key) {
    const raw = String(key || '').trim();
    if (!raw || !this.ready) return null;
    const k = this.normCode(raw);
    const exact = this.byBarcode.get(k);
    if (exact) return exact;
    const low = raw.toLowerCase();
    if (low.length >= 4) {
      for (const it of this.items) {
        if ((it.name || '').toLowerCase().includes(low)) return it;
        if ((it.barcode || '').toLowerCase().includes(low)) return it;
      }
    }
    return null;
  },
  info() {
    const ageHours = this.updatedAt ? Math.max(0, Math.round((Date.now() - new Date(this.updatedAt).getTime()) / 3600000)) : null;
    return {
      count: this.items.length, version: this.version, ageHours,
      fresh: ageHours === null ? false : ageHours <= 72,
      stale: ageHours !== null && ageHours > 24,
    };
  },
};
View.pricebookInfo = () => Pricebook.info();
window.Pricebook = Pricebook;   // 供调试与 CDP 测试访问（const 顶层不挂 window）

async function ensurePricebook() {
  if (!Pricebook.ready) await Pricebook.load();
  try { await Pricebook.sync(); } catch { /* 离线用缓存 */ }
}

/** VQA-P0（M8-02）：离线秤码本地解析——/products/scale-parse 不可达时的生鲜兜底。
 *  与服务端 scaleParse 同口径：模板归段（去点逐位对齐）、小数点锚、EAN mod10 校验位、
 *  PLU→goods_no/条码后缀定位；多候选=歧义拒收（宁拦不错收）；无模板/校验失败一律不成交 */
function scaleParseLocal(code) {
  const meta = Pricebook.scale || {};
  const tpl = String(meta.tpl || '').trim();
  if (!/^[FWENPCDOT.]{6,24}$/i.test(tpl)) return { hit: false, note: '离线无秤码模板配置' };
  const c = String(code || '').trim();
  if (!/^\d+$/.test(c)) return { hit: false, note: '非纯数字' };
  const stripped = tpl.toUpperCase().replace(/\./g, '');
  if (stripped.length !== c.length) return { hit: false, note: '长度不匹配' };
  const cpos = stripped.lastIndexOf('C');
  if (cpos >= 0 && String(meta.checkVerify || 'on') !== 'off') {
    let sum = 0, w = 3;
    for (let i = stripped.length - 1; i >= 0; i--) { if (i === cpos) continue; sum += Number(c[i]) * w; w = w === 3 ? 1 : 3; }
    if ((10 - (sum % 10)) % 10 !== Number(c[cpos])) return { hit: false, note: '秤码校验位验算失败（离线拒收）' };
  }
  const seg = { W: '', E: '', N: '', P: '', T: '' }, dp = { W: 0, E: 0, N: 0, P: 0, T: 0 };
  let lastChar = '';
  for (const ch of tpl.toUpperCase()) { if (ch === '.') { if (lastChar && dp[lastChar] != null) dp[lastChar]++; continue; } lastChar = ch; }
  for (let i = 0; i < stripped.length; i++) if (seg[stripped[i]] != null) seg[stripped[i]] += c[i];
  // VQA-GAP06：T 段=秤签打印日期（6位 YYMMDD / 8位 YYYYMMDD），与服务端同口径的有效期校验
  if (seg.T) {
    const days = Math.max(1, Number(meta.validDays) || 1);
    const ds = seg.T;
    let yy, mm, dd;
    if (ds.length === 6) { yy = 2000 + Number(ds.slice(0, 2)); mm = Number(ds.slice(2, 4)); dd = Number(ds.slice(4, 6)); }
    else if (ds.length === 8) { yy = Number(ds.slice(0, 4)); mm = Number(ds.slice(4, 6)); dd = Number(ds.slice(6, 8)); }
    else return { hit: false, note: 'T 段须 6 或 8 位' };
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return { hit: false, note: '秤签日期非法' };
    const label = new Date(yy, mm - 1, dd);
    const nowD = new Date();
    const diff = Math.round((new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()) - label) / 86400000);
    if (diff < 0) return { hit: false, note: '秤签日期在未来，拒收' };
    if (diff >= days) return { hit: false, note: `秤签已过期（${diff} 天前，有效期 ${days} 天）` };
  }
  const intOf = (k) => parseInt(seg[k] || '0', 10) || 0;
  const weightKg = dp.W > 0 ? intOf('W') / Math.pow(10, dp.W) : intOf('W') / 1000;
  const amount = intOf('E') / (dp.E > 0 ? Math.pow(10, dp.E) : 100);
  const unitPrice = intOf('P') / (dp.P > 0 ? Math.pow(10, dp.P) : 100);
  const plu = seg.N ? String(parseInt(seg.N.replace(/\D/g, '') || '0', 10)) : '';
  const out = { offline: true, format: tpl,
    weightKg: Math.round(weightKg * 1000) / 1000, amount: Math.round(amount * 100) / 100, unitPrice };
  if (!plu || plu === '0') return { hit: false, ...out, note: '无 PLU 段离线不可定位商品' };
  const cands = [];
  for (const it of Pricebook.items) {
    if (it.goodsNo && String(it.goodsNo) === plu) { cands.push(it); continue; }
    const codes = Array.isArray(it.barcodes) && it.barcodes.length ? it.barcodes : [it.barcode];
    if (codes.some(b => b && String(b).slice(-plu.length) === plu)) cands.push(it);
  }
  if (cands.length > 1) return { hit: false, ambiguous: true, candidates: cands.map(x => ({ id: Number(x.id), name: x.name })), ...out };
  const p = cands[0] || null;
  return { hit: !!p, product: p ? { id: Number(p.id), name: p.name, sellPrice: Number(p.sellPrice), baseUnit: p.baseUnit, isWeighted: !!p.isWeighted } : null, ...out };
}
window.QWScaleParseLocal = scaleParseLocal;

// ── 移动收银主屏 ──
View.checkout = function (v, opt) {
  const cart = [];   // {p, qty, manualPrice?, manualBarcode?}
  let emergency = !!(opt && opt.emergency);
  let member = null;      // {id, name, phone, balance}
  let payChannel = '现金';
  let scanRefNo = '';    // 扫码记账收款：顾客付款流水号后几位（二次确认弹窗采集，入 sale_payments.external_no）
  let gatewayNo = null;      // V4.13.2 通道扣款成功后的我方单号（pay_gateway_txns.out_trade_no）
  let gatewayTxnId = null;   // 通道流水号（入 sale_payments.external_no）
  let gatewayChannel = null; // 通道识别渠道：微信/支付宝
  let mpPreset = null;       // P2-3：余额组合支付的前置支付行（openMicropay 期间有效）
  let mpAmount = 0;          // P2-3：本次通道扣款金额（余额组合时=剩余部分）
  let ckInFlight = false; // 结账请求进行中（防双击重复下单）
  let heldId = null;      // V4.13.9 取单带入的挂单 id（结账成功后置已取单）
  let ckCloseDrawer = () => {};   // V5.0.7 购物车抽屉关闭（bind 时赋值；结账后收起抽屉露出结果条）

  // ── V5.0.5 手机正式收银：分类浏览 + 商品网格选品（数据来自 Pricebook 全量缓存） ──
  let curCat = '全部';
  const categories = {};   // id -> name
  function catName(id) { return categories[id] || '未分类'; }
  async function ensureCategories() {
    try {
      const d = await call('GET', '/products/categories');
      const arr = Array.isArray(d) ? d : (d.items || []);
      arr.forEach(c => { if (c && c.id != null) categories[c.id] = c.name; });
    } catch { /* 离线时按 id 显示，网格仍可用 */ }
  }
  function renderCats() {
    const box = $('#ckCats'); if (!box) return;
    const ids = [...new Set(Pricebook.items.map(it => it.categoryId ?? 0))];
    const cats = [{ id: '全部', name: '全部' }, ...ids.map(id => ({ id, name: catName(id) }))];
    box.innerHTML = cats.map(c => `<div class="ck-cat ${String(c.id) === String(curCat) ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</div>`).join('');
    box.querySelectorAll('.ck-cat').forEach(el => el.onclick = () => { curCat = el.dataset.cat; renderCats(); renderGrid(); });
  }
  /** V5.0.16：生鲜双码模型——只显示「有固定一维条码」的生鲜商品。
   *  纯称重/PLU 生鲜（isWeighted 且无固定条码）不入点选网格，避免误按「份」入车；
   *  它们仍可被条码秤标签扫码（/products/scale-parse）按重量入车。 */
  const isFreshScaleOnly = it => !!(it.isWeighted && !it.barcode);
  function renderGrid() {
    const box = $('#ckGrid'); if (!box) return;
    const list = Pricebook.items.filter(it =>
      (String(curCat) === '全部' || String(it.categoryId ?? 0) === String(curCat)) && !isFreshScaleOnly(it));
    if (!list.length) { box.innerHTML = '<div class="hint" style="grid-column:1/-1;text-align:center;padding:40px 0">该分类未添加商品!</div>'; return; }
    box.innerHTML = list.map(p => `
      <div class="ck-card" data-add="${p.id}">
        ${stockBadge(p)}
        <div class="n">${esc(p.name)}</div>
        <div class="p">¥${money(p.sellPrice ?? p.sell_price ?? 0)}</div>
        ${p.memberPrice ? `<div class="m">会员 ¥${money(p.memberPrice)}</div>` : ''}
        ${p.spec ? `<div class="barcode">${esc(p.spec)}</div>` : ''}
      </div>`).join('');
    box.querySelectorAll('[data-add]').forEach(el => el.onclick = () => {
      const p = Pricebook.items.find(x => Number(x.id) === Number(el.dataset.add));
      if (p) { addCart(p); renderCart(); toast('已加入：' + p.name); }
    });
    refreshStock(list.map(p => Number(p.id)));
  }
  function ensureStyle() {
    if (document.getElementById('ckSilverStyle')) return;
    const st = document.createElement('style'); st.id = 'ckSilverStyle';
    st.textContent = `
      /* V5.0.7 银豹式手机正式收银：顶部搜索 + 左分类栏/右商品网格 + 底部结算条 + 购物车抽屉 */
      .ck-main{flex:1;display:flex;min-height:0;margin-bottom:64px;background:var(--paper);}
      .ck-cats{width:96px;flex:none;overflow-y:auto;background:#fff;border-right:1px solid var(--line);-webkit-overflow-scrolling:touch;}
      .ck-cat{padding:13px 6px;text-align:center;font-size:12.5px;color:var(--ink-2);cursor:pointer;border-bottom:1px solid var(--paper-2);word-break:break-all;line-height:1.35;}
      .ck-cat.on{background:var(--paper);color:var(--pri);font-weight:800;box-shadow:inset 3px 0 0 var(--pri);}
      .ck-right{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;}
      .ck-grid{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:min-content;gap:8px;padding:8px;align-content:start;-webkit-overflow-scrolling:touch;-webkit-text-size-adjust:100%;text-size-adjust:100%;}
      .ck-card{position:relative;min-width:0;background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 9px;cursor:pointer;overflow:hidden;}
      .ck-card:active{background:var(--green-soft);transform:scale(.98);}
      .ck-card .n{font-size:13.5px;font-weight:700;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;padding-right:56px;word-break:break-word;}
      .ck-card .p{font-size:15px;font-weight:800;color:var(--pri);margin-top:4px;}
      .ck-card .m{font-size:11px;color:var(--ink-3);}
      .ck-card .barcode{font-size:10px;color:var(--ink-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .ck-stockpill{position:absolute;top:6px;right:7px;font-size:10px;border-radius:8px;padding:1px 7px;background:var(--paper-2);color:var(--ink-2);font-weight:600;}
      .ck-stockpill.low{background:#fdf3d8;color:#b07207;}
      .ck-stockpill.out{background:#ffe0e0;color:#c00;}
      .ck-topbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
      .ck-topbar span{font-weight:800;color:var(--pri);font-size:15px;}
      .ck-pbstate{font-size:12px;color:var(--ink-3);margin-left:auto;}
      #ckTools{display:flex;gap:6px;padding:6px 0;}
      #ckTools .mini-btn{flex:1;text-align:center;padding:8px 0;}
      /* 底部结算条（银豹式一行）：取单 | 购物车金额 | 结账 */
      .ck-bottom{padding:8px 12px;}
      .ck-bottom .ck-actions{display:flex;gap:8px;align-items:stretch;}
      .ck-bottom .ck-actions .btn{padding:12px 0;font-size:15px;border-radius:10px;}
      .ck-cart-info{flex:1.7;display:flex;align-items:center;justify-content:center;gap:6px;background:#ececec;border:none;border-radius:10px;color:#333;cursor:pointer;white-space:nowrap;}
      .ck-cart-info .money{font-size:17px;font-weight:800;color:#111;}
      .ck-cart-info small{font-size:11px;color:#888;margin-left:2px;}
      /* 购物车抽屉（点购物车金额 / 结账弹出）：明细 + 支付方式 + 合计 + 挂单/清空/结账 */
      #ckDrawer .sheet{max-height:calc(var(--vhs,100vh)*0.88);display:flex;flex-direction:column;overflow:hidden;}
      #ckDrawer .ck-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;}
      #ckNotice .ok-bar,#ckNotice .warn-bar{margin:0 0 6px;}
      /* V5.0.12f 会员浮动按钮：主界面右上常驻，弹窗完成选/建会员，不再占用购物车空间 */
      #ckMemberFab{position:fixed;right:10px;bottom:calc(var(--tabbar-h,57px) + 78px);
        width:46px;height:46px;border-radius:50%;background:var(--pri,#20663f);color:#fff;
        font-size:20px;border:none;box-shadow:0 3px 12px rgba(0,0,0,.3);z-index:45;
        display:flex;align-items:center;justify-content:center;line-height:1;}
      #ckMemberFab:active{transform:scale(.94);}
      #ckMemberFab.has-m{background:var(--ok,#2e7a4e);}
      #ckMemberFab .fab-badge{position:absolute;top:-2px;right:-2px;width:12px;height:12px;
        border-radius:50%;background:var(--warn,#d98a00);border:2px solid #fff;}`;
    document.head.appendChild(st);
  }

  const render = () => {
    const info = Pricebook.info();
    const pbState = !Pricebook.ready ? '同步中…'
      : info.count === 0 ? '价格表为空（未同步）'
      : `${info.count} 条 · ${info.ageHours}h 前` + (info.stale ? ' · ⚠️ 已过 24h' : '') + (info.fresh ? '' : ' · 🚫 超 72h 禁应急');
    const freshOk = info.fresh;
    v.innerHTML = `
      <div class="ck-topbar">
        <span>💳 移动收银${emergency ? '<small style="color:var(--orange);margin-left:6px">⚡ 应急</small>' : ''}</span>
        <span class="ck-pbstate">${esc(pbState)}</span>
      </div>
      ${(typeof isBoss === 'function' && isBoss())
        ? '<div class="ck-tools" style="margin:0 0 6px;"><button class="mini-btn" id="ckBackBoss">👑 返回老板端</button></div>' : ''}
      <input id="ckScan" class="search ck-scan" placeholder="🔍 扫码 / 搜索商品" autocomplete="off">
      <div id="ckResults" class="hidden"></div>
      <div id="ckTools">
        <button class="mini-btn" id="ckAi">🤖 AI智拍</button>
        <button class="mini-btn" id="ckSp">🛒 核销</button>
        <button class="mini-btn" id="ckVoice">🎤 语音</button>
        ${hasPerm('pos.emergency.manual') ? '<button class="mini-btn" id="ckManual">✍️ 手输</button>' : ''}
      </div>
      <div class="ck-main">
        <div class="ck-cats" id="ckCats"></div>
        <div class="ck-right"><div class="ck-grid" id="ckGrid"></div></div>
      </div>
      <div id="ckNotice"></div>
      <button id="ckMemberFab" title="会员">👤</button>
      <div class="ck-sticky ck-bottom">
        <div class="ck-actions">
          <button class="btn" id="ckTake" style="flex:1">📥 取单</button>
          <div class="ck-cart-info" id="ckCartOpen"><span>🛒</span><span class="money" id="ckInfoTotal">¥0.00</span><small id="ckInfoCnt">0 件</small></div>
          <button class="btn ok" id="ckCheckout" style="flex:1.4">结 账</button>
        </div>
      </div>
      <div class="modal" id="ckDrawer" style="display:none">
        <div class="sheet">
          <h3>🛒 购物车 <span id="ckCnt" style="font-size:12px;color:var(--ink-3);font-weight:400"></span>
            <button class="mini-btn" id="ckDrawerClose" style="float:right">收起</button></h3>
          <div class="ck-body">
            <div id="ckCart"></div>
            <div id="ckMember"></div>
          </div>
          <div class="seg" id="ckPay" style="margin:8px 0 0">
            <button data-ch="现金" class="on">现金</button>
            <button data-ch="扫码">扫码</button>
            <button data-ch="余额">余额</button>
          </div>
          <div class="ck-optrow" id="ckDiscRow" style="display:flex;align-items:center;gap:8px;margin:6px 0">
            <span style="font-size:13px;color:var(--ink-2);flex:none">整单折扣</span>
            <span id="ckDiscSlot" style="display:flex;gap:6px;flex-wrap:wrap;flex:1;justify-content:flex-end"></span>
          </div>
          <div class="total-bar" style="margin:8px 0">
            <span>合计</span><span class="money" id="ckTotal">¥0.00</span>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" id="ckHold" style="flex:1;font-size:14px">📥 挂单</button>
            <button class="btn ghost" id="ckClear" style="flex:1;font-size:14px">🗑 清空</button>
            <button class="btn ok" id="ckGo" style="flex:2;font-size:16px;font-weight:700">结 账</button>
          </div>
        </div>
      </div>`;
    v.style.display = 'flex';
    v.style.flexDirection = 'column';
    v.style.height = '100%';
    v.style.overflow = 'hidden';
    bind();
    renderCart();
    applyHand();   // V4.13.9 左右手习惯：按后台设置镜像按钮排布
  };

  /** V4.27.1 Q7 生鲜称重复核：拿到重量（秤码解析/串口读重）后比对单件重量期望区间，越界提示复核 */
  async function warnWeightOut(pid, kg) {
    try {
      const g = Math.round(Number(kg) * 1000);
      if (!(g > 0)) return;
      const r = unwrap(await call('POST', '/ai/weight-check', { productId: Number(pid), weightG: g }));
      if (r && r.checked && !r.ok) toast(r.message || `重量越界：${g}g，请复核`, false);
    } catch { /* 校验失败不阻断收银 */ }
  }

  function bind() {
    const ckEmg = $('#ckEmg'); if (ckEmg) ckEmg.onchange = () => { emergency = ckEmg.checked; render(); };
    Scanner.attach($('#ckScan'), async key => {
      // V4.16.5 条码秤码：纯数字且未在价目表直命中时，按后台「条码秤格式」解析（重量+金额 → 按重量入车）
      if (/^\d{10,18}$/.test(key) && !Pricebook.find(key)) {
        let sp = null;
        try {
          sp = unwrap(await call('GET', '/products/scale-parse/' + encodeURIComponent(key)));
        } catch {
          sp = scaleParseLocal(key);   // VQA-P0（M8-02）：断网→本地同口径解析（校验失败/无 PLU/歧义均拒）
          if (sp && sp.hit) sp.product = { ...sp.product };
        }
        if (sp && sp.ambiguous) {
          toast('⚖ 秤码命中多个商品：' + (sp.candidates || []).map(x => x.name).join('、') + '，请搜索/选品录入');
          return;
        }
        if (sp && sp.hit && sp.product) {
            const base = Pricebook.find(String(sp.product.id)) || normProduct({ id: sp.product.id, name: sp.product.name, sell_price: sp.product.sellPrice, base_unit: sp.product.baseUnit, is_weighted: true });
            const kg = Number(sp.weightKg) || 0;
            if (kg > 0.001) {
              // VQA（DEF-05 / 对齐桌面端）：带金额秤签一律独立行（两张签=两行、金额各按各签），禁止并入他签；无金额签按售价合并
              const id = Number(base.id);
              if (sp.amount > 0) {
                cart.push({ p: { ...base, id }, qty: Number(kg.toFixed(3)), manualPrice: Number((sp.amount / kg).toFixed(3)) });
              } else {
                const line = cart.find(l => l.p.id === id && l.manualPrice == null);
                if (line) line.qty = Number((line.qty + kg).toFixed(3));
                else cart.push({ p: { ...base, id }, qty: Number(kg.toFixed(3)) });
              }
              renderCart(); $('#ckScan').value = '';
              warnWeightOut(base.id, kg);   // V4.27.1 Q7：秤码重量 vs 期望区间复核
              toast(`⚖ 秤码识别${sp.offline ? '（离线）' : ''}：${sp.product.name} ${kg.toFixed(3)}kg${sp.amount > 0 ? ' ¥' + money(sp.amount) : ''}`);
              return;
            }
        }
      }
      // V4.9.8：统一走 scanResolve（归一化 + 二维码/多码回退 + 未命中可行动提示）
      await scanResolve(key, p => { addCart(p); $('#ckScan').value = ''; },
        async (kw, aiItems) => {
          if (aiItems) {
            let n = 0;
            for (const it of aiItems) {
              const p2 = await productById(it.productId);
              if (p2) { addCart(p2, Math.max(1, Number(it.count) || 1)); n++; }
            }
            toast(n ? `已按 AI 识别加入 ${n} 种商品` : 'AI 也未识别出商品：请先采集样本');
            return;
          }
          if (!kw) return;
          const p2 = await lookupProduct(kw);
          if (p2) { addCart(p2); $('#ckScan').value = ''; } else toast('仍未找到商品：' + kw);
        });
    });
    // 搜索联想
    // V5.0.8d 修复「输入条码一秒一个数字」：
    //  原实现绑在 input 上做联想（300ms 防抖），逐字上屏即过滤价目表 + 重绘整个联想框，
    //  13 位 EAN 就要重排 13 次，手机输入法下体感是「一个字卡一下」。
    //  现在：① 纯数字输入（条码/PLU/秤码）直接跳过联想，交由扫码枪或 Enter 走 scanResolve；
    //       ② 联想改为 change + 显式「↵ 搜索」提示，只在用户停止输入并离开输入框时跑一次。
    const isDigits = s => /^\d*$/.test(s);
    $('#ckScan').addEventListener('input', () => {
      const kw = $('#ckScan').value.trim();
      const box = $('#ckResults');
      // 数字串：条码场景，隐藏联想、绝不逐字请求
      if (!kw || isDigits(kw)) { box.classList.add('hidden'); return; }
    });
    $('#ckScan').addEventListener('change', async () => {
      const kw = $('#ckScan').value.trim();
      const box = $('#ckResults');
      if (!kw || isDigits(kw)) { box.classList.add('hidden'); return; }   // 条码不进联想
      const list = Pricebook.ready
        ? Pricebook.items.filter(it => (it.name || '').toLowerCase().includes(kw.toLowerCase()) && !isFreshScaleOnly(it)).slice(0, 6)
        : await searchProducts(kw);
      if (!list.length) { box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      box.innerHTML = list.map(p => `
        <div class="row" data-add="${p.id}" style="margin:4px 0">
          <div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.spec || '')} · ¥${money(p.sellPrice ?? p.sell_price ?? 0)}</div></div>
        </div>`).join('');
      box.querySelectorAll('[data-add]').forEach(el => el.onclick = () => {
        const p = list.find(x => Number(x.id) === Number(el.dataset.add));
        if (p) { addCart(p); $('#ckScan').value = ''; box.classList.add('hidden'); }
      });
    });
    $('#ckManual') && ($('#ckManual').onclick = () => manualEntry(v));
    // V4.15.2 修复：取单/挂单此前从未绑定点击事件（按钮点击无反应的根因），并移入底部固定栏与结账并列
    // V4.15.3：电子秤/钱箱/小票机连接移至「我的-设备管理」（收银页只留业务按钮）
    $('#ckTake').onclick = () => takeOrder();
    $('#ckHold').onclick = () => holdOrder();
    // V5.0.7 银豹式：底部「购物车金额/结账」弹出购物车抽屉（明细+支付方式都在抽屉里）
    const drawer = $('#ckDrawer');
    const openDrawer = () => { drawer.style.display = 'flex'; };
    ckCloseDrawer = () => { drawer.style.display = 'none'; };
    $('#ckCartOpen').onclick = openDrawer;
    $('#ckCheckout').onclick = openDrawer;
    $('#ckDrawerClose').onclick = ckCloseDrawer;
    const mFab = $('#ckMemberFab'); if (mFab) mFab.onclick = () => openMemberPopup();   // V5.0.12f 会员浮动按钮
    drawer.addEventListener('click', e => { if (e.target === drawer) ckCloseDrawer(); });
    $('#ckClear').onclick = () => {
      if (!cart.length) { toast('购物车已是空的'); return; }
      pwaConfirm('清空购物车', '确认清空当前购物车的全部商品？').then(ok => {
        if (!ok) return;
        cart.length = 0; member = null;
        renderCart(); renderMember();
      });
    };
    // V5.0.11：老板从收银通道一键返回老板端（普通员工不渲染该按钮，无需处理）
    const backBoss = $('#ckBackBoss');
    if (backBoss) {
      backBoss.onclick = () => {
        // 购物车有内容时先确认，避免误触丢失已扫码商品
        if (cart.length) {
          if (!confirm('购物车还有 ' + cart.length + ' 件商品，返回老板端将清空，确定继续？')) return;
        }
        // 老板端是独立应用，需整页跳转；同时同步登录态避免二次登录
        // V5.0.13：URL 按部署形态解析——浏览器端 PWA 在 /pwa/ 下、老板端在 /boss/，
        // 旧代码写死相对路径 'boss/index.html' 会落到 /pwa/boss/index.html（404）→ 老板回不去看板
        try { localStorage.setItem('boss_token', TOKEN); } catch { }
        try { const dc = localStorage.getItem('pwa_device_code'); if (dc) localStorage.setItem('boss_device_code', dc); } catch { }
        location.href = /\/pwa\//.test(location.pathname) ? '../boss/index.html' : 'boss/index.html';
      };
    }
    $('#ckAi').onclick = () => AiScan.open({      scene: 'checkout',
      title: 'AI 多商品识别收银',
      onConfirm: chosen => {
        chosen.forEach(it => {
          const p = Pricebook.items.find(x => Number(x.id) === Number(it.productId)) ||
                    { id: it.productId, name: it.name, sellPrice: 0, barcode: '', spec: '' };
          addCart(p, it.count);   // 统一入口：id 归一化 + 同商品合并 + 库存预警（价格表 id 是字符串，必须 Number 化后比较）
        });
        renderCart();
        toast(`已加入 ${chosen.length} 种商品`);
        // V4.13 漏扫检测 MVP（店员端 informational）：识别件数 vs 购物车件数，差异仅提示不拦单
        try {
          call('POST', '/antileak/verify', {
            items: cart.filter(l => l.qty > 0).map(l => ({ productId: l.p.id, qty: l.qty })),
            aiItems: chosen.map(it => ({ productId: Number(it.productId), count: Number(it.count) || 1 })),
          }).then(vr => {
            if (vr && vr.diffs && vr.diffs.length) {
              toast(`⚠️ 漏扫提示：${vr.diffs.map(d => `${d.name} 识别${d.expected}/车${d.actual}`).join('；')}`);
            }
          }).catch(() => {});
        } catch { /* 静默 */ }
      },
    });
    // V4.14.0 S：扫码购核销（前台抽检/放行；后台不再校验）——输入 6 位核销码查订单并留痕
    $('#ckSp').onclick = () => {
      const m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = `<div class="sheet">
        <h3>🛒 扫码购核销</h3>
        <div class="hint" style="margin-bottom:8px">顾客结算后在出口出示 6 位核销码：&gt;100 元必检，其余 10% 抽检；核销即放行留痕</div>
        <div class="field"><input id="spCode" class="search" placeholder="输入 6 位核销码" inputmode="numeric" maxlength="6" autocomplete="off"></div>
        <div id="spRes"></div>
        <button class="btn ok" id="spGo" style="width:100%;margin-top:10px">核销</button>
        <button class="btn ghost" id="spClose" style="width:100%;margin-top:8px">关闭</button></div>`;
      document.body.appendChild(m);
      setTimeout(() => $('#spCode')?.focus(), 60);
      m.querySelector('#spClose').onclick = () => m.remove();
      const doVerify = async () => {
        const code = $('#spCode').value.trim();
        const box = $('#spRes');
        if (!code) { box.innerHTML = '<div class="hint">请输入核销码</div>'; return; }
        try {
          const d = await call('POST', '/sales/verify-code', { code });
          const tag = d.needCheck === '必检' ? '⚠️ 必检' : d.needCheck === '抽检' ? '🔍 抽检' : '✅ 放行';
          box.innerHTML = `<div class="row" style="margin:8px 0"><div class="grow">
              <div class="t">${esc(d.orderNo)} ${tag}</div>
              <div class="s">会员 #${d.memberId ?? '散客'} · ${d.itemCount} 件 · 实付 ¥${money(d.amount)} · 核销 ${dt(d.verifiedAt)}</div></div></div>
            <table class="tbl">${d.items.map(i => `<tr><td>${esc(i.name)}</td><td style="text-align:right">×${Number(i.qty)}</td><td style="text-align:right">¥${money(i.line_amount)}</td></tr>`).join('')}</table>`;
          $('#spCode').value = '';
          renderCart();
        } catch (e) { box.innerHTML = `<div class="hint" style="color:var(--bad)">核销失败：${esc(e.message || e)}</div>`; }
      };
      m.querySelector('#spGo').onclick = doVerify;
      $('#spCode').addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });
    };
    // V4.13 ⑤ 语音查价单点：Web Speech API 本地识别 → Pricebook 查价 → TTS 报价（零云端）
    // V4.13.1 修复：模板未渲染 #ckVoice 时跳过绑定（此前 null.onclick 抛错，阻断后续支付/结账按钮绑定）
    const voiceBtn = $('#ckVoice');
    voiceBtn && (voiceBtn.onclick = async () => {
      if (typeof Voice === 'undefined') { toast('语音组件未加载'); return; }
      if (!Voice.supported()) { toast('浏览器不支持语音识别：请用 Chrome/Edge（HTTPS）打开'); return; }
      const btn = $('#ckVoice');
      btn.disabled = true;
      await Voice.priceLookup(r => {
        if (r.listening) { btn.textContent = '🎤 听录中…'; return; }
        toast(r.text);
        if (r.ok) { $('#ckScan').value = ''; }
      }).catch(e => toast(e.message || '语音查价失败')).finally(() => { btn.textContent = '🎤 语音查价'; btn.disabled = false; });
    });
    $('#ckPay').querySelectorAll('button').forEach(b => b.onclick = () => {
      payChannel = b.dataset.ch;
      $('#ckPay').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderMember();
      renderCart();
    });
    $('#ckGo').onclick = async () => {
      // V5.0.12g：不再弹「本单有会员吗」——挂会员已前置到右上浮动按钮（未挂=散客直接结账），
      // 避免每次结账都被弹窗打断；且结账成功后会员自动清空，防下一位顾客误用上一位的积分/余额。
      // V4.13.2 成熟做法：扫码通道 → 扫顾客付款码通道扣款，成功应答自动落单（免人工核对到账）；
      // 通道未启用（40900 记账式）回退 V4.13.1 二次确认；通道已扣款但未落单时直接重试结账（幂等不重复扣款）
      // P2-3（2026-09-18 口径）：余额通道余额不足 → 自动组合（余额抵一部分 + 现金/扫码当场结清，不赊账）
      if (payChannel === '扫码') { gatewayTxnId ? checkout() : openMicropay(); return; }
      if (payChannel === '余额') {
        // P2-3：组合扫码部分已通道扣款但落单失败 → 直接重试落单（幂等），绝不重扫付款码（防双重扣款）
        if (gatewayTxnId) { checkout(presetRow()); return; }
        if (!member) { toast('余额支付请先选择会员'); return; }
        const bal = Math.round(Number(member.balance || 0) * 100) / 100;
        const valid = cart.filter(l => l.qty > 0);
        const goodsAmt0 = valid.reduce((s, l) => s + l.qty * linePrice(l), 0);
        const total = orderDisc ? Math.round(goodsAmt0 * orderDisc.rate / 100 * 100) / 100 : goodsAmt0;
        if (bal >= total || !(total > 0)) { checkout(); return; }
        if (bal <= 0) { toast('会员余额不足（¥0.00）：请改用现金/扫码收款（不赊账）'); return; }
        openBalanceCombo(total, bal);
        return;
      }
      checkout();
    };
    renderCats();
    renderGrid();
  }

  /** P2-3 余额组合支付弹窗（2026-09-18 口径）：余额抵一部分，剩余当场收现金/扫付款码，不产生欠款 */
  function openBalanceCombo(total, bal) {
    const rest = Math.round((total - bal) * 100) / 100;
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>💳 余额不足 · 组合支付</h3>
      <div class="muted" style="font-size:13px">会员 ${esc(member.name || member.phone || '')} · 余额 ¥${money(bal)}</div>
      <div style="display:flex;gap:10px;margin:10px 0">
        <div style="flex:1;text-align:center;padding:8px;border:1px dashed var(--line);border-radius:10px">
          <div class="muted" style="font-size:12px">余额抵扣</div>
          <div style="font-size:22px;font-weight:800;font-family:var(--mono)">¥${money(bal)}</div></div>
        <div style="flex:1;text-align:center;padding:8px;border:1px dashed var(--line);border-radius:10px">
          <div class="muted" style="font-size:12px">还需收款</div>
          <div style="font-size:22px;font-weight:800;color:var(--pri-2);font-family:var(--mono)">¥${money(rest)}</div></div>
      </div>
      <div class="hint" style="margin-bottom:8px">剩余部分需<b>当场结清</b>（不赊账）：请选择收款方式。</div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost" id="bcNo" style="flex:1">取消</button>
        <button class="btn" id="bcCash" style="flex:1.2">收现金</button>
        <button class="btn ok" id="bcScan" style="flex:1.6">扫顾客付款码</button>
      </div></div>`;
    document.body.appendChild(m);
    m.querySelector('#bcNo').onclick = () => m.remove();
    m.querySelector('#bcCash').onclick = () => {
      m.remove();
      checkout([{ channel: '余额', amount: bal }, { channel: '现金', amount: rest }]);
    };
    m.querySelector('#bcScan').onclick = () => {
      m.remove();
      openMicropay(rest, [{ channel: '余额', amount: bal }]);
    };
  }

  /** 付款码 → 渠道（与服务端 detectChannel 同规则：微信 10~15 / 支付宝 25~30 开头，16~32 位数字） */
  function payChannelOf(code) {
    const c = String(code || '').trim();
    if (!/^\d{16,32}$/.test(c)) return null;
    if (/^1[0-5]/.test(c)) return '微信';
    if (/^(2[5-9]|30)/.test(c)) return '支付宝';
    return null;
  }

  /** V4.13.2 通道扣款（被扫 B-scan-C）：扫顾客付款码 → /pay/micropay → 成功应答自动落单
   *  P2-3：amount/preset 可选 —— 余额组合支付时 amount=剩余金额、preset=余额前置行 */
  function openMicropay(amountOverride, presetPays) {
    const valid = cart.filter(l => l.qty > 0);
    if (!valid.length) { toast('购物车为空'); return; }
    const goodsAmt2 = valid.reduce((s, l) => s + l.qty * linePrice(l), 0);
    const discTotal2 = orderDisc ? Math.round(goodsAmt2 * orderDisc.rate / 100 * 100) / 100 : goodsAmt2;
    const total = amountOverride != null ? amountOverride : discTotal2;
    mpPreset = Array.isArray(presetPays) && presetPays.length ? presetPays : null;   // P2-3
    mpAmount = total;                                                                 // P2-3
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>📲 扫顾客付款码收款</h3>
      <div style="text-align:center;padding:8px 0">
        <div class="muted" style="font-size:13px">应收金额</div>
        <div style="font-size:34px;font-weight:800;color:var(--pri-2);font-family:var(--mono)">¥${money(total)}</div>
      </div>
      <div class="muted" style="font-size:12px;text-align:center;margin-bottom:8px">
        支持微信 / 支付宝<b>一维付款码</b>与<b>二维码</b>；也可下面手输或用扫码枪直扫
      </div>
      <div class="field"><label>顾客付款码（扫码枪直扫，回车确认）</label>
        <div style="display:flex;gap:8px">
          <input id="mpCode" type="text" inputmode="numeric" autocomplete="off" placeholder="微信 10~15 / 支付宝 25~30 开头" style="flex:1;min-width:0">
          <button class="mini-btn" id="mpCamBtn" style="flex-shrink:0;padding:10px 14px;font-weight:600">📷 扫码</button>
        </div></div>
      <div id="mpCh" class="muted" style="font-size:13px;min-height:20px">请扫描顾客付款码…</div>
      <div id="mpErr" style="color:#d33;font-size:13px;min-height:20px"></div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost" id="mpNo" style="flex:1">取消</button>
        <button class="btn ok" id="mpOk" style="flex:1">通道扣款并结账</button>
      </div></div>`;
    document.body.appendChild(m);
    const inp = $('#mpCode'); inp && inp.focus();

    /* V5.0.11m：摄像头扫码入口。
     * 现场问题（真机反馈）：此前只有「扫码枪直扫 / 手输」两种方式，**没有摄像头**，
     * 收银员必须让顾客把付款码怼到扫码枪上，或手敲 18~30 位数字 —— 都不符合实际操作。
     * 顾客手机屏幕上的付款码既有的一维（微信 18 位 / 支付宝 25~30 位），也有二维码，
     * 所以这里复用 work.js 的 Scanner（原生 BarcodeDetector 优先 → zxing-wasm 兜底），
     * 它已覆盖 ean/code128/qr_code 等格式，两类码都能识别。 */
    /* 顾客付款码可能是一维（微信/支付宝的数字码）或二维码，
     * BarcodeDetector 需要显式给出要识别的格式；SCAN_FORMATS 定义在 work.js 里，
     * checkout.js 作用域拿不到，故此处独立定义一份（含 qr_code 与主流一维格式）。 */
    const SCAN_FORMATS_CAM = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf'];

    const mpCam = async () => {
      const host = document.createElement('div');
      host.className = 'modal';
      host.innerHTML = `<div class="sheet">
        <h3 style="display:flex;align-items:center">📷 扫顾客付款码<button class="mini-btn" id="mpcX" style="margin-left:auto;flex-shrink:0">关闭</button></h3>
        <div class="scan-view">
          <video id="mpcVideo" playsinline muted style="width:100%;border-radius:12px;background:#000;max-height:calc(var(--vhs,100vh)*0.46);object-fit:cover"></video>
          <div class="scan-frame">
            <div class="sc-corner tl"></div><div class="sc-corner tr"></div>
            <div class="sc-corner bl"></div><div class="sc-corner br"></div>
            <div class="sc-baseline"></div>
          </div>
        </div>
        <div class="hint" style="margin-top:10px">把顾客付款码对准框内（<b>一维码请横着扫</b>，二维码对准中心），识别到后自动返回</div>
        <div class="muted" style="font-size:11.5px;margin-top:6px">⚠ 请勿拍照或截屏收款，需顾客当面出示付款码</div>
      </div>`;
      document.body.appendChild(host);
      const closeHost = () => { try { stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ } host.remove(); };
      host.querySelector('#mpcX').onclick = closeHost;
      const video = host.querySelector('#mpcVideo');
      let stream = null, stopped = false, timer = 0;
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('本机不支持摄像头');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
        });
        video.srcObject = stream;
        await video.play().catch(() => { /* 自动播放被拦时忽略，帧仍可读 */ });
        const tick = async () => {
          if (stopped) return;
          try {
            /* V5.0.12g：改走 BarcodeDecode 多引擎链（原生 zxing 插件 → BarcodeDetector → zxing-wasm）。
             * 原实现只认 BarcodeDetector/旧 ZXing——本机 WebView（Chrome/103）无 BarcodeDetector、
             * 旧 ZXing 分支又可能缺失 → tick 空转，「取景框无法识别一维/二维码」的真机根因。 */
            if (typeof BarcodeDecode !== 'undefined') {
              const codes = await (BarcodeDecode.decodeStep ? BarcodeDecode.decodeStep(video) : BarcodeDecode.decode(video));
              const hit = (codes || []).find(c => c && c.text);
              if (hit) { stopped = true; closeHost(); onScanned(hit.text); return; }
            } else if (Scanner.hasNative()) {
              const det = new BarcodeDetector(SCAN_FORMATS_CAM);
              const rs = await det.detect(video);
              if (rs && rs.length) { stopped = true; closeHost(); onScanned(rs[0].rawValue); return; }
            }
          } catch { /* 单帧失败继续 */ }
          timer = requestAnimationFrame(tick);
        };
        timer = requestAnimationFrame(tick);
      } catch (e) {
        closeHost();
        $('#mpErr').textContent = '摄像头不可用：' + ((e && e.message) || e) + '（可改用下方手输或扫码枪）';
        return;
      }
      function onScanned(text) {
        const code = String(text || '').trim();
        if (!code) return;
        // 顾客付款码识别特征校验，避免把商品码/二维码误当付款码提交到通道
        const ch = payChannelOf(code);
        $('#mpCode').value = code;
        $('#mpCh').innerHTML = ch ? ('已识别：<b>' + esc(ch) + '</b> · ' + code.slice(0, 10) + '…') : ('已扫到：' + code.slice(0, 24) + '（未识别渠道，仍可尝试扣款）');
        $('#mpErr').textContent = '';
        toast('已识别付款码，正在扣款…');
        go();
      }
    };
    $('#mpCamBtn') && ($('#mpCamBtn').onclick = mpCam);
    $('#mpCode').addEventListener('input', () => {
      const ch = payChannelOf($('#mpCode').value);
      $('#mpCh').innerHTML = ch ? `已识别渠道：<b>${ch}</b>` : '请扫描顾客付款码…';
      $('#mpErr').textContent = '';
    });
    $('#mpNo').onclick = () => m.remove();
    const go = async () => {
      const code = $('#mpCode').value.trim();
      if (!code) { $('#mpErr').textContent = '请先扫描顾客付款码'; return; }
      const btn = $('#mpOk'); btn.disabled = true; btn.textContent = '通道扣款中…';
      try {
        const d = await call('POST', '/pay/micropay', {
          authCode: code, amount: Number(total.toFixed(2)),
          outTradeNo: 'M' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), // 幂等单号：重试不重复扣款
        });
        if (!d?.success && d?.pending) {
          // V4.13.4 USERPAYING：顾客输入密码中，后端轮询用尽 → 前端继续查单兜底（不重复扫码）
          btn.disabled = true; btn.textContent = '等待顾客确认支付…';
          $('#mpCh').innerHTML = '⏳ 顾客支付确认中，请顾客完成密码输入…';
          const ok = await pollPayTxn(d.outTradeNo, 40);
          if (ok?.success) {
            gatewayChannel = ok.channel || d.channel; gatewayNo = ok.outTradeNo || d.outTradeNo; gatewayTxnId = ok.transaction_id;
            m.remove(); checkout(presetRow()); return;
          }
          $('#mpErr').textContent = ok ? '顾客未完成支付，请重新扫码或换收款方式' : '查单超时：请稍后在「单据-收款流水」中查单确认，勿让顾客提前离场';
          $('#mpCh').textContent = '请扫描顾客付款码…';
          btn.disabled = false; btn.textContent = '通道扣款并结账';
          return;
        }
        if (!d?.success) {
          $('#mpErr').textContent = d?.failMsg || '通道扣款失败，请重新扫码或换收款方式';
          $('#mpCh').textContent = '请扫描顾客付款码…';
          btn.disabled = false; btn.textContent = '通道扣款并结账';
          return;
        }
        gatewayChannel = d.channel; gatewayNo = d.outTradeNo; gatewayTxnId = d.transactionId;
        m.remove();
        checkout(presetRow());  // 通道成功应答驱动落单：无需人工勾选确认
      } catch (e) {
        if (/通道未启用/.test(e.message || '')) { m.remove(); confirmScanPay(); return; } // 记账式回退
        $('#mpErr').textContent = e.message || '网络异常，请检查通道服务后重试';
        btn.disabled = false; btn.textContent = '通道扣款并结账';
      }
    };
    $('#mpOk').onclick = go;
    $('#mpCode').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
  }

  /** P2-3：余额组合时构造支付行（余额前置行 + 网关行）；普通扫码返回空（走默认构造） */
  function presetRow() {
    if (!Array.isArray(mpPreset) || !mpPreset.length) return null;
    return [...mpPreset, {
      channel: gatewayChannel || '微信', amount: Number(mpAmount.toFixed(2)),
      externalNo: gatewayTxnId, gatewayOutTradeNo: gatewayNo,
    }];
  }

  /** V4.13.4 查单兜底轮询：GET /pay/txn/:no（PENDING 行后端会自动向通道补查），成功返回流水对象 */
  async function pollPayTxn(outTradeNo, maxTries = 40) {
    for (let i = 0; i < maxTries; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const t = await call('GET', '/pay/txn/' + encodeURIComponent(outTradeNo));
        if (t?.status === 'SUCCESS') return t;
        if (['FAIL', 'CLOSED', 'REVOKED', 'PAYERROR', 'NOT_PAY'].includes(t?.status)) return null;
      } catch { /* 网络抖动继续轮询 */ }
    }
    return undefined; // 超时
  }

  /** 扫码记账收款二次确认（对比报告自查风险①过渡方案）：核对到账金额 + 可选流水号 */
  function confirmScanPay() {
    const valid = cart.filter(l => l.qty > 0);
    if (!valid.length) { toast('购物车为空'); return; }
    const goodsAmt1 = valid.reduce((s, l) => s + l.qty * linePrice(l), 0);
    const total = orderDisc ? Math.round(goodsAmt1 * orderDisc.rate / 100 * 100) / 100 : goodsAmt1;
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>💰 请核对顾客实际到账</h3>
      <div style="text-align:center;padding:10px 0">
        <div class="muted" style="font-size:13px">应收金额</div>
        <div style="font-size:34px;font-weight:800;color:var(--pri-2);font-family:var(--mono)">¥${money(total)}</div>
      </div>
      <div class="warn-bar">请打开收款记录核对：顾客实际到账必须与应收一致（多退少补后重新结账），截图收款不可作为到账依据</div>
      <label style="display:flex;gap:8px;align-items:flex-start;padding:10px 2px;font-size:14px">
        <input type="checkbox" id="mmChk" style="width:20px;height:20px;flex:none;margin-top:2px">
        <span>我已核对顾客实际到账 <b>¥${money(total)}</b> 一致（微信/支付宝账单可查）</span>
      </label>
      <div class="field"><label>付款流水号后 4 位（选填，便于对账）</label><input id="mmRef" type="text" inputmode="numeric" maxlength="10" placeholder="如 6688"></div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost" id="mmNo" style="flex:1">取消</button>
        <button class="btn ok" id="mmOk" style="flex:1" disabled>确认到账并结账</button>
      </div></div>`;
    document.body.appendChild(m);
    $('#mmChk').onchange = () => { $('#mmOk').disabled = !$('#mmChk').checked; };
    $('#mmNo').onclick = () => m.remove();
    $('#mmOk').onclick = () => {
      scanRefNo = $('#mmRef').value.trim();
      m.remove();
      checkout();
    };
  }

  /** 统一加购入口：id 归一化（价格表 id 为字符串）+ 同商品合并数量。
   *  库存预警：低于等于 5 件 toast 提示；超卖（含已车量）弹「负库存售卖确认」，开启硬拦则直接拒。 */
  let stockHard = false;                 // 库存硬拦（后台 pos.cashier.stock_hard）
  let negSales = [];                     // 本班负库存清单（盘点线索）
  const nowHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const stockOf2 = p => (p.id in stockMap) ? Number(stockMap[p.id]) : null;
  function addQty(p, n) {
    const id = Number(p.id);
    const hit = cart.find(l => l.p.id === id);
    if (hit) hit.qty += n;
    else cart.push({ p: { ...p, id }, qty: n });
    renderCart();
  }
  function stockShort(p, qty) {
    const hit = cart.find(l => l.p.id === Number(p.id));
    const inCart = hit ? hit.qty : 0;
    const st = stockOf2(p);
    return { inCart, short: st != null && qty > st - inCart };
  }
  function tryAdd(p, qty) {
    qty = Math.max(1, Number(qty) || 1);
    const s = stockShort(p, qty);
    if (s.short) {
      if (stockHard) { toast(`库存硬拦已开启：${p.name} 账面仅剩 ${stockOf2(p)}，不能超卖（收银设置可关）`); return; }
      pwaConfirm('负库存售卖确认',
        `<b>${esc(p.name)}</b> 账面库存 ${stockOf2(p)}（已在车 ${s.inCart}），本次要加 <b>${qty}</b>，将超出账面 <b style="color:var(--bad)">${qty + s.inCart - stockOf2(p)}</b> 件。<br>账实不符常见于未及时入库/退货未清点；确认后按负库存成交并留痕，进「本班负库存清单」。`,
        { okText: '按负库存继续卖（留痕）' }).then(ok => {
          if (!ok) return;
          negSales.unshift({ t: nowHM(), name: p.name, stock: stockOf2(p), had: s.inCart, add: qty });
          doAdd(p, qty, true);
        });
      return;
    }
    doAdd(p, qty, false);
  }
  function doAdd(p, qty, neg) {
    if (neg) toast('已按负库存售卖并留痕（账面 ' + stockOf2(p) + '）');
    else {
      const st = stockOf2(p);
      if (st != null && st > 0 && st <= 5) toast(`库存偏低：${p.name} 仅剩 ${st}`);
    }
    addQty(p, qty);
  }
  function addCart(p, qty) { tryAdd(p, qty); }

  // ── V5.0.16：购物车折扣 / 赠送（与桌面收银同口径；后端 /sales/checkout 已支持 gift/discRate/整单折扣） ──
  let priceAuth = null;            // 店长授权票据 {ticket, exp, name, empNo}
  let authReuse = 'batch';         // batch=120s 复用 / once=每次弹窗
  let authSelf = false;            // 店长本人免输授权码
  let orderDisc = null;            // 整单折扣 {rate,name,amount,custom,reason}
  let discPresets = [];            // 整单折扣预设（后台 pos.discount.presets）
  function priceAuthValid() { return priceAuth && priceAuth.exp > Date.now(); }
  const lineBasePrice = l => Number(l.manualPrice ?? l.p.sellPrice ?? l.p.sell_price ?? 0);
  const linePrice = l => {
    if (l.gift) return 0;
    if (l.discRate != null) return Math.round(lineBasePrice(l) * l.discRate / 100 * 100) / 100;
    return lineBasePrice(l);
  };
  const cartSubtotal = () => cart.reduce((s, l) => s + l.qty * linePrice(l), 0);
  function ensurePriceAuth(scene) {
    if (authSelf && hasPerm('pos.price.authorize')) {
      return (async () => {
        if (priceAuthValid()) return true;
        try {
          const r = await call('POST', '/auth/authorize-self', {});
          priceAuth = { ticket: r.ticket, exp: Date.now() + (Number(r.expiresIn) || 120) * 1000,
                        name: r.authorizer?.name || '', empNo: r.authorizer?.empNo || '' };
          return true;
        } catch (e) { toast(e.message || '自授权失败'); return false; }
      })();
    }
    if (authReuse === 'batch' && priceAuthValid()) return Promise.resolve(true);
    return new Promise(resolve => {
      const m = document.createElement('div'); m.className = 'modal';
      m.innerHTML = `<div class="sheet" style="width:min(430px,92vw)"><h3>🔐 店长授权</h3>
        <div class="hint">「<b>${esc(scene)}</b>」需店长现场授权。<b>仅授权本次价格操作，不会切换当前收银员身份</b>；授权后 120 秒内有效，可连续改价/打折。</div>
        <div class="field"><label>店长工号</label><input id="csAzNo" placeholder="店长工号" autocomplete="off"></div>
        <div class="field"><label>店长授权码</label><input id="csAzCode" type="password" inputmode="numeric" placeholder="4~8 位数字（非登录密码）" autocomplete="off"></div>
        <div class="hint" id="csAzHint">未设置授权码？请老板在后台「员工与角色」中为店长工号设置授权码。</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn ghost" id="csAzX" style="flex:1">取消</button>
          <button class="btn ok" id="csAzGo" style="flex:1">授权</button></div></div>`;
      document.body.appendChild(m);
      const close = ok => { m.remove(); resolve(ok); };
      m.querySelector('#csAzX').onclick = () => close(false);
      const go = async () => {
        const empNo = m.querySelector('#csAzNo').value.trim();
        const code = m.querySelector('#csAzCode').value.trim();
        if (!empNo || !code) { toast('请填写店长工号与授权码'); return; }
        const btn = m.querySelector('#csAzGo'); btn.disabled = true; btn.textContent = '验证中…';
        try {
          const r = await call('POST', '/auth/authorize', { empNo, authCode: code });
          priceAuth = { ticket: r.ticket, exp: Date.now() + (Number(r.expiresIn) || 120) * 1000,
                        name: r.authorizer?.name || '', empNo: r.authorizer?.empNo || '' };
          toast(`✅ 店长 ${priceAuth.name} 已授权（120 秒内有效）`);
          close(true);
        } catch (e) {
          m.querySelector('#csAzHint').innerHTML = `<span style="color:var(--bad)">${esc(e.message || '授权失败')}</span>`;
          btn.disabled = false; btn.textContent = '授权';
          m.querySelector('#csAzCode').select();
        }
      };
      m.querySelector('#csAzGo').onclick = go;
      ['#csAzNo', '#csAzCode'].forEach(sel => m.querySelector(sel).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
      setTimeout(() => m.querySelector('#csAzNo').focus(), 60);
    });
  }
  function discEdit(i) {
    const l = cart[i]; if (!l || l.custom) return;
    if (l.gift) { toast('赠品行已是 0 元，无需打折'); return; }
    if (!hasPerm('pos.price.manual')) { toast('单品折扣需改价权限（pos.price.manual）'); return; }
    const m = document.createElement('div'); m.className = 'modal';
    const base = lineBasePrice(l);
    m.innerHTML = `<div class="sheet"><h3>💢 单品折扣</h3>
      <div class="hint">${esc(l.p.name)} · 原价 ¥${money(base)}</div>
      <div class="field"><label>折扣（折，如 88 = 88 折）</label><input id="csDcIn" type="number" step="1" placeholder="输入折数 1~100"></div>
      <div id="csDcHint"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="csDcX" style="flex:1">取消</button>
        <button class="btn ok" id="csDcOk" style="flex:1">确定</button></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csDcX').onclick = () => m.remove();
    m.querySelector('#csDcOk').onclick = async () => {
      const r = Number(m.querySelector('#csDcIn').value);
      if (!(r > 0 && r <= 100)) { toast('请输入 1~100 的折数'); return; }
      const newP = Math.round(base * r / 100 * 100) / 100;
      const minP = l.p.minPrice != null && l.p.minPrice !== '' ? Number(l.p.minPrice) : 0;
      const minD = Number(l.p.minDiscountRate || l.p.min_discount_rate || 0);
      const badDisc = minD > 0 && r < minD;
      const badPrice = newP < minP;
      if (badDisc || badPrice) {
        if (!hasPerm('pos.emergency.manual')) { m.querySelector('#csDcHint').innerHTML = `<span style="color:var(--bad)">${badDisc ? `低于本商品最低折扣 ${minD} 折` : `折后 ¥${money(newP)} 低于最低售价 ¥${money(minP)}`}，已拒绝（需店长放行）</span>`; return; }
        if (!(await pwaConfirm('店长放行', `低于${badDisc ? `最低折扣 ${minD} 折` : `最低售价 ¥${money(minP)}`}，确认放行并留痕？`, { okText: '店长放行' }))) return;
      }
      if (!(await ensurePriceAuth('单品折扣'))) return;
      delete l.manualPrice; l.discRate = r; m.remove(); renderCart(); toast(`已按 ${r} 折销售（店长已授权）`);
    };
  }
  function giftEdit(i) {
    const l = cart[i]; if (!l || l.custom) return;
    if (!hasPerm('pos.price.manual')) { toast('手工赠品需改价权限（pos.price.manual）'); return; }
    if (l.gift) { l.gift = false; delete l.manualPrice; l.remark = ''; renderCart(); toast('已撤销赠品，恢复原价'); return; }
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>🎁 设为赠品</h3>
      <div class="warn-bar">0 元出库·库存照扣·需店长授权留痕</div>
      <div class="field"><label>赠品原因（选填）</label><input id="csGfRm" placeholder="如：试吃 / 客诉补偿"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="csGfX" style="flex:1">取消</button>
        <button class="btn ok" id="csGfOk" style="flex:1">设为赠品</button></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csGfX').onclick = () => m.remove();
    m.querySelector('#csGfOk').onclick = async () => {
      if (!(await ensurePriceAuth('手工赠品（0 元出库）'))) return;
      l.gift = true; l.manualPrice = 0; l.remark = m.querySelector('#csGfRm').value.trim();
      m.remove(); renderCart(); toast('该行已设为赠品（0 元·店长已授权）');
    };
  }
  function renderDiscSlot() {
    const slot = $('#ckDiscSlot'); if (!slot) return;
    if (!discPresets.length && !hasPerm('pos.discount.custom')) { slot.innerHTML = '<span class="pill gray">未配置</span>'; return; }
    let html = discPresets.map(p => `<button class="mini-btn${orderDisc && orderDisc.rate === p.rate ? ' ok' : ''}" data-rate="${p.rate}" data-name="${esc(p.name || '')}">${esc(p.name || (p.rate + '折'))}</button>`).join('');
    if (hasPerm('pos.discount.custom')) html += `<button class="mini-btn${orderDisc && orderDisc.custom ? ' ok' : ''}" id="ckDiscCustom">自定义</button>`;
    if (orderDisc) html += `<button class="mini-btn" id="ckDiscClear">取消</button>`;
    slot.innerHTML = html;
    slot.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => applyOrderDisc(Number(b.dataset.rate), b.dataset.name, false, ''));
    const cu = $('#ckDiscCustom'); if (cu) cu.onclick = openOrderDiscCustom;
    const cl = $('#ckDiscClear'); if (cl) cl.onclick = () => { orderDisc = null; renderCart(); };
  }
  async function applyOrderDisc(rate, name, custom, reason) {
    const total = cartSubtotal();
    const amount = Math.round(total * (1 - rate / 100) * 100) / 100;
    const offenders = [];
    for (const l of cart) {
      const bp = lineBasePrice(l);
      const minP = l.p.minPrice != null && l.p.minPrice !== '' ? Number(l.p.minPrice) : 0;
      const minD = Number(l.p.minDiscountRate || l.p.min_discount_rate || 0);
      const newP = Math.round(bp * rate / 100 * 100) / 100;
      if (minD > 0 && rate < minD) offenders.push(l.p.name);
      else if (newP < minP) offenders.push(l.p.name);
    }
    if (offenders.length) {
      if (!hasPerm('pos.emergency.manual')) { toast(`整单折扣 ${rate} 折越线：${offenders.slice(0, 3).join('、')}${offenders.length > 3 ? ` 等 ${offenders.length} 项` : ''}，已拒绝（需店长放行）`); return; }
      if (!(await pwaConfirm('店长放行', `以下商品低于最低折扣/售价：${offenders.slice(0, 3).join('、')}\n确认放行并留痕？`, { okText: '店长放行' }))) return;
    }
    if (!(await ensurePriceAuth('整单折扣'))) return;
    orderDisc = { rate, name, amount, custom, reason };
    renderCart(); toast(`已套用整单折扣：${name} ${rate} 折（结账时服务端校验留痕）`);
  }
  function openOrderDiscCustom() {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>💢 自定义整单折扣</h3>
      <div class="field"><label>折扣（折，如 90 = 9 折）</label><input id="ckOdIn" type="number" step="1" placeholder="1~100"></div>
      <div class="field"><label>折扣原因（选填）</label><input id="ckOdRm" placeholder="如：会员日 / 店庆"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="ckOdX" style="flex:1">取消</button>
        <button class="btn ok" id="ckOdOk" style="flex:1">确定</button></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#ckOdX').onclick = () => m.remove();
    m.querySelector('#ckOdOk').onclick = () => {
      const r = Number(m.querySelector('#ckOdIn').value);
      if (!(r > 0 && r <= 100)) { toast('请输入 1~100 的折数'); return; }
      const rm = m.querySelector('#ckOdRm').value.trim();
      m.remove(); applyOrderDisc(r, '自定义 ' + r + ' 折', true, rm);
    };
  }
  async function loadCashierSettings() {
    try { const r = await call('GET', '/settings/key/pos.cashier.stock_hard'); stockHard = !!(r && (r.value === true || String(r.value) === 'true' || Number(r.value) === 1)); } catch {}
    try { const r = await call('GET', '/settings/key/pos.price.auth_self'); authSelf = !!(r && (r.value === true || String(r.value) === 'true' || Number(r.value) === 1)); } catch {}
    try { const r = await call('GET', '/settings/key/pos.price.auth_reuse'); authReuse = (r && r.value === 'once') ? 'once' : 'batch'; } catch {}
    try { const r = await call('GET', '/settings/key/pos.discount.presets'); if (r && r.value) { const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; if (Array.isArray(v)) discPresets = v; } } catch {}
  }

  // ── V4.13.9 B1：左右手习惯（后台 mobile.hand 设置）+ 挂单/取单（/pos/held）──
  let HAND = localStorage.getItem('pwa_hand') || '';
  async function applyHand() {
    if (!HAND) {
      try { HAND = (await call('GET', '/settings/key/mobile.hand')).value || 'right'; }
      catch { HAND = 'right'; }
      localStorage.setItem('pwa_hand', HAND);
    }
    $('#view').classList.toggle('hand-left', HAND === 'left');
  }

  // 挂单：购物车快照入 held_orders（服务端留痕，不扣库存），清空购物车继续接待下一位
  function holdOrder() {
    if (!cart.length) { toast('购物车为空，无法挂单'); return; }
    const go = async () => {
      try {
        const d = await call('POST', '/pos/held', {
          items: cart.map(l => ({ productId: l.p.id, qty: l.qty, unitPrice: l.manualPrice ?? undefined })),
          memberId: member?.id, remark: `移动收银挂单 · ${ME.name}`,
        });
        toast(`已挂单 #${d.id}：购物车已收入挂单库，可直接新开收银`);
        cart.length = 0; member = null; heldId = null;
        renderCart(); renderMember();
      } catch (e) { toast(e.message); }
    };
    // V4.15.2：原生 confirm 在部分手机 WebView 静默返回 false（表现为点了没反应），统一换 pwaConfirm
    pwaConfirm('挂单', '确认挂起当前购物车？挂单后可随时「取单」调出，也可继续接待下一位顾客。').then(ok => { if (ok) go(); });
  }

  // 取单：列出挂单中单据 → 取出回到购物车（V4.15.4：取出即销单即时从列表消失；单号/件数/金额展示；支持刷新）
  async function takeOrder() {
    try {
      const rows = await call('GET', '/pos/held');
      if (!rows.length) { toast('暂无挂单'); return; }
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));   // 按挂单时间先后排列
      const m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = `<div class="sheet"><h3>📥 取单（挂单中 <span id="hkCnt">${rows.length}</span> 单）
        <button class="mini-btn" id="hkRefresh" style="float:right">🔄 刷新</button></h3>
        <div id="hkList"></div>
        <button class="btn ghost" id="hkClose" style="width:100%;margin-top:10px">关闭</button></div>`;
      document.body.appendChild(m);
      m.querySelector('#hkClose').onclick = () => m.remove();
      m.querySelector('#hkRefresh').onclick = () => { m.remove(); takeOrder(); };
      /** 快照金额：新快照有 lineTotal；旧快照回退 qty×unitPrice；再缺则 null 不显示 */
      const qtyOf = h => (h.items || []).reduce((a, i) => a + (Number(i?.qty) || 0), 0);
      const amtOf = h => {
        const it = h.items || [];
        if (!it.length || !it.every(i => i?.lineTotal != null || i?.unitPrice != null)) return null;
        return it.reduce((a, i) => a + Number(i?.lineTotal ?? (Number(i?.unitPrice) || 0) * (Number(i?.qty) || 0)), 0);
      };
      const draw = (list) => {
        m.querySelector('#hkCnt').textContent = list.length;
        m.querySelector('#hkList').innerHTML = list.length ? list.map(h => {
          const amt = amtOf(h);
          return `
          <div class="row" data-h="${h.id}">
            <div class="grow"><div class="t">${esc(h.order_no || ('挂单 #' + h.id))} · ${qtyOf(h)} 件${amt != null ? ` · <b>${money(amt)}</b>` : ''}</div>
              <div class="s">${esc(h.member_name || '散客')} · ${esc(h.held_by_name || '')} · ${dt(h.created_at)}</div></div>
            <button class="mini-btn ok" data-tk="${h.id}" style="color:#fff;background:var(--ok)">取出</button>
            <button class="mini-btn danger" data-hx="${h.id}" data-hno="${esc(h.order_no || '#' + h.id)}">删</button>
          </div>`;
        }).join('') : '<div class="empty">暂无挂单</div>';
        m.querySelectorAll('[data-tk]').forEach(b => b.onclick = async ev => {
          ev.stopPropagation();
          try {
            const d = await call('GET', '/pos/held/' + b.dataset.tk);
            cart.length = 0;
            for (const it of (d.items || [])) {
              const p = await productById(Number(it.productId));
              if (p) cart.push({ p: { ...p, id: Number(it.productId) }, qty: Number(it.qty) || 1,
                                 manualPrice: it.unitPrice ?? undefined });
            }
            heldId = Number(d.id);
            member = null;
            // V4.15.4：取出即销单（服务端幂等，结账成功后重复 pick 已有 alreadyPicked 兜底）→ 挂单列表即时消失
            call('POST', `/pos/held/${d.id}/pick`).catch(() => {});
            m.remove();
            renderCart();
            toast(`已取出挂单 ${d.order_no || '#' + d.id}：核对后结账（挂单已即时销单）`);
          } catch (e) { toast(e.message); }
        });
        m.querySelectorAll('[data-hx]').forEach(b => b.onclick = async ev => {
          ev.stopPropagation();
          pwaConfirm('删除挂单', `确认删除挂单 ${b.dataset.hno}？（留痕，不恢复库存）`).then(async ok => {
            if (!ok) return;
            try {
              await call('DELETE', `/pos/held/${b.dataset.hx}`);   // V4.14.1 修复：后端取消挂单是 DELETE /pos/held/:id（原 POST cancel 404）
              toast('挂单已删除');
              const fresh = await call('GET', '/pos/held');
              fresh.sort((a, b2) => String(a.created_at).localeCompare(String(b2.created_at)));
              draw(fresh);
            } catch (e) { toast(e.message); }
          });
        });
      };
      draw(rows);
    } catch (e) { toast(e.message); }
  }

  // ── V5.0.16：H5 注册入口域名缓存 + 商品网格库存角标（与桌面收银 /pos/stock 同口径） ──
  let _h5entryCache;
  async function getH5Entry() {
    if (_h5entryCache !== undefined) return _h5entryCache;
    try {
      const r = await call('GET', '/settings/key/member.h5.entry_url');
      _h5entryCache = String(r?.value ?? '').replace(/^"|"$/g, '').trim();
    } catch { _h5entryCache = ''; }
    return _h5entryCache;
  }
  // 库存角标：按当前商品网格可见商品 id 拉取实时库存（刻意不缓存进价目表；易变数据）
  let stockMap = {};          // productId -> stockQty
  const stockAsked = new Set();
  async function refreshStock(ids) {
    if (!navigator.onLine) return;
    const list = (ids || (Pricebook.items || []).map(p => Number(p.id))).filter(Boolean).slice(0, 500);
    const need = list.filter(id => !stockAsked.has(id));
    if (!need.length) return;
    need.forEach(id => stockAsked.add(id));
    try {
      const d = await call('GET', '/pos/stock?ids=' + need.join(','));
      for (const r of (d.items || [])) stockMap[r.productId] = Number(r.stockQty) || 0;
      for (const it of (Pricebook.items || [])) {
        const id = Number(it.id);
        if (!(id in stockMap) && need.includes(id)) stockMap[id] = 0;   // 无库存记录=0（未进货）
      }
      renderGrid();   // 拉到库存后重渲染商品网格以显示角标（stockAsked 已记入，不会重复请求）
    } catch { /* 库存查询失败不影响收银 */ }
  }
  function stockBadge(p) {
    const st = stockMap[p.id];
    if (st == null) return '';
    const out = st <= 0;
    const low = !out && st <= 5;
    return `<span class="ck-stockpill${low ? ' low' : ''}${out ? ' out' : ''}">${out ? '库存 0' : (low ? '仅剩 ' + st : '库存 ' + st)}</span>`;
  }

  function renderCart() {
    const box = $('#ckCart');
    if (!box) return;
    /** 称重行判定：is_weighted 商品或以 kg 计价（方案 v3.2 M3：识别/扫码 → 读重计价） */
    const isW = l => !!(l.p.isWeighted || l.p.is_weighted || String(l.p.baseUnit || l.p.base_unit || '').toLowerCase() === 'kg');
    if (!cart.length) { box.innerHTML = '<div class="empty">购物车为空，扫码或搜索添加</div>'; }
    else {
      box.innerHTML = cart.map((l, i) => {
        const w = isW(l);
        const qtyTxt = w ? Number(l.qty).toFixed(3) + ' kg' : l.qty;
        const step = w ? 0.05 : 1;
        const price = linePrice(l);
        const base = lineBasePrice(l);
        const tags = []
          + (l.gift ? '<span class="pill green">赠品</span>' : '')
          + (l.discRate != null ? `<span class="pill orange">${l.discRate}折</span>` : '')
          + (l.manualPrice != null && l.discRate == null && !l.gift ? '<span class="pill orange">手输 ¥' + money(l.manualPrice) + '</span>' : '')
          + (w ? '<span class="pill blue">称重</span>' : '');
        const unit = w ? 'kg' : (l.p.baseUnit || l.p.base_unit || '件');
        const priceTxt = l.gift ? '¥0.00（赠）' : (l.discRate != null ? `¥${money(price)}<small style="color:var(--ink-3)"> /¥${money(base)}</small>` : `¥${money(price)}`);
        const canPrice = hasPerm('pos.price.manual');
        return `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(l.p.name)} ${tags}</div>
            <div class="s">${priceTxt}/${unit} × ${qtyTxt}</div>
          </div>
          <div class="qty">
            ${w ? `<button data-w="${i}" style="width:34px;height:34px;border-radius:9px;background:#e8f4f8;font-size:15px">⚖</button>` : ''}
            ${w ? `<button data-sl="${i}" style="width:34px;height:34px;border-radius:9px;background:#fdf6e8;font-size:15px" title="打印秤贴">🏷</button>` : ''}
            ${canPrice ? `<button class="mini-btn" data-f="${i}" title="单品折扣" style="padding:6px 8px">折</button>` : ''}
            ${canPrice ? `<button class="mini-btn" data-g="${i}" title="赠品" style="padding:6px 8px">${l.gift ? '撤赠' : '赠'}</button>` : ''}
            <button data-m="${i}" data-st="${step}">−</button><span>${qtyTxt}</span><button data-p="${i}" data-st="${step}">＋</button>
          </div>
          <button class="mini-btn danger" data-d="${i}">删</button>
        </div>`;
      }).join('');
      box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
        const i = +b.dataset.m, l = cart[i];
        l.qty = Math.max(0, Math.round((l.qty - Number(b.dataset.st)) * 1000) / 1000);
        // V4.13.9 B0：数量减到 0 自动删行
        if (l.qty <= 0) cart.splice(i, 1);
        renderCart();
      });
      box.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
        const l = cart[+b.dataset.p];
        l.qty = Math.round((l.qty + Number(b.dataset.st)) * 1000) / 1000;
        renderCart();
      });
      // ⚖ 自动读重：串口秤稳定读数直填数量（kg，3 位小数；失败/超时可手动 ±）
      box.querySelectorAll('[data-w]').forEach(b => b.onclick = async () => {
        const l = cart[+b.dataset.w];
        if (typeof Scale === 'undefined' || !Scale.connected()) { toast('电子秤未连接：请到「我的-设备管理」连接电子秤'); return; }
        b.textContent = '…';
        const kg = await Scale.weight(8000).catch(() => null);
        b.textContent = '⚖';
        if (kg == null) { toast('读重超时：请确认商品放上秤盘稳定后重试，或手动 ＋/−'); return; }
        if (kg <= 0.002) { toast('秤盘读数为 0：请先把商品放上秤盘'); return; }
        l.qty = kg;
        renderCart();
        warnWeightOut(l.p.id, kg);   // V4.27.1 Q7：串口秤读重 vs 期望区间复核
        toast(`已读重 ${kg.toFixed(3)} kg：${l.p.name}`);
      });
      box.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { cart.splice(+b.dataset.d, 1); renderCart(); });
      box.querySelectorAll('[data-f]').forEach(b => b.onclick = () => discEdit(+b.dataset.f));
      box.querySelectorAll('[data-g]').forEach(b => b.onclick = () => giftEdit(+b.dataset.g));
      // 🏷 即时秤贴（V4.15.7 P2）：称重行读重/改量后一键出秤贴（品名/单价/重量/金额/条码/时间），走标签机
      box.querySelectorAll('[data-sl]').forEach(b => b.onclick = async () => {
        const l = cart[+b.dataset.sl];
        if (!(Number(l.qty) > 0)) { toast('请先读重或手输数量'); return; }
        b.textContent = '…';
        try {
          const ps = await call('GET', '/printers');
          const lp = (Array.isArray(ps) ? ps : []).find(p => (p.printer_type || '小票') === '标签');
          if (!lp) { toast('暂无标签机：请到后台「打印中心」新增设备类型为「标签机」的打印机'); return; }
          const price = Number(l.manualPrice ?? l.p.sellPrice ?? l.p.sell_price ?? 0);
          const r = await call('POST', `/printers/${lp.id}/labels`, {
            jobType: '秤贴',
            items: [{
              name: l.p.name, price, barcode: l.p.barcode || '', unit: 'kg',
              weight: Number(l.qty) || 0,
              time: new Date().toLocaleString('zh-CN', { hour12: false }).slice(5, 16),
            }],
          });
          if (r.channel === 'network') toast(`秤贴已打印（${lp.name} · 网口直发）`);
          else toast(`标签机「${lp.name}」为串口连接：请在电脑后台打印，或改为网口`);
        } catch (e) { toast('秤贴打印失败：' + (e.message || e)); }
        finally { b.textContent = '🏷'; }
      });
    }
    const total = cartSubtotal();
    const totalQty = cart.reduce((s, l) => s + l.qty, 0);
    $('#ckCnt').textContent = `${cart.length} 种 · 共 ${Number.isInteger(totalQty) ? totalQty : totalQty.toFixed(3)} 件`;
    $('#ckTotal').textContent = '¥' + money(total);
    const ckInfoTotal = $('#ckInfoTotal'); if (ckInfoTotal) ckInfoTotal.textContent = '¥' + money(total);
    const ckInfoCnt = $('#ckInfoCnt'); if (ckInfoCnt) ckInfoCnt.textContent = (Number.isInteger(totalQty) ? totalQty : totalQty.toFixed(3)) + ' 件';
    renderDiscSlot();
  }

  /* V5.0.11i：会员入口。
   * 原实现 `if (payChannel !== '余额') { box.innerHTML = ''; return; }` —— 会员区只在
   * **余额支付**时渲染，导致现金/扫码结账时手机上**完全没有选择会员的入口**（用户反馈）。
   * 现在：所有支付方式都渲染会员条；现金/扫码为紧凑单行（未挂时是一个「选择会员（可选）」按钮，
   * 点开展开搜索框），余额支付保持原来的「搜索框直接可见」以免影响既有操作习惯。 */
  function renderMember() {
    const box = $('#ckMember');
    if (!box) return;
    /* V5.0.12f：会员交互整体迁移到右上浮动按钮的弹窗（选会员/建会员都在弹窗完成），
     * 购物车内只在已挂会员时显示一条紧凑 chip，未挂时不占任何空间。 */
    if (member) {
      box.innerHTML = `<div class="row" style="margin:6px 0;padding:7px 10px"><div class="grow">
          <div class="t">👤 ${esc(member.name || '会员')}</div>
          <div class="s">${esc(member.phone || member.card_no || '')} · 余额 ¥${money(member.balance)}${member.points ? ' · 积分 ' + member.points : ''}</div>
        </div><button class="mini-btn danger" id="ckMx">取消</button></div>`;
      $('#ckMx').onclick = () => { member = null; clearCouponsMobile(); renderMember(); renderCart(); };
    } else {
      box.innerHTML = '';
    }
    const fab = $('#ckMemberFab');
    if (fab) { fab.classList.toggle('has-m', !!member); fab.innerHTML = '👤' + (member ? '<i class="fab-badge"></i>' : ''); }
  }

  /** V5.0.12f 会员弹窗：搜索选会员 + 建会员（浮动按钮入口；结账时"有会员"也走这里） */
  function openMemberPopup() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>👤 会员 <button class="mini-btn" id="mpClose" style="float:right">关闭</button></h3>
      <div id="mpCur"></div>
      <div class="field" style="margin:8px 0 4px">
        <input id="ckMk" class="search" placeholder="搜索会员（手机号/卡号/姓名）" autocomplete="off" inputmode="search">
        <div id="ckMl"></div></div>
      ${hasPerm('member.register') ? '<button class="btn ghost" id="mpNew" style="width:100%;margin-top:10px">➕ 新建会员</button>' : ''}
    </div>`;
    document.body.appendChild(m);
    const drawCur = () => {
      m.querySelector('#mpCur').innerHTML = member
        ? `<div class="row" style="margin:6px 0"><div class="grow">
            <div class="t">👤 ${esc(member.name || '会员')}</div>
            <div class="s">${esc(member.phone || member.card_no || '')} · 余额 ¥${money(member.balance)}${member.points ? ' · 积分 ' + member.points : ''}</div></div>
            <button class="mini-btn danger" id="mpMx">取消挂会员</button></div>`
        : '<div class="hint" style="margin:6px 0">当前按散客结账——挂会员可享会员价 / 积分 / 优惠券 / 储值支付</div>';
      const mx = m.querySelector('#mpMx');
      if (mx) mx.onclick = () => { member = null; clearCouponsMobile(); renderMember(); renderCart(); drawCur(); };
    };
    drawCur();
    m.querySelector('#mpClose').onclick = () => m.remove();
    const mpNew = m.querySelector('#mpNew');
    if (mpNew) mpNew.onclick = () => { m.remove(); openMemberRegister(); };
    // 选中会员 → 关弹窗回主界面（chip 显示在抽屉，浮动按钮变绿点）
    const sel = el => {
      member = { id: Number(el.dataset.mid), name: el.querySelector('.t').textContent,
                 phone: el.querySelector('.s').textContent.split('·')[0].trim(),
                 balance: 0, points: 0 };
      call('GET', '/members/' + member.id).then(x => {
        const mm = (x && (x.member || x)) || null;
        if (mm) { member.balance = Number(mm.balance || 0); member.points = Number(mm.points || 0);
                   if (mm.name) member.name = mm.name; if (mm.phone) member.phone = mm.phone; }
      }).catch(() => {}).finally(() => { renderMember(); renderCart(); });
      m.remove();
      toast(`已挂会员「${member.name || ''}」`);
    };
    m.querySelectorAll('[data-mid]').forEach(el => el.onclick = () => sel(el));
    // 搜索（输入即搜，复用三态共用逻辑）
    const inp = m.querySelector('#ckMk');
    const ml = m.querySelector('#ckMl');
    inp.addEventListener('input', debounce(async () => {
      const kw = inp.value.trim();
      if (!kw) { ml.innerHTML = ''; return; }
      try {
        const d = await call('GET', '/members?keyword=' + encodeURIComponent(kw) + '&size=8');
        const list = d.items || [];
        ml.innerHTML = list.map(mm => `
          <div class="row" data-mid="${mm.id}"><div class="grow">
            <div class="t">${esc(mm.name || '会员')}</div>
            <div class="s">${esc(mm.phone || mm.card_no || '')} · 余额 ¥${money(mm.balance)}</div></div>
            <button class="mini-btn ok">选</button></div>`).join('')
          || '<div class="muted" style="padding:6px 2px;font-size:12.5px">未找到会员</div>';
        ml.querySelectorAll('[data-mid]').forEach(el => el.onclick = () => sel(el));
      } catch { ml.innerHTML = '<div class="muted" style="padding:6px 2px;font-size:12.5px">搜索失败</div>'; }
    }, 300));
    setTimeout(() => inp.focus(), 80);
  }

  /** 会员已选券清理（挂/换会员时避免沿用上一位的券） */
  function clearCouponsMobile() { /* 手机端结算暂不使用券选择，保留占位以便将来接入 */ }

  /* V5.0.12g：「本单有会员吗」结账前弹窗已移除——挂会员前置到右上 👤 浮动按钮，
   * 结账时按当前状态直接走（未挂=散客），不再每次结账都被弹窗打断。 */


  // V4.14.0 M：移动端会员建档弹窗（手机号/姓名/生日 + 隐私协议可查看全文）
  function openMemberRegister() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>➕ 会员建档</h3>
      <div class="field"><label>手机号*</label><input id="mrPhone" class="search" inputmode="numeric" maxlength="11" placeholder="11 位手机号"></div>
      <div class="field"><label>姓名*</label><input id="mrName" placeholder="会员姓名"></div>
      <div class="field"><label>生日（生日权益/触达用）</label><input id="mrBirth" type="date"></div>
      <label style="display:flex;align-items:center;gap:8px;margin:6px 0">
        <input type="checkbox" id="mrPrivacy" checked>
        <span style="font-size:13px">已阅读并同意 <a href="#" id="mrPvView" style="text-decoration:underline;color:var(--pri)">《隐私协议》</a></span>
      </label>
      <div id="mrPv" class="hint" style="display:none;max-height:120px;overflow:auto;border:1px dashed var(--line);border-radius:8px;padding:8px"></div>
      <button class="btn ok" id="mrGo" style="width:100%;margin-top:10px">建档</button>
      <button class="btn ghost" id="mrClose" style="width:100%;margin-top:8px">取消</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#mrClose').onclick = () => m.remove();
    m.querySelector('#mrPvView').onclick = async () => {
      const box = $('#mrPv');
      if (box.style.display !== 'none') { box.style.display = 'none'; return; }
      try {
        const d = await call('GET', '/settings/key/member.privacy_text');
        box.textContent = typeof d.value === 'string' ? d.value.replace(/^"|"$/g, '') : String(d.value ?? '');
      } catch { box.textContent = '（协议文本未配置）'; }
      box.style.display = '';
    };
    m.querySelector('#mrGo').onclick = async () => {
      const phone = $('#mrPhone').value.trim(), name = $('#mrName').value.trim();
      if (!/^1\d{10}$/.test(phone)) { toast('请输入 11 位手机号'); return; }
      if (!name) { toast('请填写姓名'); return; }
      if (!$('#mrPrivacy').checked) { toast('请勾选同意隐私协议（点击可查看全文）'); return; }
      try {
        const d = await call('POST', '/members', {
          phone, name, birthday: $('#mrBirth').value || undefined,
          privacyAgreed: true, registerChannel: '收银台',
        });
        toast(`建档成功：${d.card_no || d.cardNo || ''}`);
        m.remove();
        // 选中刚建的会员（按手机号回查）
        try {
          const q = await call('GET', '/members?keyword=' + encodeURIComponent(phone) + '&size=1');
          if (q.items?.length) { member = q.items[0]; renderMember(); }
        } catch { /* 回查失败不阻断 */ }
      } catch (e) { toast(e.message || e); }
    };
  }

  // 应急手输商品（店长授权，pos.emergency.manual）
  function manualEntry(container) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>✍️ 应急手输商品</h3>
      <div class="warn-bar">仅限应急收银模式；需店长权限，条码将留痕</div>
      <div class="field"><label>条码</label><input id="mmBc" type="text" placeholder="商品条码"></div>
      <div class="field"><label>商品名称</label><input id="mmNm" type="text" placeholder="名称（仅本地记录）"></div>
      <div class="field"><label>单价（元）</label><input id="mmPr" type="number" step="0.01" placeholder="0.00"></div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost" id="mmNo" style="flex:1">取消</button>
        <button class="btn ok" id="mmOk" style="flex:1">加入购物车</button>
      </div></div>`;
    document.body.appendChild(m);
    $('#mmNo').onclick = () => m.remove();
    $('#mmOk').onclick = async () => {
      const bc = $('#mmBc').value.trim();
      const price = Number($('#mmPr').value);
      const name = $('#mmNm').value.trim() || '手输商品';
      if (!bc || !(price > 0)) { toast('条码与单价必填'); return; }
      let p = Pricebook.find(bc);
      if (!p) {
        try {
          const d = await call('GET', '/products/barcode/' + encodeURIComponent(bc));
          if (d?.ambiguous && typeof pickProductModal === 'function') {
            p = await pickProductModal(d.items, bc);   // 一码多品：弹窗选择
          } else if (d) {
            p = normProduct(d.product || d);   // 接口返回 {product, units} 嵌套
          }
        } catch { p = null; }
      }
      if (!p) {
        toast(navigator.onLine ? '该条码在系统中不存在' : '离线无法识别未缓存条码，恢复联网后补录');
        return;
      }
      cart.push({ p, qty: 1, manualPrice: price, manualBarcode: bc });
      m.remove();
      renderCart();
      toast(`已手输：${name} ¥${money(price)}`);
    };
  }

  async function checkout(presetPays) {
    const valid = cart.filter(l => l.qty > 0);
    if (!valid.length) { toast('购物车为空'); return; }
    const goodsAmt = valid.reduce((s, l) => s + l.qty * linePrice(l), 0);
    const total = orderDisc ? Math.round(goodsAmt * orderDisc.rate / 100 * 100) / 100 : goodsAmt;
    if (payChannel === '余额' && !member && !presetPays) { toast('余额支付请先选择会员'); return; }
    // V4.13.2：扫码通道走通道扣款时，真实渠道取通道识别结果（微信/支付宝），挂通道流水号供服务端校验
    const effChannel = (payChannel === '扫码' && gatewayChannel) ? gatewayChannel : payChannel;
    const gwAttach = gatewayTxnId ? { externalNo: gatewayTxnId, gatewayOutTradeNo: gatewayNo }
      : (payChannel === '扫码' && scanRefNo ? { externalNo: scanRefNo } : {});
    // P2-3：余额组合支付（余额抵扣 + 现金/扫码）时调用方传入完整支付行
    const payments = Array.isArray(presetPays) && presetPays.length
      ? presetPays
      : [{ channel: effChannel, amount: Number(total.toFixed(2)), ...gwAttach }];
    const payload = {
      items: valid.map(l => ({
        productId: l.p.id, qty: l.qty,
        ...(l.manualPrice !== undefined ? { unitPrice: l.manualPrice, manualEntry: true, manualBarcode: l.manualBarcode } : {}),
        ...(l.discRate != null ? { discRate: l.discRate } : {}),
        ...(l.gift ? { gift: true } : {}),
        ...(l.remark ? { lineRemark: l.remark } : {}),
      })),
      payments,
      ...(member ? { memberId: member.id } : {}),
      ...(orderDisc ? { discountRate: orderDisc.rate, discountReason: orderDisc.name + (orderDisc.reason ? ('·' + orderDisc.reason) : '') } : {}),
      isEmergency: emergency,
      remark: `移动收银${emergency ? '·应急' : ''}`,
      clientRef: 'M' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), // 幂等单号：防双击 + 离线补传去重
    };
    scanRefNo = ''; // 一次性使用：本单携带后即清空，防残留串单（通道流水 gateway* 另行管理，失败重试需保留）
    if (ckInFlight) return;
    ckInFlight = true;
    try {
      const d = await call('POST', '/sales/checkout', payload);
      // V4.13.4 成熟收银闭环钩子：落单成功 → 打印小票 + 开钱箱（设置可关；失败不影响交易本身）
      // V5.0.16：散客（未挂会员）小票带注册二维码；已挂会员不需要
      const _h5 = await getH5Entry();
      const regUrl = member ? '' : ((_h5 ? _h5.replace(/\/+$/, '') : location.origin + '/member') + '/?orderId=' + encodeURIComponent(d.orderId));
      const snap = { orderNo: d.orderNo, payable: d.payable, roundAmount: d.roundAmount,
        lines: valid.map(l => ({ name: l.p.name || l.p.name2 || '商品', qty: l.qty,
          price: linePrice(l) })),
        channel: effChannel, member: member ? (member.name || member.phone || `会员#${member.id}`) : null,
        time: new Date(), regUrl };
      const doneMsg = emergency ? '⚡ 应急单据已留痕，恢复后自动并入日报/进销存'
        : '小票打印中，见收银台';   // V4.15.6 打印通道由 PwaPrinters 决定（直驱/网口/浏览器兜底）
      const nz = $('#ckNotice');
      if (nz) {
        const mem = member;  // 捕获：下方结账收尾会 member=null，二维码异步生成时需沿用本单会员信息
        const bar = document.createElement('div');
        bar.className = 'ok-bar'; bar.id = 'ckDone';
        bar.innerHTML = `✅ 结账成功 <b>${esc(d.orderNo)}</b> 应收 <b>¥${money(d.payable)}</b><br>` +
          (mem ? `<div style="margin-top:6px">👤 ${esc(mem.name || '会员')} · ${esc(mem.phone || mem.card_no || '')}</div>` : '') +
          `<span style="font-size:12.5px">${doneMsg} <a href="#" id="ckReprint" style="text-decoration:underline">补打小票</a></span>` +
          `<div class="ck-qr-wrap"></div>`;
        nz.appendChild(bar);
        const qrWrap = bar.querySelector('.ck-qr-wrap');
        // V5.0.16：仅散客（未挂会员）展示注册二维码；已挂会员显示会员信息、不显示二维码（避免重复注册）
        if (!mem && qrWrap) {
          (async () => {
            try {
              const base = _h5 ? _h5.replace(/\/+$/, '') : location.origin + '/member';
              const h5reg = base + '/?orderId=' + encodeURIComponent(d.orderId);
              const mod = await import('./vendor/qrcode.mjs');
              const qrcode = mod.default || mod.qrcode;
              const qr = qrcode(0, 'M'); qr.addData(h5reg); qr.make();
              const qrUrl = qr.createDataURL(4, 8);
              qrWrap.innerHTML = `<div style="font-weight:600;margin:8px 0 6px">📱 顾客扫码自助注册会员（本单自动归集）</div>` +
                `<img src="${qrUrl}" style="width:160px;height:160px;border:6px solid #fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);background:#fff" alt="注册二维码">` +
                `<div class="muted" style="font-size:11px;margin-top:4px">微信扫此码注册，散客订单自动转为会员积分</div>`;
            } catch { /* 二维码生成失败不影响结账成功提示 */ }
          })();
        }
      }
      try {
        if (!emergency) {
          // V4.15.6 P1：指令级直驱优先（串口/网口，pos.print.auto 总开关+联数），无直驱回落浏览器打印
          if (window.PwaPrinters) await window.PwaPrinters.autoPrint(snap);
          else await window.PwaReceipt?.printReceipt(snap);
          if (effChannel === '现金') await window.PwaReceipt?.kickDrawer(); // 现金收款才弹钱箱
          window.PwaTTS?.cash(d.payable, effChannel);           // V4.13.8 拟人收款播报（pos.voice_broadcast 可关）
        }
      } catch { /* 打印/钱箱/语音硬件异常不阻断收银 */ }
      const rp = $('#ckReprint');
      if (rp) rp.onclick = () => (window.PwaPrinters ? window.PwaPrinters.reprint(snap)
        : window.PwaReceipt?.printReceipt(snap, false));
      // V4.13.9 B1：本单若由挂单取出，结账成功自动销单（留痕；失败不影响交易）
      if (heldId) {
        const hid = heldId; heldId = null;
        call('POST', `/pos/held/${hid}/pick`).catch(() => {});
      }
      cart.length = 0; member = null; renderCart(); renderMember();   // V5.0.12g：会员一并清空+刷新（防下一位顾客误用上一位的积分/余额）
      ckCloseDrawer();   // V5.0.7：结账成功收起抽屉，露出「结账成功」结果条
      gatewayNo = gatewayTxnId = gatewayChannel = null; // V4.13.2：通道流水一次性，落单成功即清
      mpPreset = null; mpAmount = 0;                     // P2-3：组合支付前置行一次性，落单成功即清
      setTimeout(() => { const el = $('#ckDone'); el && el.remove(); }, 12000);
    } catch (e) {
      if (e.message.includes('网络异常')) {
        if (gatewayNo) {
          // V4.13.2：通道已真实扣款，绝不能离线暂存重发（可能重复入账）——保留购物车与通道流水，联网后重试结账
          const nz2 = $('#ckNotice'); nz2 && nz2.insertAdjacentHTML('beforeend', `
            <div class="warn-bar">⚠️ 通道已扣款 <b>¥${money(total)}</b> 但单据未生成（网络异常）：<br>
            请恢复联网后<b>再次点「结 账」重试</b>（同通道流水幂等，不会重复扣款）；顾客当面确认勿让离场。</div>`);
        } else {
          enqueueOffline({
            items: payload.items, payments: payload.payments, channel: payload.channel,
            isEmergency: payload.isEmergency, memberId: payload.memberId, remark: payload.remark,
            clientRef: payload.clientRef,
          });
          const nz3 = $('#ckNotice'); nz3 && nz3.insertAdjacentHTML('beforeend', `
            <div class="warn-bar">📴 网络不可用：本单已<b>离线暂存</b>，恢复联网后自动补传并入账<br>
            请保留购物小票/记录，避免漏单。</div>`);
          cart.length = 0; member = null; renderCart(); renderMember();   // V5.0.12g：离线单的 memberId 已随 payload 暂存，本地会员即刻清空
          ckCloseDrawer();   // 抽屉收起，露出离线暂存提示
        }
      } else {
        toast(e.message);
      }
    } finally {
      ckInFlight = false;
    }
  }

  ensureStyle();
  ensureCategories();
  render();
  loadCashierSettings().catch(() => {});
  ensurePricebook().then(() => { if (document.body.contains(v)) { ensureCategories(); render(); renderDiscSlot(); } }).catch(() => {});
};

// ── 小工具 ──
function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
