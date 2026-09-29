/**
 * 标签打印指令内核（V4.15.7 P2）：
 *   - TSPL（汉印 HPRT / 佳博 Gprinter / TSC / 通用）—— GBK 编码 + TSS24.BF2 中文字库（热敏标签机标配）
 *   - ZPL （斑马 ZEBRA）—— ^CI28 UTF-8 模式
 *   - 纸型：40x30 / 50x30 / 60x40 mm，热敏标签 8 dots/mm
 *   - 两类签：价签（品名/售价/促销价划线/条码/单位·规格·保质期）与 秤贴（品名/单价/重量/金额/条码/时间）
 *   - 输出字节由 device.module /printers/:id/labels 走网口直发，或返回 base64 由浏览器 WebSerial 串口发送
 */
import * as iconv from 'iconv-lite';

export const LABEL_SIZES: Record<string, [number, number]> = {
  '40x30': [40, 30],
  '50x30': [50, 30],
  '60x40': [60, 40],
};

/** 品牌 → 指令语言：斑马走 ZPL，其余（含通用）走 TSPL */
export function brandToLang(brand: string | null | undefined): 'tspl' | 'zpl' {
  return String(brand || '') === '斑马' ? 'zpl' : 'tspl';
}

export type LabelItem = {
  name: string;
  price: number;             // 零售价
  promoPrice?: number;       // 促销价（有则原价划线）
  promoLabel?: string;       // 促销期文案（特价有效期 / 时段特惠）
  barcode?: string;          // 缺省打「无条码」文字
  unit?: string;
  spec?: string;
  keepDays?: number;         // 保质期天数
  weight?: number;           // 秤贴：重量 kg
  time?: string;             // 秤贴：称重时间
  copies?: number;           // 该品份数
};

const r2 = (n: number) => Math.round(Number(n) * 100) / 100;
const money = (n: number) => '￥' + (Number(n) || 0).toFixed(2);
/** 去掉 TSPL 文本中的双引号（指令定界符），去换行 */
const safe = (s: any) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');
const shelfText = (d?: number) =>
  !d ? '' : d <= 90 ? `保质${Math.round(d)}天` : `保质${Math.round(d / 30)}个月`;

/** 模版字段配置（V4.15.8 P4）：fields 为空=全显示；key 无配置=默认显示 */
export type LabelCfg = { fields?: { key: string; show?: boolean }[]; title?: string };
export function mkHas(cfg?: LabelCfg): (k: string) => boolean {
  const fs = cfg?.fields;
  if (!Array.isArray(fs) || !fs.length) return () => true;
  return (k: string) => { const f = fs.find(x => x.key === k); return !f || f.show !== false; };
}

/* ═════════════════════ TSPL ═════════════════════ */

/** 价签（TSPL）：品名两行 → 价格行（促销时原价划线）→ 单位·规格·保质期 → CODE128 条码；字段显隐随模版 */
function tsplPriceTag(it: LabelItem, W: number, H: number, has: (k: string) => boolean): string[] {
  const cmds: string[] = [];
  const M = 16;                                             // 边距 dots
  const font = 'TSS24.BF2';
  if (has('name')) cmds.push(`BLOCK ${M},${M},${font},0,1,1,${W - M * 2},52,2,"${safe(it.name)}"`);
  if (has('price')) {
    if (it.promoPrice && it.promoPrice < it.price) {
      // 原价划线（LINE 压在文字中线）+ 促销价放大
      const op = money(it.price);
      cmds.push(`TEXT ${M},74,${font},0,1,1,"${op}"`);
      cmds.push(`LINE ${M - 2},88,${M - 2 + op.length * 13},88,3`);
      cmds.push(`TEXT ${M + 120},64,"TSS32.BF2",0,1,1,"${money(it.promoPrice)}"`);
    } else {
      cmds.push(`TEXT ${M},64,"TSS32.BF2",0,1,1,"${money(it.price)}"`);
    }
  }
  const info = [has('unit') ? it.unit : '', has('spec') ? it.spec : '', has('keepDays') ? shelfText(it.keepDays) : '']
    .filter(Boolean).join(' · ');
  if (info) cmds.push(`TEXT ${M},112,${font},0,1,1,"${safe(info)}"`);
  if (it.barcode && has('barcode')) cmds.push(`BARCODE ${M},${H - 96},"128",80,1,0,2,2,"${safe(it.barcode)}"`);
  else if (!has('barcode') || !it.barcode) cmds.push(`TEXT ${M},${H - 80},${font},0,1,1,""`);
  // V5.0.4：有促销价自动印「特价」角标 + 有效期（合规）
  if (it.promoPrice && it.promoPrice < it.price) {
    if (has('promoTag')) cmds.push(`TEXT ${W - 54},${M},${font},0,1,1,"特价"`);
    if (has('promoPeriod') && it.promoLabel) cmds.push(`TEXT ${M},${H - 110},${font},0,1,1,"${safe(it.promoLabel)}"`);
  }
  return cmds;
}

