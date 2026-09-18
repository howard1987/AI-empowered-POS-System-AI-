/**
 * V4.13 六项智能能力落地 · 回归验证（真库断言）
 *   A 迁移与设置  B qa 预置  C 漏扫检测（含自助收银挂接）  D 账单对账  E AI 选品  F 语音/预测开关
 * 用法：DATABASE_URL=... node tests/verify-v413-smart.mjs   （后端须已启动在 :3100）
 * 清理：所有测试数据带 V413TEST 标记，脚本结尾自动回收。
 */
import pg from 'pg';

const BASE = process.env.API || 'http://localhost:3100';
const DB = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:54329/postgres';
let pass = 0, fail = 0; const fails = [];
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name} ${extra}`); }
};

const db = new pg.Client({ connectionString: DB });
await db.connect();

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method, headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    }, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return { code: j.code, msg: j.msg, data: j.data ?? j, http: res.status };
}

/* ═══ A. 迁移与设置 ═══ */
console.log('\n══ A. 迁移与设置开关 ═══');
{
  const s = await db.query(`SELECT count(*)::int AS n FROM system_settings WHERE group_name='智能能力'`);
  ok(s.rows[0].n >= 12, `智能能力设置项 ≥12（实际 ${s.rows[0].n}）`);
  const t = await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('payment_bills','bill_recon_runs','antileak_alerts')`);
  ok(t.rows[0].n === 3, '新表 payment_bills / bill_recon_runs / antileak_alerts 齐备');
  const e = await db.query(`SELECT unnest(enum_range(NULL::suggestion_domain_t))::text AS v`);
  ok(e.rows.some(r => r.v === '选品'), "建议域枚举含 '选品'");
  const keys = ['antileak.selfcheckout.enabled', 'antileak.weight.tolerance', 'antileak.count.strict',
    'finance.billrecon.enabled', 'finance.billrecon.window_seconds', 'ai.assortment.enabled',
    'voice.price.enabled', 'ai.forecast.engine', 'ai.forecast.lgbm.url', 'ai.forecast.lgbm.min_days'];
  const k = await db.query(`SELECT setting_key FROM system_settings WHERE setting_key = ANY($1::text[])`, [keys]);
  ok(k.rows.length >= 10, '关键开关键名齐全');
}

/* ═══ 登录 ═══ */
const lg = await api('POST', '/auth/login', { empNo: 'ADMIN', password: 'admin123' });
ok(lg.code === 0 && lg.data?.token, 'ADMIN 登录', lg.msg);
const TOKEN = lg.data?.token;

/* ═══ B. qa 预置问题 ═══ */
console.log('\n══ B. qa 预置问题 ═══');
{
  const p = await api('GET', '/brain/qa/presets', undefined, TOKEN);
  ok(p.code === 0 && p.data.items.length === 9, `预置问题 9 条（实际 ${p.data?.items?.length}）`);
  const a1 = await api('POST', '/brain/qa', { question: '今天毛利多少？' }, TOKEN);
  ok(a1.code === 0 && a1.data.answer && a1.data.route === '毛利', '预置问「今天毛利多少？」路由命中 毛利');
  const a2 = await api('POST', '/brain/qa', { question: '近7天热销排行？' }, TOKEN);
  ok(a2.code === 0 && a2.data.answer, '预置问「近7天热销排行？」有作答');
}

