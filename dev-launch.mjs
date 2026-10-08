/**
 * 轻量 dev 启动器（替代 runtime-watchdog 的 PG 管理部分）
 *  - 只负责拉起并看护：后端(3100/3443)、Web后台(8088)、会员H5(8089)
 *  - 完全不管理 PostgreSQL：PG 由稳定的 Windows 服务 pos-cashier-pg 提供
 *  - 子进程 detached + windowsHide，无可见窗口、无重启风暴
 *  - 带 per-service「starting」debounce，避免冷启动期间重复 spawn 撞端口
 */
import { spawn } from 'child_process';
import net from 'net';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const BACKEND_DIR = join(ROOT, 'backend');
const WEB_DIR = join(ROOT, 'frontend-web');
const H5_DIR = join(ROOT, 'frontend-h5');

const BACKEND_ENV = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:54329/postgres',
  PORT: '3100',
  HTTPS_PORT: '3443',
};

function detached(args, cwd, env) {
  const p = spawn(NODE, args, { cwd, env: env || process.env, detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  return p.pid;
}

function alive(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1000 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

const services = [
  { name: '后端', port: 3100, args: ['dist/main.js'], cwd: BACKEND_DIR, env: BACKEND_ENV, starting: false, lock: 45000 },
  { name: 'Web后台', port: 8088, args: ['server.mjs'], cwd: WEB_DIR, env: undefined, starting: false, lock: 15000 },
  { name: '会员H5', port: 8089, args: ['server.mjs', '8089'], cwd: H5_DIR, env: undefined, starting: false, lock: 15000 },
];

async function check(s) {
  if (await alive(s.port)) { s.starting = false; return; }
  if (s.starting) return;
  s.starting = true;
  console.log(`[dev-launch] ${s.name}: 端口 ${s.port} 不可达 → 启动`);
  detached(s.args, s.cwd, s.env);
  setTimeout(() => { s.starting = false; }, s.lock);
}

async function loop() {
  try {
    for (const s of services) await check(s);
  } catch (e) {
    console.error('[dev-launch] tick error', e?.message || e);
  }
  setTimeout(loop, 5000);
}

console.log('[dev-launch] 启动（后端3100/3443 · Web8088 · H5 8089），PG 由 pos-cashier-pg 服务提供');
loop();
