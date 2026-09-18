/**
 * V4.13.9 回归：移动端批量需求 + 后台收口
 *  ① 056 设置（mobile.hand / stock.negative_sales / init.*）+ /settings/key 读取
 *  ② 挂单/取单/单独销单（held → pick 幂等）
 *  ③ 采购退货免选供应商自动分桶（无供应商属性商品拦截）
 *  ④ 订货申请免选供应商自动分桶
 *  ⑤ 库存调拨 toStoreId/fromStoreId
 *  ⑥ 随手拍 /ai/samples/free（角度校验 + 入库）
 *  ⑦ 单据列表 maker_name（入库/退货）
 *  ⑧ 改密/密保找回链路（测试员工，结束清理）
 * 前置：后端 :3100（已编译 056 迁移重放）
 * 可重跑：开头清理残留，结束复位
 */
const BASE = 'http://localhost:3100';
const unwrap = d => (d && typeof d === 'object' && 'code' in d && 'data' in d) ? d.data : d;
const H = { 'content-type': 'application/json' };
let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${String(detail).slice(0, 200)}`); }
};
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body !== undefined ? JSON.stringify(body) : undefined }).then(r => r.json());
  return { ok: r.code === 0, data: r.data, msg: r.msg, code: r.code };
};

const pg = (await import('pg')).default;
const db = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'password', database: 'postgres' });
await db.connect();

/* 登录 */
const login = unwrap(await fetch(BASE + '/auth/login', { method: 'POST', headers: H,
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json()));
t('登录 ADMIN', !!login.token);
H.authorization = 'Bearer ' + login.token;

/* ── 开头清理（可重跑）── */
await db.query(`DELETE FROM return_batch_allocs WHERE return_item_id IN (SELECT id FROM purchase_return_items WHERE return_id IN (SELECT id FROM purchase_returns WHERE remark LIKE '%V4139%'))`);
await db.query(`DELETE FROM purchase_return_items WHERE return_id IN (SELECT id FROM purchase_returns WHERE remark LIKE '%V4139%')`);
await db.query(`DELETE FROM purchase_returns WHERE remark LIKE '%V4139%'`);
await db.query(`DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE reason LIKE '%V4139%')`);
await db.query(`DELETE FROM stock_transfers WHERE reason LIKE '%V4139%'`);
await db.query(`DELETE FROM ai_samples WHERE source='随手拍' AND annotation::text LIKE '%V4139%'`);
await db.query(`DELETE FROM held_orders WHERE remark LIKE '%V4139%'`);
await db.query(`DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE remark LIKE '%V4139%')`);
await db.query(`DELETE FROM purchase_orders WHERE remark LIKE '%V4139%'`);
await db.query(`DELETE FROM products WHERE goods_no='T4139GN'`);
await db.query(`DELETE FROM employees WHERE emp_no LIKE 'T4139%'`);
await db.query(`DELETE FROM batches WHERE batch_no = 'B4139'`);

/* ── ① 056 设置 ── */
const all = unwrap(await fetch(BASE + '/settings', { headers: H }).then(r => r.json()));
const keys = new Set(all.map(s => s.setting_key));
t('①a mobile.hand 设置存在', keys.has('mobile.hand'));
t('①b stock.negative_sales 存在', keys.has('stock.negative_sales'));
t('①c init.* 开业初始设置存在', [...keys].filter(k => k.startsWith('init.')).length >= 3,
  [...keys].filter(k => k.startsWith('init.')).join(','));
const hk = unwrap(await fetch(BASE + '/settings/key/mobile.hand', { headers: H }).then(r => r.json()));
t('①d /settings/key/mobile.hand 可读', hk && 'value' in hk, JSON.stringify(hk));
const putH = await api('PUT', '/settings/mobile.hand', { value: 'left', reason: 'V4139 回归' });
const hk2 = unwrap(await fetch(BASE + '/settings/key/mobile.hand', { headers: H }).then(r => r.json()));
await api('PUT', '/settings/mobile.hand', { value: 'right', reason: 'V4139 回归复位' });
t('①e mobile.hand 可改可读', putH.ok && hk2.value === 'left', JSON.stringify(hk2));

/* ── ② 挂单/取单/销单 ── */
const prod = (await db.query(
  `SELECT id, name, supplier_default_id FROM products WHERE deleted_at IS NULL AND supplier_default_id IS NOT NULL ORDER BY id LIMIT 1`)).rows[0];
t('②前置 存在带默认供应商的商品', !!prod?.id);
const held = await api('POST', '/pos/held', {
  items: [{ productId: prod.id, qty: 2 }], remark: 'V4139 挂单回归', posNo: 'POS-TEST',
});
t('②a 挂单成功', held.ok && held.data?.id, held.msg);
const heldList = unwrap(await fetch(BASE + '/pos/held', { headers: H }).then(r => r.json()));
t('②b 挂单列表含新单', heldList.some(h => h.id === held.data.id));
const heldDetail = unwrap(await fetch(BASE + '/pos/held/' + held.data.id, { headers: H }).then(r => r.json()));
t('②c 挂单明细可读', heldDetail?.items?.length === 1 && Number(heldDetail.items[0].qty) === 2);
const pick = await api('POST', `/pos/held/${held.data.id}/pick`);
t('②d 单独销单成功', pick.ok, pick.msg);
const pick2 = await api('POST', `/pos/held/${held.data.id}/pick`);
t('②e 重复销单幂等', pick2.ok && pick2.data?.alreadyPicked === true, JSON.stringify(pick2));

/* ── ③ 采购退货免选供应商 ── */
const sup = (await db.query(`SELECT id FROM suppliers WHERE id=$1`, [prod.supplier_default_id])).rows[0];
t('③前置 默认供应商存在', !!sup?.id);
// 造在库批次 + 即时库存
const bid = (await db.query(
  `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date, expiry_date, inbound_cost, inbound_qty, remain_qty, status)
   VALUES (1,$1,$2,'B4139',CURRENT_DATE,CURRENT_DATE,CURRENT_DATE+365,3.5,10,10,'在库') RETURNING id`,
  [prod.id, prod.supplier_default_id])).rows[0].id;
await db.query(
  `INSERT INTO inventory_current (store_id, product_id, qty_total) VALUES (1,$1,10)
   ON CONFLICT (store_id, product_id) DO UPDATE SET qty_total = GREATEST(inventory_current.qty_total, 10)`, [prod.id]);
const ret1 = await api('POST', '/purchase/returns', {
  items: [{ productId: prod.id, qty: 2 }], remark: 'V4139 退货分桶回归',
});
t('③a 免选供应商退货成功（自动分桶）', ret1.ok && ret1.data?.returnNo, ret1.msg || JSON.stringify(ret1.data));
t('③b 分桶归属默认供应商', ret1.ok && Number(ret1.data?.supplierId) === Number(prod.supplier_default_id),
  JSON.stringify(ret1.data?.supplierId));
const retAllocs = (await db.query(
  `SELECT b.supplier_id FROM return_batch_allocs a JOIN batches b ON b.id=a.batch_id
    WHERE a.return_item_id IN (SELECT id FROM purchase_return_items WHERE return_id=$1)`, [ret1.data?.id])).rows;
t('③c 批次归属该供应商', retAllocs.every(r => Number(r.supplier_id) === Number(prod.supplier_default_id)));
// 无供应商属性商品
const p2 = (await db.query(
  `INSERT INTO products (store_id, goods_no, name, barcode, sell_price, supplier_default_id, base_unit, created_at)
   VALUES (1,'T4139GN','V4139无主商品','T4139NB',9.9,NULL,'件',now()) RETURNING id`)).rows[0];
const ret2 = await api('POST', '/purchase/returns', {
  items: [{ productId: p2.id, qty: 1 }], remark: 'V4139 无主商品拦截',
});
t('③d 无供应商属性商品被拦截并提示', !ret2.ok && /供应商/.test(ret2.msg), ret2.msg);
// p2 在结束清理统一删除

/* ── ④ 订货申请免选供应商 ── */
const po1 = await api('POST', '/purchase/orders', {
  items: [{ productId: prod.id, orderQty: 3 }], source: '订货申请', remark: 'V4139 订货分桶回归',
});
t('④a 免选供应商订货成功', po1.ok && (po1.data?.poNo || po1.data?.multi), po1.msg || JSON.stringify(po1.data));
t('④b 单供应商未拆单', po1.ok && po1.data?.multi === false, JSON.stringify(po1.data?.multi));
const po2 = await api('POST', '/purchase/orders', {
  items: [{ productId: p2.id, orderQty: 1 }], source: '订货申请', remark: 'V4139 订货无主拦截',
}).catch(e => ({ ok: false, msg: String(e) }));
t('④c 无供应商属性商品订货被拦截', !po2.ok && /供应商/.test(po2.msg || ''), po2.msg);

/* ── ⑤ 库存调拨门店参数 ── */
const stores = unwrap(await fetch(BASE + '/basic/stores', { headers: H }).then(r => r.json()));
t('⑤a 门店列表可读', Array.isArray(stores) && stores.length >= 1);
const tf = await api('POST', '/inventory/transfers', {
  fromStoreId: 1, toStoreId: Number(stores[0].id), reason: 'V4139 调拨门店回归',
  items: [{ productId: prod.id, qty: 1 }],
});
t('⑤b 调拨带门店参数成功（同店默认）', tf.ok && tf.data?.transferNo, tf.msg || JSON.stringify(tf.data));

/* ── ⑥ 随手拍 ── */
const free1 = await api('POST', '/ai/samples/free', {
  productId: prod.id, images: [{ angle: '顶面', path: '/uploads/t4139_1.jpg' }], annotation: { tag: 'V4139' },
});
t('⑥a 角度不全被拦截', !free1.ok && /角度/.test(free1.msg), free1.msg);
const ANGLES = ['顶面', '正面', '背面', '左侧面', '右侧面', '俯斜面'];
const free2 = await api('POST', '/ai/samples/free', {
  productId: prod.id,
  images: ANGLES.map((a, i) => ({ angle: a, path: `/uploads/t4139_${i}.jpg` })),
  annotation: { tag: 'V4139' },
});
t('⑥b 随手拍 6 角度提交成功', free2.ok && free2.data?.sampleCount === 6, free2.msg || JSON.stringify(free2.data));
const freeRows = (await db.query(`SELECT count(*)::int AS n FROM ai_samples WHERE source='随手拍' AND product_id=$1`, [prod.id])).rows;
t('⑥c 样本落库 source=随手拍', freeRows[0].n >= 6, freeRows[0].n);

/* ── ⑦ 单据列表 maker_name ── */
const inb = unwrap(await fetch(BASE + '/purchase/inbounds', { headers: H }).then(r => r.json()));
t('⑦a 入库列表含制单人', inb.every(r => 'maker_name' in r));
const rets = unwrap(await fetch(BASE + '/purchase/returns', { headers: H }).then(r => r.json()));
t('⑦b 退货列表含制单人', rets.every(r => 'maker_name' in r));

/* ── ⑧ 改密/密保找回链路（测试员工） ── */
const emp = await api('POST', '/auth/employees', {
  empNo: 'T4139A', name: 'V4139测试员', password: 'test123', roleIds: [],
});
t('⑧a 创建测试员工', emp.ok, emp.msg);
const empRow = (await db.query(`SELECT id FROM employees WHERE emp_no='T4139A'`)).rows[0];
const reset1 = await api('POST', `/auth/employees/${empRow.id}/reset-password`, { newPassword: 'newpass1' });
t('⑧b 管理员重置密码', reset1.ok, reset1.msg);
const login2 = unwrap(await fetch(BASE + '/auth/login', { method: 'POST', headers: H,
  body: JSON.stringify({ empNo: 'T4139A', password: 'newpass1' }) }).then(r => r.json()));
t('⑧c 新密码可登录', !!login2.token);
const chgWrong = await fetch(BASE + '/auth/change-password', { method: 'POST',
  headers: { ...H, authorization: 'Bearer ' + login2.token },
  body: JSON.stringify({ oldPassword: 'wrong-old', newPassword: 'abcdef' }) }).then(r => r.json());
t('⑧d 旧密码错误被拒（41002）', chgWrong.code === 41002, chgWrong.msg);
const chg = await fetch(BASE + '/auth/change-password', { method: 'POST',
  headers: { ...H, authorization: 'Bearer ' + login2.token },
  body: JSON.stringify({ oldPassword: 'newpass1', newPassword: 'abcdef' }) }).then(r => r.json());
t('⑧e 修改密码成功', chg.code === 0, chg.msg);
const sq = await fetch(BASE + '/auth/security-questions', { method: 'POST',
  headers: { ...H, authorization: 'Bearer ' + login2.token },
  body: JSON.stringify({ currentPassword: 'abcdef',
    questions: [{ question: 'Q1', answer: 'a1' }, { question: 'Q2', answer: 'a2' }, { question: 'Q3', answer: 'a3' }] }) }).then(r => r.json());
t('⑧f 设置密保问题', sq.code === 0, sq.msg);
const sqPub = unwrap(await fetch(BASE + '/auth/security-questions/T4139A').then(r => r.json()));
t('⑧g 公开接口返回问题（不含答案）', sqPub?.questions?.length === 3 &&
  JSON.stringify(sqPub).indexOf('a1') === -1, JSON.stringify(sqPub));
const forgot = await api('POST', '/auth/forgot-password', {
  empNo: 'T4139A', answers: ['a1', 'a2', 'a3'], newPassword: 'final123' });
t('⑧h 密保答对自助重置', forgot.ok, forgot.msg);
const login3 = unwrap(await fetch(BASE + '/auth/login', { method: 'POST', headers: H,
  body: JSON.stringify({ empNo: 'T4139A', password: 'final123' }) }).then(r => r.json()));
t('⑧i 重置后可登录', !!login3.token);

/* ── 结束清理 ── */
await db.query(`DELETE FROM held_orders WHERE remark LIKE '%V4139%'`);
await db.query(`DELETE FROM return_batch_allocs WHERE return_item_id IN (SELECT id FROM purchase_return_items WHERE return_id IN (SELECT id FROM purchase_returns WHERE remark LIKE '%V4139%'))`);
await db.query(`DELETE FROM purchase_return_items WHERE return_id IN (SELECT id FROM purchase_returns WHERE remark LIKE '%V4139%')`);
await db.query(`DELETE FROM purchase_returns WHERE remark LIKE '%V4139%'`);
await db.query(`DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE reason LIKE '%V4139%')`);
await db.query(`DELETE FROM stock_transfers WHERE reason LIKE '%V4139%'`);
await db.query(`DELETE FROM ai_samples WHERE source='随手拍' AND annotation::text LIKE '%V4139%'`);
await db.query(`DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE remark LIKE '%V4139%')`);
await db.query(`DELETE FROM purchase_orders WHERE remark LIKE '%V4139%'`);
await db.query(`DELETE FROM products WHERE goods_no='T4139GN'`);
await db.query(`DELETE FROM employees WHERE emp_no LIKE 'T4139%'`);
await db.query(`DELETE FROM batches WHERE batch_no = 'B4139'`);
await db.query(`UPDATE inventory_current SET qty_total = GREATEST(qty_total - 10, 0) WHERE store_id=1 AND product_id=$1`, [prod.id]);
await db.end();

console.log(`\n===== V4.13.9 回归：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
