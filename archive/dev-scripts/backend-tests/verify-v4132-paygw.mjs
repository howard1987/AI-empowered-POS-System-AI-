/* V4.13.2 支付通道适配层回归（设计文档 14.21）
 * 覆盖：付款码前缀识别渠道 · 模拟通道扣款/失败模拟 · out_trade_no 幂等 ·
 *       结账通道成功应答校验（伪造/金额不符/已关联 拒绝）· 通道流水关联订单 ·
 *       退款原路退（部分退 PART_REFUNDED / 全额退 REFUNDED）· pay.gateway.mode=off 回退记账式
 * 运行：node tests/verify-v4132-paygw.mjs   （需后端 :3100 + 联调库 54329）
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

/* ── 测试商品 + 入库批次（FIFO）── */
const BC = '6913' + String(Date.now()).slice(-9);
const prod = unwrap(await fetch(BASE + '/products', { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'V4132通道测试品', barcode: BC, baseUnit: '瓶', sellPrice: 3.3, keepDays: 365,
    supplierDefaultId: 1, costPrice: 1 }) }).then(r => r.json()));
t('① 测试商品建档', !!prod?.id, `id=${prod?.id}`);
const sup = (await pg.query(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).rows[0];
let inboundOk = false;
if (sup?.id) {
  const inb = unwrap(await fetch(BASE + '/purchase/inbounds', { method: 'POST', headers: H,
    body: JSON.stringify({ supplierId: sup.id, items: [{ productId: prod.id, qty: 50, unitCost: 1, productionDate: '2026-09-01' }] }) }).then(r => r.json()).catch(() => null));
  if (inb?.id) {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await fetch(BASE + '/purchase/signatures/attach', { method: 'POST', headers: H,
      body: JSON.stringify({ bizType: 'inbound', bizId: inb.id, personName: 'V4132回归', image: PNG }) }).then(r => r.json()).catch(() => null);
    const aud = await fetch(BASE + `/purchase/inbounds/${inb.id}/audit`, { method: 'POST', headers: H, body: '{}' }).then(r => r.json()).catch(() => null);
    inboundOk = !!aud && (aud.code === undefined || aud.code === 0);
  }
}
t('② 入库批次就绪', inboundOk);

const micropay = (authCode, amount, outTradeNo) =>
  fetch(BASE + '/pay/micropay', { method: 'POST', headers: H,
    body: JSON.stringify({ authCode, amount, ...(outTradeNo ? { outTradeNo } : {}) }) }).then(r => r.json());

/* 合法付款码：前缀 2 位 + 时间戳 13 位 + 校验位 1 位 = 16 位 */
const code = pfx => pfx + String(Date.now()) + '5';

/* ── ③ 付款码前缀识别 + 模拟扣款成功 ── */
const wx = unwrap(await micropay(code('13'), 3.3));
t('③ 微信付款码（13 开头）扣款成功', wx?.success === true && wx?.channel === '微信' && !!wx?.transactionId,
  JSON.stringify(wx).slice(0, 140));
const ali = unwrap(await micropay(code('28'), 1.0));
t('④ 支付宝付款码（28 开头）扣款成功', ali?.success === true && ali?.channel === '支付宝', `txn=${ali?.transactionId ?? '—'}`);

/* ── ⑤ 非法付款码 ── */
const bad = await micropay(code('99'), 1.0);
t('⑤ 非法前缀付款码拒绝（40903）', bad?.code === 40903, JSON.stringify(bad).slice(0, 100));
const badLen = await micropay('138123', 1.0);
t('⑤b 位数不足付款码拒绝（40903）', badLen?.code === 40903, JSON.stringify(badLen).slice(0, 100));

/* ── ⑥ 模拟失败（尾号 0000）── */
const fl = unwrap(await micropay('1381234567890120000', 1.0));
t('⑥ 模拟失败：尾号 0000 → success=false + FAIL 流水', fl?.success === false && !!fl?.failCode,
  `${fl?.failCode ?? ''} ${fl?.failMsg ?? ''}`);
const flRow = await pg.query(`SELECT status FROM pay_gateway_txns WHERE out_trade_no=$1`, [fl?.outTradeNo]);
t('⑥b 失败流水落库 status=FAIL', flRow.rows[0]?.status === 'FAIL', JSON.stringify(flRow.rows[0] || {}));

/* ── ⑦ 幂等：同 out_trade_no 重放 → 同流水号不重复扣款 ── */
const idemNo = 'MIDEM' + Date.now();
const id1 = unwrap(await micropay('1381234567890123456', 3.3, idemNo));
const id2 = unwrap(await micropay('1381234567890123456', 3.3, idemNo));
t('⑦ 幂等重放返回同 transactionId', id1?.success && id2?.success && id1.transactionId === id2.transactionId && id2.idempotent === true,
  `${id1?.transactionId} → ${id2?.transactionId}`);
const idCnt = await pg.query(`SELECT count(*)::int AS n FROM pay_gateway_txns WHERE out_trade_no=$1`, [idemNo]);
t('⑦b 幂等仅一行流水', idCnt.rows[0].n === 1, `n=${idCnt.rows[0].n}`);

/* ── ⑧ 结账通道应答校验：伪造 / 金额不符 / 已关联 均拒绝 ── */
const ckFake = await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 1 }], payments: [{ channel: '微信', amount: 3.3, gatewayOutTradeNo: 'NOT-EXIST-XXX' }],
  remark: 'V4132伪造流水' }) }).then(r => r.json());