/* ═══ C. 漏扫检测 ═══ */
console.log('\n══ C. 漏扫检测（件数 + 重量 + 自助收银挂接） ═══');
{
  const prod = (await db.query(`SELECT id, name FROM products WHERE store_id=1 AND status=1 AND deleted_at IS NULL ORDER BY id LIMIT 3`)).rows;
  ok(prod.length >= 1, '存在可测商品');
  const pid = Number(prod[0].id), pid2 = Number(prod[1]?.id ?? prod[0].id);

  // ① 无差异
  const v0 = await api('POST', '/antileak/verify',
    { items: [{ productId: pid, qty: 2 }, { productId: pid2, qty: 1 }], aiItems: [{ productId: pid, count: 2 }, { productId: pid2, count: 1 }] }, TOKEN);
  ok(v0.code === 0 && v0.data.ok === true, '件数一致 → ok=true');

  // ② 识别 3 结算 2（严格 → 差异）
  const v1 = await api('POST', '/antileak/verify',
    { items: [{ productId: pid, qty: 2 }], aiItems: [{ productId: pid, count: 3 }] }, TOKEN);
  ok(v1.data.ok === false && v1.data.diffs?.[0]?.kind === '件数差异' && v1.data.diffs[0].delta === 1, '识别 3 vs 结算 2 → 件数差异（缺 1 拦截）');

  // ③ 宽松模式：缺 1 不拦
  await db.query(`UPDATE system_settings SET value='false'::jsonb WHERE setting_key='antileak.count.strict'`);
  const v2 = await api('POST', '/antileak/verify',
    { items: [{ productId: pid, qty: 2 }], aiItems: [{ productId: pid, count: 3 }] }, TOKEN);
  ok(v2.data.ok === true, '宽松模式缺 1 件 → 不拦截');
  await db.query(`UPDATE system_settings SET value='true'::jsonb WHERE setting_key='antileak.count.strict'`);

  // ④ 重量校验：临时把 pid 标记为称重（teardown 还原）
  const wasW = (await db.query(`SELECT is_weighted FROM products WHERE id=$1`, [pid])).rows[0]?.is_weighted;
  await db.query(`UPDATE products SET is_weighted=true WHERE id=$1`, [pid]);
  const v3 = await api('POST', '/antileak/verify',
    { items: [{ productId: pid, qty: 0.5 }], weightKg: { [String(pid)]: 0.92 } }, TOKEN);
  ok(v3.data.ok === false && v3.data.diffs?.[0]?.kind === '重量差异', '理论重 0.5kg vs 实秤 0.92kg → 重量差异');
  const v4 = await api('POST', '/antileak/verify',
    { items: [{ productId: pid, qty: 0.5 }], weightKg: { [String(pid)]: 0.51 } }, TOKEN);
  ok(v4.data.ok === true, '实秤 0.51kg（容差 0.05）→ 通过');
  if (!wasW) await db.query(`UPDATE products SET is_weighted=false WHERE id=$1`, [pid]);

  // ⑤ 自助收银挂接：识别与结算不一致 → 41001 拦截 + 告警落库（已拦截）
  let mreg = await api('POST', '/m/register', { phone: '13900004013', password: 'v413test', name: 'V413TEST漏扫', privacyAgreed: true });
  if (mreg.code !== 0) mreg = await api('POST', '/m/login', { phone: '13900004013', password: 'v413test' }); // 上轮残留 → 登录
  const mTok = mreg.data?.token;
  ok(!!mTok, '测试会员就绪（注册或登录）', mreg.msg);
  const mid = Number(mreg.data?.member?.id);
  const sc = await api('POST', '/m/self-checkout',
    { items: [{ productId: pid, qty: 2 }], aiItems: [{ productId: pid, count: 3 }] }, mTok);
  ok(sc.code === 41001 && /疑似漏扫|店员复核/.test(sc.msg || ''), `自助结算差异 → 41001 暂停（msg=${(sc.msg || '').slice(0, 30)}…）`);
  const alert1 = (await db.query(`SELECT id, status FROM antileak_alerts WHERE member_id=$1 ORDER BY id DESC LIMIT 1`, [mid])).rows[0];
  ok(alert1?.status === '已拦截', '拦截路径落 antileak_alerts（已拦截）');
  // ⑥ force=true → 强推但落「待复核」告警（无余额/无库存失败不影响告警断言）
  await api('POST', '/m/self-checkout',
    { items: [{ productId: pid, qty: 2 }], aiItems: [{ productId: pid, count: 3 }], force: true }, mTok);
  const alert2 = (await db.query(`SELECT status FROM antileak_alerts WHERE member_id=$1 ORDER BY id DESC LIMIT 1`, [mid])).rows[0];
  ok(alert2?.status === '待复核', 'force 强推路径落「待复核」告警（老板端可见）');
  // ⑦ 告警列表 + 复核处置
  const al = await api('GET', '/antileak/alerts', undefined, TOKEN);
  ok(al.code === 0 && al.data.items.length >= 2, `告警列表可见（${al.data?.items?.length} 条）`);
  const hd = await api('POST', `/antileak/alerts/${alert1.id}/handle`, { status: '已放行', note: 'V413TEST' }, TOKEN);
  ok(hd.code === 0, '复核处置（已放行）成功');
}

