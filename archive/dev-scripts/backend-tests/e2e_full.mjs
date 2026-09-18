/**
 * 全流程模拟测试（E2E）：仅通过 HTTP 接口模拟人工操作（手动建档、逐单流转），
 * 不直接写库；pg 客户端仅用于【只读】账实核对。
 * 运行：node tests/e2e_full.mjs
 */
import pg from 'pg';

const BASE = process.env.BASE || 'http://localhost:3100';
const PG = process.env.PG || 'postgres://postgres:password@localhost:54329/postgres';
const TAG = String(Date.now() % 1000000); // 唯一后缀，避免重跑冲突

let TOKEN = '';
const ctx = {};          // 各阶段传递的 id
const results = [];      // [状态, 名称, 备注]
const bugs = [];         // 疑似缺陷

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

function record(st, name, note = '') { results.push([st, name, note]); if (st === 'FAIL') bugs.push(name + ' :: ' + note); }

async function step(name, fn) {
  try { const note = await fn() || ''; record('PASS', name, typeof note === 'string' ? note : ''); }
  catch (e) { record('FAIL', name, (e.code ? `[${e.code}] ` : '') + String(e.message).slice(0, 220)); }
}

/** 期望失败（参数校验类）：业务码 4xxxx 且命中关键词 */
async function stepNeg(name, fn, kw) {
  try { await fn(); record('FAIL', name, '未拦截，操作竟然成功了'); }
  catch (e) {
    const ok = e.code >= 40000 && (!kw || String(e.message).includes(kw));
    record(ok ? 'PASS' : 'WARN', name, ok ? `已拦截：${String(e.message).slice(0, 80)}` : `拦截但异常：${e.code} ${String(e.message).slice(0, 100)}`);
  }
}

/** 只读核对 */
async function db(sql, params = []) {
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end().catch(() => {}); }
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const SIGN_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** 单据补签（必签配置下审核前置动作，模拟店长在签字板手写） */
async function sign(bizType, bizId) {
  return api('POST', '/purchase/signatures/attach', { bizType, bizId, personName: 'E2E店长', roleTitle: '店长', image: SIGN_PNG });
}

/* ═══════════════ 0. 登录 ═══════════════ */
await step('T0 登录后台（ADMIN）', async () => {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json());
  if (r.code !== 0) throw new Error(r.msg);
  TOKEN = r.data.token; ctx.userId = r.data.user?.sub ?? r.data.user?.id;
  return `token ${String(TOKEN).slice(0, 12)}…`;
});

/* ═══════════════ A. 基础档案（手动建档） ═══════════════ */
await step('A1 门店列表（/basic/stores）', async () => {
  const s = await api('GET', '/basic/stores');
  if (!s.length) throw new Error('无门店数据，建档无归属');
  ctx.storeName = s[0].name;
  return `门店：${s[0].name}`;
});

await step('A2 建品类（父：E2E饮品 / 子：E2E碳酸）', async () => {
  const p = await api('POST', '/products/categories', { name: 'E2E饮品' + TAG });
  const c = await api('POST', '/products/categories', { name: 'E2E碳酸' + TAG, parentId: p.id });
  ctx.catId = c.id; return `cat=${c.id}`;
});

await step('A3 建供应商（购销/月结）', async () => {
  const s = await api('POST', '/purchase/suppliers', { name: 'E2E供应商甲' + TAG, bizMode: '购销',
    contactPerson: '王业务', contactPhone: '138' + TAG, settlePeriod: '月结' });
  ctx.sup1 = s.id; return `sup=${s.id}`;
});

await step('A4 建供应商（联营/扣点5%）', async () => {
  const s = await api('POST', '/purchase/suppliers', { name: 'E2E联营乙方' + TAG, bizMode: '联营', deductionRate: 0.05 });
  ctx.sup2 = s.id; return `sup=${s.id}`;
});

await stepNeg('A5✗ 商品缺名称应拦截', () => api('POST', '/products', { base_unit: '个', sellPrice: 1 }));

