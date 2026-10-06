/**
 * 数据库备份（V5.0.15 新增）：让「系统设置 → 应急与运维」下长期为空配置的
 *   ops.backup_hour（每日备份时间）真正生效，并补上此前缺失的手动「立即备份」入口。
 *
 * 定位：灾备。把整个业务库做一次逻辑备份（pg_dump --format=custom），落盘到
 *   backups/<时间戳>/database.dump，可随时用 pg_restore 恢复。
 *   - POST /admin/backup/now          立即备份（手动触发，受 sys.data.backup 权限控制）
 *   - GET  /admin/backup/list         列出最近备份（同名权限）
 *   - GET  /admin/backup/download/:name 下载某个备份（同名权限，防路径穿越）
 *   - POST /admin/backup/restore/:name 从某个备份恢复（同名权限；恢复前自动备份当前库作保险）
 *   - POST /admin/backup/upload       导入外部备份文件（二进制直传，落盘后需点「恢复」生效）
 *   - 自动备份：进程内 setInterval 每分钟检查，到达 ops.backup_hour 所设时刻（且当日未跑）即备份，
 *     保留最近 POS_BACKUP_RETAIN_DAYS（默认 14）天，过期目录自动清理。
 *
 * 安全设计：
 *  1) 全部接口受 @RequirePerms('sys.data.backup') 守卫（与开业初始化同源权限）；
 *  2) 下载接口 :name 强制白名单校验（仅 [A-Za-z0-9_-]），杜绝 ../ 路径穿越；
 *  3) 备份目录固定为 cwd/backups，绝不接受客户端传入路径；
 *  4) pg_dump 连接串取自服务端 DATABASE_URL（与业务库一致），密码不落盘、不回显。
 */
import { Controller, Get, Injectable, Module, OnModuleDestroy, OnModuleInit, Param, Post, Query, Req, Res } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q1, audit } from '../common/db';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

const DATABASE_URL = process.env.DATABASE_URL;
const BACKUP_ROOT = path.resolve(process.cwd(), 'backups');
const RETAIN_DAYS = Math.max(1, Number(process.env.POS_BACKUP_RETAIN_DAYS || 14));
const DEFAULT_HOUR = '02:30';
/** 上传体积上限 8GB（流式计数，超限即中断并删除半成品） */
const MAX_UPLOAD = 8 * 1024 * 1024 * 1024;

/** 定位 pg_dump：优先仓库自带 vendor 工具，否则回退系统 PATH 上的 pg_dump */
function locatePgDump(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(process.cwd(), 'vendor', 'pg-tools', 'bin', 'pg_dump' + ext),
    path.join(process.cwd(), 'pg-tools', 'bin', 'pg_dump' + ext),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'pg_dump' + ext; // 回退 PATH（如已装入系统 PostgreSQL）
}

/** 定位 pg_restore：与 pg_dump 同源（vendor 优先，回退 PATH） */
function locatePgRestore(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(process.cwd(), 'vendor', 'pg-tools', 'bin', 'pg_restore' + ext),
    path.join(process.cwd(), 'pg-tools', 'bin', 'pg_restore' + ext),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'pg_restore' + ext;
}

