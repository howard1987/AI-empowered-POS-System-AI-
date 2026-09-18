/**
 * V4.15.5 · AI 识别帧保留期清理（ai.housekeeping.ts）
 *   背景：每次 AI 识别都会把识别帧落盘（frame_*.jpg，10s 节流），是图片存储最大的增长源；
 *   样本图（correct_、sample_ 前缀）是训练资产永久保留，识别帧是过程数据按保留期滚动清理。
 *   规则：
 *     - 设置 ai.frames.retention_days（默认 30；0=关闭清理）；
 *     - 只删 frame_*.jpg 且 mtime 早于保留期，且路径未被 ai_samples 引用（纠正帧会提升为样本，绝不误删）；
 *     - 递归遍历（兼容按月子目录 uploads/YYYY-MM/ 与历史平铺结构）；
 *     - 启动 90s 后首跑，此后每 6 小时一轮；删除失败逐文件跳过不中断。
 *   说明：清理后历史 ai_recognition_logs 的 image_path 指向的文件将 404——识别帧为过程数据，
 *   日志统计不依赖原图；如需复核请在保留期内处理。
 */
import { readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { q } from '../common/db';
import { UPLOADS_DIR, uploadsFilePath } from '../common/uploads';

let timer: ReturnType<typeof setInterval> | null = null;

/** 清理一轮：返回 { scanned, deleted, freedBytes } */
export async function cleanupFrames(): Promise<{ skipped?: boolean; scanned?: number; deleted?: number; freedBytes?: number; error?: string }> {
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.frames.retention_days'`);
    const days = Number(r?.[0]?.value ?? 30);
    if (!days || days <= 0) return { skipped: true };
    const cutoff = Date.now() - days * 86400_000;

    // 样本库引用保护：ai_samples 引用的任何 /uploads/ 文件不删（纠正帧已提升为样本）
    const prot = new Set<string>();
    const rows = await q(`SELECT image_path FROM ai_samples WHERE image_path LIKE '/uploads/%'`);
    for (const row of rows as any[]) {
      const p = uploadsFilePath(String(row.image_path));
      if (p.startsWith(UPLOADS_DIR)) prot.add(p.toLowerCase());
    }

    let scanned = 0, deleted = 0, freedBytes = 0;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { walk(full); continue; }
        if (!/^frame_.*\.jpg$/i.test(name)) continue;
        scanned++;
        if (st.mtimeMs >= cutoff) continue;
        if (prot.has(full.toLowerCase())) continue;   // 被样本引用 → 保护
        try { unlinkSync(full); deleted++; freedBytes += st.size; } catch { /* 占用/权限，跳过 */ }
      }
    };
    walk(UPLOADS_DIR);
    if (deleted) console.log(`[AI清理] 识别帧保留 ${days} 天：删除 ${deleted} 张，释放 ${(freedBytes / 1048576).toFixed(1)}MB`);
    return { scanned, deleted, freedBytes };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

/** 挂载到 AiModule onModuleInit：启动 90s 首跑 + 每 6 小时一轮 */
export function scheduleFrameCleanup() {
  if (timer) return;
  setTimeout(() => { cleanupFrames(); }, 90_000);
  timer = setInterval(() => { cleanupFrames(); }, 6 * 3600_000);
  timer.unref?.();
}
