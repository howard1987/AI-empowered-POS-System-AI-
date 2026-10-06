/**
 * 服务端一体化启动器（随 release/server 发布）
 *
 *   node scripts/server-up.mjs            启动：内嵌 PG（可选）→ 幂等迁移 → 后端主进程（前台）
 *   node scripts/server-up.mjs stop       停止后端内嵌 PG
 *   node scripts/server-up.mjs status     查看 PG 状态与连接串
 *   node scripts/server-up.mjs migrate    仅重跑幂等迁移 / 管理员引导
 *   node scripts/server-up.mjs upgrade     内置 PostgreSQL 大版本升级时的数据迁移（自动备份/回滚）
 *
 *  版本锁定：内置 PG 版本由 package.json 钉死；若数据目录版本与内置不一致，启动时拒绝盲目
 *  启动并提示升级（除非设置 POS_PG_AUTO_UPGRADE=1 自动迁移）。
 *
 * 设计要点
 *  - PG 二进制与数据目录必须位于**纯 ASCII 路径**（PostgreSQL on Windows 限制），
 *    故运行时统一落到 C:\ProgramData\pos-cashier（可用 POS_DATA_DIR 覆盖；非 ASCII 会被自动跳过）。
 *  - .env 由本脚本直接解析（不依赖 cwd），字段见 deploy/env.example。
 *  - PG_MODE=embedded（默认，免安装便携库）| external（用外部已装 PG，读 DATABASE_URL）。
 */
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CMD = (process.argv[2] || 'up').toLowerCase();

// ────────────────────────── .env ──────────────────────────
function loadEnv() {
  const out = {};
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return out;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[s.slice(0, i).trim()] = v;
  }
  return out;
}

function appendEnv(key, value, comment) {
  const p = path.join(ROOT, '.env');
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const tail = cur.endsWith('\n') || !cur ? '' : '\r\n';
  fs.appendFileSync(p, `${tail}${comment ? '# ' + comment + '\r\n' : ''}${key}=${value}\r\n`);
}

const cfg = { ...loadEnv(), ...process.env };

// ─────────────────── 纯 ASCII 运行目录（PG 硬性要求）───────────────────
function pickAsciiDir() {
  const cands = [];
  if (cfg.POS_DATA_DIR) cands.push(cfg.POS_DATA_DIR);
  cands.push(path.join(process.env.ProgramData || 'C:\\ProgramData', 'pos-cashier'));
  cands.push(path.join(process.env.SystemDrive || 'C:', 'pos-cashier-data'));
  cands.push(path.join(os.tmpdir(), 'pos-cashier'));
  for (const c of cands) {
    if (/[^\x20-\x7E]/.test(c)) continue;            // 含非 ASCII → 跳过（PG 会拒绝）
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch { /* 试下一个 */ }
  }
  throw new Error('未找到可写的纯 ASCII 目录，请设置 POS_DATA_DIR 指向如 C:\\ProgramData\\pos-cashier');
}

// ────────────────────────── PG 管理 ──────────────────────────
const PG_SRC = path.join(ROOT, 'pg');                 // 随包 PG 二进制（initdb/pg_ctl/postgres…）
const PORT = Number(cfg.PG_PORT || 54329);
const PGPASSWORD_ = cfg.PG_PASSWORD || 'password';
let WORK, PGBIN, PGDATA;

function initPaths() {
  WORK = pickAsciiDir();
  PGBIN = path.join(WORK, 'pgbin');
  PGDATA = path.join(WORK, 'pgdata');
}

function ensurePgBin() {
  if (fs.existsSync(path.join(PGBIN, 'bin', 'initdb.exe'))) return;
  if (!fs.existsSync(PG_SRC)) throw new Error(`随包 PG 二进制缺失：${PG_SRC}（发布包不完整）`);
  console.log(`▶ 首次部署：释放 PostgreSQL 到纯 ASCII 路径 ${PGBIN}`);
  fs.rmSync(PGBIN, { recursive: true, force: true });
  fs.cpSync(PG_SRC, PGBIN, { recursive: true });
}

function pgCtl(args, opts = {}) {
  return spawnSync(path.join(PGBIN, 'bin', 'pg_ctl.exe'), args, { encoding: 'utf8', ...opts });
}

/** 中文 Windows 根治：给 PG 二进制注入 UTF-8 代码页 manifest，避免 initdb / postgres
 *  在读取系统区域名时将 GBK 字节当 UTF8 插入，导致 "invalid byte sequence 0xb3" 而初始化失败。
 *  仅 Windows 生效；以 initdb.exe 的修改时间判断是否需要重新注入（覆盖升级替换场景）。
 *  注入失败不阻断启动，降级为原样尝试 initdb。 */
