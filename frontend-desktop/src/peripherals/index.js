/**
 * 外设接入层（T16，方案 9.9 / V4.6.4）—— 适配器模式：
 *   扫码枪：keyboard-wedge（HID 键盘模拟，收银输入框天然接收）与串口两种适配器
 *   电子秤：串口连续读重（AI 秤俯拍兜底见后端 9.2.7）
 *   小票机：USB（虚拟串口）/ 蓝牙（SPP 串口）/ 网口（TCP 9100）三种连接，ESC/POS 指令
 * 原生模块 serialport 为 optionalDependencies——未安装时自动降级为模拟适配器，
 * 保证 UI 与打印模板链路在任何环境可开发可测试；真机只需 npm i serialport。
 */
const net = require('net');

let SerialPort = null;
try { SerialPort = require('serialport').SerialPort; } catch { /* 降级模拟 */ }

// ─── 扫码枪 ───
class Scanner {
  constructor() { this.mode = SerialPort ? 'serial' : 'keyboard'; this.listeners = []; }
  /** keyboard 模式：渲染层 input 事件直接喂 here；serial 模式：断续读条码行 */
  feed(code) { this.listeners.forEach(fn => fn(String(code).trim())); }
  onScan(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(x => x !== fn); }; }
  describe() { return { kind: '扫码枪', mode: this.mode, ready: true }; }
}

// ─── 电子秤 ───
class Scale {
  constructor() { this.port = null; this.mock = true; this.listeners = []; }
  async open(path, baudRate = 9600) {
    if (!SerialPort) return { ok: false, reason: 'serialport 未安装（模拟模式）' };
    this.port = new SerialPort({ path, baudRate });
    this.mock = false;
    let buf = '';
    this.port.on('data', d => {
      buf += d.toString();
      const m = buf.match(/([-+]?\d+\.?\d*)\s*kg/i);
      if (m) { this.listeners.forEach(fn => fn(parseFloat(m[1]))); buf = ''; }
    });
    return { ok: true };
  }
  /** 模拟读重（无真机时 UI 开发用） */
  feedMock(kg) { if (this.mock) this.listeners.forEach(fn => fn(kg)); }
  onWeight(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(x => x !== fn); }; }
  describe() { return { kind: '电子秤', mode: this.mock ? 'mock' : 'serial', ready: true }; }
}

// ─── 小票机（ESC/POS）───
class ReceiptPrinter {
  constructor() { this.conn = null; } // { type: 'net'|'serial', handle }
  describe() {
    return { kind: '小票机', modes: ['usb(虚拟串口)', 'bluetooth(SPP)', 'net(9100)'],
             connected: !!this.conn, serialport: !!SerialPort };
  }
  /** 网口连接：TCP 9100 直发（三种连接方式共用的指令层） */
  connectNet(host, port = 9100) {
    return new Promise((resolve) => {
      const s = net.createConnection({ host, port }, () => { this.conn = { type: 'net', handle: s }; resolve({ ok: true }); });
      s.on('error', e => resolve({ ok: false, reason: e.message }));
    });
  }
  /** USB/蓝牙：串口路径连接 */
  connectSerial(path, baudRate = 9600) {
    if (!SerialPort) return Promise.resolve({ ok: false, reason: 'serialport 未安装' });
    return new Promise((resolve) => {
      const s = new SerialPort({ path, baudRate }, e => {
        if (e) resolve({ ok: false, reason: e.message });
        else { this.conn = { type: 'serial', handle: s }; resolve({ ok: true }); }
      });
    });
  }
  /** 发送文本小票（ESC/POS：初始化 + 文本 + 走纸切刀） */
  async print(text) {
    if (!this.conn) return { ok: false, reason: '小票机未连接' };
    const esc = Buffer.concat([
      Buffer.from([0x1b, 0x40]),                    // ESC @ 初始化
      Buffer.from(text, 'gbk'),                      // 中文编码 GBK（多数热敏机）
      Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]), // 走纸 + 切刀
    ]);
    if (this.conn.type === 'net') this.conn.handle.write(esc);
    else this.conn.handle.write(esc);
    return { ok: true, bytes: esc.length };
  }
  disconnect() { if (this.conn) { try { this.conn.handle.destroy(); } catch { /* noop */ } this.conn = null; } }
}

module.exports = { Scanner, Scale, ReceiptPrinter, hasSerial: !!SerialPort };
