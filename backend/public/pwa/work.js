'use strict';
/* 员工移动端 PWA · 作业（work.js）：移动收货 / 采购退货 / 移动盘点 / 拍照报损
 * 对端：/purchase/inbounds|returns、/inventory/counts|losses、/upload、/products、/inventory/summary */

// ── 共享：商品查找（优先本机价格表缓存 → 条码 → 关键词）──
function normProduct(p) {
  return {
    id: Number(p.id || p.productId),
    name: p.name || '',
    barcode: p.barcode || '',
    spec: p.spec || '',
    unit: p.baseUnit || p.base_unit || '',
    sellPrice: Number(p.sellPrice ?? p.sell_price ?? 0),
    costPrice: Number(p.costPrice ?? p.cost_price ?? 0),
    supplierDefaultId: Number(p.supplierDefaultId ?? p.supplier_default_id ?? 0) || null,   // V4.13.9 B3：退货自动分桶用
  };
}
/* ── V4.9.8 条码归一化与多候选回退（二维码 / 一码多品 / 称重码 / 包装码统一命中）──
 * 背景：原实现仅对「6~16 位纯数字」走 /products/barcode 接口，字母数字二维码、
 *       带 URL/前缀的二维码、UPC 补零码、去校验位码一律落到关键词搜索 → 必然"扫不出"。
 * 归一化顺序：去空白/全角 → 去 AIM 前缀(]C1 等) → 去 CODE128:/EAN13: 等协议前缀
 *            → URL 取码（?code= 或末段路径）
 * 候选回退：原码 → 去前导零 → 13位去校验位 → 12位补零成 EAN-13 → 8位去校验位 */
function normBarcode(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^\][A-Za-z0-9]{1,3}/, '');                       // AIM 前缀 ]C1 / ]E0 / ]Q3
  const pm = s.match(/^(?:CODE128|CODE39|EAN13|EAN8|UPCA|UPCE|QR|QRCODE|DATAMATRIX)[:\-=](.+)$/i);
  if (pm) s = pm[1].trim();                                        // 解码器协议前缀
  if (/^https?:\/\//i.test(s)) {                                   // 二维码内容是 URL
    try {
      const u = new URL(s);
      s = u.searchParams.get('code') || u.searchParams.get('barcode') || u.searchParams.get('bc')
        || u.searchParams.get('sn') || decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    } catch { /* URL 解析失败则原样继续 */ }
  }
  s = s.replace(/[\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, '');
  return s;
}
function barcodeCandidates(raw) {
  const s = normBarcode(raw);
  if (!s) return [];
  const out = [];
  const add = x => { if (x && !out.includes(x)) out.push(x); };
  add(s);
  add(s.replace(/^0+(?=\d{8,})/, ''));            // 去前导零（UPC-A 补零形态）
  if (/^\d{13}$/.test(s)) add(s.slice(0, 12));    // EAN-13 去校验位
  if (/^\d{12}$/.test(s)) add('0' + s);           // UPC-A → EAN-13
  if (/^\d{8}$/.test(s)) add(s.slice(0, 7));      // EAN-8 去校验位
  return out;
}
/** 服务端按候选逐一回查（主码 + 辅助码 + 包装码由后端统一处理）；全不中返回 null */
async function lookupByBarcode(code) {
  for (const cand of barcodeCandidates(code)) {
    try {
      const d = await call('GET', '/products/barcode/' + encodeURIComponent(cand));
      if (d?.ambiguous) return await pickProductModal(d.items, cand);   // 一码多品：人工选择
      if (d) return normProduct(d.product || d);
    } catch { /* 换下一个候选 */ }
  }
  return null;
}
async function lookupProduct(key) {
  key = String(key || '').trim();
  if (!key) return null;
  const code = normBarcode(key);
  if (window.Pricebook && Pricebook.ready) {
    const hit = Pricebook.find(code || key);
    if (hit) return hit;
  }
  // 二维码（字母数字/混合）与数字条码同口径走条码接口：4~48 位可打印字符即视为码
  if (code && /^[0-9A-Za-z][0-9A-Za-z\-_.]{2,47}$/.test(code)) {
    const p = await lookupByBarcode(code);
    if (p) return p;
  }
  try {
    const list = unwrap(await call('GET', '/products?keyword=' + encodeURIComponent(key) + '&size=10'));
    return list.length ? normProduct(list[0]) : null;
  } catch { return null; }
}
/** 扫码/手输未命中：给出可行动提示（改关键词搜索 · AI智拍 · 去建档），不再只 toast 一句 */
function scanMiss(raw, onRetry) {
  const code = normBarcode(raw) || String(raw || '').trim();
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet">
    <h3>🔍 未找到商品</h3>
    <div class="hint">条码/二维码：<b style="font-family:var(--mono)">${esc(code)}</b><br>
      已尝试：主条码 · 辅助码 · 包装码 · 去校验位/补零回退，均未命中。</div>
    <div class="hint" style="margin-top:6px">可能原因：① 该商品未建档或未维护此码 ② 码损坏/反光 ③ 二维码内容非商品码（如活动链接）</div>
    <button class="btn" id="smRetry" style="width:100%;margin-top:12px">🔁 换个关键词搜索</button>
    <button class="btn ghost" id="smAi" style="width:100%;margin-top:8px">🤖 改用 AI智拍</button>
    <button class="btn ghost" id="smClose" style="width:100%;margin-top:8px">关闭</button>
  </div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('#smClose').onclick = close;
  m.querySelector('#smRetry').onclick = () => {
    const kw = prompt('输入商品名称 / 名称拼音 / 条码后几位：', code) || '';
    m.remove();
    if (kw.trim()) onRetry && onRetry(kw.trim());
  };
  m.querySelector('#smAi').onclick = () => {
    m.remove();
    AiScan.open({
      scene: 'checkout', title: 'AI智拍（扫码未命中兜底）',
      onConfirm: async chosen => { onRetry && onRetry(null, chosen); },
    });
  };
}
/** 扫码入口统一处理：命中→回调商品；未命中→弹可行动提示。onHit(p, key) / onRetry(keyword|null, aiItems) */
async function scanResolve(key, onHit, onRetry) {
  const p = await lookupProduct(key);
  if (p) { onHit && onHit(p, key); return p; }
  scanMiss(key, (kw, aiItems) => onRetry && onRetry(kw, aiItems));
  return null;
}
/* 一码多品：多个商品共用同一码 → 弹窗选择后返回所选商品（取消返回 null） */
function pickProductModal(items, code) {
  return new Promise(res => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet">
      <h3>🔀 一码多品 · 请选择商品</h3>
      <div class="hint">条码 ${esc(code)} 命中 ${items.length} 个商品，请点选本次要操作的商品</div>
      ${items.map((it, i) => `<div class="row" data-i="${i}" style="cursor:pointer">
        <div class="grow"><div class="t">${esc(it.product.name)}</div>
        <div class="s">¥${Number(it.product.sell_price || 0).toFixed(2)} · ${esc(it.product.spec || '—')} · ${esc(it.product.base_unit || '')}</div></div>
        <span class="pill gray">选择 ›</span></div>`).join('')}
      <button class="btn ghost" id="ppCancel" style="width:100%;margin-top:10px">取消</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#ppCancel').onclick = () => { m.remove(); res(null); };
    m.addEventListener('click', e => {
      const row = e.target.closest('.row[data-i]');
      if (!row) return;
      m.remove();
      res(normProduct(items[Number(row.dataset.i)].product));
    });
  });
}
async function searchProducts(key) {
  try {
    const list = unwrap(await call('GET', '/products?keyword=' + encodeURIComponent(key) + '&size=15'));
    return list.map(normProduct);
  } catch { return []; }
}
async function productById(id) {
  try {
    const d = await call('GET', '/products/' + Number(id));
    return normProduct(d && d.product ? d.product : d);   // 接口返回 {product, units, barcodes} 嵌套
  } catch { return null; }
}
/** 共享：AI智拍 → 识别候选 → 回调加入作业明细（M2） */
function aiAddLines(scene, title, addOne) {
  AiScan.open({
    scene, title,
    onConfirm: async chosen => {
      for (const it of chosen) {
        const p = await productById(it.productId);
        if (p) addOne(p, it.count);
        else toast(`未找到商品 #${it.productId}，请手动扫码`);
      }
      toast(`已加入 ${chosen.length} 种商品`);
    },
  });
}

/** 扫码未命中 → 转 AI 识别后的结果落明细（V4.9.8 兜底链路） */
async function addAiFallback(aiItems, addOne) {
  let n = 0;
  for (const it of aiItems || []) {
    const p = await productById(it.productId);
    if (p) { for (let i = 0; i < Math.max(1, Number(it.count) || 1); i++) addOne(p); n++; }
  }
  toast(n ? `已按 AI 识别加入 ${n} 种商品` : 'AI 也未识别出商品：该商品尚未采集样本，请先到「AI 训练采集」拍 6 个角度');
}

/** M3b：提交成功后展示操作员/业务员签名关联结果；无预采模板 → 手机屏幕现场签名
 *  ctx: { bizType, bizId, doneText, title, signTitle, defaultName, hint }
 *  大额（P1-1）：signInfo.needsLive → 现场补签；signInfo.needSms → 短信确认码校验（线下转达） */