/** 文件系统安全的时间戳目录名：YYYYMMDD_HHmmss */
function tsName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 清理超过保留期的备份目录，返回清理数量 */
function cleanupOld(): number {
  if (!fs.existsSync(BACKUP_ROOT)) return 0;
  const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
  let removed = 0;
  for (const e of fs.readdirSync(BACKUP_ROOT)) {
    const dir = path.join(BACKUP_ROOT, e);
    try {
      const st = fs.statSync(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch { /* 跳过异常项 */ }
  }
  return removed;
}

/** 执行一次备份（手动 / 自动共用）。返回相对路径与统计信息。
 *  nameOverride：供「恢复前保险快照」传入带唯一后缀的名字，避免与同一秒内的目标备份同名而被覆盖。 */
function doBackup(nameOverride?: string): { name: string; file: string; size: number; tookMs: number; removed: number } {
  if (!DATABASE_URL) throw new BizException(50000, '缺少 DATABASE_URL 环境变量，无法执行备份');
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const dump = locatePgDump();
  const name = nameOverride || tsName();
  const dir = path.join(BACKUP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'database.dump');
  const t0 = Date.now();
  // pg_dump 支持把连接串直接作为最后一个位置参数（dbname）
  const r = spawnSync(dump, ['--no-owner', '--format=custom', '--file', file, DATABASE_URL], {
    cwd: process.cwd(),
    timeout: 10 * 60_000,
    maxBuffer: 200 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || r.error?.message || 'pg_dump 执行失败');
    // 失败时清理半成品，避免留下半截文件被列表误认
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    throw new BizException(50000, '数据库备份失败：' + err.slice(-500));
  }
  const size = fs.statSync(file).size;
  const tookMs = Date.now() - t0;
  const removed = cleanupOld();
  return { name, file: path.join(name, 'database.dump'), size, tookMs, removed };
}

/**
 * 导入外部备份文件：前端以 application/octet-stream 直传裸流（不用 multipart，免依赖），
 * 边收边落盘到 backups/upload_<时间戳>_<随机>/database.dump，随后由 /restore/:name 走同一条恢复链路。
 *  安全：目录名完全由服务端生成（绝不采用客户端文件名，杜绝路径穿越）；流式计数超 8GB 即中断；
 *  落盘后校验文件头必须是 pg_dump custom（PGDMP）或 SQL 文本，否则删除并报错，避免垃圾文件混进备份列表。
 */
async function doUpload(req: any): Promise<{ name: string; size: number; kind: string }> {
  const ct = String(req?.headers?.['content-type'] || '');
  if (/multipart\/form-data|application\/json|application\/x-www-form-urlencoded/i.test(ct)) {
    throw new BizException(40003, '请以二进制流上传备份文件（不要使用表单方式）');
  }
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const name = `upload_${tsName()}_${randomBytes(3).toString('hex')}`;
  const dir = path.join(BACKUP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'database.dump');
  let received = 0;
  const counter = new Transform({
    transform(chunk: any, _enc: string, cb: any) {
      received += chunk.length;
      if (received > MAX_UPLOAD) cb(new Error('文件超过 8GB 上限')); else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(file));
  } catch (e: any) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    throw new BizException(50000, '上传失败：' + String(e?.message || e).slice(-300));
  }
  const size = fs.statSync(file).size;
  if (size < 64) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    throw new BizException(40003, '文件过小，不是有效的备份文件');
  }
  // 文件头校验：custom 格式以 PGDMP 开头；SQL 文本以注释/SET/COPY/CREATE 开头
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  const isCustom = head.slice(0, 5).toString('latin1') === 'PGDMP';
  const isSql = /^\s*(--|SET\s|COPY\s|CREATE\s)/i.test(head.toString('utf8'));
  if (!isCustom && !isSql) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    throw new BizException(40003, '不是有效的 pg_dump 备份文件（文件头校验失败）');
  }
  return { name, size, kind: isCustom ? 'custom' : 'sql' };
}

/**
 * 从指定备份恢复整个业务库。
 *  1) 先用 doBackup() 给「恢复前的当前库」拍一张保险快照，误操作也能回退；
 *  2) 再用 pg_restore --clean --if-exists 把目标备份的 schema+data 整体还原。
 * 注：恢复会 drop 并重建全部对象，当前活跃业务连接若持有旧对象可能短暂报错，
 * 属于一次性手动运维操作，操作期间请勿进行其它写库动作。
 */
function doRestore(name: string): { name: string; size: number; tookMs: number; backupName: string } {
  if (!DATABASE_URL) throw new BizException(50000, '缺少 DATABASE_URL 环境变量，无法执行恢复');
  const f = path.join(BACKUP_ROOT, name, 'database.dump');
  if (!fs.existsSync(f)) throw new BizException(40404, '备份不存在或已被清理');
  // ① 保险快照：先备份当前库，便于误恢复后找回。
  //    名字必须与目标备份不同 —— tsName() 只到秒，若与目标同名会直接把目标文件覆盖掉。
  const safe = doBackup(`${tsName()}_pre${Date.now().toString(36).slice(-4)}`);
  // ② 恢复
  const restore = locatePgRestore();
  const t0 = Date.now();
  const r = spawnSync(restore, ['--clean', '--if-exists', '--no-owner', '--no-privileges',
    '--format=custom', '--dbname', DATABASE_URL, f], {
    cwd: process.cwd(),
    timeout: 10 * 60_000,
    maxBuffer: 200 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || r.error?.message || 'pg_restore 执行失败');
    // 恢复失败：保险快照已生成，提示用户可从 safe.name 回退
    throw new BizException(50000, '数据库恢复失败（已自动备份当前库为 ' + safe.name + '）：' + err.slice(-500));
  }
  const tookMs = Date.now() - t0;
  return { name, size: fs.statSync(f).size, tookMs, backupName: safe.name };
}