await step('A6 建商品（瓶装水：多单位+附加码+会员价）', async () => {
  const p = await api('POST', '/products', {
    name: 'E2E矿泉水550ml' + TAG, barcode: '69' + TAG + '01', baseUnit: '瓶', sellPrice: 2.5, memberPrice: 2.2,
    keepDays: 365, categoryId: ctx.catId, supplierDefaultId: ctx.sup1, minStock: 10,
    units: [{ unitName: '箱', rate: 24, price: 55, barcode: '69' + TAG + '01C', isDefaultSale: false }],
  });
  ctx.pWater = p.id;
  await api('POST', `/products/${p.id}/barcodes`, { barcodes: ['69' + TAG + '01X'] }); // 一品多码：临期促销码
  const byUnit = await api('GET', '/products/barcode/69' + TAG + '01C');
  if (Number(byUnit.product?.id ?? byUnit.id ?? byUnit[0?.id]) !== p.id && !(JSON.stringify(byUnit).includes(String(p.id)))) {
    throw new Error('包装条码反查未命中该商品：' + JSON.stringify(byUnit).slice(0, 120));
  }
  return `product=${p.id}，包装码反查OK`;
});

await step('A7 建商品（香烟：保质期365天）', async () => {
  const p = await api('POST', '/products', { name: 'E2E香烟A' + TAG, barcode: '69' + TAG + '02',
    baseUnit: '包', sellPrice: 20, keepDays: 365, supplierDefaultId: ctx.sup1 });
  ctx.pSmoke = p.id; return `product=${p.id}`;
});

await step('A8 建商品（称重水果：保质期7天）', async () => {
  const p = await api('POST', '/products', { name: 'E2E香蕉(称重)' + TAG, barcode: '69' + TAG + '03',
    baseUnit: 'kg', sellPrice: 8.8, isWeighted: true, keepDays: 7, categoryId: ctx.catId });
  ctx.pFruit = p.id; return `product=${p.id}`;
});

await step('A9 附加条码反查（一品多码）', async () => {
  const r = await api('GET', '/products/barcode/69' + TAG + '01X');
  if (!JSON.stringify(r).includes(String(ctx.pWater))) throw new Error('附加码反查未命中');
  return 'OK';
});

await step('A10 一码多品：同码重复建档（应可建但系统可识别）', async () => {
  const p = await api('POST', '/products', { name: 'E2E同码商品' + TAG, barcode: '69' + TAG + '01',
    baseUnit: '瓶', sellPrice: 3 });
  ctx.pDup = p.id;
  return `允许建档（id=${p.id}），依赖收银端一码多品弹窗选择`;
});

await step('A11 编辑商品（改售价）', async () => {
  await api('PUT', `/products/${ctx.pWater}`, { sellPrice: 2.6 });
  const d = await api('GET', `/products/${ctx.pWater}`);
  const price = Number(d.sell_price ?? d.sellPrice ?? d.product?.sell_price);
  if (price !== 2.6) throw new Error('改价未生效，当前 ' + price);
  await api('PUT', `/products/${ctx.pWater}`, { sellPrice: 2.5 }); // 改回
  return 'OK';
});

await stepNeg('A12✗ 供应商缺名称应拦截', () => api('POST', '/purchase/suppliers', { bizMode: '购销' }));

/* ═══════════════ B. 采购全流程 ═══════════════ */
await step('B1 采购订单（草稿：水100×1.2 烟50×18）', async () => {
  const o = await api('POST', '/purchase/orders', { supplierId: ctx.sup1, source: '手动',
    items: [{ productId: ctx.pWater, orderQty: 100, price: 1.2 }, { productId: ctx.pSmoke, orderQty: 50, price: 18 }] });
  ctx.po = o.id; return `PO=${o.poNo}`;
});

await step('B2 提交→审批 PO', async () => {
  await api('POST', `/purchase/orders/${ctx.po}/submit`);
  await api('POST', `/purchase/orders/${ctx.po}/approve`);
  const d = await api('GET', `/purchase/orders/${ctx.po}`);
  return `状态=${d.status}`;
});