function showSignResult(v, d, ctx) {
  const op = esc(ME.name);
  const info = d.signInfo || {};
  const auto = !!(info.personName);
  const sb = document.createElement('div');
  let html = `<div class="ok-bar">${ctx.doneText}${auto
    ? `<br>📝 已关联操作员 <b>${op}</b> · 业务员「${esc(info.personName)}」${info.scene === '现场补签' ? '（现场补签）' : '电子签名自动提取'}`
    : ''}</div>`;
  if (info.needSms) {
    html += `<div class="warn-bar" style="margin-top:10px">
      <div>🔐 大额单据已关联「${esc(info.personName)}」预采签名，需短信确认后生效${info.smsCode
        ? `<br>确认码：<b style="font-size:17px;letter-spacing:4px">${esc(info.smsCode)}</b>（请当面/电话转达被签字人）` : ''}</div>
      <input id="spCodeIn" class="search" style="margin-top:8px;text-align:center;letter-spacing:6px" placeholder="输入 6 位确认码" maxlength="6" inputmode="numeric" autocomplete="off">
      <button class="btn" id="spSmsGo" style="margin-top:8px;width:100%">✔ 确认签字生效</button></div>`;
  } else if (!auto) {
    const reason = info.needsLive ? '该单据金额已达大额签字阈值，须现场补签' : `暂无${esc(ctx.title || '')}预采电子签名`;
    html += `<div class="warn-bar" style="margin-top:10px">
      <div>📝 已关联操作员 <b>${op}</b> · ${reason}</div>
      <button class="btn" id="spGo" style="margin-top:8px;width:100%">✍️ 请${esc(ctx.defaultName || '签字人')}现场签名</button>
      <div class="hint" style="margin:6px 0 0">现场手写随单据留痕；可后续预采模板免签</div></div>`;
  }
  sb.innerHTML = html;
  v.insertAdjacentElement('beforeend', sb);
  if (info.needSms) {
    sb.querySelector('#spCodeIn').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
    sb.querySelector('#spSmsGo').onclick = async () => {
      const code = sb.querySelector('#spCodeIn').value.trim();
      if (!/^\d{6}$/.test(code)) { toast('请输入 6 位数字确认码'); return; }
      try {
        await call('POST', '/purchase/signatures/confirm', { bizType: ctx.bizType, bizId: ctx.bizId, code });
        sb.querySelector('.warn-bar').innerHTML = `<div>✅ 短信确认通过，签字已生效（${esc(info.personName)}）</div>`;
        toast('签字已生效');
      } catch (e) { toast(e.message); }
    };
    return;
  }
  if (auto) return;
  sb.querySelector('#spGo').onclick = () => SignPad.open({
    title: ctx.signTitle || '现场签名',
    hint: ctx.hint || '请签字人在手机屏幕手写签名，提交后随单据留痕',
    defaultName: ctx.defaultName || '',
    onSave: async signData => {
      try {
        const s = await call('POST', '/purchase/signatures/attach', {
          bizType: ctx.bizType, bizId: ctx.bizId,
          personName: signData.personName, roleTitle: signData.roleTitle, image: signData.image,
        });
        sb.innerHTML = `<div class="ok-bar">${ctx.doneText}<br>📝 已关联操作员 <b>${op}</b> · 业务员「${esc(s.personName)}」（现场补签）</div>`;
        toast('现场签名已留痕');
      } catch (e) { toast(e.message); }
    },
  });
}

/** M3a 共享：票据 OCR 识别入库（拍照/文本 → 识别预览 → 低价保护 → 生成入库草稿）
 *  V4.14.1：未选供应商时先识别，识别后按明细主供应商投票自动回选（setSupplier 回调写回页面下拉） */
function openInvoiceModal(getSupplierId, setSupplier) {
  const supplierId = Number(getSupplierId());
  let rows = [], dataUrl = '', applying = false;
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet" style="padding:14px">
    <div style="display:flex;align-items:center;margin-bottom:8px">
      <b style="flex:1;font-size:15px">📄 票据 OCR 识别入库</b>
      <button class="mini-btn" id="ivClose">关闭</button>
    </div>
    <div class="hint" style="margin:0 0 8px" id="ivSupHint">${supplierId ? '供应商：' + esc(SUP_NAMES[supplierId] || ('#' + supplierId)) : '未选供应商：识别后按商品主供应商自动选择'}</div>
    <div style="display:flex;gap:8px">
      <input type="file" id="ivCam" accept="image/*" capture="environment" class="file-hidden">
      <input type="file" id="ivGal" accept="image/*" class="file-hidden">
      <button class="btn ghost" id="ivTake" style="flex:1">📷 拍照票据</button>
      <button class="btn ghost" id="ivPick" style="flex:1">🖼 选择照片</button>
      <button class="btn ghost" id="ivTextMode" style="flex:1">✏️ 文本模式</button>
    </div>
    <textarea id="ivTxt" class="hidden" rows="5" style="width:100%;margin-top:8px;box-sizing:border-box" placeholder="每行：商品名,条码,单价,数量[,生产日期][,保质期天]"></textarea>
    <img id="ivPrev" class="hidden" style="width:100%;border-radius:12px;margin-top:8px">
    <button class="btn" id="ivGo" style="margin-top:8px">🔍 开始识别</button>
    <div id="ivRows" style="margin-top:10px"></div>
    <div id="ivForce" class="hidden" style="margin-top:8px">
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="ivForceCb"><span>强制通过低价行（店长强推，入库审核前可撤销）</span></label>
    </div>
    <button class="btn ok hidden" id="ivApply" style="margin-top:10px">📦 生成入库草稿</button>
  </div>`;
  document.body.appendChild(m);
  const stop = () => m.remove();
  m.querySelector('#ivClose').onclick = stop;

  const handleInvoiceFile = f => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = e => {
      const MAX = 1600, img = new Image();
      img.onload = () => {
        const k = Math.min(1, MAX / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        dataUrl = c.toDataURL('image/jpeg', 0.72);
        m.querySelector('#ivPrev').src = dataUrl;
        m.querySelector('#ivPrev').classList.remove('hidden');
        toast('票据图片已就绪，点击开始识别');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(f);
  };
  bindPhotoPick(m, 'iv', handleInvoiceFile);
  m.querySelector('#ivTextMode').onclick = () => {
    m.querySelector('#ivTxt').classList.toggle('hidden');
    toast('文本模式：每行「商品名,条码,单价,数量」');
  };

  const renderRows = () => {
    const box = m.querySelector('#ivRows');
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="sec" style="margin-top:0">识别结果（${rows.filter(r => r.ok && r.matched).length} 条可入库）</div>` +
      rows.map((r, i) => {
        const tag = !r.ok ? '<span class="pill red">错误</span>'
          : r.blocked ? `<span class="pill red">⛔ 低价拦截</span>`
          : r.lowPrice ? '<span class="pill orange">⚠ 低于历史最低价</span>'
          : r.unmatched ? '<span class="pill gray">⚠ 未建档</span>'
          : '<span class="pill green">✓ 匹配</span>';
        return `<div class="row" style="flex-wrap:wrap">
          <div class="grow">
            <div class="t">${esc(r.name)} ${tag}</div>
            <div class="s">${esc(r.barcode || '无条码')}${r.minPrice != null ? ` · 历史最低 ¥${Number(r.minPrice).toFixed(2)}` : ''}${r.matchedName && r.matchedName !== r.name ? ` · 匹配「${esc(r.matchedName)}」` : ''}${!r.ok ? ' · ' + esc(r.err.join('；')) : ''}</div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <input class="mini-input" data-i="${i}" data-f="price" type="number" step="0.01" value="${r.price}" style="width:86px">
              <input class="mini-input" data-i="${i}" data-f="qty" type="number" step="1" value="${r.qty}" style="width:70px">
            </div>
          </div>
        </div>`;
      }).join('');
    box.querySelectorAll('.mini-input').forEach(inp => inp.onchange = () => {
      const r = rows[+inp.dataset.i];
      r[inp.dataset.f] = Math.max(0.01, Number(inp.value) || 0);
    });
    const hasLow = rows.some(r => r.ok && r.lowPrice);
    m.querySelector('#ivForce').classList.toggle('hidden', !hasLow);
    m.querySelector('#ivApply').classList.remove('hidden');
  };

  const recognize = async () => {
    const go = m.querySelector('#ivGo');
    go.disabled = true; go.textContent = '识别中…';
    try {
      const text = m.querySelector('#ivTxt').value.trim();
      let supId = Number(getSupplierId()) || 0;
      const d0 = await call('POST', '/ai/ocr-invoice', {
        ...(supId ? { supplierId: supId } : {}),
        ...(dataUrl ? { imageBase64: dataUrl } : {}),
        ...(text ? { text } : {}),
      });
      // V4.14.1：识别后自动选择供应商（票据指名 → 明细主供应商投票），写回收货页下拉
      if (!supId && d0.suggestedSupplier && d0.suggestedSupplier.id) {
        supId = Number(d0.suggestedSupplier.id);
        setSupplier && setSupplier(supId);
        m.querySelector('#ivSupHint').innerHTML = `已自动选择供应商：<b>${esc(d0.suggestedSupplier.name || ('#' + supId))}</b>`;
        toast(`已按票据自动选择供应商：${d0.suggestedSupplier.name || '#' + supId}`);
      }
      rows = (d0.rows || []).map(r => ({ ...r, qty: Number(r.qty) || 1, price: Number(r.price) || 0 }));
      renderRows();
      if (!d0.okCount) toast('未识别到可入库明细：' + (d0.unmatchedCount ? `未匹配 ${d0.unmatchedCount} 条（先建档）` : '请检查票据内容'));
      else toast(`识别 ${d0.okCount} 条 · 低价 ${d0.lowCount} · 拦截 ${d0.blockedCount}`);
    } catch (e) { toast(e.message); }
    finally { go.disabled = false; go.textContent = '🔍 开始识别'; }
  };
  m.querySelector('#ivGo').onclick = recognize;

  m.querySelector('#ivApply').onclick = async () => {
    if (applying) return;
    applying = true;
    const btn = m.querySelector('#ivApply');
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const d = await call('POST', '/ai/ocr-invoice', {
        supplierId: Number(getSupplierId()) || 0,
        rows: rows.map(r => ({ line: r.line, name: r.name, barcode: r.barcode, price: r.price, qty: r.qty })),
        apply: true,
        forceLowPrice: m.querySelector('#ivForceCb').checked,
        autoCreate: true,
      });
      m.querySelector('#ivRows').innerHTML = `<div class="ok-bar">✅ 已生成入库草稿：<b>${esc(d.inboundNo)}</b>（${d.createdCount} 条${d.blocked ? `，低价拦截 ${d.blocked} 条` : ''}）<br>草稿在桌面端「进货入库」审核，生产日期将按今天补齐，请审核时核对</div>`;
      m.querySelector('#ivApply').classList.add('hidden');
    } catch (e) { toast(e.message); }
    finally { applying = false; btn.disabled = false; btn.textContent = '📦 生成入库草稿'; }
  };
}

