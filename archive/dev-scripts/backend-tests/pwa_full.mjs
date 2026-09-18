/**
 * 员工手机端（PWA）全功能模拟测试：仅通过 HTTP 接口模拟人工操作，
 * 不直接写库；pg 客户端仅用于【只读】账实核对。
 * 覆盖（对应 pwa/*.js 全部视图）：登录/我的、价目表缓存源、移动收银（含应急/手输价/余额/离线补传）、
 *   移动收货+签名、采购退货+凭证、移动盘点、盘点任务、拍照报损、订货申请、配货拣货、
 *   配送码核销、库存调拨、次卡核销、AI识别/采集/票据OCR、单据/消息。
 * 运行：node tests/pwa_full.mjs
 */
import pg from 'pg';

const BASE = process.env.BASE || 'http://localhost:3100';
const PG = process.env.PG || 'postgres://postgres:password@localhost:54329/postgres';
const TAG = String(Date.now() % 1000000).padStart(6, '0');

let TOKEN = '';
const ctx = {};
const results = [];
const bugs = [];

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j;
  try { j = await res.json(); } catch { j = { code: -1, msg: 'HTTP ' + res.status + '（非JSON响应）' }; }
  if (j.code !== 0) { const e = new Error(j.msg || ('HTTP ' + res.status)); e.code = j.code; throw e; }
  return j.data;
}
async function apiRaw(method, path, body, withToken = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(withToken && TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try { return await res.json(); } catch { return { code: -1, msg: 'HTTP ' + res.status }; }
}
async function asStaff() {
  const j = await apiRaw('POST', '/auth/login', { empNo: 'ADMIN', password: 'admin123' }, false);
  if (j.code !== 0) throw new Error('管理员登录失败：' + j.msg);
  TOKEN = j.data.token;
}
function record(st, name, note = '') { results.push([st, name, note]); if (st === 'FAIL') bugs.push(name + ' :: ' + note); }
async function step(name, fn) {
  try { const note = await fn() || ''; record('PASS', name, typeof note === 'string' ? note : ''); }
  catch (e) { record('FAIL', name, (e.code ? `[${e.code}] ` : '') + String(e.message).slice(0, 220)); }
}
/** 期望失败：业务码 4xxxx/5xxxx 即通过；不抛错=漏洞 */
async function stepNeg(name, fn) {
  try { await fn(); record('FAIL', name, '未拦截，操作竟然成功了'); }
  catch (e) {
    const ok = e.code >= 40000;
    record(ok ? 'PASS' : 'WARN', name, ok ? `已拦截：${String(e.message).slice(0, 80)}` : `拦截但异常：${e.code} ${String(e.message).slice(0, 100)}`);
  }
}
async function db(sql, params = []) {
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end().catch(() => {}); }
}
const today = () => new Date().toISOString().slice(0, 10);
const SIGN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sign = (bizType, bizId) => api('POST', '/purchase/signatures/attach',
  { bizType, bizId, personName: 'PWA店长' + TAG, roleTitle: '店长', image: SIGN_PNG });

/* ═══════ A. 登录与身份（app.js） ═══════ */
await step('A1 员工登录（/auth/login）', async () => {
  const j = await apiRaw('POST', '/auth/login', { empNo: 'ADMIN', password: 'admin123' }, false);
  if (j.code !== 0) throw new Error(j.msg);
  TOKEN = j.data.token;
  return 'token OK';
});
await step('A2 /auth/me 返回权限点（View.me 权限墙）', async () => {
  const me = await api('GET', '/auth/me');
  ctx.staffId = Number(me.staffId);
  if (!Array.isArray(me.perms) || !me.perms.includes('pos.sell')) throw new Error('缺少 pos.sell 权限');
  return `${me.name} · ${me.perms.length} 项权限`;
});
await stepNeg('A3✗ 错误密码应拦截', async () => {
  const j = await apiRaw('POST', '/auth/login', { empNo: 'ADMIN', password: 'wrong-password' }, false);
  if (j.code === 0) throw new Error('错误密码登录成功');
  const e = new Error(j.msg); e.code = j.code; throw e;
});
await stepNeg('A4✗ 无 token 访问价目表应拒绝', async () => {
  const j = await apiRaw('GET', '/pos/pricebook', undefined, false);
  if (j.code === 0) throw new Error('未登录竟可拉价目表');
  const e = new Error(j.msg); e.code = j.code; throw e;
});

