/**
 * 通用/测试协议
 * - 通过串口/网口发送 CSV 行，便于调试或对接支持文本导入的秤
 * - 无真实秤时可选「模拟模式」，只向控制台打印帧
 * 说明：名称字段走 nameField()，支持中文下发（charset=gbk/gb2312）
 */
import { pluOf, nameField, shortNameOf, asciiBytes, concatBytes, CRLF } from './utils.js';

function csvParts(item, cfg = {}, opts = {}) {
  const plu = pluOf(item, 5);
  const code = String(item.barcode || item.goods_no || plu).replace(/[^\d]/g, '').slice(-13).padStart(13, '0');
  const price = Number(item.sell_price || 0).toFixed(2);
  const member = Number(item.member_price || item.sell_price || 0).toFixed(2);
  const dept = cfg.department || item.scale_department || '01';
  const prefix = cfg.barcodePrefix || '22';
  const bytes = concatBytes(prefix, ',', plu, ',', code, ',', nameField(item, cfg, 20, opts), ',', price, ',', member, ',', dept);
  const preview = `${prefix},${plu},${code},${shortNameOf(item, 20).replace(/,/g, ' ')},${price},${member},${dept}`;
  return { bytes, preview };
}

export default {
  key: 'generic',
  name: '通用/测试',
  brand: 'Generic',
  desc: '通用 CSV 帧（调试/模拟/文本导入），不依赖具体品牌协议',
  defaultBaud: 9600,
  defaultDataBits: 8,
  defaultParity: 'none',
  defaultStopBits: 1,

  encodePlu(item, cfg = {}, opts = {}) {
    const { bytes, preview } = csvParts(item, cfg, opts);
    return { bytes: concatBytes(bytes, CRLF), preview };
  },

  encodeBatch(items, cfg = {}, opts = {}) {
    const parts = [asciiBytes('prefix,plu,barcode,name,price,member,dept')];
    for (const it of items) {
      const { bytes } = csvParts(it, cfg, opts);
      parts.push(CRLF, bytes);
    }
    parts.push(CRLF);
    const bytes = concatBytes(...parts);
    return { bytes, count: items.length, preview: `CSV 帧 ×${items.length}` };
  },

  parseResponse(bytes) {
    const text = String.fromCharCode(...bytes);
    return { ok: true, raw: text };
  },
};