// ── 共享：条码扫码（原生 BarcodeDetector 优先，否则 ZXing 软解兜底，覆盖 iOS/微信/PC 浏览器）──
const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];
const Scanner = {
  hasNative: () => 'BarcodeDetector' in window,
  hasZxing: () => typeof window.ZXing !== 'undefined' && !!window.ZXing.BrowserMultiFormatReader,
  /** 给输入框挂「扫一扫」按钮；Enter/扫中后回调 onBarcode */
  attach(input, onBarcode) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px;position:relative';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.textContent = '📷 扫码';
    btn.style.flexShrink = '0';
    wrap.appendChild(btn);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onBarcode(input.value); } });
    btn.onclick = () => {
      if (!window.isSecureContext) { toast('当前为 HTTP 访问，浏览器禁止摄像头。请用 HTTPS 地址重新打开（后台重新生成二维码）'); input.focus(); return; }
      Scanner.start(input, onBarcode);
    };
  },
  /** 相机扫码：识别即停。多趟解码（native 全帧 → ROI → ROI×2 → 小窗×3 → 全帧兜底）。
   *  1080p 高清流 + 连续自动对焦 + 点击画面聚焦 + 手电筒 + 数码变焦（小码/远距识别率关键） */
  start(input, onBarcode) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="padding:14px">
      <div style="display:flex;align-items:center;margin-bottom:10px">
        <b style="flex:1;font-size:15px">📷 对准商品条码/二维码</b>
        <button class="mini-btn" id="scTorch" style="display:none">🔦</button>
        <button class="mini-btn" id="scClose" style="margin-left:6px">关闭</button>
      </div>
      <div id="scZoomRow" style="display:none;margin-bottom:8px;align-items:center;gap:8px">
        <span style="font-size:12px;color:#666;white-space:nowrap">🔍 变焦</span>
        <input id="scZoom" type="range" min="1" max="5" step="0.5" value="1" style="flex:1">
        <span id="scZoomVal" style="font-size:12px;color:#666;width:34px;text-align:right">1.0x</span>
      </div>
      <div class="scan-view">
        <video id="scVideo" playsinline muted style="width:100%;border-radius:12px;background:#000;max-height:46dvh;object-fit:cover"></video>
        <div class="scan-frame">
          <span class="sc-corner tl"></span><span class="sc-corner tr"></span>
          <span class="sc-corner bl"></span><span class="sc-corner br"></span>
          <div class="sc-baseline"></div>
          <div class="sc-scanline"></div>
        </div>
      </div>
      <div class="hint" id="scStat" style="text-align:center;color:#b0b0b0;font-size:11px;min-height:14px"></div>
      <div class="hint" style="text-align:center">将<b style="color:#ff3b30">红色基线</b>对准条码/二维码中心 · 识别成功自动加入 · 点击画面可对焦 · 小码请拉大变焦或凑近</div>
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
        <input id="scManual" placeholder="扫不上？手动输入条码回车" inputmode="numeric" autocomplete="off"
               style="flex:1;padding:9px 10px;border:1px solid #d8d8d8;border-radius:8px;font-size:14px;background:#fff">
        <button class="mini-btn" id="scManualGo" style="background:#28a745;color:#fff;padding:9px 14px;font-weight:600">确认</button>
      </div></div>`;
    document.body.appendChild(m);
    const video = m.querySelector('#scVideo');
    let stream = null, raf = 0, zxReader = null, done = false;
    const stop = () => {
      if (done) return; done = true;
      cancelAnimationFrame(raf);
      if (zxReader) { try { zxReader.reset(); } catch { /* 忽略 */ } zxReader = null; }
      if (stream) stream.getTracks().forEach(t => t.stop());
      m.remove();
    };
    m.querySelector('#scClose').onclick = stop;
    // 手动输入兜底（弧面/小码/格式不支持时，敲条码回车 = 视为扫码成功）
    const manualGo = () => {
      const v = (m.querySelector('#scManual').value || '').trim();
      if (v) hit(v);
    };
    m.querySelector('#scManualGo').onclick = manualGo;
    m.querySelector('#scManual').onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); manualGo(); }
    };
    const hit = code => { stop(); onBarcode(code); };

    /** 对焦增强：连续自动对焦 + 点击聚焦（pointsOfInterest）+ 手电筒 + 数码变焦（能力检测，逐项 try） */
    const enhance = async () => {
      const track = stream && stream.getVideoTracks()[0];
      if (!track) return;
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      try {
        if (caps.focusMode && caps.focusMode.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      } catch { /* 忽略 */ }
      // 数码变焦滑杆（小码/远距的关键手段；无 zoom 能力的摄像头隐藏此行）
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        const row = m.querySelector('#scZoomRow'), slider = m.querySelector('#scZoom'), val = m.querySelector('#scZoomVal');
        row.style.display = 'flex';
        slider.min = caps.zoom.min; slider.max = caps.zoom.max;
        slider.step = caps.zoom.step || Math.max(0.1, (caps.zoom.max - caps.zoom.min) / 10);
        slider.value = caps.zoom.min;
        val.textContent = `${Number(caps.zoom.min).toFixed(1)}x`;
        slider.oninput = async () => {
          val.textContent = `${Number(slider.value).toFixed(1)}x`;
          try { await track.applyConstraints({ advanced: [{ zoom: Number(slider.value) }] }); } catch { /* 忽略 */ }
        };
      }
      // 点击画面 → 以点击点为对焦点
      video.onpointerdown = async e => {
        if (!caps.pointsOfInterest) return;
        const r = video.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
        try { await track.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x, y }] }] }); } catch { /* 忽略 */ }
        try { await track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }] }] }); } catch { /* 忽略 */ }
      };
      // 手电筒
      const tBtn = m.querySelector('#scTorch');
      if (caps.torch) {
        tBtn.style.display = '';
        let on = false;
        tBtn.onclick = async () => {
          on = !on;
          tBtn.style.background = on ? '#f5c542' : '';
          try { await track.applyConstraints({ advanced: [{ torch: on }] }); } catch { /* 忽略 */ }
        };
      }
    };

    // 1080p 优先（1D 条码清晰度直接受益；能力不足浏览器自动降级）
    const HD = { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    // 统一解码：BarcodeDetector 原生优先（每帧极快、多码同时），未命中再走 zxing-wasm（WASM，
    // 对弧面/反光/模糊/低对比度条码远强于旧 @zxing/library JS 端口）。已 Node 端真实回合验证可解 EAN-13。
    if (typeof BarcodeDecode === 'undefined') {
      toast('扫码引擎未就绪，请刷新页面或手动输入条码'); input.focus();
    }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: HD });
      } catch {
        toast(window.isSecureContext ? '无法打开摄像头，请检查权限' : '摄像头不可用：HTTP 页面浏览器禁止调用，请改用 HTTPS 地址打开（后台重新生成二维码）');
        m.remove(); input.focus(); return;
      }
      video.srcObject = stream;
      await video.play();
      enhance();
      let busy = false, lastStat = 0;
      const statEl = m.querySelector('#scStat');
      const tick = async () => {
        if (done) return;
        raf = requestAnimationFrame(tick);
        if (busy || video.readyState < 2) return;
        busy = true;
        try {
          if (typeof BarcodeDecode !== 'undefined') {
            const codes = await BarcodeDecode.decode(video);
            const now = Date.now();
            if (now - lastStat > 600 && statEl) {   // 状态行：让“扫不上”可被看见、可报告
              lastStat = now;
              const s = BarcodeDecode.stats;
              statEl.textContent = `已尝试 ${s.frames} 帧 · 命中 ${s.hits} · 单帧 ${s.lastMs}ms · 引擎 ${s.lastEngine}`;
            }
            if (codes.length && codes[0].text) { hit(codes[0].text); return; }
          }
        } catch { /* 解码异常忽略，继续下一帧 */ }
        finally { busy = false; }
      };
      tick();
    })();
  },
};

// ── 共享：供应商下拉（SUP_CONTACTS 记录供应商常驻业务员，供现场签名默认名；SUP_NAMES 供退货行显示主供应商）──
const SUP_CONTACTS = {};
const SUP_NAMES = {};
async function fillSuppliers(sel, onlyConsign) {
  sel.innerHTML = '<option value="">加载中…</option>';
  const list = unwrap(await call('GET', '/purchase/suppliers'));
  const arr = onlyConsign ? list.filter(s => (s.biz_mode || s.bizMode) === '联营') : list;
  arr.forEach(s => {
    SUP_CONTACTS[Number(s.id)] = String(s.contact_person || '').trim();
    SUP_NAMES[Number(s.id)] = String(s.name || '').trim();   // V4.14.1：退货行显示主供应商名
  });
  sel.innerHTML = '<option value="">请选择供应商</option>' +
    arr.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  return arr;
}

// ── V4.14.1：左右手习惯全局生效（作业侧也镜像；checkout 已有同款，抽出共用存储键 pwa_hand）──
async function applyWorkHand() {
  let HAND = localStorage.getItem('pwa_hand');
  if (!HAND) {
    try { HAND = (await call('GET', '/settings/key/mobile.hand')).value || 'right'; }
    catch { HAND = 'right'; }
    localStorage.setItem('pwa_hand', HAND);
  }
  $('#view').classList.toggle('hand-left', HAND === 'left');
}

// ── V4.14.1 通用件：数量手输 + 加减（所有作业模块行内数量框）；penetration到 0 不自动删行，提交时过滤 ──
function qtyInputHtml(i, val, step = 1) {
  return `<input class="qty-in" data-q="${i}" type="number" inputmode="decimal" min="0" step="${step}" value="${val}" style="width:64px;text-align:center;border:1px solid var(--line);border-radius:8px;padding:5px 2px;font-size:15px">`;
}
function bindQtyInput(box, lines, key, render) {
  box.querySelectorAll('.qty-in').forEach(inp => inp.onchange = () => {
    const l = lines[+inp.dataset.q];
    if (!l) return;
    l[key] = Math.max(0, Number(inp.value) || 0);
    render();
  });
}

// ── V4.14.1 通用件：拍照 / 选择照片 分离（拍照=直接调起后置摄像头；选择照片=手机/平板相册）──
// V4.14.2：隐藏 input 改「视觉隐藏」而非 display:none——部分安卓 WebView/内核对 display:none 的 input.click() 不传递相机/文件意图，导致拍照打不开摄像头
// V4.15.0：手机走原生相机意图（capture=environment，系统相机画质更好）；电脑浏览器走 getUserMedia 取景拍摄（file input 弹不出摄像头）
const IS_MOBILE = /Android|iPhone|iPad|Mobile|HarmonyOS/i.test(navigator.userAgent);

/** 桌面摄像头取景弹窗：getUserMedia 打开后置/唯一摄像头 → 「拍摄」截帧 → File 回调（与拍照input同管线） */
function openCamModal(onFile, fallbackInput) {
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,10,.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px';
  mask.innerHTML = `<div style="color:#fff;font-size:15px">📷 对准票证/货物后点「拍摄」</div>
    <video autoplay playsinline muted style="max-width:92vw;max-height:64vh;border-radius:14px;background:#000;box-shadow:0 8px 40px rgba(0,0,0,.6)"></video>
    <div style="display:flex;gap:14px;align-items:center">
      <button class="btn" id="cmClose">取消</button>
      <button class="btn ok" id="cmShot" style="min-width:130px;font-weight:700">📷 拍 摄</button>
    </div>
    <div id="cmErr" style="color:#ffb4a2;font-size:12.5px;max-width:80vw;text-align:center"></div>`;
  document.body.appendChild(mask);
  const v = mask.querySelector('video');
  let stream = null, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch { /* 忽略 */ }
    mask.remove();
  };
  mask.querySelector('#cmClose').onclick = stop;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    mask.querySelector('#cmErr').textContent = '当前环境不支持直接调起摄像头，已改为选择文件。';
    setTimeout(() => { stop(); fallbackInput && fallbackInput.click(); }, 900);
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false })
    .then(s => { if (stopped) { s.getTracks().forEach(t => t.stop()); return; } stream = s; v.srcObject = s; })
    .catch(e => {
      mask.querySelector('#cmErr').textContent = '摄像头打开失败（' + (e.name || e.message) + '）：已改为选择文件。';
      setTimeout(() => { stop(); fallbackInput && fallbackInput.click(); }, 1200);
    });
  mask.querySelector('#cmShot').onclick = async () => {
    if (!stream || !v.videoWidth) { toast('摄像头尚未就绪，稍候再点'); return; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.9);
    const blob = await (await fetch(dataUrl)).blob();
    stop();
    onFile(new File([blob], `cam-${Date.now()}.jpg`, { type: 'image/jpeg' }));
  };
}

function photoPickButtons(id) {
  return `
    <input type="file" id="${id}Cam" accept="image/*" capture="environment" class="file-hidden">
    <input type="file" id="${id}Gal" accept="image/*" class="file-hidden">
    <div style="display:flex;gap:8px">
      <button class="btn ghost" id="${id}Take" style="flex:1">📷 拍照</button>
      <button class="btn ghost" id="${id}Pick" style="flex:1">🖼 选择照片</button>
    </div>`;
}
function bindPhotoPick(root, id, onFile) {
  const cam = root.querySelector(`#${id}Cam`), gal = root.querySelector(`#${id}Gal`);
  root.querySelector(`#${id}Take`).onclick = () => {
    if (IS_MOBILE) { cam.click(); return; }      // 手机：原生相机意图
    openCamModal(onFile, cam);                    // 电脑：直接开摄像头取景拍摄
  };
  root.querySelector(`#${id}Pick`).onclick = () => gal.click();
  const handle = f => { if (f) onFile(f); };
  cam.onchange = () => { handle(cam.files[0]); cam.value = ''; };
  gal.onchange = () => { handle(gal.files[0]); gal.value = ''; };
}