/* ═══ D. 支付账单导入对账 ═══ */
console.log('\n══ D. 支付账单导入对账 ═══');
{
  // 造本地微信收款（直接落库：金额 12.50，2 分钟前）
  const t0 = new Date(Date.now() - 120000);
  const orderNo = 'ZDV413-' + Date.now();
  const so = await db.query(
    `INSERT INTO sales_orders (store_id, order_no, channel, status, payable_amount, remark, created_at, updated_at)
     VALUES (1,$1,'收银台','已完成',12.50,'V413TEST',$2,$2) RETURNING id`, [orderNo, t0]);
  await db.query(
    `INSERT INTO sale_payments (order_id, channel, amount, created_at) VALUES ($1,'微信',12.50,$2)`, [so.rows[0].id, t0]);
  ok(true, `本地测试单已建（${orderNo} ¥12.50）`);

  const hm = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const extA = 'V413WX' + Date.now(), extB = 'V413WX' + (Date.now() + 1);
  const csv = [
    '微信支付账单明细,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    `${hm(new Date(Date.now() - 60000))},商户消费,测试门店,V413TEST商品,收入,¥12.50,零钱,支付成功,${extA},M1,自建`,
    `${hm(new Date(Date.now() - 30000))},商户消费,测试门店,V413TEST孤儿,收入,¥99.99,零钱,支付成功,${extB},M2,自建`,
  ].join('\n');
  const imp = await api('POST', '/finance/recon/bill/import', { channel: '微信', csv }, TOKEN);
  ok(imp.code === 0 && imp.data.importedRows === 2, `导入 2 行（跳过 0）`, imp.msg);
  ok(imp.data.matched === 1 && Number(imp.data.matched_total) === 12.5, `自动对齐命中 1 行 ¥12.50（本地单 ${orderNo}）`);
  ok(Number(imp.data.diff_rows) === 1, `差异 1 行（账单有本地无 ¥99.99）`);
  ok(Number(imp.data.localTotal) >= 12.5, `本地同期渠道收款合计 ¥${imp.data.localTotal} ≥ 12.50`);

  const runs = await api('GET', '/finance/recon/runs', undefined, TOKEN);
  ok(runs.code === 0 && runs.data.items.length >= 1, '对账批次列表可见');
  const det = await api('GET', `/finance/recon/runs/${imp.data.runId}`, undefined, TOKEN);
  ok(det.code === 0 && det.data.bills.length === 2, '批次详情含 2 行账单');

  // 防重复导入
  const dup = await api('POST', '/finance/recon/bill/import', { channel: '微信', csv }, TOKEN);
  ok(dup.code === 40003, '重复导入相同交易单号 → 拒绝', dup.msg);

  // 差异行忽略
  const diffRow = det.data.bills.find(b => b.match_status === '金额差异');
  const ig = await api('POST', `/finance/recon/bills/${diffRow.id}/ignore`, {}, TOKEN);
  ok(ig.code === 0, '差异行人工忽略成功');
}

