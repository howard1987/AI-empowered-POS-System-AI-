/**
 * V4.11 · 向量索引与检索服务（ai.emb.ts）—— Chinese-CLIP 图像检索 + 中文商品名 rerank
 *   - 图像索引：已审核/已入库样本逐张编码为 512 维向量（Chinese-CLIP ViT-B/16 量化），
 *     存 ai_samples.embedding（JSONB）。pgvector 在本机 PG 不可用 → JSONB + 应用层余弦。
 *   - rerank（V4.11 新增）：图像-图像检索只给"长得像"；易混 SKU（白瓶+红标）区分度弱。
 *     第二信号 = 识别帧图像 × 中文商品名 的图文对齐（Chinese-CLIP 文本塔，可读出瓶身品牌字）。
 *     融合：score = 图像相似度 + 0.1 × 文本相似度组内归一化，重排后进入三门槛判定。
 *   - 时机：店长审核通过（已入库）自动索引单张；「AI 训练台」一键建索引/强制重建（换模型后全量重算）。
 *   - 识别帧落盘：命中时节流保存（10s 节流），供纠正链路取图。
 */
import { q } from '../common/db';
import { PRODUCT_VISIBLE } from '../common/sql';   // V5.0.0 商品可售可见性
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { clipcnEmbedImage, clipcnEmbedText, cnCosine, clipcnReady, CLIPCN_MODEL_TAG } from './ai.clipcn';
import { ppshituEmbedImage, ppshituReady, PPSHITU_MODEL_TAG } from './ai.ppshitu';
import { segmentItems, cropItemBase64, SegBox, SegResult } from './ai.seg';
import { segmentItemsYolo } from './ai.seg.yolo';
import { UPLOADS_DIR, uploadsFilePath, saveUploadImage } from '../common/uploads';

/* ── V5.0.13 特征引擎路由 ──
 * 'ppshitu'（默认 auto 首选）：PP-ShiTuV2 度量学习特征，SKU 级细粒度区分
 *   （实测跨商品余弦 ≤0.09，CLIP 为 0.95+ 饱和区）；
 * 'clipcn'：Chinese-CLIP 图文对齐（含文本塔 rerank；回退引擎）。
 * 设置 ai.feature.engine：auto（默认，模型在即用 ppshitu）/ clipcn / ppshitu。
 * 两套引擎的相似度量纲不同 → 三门槛阈值按引擎各自成组（ai.emb.* 与 ai.emb.pp.*），
 * embedding 以各自 emb_model tag 存储，切换后旧向量视为 stale，训练台重建索引即可。 */
export type FeatureEngine = 'ppshitu' | 'clipcn';
export async function featureEngine(): Promise<FeatureEngine> {
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.feature.engine'`);
    const v = String(r[0]?.value ?? 'auto');
    if (v === 'clipcn') return 'clipcn';
    if (v === 'ppshitu') return ppshituReady() ? 'ppshitu' : 'clipcn';
    return ppshituReady() ? 'ppshitu' : 'clipcn';   // auto
  } catch { return 'clipcn'; }
}
export async function activeTag(): Promise<string> {
  return (await featureEngine()) === 'ppshitu' ? PPSHITU_MODEL_TAG : CLIPCN_MODEL_TAG;
}
/** 按当前引擎嵌入图像 */
export async function embedImage(base64: string): Promise<{ vector: number[]; ms: number }> {
  return (await featureEngine()) === 'ppshitu' ? ppshituEmbedImage(base64) : clipcnEmbedImage(base64);
}
/** 余弦统一入口（两个引擎的向量都已 L2 归一化，数学相同） */
export const featCosine = cnCosine;
/** 样本状态口径与视觉知识库（ai.vl.ts）保持一致：只有审核通过的样本参与检索 */
const READY_STATUS = "('已审核','已入库')";
/** rerank 融合权重：图像检索给出排序主体，文本信号组内归一化后加权重排（V4.16.0 起后台可配 ai.rerank.text_weight，默认 0.1） */
const TEXT_WEIGHT_DEFAULT = 0.1;
/** rerank 文本权重（后台可调：越大越信"瓶身品牌字"文本信号，越大也越可能被文字带偏；0=关闭 rerank） */
export async function rerankTextWeight(): Promise<number> {
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.rerank.text_weight'`);
    const v = Number(r[0]?.value ?? NaN);
    return Number.isFinite(v) ? Math.min(0.3, Math.max(0, v)) : TEXT_WEIGHT_DEFAULT;
  } catch { return TEXT_WEIGHT_DEFAULT; }
}
/** rerank 候选池：取图像检索前 N 个商品参与文本重排（多件场景候选卡片仍只展示 topk） */
const RERANK_POOL = 8;

