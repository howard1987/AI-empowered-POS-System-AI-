/**
 * 开发联调环境（复用 e2e 的 PG 启动逻辑，但不跑断言、不停库）：
 *   node tests/dev-up.mjs  →  前台保持运行
 *   后端 API  http://localhost:3100
 *   Web 后台  http://localhost:8088（由 frontend-web/server.mjs 提供）
 * 注意：PG 二进制必须位于纯 ASCII 路径（BUG #16926）；须前台跑（沙箱会拦截 initdb 孵化）
 */
import { spawn, spawnSync, execSync } from 'child_process';
import { Client } from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PGPORT = 54329;
const DATABASE_URL = `postgres://postgres:password@localhost:${PGPORT}/postgres`;

const NATIVE_SRC = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native');
const PGBIN = path.join(os.tmpdir(), 'pgbin-ascii');
// 数据目录放用户主目录（纯 ASCII + 持久化）：首次 initdb，之后重启复用，不再清库
const PGDATA = path.join(os.homedir(), 'pgdata-cashier-dev');
const FRESH = !fs.existsSync(path.join(PGDATA, 'PG_VERSION'));

if (!fs.existsSync(path.join(PGBIN, 'bin', 'initdb.exe'))) {
  fs.rmSync(PGBIN, { recursive: true, force: true });
  const rc = spawnSync('robocopy', [NATIVE_SRC, PGBIN, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8' });
  if (rc.status === null || rc.status >= 8) throw new Error('robocopy 失败');
}
const bin = path.join(PGBIN, 'bin');

try { spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'immediate'], { stdio: 'ignore', timeout: 10000 }); } catch { /* noop */ }

if (FRESH) {
  // 仅首次（或数据目录被删后）初始化；正常重启保留全部业务数据
  const pwFile = path.join(os.tmpdir(), 'pgpw-cashier-dev.txt');
  fs.writeFileSync(pwFile, 'password\n');
  console.log('▶ 首次 initdb 初始化数据目录:', PGDATA);
  const idb = spawnSync(path.join(bin, 'initdb.exe'),
    ['-D', PGDATA, '-U', 'postgres', '--pwfile=' + pwFile, '--locale=C', '--encoding=UTF8'], { encoding: 'utf8' });
  if (idb.status !== 0) throw new Error('initdb 失败: ' + (idb.stderr || '').slice(-300));
} else {
  console.log('▶ 检测到已有数据目录，保留数据直接启动:', PGDATA);
}

console.log('▶ 启动 postgres :54329 ...');
spawn(path.join(bin, 'pg_ctl.exe'), ['-D', PGDATA, '-l', path.join(os.tmpdir(), 'pg-cashier-dev.log'), '-o', `-p ${PGPORT}`, 'start']);

let dbc = null;
for (let i = 0; i < 60; i++) {
  const c = new Client({ connectionString: DATABASE_URL });
  try { await c.connect(); dbc = c; break; }
  catch { await new Promise(s => setTimeout(s, 500)); }
  if (i === 59) throw new Error('postgres 启动超时');
}
await dbc.end();

console.log('▶ 执行建表基线 + 迁移 + 管理员引导 ...');
const init = spawnSync(process.execPath, ['dist/scripts/init-db.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' });
if (init.status !== 0) throw new Error('init-db 失败: ' + (init.stderr || '').slice(-300));

// detached 派生常驻服务后本脚本退出（沙箱内无法长驻；前台免沙箱运行几秒即可）
function daemonize(cmd, args, opts, tag) {
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`  ${tag} PID=${child.pid}`);
  return child.pid;
}

const pids = {};
pids.backend = daemonize(process.execPath, ['dist/main.js'],
  { cwd: ROOT, env: { ...process.env, DATABASE_URL, PORT: '3100' } }, '后端 :3100');
pids.web = daemonize(process.execPath, ['server.mjs'],
  { cwd: path.join(ROOT, '..', 'frontend-web') }, 'Web 后台 :8088');
pids.h5 = daemonize(process.execPath, ['server.mjs'],
  { cwd: path.join(ROOT, '..', 'frontend-h5') }, 'H5 会员端 :8089');

let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch('http://localhost:3100/health'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
  await new Promise(s => setTimeout(s, 500));
}
if (!up) throw new Error('后端健康检查超时');
fs.writeFileSync(path.join(os.tmpdir(), 'cashier-dev-pids.json'), JSON.stringify(pids));
console.log('\n✅ 联调环境就绪（常驻）：\n   Web 后台  http://localhost:8088 （ADMIN / admin123）\n   H5 会员端 http://localhost:8089 （手机号注册登录）\n   后端 API  http://localhost:3100\n   停止：node tests/dev-down.mjs');
