/**
 * P2 端到端验证（联营对账 + 电子签字 + 次卡 + 扫码购）：
 *   node tests/e2e-p2.mjs
 * 依赖：后端已启动（http://localhost:3100）、库已迁移（018_consign.sql）
 * 全部通过退出码 0；任一失败打印 FAIL 并退出 1
 */
const BASE = 'http://localhost:3100';
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
  return j.code === 0 ? j.data : j; // 成功解包 data；失败返回 {code,msg}
};

const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

console.log('══ P2 E2E 验证 ══');
const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const mStart = ymd.slice(0, 8) + '01';
// 每次运行使用唯一标识，保证脚本可重复执行（幂等）
const ts = String(Date.now()).slice(-8);
const phone = '138' + ts;                       // 11 位唯一手机号
const mkBarcode = (n) => '69' + ts + n;         // 唯一商品条码

// ── 登录 ──
const lg = await api('/auth/login', { method: 'POST', body: { empNo: 'ADMIN', password: 'admin123' } });
const TOKEN = lg.token;
ok(!!TOKEN, '管理员登录');

// ════════ A. 联营对账 + 电子签字（P2-3a / P2-3b） ════════
console.log('\n── A. 联营对账 + 电子签字 ──');
const supR = await api('/purchase/suppliers', {
  method: 'POST', token: TOKEN,
  body: { name: `联营测试供应商${ts}`, pinyinCode: `LY${ts}`, contactPerson: '王业务', contactPhone: '13900001111', bizMode: '联营', deductionRate: 0.15, guaranteeMin: 0, settlePeriod: '月结' },
});
const supId = Number(supR.id);
ok(supId > 0, `创建联营供应商 #${supId}（扣点 15%）`);

const mkP = async (name, barcode, price) => {
  const r = await api('/products', {
    method: 'POST', token: TOKEN,
    body: { name, barcode, baseUnit: '件', sellPrice: price, trackInventory: false, bizMode: '联营', supplierDefaultId: supId, status: 1 },
  });
  return Number(r.id);
};
const pA = await mkP('联营测试商品A', mkBarcode('1'), 10);
const pB = await mkP('联营测试商品B', mkBarcode('2'), 20);
ok(pA > 0 && pB > 0, `创建联营商品 #${pA} / #${pB}`);

// 会员 + 充值
const reg = await api('/m/register', { method: 'POST', body: { phone, password: 'test123456', name: '联营测试会员', privacyAgreed: true } });
const M1 = Number(reg.member?.id);
const MTOKEN = reg.token;
ok(M1 > 0, `注册会员 #${M1}`);
const rc = await api(`/members/${M1}/recharges`, { method: 'POST', token: TOKEN, body: { principal: 500 } });
ok(rc.balanceAfter === 500, `会员充值 500（余额 ${rc.balanceAfter}）`);

// 收银下单（联营商品销售）
const chk = async (items, opts = {}) => {
  const amount = items.reduce((a, i) => a + i.qty * (i.price || 0), 0);
  return api('/sales/checkout', {
    method: 'POST', token: TOKEN,
    body: { items: items.map(i => ({ productId: i.id, qty: i.qty })), memberId: M1, channel: opts.channel || '收银台', couponId: opts.couponId, payments: opts.pay || [{ channel: '现金', amount }] },
  });
};
const s1 = await chk([{ id: pA, qty: 2, price: 10 }, { id: pB, qty: 1, price: 20 }]);
ok(Number(s1.orderId) > 0 && Number(s1.payable) === 40, `联营销售 #${s1.orderId} 应收 40`);
const s2 = await chk([{ id: pA, qty: 1, price: 10 }]);
ok(Number(s2.orderId) > 0, `联营销售 #${s2.orderId}`);

// 看板
const ov = await api(`/purchase/consign/overview?supplierId=${supId}&from=${mStart}&to=${ymd}`, { token: TOKEN });
ok(Number(ov.salesTotal) === 50, `看板销售额 50（实际 ${ov.salesTotal}）`);
ok(Number(ov.orderCount) === 2, `看板销售单数 2（实际 ${ov.orderCount}）`);
ok(Number(ov.deductionAmount) === 7.5, `看板扣点收益 7.5（实际 ${ov.deductionAmount}）`);
ok(Number(ov.payable) === 42.5, `看板应结 42.5（实际 ${ov.payable}）`);
ok(ov.topProducts.length >= 2, `看板 TOP 商品 ${ov.topProducts.length} 个`);

