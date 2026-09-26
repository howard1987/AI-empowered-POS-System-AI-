/**
 * 托利多（Mettler-Toledo）条码秤 PLU 下发协议（简化文本模式）
 * 适用：bPro / bCom 系列
 * 帧格式：
 *   <PLU {PLU6};NAME={名称};PRICE={单价};BARCODE={条码};UNIT=KG;>
 * 说明：托利多 PC 软件常见文本指令，具体以 Scale Manager 配置为准
 *       名称字段走 nameField()，支持中文下发（charset=gbk/gb2312）
 */
import { pluOf, nameField, shortNameOf, concatBytes, CRLF } from './utils.js';

export default {
  key: 'mettler',
  name: '托利多',
  brand: 'Mettler-Toledo',
  desc: '托利多 bPro/bCom 系列（文本兼容帧），串口 9600,8,N,1 或网口',
  defaultBaud: 9600,
  defaultDataBits: 8,
  defaultParity: 'none',
  defaultStopBits: 1,

  encodePlu(item, cfg = {}, opts = {}) {
    const plu = pluOf(item, 6);
    const code = String(item.barcode || item.goods_no || plu).replace(/\D/g, '').slice(-13).padStart(13, '0');
    const price = Math.round(Number(item.sell_price || 0) * 100).toString().padStart(6, '0');
    const bytes = concatBytes(
      '<PLU ', plu,
      ';NAME=', nameField(item, cfg, 12, opts),
      ';PRICE=', price,
      ';BARCODE=', code,
      ';UNIT=KG;>',
      CRLF,
    );
    return { bytes, preview: `<PLU ${plu};NAME=${shortNameOf(item, 12)};PRICE=${price};BARCODE=${code};UNIT=KG;>` };
  },

  encodeBatch(items, cfg = {}, opts = {}) {
    const parts = [];
    for (const it of items) {
      const { bytes } = this.encodePlu(it, cfg, opts);
      parts.push(bytes);
    }
    const bytes = concatBytes(...parts);
    return { bytes, count: items.length, preview: `托利多帧 ×${items.length}` };
  },

  parseResponse(bytes) {
    const text = String.fromCharCode(...bytes);
    return { ok: text.includes('OK') || text.includes('ok'), raw: text };
  },
};