let lastFrameSaveAt = 0;

export interface EmbCandidate { productId: number; name: string; conf: number; rawImgSim?: number; textSim?: number; samplePath: string; }

export async function embEnabled(): Promise<boolean> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.enabled'`);
  return r.length ? r[0].value !== false : true;   // 默认开启
}

export async function embMinConf(): Promise<number> {
  // V5.0.13：PP-ShiTu 空间量纲不同（跨商品 ≤0.09、类内 0.1~0.85），阈值独立成组
  if (await featureEngine() === 'ppshitu') {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.pp.min_conf'`);
    return r.length ? Number(r[0].value ?? 0.15) : 0.15;
  }
  const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.min_conf'`);
  return r.length ? Number(r[0].value ?? 0.72) : 0.72;
}

export async function embTopK(): Promise<number> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.topk'`);
  return r.length ? Number(r[0].value ?? 3) : 3;
}

/** Top1-Top2 最小边距：防止"两个长得像的 SKU"之间摇摆误判（低于边距 → 交给候选卡片人工确认） */
export async function embMargin(): Promise<number> {
  if (await featureEngine() === 'ppshitu') {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.pp.margin'`);
    return r.length ? Number(r[0].value ?? 0.12) : 0.12;
  }
  const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.margin'`);
  return r.length ? Number(r[0].value ?? 0.03) : 0.03;
}

/** 高置信快速通道：Top-1 达到该值视为"近乎样本复拍"，紧凑边距下限降档（仍需边距） */
export async function embStrictConf(): Promise<number> {
  if (await featureEngine() === 'ppshitu') {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.pp.strict_conf'`);
    return r.length ? Number(r[0].value ?? 0.55) : 0.55;
  }
  const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.emb.strict_conf'`);
  return r.length ? Number(r[0].value ?? 0.97) : 0.97;
}

/** 多件识别开关（方案 v3.2 M2：轮廓分割 + 逐件 CLIP 检索，默认开） */
export async function embMultiEnabled(): Promise<boolean> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.multi.enabled'`);
  return r.length ? r[0].value !== false : true;
}

/** 多件逐件采信阈值：crop 相对样本是"换背景/换构图"复拍，相似度系统性低于全帧复拍（CLIP 默认 0.85；PP 空间与单件同值） */
export async function embMultiMinConf(): Promise<number> {
  if (await featureEngine() === 'ppshitu') return embMinConf();
  const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.multi.min_conf'`);
  return r.length ? Number(r[0].value ?? 0.85) : 0.85;
}

/** 引擎就绪（供 ai.module 判断是否启用向量检索层）：任一特征引擎就绪即可 */
export function embModelReady(): boolean {
  return ppshituReady() || clipcnReady();
}