// 预览
const pv = await api(`/purchase/consign/preview?supplierId=${supId}&from=${mStart}&to=${ymd}`, { token: TOKEN });
ok(pv.orders?.length === 2, `预览销售小票 2 单（实际 ${pv.orders?.length}）`);
ok(Number(pv.payable) === 42.5, `预览应结 42.5（实际 ${pv.payable}）`);

// 生成对账单
const cr = await api('/purchase/consign-recon', { method: 'POST', token: TOKEN, body: { supplierId: supId, from: mStart, to: ymd } });
const reconId = Number(cr.id);
ok(/^LC-/.test(cr.reconNo || ''), `生成对账单 ${cr.reconNo}`);
ok(Number(cr.orderCount) === 2, `对账单吸收 2 单（实际 ${cr.orderCount}）`);

// 预采集签字模板
const sig = await api('/purchase/signatures', { method: 'POST', token: TOKEN, body: { personName: '王业务', roleTitle: '常驻业务员', image: PNG1 } });
const tplId = Number(sig.id);
ok(tplId > 0, `预采集签字模板 #${tplId}（王业务）`);

// 对账单确认（预采调用落证据链）
const cf = await api(`/purchase/consign-recons/${reconId}/confirm`, { method: 'POST', token: TOKEN, body: { confirmType: '现场确认', confirmName: '王业务', templateId: tplId } });
ok(cf.status === '已确认' && Number(cf.signRecordId) > 0, `对账单确认（签字记录 #${cf.signRecordId}）`);

// 签字调用记录
const recs = await api('/purchase/signature-records?bizType=对账确认', { token: TOKEN });
const rec = (recs.items || []).find(r => Number(r.biz_id) === reconId);
ok(!!rec && rec.person_name === '王业务' && rec.scene === '调用', `签字调用记录留痕（${rec?.scene} / ${rec?.person_name}）`);

// 结算
const st = await api(`/purchase/consign-recons/${reconId}/settle`, { method: 'POST', token: TOKEN, body: { payMode: '转账' } });
ok(st.status === '已结算', '对账单结算');

// 列表状态 + 吸收后预览为空
const lst = await api('/purchase/consign-recons', { token: TOKEN });
const row = (lst.items || []).find(r => Number(r.id) === reconId);
ok(row?.status === '已结算', `对账单状态已结算（${row?.status}）`);
ok(Number(row?.payable_amount) === 42.5, `对账单应结 42.5（实际 ${row?.payable_amount}）`);
const pv2 = await api(`/purchase/consign/preview?supplierId=${supId}&from=${mStart}&to=${ymd}`, { token: TOKEN });
ok((pv2.orders || []).length === 0, '吸收后预览无待对账销售（防重复对账）');

// 作废释放 → 重建 → 现场手写补签 → 结算（验证 5.7.6 ④⑤⑥ 全链路）
const vd1 = await api(`/purchase/consign-recons/${reconId}/void`, { method: 'POST', token: TOKEN, body: { reason: '验证作废' } });
ok(vd1.code === 50018, '已结算对账单禁止作废（50018）');
// 同区间重建：先产生新销售（有待对账），同区间已有对账单 → 50018
await chk([{ id: pA, qty: 1, price: 10 }]);
const cr2 = await api('/purchase/consign-recon', { method: 'POST', token: TOKEN, body: { supplierId: supId, from: mStart, to: ymd } });
ok(cr2.code === 50018, '同区间已存在对账单禁止重建（50018）');
// 现场补签（手写 base64 直存）→ 已结算禁止重复确认
const cf2 = await api(`/purchase/consign-recons/${reconId}/confirm`, { method: 'POST', token: TOKEN, body: { confirmType: '口头确认' } });
ok(cf2.code === 50018, '已结算对账单禁止重复确认（50018）');
const sig3 = await api('/purchase/signature-records', { token: TOKEN });
ok((sig3.items || []).length >= 1, `签字记录表共 ${(sig3.items || []).length} 条`);

// 全新对账区间（单日）：生成 → 作废 → 重建 → 手写补签 → 结算
const cr3 = await api('/purchase/consign-recon', { method: 'POST', token: TOKEN, body: { supplierId: supId, from: ymd, to: ymd } });
ok(/^LC-/.test(cr3.reconNo || ''), `单日对账单 ${cr3.reconNo}（吸收新售 1 单）`);
const vd3 = await api(`/purchase/consign-recons/${cr3.id}/void`, { method: 'POST', token: TOKEN, body: { reason: '验证重建' } });
ok(vd3.status === '已作废', '对账单作废（释放小票）');
const cr4 = await api('/purchase/consign-recon', { method: 'POST', token: TOKEN, body: { supplierId: supId, from: ymd, to: ymd } });
ok(/^LC-/.test(cr4.reconNo || ''), `重建对账单 ${cr4.reconNo}（吸收释放小票）`);
const cf4 = await api(`/purchase/consign-recons/${cr4.id}/confirm`, { method: 'POST', token: TOKEN, body: { confirmType: '现场确认', confirmName: '张店长', signImage: PNG1 } });
ok(cf4.status === '已确认' && Number(cf4.signRecordId) > 0, `现场手写补签确认（签字记录 #${cf4.signRecordId}）`);
const st4 = await api(`/purchase/consign-recons/${cr4.id}/settle`, { method: 'POST', token: TOKEN, body: { payMode: '现金' } });
ok(st4.status === '已结算', '重建对账单结算');