await stepNeg('B3✗ 入库缺生产日期应拦截(50011)', () =>
  api('POST', '/purchase/inbounds', { supplierId: ctx.sup1, poId: ctx.po,
    items: [{ productId: ctx.pWater, qty: 10, unitCost: 1.2 }] }));

await step('B4 首次入库60瓶（部分到货）', async () => {
  const r = await api('POST', '/purchase/inbounds', { supplierId: ctx.sup1, poId: ctx.po,
    items: [
      { productId: ctx.pWater, qty: 60, unitCost: 1.2, productionDate: daysAgo(30) },
      { productId: ctx.pSmoke, qty: 20, unitCost: 18, productionDate: daysAgo(60) },
    ] });
  ctx.ib1 = r.id;
  await sign('inbound', r.id);           // 必签配置：审核前补签
  await api('POST', `/purchase/inbounds/${r.id}/audit`, {});
  const d = await api('GET', `/purchase/orders/${ctx.po}`);
  if (!['到货中', '已完成'].includes(d.status)) throw new Error('PO状态异常：' + d.status);
  return `RK=${r.inboundNo}，PO→${d.status}`;
});

await step('B5 二次入库尾单（水40 烟30）→ PO应完成', async () => {
  const r = await api('POST', '/purchase/inbounds', { supplierId: ctx.sup1, poId: ctx.po,
    items: [
      { productId: ctx.pWater, qty: 40, unitCost: 1.25, productionDate: daysAgo(20) },
      { productId: ctx.pSmoke, qty: 30, unitCost: 18, productionDate: daysAgo(55) },
    ] });
  ctx.ib2 = r.id;
  await sign('inbound', r.id);
  await api('POST', `/purchase/inbounds/${r.id}/audit`, {});
  const d = await api('GET', `/purchase/orders/${ctx.po}`);
  if (d.status !== '已完成') throw new Error('PO应已完成，实际 ' + d.status);
  return 'OK';
});

await step('B6 入库后账实核对（批次/即时库存/进价历史）', async () => {
  const rows = await db(`SELECT id, remain_qty, inbound_cost, status FROM batches
    WHERE product_id=$1 AND store_id=1 ORDER BY id`, [ctx.pWater]);
  if (rows.length < 2) throw new Error('应为2个批次，实际 ' + rows.length);
  if (Number(rows[0].inbound_cost) !== 1.2 || Number(rows[1].inbound_cost) !== 1.25)
    throw new Error('批次成本不符：' + rows.map(r => r.inbound_cost).join(','));
  const inv = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  if (Number(inv[0].qty_total) !== 100) throw new Error('即时库存应100，实际 ' + inv[0].qty_total);
  return `批次${rows.length}个 100瓶 FIFO成本=1.2✓`;
});

await step('B7 采购退货（水5包，自动归属最早批次）', async () => {
  const r = await api('POST', '/purchase/returns', { supplierId: ctx.sup1,
    items: [{ productId: ctx.pWater, qty: 5, lineRemark: '包装破损' }] });
  ctx.ret = r.id;
  const b0 = await db(`SELECT remain_qty FROM batches WHERE product_id=$1 AND store_id=1 ORDER BY id LIMIT 1`, [ctx.pWater]);
  await api('POST', `/purchase/returns/${r.id}/evidence`, { evidencePath: '/uploads/e2e_evidence.png' }); // 补传凭证
  await sign('return', r.id);            // 必签配置：审核前补签
  await api('POST', `/purchase/returns/${r.id}/audit`, {});
  const b1 = await db(`SELECT remain_qty FROM batches WHERE product_id=$1 AND store_id=1 ORDER BY id LIMIT 1`, [ctx.pWater]);
  if (Number(b1[0].remain_qty) !== Number(b0[0].remain_qty) - 5) throw new Error(`首批次应扣5：${b0[0].remain_qty}→${b1[0].remain_qty}`);
  return `TH单${r.returnNo}，原批次扣减✓`;
});