/** 索引状态（训练台面板用）——按当前特征引擎统计 */
export async function embStatus(storeId: number) {
  const tag = await activeTag();
  const tot = await q(
    `SELECT count(*)::int AS n FROM ai_samples WHERE store_id=$1 AND status IN ${READY_STATUS} AND image_path LIKE '/uploads/%'`,
    [storeId]);
  const done = await q(
    `SELECT count(*)::int AS n FROM ai_samples WHERE store_id=$1 AND status IN ${READY_STATUS}
       AND image_path LIKE '/uploads/%' AND embedding IS NOT NULL AND emb_model=$2`,
    [storeId, tag]);
  const prods = await q(
    `SELECT count(DISTINCT product_id)::int AS n FROM ai_samples WHERE store_id=$1 AND status IN ${READY_STATUS}
       AND image_path LIKE '/uploads/%' AND embedding IS NOT NULL AND emb_model=$2`,
    [storeId, tag]);
  const stale = await q(
    `SELECT count(*)::int AS n FROM ai_samples WHERE store_id=$1 AND status IN ${READY_STATUS}
       AND image_path LIKE '/uploads/%' AND embedding IS NOT NULL AND emb_model <> $2`,
    [storeId, tag]);
  const err = await q(
    `SELECT count(*)::int AS n FROM ai_samples WHERE store_id=$1 AND status IN ${READY_STATUS}
       AND image_path LIKE '/uploads/%' AND emb_model='clip-error'`,
    [storeId]);
  return {
    enabled: await embEnabled(),
    engine: await featureEngine(),
    modelReady: (await featureEngine()) === 'ppshitu' ? ppshituReady() : clipcnReady(),
    model: tag,
    total: tot[0]?.n || 0,
    indexed: done[0]?.n || 0,
    stale: stale[0]?.n || 0,
    error: err[0]?.n || 0,
    products: prods[0]?.n || 0,
  };
}

/** 索引单张样本（审核通过后调用；失败静默，由批量重建兜底） */
export async function embIndexOne(sampleId: number): Promise<boolean> {
  try {
    const tag = await activeTag();
    if ((await featureEngine()) === 'ppshitu' ? !ppshituReady() : !clipcnReady()) return false;
    const rows = await q(`SELECT id, image_path FROM ai_samples WHERE id=$1 AND status IN ${READY_STATUS} AND image_path LIKE '/uploads/%'`, [sampleId]);
    if (!rows.length) return false;
    const f = uploadsFilePath(String(rows[0].image_path));
    if (!existsSync(f)) return false;
    const { vector } = await embedImage(readFileSync(f).toString('base64'));
    await q(`UPDATE ai_samples SET embedding=$2, emb_model=$3, emb_at=now() WHERE id=$1`, [sampleId, JSON.stringify(vector), tag]);
    return true;
  } catch { return false; }
}

/** 批量建索引：force=false 只补缺失/旧模型，force=true 全部重算 */
export async function embIndexStore(storeId: number, force = false, limit = 500) {
  const engine = await featureEngine();
  const tag = await activeTag();
  if (engine === 'ppshitu' && !ppshituReady()) throw new Error('PP-ShiTu 模型缺失（backend/models/ppshituv2_general.onnx）');
  if (engine === 'clipcn' && !clipcnReady()) throw new Error('Chinese-CLIP 模型文件缺失（backend/models/clipcn/model_quantized.onnx + vocab.txt）');
  const where = force ? '' : ` AND emb_model IS DISTINCT FROM 'clip-error' AND (embedding IS NULL OR emb_model <> $2::varchar)`;
  const params = force ? [storeId, limit] : [storeId, tag, limit];
  const rows = await q(
    `SELECT id FROM ai_samples WHERE store_id=$1 AND status IN ${READY_STATUS} AND image_path LIKE '/uploads/%'${where} ORDER BY id DESC LIMIT $${params.length}`,
    params);
  let indexed = 0, failed = 0;
  const t0 = Date.now();
  for (const r of rows) {
    if (await embIndexOne(Number(r.id))) { indexed++; continue; }
    failed++;
    // 解码失败的样本（损坏/非 JPEG-PNG）标记 clip-error，增量建索引不再反复重试
    await q(`UPDATE ai_samples SET emb_model='clip-error', emb_at=now() WHERE id=$1`, [Number(r.id)]).catch(() => {});
  }
  return { found: rows.length, indexed, failed, ms: Date.now() - t0, model: tag };
}

