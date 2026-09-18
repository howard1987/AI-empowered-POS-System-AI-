/**
 * 智能决策中心（AI 赋能）端到端验证：
 *   node tests/e2e-aibrain.mjs
 * 依赖：后端已启动（http://localhost:3100）、021_aibrain.sql 已应用
 * 覆盖：9 项智能应用 + 建议闭环（执行→采购单 / 否决留痕）+ AI 日报 + 知识库 + Ollama 预留接口
 * 全部通过退出码 0；任一失败打印 FAIL 并退出 1
 */
import { Client } from 'pg';

const BASE = 'http://localhost:3100';
const DB = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:54329/postgres';
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

console.log('══ 智能决策中心 E2E 验证 ══');
const ts = String(Date.now()).slice(-8);
const phone = '137' + ts;
const mkBarcode = (n) => '68' + ts + n;
const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── 登录 ──
const lg = await api('/auth/login', { method: 'POST', body: { empNo: 'ADMIN', password: 'admin123' } });
const TOKEN = lg.token;
ok(!!TOKEN, '管理员登录');

// ════════ 造数：供应商 / 商品 / 批次 / 库存 / 会员 / 历史销售 ════════
console.log('\n── 测试数据准备 ──');
const sup = await api('/purchase/suppliers', {
  method: 'POST', token: TOKEN,
  body: { name: `AI测试供应商${ts}`, pinyinCode: `AI${ts}`, contactPerson: '王采购', contactPhone: '13900002222', bizMode: '经销', guaranteeMin: 0, settlePeriod: '月结' },
});
const supId = Number(sup.id);
ok(supId > 0, `创建供应商 #${supId}`);

const mkP = async (name, barcode, price) => {
  const r = await api('/products', {
    method: 'POST', token: TOKEN,
    body: { name, barcode, baseUnit: '件', sellPrice: price, trackInventory: true, keepDays: 30, supplierDefaultId: supId, status: 1 },
  });
  return Number(r.id);
};
const pA = await mkP('AI测试商品A', mkBarcode('1'), 10);
const pB = await mkP('AI测试商品B', mkBarcode('2'), 20);
const pC = await mkP('AI测试商品C', mkBarcode('3'), 50);
ok(pA > 0 && pB > 0 && pC > 0, `创建商品 #${pA} / #${pB} / #${pC}`);

// 批次（A 临期 7 天触发防损；B/C 远效期）+ 即时库存
const dbc = new Client({ connectionString: DB });
await dbc.connect();
const ago = (d) => { const x = new Date(); x.setDate(x.getDate() - d); return todayStr(x); };
const mkBatch = async (pid, tag, expiryDays) => {
  await dbc.query(
    `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date, expiry_date, inbound_cost, inbound_qty, remain_qty, status)
     VALUES (1,$1,$2,$3,$4,$4,$5,$6,20,10,'在库')`,
    [pid, supId, `RK-${ts}-${tag}`, ago(30), todayStr(new Date(Date.now() + expiryDays * 86400000)), 0.7 * (pid === pA ? 10 : pid === pB ? 20 : 50)]);
  await dbc.query(
    `INSERT INTO inventory_current (store_id, product_id, qty_total) VALUES (1,$1,10)
     ON CONFLICT (store_id, product_id) DO UPDATE SET qty_total=10`, [pid]);
};
await mkBatch(pA, 'A', 7);
await mkBatch(pB, 'B', 180);
await mkBatch(pC, 'C', 180);
ok(true, `批次与库存：A 临期 7 天，B/C 远效期`);

// 会员 + 储值（沉默唤醒：last_active_date 为空 + 余额 500）
const reg = await api('/m/register', { method: 'POST', body: { phone, password: 'test123456', name: 'AI测试会员', privacyAgreed: true } });
const M1 = Number(reg.member?.id);
ok(M1 > 0, `注册会员 #${M1}`);
const rc = await api(`/members/${M1}/recharges`, { method: 'POST', token: TOKEN, body: { principal: 500 } });
ok(Number(rc.balanceAfter) === 500, `会员储值 500（余额 ${rc.balanceAfter}）`);