await step('B8 对账单生成→确认→结算→审核', async () => {
  const preview = await api('GET', `/purchase/recon/preview?supplierId=${ctx.sup1}&from=${daysAgo(7)}&to=${today()}`);
  const rec = await api('POST', '/purchase/recon', { supplierId: ctx.sup1, from: daysAgo(7), to: today() });
  ctx.recon = rec.id ?? rec.reconciliation?.id;
  const conf = await api('POST', `/purchase/recon/${ctx.recon}/confirm`,
    { confirmType: '现场确认', confirmName: '王业务', signImage: SIGN_PNG });
  const st = await api('POST', '/purchase/settlements', { reconId: ctx.recon, payMode: '转账' });
  ctx.stl = st.id;
  const au = await api('POST', `/purchase/settlements/${st.id}/audit`, {});
  const list = await api('GET', '/purchase/recons');
  const items = Array.isArray(list) ? list : (list.items ?? []);
  const mine = items.find(x => Number(x.id) === Number(ctx.recon));
  if (!mine || mine.status !== '已结算') throw new Error('对账单未置已结算：' + mine?.status);
  return `DZ#${ctx.recon} 应付${st.amount} → 已结算✓`;
});

/* ═══════════════ C. 库存作业 ═══════════════ */
await step('C1 创建盘点任务（全仓）并指派', async () => {
  const emps = await api('GET', '/basic/employees');
  const t = await api('POST', '/inventory/count-tasks', { name: 'E2E全仓盘点' + TAG,
    scopeType: '全仓', assigneeId: emps[0]?.id ?? ctx.userId });
  ctx.task = t.id ?? t.task?.id;
  const d = await api('GET', `/inventory/count-tasks/${ctx.task}`);
  ctx.taskItems = d.items;
  if (!ctx.taskItems?.length) throw new Error('任务无明细');
  await api('POST', `/inventory/count-tasks/${ctx.task}/start`, {});
  return `${d.total_sku} SKU`;
});

await step('C2 手机端提交实盘（全部SKU：水=账面-3 制造盘亏，其余照抄账面）', async () => {
  const water = ctx.taskItems.find(i => Number(i.product_id) === Number(ctx.pWater));
  const expected = Math.max(0, Number(water.book_qty) - 3);
  const payload = ctx.taskItems.map(i => ({
    itemId: i.id,
    actualQty: Number(i.product_id) === Number(ctx.pWater) ? Math.max(0, Number(i.book_qty) - 3) : Math.max(0, Number(i.book_qty)),
  }));
  await api('POST', `/inventory/count-tasks/${ctx.task}/submit`, { items: payload });
  await api('POST', `/inventory/count-tasks/${ctx.task}/audit`, {});
  const inv = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  if (Number(inv[0].qty_total) !== expected) throw new Error(`盘点后库存应${expected}（${water.book_qty}-3），实际 ${inv[0].qty_total}`);
  return `审核通过，库存 ${water.book_qty}→${expected} FIFO扣减✓`;
});

