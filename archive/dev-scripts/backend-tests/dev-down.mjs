/** 停止联调环境：node tests/dev-down.mjs（读取 dev-up 写入的 PID） */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
const f = path.join(os.tmpdir(), 'cashier-dev-pids.json');
if (fs.existsSync(f)) {
  const pids = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [k, pid] of Object.entries(pids)) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); console.log(`已停止 ${k} (${pid})`); }
    catch { console.log(`${k} (${pid}) 已不在运行`); }
  }
  fs.rmSync(f, { force: true });
}
try { execSync(`"${path.join(os.tmpdir(), 'pgbin-ascii', 'bin', 'pg_ctl.exe')}" -D "${path.join(os.homedir(), 'pgdata-cashier-dev')}" stop -m fast`, { timeout: 15000, stdio: 'ignore' }); console.log('已停止 postgres'); } catch { /* noop */ }
