/**
 * 大华（Dahua）条码秤 PLU 下发协议（简化版）
 * 适用：大华 TM-A / TM-F / SY 系列及兼容机型（友声/顺展等）
 * 帧格式（文本模式）：
 *   !0W{PLU4}A{商品代码7}B{单价(分/kg)5}C{单位1}D{有效期3}E{皮重5}F{信息1}G{商品名}\r\n
 * 说明：
 *   - 不同型号字段长度/分隔符可能略有差异，本实现覆盖常见默认格式
 *   - 名称字段走 nameField()：charset=gbk/gb2312 时下发中文，否则回落 ASCII 简称
 */
import { pad, priceCentsStr, pluOf, nameField, concatBytes, CRLF } from './utils.js';

function unitFlag(item) {
  const u = String(item.base_unit || '').toLowerCase();
  // 0=称重 1=计件 2=定重
  if (u === 'kg' || u === '克' || u === 'g' || u === '斤' || u === '500g') return '0';
  return '1';
}

export default {
  key: 'dahua',
  name: '大华',
  brand: 'Dahua',
  desc: '大华 TM-A/TM-F 条码秤及兼容机型（友声/顺展等），串口 9600,8,N,1',
  defaultBaud: 9600,
  defaultDataBits: 8,
  defaultParity: 'none',
  defaultStopBits: 1,

  encodePlu(item, cfg = {}, opts = {}) {
    const code = String(item.barcode || item.goods_no || pluOf(item, 7)).replace(/\D/g, '').slice(-7).padStart(7, '0');
    const frame = concatBytes(
      '!0W',
      pluOf(item, 4),
      'A', code,
      'B', priceCentsStr(item.sell_price, 5),
      'C', unitFlag(item),
      'D', pad(item.keep_days || 0, 3),
      'E', '00000',    // 皮重(g)，默认 0
      'F', '0',       // 特殊信息号
      'G', nameField(item, cfg, 20, opts),
      CRLF,
    );
    return { bytes: frame, preview: `!0W ${pluOf(item, 4)} ${code}` };
  },

  encodeBatch(items, cfg = {}, opts = {}) {
    const parts = [];
    for (const it of items) {
      const { bytes } = this.encodePlu(it, cfg, opts);
      parts.push(bytes);
    }
    const bytes = concatBytes(...parts);
    return { bytes, count: items.length, preview: `大华帧 ×${items.length}` };
  },

  /** 大华常见回应：!0w{PLU4}a... ，解析是否成功 */
  parseResponse(bytes) {
    const text = String.fromCharCode(...bytes);
    return { ok: /!0w\d{4}[a-z]/i.test(text), raw: text };
  },
};