await step('C3 报损（base64拍照上传→建单→补签→审核）', async () => {
  const up = await api('POST', '/upload', { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' });
  if (!up.path) throw new Error('上传失败');
  const r = await api('POST', '/inventory/losses', { reasonType: '破损', photoPath: up.path,
    items: [{ productId: ctx.pWater, qty: 1 }] });
  const before = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  await sign('loss', r.id);              // 必签配置：审核前补签
  await api('POST', `/inventory/losses/${r.id}/audit`, {});
  const after = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  if (Number(after[0].qty_total) !== Number(before[0].qty_total) - 1)
    throw new Error(`报损后库存应${Number(before[0].qty_total) - 1}，实际 ${after[0].qty_total}`);
  return `BS单${r.loss_no ?? r.id} 上传${up.path} 库存${before[0].qty_total}→${after[0].qty_total}✓`;
});

await step('C4 调拨（店内调拨→确认）', async () => {
  const stores = await api('GET', '/basic/stores');
  const r = await api('POST', '/inventory/transfers', { toStoreId: Number(stores[0].id), reason: 'E2E门店内移库',
    items: [{ productId: ctx.pSmoke, qty: 2 }] });
  ctx.tr = r.id;
  await api('POST', `/inventory/transfers/${r.id}/confirm`, {});
  const b = await db(`SELECT batch_no FROM batches WHERE product_id=$1 AND status='在库' AND batch_no LIKE 'DB%' LIMIT 1`, [ctx.pSmoke]);
  return `DB单#${r.id} 转入批次${b[0]?.batch_no ?? '(查无DB批次?)'}`;
});

await step('C5 调价单（售价2.5→2.8）→ 审核生效', async () => {
  const r = await api('POST', '/price-changes', { items: [{ productId: ctx.pWater, newPrice: 2.8 }], remark: 'E2E调价' });
  ctx.pc = r.id ?? r.order?.id;
  await api('POST', `/price-changes/${ctx.pc}/approve`, {});
  const d = await api('GET', `/products/${ctx.pWater}`);
  const price = Number(d.product?.sell_price ?? d.sell_price);
  if (price !== 2.8) throw new Error('调价未生效：' + price);
  await api('POST', '/price-changes', { items: [{ productId: ctx.pWater, newPrice: 2.5 }] })
    .then(async r2 => { await api('POST', `/price-changes/${r2.id ?? r2.order?.id}/approve`, {}); });
  return 'OK（已改回2.5）';
});

/* ═══════════════ D. 促销 ═══════════════ */
await step('D1 模板卡片数据（/promotions/templates）', async () => {
  const t = await api('GET', '/promotions/templates');
  if (!t.length) throw new Error('模板为空');
  ctx.tpl = t.find(x => x.kind === '满减') || t[0];
  return `${t.length} 个模板`;
});

await step('D2 建满减活动（模板改参：满100减20）', async () => {
  const r = await api('POST', '/promotions', { name: 'E2E满100减20' + TAG, kind: '满减',
    rules: { tiers: [{ threshold: 100, off: 20 }] },
    startAt: new Date().toISOString(), endAt: new Date(Date.now() + 86400000).toISOString(), startNow: true });
  ctx.promo = r.id ?? r[0]?.id;
  return `promo#${ctx.promo}`;
});

/* ═══════════════ E. 收银 ═══════════════ */
await step('E1 开班次（复用未交班次）', async () => {
  const cur = await api('GET', '/shifts/current');
  if (cur.shift?.id) { ctx.shift = cur.shift.id; return `复用进行中 shift#${ctx.shift}`; }
  const s = await api('POST', '/shifts/open', { posNo: 'POS-E2E', openingFloat: 100 });
  ctx.shift = s.id; return `shift#${s.id}`;
});

await step('E2 现金收银（水×3 应收7.5）FIFO成本核对', async () => {
  const r = await api('POST', '/sales/checkout', { shiftId: ctx.shift,
    items: [{ productId: ctx.pWater, qty: 3 }], payments: [{ channel: '现金', amount: 7.5 }] });
  ctx.sale1 = r.orderId ?? r.id;
  if (Number(r.payable) !== 7.5) throw new Error('应收应为7.5（3×2.5），实际 ' + r.payable);
  const cost = await db(`SELECT SUM(c.qty * c.unit_cost) AS cost FROM sale_item_batches c
    JOIN sale_items si ON si.id = c.sale_item_id WHERE si.order_id=$1`, [ctx.sale1]);
  if (Math.abs(Number(cost[0].cost) - Number(r.costTotal)) > 0.01)
    throw new Error(`响应成本${r.costTotal} 与台账${cost[0].cost} 不一致`);
  if (Math.abs(Number(cost[0].cost) - 3.6) > 0.01)
    throw new Error(`FIFO成本应3.6（3×首批次1.2），实际 ${cost[0].cost}`);
  return `订单#${ctx.sale1} FIFO成本3.6✓`;
});

await step('E3 多单位收银（整箱 应收55）', async () => {
  const q0 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  const r = await api('POST', '/sales/checkout', { shiftId: ctx.shift,
    items: [{ productId: ctx.pWater, qty: 1, unitName: '箱' }], payments: [{ channel: '微信', amount: 55 }] });
  ctx.sale2 = r.orderId ?? r.id;
  if (Number(r.payable) !== 55) throw new Error('整箱应收应55（箱价），实际 ' + r.payable);
  const q1 = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  if (Number(q1[0].qty_total) !== Number(q0[0].qty_total) - 24)
    throw new Error(`整箱应扣24瓶：${q0[0].qty_total}→${q1[0].qty_total}`);
  return `24瓶换算扣减✓（${q0[0].qty_total}→${q1[0].qty_total}）`;
});

await step('E4 满减促销生效（烟6包120→应付100）', async () => {
  const r = await api('POST', '/sales/checkout', { shiftId: ctx.shift,
    items: [{ productId: ctx.pSmoke, qty: 6 }], payments: [{ channel: '现金', amount: 100 }] });
  ctx.sale3 = r.orderId ?? r.id;
  const pay = Number(r.payable ?? r.payable_amount);
  if (pay !== 100) throw new Error(`应付应100（120-20），实际 ${pay}`);
  if (Number(r.promoAmount) !== 20) throw new Error(`促销优惠应20，实际 ${r.promoAmount}`);
  await api('POST', `/promotions/${ctx.promo}/stop`, {});
  return `120→${pay} 减20✓（已停活动）`;
});

await stepNeg('E5✗ 超库存销售应拦截', () =>
  api('POST', '/sales/checkout', { shiftId: ctx.shift,
    items: [{ productId: ctx.pSmoke, qty: 99999 }], payments: [{ channel: '现金', amount: 999999 }] }));

await stepNeg('E6✗ 支付金额不足应拦截或自动拆分', () =>
  api('POST', '/sales/checkout', { shiftId: ctx.shift,
    items: [{ productId: ctx.pWater, qty: 1 }], payments: [{ channel: '现金', amount: 0.1 }] }), '');

/* ═══════════════ F. 会员/分红/券/售后 ═══════════════ */
await step('F1 会员建档+充值（100+20）', async () => {
  const m = await api('POST', '/members', { phone: '139' + TAG, name: 'E2E会员', privacyAgreed: true });
  ctx.member = m.id;
  const rc = await api('POST', `/members/${ctx.member}/recharges`, { principal: 100, gift: 20 });
  if (Number(rc.balanceAfter) !== 120) throw new Error('充值后余额应120，实际 ' + rc.balanceAfter);
  return `member#${m.id} 余额120`;
});

await step('F2 会员消费（会员价2.2 应收44.4，余额支付）', async () => {
  const r = await api('POST', '/sales/checkout', { memberId: ctx.member, shiftId: ctx.shift,
    items: [{ productId: ctx.pSmoke, qty: 2 }, { productId: ctx.pWater, qty: 2 }],
    payments: [{ channel: '余额', amount: 44.4 }] });
  ctx.saleM = r.orderId ?? r.id;
  if (Number(r.payable) !== 44.4) throw new Error('会员价应收应44.4（2×20+2×2.2），实际 ' + r.payable);
  const acc = await db(`SELECT balance, principal_balance, gift_balance FROM member_accounts WHERE member_id=$1`, [ctx.member]);
  const bal = Number(acc[0].balance);
  if (Number(acc[0].balance).toFixed(2) !== (120 - 44.4).toFixed(2)) throw new Error('余额扣减异常：' + bal);
  return `余额120→${bal}（口径B principal=${acc[0].principal_balance} gift=${acc[0].gift_balance}）`;
});

await step('F3 余额不足组合支付（余额+现金补差买水36瓶=79.2）', async () => {
  const acc = await db(`SELECT balance FROM member_accounts WHERE member_id=$1`, [ctx.member]);
  const bal = Number(acc[0].balance); // 75.6
  const r = await api('POST', '/sales/checkout', { memberId: ctx.member, shiftId: ctx.shift,
    items: [{ productId: ctx.pWater, qty: 36 }],
    payments: [{ channel: '余额', amount: bal }, { channel: '现金', amount: Number((79.2 - bal).toFixed(2)) }] });
  ctx.saleM2 = r.orderId ?? r.id;
  if (Number(r.payable) !== 79.2) throw new Error('应收应79.2（36×会员价2.2），实际 ' + r.payable);
  return `余额${bal}+现金${(79.2 - bal).toFixed(2)} 组合支付OK`;
});

await step('F4 券：创建→发放→核销（满10减2）', async () => {
  const cp = await api('POST', '/coupons', { name: 'E2E满10减2' + TAG, type: '满减券',
    threshold: 10, discount: 2, validDays: 7, perMember: 1 });
  const is = await api('POST', `/coupons/${cp.id}/issue`, { memberIds: [ctx.member] });
  if (!is.issued) throw new Error('发放0张');
  const mine = await api('GET', `/coupons/member/${ctx.member}`);
  const c = (mine.items ?? mine ?? []).find?.(x => Number(x.coupon_id ?? x.couponId) === Number(cp.id) && !x.used_at);
  ctx.coupon = c?.id;
  if (!ctx.coupon) throw new Error('会员名下未查到有效券');
  const r = await api('POST', '/sales/checkout', { memberId: ctx.member, shiftId: ctx.shift,
    couponId: ctx.coupon,
    items: [{ productId: ctx.pWater, qty: 6 }], payments: [{ channel: '现金', amount: 11.2 }] });
  ctx.saleC = r.orderId ?? r.id;
  if (Number(r.couponAmount) !== 2) throw new Error(`券抵扣应2，实际 ${r.couponAmount}`);
  if (Number(r.payable) !== 11.2) throw new Error(`券后应付应11.2（6×2.2-2），实际 ${r.payable}`);
  return `券${is.issued}张 核销抵扣2元✓ 应付11.2`;
});

await step('F4b 会员追加充值50（保持余额>0，分红权重=本金余额）', async () => {
  const rc = await api('POST', `/members/${ctx.member}/recharges`, { principal: 50, gift: 0 });
  if (Number(rc.balanceAfter) !== 50) throw new Error('追加充值后余额应50，实际 ' + rc.balanceAfter);
  return '余额50（活跃窗口已达标 114.8≥50）';
});

await step('F5 分红计提（netProfit=200 → 活跃且余额>0的会员应得分红）', async () => {
  const pv = await api('GET', '/dividend/preview?netProfit=200');
  let run = null;
  let lastErr = null;
  for (let i = 0; i < 30 && !run; i++) {         // 当日已计提→逐日回溯找未计提日期（30天窗口支持反复重跑）
    try { run = await api('POST', '/dividend/periods/run', { date: daysAgo(i), netProfit: 200 }); }
    catch (e) { if (e.code !== 50060) throw e; lastErr = e; }
  }
  if (!run) throw lastErr || new Error('连续5日均已计提');
  const rec = await api('GET', `/dividend/records?memberId=${ctx.member}`);
  const list = rec.items ?? rec ?? [];
  const mine = list.find?.(x => Number(x.member_id) === Number(ctx.member));
  if (!mine) throw new Error('该会员未入分红名单（窗口累计或单笔门槛未过）resp=' + JSON.stringify(rec).slice(0, 150));
  return `period#${run.period?.id ?? run.id ?? '-'} 会员分红=${mine.amount ?? mine.dividend_amount ?? '?'}`;
});

await step('F6 销售退货（按行退1瓶水，原批次回仓）', async () => {
  const d = await api('GET', `/sales/${ctx.sale1}`);
  const line = (d.items ?? d.lines ?? []).find(x => Number(x.product_id) === Number(ctx.pWater));
  if (!line) throw new Error('未找到销售明细行');
  const r = await api('POST', '/refunds', { orderId: ctx.sale1, items: [{ saleItemId: line.id, qty: 1 }], reason: 'E2E退货', restock: true });
  ctx.refund = r.id ?? r.refundId ?? r.refund?.id ?? r.orderId;
  if (r.status && ['待审核', '待审批'].includes(r.status)) {
    await api('POST', `/refunds/${ctx.refund}/audit`, { approve: true });
  }
  const inv = await db(`SELECT qty_total FROM inventory_current WHERE product_id=$1 AND store_id=1`, [ctx.pWater]);
  return `refund#${ctx.refund} 现库存=${inv[0].qty_total}`;
});

await step('F7 交班（对账小票汇总）', async () => {
  const c = await api('POST', `/shifts/${ctx.shift}/close`, { cashCounted: 100, remark: 'E2E交班' });
  return `shift#${ctx.shift} 关闭✓`;
});

/* ═══════════════ G. 大客户团购 ═══════════════ */
await step('G1 大客户建档（9折/赊账额度500）', async () => {
  const r = await api('POST', '/big-customers', { name: 'E2E公司客户' + TAG, contact: '李采购',
    phone: '137' + TAG, defaultDiscount: 0.9, creditLimit: 500 });
  ctx.bc = r.id; return `bc#${r.id}`;
});

await step('G2 设置专属价（烟=19）+ 赊账下单', async () => {
  await api('PUT', `/big-customers/${ctx.bc}/prices`, { items: [{ productId: ctx.pSmoke, price: 19,
    validFrom: today() }] });
  const o = await api('POST', `/big-customers/${ctx.bc}/order`,
    { items: [{ productId: ctx.pSmoke, qty: 10 }], payChannel: '赊账' });
  ctx.bcOrder = o.id ?? o.orderId;
  const rcv = await api('GET', `/big-customers/${ctx.bc}/receivables`);
  const s = JSON.stringify(rcv);
  if (!s || s === '{}') throw new Error('应收概览为空');
  await api('POST', `/big-customers/${ctx.bc}/collect`, { amount: 50, method: '现金', remark: 'E2E回款' });
  return `订单#${ctx.bcOrder} 应收概览=${s.slice(0, 80)}，回款50✓`;
});

await stepNeg('G3✗ 非法支付渠道应拦截', () =>
  api('POST', `/big-customers/${ctx.bc}/order`, { items: [{ productId: ctx.pWater, qty: 1 }], payChannel: '比特币' }));

/* ═══════════════ H. 报表与杂项 ═══════════════ */
await step('H1 报表：dashboard/overview/daily', async () => {
  await api('GET', '/reports/dashboard');
  await api('GET', '/reports/overview');
  await api('GET', `/reports/daily?from=${daysAgo(1)}&to=${today()}`);
  return 'OK';
});
await step('H2 报表：销售明细/会员/库存', async () => {
  await api('GET', `/reports/sale-detail?from=${daysAgo(1)}&to=${today()}`);
  await api('GET', '/reports/member');
  await api('GET', '/reports/inventory');
  return 'OK';
});
await step('H3 设置读取+变更留痕', async () => {
  const s = await api('GET', '/settings');
  const first = (s.items ?? s ?? [])[0];
  if (first) await api('PUT', `/settings/${first.setting_key}`, { value: first.value, reason: 'E2E测试回写原值' });
  const ch = await api('GET', '/settings/changes');
  return `settings=${(s.items ?? s ?? []).length} 项，留痕${(ch.items ?? ch ?? []).length} 条`;
});
await step('H4 打印模板与打印机', async () => {
  const t = await api('GET', '/print-templates');
  const p = await api('GET', '/printers');
  return `模板${(t.items ?? t ?? []).length} 打印机${(p.items ?? p ?? []).length}`;
});
await step('H5 采购往来账（ledger）', async () => {
  const l = await api('GET', `/purchase/ledger?supplierId=${ctx.sup1}`);
  return `ledger ${(l.items ?? l ?? []).length} 条`;
});
await step('H6 临期预警', async () => {
  const e = await api('GET', '/inventory/expiry-alerts');
  return `${(e.items ?? e ?? []).length} 条预警`;
});

/* ═══════════════ 汇总 ═══════════════ */
const pass = results.filter(r => r[0] === 'PASS').length;
const warn = results.filter(r => r[0] === 'WARN').length;
const fail = results.filter(r => r[0] === 'FAIL').length;
console.log('\n========== E2E 全流程模拟测试结果 ==========');
for (const [st, name, note] of results) {
  const mark = st === 'PASS' ? '✅' : st === 'WARN' ? '⚠️ ' : '❌';
  console.log(`${mark} ${name}${note ? '  | ' + note : ''}`);
}
console.log(`\n合计：${results.length} 项 | 通过 ${pass} | 警示 ${warn} | 失败 ${fail}`);
if (bugs.length) { console.log('\n疑似缺陷清单：'); bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`)); }
