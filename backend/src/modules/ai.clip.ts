/**
 * M2 · CLIP 视觉向量引擎（ai.clip.ts）—— 实时识别主路径的第一层图像识别
 * 背景（方案 v3.1）：实时识别错用 VL 大模型（自回归逐字生成）导致单件 3-10s、多件分钟级。
 *   行业成熟方案（好想来/零食有鸣）= 专用小模型毫秒级 + VL 不进实时路径。
 * 本引擎：CLIP ViT-B/32（量化 ONNX，153MB，onnxruntime-node CPU 推理）把图片编码为 512 维向量，
 *   样本库预先建向量索引，识别帧 → 向量 → 与样本向量做余弦相似度 → Top-K 候选。
 *   实测 CPU 单帧推理 ~130ms，检索（数千样本内）毫秒级 → 单件识别全程 <500ms。
 * 管线分工：条码（前端 BarcodeDetector/扫码枪，conf=1）→ CLIP 向量检索（本引擎）→ VL 兜底（ai.vl.ts）→ dHash（ai.sample-match.ts）。
 * 说明：纯本地推理，图片不出店；模型文件 backend/models/clip/model_quantized.onnx（Xenova/clip-vit-base-patch32 量化版）。
 */
import * as ort from 'onnxruntime-node';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

const MODELS_DIR = path.join(__dirname, '..', '..', 'models');
export const CLIP_MODEL_FILE = 'clip/model_quantized.onnx';
export const CLIP_MODEL_TAG = 'clip-vit-b32-quant';   // 存入 ai_samples.emb_model，换模型后可识别重建索引
const CLIP_SIZE = 224;
// CLIP 官方归一化参数（OpenAI CLIP 预处理）
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
// 文本分支哑 token（CLIP BOS/EOS）：模型为图文双塔完整导出，文本分支给合法占位输入，仅取 image_embeds
const DUMMY_IDS = BigInt64Array.from([49406n, 49407n, ...Array(75).fill(0n)]);

let session: ort.InferenceSession | null = null;
let sessionErr = '';

export function clipModelPath(): string {
  return path.isAbsolute(CLIP_MODEL_FILE) ? CLIP_MODEL_FILE : path.join(MODELS_DIR, CLIP_MODEL_FILE);
}

/** 模型文件是否就绪（存在即视为可加载，加载失败在推理时报错并缓存错误） */
export function clipReady(): boolean {
  return existsSync(clipModelPath());
}

async function loadSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (!clipReady()) throw new Error(`CLIP 模型文件缺失：${CLIP_MODEL_FILE}（请放置 backend/models/clip/model_quantized.onnx）`);
  session = await ort.InferenceSession.create(clipModelPath(), { executionProviders: ['cpu'] });
  return session;
}

/** 解码 base64 → RGB，shortest-side 缩放到 224 后中心裁剪 224×224（CLIP 标准预处理）→ NCHW Float32 */
async function preprocess(imageBase64: string): Promise<Float32Array> {
  const { Jimp } = await import('jimp');
  const buf = Buffer.from(String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (!buf.length) throw new Error('图片 base64 为空');
  const img = await Jimp.read(buf);
  const w0 = img.bitmap.width, h0 = img.bitmap.height;
  if (!w0 || !h0) throw new Error('图片解码失败');
  // shortest-side resize（双线性），再中心裁剪
  const scale = Math.max(CLIP_SIZE / w0, CLIP_SIZE / h0);
  img.scale(scale);
  const w1 = img.bitmap.width, h1 = img.bitmap.height;
  const x0 = Math.max(0, Math.floor((w1 - CLIP_SIZE) / 2));
  const y0 = Math.max(0, Math.floor((h1 - CLIP_SIZE) / 2));
  const data = new Float32Array(3 * CLIP_SIZE * CLIP_SIZE);
  for (let y = 0; y < CLIP_SIZE; y++) {
    for (let x = 0; x < CLIP_SIZE; x++) {
      const si = ((y + y0) * w1 + (x + x0)) * 4;
      const di = (y * CLIP_SIZE + x) * 3;
      data[di] = (img.bitmap.data[si] / 255 - MEAN[0]) / STD[0];
      data[di + 1] = (img.bitmap.data[si + 1] / 255 - MEAN[1]) / STD[1];
      data[di + 2] = (img.bitmap.data[si + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return data;
}

export interface ClipEmbedResult { vector: number[]; ms: number; }

/** 图片 → 512 维 L2 归一化向量（纯本地推理） */
export async function clipEmbed(imageBase64: string): Promise<ClipEmbedResult> {
  const t0 = Date.now();
  const s = await loadSession();
  const pixel = await preprocess(imageBase64);
  const feeds: Record<string, ort.Tensor> = { pixel_values: new ort.Tensor('float32', pixel, [1, 3, CLIP_SIZE, CLIP_SIZE]) };
  // 完整图文模型需要文本分支输入 → 哑 token 占位（只取 image_embeds 输出）
  if (s.inputNames.includes('input_ids')) {
    feeds.input_ids = new ort.Tensor('int64', DUMMY_IDS, [1, 77]);
  }
  if (s.inputNames.includes('attention_mask')) {
    feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from([1n, 1n, ...Array(75).fill(0n)]), [1, 77]);
  }
  const out = await s.run(feeds);
  const emb = out['image_embeds'] || out[Object.keys(out)[0]];
  const arr = emb.data as Float32Array;
  const v = Array.from(arr);
  // L2 归一化（CLIP 输出未归一化，归一后余弦=点积）
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return { vector: v.map(x => Math.round((x / norm) * 1e6) / 1e6), ms: Date.now() - t0 };
}

/** 余弦相似度（两向量均已 L2 归一化时等价点积；此处做完整余弦以兼容旧数据） */
export function cosine(a: number[] | string, b: number[] | string): number {
  const va = typeof a === 'string' ? JSON.parse(a) : a;
  const vb = typeof b === 'string' ? JSON.parse(b) : b;
  if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i++) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