// 历史销售：近 12 天每天 2 单（A + B/C 交替），供预测/关联/补货学习
let orderSeq = 0;
for (let d = 12; d >= 1; d--) {
  for (let h = 0; h < 2; h++) {
    const withB = (d + h) % 2 === 0;
    const items = [{ pid: pA, qty: 2, price: 10 }, { pid: withB ? pB : pC, qty: 1, price: withB ? 20 : 50 }];
    const goods = items.reduce((a, i) => a + i.qty * i.price, 0);
    const cost = items.reduce((a, i) => a + i.qty * i.price * 0.7, 0);
    const no = `SO-${ts}-${String(++orderSeq).padStart(3, '0')}`;
    await dbc.query(
      `INSERT INTO sales_orders (store_id, order_no, channel, cashier_id, status, goods_amount, payable_amount, cost_amount, profit_amount, created_at)
       VALUES (1,$1,'收银台',1,'已完成',$2,$2,$3,$4, now() - ($5 || ' days 10:00')::interval) RETURNING id`,
      [no, goods, cost, goods - cost, d]);
    const oid = (await dbc.query(`SELECT id FROM sales_orders WHERE order_no=$1`, [no])).rows[0].id;
    for (const it of items) {
      await dbc.query(
        `INSERT INTO sale_items (order_id, product_id, unit_name, qty, unit_price, origin_price, line_amount)
         VALUES ($1,$2,'基本',$3,$4,$4,$5)`, [oid, it.pid, it.qty, it.price, it.qty * it.price]);
    }
  }
}
ok(true, `历史销售：12 天 × 2 单（共 24 单，A 与 B/C 共现）`);
await dbc.end();

// ════════ A. 全量刷新（8 项应用一次闭环） ════════
console.log('\n── A. 全量刷新 ──');
// 前置清理：当日遗留的待处理建议先否决（避免 hasPending 当日去重拦截本次刷新），保证脚本可重复执行
const legacy = await api('/brain/suggestions?status=待处理', { token: TOKEN });
for (const s of (legacy.items || [])) {
  await api(`/brain/suggestions/${Number(s.id)}/reject`, { method: 'POST', token: TOKEN, body: { reason: 'e2e 测试清理' } });
}
const ref = await api('/brain/refresh', { method: 'POST', token: TOKEN });
const stepOk = ['restock', 'memberTouch', 'forecast', 'pricing', 'expiryLoss', 'assocRules', 'fraudBaseline', 'effectRecovery']
  .every(k => ref[k] != null && !ref[k].error);
ok(stepOk, 'refresh 8 步全部成功', JSON.stringify(ref));
ok(Number(ref.restock?.count) > 0, `智能补货建议 ${ref.restock?.count} 条（安全库存法）`);
ok(Number(ref.memberTouch?.count) > 0, `会员推送建议 ${ref.memberTouch?.count} 人（沉默唤醒）`);
ok(Number(ref.forecast?.products) > 0, `销量预测 ${ref.forecast?.products} 个商品 / ${ref.forecast?.snapshots} 个快照`);
ok(Number(ref.expiryLoss?.count) > 0, `临期预警 ${ref.expiryLoss?.count} 批（≤15 天）`);
ok(Number(ref.assocRules?.ruleCount) > 0, `购物篮关联规则 ${ref.assocRules?.ruleCount} 条（置信度≥阈值）`);

// ════════ B. 学习资产看板 ════════
console.log('\n── B. 学习资产看板 ──');
const ov = await api('/brain/overview', { token: TOKEN });
ok(Array.isArray(ov.suggestions) && ov.suggestions.length > 0, `建议闭环统计 ${ov.suggestions.length} 域`);
ok(Array.isArray(ov.forecasts?.byCategory) && ov.forecasts.byCategory.length > 0, `未来 7 天预测按类目 ${ov.forecasts.byCategory.length} 类`);
ok(Number(ov.assocRules) > 0, `关联规则资产 ${ov.assocRules} 条`);
ok(ov.acceptRate === null || Number(ov.acceptRate) >= 0, `采纳率字段 ${ov.acceptRate}`);

