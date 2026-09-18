/* V4.22.0：执行迁移 092（设置本机化备注）并回读验证 */
const fs = require('fs'), path = require('path');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:54329/postgres' });
  await c.connect();
  const sql = fs.readFileSync(path.join(__dirname, '../db/092_v4220_p163.sql'), 'utf8');
  await c.query(sql);
  const r = await c.query(`SELECT setting_key, remark FROM system_settings WHERE setting_key='pos.cashier.grid_cols'`);
  console.log('grid_cols remark =', r.rows[0] && r.rows[0].remark);
  // 顺带验证 /sales/items 需要的列都在
  const chk = await c.query(`SELECT si.id, o.order_no, p.name FROM sale_items si JOIN sales_orders o ON o.id=si.order_id JOIN products p ON p.id=si.product_id LIMIT 1`);
  console.log('sale_items join ok, sample =', chk.rows[0] || 'none');
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
