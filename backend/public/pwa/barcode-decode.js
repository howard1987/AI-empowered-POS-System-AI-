'use strict';
/* 统一条码解码（barcode-decode.js，ESM）—— 扫描级多趟管线 V2
 *
 * 为什么 V1 实机扫不出（Node 解干净图成功 ≠ 摄像头实流可用）：
 *   ① 全帧解码对小条码极弱：手机正常距离下 EAN-13 只占画面 15~25% 宽，商用扫码（银豹/微信）
 *      都靠「中央 ROI 裁剪 + 放大」，V1 只做全帧 tryHarder，小码基本必败；
 *   ② 每帧 new BarcodeDetector + 每帧新建 canvas + 全帧 getImageData（3.7MB/帧 拷贝进 wasm）
 *      → 单帧上百 ms，有效帧率仅 2~5fps，对焦窗口内抓不到清晰帧；
 *   ③ 手机变焦能力完全没用上（小码/固定对焦镜头的关键手段）。
 *
 * V2 多趟策略（每帧从快到慢依次执行，命中即返；趟越靠后覆盖越难的场景）：
 *   T1 原生 BarcodeDetector 全帧（快，抓大码/二维码）
 *   T2 zxing 中央水平带 ROI 直解（条码横向对准红线 → 就在带内；小图快）
 *   T3 ROI ×2 双线性放大（小码/远距关键增益；必须双线性，最近邻会劣化）
 *   T4 中央小窗 ×3 放大（更小/更远）
 *   T5 zxing 全帧 tryHarder 兜底
 *   另：单例 detector / 复用 canvas / willReadFrequently —— 有效帧率提升一个量级。
 *
 * 用法（经典脚本中）：await BarcodeDecode.decode(video|img|canvas) → [{text,format,engine}]
 * 统计：BarcodeDecode.stats = { frames, hits, lastMs, lastEngine }（扫码 UI 可显示排障）
 */
import { readBarcodes } from './vendor/zxing-wasm/es/reader/index.js';

// zxing-wasm v3 合法枚举名（share.js 别名表核实）：非法名会导致 wasm 返回空文本伪命中 → 永远扫不出
const ZX_FORMATS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'Code93',
  'Codabar', 'ITF', 'QRCode', 'MicroQRCode', 'DataMatrix', 'Aztec', 'PDF417', 'DataBar'];
// BarcodeDetector 支持的格式名（实际以 getSupportedFormats 过滤）
const BD_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39',
  'code_93', 'codabar', 'itf', 'qr_code', 'data_matrix', 'aztec', 'pdf_417'];

const FULL_MAX = 1920;   // 全帧画布上限（1080p 流直取，不再压缩）

/* ── 复用资源（单例，避免每帧分配） ── */
const _pools = new Map();  // key → { cv, ctx, w, h }
function pool(key, w, h) {
  let p = _pools.get(key);
  if (!p || p.w !== w || p.h !== h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    p = { cv, ctx, w, h };
    _pools.set(key, p);
  }
  return p;
}

/* ── 原生 BarcodeDetector 单例 ── */
let _bd = null, _bdInit = false;
async function getDetector() {
  if (_bdInit) return _bd;
  _bdInit = true;
  if (typeof BarcodeDetector === 'undefined') return null;
  let formats = BD_FORMATS;
  try {
    const sup = await BarcodeDetector.getSupportedFormats();
    if (Array.isArray(sup) && sup.length) formats = BD_FORMATS.filter(f => sup.includes(f));
  } catch { /* 不支持过滤则全格式尝试 */ }
  if (!formats.length) return null;
  try { _bd = new BarcodeDetector({ formats }); } catch { _bd = null; }
  return _bd;
}

/** 原生检测（整帧，快） */
async function detectNative(cv) {
  const det = await getDetector();
  if (!det || !cv) return [];
  try {
    const codes = await det.detect(cv);
    return (codes || []).map(c => ({ text: String(c.rawValue || '').trim(), format: c.format || '', engine: 'native' }))
      .filter(x => x.text);
  } catch { return []; }
}

/** zxing-wasm：入参 canvas 或 ImageData；统一归一化为 {data,width,height} 纯对象（wasm 层 pixmap 路径） */
async function detectZX(src) {
  if (!src) return [];
  try {
    let img = src;
    if (src.getContext) {
      const raw = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
      img = { data: raw.data, width: raw.width, height: raw.height };
    }
    if (!img || !img.data || !img.width || !img.height) return [];
    const res = await readBarcodes(img, { tryHarder: true, formats: ZX_FORMATS });
    return (Array.isArray(res) ? res : []).map(r => {
      const dr = r && r.decodeResult ? r.decodeResult : r;
      const t = String((dr && dr.text) || '').trim();
      return t ? { text: t, format: String((dr && dr.format) || ''), engine: 'zxing-wasm' } : null;
    }).filter(Boolean);
  } catch (e) {
    console.warn('[BarcodeDecode] zxing-wasm 失败：', e && e.message);
    return [];
  }
}

