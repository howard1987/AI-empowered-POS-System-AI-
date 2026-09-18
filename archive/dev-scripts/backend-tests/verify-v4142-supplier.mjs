/** V4.14.2 供应商变更单回归：NaN 修复 + 独立供应 + 记录列表（测试数据清理） */
import pg from 'pg';
const API = 'http://localhost:3100';
const pool = new pg.Pool({ connectionString: 'postgres://postgres:password@localhost:54329/postgres' });
const q = (s, p = []) => pool.query(s, p);
let TOKEN = '';
async function api(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}
async function must(method, path, body) {
  const j = await api(method, path, body);
  if (j.code !== 0) throw new Error(`${method} ${path} → ${j.code} ${j.msg}`);
  return j.data;
}
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + ' ' + d)); };

const lg = await api('POST', '/auth/login', { empNo: 'ADMIN', password: 'admin123' });
TOKEN = lg.data.token;
ok('登录', !!TOKEN);

/* 1. NaN 修复：GET supplier-changes 无参数 / 带 supplierId */
const l1 = await api('GET', '/purchase/supplier-changes');
ok('GET supplier-changes 无参数（原 NaN 场景）', l1.code === 0, `code=${l1.code} ${l1.msg || ''}`);
const l2 = await api('GET', '/purchase/supplier-changes?supplierId=1');
ok('GET supplier-changes?supplierId=1', l2.code === 0, `code=${l2.code}`);
const l3 = await api('GET', '/purchase/fees');
ok('GET /purchase/fees 无参数（同型隐患）', l3.code === 0, `code=${l3.code}`);

/* 2. 独立供应变更：A 商品原主供 1 号，独立切换到 2 号 */
const prods = (await q(`SELECT p.id, p.sell_price, p.supplier_default_id FROM products p WHERE p.id=118`)).rows
  .map(r => ({ ...r, id: Number(r.id), sell_price: Number(r.sell_price), supplier_default_id: r.supplier_default_id == null ? null : Number(r.supplier_default_id) }));
const A = prods[0];
// 给 A 造一条 1 号供应商进价记录（若不存在），确保"清除关联"有对象
const sup1 = Number(A.supplier_default_id) || 1;
// 仅当 sup1 无进价记录时补造一条（避免重复插行），并快照变更前全部关联供清理还原
await q(`INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
         SELECT $1,$2,9.5,9.5,'V4142TEST' WHERE NOT EXISTS (SELECT 1 FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2)`, [A.id, sup1]);
const preRows = (await q(`SELECT supplier_id, price, min_price, source_doc FROM supplier_product_prices WHERE product_id=$1`, [A.id])).rows;
const before = (await q(`SELECT count(*)::int n FROM supplier_product_prices WHERE product_id=$1`, [A.id])).rows[0].n;
console.log(`   商品#118 变更前进价关联 ${before} 条（主供 ${A.supplier_default_id}）`);
const sups = (await must('GET', '/purchase/suppliers'));
const supList = Array.isArray(sups) ? sups : (sups.items || []);
const newSup = supList.find(s => Number(s.id) !== sup1);
ok('存在其他供应商', !!newSup);
const chg = await must('POST', '/purchase/supplier-changes', {
  newSupplierId: Number(newSup.id), reason: 'V4142TEST 独立供应回归',
  items: [{ productId: A.id, independent: true }],
});
const chgNo = chg.change_no || chg.changeNo;
ok('独立供应变更单创建', /^GYSBG-/.test(chgNo || ''), `no=${chgNo}`);
const pAfter = (await q(`SELECT supplier_default_id, sell_price FROM products WHERE id=$1`, [A.id])).rows[0];
ok('主供应商已切到新供应商', Number(pAfter.supplier_default_id) === Number(newSup.id), `got=${pAfter.supplier_default_id}`);
const leftOthers = (await q(`SELECT count(*)::int n FROM supplier_product_prices WHERE product_id=$1 AND supplier_id<>$2`, [A.id, newSup.id])).rows[0].n;
ok('其他供应商进价关联已清除', leftOthers === 0, `残留=${leftOthers}`);
const det = await must('GET', `/purchase/supplier-changes/${chg.id}`);
const it0 = (det.items || [])[0] || {};
ok('留痕含 removedSuppliers 快照', Array.isArray(it0.removedSuppliers) && it0.removedSuppliers.length >= 1 && it0.independent === true,
  JSON.stringify(it0.removedSuppliers || null));

/* 3. 清理：按变更前快照精确还原商品关联与价格 */
for (const r of preRows) {
  await q(`INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc) VALUES ($1,$2,$3,$4,$5)`,
    [A.id, r.supplier_id, r.price, r.min_price, r.source_doc]);
}
await q(`DELETE FROM supplier_product_prices WHERE product_id=$1 AND (source_doc = $2 OR source_doc LIKE 'V4142TEST%')`, [A.id, chgNo]);
await q(`DELETE FROM supplier_changes WHERE change_no = $1`, [chgNo]);
await q(`UPDATE products SET supplier_default_id=$2, sell_price=$3, updated_at=now() WHERE id=$1`, [A.id, A.supplier_default_id, A.sell_price]);
const after = (await q(`SELECT count(*)::int n, string_agg(supplier_id::text, ',') sups FROM supplier_product_prices WHERE product_id=$1`, [A.id])).rows[0];
console.log(`   已还原商品#118（主供 ${A.supplier_default_id}）；当前进价关联 ${after.n} 条（供应商 ${after.sups || '—'}）`);

await pool.end();
console.log(`\n═══ V4.14.2 供应商变更回归：${pass} 通过 / ${fail} 失败 ═══`);
if (fail) process.exit(1);