/* ═══ E. AI 选品建议 ═══ */
console.log('\n══ E. AI 选品建议 ═══');
{
  const r = await api('POST', '/brain/run/assortment', {}, TOKEN);
  ok(r.code === 0 && Number.isInteger(r.data.eliminated) && Number.isInteger(r.data.expand),
    `选品引擎运行：淘汰 ${r.data?.eliminated} 个 · 扩容 ${r.data?.expand} 类`, r.msg);
  const s = await api('GET', '/brain/suggestions?domain=' + encodeURIComponent('选品'), undefined, TOKEN);
  ok(s.code === 0, '选品建议域可查询（空列表亦为合法：零动销样本未达阈值）');
}

/* ═══ F. 语音查价 / 预测引擎开关 ═══ */
console.log('\n══ F. 语音查价 / 预测引擎开关（功能常备、默认关） ═══');
{
  const v1 = await api('GET', '/settings/key/voice.price.enabled', undefined, TOKEN);
  ok(v1.code === 0 && (v1.data.value === false || v1.data.value === 'false'), 'voice.price.enabled 默认关');
  const v2 = await api('PUT', '/settings/voice.price.enabled', { value: true, reason: 'V413TEST' }, TOKEN);
  const v3 = await api('GET', '/settings/key/voice.price.enabled', undefined, TOKEN);
  ok(v2.code === 0 && v3.data.value === true, '开关可切换（老板端设置页同口径）');
  await api('PUT', '/settings/voice.price.enabled', { value: false, reason: 'V413TEST 恢复' }, TOKEN);

  const f1 = await api('GET', '/settings/key/ai.forecast.engine', undefined, TOKEN);
  ok(f1.data.value === 'baseline', `预测引擎默认 baseline（实际 ${f1.data.value}）`);
  const f2 = await api('POST', '/brain/run/forecast', {}, TOKEN);
  ok(f2.code === 0 && 'products' in (f2.data || {}), 'baseline 引擎运行正常（products/snapshots 字段齐备）');
  // lgbm 模式：本地服务未部署 → 自动回落，不抛错
  await api('PUT', '/settings/ai.forecast.engine', { value: 'lgbm', reason: 'V413TEST' }, TOKEN);
  const f3 = await api('POST', '/brain/run/forecast', {}, TOKEN);
  ok(f3.code === 0 && 'products' in (f3.data || {}), 'lgbm 服务不可达 → 自动回落 baseline，预测链路不断');
  await api('PUT', '/settings/ai.forecast.engine', { value: 'baseline', reason: 'V413TEST 恢复' }, TOKEN);
}

/* ═══ Teardown：回收 V413TEST 数据 ═══ */
console.log('\n══ Teardown（回收测试数据） ═══');
{
  await db.query(`DELETE FROM payment_bills WHERE batch_no LIKE 'ZD-WX-%' AND raw::text LIKE '%V413TEST%'`);
  await db.query(`DELETE FROM bill_recon_runs WHERE summary::text LIKE '%V413TEST%' OR (created_at > now() - interval '10 minutes' AND channel='微信')`);
  await db.query(`DELETE FROM sale_payments WHERE order_id IN (SELECT id FROM sales_orders WHERE remark='V413TEST')`);
  await db.query(`DELETE FROM sales_orders WHERE remark='V413TEST'`);
  await db.query(`DELETE FROM antileak_alerts WHERE member_id IN (SELECT id FROM members WHERE name='V413TEST漏扫')`);
  await db.query(`DELETE FROM members WHERE name='V413TEST漏扫'`);
  await db.query(`DELETE FROM ai_suggestions WHERE reason::text LIKE '%V413TEST%'`);
  console.log('  🧹 测试单据/账单/会员/告警已回收');
}

await db.end();
console.log(`\n════════ V4.13 回归：${pass} 通过 / ${fail} 失败 ════════`);
if (fails.length) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
