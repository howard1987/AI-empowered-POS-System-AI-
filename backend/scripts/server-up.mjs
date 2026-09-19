/**
 * 服务端一体化启动器（随 release/server 发布）
 *
 *   node scripts/server-up.mjs            启动：内嵌 PG（可选）→ 幂等迁移 → 后端主进程（前台）
 *   node scripts/server-up.mjs stop       停止后端内嵌 PG
 *   node scripts/server-up.mjs status     查看 PG 状态与连接串
 *   node scripts/server-up.mjs migrate    仅重跑幂等迁移 / 管理员引导
 *
 * 设计要点
 *  - PG 二进制与数据目录必须位于**纯 ASCII 路径**（PostgreSQL on Windows 限制），
 *    故运行时统一落到 C:\ProgramData\pos-cashier（可用 POS_DATA_DIR 覆盖；非 ASCII 会被自动跳过）。
 *  - .env 由本脚本直接解析（不依赖 cwd），字段见 deploy/env.example。
 *  - PG_MODE=embedded（默认，免安装便携库）| external（用外部已装 PG，读 DATABASE_URL）。
 */
import { spawn, spawnSync } from 'child_process';
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

function initDb(args) {
  return spawnSync(path.join(PGBIN, 'bin', 'initdb.exe'), args, { encoding: 'utf8' });
}

function pgRunning() {
  try { return pgCtl(['-D', PGDATA, 'status'], { stdio: 'ignore' }).status === 0; } catch { return false; }
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

  if (embedded) {
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