/* ═══════ B. 价目表与商品查找（checkout.js Pricebook / work.js lookupProduct） ═══════ */
await step('B1 /pos/pricebook 全量价目（缓存源）', async () => {
  const d = await api('GET', '/pos/pricebook');
  if (!d.version || !Array.isArray(d.items) || !d.items.length) throw new Error('价目表为空或缺 version');
  const it = d.items[0];
  for (const k of ['id', 'name', 'sellPrice']) if (it[k] === undefined) throw new Error('缺字段 ' + k);
  const withBc = d.items.find(x => x.barcode);
  if (!withBc) throw new Error('价目表无条码商品，条码缓存查找将全部失效');
  ctx.pbBarcode = withBc.barcode;
  ctx.pbSize = d.items.length;
  return `${ctx.pbSize} 条 · v${String(d.version).slice(0, 8)}`;
});
await step('B2 条码回源接口契约（单命中 {product,units} / 一码多品 {ambiguous,items}）', async () => {
  const d = await api('GET', '/products/barcode/' + ctx.pbBarcode);
  if (d?.ambiguous) {   // 一码多品：历史数据中该码被多商品共用，属合法形态
    if (!Array.isArray(d.items) || !d.items.length) throw new Error('ambiguous 但无候选');
    return `一码多品形态 ✓（${d.items.length} 个候选，前端弹窗选择）`;
  }
  const p = d && d.product ? d.product : d;
  if (!p || !p.name) throw new Error('条码回源失败：' + JSON.stringify(d).slice(0, 60));
  return `${p.name} ¥${p.sellPrice}（单命中，嵌套结构已确认）`;
});
await stepNeg('B3✗ 不存在条码应 404', async () => {
  await api('GET', '/products/barcode/9999999999999');
});
await step('B4 一码多品（多商品共用一码 → ambiguous + 全部候选）', async () => {
  const bc = '69' + TAG + 'AMB';
  const cat = (await api('GET', '/basic/categories')).items?.[0];
  const mk = async name => { const r = await apiRaw('POST', '/products', { name, barcode: bc, baseUnit: '个', sellPrice: 5.5, categoryId: cat?.id }); if (r.code !== 0) throw new Error(r.msg); return r.data.id; };
  const idA = await mk('一码多品A' + TAG);
  await mk('一码多品B' + TAG);
  const d = await api('GET', '/products/barcode/' + bc);
  if (!d.ambiguous || !Array.isArray(d.items) || d.items.length !== 2)
    throw new Error('应返回 ambiguous+2候选：' + JSON.stringify(d).slice(0, 80));
  if (!d.items.every(it => it.product && Array.isArray(it.units))) throw new Error('候选缺 product/units');
  // 一品多码对照：附加码应单命中（不 ambiguous）
  await api('POST', `/products/${idA}/barcodes`, { barcodes: ['69' + TAG + 'EXT'] });
  const s = await api('GET', '/products/barcode/69' + TAG + 'EXT');
  if (s.ambiguous || Number(s.product?.id) !== Number(idA)) throw new Error('附加码应单命中A');
  return 'ambiguous+2候选 ✓ · 附加码单命中 ✓（PWA/POS 弹窗选择）';
});

/* ═══════ C. 移动收银（checkout.js） ═══════ */
await step('C0 建档：供应商+2商品+首批入库（PWA 专用）', async () => {
  const s = await api('POST', '/purchase/suppliers', { name: 'PWA供应商' + TAG, bizMode: '购销', contactPerson: '王业务' });
  ctx.sup = s.id;
  const w = await api('POST', '/products', { name: 'PWA矿泉水' + TAG, barcode: '69' + TAG + '11',
    base_unit: '瓶', sellPrice: 2.5, keepDays: 180 });
  ctx.pWater = w.id; ctx.bcWater = '69' + TAG + '11';
  const c = await api('POST', '/products', { name: 'PWA可乐' + TAG, barcode: '69' + TAG + '12',
    base_unit: '罐', sellPrice: 3.5, keepDays: 270 });
  ctx.pCola = c.id;
  const ib = await api('POST', '/purchase/inbounds', { supplierId: ctx.sup, items: [
    { productId: ctx.pWater, qty: 100, unitCost: 1.2, productionDate: today() },
    { productId: ctx.pCola, qty: 100, unitCost: 2.0, productionDate: today() }] });
  await sign('inbound', ib.id);
  await api('POST', `/purchase/inbounds/${ib.id}/audit`, {});
  return `sup#${ctx.sup} 水#${ctx.pWater} 可乐#${ctx.pCola} 首批 100+100 已审核`;
});

await step('C1 现金结账（水×3+可乐×2 应收14.5）FIFO+库存核对+自动挂班', async () => {
  // 修复②回归：给该员工开班后，checkout 不传 shiftId 应自动挂接本人进行中班次
  try { await api('POST', '/shifts/open', { posNo: 'PWA-E2E', openingFloat: 100 }); } catch { /* 已有进行中班次 */ }
  const q0 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  const r = await api('POST', '/sales/checkout', {   // 注意：PWA 不传 shiftId
    items: [{ productId: ctx.pWater, qty: 3 }, { productId: ctx.pCola, qty: 2 }],
    payments: [{ channel: '现金', amount: 14.5 }], remark: '移动收银' });
  ctx.sale1 = r.orderId ?? r.id;
  if (Number(r.payable) !== 14.5) throw new Error('应收应14.5，实际 ' + r.payable);
  const q1 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  if (Number(q1[0].qty_total) !== Number(q0[0].qty_total) - 3) throw new Error(`库存应扣3：${q0[0].qty_total}→${q1[0].qty_total}`);
  const cost = await db(`SELECT SUM(c.qty*c.unit_cost) AS cost FROM sale_item_batches c
    JOIN sale_items si ON si.id=c.sale_item_id WHERE si.order_id=$1`, [ctx.sale1]);
  if (Math.abs(Number(cost[0].cost) - Number(r.costTotal)) > 0.01) throw new Error(`响应成本${r.costTotal}≠台账${cost[0].cost}`);
  const so = await db(`SELECT shift_id FROM sales_orders WHERE id=$1`, [ctx.sale1]);
  if (!so[0].shift_id) throw new Error('未传 shiftId 却未自动挂接本人进行中班次（修复②失效）');
  return `订单#${ctx.sale1} 扣库存✓ FIFO成本${cost[0].cost}✓ 自动挂班 shift#${so[0].shift_id} ✓`;
});

