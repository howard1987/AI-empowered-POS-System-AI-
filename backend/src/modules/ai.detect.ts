/**
 * AI 识别真机推理引擎（设计方案 9 章：识别 mock→真机）
 *   - 图像：jimp 解码 base64 → letterbox 640（保比例+灰边）→ RGB CHW Float32
 *   - 推理：onnxruntime-node（官方库，CPU 推理零 GPU 依赖）session.run
 *   - 输出解析双模式：
 *       classify  —— 输出 [1, nc] 概率 → argmax（识别秤/俯拍整图商品分类）
 *       detect    —— 输出 [1,4+nc,N] 或 [1,N,4+nc] → 阈值过滤 + NMS（YOLOv8 目标检测）
 *   - 类别映射：ai_models.metrics.classes = { "0": {name, productId?}, ... }
 *   - 模型缓存：按 file_path 缓存 InferenceSession（加载 ~百 ms 级，避免每次重建）
 */
import * as ort from 'onnxruntime-node';
import { promises as fsp } from 'fs';
import path from 'path';

const MODELS_DIR = path.join(__dirname, '..', '..', 'models');

/** 模型元信息（来自 ai_models 行） */
export interface AiModelMeta {
  id: number;
  name: string;
  file_path: string;
  mode?: 'classify' | 'detect';
  classes?: Record<string, { name: string; productId?: number }>;
}

export interface DetBox {
  productId: number | null;
  name: string;
  count: number;
  conf: number;
  bbox?: number[];
}

export interface DetResult {
  ok: boolean;
  err?: string;
  boxes: DetBox[];
  latencyMs: number;
  /** 主模型置信度低于兜底阈值（ai.fallback_conf）→ 触发本地大模型兜底 */
  lowConf: boolean;
}

/* ── 图像解码（jimp 纯 JS，跨平台零原生依赖） ── */
export async function decodeImage(imageBase64: string): Promise<{ rgb: Uint8Array; w: number; h: number }> {
  const buf = Buffer.from(imageBase64, 'base64');
  if (!buf.length) throw new Error('图片 base64 为空');
  const { Jimp } = await import('jimp');
  const img = await Jimp.read(buf);
  const { bitmap } = img;
  const { width, height, data } = img.bitmap;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    rgb[j] = data[i * 4];
    rgb[j + 1] = data[i * 4 + 1];
    rgb[j + 2] = data[i * 4 + 2];
  }
  return { rgb, w: width, h: height };
}

/** letterbox：保比例缩放 + 灰边填充到 size×size，返回 CHW Float32（0-1 归一化）+ 坐标还原参数 */
export function letterbox(rgb: Uint8Array, w: number, h: number, size = 640) {
  const scale = Math.min(size / w, size / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const padX = Math.round((size - nw) / 2), padY = Math.round((size - nh) / 2);
  const data = new Float32Array(3 * size * size);
  const src = rgb;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.floor(x / scale), sy = Math.floor(y / scale);
      const si = (sy * w + sx) * 3;
      const di = ((y + padY) * size + (x + padX)) * 3;
      data[di] = src[si] / 255;
      data[di + 1] = src[si + 1] / 255;
      data[di + 2] = src[si + 2] / 255;
    }
  }
  return { data, scale, padX, padY };
}

/* ── Session 缓存（同一模型文件只加载一次） ── */
const sessions = new Map<string, ort.InferenceSession>();
export async function loadSession(filePath: string): Promise<ort.InferenceSession> {
  const cached = sessions.get(filePath);
  if (cached) return cached;
  const root = path.resolve(MODELS_DIR);
  const abs = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(MODELS_DIR, filePath));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`模型路径不合法（P1-M6）：${filePath}`);
  await fsp.access(abs).catch(() => { throw new Error(`模型文件缺失：${filePath}`); });
  const session = await ort.InferenceSession.create(abs, { executionProviders: ['cpu'] });
  sessions.set(filePath, session);
  return session;
}

/** 清空模型缓存（导入新版本激活后调用，避免加载旧文件） */
export function clearSessionCache(): void { sessions.clear(); }

/* ── 输出解析 ── */

