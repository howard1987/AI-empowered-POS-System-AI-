/**
 * V4.27.0 · 多帧跟踪平滑（借鉴 ultralytics 目标跟踪思想：连续帧匹配 + 置信度平滑）
 *   - 场景：PWA/收银端 1.6s/帧连续识别，单帧判定会在置信度边界抖动（忽闪/摇摆）。
 *     对连续帧识别结果做"同品 + IoU"匹配，连续 ≥N 帧命中同一商品标记稳定，
 *     置信度做 EMA 平滑（trackConf），给店员/前端明确的"稳定确认"信号。
 *   - 铁律：只做增量标注，绝不改变三门槛命中判定（融合分只排序/门槛不旁路）。
 *     stable 不用于放行低分命中，仅用于 ① 结果注释 ② 前端可对 stable 项免重复语音播报。
 *   - 实现：内存态（重启清零，可接受——跟踪本来就是帧间短程状态），按 store:device 隔离，
 *     TTL 5s 自动淘汰旧轨迹，单设备轨迹上限 50（防异常帧数撑爆内存）。
 */
import { q } from '../common/db';

export interface TrackItem { productId: number; conf: number; bbox?: number[] }
export interface TrackState extends TrackItem { hits: number; ema: number; lastSeen: number }

const TTL_MS = 5000;      // 轨迹有效期（超过视为新目标；略大于连拍间隔 1.6s 的 3 倍）
const IOU_TH = 0.3;       // 同品且框 IoU ≥ 该值才认作同一实例（多件同品各自独立计数）
const EMA_A = 0.6;        // EMA 平滑系数（旧值权重）
const MAX_TRACKS = 50;

const tracks = new Map<string, TrackState[]>();

function boxIou(a: number[] = [], b: number[] = []): number {
  const ax1 = a[0], ay1 = a[1], aw = a[2] || 0, ah = a[3] || 0;
  const bx1 = b[0], by1 = b[1], bw = b[2] || 0, bh = b[3] || 0;
  const ix = Math.max(0, Math.min(ax1 + aw, bx1 + bw) - Math.max(ax1, bx1));
  const iy = Math.max(0, Math.min(ay1 + ah, by1 + bh) - Math.max(ay1, by1));
  const inter = ix * iy;
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0 : inter / union;
}

export async function trackEnabled(): Promise<boolean> {
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.track.enabled'`);
    return r.length ? r[0].value !== false : true;   // 默认开启
  } catch { return true; }
}

export async function stableFrames(): Promise<number> {
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.track.stable_frames'`);
    const v = Number(r[0]?.value ?? NaN);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 2;
  } catch { return 2; }
}

/**
 * 一帧识别结果 → 匹配/延续轨迹。返回与 items 等长的轨迹状态数组（含 hits/ema）。
 * 匹配规则：productId 相同 且（双方有 bbox 时 IoU ≥ IOU_TH，否则视为同一实例）。
 * 同品多实例（两瓶同款）靠 bbox 区分；无 bbox（多件聚合计数）按商品粒度匹配。
 */
export function trackFrame(storeId: number, deviceId: number | null, items: TrackItem[], now = Date.now()): TrackState[] {
  const key = `${storeId}:${deviceId ?? 0}`;
  const alive = (tracks.get(key) || []).filter(t => now - t.lastSeen <= TTL_MS);
  const used = new Set<number>();
  const out: TrackState[] = [];
  for (const it of items) {
    let best = -1, bestIou = -1;
    for (let i = 0; i < alive.length; i++) {
      if (used.has(i)) continue;
      const t = alive[i];
      if (t.productId !== it.productId) continue;
      const v = (it.bbox && t.bbox) ? boxIou(it.bbox, t.bbox) : 1;
      if (v >= IOU_TH && v > bestIou) { best = i; bestIou = v; }
    }
    if (best >= 0) {
      const t = alive[best];
      used.add(best);
      t.hits += 1;
      t.conf = it.conf;
      t.ema = Math.round((EMA_A * t.ema + (1 - EMA_A) * it.conf) * 1000) / 1000;
      if (it.bbox) t.bbox = it.bbox;
      t.lastSeen = now;
      out.push(t);
    } else {
      out.push({ ...it, hits: 1, ema: it.conf, lastSeen: now });
    }
  }
  // 未匹配的旧轨迹保留（商品可能下一帧回到画面），与新一帧合并
  const rest = alive.filter((_, i) => !used.has(i));
  tracks.set(key, [...out, ...rest].slice(0, MAX_TRACKS));
  return out;
}

/** 测试/热更新辅助：清空全部轨迹 */
export function resetTracks(): void { tracks.clear(); }