/** 秤贴（TSPL）：品名 → 单价/重量 → 金额放大 → 条码 → 称重时间；字段显隐随模版 */
function tsplScaleTag(it: LabelItem, W: number, H: number, has: (k: string) => boolean): string[] {
  const cmds: string[] = [];
  const M = 16;
  const font = 'TSS24.BF2';
  const w = Number(it.weight) || 0;
  const amt = r2((Number(it.price) || 0) * w);
  if (has('name')) cmds.push(`BLOCK ${M},${M},${font},0,1,1,${W - M * 2},28,1,"${safe(it.name)}"`);
  if (has('time') && it.time) cmds.push(`TEXT ${W - M - 104},${M},"${font}",0,1,1,"${safe(it.time)}"`);
  if (has('unitPrice')) cmds.push(`TEXT ${M},48,${font},0,1,1,"单价:${money(it.price)}/${safe(it.unit || 'kg')}"`);
  if (has('weight')) cmds.push(`TEXT ${M},80,${font},0,1,1,"重量:${w.toFixed(3)}kg"`);
  if (has('amount')) cmds.push(`TEXT ${M},108,"TSS32.BF2",0,1,1,"金额:${money(amt)}"`);
  if (it.barcode && has('barcode')) cmds.push(`BARCODE ${M},${H - 96},"128",80,1,0,2,2,"${safe(it.barcode)}"`);
  return cmds;
}

/** TSPL 整批构建：每张 CLS+PRINT */
export function buildTsplBytes(items: LabelItem[], wmm: number, hmm: number, copies = 1, cfg?: LabelCfg): Buffer {
  const W = wmm * 8, H = hmm * 8;
  const has = mkHas(cfg);
  let s = '';
  for (const it of items) {
    s += `SIZE ${wmm} mm,${hmm} mm\r\nGAP 2 mm,0\r\nDIRECTION 1\r\nCLS\r\n`;
    for (const c of (it.weight != null ? tsplScaleTag(it, W, H, has) : tsplPriceTag(it, W, H, has))) s += c + '\r\n';
    s += `PRINT 1,${Math.max(1, Number(it.copies) || copies)}\r\n`;
  }
  return iconv.encode(s, 'gbk');
}

/* ═════════════════════ ZPL（斑马） ═════════════════════ */

function zplPriceTag(it: LabelItem, W: number, H: number, has: (k: string) => boolean): string {
  const M = 16;
  let s = '';
  if (has('name')) s += `^CI28^FO${M},${M}^A0N,26,26^FB${W - M * 2},2,0,L^FD${safe(it.name)}^FS`;
  if (has('price')) {
    if (it.promoPrice && it.promoPrice < it.price) {
      const op = money(it.price);
      s += `^FO${M},72^A0N,26,26^FD${op}^FS^FO${M - 2},84^GB${op.length * 13},3,3^FS`;
      s += `^FO${M + 120},62^A0N,34,30^FD${money(it.promoPrice)}^FS`;
    } else {
      s += `^FO${M},62^A0N,34,30^FD${money(it.price)}^FS`;
    }
  }
  const info = [has('unit') ? it.unit : '', has('spec') ? it.spec : '', has('keepDays') ? shelfText(it.keepDays) : '']
    .filter(Boolean).join(' · ');
  if (info) s += `^FO${M},${H - 130}^A0N,24,24^FD${safe(info)}^FS`;
  if (it.barcode && has('barcode')) s += `^FO${M},${H - 100}^BY2,2,80^BCN,,Y,N,N^FD${safe(it.barcode)}^FS`;
  // V5.0.4：有促销价自动印「特价」角标 + 有效期（合规）
  if (it.promoPrice && it.promoPrice < it.price) {
    if (has('promoTag')) s += `^FO${W - 60},${M + 2}^A0N,24,24^FD特价^FS`;
    if (has('promoPeriod') && it.promoLabel) s += `^FO${M},${H - 116}^A0N,24,24^FD${safe(it.promoLabel)}^FS`;
  }
  return s;
}