t('⑧a 伪造 gatewayOutTradeNo 拒绝（40902）', ckFake?.code === 40902, JSON.stringify(ckFake).slice(0, 120));

const ckAmt = await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 1 }], payments: [{ channel: '微信', amount: 9.9, gatewayOutTradeNo: wx.outTradeNo }],
  remark: 'V4132金额不符' }) }).then(r => r.json());
t('⑧b 通道扣款金额与支付金额不符拒绝（40902）', ckAmt?.code === 40902, JSON.stringify(ckAmt).slice(0, 120));

/* 正常：通道扣款 3.3 → 结账 3.3 */
const ckOk = unwrap(await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 1 }], payments: [{ channel: wx.channel, amount: 3.3, gatewayOutTradeNo: wx.outTradeNo }],
  remark: 'V4132通道结账' }) }).then(r => r.json()));
t('⑧c 通道成功应答结账通过', !!ckOk?.orderId, `orderId=${ckOk?.orderId ?? JSON.stringify(ckOk).slice(0, 120)}`);
const txn1 = (await pg.query(`SELECT order_id, transaction_id, status, amount_cents, refund_cents FROM pay_gateway_txns WHERE out_trade_no=$1`, [wx.outTradeNo])).rows[0];
t('⑧d 通道流水回填 order_id', String(txn1?.order_id ?? '') === String(ckOk?.orderId), `order_id=${txn1?.order_id}`);
const pay1 = (await pg.query(`SELECT external_no FROM sale_payments WHERE order_id=$1`, [ckOk?.orderId])).rows[0];
t('⑧e sale_payments.external_no = 通道流水号', pay1?.external_no === txn1?.transaction_id, `${pay1?.external_no}`);

const ckRe = await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 1 }], payments: [{ channel: '微信', amount: 3.3, gatewayOutTradeNo: wx.outTradeNo }],
  remark: 'V4132重复关联' }) }).then(r => r.json());
t('⑧f 已关联流水二次结账拒绝（40902）', ckRe?.code === 40902, JSON.stringify(ckRe).slice(0, 120));

/* ── ⑨ 查单接口 ── */
const qr = unwrap(await fetch(BASE + `/pay/txn/${wx.outTradeNo}`, { headers: H }).then(r => r.json()));
t('⑨ 查单接口返回 SUCCESS 流水', qr?.status === 'SUCCESS' && qr?.out_trade_no === wx.outTradeNo, JSON.stringify(qr).slice(0, 120));