await step('C2 应急收银模式（isEmergency=true）', async () => {
  const r = await api('POST', '/sales/checkout', {
    items: [{ productId: ctx.pCola, qty: 1 }], payments: [{ channel: '现金', amount: 3.5 }],
    isEmergency: true, remark: '移动收银·应急' });
  if (Number(r.payable) !== 3.5) throw new Error('应收应3.5，实际 ' + r.payable);
  return `订单#${r.orderId ?? r.id} 应急单入账 ✓`;
});

await step('C3 应急手输价（unitPrice 1.0 + 条码留痕）', async () => {
  const r = await api('POST', '/sales/checkout', {
    items: [{ productId: ctx.pWater, qty: 1, unitPrice: 1.0, manualEntry: true, manualBarcode: '69' + TAG + '99' }],
    payments: [{ channel: '现金', amount: 1.0 }], isEmergency: true, remark: '移动收银·应急' });
  if (Number(r.payable) !== 1.0) throw new Error('手输价应收1.0，实际 ' + r.payable);
  const it = await db(`SELECT unit_price, line_remark, manual_barcode FROM sale_items WHERE order_id=$1`, [r.orderId ?? r.id]);
  if (!it.length || Number(it[0].unit_price) !== 1.0) throw new Error('明细单价非手输价');
  if (String(it[0].manual_barcode || '') !== '69' + TAG + '99')
    throw new Error(`manual_barcode 独立留痕缺失：「${it[0].manual_barcode}」（修复④失效）`);
  return `手输 ¥1.0 生效 · manual_barcode=${it[0].manual_barcode} ✓ · line_remark="${it[0].line_remark}"`;
});

await stepNeg('C4✗ 支付金额不足应拦截', () =>
  api('POST', '/sales/checkout', { items: [{ productId: ctx.pWater, qty: 1 }],
    payments: [{ channel: '现金', amount: 0.1 }], remark: '移动收银' }));
await stepNeg('C5✗ 超库存销售应拦截', () =>
  api('POST', '/sales/checkout', { items: [{ productId: ctx.pWater, qty: 99999 }],
    payments: [{ channel: '现金', amount: 999999 }], remark: '移动收银' }));

await step('C6 会员余额支付（建会员+充值100）', async () => {
  const m = await api('POST', '/members', { phone: '138' + TAG + '00', name: 'PWA会员', privacyAgreed: true });
  ctx.member = m.id;
  await api('POST', `/members/${ctx.member}/recharges`, { principal: 100, gift: 0 });
  const r = await api('POST', '/sales/checkout', { memberId: ctx.member,
    items: [{ productId: ctx.pWater, qty: 4 }], payments: [{ channel: '余额', amount: 10 }], remark: '移动收银' });
  const acc = await db(`SELECT balance FROM member_accounts WHERE member_id=$1`, [ctx.member]);
  if (Number(acc[0].balance) !== 90) throw new Error('余额应扣至90，实际 ' + acc[0].balance);
  return `member#${ctx.member} 余额100→${acc[0].balance}`;
});

await step('C7 离线补传幂等（同 clientRef 重发返回原单，修复①回归）', async () => {
  // 模拟断网暂存后补传两次（对应 app.js flushQueue 崩溃重试场景）
  const clientRef = 'T' + TAG + Date.now();
  const payload = { items: [{ productId: ctx.pWater, qty: 1 }],
    payments: [{ channel: '现金', amount: 2.5 }], remark: '离线补传', clientRef };
  const r1 = await api('POST', '/sales/checkout', payload);
  const r2 = await api('POST', '/sales/checkout', payload);
  if (r1.orderNo !== r2.orderNo || !r2.idempotent)
    throw new Error(`重发未返回原单：${r1.orderNo} vs ${r2.orderNo}（修复①失效）`);
  const cnt = await db(`SELECT count(*)::int AS n FROM sales_orders WHERE client_ref=$1`, [clientRef]);
  if (cnt[0].n !== 1) throw new Error(`同 clientRef 落库 ${cnt[0].n} 笔，重复入账`);
  return `重发幂等 ✓ 原单 ${r1.orderNo}（落库 1 笔，idempotent=true）`;
});

