/**
 * V4.15.5 · AI 图片存储统一入口（common/uploads.ts）
 *   背景：上万 SKU 规模下识别帧/样本图会涨到数万~数十万张（见 V4.15.4 存储方案）。
 *   三项治理：
 *     ① AI_UPLOADS_DIR 环境变量：图片目录外置到独立数据盘/NAS（冷热分层），默认仍为 backend/public/uploads；
 *     ② 新落盘图片按月分目录 uploads/YYYY-MM/，防单目录文件数爆炸；
 *     ③ 识别帧保留期清理见 modules/ai.housekeeping.ts（ai.frames.retention_days）。
 *   兼容：历史图片是 /uploads/<file>.jpg（无子目录），新图是 /uploads/YYYY-MM/<file>.jpg，
 *        读取一律走 uploadsFilePath()（按相对路径拼目录），旧新通吃。
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, sep, basename } from 'path';

export const UPLOADS_DIR = process.env.AI_UPLOADS_DIR
  ? join(process.env.AI_UPLOADS_DIR)
  : join(__dirname, '..', '..', 'public', 'uploads');

/**
 * /uploads/... 相对路径 → 磁盘绝对路径（支持外置目录与按月子目录）
 * P1-H3 收口：拒绝 .. / 反斜杠 / 盘符绝对路径，resolve 后强制在 UPLOADS_DIR 内；
 * 非法输入返回 ''（调用方 existsSync 即跳过），杜绝任意文件读取。
 */
export function uploadsFilePath(imagePath: string): string {
  const raw = String(imagePath || '');
  const rel = raw.replace(/^\/?uploads\/?/, '');
  if (!rel || rel.includes('..') || rel.includes('\\') || /^[a-zA-Z]:|^[/\\]/.test(rel)) return '';
  const abs = resolve(join(UPLOADS_DIR, rel));
  const root = resolve(UPLOADS_DIR);
  if (abs !== root && !abs.startsWith(root + sep)) return '';
  return abs;
}

/** P4：解码后校验文件头 magic-byte，确认确为 PNG/JPEG/WebP（拒绝把任意内容伪装成图片上传） */
export function isRealImage(buf: Buffer, ext: string): boolean {
  if (!buf || buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  if (ext === 'png') return png;
  if (ext === 'jpg') return jpg;
  if (ext === 'webp') return webp;
  return png || jpg || webp;
}

/** 新图落盘：按月分目录 /uploads/YYYY-MM/<filename>，返回相对路径 */
export function saveUploadImage(raw: Buffer, filename: string): string {
  const d = new Date();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dir = join(UPLOADS_DIR, ym);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), raw);
  return `/uploads/${ym}/${filename}`;
}
