/* 一次性：应用 090 迁移（幂等），用完即删 */
const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const sql = fs.readFileSync('db/090_v4211_pos_device_auth.sql', 'utf8');
  const c = new Client({ connectionString: 'postgres://postgres:password@localhost:54329/postgres' });
  await c.connect();
  await c.query(sql);
  const t = await c.query(`SELECT count(*)::int n FROM pos_devices`);
  const s = await c.query(`SELECT value FROM system_settings WHERE setting_key='pos.device.auth'`);
  console.log('090 OK, pos_devices rows =', t.rows[0].n, ', pos.device.auth =', JSON.stringify(s.rows[0].value));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
