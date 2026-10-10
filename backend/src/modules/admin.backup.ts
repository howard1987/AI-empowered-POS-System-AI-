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
import { Body, Controller, Get, Injectable, Module, OnModuleDestroy, OnModuleInit, Param, Post, Query, Req, Res } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q1, audit } from '../common/db';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { logDangerousOp } from './reset.history';

const DATABASE_URL = process.env.DATABASE_URL;
/** 恢复专用连接串：恢复需 DROP/重建全部对象（--clean），须用属主/超户角色；
 *  默认回落 DATABASE_URL。部署时应将 RESTORE_DATABASE_URL 指向 postgres 超户或库属主，
 *  否则 pos_app 等最小权限角色会因「must be owner」失败（缺陷 D3）。 */
const RESTORE_DATABASE_URL = process.env.RESTORE_DATABASE_URL || DATABASE_URL;
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

/** V5.0.18 备份保留策略缓存（keep_count 份数上限 / max_total_gb 总大小上限；0=不限）。
 *  cleanupOld 在同步上下文中执行，故由 async 的 refreshLimits() 预先刷新缓存
 *  （tick 每分钟刷新、手动备份前刷新）；读不到设置回退 0=不限，绝不阻断备份主流程。 */
let limitCache = { keepCount: 0, maxTotalGb: 0 };
async function refreshLimits(): Promise<void> {
  try {
    const kc = await q1(`SELECT value #>> '{}' AS v FROM system_settings WHERE setting_key='ops.backup.keep_count'`);
    const mt = await q1(`SELECT value #>> '{}' AS v FROM system_settings WHERE setting_key='ops.backup.max_total_gb'`);
    limitCache = { keepCount: Math.max(0, Number(kc?.v ?? 0)) || 0,
                   maxTotalGb: Math.max(0, Number(mt?.v ?? 0)) || 0 };
  } catch { /* 保留上次缓存 */ }
}

/** 清理备份：① 按保留天数过期（env POS_BACKUP_RETAIN_DAYS，默认 14 天）
 *  ② V5.0.18 按份数循环覆盖（ops.backup.keep_count，保留最近 N 份，超出删最旧）
 *  ③ V5.0.18 按总大小限制（ops.backup.max_total_gb，从最旧删起直到达标）
 *  返回清理数量。limits 由调用方异步读取后传入（0 = 不限）。 */
function cleanupOld(limits?: { keepCount: number; maxTotalGb: number }): number {
  if (!fs.existsSync(BACKUP_ROOT)) return 0;
  const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
  type Item = { dir: string; mtime: number; size: number };
  const items: Item[] = [];
  for (const e of fs.readdirSync(BACKUP_ROOT)) {
    const dir = path.join(BACKUP_ROOT, e);
    try {
      const st = fs.statSync(dir);
      if (st.isDirectory()) items.push({ dir, mtime: st.mtimeMs, size: dirSize(dir) });
    } catch { /* 跳过异常项 */ }
  }
  items.sort((a, b) => a.mtime - b.mtime);   // 最旧在前
  let removed = 0;
  const kill = (it: Item) => { try { fs.rmSync(it.dir, { recursive: true, force: true }); removed++; } catch { /* noop */ } };
  // ① 天数过期
  for (const it of items) if (it.mtime < cutoff) kill(it);
  const alive = () => items.filter(it => fs.existsSync(it.dir));
  // ② 份数上限：保留最近 N 份，从最旧开始删
  const keep = limits?.keepCount ?? 0;
  if (keep > 0) {
    let list = alive();
    while (list.length > keep) { kill(list[0]); list = alive(); }
  }
  // ③ 总大小上限：从最旧删起直到达标
  const maxBytes = (limits?.maxTotalGb ?? 0) * 1024 * 1024 * 1024;
  if (maxBytes > 0) {
    let list = alive();
    let total = list.reduce((s, it) => s + it.size, 0);
    while (total > maxBytes && list.length > 1) {   // 至少保 1 份，删空比超额更危险
      total -= list[0].size;
      kill(list[0]);
      list = alive();
    }
  }
  return removed;
}

/** 目录大小（递归，字节） */
function dirSize(dir: string): number {
  let size = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) size += dirSize(p);
      else { try { size += fs.statSync(p).size; } catch { /* noop */ } }
    }
  } catch { /* noop */ }
  return size;
}

/** 本地日期 YYYY-MM-DD（与备份目录名 tsName() 同用本地时区，避免跨日判断错位） */
function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今日是否已有有效备份（用于防止每次服务重启都重复全量备份） */
function hasBackupToday(): boolean {
  try {
    if (!fs.existsSync(BACKUP_ROOT)) return false;
    const ymd = tsName().slice(0, 8);   // YYYYMMDD（本地时区，与目录名一致）
    return fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .some(e => e.isDirectory() && e.name.startsWith(ymd)
              && fs.existsSync(path.join(BACKUP_ROOT, e.name, 'database.dump')));
  } catch { return false; }
}

/** 执行一次备份（手动 / 自动共用）。返回相对路径与统计信息。
 *  nameOverride：供「恢复前保险快照」传入带唯一后缀的名字，避免与同一秒内的目标备份同名而被覆盖。 */
