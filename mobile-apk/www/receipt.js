/**
 * V4.13.4 小票打印 + 开钱箱钩子（自包含模块，挂 window.PwaReceipt）
 *   - printReceipt(snap)：落单成功后自动打印 58/80mm 销售小票（隐藏 iframe + 浏览器打印，
 *     无驱动依赖；对接 ESC/POS 打印机装系统驱动后即为静默出纸）
 *   - kickDrawer()：现金收款后向钱箱发 ESC/POS 弹开指令（WebSerial；需先 connectDrawer() 授权，
 *     与 scale.js 电子秤同款连接模式）
 *   - 设置项（通用设置组）：pos.receipt.auto_print / pos.receipt.width / pos.drawer.enabled
 *   - 任何硬件异常只提示不阻断收银（调用方已 catch）
 */
(function () {
  'use strict';
  let drawerPort = null;      // WebSerial 已授权的钱箱端口
  let settingsCache = null;   // 会话内设置缓存
  let settingsAt = 0;
  let drawerHintShown = false;

  const call = (...a) => window.call ? window.call(...a) : Promise.reject(new Error('no call'));

  async function loadSettings(force) {
    if (!force && settingsCache && Date.now() - settingsAt < 60000) return settingsCache;
    const def = { autoPrint: true, width: 80, drawer: false };
    try {
      const get = async (key) => (await call('GET', '/settings/key/' + key))?.value;
      const [auto, w, dw] = await Promise.all([
        get('pos.receipt.auto_print'), get('pos.receipt.width'), get('pos.drawer.enabled')]);
      settingsCache = {
        autoPrint: auto === undefined ? def.autoPrint : (auto === true || auto === 'true'),
        width: Number(w) === 58 ? 58 : 80,
        drawer: dw === true || dw === 'true',
      };
    } catch { settingsCache = def; }
    settingsAt = Date.now();
    return settingsCache;
  }

  const money = n => (Number(n) || 0).toFixed(2);

  // ═══ V4.18.9：浏览器兜底小票接 hiprint v3 版式（与打印内核 hpToEls 同映射的 HTML 渲染） ═══
  const FW = { // 字段取值（与 printers.js buildReceiptLayout 的 FV 同口径）
    orderNo: s => String(s.orderNo || ''),
    time: s => new Date(s.time || Date.now()).toLocaleString('zh-CN', { hour12: false }),
    cashier: s => s.cashier || '', member: s => s.member || '',
    discount: s => s.roundAmount > 0 ? '-' + money(s.roundAmount) : '',
    subtotal: s => money(s.payable), total: s => money(s.payable),
    change: s => s.change != null ? money(s.change) : '',
    thanks: () => '谢谢惠顾 · 退换货请凭小票',
  };
  /** hiprint v3 JSON → 纵向流元素（同 printers.js hpToEls 映射） */
  function elsFromHp(hp) {
    const panel = hp && Array.isArray(hp.panels) ? hp.panels[0] : null;
    if (!panel) return null;
    return (panel.printElements || []).map(pe => {
      const o = (pe && pe.options) || {};
      const t = ((pe && pe.printElementType) || {}).type || '';
      if (t === 'hline') return { type: 'divider' };
      if (t === 'table') return { type: 'items' };
      if (t === 'rect' || t === 'image' || t === 'vline' || t === 'html') return null;
      if (t === 'text' || t === 'longText' || t === 'customText') {
        if (o.textType === 'barcode') return null;
        if (o.textType === 'qrcode') return { type: 'qrcode', key: o.field || 'orderNo' };
        const el = { type: 'text', align: o.textAlign === 'center' ? 'center' : o.textAlign === 'right' ? 'right' : 'left' };
        if (o.field) { el.type = o.title && !o.hideTitle ? 'kv' : 'field'; el.key = o.field; if (el.type === 'kv') el.label = o.title; }
        else el.text = o.title || o.testData || '';
        return el;
      }
      return null;
    }).filter(Boolean);
  }
  /** v3 版式 HTML（纵向流；二维码以居中单号行替代——浏览器打印通道暂不画 QR） */
  function receiptHTMLv3(snap, widthMm, tpl) {
    const els = elsFromHp(tpl.content.hp) || [];
    const store = tpl.content.title || localStorage.getItem('pwa_store_name') || '门店销售小票';
    const F = k => (FW[k] ? FW[k](snap) : '');
    const body = els.map(el => {
      if (el.type === 'divider') return '<div class="dash"></div>';
      if (el.type === 'items') return `<table><thead><tr><td>品名</td><td class="r">数量</td><td class="r">单价</td><td class="r">小计</td></tr></thead>
        <tbody>${(snap.lines || []).map(l => `<tr><td>${String(l.name).slice(0, 14)}</td><td class="r">×${l.qty}</td><td class="r">¥${money(l.price)}</td><td class="r">¥${money(l.qty * l.price)}</td></tr>`).join('')}</tbody></table>`;
      if (el.type === 'total') return `<div class="total"><span>实收（${snap.channel || ''}）</span><span>¥${money(snap.payable)}</span></div>`;
      if (el.type === 'qrcode') return `<div class="line c">单号 ${escHtml(F(el.key))}</div>`;
      if (el.type === 'kv') { const v = F(el.key); return v ? `<div class="meta div"><span>${escHtml(el.label || '')}</span><span>${escHtml(v)}</span></div>` : ''; }
      if (el.type === 'field') { const v = F(el.key); return v ? `<div class="line ${el.align === 'center' ? 'c' : el.align === 'right' ? 'r' : ''}">${escHtml(v)}</div>` : ''; }
      return el.text ? `<div class="line ${el.align === 'center' ? 'c' : el.align === 'right' ? 'r' : ''}">${escHtml(el.text)}</div>` : '';
    }).join('');
    return v3Shell(snap, widthMm, store, body);
  }
  function v3Shell(snap, widthMm, store, body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: ${widthMm}mm auto; margin: 3mm; }
      body { width:${widthMm - 6}mm; font:12px/1.5 "Microsoft YaHei",sans-serif; color:#000; margin:0; }
      h1 { font-size:15px; text-align:center; margin:2px 0 6px; letter-spacing:2px; }
      .meta, table { width:100%; border-collapse:collapse; font-size:11px; }
      .meta.div { display:flex; justify-content:space-between; }
      td { padding:1px 0; vertical-align:top; } .r { text-align:right; white-space:nowrap; }
      thead td { border-bottom:1px dashed #000; }
      .dash { border-top:1px dashed #000; margin:5px 0; }
      .line { font-size:11px; } .line.c { text-align:center; } .line.r { text-align:right; }
      .total { display:flex; justify-content:space-between; font-size:14px; font-weight:700;
               margin-top:4px; padding-top:4px; }
      .foot { text-align:center; font-size:10.5px; margin-top:8px; color:#333; }
      .cut { text-align:center; letter-spacing:6px; margin:6px 0 0; font-size:10px; }
    </style></head><body>
      <h1>${escHtml(store)}</h1>
      ${body}
      <div class="foot">请核对小票 · 退换货凭小票<br>****${String(snap.orderNo).slice(-4)}****<div class="cut">✂</div></div>
    </body></html>`;
  }
  function escHtml(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /** 80/58mm 小票 HTML（单据式排版：店名/单号/明细/合计/支付方式/会员） */
  function receiptHTML(snap, widthMm) {
    const store = localStorage.getItem('pwa_store_name') || '门店销售小票';
    const rows = (snap.lines || []).map(l => `
      <tr><td>${String(l.name).slice(0, 14)}</td>
          <td class="r">×${l.qty}</td>
          <td class="r">¥${money(l.price)}</td>
          <td class="r">¥${money(l.qty * l.price)}</td></tr>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: ${widthMm}mm auto; margin: 3mm; }
      body { width:${widthMm - 6}mm; font:12px/1.5 "Microsoft YaHei",sans-serif; color:#000; margin:0; }
      h1 { font-size:15px; text-align:center; margin:2px 0 6px; letter-spacing:2px; }
      .meta, table { width:100%; border-collapse:collapse; font-size:11px; }
      .meta div { display:flex; justify-content:space-between; }
      td { padding:1px 0; vertical-align:top; } .r { text-align:right; white-space:nowrap; }
      thead td { border-bottom:1px dashed #000; }
      .total { display:flex; justify-content:space-between; font-size:14px; font-weight:700;
               border-top:1px dashed #000; margin-top:6px; padding-top:6px; }
      .foot { text-align:center; font-size:10.5px; margin-top:8px; color:#333; }
      .cut { text-align:center; letter-spacing:6px; margin:6px 0 0; font-size:10px; }
    </style></head><body>
      <h1>${store}</h1>
      <div class="meta">
        <div><span>单号</span><span>${snap.orderNo}</span></div>
        <div><span>时间</span><span>${new Date(snap.time).toLocaleString('zh-CN', { hour12: false })}</span></div>
        ${snap.member ? `<div><span>会员</span><span>${snap.member}</span></div>` : ''}
        ${snap.roundAmount > 0 ? `<div><span>抹零</span><span>-¥${money(snap.roundAmount)}</span></div>` : ''}
      </div>
      <table><thead><tr><td>品名</td><td class="r">数量</td><td class="r">单价</td><td class="r">小计</td></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="total"><span>实收（${snap.channel || ''}）</span><span>¥${money(snap.payable)}</span></div>
      <div class="foot">谢谢惠顾 · 请核对小票 · 退换货凭小票<br>****${String(snap.orderNo).slice(-4)}****<div class="cut">✂</div></div>
    </body></html>`;
  }

  /** 打印小票；respectAuto=false 时无视开关强制打印（补打按钮用）
   *  V4.18.9：优先按 hiprint v3 版式渲染（打印中心「小票模版」可视化排版所见即所得） */
  async function printReceipt(snap, respectAuto = true) {
    const cfg = await loadSettings();
    if (respectAuto && !cfg.autoPrint) return false;
    if (!snap || !snap.orderNo) return false;
    let tpl = null;
    try { tpl = window.PwaPrinters && window.PwaPrinters.receiptTpl ? await window.PwaPrinters.receiptTpl() : await call('GET', '/print-templates/default?bizType=receipt'); } catch { /* 拉不到走固定版式 */ }
    const isV3 = tpl && tpl.content && Number(tpl.content.version) === 3 && tpl.content.hp
      && Array.isArray(tpl.content.hp.panels) && tpl.content.hp.panels[0]
      && (tpl.content.hp.panels[0].printElements || []).length;
    const html = isV3 ? receiptHTMLv3(snap, cfg.width, tpl) : receiptHTML(snap, cfg.width);
    // V4.20.0 P16：EXE 端走 Electron 隐藏窗口静默打印（无预览弹窗）；浏览器端仍 iframe（弹预览属正常）
    if (window.DesktopShell && window.DesktopShell.silentPrintHtml) {
      try { return await window.DesktopShell.silentPrintHtml(html, { widthMm: cfg.width }); } catch { /* 失败落回 iframe */ }
    }
    const old = document.getElementById('pwa-receipt-frame');
    if (old) old.remove();
    const f = document.createElement('iframe');
    f.id = 'pwa-receipt-frame';
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    const _blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    document.body.appendChild(f);
    f.src = _blobUrl;
    await new Promise(r => { f.onload = r; setTimeout(r, 800); });
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* 打印被拒绝不阻断 */ }
    setTimeout(() => { URL.revokeObjectURL(_blobUrl); f.remove(); }, 60000); // 打完回收
    return true;
  }

  /** 连接钱箱（WebSerial，须在用户手势内调用，如设置页「连接钱箱」按钮） */
  async function connectDrawer() {
    if (!navigator.serial) throw new Error('当前浏览器不支持 WebSerial（请用 Chrome/Edge）');
    drawerPort = await navigator.serial.requestPort();
    await drawerPort.open({ baudRate: 9600 });
    return true;
  }

  /** 弹钱箱：ESC p 0 25 250（2ms 脉冲 ×2 针，兼容大多数 RJ11 接小票机/USB 钱箱） */
  async function kickDrawer() {
    const cfg = await loadSettings();
    if (!cfg.drawer) return false;
    if (!drawerPort) {
      if (!drawerHintShown) { toastSafe('钱箱未连接：请在「我的-设备管理」先连接钱箱'); drawerHintShown = true; }
      return false;
    }
    try {
      const writer = drawerPort.writable.getWriter();
      await writer.write(new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]));
      writer.releaseLock();
      return true;
    } catch (e) { drawerPort = null; return false; }
  }

  /** V4.15.3 钱箱手动弹箱测试（设备管理用，无视 pos.drawer.enabled 开关） */
  async function testDrawer() {
    if (!drawerPort) throw new Error('钱箱未连接：请先在上方连接钱箱');
    const writer = drawerPort.writable.getWriter();
    await writer.write(new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]));
    writer.releaseLock();
    return true;
  }

  /** V4.15.3 小票机打印测试页（设备管理用）：走系统打印通道出一张 58/80mm 测试小票 */
  async function printTestPage() {
    const cfg = await loadSettings();
    return printReceipt({
      orderNo: 'TEST-' + String(Date.now()).slice(-6),
      payable: 8, roundAmount: 0,
      lines: [{ name: '测试商品A', qty: 1, price: 1 }, { name: '测试商品B', qty: 2, price: 3.5 }],
      channel: '打印测试', member: null, time: new Date(),
    }, false);
  }

  function toastSafe(msg) { try { window.toast && toast(msg, false); } catch { /* noop */ } }

  window.PwaReceipt = { printReceipt, printTestPage, kickDrawer, testDrawer, connectDrawer, loadSettings,
    drawerConnected: () => !!drawerPort };
})();
