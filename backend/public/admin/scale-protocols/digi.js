/**
 * 寺冈 DIGI SM-300 条码秤 PLU 下发协议（简化文本模式）
 * 适用：寺冈 DIGI SM-300/SM-90/SM-120 系列
 * 帧格式：
 *   STX '01' {PLU6} {单价6} {名称12} {条码13} {有效期3} {皮重5} ETX BCC\r\n
 * 说明：
 *   - SM-300 原生协议为二进制+BCC；此处提供常见 PC 软件兼容文本简化帧
 *   - 名称定长 12 字节：中文按 GBK 下发时每字 2 字节，不足补空格、超长按字边界裁剪
 */
import { pad, priceCentsStr, pluOf, nameField, padBytes, concatBytes, CRLF } from './utils.js';

export default {
  key: 'digi',
  name: '寺冈 DIGI',
  brand: 'DIGI',
  desc: '寺冈 DIGI SM-300/SM-90 系列条码秤（文本兼容帧），串口 9600,8,N,1',
  defaultBaud: 9600,
  defaultDataBits: 8,
  defaultParity: 'none',
  defaultStopBits: 1,

  encodePlu(item, cfg = {}, opts = {}) {
    const plu = pluOf(item, 6);
    const code = String(item.barcode || item.goods_no || plu).replace(/\D/g, '').slice(-13).padStart(13, '0');
    const name = padBytes(nameField(item, cfg, 12, opts), 12);
    const price = priceCentsStr(item.sell_price, 6);
    const body = concatBytes('01', plu, price, name, code, pad(item.keep_days || 0, 3), '00000');
    // BCC：从 STX 后到 ETX 前所有字节异或
    let bcc = 0;
    for (const b of body) bcc ^= b;
    const frame = concatBytes(
      new Uint8Array([0x02]),
      body,
      new Uint8Array([0x03, bcc]),
      CRLF,
    );
    return { bytes: frame, preview: `DIGI PLU=${plu} price=${price}` };
  },

  encodeBatch(items, cfg = {}, opts = {}) {
    const parts = [];
    for (const it of items) {
      const { bytes } = this.encodePlu(it, cfg, opts);
      parts.push(bytes);
    }
    const bytes = concatBytes(...parts);
    return { bytes, count: items.length, preview: `DIGI 帧 ×${items.length}` };
  },

  parseResponse(bytes) {
    const text = String.fromCharCode(...bytes);
    return { ok: /\x06/.test(text) || text.includes('OK'), raw: text };
  },
};