function zplScaleTag(it: LabelItem, W: number, H: number, has: (k: string) => boolean): string {
  const M = 16;
  const w = Number(it.weight) || 0;
  const amt = r2((Number(it.price) || 0) * w);
  let s = '^CI28';
  if (has('name')) s += `^FO${M},${M}^A0N,26,26^FD${safe(it.name)}^FS`;
  if (has('time') && it.time) s += `^FO${W - M - 110},${M}^A0N,22,22^FD${safe(it.time)}^FS`;
  if (has('unitPrice')) s += `^FO${M},48^A0N,26,26^FD单价:${money(it.price)}/${safe(it.unit || 'kg')}^FS`;
  if (has('weight')) s += `^FO${M},80^A0N,26,26^FD重量:${w.toFixed(3)}kg^FS`;
  if (has('amount')) s += `^FO${M},108^A0N,34,30^FD金额:${money(amt)}^FS`;
  if (it.barcode && has('barcode')) s += `^FO${M},${H - 100}^BY2,2,80^BCN,,Y,N,N^FD${safe(it.barcode)}^FS`;
  return s;
}

export function buildZplBytes(items: LabelItem[], wmm: number, hmm: number, copies = 1, cfg?: LabelCfg): Buffer {
  const W = wmm * 8, H = hmm * 8;
  const has = mkHas(cfg);
  let s = '';
  for (const it of items) {
    s += `^XA^PW${W}^LL${H}^LH0,0`
      + (it.weight != null ? zplScaleTag(it, W, H, has) : zplPriceTag(it, W, H, has))
      + `^PQ${Math.max(1, Number(it.copies) || copies)},0,0,Y^XZ`;
  }
  return Buffer.from(s, 'utf8');
}

/* ═════════════════════ 测试标签 ═════════════════════ */

export function buildLabelTestBytes(lang: 'tspl' | 'zpl', wmm: number, hmm: number): Buffer {
  const W = wmm * 8, H = hmm * 8;
  if (lang === 'zpl') {
    const s = `^XA^PW${W}^LL${H}^CI28^FO16,14^A0N,30,30^FD标签测试页^FS`
      + `^FO16,54^A0N,24,24^FD纸型 ${wmm}x${hmm}mm · 中文/ABC/0123^FS`
      + `^FO16,88^A0N,24,24^FD打印正常 · 请核对清晰度^FS`
      + `^FO16,${H - 100}^BY2,2,80^BCN,,Y,N,N^FD12345678^FS`
      + `^PQ1,0,0,Y^XZ`;
    return Buffer.from(s, 'utf8');
  }
  const s = `SIZE ${wmm} mm,${hmm} mm\r\nGAP 2 mm,0\r\nDIRECTION 1\r\nCLS\r\n`
    + `TEXT 16,14,"TSS32.BF2",0,1,1,"标签测试页"\r\n`
    + `TEXT 16,56,"TSS24.BF2",0,1,1,"纸型 ${wmm}x${hmm}mm 中文ABC0123"\r\n`
    + `TEXT 16,88,"TSS24.BF2",0,1,1,"打印正常·请核对清晰度"\r\n`
    + `BARCODE 16,${H - 96},"128",80,1,0,2,2,"12345678"\r\n`
    + `PRINT 1,1\r\n`;
  return iconv.encode(s, 'gbk');
}