/** 商品名/别名文本嵌入（缓存于 ai_name_embs；缺则现算并落库，单次 ~180ms 仅首次）
 *  V5.0.13：仅 clipcn 引擎可用（PP-ShiTu 无文本塔，ppshitu 模式下 rerank 文本信号自动失效） */
async function ensureNameEmb(storeId: number, productId: number, name: string): Promise<number[] | null> {
  if (await featureEngine() !== 'clipcn') return null;
  try {
    const hit = await q(
      `SELECT embedding FROM ai_name_embs WHERE store_id=$1 AND product_id=$2 AND name=$3 AND emb_model=$4`,
      [storeId, productId, name, CLIPCN_MODEL_TAG]);
    if (hit.length) return hit[0].embedding as number[];
    const { vector } = await clipcnEmbedText(name);
    await q(
      `INSERT INTO ai_name_embs (store_id, product_id, name, embedding, emb_model)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (store_id, product_id, name) DO UPDATE SET embedding=EXCLUDED.embedding, emb_model=EXCLUDED.emb_model`,
      [storeId, productId, name, JSON.stringify(vector), CLIPCN_MODEL_TAG]);
    return vector;
  } catch { return null; }
}

/** 商品别名（V4.11.2 别名表落地：口语叫法与档案名解耦） */
async function aliasesOf(storeId: number, productId: number): Promise<string[]> {
  try {
    const rows = await q(`SELECT alias FROM product_aliases WHERE store_id=$1 AND product_id=$2 LIMIT 8`, [storeId, productId]);
    return rows.map((r: any) => String(r.alias)).filter(Boolean);
  } catch { return []; }
}

/** 文本第二信号：识别帧向量 × 商品名/别名（任一叫法命中即取最大值，别名嵌入同样进缓存） */
async function bestTextSim(storeId: number, productId: number, name: string, imageVector: number[]): Promise<number> {
  let best = NaN;
  for (const text of [name, ...(await aliasesOf(storeId, productId))]) {
    const tv = await ensureNameEmb(storeId, productId, text);
    if (tv) {
      const s = cnCosine(imageVector, tv);
      if (isNaN(best) || s > best) best = s;
    }
  }
  return best;
}

/** 图像向量 → 每商品最大相似度映射（样本行由调用方加载一次，多件逐框复用） */
function bestByProduct(vector: number[], rows: any[]): Map<number, EmbCandidate> {
  const best = new Map<number, EmbCandidate>();
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (!pid) continue;
    const sim = cnCosine(vector, r.embedding as any);
    const prev = best.get(pid);
    if (!prev || sim > prev.conf) {
      best.set(pid, { productId: pid, name: String(r.product_name || `商品${pid}`), conf: Math.round(sim * 1000) / 1000, samplePath: String(r.image_path) });
    }
  }
  return best;
}

/** rerank：文本信号组内归一化加权重排（单件/逐件共用；权重后台可配 V4.16.0） */
async function rerankCandidates(storeId: number, imageVector: number[], best: Map<number, EmbCandidate>, topK: number, weight = TEXT_WEIGHT_DEFAULT): Promise<{ candidates: EmbCandidate[]; reranked: boolean }> {
  let candidates = [...best.values()].sort((a, b) => b.conf - a.conf);
  let reranked = false;
  const pool = candidates.slice(0, Math.max(topK, RERANK_POOL)).map(c => ({ c, img: c.conf, ts: NaN as number }));
  if (weight > 0 && pool.length >= 2) {
    for (const x of pool) x.ts = await bestTextSim(storeId, x.c.productId, x.c.name, imageVector);
    const valid = pool.filter(x => !isNaN(x.ts));
    if (valid.length >= 2) {
      const min = Math.min(...valid.map(x => x.ts)), max = Math.max(...valid.map(x => x.ts));
      const span = max - min;
      for (const x of pool) {
        x.c.rawImgSim = x.img;
        if (!isNaN(x.ts)) {
          x.c.textSim = Math.round(x.ts * 1000) / 1000;
          const norm = span > 1e-9 ? (x.ts - min) / span : 0.5;   // 全体几乎相等时不偏袒
          x.c.conf = Math.round(Math.min(1, x.img + weight * norm) * 1000) / 1000;
        }
      }
      candidates = pool.map(x => x.c).sort((a, b) => b.conf - a.conf);
      reranked = true;
    }
  }
  return { candidates: candidates.slice(0, Math.max(1, topK)), reranked };
}

