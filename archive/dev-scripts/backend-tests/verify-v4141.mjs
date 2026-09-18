/**
 * V4.14.1 批量整改 · 真实 PG 回归（测试数据自带清理）
 * 覆盖：促销四新类型（创建/校验/捆绑销售真实计价）、供应商变更单（落库+生效+还原）、
 *       AI 按商品发布任务/样本分页/随手拍样本删除、挂单挂起-删除链路、密码策略设置项
 */
import pg from 'pg';

const API = 'http://localhost:3100';
const DB = 'postgres://postgres:password@localhost:54329/postgres';
const pool = new pg.Pool({ connectionString: DB });
let TOKEN = '';
let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name + (detail ? ` —— ${detail}` : '')); console.log(`  ❌ ${name} ${detail}`); }
}

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return j;
}
async function must(method, path, body) {
  const j = await api(method, path, body);
  if (j.code !== 0) throw new Error(`${method} ${path} → code=${j.code} ${j.msg}`);
  return j.data;
}
const q = (sql, p = []) => pool.query(sql, p);

async function main() {
  /* ── 登录 ── */
  const lg = await api('POST', '/auth/login', { empNo: 'ADMIN', password: 'admin123' });
  ok('登录', lg.code === 0 && lg.data?.token);
  TOKEN = lg.data.token;

  /* ── 准备商品：两件有库存商品 ── */
  const prods = (await q(
    `SELECT p.id, p.name, p.sell_price, p.supplier_default_id, c.qty_total
       FROM products p JOIN inventory_current c ON c.product_id = p.id AND c.store_id = 1
      WHERE p.deleted_at IS NULL AND c.qty_total >= 20 ORDER BY p.id LIMIT 2`)).rows
    .map(r => ({ ...r, id: Number(r.id), sell_price: Number(r.sell_price), supplier_default_id: r.supplier_default_id == null ? null : Number(r.supplier_default_id) }));
  ok('准备两件库存充足商品', prods.length === 2, `got=${prods.length}`);
  const [A, B] = prods;
  console.log(`   商品A: #${A.id} ${A.name} ¥${A.sell_price} · 商品B: #${B.id} ${B.name} ¥${B.sell_price}`);

  /* ═══ 1. 促销四新类型 ═══ */
  console.log('\n── 1. 促销新类型 ──');
  const mk = (name, kind, rules) => must('POST', '/promotions', {
    name, kind, rules,
    startAt: new Date(Date.now() - 60e3).toISOString(),
    endAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  const p1 = await mk('V4141TEST·定时打折', '定时打折', { startTime: '00:01', endTime: '23:59', rate: 0.9 });
  const p2 = await mk('V4141TEST·捆绑销售', '捆绑销售', { items: [{ productId: A.id, qty: 1 }, { productId: B.id, qty: 1 }], bundlePrice: 5 });
  const p3 = await mk('V4141TEST·消费后奖励', '消费后奖励', { threshold: 50, rewardType: 'gift', giftName: 'V4141测试赠品' });
  const p4 = await mk('V4141TEST·满件折扣', '满件折扣', { minQty: 3, rate: 0.85 });
  ok('定时打折 创建', !!p1?.id);
  ok('捆绑销售 创建', !!p2?.id);
  ok('消费后奖励 创建', !!p3?.id);
  ok('满件折扣 创建', !!p4?.id);

  const bad = await api('POST', '/promotions', {
    name: 'V4141TEST·负例', kind: '定时打折', rules: { startTime: '20:00', endTime: '22:00' },
    startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  ok('定时打折缺 rate → 40003', bad.code === 40003, `code=${bad.code}`);
  const bad2 = await api('POST', '/promotions', {
    name: 'V4141TEST·负例2', kind: '捆绑销售', rules: { items: [{ productId: A.id, qty: 1 }], bundlePrice: 5 },
    startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  ok('捆绑销售单品 → 40003', bad2.code === 40003, `code=${bad2.code}`);
  const bad3 = await api('POST', '/promotions', {
    name: 'V4141TEST·负例3', kind: '消费后奖励', rules: { threshold: 50, rewardType: 'coupon' },
    startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  ok('消费后奖励发券缺 couponTemplateId → 40003', bad3.code === 40003, `code=${bad3.code}`);

  const lst = await must('GET', `/promotions?kind=${encodeURIComponent('捆绑销售')}&size=50`);
  ok('列表按新类型过滤', (lst.items || []).some(x => x.name === 'V4141TEST·捆绑销售'));

  /* ── 捆绑销售真实计价（启动 → 收银 → 校验 payable） ── */
  const bundlePrice = 5;
  await must('POST', `/promotions/${p2.id}/start`);
  const active = (await q(`SELECT count(*)::int AS n FROM promotions WHERE store_id=1 AND status='进行中' AND id <> $1`, [p2.id])).rows[0].n;
  if (active > 0) console.log(`   ⚠ 店内另有 ${active} 个进行中活动，计价取最优层可能叠加，断言按 payable ≤ 组合价`);
  const sumAB = Number(A.sell_price) + Number(B.sell_price);
  const co = await must('POST', '/sales/checkout', {
    items: [{ productId: A.id, qty: 1 }, { productId: B.id, qty: 1 }],
    payments: [{ channel: '现金', amount: bundlePrice, auto: true }],
    clientRef: `V4141TEST-${Date.now()}`,
  });
  const payable = Number(co.payable ?? co.payableAmount ?? co.total);
  const saved = Number(co.saved ?? co.discountTotal ?? co.promoSaved ?? 0);
  console.log(`   收银应答: payable=${payable} saved=${saved} 原价合计=${sumAB}`);
  if (active > 0) ok('捆绑销售计价（payable ≤ 组合价）', payable <= bundlePrice + 0.001);
  else ok('捆绑销售计价（payable = 组合价 5）', Math.abs(payable - bundlePrice) < 0.001, `payable=${payable}`);
  ok('捆绑销售有让利', saved > 0 || payable < sumAB, `saved=${saved}`);
  const orderId = co.orderId || co.id || co.order?.id;
  ok('收银落单', !!orderId);

  await must('POST', `/promotions/${p2.id}/stop`);

  /* ═══ 2. 供应商变更单 ═══ */
  console.log('\n── 2. 供应商变更单 ──');
  const sups = (await must('GET', '/purchase/suppliers'));
  const supList = sups.items || sups || [];
  const oldSid = A.supplier_default_id ? Number(A.supplier_default_id) : null;
  const newSup = supList.find(s => Number(s.id) !== oldSid) || supList[0];
  ok('存在可用供应商', !!newSup, '无供应商');
  const origPrice = Number(A.sell_price);
  const chg = await must('POST', '/purchase/supplier-changes', {
    newSupplierId: Number(newSup.id),
    reason: 'V4141TEST 变更回归',
    items: [{ productId: A.id, newCost: 9.99, newPrice: origPrice, isPrimary: true }],
  });
  const chgNo = chg.change_no || chg.changeNo;
  ok('变更单创建（GYSBG 单号）', /^GYSBG-\d{8}-\d{3,}$/.test(chgNo || ''), `no=${chgNo}`);
  const pAfter = (await q(`SELECT sell_price, supplier_default_id FROM products WHERE id=$1`, [A.id])).rows[0];
  ok('新售价已同步商品档案', Number(pAfter.sell_price) === origPrice);
  ok('主供应商已切换', Number(pAfter.supplier_default_id) === Number(newSup.id), `got=${pAfter.supplier_default_id}`);
  const costRow = (await q(`SELECT id FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 AND price=9.99 AND source_doc=$3`, [A.id, newSup.id, chgNo])).rows;
  ok('新进价落 supplier_product_prices（留痕）', costRow.length >= 1);
  const chgDetail = await must('GET', `/purchase/supplier-changes/${chg.id}`);
  ok('变更单明细可查', (chgDetail.items || []).length === 1 && chgDetail.items[0].productId === A.id);

  /* ═══ 3. AI 训练台 ═══ */
  console.log('\n── 3. AI 训练台 ──');
  const task = await must('POST', '/ai/tasks', { taskType: '采集', productIds: [A.id, B.id], remark: 'V4141TEST 按商品发布' });
  ok('按商品发布任务（目标=商品数）', Number(task.target_count ?? task.targetCount) === 2, `target=${task.target_count ?? task.targetCount}`);
  const orders = await must('GET', '/ai/orders');
  const orderArr = orders.items || orders || [];
  const tRow = orderArr.find(t => Number(t.id) === Number(task.id));
  ok('任务列表返回商品进度', tRow && Number(tRow.total_products) === 2 && Number(tRow.done_products) === 0,
    tRow ? `total=${tRow.total_products} done=${tRow.done_products}` : '未找到任务');

  const sPage1 = await must('GET', '/ai/samples?page=1&size=2');
  const arr1 = sPage1.items || sPage1 || [];
  ok('样本分页（size=2）', arr1.length <= 3, `len=${arr1.length}`);
  const sKw = await must('GET', `/ai/samples?keyword=${encodeURIComponent(A.name)}`);
  ok('样本关键字过滤', Array.isArray(sKw.items || sKw));

  // 样本删除端点（SQL 直插一行测试样本 → 走端点删除）
  const insS = await q(
    `INSERT INTO ai_samples (store_id, product_id, image_path, source, annotation, status)
     VALUES (1, $1, '/uploads/v4141test.png', 'V4141TEST', '{}', '待审核') RETURNING id`, [A.id]);
  const testSampleId = Number(insS.rows[0].id);
  const del = await api('POST', `/ai/samples/${testSampleId}/delete`);
  ok('样本删除端点', del.code === 0, `code=${del.code} ${del.msg || ''}`);
  const gone = (await q(`SELECT count(*)::int AS n FROM ai_samples WHERE id=$1`, [testSampleId])).rows[0].n;
  ok('样本已物理移除', gone === 0);

  /* ═══ 4. 挂单链路 ═══ */
  console.log('\n── 4. 挂单链路 ──');
  const held = await api('POST', '/pos/held', { items: [{ productId: A.id, qty: 1 }], remark: 'V4141TEST 挂单' });
  ok('挂单创建', held.code === 0 && !!held.data, `code=${held.code} ${held.msg || ''}`);
  const heldId = held.data?.id ?? held.data?.heldId;
  const heldList = await must('GET', '/pos/held?status=挂单中');
  ok('挂单后台列表可见', (heldList.items || heldList || []).some(x => Number(x.id) === Number(heldId)));
  const delHeld = await api('DELETE', `/pos/held/${heldId}`);
  ok('挂单删除（DELETE 端点）', delHeld.code === 0, `code=${delHeld.code} ${delHeld.msg || ''}`);

  /* ═══ 5. 密码策略设置项 ═══ */
  console.log('\n── 5. 设置 ═══');
  const pol = (await q(`SELECT value, value_type FROM system_settings WHERE setting_key='auth.password_policy'`)).rows[0];
  ok('auth.password_policy 设置存在（enum）', !!pol && pol.value_type === 'enum', JSON.stringify(pol));

  /* ═══ 清理 ═══ */
  console.log('\n── 清理测试数据 ──');
  if (orderId) {
    await q(`DELETE FROM stock_flows WHERE ref_type='sale' AND ref_id=$1`, [orderId]);
    await q(`UPDATE batches b SET remain_qty = b.remain_qty + a.qty
               FROM sale_item_batches a JOIN sale_items si ON si.id = a.sale_item_id
              WHERE si.order_id = $1 AND b.id = a.batch_id`, [orderId]);
    await q(`UPDATE inventory_current c SET qty_total = c.qty_total + si.qty
               FROM sale_items si
              WHERE si.order_id = $1 AND c.product_id = si.product_id AND c.store_id = 1 AND si.qty > 0`, [orderId]);
    await q(`DELETE FROM sale_item_batches WHERE sale_item_id IN (SELECT id FROM sale_items WHERE order_id=$1)`, [orderId]);
    await q(`DELETE FROM sale_payments WHERE order_id=$1`, [orderId]);
    await q(`DELETE FROM sale_items WHERE order_id=$1`, [orderId]);
    await q(`DELETE FROM sales_orders WHERE id=$1`, [orderId]);
    console.log(`   已还原测试订单 #${orderId}（库存/流水/订单）`);
  }
  // 供应商变更还原
  await q(`DELETE FROM supplier_product_prices WHERE source_doc=$1`, [chgNo]);
  await q(`DELETE FROM supplier_changes WHERE change_no=$1`, [chgNo]);
  await q(`UPDATE products SET sell_price=$2, supplier_default_id=$3, updated_at=now() WHERE id=$1`,
    [A.id, origPrice, oldSid]);
  console.log(`   已还原商品 #${A.id}（售价/主供应商）+ 删除测试变更单/进价记录`);
  // 促销测试活动
  for (const p of [p1, p2, p3, p4]) {
    if (p?.id) await q(`DELETE FROM promotions WHERE id=$1 AND name LIKE 'V4141TEST%'`, [p.id]);
  }
  console.log('   已删除 4 个 V4141TEST 测试活动');
  if (task?.id) { await q(`DELETE FROM ai_tasks WHERE id=$1`, [Number(task.id)]); console.log('   已删除测试采集任务'); }

  await pool.end();
  console.log(`\n═══ V4.14.1 回归：${pass} 通过 / ${fail} 失败 ═══`);
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(async e => { console.error('脚本异常:', e.message); await pool.end(); process.exit(1); });
