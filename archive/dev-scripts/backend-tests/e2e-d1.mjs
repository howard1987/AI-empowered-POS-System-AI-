/**
 * 方向1 收尾端到端验证（销售流水导出数据源 + 会员操作日志 + 进销存报表）：
 *   node tests/e2e-d1.mjs
 * 依赖：后端已启动（http://localhost:3100）
 * 全部通过退出码 0；任一失败打印 FAIL 并退出 1
 */
import { Client } from 'pg';

const BASE = 'http://localhost:3100';
const PG = 'postgres://postgres:password@localhost:54329/postgres';
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const api = async (path, { method = 'GET', token, body } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  return j.code === 0 ? j.data : j;
};
const pg = new Client({ connectionString: PG });
await pg.connect();

console.log('══ 方向1 收尾 E2E ══');
const ts = String(Date.now()).slice(-8);
const today = new Date().toISOString().slice(0, 10);
const mkBarcode = (n) => '67' + ts + n;

// ── 登录 ──
const lg = await api('/auth/login', { method: 'POST', body: { empNo: 'ADMIN', password: 'admin123' } });
const TOKEN = lg.token;
ok(!!TOKEN, '管理员登录');

// ════════ A. 造数：分类 + 商品 + 昨日入库流水 + 会员 ════════
console.log('\n── A. 造数 ──');
const cat = await api('/products/categories', { method: 'POST', token: TOKEN, body: { name: `D1报表${ts}` } });
const catId = Number(cat.id);
ok(catId > 0, `创建分类 #${catId}`);

const p = await api('/products', {
  method: 'POST', token: TOKEN,
  body: { name: `D1进销存${ts}`, barcode: mkBarcode('1'), categoryId: catId, baseUnit: '件', sellPrice: 10, memberPrice: null, trackInventory: true, status: 1 },
});
const pid = Number(p.id);
ok(pid > 0, `创建商品 #${pid}（售价 10）`);

// 昨日入库 10 件（stock_flows 全量流水，进销存期初口径）
await pg.query(
  `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date,
                        expiry_date, inbound_cost, inbound_qty, remain_qty, status)
   VALUES (1,$1,1,'BATCH-D1-'||floor(random()*100000),CURRENT_DATE-1,CURRENT_DATE-30,CURRENT_DATE+90,5,10,10,'在库')`,
  [pid]);
await pg.query(
  `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, created_at)
   VALUES (1,$1,(SELECT id FROM batches WHERE product_id=$1 ORDER BY id DESC LIMIT 1),'入库',10,5,'inbound',1,CURRENT_DATE - interval '1 day')`,
  [pid]);
await pg.query(
  `INSERT INTO inventory_current (store_id, product_id, qty_total)
   VALUES (1,$1,10) ON CONFLICT (store_id, product_id) DO UPDATE SET qty_total=EXCLUDED.qty_total`, [pid]);

// 会员建档（触发 audit_logs member.register）
const m = await api('/members', { method: 'POST', token: TOKEN, body: { phone: '136' + ts, name: 'D1操作日志', privacyAgreed: true } });
const mid = Number(m.id);
ok(mid > 0, `建档会员 #${mid}`);

// ════════ B. 销售下单（今日出库 3 件 → 进销存出库/销售行） ════════
console.log('\n── B. 销售下单 ──');
const co = await api('/sales/checkout', { method: 'POST', token: TOKEN, body: {
  items: [{ productId: pid, qty: 3 }], payments: [{ channel: '现金', amount: 30 }] } });
ok(co.orderId > 0, `收银结账 3 件（订单 #${co.orderId}）`);

// ════════ C. 进销存报表 ════════
console.log('\n── C. 进销存报表 GET /reports/inventory ──');
const iv = await api(`/reports/inventory?from=${today}&to=${today}&keyword=${encodeURIComponent(`D1进销存${ts}`)}`, { token: TOKEN });
const row = (iv.items || []).find(x => Number(x.id) === pid);
ok(!!row, '报表命中商品行');
ok(Number(row?.open_qty) === 10, `期初数量 10（昨日累计净入，实际 ${row?.open_qty}）`);
ok(Number(row?.in_qty) === 0, `区间入库 0（实际 ${row?.in_qty}）`);
ok(Number(row?.out_qty) === 3, `区间出库 3（实际 ${row?.out_qty}）`);
ok(Number(row?.open_qty) + Number(row?.in_qty) - Number(row?.out_qty) === 7, `期末数量 7（实际 ${Number(row?.open_qty) + Number(row?.in_qty) - Number(row?.out_qty)}）`);
ok(Number(row?.sale_orders) === 1, `销售单数 1（实际 ${row?.sale_orders}）`);
ok(Number(row?.sale_amount) === 30, `销售额 30（实际 ${row?.sale_amount}）`);
ok(Number(row?.sale_cost) === 15, `销售成本 15 = 3×5（实际 ${row?.sale_cost}）`);
ok(Number(row?.sale_profit) === 15, `毛利 15（实际 ${row?.sale_profit}）`);
ok(Number(iv.total?.saleAmount) >= 30 && Number(iv.total?.saleProfit) >= 15, `合计行含销售金额/毛利（${iv.total?.saleAmount}/${iv.total?.saleProfit}）`);

// ════════ D. 会员操作日志 ════════
console.log('\n── D. 会员操作日志 GET /members/:id ──');
const rc = await api(`/members/${mid}/recharges`, { method: 'POST', token: TOKEN, body: { principal: 100 } });
ok(rc.balanceAfter === 100, `储值 100 触发操作留痕（余额 ${rc.balanceAfter}）`);
const det = await api(`/members/${mid}`, { token: TOKEN });
const logs = det.logs || [];
ok(logs.length >= 2, `操作日志 ≥2 条（实际 ${logs.length}）`);
const regLog = logs.find(x => x.action === 'member.register');
const rcLog = logs.find(x => x.action === 'member.recharge');
ok(!!regLog, '含建档日志 member.register');
ok(!!rcLog, '含储值日志 member.recharge');
ok(rcLog?.operator_name && rcLog.operator_name !== '', `操作人解析（${rcLog?.operator_name}）`);
ok(rcLog?.detail && Number(rcLog.detail?.principal) === 100, '储值日志 detail 含本金 100');

// ════════ E. 销售流水导出数据源（分页 size=100） ════════
console.log('\n── E. 销售流水导出数据源 GET /sales ──');
const sl = await api(`/sales?from=&to=&size=100&page=1`, { token: TOKEN });
const slRow = (sl.items || []).find(x => Number(x.id) === Number(co.orderId));
ok(!!slRow, '流水含今日订单');
ok(slRow?.order_no && slRow?.channel && slRow?.payable_amount !== undefined && slRow?.profit_amount !== undefined,
  '导出所需字段齐全（单号/渠道/应收/毛利）');
ok(Array.isArray(sl.items) && Number(sl.items.length) <= 100, `分页 size=100 生效（本页 ${sl.items.length} 行）`);

console.log(`\n结果：${pass}/${pass + fail} 通过`);
pg.end();
process.exit(fail ? 1 : 0);
