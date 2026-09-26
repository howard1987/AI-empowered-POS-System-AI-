/**
 * AI 服务模块（设计方案 9 章 / 任务卡 T15：识别 mock→真机、训练闭环、OCR 入库）
 *   - 识别：POST /ai/recognize —— 真实样本相似度匹配（dHash，只认已上传样本的商品，不再模拟）；
 *     或 yolo 引擎（本地 ONNX 真机推理）；置信度低于 ai.fallback_conf → 本地多模态大模型兜底（预留）
 *   - 人工纠正：POST /ai/recognize/:id/correct —— 收银员纠正即训练信号（corrected/corrected_json），
 *     纠正帧自动进样本库（ai_samples.source='识别纠正'）
 *   - 训练闭环：任务（采集/训练/评估）→ 随手拍提交样本 → 店长审核 → 训练完成产出模型版本 → 单活部署切换
 *   - OCR 入库：POST /ai/ocr-intake —— 文本行解析（名称,条码,售价,保质期天），preview 校验 / apply 批量建档
 */
import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q, q1, r2, tx, audit, seqLock } from '../common/db';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { runDetection, clearSessionCache, prewarmModels } from './ai.detect';
import { matchSamples } from './ai.sample-match';
import { recognizeWithVL } from './ai.vl';
import { embSearch, embSearchMulti, embEnabled, embMinConf, embTopK, embMargin, embStrictConf, embModelReady, embMultiEnabled, embMultiMinConf, embStatus, embIndexStore, embIndexOne } from './ai.emb';
import { trackFrame, trackEnabled, stableFrames } from './ai.track';
import { segmentItems } from './ai.seg';
import { segmentItemsYolo } from './ai.seg.yolo';
import { autotrainStatus, autotrainRun, autotrainTick, autotrainBusy, autotrainEnvCheck, autotrainEnvSetup, autotrainEnvJob } from './ai.autotrain';
import { AiModelsController } from './ai.models';
import { AiOcrController, AiSignatureController } from './ai.ocr';
import { uploadsFilePath, saveUploadImage } from '../common/uploads';
import { scheduleFrameCleanup } from './ai.housekeeping';

const cx = (c: any, sql: string, params: any[] = []) => c.query(sql, params).then((r: any) => r.rows);

/** CLIP 三门槛判定（单件/多件逐件共用，V4.10.2 + V4.11 rerank 规则）：
 *  ① rawImgSim ≥ strict_conf：近乎样本复拍，直接命中；
 *  ② min_conf ≤ rawImgSim < strict 且 Top1−Top2 ≥ margin（或 rerank 文本信号同向）：命中；
 *  ③ 达标但边距不足且文本信号不背书 → ambiguous（候选卡片店员点选）；
 *  ④ rawImgSim < min_conf → none（未建库/背景噪声）。
 *  V4.11.4 修复：判定一律按 rawImgSim 重排后进行（方案 v3.2 铁律"融合分只排序"）。
 *  此前在 rerank 后的序列上取 top1/top2——文本翻转排序后 textAgree（比较被改写的 top1/top2 的
 *  textSim）恒真，形成"文本既改写排序又自我佐证"的误命中通路（实测白瓶瓶身文字弱噪声即可触发）。 */
function gateClip(cands: any[], minConf: number, strictConf: number, margin: number): { hit: any | null; ambiguous: boolean; textAgree: boolean } {
  const byImg = [...cands].sort((a, b) => (b.rawImgSim ?? b.conf) - (a.rawImgSim ?? a.conf));
  const top1 = byImg[0], top2 = byImg[1];
  const img1 = top1 ? (top1.rawImgSim ?? top1.conf) : 0;
  const img2 = top2 ? (top2.rawImgSim ?? top2.conf) : 0;
  if (!top1 || img1 < minConf) return { hit: null, ambiguous: false, textAgree: false };
  const strictOk = img1 >= strictConf;
  const textAgree = !!top1.textSim && !!top2?.textSim && top1.textSim > top2.textSim;
  const marginOk = !top2 || (img1 - img2) >= margin || textAgree;
  if (strictOk || marginOk) return { hit: top1, ambiguous: false, textAgree };
  return { hit: null, ambiguous: true, textAgree };
}

/** 模型文件目录（backend/models，相对脚本目录自动适配） */
const MODELS_DIR = join(__dirname, '..', '..', 'models');

/** V4.16.0 P6 候选卡片增强：补齐差异对比字段（类别/售价/单位/规格）+ 近30天销量（使用频率）。
 *  频率只影响候选卡片「展示顺序」（conf + 频率加成 ≤0.03），绝不影响三门槛命中判定（"融合分只排序"铁律不变）。 */
async function enrichCandidates(storeId: number, candidates: any[]): Promise<any[]> {
  if (!candidates.length) return candidates;
  const ids = [...new Set(candidates.map(c => Number(c.productId)).filter(Boolean))];
  if (!ids.length) return candidates;
  try {
    const rows = await q(
      `SELECT p.id, p.sell_price, p.base_unit AS unit, p.spec, p.barcode,
              p.weight_min_g, p.weight_max_g,
              COALESCE(c.name,'未分类') AS category,
            COALESCE((SELECT SUM(si.qty) FROM sale_items si
                       JOIN sales_orders so ON so.id=si.order_id
                       AND so.status IN ('已完成','部分退款') AND so.created_at >= CURRENT_DATE - 30
                      WHERE si.product_id=p.id),0) AS freq30
       FROM products p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.id = ANY($1::bigint[])`, [ids]);
    const m = new Map(rows.map((r: any) => [Number(r.id), r]));
    const fwRow = await q(`SELECT value FROM system_settings WHERE setting_key='ai.rerank.freq_weight'`);
    const fw = Math.min(0.1, Math.max(0, Number(fwRow[0]?.value ?? 0.03) || 0));
    for (const c of candidates) {
      const r = m.get(Number(c.productId));
      if (!r) continue;
      c.category = r.category || '未分类';
      c.sellPrice = r.sell_price != null ? Number(r.sell_price) : null;
      c.unit = r.unit || '';
      c.spec = r.spec || '';
      c.barcode = r.barcode || '';   // V4.27.1 Q5：候选确认须扫条码二次校验
      // V4.27.1 Q7：生鲜单件重量期望区间（g），称重复核用
      if (r.weight_min_g != null || r.weight_max_g != null) {
        c.weightRange = { minG: r.weight_min_g != null ? Number(r.weight_min_g) : null,
                          maxG: r.weight_max_g != null ? Number(r.weight_max_g) : null };
      }
      c.freq = Math.round(Number(r.freq30) * 100) / 100;
      c._score = (c.conf ?? 0) + fw * Math.min(1, (c.freq ?? 0) / 100);
    }
    return candidates.sort((a, b) => (b._score ?? b.conf ?? 0) - (a._score ?? a.conf ?? 0));
  } catch { return candidates; }   // 增强失败不影响识别主链路
}
/** 上传图片目录（V4.15.5：统一走 common/uploads，支持 AI_UPLOADS_DIR 外置与按月子目录） */

/** 手写 ZIP（STORE 无压缩，零依赖）：items = [{name, data: Buffer}] */
function makeZip(items: { name: string; data: Buffer }[]): Buffer {
  const { crc32 } = require('zlib') as any;
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const it of items) {
    const nameBuf = Buffer.from(it.name, 'utf8');
    const crc = crc32(it.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(it.data.length, 18); lh.writeUInt32LE(it.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, it.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(it.data.length, 20); ch.writeUInt32LE(it.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + it.data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const cdStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8); eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...local, ...central, eocd]);
}

