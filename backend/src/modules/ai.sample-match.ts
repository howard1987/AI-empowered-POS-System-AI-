/**
 * 样本相似度真实识别（ai.sample-match.ts）
 * 背景：原 mock 引擎不分析图像、直接返回候选商品编造高置信度，真实使用中「拍腿也能识别出商品」。
 * 方案：零依赖真实识别 —— 用 jpeg-js 解码图像 → 8×8 灰度 → dHash 感知哈希（64 bit）
 *       → 与样本库（ai_samples，全部状态，凡已上传即可参与）逐张计算汉明距离，
 *       距离 ≤ 阈值视为同一商品，置信度 = 1 - dist/64。没有任何匹配就返回空结果，
 *       由调用方明确提示「未识别」，绝不编造候选。
 * 说明：哈希按文件路径缓存（样本图不变则只算一次）；识别帧每次现算（<20ms）。
 */
import { readFileSync, existsSync } from 'fs';
import { uploadsFilePath, saveUploadImage } from '../common/uploads';

/* eslint-disable @typescript-eslint/no-var-requires */
const jpeg = require('jpeg-js');
const PNG = require('pngjs').PNG;

/** 汉明距离匹配阈值（64 bit）
 *  dHash 抗亮度/构图变化、但对位移/缩放敏感；aHash 抗位移但对亮度/对比度敏感。
 *  二者取「或」：任一 ≤ 阈值即视为同一商品，显著降低无条码商品的漏匹配。 */
const MATCH_DIST = 20;    // dHash ≤ 20
const MATCH_DIST_A = 10;  // aHash ≤ 10

/** hash 缓存：image_path → { d, a } | null（解码失败） */
const hashCache = new Map<string, { d: number[] | null; a: number[] | null } | null>();
/** 最近一次保存识别帧的时间戳（节流落盘，供纠正链路取图） */
let lastFrameSaveAt = 0;

/** RGB → 灰度 */
const grayOf = (d: Buffer | Uint8Array, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** 任意尺寸 RGBA → 9×8 灰度 → 64 bit dHash（相邻横向梯度，比 aHash 更抗亮度/构图变化） */
function dHash(data: Uint8Array, width: number, height: number): number[] {
  const g: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / 9));
      const sy = Math.min(height - 1, Math.floor((y * height) / 8));
      g.push(grayOf(data, (sy * width + sx) * 4));
    }
  }
  const bits: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0);
  return bits;
}

/** 任意尺寸 RGBA → 8×8 灰度 → 64 bit aHash（平均哈希，抗平移、对亮度/对比度敏感） */
function aHash(data: Uint8Array, width: number, height: number): number[] {
  const g: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / 8));
      const sy = Math.min(height - 1, Math.floor((y * height) / 8));
      g.push(grayOf(data, (sy * width + sx) * 4));
    }
  }
  const avg = g.reduce((a, b) => a + b, 0) / g.length;
  return g.map(v => (v >= avg ? 1 : 0));
}

/** 解码并计算 dHash + aHash；JPEG/PNG 任一可解即算（手机采集多为 PNG）；失败 → null */
function hashBuffer(buf: Buffer): { d: number[] | null; a: number[] | null } {
  try {
    let data: Uint8Array, w = 0, h = 0;
    // PNG（pngjs 同步解码，含透明通道 → RGBA）
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
      const png = PNG.sync.read(buf);
      if (!png.width || !png.height) return { d: null, a: null };
      data = png.data; w = png.width; h = png.height;
    } else {
      // JPEG
      const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      if (!img.width || !img.height) return { d: null, a: null };
      data = img.data; w = img.width; h = img.height;
    }
    return { d: dHash(data, w, h), a: aHash(data, w, h) };
  } catch {
    return { d: null, a: null };
  }
}

/** 样本文件 hash（带缓存，dHash + aHash） */
function sampleHash(imagePath: string): { d: number[] | null; a: number[] | null } | null {
  if (hashCache.has(imagePath)) return hashCache.get(imagePath)!;
  const file = uploadsFilePath(imagePath);
  const h = existsSync(file) ? hashBuffer(readFileSync(file)) : null;
  hashCache.set(imagePath, h);
  return h;
}

/** 汉明距离 */
function hamming(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
}

export interface SampleMatchItem {
  productId: number;
  name: string;
  conf: number;
  dist: number;
  samplePath: string;
  sampleCountForProduct: number;
}

export interface SampleMatchResult {
  items: SampleMatchItem[];
  sampleTotal: number;   // 参与比对的样本张数
  framePath: string | null; // 识别帧落盘路径（节流保存，供纠正/训练）
}

/**
 * 识别帧 ↔ 样本库真实匹配。
 * rows: [{ product_id, product_name, image_path }]（调用方从 ai_samples JOIN products 查出）
 */
export function matchSamples(frameBase64: string, rows: { product_id: any; product_name?: string; image_path: string }[]): SampleMatchResult {
  const raw = String(frameBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  const fh = raw ? hashBuffer(Buffer.from(raw, 'base64')) : null;
  const items: SampleMatchItem[] = [];
  let sampleTotal = 0;

  // 识别帧落盘：仅在命中商品时限流保存（10s 一张），避免自动识别循环刷爆磁盘；V4.15.5 按月分目录
  let framePath: string | null = null;
  if (fh && fh.d && raw && Date.now() - lastFrameSaveAt > 10_000) {
    try {
      framePath = saveUploadImage(Buffer.from(raw, 'base64'), `frame_${Date.now()}.jpg`);
      lastFrameSaveAt = Date.now();
    } catch { framePath = null; }
  }

  if (!fh || !fh.d) return { items, sampleTotal, framePath };

  // 每个商品取最小距离（多张样本任一命中即算）；dHash 或 aHash 任一达标即视为同一商品
  const best = new Map<number, SampleMatchItem>();
  for (const r of rows) {
    const sh = sampleHash(r.image_path);
    if (!sh || !sh.d) continue;                  // 解码失败/非图像 → 跳过
    sampleTotal++;
    const pid = Number(r.product_id);
    if (!pid) continue;
    const distD = hamming(fh.d, sh.d);
    const distA = (fh.a && sh.a) ? hamming(fh.a, sh.a) : 999;
    if (distD > MATCH_DIST && distA > MATCH_DIST_A) continue;
    const dist = Math.min(distD, distA);
    const prev = best.get(pid);
    if (!prev || dist < prev.dist) {
      best.set(pid, {
        productId: pid,
        name: String(r.product_name || `商品${pid}`),
        conf: Math.round((1 - dist / 64) * 100) / 100,
        dist,
        samplePath: r.image_path,
        sampleCountForProduct: 1,
      });
    } else if (prev) {
      prev.sampleCountForProduct++;
    }
  }
  items.push(...[...best.values()].sort((a, b) => a.dist - b.dist));
  return { items, sampleTotal, framePath };
}