/** 统一入口：按语言构建整批标签字节（cfg=模版字段显隐） */
export function buildLabelBytes(lang: 'tspl' | 'zpl', items: LabelItem[], wmm: number, hmm: number, copies = 1, cfg?: LabelCfg): Buffer {
  return lang === 'zpl'
    ? buildZplBytes(items, wmm, hmm, copies, cfg)
    : buildTsplBytes(items, wmm, hmm, copies, cfg);
}

/* ═════════════════════════════════════════════════════════════════
 * V4.15.9 可视化排版（v2）：content.version===2 时按 elements 逐元素渲染
 *   元素：{ id,type,x,y,w,h, text?,key?,label?,fontSize?,bold?,align?,rotate?,show? }
 *   坐标/尺寸均为 mm；type: text/field/kv/divider/line/barcode/qrcode/rect/box
 * ═════════════════════════════════════════════════════════════════ */

export type LayoutEl = {
  id?: string;
  type: string;
  x: number; y: number; w?: number; h?: number;
  text?: string; key?: string; label?: string;
  fontSize?: number; bold?: boolean;
  align?: 'left' | 'center' | 'right';
  rotate?: number;                        // 0/90/180/270（标签）
  th?: number;                            // rect 线宽 mm
  show?: boolean;
};
export type LayoutDoc = { version?: number; title?: string; paper?: { wmm: number; hmm: number }; elements?: LayoutEl[] };

/** 字段取值（与 P2 固定版式同口径）：info=单位·规格·保质期 合成，amount=单价×重量 */
export function resolveFieldValue(key: string, it: LabelItem): { text: string; promo?: number } {
  switch (key) {
    case 'name': return { text: String(it.name || '') };
    case 'price': {
      const promo = it.promoPrice && it.promoPrice < it.price ? it.promoPrice : undefined;
      return { text: money(it.price), promo };
    }
    case 'promoPrice': return { text: it.promoPrice && it.promoPrice < it.price ? money(it.promoPrice) : '' };
    case 'info': return {
      text: [it.unit, it.spec, shelfText(it.keepDays)].filter(Boolean).join(' · '),
    };
    case 'barcode': return { text: String(it.barcode || '') };
    case 'unit': return { text: String(it.unit || '') };
    case 'spec': return { text: String(it.spec || '') };
    case 'keepDays': return { text: shelfText(it.keepDays) };
    case 'unitPrice': return { text: `单价:${money(it.price)}/${String(it.unit || 'kg')}` };
    case 'weight': return { text: `重量:${(Number(it.weight) || 0).toFixed(3)}kg` };
    case 'amount': return { text: `金额:${money(r2((Number(it.price) || 0) * (Number(it.weight) || 0)))}` };
    case 'time': return { text: String(it.time || '') };
    case 'promoLabel': return { text: String(it.promoLabel || '') };
    case 'promoTag': return { text: it.promoPrice && it.promoPrice < it.price ? '特价' : '' };
    case 'promoPeriod': return { text: String(it.promoLabel || '') };
    default: return { text: '' };
  }
}

const DOTS = 8;                                   // 热敏标签 8 dots/mm
const dispW = (s: string) => { let n = 0; for (const ch of s) n += ch.codePointAt(0) > 255 ? 2 : 1; return n; };
const rotDeg = (r?: number) => [0, 90, 180, 270].includes(Number(r)) ? Number(r) : 0;

