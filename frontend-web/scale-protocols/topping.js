/**
 * 顶尖（Topping）条码秤 PLU 下发协议（简化版）
 * 适用：顶尖 LS2/LS3/LS6 系列及兼容机型
 * 帧格式（文本模式）：
 *   !1W{PLU4}A{商品代码7}B{单价(分/kg)5}C{单位1}D{有效期3}E{皮重5}F{信息1}G{商品名}\r\n
 * 说明：名称字段走 nameField()，支持中文下发（charset=gbk/gb2312）
 */
import { pad, priceCentsStr, pluOf, nameField, concatBytes, CRLF } from './utils.js';

function unitFlag(item) {
  const u = String(item.base_unit || '').toLowerCase();
  if (u === 'kg' || u === '克' || u === 'g' || u === '斤' || u === '500g') return '0';
  return '1';
}

export default {
  key: 'topping',
  name: '顶尖',
  brand: 'Topping',
  desc: '顶尖 LS2/LS3/LS6 系列条码秤，串口 9600,8,N,1',
  defaultBaud: 9600,
  defaultDataBits: 8,
  defaultParity: 'none',
  defaultStopBits: 1,

  encodePlu(item, cfg = {}, opts = {}) {
    const code = String(item.barcode || item.goods_no || pluOf(item, 7)).replace(/\D/g, '').slice(-7).padStart(7, '0');
    const frame = concatBytes(
      '!1W',
      pluOf(item, 4),
      'A', code,
      'B', priceCentsStr(item.sell_price, 5),
      'C', unitFlag(item),
      'D', pad(item.keep_days || 0, 3),
      'E', '00000',
      'F', '0',
      'G', nameField(item, cfg, 20, opts),
      CRLF,
    );
    return { bytes: frame, preview: `!1W ${pluOf(item, 4)} ${code}` };
  },

  encodeBatch(items, cfg = {}, opts = {}) {
    const parts = [];
    for (const it of items) {
      const { bytes } = this.encodePlu(it, cfg, opts);
      parts.push(bytes);
    }
    const bytes = concatBytes(...parts);
    return { bytes, count: items.length, preview: `顶尖帧 ×${items.length}` };
  },

  parseResponse(bytes) {
    const text = String.fromCharCode(...bytes);
    return { ok: /!1w\d{4}[a-z]/i.test(text), raw: text };
  },
};