export function doBackup(nameOverride?: string): { name: string; file: string; size: number; tookMs: number; removed: number } {
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
    // S-09：stderr 详情（主机/端口/角色名等部署细节）只入服务端日志，不回显给调用方
    console.error('[备份失败] pg_dump:', err.slice(-2000));
    // 失败时清理半成品，避免留下半截文件被列表误认
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    throw new BizException(50000, '数据库备份失败，请查看服务端日志（logs/error.log）');
  }
  const size = fs.statSync(file).size;
  const tookMs = Date.now() - t0;
  const removed = cleanupOld(limitCache);
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
  // ② 恢复：必须用属主/超户连接（RESTORE_DATABASE_URL）执行 --clean（DROP 需属主权限）；
  //   --no-privileges 已移除 → 备份中携带的 GRANT（如 pos_app 的访问授权）在恢复后重新生效，避免恢复后应用失权。
  const restore = locatePgRestore();
  const t0 = Date.now();
  const r = spawnSync(restore, ['--clean', '--if-exists', '--no-owner',
    '--format=custom', '--dbname', RESTORE_DATABASE_URL, f], {
    cwd: process.cwd(),
    timeout: 10 * 60_000,
    maxBuffer: 200 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || r.error?.message || 'pg_restore 执行失败');
    // S-09：stderr 详情只入服务端日志；对客户端保留「可回退的保险快照名」这一行动信息
    console.error('[恢复失败] pg_restore:', err.slice(-2000));
    // 恢复失败：保险快照已生成，提示用户可从 safe.name 回退
    throw new BizException(50000, '数据库恢复失败（已自动备份当前库为 ' + safe.name + '，详情见服务端日志）');
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
  // V5.0.19f：原为 sys.data.backup（备份权限即可覆盖整个库）→ 改为独立高危权限点
  @RequirePerms('sys.data.restore')
  async restore(@Param('name') name: string, @Body() b: { password?: string; confirmName?: string },
                @CurrentUser() user: AuthUser) {
    if (!/^[A-Za-z0-9_-]+$/.test(name || '')) throw new BizException(40003, '非法的备份名称');
    // 保险机制 ①：登录密码复核（与清库同规格的强认证）
    if (!b?.password) throw new BizException(40003, '恢复数据库需二次确认：请再次输入您的登录密码');
    const me = await q1<any>(`SELECT password_hash FROM employees WHERE id=$1`, [user.sub]);
    if (!me || !bcrypt.compareSync(String(b.password), me.password_hash)) {
      throw new BizException(41002, '登录密码不正确，已取消恢复', 401);
    }
    // 保险机制 ②：备份名二次确认 —— 手打一遍备份名，杜绝在列表里误点相邻项
    // （恢复是覆盖整个库，选错一个备份 = 把业务数据换成了另一个时间点的状态）
    if (!b.confirmName || String(b.confirmName) !== name) {
      throw new BizException(40003, `请正确输入要恢复的备份名称「${name}」以完成二次确认`);
    }
    const r = doRestore(name);
    await audit(user.storeId, user.sub, '系统', '数据库恢复', 'restore', null,
      { name: r.name, size: r.size, tookMs: r.tookMs, backupName: r.backupName }).catch(() => { });
    // V5.0.19e：恢复同样是不可逆高危操作 → 写入不可删的 data_reset_history（audit_logs 会被恢复覆盖，不能只靠它）
    await logDangerousOp({
      op: 'restore', storeId: user.storeId, employeeId: user.sub,
      empNo: (user as any).empNo ?? null, empName: (user as any).name ?? null,
      backupName: r.backupName, detail: { restoredFrom: r.name, size: r.size, tookMs: r.tookMs },
    });
    return { ok: true, ...r };
  }
}

/** 自动备份定时任务：把 ops.backup_hour 这个长期空配置变成真功能 */
@Injectable()
export class BackupJob implements OnModuleInit, OnModuleDestroy {
  private timer: any;
  private lastDay = '';

  onModuleInit() {
    // V5.0.19e 加固：lastDay 原本只存在内存里 —— 服务每重启一次就会再全量备份一次
    // （2026-10-09 一晚因反复重启产生了 14 份备份，既浪费磁盘又提前触发保留期清理）。
    // 启动时先看磁盘上今天是否已有备份，有则视为已跑过。
    if (hasBackupToday()) this.lastDay = localDay();
    this.timer = setInterval(() => { this.tick().catch(() => { }); }, 60_000);
    console.log(`[备份] 数据库自动备份定时器已启动（每日 ${DEFAULT_HOUR} 起，ops.backup_hour 可改；保留 ${RETAIN_DAYS} 天）` +
      (this.lastDay ? `；今日已有备份，本次启动不再重复备份` : ''));
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    try {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      await refreshLimits().catch(() => { });   // V5.0.18：刷新备份保留策略缓存
      const target = await getBackupHour();
      // 当天还没到设定时刻 → 不跑；已跑过 → 不重复（窗口 = 设定时刻起到当天结束，命中即锁当天）
      if (hhmm < target) return;
      const day = localDay();   // V5.0.19e：改用本地日（原 UTC 日与备份目录名的本地日不一致，跨时区会重复备份）
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