/** TSPL v2：逐元素出指令。价格元素带促销价时：原价+划线，后接促销价 */
function tsplLayoutCmds(els: LayoutEl[], it: LabelItem, W: number): string[] {
  const cmds: string[] = [];
  for (const el of els) {
    if (el.show === false) continue;
    const X = Math.round(el.x * DOTS), Y = Math.round(el.y * DOTS);
    const Wd = Math.round((el.w || 0) * DOTS), Hd = Math.round((el.h || 0) * DOTS);
    const font = 'TSS24.BF2';
    const rot = rotDeg(el.rotate);
    if (el.type === 'text' || el.type === 'field' || el.type === 'kv') {
      let text = el.type === 'text' ? String(el.text ?? '')
        : el.type === 'kv' ? `${String(el.label ?? '')}${resolveFieldValue(String(el.key || ''), it).text}`
        : resolveFieldValue(String(el.key || ''), it).text;
      if (!text) continue;
      const mul = Math.max(1, Math.round((Number(el.fontSize) || 3) * DOTS / 24));
      let promo = 0;
      if (el.type === 'field' && el.key === 'price') {
        const pv = resolveFieldValue('price', it);
        if (pv.promo) { text = pv.text; promo = pv.promo; }
      }
      const textW = dispW(text) * 12 * mul;     // TSS24：全角24/半角12 dots × 倍率
      let x = X;
      if (!rot) {
        if (el.align === 'center') x = X + Math.max(0, Math.round((Wd - textW) / 2));
        else if (el.align === 'right') x = X + Math.max(0, Wd - textW);
      }
      cmds.push(`TEXT ${x},${Y},${font},${rot},${mul},${mul},"${safe(text)}"`);
      if (promo) {                              // 原价划线 + 促销价（右移原价宽）
        const px = rot ? x : x + textW + 8;
        const pw = Math.max(1, Math.round((Number(el.fontSize) || 3) * 2 * DOTS / 24));
        cmds.push(`LINE ${x - 2},${Y + 12 * mul},${x - 2 + textW},${Y + 12 * mul},3`);
        cmds.push(`TEXT ${px},${Y},${font},${rot},${pw},${pw},"${safe(money(promo))}"`);
      }
    } else if (el.type === 'barcode') {
      const v = resolveFieldValue(String(el.key || 'barcode'), it).text;
      if (v) cmds.push(`BARCODE ${X},${Y},"128",${Math.max(20, Hd || 60)},1,0,2,2,"${safe(v)}"`);
    } else if (el.type === 'qrcode') {
      const v = resolveFieldValue(String(el.key || 'barcode'), it).text;
      if (v) cmds.push(`QRCODE ${X},${Y},M,4,A,0,M2,"${safe(v)}"`);
    } else if (el.type === 'divider' || el.type === 'line') {
      cmds.push(`LINE ${X},${Y},${X + (Wd || W - X)},${Y},${Math.max(1, Math.round((el.h || 0.4) * DOTS))}`);
    } else if (el.type === 'rect' || el.type === 'box') {
      const th = Math.max(1, Math.round((el.th || 0.3) * DOTS));
      cmds.push(`BOX ${X},${Y},${X + (Wd || W - X)},${Y + (Hd || 40)},${th}`);
    }
  }
  return cmds;
}

/** TSPL v2 整批：每张 CLS + 逐元素 + PRINT */
export function buildTsplLayout(items: LabelItem[], els: LayoutEl[], wmm: number, hmm: number, copies = 1): Buffer {
  const W = wmm * DOTS;
  let s = '';
  for (const it of items) {
    s += `SIZE ${wmm} mm,${hmm} mm\r\nGAP 2 mm,0\r\nDIRECTION 1\r\nCLS\r\n`;
    for (const c of tsplLayoutCmds(els, it, W)) s += c + '\r\n';
    s += `PRINT 1,${Math.max(1, Number(it.copies) || copies)}\r\n`;
  }
  return iconv.encode(s, 'gbk');
}

