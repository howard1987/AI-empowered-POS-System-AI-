/**
 * 传秤协议工具函数
 * - 数字字段一律 ASCII；名称字段统一走 nameField()
 * - V4.26.1 起支持中文化秤名：cfg.charset = gbk/gb2312 时，由后端 iconv-lite 编码为 GBK 字节，
 *   经 opts.nameBytes 注入帧内，并按双字节边界裁剪，保证不截断汉字
 */

/** 左补零 */
export function pad(num, len) {
  const s = String(Math.abs(Number(num) || 0)).replace(/\D/g, '');
  return s.padStart(len, '0').slice(-len);
}

/** 价格元 → 分 */
export function toFen(yuan) {
  return Math.round(Number(yuan || 0) * 100);
}

/** 价格元 → 千分位（部分协议需要 5 位分/kg） */
export function priceCentsStr(yuan, len = 5) {
  return pad(toFen(yuan), len);
}

/** ASCII 字符串转 Uint8Array */
export function asciiBytes(str) {
  const s = String(str || '').replace(/[^\x00-\x7F]/g, '?');
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xFF;
  return arr;
}

/** 合并多个 Uint8Array/字符串 */
export function concatBytes(...parts) {
  const arrays = parts.map(p => {
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'string') return asciiBytes(p);
    return asciiBytes(String(p));
  });
  const total = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

export const CRLF = new Uint8Array([0x0D, 0x0A]);

/** 取秤内码：优先 scale_plu_code，其次 barcode 后 N 位，最后 goods_no */
export function pluOf(item, len = 4) {
  const code = String(item.scale_plu_code || item.barcode || item.goods_no || item.id).replace(/\D/g, '');
  return pad(code, len);
}

/** 取商品简称：优先 short_name，再 name（截断为 ASCII） */
export function shortNameOf(item, maxLen = 20) {
  const s = String(item.short_name || item.name || '').replace(/[^\x00-\x7F]/g, '?');
  return s.slice(0, maxLen).trim() || ('PLU' + pluOf(item, 4));
}

/** 按 GBK 双字节边界安全裁剪：保证不截断半个汉字 */
export function trimBytesGbk(bytes, maxLen) {
  if (!(bytes instanceof Uint8Array)) return new Uint8Array(0);
  let i = 0;
  while (i < bytes.length) {
    const w = (bytes[i] >= 0x81 && bytes[i] <= 0xFE) ? 2 : 1;  // GBK 汉字占 2 字节
    if (i + w > maxLen) break;
    i += w;
  }
  const out = new Uint8Array(i);
  out.set(bytes.subarray(0, i));
  return out;
}

/**
 * 名称字段（V4.26.1 支持中文）
 * - cfg.charset = gbk/gb2312 且传入 opts.nameBytes（后端 iconv-lite 编码好的字节）→ 直接下发中文
 * - 否则回落 ASCII 简称（老秤/无中文库场景）
 */
export function nameField(item, cfg = {}, maxLen = 20, opts = {}) {
  const charset = String(cfg.charset || 'ascii').toLowerCase();
  if ((charset === 'gbk' || charset === 'gb2312') && opts.nameBytes) {
    return trimBytesGbk(opts.nameBytes, maxLen);
  }
  return shortNameOf(item, maxLen);
}

/** 定长名称字段：右侧补空格到 len 字节（供寺冈/凯士等定长帧使用） */
export function padBytes(val, len) {
  const b = (val instanceof Uint8Array) ? val : asciiBytes(String(val ?? ''));
  const out = new Uint8Array(len);
  out.fill(0x20);
  out.set(b.subarray(0, Math.min(b.length, len)));
  return out;
}

/** 计算简单累加和校验（用于部分协议兜底） */
export function sumChecksum(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xFF;
  return s.toString(16).toUpperCase().padStart(2, '0');
}

/** 16 进制预览 */
export function hexPreview(bytes, max = 48) {
  const a = bytes.slice(0, max);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
}