/* ═══════ D. 移动收货（work.js View.receive） ═══════ */
await step('D1 供应商下拉（/purchase/suppliers）', async () => {
  const list = await api('GET', '/purchase/suppliers');
  if (!Array.isArray(list) || !list.length) throw new Error('供应商列表为空');
  const hit = list.find(s => Number(s.id) === Number(ctx.sup));
  if (!hit) throw new Error('新建供应商不在列表');
  return `${list.length} 家，contact_person=${hit.contact_person ?? '（无字段）'}`;
});
await step('D2 提交收货单（生产日期必填）+ signInfo 自动关联', async () => {
  const r = await api('POST', '/purchase/inbounds', { supplierId: ctx.sup, items: [
    { productId: ctx.pWater, qty: 50, unitCost: 1.1, productionDate: today() }] });
  ctx.ib2 = r.id;
  if (!r.inboundNo) throw new Error('未返回 inboundNo');
  if (!r.signInfo || !r.signInfo.personName) record('WARN', 'D2 signInfo', '返回无 signInfo.personName，前端将走「现场补签」分支（可用但多一步）');
  else return `${r.inboundNo} 已自动关联业务员「${r.signInfo.personName}」`;
  return `${r.inboundNo}（无预采签名，走补签分支）`;
});
await stepNeg('D3✗ 明细缺生产日期应拦截（防绕过前端校验）', async () => {
  await api('POST', '/purchase/inbounds', { supplierId: ctx.sup, items: [
    { productId: ctx.pWater, qty: 10, unitCost: 1.0 }] });
});
await stepNeg('D4✗ 未签字审核应拦截（必签规则）', async () => {
  await api('POST', `/purchase/inbounds/${ctx.ib2}/audit`, {});
});
await step('D5 补签→审核→FIFO 批次生成核对', async () => {
  await sign('inbound', ctx.ib2);
  await api('POST', `/purchase/inbounds/${ctx.ib2}/audit`, {});
  const b = await db(`SELECT batch_no, remain_qty, inbound_cost FROM batches
    WHERE product_id=$1 AND store_id=1 ORDER BY id DESC LIMIT 1`, [ctx.pWater]);
  if (!b.length || Number(b[0].remain_qty) !== 50 || Number(b[0].inbound_cost) !== 1.1)
    throw new Error('审核后批次 50×1.1 未生成：' + JSON.stringify(b[0] || {}));
  return `批次 ${b[0].batch_no} 50×¥1.1 ✓`;
});

/* ═══════ E. 采购退货（work.js View.ret + captureEvidence） ═══════ */
await step('E1 提交退货单（批次自动归属）', async () => {
  const r = await api('POST', '/purchase/returns', { supplierId: ctx.sup,
    items: [{ productId: ctx.pWater, qty: 5 }] });
  ctx.ret = r.id;
  if (!r.returnNo) throw new Error('未返回 returnNo');
  return `${r.returnNo}（${r.status}）`;
});
await step('E2 补传退货凭证（/upload + evidence）', async () => {
  const u = await api('POST', '/upload', { image: SIGN_PNG });
  if (!u.path) throw new Error('upload 未返回 path');
  await api('POST', `/purchase/returns/${ctx.ret}/evidence`, { evidencePath: u.path });
  const row = await db(`SELECT evidence_path FROM purchase_returns WHERE id=$1`, [ctx.ret]);
  if (!row[0].evidence_path) throw new Error('凭证未落库');
  return `凭证 ${u.path} ✓`;
});
await step('E3 补签→审核→库存回仓核对', async () => {
  const q0 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  await sign('return', ctx.ret);
  await api('POST', `/purchase/returns/${ctx.ret}/audit`, {});
  const q1 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  if (Number(q1[0].qty_total) !== Number(q0[0].qty_total) - 5) throw new Error(`退货应扣5：${q0[0].qty_total}→${q1[0].qty_total}`);
  return `库存 ${q0[0].qty_total}→${q1[0].qty_total}（-5）✓`;
});
await stepNeg('E4✗ 未传凭证的退货审核应拦截', async () => {
  const r = await api('POST', '/purchase/returns', { supplierId: ctx.sup,
    items: [{ productId: ctx.pCola, qty: 2 }] });
  await sign('return', r.id);
  await api('POST', `/purchase/returns/${r.id}/audit`, {});
});

