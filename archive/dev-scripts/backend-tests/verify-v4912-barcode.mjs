// V4.9.12 条码数据升级回归：回写闭环 / 确认档案优先 / 导入 upsert / 爬虫质量护栏
// 用法：node tests/verify-v4912-barcode.mjs   （需后端 :3100 + PG 54329）
import { Client } from 'pg';

const BASE = process.env.BASE || 'http://localhost:3100';
let pass = 0, fail = 0;
const t = (n, c, extra = '') => { c ? pass++ : fail++; console.log(c ? '✓' : '✗', n, extra); };
const unwrap = j => (j && typeof j === 'object' && 'code' in j ? j.data : j);

const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json());
const tk = unwrap(login)?.token ?? login.token;
if (!tk) { console.error('登录失败', JSON.stringify(login).slice(0, 200)); process.exit(1); }
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tk };

const c = new Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'password', database: 'postgres' });
await c.connect();

// 前置清理：上一轮可能残留的测试数据
await c.query(`UPDATE products SET deleted_at=now() WHERE barcode LIKE '6900999900%'`);
await c.query(`DELETE FROM barcode_cache WHERE barcode LIKE '6900999900%'`);
await c.query(`DELETE FROM barcode_cache WHERE barcode='6902626000517'`);   // 上一轮爬虫垃圾行

// ① 本店码最高优先
const r1 = unwrap(await fetch(`${BASE}/products/barcode-lookup/6950549800187`, { headers: H }).then(r => r.json()));
t('① 本店码 exists=true', r1?.exists === true, `name=${r1?.name}`);

// ② 国内常见码：OFF/爬虫命中且名称清洗（mxnzp 未配凭据已跳过）
const r2 = unwrap(await fetch(`${BASE}/products/barcode-lookup/6921168509256`, { headers: H }).then(r => r.json()));
t('② 农夫山泉码命中且含规格', /农夫山泉/.test(r2?.name || '') && !/旗舰店|正品|包邮/.test(r2?.name || ''),
  `source=${r2?.source} name=${r2?.name} spec=${r2?.spec}`);

// ③ 建档 → 回写 manual 缓存
const p = unwrap(await fetch(BASE + '/products', { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'V4912回写测试商品', barcode: '6900999900017', baseUnit: '瓶', sellPrice: 9.9, spec: '500ml' }) }).then(r => r.json()));
t('③ 建档成功', !!p?.id, `id=${p?.id}`);
const row = await c.query(`SELECT name, manual, source FROM barcode_cache WHERE barcode='6900999900017'`);
t('③ 建档回写 manual 缓存', row.rows.length === 1 && row.rows[0].manual === true && row.rows[0].name === 'V4912回写测试商品',
  JSON.stringify(row.rows[0] || {}));

// ④ 同码再查 → 本店确认档案（confirmed=true，压过在线源）
const r4 = unwrap(await fetch(`${BASE}/products/barcode-lookup/6900999900017`, { headers: H }).then(r => r.json()));
t('④ 同码再查本店库优先（exists）或确认档案（confirmed）', r4?.exists === true || r4?.confirmed === true, `source=${r4?.source} name=${r4?.name}`);

// ⑤ 导入 upsert：首建→created；复导→updated；覆盖结果落库
const imp1 = unwrap(await fetch(BASE + '/products/import', { method: 'POST', headers: H,
  body: JSON.stringify({ rows: [
    { name: 'V4912导入A', barcode: '6900999900018', baseUnit: '袋', sellPrice: 5.5 },
    { name: 'V4912导入B', barcode: '6900999900019', baseUnit: '瓶', sellPrice: 3.5 },
  ] }) }).then(r => r.json()));
t('⑤ 首轮导入 2 新增', imp1?.created === 2 && imp1?.fail === 0, JSON.stringify({ created: imp1?.created, updated: imp1?.updated, fail: imp1?.fail }));
const imp2 = unwrap(await fetch(BASE + '/products/import', { method: 'POST', headers: H,
  body: JSON.stringify({ rows: [
    { name: 'V4912导入A改', barcode: '6900999900018', baseUnit: '袋', sellPrice: 6.5 },
    { name: 'V4912导入B', barcode: '6900999900019', baseUnit: '瓶', sellPrice: 3.5 },
  ] }) }).then(r => r.json()));
t('⑤ 二轮导入按行覆盖（A 改值 + B 同值重写均计 updated）', imp2?.updated === 2 && imp2?.created === 0 && imp2?.fail === 0, JSON.stringify({ created: imp2?.created, updated: imp2?.updated, fail: imp2?.fail }));
const chg = await c.query(`SELECT name, sell_price FROM products WHERE barcode='6900999900018'`);
t('⑤ 覆盖更新落库', chg.rows[0]?.name === 'V4912导入A改' && Number(chg.rows[0]?.sell_price) === 6.5, JSON.stringify(chg.rows[0] || {}));
const impRow = await c.query(`SELECT manual, name FROM barcode_cache WHERE barcode='6900999900018'`);
t('⑤ 导入回写 manual 缓存', impRow.rows[0]?.manual === true && impRow.rows[0]?.name === 'V4912导入A改', JSON.stringify(impRow.rows[0] || {}));

// ⑥ 爬虫质量护栏：无条码命中且无商品特征的标题必须放弃（不得返回知乎问答类垃圾）
const r6 = unwrap(await fetch(`${BASE}/products/barcode-lookup/6902626000517`, { headers: H }).then(r => r.json()));
const junk = r6?.name && (/知乎|屏蔽|方法|怎么|如何/.test(r6.name) || !/\d+(ml|L|g|克|kg)/i.test(r6.name + r6.spec) && !/(瓶|袋|盒|罐)/.test(r6.name));
t('⑥ 爬虫无垃圾标题（商品式或明确未收录）', !junk, `source=${r6?.source || r6?.message || ''} name=${r6?.name || ''}`);
const junkRow = await c.query(`SELECT name FROM barcode_cache WHERE barcode='6902626000517' AND name ~ '知乎|屏蔽|方法'`);
t('⑥ 垃圾标题未入缓存', junkRow.rows.length === 0);

// 清理测试数据
for (const code of ['6900999900017', '6900999900018', '6900999900019'])
  await c.query(`UPDATE products SET deleted_at=now() WHERE barcode=$1`, [code]);
await c.query(`DELETE FROM barcode_cache WHERE barcode LIKE '6900999900%'`);
await c.end();

console.log('---');
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
