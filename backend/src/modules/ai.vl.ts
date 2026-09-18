/**
 * M2b · 真模型商品识别引擎（vl = Vision-Language，本地 Qwen2.5 VL，Ollama 部署、图片不出店）
 * 设计方案 9 章 / 9.2.7：本地多模态大模型兜底 —— 就是用户说的「训练=把商品视觉特征沉淀成知识库，
 * 同一个商品样本越多轮廓越清晰，识别时调用知识库轮廓做匹配」，而不是简单哈希对比。
 *
 * 实现（少样本视觉定位 / few-shot visual grounding）：
 *   1) 知识库：门店「已审核」样本图按商品聚合，每商品取 1 张参考图（样本越多=参考越充分，轮廓越清晰）。
 *   2) 识别：把实时帧作为第 1 张图、知识库参考图依次追加，连同「编号→商品」清单发给 Qwen2.5 VL，
 *      让模型判断第 1 张图出现了哪些已知商品、数量、置信度（纯多模态推理，非哈希）。
 *   3) 解析模型返回的 JSON → [{product_id,name,count,conf}]；置信度低于阈值丢弃。
 *   4) 兜底：Ollama 不可达 / 知识库为空 / 解析失败 → 上层降级到 dHash 样本匹配，保证识别链路不空转。
 *
 * 复用 ai.ocr.ts 的同款 Ollama 协议（/api/generate，images=base64 数组）。
 */
import { q } from '../common/db';
import { PRODUCT_VISIBLE } from '../common/sql';   // V5.0.0 商品可售可见性
import { readFileSync, existsSync } from 'fs';
import { Jimp } from 'jimp';
import { uploadsFilePath } from '../common/uploads';

const DEFAULT_MODEL = 'qwen2.5vl:3b';   // 本机已部署；可切 qwen2.5vl:7b（设置 ai.ocr.vl_model）
const DEFAULT_BASE = 'http://localhost:11434';
const MAX_REFS = 12;                    // 单次少样本参考图上限（兼顾 3B 上下文窗口与识别延迟）
const MAX_DIM = 640;                    // 参考图/实时帧最长边限制（控制视觉 token 数，避免超出上下文窗口）
const VL_NUM_CTX = 16384;               // 单次推理上下文窗口（本机 qwen2.5vl:3b 默认仅 4096，多图必溢出）

async function getSetting(key: string, fb: any = null): Promise<any> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
  return r.length ? r[0].value : fb;
}

interface VLCandidate { id: number; name: string; refBase64: string | null; }

/** 加载门店视觉知识库：已审核样本图按商品聚合，每商品 1 张参考图 */
async function loadKnowledgeBase(storeId: number): Promise<VLCandidate[]> {
  const rows = await q(
    `SELECT DISTINCT s.product_id, p.name
       FROM ai_samples s JOIN products p ON p.id = s.product_id
      WHERE s.store_id = $1 AND s.status IN ('已审核','已入库') AND s.image_path LIKE '/uploads/%'
        AND ${PRODUCT_VISIBLE('$1')} AND p.status = 1
      ORDER BY s.product_id DESC LIMIT $2`,
    [storeId, MAX_REFS * 3],
  );
  const cands: VLCandidate[] = [];
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (!pid || cands.some(c => c.id === pid)) continue;
    const img = await q(
      `SELECT image_path FROM ai_samples WHERE product_id=$1 AND status IN ('已审核','已入库') AND image_path LIKE '/uploads/%' ORDER BY id DESC LIMIT 1`,
      [pid],
    );
    let refBase64: string | null = null;
    if (img.length) {
      const f = uploadsFilePath(String(img[0].image_path));
      if (existsSync(f)) refBase64 = readFileSync(f).toString('base64');
    }
    cands.push({ id: pid, name: String(r.name || `商品${pid}`), refBase64 });
    if (cands.length >= MAX_REFS) break;
  }
  return cands;
}

function stripB64(s: string): string {
  return String(s || '').replace(/^data:image\/\w+;base64,/, '');
}

