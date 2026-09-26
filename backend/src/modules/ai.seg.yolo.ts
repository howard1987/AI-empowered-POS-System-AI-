/**
 * V4.27.0 · 多件识别定位升级（借鉴 ultralytics：YOLO 检测式定位优先，轮廓分割兜底）
 *   - 动机：原 ai.seg.ts 为零训练亮度阈值分割，仅适用"浅色秤盘/台面"受限场景；
 *     换用 ultralytics 训练的单类「商品」detect 模型（backend/ai-train 训练包产出）后，
 *     任意背景/光照/堆叠都能框出每件商品，逐件 CLIP 检索的 crop 质量同步提升。
 *   - 模型选择：system_settings ai.seg.model_id = ai_models.id（detect 模型）；
 *     0 / 模型缺失 / 推理失败 → 返回 null，调用方回落 ai.seg.ts 轮廓分割（链路永不阻断）。
 *   - 复用 ai.detect.ts 真机推理管线（letterbox 640 + NMS + 坐标还原），零新增依赖。
 *   - 注意：定位模型建议单类（nc=1）；多类模型须在 ai_models.metrics.classes 配齐映射，
 *     否则 parseDetect 的 nc 与输出通道不匹配会解析失败（仍走回落，不报错）。
 */
import { q } from '../common/db';
import { runDetection, AiModelMeta } from './ai.detect';
import { SegBox, SegResult } from './ai.seg';

const PAD_PCT = 0.06;        // 框外扩比例（保住商品边缘，与轮廓分割 PAD_PCT 同目的）
const MAX_BOXES = 12;        // 与轮廓分割一致的上限（防极端噪声拖垮逐件检索）

/** 读取定位模型元信息（未配置/模型非 detect/未导入 → null） */
async function locatorMeta(): Promise<{ meta: AiModelMeta; minConf: number } | null> {
  const cfg = await q(`SELECT value FROM system_settings WHERE setting_key='ai.seg.model_id'`);
  const id = Number(cfg[0]?.value ?? 0);
  if (!Number.isFinite(id) || id <= 0) return null;
  const rows = await q(`SELECT * FROM ai_models WHERE id=$1`, [id]);
  if (!rows.length) return null;
  const row = rows[0];
  const mode = (row.metrics?.mode) || row.task;
  if (mode !== 'detect') return null;
  // 单类定位模型的缺省类别映射（parseDetect 以 classes 数量定 nc，须与模型输出通道一致）
  const classes = row.metrics?.classes && Object.keys(row.metrics.classes).length
    ? row.metrics.classes
    : { '0': { name: '商品' } };
  const confRow = await q(`SELECT value FROM system_settings WHERE setting_key='ai.seg.yolo_min_conf'`);
  const minConf = Number(confRow[0]?.value ?? 0.25);
  return {
    meta: { id: Number(row.id), name: String(row.name), file_path: String(row.file_path), mode: 'detect', classes },
    minConf: Number.isFinite(minConf) && minConf > 0 ? minConf : 0.25,
  };
}

/**
 * 识别帧 → YOLO 检出每件商品外接框（原图坐标 + 外扩）。
 * 返回 null 表示未配置定位模型或推理失败（调用方回落轮廓分割）；
 * multi=false 表示检出 0~1 件（调用方回落单件管线），与 ai.seg.ts 契约一致。
 */
export async function segmentItemsYolo(imageBase64: string): Promise<SegResult | null> {
  const t0 = Date.now();
  try {
    const loc = await locatorMeta();
    if (!loc) return null;
    const det = await runDetection(loc.meta, imageBase64, loc.minConf);
    if (!det.ok) return null;
    const boxes: SegBox[] = det.boxes
      .filter(b => b.bbox && b.bbox[2] > 4 && b.bbox[3] > 4 && b.conf >= loc.minConf)
      .sort((a, b) => b.conf - a.conf)
      .slice(0, MAX_BOXES)
      .map(b => {
        const [x, y, w, h] = b.bbox!;
        const px = Math.round(PAD_PCT * Math.max(w, h));
        return {
          x: Math.max(0, Math.floor(x - px)),
          y: Math.max(0, Math.floor(y - px)),
          w: Math.ceil(w + 2 * px),
          h: Math.ceil(h + 2 * px),
          frac: 0,   // 占位：YOLO 框无需面积占比过滤（仅轮廓分割使用 frac 过滤）
        };
      });
    // 原图宽高未透传（runDetection 不返回尺寸），契约只消费 boxes/multi/ms，置 0 不影响调用方
    return { multi: boxes.length >= 2, boxes, ms: Date.now() - t0, w: 0, h: 0 };
  } catch {
    return null;
  }
}