// ── 共享：行编辑工具（数量步进 / 删除）──
function qtyCtrl(btnMinus, span, btnPlus, onChange) {
  const set = v => { span.textContent = String(Math.max(0, Number(v) || 0)); onChange && onChange(); };
  btnMinus.onclick = () => set(Number(span.textContent) - 1);
  btnPlus.onclick = () => set(Number(span.textContent) + 1);
  return set;
}

// ── 作业主页（原型 s-staff：橙色应急横幅 + 双列白卡网格 + 进行中状态）──
View.work = function (v) {
  applyWorkHand();   // V4.14.1：左右手习惯在作业模块全局生效
  const q = queueList().length;
  // V4.16.0 P9 语音增强：进作业页播报最新一条未读经营告警（同条每设备只播一次；设置 ai.voice.alerts 可关）
  (async () => {
    try {
      if (!window.PwaTTS) return;
      const d = await call('GET', '/finance/notices');
      const un = (d?.items || []).find(n => !n.read && n.title);
      if (un && !sessionStorage.getItem('voiced_notice_' + un.id)) {
        sessionStorage.setItem('voiced_notice_' + un.id, '1');
        PwaTTS.alert(un.title);
      }
    } catch { /* 告警拉取失败静默 */ }
  })();
  v.innerHTML = `
    <div class="work-hero" id="wCheckout">
      <div class="wh-t">🛒 移动收银（正式）<span class="tag">在线收银</span></div>
      <div class="wh-s" id="wPb">价格表同步中…</div>
    </div>
    <div class="grid">
      <div class="entry" id="wCheckoutEmg"><div class="eic">⚡</div><div class="et">移动收银（应急）</div><div class="es">离线价目 · 停电可用</div></div>
      <div class="entry" id="wReceive"><div class="eic">📦</div><div class="et">移动收货</div><div class="es">扫码/送货单OCR · 生产日期</div></div>
      <div class="entry" id="wRet"><div class="eic">↩️</div><div class="et">采购退货</div><div class="es">批次归属 · 拍照</div></div>
      <div class="entry" id="wCount"><div class="eic">🧮</div><div class="et">移动盘点</div><div class="es">扫码录实盘数</div></div>
      <div class="entry" id="wCountTask"><div class="eic">📋</div><div class="et">盘点任务</div><div class="es">按分类领任务实盘</div></div>
      <div class="entry" id="wLoss"><div class="eic">📷</div><div class="et">拍照报损</div><div class="es">整单拍照 ≥1 张</div></div>
      <div class="entry" id="wDeliver"><div class="eic">🚚</div><div class="et">配送码核销</div><div class="es">扫顾客 8 位码</div></div>
      <div class="entry" id="wAi"><div class="eic">🤖</div><div class="et">AI 训练采集</div><div class="es">随手拍样本入库</div></div>
      <div class="entry" id="wOrder"><div class="eic">🛒</div><div class="et">订货申请</div><div class="es">提交补货申请</div></div>
      <div class="entry" id="wPick"><div class="eic">🧺</div><div class="et">配货拣货</div><div class="es">扫码校验 · 缺货登记</div></div>
      <div class="entry" id="wTransfer"><div class="eic">🔄</div><div class="et">库存调拨</div><div class="es">批次整体转移</div></div>
      <div class="entry" id="wTimes"><div class="eic">🎟️</div><div class="et">次卡核销</div><div class="es">报手机号核销</div></div>
      <div class="entry" id="wTodo"><div class="eic">✅</div><div class="et">待办审批 <span class="badge-dot" id="wTodoN" style="display:none"></span></div><div class="es">单据审核 · 店长专属</div></div>
    </div>
    <div class="work-prog" id="wProg" style="display:none">
      <b>⏳ 进行中 · <span id="wProgNo">--</span></b>
      <div class="wp-r" id="wProgSub"><span></span><span style="color:var(--orange)">进行中</span></div>
    </div>
    <div class="work-prog">
      <b>⏳ 离线暂存 ${q} 单</b>
      <div class="wp-r"><span id="wNet">${navigator.onLine ? '🟢 网络在线' : '🔴 离线（恢复自动补传）'}</span><span>${esc(ME.name)} · ${esc(ME.empNo)}</span></div>
    </div>`;
  $('#wCheckout').onclick = () => push('移动收银', View.checkout);
  $('#wCheckoutEmg').onclick = () => push('移动收银', View.checkout, { emergency: true });
  $('#wReceive').onclick = () => push('移动收货', View.receive);
  $('#wRet').onclick = () => push('采购退货', View.ret);
  $('#wCount').onclick = () => push('移动盘点', View.count);
  $('#wCountTask').onclick = () => push('盘点任务', View.countTask);
  $('#wLoss').onclick = () => push('拍照报损', View.loss);
  $('#wDeliver').onclick = () => push('配送码核销', View.deliver);
  $('#wAi').onclick = () => push('AI 训练采集', View.aiCollect);
  $('#wOrder').onclick = () => push('订货申请', View.order);
  $('#wPick').onclick = () => push('配货拣货', View.pick);
  $('#wTransfer').onclick = () => push('库存调拨', View.transfer);
  $('#wTimes').onclick = () => push('次卡核销', View.timesCard);
  $('#wTodo').onclick = () => openTab('msg');
  const info = View.pricebookInfo();
  const el = $('#wPb');
  if (el) el.textContent = info.count
    ? `扫码 / 手输计价 · 离线价目缓存 ${info.count} 条 · ${info.ageHours}h 前更新${info.fresh ? '' : '（已过期）'}`
    : '扫码 / 手输计价 · 离线价目缓存（尚未同步）';
  loadWorkStatus();
};