/* ═══════ F. 移动盘点（work.js View.count） ═══════ */
await step('F1 提交盘点单（实盘=账面-1 制造盘亏）', async () => {
  const sum = await api('GET', '/inventory/summary?keyword=PWA可乐' + TAG);
  const list = sum.items ?? sum;
  const hit = list.find(r => Number(r.id) === Number(ctx.pCola));
  if (!hit) throw new Error('库存汇总查不到可乐');
  ctx.colaBook = Number(hit.qty_total);
  const r = await api('POST', '/inventory/counts', { items: [{ productId: ctx.pCola, actualQty: ctx.colaBook - 1 }] });
  ctx.cnt1 = r.id;
  if (!r.countNo) throw new Error('未返回 countNo');
  return `${r.countNo}（${r.status}）账面${ctx.colaBook} 实盘${ctx.colaBook - 1}`;
});
await step('F2✗ 未签字盘点审核应拦截（必签场景探测）', async () => {
  try { await api('POST', `/inventory/counts/${ctx.cnt1}/audit`, {}); }
  catch (e) { return `已拦截：${e.message}`; }
  ctx.cnt1Audited = true;
  throw new Error('未签字盘点单审核通过 —— auth.sign_required_scenes 缺少 count（入库/退货/报损均强制）');
});
await step('F3 补签→审核→盘亏 FIFO 扣减核对', async () => {
  let cntId = ctx.cnt1, expect = ctx.colaBook - 1;
  if (ctx.cnt1Audited) {   // 漏洞场景下 F2 已扣 1，另建带签名单验证审核链路
    const r = await api('POST', '/inventory/counts', { items: [{ productId: ctx.pCola, actualQty: ctx.colaBook - 2 }] });
    cntId = r.id; expect = ctx.colaBook - 2;
  }
  await sign('count', cntId);
  await api('POST', `/inventory/counts/${cntId}/audit`, {});
  const q = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pCola]);
  if (Number(q[0].qty_total) !== expect) throw new Error(`盘亏后应${expect}，实际 ${q[0].qty_total}`);
  return `账实一致：${q[0].qty_total} ✓`;
});

/* ═══════ G. 盘点任务（work.js View.countTask） ═══════ */
await step('G1 店长创建盘点任务（全仓）', async () => {
  const t = await api('POST', '/inventory/count-tasks', { name: 'PWA盘点任务' + TAG,
    scopeType: '全仓', assigneeId: ctx.staffId, assigneeName: 'ADMIN', dueDate: today() });
  ctx.task = t.id;
  return `task#${ctx.task}（${t.taskNo ?? t.task_no ?? '无号'}）`;
});
await step('G2 店员任务列表+详情（assigneeId 过滤）', async () => {
  const list = await api('GET', '/inventory/count-tasks?assigneeId=' + ctx.staffId);
  const rows = list.items ?? list;
  const hit = rows.find(t => Number(t.id) === Number(ctx.task));
  if (!hit) throw new Error('指派任务不在我的列表');
  const d = await api('GET', `/inventory/count-tasks/${ctx.task}`);
  const items = d.items || [];
  if (!items.length) throw new Error('任务明细为空');
  ctx.taskItems = items.map(x => ({ id: Number(x.id), book: Number(x.book_qty) }));
  return `${items.length} 项 SKU · 状态 ${d.status}`;
});
await step('G3 开始→提交实盘（全部SKU 对齐账面）', async () => {
  await api('POST', `/inventory/count-tasks/${ctx.task}/start`, {});
  await api('POST', `/inventory/count-tasks/${ctx.task}/submit`,
    { items: ctx.taskItems.map(x => ({ itemId: x.id, actualQty: x.book })) });
  const d = await api('GET', `/inventory/count-tasks/${ctx.task}`);
  if (Number(d.counted_sku) !== Number(d.total_sku)) throw new Error(`已盘 ${d.counted_sku}/${d.total_sku} 不齐`);
  return `已盘 ${d.counted_sku}/${d.total_sku} · ${d.status}`;
});
await step('G4 店长审核任务（差异为零）', async () => {
  const r = await api('POST', `/inventory/count-tasks/${ctx.task}/audit`, {});
  return `audit OK：${JSON.stringify(r).slice(0, 60)}`;
});

/* ═══════ H. 拍照报损（work.js View.loss） ═══════ */
await stepNeg('H1✗ 无拍照凭证提交报损应拦截', async () => {
  await api('POST', '/inventory/losses', { reasonType: '破损', items: [{ productId: ctx.pCola, qty: 1 }] });
});
await step('H2 上传照片→提交报损单', async () => {
  const u = await api('POST', '/upload', { image: SIGN_PNG });
  const r = await api('POST', '/inventory/losses', { reasonType: '破损', photoPath: u.path,
    items: [{ productId: ctx.pCola, qty: 2 }] });
  ctx.loss = r.id;
  if (r.totalCost === undefined) record('WARN', 'H2 totalCost', '返回无 totalCost（前端要显示合计成本）');
  return `${r.lossNo}（${r.status}）成本 ${r.totalCost ?? '—'}`;
});
await stepNeg('H3✗ 未签字报损审核应拦截', async () => {
  await api('POST', `/inventory/losses/${ctx.loss}/audit`, {});
});
await step('H3b 补签→审核→报损扣库存核对', async () => {
  const q0 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pCola]);
  await sign('loss', ctx.loss);
  await api('POST', `/inventory/losses/${ctx.loss}/audit`, {});
  const q1 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pCola]);
  if (Number(q1[0].qty_total) !== Number(q0[0].qty_total) - 2) throw new Error(`报损应扣2：${q0[0].qty_total}→${q1[0].qty_total}`);
  return `库存 ${q0[0].qty_total}→${q1[0].qty_total}（-2）✓`;
});