/** 分类模式：输出 [1,nc] → argmax */
export function parseClassify(output: Float32Array, classes: Record<string, { name: string; productId?: number }>): DetBox[] {
  if (!output.length) return [];
  let best = 0;
  for (let i = 1; i < output.length; i++) if (output[i] > output[best]) best = i;
  const cls = classes[String(best)] || { name: `类别${best}` };
  return [{ productId: cls.productId ?? null, name: cls.name, count: 1, conf: output[best] }];
}

/** V4.27.1 · YOLO26 端到端（NMS-free）输出解析：[1,max_det,6] 行 = [x1,y1,x2,y2,conf,cls]（letterbox 640 系）
 *  判定条件：dims[2]===6 且 N<1000（标准 detect 输出 N 为网格锚点数 ≥2100，YOLO26 导出 max_det 默认 300）。
 *  端到端模型已内置去重，此处仍做轻量 NMS 兜底（同 cls IoU>0.45，防极端重复框）。 */
export function parseEndToEnd(
  dims: number[], output: Float32Array,
  classes: Record<string, { name: string; productId?: number }>,
  minConf = 0.25, iouTh = 0.45,
): { x1: number; y1: number; x2: number; y2: number; conf: number; cls: number }[] {
  const n = dims[1];
  const rows: { x1: number; y1: number; x2: number; y2: number; conf: number; cls: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const conf = output[o + 4];
    if (conf < minConf) continue;
    rows.push({ x1: output[o], y1: output[o + 1], x2: output[o + 2], y2: output[o + 3], conf, cls: Math.round(output[o + 5]) });
  }
  rows.sort((a, b) => b.conf - a.conf);
  const keep: typeof rows = [];
  for (const b of rows) {
    const overlap = keep.some(k => k.cls === b.cls && iou(k, b) > iouTh);
    if (!overlap) keep.push(b);
  }
  return keep;
}

/** 检测模式：输入 [1,4+nc,N] 或 [1,N,4+nc]（YOLOv8），阈值过滤 + NMS（IoU 0.45） */
export function parseDetect(
  dims: number[], output: Float32Array,
  classes: Record<string, { name: string; productId?: number }>,
  minConf = 0.25, iouTh = 0.45,
): DetBox[] {
  if (dims.length !== 3) throw new Error(`检测模型输出须为 3 维，实际 ${dims.length} 维`);
  const nc = Object.keys(classes || {}).length;
  if (!nc) throw new Error('检测模型缺少类别映射 classes');
  let n = 0, stride = 0, transposed = false;
  if (dims[2] === 4 + nc) { n = dims[1]; stride = 4 + nc; transposed = true; } // [1,N,4+nc]
  else if (dims[1] === 4 + nc) { n = dims[2]; stride = 4 + nc; }              // [1,4+nc,N]
  else throw new Error(`检测模型输出维度不符（需 [1,4+nc,N] 或 [1,N,4+nc]）：[${dims.join('x')}]`);
  const boxes: { x1: number; y1: number; x2: number; y2: number; conf: number; cls: number }[] = [];
  const at = (row: number, col: number) => transposed ? output[row * stride + col] : output[col * stride + row];
  for (let i = 0; i < n; i++) {
    let best = 0, bestScore = 0;
    for (let c = 4; c < stride; c++) {
      const s = at(i, c);
      if (s > bestScore) { bestScore = s; best = c - 4; }
    }
    if (bestScore < minConf) continue;
    const cx = at(i, 0), cy = at(i, 1), bw = at(i, 2), bh = at(i, 3);
    boxes.push({ x1: cx - bw / 2, y1: cy - bh / 2, x2: cx + bw / 2, y2: cy + bh / 2, conf: bestScore, cls: best });
  }
  boxes.sort((a, b) => b.conf - a.conf);
  const keep: typeof boxes = [];
  for (const b of boxes) {
    const overlap = keep.some(k => k.cls === b.cls && iou(k, b) > iouTh);
    if (!overlap) keep.push(b);
  }
  return keep.map(b => {
    const cls = classes[String(b.cls)] || { name: `类别${b.cls}` };
    return {
      productId: cls.productId ?? null,
      name: cls.name,
      count: 1,
      conf: b.conf,
      bbox: [b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1],
    };
  });
}