// ── 工作台异步状态：待办审批角标 + 最新进行中单据（原型 s-staff 进行中卡）──
async function loadWorkStatus() {
  const badge = $('#wTodoN'), prog = $('#wProg');
  try {
    const [inb, ret, cnt, loss, inbs, cnts] = await Promise.all([
      call('GET', '/purchase/inbounds?status=' + encodeURIComponent('未审核')),
      call('GET', '/purchase/returns'),
      call('GET', '/inventory/counts?status=' + encodeURIComponent('进行中')),
      call('GET', '/inventory/losses?status=' + encodeURIComponent('待审核')),
      call('GET', '/purchase/inbounds'),
      call('GET', '/inventory/counts'),
    ]);
    const n = unwrap(inb).length
      + unwrap(ret).filter(r => r.status === '待审核').length
      + unwrap(cnt).length + unwrap(loss).length;
    if (badge && n > 0) { badge.style.display = ''; badge.textContent = n; }
    const rows = [];
    unwrap(inbs).forEach(r => Number(r.employee_id) === ME.staffId && r.status === '未审核' && rows.push({ no: r.inbound_no, icon: '📦', st: '未审核', items: r.item_count ?? 0, name: r.supplier_name, f: 'in' }));
    unwrap(cnts).forEach(r => Number(r.employee_id) === ME.staffId && r.status === '进行中' && rows.push({ no: r.count_no, icon: '🧮', st: '进行中', items: r.item_count ?? 0, name: r.scope || '全仓', f: 'count' }));
    if (rows.length && prog) {
      rows.sort((a, b) => String(b.no).localeCompare(String(a.no)));
      const r0 = rows[0];
      $('#wProgNo').textContent = r0.no;
      $('#wProgSub').firstElementChild.textContent = `${r0.icon} ${r0.st} · ${r0.items} 项${r0.name ? ' · ' + r0.name : ''}`;
      prog.style.display = '';
      prog.onclick = () => openTab('docs', r0.f);
    }
  } catch { /* 待办/进行中加载失败不阻塞工作台 */ }
}

// ── 移动收货（POST /purchase/inbounds）──
View.receive = function (v) {
  const lines = [];   // {product, qty, unitCost, productionDate, ordered?, arrived?}
  let curPoId = 0, curPoNo = '';
  const addLine = (p, qty = 1) => {
    const hit = lines.find(l => l.product.id === p.id);
    if (hit) { hit.qty += qty; renderLines(); return; }
    lines.push({ product: p, qty, unitCost: p.costPrice || p.sellPrice || 0, productionDate: '' });   // V4.14.1：生产日期默认空，点击弹日期选择器手选
    renderLines();
  };
  v.innerHTML = `
    <div class="sec">供应商（选后自动提取该供应商未收完采购单）</div>
    <div class="field"><select id="rcSup"></select></div>
    <div class="sec">从采购单快速收货（可选）</div>
    <div class="field"><select id="rcPo"><option value="">不关联采购单（自由收货）</option></select></div>
    <div class="sec">扫码 / 搜索添加商品</div>
    <input id="rcScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
    <div style="display:flex;gap:8px;margin-top:6px" id="rcTools">
      <button class="mini-btn" id="rcOcr" style="flex:1">📄 扫送货单（OCR 收货）</button>
      <button class="mini-btn" id="rcAi" style="flex:1">🤖 AI智拍（识别入库）</button>
    </div>
    <div class="sec">收货明细（如实填写实到数量 · 生产日期必填）</div>
    <div id="rcLines"></div>
    <div class="hint" id="rcSum"></div>
    <button class="btn ok" id="rcGo">提交入库审核</button>`;
  fillSuppliers($('#rcSup'));
  // V4.13.9 B2：选供应商后自动提取该供应商未收完的采购单（已下单·待入库 / 到货中）
  const loadPos = async () => {
    const sid = Number($('#rcSup').value) || 0;
    try {
      const [a, b] = await Promise.all([
        call('GET', '/purchase/orders?status=' + encodeURIComponent('已下单') + (sid ? '&supplierId=' + sid : '')),
        call('GET', '/purchase/orders?status=' + encodeURIComponent('到货中') + (sid ? '&supplierId=' + sid : '')),
      ]);
      const pos = [...unwrap(a), ...unwrap(b)];
      const sel = $('#rcPo');
      sel.innerHTML = '<option value="">不关联采购单（自由收货）</option>' + pos.map(o =>
        `<option value="${o.id}">${esc(o.po_no)} · ${esc(o.supplier_name || '')} · ${o.item_count ?? '?'} 项</option>`).join('');
      return pos;
    } catch { return []; }
  };
  $('#rcSup').onchange = () => { loadPos(); };
  // 首次加载（未选供应商时列全部）
  loadPos();
  {
    const sel = $('#rcPo');
      sel.onchange = async () => {
        const id = Number(sel.value);
        lines.length = 0; curPoId = 0; curPoNo = '';
        if (!id) { renderLines(); return; }
        try {
          const o = await call('GET', '/purchase/orders/' + id);
          curPoId = Number(o.id); curPoNo = o.po_no || '';
          if (o.supplier_id) $('#rcSup').value = String(o.supplier_id);
          for (const it of (o.items || [])) {
            const remain = Number(it.order_qty) - Number(it.arrived_qty || 0);
            if (remain <= 0) continue;
            let p = null;
            try { const d = await call('GET', '/products/' + it.product_id); p = normProduct(d.product || d); } catch { /* 商品可能已删 */ }
            if (!p) p = { id: Number(it.product_id), name: it.product_name || ('商品#' + it.product_id), barcode: '', spec: '', unit: it.base_unit || '', sellPrice: 0 };
            lines.push({ product: p, qty: remain, unitCost: Number(it.price ?? 0) || 0, productionDate: today(),
                         ordered: Number(it.order_qty), arrived: Number(it.arrived_qty || 0) });
          }
          renderLines();
          toast(`已提取 ${curPoNo}：请逐项核对，如实填写实到数量`);
        } catch (e) { toast(e.message); }
      };
  }
  $('#rcAi').onclick = () => aiAddLines('intake', 'AI 多商品识别入库', (p, n) => addLine(p, n));
  // V4.9.10 供应商送货单 OCR 收货：V4.14.1 未选供应商时识别后自动回选
  $('#rcOcr').onclick = () => openInvoiceModal(() => Number($('#rcSup').value), id => { $('#rcSup').value = String(id); loadPos(); });
  Scanner.attach($('#rcScan'), async key => {
    await scanResolve(key, p => {
      addLine(p);
      $('#rcScan').value = '';
      toast(`已添加 ${p.name}`);
    }, async (kw, aiItems) => {
      if (aiItems) return addAiFallback(aiItems, p => addLine(p));
      if (!kw) return;
      const p2 = await lookupProduct(kw);
      if (p2) { addLine(p2); $('#rcScan').value = ''; toast(`已添加 ${p2.name}`); }
      else toast('仍未找到商品：' + kw);
    });
  });
  const linesBox = $('#rcLines');
  function renderLines() {
    if (!lines.length) { linesBox.innerHTML = '<div class="empty">暂无明细，扫一扫或从采购单提取</div>'; }
    else {
      linesBox.innerHTML = lines.map((l, i) => `
        <div class="recv-line">
          <div class="rl-top">
            <div class="t">${esc(l.product.name)}<span class="rl-meta">${esc(l.product.spec || l.product.unit || '')} · 进价 ¥${money(l.unitCost)}${l.ordered != null ? ` · 订购 ${l.ordered}/已到 ${l.arrived ?? 0}` : ''}</span><span class="pill gray">${esc(l.product.barcode || '—')}</span></div>
            <button class="mini-btn danger" data-d="${i}">删</button>
          </div>
          <div class="rl-grid">
            <div class="rl-cell">
              <label>单价（元）</label>
              <input class="mini-input" data-i="${i}" data-f="unitCost" type="number" step="0.01" value="${l.unitCost}" style="width:92px">
            </div>
            <div class="rl-cell">
              <label>数量</label>
              <div class="qty"><button data-m="${i}">−</button>${qtyInputHtml(i, l.qty)}<button data-p="${i}">＋</button></div>
            </div>
            <div class="rl-cell" style="flex:1;min-width:150px">
              <label>生产日期</label>
              <input class="mini-input" data-i="${i}" data-f="productionDate" type="date" value="${l.productionDate}" placeholder="生产日期" style="width:100%">
            </div>
          </div>
        </div>`).join('');
      linesBox.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const i = +b.dataset.m; const l = lines[i]; l.qty = Math.max(0, l.qty - 1); renderLines(); });   // V4.14.1：数量 0 提交时自动过滤（行保留手输改正）
      linesBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { lines[+b.dataset.p].qty++; renderLines(); });
      bindQtyInput(linesBox, lines, 'qty', renderLines);
      linesBox.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { lines.splice(+b.dataset.d, 1); renderLines(); });
      linesBox.querySelectorAll('.mini-input').forEach(inp => inp.onchange = () => {
        lines[+inp.dataset.i][inp.dataset.f] = inp.dataset.f === 'unitCost' ? Number(inp.value) : inp.value;
      });
    }
    $('#rcSum').textContent = `共 ${lines.length} 种 / ${lines.reduce((s, l) => s + l.qty, 0)} 件`;
  }
  renderLines();
  $('#rcGo').onclick = async () => {
    const supplierId = Number($('#rcSup').value);
    if (!supplierId) { toast('请选择供应商'); return; }
    const valid = lines.filter(l => l.qty > 0);
    if (!valid.length) { toast('请先添加收货明细'); return; }
    if (valid.some(l => !l.productionDate)) { toast('生产日期必填'); return; }
    try {
      const d = await call('POST', '/purchase/inbounds', {
        supplierId,
        ...(curPoId ? { poId: curPoId } : {}),
        items: valid.map(l => ({ productId: l.product.id, qty: l.qty, unitCost: l.unitCost, productionDate: l.productionDate })),
      });
      showSignResult(v, d, {
        bizType: 'inbound', bizId: d.id,
        doneText: `✅ 收货单已提交入库审核：<b>${esc(d.inboundNo)}</b>（${d.status}）${curPoNo ? `<br>已回写采购单 ${esc(curPoNo)} 到货量` : ''}<br>后台「采购入库」审核通过后正式入库`,
        title: '该供应商业务员',
        signTitle: '供应商业务员现场签名',
        defaultName: SUP_CONTACTS[supplierId] || '',
        hint: '请供应商业务员在手机屏幕手写签名（该供应商暂无预采电子签名，提交后即随单据留痕）',
      });
      lines.length = 0; curPoId = 0; curPoNo = '';
      renderLines();
      $('#rcSup').value = '';
      $('#rcPo').value = '';
    } catch (e) { toast(e.message); }
  };
};

