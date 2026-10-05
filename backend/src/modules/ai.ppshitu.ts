/**
 * V5.0.13 · PP-ShiTuV2 通用识别特征编码器（ai.ppshitu.ts）
 *   - 模型：PaddleClas PP-ShiTuV2 general_PPLCNetV2_base（大规模商品数据 ArcLoss 度量学习预训练）
 *     → paddle2onnx 导出 ONNX（backend/models/ppshituv2_general.onnx），纯本地 CPU 推理，图片不出店。
 *   - 实测（V5.0.13 门店 3 SKU）：跨商品余弦 ≤0.09（CLIP 为 0.95+，互相挤在饱和区），
 *     类内 0.10~0.85、留一检索 Top1 12/13——细粒度 SKU 区分能力数量级优于 CLIP。
 *   - 与 ai.clipcn.ts 同构：embedImage(base64) → L2 向量；无文本塔（rerank 文本信号自动失效）。
 *   - 预处理（官方 inference_general.yaml RecPreProcess）：Resize 224x224 → Normalize(ImageNet) → CHW。
 */
import * as ort from 'onnxruntime-node';
import path from 'path';
import { existsSync } from 'fs';

const MODELS_DIR = path.join(__dirname, '..', '..', 'models');
const PP_MODEL_FILE = 'ppshituv2_general.onnx';
/** 存入 ai_samples.emb_model / ai_name_embs.emb_model；换特征模型后按 tag 识别重建索引 */
export const PPSHITU_MODEL_TAG = 'ppshituv2-general-v1';
const PP_SIZE = 224;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

export function ppshituModelPath(): string {
  return path.join(MODELS_DIR, PP_MODEL_FILE);
}
/** 模型文件是否就绪 */
export function ppshituReady(): boolean {
  return existsSync(ppshituModelPath());
}

let session: ort.InferenceSession | null = null;
async function loadSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (!ppshituReady()) throw new Error('PP-ShiTu 模型缺失（backend/models/ppshituv2_general.onnx）');
  session = await ort.InferenceSession.create(ppshituModelPath(), { executionProviders: ['cpu'] });
  return session;
}

/** 图片 base64 → Float32 NCHW（官方 RecPreProcess：拉伸 224 + ImageNet 归一化 + CHW） */
async function preprocess(imageBase64: string): Promise<Float32Array> {
  const { Jimp } = await import('jimp');
  const buf = Buffer.from(String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (!buf.length) throw new Error('图片 base64 为空');
  const img = await Jimp.read(buf);
  if (!img.bitmap.width || !img.bitmap.height) throw new Error('图片解码失败');
  img.resize({ w: PP_SIZE, h: PP_SIZE });
  const data = new Float32Array(3 * PP_SIZE * PP_SIZE);
  for (let y = 0; y < PP_SIZE; y++) for (let x = 0; x < PP_SIZE; x++) {
    const si = (y * PP_SIZE + x) * 4;
    const r = img.bitmap.data[si] / 255, g = img.bitmap.data[si + 1] / 255, b = img.bitmap.data[si + 2] / 255;
    data[0 * PP_SIZE * PP_SIZE + y * PP_SIZE + x] = (r - MEAN[0]) / STD[0];
    data[1 * PP_SIZE * PP_SIZE + y * PP_SIZE + x] = (g - MEAN[1]) / STD[1];
    data[2 * PP_SIZE * PP_SIZE + y * PP_SIZE + x] = (b - MEAN[2]) / STD[2];
  }
  return data;
}

function l2normalize(arr: Float32Array | number[]): number[] {
  const v = Array.from(arr);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => Math.round((x / n) * 1e6) / 1e6);
}

export interface PpEmbedResult { vector: number[]; ms: number; }

/** 图片 → L2 归一化特征向量（PP-ShiTuV2 识别塔） */
export async function ppshituEmbedImage(imageBase64: string): Promise<PpEmbedResult> {
  const t0 = Date.now();
  const s = await loadSession();
  const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', await preprocess(imageBase64), [1, 3, PP_SIZE, PP_SIZE]) };
  const out = await s.run(feeds);
  const emb = out[s.outputNames[0]];
  return { vector: l2normalize(emb.data as Float32Array), ms: Date.now() - t0 };
}

/** 余弦相似度（与 ai.clipcn.cnCosine 同实现，独立导出避免跨模块耦合） */
export function ppCosine(a: number[] | string, b: number[] | string): number {
  const va = typeof a === 'string' ? JSON.parse(a) : a;
  const vb = typeof b === 'string' ? JSON.parse(b) : b;
  if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i++) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
