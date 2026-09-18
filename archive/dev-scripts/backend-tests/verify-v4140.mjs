/**
 * V4.14.0 批量整改回归（可重跑）：
 *   A  费用协议一次性/周期性+期数   S  扫码购开关/流水/渠道过滤   L  防损下钻三端点
 *   C  大客户预充值/电子签字/预存余额下单   M  会员重置密码/H5密保找回/设置项
 *   P  促销关键字查询   ST  留痕过滤
 * 运行：node tests/verify-v4140.mjs
 */
import pg from 'pg';

const BASE = 'http://localhost:3100';
const DB = 'postgres://postgres:password@localhost:54329/postgres';
const phone = '13941400000' + '';           // 测试会员手机号（可重跑前清理）
let token = '';
let passN = 0, failN = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passN++; console.log(`  ✅ ${name}`); }
  else { failN++; console.log(`  ❌ ${name} ${extra}`); }
};

async function api(method, path, body, useToken = true) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(useToken && token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return j;
}

// ── 0. 登录 + 清理残留 ──
const login = await api('POST', '/auth/login', { empNo: 'ADMIN', password: 'admin123' }, false);
token = login?.data?.token || '';
ok('① 登录', !!token);

const db = new pg.Pool({ connectionString: DB });
await db.query(`DELETE FROM members WHERE phone=$1`, [phone]);
await db.query(`DELETE FROM big_customer_payments WHERE customer_id IN (SELECT id FROM big_customers WHERE name LIKE 'V4140测试%')`);
await db.query(`DELETE FROM sales_orders WHERE big_customer_id IN (SELECT id FROM big_customers WHERE name LIKE 'V4140测试%') AND store_id=1`);
await db.query(`DELETE FROM big_customers WHERE name LIKE 'V4140测试%'`);
await db.query(`DELETE FROM batches WHERE batch_no='B4140'`);
await db.query(`DELETE FROM products WHERE goods_no='T4140G'`);
await db.query(`DELETE FROM supplier_fee_agreements WHERE start_date='2026-09-01' AND amount=88.8`);

// ── 1. A 费用协议：一次性/周期性+期数 ──
const sup = await api('GET', '/purchase/suppliers?size=1');
const sid = Number(sup?.data?.items?.[0]?.id ?? sup?.data?.[0]?.id ?? sup?.items?.[0]?.id);
const ft = await api('GET', '/purchase/fee-types');
const tid = Number((ft?.data?.items ?? ft?.data ?? ft?.items ?? [])[0]?.id);
if (sid && tid) {
  const once = await api('POST', '/purchase/fee-agreements', {
    supplierId: sid, feeTypeId: tid, amountMode: '固定额', amount: 88.8,
    startDate: '2026-09-01', feeNature: '一次性',
  });
  const onceD = once?.data ?? once;
  ok('②a 一次性协议创建（自动置 1 期）', onceD?.fee_nature === '一次性' && Number(onceD?.total_periods) === 1, JSON.stringify(once).slice(0, 160));
  const cyc = await api('POST', '/purchase/fee-agreements', {
    supplierId: sid, feeTypeId: tid, amountMode: '固定额', amount: 200,
    startDate: '2026-09-01', feeNature: '周期性', totalPeriods: 2,
  });
  const cycD = cyc?.data ?? cyc;
  ok('②b 周期性协议限 2 期', cycD?.fee_nature === '周期性' && Number(cycD?.total_periods) === 2, JSON.stringify(cyc).slice(0, 160));
  const bad = await api('POST', '/purchase/fee-agreements', {
    supplierId: sid, feeTypeId: tid, amountMode: '固定额', amount: 1,
    startDate: '2026-09-01', feeNature: '周期性', totalPeriods: 999,
  });
  ok('②c 期数超 120 拦截', bad?.code === 40003, JSON.stringify(bad).slice(0, 80));
} else { ok('② 费用协议前置数据（供应商/费用类型）', false, '缺供应商或费用类型'); }