function iou(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** 还原 letterbox 坐标到原图（模型输出 640 系 → 原图系） */
export function toOrig(bbox: number[], scale: number, padX: number, padY: number): number[] {
  return [Math.round((bbox[0] - padX) / scale), Math.round((bbox[1] - padY) / scale),
          Math.round(bbox[2] / scale), Math.round(bbox[3] / scale)];
}

/* ── 主入口：完整推理（V4.27.1 增加并发限流：多收银台同时识别时排队，防 CPU/显存抖动） ── */
const MAX_CONC = Math.max(1, Number(process.env.AI_INFER_MAX_CONCURRENCY) || 2);
let active = 0;
const waiters: (() => void)[] = [];
async function withInferSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONC) await new Promise<void>(r => waiters.push(r));
  active++;
  try { return await fn(); } finally {
    active--;
    const w = waiters.shift();
    if (w) w();
  }
}

export async function runDetection(model: AiModelMeta, imageBase64: string, minConf = 0.25): Promise<DetResult> {
  return withInferSlot(() => runDetectionOnce(model, imageBase64, minConf));
}

async function runDetectionOnce(model: AiModelMeta, imageBase64: string, minConf = 0.25): Promise<DetResult> {
  const t0 = Date.now();
  try {
    const { rgb, w, h } = await decodeImage(imageBase64);
    const { data, scale, padX, padY } = letterbox(rgb, w, h, 640);
    const session = await loadSession(model.file_path);
    const inputName = session.inputNames[0];
    const feeds: Record<string, ort.Tensor> = {
      [inputName]: new ort.Tensor('float32', data, [1, 3, 640, 640]),
    };
    const out = await session.run(feeds);
    const outName = session.outputNames[0];
    const tensor = out[outName];
    const dims = tensor.dims;
    const mode = model.mode || (dims.length === 2 ? 'classify' : 'detect');
    const classes = model.classes || {};
    let boxes: DetBox[];
    if (mode === 'classify' || dims.length === 2) {
      boxes = parseClassify(tensor.data as Float32Array, classes);
    } else if (dims.length === 3 && dims[2] === 6 && dims[1] < 1000) {
      // V4.27.1 YOLO26 端到端（NMS-free）输出 [1,max_det,6]；标准 detect 输出 N≥2100 不可能 <1000
      boxes = parseEndToEnd(dims, tensor.data as Float32Array, classes, minConf).map(b => ({
        productId: classes[String(b.cls)]?.productId ?? null,
        name: classes[String(b.cls)]?.name || `类别${b.cls}`,
        count: 1,
        conf: b.conf,
        bbox: toOrig([b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1], scale, padX, padY),
      }));
    } else {
      boxes = parseDetect(dims, tensor.data as Float32Array, classes, minConf).map(b => ({
        ...b,
        bbox: b.bbox ? toOrig(b.bbox, scale, padX, padY) : undefined,
      }));
    }
    // 无类别映射时按名称回查商品（recognize 层处理）；此处仅透传
    return { ok: true, boxes, latencyMs: Date.now() - t0, lowConf: boxes.some(b => b.conf < minConf) };
  } catch (e: any) {
    return { ok: false, err: e?.message || String(e), boxes: [], latencyMs: Date.now() - t0, lowConf: false };
  }
}

/** V4.27.1 启动预热（Q10 热加载配套）：进程启动即后台加载激活检测模型 + 多件定位模型的 session，
 *  首次收银识别不再吃"百 ms 级冷加载"。热加载本身已由 sessions Map 保证（同文件只 load 一次，
 *  模型切换/激活时 clearSessionCache 定向失效），不存在每请求重复加载。 */
export async function prewarmModels(): Promise<void> {
  try {
    const { q } = await import('../common/db');
    const rows = await q(`SELECT file_path, metrics FROM ai_models WHERE is_active AND task='detect' LIMIT 1`);
    if (rows.length) {
      const m = rows[0];
      await loadSession(String(m.file_path)).catch(() => {});
    }
    const cfg = await q(`SELECT value FROM system_settings WHERE setting_key='ai.seg.model_id'`);
    const segId = Number(cfg[0]?.value ?? 0);
    if (segId > 0) {
      const s = await q(`SELECT file_path FROM ai_models WHERE id=$1`, [segId]);
      if (s.length) await loadSession(String(s[0].file_path)).catch(() => {});
    }
  } catch { /* DB 未就绪等场景静默：首次请求时仍会懒加载 */ }
}