/** 加载门店可检索样本行（图像向量已索引；多件逐框复用，一次查询）——按当前特征引擎的 tag 过滤 */
async function loadSearchRows(storeId: number) {
  return q(
    `SELECT s.product_id, p.name AS product_name, s.image_path, s.embedding
       FROM ai_samples s JOIN products p ON p.id = s.product_id
      WHERE s.store_id=$1 AND s.status IN ${READY_STATUS} AND s.image_path LIKE '/uploads/%'
        AND s.embedding IS NOT NULL AND s.emb_model=$2 AND ${PRODUCT_VISIBLE('$1')} AND p.status=1`,
    [storeId, await activeTag()]);
}

/**
 * 识别帧 → Chinese-CLIP 图像检索 → 中文商品名/别名 rerank（按商品聚合取最大图像相似度）
 * 返回重排后的 Top-K 候选（带 conf=图像相似度、textSim=图文对齐相似度），不设阈值——判定交给调用方。
 */
export async function embSearch(frameBase64: string, storeId: number, topK = 3): Promise<{ candidates: EmbCandidate[]; sampleTotal: number; ms: number; framePath: string | null; reranked: boolean }> {
  const t0 = Date.now();
  const { vector } = await embedImage(frameBase64);
  const rows = await loadSearchRows(storeId);
  const { candidates, reranked } = await rerankCandidates(storeId, vector, bestByProduct(vector, rows), topK);
  return { candidates, sampleTotal: rows.length, ms: Date.now() - t0, framePath: saveFrameThrottled(frameBase64), reranked };
}

export interface MultiCropResult {
  box: SegBox;
  candidates: EmbCandidate[];
  reranked: boolean;
  ms: number;
}

export interface EmbMultiResult {
  multi: boolean;
  boxes: SegBox[];
  crops: MultiCropResult[];
  sampleTotal: number;
  segMs: number;
  ms: number;
  framePath: string | null;
  /** V4.27.0 定位引擎：yolo=检测模型框选（任意背景鲁棒）；contour=零训练轮廓分割兜底 */
  segEngine: 'yolo' | 'contour';
}

/**
 * 方案 v3.2 M2 · 多件识别：识别帧 → 定位每件（V4.27.0 起 YOLO 检测模型优先，未配置/失败回落
 * 零训练轮廓分割）→ 逐件裁剪 → Chinese-CLIP 检索 + 别名 rerank。
 * 单件画面（0~1 个有效框）返回 multi=false，调用方回落单件管线。
 * 每件独立给出候选与判定信号（conf/rawImgSim/textSim），聚合计数与门槛判定由 ai.module 完成。
 */
