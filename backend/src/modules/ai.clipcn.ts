/**
 * V4.11 · Chinese-CLIP 图文编码引擎（ai.clipcn.ts）—— 替换 ViT-B/32 通用模型 + 提供中文文本编码
 * 背景：V4.10.2 实测 CLIP ViT-B/32 对"白瓶+红标"类商品区分度弱（益达口香糖 vs 宜简水边距仅 0.021）。
 *   Chinese-CLIP（OFA-Sys，ViT-B/16）在中文电商/零售语料（MUGE 等）上训练：
 *   ① 图像塔对中文商品视觉分布更贴合；② 文本塔可读中文——商品名（含品牌字样）与识别帧直接图文对齐，
 *   为 rerank 提供独立于图像-图像检索的第二信号。
 * 模型：backend/models/clipcn/model_quantized.onnx（Xenova/chinese-clip-vit-base-patch16 量化，图文合并导出）
 *   + vocab.txt（Chinese BERT WordPiece 词表）。纯本地推理，图片文本均不出店。
 * 预处理：与 OpenAI CLIP 相同 mean/std（preprocessor_config.json 确认），shortest-side 224 + 中心裁剪。
 */
import * as ort from 'onnxruntime-node';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

const MODELS_DIR = path.join(__dirname, '..', '..', 'models');
const CN_MODEL_FILE = 'clipcn/model_quantized.onnx';
const CN_VOCAB_FILE = 'clipcn/vocab.txt';
/** 存入 ai_samples.emb_model / ai_name_embs.emb_model，换模型后可识别重建索引。
 *  V5.0.12：预处理加中心裁剪（抑制桌面背景主导），向量口径变化 → tag 同步升级，
 *  旧向量自动视为 stale（emb_status 可见），需在训练台「重建索引」后恢复检索。 */
export const CLIPCN_MODEL_TAG = 'clipcn-vit-b16-quant-c82';
/** V5.0.12 中心裁剪比例：真机实测全帧嵌入被背景/台面主导——同一桌面拍的不同商品
 *  相互相似度高达 0.96~0.98、Top1-Top2 边距仅 0.02~0.04 且排序会翻转（拍偏帧真品排第三），
 *  门槛再严也救不了排序错误。先中心裁掉 ~18% 边缘（背景占比最高的区域）再走 CLIP 标准预处理，
 *  样本与识别帧同口径，让特征向"商品本体"集中。 */
const CN_CROP_RATIO = 0.82;
const CN_SIZE = 224;
const CN_TEXT_LEN = 52;                    // Chinese-CLIP 官方文本最大长度（含 [CLS]/[SEP]）
// 与 ai.clip.ts 相同的 CLIP 归一化参数（Chinese-CLIP preprocessor_config 一致）
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const CLS_ID = 101, SEP_ID = 102, UNK_ID = 100;

let session: ort.InferenceSession | null = null;
let vocab: Map<string, number> | null = null;

export function clipcnModelPath(): string {
  return path.join(MODELS_DIR, CN_MODEL_FILE);
}

/** 模型+词表是否就绪 */
export function clipcnReady(): boolean {
  return existsSync(clipcnModelPath()) && existsSync(path.join(MODELS_DIR, CN_VOCAB_FILE));
}

async function loadSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (!clipcnReady()) throw new Error('Chinese-CLIP 模型文件缺失（backend/models/clipcn/model_quantized.onnx + vocab.txt）');
  session = await ort.InferenceSession.create(clipcnModelPath(), { executionProviders: ['cpu'] });
  return session;
}

/* ── Chinese BERT WordPiece 分词 ─────────────────────────────── */

function loadVocab(): Map<string, number> {
  if (vocab) return vocab;
  const lines = readFileSync(path.join(MODELS_DIR, CN_VOCAB_FILE), 'utf8').split('\n');
  vocab = new Map();
  lines.forEach((l, i) => { const t = l.replace(/\r$/, ''); if (t) vocab!.set(t, i); });
  return vocab;
}

/** CJK 汉字（含扩展A/兼容区）：逐字切开，BERT 中文规范 */
function isCJK(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
}

/** BERT basic：小写化；CJK/非字母数字字符前后加空格切分 */
function basicTokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  let spaced = '';
  for (const ch of lowered) {
    if (isCJK(ch)) spaced += ` ${ch} `;
    else if (/[\w]/.test(ch)) spaced += ch;      // 字母数字连在一起（后面 WordPiece 再切）
    else spaced += ' ';                          // 其余（标点/符号/全角）当分隔符
  }
  return spaced.split(/\s+/).filter(Boolean);
}

/** WordPiece 贪心最长匹配（延续子词加 ## 前缀） */
function wordPiece(token: string, v: Map<string, number>): number[] {
  if (token.length > 100) return [UNK_ID];
  const out: number[] = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length, cur: string | null = null;
    while (start < end) {
      let sub = token.slice(start, end);
      if (start > 0) sub = '##' + sub;
      if (v.has(sub)) { cur = sub; break; }
      end--;
    }
    if (cur === null) return [UNK_ID];           // 整词无法覆盖 → [UNK]（BERT 标准）
    out.push(v.get(cur)!);
    start = end;
  }
  return out;
}

/** 中文文本 → input ids（[CLS] … [SEP]，截断到 CN_TEXT_LEN） */
export function tokenizeChinese(text: string): number[] {
  const v = loadVocab();
  const ids: number[] = [CLS_ID];
  for (const w of basicTokenize(String(text || ''))) {
    ids.push(...wordPiece(w, v));
    if (ids.length >= CN_TEXT_LEN - 1) break;
  }
  ids.push(SEP_ID);
  return ids.slice(0, CN_TEXT_LEN);
}