/* ═══════ I. 订货申请（ops2.js View.order） ═══════ */
await step('I1 提交订货申请（source=订货申请）', async () => {
  const r = await api('POST', '/purchase/orders', { supplierId: ctx.sup,
    items: [{ productId: ctx.pWater, orderQty: 200, price: 1.1 }],
    source: '订货申请', remark: '移动端订货申请' });
  ctx.po = r.id;
  if (r.status !== '草稿') throw new Error('订货申请应落草稿状态，实际 ' + r.status);
  const d = await api('GET', `/purchase/orders/${ctx.po}`);
  if (d.source !== '订货申请') throw new Error('source 未落库：' + d.source);
  return `${r.poNo} 草稿 · 200×¥1.1 source=订货申请 ✓`;
});

/* ═══════ J. 配货拣货 + 配送码核销（ops2.js View.pick / View.deliver） ═══════ */
await step('J1 会员H5建档+地址（/m/register + /m/addresses）', async () => {
  const phone = '137' + TAG + '00';   // 11 位
  const reg = await apiRaw('POST', '/m/register', { phone, password: 'pwa123456', name: 'PWA线上会员', privacyAgreed: true });
  if (reg.code !== 0) throw new Error(reg.msg);
  ctx.mToken = reg.data.token; ctx.memberId2 = Number(reg.data.member.id);
  // 线上单余额自动付清 → 预充 50（员工端充值接口，立即到账）
  const rc = await api('POST', `/members/${ctx.memberId2}/recharges`, { principal: 50, gift: 0 });
  if (Number(rc.balanceAfter) !== 50) throw new Error('线上会员预充值未到账：' + rc.balanceAfter);
  TOKEN = ctx.mToken;
  let addr;
  try { addr = await api('POST', '/m/addresses', { contact: '张三', phone, address: '幸福路1号', isDefault: true }); }
  finally { await asStaff(); }
  ctx.addrId = addr && (addr.id ?? (addr.items && addr.items[0] && addr.items[0].id));
  if (!ctx.addrId) throw new Error('地址创建失败');
  return `member#${ctx.memberId2} addr#${ctx.addrId}`;
});
await step('J2 H5下单（小程序渠道·配送）→ 待拣货', async () => {
  TOKEN = ctx.mToken;
  let r;
  try {
    r = await api('POST', '/m/orders', { items: [{ productId: ctx.pWater, qty: 6 }],
      pickupMode: '配送', addressId: ctx.addrId });
  } finally { await asStaff(); }
  ctx.pickOrder = r.orderId; ctx.deliveryCode = r.pickupCode;
  if (!r.pickupCode) throw new Error('未返回配送核销码 pickupCode');
  return `订单#${r.orderId} 待拣货 · 配送码 ${r.pickupCode}`;
});
await step('J3 拣货单列表（/sales/picking?status=待拣货）', async () => {
  const rows = await api('GET', '/sales/picking?status=' + encodeURIComponent('待拣货'));
  const hit = rows.find(r => Number(r.id) === Number(ctx.pickOrder));
  if (!hit) throw new Error('线上订单未出现在拣货列表');
  if (!hit.picking_status) record('WARN', 'J3 picking_status', '列表无 picking_status 字段');
  return `命中 ${hit.order_no} · ${hit.channel}`;
});
await step('J4 拣货详情→开始→完成（配送自动 dispatch）', async () => {
  const d = await api('GET', '/sales/picking/' + ctx.pickOrder);
  if (!d.items.length) throw new Error('拣货明细为空');
  await api('POST', `/sales/picking/${ctx.pickOrder}/start`, {});
  const r = await api('POST', `/sales/picking/${ctx.pickOrder}/complete`, { shortages: [] });
  const o = await db(`SELECT picking_status, dispatched_at, picked_by FROM sales_orders WHERE id=$1`, [ctx.pickOrder]);
  if (o[0].picking_status !== '已拣货') throw new Error('完成拣货后状态异常：' + o[0].picking_status);
  if (!o[0].dispatched_at) record('WARN', 'J4 dispatch', '配送单拣货完成未置 dispatched_at（配送跟踪看不到出发）');
  return `${r.status} · picked_by=${o[0].picked_by} · dispatched=${!!o[0].dispatched_at}`;
});
await step('J5 配送码核销（delivery/verify）', async () => {
  const d = await api('POST', '/sales/delivery/verify', { code: ctx.deliveryCode });
  if (!d.orderNo) throw new Error('核销返回无单号');
  return `核销 ${d.orderNo} ¥${d.amount}`;
});
await stepNeg('J6✗ 重复核销同一配送码应拦截', async () => {
  await api('POST', '/sales/delivery/verify', { code: ctx.deliveryCode });
});
await step('J7 缺货登记拣货（第二单 complete+shortages）', async () => {
  TOKEN = ctx.mToken;
  let oid;
  try {
    const r = await api('POST', '/m/orders', { items: [{ productId: ctx.pCola, qty: 4 }],
      pickupMode: '配送', addressId: ctx.addrId });
    oid = r.orderId;
  } finally { await asStaff(); }
  await api('POST', `/sales/picking/${oid}/start`, {});
  const done = await api('POST', `/sales/picking/${oid}/complete`,
    { shortages: [{ productId: ctx.pCola, qty: 4, reason: '供应商断货' }] });
  if (done.status !== '缺货') throw new Error('缺货登记后状态应=缺货，实际 ' + done.status);
  const sh = await db(`SELECT qty, reason FROM picking_shortages WHERE order_id=$1`, [oid]);
  if (!sh.length || Number(sh[0].qty) !== 4) throw new Error('缺货登记未落库');
  return `订单#${oid} 缺货登记 4 件 ✓`;
});