/** ZPL v2：^FB 字段块自带对齐；^FW/^A0 字母表旋转 */
function zplLayoutCmds(els: LayoutEl[], it: LabelItem, W: number): string {
  const ROT = ['N', 'R', 'I', 'B'];
  let s = '^CI28';
  for (const el of els) {
    if (el.show === false) continue;
    const X = Math.round(el.x * DOTS), Y = Math.round(el.y * DOTS);
    const Wd = Math.round((el.w || 0) * DOTS), Hd = Math.round((el.h || 0) * DOTS);
    const r = ROT[[0, 90, 180, 270].indexOf(rotDeg(el.rotate))] || 'N';
    if (el.type === 'text' || el.type === 'field' || el.type === 'kv') {
      let text = el.type === 'text' ? String(el.text ?? '')
        : el.type === 'kv' ? `${String(el.label ?? '')}${resolveFieldValue(String(el.key || ''), it).text}`
        : resolveFieldValue(String(el.key || ''), it).text;
      if (!text) continue;
      const hd = Math.round((Number(el.fontSize) || 3) * DOTS);
      let promo = 0;
      if (el.type === 'field' && el.key === 'price') {
        const pv = resolveFieldValue('price', it);
        if (pv.promo) { text = pv.text; promo = pv.promo; }
      }
      const align = { left: 'L', center: 'C', right: 'R' }[el.align || 'left'] || 'L';
      s += `^FO${X},${Y}^A0${r},${hd},${hd}`;
      if (r === 'N' && Wd > 0) s += `^FB${Wd},1,0,${align}`;
      s += `^FD${safe(text)}^FS`;
      if (promo) {
        const pd = Math.round((Number(el.fontSize) || 3) * 2 * DOTS);
        const promoX = r === 'N' && Wd > 0 && align === 'L' ? X + dispW(text) * hd / 2 + 8 : X;
        s += `^FO${Math.round(promoX)},${Y}^A0${r},${pd},${pd}^FD${safe(money(promo))}^FS`
          + `^FO${X},${Y + Math.round(hd * 0.8)}^GB${Math.round(dispW(text) * hd / 2)},3,3^FS`;
      }
    } else if (el.type === 'barcode') {
      const v = resolveFieldValue(String(el.key || 'barcode'), it).text;
      if (v) s += `^FO${X},${Y}^BY2,2,${Math.max(20, Hd || 60)}^BC${r},,Y,N,N^FD${safe(v)}^FS`;
    } else if (el.type === 'qrcode') {
      const v = resolveFieldValue(String(el.key || 'barcode'), it).text;
      if (v) s += `^FO${X},${Y}^BQ${r},2,4^FDLA,${safe(v)}^FS`;
    } else if (el.type === 'divider' || el.type === 'line') {
      s += `^FO${X},${Y}^GB${Wd || W - X},${Math.max(1, Math.round((el.h || 0.4) * DOTS))},${Math.max(1, Math.round((el.h || 0.4) * DOTS))}^FS`;
    } else if (el.type === 'rect' || el.type === 'box') {
      const th = Math.max(1, Math.round((el.th || 0.3) * DOTS));
      s += `^FO${X},${Y}^GB${Wd || W - X},${Hd || 40},${th}^FS`;
    }
  }
  return s;
}

/** ZPL v2 整批 */
export function buildZplLayout(items: LabelItem[], els: LayoutEl[], wmm: number, hmm: number, copies = 1): Buffer {
  const W = wmm * DOTS;
  let s = '';
  for (const it of items) {
    s += `^XA^PW${W}^LL${hmm * DOTS}^LH0,0` + zplLayoutCmds(els, it, W)
      + `^PQ${Math.max(1, Number(it.copies) || copies)},0,0,Y^XZ`;
  }
  return Buffer.from(s, 'utf8');
}

/** v2 统一分发：cfg.elements 为数组 → 排版渲染；否则回落 v1 固定版式 */
export function buildLayoutBytes(lang: 'tspl' | 'zpl', items: LabelItem[], wmm: number, hmm: number, copies = 1, cfg?: LayoutDoc): Buffer {
  const els = cfg && Array.isArray(cfg.elements) ? cfg.elements : null;
  if (!els || !els.length) return buildLabelBytes(lang, items, wmm, hmm, copies, cfg);
  const p = cfg?.paper;
  const w2 = p && Number(p.wmm) >= 10 && Number(p.wmm) <= 200 ? Number(p.wmm) : wmm;
  const h2 = p && Number(p.hmm) >= 10 && Number(p.hmm) <= 200 ? Number(p.hmm) : hmm;
  return lang === 'zpl'
    ? buildZplLayout(items, els, w2, h2, copies)
    : buildTsplLayout(items, els, w2, h2, copies);
}