// ── 2. S 扫码购开关 + 流水 + 渠道过滤 ──
const sp = await api('GET', '/settings/key/sales.scanpay_enabled');
ok('③a 扫码购开关设置存在', !!sp?.data || !!sp?.key, JSON.stringify(sp).slice(0, 80));
const sAll = await api('GET', '/sales?size=5');
const sScan = await api('GET', '/sales?size=5&channel=' + encodeURIComponent('扫码购'));
ok('③b /sales 支持 channel 过滤并返回 total', Array.isArray(sAll?.data?.items) && typeof (sScan?.data?.total ?? sScan?.data?.items?.length) === 'number',
  JSON.stringify(sScan).slice(0, 100));

// ── 3. L 防损下钻 ──
const d1 = await api('GET', '/ai/fraud/disc-orders?days=7');
const d2 = await api('GET', '/ai/fraud/refund-orders?days=30');
const d3 = await api('GET', '/ai/fraud/return-orders?days=30');
ok('④a disc-orders', d1?.code === 0 && Array.isArray(d1?.data?.items), JSON.stringify(d1).slice(0, 80));
ok('④b refund-orders', d2?.code === 0 && Array.isArray(d2?.data?.items), JSON.stringify(d2).slice(0, 80));
ok('④c return-orders', d3?.code === 0 && Array.isArray(d3?.data?.items), JSON.stringify(d3).slice(0, 80));

// ── 4. C 大客户：预充值/签字/预存余额下单 ──
const bc = await api('POST', '/big-customers', { name: 'V4140测试客户', contact: '测试联系人', creditLimit: 0, defaultDiscount: 1 });
const bcId = bc?.data?.id ?? bc?.id;
ok('⑤a 大客户建档', !!bcId, JSON.stringify(bc).slice(0, 80));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sig = await api('POST', `/big-customers/${bcId}/signature`, { signature: png });
ok('⑤b 电子签字保存', !!sig?.data?.signaturePath, JSON.stringify(sig).slice(0, 80));
const rc = await api('POST', `/big-customers/${bcId}/recharge`, { amount: 100, method: '现金' });
ok('⑤c 预充值 100 → 余额 100', Number(rc?.data?.balance) === 100, JSON.stringify(rc).slice(0, 80));

// 造测试商品+批次（库存 10，成本 3.5）
const prod = (await db.query(
  `INSERT INTO products (store_id, goods_no, name, barcode, sell_price, base_unit, track_inventory, supplier_default_id, created_at)
   VALUES (1,'T4140G','V4140测试商品','T4140BC',10,'件',true,$1,now()) RETURNING id`, [sid])).rows[0];
await db.query(
  `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date, expiry_date, inbound_cost, inbound_qty, remain_qty, status)
   VALUES (1,$1,$2,'B4140',CURRENT_DATE,CURRENT_DATE,CURRENT_DATE+365,3.5,100,100,'在库')`, [prod.id, sid]);
const order1 = await api('POST', `/big-customers/${bcId}/order`, { items: [{ productId: prod.id, qty: 2 }], payChannel: '预存余额' });
const payable1 = Number(order1?.data?.payable ?? 0);
ok('⑤d 预存余额下单成功（应付=2×10）', order1?.code === 0 && payable1 === 20, JSON.stringify(order1).slice(0, 120));
const list1 = await api('GET', '/big-customers?keyword=V4140');
const bc1 = (list1?.data ?? list1 ?? []).find(x => Number(x.id) === Number(bcId));
ok('⑤e 下单后余额扣减（100-20=80）', bc1 && Number(bc1.balance) === 80, `balance=${bc1?.balance}`);
ok('⑤f 档案含签字路径', !!bc1?.signature_path, `path=${bc1?.signature_path}`);
const order2 = await api('POST', `/big-customers/${bcId}/order`, { items: [{ productId: prod.id, qty: 9 }], payChannel: '预存余额' });
ok('⑤g 余额不足拦截（80 < 90）', order2?.code === 50035, JSON.stringify(order2).slice(0, 100));