/** 等比缩放到最长边 ≤ maxDim，并重编码为 JPEG，降低视觉 token 数；解码失败则原样返回（兜底） */
async function downscaleB64(b64: string, maxDim = MAX_DIM): Promise<string> {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return b64;
    const img = await Jimp.read(buf);
    if (img.bitmap.width > maxDim || img.bitmap.height > maxDim) {
      img.scaleToFit({ w: maxDim, h: maxDim }); // 等比缩放到最长边 maxDim 内
    }
    const out = await img.getBuffer('image/jpeg');
    return out.toString('base64');
  } catch {
    return b64; // 个别样本图损坏 → 不强求，原样传（Ollama 会在该张上自行忽略/报错）
  }
}

async function callVL(base: string, model: string, images: string[], prompt: string, timeoutMs = 60000): Promise<string> {
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST', signal: ctl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, images, stream: false, options: { num_ctx: VL_NUM_CTX } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  const j: any = await res.json().catch((): any => null);
  return String(j?.response || '');
}

/** 从模型自由文本中抽取第一个 JSON 对象（兼容 ```json 围栏 / 多余说明文字） */
function parseVLJson(text: string): any[] {
  const t = String(text || '').trim();
  if (!t) return [];
  // 优先直接用整段解析
  try { const o = JSON.parse(t); return Array.isArray(o?.products) ? o.products : (Array.isArray(o) ? o : []); } catch { /* 继续 */ }
  // 退而求其次：截取首个 { 到末尾最后一个 }
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { const o = JSON.parse(t.slice(s, e + 1)); return Array.isArray(o?.products) ? o.products : (Array.isArray(o) ? o : []); } catch { /* 忽略 */ }
  }
  return [];
}

export interface VLResult { productId: number; name: string; count: number; conf: number; }

/**
 * 真模型识别：返回命中商品列表（已映射到知识库 product_id）。
 * 知识库为空或 Ollama 不可达时抛错，由调用方降级到 dHash。
 */
export async function recognizeWithVL(
  frameBase64: string, storeId: number, scene: string, minConf = 0.3,
): Promise<{ items: VLResult[]; kbSize: number; model: string }> {
  const base = String(await getSetting('ai.llm.base', DEFAULT_BASE)).replace(/\/$/, '');
  const model = String(await getSetting('ai.ocr.vl_model', DEFAULT_MODEL));
  const cands = await loadKnowledgeBase(storeId);
  if (!cands.length) throw new Error('NO_KB: 门店知识库为空（请先在「AI 训练采集」上传并审核商品样本）');
  const refList = cands.filter(c => c.refBase64);
  if (!refList.length) throw new Error('NO_KB: 知识库参考图缺失');

  const frameB64 = await downscaleB64(stripB64(frameBase64));
  const refB64s = await Promise.all(refList.map(c => downscaleB64(c.refBase64 as string)));
  const images = [frameB64, ...refB64s];
  const prompt =
    `你是一个超市商品识别器。第 1 张图是收银台/货架的实时照片。后面 ${refList.length} 张是已知商品的参考照片，顺序对应下列编号：\n` +
    refList.map((c, i) => `#${i + 1} = 商品ID ${c.id}（${c.name}）`).join('\n') + `\n` +
    `请判断第 1 张图中实际出现了哪些已知商品（可能多个），对每个给出数量 count（整数）与置信度 confidence(0-1)。\n` +
    `只输出 JSON，格式：{"products":[{"product_id":<编号>,"count":<整数>,"confidence":<0-1>}]}。` +
    `未出现任何已知商品则输出 {"products":[]}。不要输出多余解释。`;

  const text = await callVL(base, model, images, prompt);
  const parsed = parseVLJson(text);
  const items: VLResult[] = [];
  for (const p of parsed) {
    const pid = Number(p?.product_id);
    const c = refList.find(x => x.id === pid);
    if (!c) continue; // 模型编了知识库外的 id → 丢弃
    const conf = Math.min(1, Math.max(0, Number(p?.confidence ?? 0.5)));
    if (conf < minConf) continue;
    items.push({ productId: c.id, name: c.name, count: Math.max(1, Number(p?.count) || 1), conf });
  }
  return { items, kbSize: refList.length, model };
}