// ── 采购退货（POST /purchase/returns + 拍照凭证）──
View.ret = function (v) {
  const lines = [];   // {product, qty}
  const addLine = async p => {
    // V4.14.1：默认按主供应商退；价目表缓存缺供应商属性时回源商品档案补全
    if (!p.supplierDefaultId) {
      try {
        const full = await productById(p.id);
        if (full && full.supplierDefaultId) { p.supplierDefaultId = full.supplierDefaultId; p.supplierName = full.supplierName || SUP_NAMES[full.supplierDefaultId] || ''; }
      } catch { /* 回源失败不阻塞 */ }
    } else if (!p.supplierName) {
      p.supplierName = SUP_NAMES[p.supplierDefaultId] || '';
    }
    if (!p.supplierDefaultId && !Number($('#rtSup').value)) {
      toast(`⚠️ ${p.name} 没有供应商属性，无法退货；请联系管理员在商品档案补全供应商`);
    }
    const hit = lines.find(l => l.product.id === p.id);
    if (hit) { hit.qty++; renderLines(); return; }
    lines.push({ product: p, qty: 1 });
    renderLines();
  };
  v.innerHTML = `
    <div class="sec">供应商（可选，留空则按商品主供应商自动分桶）</div>
    <div class="field"><select id="rtSup"></select></div>
    <div class="sec">扫码 / 搜索添加退货商品（可多供应商混退）</div>
    <input id="rtScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
    <div class="ai-right" style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="mini-btn" id="rtAi">🤖 AI智拍（识别退货）</button>
    </div>
    <div class="sec">退货明细（提交时按商品供应商自动分桶，每供应商一张单）</div>
    <div id="rtLines"></div>
    <div class="hint" id="rtSum"></div>
    <button class="btn ok" id="rtGo">提交退货单</button>
    <div class="warn-bar" style="margin-top:10px">📷 提交后需整单拍照 ≥1 张作为退货凭证（自动加水印），店长审核前必须补传。</div>`;
  fillSuppliers($('#rtSup'));
  $('#rtAi').onclick = () => aiAddLines('return', 'AI 多商品识别退货', (p, n) => { for (let i = 0; i < n; i++) addLine(p); });
  Scanner.attach($('#rtScan'), async key => {
    await scanResolve(key, p => { addLine(p); $('#rtScan').value = ''; },
      async (kw, aiItems) => {
        if (aiItems) return addAiFallback(aiItems, p => addLine(p));
        if (!kw) return;
        const p2 = await lookupProduct(kw);
        if (p2) { addLine(p2); $('#rtScan').value = ''; } else toast('仍未找到商品：' + kw);
      });
  });
  const linesBox = $('#rtLines');
  function renderLines() {
    if (!lines.length) linesBox.innerHTML = '<div class="empty">暂无明细，扫一扫添加</div>';
    else {
      linesBox.innerHTML = lines.map((l, i) => `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(l.product.name)} <span class="pill gray">${esc(l.product.barcode || '—')}</span></div>
            <div class="s">${esc(l.product.spec || '')}${l.product.supplierDefaultId ? ` · 主供：${esc(l.product.supplierName || SUP_NAMES[l.product.supplierDefaultId] || ('#' + l.product.supplierDefaultId))}` : '<span class="pill red">无主供应商</span>'}</div>
          </div>
          <div class="qty"><button data-m="${i}">−</button>${qtyInputHtml(i, l.qty)}<button data-p="${i}">＋</button></div>
          <button class="mini-btn danger" data-d="${i}">删</button>
        </div>`).join('');
      linesBox.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const i = +b.dataset.m; lines[i].qty = Math.max(0, lines[i].qty - 1); renderLines(); });   // V4.14.1：数量 0 提交时过滤
      linesBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { lines[+b.dataset.p].qty++; renderLines(); });
      bindQtyInput(linesBox, lines, 'qty', renderLines);
      linesBox.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { lines.splice(+b.dataset.d, 1); renderLines(); });
    }
    $('#rtSum').textContent = `共 ${lines.length} 种 / ${lines.reduce((s, l) => s + l.qty, 0)} 件`;
  }
  renderLines();
  $('#rtGo').onclick = async () => {
    // V4.13.9 B3：不强制选供应商；选了则全单归该供应商，否则按商品供应商自动分桶
    const supplierId = Number($('#rtSup').value) || 0;
    const valid = lines.filter(l => l.qty > 0);
    if (!valid.length) { toast('请先添加退货明细'); return; }
    try {
      const d = await call('POST', '/purchase/returns', {
        ...(supplierId ? { supplierId } : {}),
        items: valid.map(l => ({ productId: l.product.id, qty: l.qty })),
      });
      const multiNote = d.multi ? `<br>已按供应商拆为 <b>${d.docCount}</b> 张退货单（每张均需拍照凭证，请在后台逐单补传）` : '';
      showSignResult(v, d, {
        bizType: 'return', bizId: d.id,
        doneText: `✅ 退货单已提交：<b>${esc(d.returnNo)}</b>（${d.status}）${multiNote}<br>${esc(d.note || '')}`,
        title: '该供应商业务员',
        signTitle: '供应商业务员现场签名',
        defaultName: SUP_CONTACTS[supplierId] || '',
        hint: '请供应商业务员在手机屏幕手写签名（该供应商暂无预采电子签名，提交后即随单据留痕）',
      });
      lines.length = 0; renderLines();
      $('#rtSup').value = '';
      if (!d.multi) captureEvidence(v, d.id, d.returnNo);   // 混退多单时首单已在后台，逐单凭证后台补传
    } catch (e) { toast(e.message); }
  };
};