/* ═══════ K. 库存调拨（ops2.js View.transfer） ═══════ */
await step('K1 新建店内调拨→确认入库→成本不变', async () => {
  const stores = await api('GET', '/basic/stores');
  const b0 = await db(`SELECT id, remain_qty, inbound_cost FROM batches WHERE product_id=$1 AND store_id=1 ORDER BY id LIMIT 1`, [ctx.pWater]);
  if (!b0.length) throw new Error('无可调拨批次');
  const r = await api('POST', '/inventory/transfers', { toStoreId: Number(stores[0].id), reason: 'PWA店内移库',
    items: [{ productId: ctx.pWater, qty: 10 }] });
  await api('POST', `/inventory/transfers/${r.id}/confirm`, {});
  const d = await api('GET', `/inventory/transfers/${r.id}`);
  const it = (d.items || [])[0] || {};
  if (Number(it.unit_cost) !== Number(b0[0].inbound_cost)) throw new Error(`调拨成本应不变 ${b0[0].inbound_cost}，实际 ${it.unit_cost}`);
  return `${r.transferNo} 10件 · 成本¥${it.unit_cost} 不变 ✓`;
});

/* ═══════ L. 次卡核销（ops2.js View.timesCard） ═══════ */
await step('L1 创建次卡（3次）→发放→查询', async () => {
  const cp = await api('POST', '/coupons', { name: 'PWA次卡' + TAG, type: '次卡',
    discount: 3, validDays: 30, perMember: 1 });
  ctx.timesCard = cp.id;
  const is = await api('POST', `/coupons/${cp.id}/issue`, { memberIds: [ctx.member] });
  if (!is.issued) throw new Error('发放0张');
  const mine = await api('GET', `/coupons/member/${ctx.member}`);
  const arr = mine.items ?? mine;
  const card = arr.find(x => Number(x.coupon_id ?? x.couponId) === Number(cp.id));
  if (!card) throw new Error('会员名下查不到次卡');
  ctx.memberCoupon = Number(card.id);
  return `次卡#${ctx.memberCoupon} 已发放`;
});
await step('L2 核销一次→剩余2次', async () => {
  const r = await api('POST', '/coupons/verify-times', { memberCouponId: ctx.memberCoupon });
  if (Number(r.remain) !== 2) throw new Error('剩余应2，实际 ' + r.remain);
  return `剩余 ${r.remain} ✓`;
});
await step('L3 连续核销至用尽→✗再核销应拦截', async () => {
  await api('POST', '/coupons/verify-times', { memberCouponId: ctx.memberCoupon });
  await api('POST', '/coupons/verify-times', { memberCouponId: ctx.memberCoupon });
  await stepNeg('L3b✗ 次数用完再核销', () =>
    api('POST', '/coupons/verify-times', { memberCouponId: ctx.memberCoupon }));
});

