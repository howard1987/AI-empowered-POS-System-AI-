'use strict';
/* 统一条码解码（barcode-decode.js，ESM）—— 扫描级多趟管线 V3
 *
 * V2 实测仍扫不出的根因（本版针对「矿泉水弧形条码 / 纸巾平面条码」等一维码）：
 *   ① ROI 只有「中央水平带」(y 30%~70%) 一条，且 x 5%~95%：弧形条码上下弯曲，
 *      条码主体被这条带裁掉或只剩一截 → 模块不完整必然解不出；
 *   ② 无任何灰度/对比度预处理：实拍弧面有条码弯曲造成的阴影与高光反光，
 *      zxing 的二值化阈值在低对比度区域直接失效（纸巾白色包装反光最典型）；
 *   ③ ROI 边界会把条码切断：横跨边界的码，模块被截断 → 静默失败；
 *   ④ 1D 码（EAN/UPC/Code128）本质是「沿水平线采样」，竖直方向不需要大 ROI，
 *      而旧管线把大量算力浪费在竖直方向的无关像素上，拖低有效帧率。
 *
 * V3 策略：
 *   A. 1D 专项：多段「窄高比」水平条（多 y 位置 × 全宽安全内缩），先直解再放大直解；
 *   B. 灰度 + 自适应对比度拉伸（Otsu 简化版）：把弧面阴影/反光拉平，1D 关键增益；
 *   C. 安全内缩裁剪（inset 6%）：确保条码不跨 ROI 边界被截断；
 *   D. 二维码 / 堆叠码仍走全帧 + ROI 兜底（保持既有能力不回退）。
 *
 * 用法：await BarcodeDecode.decode(video|img|canvas) → [{text,format,engine}]
 * 统计：BarcodeDecode.stats = { frames, hits, lastMs, lastEngine }（扫码 UI 可显示排障）
 *
 * ★ V5.0.8g 关键修复：zxing_reader.wasm 一直 404 → 引擎从未加载成功（永远扫不出的真凶）
 *   zxing-wasm 打包产物里 `var c = "./this.program", l` 中 l 从未被赋值，于是
 *   `u = new URL(".", l).href` 抛错并被 `catch {}` 吞掉，u 保持空串，
 *   导致 locateFile 解析成 `zxing_reader.wasm`（相对**页面**路径 /pwa/）→ 404。
 *   真实文件在 /pwa/vendor/zxing-wasm/es/reader/zxing_reader.wasm。
 *   现象：每帧 16ms 快速失败、引擎恒为 '-'、命中 0（异常被库内与本文件双重吞掉）。
 *   处置：用官方 setZXingModuleOverrides 显式指定 locateFile，并在初始化时
 *   预热校验 wasm 是否真的就绪（结果暴露到 ZX_STATE，供 UI 提示）。
 */
// 引擎就绪状态：'init' | 'ready' | 'unavailable' | 'failed'，供扫码 UI 提示与排障
const ZX_STATE = { state: 'init', err: '' };
let _zx = null;        // zxing-wasm 模块引用
let _zxTried = false;  // 是否已尝试加载（只试一次）

/* 懒加载 zxing-wasm（V5.0.9 为 APK 改造）：
 * 原为顶层静态 import，但 APK 内已排除 vendor/zxing-wasm（3.1MB，阶段五改用系统原生扫码），
 * 静态 import 会因模块解析失败而让**整个 barcode-decode.js 加载失败**（扫码全废）。
 * 改为动态 import + 容错：加载不到仅降级为原生 BarcodeDetector，不影响模块本身与二维码能力。 */
async function ensureZX() {
  if (_zx || _zxTried) return _zx;
  _zxTried = true;
  try {
    const m = await import('./vendor/zxing-wasm/es/reader/index.js');
    // 显式指定 wasm 二进制位置（相对本模块 URL，兼容任意部署子路径 / file 协议）
    m.setZXingModuleOverrides({
      locateFile: (path) => new URL('./vendor/zxing-wasm/es/reader/' + path, import.meta.url).href,
    });
    m.prepareZXingModule({});          // 预热：失败立刻暴露，避免等到扫码时静默失败
    _zx = m;
    ZX_STATE.state = 'ready';
  } catch (e) {
    ZX_STATE.state = 'unavailable';    // 非致命：降级到原生 BarcodeDetector
    ZX_STATE.err = String((e && e.message) || e);
    console.warn('[BarcodeDecode] zxing-wasm 不可用，降级为原生 BarcodeDetector：', e);
  }
  return _zx;
}

