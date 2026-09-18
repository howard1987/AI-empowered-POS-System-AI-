/**
 * 本地开发服务（真库）：启动嵌入式 PostgreSQL(54329) → 建表基线 → 启动 NestJS(:3100)，
 * 前台保持运行，Ctrl+C 退出并停库。用法：npm run build && node tests/dev-server.mjs
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3100, PGPORT = 54329, DB = 'postgres';
const DATABASE_URL = `postgres://postgres:password@localhost:${PGPORT}/${DB}`;

const NATIVE_SRC = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native');
const PGBIN = path.join(os.tmpdir(), 'pgbin-ascii');
const PGDATA = path.join(os.tmpdir(), 'pgdata-cashier-dev');

if (!fs.existsSync(path.join(PGBIN, 'bin', 'initdb.exe'))) {
  fs.rmSync(PGBIN, { recursive: true, force: true });
  const rc = spawnSync('robocopy', [NATIVE_SRC, PGBIN, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8' });
  if (rc.status === null || rc.status >= 8) throw new Error('robocopy 失败: ' + rc.stderr);
}
const bin = path.join(PGBIN, 'bin');

try { spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'immediate'], { stdio: 'ignore', timeout: 10000 }); } catch { /* noop */ }
for (let i = 0; i < 10; i++) {
  try { fs.rmSync(PGDATA, { recursive: true, force: true }); break; }
  catch { await new Promise(s => setTimeout(s, 1000)); }
}
const pwFile = path.join(os.tmpdir(), 'pgpw-cashier-dev.txt');
fs.writeFileSync(pwFile, 'password\n');
console.log('▶ initdb ...');
const idb = spawnSync(path.join(bin, 'initdb.exe'), ['-D', PGDATA, '-U', 'postgres', '--pwfile=' + pwFile, '--locale=C', '--encoding=UTF8'], { encoding: 'utf8' });
if (idb.status !== 0) { console.error(idb.stderr || idb.stdout); process.exit(1); }
console.log(`▶ 启动 postgres :${PGPORT} ...`);
spawn(path.join(bin, 'pg_ctl.exe'), ['-D', PGDATA, '-l', path.join(os.tmpdir(), 'pg-cashier-dev.log'), '-o', `-p ${PGPORT}`, 'start']);

async function waitPg() {
  const { Client } = await import('pg');
  for (let i = 0; i < 60; i++) {
    const c = new Client({ connectionString: DATABASE_URL });
    try { await c.connect(); await c.end(); return; }
    catch { await new Promise(s => setTimeout(s, 500)); }
  }
  throw new Error('postgres 启动超时');
}
await waitPg();
console.log('▶ 建表基线 + 管理员引导 ...');
const init = spawnSync(process.execPath, ['dist/scripts/init-db.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' });
if (init.status !== 0) { console.error(init.stderr?.slice(0, 500)); process.exit(1); }
console.log(`▶ 启动后端 :${PORT} （Ctrl+C 退出并停库）`);
const srv = spawn(process.execPath, ['dist/main.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL, PORT: String(PORT) }, stdio: 'inherit' });
srv.on('exit', code => {
  spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'immediate'], { stdio: 'ignore' });
  process.exit(code ?? 0);
});
process.on('SIGINT', () => { spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'immediate'], { stdio: 'ignore' }); process.exit(0); });