/* ── 张量预处理 ─────────────────────────────────────────────── */

/** 图片 base64 → NCHW Float32（shortest-side 224 + 中心裁剪，CLIP 标准预处理） */
async function preprocessImage(imageBase64: string): Promise<Float32Array> {
  const { Jimp } = await import('jimp');
  const buf = Buffer.from(String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (!buf.length) throw new Error('图片 base64 为空');
  const img = await Jimp.read(buf);
  const w0 = img.bitmap.width, h0 = img.bitmap.height;
  if (!w0 || !h0) throw new Error('图片解码失败');
  // V5.0.12：先中心裁剪（样本/识别帧同口径），再走 CLIP 标准 shortest-side + 中心裁剪
  if (CN_CROP_RATIO < 1) {
    const cw = Math.round(w0 * CN_CROP_RATIO), ch = Math.round(h0 * CN_CROP_RATIO);
    img.crop({ x: Math.floor((w0 - cw) / 2), y: Math.floor((h0 - ch) / 2), w: cw, h: ch });
  }
  const wc = img.bitmap.width, hc = img.bitmap.height;   // 裁剪后的实际尺寸
  const scale = Math.max(CN_SIZE / wc, CN_SIZE / hc);
  img.scale(scale);
  const w1 = img.bitmap.width, h1 = img.bitmap.height;
  const x0 = Math.max(0, Math.floor((w1 - CN_SIZE) / 2));
  const y0 = Math.max(0, Math.floor((h1 - CN_SIZE) / 2));
  const data = new Float32Array(3 * CN_SIZE * CN_SIZE);
  for (let y = 0; y < CN_SIZE; y++) {
    for (let x = 0; x < CN_SIZE; x++) {
      const si = ((y + y0) * w1 + (x + x0)) * 4;
      const di = (y * CN_SIZE + x) * 3;
      data[di] = (img.bitmap.data[si] / 255 - MEAN[0]) / STD[0];
      data[di + 1] = (img.bitmap.data[si + 1] / 255 - MEAN[1]) / STD[1];
      data[di + 2] = (img.bitmap.data[si + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return data;
}

/** 中文文本 → 定长 token 张量组（导出图输入：input_ids/attention_mask，无 token_type_ids） */
function textTensor(text: string) {
  const ids = tokenizeChinese(text);
  const inputIds = new BigInt64Array(CN_TEXT_LEN).fill(0n);
  const mask = new BigInt64Array(CN_TEXT_LEN).fill(0n);
  ids.forEach((id, i) => { inputIds[i] = BigInt(id); mask[i] = 1n; });
  return {
    input_ids: new ort.Tensor('int64', inputIds, [1, CN_TEXT_LEN]),
    attention_mask: new ort.Tensor('int64', mask, [1, CN_TEXT_LEN]),
  };
}

/** 图像塔占位 token（图文合并导出，文本塔必须有合法输入；长度=CN_TEXT_LEN，[CLS]/[SEP]+pad） */
function dummyText() {
  const ids = new BigInt64Array(CN_TEXT_LEN).fill(0n);
  const mask = new BigInt64Array(CN_TEXT_LEN).fill(0n);
  ids[0] = 101n; mask[0] = 1n; ids[1] = 102n; mask[1] = 1n;
  return {
    input_ids: new ort.Tensor('int64', ids, [1, CN_TEXT_LEN]),
    attention_mask: new ort.Tensor('int64', mask, [1, CN_TEXT_LEN]),
  };
}

function l2normalize(arr: Float32Array | number[]): number[] {
  const v = Array.from(arr);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => Math.round((x / n) * 1e6) / 1e6);
}

export interface ClipcnEmbedResult { vector: number[]; ms: number; }

/** 图片 → 512 维 L2 归一化向量（Chinese-CLIP 图像塔） */
export async function clipcnEmbedImage(imageBase64: string): Promise<ClipcnEmbedResult> {
  const t0 = Date.now();
  const s = await loadSession();
  const feeds: Record<string, ort.Tensor> = { pixel_values: new ort.Tensor('float32', await preprocessImage(imageBase64), [1, 3, CN_SIZE, CN_SIZE]), ...dummyText() };
  const out = await s.run(feeds);
  const emb = out['image_embeds'] || out[Object.keys(out)[0]];
  return { vector: l2normalize(emb.data as Float32Array), ms: Date.now() - t0 };
}

/** 中文文本 → 512 维 L2 归一化向量（Chinese-CLIP 文本塔，商品名嵌入用） */
export async function clipcnEmbedText(text: string): Promise<ClipcnEmbedResult> {
  const t0 = Date.now();
  const s = await loadSession();
  const feeds: Record<string, ort.Tensor> = { ...textTensor(text) };
  // 图像塔喂全零像素占位（只取 text_embeds）
  feeds.pixel_values = new ort.Tensor('float32', new Float32Array(3 * CN_SIZE * CN_SIZE), [1, 3, CN_SIZE, CN_SIZE]);
  const out = await s.run(feeds);
  const emb = out['text_embeds'] || out[Object.keys(out).find(k => /text/i.test(k))!];
  return { vector: l2normalize(emb.data as Float32Array), ms: Date.now() - t0 };
}

/** 余弦相似度（向量已 L2 归一化或原始数组均可） */
export function cnCosine(a: number[] | string, b: number[] | string): number {
  const va = typeof a === 'string' ? JSON.parse(a) : a;
  const vb = typeof b === 'string' ? JSON.parse(b) : b;
  if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i++) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