// zxing-wasm v3 合法枚举名（share.js 别名表核实）：非法名会导致 wasm 返回空文本伪命中 → 永远扫不出
const ZX_FORMATS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'Code93',
  'Codabar', 'ITF', 'QRCode', 'MicroQRCode', 'DataMatrix', 'Aztec', 'PDF417', 'DataBar'];
// 1D 专项：只跑一维格式，速度与成功率都优于混合全格式（弧面/低对比度场景的关键）
const ZX_1D_ONLY = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'Code93', 'Codabar', 'ITF', 'DataBar'];
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
// V5.0.8h 设备能力探测：BarcodeDetector 是浏览器里唯一的「原生」扫码能力，
// 但 Android Chrome 长期未默认启用，且即便启用，很多机型 getSupportedFormats()
// 只返回 qr_code（不支持 EAN-13/UPC/Code128 等一维码）→ 一维码只能回落 wasm。
// 这里把真实能力探测出来，供 UI 如实告知（避免「以为走了原生其实一直回落」）。
const NATIVE_CAP = { supported: false, formats: [], oneD: false, reason: '' };
async function probeNative() {
  if (typeof BarcodeDetector === 'undefined') {
    NATIVE_CAP.reason = '此浏览器未提供 BarcodeDetector（无原生扫码能力）';
    return NATIVE_CAP;
  }
  try {
    const sup = await BarcodeDetector.getSupportedFormats();
    const list = Array.isArray(sup) ? sup : [];
    NATIVE_CAP.supported = true;
    NATIVE_CAP.formats = list;
    const oneDKeys = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf', 'data_bar'];
    NATIVE_CAP.oneD = list.some(f => oneDKeys.includes(f));
    NATIVE_CAP.reason = NATIVE_CAP.oneD
      ? `原生可用（含一维码：${oneDKeys.filter(k => list.includes(k)).join('/')}）`
      : `原生仅支持 ${list.join('/') || '无'}，不含一维码 → 一维码走 wasm 引擎`;
  } catch (e) {
    NATIVE_CAP.reason = 'BarcodeDetector 探测失败：' + String((e && e.message) || e);
  }
  return NATIVE_CAP;
}
const NATIVE_READY = probeNative();   // 模块加载即开始探测

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

/* ── V5.0.10 Capacitor 原生 ZXing 通道（仅 APK 内可用） ──
   插件侧：android/app/src/main/java/com/pos/cashier/NativeScannerPlugin.java（ZXing core）
   探测结果缓存：undefined=未探测，null=不可用，对象=可用。 */
let _nsP = undefined;
/** zxing 的 'EAN-13' 写法 → Java 枚举名 'EAN_13'（非法名插件侧会忽略） */
const ZX_TO_NATIVE = ZX_FORMATS.map(f => String(f).replace(/-/g, '_'));

async function nativeScanner() {
  if (_nsP !== undefined) return _nsP;
  try {
    const cap = window.Capacitor;
    const p = cap && cap.Plugins && cap.Plugins.NativeScanner;
    if (!p || typeof p.analyze !== 'function') { _nsP = null; return null; }
    const r = await p.isAvailable();
    _nsP = (r && r.available) ? p : null;
  } catch { _nsP = null; }
  return _nsP;
}

async function detectNativePlugin(cv) {
  const ns = await nativeScanner();
  if (!ns || !cv || !cv.width) return [];
  try {
    // 缩到 1280 宽以内：ZXing 在大图上反而更慢，且 base64 IPC 开销与像素数成正比
    let src = cv;
    if (cv.width > 1280) {
      const k = 1280 / cv.width;
      const c2 = document.createElement('canvas');
      c2.width = Math.max(1, Math.round(cv.width * k));
      c2.height = Math.max(1, Math.round(cv.height * k));
      c2.getContext('2d').drawImage(cv, 0, 0, c2.width, c2.height);
      src = c2;
    }
    const r = await ns.analyze({ image: src.toDataURL('image/jpeg', 0.7), formats: ZX_TO_NATIVE });
    if (!r || !r.found) return [];
    const codes = r.codes || {};
    return Object.keys(codes).map(k => {
      const c = codes[k] || {};
      const t = String(c.text || '').trim();
      return t ? { text: t, format: String(c.format || ''), engine: 'native-zxing' } : null;
    }).filter(Boolean);
  } catch { return []; }
}