export async function embSearchMulti(frameBase64: string, storeId: number, topK = 3): Promise<EmbMultiResult> {
  const t0 = Date.now();
  // V4.27.0：YOLO 检测式定位优先（ai.seg.model_id），未配置/推理失败 → 轮廓分割兜底，链路不阻断
  const yoloSeg = await segmentItemsYolo(frameBase64).catch((): SegResult | null => null);
  const seg = yoloSeg ?? await segmentItems(frameBase64);
  const segEngine: 'yolo' | 'contour' = yoloSeg ? 'yolo' : 'contour';
  /* V5.0.12 主体优先：只要分割出 ≥1 个主体框就走"逐件裁剪检索"——
   * 裁剪后的 crop 是商品本体主导，消除了全帧嵌入被台面/背景主导导致的
   * "不同商品相互 0.96~0.98、排序翻转"误判（真机乱识别根因）。 */
  let boxes = seg.boxes;
  if (boxes.length) {
    /* V5.0.12b 治"红框框到背景"（真机实测：轮廓分割把画面边缘闯入的白色包装盒
     * 当成主体，透明瓶身反而落选）：多框时丢弃"贴画面边缘 + 远离中心"的框——
     * 用户对准拍摄时商品主体在画面中央是天然先验；贴边且偏角落的框大概率是背景物。
     * 只剩 1 个框时无条件保留（宁可用差框不空转）。并按中心度排序（供前端高亮/日志）。 */
    if (boxes.length > 1) {
      const w0 = seg.w, h0 = seg.h;
      const centrality = (b: SegBox) => {
        const dx = (b.x + b.w / 2 - w0 / 2) / (w0 / 2), dy = (b.y + b.h / 2 - h0 / 2) / (h0 / 2);
        return 1 - Math.min(1, Math.hypot(dx, dy));
      };
      const edgeTouch = (b: SegBox) =>
        b.x <= w0 * 0.02 || b.y <= h0 * 0.02 || (b.x + b.w) >= w0 * 0.98 || (b.y + b.h) >= h0 * 0.98;
      const kept = boxes.filter(b => !(edgeTouch(b) && centrality(b) < 0.55));
      if (kept.length) boxes = [...kept].sort((a, b) => centrality(b) - centrality(a));
    }
  } else {
    /* 0 框（分割失败/背景过乱）：回退"中央虚拟框"（60%×60%）——
     * 仍然主体优先（用户对准拍摄时主体在中央），绝不退回全帧（全帧=背景主导误判根源），
     * 且前端红框始终有得画。 */
    const w0 = seg.w, h0 = seg.h;
    if (!w0 || !h0) return { multi: false, boxes: [], crops: [], sampleTotal: 0, segMs: seg.ms, ms: Date.now() - t0, framePath: null, segEngine };
    boxes = [{ x: Math.round(w0 * 0.2), y: Math.round(h0 * 0.2), w: Math.round(w0 * 0.6), h: Math.round(h0 * 0.6), frac: 0.36 }];
  }
  const rows = await loadSearchRows(storeId);
  const w = await rerankTextWeight();
  const crops: MultiCropResult[] = [];
  for (const box of boxes) {
    const ct0 = Date.now();
    try {
      const cropB64 = await cropItemBase64(frameBase64, box);
      const { vector } = await embedImage(cropB64);
      const { candidates, reranked } = await rerankCandidates(storeId, vector, bestByProduct(vector, rows), topK, w);
      crops.push({ box, candidates, reranked, ms: Date.now() - ct0 });
    } catch {
      crops.push({ box, candidates: [], reranked: false, ms: Date.now() - ct0 });
    }
  }
  return { multi: true, boxes, crops, sampleTotal: rows.length, segMs: seg.ms, ms: Date.now() - t0, framePath: saveFrameThrottled(frameBase64), segEngine };
}

/** 识别帧节流落盘（10s 一张，与 ai.sample-match.ts 策略一致；供纠正链路/样本回流取图；V4.15.5 按月分目录） */
export function saveFrameThrottled(frameBase64: string): string | null {
  try {
    const raw = String(frameBase64 || '').replace(/^data:image\/\w+;base64,/, '');
    if (!raw || Date.now() - lastFrameSaveAt < 10_000) return null;
    const p = saveUploadImage(Buffer.from(raw, 'base64'), `frame_${Date.now()}.jpg`);
    lastFrameSaveAt = Date.now();
    return p;
  } catch { return null; }
}
