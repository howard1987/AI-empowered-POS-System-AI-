/**
 * 方向4 在线业务端到端验证（在线商城 + 地址簿 + 在线下单/配送/自提/外卖 + 拣货/核销/取消退款）：
 *   node tests/e2e-online.mjs
 * 依赖：后端已启动（http://localhost:3100）、库已迁移（023_online.sql + member_addresses 基线）
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

console.log('══ 方向4 在线业务 E2E ══');
const ts = String(Date.now()).slice(-8);
const phone = '137' + ts;
const mkBarcode = (n) => '68' + ts + n;

// ── 登录 ──
const lg = await api('/auth/login', { method: 'POST', body: { empNo: 'ADMIN', password: 'admin123' } });
const TOKEN = lg.token;
ok(!!TOKEN, '管理员登录');

// ════════ A. 造数：分类 + 商品 + 批次 + 会员 + 充值 ════════
console.log('\n── A. 造数 ──');
const cat = await api('/products/categories', { method: 'POST', token: TOKEN, body: { name: `在线商城${ts}` } });
const catId = Number(cat.id);
ok(catId > 0, `创建商城分类 #${catId}`);

const mkP = async (name, barcode, price, opts = {}) => {
  const r = await api('/products', {
    method: 'POST', token: TOKEN,
    body: { name, barcode, categoryId: catId, baseUnit: '件', sellPrice: price, memberPrice: opts.memberPrice ?? null,
            trackInventory: opts.track !== false, status: opts.status ?? 1 },
  });
  return Number(r.id);
};
const pA = await mkP('在线商品A', mkBarcode('1'), 10);
const pB = await mkP('在线商品B', mkBarcode('2'), 20, { track: false });
const pHidden = await mkP('停售商品', mkBarcode('3'), 5, { status: 0 });
const pOff = await mkP('下架商品', mkBarcode('4'), 8);
await pg.query(`UPDATE products SET online_visible=false WHERE id=$1`, [pOff]);
ok(pA > 0 && pB > 0 && pHidden > 0 && pOff > 0, `商品 #${pA} #${pB} #${pHidden} #${pOff}`);

// pA 在库批次 10 件（直接 SQL 造数，同 PWA 测试惯例）
await pg.query(
  `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date,
                        expiry_date, inbound_cost, inbound_qty, remain_qty, status)
   VALUES (1,$1,1,'BATCH-OL-'||floor(random()*100000),CURRENT_DATE,CURRENT_DATE,CURRENT_DATE+60,5,10,10,'在库')`,
  [pA]);
await pg.query(
  `INSERT INTO inventory_current (store_id, product_id, qty_total)
   VALUES (1,$1,10)
   ON CONFLICT (store_id, product_id) DO UPDATE SET qty_total = EXCLUDED.qty_total`, [pA]);

// 会员 + 充值 500
const reg = await api('/m/register', { method: 'POST', body: { phone, password: 'test123456', name: '在线测试会员', privacyAgreed: true } });
const M1 = Number(reg.member?.id);
const MTOKEN = reg.token;
ok(M1 > 0, `注册会员 #${M1}`);
const rc = await api(`/members/${M1}/recharges`, { method: 'POST', token: TOKEN, body: { principal: 500 } });
ok(rc.balanceAfter === 500, `会员充值 500（余额 ${rc.balanceAfter}）`);

// ════════ B. 在线商城：分类 + 商品列表 ════════
console.log('\n── B. 在线商城 ──');
const mcat = await api('/m/mall/categories', { token: MTOKEN });
const mcatRow = (mcat.items || []).find(c => Number(c.id) === catId);
ok(!!mcatRow && Number(mcatRow.prod_count) === 2, `商城分类含 2 个可售商品（实际 ${mcatRow?.prod_count}）`);

const mall = await api('/m/mall/products', { token: MTOKEN });
const mallIds = (mall.items || []).map(p => Number(p.id));
ok(mallIds.includes(pA) && mallIds.includes(pB), '商城商品含 A/B');
ok(!mallIds.includes(pHidden) && !mallIds.includes(pOff), '商城排除停售/下架商品');
ok(Number(mall.total) >= 2, `商城商品总数 ${mall.total}`);
const mallA = (mall.items || []).find(p => Number(p.id) === pA);
ok(Number(mallA?.stock) === 10 && Number(mallA?.sellPrice) === 10, `商城商品含库存/售价（库存 ${mallA?.stock}）`);

// 分类筛选 + 关键词
const mallCat = await api(`/m/mall/products?cat=${catId}`, { token: MTOKEN });
ok(Number(mallCat.total) === 2, `分类筛选命中 2 条（实际 ${mallCat.total}）`);

// ════════ C. 地址簿 ════════
console.log('\n── C. 地址簿 ──');
const a1 = await api('/m/addresses', { method: 'POST', token: MTOKEN, body: { contact: '张三', phone, address: '幸福路 1 号院 1 号楼' } });
const a1Id = Number(a1.id);
ok(a1Id > 0 && a1.is_default === true, `新增地址 #${a1Id}（首个自动默认）`);
const a2 = await api('/m/addresses', { method: 'POST', token: MTOKEN, body: { contact: '李四', phone, address: '中心大街 88 号' } });
const a2Id = Number(a2.id);
ok(a2Id > 0 && a2.is_default === false, `新增地址 #${a2Id}（非默认）`);
const up = await api(`/m/addresses/${a2Id}`, { method: 'PUT', token: MTOKEN, body: { isDefault: true, address: '中心大街 99 号' } });
ok(up.ok === true, '修改地址为默认');
const addrs = await api('/m/addresses', { token: MTOKEN });
const alist = (addrs.items || []).filter(a => [a1Id, a2Id].includes(Number(a.id)));
ok(alist.length === 2 && alist.find(a => Number(a.id) === a2Id)?.is_default === true, '地址簿 2 条且默认切换');
const badAddr = await api('/m/addresses', { method: 'POST', token: MTOKEN, body: { contact: '王五', phone: '123', address: 'x' } });
ok(badAddr.code !== 0, `非法地址被拒（${badAddr.msg || badAddr.code}）`);

// ════════ D. 在线下单 ════════
console.log('\n── D. 在线下单 ──');
// D1 自提：1×A = 10
const o1 = await api('/m/orders', { method: 'POST', token: MTOKEN, body: { items: [{ productId: pA, qty: 1 }], pickupMode: '自提' } });
ok(Number(o1.orderId) > 0 && Number(o1.payable) === 10, `自提单 #${o1.orderId} 应付 10（${o1.payable}）`);
ok(/^\d{6}$/.test(o1.pickupCode || ''), `自提单下发 6 位自提码 ${o1.pickupCode}`);
ok(o1.pickupMode === '自提' && o1.statusText === '待拣货', '自提单渠道/状态正确');
const me1 = await api('/m/me', { token: MTOKEN });
ok(Number(me1.assets?.balance) === 490, `余额自动扣减 490（实际 ${me1.assets?.balance}）`);

// D2 配送（20 < 免邮 50）：应收 20 + 配送费 3 = 23
const o2 = await api('/m/orders', { method: 'POST', token: MTOKEN, body: { items: [{ productId: pA, qty: 2 }], pickupMode: '配送', addressId: a1Id } });
ok(Number(o2.orderId) > 0 && Number(o2.deliveryFee) === 3 && Number(o2.payable) === 23, `配送单 #${o2.orderId} 配送费 3 应付 23`);

// D3 配送（50 ≥ 免邮 50）：免配送费
const o3 = await api('/m/orders', { method: 'POST', token: MTOKEN, body: { items: [{ productId: pA, qty: 1 }, { productId: pB, qty: 2 }], pickupMode: '配送', addressId: a1Id } });
ok(Number(o3.orderId) > 0 && Number(o3.deliveryFee) === 0 && Number(o3.payable) === 50, `配送单 #${o3.orderId} 满 ${50} 免配送费`);

// D4 未开通配送拦截：delivery.serving=0
await api('/settings/delivery.serving', { method: 'PUT', token: TOKEN, body: { value: 0 } });
const noServe = await api('/m/orders', { method: 'POST', token: MTOKEN, body: { items: [{ productId: pB, qty: 1 }], pickupMode: '配送', addressId: a1Id } });
ok(noServe.code !== 0 && /配送/.test(noServe.msg || ''), `未开通配送被拒（${noServe.msg}）`);
await api('/settings/delivery.serving', { method: 'PUT', token: TOKEN, body: { value: 1 } });

// D5 配送围栏：radius=1km，门店 (31.2,121.5)
await api('/settings/delivery.radius_km', { method: 'PUT', token: TOKEN, body: { value: 1 } });
await api('/settings/store.lat', { method: 'PUT', token: TOKEN, body: { value: 31.2 } });
await api('/settings/store.lng', { method: 'PUT', token: TOKEN, body: { value: 121.5 } });
const far = await api('/m/orders', { method: 'POST', token: MTOKEN, body: { items: [{ productId: pB, qty: 1 }], pickupMode: '配送', addressId: a1Id, lat: 39.9042, lng: 116.4074 } });
ok(far.code !== 0 && /配送范围/.test(far.msg || ''), `超出配送围栏被拒（${far.msg}）`);
const near = await api('/m/orders', { method: 'POST', token: MTOKEN, body: { items: [{ productId: pB, qty: 1 }], pickupMode: '外卖', addressId: a2Id, lat: 31.2001, lng: 121.5001 } });
const o4 = near;
ok(Number(o4.orderId) > 0, `围栏内外卖单 #${o4.orderId} 通过`);
ok(Number(o4.deliveryFee) === 3, `外卖单配送费 3（${o4.deliveryFee}）`);
await api('/settings/delivery.radius_km', { method: 'PUT', token: TOKEN, body: { value: 0 } });
await api('/settings/store.lat', { method: 'PUT', token: TOKEN, body: { value: 0 } });
await api('/settings/store.lng', { method: 'PUT', token: TOKEN, body: { value: 0 } });

// D6 收货人信息落库
const d2 = await api(`/m/orders/${o2.orderId}`, { token: MTOKEN });
ok(d2.order?.receiver === '张三' && d2.order?.receiver_address === '幸福路 1 号院 1 号楼', '配送单收货人/地址落库');
ok(Number(d2.order?.delivery_fee) === 3 && d2.order?.status === '已完成', '配送单配送费/状态落库');
ok(d2.items?.length === 1, `订单明细 ${d2.items?.length} 行`);

// D7 订单列表 + 派生状态
const orders = await api('/m/orders', { token: MTOKEN });
const myIds = (orders.items || []).map(o => Number(o.id));
ok(myIds.includes(Number(o1.orderId)) && myIds.includes(Number(o3.orderId)) && myIds.includes(Number(o4.orderId)), '订单列表含全部在线单');
ok((orders.items || []).every(o => ['待拣货', '配送中', '待自提', '已自提', '已送达', '已取消'].includes(o.statusText)), '列表派生状态文案合法');

// ════════ E. 门店履约：拣货 → 配送/核销 ════════
console.log('\n── E. 门店履约 ──');
// E1 拣货列表（线上单可拣）
const pickList = await api('/sales/picking', { token: TOKEN });
const pickRows = (Array.isArray(pickList) ? pickList : pickList.items || []).filter(o => [Number(o2.orderId), Number(o3.orderId)].includes(Number(o.id)));
ok(pickRows.length === 2, `拣货列表含 2 张线上单（${pickRows.length}）`);

// E2 配送单拣货开始→完成 → 装车出发（dispatched_at 置位）
const st2 = await api(`/sales/picking/${o2.orderId}/start`, { method: 'POST', token: TOKEN });
ok(st2.ok === true, '配送单开始拣货');
const cp2 = await api(`/sales/picking/${o2.orderId}/complete`, { method: 'POST', token: TOKEN });
ok(cp2.status === '已拣货', `配送单拣货完成（${cp2.status}）`);
const row2 = (await pg.query(`SELECT picking_status, dispatched_at, picked_by FROM sales_orders WHERE id=$1`, [o2.orderId])).rows[0];
ok(row2.picking_status === '已拣货' && !!row2.dispatched_at && !!row2.picked_by, `配送单已拣货+装车出发（dispatched_at=${row2.dispatched_at ? '已置位' : '空'}）`);
const d2b = await api(`/m/orders/${o2.orderId}`, { token: MTOKEN });
ok(d2b.order?.statusText === '配送中', `配送单状态文案「配送中」（${d2b.order?.statusText}）`);

// E3 配送码核销（顾客出示 6 位码 → 已送达）
const dv = await api('/sales/delivery/verify', { method: 'POST', token: TOKEN, body: { code: o3.pickupCode } });
ok(Number(dv.orderId) === Number(o3.orderId), `配送码核销 #${dv.orderNo}（已送达）`);
const d3 = await api(`/m/orders/${o3.orderId}`, { token: MTOKEN });
ok(d3.order?.statusText === '已送达', `配送单状态文案「已送达」（${d3.order?.statusText}）`);

// E4 自提单核销（顾客出示 6 位自提码 → 已自提）
const pv = await api('/sales/pickup/verify', { method: 'POST', token: TOKEN, body: { code: o1.pickupCode } });
ok(Number(pv.orderId) === Number(o1.orderId) && pv.itemCount === 1, `自提核销 #${pv.orderNo}（${pv.itemCount} 件）`);
const d1 = await api(`/m/orders/${o1.orderId}`, { token: MTOKEN });
ok(d1.order?.statusText === '已自提', `自提单状态文案「已自提」（${d1.order?.statusText}）`);
const pvBad = await api('/sales/pickup/verify', { method: 'POST', token: TOKEN, body: { code: o1.pickupCode } });
ok(pvBad.code !== 0, `自提码复用被拒（${pvBad.msg || pvBad.code}）`);

// ════════ F. 在线订单取消（原路退款 + 回库存） ════════
console.log('\n── F. 取消退款 ──');
// F1 已拣货订单不可取消
const canPicked = await api(`/m/orders/${o2.orderId}/cancel`, { method: 'POST', token: MTOKEN });
ok(canPicked.code !== 0 && /拣货|配送/.test(canPicked.msg || ''), `已拣货订单取消被拒（${canPicked.msg}）`);

// F2 新自提单 2×A=20 → 取消 → 退款 + 回库存
const o5 = await api('/m/orders', { method: 'POST', token: MTOKEN, body: { items: [{ productId: pA, qty: 2 }], pickupMode: '自提' } });
ok(Number(o5.orderId) > 0, `新自提单 #${o5.orderId} 2×A=20`);
const me5 = await api('/m/me', { token: MTOKEN });
ok(Number(me5.assets?.balance) === 374, `下单后余额 374（实际 ${me5.assets?.balance}）`);
const can = await api(`/m/orders/${o5.orderId}/cancel`, { method: 'POST', token: MTOKEN });
ok(can.ok === true && Number(can.refundId) > 0 && Number(can.refundAmount) === 20, `取消退款 #${can.refundId} 金额 ${can.refundAmount}`);
const d5 = await api(`/m/orders/${o5.orderId}`, { token: MTOKEN });
ok(d5.order?.status === '已取消' && d5.order?.statusText === '已取消', '取消单状态已取消');
const me5b = await api('/m/me', { token: MTOKEN });
ok(Number(me5b.assets?.balance) === 394, `退款后余额回补 394（实际 ${me5b.assets?.balance}）`);
const stockA = (await pg.query(`SELECT remain_qty FROM batches WHERE product_id=$1 AND status='在库' ORDER BY id DESC LIMIT 1`, [pA])).rows[0];
ok(Number(stockA.remain_qty) === 6, `取消后库存回补（A 余 ${stockA.remain_qty}，应为 6）`);
// 退款留痕
const refunds = await api('/refunds', { token: TOKEN });
const rfRow = (Array.isArray(refunds) ? refunds : refunds.items || []).find(r => Number(r.order_id) === Number(o5.orderId));
ok(!!rfRow && rfRow.status === '已退款' && rfRow.restock === true, `退款单留痕（${rfRow?.status} / restock=${rfRow?.restock}）`);

// F3 已核销订单不可取消
const canVerified = await api(`/m/orders/${o1.orderId}/cancel`, { method: 'POST', token: MTOKEN });
ok(canVerified.code !== 0, `已自提订单取消被拒（${canVerified.msg || canVerified.code}）`);

// ════════ G. 地址删除 ════════
const del = await api(`/m/addresses/${a1Id}`, { method: 'DELETE', token: MTOKEN });
ok(del.ok === true, '删除地址');
const addrs2 = await api('/m/addresses', { token: MTOKEN });
ok((addrs2.items || []).length === 1, `地址簿剩 1 条（${(addrs2.items || []).length}）`);

console.log(`\n结果：${pass}/${pass + fail} 通过`);
await pg.end();
process.exit(fail ? 1 : 0);