/** 把源帧画到复用全帧画布（cap FULL_MAX） */
function grabFull(src) {
  const w = src.videoWidth || src.naturalWidth || src.width || 0;
  const h = src.videoHeight || src.naturalHeight || src.height || 0;
  if (!w || !h) return null;
  const k = Math.min(1, FULL_MAX / Math.max(w, h));
  const p = pool('full', Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  p.ctx.drawImage(src, 0, 0, p.w, p.h);
  return p;
}

/** ROI 子区 → 放大画布（双线性，imageSmoothingQuality=high）；返回 canvas */
function roiScaled(p, rx, ry, rw, rh, scale, key) {
  const q = pool(key, Math.max(1, Math.round(rw * scale)), Math.max(1, Math.round(rh * scale)));
  q.ctx.imageSmoothingEnabled = true;
  q.ctx.imageSmoothingQuality = 'high';
  q.ctx.drawImage(p.cv, rx, ry, rw, rh, 0, 0, q.w, q.h);
  return q.cv;
}

/* ── 运行统计（UI 排障用） ── */
const stats = { frames: 0, hits: 0, lastMs: 0, lastEngine: '-' };
function mark(list, engine, t0) {
  stats.frames++; stats.hits++;
  stats.lastMs = Math.round(performance.now() - t0);
  stats.lastEngine = engine;
  return list.map(x => ({ ...x, engine }));
}
function miss(t0) { stats.frames++; stats.lastMs = Math.round(performance.now() - t0); stats.lastEngine = '-'; }

function dedupe(list) {
  const seen = new Set(); const out = [];
  for (const it of list) {
    if (seen.has(it.text)) continue;
    seen.add(it.text); out.push(it);
  }
  return out;
}

/** 多趟解码：原生全帧 → ROI 直解 → ROI×2 → 中央小窗×3 → 全帧兜底 */
async function decodeMulti(src) {
  const t0 = performance.now();
  const p = grabFull(src);
  if (!p) { miss(t0); return []; }
  const W = p.w, H = p.h;

  let r = await detectNative(p.cv);                                  // T1 原生全帧
  if (r.length) return mark(r, 'native-full', t0);

  // T2 中央水平带 ROI 直解（条码横向 → 带内）；x 5%~95%，y 30%~70%
  const rw = Math.round(W * 0.90), rh = Math.round(H * 0.40);
  const rx = Math.round(W * 0.05), ry = Math.round(H * 0.30);
  r = await detectZX(roiScaled(p, rx, ry, rw, rh, 1, 'band'));
  if (r.length) return mark(r, 'zx-roi', t0);

  // T3 中央带 ×2 双线性放大（小码/远距关键趟）
  r = await detectZX(roiScaled(p, rx, ry, rw, rh, 2, 'band2'));
  if (r.length) return mark(r, 'zx-roi-x2', t0);

  // T4 中央小窗 ×3（更小/更远）
  const sw = Math.round(W * 0.50), sh = Math.round(H * 0.24);
  const sx = Math.round(W * 0.25), sy = Math.round(H * 0.38);
  r = await detectZX(roiScaled(p, sx, sy, sw, sh, 3, 'win3'));
  if (r.length) return mark(r, 'zx-win-x3', t0);

  // T5 全帧 zxing 兜底（覆盖偏离中央/大画幅二维码等）
  r = await detectZX(p.cv);
  if (r.length) return mark(r, 'zx-full', t0);

  miss(t0);
  return [];
}

window.BarcodeDecode = {
  /** 解码所有条码（内部多趟，命中即返） */
  async decode(src) { return dedupe(await decodeMulti(src)); },
  /** 仅取第一个命中 */
  async decodeFirst(src) { return (await this.decode(src))[0] || null; },
  /** 运行统计（扫码 UI 显示：帧数/命中/耗时/引擎） */
  stats,
  /** 是否可用（模块已加载即可用；wasm 在首次 decode 时按需拉取） */
  ready: true,
};
console.info('[BarcodeDecode] V2 已加载（native + zxing-wasm 多趟：全帧/ROI/放大）');