/** 原生检测（整帧，快）
 *  V5.0.10 引擎顺序：① Web BarcodeDetector → ② Capacitor 原生 ZXing 插件 → ③ zxing-wasm。
 *  顺序是实测校准的：真机（Android 16 / WebView 138）上 BarcodeDetector 存在且支持 13 种格式，
 *  它在 WebView 进程内完成解码，比「base64 + IPC + ZXing」的插件路径更快，故先试它。
 *  插件作为第二道：BarcodeDetector 在部分 WebView/桌面浏览器上不存在（桌面 Chrome 上直接是
 *  undefined），且 ZXing 带 TRY_HARDER 对低对比度/弧形条码更宽容，适合作为兜底而非首选。 */
async function detectNative(cv) {
  if (!cv) return [];
  const det = await getDetector();
  if (det) {
    try {
      const codes = await det.detect(cv);
      const hit = (codes || []).map(c => ({ text: String(c.rawValue || '').trim(), format: c.format || '', engine: 'native' }))
        .filter(x => x.text);
      if (hit.length) return hit;
    } catch { /* 落到插件通道 */ }
  }
  return detectNativePlugin(cv);
}

/** zxing-wasm：入参 canvas 或 ImageData；统一归一化为 {data,width,height} 纯对象（wasm 层 pixmap 路径） */
async function detectZX(src, formats) {
  if (!src) return [];
  const zx = await ensureZX();          // 懒加载；未打包时返回 null（仅 -SlimScan 构建才会缺）
  if (!zx) return [];
  try {
    let img = src;
    if (src.getContext) {
      const raw = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
      img = { data: raw.data, width: raw.width, height: raw.height };
    }
    if (!img || !img.data || !img.width || !img.height) return [];
    const res = await zx.readBarcodes(img, { tryHarder: true, formats: formats || ZX_FORMATS });
    return (Array.isArray(res) ? res : []).map(r => {
      const dr = r && r.decodeResult ? r.decodeResult : r;
      const t = String((dr && dr.text) || '').trim();
      return t ? { text: t, format: String((dr && dr.format) || ''), engine: 'zxing-wasm' } : null;
    }).filter(Boolean);
  } catch (e) {
    // 不再静默：记录真实原因，供 ZX_STATE/UI 排障（此前这里吞掉了 wasm 404 的全部线索）
    ZX_STATE.state = 'failed';
    ZX_STATE.err = String((e && e.message) || e);
    console.warn('[BarcodeDecode] zxing-wasm 解码失败：', e);
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

/**
 * ROI 子区 → 放大画布（双线性，imageSmoothingQuality=high）。
 * gray=true 时额外做「灰度 + Otsu 自适应对比度拉伸」，用于弧面阴影/反光下的 1D 码。
 */
function roiScaled(p, rx, ry, rw, rh, scale, key, gray) {
  const q = pool(key, Math.max(1, Math.round(rw * scale)), Math.max(1, Math.round(rh * scale)));
  q.ctx.imageSmoothingEnabled = true;
  q.ctx.imageSmoothingQuality = 'high';
  q.ctx.clearRect(0, 0, q.w, q.h);
  q.ctx.drawImage(p.cv, rx, ry, rw, rh, 0, 0, q.w, q.h);
  if (gray) boostContrast(q);
  return q.cv;
}

/**
 * 灰度 + Otsu 自适应阈值拉伸（就地写回 ImageData）。
 * 弧形瓶身/软包装的弯曲会让条码区形成明暗带，全局固定阈值必然失效；
 * Otsu 按当前帧直方图自动选阈值，把暗部拉亮、亮部压暗，显著提升 1D 成功率。
 */
function boostContrast(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return;
  let img;
  try { img = ctx.getImageData(0, 0, w, h); } catch { return; }
  const d = img.data;
  // 1) 亮度直方图（256 桶）
  const hist = new Uint32Array(256);
  const total = w * h;
  for (let i = 0; i < d.length; i += 4) {
    // Rec.601 亮度
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    d[i + 3] = d[i + 3]; // keep alpha
    hist[y]++;
  }
  // 2) Otsu 阈值
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  // 3) 按阈值二值化并写回（条码只关心黑白二值，丢色提升对比度）
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    const v = y > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  try { ctx.putImageData(img, 0, 0); } catch { /* 忽略 */ }
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

/**
 * 1D 专项：多段「窄高比」水平条。
 * - x 安全内缩 INSET（默认 6%）→ 条码不跨 ROI 边界，杜绝模块被截断（V2 的③号根因）；
 * - 多个 y 中心（0.28 / 0.42 / 0.5 / 0.58 / 0.72）覆盖弧形条码的上下弯曲范围（①号根因）；
 * - 每条带先直解、再灰度放大直解（②号根因）；条带高度窄 → 1D 采样快、命中率高。
 */
async function decode1D(p) {
  const W = p.w, H = p.h;
  const INSET = 0.06;                        // 横向安全内缩比例
  const rw = Math.round(W * (1 - INSET * 2));
  const rx = Math.round(W * INSET);
  const bandH = Math.round(H * 0.20);         // 窄带：1D 只需一条水平采样线附近的厚度
  const ys = [0.50, 0.38, 0.62, 0.28, 0.72];  // 自中心向上下扩展，覆盖弧形弯曲
  for (let i = 0; i < ys.length; i++) {
    const ry = Math.max(0, Math.min(H - bandH, Math.round(H * ys[i] - bandH / 2)));
    // 直解（最快，命中即返）
    let r = await detectZX(roiScaled(p, rx, ry, rw, bandH, 1, 'b1d' + i, false), ZX_1D_ONLY);
    if (r.length) return mark(r, 'zx-1d-direct', t0Safe());
    // 灰度 + 放大（弧面阴影/反光、小码/远距的关键增益）
    r = await detectZX(roiScaled(p, rx, ry, rw, bandH, 2, 'b1dg' + i, true), ZX_1D_ONLY);
    if (r.length) return mark(r, 'zx-1d-gray-x2', t0Safe());
  }
  return null;
}
let _t0 = 0;
function t0Safe() { return _t0; }

/**
 * 分帧单趟（V5.0.8f）：把完整管线拆为 8 趟，每帧只跑一趟并轮转。
 * 趟序即优先级：原生全帧 → 1D 五条窄带直解 → 1D 灰度放大 → 全帧兜底。
 * 单帧耗时降至约 1/8，帧率提升一个量级，主线程能及时响应键盘输入。
 */
const STEP_TOTAL = 8;
let _step = 0;
async function decodeStep(src) {
  const t0 = performance.now();
  _t0 = t0;
  const p = grabFull(src);
  if (!p) { miss(t0); return []; }
  const W = p.w, H = p.h;
  const i = _step % STEP_TOTAL;
  _step = (_step + 1) % STEP_TOTAL;

  // 趟 0：原生全帧（最快，大码/二维码）
  if (i === 0) {
    const r = await detectNative(p.cv);
    if (r.length) return mark(r, 'native-full', t0);
    miss(t0); return [];
  }

  const INSET = 0.06;
  const rw = Math.round(W * (1 - INSET * 2)), rx = Math.round(W * INSET);
  const bandH = Math.round(H * 0.20);
  const ys = [0.50, 0.38, 0.62, 0.28, 0.72];

  // 趟 1~5：1D 窄带直解（覆盖弧形条码上下弯曲）
  if (i >= 1 && i <= 5) {
    const b = i - 1;
    const ry = Math.max(0, Math.min(H - bandH, Math.round(H * ys[b] - bandH / 2)));
    const r = await detectZX(roiScaled(p, rx, ry, rw, bandH, 1, 'b1d' + b, false), ZX_1D_ONLY);
    if (r.length) return mark(r, 'zx-1d-direct', t0);
    miss(t0); return [];
  }

  // 趟 6：1D 中央带灰度放大（弧面阴影/反光、小码/远距关键增益）
  if (i === 6) {
    const ry = Math.max(0, Math.min(H - bandH, Math.round(H * 0.5 - bandH / 2)));
    const r = await detectZX(roiScaled(p, rx, ry, rw, bandH, 2, 'b1dg', true), ZX_1D_ONLY);
    if (r.length) return mark(r, 'zx-1d-gray-x2', t0);
    miss(t0); return [];
  }

  // 趟 7：全帧 zxing 兜底（全部格式）
  const r = await detectZX(p.cv);
  if (r.length) return mark(r, 'zx-full', t0);
  miss(t0); return [];
}

/** 多趟解码：原生全帧 → 1D 专项（多窄带 + 灰度）→ 二维/混合 ROI 兜底 → 全帧兜底 */
async function decodeMulti(src) {
  const t0 = performance.now();
  _t0 = t0;
  const p = grabFull(src);
  if (!p) { miss(t0); return []; }
  const W = p.w, H = p.h;

  // T1 原生全帧（最快，抓大码/二维码）
  let r = await detectNative(p.cv);
  if (r.length) return mark(r, 'native-full', t0);

  // T2 1D 专项（弧形/平面一维条码主战场：多窄带 + 灰度放大）
  const oneD = await decode1D(p);
  if (oneD && oneD.length) return oneD;

  // T3 二维/混合中央带 ROI（保留 V2 能力：偏离中央的二维码/堆叠码）
  const rw = Math.round(W * 0.90), rh = Math.round(H * 0.40);
  const rx = Math.round(W * 0.05), ry = Math.round(H * 0.30);
  r = await detectZX(roiScaled(p, rx, ry, rw, rh, 1, 'band'));
  if (r.length) return mark(r, 'zx-roi', t0);

  // T4 中央带 ×2 双线性放大
  r = await detectZX(roiScaled(p, rx, ry, rw, rh, 2, 'band2'));
  if (r.length) return mark(r, 'zx-roi-x2', t0);

  // T5 全帧 zxing tryHarder 兜底（含全部格式）
  r = await detectZX(p.cv);
  if (r.length) return mark(r, 'zx-full', t0);

  miss(t0);
  return [];
}

window.BarcodeDecode = {
  /** 解码所有条码（内部多趟，命中即返）——一次性跑完整管线，耗时较高，适合单张图片 */
  async decode(src) { return dedupe(await decodeMulti(src)); },
  /** 仅取第一个命中 */
  async decodeFirst(src) { return (await this.decode(src))[0] || null; },
  /**
   * 分帧单趟解码（V5.0.8f 修复「扫不出 + 手输卡」）：
   *  完整管线单帧要跑 10+ 次 wasm（数百 ms～1s+），导致
   *  ① 有效帧率仅 1~2fps，对焦窗口内抓不到清晰帧 → 弧面/小码扫不出；
   *  ② wasm 长时间独占主线程 → 手动输入条码时键盘逐字卡顿。
   *  本方法把管线拆成多趟、每次调用只跑一趟并轮转，单帧耗时降到 1/N，
   *  帧率提升一个量级，主线程得以响应键盘输入。
   *  用法：循环调用本方法即可（命中即返回结果，未命中返回空数组）。
   */
  async decodeStep(src) { return dedupe(await decodeStep(src)); },
  /** 运行统计（扫码 UI 显示：帧数/命中/耗时/引擎） */
  stats,
  /** 引擎就绪状态与真实错误（V5.0.8g：wasm 曾长期 404 却静默失败） */
  zxState: ZX_STATE,
  /** 设备原生扫码能力探测（V5.0.8h：BarcodeDetector 是否可用/是否含一维码） */
  nativeCap: NATIVE_CAP,
  /** 等待原生能力探测完成（供 UI 异步取用） */
  nativeReady: NATIVE_READY,
  /** 是否可用（模块已加载即可用；wasm 在首次 decode 时按需拉取） */
  ready: true,
};
console.info('[BarcodeDecode] V3.2 已加载（1D 多窄带 + Otsu 灰度 + 安全内缩 + 分帧 decodeStep + wasm 路径修复）', ZX_STATE);