function ensureUtf8Manifest() {
  if (process.platform !== 'win32') return;
  const flag = path.join(PGBIN, '.utf8patched');
  const exe = path.join(PGBIN, 'bin', 'initdb.exe');
  if (!fs.existsSync(exe)) return;
  if (fs.existsSync(flag) && fs.statSync(exe).mtimeMs <= fs.statSync(flag).mtimeMs) return;
  const bin = path.join(PGBIN, 'bin').replace(/\\/g, '\\\\');
  const ps = [
    '$ErrorActionPreference="Stop"',
    '$code=\'using System; using System.Runtime.InteropServices; public class R { [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr BeginUpdateResource(string p,bool d); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool UpdateResource(IntPtr h,IntPtr t,IntPtr n,ushort l,byte[] d,uint cb); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool EndUpdateResource(IntPtr h,bool disc); }\'',
    'Add-Type $code',
    '$xml=\'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity type="win32" name="pg" version="1.0.0.0"/><application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage></windowsSettings></application></assembly>\'',
    '$b=[System.Text.Encoding]::UTF8.GetBytes($xml)',
    'foreach ($f in @("initdb.exe","postgres.exe","pg_ctl.exe")) {',
    '  $e=Join-Path "' + bin + '" $f',
    '  if (!(Test-Path $e)) { continue }',
    '  try {',
    '    $h=[R]::BeginUpdateResource($e,$false)',
    '    [void][R]::UpdateResource($h,[IntPtr]24,[IntPtr]1,0,$b,$b.Length)',
    '    [void][R]::EndUpdateResource($h,$false)',
    '  } catch {}',
    '}'
  ].join('\n');
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    try { fs.writeFileSync(flag, new Date().toISOString()); } catch { /* noop */ }
  } catch (e) { /* 注入失败不阻断启动 */ }
}

function initDb(args) {
  ensureUtf8Manifest();
  return spawnSync(path.join(PGBIN, 'bin', 'initdb.exe'), args, { encoding: 'utf8' });
}

// ───────────────────── PostgreSQL 版本锁定与数据迁移 ─────────────────────
// 设计：随包 PG 二进制由 package.json 钉死版本。运行时校验"数据目录版本"与"内置二进制
// 版本"是否一致：不一致则拒绝盲目启动，提示用户升级（避免静默损坏 / 无法启动）。
// 用户提供 upgrade 命令后，本程序自动「备份 → 逻辑迁移(pg_dump/psql) → 校验 → 失败回滚」。