/** 列出备份目录（按修改时间倒序） */
async function listBackups(): Promise<{ name: string; size: number; createdAt: number }[]> {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  const out: { name: string; size: number; createdAt: number }[] = [];
  for (const e of fs.readdirSync(BACKUP_ROOT)) {
    const dir = path.join(BACKUP_ROOT, e);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) continue;
      const f = path.join(dir, 'database.dump');
      if (!fs.existsSync(f)) continue;
      out.push({ name: e, size: fs.statSync(f).size, createdAt: st.mtimeMs });
    } catch { /* 跳过异常项 */ }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** 读取自动备份时刻（ops.backup_hour），默认 02:30 */
async function getBackupHour(): Promise<string> {
  try {
    const row = await q1(`SELECT value FROM system_settings WHERE setting_key='ops.backup_hour'`);
    if (row?.value) {
      const v = JSON.parse(row.value);
      if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) return v;
    }
  } catch { /* 读不到则用默认 */ }
  return DEFAULT_HOUR;
}

@Controller('admin/backup')
export class AdminBackupController {
  /** 立即备份（手动触发） */
  @Post('now')
  @RequirePerms('sys.data.backup')
  async backupNow(@CurrentUser() user: AuthUser) {
    const r = doBackup();
    await audit(user.storeId, user.sub, '系统', '数据库备份', 'backup', null,
      { name: r.name, size: r.size, tookMs: r.tookMs, kind: 'manual', removed: r.removed }).catch(() => { });
    return { ok: true, ...r };
  }

  /** 备份列表（最近在前） */
  @Get('list')
  @RequirePerms('sys.data.backup')
  async list() {
    return { items: await listBackups(), retainDays: RETAIN_DAYS };
  }

  /** 下载某个备份（防路径穿越） */
  @Get('download/:name')
  @RequirePerms('sys.data.backup')
  async download(@Param('name') name: string, @Res() res: any) {
    if (!/^[A-Za-z0-9_-]+$/.test(name || '')) throw new BizException(40003, '非法的备份名称');
    const f = path.join(BACKUP_ROOT, name, 'database.dump');
    if (!fs.existsSync(f)) throw new BizException(40404, '备份不存在或已被清理');
    res.download(f, `pos-backup-${name}.dump`);
  }

  /** 导入外部备份文件（二进制直传，落盘后需再点「恢复」才生效） */
  @Post('upload')
  @RequirePerms('sys.data.backup')
  async upload(@Req() req: any, @CurrentUser() user: AuthUser) {
    const r = await doUpload(req);
    await audit(user.storeId, user.sub, '系统', '导入备份文件', 'backup', null, r).catch(() => { });
    return { ok: true, ...r };
  }

  /** 从某个备份恢复整个数据库（危险操作；恢复前自动备份当前库作保险） */
  @Post('restore/:name')
  @RequirePerms('sys.data.backup')
  async restore(@Param('name') name: string, @CurrentUser() user: AuthUser) {
    if (!/^[A-Za-z0-9_-]+$/.test(name || '')) throw new BizException(40003, '非法的备份名称');
    const r = doRestore(name);
    await audit(user.storeId, user.sub, '系统', '数据库恢复', 'restore', null,
      { name: r.name, size: r.size, tookMs: r.tookMs, backupName: r.backupName }).catch(() => { });
    return { ok: true, ...r };
  }
}

/** 自动备份定时任务：把 ops.backup_hour 这个长期空配置变成真功能 */
@Injectable()
export class BackupJob implements OnModuleInit, OnModuleDestroy {
  private timer: any;
  private lastDay = '';

  onModuleInit() {
    this.timer = setInterval(() => { this.tick().catch(() => { }); }, 60_000);
    console.log(`[备份] 数据库自动备份定时器已启动（每日 ${DEFAULT_HOUR} 起，ops.backup_hour 可改；保留 ${RETAIN_DAYS} 天）`);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    try {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const target = await getBackupHour();
      // 当天还没到设定时刻 → 不跑；已跑过 → 不重复（窗口 = 设定时刻起到当天结束，命中即锁当天）
      if (hhmm < target) return;
      const day = now.toISOString().slice(0, 10);
      if (this.lastDay === day) return;
      this.lastDay = day;
      const r = doBackup();
      await audit(1, null, '系统', '数据库备份', 'backup', null,
        { name: r.name, size: r.size, tookMs: r.tookMs, kind: 'auto', removed: r.removed }).catch(() => { });
      console.log(`[备份] 自动备份完成：${r.name}（${Math.round(r.size / 1024)} KB，清理 ${r.removed} 个过期备份）`);
    } catch (e: any) {
      console.error('[备份] 自动备份失败（不影响业务）：', e?.message || e);
    }
  }
}

@Module({ controllers: [AdminBackupController], providers: [BackupJob] })
export class AdminBackupModule {}