@Controller('ai')
export class AiController {
  /** 商品识别（收银端 AI 秤/俯拍摄像头 / 手机端多作业识别）
   *  scene: checkout=收银 intake=入库 return=退货 loss=报损 count=盘点 order=订货 transfer=调拨（mock 引擎按场景选候选）
   */
  @Post('recognize')
  async recognize(@Body() b: { imageBase64?: string; deviceId?: number; expectProductIds?: number[]; simulateFallback?: boolean; scene?: string; mode?: 'single' | 'multi' },
                  @CurrentUser() user: AuthUser) {
    const t0 = Date.now();
    const scene = ['checkout', 'intake', 'return', 'loss', 'count', 'order', 'transfer'].includes(b.scene || '') ? b.scene : 'checkout';
    const engineRow = await q(`SELECT value FROM system_settings WHERE setting_key='ai.engine'`);
    const engine = engineRow[0]?.value || 'mock'; // JSONB → 原生字符串
    const fbRow = await q(`SELECT value FROM system_settings WHERE setting_key='ai.fallback_conf'`);
    const fbConf = Number(fbRow[0]?.value || 0.6);

    let result: any[] | null = null;
    let usedFallback = false, fallbackModel: string | null = null;
    let notice = '';
    let imagePath: string | null = null;
    /* V4.10.1 识别分层：barcode（前端条码先行，conf=1）→ clip（向量检索，毫秒级）→ vl → dhash / onnx */
    let layer = 'barcode';
    let candidates: any[] = [];      // 候选卡片（Top-K，未自动命中时供店员点选确认）
    let clipMs = 0;

    /* ── Chinese-CLIP 向量检索层（V4.11：换模型 + 文本 rerank）：识别帧 → 512 维向量 → 样本库图像余弦
     *    → 中文商品名图文对齐 rerank（可读出瓶身品牌字，专治"白瓶+红标"易混 SKU）→ 三门槛判定：
     *      ① 原始图像相似度 ≥ strict_conf(0.97)：近乎样本复拍，直接命中；
     *      ② min_conf(0.90) ≤ 原始图像 < strict 且 Top1−Top2 ≥ margin(0.03)：明显领先，命中；
     *      ③ 达标但边距不足：若 rerank 后文本信号与 Top1 同向（top1.textSim > top2.textSim）→ 仍命中
     *         （瓶身品牌字可读出时的强佐证）；否则 layer='clip-cand' 跳过 VL 慢兜底，返回候选卡片店员点选；
     *      ④ 原始图像 < min_conf：灰图/未建库商品 → 照旧走 VL/dHash 链路。 ── */
    let clipAmbiguous = false;
    /** V4.16.0 P6 易混 SKU 补拍提示：相近候选无法自动区分时，引导店员补拍侧面/背面样本建库增强 */
    let reshoot: { productIds: number[]; text: string } | null = null;
    /** V4.16.0 P6 多件分步拍引导：单张建议件数 / 已识别件数 / 待确认件数 / 是否建议补拍 */
    let guide: any = null;
    /** V4.27.4 多品同拍采集：过三门槛自动命中的逐件明细（同品最高置信，≤10），供采集链路裁剪入样本库 */
    let cropSamples: { productId: number; name: string; conf: number; cropBox: any }[] = [];
    /** V4.27.5 采集纠错：逐件全量明细（含未命中件 + Top3 候选）——收银员手动纠错后可采，
     *  尽量避免"未识别"整帧浪费；hit=true 的件为自动命中（免纠错直采）。 */
    let cropDetail: { cropBox: any; hit: boolean; productId: number | null; name: string | null; conf: number | null; cands: { productId: number; name: string; conf: number }[] }[] = [];

    /* ── V4.11.2 M2 多件识别（方案 v3.2）：mode='multi' 时先试零训练轮廓分割 + 逐件 CLIP 检索；
     *    每件独立过三门槛 → 命中件按商品聚合计数（确认卡片多件同出），未决件给出候选卡片；
     *    单件画面（分割出 0~1 个有效框）自动回落下方单件管线，前端无需感知。 ── */
    let multiDone = false;
    if (b.mode === 'multi' && b.imageBase64 && (await embEnabled()) && (await embMultiEnabled()) && embModelReady()) {
      try {
        const em = await embSearchMulti(b.imageBase64, user.storeId, await embTopK());
        if (em.multi) {
          // crop 采信阈值放宽（换背景复拍系统性偏低），但 strict/margin 门槛不变，双保险防误判
          const minConf = Math.min(await embMinConf(), await embMultiMinConf());
          const strictConf = await embStrictConf(), margin = await embMargin();
          const counts = new Map<number, { productId: number; name: string; count: number; conf: number }>();
          const candCards = new Map<number, any>();
          const cropHits: { productId: number; name: string; conf: number; cropBox: any }[] = [];   // V4.27.4 多品同拍采集：逐件命中明细
          let ambCrops = 0, lowCrops = 0;
          for (const crop of em.crops) {
            const g = gateClip(crop.candidates, minConf, strictConf, margin);
            if (g.hit) {
              const it = counts.get(g.hit.productId) || { productId: g.hit.productId, name: g.hit.name, count: 0, conf: 0 };
              it.count += 1;
              it.conf = Math.max(it.conf, Math.round(g.hit.conf * 1000) / 1000);
              counts.set(g.hit.productId, it);
              cropHits.push({ productId: g.hit.productId, name: g.hit.name, conf: g.hit.conf, cropBox: crop.box });
              candCards.delete(g.hit.productId);   // 已确认件不再出现在候选卡片
            } else {
              if (g.ambiguous) ambCrops++; else lowCrops++;
              for (const cd of crop.candidates) {
                if (!cd?.productId || counts.has(cd.productId)) continue;
                const prev = candCards.get(cd.productId);
                if (!prev || (cd.rawImgSim ?? cd.conf) > (prev.rawImgSim ?? prev.conf)) {
                  candCards.set(cd.productId, { ...cd, cropBox: crop.box });
                }
              }
            }
          }
          layer = 'clip-multi';
          multiDone = true;
          clipMs = em.ms;
          result = [...counts.values()].map(it => ({ productId: it.productId, name: it.name, count: it.count, conf: it.conf, matched: true }));
          candidates = [...candCards.values()];
          // V4.27.4 多品同拍采集：逐件命中明细（同品取最高置信，≤10 个），供前端裁剪入样本库
          const bestBy = new Map<number, { productId: number; name: string; conf: number; cropBox: any }>();
          for (const c of cropHits) {
            const prev = bestBy.get(c.productId);
            if (!prev || c.conf > prev.conf) bestBy.set(c.productId, c);
          }
          cropSamples = [...bestBy.values()].sort((a, b2) => b2.conf - a.conf).slice(0, 10);
          // V4.27.5 逐件全量明细（含未命中件）：收银员对"待确认/未识别"件手动指定正确商品后可采
          cropDetail = em.crops.slice(0, 12).map(crop => {
            const g = gateClip(crop.candidates, minConf, strictConf, margin);
            return {
              cropBox: crop.box,
              hit: !!g.hit,
              productId: g.hit ? g.hit.productId : null,
              name: g.hit ? g.hit.name : null,
              conf: g.hit ? g.hit.conf : null,
              cands: (crop.candidates || []).slice(0, 3).map(c => ({ productId: Number(c.productId), name: c.name, conf: Number(c.conf) || 0 })),
            };
          });
          imagePath = em.framePath;
          const parts = [`${em.segEngine === 'yolo' ? 'YOLO 定位' : '轮廓分割'} ${em.boxes.length} 件（${em.segMs}ms）`];
          if (result.length) parts.push(`自动确认 ${result.length} 种共 ${result.reduce((a, b2) => a + b2.count, 0)} 件（逐件检索 ${em.ms}ms）`);
          if (ambCrops) parts.push(`${ambCrops} 件外观相近待点选`);
          if (lowCrops) parts.push(`${lowCrops} 件未确认`);
          notice = (result.length || candidates.length) ? `多件识别：${parts.join('，')}` : `多件识别：分割出 ${em.boxes.length} 件，但均未匹配到已建库商品（逐件检索 ${em.ms}ms）`;
          // V4.16.0 P6 分步拍引导：拍完即报件数账，引导补拍
          const recognizedPieces = result.reduce((a, b2) => a + b2.count, 0);
          guide = { suggestedPerShot: '3~5', recognizedKinds: result.length, recognizedPieces,
                    unconfirmedPieces: ambCrops + lowCrops,
                    suggestMore: (ambCrops + lowCrops) > 0 || (em.crops.length >= 3 && recognizedPieces < 3) };
          if (ambCrops > 0) {
            const tops = [...candCards.values()].slice(0, 2);
            if (tops.length >= 2) reshoot = {
              productIds: tops.map(t => Number(t.productId)).filter(Boolean),
              text: `${ambCrops} 件外观相近待确认：建议在「随手拍」为这些商品补拍背面/侧面样本，建库增强后可自动区分` };
          }
        }
      } catch { /* 分割/逐件检索失败不阻断 → 回落单件管线 */ }
    }

    /* ── Chinese-CLIP 向量检索层（V4.11：换模型 + 文本 rerank）：识别帧 → 512 维向量 → 样本库图像余弦
     *    → 中文商品名图文对齐 rerank（可读出瓶身品牌字，专治"白瓶+红标"易混 SKU）→ 三门槛判定：
     *      ① 原始图像相似度 ≥ strict_conf(0.97)：近乎样本复拍，直接命中；
     *      ② min_conf(0.90) ≤ 原始图像 < strict 且 Top1−Top2 ≥ margin(0.03)：明显领先，命中；
     *      ③ 达标但边距不足：若 rerank 后文本信号与 Top1 同向（top1.textSim > top2.textSim）→ 仍命中
     *         （瓶身品牌字可读出时的强佐证）；否则 layer='clip-cand' 跳过 VL 慢兜底，返回候选卡片店员点选；
     *      ④ 原始图像 < min_conf：灰图/未建库商品 → 照旧走 VL/dHash 链路。 ── */
    if (!multiDone && b.imageBase64 && (await embEnabled()) && embModelReady()) {
      try {
        const es = await embSearch(b.imageBase64, user.storeId, await embTopK());
        candidates = es.candidates;
        clipMs = es.ms;
        const g = gateClip(candidates, await embMinConf(), await embStrictConf(), await embMargin());
        const top1 = candidates[0], top2 = candidates[1];
        if (g.hit) {
          layer = 'clip';
          result = [{ productId: g.hit.productId, name: g.hit.name, count: 1, conf: g.hit.conf, matched: true }];
          imagePath = es.framePath;
          notice = `向量检索命中「${g.hit.name}」（图像相似度 ${Math.round((g.hit.rawImgSim ?? g.hit.conf) * 100)}%${g.textAgree ? `，瓶身文字佐证 ${Math.round(g.hit.textSim! * 100)}%` : ''}，图像编码+检索 ${clipMs}ms）`;
        } else if (g.ambiguous) {
          layer = 'clip-cand';
          clipAmbiguous = true;
          notice = `「${top1.name}」(${Math.round((top1.rawImgSim ?? top1.conf) * 100)}%) 与「${top2.name}」(${Math.round((top2.rawImgSim ?? top2.conf) * 100)}%) 外观相近，请从候选卡片点选确认`;
          // V4.16.0 P6 易混补拍提示（建库增强后可自动区分）
          reshoot = { productIds: [Number(top1.productId), Number(top2?.productId)].filter(Boolean),
                      text: `两品外观相近：可在「随手拍」为它们补拍背面/侧面样本，建库增强后即可自动区分` };
        }
      } catch { /* Chinese-CLIP 不可用（缺模型/编码失败）不阻断，继续走既有链路 */ }
    }
    if ((engine === 'mock' || engine === 'sample') && !result) {
      // ★ 真实样本相似度识别（模拟引擎已废除）：
      //   识别帧 ↔ 样本库 dHash 感知哈希比对，距离 ≤ 阈值才算命中同一商品。
      //   没上传过样本的商品绝不可能出现在结果里；无匹配 → 空结果 + 明确提示，绝不编造。
      if (!b.imageBase64) throw new BizException(40003, '真实识别必须传 imageBase64（摄像头帧）。模拟联调模式已按真实使用要求关闭。');
      const srows = await q(
        `SELECT s.product_id, p.name AS product_name, s.image_path
           FROM ai_samples s LEFT JOIN products p ON p.id = s.product_id
          WHERE s.store_id=$1 AND s.image_path LIKE '/uploads/%'
          ORDER BY s.id DESC LIMIT 300`, [user.storeId]);
      const m = matchSamples(b.imageBase64, srows as any[]);
      result = m.items.map(it => ({
        productId: it.productId, name: it.name, count: 1, conf: it.conf,
        samplePath: it.samplePath, matched: true,
      }));
      imagePath = m.framePath;
      layer = 'dhash';
      notice = result.length
        ? `真实识别：识别帧与样本库 ${m.sampleTotal} 张样本逐一比对，命中 ${result.length} 种商品（相似度 ${Math.round(Math.max(...result.map(x => x.conf)) * 100)}%）`
        : `未识别出商品：识别帧与样本库 ${m.sampleTotal} 张样本比对均不匹配。请对准商品正面、保证光线充足、减少背景干扰；若该商品还没上传过样本，请先在「AI 训练采集」拍 6 角度样本——识别只认真实上传过的商品，已不再模拟。`;
    } else if (engine === 'vl' && !result) {
      /* 真模型识别（本地 Qwen2.5 VL，Ollama 部署）：实时帧与门店视觉知识库（已审核样本图）做少样本视觉定位。
       * 不是哈希对比，而是多模态大模型推理。模型不可达 / 知识库为空 → 降级 dHash 样本匹配，识别链路不空转。
       * V4.10.2：CLIP 已给出候选但不确定（clipAmbiguous）时跳过 VL——VL 单帧 3-10s 会拖垮实时节奏，
       * 且外观相近场景 VL 同样可能猜错；正确动作是让店员在候选卡片里点选（快且准）。 */
      if (clipAmbiguous) {
        notice = `向量检索存在多个相近候选（${clipMs}ms），请从候选卡片点选确认；如都不对请改用扫码枪`;
      } else {
      if (!b.imageBase64) throw new BizException(40003, '真模型识别须传 imageBase64（摄像头帧）');
      try {
        const vl = await recognizeWithVL(b.imageBase64, user.storeId, scene, fbConf);
        result = vl.items.map(it => ({ productId: it.productId, name: it.name, count: it.count, conf: it.conf, matched: true }));
        layer = 'vl';
        notice = vl.items.length
          ? `真模型识别（${vl.model}）：实时帧与 ${vl.kbSize} 个知识库商品做少样本视觉定位，命中 ${vl.items.length} 种`
          : `真模型识别（${vl.model}）：实时帧与 ${vl.kbSize} 个知识库商品比对，未匹配到已知商品（可换角度/补光，或该商品尚未采集样本）`;
      } catch (e: any) {
        usedFallback = true; fallbackModel = 'dhash';
        layer = 'dhash';
        const srows = await q(
          `SELECT s.product_id, p.name AS product_name, s.image_path
             FROM ai_samples s LEFT JOIN products p ON p.id = s.product_id
            WHERE s.store_id=$1 AND s.image_path LIKE '/uploads/%'
            ORDER BY s.id DESC LIMIT 300`, [user.storeId]);
        const m = matchSamples(b.imageBase64, srows as any[]);
        result = m.items.map(it => ({
          productId: it.productId, name: it.name, count: 1, conf: it.conf,
          samplePath: it.samplePath, matched: true,
        }));
        imagePath = m.framePath;
        notice = `视觉模型不可用，已降级 dHash 样本匹配${result.length ? `：命中 ${result.length} 种` : '：样本库无匹配'}`;
      }
      }
    } else if (!result) {
      // yolo 真机：加载激活模型（ai_models.is_active）走 ONNX Runtime 真推理
      const active = await q(`SELECT * FROM ai_models WHERE is_active ORDER BY id DESC LIMIT 1`);
      if (!active.length) throw new BizException(50047, '无已部署模型（先在训练台导入/训练并激活）');
      const m = active[0];
      if (!b.imageBase64) throw new BizException(40003, '真机推理须传 imageBase64（收银端摄像头原图）');
      const meta = {
        id: Number(m.id), name: String(m.name), file_path: String(m.file_path),
        mode: (m.metrics?.mode) || 'detect',
        classes: (m.metrics?.classes) || {},
      };
      const det = await runDetection(meta, b.imageBase64, fbConf);
      if (!det.ok) throw new BizException(50050, `模型推理失败：${det.err || '未知错误'}`);
      layer = 'onnx';
      result = det.boxes.map(bx => ({
        productId: bx.productId != null ? Number(bx.productId) : null,
        name: bx.name, count: bx.count, conf: r2(bx.conf), bbox: bx.bbox,
      }));
      usedFallback = det.lowConf; // 主模型置信度低于兜底阈值 → 预留本地多模态兜底
      if (usedFallback) fallbackModel = 'qwen2-vl-2b-instruct-gguf';
      if (!result.length) throw new BizException(50051, '模型未检出商品（置信度均低于阈值，可调低 ai.fallback_conf 或补充训练样本）');
    }
    const latency = Date.now() - t0;
    // V4.16.0 P6：候选卡片补差异字段 + 频率展示排序（不改命中判定）
    if (candidates.length) candidates = await enrichCandidates(user.storeId, candidates);
    // 设备未登记（收银端本地编号不在 devices 表）时落库 NULL，避免外键中断识别链路
    let deviceId: number | null = b.deviceId ?? null;
    if (deviceId != null) {
      const dv = await q(`SELECT id FROM devices WHERE id=$1`, [deviceId]);
      if (!dv.length) deviceId = null;
    }
    /* ── V4.27.0 多帧跟踪平滑（借鉴 ultralytics 跟踪）：连续帧同品匹配 → stable 标注 + EMA 置信度。
     *    只做增量标注（店员信心/前端免重复播报），不改变三门槛命中判定（铁律不变）。 ── */
    if (result && result.length && (await trackEnabled())) {
      const sf = await stableFrames();
      const tracked = trackFrame(user.storeId, deviceId,
        result.map(r => ({ productId: Number(r.productId), conf: Number(r.conf) || 0, bbox: r.bbox })));
      result.forEach((r, i) => {
        const t = tracked[i];
        if (!t) return;
        r.trackStable = t.hits >= sf;
        r.trackHits = t.hits;
        r.trackConf = t.ema;
      });
      if (result.length && result.every(r => r.trackStable)) notice += `（连续 ${sf} 帧稳定确认）`;
    }
    /* ── V4.27.1 命中结果补条码/重量区间（Q5 候选确认扫条码二次校验 + Q7 生鲜称重复核，前端消费） ── */
    if (result && result.length) {
      try {
        const pids = [...new Set(result.map(r => Number(r.productId)).filter(Boolean))];
        const prows = await q(`SELECT id, barcode, weight_min_g, weight_max_g FROM products WHERE id = ANY($1::bigint[])`, [pids]);
        const pm = new Map(prows.map((r: any) => [Number(r.id), r]));
        for (const r of result) {
          const p = pm.get(Number(r.productId));
          if (!p) continue;
          r.barcode = p.barcode || '';
          if (p.weight_min_g != null || p.weight_max_g != null) {
            r.weightRange = { minG: p.weight_min_g != null ? Number(p.weight_min_g) : null,
                              maxG: p.weight_max_g != null ? Number(p.weight_max_g) : null };
          }
        }
      } catch { /* 商品信息补全失败不阻断识别链路 */ }
    }
    const log = await q(
      `INSERT INTO ai_recognition_logs (store_id, device_id, image_path, raw_result, used_fallback, fallback_model, latency_ms, scene, layer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [user.storeId, deviceId, imagePath, JSON.stringify(result), usedFallback, fallbackModel, latency, scene, layer]);
    return { logId: Number(log[0].id), engine: engine === 'mock' ? 'sample' : engine, scene, result, usedFallback, fallbackModel, latencyMs: latency, layer, candidates, cropSamples, cropDetail, notice };
  }

  /** 人工纠正（收银员改识别结果 = 训练对；纠正帧自动进样本库） */
  /** 纠正回传（V4.11.3 落地，V4.11.5 增强）：纠正帧 → 样本库规则：
   *  ① 仅"保留件"（count>0）建样本，全移除只记纠正日志（防毒数据）；
   *  ② 手输补录（manualAdd=true）不建样本——补录商品可能不在画面内，挂错风险大于收益；
   *  ③ 每个保留品各建一条样本（旧版只取第一条）；
   *  ④ 候选确认件带 cropBox 时从识别帧裁出单件落盘挂样本（多件场景整帧语义不符）。 */
  @Post('recognize/:id/correct')
  async correct(@Param('id') id: string,
                @Body() b: { corrected: { productId: number; count: number; manualAdd?: boolean; cropBox?: { x: number; y: number; w: number; h: number } }[]; frameImage?: string },
                @CurrentUser() user: AuthUser) {
    if (!b.corrected?.length) throw new BizException(40003, '纠正结果不能为空');
    return tx(async c => {
      const logs = await cx(c, `SELECT * FROM ai_recognition_logs WHERE id=$1`, [id]);
      if (!logs.length) throw new BizException(40004, '识别日志不存在');
      const upd = await cx(c,
        `UPDATE ai_recognition_logs SET corrected=true, corrected_json=$2 WHERE id=$1 RETURNING image_path`,
        [id, JSON.stringify(b.corrected)]);
      const keep = b.corrected.filter(x => Number(x.count) > 0 && !x.manualAdd);
      let framePath = String(upd[0]?.image_path || '');
      // V4.16.5：识别帧未落盘（img:// 本机帧）时，前端回传帧图 → 落盘挂样本，纠正项从此有图
      if (!framePath.startsWith('/uploads/') && /^data:image\/(png|jpeg|jpg);base64,.+$/.test(String(b.frameImage || ''))) {
        try {
          const buf = Buffer.from(String(b.frameImage).replace(/^data:image\/\w+;base64,/, ''), 'base64');
          framePath = saveUploadImage(buf, `frame_${id}_${Date.now()}.jpg`);
          await cx(c, `UPDATE ai_recognition_logs SET image_path=$2 WHERE id=$1`, [id, framePath]);
        } catch { /* 落盘失败维持原路径 */ }
      }
      const sampleIds: number[] = [];
      for (const k of keep) {
        let imgPath = framePath;
        const box = k.cropBox;
        if (box && box.w > 0 && box.h > 0 && framePath.startsWith('/uploads/') && existsSync(uploadsFilePath(framePath))) {
          try {
            const { Jimp } = await import('jimp');
            const img = await Jimp.read(uploadsFilePath(framePath));
            const pad = 6;
            const x0 = Math.max(0, Math.round(Number(box.x) - pad));
            const y0 = Math.max(0, Math.round(Number(box.y) - pad));
            const w0 = Math.min(img.bitmap.width - x0, Math.round(Number(box.w) + pad * 2));
            const h0 = Math.min(img.bitmap.height - y0, Math.round(Number(box.h) + pad * 2));
            if (w0 > 8 && h0 > 8) {
              img.crop({ x: x0, y: y0, w: w0, h: h0 });
              const buf = await img.getBuffer('image/jpeg');
              imgPath = saveUploadImage(buf, `correct_${id}_${k.productId}_${Date.now()}.jpg`);
            }
          } catch { /* 裁剪失败回落整帧 */ }
        }
        const s = await cx(c,
          `INSERT INTO ai_samples (store_id, product_id, image_path, source, annotation, status)
           VALUES ($1,$2,$3,'识别纠正',$4,'待审核') RETURNING id`,
          [user.storeId, k.productId, imgPath || `img://corrected-${id}.jpg`, JSON.stringify(b.corrected)]);
        sampleIds.push(Number(s[0].id));
      }
      return { ok: true, sampleId: sampleIds.length ? sampleIds[0] : null, sampleIds };
    });
  }

  /** 识别质量报表（M4 长期闭环，V4.11.3）：近 30 天识别量 / 人工纠正率（准确率代理）/ 低置信件闭环率 /
   *  层级与场景分布 / 纠正 TOP 品类 / 最近识别记录。 */
  @Get('quality')
  async quality(@CurrentUser() user: AuthUser) {
    const sid = user.storeId;
    const [summary] = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE corrected)::int AS corrected,
              count(*) FILTER (WHERE NOT corrected)::int AS ok,
              COALESCE(round(avg(latency_ms))::int, 0) AS avg_ms,
              count(*) FILTER (WHERE jsonb_typeof(raw_result) = 'array' AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(raw_result) = 'array' THEN raw_result ELSE '[]'::jsonb END) e
                  WHERE (e->>'conf') IS NOT NULL AND (e->>'conf')::numeric < 0.90))::int AS low_conf,
              count(*) FILTER (WHERE corrected AND jsonb_typeof(raw_result) = 'array' AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(raw_result) = 'array' THEN raw_result ELSE '[]'::jsonb END) e
                  WHERE (e->>'conf') IS NOT NULL AND (e->>'conf')::numeric < 0.90))::int AS low_conf_closed
         FROM ai_recognition_logs
        WHERE store_id=$1 AND created_at > now() - interval '30 days'`, [sid]);
    const trend = await q(
      `SELECT to_char(date_trunc('day', created_at), 'MM-DD') AS day,
              count(*)::int AS total,
              count(*) FILTER (WHERE corrected)::int AS corrected,
              COALESCE(round(avg(latency_ms))::int, 0) AS avg_ms
         FROM ai_recognition_logs
        WHERE store_id=$1 AND created_at > now() - interval '30 days'
        GROUP BY date_trunc('day', created_at) ORDER BY date_trunc('day', created_at)`, [sid]);
    const layerDist = await q(
      `SELECT COALESCE(layer, '未知') AS layer, count(*)::int AS n
         FROM ai_recognition_logs
        WHERE store_id=$1 AND created_at > now() - interval '30 days'
        GROUP BY 1 ORDER BY n DESC`, [sid]);
    const sceneDist = await q(
      `SELECT scene, count(*)::int AS n
         FROM ai_recognition_logs
        WHERE store_id=$1 AND created_at > now() - interval '30 days'
        GROUP BY 1 ORDER BY n DESC`, [sid]);
    const corrTop = await q(
      `SELECT s.product_id AS "productId", p.name AS "name", count(*)::int AS n
         FROM ai_samples s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.store_id=$1 AND s.source='识别纠正' AND s.created_at > now() - interval '30 days'
        GROUP BY 1, 2 ORDER BY n DESC LIMIT 8`, [sid]);
    const recent = await q(
      `SELECT id, scene, layer, corrected, used_fallback AS "usedFallback", latency_ms AS "latencyMs",
              image_path AS "imagePath", created_at AS "createdAt",
              (SELECT count(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(raw_result) = 'array' THEN raw_result ELSE '[]'::jsonb END) e
                WHERE e->>'name' IS NOT NULL) AS items
         FROM ai_recognition_logs
        WHERE store_id=$1 ORDER BY id DESC LIMIT 20`, [sid]);
    return { summary, trend, layerDist, sceneDist, corrTop, recent };
  }

  /** 创建 AI 任务（采集/训练/评估）→ 生成任务工单号：AICJ/AIXL/AIPG + YYYYMMDD + 4 位日序号
   *  V4.14.1：采集任务支持按商品明细发布（productIds=按分类筛出的未采集商品清单）——
   *  目标样本数=采集商品数量（非图片数量），店员按明细逐个采集，全部商品采完才能提交预检 */
  @Post('tasks')
  @RequirePerms('ai.train.launch')
  createTask(@Body() b: { taskType: string; scope?: any; targetCount?: number; assignedTo?: number; remark?: string; productIds?: number[] },
             @CurrentUser() user: AuthUser) {
    if (!['采集', '训练', '评估'].includes(b.taskType)) throw new BizException(40003, '任务类型非法');
    const prefix = b.taskType === '采集' ? 'AICJ' : b.taskType === '训练' ? 'AIXL' : 'AIPG';
    const productIds = Array.isArray(b.productIds) ? [...new Set(b.productIds.map(Number).filter(x => x > 0))] : [];
    const scope = productIds.length ? { ...(b.scope || {}), productIds } : b.scope;
    const targetCount = productIds.length ? productIds.length : (b.targetCount ?? null);
    return tx(async c => {
      const ymd = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, '');
      await seqLock(c, 'ai_tasks', 'task_no', `${prefix}${ymd}-%`);
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM ai_tasks WHERE task_no LIKE $1`, [`${prefix}${ymd}-%`]);
      const taskNo = `${prefix}${ymd}-${String(seq[0].n).padStart(4, '0')}`;
      const rows = await cx(c,
        `INSERT INTO ai_tasks (store_id, task_type, task_no, scope, target_count, assigned_to, created_by, remark)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [user.storeId, b.taskType, taskNo, scope ? JSON.stringify(scope) : null,
         targetCount, b.assignedTo ?? null, user.sub, b.remark ?? null]);
      return rows[0];
    });
  }

  /** 任务列表（V4.14.1：带商品维度进度 totalProducts/doneProducts，目标样本数=采集商品数量） */
  @Get('tasks')
  tasks(@CurrentUser() user: AuthUser) {
    return q(
      `SELECT t.*,
              CASE WHEN t.scope ? 'productIds' AND jsonb_array_length(t.scope->'productIds') > 0
                   THEN jsonb_array_length(t.scope->'productIds') END AS total_products,
              CASE WHEN t.scope ? 'productIds' AND jsonb_array_length(t.scope->'productIds') > 0 THEN (
                SELECT count(DISTINCT s.product_id)::int FROM ai_samples s
                 WHERE s.task_id = t.id
                   AND s.product_id = ANY (ARRAY(SELECT jsonb_array_elements_text(t.scope->'productIds'))::bigint[])
              ) END AS done_products
         FROM ai_tasks t
        WHERE t.store_id=$1 ORDER BY t.id DESC LIMIT 50`, [user.storeId]);
  }

  /** 开始执行（待执行 → 进行中） */
  @Post('tasks/:id/start')
  async startTask(@Param('id') id: string) {
    return tx(async c => {
      const r = await cx(c,
        `UPDATE ai_tasks SET status='进行中', started_at=now()
          WHERE id=$1 AND status='待执行' RETURNING id`, [id]);
      if (!r.length) throw new BizException(50048, '任务状态不是「待执行」，无法开始');
      return { ok: true };
    });
  }

  /** 随手拍提交样本（员工执行采集任务；进样本库待审核，done_count/progress 联动）
   *  新规范：images = 6 角度照片组（顶面/正面/背面/左侧面/右侧面/俯斜面），六面齐全才可提交，
   *  逐张落 ai_samples（annotation.angle 记录视角），done_count 按照片张数累计。
   *  兼容旧版：仅传 imagePath 单张时按老逻辑入库。 */
  @Post('tasks/:id/submit-sample')
  async submitSample(@Param('id') id: string,
                     @Body() b: { imagePath?: string; images?: { angle: string; path: string }[]; productId: number; annotation?: any }) {
    if (!b.productId) throw new BizException(40003, 'productId 必填');
    const REQUIRED_ANGLES = ['顶面', '正面', '背面', '左侧面', '右侧面', '俯斜面'];
    let images: { angle: string; path: string }[] = [];
    if (Array.isArray(b.images) && b.images.length) {
      images = b.images.filter(i => i && i.path && i.angle);
      const got = new Set(images.map(i => i.angle));
      const missing = REQUIRED_ANGLES.filter(a => !got.has(a));
      if (missing.length) throw new BizException(40003, `样本照片不全，缺少角度：${missing.join('、')}（需 6 张：顶面/正面/背面/左侧面/右侧面/俯斜面）`);
      const extra = images.filter(i => !REQUIRED_ANGLES.includes(i.angle));
      if (extra.length) throw new BizException(40003, '存在无效角度，仅支持：顶面/正面/背面/左侧面/右侧面/俯斜面');
    } else if (b.imagePath) {
      images = [{ angle: '正面', path: b.imagePath }];    // 旧版单张兼容
    } else {
      throw new BizException(40003, 'images（6 角度照片组）或 imagePath 必填');
    }
    return tx(async c => {
      const ts = await cx(c, `SELECT * FROM ai_tasks WHERE id=$1 FOR UPDATE`, [id]);
      if (!ts.length) throw new BizException(40004, '任务不存在');
      const t = ts[0];
      if (t.status !== '进行中') throw new BizException(50048, `任务状态为「${t.status}」，提交样本须先开始任务`);
      // V4.14.1：任务按商品明细发布时，只能采明细内商品（防盲目随机采集）
      const scopeProducts: number[] = (t.scope?.productIds || []).map(Number);
      if (scopeProducts.length && !scopeProducts.includes(Number(b.productId))) {
        throw new BizException(40003, '该商品不在本任务的采集明细内（请按任务商品明细采集）');
      }
      for (const img of images) {
        // P1-H3 写入侧收口：路径不得含 ..、不得盘符/根绝对；/uploads/ 前缀外仅容忍 img:// 历史占位（读取端 uploadsFilePath 已白名单化）
        const ip = String(img.path || '');
        if (!ip || ip.includes('..') || /^[a-zA-Z]:|^[/\\]/.test(ip) || !/^(\/uploads\/|img:\/\/)/.test(ip)) {
          throw new BizException(40003, `样本图片路径不合法：${ip.slice(0, 64)}`);
        }
        const ann = { ...(b.annotation || {}), angle: img.angle };
        await cx(c,
          `INSERT INTO ai_samples (store_id, product_id, image_path, source, annotation, task_id)
           VALUES ($1,$2,$3,'采集任务',$4,$5)`,
          [t.store_id, b.productId, img.path, JSON.stringify(ann), t.id]);
      }
      // V4.14.1：按商品明细发布时，进度=已采商品数/明细商品数（目标样本数=采集商品数量）
      if (scopeProducts.length) {
        const got = await cx(c,
          `SELECT count(DISTINCT product_id)::int AS n FROM ai_samples WHERE task_id=$1 AND product_id = ANY($2::bigint[])`,
          [id, scopeProducts]);
        const doneProducts = Number(got[0].n);
        const allDone = doneProducts >= scopeProducts.length;
        const progress = Math.min(100, Math.round(doneProducts / scopeProducts.length * 100));
        await cx(c, `UPDATE ai_tasks SET done_count=$2, progress=$3 WHERE id=$1`, [id, doneProducts, progress]);
        return { sampleCount: images.length, doneCount: doneProducts, progress,
                 productDone: doneProducts, productTotal: scopeProducts.length, allDone,
                 note: allDone ? '✅ 明细内全部商品已采集完成，可提交店长预检' : `已采 ${doneProducts}/${scopeProducts.length} 种商品` };
      }
      const done = Number(t.done_count) + images.length;
      const progress = t.target_count ? Math.min(100, Math.round(done / Number(t.target_count) * 100)) : 0;
      await cx(c, `UPDATE ai_tasks SET done_count=$2, progress=$3 WHERE id=$1`, [id, done, progress]);
      return { sampleCount: images.length, doneCount: done, progress };
    });
  }

  /** V4.13.9 随手拍（免任务）：先选商品再拍照，6 角度齐全后直接进样本库待审核（source='随手拍'） */
  @Post('samples/free')
  async freeSample(@Body() b: { productId: number; images?: { angle: string; path: string }[]; annotation?: any },
                   @CurrentUser() user: AuthUser) {
    if (!b.productId) throw new BizException(40003, 'productId 必填（先选商品再拍照）');
    const REQUIRED_ANGLES = ['顶面', '正面', '背面', '左侧面', '右侧面', '俯斜面'];
    const images = (b.images || []).filter(i => i && i.path && i.angle);
    const got = new Set(images.map(i => i.angle));
    const missing = REQUIRED_ANGLES.filter(a => !got.has(a));
    if (missing.length) {
      throw new BizException(40003, `样本照片不全，缺少角度：${missing.join('、')}（需 6 张：顶面/正面/背面/左侧面/右侧面/俯斜面）`);
    }
    const extra = images.filter(i => !REQUIRED_ANGLES.includes(i.angle));
    if (extra.length) throw new BizException(40003, '存在无效角度，仅支持：顶面/正面/背面/左侧面/右侧面/俯斜面');
    const p = await q1(`SELECT id, store_id FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(b.productId)]);
    if (!p) throw new BizException(40404, '商品不存在', 404);
    return tx(async c => {
      for (const img of images) {
        const ip = String(img.path || ''); // P1-H3 写入侧收口（同采集任务）
        if (!ip || ip.includes('..') || /^[a-zA-Z]:|^[/\\]/.test(ip) || !/^(\/uploads\/|img:\/\/)/.test(ip)) {
          throw new BizException(40003, `样本图片路径不合法：${ip.slice(0, 64)}`);
        }
        const ann = { ...(b.annotation || {}), angle: img.angle, free: true };
        await cx(c,
          `INSERT INTO ai_samples (store_id, product_id, image_path, source, annotation)
           VALUES ($1,$2,$3,'随手拍',$4)`,
          [p.store_id, b.productId, img.path, JSON.stringify(ann)]);
      }
      await audit(p.store_id, user.sub, 'AI', 'ai.sample.free', 'product', Number(b.productId), { count: images.length });
      return { sampleCount: images.length, note: '随手拍样本已入库，等待店长审核' };
    });
  }

  /** 店长审核样本（待审核 → 已入库/不合格） */
  @Post('samples/:id/review')
  @RequirePerms('ai.train.launch')
  async reviewSample(@Param('id') id: string, @Body() b: { status: string }, @CurrentUser() user: AuthUser) {
    if (!['已入库', '不合格'].includes(b.status)) throw new BizException(40003, '审核结论须为 已入库/不合格');
    const r = await tx(async c => {
      const rows = await cx(c,
        `UPDATE ai_samples SET status=$2, reviewed_by=$3
          WHERE id=$1 AND status='待审核' RETURNING id`,
        [id, b.status, user.sub]);
      if (!rows.length) throw new BizException(50049, '样本不存在或已审核');
      return { ok: true, sampleId: Number(rows[0].id) };
    });
    // 审核通过 → 自动建向量索引（CLIP 编码约百 ms；失败静默，训练台可批量重建）
    if (b.status === '已入库') embIndexOne(r.sampleId).catch(() => {});
    return { ok: true };
  }

  /** V4.14.9 样本批量操作：{ ids, action: '已入库'|'不合格'|'删除' } —— 逐条处理返回成功/跳过数 */
  @Post('samples/batch')
  @RequirePerms('ai.train.launch')
  async batchSamples(@Body() b: { ids: number[]; action: string }, @CurrentUser() user: AuthUser) {
    const ids = (b.ids || []).map(Number).filter(Boolean);
    if (!ids.length) throw new BizException(40003, 'ids 必填（样本 id 数组）');
    if (!['已入库', '不合格', '删除'].includes(b.action)) throw new BizException(40003, 'action 须为 已入库/不合格/删除');
    let ok = 0, skip = 0;
    const indexed: number[] = [];
    await tx(async c => {
      for (const id of ids) {
        if (b.action === '删除') {
          const s = await cx(c, `SELECT * FROM ai_samples WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
          if (!s.length) { skip++; continue; }
          await cx(c, `DELETE FROM ai_samples WHERE id=$1`, [id]);
          await audit(user.storeId, user.sub, 'AI', 'ai.sample.delete', 'ai_sample', id,
            { productId: s[0].product_id, imagePath: s[0].image_path, status: s[0].status, batch: true });
          ok++;
        } else {
          const rows = await cx(c,
            `UPDATE ai_samples SET status=$2, reviewed_by=$3 WHERE id=$1 AND status='待审核' RETURNING id`,
            [id, b.action, user.sub]);
          if (!rows.length) { skip++; continue; }
          ok++;
          if (b.action === '已入库') indexed.push(Number(rows[0].id));
        }
      }
      return { ok: true };
    });
    // 批量入库 → 逐张自动建向量索引（失败静默，可一键重建补齐）
    for (const sid of indexed) embIndexOne(sid).catch(() => {});
    return { ok, skip };
  }

  /** 样本列表（V4.14.1：支持分页与关键字；带商品名/角度/图片路径/所属工单号）
   *  task_id 兜底：工单制上线前的历史样本未落 task_id，从 annotation.taskId 回退解析 */
  @Get('samples')
  samples(@Query('status') status = '', @Query('keyword') keyword = '',
          @Query('page') page = '1', @Query('size') size = '10', @CurrentUser() user: AuthUser) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 10));
    const kw = (keyword || '').trim();
    return q(
      `SELECT s.*, p.name AS product_name, p.barcode AS product_barcode,
              COALESCE(s.annotation->>'angle', '') AS angle,
              COALESCE(s.task_id, CASE WHEN s.annotation->>'taskId' ~ '^\d+$' THEN (s.annotation->>'taskId')::bigint END) AS task_id,
              t.task_no
         FROM ai_samples s
         LEFT JOIN products p ON p.id = s.product_id
         LEFT JOIN ai_tasks t ON t.id = COALESCE(s.task_id, CASE WHEN s.annotation->>'taskId' ~ '^\d+$' THEN (s.annotation->>'taskId')::bigint END)
        WHERE s.store_id = $1
          AND ($2 = '' OR s.status = $2)
          AND ($3 = '' OR p.name ILIKE '%'||$3||'%' OR p.barcode = $3)
        ORDER BY s.id DESC
        LIMIT $4 OFFSET $5`,
      [user.storeId, status || '', kw, sz + 1, (pn - 1) * sz],
    );
  }

  /** V4.14.1：样本删除（误采/重复采集清理；删除留痕，CLIP 向量随重建覆盖） */
  @Post('samples/:id/delete')
  @RequirePerms('ai.train.launch')
  async deleteSample(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const s = await q1<any>(`SELECT * FROM ai_samples WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!s) throw new BizException(40404, '样本不存在', 404);
    await q(`DELETE FROM ai_samples WHERE id=$1`, [id]);
    await audit(user.storeId, user.sub, 'AI', 'ai.sample.delete', 'ai_sample', Number(id),
      { productId: s.product_id, imagePath: s.image_path, status: s.status });
    return { ok: true };
  }

  /* ── V4.10.1 CLIP 向量索引（实时识别提速层）：训练台面板调用 ── */

  /** 向量索引状态：模型就绪 / 已索引 / 待索引 / 覆盖商品数 */
  @Get('emb/status')
  async embStatusC(@CurrentUser() user: AuthUser) {
    return embStatus(user.storeId);
  }

  /** 一键建索引：force=false 只补缺失（新样本），force=true 全部重算（换模型后用） */
  @Post('emb/reindex')
  @RequirePerms('ai.train.launch')
  async embReindex(@Body() b: { force?: boolean; limit?: number }, @CurrentUser() user: AuthUser) {
    const r = await embIndexStore(user.storeId, !!b.force, Math.min(2000, Number(b.limit) || 500));
    await audit(user.storeId, user.sub, 'ai', 'emb.reindex', 'ai_samples', undefined, { ...r });
    return { ok: true, ...r };
  }

  /* ── 任务工单审核（V4.9.1）：审核以工单为单位 ──
   *  流程：员工提交样本 → 店长点工单号进详情（商品+图片）→ 预检「合格 / 回退」
   *   - 合格 → 「审核通过」按钮点亮 → 通过后工单内待审核样本全部置已入库（工单号绿色）
   *   - 回退 → 样本置不合格、任务回到进行中由店员重新拍照（工单号黄色）
   *  统一状态颜色规则（全模块一致）：绿=已审核通过/成功 · 红=待审核/待办需行动 · 黄=进行中/回退待重拍/临期 · 灰=停用/失效 · 蓝=信息提示 */

  /** 工单列表（含任务工单号 + 样本数统计） */
  @Get('orders')
  async orders(@CurrentUser() user: AuthUser) {
    return q(
      `SELECT t.*, u.name AS creator_name,
              COALESCE(cnt.total, 0) AS sample_total,
              COALESCE(cnt.pending, 0) AS sample_pending,
              COALESCE(cnt.ok, 0) AS sample_ok,
              COALESCE(cnt.bad, 0) AS sample_bad,
              CASE WHEN t.scope ? 'productIds' AND jsonb_array_length(t.scope->'productIds') > 0
                   THEN jsonb_array_length(t.scope->'productIds') END AS total_products,
              CASE WHEN t.scope ? 'productIds' AND jsonb_array_length(t.scope->'productIds') > 0 THEN (
                SELECT count(DISTINCT s.product_id)::int FROM ai_samples s
                 WHERE s.task_id = t.id
                   AND s.product_id = ANY (ARRAY(SELECT jsonb_array_elements_text(t.scope->'productIds'))::bigint[])
              ) END AS done_products
         FROM ai_tasks t
         LEFT JOIN employees u ON u.id = t.created_by
         LEFT JOIN LATERAL (
           SELECT count(*) AS total,
                  count(*) FILTER (WHERE status = '待审核') AS pending,
                  count(*) FILTER (WHERE status = '已入库') AS ok,
                  count(*) FILTER (WHERE status = '不合格') AS bad
             FROM ai_samples s
              WHERE s.task_id = t.id
                 OR (s.task_id IS NULL AND s.annotation->>'taskId' = t.id::text)
         ) cnt ON true
        WHERE t.store_id = $1
        ORDER BY t.id DESC LIMIT 100`, [user.storeId],
    );
  }

  /** 工单详情（任务头 + 工单内全部样本图，按商品分组由前端渲染） */
  @Get('orders/:id')
  async orderDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const t = await q1<any>(
      `SELECT t.*, u.name AS creator_name FROM ai_tasks t
        LEFT JOIN employees u ON u.id = t.created_by
       WHERE t.id=$1 AND t.store_id=$2`, [id, user.storeId]);
    if (!t) throw new BizException(40404, '工单不存在', 404);
    const samples = await q(
      `SELECT s.*, p.name AS product_name, p.barcode AS product_barcode,
              COALESCE(s.annotation->>'angle', '') AS angle
         FROM ai_samples s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.task_id=$1 ORDER BY s.product_id, s.id`, [id]);
    return { order: t, samples };
  }

  /** 工单预检（店长查看详情后）：合格 → 点亮审核按钮；回退 → 样本置不合格、任务回到进行中让店员重拍 */
  @Post('orders/:id/precheck')
  @RequirePerms('ai.train.launch')
  async precheckOrder(@Param('id') id: string, @Body() b: { result: string; remark?: string },
                      @CurrentUser() user: AuthUser) {
    if (!['合格', '回退'].includes(b.result)) throw new BizException(40003, '预检结论须为 合格/回退');
    return tx(async c => {
      const ts = await cx(c, `SELECT * FROM ai_tasks WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id, user.storeId]);
      if (!ts.length) throw new BizException(40404, '工单不存在', 404);
      if (ts[0].review_result === '合格') throw new BizException(40003, '工单已预检合格（可点击「审核通过」终审），不可再改预检结论');
      // V4.14.1：按商品明细发布的采集任务，全部商品采完才能提交预检（防漏采）
      const scopeProducts: number[] = (ts[0].scope?.productIds || []).map(Number);
      if (b.result === '合格' && scopeProducts.length) {
        const got = await cx(c,
          `SELECT count(DISTINCT product_id)::int AS n FROM ai_samples WHERE task_id=$1 AND product_id = ANY($2::bigint[])`,
          [id, scopeProducts]);
        if (Number(got[0].n) < scopeProducts.length) {
          throw new BizException(40003, `采集未完成：明细 ${scopeProducts.length} 种商品已采 ${Number(got[0].n)} 种，全部商品采集完成后才能提交预检`);
        }
      }
      if (b.result === '回退') {
        await cx(c, `UPDATE ai_samples SET status='不合格' WHERE task_id=$1 AND status='待审核'`, [id]);
        await cx(c,
          `UPDATE ai_tasks SET review_result='回退', review_remark=$2, reviewed_by=$3, reviewed_at=now(),
                  status='进行中', done_count=0, progress=0 WHERE id=$1`,
          [id, b.remark || '回退重拍', user.sub]);
        return { ok: true, result: '回退' };
      }
      await cx(c,
        `UPDATE ai_tasks SET review_result='合格', review_remark=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1`,
        [id, b.remark || '', user.sub]);
      return { ok: true, result: '合格' };
    });
  }

  /** 工单审核通过（终审）：仅预检合格后可点；工单内全部待审核样本 → 已入库 */
  @Post('orders/:id/approve')
  @RequirePerms('ai.train.launch')
  async approveOrder(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const ts = await cx(c, `SELECT * FROM ai_tasks WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id, user.storeId]);
      if (!ts.length) throw new BizException(40404, '工单不存在', 404);
      const t = ts[0];
      if (t.review_result !== '合格') throw new BizException(40003, '请先预检「合格」后才能审核通过（回退工单须由店员重新拍照提交）');
      // 历史孤儿样本物理绑定（annotation.taskId → task_id，幂等）
      await cx(c, `UPDATE ai_samples SET task_id=$1::bigint WHERE task_id IS NULL AND annotation->>'taskId'=$1::text`, [id]);
      const r = await cx(c,
        `UPDATE ai_samples SET status='已入库', reviewed_by=$2 WHERE task_id=$1 AND status='待审核' RETURNING id`, [id, user.sub]);
      await cx(c,
        `UPDATE ai_tasks SET status='已完成', progress=100, reviewed_by=$2, reviewed_at=now() WHERE id=$1 AND status <> '已完成'`,
        [id, user.sub]);
      await audit(user.storeId, user.sub, 'AI', 'ai.order.approve', 'ai_task', Number(id),
        { taskNo: t.task_no, approved: r.length });
      return { ok: true, approved: r.length, taskNo: t.task_no };
    });
  }

  /** 训练完成：产出模型版本（同名单调递增），可单活部署（灰度/回滚 = 再切换 activate） */
  @Post('tasks/:id/finish')
  @RequirePerms('ai.train.launch')
  finishTask(@Param('id') id: string,
             @Body() b: { modelName?: string; metrics: any; activate?: boolean }) {
    return tx(async c => {
      const ts = await cx(c, `SELECT * FROM ai_tasks WHERE id=$1 FOR UPDATE`, [id]);
      if (!ts.length) throw new BizException(40004, '任务不存在');
      const t = ts[0];
      if (t.status !== '进行中') throw new BizException(50048, `任务状态为「${t.status}」，须先开始`);
      if (t.task_type === '训练') {
        if (!b.metrics) throw new BizException(40003, '训练完成必须提交 metrics（mAP/准确率等）');
        const rawName = String(b.modelName || 'yolo-shelf').trim();
        if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(rawName)) throw new BizException(40003, '模型名仅限字母/数字/_-，64 字符内（P1-M6）');
        const name = rawName;
        const ver = await cx(c, `SELECT COALESCE(MAX(version),0)+1 AS v FROM ai_models WHERE name=$1`, [name]);
        const m = await cx(c,
          `INSERT INTO ai_models (store_id, name, task, version, file_path, metrics, is_active, deployed_at, trained_task_id)
           VALUES ($1,$2,'detect',$3,$4,$5,$6, CASE WHEN $6 THEN now() ELSE NULL END, $7::bigint) RETURNING *`,
          [t.store_id, name, ver[0].v, `models/${name}-v${ver[0].v}.onnx`,
           JSON.stringify(b.metrics), !!b.activate, id]);
        if (b.activate) { // 单活切换：同 task 其它模型全部下线
          await cx(c, `UPDATE ai_models SET is_active=false WHERE task='detect' AND id <> $1`, [m[0].id]);
        }
        await cx(c,
          `UPDATE ai_tasks SET status='已完成', finished_at=now(), progress=100, model_id=$2, metrics=$3 WHERE id=$1`,
          [id, m[0].id, JSON.stringify(b.metrics)]);
        return { modelId: Number(m[0].id), version: Number(m[0].version), activated: !!b.activate };
      }
      // 采集/评估任务直接完成
      await cx(c, `UPDATE ai_tasks SET status='已完成', finished_at=now(), progress=100 WHERE id=$1`, [id]);
      return { ok: true };
    });
  }

  /** 模型版本列表 */
  @Get('models')
  models() {
    return q(`SELECT id, name, task, version, metrics, is_active, deployed_at, trained_task_id
                FROM ai_models ORDER BY name, version DESC`);
  }

  /** OCR 批量入库：文本行「名称,条码,售价,保质期天」→ preview 校验 / apply=true 落库建档 */
  @Post('ocr-intake')
  @RequirePerms('ai.train.launch')
  async ocrIntake(@Body() b: { text: string; apply?: boolean }, @CurrentUser() user: AuthUser) {
    const lines = String(b.text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) throw new BizException(40003, 'OCR 文本为空');
    const rows: any[] = [];
    for (const [i, line] of lines.entries()) {
      const parts = line.split(/[,|，\t]+/).map(s => s.trim());
      const [name, barcode, sell, keepDays] = parts;
      const err: string[] = [];
      if (!name) err.push('缺名称');
      if (!barcode) err.push('缺条码');
      if (!(sell && Number(sell) > 0)) err.push('售价非法');
      if (!keepDays || !(Number(keepDays) >= 1)) err.push('保质期天数非法');
      if (barcode) {
        const dup = await q(`SELECT id FROM products WHERE barcode=$1`, [barcode]);
        if (dup.length) err.push('条码已存在');
        if (rows.some(r => r.barcode === barcode)) err.push('批内条码重复');
      }
      rows.push({ line: i + 1, name, barcode, sellPrice: sell ? Number(sell) : null,
                  keepDays: keepDays ? Number(keepDays) : null, ok: !err.length, err: err.join('；') });
    }
    const okRows = rows.filter(r => r.ok);
    if (!b.apply) return { apply: false, okCount: okRows.length, errCount: rows.length - okRows.length, rows };

    return tx(async c => {
      const created: any[] = [];
      for (const r of okRows) {
        const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM products`);
        const goodsNo = `SKU-${String(seq[0].n).padStart(4, '0')}`;
        const ins = await cx(c,
          `INSERT INTO products (store_id, goods_no, barcode, name, base_unit, keep_days, sell_price, status)
           VALUES ($1,$2,$3,$4,'件',$5,$6,1) RETURNING id, goods_no, name, barcode, sell_price, keep_days`,
          [user.storeId, goodsNo, r.barcode, r.name, r.keepDays, r.sellPrice]);
        created.push(ins[0]);
      }
      return { apply: true, createdCount: created.length, created, skipped: rows.filter(x => !x.ok).length };
    });
  }

  /** 导入模型（训练产物 .onnx → base64）：生成版本 + 可选单活激活；classes={idx:{name,productId?},mode=classify|detect} */
  @Post('models/import')
  @RequirePerms('ai.train.launch')
  async importModel(@Body() b: { name: string; base64: string; mode?: string; classes?: any; activate?: boolean; base_model?: string; remark?: string },
                    @CurrentUser() user: AuthUser) {
    const name = String(b.name || '').trim();
    if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(name)) throw new BizException(40003, '模型名仅限字母/数字/_-，64 字符内');
    const b64 = String(b.base64 || '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || b64.length > 56 * 1024 * 1024) throw new BizException(40003, '模型文件为空或超过 40MB（base64）');
    if (!b64.match(/^[A-Za-z0-9+/=\s]+$/)) throw new BizException(40003, 'base64 内容非法');
    const mode = b.mode === 'classify' ? 'classify' : 'detect';
    const classes = b.classes && typeof b.classes === 'object' ? b.classes : {};
    if (mode === 'classify' && !Object.keys(classes).length) throw new BizException(40003, '分类模型须提供 classes 类别映射');
    if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR, { recursive: true });
    return tx(async c => {
      const ver = await cx(c, `SELECT COALESCE(MAX(version),0)+1 AS v FROM ai_models WHERE name=$1`, [name]);
      const file = `${name}-v${Number(ver[0].v)}.onnx`;
      writeFileSync(join(MODELS_DIR, file), buf);
      const m = await cx(c,
        `INSERT INTO ai_models (store_id, name, task, version, file_path, base_model, metrics, is_active, deployed_at, remark)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8 THEN now() ELSE NULL END, $9) RETURNING *`,
        [user.storeId, name, mode, Number(ver[0].v), file, b.base_model ?? null,
         JSON.stringify({ mode, classes }), !!b.activate, b.remark ?? null]);
      if (b.activate) await cx(c, `UPDATE ai_models SET is_active=false WHERE id <> $1`, [m[0].id]);
      clearSessionCache();
      await audit(user.storeId, user.sub, 'AI', 'ai.model.import', 'ai_model', Number(m[0].id),
        { name, version: Number(ver[0].v), mode, activate: !!b.activate });
      return { modelId: Number(m[0].id), version: Number(ver[0].v), activated: !!b.activate, file };
    });
  }

  /** 激活模型版本（单活切换：同 task 其它版本全部下线；回滚=再激活旧版本） */
  @Post('models/:id/activate')
  @RequirePerms('ai.train.launch')
  async activateModel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const r = await cx(c, `UPDATE ai_models SET is_active=true, deployed_at=now() WHERE id=$1 RETURNING id, name, version`, [id]);
      if (!r.length) throw new BizException(40004, '模型不存在');
      await cx(c, `UPDATE ai_models SET is_active=false WHERE id <> $1`, [id]);
      clearSessionCache();
      await audit(user.storeId, user.sub, 'AI', 'ai.model.activate', 'ai_model', Number(id), { name: r[0].name, version: Number(r[0].version) });
      return { ok: true };
    });
  }

  /** 停用模型 */
  @Post('models/:id/deactivate')
  @RequirePerms('ai.train.launch')
  async deactivateModel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await q(`UPDATE ai_models SET is_active=false WHERE id=$1 RETURNING id`, [id]);
    clearSessionCache();
    return { ok: true };
  }

  /** 导出训练数据集（YOLO 分类格式 zip）：已入库样本 → train/<类名>/<id>_<商品id>.jpg + data.yaml */
  @Get('train/dataset')
  @RequirePerms('ai.train.launch')
  async exportDataset() {
    const rows = await q(
      `SELECT s.id, s.product_id, s.image_path, p.name AS product_name
         FROM ai_samples s LEFT JOIN products p ON p.id=s.product_id
        WHERE s.status='已入库' AND s.image_path LIKE '/uploads/%'
        ORDER BY s.id`);
    const items: { name: string; data: Buffer }[] = [];
    let copied = 0, skipped = 0;
    const classes: Record<string, number> = {};
    for (const s of rows as any[]) {
      const file = uploadsFilePath(String(s.image_path));
      if (!existsSync(file)) { skipped++; continue; }
      const clsName = String(s.product_name || `商品${s.product_id}`).replace(/[\\/:*?"<>|]/g, '_');
      classes[clsName] = Number(s.product_id);
      items.push({ name: `dataset/train/${clsName}/${s.id}_${s.product_id}.jpg`, data: readFileSync(file) });
      copied++;
    }
    const names = Object.entries(classes).map(([k], i) => `${i}: ${JSON.stringify(k)}`).join('\n');
    const yaml = `path: dataset\ntrain: train\nnames:\n${names}\n`;
    items.push({ name: 'dataset/data.yaml', data: Buffer.from(yaml, 'utf8') });
    items.push({ name: 'dataset/README.txt', data: Buffer.from(
      `导出 ${copied} 张已入库样本（跳过 ${skipped} 张无文件）。\n训练：1) pip install ultralytics  2) 下载本 zip 解压  3) 运行训练台「获取训练脚本」生成的 train_cls.py\n`, 'utf8') });
    const zip = makeZip(items);
    return { base64: zip.toString('base64'), count: copied, skipped, classes: Object.keys(classes).length, fileName: 'dataset.zip' };
  }

  /** 获取训练脚本（Python + ultralytics 分类训练 → 导出 ONNX → 回传导入） */
  @Get('train/script')
  @RequirePerms('ai.train.launch')
  trainScript() {
    const script = `# -*- coding: utf-8 -*-
"""识别秤/俯拍商品分类训练（ultralytics）→ 导出 ONNX → 训练台导入部署
用法：
  1) pip install ultralytics
  2) 训练台「导出数据集」下载 dataset.zip 并解压到本脚本同目录
  3) python train_cls.py
  4) 打开训练台「模型管理」→ 导入 best.onnx（转 base64），mode=classify，
     classes 映射与 data.yaml 中 names 一致（0: 商品名, ...），激活后 ai.engine 切 yolo 即真机推理
"""
from ultralytics import YOLO

model = YOLO('yolov8n-cls.pt')          # 首次自动下载预训练；离线可用本机已有权重替换
model.train(data='dataset', epochs=50, imgsz=224, batch=16)
model.export(format='onnx', imgsz=224)  # 产出 runs/classify/train/weights/best.onnx
print('完成：best.onnx 即可导入训练台')
`;
    return { script };
  }

  /** V4.27.0 获取检测训练脚本（ultralytics 单类「商品」检测 → ONNX → 导入后 ai.seg.model_id 启用 YOLO 定位）。
   *  完整训练包（数据导出/自动标注/量化）见 backend/ai-train/。 */
  @Get('train/script-detect')
  @RequirePerms('ai.train.launch')
  trainScriptDetect() {
    const script = `# -*- coding: utf-8 -*-
"""单类「商品」检测训练（ultralytics YOLO26，GPU）→ 导出 ONNX → 训练台导入 → 多件识别 YOLO 定位
用法：
  1) GPU 服务器：pip install ultralytics（CUDA 版 PyTorch 按官方指引安装）
  2) 数据集：backend/ai-train/export_dataset.py 自动导出（ai_samples → YOLO 检测格式，含 train/val/test 划分），
     或训练台「导出数据集」zip 手工整理为 YOLO detect 格式（labels: 0 cx cy w h 归一化）
  3) python train_det.py
  4) 训练台「模型管理」导入 best.onnx（mode=detect，classes={"0":{"name":"商品"}}），
     导入后设置 ai.seg.model_id = 模型 id → 多件识别启用 YOLO 定位（0=回落轮廓分割）
说明：YOLO26 为端到端 NMS-free 模型，ONNX 输出 [1,300,6]（max_det=300），
     后端 ai.detect.ts parseEndToEnd 已支持该格式（默认参数勿改 max_det）。
"""
from ultralytics import YOLO

model = YOLO('yolo26n.pt')              # YOLO26 nano：端到端 NMS-free，同精度更快；降级可用 yolo11n.pt
model.train(data='dataset/data.yaml', epochs=80, imgsz=640, batch=16, device='0', patience=20)
model.export(format='onnx', imgsz=640, opset=12, dynamic=False, simplify=True)   # max_det 保持默认 300
print('完成：runs/detect/train/weights/best.onnx 导入训练台，并设置 ai.seg.model_id')
`;
    return { script };
  }

  /* ── V4.27.1 Q3 标注审核台：自动建议框（YOLO 定位/轮廓分割）→ 人工拖拽修正 → 校正框入库 ──
   *  校正框存 ai_samples.annotation.boxes（labelReviewed=true），训练包 export_dataset.py 优先使用。 */

  /** 待标注样本队列（已入库样本，未做过框校正） */
  @Get('label/pending')
  @RequirePerms('ai.train.launch')
  labelPending(@Query('page') page = '1', @Query('size') size = '20', @CurrentUser() user: AuthUser) {
    const pn = Math.max(1, Number(page) || 1), sz = Math.min(100, Math.max(1, Number(size) || 20));
    return q(
      `SELECT s.id, s.product_id, p.name AS product_name, s.image_path, s.status,
              COALESCE(s.annotation->>'angle','') AS angle,
              COALESCE((s.annotation->>'labelReviewed')::boolean, false) AS "labelReviewed"
         FROM ai_samples s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.store_id=$1 AND s.status IN ('已审核','已入库') AND s.image_path LIKE '/uploads/%'
          AND COALESCE((s.annotation->>'labelReviewed')::boolean, false) = false
        ORDER BY s.id DESC LIMIT $2 OFFSET $3`, [user.storeId, sz + 1, (pn - 1) * sz]);
  }

  /** 获取样本 + 自动建议框（YOLO 定位模型优先，未配置回落轮廓分割；已有人工框则直接返回人工框） */
  @Get('label/:id/boxes')
  @RequirePerms('ai.train.launch')
  async labelPropose(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const rows = await q(
      `SELECT s.*, p.name AS product_name FROM ai_samples s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.id=$1 AND s.store_id=$2`, [id, user.storeId]);
    if (!rows.length) throw new BizException(40404, '样本不存在', 404);
    const s = rows[0];
    if (!String(s.image_path).startsWith('/uploads/')) throw new BizException(40003, '样本图为 img:// 占位（无实体文件），无法标注');
    const f = uploadsFilePath(String(s.image_path));
    if (!existsSync(f)) throw new BizException(40404, '样本图文件缺失（可能未随备份恢复）', 404);
    const b64 = readFileSync(f).toString('base64');
    let reviewed: any[] | null = null;
    try { const arr = s.annotation?.boxes; if (Array.isArray(arr) && arr.length) reviewed = arr; } catch { /* 忽略坏数据 */ }
    if (reviewed) {
      return { sampleId: Number(s.id), productId: Number(s.product_id), productName: s.product_name,
               imagePath: s.image_path, boxes: reviewed, engine: 'manual', reviewed: true };
    }
    const yolo = await segmentItemsYolo(b64).catch((): import('./ai.seg').SegResult | null => null);
    const seg = yolo ?? await segmentItems(b64);
    return { sampleId: Number(s.id), productId: Number(s.product_id), productName: s.product_name,
             imagePath: s.image_path,
             boxes: seg.boxes.map((b: { x: number; y: number; w: number; h: number }) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
             engine: yolo ? 'yolo' : 'contour', reviewed: false };
  }

  /** 保存人工校正框（标注审核台提交；boxes 空数组=确认背景图/负样本） */
  @Post('label/:id/boxes')
  @RequirePerms('ai.train.launch')
  async labelSave(@Param('id') id: string,
                  @Body() b: { boxes: { x: number; y: number; w: number; h: number }[] },
                  @CurrentUser() user: AuthUser) {
    const boxes = (b.boxes || [])
      .filter(x => Number(x.w) > 4 && Number(x.h) > 4)
      .map(x => ({ x: Math.max(0, Math.round(Number(x.x))), y: Math.max(0, Math.round(Number(x.y))),
                   w: Math.round(Number(x.w)), h: Math.round(Number(x.h)) }))
      .slice(0, 12);
    const r = await q(
      `UPDATE ai_samples
          SET annotation = jsonb_set(jsonb_set(COALESCE(annotation,'{}'::jsonb), '{boxes}', $2::jsonb), '{labelReviewed}', 'true'::jsonb)
        WHERE id=$1 AND store_id=$3 RETURNING id`,
      [id, JSON.stringify(boxes), user.storeId]);
    if (!r.length) throw new BizException(40004, '样本不存在');
    await audit(user.storeId, user.sub, 'AI', 'ai.label.review', 'ai_sample', Number(id), { boxes: boxes.length });
    return { ok: true, boxes: boxes.length };
  }

  /* ── V4.27.1 Q7 生鲜称重复核：称重结果 vs 单件重量期望区间（products.weight_min_g/max_g） ── */

  @Post('weight-check')
  async weightCheck(@Body() b: { productId: number; weightG: number }) {
    const pid = Number(b.productId), g = Number(b.weightG);
    if (!pid || !(g > 0)) throw new BizException(40003, 'productId 与 weightG 必填');
    const rows = await q(`SELECT name, weight_min_g, weight_max_g FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
    if (!rows.length) throw new BizException(40404, '商品不存在', 404);
    const p = rows[0];
    const minG = p.weight_min_g != null ? Number(p.weight_min_g) : null;
    const maxG = p.weight_max_g != null ? Number(p.weight_max_g) : null;
    if (minG == null && maxG == null) return { ok: true, checked: false, name: p.name };
    const below = minG != null && g < minG, above = maxG != null && g > maxG;
    return { ok: !(below || above), checked: true, name: p.name, minG, maxG, weightG: g, below, above,
             message: below ? `⚠️ 重量 ${g}g 低于期望下限 ${minG}g：请复核是否拿错品类/漏称`
                   : above ? `⚠️ 重量 ${g}g 超过期望上限 ${maxG}g：请复核是否拿错品类/重复称`
                   : '' };
  }

  /* ── V4.27.1 Q15 难例挖掘：识别错误（纠正）/低置信 识别日志检索（纠正帧已自动回流样本库，
   *  本接口用于批量导出难例图做数据集迭代 / 复盘低置信模式） ── */

  @Get('hardcases')
  @RequirePerms('ai.train.launch')
  async hardcases(@Query('days') days = '30', @Query('kind') kind = 'all', @Query('limit') limit = '100',
                  @CurrentUser() user: AuthUser) {
    const d = Math.min(180, Math.max(1, Number(days) || 30));
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const kindCond = kind === 'corrected'
      ? `AND l.corrected`
      : kind === 'lowconf'
        ? `AND NOT COALESCE(l.corrected, false) AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.raw_result)='array' THEN l.raw_result ELSE '[]'::jsonb END) e
              WHERE (e->>'conf') IS NOT NULL AND (e->>'conf')::numeric < 0.90)`
        : '';
    const rows = await q(
      `SELECT l.id, l.scene, l.layer, l.corrected, l.corrected_json, l.raw_result, l.image_path,
              l.latency_ms AS "latencyMs", l.created_at AS "createdAt"
         FROM ai_recognition_logs l
        WHERE l.store_id=$1 AND l.created_at > now() - ($2 || ' days')::interval
          AND l.image_path LIKE '/uploads/%' ${kindCond}
        ORDER BY l.id DESC LIMIT $3`, [user.storeId, String(d), lim]);
    const stats = await q(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE corrected)::int AS corrected
         FROM ai_recognition_logs
        WHERE store_id=$1 AND created_at > now() - ($2 || ' days')::interval AND image_path LIKE '/uploads/%'`,
      [user.storeId, String(d)]);
    return { stats: stats[0], kind, rows };
  }

  /** V4.27.4/V4.27.5 多品同拍批量采集：一次拍照识别出的多件商品，逐件裁剪图批量入样本库（待审核）。
   *  权限设计：采集【免店长放权】（登录即可，任何员工可闲时采集），审核在后台由店长/管理员异步完成，
   *  不打断店长日常工作。人工纠错件（manual=true，识别未命中由收银员指定的商品）单独标记来源，
   *  便于审核时重点把关。防反馈回路：一律待审核，审核不通过可批量驳回。
   *  imagePath 须为 /uploads/ 相对路径（前端已先 /upload 落盘）。 */
  @Post('samples/batch-collect')
  async batchCollect(@Body() b: { items: { productId: number; imagePath: string; conf?: number; angle?: string; manual?: boolean }[] },
                     @CurrentUser() user: AuthUser) {
    const items = Array.isArray(b.items) ? b.items.slice(0, 12) : [];
    if (!items.length) throw new BizException(40003, 'items 为空（每条 = productId + imagePath）');
    let ok = 0;
    const failed: string[] = [];
    return tx(async c => {
      for (const [i, it] of items.entries()) {
        const ip = String(it.imagePath || '');
        // P1-H3 同款路径收口：仅 /uploads/ 相对路径，拒绝 .. 与盘符/绝对路径
        if (!ip.startsWith('/uploads/') || ip.includes('..') || ip.includes('\\') || /^[a-zA-Z]:/.test(ip)) {
          failed.push(`#${i} 路径不合法`); continue;
        }
        const p = await cx(c, `SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(it.productId)]);
        if (!p.length) { failed.push(`#${i} 商品不存在：${it.productId}`); continue; }
        const manual = !!it.manual;
        await cx(c,
          `INSERT INTO ai_samples (store_id, product_id, image_path, source, annotation, status)
           VALUES ($1,$2,$3,'多品同拍',$4,'待审核')`,
          [user.storeId, Number(it.productId), ip,
           JSON.stringify({ from: manual ? '多品同拍(人工纠错)' : '多品同拍', angle: String(it.angle || '俯拍'),
                            conf: Number(it.conf) || null, manual,
                            collectedBy: user.sub, collectedAt: new Date().toISOString() })]);
        ok++;
      }
      await audit(user.storeId, user.sub, 'AI', 'ai.sample.batch-collect', 'ai_samples', undefined,
        { collected: ok, failed: failed.length });
      return { ok: true, collected: ok, failedCount: failed.length, failed: failed.slice(0, 5) };
    });
  }

  /* ── V4.27.6 AI 自动训练：状态查询 + 手动触发（把"每周手动跑三步脚本"变成设置里的自动任务） ── */

  /** 自动训练状态（开关/计划/上次运行结果与日志尾部） */
  @Get('autotrain/status')
  @RequirePerms('ai.train.launch')
  async autotrainStatusC() {
    return autotrainStatus();
  }

  /** 立即执行一次自动训练（导出数据集 → GPU 训练 → 导入模型库；异步执行，轮询 status 看进度） */
  @Post('autotrain/run')
  @RequirePerms('ai.train.launch')
  async autotrainRunC() {
    if (autotrainBusy()) throw new BizException(40003, '已有自动训练在运行中（进度见 GET /ai/autotrain/status）');
    void autotrainRun('manual').catch(() => {});   // 异步启动，训练可能数小时，立即返回
    return { ok: true, message: '自动训练已启动（异步执行，进度/结果见 GET /ai/autotrain/status）' };
  }

  /* ── V4.27.7 训练环境：检测 + 一键安装（pip 两连，替代手工敲命令） ── */

  /** 环境检测：python/pip/torch(GPU?)/ultralytics + 一键安装任务进度 */
  @Get('autotrain/env')
  @RequirePerms('ai.train.launch')
  async autotrainEnvC() {
    const env = await autotrainEnvCheck();
    return { env, job: autotrainEnvJob() };
  }

  /** 一键安装训练环境（GPU 版 PyTorch + ultralytics；后台执行 10~30 分钟，进度看 env 接口） */
  @Post('autotrain/setup-env')
  @RequirePerms('ai.train.launch')
  async autotrainSetupC() {
    return autotrainEnvSetup();
  }

  /* ── V4.27.1 Q9 样本数据备份/恢复：整店样本图 + 元数据 zip 导出；JSON 分批导入恢复 ──
   *  全量灾备 = 本接口（或文件目录拷贝）+ pg_dump；详见 deploy/backup/README.md。 */

  @Get('samples/export')
  @RequirePerms('ai.train.launch')
  async samplesExport(@CurrentUser() user: AuthUser) {
    const rows = await q(
      `SELECT s.id, s.product_id, p.name AS product_name, p.barcode AS product_barcode,
              s.image_path, s.source, s.annotation, s.status, s.created_at
         FROM ai_samples s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.store_id=$1 AND s.image_path LIKE '/uploads/%' ORDER BY s.id`, [user.storeId]);
    const items: { name: string; data: Buffer }[] = [];
    const manifest: any[] = [];
    let copied = 0, skipped = 0;
    for (const s of rows as any[]) {
      const f = uploadsFilePath(String(s.image_path));
      if (!existsSync(f)) { skipped++; continue; }
      const rel = String(s.image_path).replace(/^\/uploads\//, '');
      items.push({ name: `backup/images/${rel}`, data: readFileSync(f) });
      manifest.push({ productId: Number(s.product_id), productName: s.product_name, barcode: s.product_barcode,
                      imagePath: String(s.image_path), source: s.source, annotation: s.annotation,
                      status: s.status, createdAt: s.created_at });
      copied++;
    }
    items.push({ name: 'backup/manifest.json', data: Buffer.from(JSON.stringify(
      { store: user.storeId, exportedAt: new Date().toISOString(), count: copied, items: manifest }), 'utf8') });
    items.push({ name: 'backup/README.txt', data: Buffer.from(
      `门店 ${user.storeId} AI 样本备份：${copied} 张图（跳过 ${skipped} 张缺失）。\n` +
      `恢复方式：① 整目录拷回 AI_UPLOADS_DIR + PG 恢复 ai_samples（全量灾备）；\n` +
      `② POST /ai/samples/import 按 manifest.json 分批回传（选择性恢复/跨店迁移）。`, 'utf8') });
    const zip = makeZip(items);
    await audit(user.storeId, user.sub, 'AI', 'ai.samples.export', 'ai_samples', undefined, { copied, skipped });
    return { base64: zip.toString('base64'), count: copied, skipped,
             fileName: `ai-samples-store${user.storeId}-${new Date().toISOString().slice(0, 10)}.zip` };
  }

  /** 恢复导入（数据丢失/损坏/迁移）：items 每条 = 一张样本图 + 挂靠商品。单批 ≤200，可分批回传 */
  @Post('samples/import')
  @RequirePerms('ai.train.launch')
  async samplesImport(@Body() b: { items: { productId: number; imageBase64: string; filename?: string;
                                            angle?: string; source?: string; status?: string; annotation?: any }[] },
                      @CurrentUser() user: AuthUser) {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, 'items 为空（每条 = productId + imageBase64）');
    if (items.length > 200) throw new BizException(40003, '单批最多 200 条，请分批回传');
    let ok = 0;
    const failed: string[] = [];
    return tx(async c => {
      for (const [i, it] of items.entries()) {
        try {
          const raw = String(it.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
          const buf = Buffer.from(raw, 'base64');
          if (!buf.length) { failed.push(`#${i} 图片数据为空`); continue; }
          const p = await cx(c, `SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(it.productId)]);
          if (!p.length) { failed.push(`#${i} 商品不存在：${it.productId}`); continue; }
          const fname = /^[\w\-.]{1,80}$/.test(String(it.filename || '')) ? String(it.filename) : `restore_${Date.now()}_${i}.jpg`;
          const path = saveUploadImage(buf, fname);
          const ann = { ...(it.annotation || {}), ...(it.angle ? { angle: String(it.angle) } : {}), restored: true };
          const status = ['已审核', '已入库', '待审核', '不合格'].includes(String(it.status)) ? String(it.status) : '待审核';
          await cx(c,
            `INSERT INTO ai_samples (store_id, product_id, image_path, source, annotation, status)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [user.storeId, Number(it.productId), path, String(it.source || '备份恢复'), JSON.stringify(ann), status]);
          ok++;
        } catch (e: any) {
          failed.push(`#${i} ${e?.message || '写入失败'}`);
        }
      }
      await audit(user.storeId, user.sub, 'AI', 'ai.samples.import', 'ai_samples', undefined, { imported: ok, failed: failed.length });
      return { ok: true, imported: ok, failedCount: failed.length, failed: failed.slice(0, 10) };
    });
  }
}

@Module({ controllers: [AiController, AiModelsController, AiOcrController, AiSignatureController] })
export class AiModule {
  onModuleInit() {
    // V4.15.5：识别帧保留期清理（ai.frames.retention_days，默认 30 天；详见 ai.housekeeping.ts）
    scheduleFrameCleanup();
    // V4.27.1 Q10：后台加载激活检测模型 + 多件定位模型 session（热加载已有 session 缓存，此处消首次冷启动）
    prewarmModels().catch(() => {});
    // V4.27.6：AI 自动训练调度（每 10 分钟检查一次是否到计划时间；开关/计划见系统设置 ai.autotrain.*）
    setInterval(() => { autotrainTick().catch(() => {}); }, 10 * 60 * 1000);
  }
}