function runExe(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function pgMajorOf(text) {
  const m = String(text || '').match(/(\d+)(?:\.(\d+))?/);
  return m ? parseInt(m[1], 10) : null;
}

/** 内置 PostgreSQL 大版本：必须以"随包源 PG_SRC"为准（升级场景下已解压的 PGBIN 可能仍是旧二进制） */
function bundledPgMajor() {
  for (const base of [PG_SRC, PGBIN]) {
    const exe = path.join(base, 'bin', 'postgres.exe');
    if (fs.existsSync(exe)) {
      const r = runExe(exe, ['--version']);
      if (r.status === 0) { const v = pgMajorOf(r.stdout); if (v) return v; }
    }
  }
  return null;
}

function dataPgMajor() {
  const f = path.join(PGDATA, 'PG_VERSION');
  if (!fs.existsSync(f)) return null;
  return pgMajorOf(fs.readFileSync(f, 'utf8'));
}

function pendingFile() { return path.join(WORK, 'PG_UPGRADE_REQUIRED.txt'); }
function clearUpgradePending() { try { fs.unlinkSync(pendingFile()); } catch { /* noop */ } }

function writeUpgradePending(dMajor, bMajor) {
  const msg =
`超市收银系统 · 数据库需要升级才能启动
========================================
内置 PostgreSQL 版本 ：${bMajor}
现有数据目录版本    ：${dMajor}
数据目录            ：${PGDATA}

本程序出于数据安全，不会自动升级。升级前会自动完整备份数据，并使用
pg_dump / psql 做逻辑迁移，任何一步失败都会自动回滚（数据不丢失）。

升级方式（任选其一）：
  1) 打开「服务端管理器」，按弹窗提示点击「立即升级」；
  2) 命令行执行：  node scripts/server-up.mjs upgrade
  3) 无人值守自动升级：设置环境变量 POS_PG_AUTO_UPGRADE=1 后重启服务。

升级完成后本提示文件会被自动删除，服务即可正常启动。
`;
  fs.writeFileSync(pendingFile(), msg, 'utf8');
}

/** 等待 PostgreSQL 在指定端口就绪（TCP 探测） */
function waitPg(port, secs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + secs * 1000;
    const tick = () => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => { try { s.destroy(); } catch { /* noop */ } resolve(true); });
      s.once('error', () => {
        try { s.destroy(); } catch { /* noop */ }
        if (Date.now() > deadline) reject(new Error(`PostgreSQL 在 ${secs}s 内未就绪`));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

/** 抓取某 PG 实例 public 模式下所有普通表的精确行数，作为迁移前后一致性基线 */
async function snapshotRowCounts(port) {
  const { Client } = createRequire(path.join(ROOT, 'package.json'))('pg');
  const c = new Client({
    connectionString: `postgres://postgres:${encodeURIComponent(PGPASSWORD_)}@127.0.0.1:${port}/postgres`,
    connectionTimeoutMillis: 5000,
  });
  await c.connect();
  try {
    await c.query('SET statement_timeout = 60000');
    const tr = await c.query(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
    const out = {};
    for (const row of tr.rows) {
      const r = await c.query(`SELECT count(*)::bigint AS n FROM "${row.t}"`);
      out[row.t] = Number(r.rows[0].n);
    }
    return out;
  } finally {
    await c.end();
  }
}

/** 强校验：连上并核对迁移前后每张业务表的行数是否完全一致，避免导入缺表/丢行而误判成功 */
async function verifyPg(port, preCounts) {
  try {
    const { Client } = createRequire(path.join(ROOT, 'package.json'))('pg');
    const c = new Client({
      connectionString: `postgres://postgres:${encodeURIComponent(PGPASSWORD_)}@127.0.0.1:${port}/postgres`,
      connectionTimeoutMillis: 5000,
    });
    await c.connect();
    await c.query('SET statement_timeout = 60000');
    const tr = await c.query(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
    const postCounts = {};
    for (const row of tr.rows) {
      const r = await c.query(`SELECT count(*)::bigint AS n FROM "${row.t}"`);
      postCounts[row.t] = Number(r.rows[0].n);
    }
    await c.end();

    // 无基线（非迁移/首次安装场景）时退化为"能连上即可"
    if (!preCounts) return true;

    const miss = [];
    const diff = [];
    for (const [t, n] of Object.entries(preCounts)) {
      if (!(t in postCounts)) { miss.push(t); continue; }
      if (postCounts[t] !== n) diff.push(`${t}(旧 ${n} / 新 ${postCounts[t]})`);
    }
    if (miss.length) { console.error('  校验失败：新库缺失表 ' + miss.join(', ')); return false; }
    if (diff.length) { console.error('  校验失败：行数不一致 ' + diff.join(', ')); return false; }
    console.log('  ✅ 校验通过：' + Object.keys(preCounts).length + ' 张表行数全部一致');
    return true;
  } catch (e) {
    console.error('  校验异常：' + (e && e.message ? e.message : e));
    return false;
  }
}

/** 定位/补齐迁移所需的客户端工具（pg_dump / pg_dumpall / psql） */
async function ensurePgTools() {
  const need = ['pg_dump.exe', 'pg_dumpall.exe', 'psql.exe'];
  const dlls = ['libpq.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll', 'libintl-9.dll', 'libiconv-2.dll', 'zlib1.dll', 'libwinpthread-1.dll'];
  const have = f => fs.existsSync(path.join(PGBIN, f));
  // 把仓库自带工具复制进目标 bin；同时写入 PG_SRC/bin，确保后续"重解压新二进制"后工具仍在
  const copyVendorTo = (dir) => {
    const src = path.join(ROOT, 'vendor', 'pg-tools', 'bin');
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(dir, { recursive: true });
    let ok = true;
    for (const f of need.concat(dlls)) {
      const s = path.join(src, f);
      if (fs.existsSync(s)) { try { fs.copyFileSync(s, path.join(dir, f)); } catch { /* noop */ } }
      else if (need.includes(f)) ok = false;
    }
    return ok;
  };
  const copyFrom = (dir) => {
    if (!fs.existsSync(dir)) return false;
    let ok = true;
    for (const f of need.concat(dlls)) {
      const s = path.join(dir, f);
      if (fs.existsSync(s)) { try { fs.copyFileSync(s, path.join(PGBIN, f)); } catch { /* noop */ } }
      else if (need.includes(f)) ok = false;
    }
    return ok;
  };
  if (need.every(have)) return;
  // 1) 仓库自带 / 安装包内已并入 PG_SRC 的工具
  copyVendorTo(PGBIN);
  try { copyVendorTo(path.join(PG_SRC, 'bin')); } catch { /* noop */ }
  if (need.every(have)) return;
  // 2) 系统已安装的 PostgreSQL
  const searchBins = [];
  try {
    const w = runExe('powershell.exe', ['-NoProfile', '-Command', 'try{(Get-Command psql -ErrorAction Stop).Source}catch{""}']);
    const p = String(w.stdout || '').trim();
if (p) searchBins.push(path.dirname(p));
  } catch { /* noop */ }
  for (const base of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        const bin = path.join(base, d, 'bin');
        if (fs.existsSync(path.join(bin, 'pg_dump.exe'))) searchBins.push(bin);
      }
    }
  }
  for (const bin of searchBins) { if (copyFrom(bin) && need.every(have)) return; }
  // 3) 联网下载匹配大版本的客户端工具（最后兜底）
  const major = bundledPgMajor();
  if (major && await downloadPgTools(major, path.join(WORK, 'pg-tools-cache'))) {
    const cache = path.join(WORK, 'pg-tools-cache');
    let ok = true;
    for (const f of need.concat(dlls)) { const s = path.join(cache, f); if (fs.existsSync(s)) { try { fs.copyFileSync(s, path.join(PGBIN, f)); } catch { /* noop */ } } else if (need.includes(f)) ok = false; }
    if (ok && need.every(have)) return;
  }
  throw new Error('缺少 PostgreSQL 客户端迁移工具（pg_dump/psql）。请在 ' + PGBIN + ' 放入这些工具后重试升级。');
}

/** 从官方源下载匹配大版本的 PG 客户端工具（尽力而为，失败返回 false） */
async function downloadPgTools(major, cache) {
  try {
    fs.mkdirSync(cache, { recursive: true });
    const zip = path.join(cache, 'pg.zip');
    const minors = ['4-1', '3-1', '2-1', '1-1', '5-1'];
    let got = false;
    for (const m of minors) {
      const url = `https://get.enterprisedb.com/postgresql/postgresql-${major}.${m}-windows-x64-binaries.zip`;
      const r = runExe('curl.exe', ['-fSL', '-o', zip, url]);
      if (r.status === 0 && fs.existsSync(zip) && fs.statSync(zip).size > 1e6) { got = true; break; }
    }
    if (!got) return false;
    runExe('tar.exe', ['-xf', zip, '-C', cache]);
    const bin = path.join(cache, 'pgsql', 'bin');
    if (!fs.existsSync(path.join(bin, 'pg_dump.exe'))) return false;
    for (const f of fs.readdirSync(bin)) { try { fs.copyFileSync(path.join(bin, f), path.join(cache, f)); } catch { /* noop */ } }
    return true;
  } catch { return false; }
}

/** 真正的迁移：备份 → 逻辑导出 → 切换新二进制 → 初始化 → 导入 → 校验 → 失败回滚 */
async function migratePg() {
  const dMajor = dataPgMajor();
  const bMajor = bundledPgMajor();
  if (!(bMajor > dMajor)) throw new Error(`当前无需升级（数据版本 ${dMajor}，内置 ${bMajor}）`);
  await ensurePgTools();

  let preCounts = null;   // 旧库行数基线，用于迁移后强校验
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dataBackup = PGDATA + '.pre-upgrade-' + ts;   // 重命名即瞬时完整备份
  const binBackup = PGBIN + '.old';
  const dumpFile = path.join(WORK, 'pg-upgrade-dump-' + ts + '.sql');
  const tool = f => path.join(PGBIN, 'bin', f);        // 客户端工具（ensurePgTools 已确保存在）

  console.log(`▶ 升级 PostgreSQL ${dMajor} → ${bMajor}（数据目录 ${PGDATA}）`);

  // 0) 停旧库（确保从已解压的 PGBIN=旧二进制区域停止）
  pgStop(true);

  // 1) 启动旧库做导出（若端口已被旧库占用则直接复用）
  const oldLog = path.join(WORK, 'pg-upgrade-old.log');
  let startedOld = false;
  if (!(await tcpInUse(PORT))) {
    const st = runExe(path.join(PGBIN, 'bin', 'pg_ctl.exe'),
      ['-D', PGDATA, '-l', oldLog, '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, 'start']);
    if (st.status !== 0) throw new Error('启动旧 PostgreSQL 失败：' + (st.stderr || st.stdout || '').slice(-400));
    startedOld = true;
  }
  await waitPg(PORT, 30);

  // 2) 逻辑导出（仅业务库 postgres；角色由后续 ensureAppRole 重建，规避 bootstrap 超户冲突）
  try {
    const env = { ...process.env, PGPASSWORD: PGPASSWORD_ };
    const dp = runExe(tool('pg_dump.exe'),
      ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-f', dumpFile, '--clean', '--if-exists', '--no-owner'],
      { env });
    if (dp.status !== 0) throw new Error('pg_dump 导出失败：' + (dp.stderr || dp.stdout || '').slice(-500));
    console.log(`  ✅ 已导出旧库到 ${dumpFile}（${Math.round(fs.statSync(dumpFile).size / 1024)} KB）`);
    try { preCounts = await snapshotRowCounts(PORT); console.log(`  📊 已记录旧库 ${Object.keys(preCounts).length} 张表行数基线`); }
    catch (e) { console.warn('  ⚠️ 无法建立行数基线，将退化为弱校验：' + (e && e.message ? e.message : e)); }
  } finally {
    if (startedOld) try { runExe(path.join(PGBIN, 'bin', 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'fast']); } catch { /* noop */ }
  }

  // 3) 备份旧二进制与旧数据（重命名，瞬时且完整）
  if (fs.existsSync(binBackup)) fs.rmSync(binBackup, { recursive: true, force: true });
  fs.renameSync(PGBIN, binBackup);
  if (fs.existsSync(dataBackup)) fs.rmSync(dataBackup, { recursive: true, force: true });
  fs.renameSync(PGDATA, dataBackup);

  // 4) 释放新二进制
  fs.rmSync(PGBIN, { recursive: true, force: true });
  fs.mkdirSync(PGBIN, { recursive: true });
  fs.cpSync(PG_SRC, PGBIN, { recursive: true });

  // 5) 初始化新数据目录
  const pwFile = path.join(WORK, 'pgpw.txt');
  fs.writeFileSync(pwFile, PGPASSWORD_ + '\n');
  const idb = initDb(['-D', PGDATA, '-U', 'postgres', `--pwfile=${pwFile}`, '--locale=C', '--encoding=UTF8']);
  if (idb.status !== 0) throw new Error('新版本 initdb 失败：' + (idb.stderr || idb.stdout || '').slice(-400));

  // 6) 启动新库 → 重建应用角色 → 导入
  const newLog = path.join(WORK, 'pg-upgrade-new.log');
  const startNew = () => runExe(path.join(PGBIN, 'bin', 'pg_ctl.exe'),
    ['-D', PGDATA, '-l', newLog, '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, 'start']);
  try {
    if (!(await tcpInUse(PORT))) {
      const st = startNew();
      if (st.status !== 0) throw new Error('启动新 PostgreSQL 失败：' + (st.stderr || st.stdout || '').slice(-400));
    }
    await waitPg(PORT, 40);
    await ensureAppRole();   // 重建 pos_app 角色（导出 SQL 中的 GRANT 依赖它）
    const env = { ...process.env, PGPASSWORD: PGPASSWORD_, ON_ERROR_STOP: '1' };
    const rs = runExe(tool('psql.exe'),
      ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-f', dumpFile], { env });
    if (rs.status !== 0) throw new Error('psql 导入失败：' + (rs.stderr || rs.stdout || '').slice(-600));
    console.log('  ✅ 新库导入完成');
  } catch (e) {
    rollback(e);
  }

  // 7) 校验（失败同样回滚）
  if (!(await verifyPg(PORT, preCounts))) {
    try { runExe(path.join(PGBIN, 'bin', 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'immediate']); } catch { /* noop */ }
    rollback(new Error('升级后数据校验未通过'));
  }

  function rollback(err) {
    console.error('  ❌ 迁移失败，正在回滚到升级前状态…');
    try { runExe(path.join(PGBIN, 'bin', 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'immediate']); } catch { /* noop */ }
    fs.rmSync(PGBIN, { recursive: true, force: true });
    fs.cpSync(binBackup, PGBIN, { recursive: true });
    fs.rmSync(PGDATA, { recursive: true, force: true });
    fs.renameSync(dataBackup, PGDATA);
    try {
      runExe(path.join(PGBIN, 'bin', 'pg_ctl.exe'),
        ['-D', PGDATA, '-l', path.join(WORK, 'pg.log'), '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, 'start']);
    } catch { /* noop */ }
    throw new Error('数据库升级失败并已回滚（数据未丢失，仍运行于旧版本）。原错误：' + (err && err.message ? err.message : err));
  }

  console.log(`✅ 数据库已从 PostgreSQL ${dMajor} 升级到 ${bMajor}。`);
  console.log(`  旧数据备份保留于：${dataBackup}（确认无误后可手动删除）`);
  console.log(`  逻辑导出备份    ：${dumpFile}`);
  clearUpgradePending();
}

/** 版本门禁：内置版本与数据目录版本不一致时拒绝盲目启动 */
async function checkVersionGate() {
  const dMajor = dataPgMajor();
  if (dMajor == null) return;                  // 首次部署，无数据目录
  const bMajor = bundledPgMajor();
  if (bMajor == null) return;                  // 无法确定内置版本，交回 pgStart
  if (bMajor === dMajor) { clearUpgradePending(); return; }
  if (bMajor < dMajor) {
    throw new Error(
      `数据目录由 PostgreSQL ${dMajor} 创建，但当前内置版本为更旧的 ${bMajor}，` +
      `无法打开。请使用与数据匹配的软件版本，或先升级内置数据库。`);
  }
  // bMajor > dMajor：需要升级迁移
  if (String(cfg.POS_PG_AUTO_UPGRADE || '').toLowerCase() === '1') {
    console.log(`▶ 检测到数据库需从 PostgreSQL ${dMajor} 升级到 ${bMajor}（POS_PG_AUTO_UPGRADE=1，自动执行）`);
    await migratePg();
    clearUpgradePending();
    return;
  }
  writeUpgradePending(dMajor, bMajor);
  console.error(
    `\n⚠ 数据库需要升级：内置 PostgreSQL ${bMajor}，现有数据目录 ${dMajor}。` +
    `\n  为保障数据安全，本程序不会自动升级。请运行「服务端管理器」中的提示，或执行：` +
    `\n    node scripts/server-up.mjs upgrade` +
    `\n  升级前会自动备份并可在失败时自动回滚。详见 ${pendingFile()}`);
  await new Promise(r => setTimeout(r, 8000));   // 错开 WinSW 重启风暴
  process.exit(0);
}

function pgRunning() {
  try { return pgCtl(['-D', PGDATA, 'status'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

/** V4.28.9f：TCP 探测端口是否已有监听者（识别 pg_ctl status 认不出的孤儿 postmaster） */
function tcpInUse(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = v => { try { s.destroy(); } catch { /* noop */ } resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

function pgStop(silent = false) {
  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) return false;
  const r = pgCtl(['-D', PGDATA, 'stop', '-m', 'fast'], { stdio: silent ? 'ignore' : 'inherit' });
  return r.status === 0;
}

async function pgStart() {
  ensurePgBin();
  const fresh = !fs.existsSync(path.join(PGDATA, 'PG_VERSION'));

  if (pgRunning()) {
    console.log(`▶ PostgreSQL 已在运行（数据目录 ${PGDATA}）`);
    return;
  }
  pgCtl(['-D', PGDATA, 'stop', '-m', 'immediate'], { stdio: 'ignore' });   // 清掉残留

  // V4.28.9f 修复"启动服务失效"：pg_ctl stop/immediate 清不掉**孤儿 postmaster**
  //  （如服务进程被强杀后 postgres.exe 被系统收养，pg_ctl status 已不认它，但 54329 端口仍被占用）。
  //  此前直接 pg_ctl start → 端口占用 FATAL → 整个服务起不来。
  //  现改为启动前 TCP 探测：端口已有监听 = 数据库实际可用 → 直接复用（连接重试段会立刻连通）。
  if (await tcpInUse(PORT)) {
    console.log(`ℹ 端口 ${PORT} 已有 PostgreSQL 在运行（复用，不重复启动）`);
    return;
  }

  if (fresh) {
    const pwFile = path.join(WORK, 'pgpw.txt');
    fs.writeFileSync(pwFile, PGPASSWORD_ + '\n');
    console.log(`▶ 首次初始化数据库（initdb）: ${PGDATA}`);
    const idb = initDb(['-D', PGDATA, '-U', 'postgres', `--pwfile=${pwFile}`, '--locale=C', '--encoding=UTF8']);
    if (idb.status !== 0) {
      const detail = String(idb.stderr || idb.stdout || '') || String(idb.error?.message || '') || '(initdb 无任何输出：多为杀软拦截或 DLL 加载失败)';
      throw new Error(`initdb 失败（status=${idb.status}, signal=${idb.signal ?? 'none'}）: ${detail.slice(-400)}`);
    }
  } else {
    console.log(`▶ 复用已有数据目录: ${PGDATA}`);
  }

  const log = path.join(WORK, 'pg.log');
  console.log(`▶ 启动 PostgreSQL :${PORT}（仅监听本机）…`);
  // 关键：必须切断 stdio 管道。否则 postgres 会继承管道句柄，
  // 导致 spawnSync 等不到 EOF 而永久阻塞（表现为启动卡死）。
  const st = pgCtl(['-D', PGDATA, '-l', log, '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, 'start'], { stdio: 'ignore' });
  if (st.status !== 0) {
    let tail = '';
    try { tail = fs.readFileSync(log, 'utf8').split(/\r?\n/).slice(-15).join('\n'); } catch { /* noop */ }
    throw new Error(`pg_ctl start 失败（代码 ${st.status}）\n${tail}`);
  }

  const require = createRequire(path.join(ROOT, 'package.json'));
  const { Client } = require('pg');
  let lastErr = null;
  for (let i = 0; i < 40; i++) {
    const c = new Client({ connectionString: dbUrl(), connectionTimeoutMillis: 3000 });
    try { await c.connect(); await c.end(); return; }
    catch (e) {
      lastErr = e;
      if (i === 0 || i === 5 || i === 15) console.log(`  ...连接重试 ${i + 1}：${e && e.message}`);
      await new Promise(s => setTimeout(s, 500));
    }
  }
  throw new Error(`PostgreSQL 已监听但连接失败（${PORT}）：${lastErr && lastErr.message}；连接串 ${dbUrl().replace(/:[^:@/]+@/, ':****@')}`);
}

function dbUrl() {
  return `postgres://postgres:${encodeURIComponent(PGPASSWORD_)}@127.0.0.1:${PORT}/postgres`;
}
/** VQA-B3：最小权限应用账号——DML/TRUNCATE/序列 USAGE，无 SUPERUSER/CREATEDB/登录库外权限与运行时 DDL 需求（dist 已核实零运行时 DDL） */
async function ensureAppRole() {
  const { Client } = createRequire(path.join(ROOT, 'package.json'))('pg');
  const { randomBytes } = await import('crypto');
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const mkPw = () => Array.from(randomBytes(20)).map(b => alpha[b % alpha.length]).join('');
  const pwFile = path.join(WORK, 'pgapp.txt');
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  let pw = fs.existsSync(pwFile) ? String(fs.readFileSync(pwFile, 'utf8')).trim() : '';
  if (!pw || pw.length < 12) pw = mkPw();
  const ex = await c.query(`SELECT 1 FROM pg_roles WHERE rolname='pos_app'`);
  // PG DDL 不支持参数绑定；pw 为字母数字集，单引号内联安全
  const lit = "'" + pw.replace(/'/g, "''") + "'";
  if (!ex.rowCount) await c.query(`CREATE ROLE pos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${lit}`);
  else await c.query(`ALTER ROLE pos_app LOGIN PASSWORD ${lit}`);
  fs.writeFileSync(pwFile, pw + '\n');
  await c.query(`GRANT CONNECT ON DATABASE postgres TO pos_app`);
  await c.query(`GRANT USAGE ON SCHEMA public TO pos_app`);
  await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES ON ALL TABLES IN SCHEMA public TO pos_app`);
  await c.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO pos_app`);
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES ON TABLES TO pos_app`);
  await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO pos_app`);
  await c.end();
  return pw;
}
function appUrl(pw) {
  return `postgres://pos_app:${encodeURIComponent(pw)}@127.0.0.1:${PORT}/postgres`;
}

// ────────────────────────── 主流程 ──────────────────────────
function runMigrate(env) {
  console.log('▶ 幂等迁移 + 管理员引导（init-db）…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'scripts', 'init-db.js')],
    { cwd: ROOT, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('init-db 失败（退出码 ' + r.status + '）');
}

async function main() {
  initPaths();

  if (CMD === 'stop') {
    console.log('▶ 停止内嵌 PostgreSQL …');
    console.log(pgStop() ? '✅ 已停止' : 'ℹ 未运行或数据目录不存在');
    return;
  }

  if (CMD === 'status') {
    ensurePgBin();
    console.log(`工作目录 : ${WORK}`);
    console.log(`数据目录 : ${PGDATA}`);
    console.log(`PG 状态  : ${pgRunning() ? '运行中' : '未运行'}`);
    console.log(`连接串   : ${dbUrl()}`);
    return;
  }

  const embedded = String(cfg.PG_MODE || 'embedded').toLowerCase() !== 'external';
  const env = { ...process.env };

  // 独立的数据库升级命令（由服务端管理器弹窗或运维手动触发）
  if (CMD === 'upgrade') {
    if (!embedded) { console.log('外部 PostgreSQL 模式无需内置升级；请自行升级数据库。'); return; }
    await migratePg();
    console.log('✅ 数据库升级完成，请启动服务（node scripts/server-up.mjs up）。');
    return;
  }

  if (embedded) {
    await checkVersionGate();   // 校验内置 PG 版本与数据目录一致；不一致则提示升级（或自动迁移）
    await pgStart();
    env.DATABASE_URL = dbUrl();
  } else {
    if (!cfg.DATABASE_URL) throw new Error('PG_MODE=external 时必须在 .env 配置 DATABASE_URL');
    env.DATABASE_URL = cfg.DATABASE_URL;
    console.log('▶ 使用外部 PostgreSQL：' + String(cfg.DATABASE_URL).replace(/:[^:@/]+@/, ':****@'));
  }

  // JWT 密钥：缺省自动生成并落 .env（避免重装后令牌失效 / 每次重启换密钥）
  let jwt = cfg.JWT_SECRET;
  if (!jwt || String(jwt).length < 32) {
    const { randomBytes } = await import('crypto');
    jwt = randomBytes(32).toString('hex');
    appendEnv('JWT_SECRET', jwt, '首次启动自动生成（请随备份一并保存；更换会导致所有登录令牌失效）');
    console.log('▶ 已自动生成 JWT_SECRET 并写入 .env');
  }
  env.JWT_SECRET = jwt;

  const port = String(cfg.PORT || 3100);
  env.PORT = port;
  if (cfg.HTTPS_PORT) env.HTTPS_PORT = String(cfg.HTTPS_PORT);
  if (cfg.AI_UPLOADS_DIR) env.AI_UPLOADS_DIR = cfg.AI_UPLOADS_DIR;

  if (CMD === 'migrate') { runMigrate(env); console.log('✅ 迁移完成'); return; }

  if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) throw new Error('dist/main.js 缺失（发布包不完整）');
  runMigrate(env);
  // VQA-B3：迁移完成后，业务进程切换最小权限账号 pos_app
  //   embedded：恒幂等开通/同步（pgapp.txt 口令与 role 对齐），迁移仍走超户
  //   external：若配置 APP_DATABASE_URL（如 pos_app 串），业务进程用它；迁移仍用 DATABASE_URL
  if (embedded) {
    try {
      const appPw = await ensureAppRole();
      env.DATABASE_URL = appUrl(appPw);
      console.log('▶ 应用已切换最小权限账号 pos_app（超户仅用于迁移/引导）');
    } catch (e) {
      console.log('⚠ pos_app 开通失败，本进程回退超级用户连接：' + (e && e.message));
    }
  } else if (cfg.APP_DATABASE_URL) {
    env.DATABASE_URL = String(cfg.APP_DATABASE_URL);
    console.log('▶ 业务进程使用最小权限连接（APP_DATABASE_URL）；迁移沿用 DATABASE_URL');
  }

  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log('  ✅ 服务端已就绪（Ctrl+C 停止后端）');
  console.log(`  管理后台 : http://localhost:${port}/admin/`);
  console.log(`  收银端   : http://localhost:${port}/pwa/`);
  console.log(`  老板端   : http://localhost:${port}/boss/`);
  console.log(`  客显副屏 : http://localhost:${port}/display/`);
  console.log(`  健康检查 : http://localhost:${port}/health`);
  console.log(`  HTTPS    : https://localhost:${cfg.HTTPS_PORT || 3443}/pwa/  （手机摄像头/装 PWA 必须）`);
  console.log('════════════════════════════════════════════════');
  console.log('');

  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'main.js')], { cwd: ROOT, env, stdio: 'inherit' });
  const bye = () => { try { child.kill(); } catch { /* noop */ } process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  child.on('exit', code => {
    console.log(`\n后端进程已退出（code=${code}）。PG 仍在运行，如需停止：node scripts/server-up.mjs stop`);
    process.exit(code || 0);
  });
}

main().catch(e => { console.error('\n❌ ' + (e && e.message ? e.message : e)); process.exit(1); });