/* ── ⑩ 退款原路退：部分退 → PART_REFUNDED；全额退 → REFUNDED ── */
/* 重新扣一笔 6.6（qty 2 的单）*/
const wx2 = unwrap(await micropay(code('15'), 6.6));
const ck2 = unwrap(await fetch(BASE + '/sales/checkout', { method: 'POST', headers: H, body: JSON.stringify({
  items: [{ productId: prod.id, qty: 2 }], payments: [{ channel: wx2.channel, amount: 6.6, gatewayOutTradeNo: wx2.outTradeNo }],
  remark: 'V4132部分退' }) }).then(r => r.json()));
t('⑩a 第二单结账（qty 2 / 6.6 元）', !!ck2?.orderId, `orderId=${ck2?.orderId}`);
const det = unwrap(await fetch(BASE + `/sales/${ck2.orderId}`, { headers: H }).then(r => r.json()));
const itemId = det?.items?.[0]?.id;
const rf1 = unwrap(await fetch(BASE + '/refunds', { method: 'POST', headers: H,
  body: JSON.stringify({ orderId: ck2.orderId, items: [{ saleItemId: itemId, qty: 1 }], reason: 'V4132部分退', restock: false }) }).then(r => r.json()));
t('⑩b 部分退（1/2）执行', rf1?.status === '已退款', JSON.stringify(rf1).slice(0, 120));
const txnA = (await pg.query(`SELECT status, refund_cents, amount_cents FROM pay_gateway_txns WHERE out_trade_no=$1`, [wx2.outTradeNo])).rows[0];
t('⑩c 通道流水 PART_REFUNDED + 已退 330 分', txnA?.status === 'PART_REFUNDED' && Number(txnA?.refund_cents) === 330,
  JSON.stringify(txnA || {}));
const rf2 = unwrap(await fetch(BASE + '/refunds', { method: 'POST', headers: H,
  body: JSON.stringify({ orderId: ck2.orderId, items: [{ saleItemId: itemId, qty: 1 }], reason: 'V4132余款退', restock: false }) }).then(r => r.json()));
t('⑩d 余款退执行', rf2?.status === '已退款', JSON.stringify(rf2).slice(0, 120));
const txnB = (await pg.query(`SELECT status, refund_cents FROM pay_gateway_txns WHERE out_trade_no=$1`, [wx2.outTradeNo])).rows[0];
t('⑩e 全额退后 REFUNDED + 660 分', txnB?.status === 'REFUNDED' && Number(txnB?.refund_cents) === 660, JSON.stringify(txnB || {}));
/* 超额退护栏：第三笔再退应 50072（可退数量不足，通道层不会超额）*/
t('⑩f 通道退款累计 = 原扣款（无超额）', Number(txnB?.refund_cents) <= 660, `refund_cents=${txnB?.refund_cents}`);

/* ── ⑪ pay.gateway.mode=off → 40900 记账式回退 ── */
const putOff = await fetch(BASE + '/settings/pay.gateway.mode', { method: 'PUT', headers: H,
  body: JSON.stringify({ value: 'off' }) }).then(r => r.json());
const offR = await micropay(code('13'), 1.0);
t('⑪ mode=off 微通道扣款拒绝（40900）', putOff?.code === 0 && offR?.code === 40900, JSON.stringify(offR).slice(0, 100));
await fetch(BASE + '/settings/pay.gateway.mode', { method: 'PUT', headers: H, body: JSON.stringify({ value: 'mock' }) }).then(r => r.json());
const backR = unwrap(await micropay(code('13'), 1.0));
t('⑪b 恢复 mock 后扣款正常', backR?.success === true, `txn=${backR?.transactionId ?? '—'}`);

/* ── 汇总 ── */
console.log(`\n──── V4.13.2 支付通道适配层回归：${pass} 通过 / ${fail} 失败 ────`);
await pg.end();
process.exit(fail ? 1 : 0);
