'use strict';
/* 员工移动端 PWA · 串口电子秤读重（scale.js，方案 v3.2 M3 · Web Serial）
 * 适用：Chrome/Edge 安卓或桌面（HTTPS/localhost 安全上下文），OTG/USB 串口电子秤（大华/顶尖等）。
 * 协议：商用电子秤连续发送帧（默认 9600,8N1），自动解析常见格式：
 *   大华/顶尖连续帧：ST,GS,+  1.234kg / US,GS,  0.123 kg（ST=稳定 US=不稳定）
 *   通用数字帧：     +  1.234 kg / 1234 g / 1,234
 * 用法：
 *   await Scale.connect()          —— 用户手势内调用（requestPort 必须手势触发）
 *   const kg = await Scale.weight(8000)   —— 取最近一次稳定读数（超时返回 null）
 */
const Scale = {
  port: null, reader: null,
  last: { kg: null, stable: false, at: 0, raw: '' },
  _buf: '', _closed: false, _waiters: [],

  supported() { return typeof navigator !== 'undefined' && !!navigator.serial; },

  /** 连接电子秤（必须在用户点击等手势内调用）；波特率默认取后台设置 scale.baud（9600） */
  async connect() {
    if (!this.supported()) throw new Error('当前浏览器不支持 Web Serial：请用 Chrome/Edge 打开本页（HTTPS），或手动输入重量');
    let baud = 9600;
    try {
      const st = unwrap(await call('GET', '/settings'));
      const list = Array.isArray(st) ? st : (st.items || []);
      // VQA-D3：scale.enabled 自动读重总开关（此前死键；关=秤连接入口禁用，手输/扫秤码不受影响）
      const en = list.find(s => s.setting_key === 'scale.enabled');
      if (en && (en.value === false || String(en.value).replace(/"/g, '') === 'false' || String(en.value) === '关'))
        throw new Error('电子秤自动读重已在后台关闭（通用设置 → 电子秤自动读重），可手动输入重量或扫秤码');
      const row = list.find(s => s.setting_key === 'scale.baud');
      if (row && Number(row.value) > 0) baud = Number(row.value);
    } catch (e) {
      if (e && /后台关闭/.test(String(e.message || ''))) throw e; // 总开关拒绝直传
      /* 离线用默认 9600 */
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none' });
    this._closed = false;
    this._pump();
    return { baud };
  },

  disconnect() {
    this._closed = true;
    this._resolveWaiters(null);
    try { this.reader && this.reader.cancel(); } catch { /* 已关闭 */ }
    try { this.port && this.port.close(); } catch { /* 已关闭 */ }
    this.port = null; this.reader = null;
  },

  connected() { return !!this.port && !this._closed; },

  /** 取一次稳定读数：已有新鲜稳定值直接返回；否则等待最多 timeoutMs（超时 null） */
  weight(timeoutMs = 8000) {
    if (this.last.stable && this.last.kg != null && Date.now() - this.last.at < 1500) {
      return Promise.resolve(this.last.kg);
    }
    return new Promise(res => {
      const w = { res, timer: setTimeout(() => this._drop(w, null), timeoutMs) };
      this._waiters.push(w);
    });
  },

  _drop(w, val) { clearTimeout(w.timer); this._waiters = this._waiters.filter(x => x !== w); w.res(val); },
  _resolveWaiters(val) { const ws = this._waiters; this._waiters = []; ws.forEach(w => clearTimeout(w.timer)); ws.forEach(w => w.res(val)); },

  async _pump() {
    const dec = new TextDecoder();
    try {
      while (this.port && this.port.readable && !this._closed) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            this._buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = this._buf.search(/[\r\n]/)) >= 0) {
              const line = this._buf.slice(0, nl);
              this._buf = this._buf.slice(nl + 1);
              this._onLine(line);
            }
            if (this._buf.length > 256) this._buf = '';   // 防无换行垃圾流积压
          }
        } finally { try { this.reader.releaseLock(); } catch { /* 忽略 */ } }
      }
    } catch { /* 拔线/取消 → 结束读循环 */ }
    if (!this._closed && this.port) {
      // V4.19.0 P15.5 #9：秤离线埋点（warn 推老板端消息中心）
      try { if (window.PwaDevices) window.PwaDevices.report('scale', '电子秤', 'scale_offline', 'warn', { msg: '串口读循环中断（拔线/异常）' }); } catch { /* noop */ }
      try { if (window.CsMsg) window.CsMsg('电子秤离线：称重不可用，可手输重量', 'warn'); } catch { /* noop */ }
    }
    this._closed = true;
    this._resolveWaiters(null);
  },

  _onLine(line) {
    const w = Scale._parse(line);
    if (!w) return;
    this.last = { kg: w.kg, stable: w.stable, at: Date.now(), raw: line };
    if (w.stable && w.kg != null) this._resolveWaiters(w.kg);
  },

  /** 单行 → {kg, stable}；解析失败返回 null */
  _parse(line) {
    const s = String(line || '').trim();
    if (!s) return null;
    // 状态前缀：ST=稳定，US/OL/…=不稳定；无前缀按稳定处理
    let stable = true;
    if (/^(ST|OK)[\s,]/i.test(s)) stable = true;
    else if (/^(US|OL|UNSTABLE)[\s,]/i.test(s)) stable = false;
    // 数字 + 可选单位（kg/g），兼容千分位逗号与符号间空格：ST,GS,+  1.234kg
    const m = s.match(/([+-]?)\s*(\d{1,6}(?:[.,]\d{1,4})?)\s*(kg|g|Kg|KG|G|Kg)?\s*$/i);
    if (!m) return null;
    let kg = parseFloat(m[2].replace(',', '.'));
    if (!isFinite(kg) || kg < 0 || kg > 1000) return null;
    if ((m[3] || '').toLowerCase() === 'g' || (!m[3] && kg >= 100000)) kg = kg / 1000;   // 无单位大数按克兜底
    return { kg: Math.round(kg * 1000) / 1000, stable };
  },
};
window.Scale = Scale;   // 调试/CDP 访问
