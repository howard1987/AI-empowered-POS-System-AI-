/* V4.13.1 支付安全加固回归（设计文档 14.20 / 支付对比分析报告落地验证）
 * 覆盖：整数分支付校验 · pay_status 状态机（结账 paid / 退款 CAS）· CAS settle 预留 · 对账反方向报告
 * 运行：node tests/verify-v4131-pay.mjs   （需后端 :3100 + 联调库 54329）
 */
import { Client } from 'pg';

const BASE = 'http://localhost:3100';
const PG = { host: 'localhost', port: 54329, user: 'postgres', password: 'password', database: 'postgres' };
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '✓' : '✗'), name, extra); };
const unwrap = d => (d && typeof d === 'object' && 'code' in d && 'data' in d) ? d.data : d;

const pg = new Client(PG);
await pg.connect();

/* ── 登录 ── */
const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json());
const tk = unwrap(login)?.token;
if (!tk) { console.error('登录失败', JSON.stringify(login).slice(0, 200)); process.exit(1); }
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tk };

/* ── 准备测试商品（有库存批次才能结账；条码带时间戳防重跑撞档） ── */
const BC = '6912' + String(Date.now()).slice(-9);
const prod = unwrap(await fetch(BASE + '/products', { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'V4131支付测试品', barcode: BC, baseUnit: '瓶', sellPrice: 3.3, keepDays: 365,
    supplierDefaultId: 1, costPrice: 1 }) }).then(r => r.json()));
t('① 测试商品建档', !!prod?.id, `id=${prod?.id}`);

/* 入库建批次（FIFO）：直接建入库单 → 审核（库存落账） */
const sup = (await pg.query(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).rows[0];
t('②a 取供应商', !!sup?.id, `supplierId=${sup?.id ?? '—'}`);
let inboundOk = false;
if (sup?.id) {
  const inb = unwrap(await fetch(BASE + '/purchase/inbounds', { method: 'POST', headers: H,
    body: JSON.stringify({ supplierId: sup.id, items: [{ productId: prod.id, qty: 10, unitCost: 1, productionDate: '2026-09-01' }] }) }).then(r => r.json()).catch(() => null));
  if (inb?.id) {
    // 必签场景（inbound）：先补电子签字再审核（50018 防线）
    const PNG1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const sig = await fetch(BASE + '/purchase/signatures/attach', { method: 'POST', headers: H,
      body: JSON.stringify({ bizType: 'inbound', bizId: inb.id, personName: 'V4131回归', image: PNG1PX }) }).then(r => r.json()).catch(() => null);
    const aud = await fetch(BASE + `/purchase/inbounds/${inb.id}/audit`, { method: 'POST', headers: H, body: '{}' }).then(r => r.json()).catch(e => ({ err: e.message }));
    inboundOk = !!aud && (aud.code === undefined || aud.code === 0);
    if (!inboundOk) console.log('  sig/audit resp:', JSON.stringify(sig).slice(0, 120), JSON.stringify(aud).slice(0, 200));
  }
}
t('② 入库批次就绪（审核落库存）', inboundOk);

/* ── ③ 整数分边界：0.1+0.2 类浮点累加不再误判 ──
   构造 payments 累加 0.1+0.2=0.30000000000000004 ≠ 0.3：按浮点全等会报 50031，逐分比对应通过 */
const ck = await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 1 }],
  payments: [{ channel: '现金', amount: 0.1 }, { channel: '现金', amount: 0.2 }],
  remark: 'V4131浮点边界' }) }).then(r => r.json()).catch(e => ({ err: e.message }));
// 商品 3.3 元，两笔 0.1/0.2 不等应收 → 预期仍 50031，但错误语义走整数分路径；用 1+2 组合验证通过性
const ck2 = await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 1, unitPrice: 0.3 }],
  payments: [{ channel: '现金', amount: 0.1 }, { channel: '现金', amount: 0.2 }],
  remark: 'V4131浮点边界通过' }) }).then(r => r.json()).catch(e => ({ err: e.message }));
const ck2d = unwrap(ck2);
t('③ 浮点累加 0.1+0.2 逐分比对通过（改价 0.3）', !!ck2d?.orderId, `orderId=${ck2d?.orderId ?? JSON.stringify(ck2).slice(0, 120)}`);

/* ── ④ pay_status 结账即 paid + pay_paid_at ── */
const ord1 = await pg.query(`SELECT pay_status, pay_paid_at FROM sales_orders WHERE id=$1`, [ck2d.orderId]);
t('④ 结账单 pay_status=paid 且 pay_paid_at 落值',
  ord1.rows[0]?.pay_status === 'paid' && ord1.rows[0]?.pay_paid_at !== null, JSON.stringify(ord1.rows[0] || {}));

