/**
 * 凯士（CAS）条码秤 PLU 下发协议（简化版）
 * 适用：CAS CL-3000/CL-5000 系列等
 * 帧格式：
 *   STX 'C' {PLU5} {商品码7} {单价5} {名称16} {单位1} ETX LRC\r\n
 * 说明：名称定长 16 字节；中文按 GBK 下发时每字 2 字节，不足补空格、超长按字边界裁剪
 */
import { pad, priceCentsStr, pluOf, nameField, padBytes, concatBytes, CRLF } from './utils.js';

function unitFlag(item) {
  const u = String(item.base_unit || '').toLowerCase();
  if (u === 'kg' || u === '克' || u === 'g' || u === '斤') return '0';
  return '1';
}

export default {
  key: 'cas',
  name: '凯士 CAS',
  brand: 'CAS',
  desc: '凯士 CL-3000/CL-5000 系列条码秤（文本兼容帧）',
  defaultBaud: 9600,
  defaultDataBits: 8,
  defaultParity: 'none',
  defaultStopBits: 1,

  encodePlu(item, cfg = {}, opts = {}) {
    const plu = pluOf(item, 5);
    const code = String(item.barcode || item.goods_no || plu).replace(/\D/g, '').slice(-7).padStart(7, '0');
    const price = priceCentsStr(item.sell_price, 5);
    const name = padBytes(nameField(item, cfg, 16, opts), 16);
    const body = concatBytes('C', plu, code, price, name, unitFlag(item));
    let lrc = 0;
    for (const b of body) lrc ^= b;
    const frame = concatBytes(
      new Uint8Array([0x02]),
      body,
      new Uint8Array([0x03, lrc]),
      CRLF,
    );
    return { bytes: frame, preview: `CAS PLU=${plu} code=${code}` };
  },

  encodeBatch(items, cfg = {}, opts = {}) {
    const parts = [];
    for (const it of items) {
      const { bytes } = this.encodePlu(it, cfg, opts);
      parts.push(bytes);
    }
    const bytes = concatBytes(...parts);
    return { bytes, count: items.length, preview: `CAS 帧 ×${items.length}` };
  },

  parseResponse(bytes) {
    const text = String.fromCharCode(...bytes);
    return { ok: /\x06/.test(text) || text.includes('OK'), raw: text };
  },
};