// ── 拍照 + 水印（单号+时间+操作人）→ /upload → 补传退货凭证 ──
function captureEvidence(v, retId, returnNo) {
  const label = `退货单 ${returnNo}`;
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet">
    <h3>📷 上传退货凭证 ${esc(label)}</h3>
    <div class="warn-bar">系统将自动添加水印：${esc(label)} · ${today()} · ${esc(ME.name)}</div>
    ${photoPickButtons('ev')}
    <img id="evPrev" class="hidden" style="width:100%;border-radius:12px;margin-top:10px">
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn ghost" id="evCancel" style="flex:1">稍后补传</button>
      <button class="btn ok hidden" id="evUp" style="flex:1">上传凭证</button>
    </div></div>`;
  document.body.appendChild(m);
  const prev = m.querySelector('#evPrev'), up = m.querySelector('#evUp');
  let dataUrl = '';
  m.querySelector('#evCancel').onclick = () => m.remove();
  bindPhotoPick(m, 'ev', async f => {
    if (!f) return;
    try {
      dataUrl = await watermarkImage(f, `${label} ${today()} ${ME.name}`);
      prev.src = dataUrl; prev.classList.remove('hidden');
      m.querySelector('#evTake').classList.add('hidden');
      m.querySelector('#evPick').classList.add('hidden');
      up.classList.remove('hidden');
      up.onclick = async () => {
        up.disabled = true; up.textContent = '上传中…';
        try {
          const u = await call('POST', '/upload', { image: dataUrl });
          await call('POST', `/purchase/returns/${retId}/evidence`, { evidencePath: u.path });
          toast('凭证已上传，等待店长审核');
          m.remove();
        } catch (e) { up.disabled = false; up.textContent = '上传凭证'; toast(e.message); }
      };
    } catch (e) { toast(e.message); }
  });
}
/** 图片压缩 + 水印 → JPEG dataURL（≤1280px） */
function watermarkImage(file, text) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      const k = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, c.height - 34, c.width, 34);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(13, c.width / 60)}px sans-serif`;
      ctx.fillText(text, 10, c.height - 10);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('图片读取失败')); };
    img.src = url;
  });
}

// ── 移动盘点（POST /inventory/counts）──
View.count = function (v) {
  const lines = [];   // {product, actualQty, bookQty}
  // V4.14.1：前置条件——盘点任务（自动拉取）与商品分类二选一，未选不能盘
  let scopeMode = '', scopeTaskId = 0, scopeCategoryId = 0;
  const addLine = p => {
    const hit = lines.find(l => l.product.id === p.id);
    if (hit) { hit.actualQty++; renderLines(); return; }
    lines.push({ product: p, actualQty: 1, bookQty: null });
    renderLines();
    lookupBookQty(p).then(b => { if (b !== null) { hitBook(p.id, b); } });
  };
  const hitBook = (pid, q) => {
    const l = lines.find(x => x.product.id === pid);
    if (l) { l.bookQty = q; renderLines(); }
  };
  v.innerHTML = `
    <div class="warn-bar" style="margin-bottom:8px">盘点范围（任务与分类二选一，选后才能开始盘点）</div>
    <div class="field"><select id="cnTask"><option value="">— 按盘点任务（自动拉取） —</option></select></div>
    <div class="field"><select id="cnCat"><option value="">— 按商品分类 —</option></select></div>
    <div id="cnScope" class="empty">请先选择盘点任务或商品分类（二者选其一）</div>
    <div id="cnWork" class="hidden">
    <div class="sec">扫码 / 搜索盘点商品（录入实盘数量）</div>
    <input id="cnScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
    <div class="ai-right" style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="mini-btn" id="cnAi">🤖 AI智拍（识别盘点）</button>
    </div>
    <div class="sec">实盘明细</div>
    <div id="cnLines"></div>
    <div class="hint" id="cnSum"></div>
    <button class="btn ok" id="cnGo">提交盘点单</button>
    </div>`;
  // 拉取可选拉任务与分类
  (async () => {
    try {
      const tasks = unwrap(await call('GET', '/inventory/count-tasks'));
      $('#cnTask').innerHTML = '<option value="">— 按盘点任务（自动拉取） —</option>' +
        tasks.filter(t => t.status !== '已完成' && t.status !== '待审核').map(t =>
          `<option value="${t.id}">${esc(t.task_no || t.name)} · ${esc(t.category_names || t.scope_type || '')} · ${t.counted_sku ?? 0}/${t.total_sku ?? '?'} 已盘</option>`).join('');
    } catch { /* 任务拉取失败不阻塞分类选择 */ }
    try {
      const cats = unwrap(await call('GET', '/products/categories'));
      $('#cnCat').innerHTML = '<option value="">— 按商品分类 —</option>' +
        cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    } catch { /* 分类拉取失败不阻塞任务选择 */ }
  })();
  const syncScope = () => {
    scopeTaskId = Number($('#cnTask').value) || 0;
    scopeCategoryId = Number($('#cnCat').value) || 0;
    if (scopeTaskId && scopeCategoryId) {
      // 二者同选：以后选的为准（互斥提示）
      if (document.activeElement === $('#cnTask')) { $('#cnCat').value = ''; scopeCategoryId = 0; }
      else { $('#cnTask').value = ''; scopeTaskId = 0; }
    }
    scopeMode = scopeTaskId ? 'task' : (scopeCategoryId ? 'category' : '');
    const ready = !!scopeMode;
    $('#cnWork').classList.toggle('hidden', !ready);
    $('#cnScope').classList.toggle('hidden', ready);
    if (ready) $('#cnScope').classList.add('hidden');
  };
  $('#cnTask').onchange = syncScope;
  $('#cnCat').onchange = syncScope;
  $('#cnAi').onclick = () => {
    if (!scopeMode) { toast('请先选择盘点任务或商品分类'); return; }
    aiAddLines('count', 'AI 多商品识别盘点', (p, n) => { for (let i = 0; i < n; i++) addLine(p); });
  };
  Scanner.attach($('#cnScan'), async key => {
    if (!scopeMode) { toast('请先选择盘点任务或商品分类'); $('#cnScan').value = ''; return; }
    await scanResolve(key, p => { addLine(p); $('#cnScan').value = ''; },
      async (kw, aiItems) => {
        if (aiItems) return addAiFallback(aiItems, p => addLine(p));
        if (!kw) return;
        const p2 = await lookupProduct(kw);
        if (p2) { addLine(p2); $('#cnScan').value = ''; } else toast('仍未找到商品：' + kw);
      });
  });
  const linesBox = $('#cnLines');
  function renderLines() {
    if (!lines.length) linesBox.innerHTML = '<div class="empty">暂无明细，扫一扫添加</div>';
    else {
      linesBox.innerHTML = lines.map((l, i) => `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(l.product.name)} <span class="pill gray">${esc(l.product.barcode || '—')}</span></div>
            <div class="s">${l.bookQty === null ? '账面：…' : '账面 ' + l.bookQty + ' · 差异 ' + (l.actualQty - l.bookQty)}</div>
          </div>
          <div class="qty"><button data-m="${i}">−</button>${qtyInputHtml(i, l.actualQty)}<button data-p="${i}">＋</button></div>
          <button class="mini-btn danger" data-d="${i}">删</button>
        </div>`).join('');
      linesBox.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const i = +b.dataset.m; lines[i].actualQty = Math.max(0, lines[i].actualQty - 1); renderLines(); });   // V4.14.1：数量 0 提交时过滤
      linesBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { lines[+b.dataset.p].actualQty++; renderLines(); });
      bindQtyInput(linesBox, lines, 'actualQty', renderLines);
      linesBox.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { lines.splice(+b.dataset.d, 1); renderLines(); });
    }
    $('#cnSum').textContent = `共 ${lines.length} 种 / 实盘 ${lines.reduce((s, l) => s + l.actualQty, 0)} 件`;
  }
  renderLines();
  $('#cnGo').onclick = async () => {
    const valid = lines.filter(l => l.actualQty >= 0);
    if (!valid.length) { toast('请先录入盘点明细'); return; }
    try {
      const d = await call('POST', '/inventory/counts', {
        items: valid.map(l => ({ productId: l.product.id, actualQty: l.actualQty })),
      });
      showSignResult(v, d, {
        bizType: 'count', bizId: d.id,
        doneText: `✅ 盘点单已提交：<b>${esc(d.countNo)}</b>（${d.status}）`,
        title: '盘点确认人',
        signTitle: '盘点确认签名',
        defaultName: ME.name,
        hint: '请盘点员/店长在手机屏幕手写签名确认（提交后即随单据留痕）',
      });
      lines.length = 0; renderLines();
    } catch (e) { toast(e.message); }
  };
};
async function lookupBookQty(p) {
  try {
    const list = unwrap(await call('GET', '/inventory/summary?keyword=' + encodeURIComponent(p.barcode || p.name)));
    const hit = list.find(r => Number(r.id) === p.id);
    return hit ? Number(hit.qty_total) : null;
  } catch { return null; }
}

