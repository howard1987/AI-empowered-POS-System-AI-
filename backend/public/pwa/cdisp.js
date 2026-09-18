/* 串口客显（杆屏/VFD/LCD）原生适配器 · V4.22.0 P16 批3
 * 通道：WebSerial（桌面 Chrome/Edge 与 EXE 内置，须在点击手势内连接）；EXE 已放行 serial 权限。
 * 协议档案：
 *   esc   — ESC/POS 通用双行客显（晶彩/迅宝/佳维佳等主流 LCD 杆屏）：init=ESC@，整屏重写两行
 *   cd522 — CD5220/VFD 类（PD-300/LTN-300 等）：ESC Q A / ESC Q B 写第 1/2 行
 *   txt   — 纯文本镜像（\r 分行，调试/串口屏）
 * 中文编码：浏览器无 GBK 编码器 → POST /display/gbk 服务端 iconv 代编（结果缓存）；离线回落 ASCII 数字。
 * 与 SSE 副屏（/display 页）并行不悖：副屏断了，杆屏照常走串口。
 */
window.CDisp = (function () {
  let port = null, writer = null, prof = 'esc', baud = 9600;
  const gbkCache = new Map();   // text -> base64 | null(失败)

  const supported = () => !!navigator.serial;

  async function encB64(texts) {
    const miss = [...new Set(texts)].filter(t => !gbkCache.has(t));
    if (miss.length) {
      try {
        const r = await fetch('/display/gbk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: miss }),
        });
        const d = await r.json();
        (d.items || []).forEach((b64, i) => gbkCache.set(miss[i], b64));
      } catch { miss.forEach(t => gbkCache.set(t, null)); }   // 失败也缓存（ASCII 回落），避免每次打后端
    }
    return texts.map(t => gbkCache.get(t));
  }

  /** 单行文本 → GBK 字节数组（无缓存命中时回落 ASCII：数字价格仍可显示） */
  function lineBytes(b64, text) {
    if (b64) {
      const bin = atob(b64), out = [];
      for (let j = 0; j < bin.length; j++) out.push(bin.charCodeAt(j));
      return out;
    }
    const out = [];
    for (const ch of String(text || '')) { const c = ch.charCodeAt(0); if (c < 128) out.push(c); }
    return out;
  }

  /** 按协议档案组帧：两行（超出 20 列截断由文本层保证） */
  function frame(l1, l2, b1, b2) {
    const W = 20;
    const cut = s => String(s || '').slice(0, W);
    const out = [];
    if (prof === 'cd522') {
      out.push(0x1b, 0x40);                 // init
      out.push(0x1b, 0x51, 0x41);           // ESC Q A → line1
      out.push(...lineBytes(b1, cut(l1)), 0x0d);
      out.push(0x1b, 0x51, 0x42);           // ESC Q B → line2
      out.push(...lineBytes(b2, cut(l2)), 0x0d);
    } else if (prof === 'txt') {
      out.push(...lineBytes(b1, cut(l1)), 0x0d);
      out.push(...lineBytes(b2, cut(l2)), 0x0d);
    } else {                                // esc：ESC@ 清屏整写
      out.push(0x1b, 0x40);
      out.push(...lineBytes(b1, cut(l1)), 0x0d, 0x0a);
      out.push(...lineBytes(b2, cut(l2)));
    }
    return out;
  }

  /** 展示两行（自动按协议组帧 + GBK）；失败静默返回 false（不打断收银） */
  async function show(l1, l2) {
    if (!writer) return false;
    try {
      const a = String(l1 || '').slice(0, 40), b = String(l2 || '').slice(0, 40);
      const [b1, b2] = await encB64([a, b]);
      const bytes = new Uint8Array(frame(a, b, b1, b2));
      await writer.write(bytes);
      return true;
    } catch { return false; }
  }

  /** 连接（须在按钮点击手势内调用 requestPort） */
  async function connect(profile, baudRate) {
    if (!supported()) throw new Error('当前环境不支持 WebSerial（EXE/电脑 Chrome/Edge 可用）');
    prof = profile || 'esc'; baud = Number(baudRate) || 9600;
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: baud });
    writer = port.writable.getWriter();
    await show('已连接', 'POS 客显');
    return true;
  }
  async function disconnect() {
    try { writer && (await writer.close()); } catch { /* noop */ }
    try { port && (await port.close()); } catch { /* noop */ }
    writer = null; port = null;
  }
  const connected = () => !!writer;

  return { supported, connected, connect, disconnect, show };
})();
