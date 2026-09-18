/** V4.21.2：执行 091 迁移（设置分组合并 + 类型人性化）——语句级逐条执行（init-db 同口径） */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '091_v4212_settings_device_group.sql'), 'utf8');
  const c = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:54329/postgres' });
  await c.connect();
  let n = 0;
  for (const stmt of sql.split(/;\s*\n/)) {
    const s = stmt.replace(/^\s*--.*$/gm, '').trim();
    if (!s) continue;
    await c.query(s);
    n++;
  }
  const { rows } = await c.query(
    `SELECT group_name, count(*)::int AS n FROM system_settings WHERE group_name IN ('设备管理','收银台','收银') GROUP BY 1 ORDER BY 1`);
  console.log('statements executed:', n);
  console.log('groups:', JSON.stringify(rows));
  const { rows: chk } = await c.query(
    `SELECT setting_key, value_type, value FROM system_settings WHERE setting_key IN
     ('pos.cashier.new_ui','pos.cashier.stock_hard','pos.cashier.lock_timeout','pos.cashier.debounce','pos.device.auth') ORDER BY 1`);
  console.log('checks:', JSON.stringify(chk, null, 1));
  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