// ── 拍照报损（POST /inventory/losses，整单拍照 ≥1 张）──
View.loss = function (v) {
  const lines = [];   // {product, qty}
  const addLine = p => {
    const hit = lines.find(l => l.product.id === p.id);
    if (hit) { hit.qty++; renderLines(); return; }
    lines.push({ product: p, qty: 1 });
    renderLines();
  };
  let photoPath = '';
  v.innerHTML = `
    <div class="sec">报损原因</div>
    <div class="field"><select id="lsReason">
      <option value="损耗">损耗</option><option value="过期">过期</option>
      <option value="破损">破损</option><option value="质量问题">质量问题</option>
    </select></div>
    <div class="sec">拍照凭证（必拍 ≥1 张）</div>
    ${photoPickButtons('ls')}
    <img id="lsPrev" class="hidden" style="width:100%;border-radius:12px;margin-top:8px">
    <div class="sec">扫码 / 搜索添加报损商品</div>
    <input id="lsScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
    <div class="ai-right" style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="mini-btn" id="lsAi">🤖 AI智拍（识别报损）</button>
    </div>
    <div class="sec">报损明细</div>
    <div id="lsLines"></div>
    <div class="hint" id="lsSum"></div>
    <button class="btn ok" id="lsGo">提交报损单</button>`;
  Scanner.attach($('#lsScan'), async key => {
    await scanResolve(key, p => { addLine(p); $('#lsScan').value = ''; },
      async (kw, aiItems) => {
        if (aiItems) return addAiFallback(aiItems, p => addLine(p));
        if (!kw) return;
        const p2 = await lookupProduct(kw);
        if (p2) { addLine(p2); $('#lsScan').value = ''; } else toast('仍未找到商品：' + kw);
      });
  });
  $('#lsAi').onclick = () => aiAddLines('loss', 'AI 多商品识别报损', (p, n) => { for (let i = 0; i < n; i++) addLine(p); });
  const handleLossFile = async f => {
    if (!f) return;
    try {
      const dataUrl = await watermarkImage(f, `报损 ${today()} ${ME.name}`);
      $('#lsPrev').src = dataUrl; $('#lsPrev').classList.remove('hidden');
      $('#lsTake').textContent = '📷 重新拍照';
      $('#lsPick').textContent = '🖼 重选照片';
      const u = await call('POST', '/upload', { image: dataUrl });
      photoPath = u.path;
      toast('照片已上传');
    } catch (e) { toast(e.message); }
  };
  bindPhotoPick(v, 'ls', handleLossFile);   // V4.14.2 修复：报损拍照/选照按钮未绑定事件导致无效
  const linesBox = $('#lsLines');
  function renderLines() {
    if (!lines.length) linesBox.innerHTML = '<div class="empty">暂无明细，扫一扫添加</div>';
    else {
      linesBox.innerHTML = lines.map((l, i) => `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(l.product.name)} <span class="pill gray">${esc(l.product.barcode || '—')}</span></div>
            <div class="s">${esc(l.product.spec || '')}</div>
          </div>
          <div class="qty"><button data-m="${i}">−</button>${qtyInputHtml(i, l.qty)}<button data-p="${i}">＋</button></div>
          <button class="mini-btn danger" data-d="${i}">删</button>
        </div>`).join('');
      linesBox.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const i = +b.dataset.m; lines[i].qty = Math.max(0, lines[i].qty - 1); renderLines(); });   // V4.14.1：数量 0 提交时过滤
      linesBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { lines[+b.dataset.p].qty++; renderLines(); });
      bindQtyInput(linesBox, lines, 'qty', renderLines);
      linesBox.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { lines.splice(+b.dataset.d, 1); renderLines(); });
    }
    $('#lsSum').textContent = `共 ${lines.length} 种 / ${lines.reduce((s, l) => s + l.qty, 0)} 件`;
  }
  renderLines();
  $('#lsGo').onclick = async () => {
    if (!photoPath) { toast('请先拍照上传报损凭证'); return; }
    const valid = lines.filter(l => l.qty > 0);
    if (!valid.length) { toast('请先添加报损明细'); return; }
    try {
      const d = await call('POST', '/inventory/losses', {
        reasonType: $('#lsReason').value,
        photoPath,
        items: valid.map(l => ({ productId: l.product.id, qty: l.qty })),
      });
      showSignResult(v, d, {
        bizType: 'loss', bizId: d.id,
        doneText: `✅ 报损单已提交：<b>${esc(d.lossNo)}</b>（${d.status}，合计 ${money(d.totalCost)} 元）`,
        title: '报损确认',
        signTitle: '报损确认签名',
        defaultName: ME.name,
        hint: '报损无供应商业务员，请操作员/店长在手机屏幕手写签名确认（提交后即随单据留痕）',
      });
      lines.length = 0; renderLines(); photoPath = '';
      $('#lsPrev').classList.add('hidden'); $('#lsTake').textContent = '📷 拍照'; $('#lsPick').textContent = '🖼 选择照片';
    } catch (e) { toast(e.message); }
  };
};

// ── 盘点任务（V4.8.25：后台创建任务→店员按分类实盘→提交待审核）──
View.countTask = function (v) {
  v.innerHTML = '<div class="sec">我的盘点任务</div><div id="ctList"><div class="empty">加载中…</div></div>';
  const load = async () => {
    try {
      const list = unwrap(await call('GET', '/inventory/count-tasks?assigneeId=' + ME.staffId));
      const box = $('#ctList');
      if (!list.length) { box.innerHTML = '<div class="empty">暂无指派给我的盘点任务</div>'; return; }
      box.innerHTML = list.map(function (t) {
        const stCls = t.status === '待执行' ? 'gray' : (t.status === '已完成' ? 'green' : 'orange');
        return '<div class="row" data-id="' + t.id + '" style="cursor:pointer">'
          + '<div class="grow"><div class="t">' + esc(t.name) + ' <span class="pill gray">' + esc(t.task_no) + '</span></div>'
          + '<div class="s">' + esc(t.category_names || t.scope_type) + ' · ' + t.counted_sku + '/' + t.total_sku + ' 已盘</div></div>'
          + '<span class="pill ' + stCls + '">' + esc(t.status) + '</span></div>';
      }).join('');
      box.querySelectorAll('[data-id]').forEach(function (r) { r.onclick = function () { openTask(Number(r.dataset.id)); }; });
    } catch (e) { toast(e.message); }
  };
  const openTask = async (id) => {
    try {
      const t = await call('GET', '/inventory/count-tasks/' + id);
      const items = t.items || [];
      const groups = {};
      items.forEach(function (it) { const g = it.category_name || '未分类'; (groups[g] = groups[g] || []).push(it); });
      const canEdit = t.status === '执行中' || t.status === '待审核';
      const canStart = t.status === '待执行';
      const filled = items.filter(function (x) { return x.actual_qty != null; }).length;
      let html = '<div class="sec">' + esc(t.name) + ' · ' + esc(t.task_no)
        + ' <span class="pill gray">' + esc(t.status) + '</span></div>'
        + '<div class="hint">范围：' + esc(t.category_names || t.scope_type) + ' · 共 ' + t.total_sku + ' 种 · 已盘 ' + t.counted_sku + '</div>';
      html += '<div id="ctItems">' + Object.keys(groups).map(function (g) {
        return '<div class="sec">📂 ' + esc(g) + '</div>' + groups[g].map(function (it) {
          const book = Number(it.book_qty);
          const diff = it.actual_qty != null ? (Number(it.actual_qty) - book) : null;
          const right = canEdit
            ? '<div class="qty"><input data-it="' + it.id + '" type="number" min="0" step="0.001" value="'
              + (it.actual_qty != null ? Number(it.actual_qty) : '') + '" placeholder="实盘" style="width:76px"></div>'
            : '<span class="pill ' + (it.actual_qty != null ? 'green' : 'orange') + '">'
              + (it.actual_qty != null ? '已盘 ' + Number(it.actual_qty) : '未盘') + '</span>';
          return '<div class="row"><div class="grow"><div class="t">' + esc(it.product_name) + '</div>'
            + '<div class="s">账面 ' + book + ' ' + esc(it.base_unit || '')
            + (diff != null ? ' · 差异 ' + diff : '') + '</div></div>' + right + '</div>';
        }).join('');
      }).join('') + '</div>';
      if (canStart) html += '<button class="btn ok" id="ctStart">▶ 开始执行</button>';
      if (canEdit) html += '<button class="btn ok" id="ctGo">提交实盘（已填 ' + filled + '/' + t.total_sku + '）</button>';
      if (t.status === '待审核') html += '<div class="hint">✅ 实盘已提交，等待店长在后台审核生成盘点单</div>';
      if (t.status === '已完成') html += '<div class="hint">✅ 已生成盘点单，差异已按 FIFO 生效</div>';
      v.innerHTML = html;
      const st = $('#ctStart');
      if (st) st.onclick = async function () {
        try { await call('POST', '/inventory/count-tasks/' + id + '/start', {}); toast('任务已开始'); openTask(id); }
        catch (e) { toast(e.message); }
      };
      const go = $('#ctGo');
      if (go) go.onclick = async function () {
        const payload = [];
        v.querySelectorAll('[data-it]').forEach(function (inp) {
          if (inp.value !== '') payload.push({ itemId: Number(inp.dataset.it), actualQty: Number(inp.value) });
        });
        if (!payload.length) { toast('请先填写实盘数量'); return; }
        try {
          const d = await call('POST', '/inventory/count-tasks/' + id + '/submit', { items: payload });
          toast('已提交 ' + payload.length + ' 项（' + d.countedSku + '/' + d.totalSku + '）');
          openTask(id);
        } catch (e) { toast(e.message); }
      };
    } catch (e) { toast(e.message); }
  };
  load();
};
