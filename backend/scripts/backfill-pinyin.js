// V4.18.2 拼音码回填：pinyin_code 为空的商品按名称自动生成拼音首字母串（测试商品→cssp）
// 用法：node scripts/backfill-pinyin.js   （幂等，可反复执行；仅补空值，不覆盖手工维护的值）
const { Client } = require('pg');
const { pinyin } = require('pinyin-pro');

function genPinyin(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  try {
    return pinyin(s, { pattern: 'first', toneType: 'none', type: 'array' })
      .join('').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  } catch { return ''; }
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:54329/postgres' });
  await c.connect();
  const rows = await c.query(
    "SELECT id, name FROM products WHERE deleted_at IS NULL AND (pinyin_code IS NULL OR pinyin_code = '') AND name IS NOT NULL");
  let n = 0;
  for (const r of rows.rows) {
    const py = genPinyin(r.name);
    if (!py) continue;
    await c.query('UPDATE products SET pinyin_code=$2, updated_at=updated_at WHERE id=$1', [r.id, py]);
    n++;
    if (n <= 30) console.log(`#${r.id} ${r.name} → ${py}`);
  }
  console.log(`backfilled ${n}/${rows.rowCount} products`);
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