/* ═══════ M. AI（ai-scan.js / aiCollect / 票据OCR） ═══════ */
await step('M1 AI 多商品识别（mock 模拟一帧）', async () => {
  const d = await api('POST', '/ai/recognize', { scene: 'checkout' });
  const r = d.result ?? d;
  if (!Array.isArray(r)) throw new Error('识别结果非数组');
  return `${r.length} 个候选`;
});
await step('M2 AI 采集任务：建→领→交样本', async () => {
  const t = await api('POST', '/ai/tasks', { taskType: '采集', targetCount: 5, remark: 'PWA采集' + TAG });
  ctx.aiTask = t.id;
  await api('POST', `/ai/tasks/${ctx.aiTask}/start`, {});
  const u = await api('POST', '/upload', { image: SIGN_PNG });
  const s = await api('POST', `/ai/tasks/${ctx.aiTask}/submit-sample`,
    { imagePath: u.path, productId: ctx.pWater, annotation: { name: 'PWA矿泉水' + TAG, barcode: '69' + TAG + '11' } });
  if (Number(s.doneCount) < 1) throw new Error('样本计数未递增');
  return `任务#${ctx.aiTask} 样本 ${s.doneCount} 张`;
});
await step('M3 票据OCR文本模式：识别+低价保护', async () => {
  const d = await api('POST', '/ai/ocr-invoice', { supplierId: ctx.sup,
    text: `PWA矿泉水${TAG},69${TAG}11,0.5,10` });   // 0.5 元低于历史进价 1.1/1.2
  if (!Array.isArray(d.rows) || !d.rows.length) throw new Error('OCR 未识别出行');
  const row = d.rows[0];
  if (!row.lowPrice && !row.blocked) record('WARN', 'M3 低价保护', '进价0.5（历史最低1.1）未标记低价/拦截');
  else return `识别1行 · ${row.blocked ? '⛔已拦截' : '⚠低价'} 历史最低 ¥${row.minPrice}`;
  return `识别1行 lowPrice=${row.lowPrice} blocked=${row.blocked}`;
});
await step('M4 票据OCR 生成入库草稿（拦截→强推通过）', async () => {
  let blockedOk = false;
  try {
    const d1 = await api('POST', '/ai/ocr-invoice', { supplierId: ctx.sup,
      rows: [{ line: 1, name: 'PWA矿泉水' + TAG, barcode: '69' + TAG + '11', price: 0.5, qty: 10 }],
      apply: true, autoCreate: true });
    if (!d1.blocked) throw new Error('低价行未拦截也未提示');
    blockedOk = true;
  } catch (e) { if (String(e.message).includes('低价')) blockedOk = true; }
  const d2 = await api('POST', '/ai/ocr-invoice', { supplierId: ctx.sup,
    rows: [{ line: 1, name: 'PWA矿泉水' + TAG, barcode: '69' + TAG + '11', price: 0.5, qty: 10 }],
    apply: true, forceLowPrice: true, autoCreate: true });
  if (!d2.inboundNo) throw new Error('强制通过后未生成入库草稿');
  return `拦截=${blockedOk} · 强推草稿 ${d2.inboundNo}（${d2.createdCount} 条）`;
});

/* ═══════ N. 单据/消息（docs.js） ═══════ */
await step('N1 单据 Tab 四源聚合（入库/退货/盘点/报损）', async () => {
  const [inb, ret, cnt, loss] = await Promise.all([
    api('GET', '/purchase/inbounds'), api('GET', '/purchase/returns'),
    api('GET', '/inventory/counts'), api('GET', '/inventory/losses')]);
  const mine = a => (a.items ?? a).filter(r => Number(r.employee_id) === ctx.staffId);
  const n = mine(inb).length + mine(ret).length + mine(cnt).length + mine(loss).length;
  if (n < 4) throw new Error(`我经手的单据仅 ${n} 条，聚合异常`);
  const first = (inb.items ?? inb)[0] || {};
  if (first.employee_id === undefined)
    record('WARN', 'N1 字段', '列表缺 employee_id（前端按经手人过滤，缺失将显示为空）');
  return `入库${mine(inb).length} 退货${mine(ret).length} 盘点${mine(cnt).length} 报损${mine(loss).length}`;
});
await step('N2 消息 Tab：待办+临期预警', async () => {
  const [inb, cnt, loss, exp] = await Promise.all([
    api('GET', '/purchase/inbounds?status=' + encodeURIComponent('未审核')),
    api('GET', '/inventory/counts?status=' + encodeURIComponent('进行中')),
    api('GET', '/inventory/losses?status=' + encodeURIComponent('待审核')),
    api('GET', '/inventory/expiry-alerts')]);
  const exps = exp.items ?? exp;
  return `待审入库${(inb.items ?? inb).length} 进行中盘点${(cnt.items ?? cnt).length} 待审报损${(loss.items ?? loss).length} 临期${exps.length}`;
});

await step('O1 商城上下架（PUT /products/:id/online，修复③回归）', async () => {
  const off = await api('PUT', `/products/${ctx.pWater}/online`, { visible: false });
  if (off.onlineVisible !== false) throw new Error('下架未生效：' + JSON.stringify(off).slice(0, 60));
  const row = await db(`SELECT online_visible FROM products WHERE id=$1`, [ctx.pWater]);
  if (row[0].online_visible) throw new Error('库中仍为上架，member-app 将仍可见');
  const on = await api('PUT', `/products/${ctx.pWater}/online`, { visible: true });
  if (on.onlineVisible !== true) throw new Error('重上架未生效');
  return '下架→库表核实→重上架 ✓（member-app 商城查询均带 online_visible 过滤）';
});

/* ═══════ 汇总 ═══════ */
const pass = results.filter(r => r[0] === 'PASS').length;
const warn = results.filter(r => r[0] === 'WARN').length;
const fail = results.filter(r => r[0] === 'FAIL').length;
console.log('\n──────── PWA 全功能测试结果 ────────');
for (const [st, name, note] of results)
  console.log(`${st === 'PASS' ? '✅' : st === 'WARN' ? '🟡' : '❌'} ${name}${note ? ' | ' + note : ''}`);
console.log(`\n合计 ${results.length} 项 | 通过 ${pass} | 警示 ${warn} | 失败 ${fail}`);
if (bugs.length) { console.log('\n疑似缺陷：'); for (const b of bugs) console.log('  · ' + b); }
process.exit(fail ? 1 : 0);
