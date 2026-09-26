/**
 * Web Serial API 封装（前端条码秤直发）
 * - 必须在安全上下文（HTTPS/localhost）+ Chrome/Edge 中使用
 * - requestPort 必须用户手势触发
 */

export class ScaleSerial {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this._closed = true;
    this._buf = '';
  }

  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  /** 取已授权（用户曾在本站授予过）的串口列表，用于「自动判断串口号」避免每次弹选择器 */
  static async getGrantedPorts() {
    if (!ScaleSerial.supported()) return [];
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  /** 用户选择串口并打开（opts.port 可传入已授权的 SerialPort，跳过弹窗） */
  async connect(opts = {}) {
    if (!ScaleSerial.supported()) {
      throw new Error('当前浏览器不支持 Web Serial：请用 Chrome/Edge 打开本页（localhost 或 HTTPS），或改用「导出 CSV」方式');
    }
    this.port = opts.port || await navigator.serial.requestPort();
    await this.port.open({
      baudRate: opts.baudRate || 9600,
      dataBits: opts.dataBits || 8,
      stopBits: opts.stopBits || 1,
      parity: opts.parity || 'none',
      flowControl: opts.flowControl || 'none',
    });
    this._closed = false;
    this._buf = '';
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    return { ok: true };
  }

  async disconnect() {
    this._closed = true;
    try { if (this.reader) await this.reader.cancel(); } catch { /* noop */ }
    try { if (this.writer) await this.writer.releaseLock(); } catch { /* noop */ }
    try { if (this.port) await this.port.close(); } catch { /* noop */ }
    this.reader = null;
    this.writer = null;
    this.port = null;
  }

  /** 写原始 Uint8Array */
  async write(bytes) {
    if (!this.writer) throw new Error('串口未打开');
    await this.writer.write(bytes);
  }

  /** 写文本 */
  async writeText(text) {
    const enc = new TextEncoder();
    await this.write(enc.encode(text));
  }

  /** 读取所有可用数据直到 timeoutMs 或匹配到 pattern */
  async read(timeoutMs = 2000, pattern = null) {
    if (!this.reader) throw new Error('串口未打开');
    const dec = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let acc = new Uint8Array(0);
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const { value, done } = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), remaining)),
      ]);
      if (done) break;
      const next = new Uint8Array(acc.length + value.length);
      next.set(acc);
      next.set(value, acc.length);
      acc = next;
      const text = dec.decode(acc);
      if (pattern && pattern.test(text)) break;
    }
    return acc;
  }

  /** 发送一帧并等待回应 */
  async sendAndWait(bytes, waitMs = 500) {
    await this.write(bytes);
    return this.read(waitMs);
  }
}