// ════════ B. 次卡计次核销（P2-3c） ════════
console.log('\n── B. 次卡计次核销 ──');
const cpn = await api('/coupons', { method: 'POST', token: TOKEN, body: { name: '儿童乐园次卡', type: '次卡', discount: 2, validDays: 30, perMember: 1, totalQty: 10 } });
const cpnId = Number(cpn.id);
ok(cpnId > 0, `创建次卡模板 #${cpnId}（总 2 次）`);
const iss = await api(`/coupons/${cpnId}/issue`, { method: 'POST', token: TOKEN, body: { memberIds: [M1] } });
ok(Number(iss.issued) === 1, `向会员 #${M1} 发次卡 1 张`);
const mine = await api(`/coupons/member/${M1}`, { token: TOKEN });
const mc = (Array.isArray(mine) ? mine : (mine.items || [])).find(x => Number(x.coupon_id) === cpnId && x.status === '未使用');
ok(!!mc, '会员持有未使用次卡');

const useChk = async () => {
  const amount = 20;
  return api('/sales/checkout', {
    method: 'POST', token: TOKEN,
    body: { items: [{ productId: pB, qty: 1 }], memberId: M1, couponId: Number(mc.id), payments: [{ channel: '余额', amount }] },
  });
};
const u1 = await useChk();
ok(Number(u1.orderId) > 0, `次卡第 1 次核销（单 ${u1.orderId}）`);
const u2 = await useChk();
ok(Number(u2.orderId) > 0, `次卡第 2 次核销（单 ${u2.orderId}）`);
const u3 = await useChk();
ok(u3.code === 50045, `第 3 次被拒（次数已用完 ${u3.msg || u3.code}）`);

const det = await api(`/members/${M1}`, { token: TOKEN });
const mcNow = (det.coupons || []).find(x => Number(x.id) === Number(mc.id));
ok(Number(mcNow?.times_used) === 2 && mcNow.status === '未使用', `会员详情次卡已用 ${mcNow?.times_used}/2、状态 ${mcNow?.status}`);
const mine2 = await api(`/coupons/member/${M1}`, { token: TOKEN });
const mc2 = (Array.isArray(mine2) ? mine2 : (mine2.items || [])).find(x => Number(x.id) === Number(mc.id));
ok(Number(mc2?.times_used) === 2 && mc2.status === '未使用', `券列表次卡已用 ${mc2?.times_used}/2、状态 ${mc2?.status}`);

// ════════ C. 扫码购 + 离场核销码（P2-2） ════════
console.log('\n── C. 顾客扫码购 ──');
const pC = await mkP('扫码购测试商品C', mkBarcode('3'), 150);
ok(pC > 0, `创建商品 #${pC}（150 元）`);
const sc = await api('/m/self-checkout', {
  method: 'POST', token: MTOKEN,
  body: { items: [{ productId: pC, qty: 1 }] },
});
ok(Number(sc.orderId) > 0 && /^\d{6}$/.test(sc.leaveCode || ''), `扫码购下单 #${sc.orderId} 离场码 ${sc.leaveCode}`);
ok(Number(sc.payable) === 150, `扫码购余额自动付清 150（${sc.payable}）`);

const vf = await api('/sales/verify-code', { method: 'POST', token: TOKEN, body: { code: sc.leaveCode } });
ok(Number(vf.orderId) === Number(sc.orderId) && vf.needCheck === '必检', `离场核销（>100 必检，实际 ${vf.needCheck}）`);
const vf2 = await api('/sales/verify-code', { method: 'POST', token: TOKEN, body: { code: sc.leaveCode } });
ok(vf2.code === 50050, '重复核销被拒（50050）');

// 明细下钻（联营商品 supplier/biz_mode 落库）
const d1 = await api(`/sales/${s1.orderId}`, { token: TOKEN });
ok((d1.items || []).every(i => Number(i.supplier_id) === supId && i.biz_mode === '联营'), '销售明细冗余联营供应商/模式');

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`);
process.exit(fail ? 1 : 0);