// ── 5. M 会员：H5 密保注册+忘记密码找回；后台重置密码 ──
const reg = await api('POST', '/m/register', {
  phone, password: 'abc12345', name: 'V4140会员', privacyAgreed: true, birthday: '1990-01-02',
  securityQuestions: [
    { question: '您的母亲姓氏', answer: '王' },
    { question: '您的小学名称', answer: '实验小学' },
  ],
}, false);
ok('⑥a H5 注册（生日+密保）', reg?.code === 0 && reg?.data?.member?.cardNo, JSON.stringify(reg).slice(0, 100));
const fq = await api('GET', `/m/password/forgot/questions?phone=${phone}`, null, false);
ok('⑥b 忘记密码取密保问题（2 问）', fq?.code === 0 && fq?.data?.questions?.length === 2, JSON.stringify(fq).slice(0, 100));
const bad1 = await api('POST', '/m/password/forgot', {
  phone, newPassword: 'newpass77',
  answers: [{ question: '您的母亲姓氏', answer: '李' }, { question: '您的小学名称', answer: '实验小学' }],
}, false);
ok('⑥c 密保答案错误拦截', bad1?.code === 42010, JSON.stringify(bad1).slice(0, 90));
const good1 = await api('POST', '/m/password/forgot', {
  phone, newPassword: 'newpass77',
  answers: [{ question: '您的母亲姓氏', answer: '王' }, { question: '您的小学名称', answer: '实验小学' }],
}, false);
ok('⑥d 密保答案正确重置成功', good1?.code === 0, JSON.stringify(good1).slice(0, 90));
const relogin = await api('POST', '/m/login', { phone, password: 'newpass77' }, false);
ok('⑥e 新密码可登录', relogin?.code === 0, JSON.stringify(relogin).slice(0, 80));

const memRow = (await db.query(`SELECT id FROM members WHERE phone=$1`, [phone])).rows[0];
const rp = await api('POST', `/members/${memRow?.id}/reset-password`);
ok('⑥f 后台重置会员密码返回临时密码', /^\w{8,12}$/.test(rp?.data?.tempPassword || ''), JSON.stringify(rp).slice(0, 80));

const pv = await api('GET', '/settings/key/member.privacy_text');
const lpm = await api('GET', '/settings/key/member.level_price_mode');
ok('⑥g 隐私协议文本/等级价格模式设置存在', (!!pv?.data || !!pv?.key) && (!!lpm?.data || !!lpm?.key), JSON.stringify(pv).slice(0, 60));

// ── 6. P 促销关键字查询 / ST 留痕过滤 ──
const pk = await api('GET', '/promotions?keyword=' + encodeURIComponent('不存在KeyWordXYZ'));
ok('⑦a 促销关键字查询（空结果）', pk?.code === 0 && Array.isArray(pk?.data?.items) && pk.data.items.length === 0, JSON.stringify(pk).slice(0, 80));
const cg = await api('GET', '/settings/changes?page=1&pageSize=10&from=2026-09-01&to=2026-09-30&operator=ADMIN');
ok('⑦b 留痕日期+操作人过滤', cg?.code === 0 && Array.isArray(cg?.data?.rows), JSON.stringify(cg).slice(0, 80));

// ── 清理 ──
await db.query(`DELETE FROM members WHERE phone=$1`, [phone]);
await db.query(`DELETE FROM big_customer_payments WHERE customer_id IN (SELECT id FROM big_customers WHERE name LIKE 'V4140测试%')`);
await db.query(`DELETE FROM sale_item_batches WHERE batch_id IN (SELECT id FROM batches WHERE batch_no='B4140')`);
await db.query(`DELETE FROM stock_flows WHERE batch_id IN (SELECT id FROM batches WHERE batch_no='B4140')`);
await db.query(`DELETE FROM sales_orders WHERE big_customer_id IN (SELECT id FROM big_customers WHERE name LIKE 'V4140测试%') AND store_id=1`);
await db.query(`DELETE FROM big_customers WHERE name LIKE 'V4140测试%'`);
await db.query(`DELETE FROM batches WHERE batch_no='B4140'`);
await db.query(`DELETE FROM products WHERE goods_no='T4140G'`);
await db.query(`DELETE FROM supplier_fee_agreements WHERE start_date='2026-09-01' AND amount IN (88.8, 200)`);
await db.end();

console.log(`\n═══ V4.14.0 回归：${passN} 通过 / ${failN} 失败 ═══`);
process.exit(failN ? 1 : 0);