// ════════ C. 建议闭环：执行补货 → 生成采购单；否决推送 → 留痕 ════════
console.log('\n── C. 建议闭环 ──');
let pending = await api('/brain/suggestions?domain=补货&status=待处理', { token: TOKEN });
let items = pending.items || [];
if (!items.length) { await api('/brain/run/restock', { method: 'POST', token: TOKEN }); pending = await api('/brain/suggestions?domain=补货&status=待处理', { token: TOKEN }); items = pending.items || []; }
if (items.length) {
  const sid = Number(items[0].id);
  const ex = await api(`/brain/suggestions/${sid}/execute`, { method: 'POST', token: TOKEN });
  ok(ex.ok === true && /采购单 CG-/.test(ex.note || ''), `执行补货建议 #${sid} → ${ex.note || ''}`);
  const poRows = await (await fetch(BASE + '/purchase/orders?keyword=' + (ex.note || '').match(/CG-\S+/)?.[0], { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const poList = poRows.code === 0 ? poRows.data.items || poRows.data : poRows;
  ok((Array.isArray(poList) ? poList : []).some(o => o.source === '补货建议'), `采购单已生成且 source=补货建议`);
  const again = await api(`/brain/suggestions/${sid}/execute`, { method: 'POST', token: TOKEN });
  ok(again.code === 40003, `重复执行被拦截（建议已${items[0].status}）`);
} else {
  ok(false, '无待处理补货建议可执行（库存充足）');
}

let pend2 = await api('/brain/suggestions?domain=营销推送&status=待处理', { token: TOKEN });
let items2 = pend2.items || [];
if (!items2.length) { await api('/brain/run/memberTouch', { method: 'POST', token: TOKEN }); pend2 = await api('/brain/suggestions?domain=营销推送&status=待处理', { token: TOKEN }); items2 = pend2.items || []; }
if (items2.length) {
  const rj = await api(`/brain/suggestions/${Number(items2[0].id)}/reject`, { method: 'POST', token: TOKEN, body: { reason: '本期不发券（测试否决）' } });
  ok(rj.ok === true, `否决营销推送建议 #${items2[0].id}（原因留痕）`);
  const rj2 = await api(`/brain/suggestions/${Number(items2[0].id)}/reject`, { method: 'POST', token: TOKEN, body: { reason: 'x' } });
  ok(rj2.code === 40003, `重复否决被拦截`);
} else {
  ok(false, '无待处理营销推送建议可否决');
}

// ════════ D. 自然语言问答 ════════
console.log('\n── D. 自然语言问答 ──');
const q1 = await api('/brain/qa', { method: 'POST', token: TOKEN, body: { question: '今天销售如何' } });
ok(/销售额/.test(q1.answer || ''), `问答「今天销售如何」→ ${(q1.answer || '').slice(0, 40)}…`);
const q2 = await api('/brain/qa', { method: 'POST', token: TOKEN, body: { question: '毛利多少' } });
ok(/毛利/.test(q2.answer || ''), `问答「毛利多少」→ ${(q2.answer || '').slice(0, 40)}…`);
const q3 = await api('/brain/qa', { method: 'POST', token: TOKEN, body: { question: '哪些商品缺货' } });
ok(/低库存/.test(q3.answer || ''), `问答「哪些商品缺货」→ ${(q3.answer || '').slice(0, 40)}…`);

// ════════ E. AI 日报（幂等 + 知识库归档 + 问答命中） ════════
console.log('\n── E. AI 日报 ──');
const dr1 = await api('/brain/daily-report', { method: 'POST', token: TOKEN });
ok(dr1.created === true ? /AI 日报/.test(dr1.text || '') : dr1.created === false,
  `今日日报：${dr1.created ? '已生成（含 ' + (dr1.text || '').split('\n').length + ' 行）' : '当日已存在（幂等跳过）'}`);
const dr2 = await api('/brain/daily-report', { method: 'POST', token: TOKEN });
ok(dr2.created === false, `日报幂等：重复生成被跳过`);
const q4 = await api('/brain/qa', { method: 'POST', token: TOKEN, body: { question: '今天怎么样' } });
ok(/AI 日报/.test(q4.answer || ''), `问答命中今日日报 → ${(q4.answer || '').slice(0, 40)}…`);

// ════════ F. 知识库管理 ════════
console.log('\n── F. 知识库 ──');
const kb1 = await api('/brain/kb', { token: TOKEN });
const kbList = kb1.items || kb1;
ok(Array.isArray(kbList) && kbList.some(d => /AI日报/.test(d.title || '')), `知识库含日报文档（共 ${(Array.isArray(kbList) ? kbList : []).length} 篇）`);
const add = await api('/brain/kb', { method: 'POST', token: TOKEN, body: { title: `门店操作手册${ts}`, content: '营业前检查：1. 收银机开机自检；2. 生鲜区补货陈列；3. 临期商品排查。收银规范：扫码必须确认条码数量，散称商品先称重后收银。' } });
ok(Number(add.id) > 0, `知识库入库 #${add.id}`);
const del = await api(`/brain/kb/${Number(add.id)}`, { method: 'DELETE', token: TOKEN });
ok(del.ok === true, `知识库删除 #${add.id}`);

// ════════ G. 单应用运行 + Ollama 预留 ════════
console.log('\n── G. 单应用 / Ollama ──');
const fc = await api('/brain/run/forecast', { method: 'POST', token: TOKEN });
ok(Number(fc.products) >= 1, `单跑 forecast：${fc.products} 商品 / 回填 MAE ${fc.maeBackfilled} 条`);
// 防损域当日已有待处理建议时 hasPending 拦截，先否决再单跑
const pendLoss = await api('/brain/suggestions?domain=防损&status=待处理', { token: TOKEN });
for (const s of (pendLoss.items || [])) {
  await api(`/brain/suggestions/${Number(s.id)}/reject`, { method: 'POST', token: TOKEN, body: { reason: 'e2e 单跑前清理' } });
}
const ex2 = await api('/brain/run/expiryLoss', { method: 'POST', token: TOKEN });
ok(Number(ex2.count) >= 1, `单跑 expiryLoss：${ex2.count} 批临期`);
const llm = await api('/brain/llm/check', { token: TOKEN });
ok(llm.enabled === false && typeof llm.reachable === 'boolean', `Ollama 预留接口（默认关：${llm.enabled ? '开' : '关'}）`);

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`);
process.exit(fail ? 1 : 0);