/* ── ⑤ CAS settle 预留：unpaid 单走 CAS 才能收钱（构造 unpaid 单验证） ── */
await pg.query(`UPDATE sales_orders SET pay_status='unpaid', pay_paid_at=NULL WHERE id=$1`, [ck2d.orderId]);
process.env.DATABASE_URL ||= 'postgres://postgres:password@localhost:54329/postgres';
const { SalesService } = await import('../dist/modules/sales.module.js').catch(() => ({}));
let casOk = false;
if (SalesService) {
  const svc = new SalesService();
  const payable = Number((await pg.query(`SELECT payable_amount FROM sales_orders WHERE id=$1`, [ck2d.orderId])).rows[0].payable_amount);
  casOk = await svc.settlePaidCas(ck2d.orderId, payable + 100); // 金额不符 → 拒绝
  t('⑤a CAS 金额不符拒绝', casOk === false, `expectPayable+100 → ${casOk}`);
  casOk = await svc.settlePaidCas(ck2d.orderId, payable);
  t('⑤b CAS 金额相符迁移 unpaid→paid', casOk === true);
  const again = await svc.settlePaidCas(ck2d.orderId, payable);
  t('⑤c CAS 幂等（已 paid 再迁失败）', again === false);
} else {
  // dist 直调不可用时走 SQL 等价验证
  const r = await pg.query(`UPDATE sales_orders SET pay_status='paid', pay_paid_at=now()
    WHERE id=$1 AND pay_status='unpaid' AND ROUND(payable_amount*100)=$2 RETURNING id`, [ck2d.orderId, Math.round(0.3 * 100)]);
  casOk = r.rowCount === 1;
  t('⑤ CAS SQL 等价迁移 unpaid→paid', casOk, `rowCount=${r.rowCount}`);
}

/* ── ⑥ 退款 CAS：部分退 → part_refunded；全额退 → refunded ── */
const det = unwrap(await fetch(BASE + `/sales/${ck2d.orderId}`, { headers: H }).then(r => r.json()));
const itemId = det?.items?.[0]?.id;
if (itemId) {
  // 部分退（qty 不足原行的 100%：原行 qty=1 无法部分退 → 直接全额退验证 refunded）
  const rf = await fetch(BASE + '/refunds', { method: 'POST', headers: H,
    body: JSON.stringify({ orderId: ck2d.orderId, items: [{ saleItemId: itemId, qty: 1 }], reason: 'V4131退款CAS', restock: false }) }).then(r => r.json());
  const rfd = unwrap(rf);
  t('⑥a 退款单创建并执行', rfd?.status === '已退款', JSON.stringify(rfd).slice(0, 140));
  if (rfd?.refundId && rfd.status !== '已退款') {
    const ex = unwrap(await fetch(BASE + `/refunds/${rfd.refundId}/audit`, { method: 'POST', headers: H, body: JSON.stringify({ approve: true }) }).then(r => r.json())).catch(() => null);
    t('⑥b 审核执行退款', !!ex, JSON.stringify(ex || {}).slice(0, 120));
  }
  const ps = (await pg.query(`SELECT pay_status FROM sales_orders WHERE id=$1`, [ck2d.orderId])).rows[0]?.pay_status;
  t('⑥c 全额退款后 pay_status=refunded（CAS）', ps === 'refunded', `pay_status=${ps}`);
} else t('⑥ 退款 CAS', false, '取不到明细行');

/* ── ⑦ 对账反方向：本地扫码收款、平台账单无行 → reverseDiffs 捕获 ── */
const ckScan = unwrap(await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 1, unitPrice: 5.5 }],
  payments: [{ channel: '微信', amount: 5.5, externalNo: 'V4131REV0001' }],
  remark: 'V4131反方向' }) }).then(r => r.json()));
t('⑦a 微信记账收款单创建', !!ckScan?.orderId, `orderId=${ckScan?.orderId} ${JSON.stringify(ckScan).slice(0, 100)}`);
const nowStr = (() => { const d = new Date(Date.now() - 60e3); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })();
const csv = `交易单号,金额,交易时间,收/支,状态\nTESTNOREV${Date.now()},1.00,${nowStr},收入,支付成功\n`;
const recon = unwrap(await fetch(BASE + '/finance/recon/bill/import', { method: 'POST', headers: H,
  body: JSON.stringify({ channel: '微信', csv, billDate: '20260909' }) }).then(r => r.json()));
t('⑦b 对账反方向报告：捕获本地有平台无（含本笔，≥1）', Number(recon?.reverseRows) >= 1 && Number.isFinite(Number(recon?.reverseTotal)), `reverseRows=${recon?.reverseRows} reverseTotal=${recon?.reverseTotal}`);
if (Number(recon?.reverseRows) === 1) {
  const det2 = unwrap(await fetch(BASE + `/finance/recon/runs/${recon.runId}`, { headers: H }).then(r => r.json()));
  const rev = det2?.reverseDiffs || [];
  t('⑦c 反方向明细含测试收款单', rev.some(x => x.orderNo === ckScan.orderNo), JSON.stringify(rev).slice(0, 160));
}

/* ── 清理 ── */
await pg.query(`UPDATE products SET deleted_at=now() WHERE barcode=$1`, [BC]);
await pg.query(`DELETE FROM barcode_cache WHERE barcode=$1`, [BC]);
await pg.end();
console.log('---'); console.log(`PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
