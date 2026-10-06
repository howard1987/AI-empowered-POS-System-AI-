/**
 * V4.15.6 P1 打印底座：ESC/POS 指令级直驱内核（挂 window.PwaPrinters）
 *   - 通道三级：串口直驱（WebSerial，免系统驱动）→ 网口直发（后端代理 /printers/:id/send）
 *              → 浏览器 iframe 打印（PwaReceipt 兜底，任何打印机装系统驱动即可）
 *   - GBK 编码：TextDecoder('gbk') 反查表动态构建（无外部依赖，中文热敏机标准字符集）
 *   - 模版：默认打印机（width_mm 决定 58/80 版式）+ pos.print.auto / pos.print.copies 开关
 *   - 每次直驱打印落 print_jobs 留痕（重打标识），浏览器兜底通道由 PwaReceipt 自理
 *   - 硬件异常只提示不阻断收银
 */
(function () {
  'use strict';
  const call = (...a) => window.call ? window.call(...a) : Promise.reject(new Error('no call'));
  const ESC = 0x1B, GS = 0x1D;

  // ═══════════ GBK 编码（反查表，懒构建一次 ~24k 项 <50ms） ═══════════
  let gbkMap = null;
  function buildGbkMap() {
    const dec = new TextDecoder('gbk');
    const m = new Map();
    const buf = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xFE; lead++) {
      for (let trail = 0x40; trail <= 0xFE; trail++) {
        if (trail === 0x7F) continue;
        buf[0] = lead; buf[1] = trail;
        let s; try { s = dec.decode(buf); } catch { continue; }
        if (s && s.length === 1 && !m.has(s)) m.set(s, [lead, trail]);
      }
    }
    return m;
  }
  function gbkBytes(str) {
    if (!gbkMap) gbkMap = buildGbkMap();
    const out = [];
    for (const ch of String(str)) {
      const cp = ch.codePointAt(0);
      if (cp < 128) { out.push(cp); continue; }
      const b = gbkMap.get(ch);
      if (b) out.push(b[0], b[1]); else out.push(0x3F); // 未知字符 → '?'
    }
    return out;
  }

  // ═══════════ 排版工具（与 print.render.ts 同宽口径：全角=2） ═══════════
  const dispW = s => { let n = 0; for (const ch of s) n += ch.codePointAt(0) > 255 ? 2 : 1; return n; };
  function kv(k, v, col) { const pad = Math.max(1, col - dispW(k) - dispW(v)); return k + ' '.repeat(pad) + v; }
  function center(s, col) { const pad = Math.max(0, col - dispW(s)); return ' '.repeat(Math.floor(pad / 2)) + s; }
  function trunc(s, col) { let out = '', n = 0; for (const ch of s) { const w = ch.codePointAt(0) > 255 ? 2 : 1; if (n + w > col) break; out += ch; n += w; } return out; }
  const money = n => (Number(n) || 0).toFixed(2);

  // ═══════════ v3 可视化排版（hiprint JSON）→ 纵向流元素 → ESC/POS ═══════════
  /** hiprint 模板 JSON → 元素列表（与后端 print.hiprint.ts 同逻辑精简版；按 y 排序纵向流） */
  function hpToEls(hp) {
    const panel = hp && Array.isArray(hp.panels) ? hp.panels[0] : null;
    if (!panel) return null;
    const P = 72 / 25.4;
    const mm = v => Math.round((Number(v) || 0) / P * 100) / 100;
    const els = (panel.printElements || []).map(pe => {
      const o = (pe && pe.options) || {};
      const t = ((pe && pe.printElementType) || {}).type || '';
      const base = { x: mm(o.left), y: mm(o.top), w: mm(o.width), h: mm(o.height), show: true };
      if (t === 'hline') return { ...base, type: 'divider' };
      if (t === 'table') return { ...base, type: 'items' };
      if (t === 'rect' || t === 'image' || t === 'vline' || t === 'html') return null;
      if (t === 'text' || t === 'longText' || t === 'customText') {
        if (o.textType === 'qrcode') return { ...base, type: 'qrcode', key: o.field || 'orderNo' };
        if (o.textType === 'barcode') return null;   // ESC/POS 一维码兼容性差：忽略（条码建议打二维码或文字单号）
        const el = { ...base, type: 'text', align: o.textAlign === 'center' ? 'center' : o.textAlign === 'right' ? 'right' : 'left' };
        if (o.field) { el.type = o.title && !o.hideTitle ? 'kv' : 'field'; el.key = o.field; if (el.type === 'kv') el.label = o.title; }
        else el.text = o.title || o.testData || '';
        return el;
      }
      return null;
    }).filter(Boolean).sort((a, b) => a.y - b.y);
    return { elements: els };
  }

  /** 二维码（GS ( k，cn=49）：数据=单号 */
  function qrBytes(raw, gbk, data) {
    const bytes = gbk(data);
    raw(0x1D, 0x28, 0x6B, 4, 0x31, 0x41, 2, 0);        // 选模型 2
    raw(0x1D, 0x28, 0x6B, 3, 0x31, 0x43, 4);           // 模块 4
    raw(0x1D, 0x28, 0x6B, 3, 0x31, 0x45, 49);          // 纠错 M
    const n = bytes.length + 3;
    raw(0x1D, 0x28, 0x6B, n & 0xFF, (n >> 8) & 0xFF, 0x31, 0x50, 0x30, ...bytes);
    raw(0x1D, 0x28, 0x6B, 3, 0x31, 0x51, 0x30);        // 打印
  }

  /** v2/v3 纵向流渲染：元素按 y 顺序逐行输出（对齐/缩进随版式，明细/实收为专用块） */
  function buildReceiptLayout(snap, widthMm, jobType, opts, els) {
    const col = Number(widthMm) === 58 ? 32 : 48;
    const tpl = opts.tpl;
    const optCut = !(tpl && tpl.content && tpl.content.options && tpl.content.options.cut === false);
    const store = (tpl && tpl.content && tpl.content.title) || localStorage.getItem('pwa_store_name') || '门店销售小票';
    const stub = !!opts.stub;
    const out = [];
    const raw = (...b) => out.push(...b);
    const text = s => out.push(...gbkBytes(s), 0x0A);
    const padL = n => ' '.repeat(Math.max(0, Math.round(n)));
    const wmm = Number(widthMm) || 80;
    const FV = {
      orderNo: String(snap.orderNo || ''),
      time: new Date(snap.time || Date.now()).toLocaleString('zh-CN', { hour12: false }),
      cashier: snap.cashier || '', member: snap.member || '',
      discount: snap.roundAmount > 0 ? '-' + money(snap.roundAmount) : '',
      subtotal: money(snap.payable), total: money(snap.payable),
      change: snap.change != null ? money(snap.change) : '',
      thanks: '谢谢惠顾 · 退换货请凭小票',
    };
    raw(ESC, 0x40);
    raw(ESC, 0x61, 1); raw(GS, 0x21, 0x30);
    text(trunc(store, col));
    raw(GS, 0x21, 0x00);
    if (stub) text('- - 存 根 联 - -');
    if (jobType === '重打') text('** 重 打 **');
    text('='.repeat(col));
    raw(ESC, 0x61, 0);
    for (const el of els) {
      if (el.show === false) continue;
      const a = el.align || 'left';
      if (el.type === 'divider') { raw(ESC, 0x61, 0); text('-'.repeat(col)); continue; }
      if (el.type === 'items') {
        for (const l of (snap.lines || [])) {
          const amt = money((Number(l.qty) || 0) * (Number(l.price) || 0));
          const nameCol = col - dispW(amt) - 2;
          text(trunc(l.name || '', nameCol) + ' '.repeat(Math.max(1, nameCol - dispW(trunc(l.name || '', nameCol)))) + amt);
          text('  x' + l.qty + ' @ ' + money(l.price));
        }
        continue;
      }
      if (el.type === 'total') {
        const line = kv('实收(' + (snap.channel || '') + ')', money(snap.payable), col);
        raw(GS, 0x21, 0x11);
        if (a === 'center') { raw(ESC, 0x61, 1); text(line); raw(ESC, 0x61, 0); } else text(line);
        raw(GS, 0x21, 0x00);
        continue;
      }
      if (el.type === 'qrcode') { const d = String(snap.orderNo || ''); if (d) { raw(ESC, 0x61, 1); qrBytes(raw, gbkBytes, d); raw(ESC, 0x61, 0); } continue; }
      let s = el.type === 'kv' ? String(el.label || '') + (FV[el.key] ?? '')
        : el.type === 'field' ? String(FV[el.key] ?? '')
        : String(el.text ?? '');
      if (!s) continue;
      s = trunc(s, col);
      if (a === 'center') { raw(ESC, 0x61, 1); text(s); raw(ESC, 0x61, 0); }
      else if (a === 'right') text(padL(col - dispW(s)) + s);
      else text(padL((Number(el.x) || 0) * col / wmm) + s);
    }
    if (snap.regUrl) {   // V5.0.16：散客小票追加「扫码注册会员」二维码（ESC/POS 直驱，v2/v3 版式）
      raw(ESC, 0x61, 1);
      text('扫码注册会员');
      qrBytes(raw, gbkBytes, String(snap.regUrl));
      raw(ESC, 0x61, 0);
    }
    if (stub) {
      text('-'.repeat(col));
      text(kv('大写', rmbCapital(snap.payable), col));
      text('收银员签字：＿＿＿＿＿＿');
      text('顾客签字：＿＿＿＿＿＿');
    }
    text('='.repeat(col));
    raw(0x0A, 0x0A, 0x0A);
    if (optCut) raw(GS, 0x56, 0x42, 0x00);
    return new Uint8Array(out);
  }

  // ═══════════ ESC/POS 小票构建 ═══════════
  /** 手机/平板浏览器（串口能力缺失：Android WebView/移动 Chrome 无 Web Serial） */
  const isMobile = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

  /** 金额大写（存根联用） */
  function rmbCapital(n) {
    n = Math.round((Number(n) || 0) * 100);
    if (!n) return '零元整';
    const U = '零壹贰叁肆伍陆柒捌玖', D = ['', '拾', '佰', '仟'], G = ['万', '亿'];
    const int = Math.floor(n / 100), dec = n % 100, jiao = Math.floor(dec / 10), fen = dec % 10;
    let s = '', zero = false, sec = 0;
    const seg4 = v => { let t = '', z = false; for (let i = 3; i >= 0; i--) { const d = Math.floor(v / 10 ** i) % 10; if (d) { if (z) t += '零'; t += U[d] + D[i]; z = false; } else z = !!t; } return t; };
    for (let v = int; v > 0; sec++) {
      const part = v % 10000;
      if (part) { if (zero && s) s = '零' + s; s = seg4(part) + (G[sec - 1] || '') + s; zero = false; }
      else if (s) zero = true;
      v = Math.floor(v / 10000);
    }
    s = (s || '零') + '元';
    if (jiao) s += U[jiao] + '角'; else if (fen) s += '零';
    if (fen) s += U[fen] + '分'; else if (!jiao) s += '整';
    return s;
  }

  /** 默认小票模版（V4.15.8 P4：字段显隐随打印中心编辑；60s 缓存，无模版=全显示） */
  let tplCache, tplAt = 0;
  async function receiptTpl(force) {
    if (!force && tplCache !== undefined && Date.now() - tplAt < 60000) return tplCache;
    try { tplCache = await call('GET', '/print-templates/default?bizType=receipt'); }
    catch { tplCache = null; }
    tplAt = Date.now();
    return tplCache;
  }

  /** snap 形状与 PwaReceipt.printReceipt 一致：{orderNo,time,lines[{name,qty,price}],payable,channel,member,roundAmount}
   *  opts：{ stub=存根联版式, tpl=模版(调用方预取), jobType } */
  function buildReceiptBytes(snap, widthMm, jobType, opts = {}) {
    const tpl = opts.tpl;
    const c = tpl && tpl.content;
    // V4.15.9：v3（hiprint 排版）与 v2（元素）走纵向流渲染；v1 字段显隐走固定版式
    if (c && c.version === 3 && c.hp) {
      const r = hpToEls(c.hp);
      if (r && r.elements.length) return buildReceiptLayout(snap, widthMm, jobType, opts, r.elements);
    }
    if (c && c.version === 2 && Array.isArray(c.elements) && c.elements.length) {
      return buildReceiptLayout(snap, widthMm, jobType, opts,
        [...c.elements].filter(e => e && e.show !== false).sort((a, b) => (a.y || 0) - (b.y || 0)));
    }
    const col = Number(widthMm) === 58 ? 32 : 48;
    const F = k => { const f = tpl && tpl.content && tpl.content.fields; const x = f && f.find(v => v.key === k); return !x || x.show !== false; };
    const optCut = !(tpl && tpl.content && tpl.content.options && tpl.content.options.cut === false);
    const store = (tpl && tpl.content && tpl.content.title) || localStorage.getItem('pwa_store_name') || '门店销售小票';
    const stub = !!opts.stub;
    const out = [];
    const raw = (...b) => out.push(...b);
    const text = s => out.push(...gbkBytes(s), 0x0A);
    raw(ESC, 0x40);                          // 初始化
    raw(ESC, 0x61, 1); raw(GS, 0x21, 0x30);  // 居中 + 倍高宽店名
    text(trunc(store, col));
    raw(GS, 0x21, 0x00);
    if (stub) text('- - 存 根 联 - -');
    if (jobType === '重打') text('** 重 打 **');
    text('='.repeat(col));
    raw(ESC, 0x61, 0);                       // 左对齐
    if (F('orderNo')) text(kv('单号', snap.orderNo || '', col));
    if (F('time')) text(kv('时间', new Date(snap.time || Date.now()).toLocaleString('zh-CN', { hour12: false }), col));
    if (F('cashier') && snap.cashier) text(kv('收银员', trunc(snap.cashier, col - 8), col));
    if (F('member') && snap.member) text(kv('会员', trunc(snap.member, col - 6), col));
    if (F('discount') && snap.roundAmount > 0) text(kv('抹零', '-' + money(snap.roundAmount), col));
    text('-'.repeat(col));
    if (F('items')) {
      for (const l of (snap.lines || [])) {
        const amt = money((Number(l.qty) || 0) * (Number(l.price) || 0));
        const nameCol = col - dispW(amt) - 2;
        text(trunc(l.name || '', nameCol) + ' '.repeat(Math.max(1, nameCol - dispW(trunc(l.name || '', nameCol)))) + amt);
        text('  x' + l.qty + ' @ ' + money(l.price));
      }
    }
    text('-'.repeat(col));
    if (F('pay')) {
      raw(GS, 0x21, 0x11);                   // 合计倍高宽
      text(kv('实收(' + (snap.channel || '') + ')', money(snap.payable), col));
      raw(GS, 0x21, 0x00);
    }
    if (stub) {
      text(kv('大写', rmbCapital(snap.payable), col));
      text('-'.repeat(col));
      text('收银员签字：＿＿＿＿＿＿');
      text('顾客签字：＿＿＿＿＿＿');
    }
    text('='.repeat(col));
    raw(ESC, 0x61, 1);                       // 居中脚注
    if (F('thanks')) text('谢谢惠顾 · 退换货请凭小票');
    text('****' + String(snap.orderNo || '').slice(-4) + '****');
    if (snap.regUrl) {   // V5.0.16：散客小票追加「扫码注册会员」二维码
      raw(ESC, 0x61, 1);
      text('扫码注册会员');
      qrBytes(raw, gbkBytes, String(snap.regUrl));
      raw(ESC, 0x61, 0);
    }
    raw(0x0A, 0x0A, 0x0A);
    if (optCut) raw(GS, 0x56, 0x42, 0x00);   // 走纸切刀（模版可关）
    return new Uint8Array(out);
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ═══════════ 设备与通道 ═══════════
  let printerCache, printerAt = 0, cfgCache, cfgAt = 0, printerPort = null;

  async function defaultPrinter(force) {
    if (!force && printerCache && Date.now() - printerAt < 60000) return printerCache;
    try {
      const list = await call('GET', '/printers');
      const arr = Array.isArray(list) ? list : [];
      // V4.22.0 本机绑定优先：收银设置「本机小票机」存本机 localStorage，不串台；未绑定回落后台默认机
      let mine = null;
      try {
        const lc = JSON.parse(localStorage.getItem('pwa_cashier_local') || '{}') || {};
        if (lc.printerId) mine = arr.find(p => Number(p.id) === Number(lc.printerId)) || null;
      } catch { /* 忽略 */ }
      printerCache = mine || arr.find(p => p.is_default) || null;
    } catch { printerCache = null; }
    printerAt = Date.now();
    return printerCache;
  }

  async function printCfg(force) {
    if (!force && cfgCache && Date.now() - cfgAt < 60000) return cfgCache;
    const def = { auto: '1', copies: 1, browserFb: '1' };
    try {
      const get = async k => (await call('GET', '/settings/key/' + k))?.value;
      const [a, c, fb] = await Promise.all([get('pos.print.auto'), get('pos.print.copies'), get('pos.print.browser_fallback')]);
      cfgCache = {
        auto: a === undefined ? def.auto : String(a),
        copies: Number(c) === 2 ? 2 : 1,
        browserFb: fb === undefined ? def.browserFb : String(fb) === '0' ? '0' : '1',
      };
    } catch { cfgCache = def; }
    cfgAt = Date.now();
    return cfgCache;
  }

  // ─── V4.19.0 P15.5 #9 设备埋点：打印/连接/补传/秤异常统一上报（静默，不阻断收银） ───
  async function devReport(deviceType, deviceName, eventType, severity, detail, batchKey) {
    try { await call('POST', '/device/events', { deviceType, deviceName, eventType, severity, detail, batchKey }); }
    catch { /* 离线时静默（埋点不产生待补传单据） */ }
  }

  /** 连接小票机（WebSerial，须在用户手势内调用） */
  async function connectPrinter() {
    if (!navigator.serial) throw new Error('当前浏览器不支持 WebSerial（请用电脑 Chrome/Edge）');
    printerPort = await navigator.serial.requestPort();
    await printerPort.open({ baudRate: 9600 });
    return true;
  }

  // ─── V4.18.6 USB 小票机直驱（WebUSB，免系统驱动）：claim 打印接口 + bulk OUT 直发 ESC/POS ───
  let usbDev = null, usbEp = -1;
  const USB_KEY = 'pwa_usb_printer';
  /** 打开并接管设备：优先 USB 打印类(class 7)接口，否则取首个含 bulk OUT 的接口 */
  async function usbOpen(dev) {
    await dev.open();
    if (dev.configuration == null) await dev.selectConfiguration(1);
    let picked = null;
    for (const itf of dev.configuration.interfaces) {
      const alt = (itf.alternates || []).find(a => (a.endpoints || []).some(e => e.type === 'bulk' && e.direction === 'out'));
      if (alt) { picked = { num: itf.interfaceNumber, ep: alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'out').endpointNumber }; break; }
    }
    if (!picked) { try { await dev.close(); } catch { /* noop */ } throw new Error('未找到打印接口：该设备可能被系统驱动独占，请在设备管理卸载驱动后重试，或改用网口方式'); }
    await dev.claimInterface(picked.num);
    usbDev = dev; usbEp = picked.ep;
    localStorage.setItem(USB_KEY, dev.vendorId + ':' + dev.productId);
  }
  /** 连接 USB 小票机（WebUSB，须在用户手势内调用；弹出系统设备选择器） */
  async function connectPrinterUsb() {
    if (!navigator.usb) throw new Error('当前浏览器不支持 WebUSB（请用电脑 Chrome/Edge）');
    const dev = await navigator.usb.requestDevice({ filters: [] });
    await usbOpen(dev);
    return true;
  }
  /** USB 自动重连：本源已授权设备刷新后仍可静默恢复（getDevices），自动打印无需再次手势 */
  let _reconGate = null; // VQA-D3：ops.printer_reconnect 全局总闸缓存（读失败按「开」处理）
  async function reconnectGloballyAllowed() {
    if (_reconGate != null) return _reconGate;
    try {
      const v = (await call('GET', '/settings/key/' + encodeURIComponent('ops.printer_reconnect')))?.value;
      _reconGate = !(v === false || String(v).replace(/"/g, '') === 'false' || String(v) === '关');
    } catch { _reconGate = true; }
    return _reconGate;
  }
  async function usbResume() {
    if (usbDev && usbDev.opened) return true;
    usbDev = null;
    if (!navigator.usb || !localStorage.getItem(USB_KEY)) return false;
    if (!(await reconnectGloballyAllowed())) return false; // VQA-D3：后台关了自动重连
    try {
      const key = localStorage.getItem(USB_KEY);
      const dev = (await navigator.usb.getDevices()).find(d => (d.vendorId + ':' + d.productId) === key);
      if (!dev) return false;
      await usbOpen(dev);
      return true;
    } catch { return false; }
  }
  /** USB 直发（4096 字节分块，规避部分机型 ep 缓冲上限） */
  async function usbSend(bytes) {
    for (let i = 0; i < bytes.length; i += 4096) await usbDev.transferOut(usbEp, bytes.subarray(i, i + 4096));
  }
  const usbConnected = () => !!usbDev && usbDev.opened;

  async function disconnectPrinter() {
    try { await printerPort && printerPort.close(); } catch { /* noop */ } printerPort = null;
    try { await usbDev && usbDev.close(); } catch { /* noop */ } usbDev = null; usbEp = -1;
  }
  const printerConnected = () => !!printerPort || usbConnected();

  /** 直驱打印：成功返回 {channel,printer}；无默认机/失败返回 null（调用方回落浏览器打印）
   *  V4.15.8：copies≥2 时第二联起走「存根联」版式（大写金额+签字区）；手机端禁用串口通道 */
  async function directPrint(snap, jobType, copies) {
    const p = await defaultPrinter();
    if (!p) return null;
    const tpl = await receiptTpl();
    const n = Math.max(1, Number(copies) || 1);
    const stub = n >= 2;
    const b64Of = i => bytesToB64(buildReceiptBytes(snap, p.width_mm || 80, jobType, { stub: stub && i > 0, tpl }));
    const meta = {
      bizType: 'receipt', bizId: snap && snap.bizId, bizNo: snap && snap.orderNo,
      jobType: jobType || '打印',
    };
    try {
      if (String(p.conn_type) === '网口') {
        for (let i = 0; i < n; i++) {
          await call('POST', `/printers/${p.id}/send`, { ...meta, dataBase64: b64Of(i) });
        }
        return { channel: 'network', printer: p.name };
      }
      if (String(p.conn_type) === '串口') {
        if (isMobile() || !navigator.serial) {
          toastSafe('手机端不支持串口直驱：请改用网口小票机（后台打印中心配置 IP:9100）');
          return null;
        }
        if (!printerPort) throw new Error('小票机未连接：请到「我的-设备管理」连接小票机');
        const t0 = Date.now();
        for (let i = 0; i < n; i++) {
          const w = printerPort.writable.getWriter();
          await w.write(buildReceiptBytes(snap, p.width_mm || 80, jobType, { stub: stub && i > 0, tpl })); w.releaseLock();
        }
        call('POST', `/printers/${p.id}/send`, { ...meta, dataBase64: '', costMs: Date.now() - t0 }).catch(() => { });
        return { channel: 'serial', printer: p.name };
      }
      if (String(p.conn_type) === 'USB') {
        // V4.18.7b USB + 绑定系统打印机名 → 后端 winspool RAW 直发（已装驱动机器如 POS-80，推荐）
        if (String(p.conn_addr || '').trim()) {
          const t0 = Date.now();
          for (let i = 0; i < n; i++) {
            await call('POST', `/printers/${p.id}/send`, { ...meta, dataBase64: b64Of(i) });
          }
          return { channel: 'os', printer: p.name };
        }
        // V4.18.6 USB 直驱：WebUSB bulk OUT 直发（未装驱动机器/安卓 Chrome）
        if (!navigator.usb) { toastSafe('当前浏览器不支持 WebUSB：请用电脑 Chrome/Edge，或到设备管理绑定系统打印机'); return null; }
        if (!(await usbResume())) throw new Error('USB 小票机未连接：请到「我的-设备管理」连接');
        const t0 = Date.now();
        const parts = [];
        for (let i = 0; i < n; i++) parts.push(buildReceiptBytes(snap, p.width_mm || 80, jobType, { stub: stub && i > 0, tpl }));
        for (const b of parts) await usbSend(b);
        call('POST', `/printers/${p.id}/send`, { ...meta, dataBase64: '', bytes: parts.reduce((s, b) => s + b.length, 0), costMs: Date.now() - t0 }).catch(() => { });
        return { channel: 'usb', printer: p.name };
      }
      toastSafe(`默认机连接方式为「${p.conn_type}」，暂不支持指令直驱`);
      devReport('printer', p.name, 'connect_fail', 'warn', { channel: p.conn_type, msg: '通道不支持直驱' });
    } catch (e) {
      toastSafe('直驱打印失败：' + (e.message || e));
      devReport('printer', p && p.name, 'print_fail', 'warn',
        { channel: p && p.conn_type, msg: String(e && e.message || e).slice(0, 120) },
        'prn:' + new Date().toISOString().slice(0, 13));   // 同小时去重，防缺纸风暴
    }
    return null;
  }

  /** 收银结账自动打印（checkout 调用）：pos.print.auto 总开关 → 直驱（2 联=顾客联+存根联）
   *  V4.19.0 静默策略：已配置默认小票机时直驱失败/不可达 → 不再回落浏览器打印（杜绝结账弹打印预览），
   *  明示未出票+埋点留痕，可「补打上一单」重试；未配置默认机时按 pos.print.browser_fallback 决定 */
  async function autoPrint(snap) {
    const cfg = await printCfg();
    if (cfg.auto === '0') return false;
    if (!snap || !snap.orderNo) return false;
    const p = await defaultPrinter();
    if (!p) {
      if (cfg.browserFb === '0') {
        toastSafe('小票未打印：未配置默认小票机（设备管理/打印中心设置后可静默直出）');
        return false;
      }
      return window.PwaReceipt ? window.PwaReceipt.printReceipt(snap, false) : false;
    }
    const r = await directPrint(snap, '打印', cfg.copies);
    if (r) { toastSafe(`小票已打印（${r.printer} · ${({ network: '网口', serial: '串口', usb: 'USB', os: '系统驱动' })[r.channel] || r.channel}直驱）`); return true; }
    toastSafe(`⚠ 小票机「${p.name}」未出票：检查电源/缺纸/连接后可补打（已留痕）`);
    return false;
  }

  /** 补打（强制直驱优先，重打标识留痕） */
  async function reprint(snap) {
    if (!snap || !snap.orderNo) return false;
    const r = await directPrint(snap, '重打', 1);
    if (r) { toastSafe(`已补打（${r.printer}，留痕标「重打」）`); return true; }
    return window.PwaReceipt ? window.PwaReceipt.printReceipt(snap, false) : false;
  }

  /** 测试直驱通道（设备管理用）：打一张测试小票，不经浏览器兜底 */
  async function testDirect() {
    const snap = {
      orderNo: 'TEST-' + String(Date.now()).slice(-6), payable: 8, roundAmount: 0, time: new Date(),
      lines: [{ name: '测试商品A', qty: 1, price: 1 }, { name: '测试商品B', qty: 2, price: 3.5 }],
      channel: '测试', member: null,
    };
    const r = await directPrint(snap, '测试页', 1);
    if (!r) throw new Error('直驱不可用：检查默认机连接方式（网口地址 / 串口或USB是否已连接）');
    return r;
  }

  /** 弹箱（V4.15.8 网口 / V4.18.6 USB）：ESC p 弹箱指令经默认小票机转发（RJ11 接钱箱） */
  async function kickDrawer() {
    const p = await defaultPrinter(true);
    if (!p) throw new Error('未配置默认小票机：请在后台「打印中心」设置');
    const bytes = new Uint8Array([0x1B, 0x40, 0x1B, 0x70, 0x00, 0x19, 0xFA]);
    if (String(p.conn_type) === '网口') {
      await call('POST', `/printers/${p.id}/send`, { bizType: 'receipt', jobType: '弹箱', dataBase64: bytesToB64(bytes) });
      return { printer: p.name, channel: 'network' };
    }
    if (String(p.conn_type) === 'USB') {
      // V4.18.7b 绑定系统打印机 → 后端 RAW 弹箱
      if (String(p.conn_addr || '').trim()) {
        await call('POST', `/printers/${p.id}/send`, { bizType: 'receipt', jobType: '弹箱', dataBase64: bytesToB64(bytes) });
        return { printer: p.name, channel: 'os' };
      }
      if (!(await usbResume())) throw new Error('USB 小票机未连接：请到「我的-设备管理」连接');
      await usbSend(bytes);
      call('POST', `/printers/${p.id}/send`, { bizType: 'receipt', jobType: '弹箱', dataBase64: '', bytes: bytes.length }).catch(() => { });
      return { printer: p.name, channel: 'usb' };
    }
    throw new Error('弹箱需默认机为网口/USB 小票机（钱箱 RJ11 接在打印机上）；当前为「' + p.conn_type + '」');
  }

  function toastSafe(msg) { try { window.toast && toast(msg, false); } catch { /* noop */ } }

  window.PwaPrinters = {
    autoPrint, reprint, testDirect, connectPrinter, connectPrinterUsb, disconnectPrinter,
    printerConnected, usbConnected, usbResume, defaultPrinter, printCfg, buildReceiptBytes, kickDrawer, receiptTpl, devReport,
    autoEnabled: async () => (await printCfg()).auto !== '0',
  };
  // V4.19.0：设备埋点统一出口（printers 直驱层已内接；补传/秤离线等从 app.js/scale.js 调 PwaDevices.report）
  window.PwaDevices = { report: devReport };
})();
