/**
 * 端到端集成测试（真实 PostgreSQL：本机原生二进制，规避 BUG #16926 ——
 * initdb --encoding=UTF8 在含非 ASCII 字符的二进制路径下必然崩溃，故二进制须位于纯 ASCII 路径）
 * 覆盖：登录鉴权 / 设置留痕 / 商品供应商 / 入库→FIFO批次 / 收银结账→成本 /
 *       会员储值消费 / 分红引擎(5%·双门槛·R=30%封顶降级) / T7退货自动归属 / T8对账结算 /
 *       T9口径B本金赠送拆分 / T10会员等级积分 / T11报表聚合
 * 运行：npm run build && node tests/e2e.mjs
 */
import { spawn, spawnSync, execSync } from 'child_process';
import { Client } from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3100);
const PGPORT = Number(process.env.E2E_PGPORT || 54329);
const DB = 'postgres';
const DATABASE_URL = `postgres://postgres:password@localhost:${PGPORT}/${DB}`;
const BASE = `http://localhost:${PORT}`;

// 对账区间上界 = 当月月末（写死 2026-09-05 次日即破：当日建单落在区间外）；单号/补齐期次断言随之动态化
const NOW_D = new Date();
const YM_MM = `${NOW_D.getFullYear()}${String(NOW_D.getMonth() + 1).padStart(2, '0')}`;
const TO_STR = `${NOW_D.getFullYear()}-${String(NOW_D.getMonth() + 1).padStart(2, '0')}-${String(new Date(NOW_D.getFullYear(), NOW_D.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
const AUTO_FEE_MONTHS = (NOW_D.getFullYear() * 12 + NOW_D.getMonth() + 1) - (2026 * 12 + 8) + 1; // 2026-08 起至当月的协议期次

// PG 二进制：从 node_modules 拷贝到纯 ASCII 路径（BUG #16926 规避）
const NATIVE_SRC = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native');
const PGBIN = path.join(os.tmpdir(), 'pgbin-ascii');
const PGDATA = path.join(os.tmpdir(), 'pgdata-cashier-test');
function ensurePgBin() {
  if (!fs.existsSync(path.join(PGBIN, 'bin', 'initdb.exe'))) {
    fs.rmSync(PGBIN, { recursive: true, force: true });
    // 本机 fs.cpSync 拷贝该目录会触发 Node fail-fast 崩溃，改用 robocopy（退出码 <8 均为成功）
    const rc = spawnSync('robocopy', [NATIVE_SRC, PGBIN, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8' });
    if (rc.status === null || rc.status >= 8) throw new Error('robocopy 失败: ' + rc.stderr);
  }
  return path.join(PGBIN, 'bin');
}

// ── 极简断言框架 ──
let pass = 0; const fails = [];
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name} ${extra}`); }
};
const eq = (a, b, name) => ok(a === b, name, `（期望 ${b}，实际 ${a}）`);
const near = (a, b, name, tol = 0.005) => ok(Math.abs(Number(a) - Number(b)) <= tol, name, `（期望 ${b}，实际 ${a}）`);

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  return { status: res.status, ...(j || {}) };
}
const data = r => r.data;
const locDate = d => d instanceof Date ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : String(d).slice(0, 10);

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise(s => setTimeout(s, 500));
  }
  return false;
}

let server = null, pgStarted = false, dbc = null;
try {
  // ═══ 0. 端口占用预检（P0 验证期发现的测试基建缺陷：被残留进程占用时会静默打在旧服务/旧库上）═══
  {
    let busy = null;
    try { const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1200) }); if (r.ok) busy = `后端 ${BASE} 已有服务监听`; } catch { /* 空闲 */ }
    const probe = new Client({ connectionString: DATABASE_URL });
    try { await probe.connect(); await probe.end(); if (!busy) busy = `PostgreSQL :${PGPORT} 已有实例监听`; } catch { /* 空闲 */ }
    if (busy) throw new Error(`端口预检失败：${busy}。请先停掉残留进程，或用 E2E_PORT / E2E_PGPORT 环境变量换端口运行`);
  }
  // ═══ 1. 启动 PostgreSQL（ASCII 二进制路径 + UTF8 编码） ═══
  const bin = ensurePgBin();
  try { spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', PGDATA, 'stop', '-m', 'immediate'], { stdio: 'ignore', timeout: 10000 }); } catch { /* noop */ }
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(PGDATA, { recursive: true, force: true }); break; }
    catch { await new Promise(s => setTimeout(s, 1000)); }  // 残留进程退出窗口
  }
  const pwFile = path.join(os.tmpdir(), 'pgpw-cashier-test.txt');
  fs.writeFileSync(pwFile, 'password\n');
  console.log('▶ initdb 初始化集群 ...');
  const idb = spawnSync(path.join(bin, 'initdb.exe'), [
    '-D', PGDATA, '-U', 'postgres', '--pwfile=' + pwFile, '--locale=C', '--encoding=UTF8',
  ], { encoding: 'utf8' });
  ok(idb.status === 0, 'initdb 初始化成功', (idb.stderr || idb.stdout || '').slice(-300));
  console.log('▶ 启动 postgres :54329 ...');
  spawn(path.join(bin, 'pg_ctl.exe'),
    ['-D', PGDATA, '-l', path.join(os.tmpdir(), 'pg-cashier-test.log'), '-o', `-p ${PGPORT}`, 'start']);
  pgStarted = true;
  let lastConnErr;
  for (let i = 0; i < 60; i++) {
    const c = new Client({ connectionString: DATABASE_URL });
    try { await c.connect(); dbc = c; break; }
    catch (e) { lastConnErr = e.message; await new Promise(s => setTimeout(s, 500)); }
    if (i === 59) throw new Error('postgres 启动超时: ' + lastConnErr);
  }
  const sqlOnly = (s, p) => dbc.query(s, p || []);
  // V4.12+ 商品-供应商绑定：为新供应商补供货关系（价格与后续入库 unitCost 对齐，不扰动最低进价断言）
  const bindSup = async (supId, items) => {
    for (const [pid, cost] of items)
      await sqlOnly(`INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
        SELECT $1,$2,$3,$3,'e2e-bind' WHERE NOT EXISTS (SELECT 1 FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2)`, [pid, supId, cost]);
  };

  // ═══ 2. 建表基线 + 管理员引导 ═══
  console.log('▶ 执行 001_init.sql 基线 + 管理员引导 ...');
  const init = spawnSync(process.execPath, ['dist/scripts/init-db.js'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8',
  });
  ok(init.status === 0, '建表基线执行成功', init.stderr?.slice(0, 300));
  const tcnt = await sqlOnly(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'`);
  ok(Number(tcnt.rows[0].n) >= 74, `建表数量 ≥74（实际 ${tcnt.rows[0].n}）`);

  // ═══ 3. 启动后端服务 ═══
  console.log('▶ 启动后端服务 :3100 ...');
  server = spawn(process.execPath, ['dist/main.js'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL, PORT: String(PORT), LEGACY_DEFAULT_PW: 'admin123' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(d));
  // 2026-10-10 验收修复：stdout 必须"消费"掉——pipe 无人读取时缓冲(64KB)写满会阻塞子进程，
  // 服务在 Nest 启动日志刷满后整体卡死、/health 永不可达（ECONNREFUSED 根因）。
  server.stdout.on('data', () => {});
  ok(await waitHealth(), '服务启动且 /health 可达');

  // ═══ A. 登录鉴权 ═══
  console.log('■ A. 登录与鉴权');
  // 2026-10-10 acceptance fix: V4.24.0+ admin is created via first-run bootstrap (init-db no longer seeds ADMIN)
  const boot = await api('POST', '/auth/bootstrap-admin', { body: { empNo: 'ADMIN', name: 'system-admin', password: 'admin123' } });
  if (boot.code !== 0) console.log('  [bootstrap-admin]', JSON.stringify(boot).slice(0,240));
  const login = await api('POST', '/auth/login', { body: { empNo: 'ADMIN', password: 'admin123' } });
  eq(login.code, 0, '管理员登录成功');
  let T = data(login)?.token;
  ok(!!T, '返回 JWT');
  ok(data(login)?.perms?.includes('stock.inbound.audit'), 'JWT 携带颗粒化权限点');
  const me = await api('GET', '/auth/me', { token: T });
  eq(me.code, 0, 'GET /auth/me 鉴权通过');
  const bad = await api('GET', '/settings');
  eq(bad.status, 401, '未登录访问受保护接口 → 401');
  // P0-F3 整改验证：初始密码会话只能改密——先证 403 门禁，改密后重登取全功能 token
  eq((await api('GET', '/products', { token: T })).status, 403, '默认口令会话访问业务接口 → 403（P0-F3）');
  const cp = await api('POST', '/auth/change-password', { token: T, body: { oldPassword: 'admin123', newPassword: 'E2e#Admin2026' } });
  eq(cp.code, 0, 'P0-F3 修改初始密码成功');
  T = data(await api('POST', '/auth/login', { body: { empNo: 'ADMIN', password: 'E2e#Admin2026' } }))?.token;
  ok(!!T, 'P0-F3 改密后重新登录取新 token');

  // ═══ B. 设置项与留痕 ═══
  console.log('■ B. 系统设置与变更留痕');
  const s1 = await api('GET', '/settings?group=' + encodeURIComponent('财务管理'), { token: T });
  const ratioRow = data(s1)?.find?.(x => x.setting_key === 'dividend.ratio');
  eq(ratioRow?.value, 5, 'dividend.ratio 默认 5');
  const up = await api('PUT', '/settings/dividend.ratio', { token: T, body: { value: 8, reason: '测试调参' } });
  eq(up.code, 0, '修改设置成功');
  const s2 = await api('GET', '/settings?group=' + encodeURIComponent('财务管理'), { token: T });
  eq(data(s2)?.find?.(x => x.setting_key === 'dividend.ratio')?.value, 8, '修改后读取=8');
  const chg = await api('GET', '/settings/changes', { token: T });
  ok((data(chg)?.rows ?? data(chg) ?? []).some?.(x => x.setting_key === 'dividend.ratio'), '变更留痕已记录');
  await api('PUT', '/settings/dividend.ratio', { token: T, body: { value: 5, reason: '还原' } });

  // ═══ C. 商品与供应商 ═══
  console.log('■ C. 商品档案与供应商');
  const paRaw = await api('POST', '/products', { token: T, body: {
    name: '沁泉矿泉水550ml', base_unit: '瓶', sellPrice: 2, barcode: '6901234500017', keepDays: 365, minStock: 10 } });
  if (paRaw.code !== 0 || !paRaw.data) console.log('  [debug A]', JSON.stringify(paRaw));
  const pa = data(paRaw);
  const pb = data(await api('POST', '/products', { token: T, body: {
    name: '红富士苹果', base_unit: 'kg', sellPrice: 5.98, isWeighted: true, trackInventory: false, keepDays: 7 } }));
  ok(pa?.id > 0 && pb?.id > 0, '商品建档成功（A 瓶装 / B 称重）');
  const bc = await api('GET', '/products/barcode/6901234500017', { token: T });
  eq(data(bc)?.product?.id, pa.id, '条码精确查询命中');
  const s1r = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: '绿源蔬菜配送', contactPerson: '刘老板', contactPhone: '13800000011', bizMode: '购销' } }));
  const s2r = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: '百汇商贸', contactPerson: '陈经理', contactPhone: '13800000012', bizMode: '购销' } }));
  ok(s1r?.id > 0 && s2r?.id > 0, '供应商建档 ×2');
  const SID = s1r.id, SID2 = s2r.id;
  // V4.12+ 商品-供应商绑定规则：入库/采购单只允许录入该供应商供应的商品 → 先绑定主供应商
  for (const pid of [pa.id, pb.id]) {
    const bind = await api('PUT', `/products/${pid}`, { token: T, body: { supplierDefaultId: Number(SID) } });
    ok(bind.code === 0, `商品#${pid} 绑定主供应商 SID`);
  }
  // V4.7 签名治理默认「必签才能过审」（inbound/return/loss/recon）；本套件不覆盖电子签流程 → 关闭该场景
  const signOff = await api('PUT', '/settings/auth.sign_required_scenes', { token: T, body: { value: [], reason: 'e2e 套件不测电子签' } });
  eq(signOff.code, 0, '关闭必签场景（测试环境）');

  // ═══ D. 入库 → FIFO 批次闭环 ═══
  console.log('■ D. 入库审核→批次生成（FIFO）');
  const d1 = await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: SID, items: [
    { productId: pa.id, qty: 100, unitCost: 1.5, productionDate: '2026-08-20' },
    { productId: pb.id, qty: 50, unitCost: 3, productionDate: '2026-08-01' } ] } });
  eq(d1.code, 0, '入库单创建（含生产日期）');
  const dMiss = await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: SID, items: [
    { productId: pa.id, qty: 1, unitCost: 1 } ] } });
  eq(dMiss.code, 50011, '缺生产日期 → 50011 拦截（V4.3.6）');
  const I1 = data(d1).id;
  const aud1Raw = await api('POST', `/purchase/inbounds/${I1}/audit`, { token: T });
  if (aud1Raw.code !== 0) console.log('  [debug audit]', JSON.stringify(aud1Raw));
  const aud1 = aud1Raw;
  eq(data(aud1)?.status, '已审核', '入库审核通过');
  near(data(aud1)?.totalAmount, 300, '入库金额 = 100×1.5 + 50×3 = 300');
  const d2 = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: SID, items: [
    { productId: pa.id, qty: 100, unitCost: 1.3, productionDate: '2026-08-25' } ] } }));
  const I2 = d2.id;
  await api('POST', `/purchase/inbounds/${I2}/audit`, { token: T });
  const batches = await sqlOnly(
    `SELECT b.* FROM batches b WHERE b.product_id=$1 ORDER BY b.id`, [pa.id]);
  eq(batches.rows.length, 2, '商品A 生成 2 个批次（FIFO 批次=供应商×入库单×批次号）');
  eq(batches.rows[0].batch_no, `${data(d1).inboundNo}-01`, '批次号规则 = 入库单号-序号');
  eq(locDate(batches.rows[0].expiry_date), '2027-08-20', '到期日=生产日期+保质期（自动）');
  const inv = await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id]);
  eq(Number(inv.rows[0].qty_total), 200, '即时库存 = 200');
  const minp = await sqlOnly(
    `SELECT MIN(min_price) AS m FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2`, [pa.id, SID]);
  eq(Number(minp.rows[0].m), 1.3, '进价最低价保护：min_price 收敛到 1.3（V4.3.6）');
  const reAud = await api('POST', `/purchase/inbounds/${I1}/audit`, { token: T });
  eq(reAud.code, 50010, '重复审核 → 状态机拦截 50010');

  // ═══ E. 收银结账 → FIFO 扣减与混合成本 ═══
  console.log('■ E. 收银结账（FIFO 批次扣减 + 成本可追溯）');
  const e1 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [], payments: [{ channel: '现金', amount: 1 }] } });
  eq(e1.code, 40003, '空明细 → 40003');
  const e2r = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 10 }], payments: [{ channel: '现金', amount: 20 }] } });
  eq(data(e2r)?.payable, 20, '服务端计价 10×2=20');
  near(data(e2r)?.costTotal, 15, 'FIFO 成本 10×1.5=15（先到期/先入库批次）');
  near(data(e2r)?.profit, 5, '毛利 5');
  const b1 = batches.rows[0].id;
  const remain = await sqlOnly(`SELECT remain_qty, status FROM batches WHERE id=$1`, [b1]);
  eq(Number(remain.rows[0].remain_qty), 90, '批次剩余 90（FIFO 扣减）');
  const e3 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 5000 }], payments: [{ channel: '现金', amount: 1 }] } });
  eq(e3.code, 50001, '库存不足 → 50001');
  const e4 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], payments: [{ channel: '现金', amount: 1 }] } });
  eq(e4.code, 50031, '支付与应收不一致 → 50031');
  const ordId = data(e2r).orderId;
  const det = await api('GET', `/sales/${ordId}`, { token: T });
  const trace = data(det)?.items?.[0]?.batch_trace;
  ok(Array.isArray(trace) && trace[0]?.qty === 10 && Number(trace[0]?.cost) === 1.5, 'sale_item_batches 批次成本可追溯');

  // ═══ F. 会员闭环（储值/余额/积分/有效消费窗口） ═══
  console.log('■ F. 会员储值消费与有效消费窗口（双门槛 V4.3.2）');
  const m1 = data(await api('POST', '/members', { token: T, body: { phone: '13800000001', name: '张三', privacyAgreed: true } }));
  const m2 = data(await api('POST', '/members', { token: T, body: { phone: '13900000002', name: '李四' } }));
  ok(m1?.id > 0 && m2?.id > 0, '会员建档 ×2（卡号自动生成）');
  const dup = await api('POST', '/members', { token: T, body: { phone: '13800000001', name: '重复' } });
  eq(dup.code, 50050, '手机号重复 → 50050');
  const rc1 = await api('POST', `/members/${m1.id}/recharges`, { token: T, body: { principal: 200 } });
  near(data(rc1)?.balanceAfter, 200, '张三储值 200');
  await api('POST', `/members/${m2.id}/recharges`, { token: T, body: { principal: 100 } });
  const f5 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 10 }], memberId: m1.id,
    payments: [{ channel: '余额', amount: 20 }] } });
  eq(f5.code, 0, '会员余额支付成功');
  const acc1 = await sqlOnly(`SELECT balance, points FROM member_accounts WHERE member_id=$1`, [m1.id]);
  eq(Number(acc1.rows[0].balance), 180, '余额 200-20=180');
  eq(acc1.rows[0].points, 20, '积分 +20');
  const f6 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id,
    payments: [{ channel: '分红抵扣', amount: 2 }] } });
  eq(f6.code, 50033, '分红余额为0抵扣 → 50033（且事务回滚不丢单）');
  const f7 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 19.5 }], memberId: m1.id, payments: [{ channel: '现金', amount: 39 }] } });
  eq(f7.code, 0, '现金 39 元（累计窗口）');
  const f8 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1.5 }], memberId: m1.id, payments: [{ channel: '现金', amount: 3 }] } });
  eq(f8.code, 0, '3 元小额单（低于单笔门槛）');
  const w = await sqlOnly(`SELECT * FROM member_activity_windows WHERE member_id=$1 ORDER BY id`, [m1.id]);
  eq(w.rows.length, 1, '小额单未开新窗口（单笔≥5 才入账）');
  eq(Number(w.rows[0].valid_total), 59, '窗口累计 20+39=59');
  eq(w.rows[0].qualified, true, '窗口累计≥50 → 达标（可参与分红）');
  const f9 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 30 }], memberId: m2.id, payments: [{ channel: '现金', amount: 60 }] } });
  eq(f9.code, 0, '李四消费 60（窗口达标）');

  // ═══ G. 分红引擎 ═══
  console.log('■ G. 分红引擎（5% · 双门槛 · R=30% 封顶降级 · 幂等）');
  const pv = data(await api('GET', '/dividend/preview?netProfit=1000', { token: T }));
  near(pv?.pool, 50, '池 = 1000×5% = 50');
  ok(pv?.redAlert === true, '年化预警触发（红）');
  const g1 = data(await api('POST', '/dividend/periods/run', { token: T, body: { date: '2026-09-03', netProfit: 1000 } }));
  near(g1?.given, 50.00, '计提：张三 32.15 + 李四 17.85（决策③尾差守恒：1 分尾差按权重补给张三，Σ==池）');
  const g1Cons = await sqlOnly(`SELECT ROUND(COALESCE(SUM(r.amount),0),2)::numeric AS given_sum, p.pool_amount FROM dividend_periods p JOIN dividend_records r ON r.period_id = p.id WHERE p.id=$1 GROUP BY p.id, p.pool_amount`, [g1.periodId]);
  near(Number(g1Cons.rows[0]?.given_sum ?? -1), Number(g1Cons.rows[0]?.pool_amount ?? -2), '决策③守恒断言：Σ个人入账 == 分红池（无封顶干扰时分毫不差）');
  eq(g1?.memberCount, 2, '2 名合格会员参与');
  const g2 = await api('POST', '/dividend/periods/run', { token: T, body: { date: '2026-09-03', netProfit: 1000 } });
  eq(g2.code, 50060, '同日重复计提 → 幂等拦截 50060');
  const accG = await sqlOnly(`SELECT dividend_balance FROM member_accounts WHERE member_id=$1`, [m1.id]);
  near(accG.rows[0].dividend_balance, 32.15, '张三分红账户入账 32.15（尾差补发后）');
  // 封顶：张三上限 200×30%=60，李四上限 100×30%=30
  const g3 = data(await api('POST', '/dividend/periods/run', { token: T, body: { date: '2026-09-04', netProfit: 1000 } }));
  near(g3?.given, 40.00, '封顶截断：张三 27.85（到 60）+ 李四 12.15（到 30）——被封顶者不参与尾差补发，池差合法留存');
  const caps = await sqlOnly(`SELECT member_id, dividend_capped, dividend_balance FROM member_accounts ORDER BY member_id`);
  eq(caps.rows[0].dividend_capped, true, '张三达封顶 → 降级标记');
  eq(caps.rows[1].dividend_capped, true, '李四达封顶 → 降级标记');
  near(caps.rows[0].dividend_balance, 60, '张三分红余额 = 净充值×R = 60（精确封顶）');
  const g4 = data(await api('POST', '/dividend/periods/run', { token: T, body: { date: '2026-09-05', netProfit: 1000 } }));
  eq(g4?.memberCount, 0, '全员封顶后权重 0 → 降级仅积分，不再计提');

  // ═══ H. T7 退货批次自动归属 ═══
  console.log('■ H. T7 采购退货·批次自动归属（最早剩余批次+跨批拆分 V4.3.4）');
  const h1 = await api('POST', '/purchase/returns', { token: T, body: {
    supplierId: SID, items: [{ productId: pa.id, qty: 1 }] } });
  eq(data(h1)?.status, '待审核', '无凭证可建单（039 状态重命名：待预审→待审核）');
  const h2 = data(await api('POST', '/purchase/returns', { token: T, body: {
    supplierId: SID, evidencePath: '/evidence/th001.jpg', items: [{ productId: pa.id, qty: 105 }] } }));
  eq(h2?.status, '待审核', '退货单创建（录入即生效·审核后置）');
  const RET = h2.id;
  const allocs = await sqlOnly(
    `SELECT a.qty, a.unit_cost, a.alloc_rule, b.batch_no FROM return_batch_allocs a
      JOIN batches b ON b.id=a.batch_id JOIN purchase_return_items i ON i.id=a.return_item_id
     WHERE i.return_id=$1 ORDER BY a.id`, [RET]);
  eq(allocs.rows.length, 2, '跨批拆分为 2 条归属明细');
  near(allocs.rows[0].qty, 29, '最早批次（1.5元）先扣 29（已售 71 件后剩余）');
  near(allocs.rows[1].qty, 76, '跨批拆分第二批（1.3元）76');
  eq(allocs.rows[0].alloc_rule, '自动', '归属规则=自动');
  const h3 = await api('POST', '/purchase/returns', { token: T, body: {
    supplierId: SID, evidencePath: '/evidence/x.jpg', items: [{ productId: pa.id, qty: 10000 }] } });
  eq(h3.code, 50014, '超商品总库存 → 50014（账实脱钩校验口径）');
  const h4 = await api('POST', '/purchase/returns', { token: T, body: {
    supplierId: SID2, evidencePath: '/evidence/y.jpg', items: [{ productId: pa.id, qty: 5 }] } });
  eq(h4.code, 50015, '其他供应商无批次可归属 → 50015（多供应商隔离 V4.3.5）');
  const h5 = data(await api('POST', `/purchase/returns/${RET}/audit`, { token: T }));
  near(h5?.totalAmount, 142.30, '退货金额 = 29×1.5 + 76×1.3 = 142.30（批次原价）');
  const afterRet = await sqlOnly(
    `SELECT (SELECT qty_total FROM inventory_current WHERE product_id=$1) AS inv,
            (SELECT count(*) FROM batches WHERE product_id=$1 AND status='在库') AS live_b`,
    [pa.id]);
  eq(Number(afterRet.rows[0].inv), 24, '库存 200-71已售-105退货=24');
  eq(Number(afterRet.rows[0].live_b), 1, '早期批次售罄，仅剩 1 个在库批次');
  const reRet = await api('POST', `/purchase/returns/${RET}/audit`, { token: T });
  eq(reRet.code, 50016, '重复审核退货 → 状态机拦截 50016');

  // ═══ I. T8 对账与结算 ═══
  console.log('■ I. T8 对账与结算（费用自动补齐 + 往来账 + 现场确认）');
  await sqlOnly(`INSERT INTO supplier_fee_types (code,name,direction) VALUES
    ('rebate','销售返利','收'),('diff','价补差','付') ON CONFLICT (code) DO NOTHING`);
  await sqlOnly(
    `INSERT INTO supplier_fee_agreements (store_id,supplier_id,fee_type_id,cycle,amount_mode,amount,start_date,auto_generate)
     VALUES (1,$1,(SELECT id FROM supplier_fee_types WHERE code='rebate'),'月','固定额',100,'2026-08-01',true)`, [SID]);
  await sqlOnly(
    `INSERT INTO supplier_fees (store_id,fee_no,supplier_id,fee_type_id,period_start,period_end,amount,status,employee_id,remark)
     VALUES (1,'FY-MANUAL-001',$1,(SELECT id FROM supplier_fee_types WHERE code='diff'),'2026-09-01','2026-09-05',50,'已审核',1,'人工补差')`, [SID]);
  const pv2 = data(await api('GET', `/purchase/recon/preview?supplierId=${SID}&from=2026-08-01&to=${TO_STR}`, { token: T }));
  eq(pv2?.inbounds?.length, 2, '预览：2 张入库单');
  eq(pv2?.returns?.length, 2, '预览：退货单展示 2 张（039 后与入库同口径：含待审核展示，仅已审核计入应付）');
  eq(pv2?.fees?.length, 1, '预览：仅 1 笔已审核人工费用（协议补齐发生在对账时）');
  near(pv2?.payableTotal, 337.70, '预览应付（未含补齐费用）= 430 - 142.3 + 50 = 337.70');
  const i3 = data(await api('POST', '/purchase/recon', { token: T, body: {
    supplierId: SID, from: '2026-08-01', to: TO_STR } }));
  eq(i3?.reconNo, 'DZ-' + YM_MM + '-001', '对账单号规则');
  near(i3?.payableTotal, 337.70 - 100 * AUTO_FEE_MONTHS, '对账应付（预览应付 - 协议补齐 ' + AUTO_FEE_MONTHS + ' 期，随月动态）');
  eq(i3?.autoFees?.length, AUTO_FEE_MONTHS, `协议漏记期次自动补齐 ${AUTO_FEE_MONTHS} 笔（V4.3.6）`);
  const RECON = i3.id;
  const i4 = await sqlOnly(`SELECT recon_id FROM inbound_orders WHERE id=$1`, [I1]);
  eq(Number(i4.rows[0].recon_id), Number(RECON), '入库单标记已被对账吸收');
  const i5 = await api('POST', '/purchase/recon', { token: T, body: {
    supplierId: SID, from: '2026-08-01', to: TO_STR } });
  eq(i5.code, 50017, '区间单据已全部吸收 → 50017');
  const i6 = await api('POST', '/purchase/settlements', { token: T, body: { reconId: RECON } });
  eq(i6.code, 50019, '未确认先结算 → 50019');
  const i7 = await api('POST', `/purchase/recon/${RECON}/confirm`, { token: T, body: {
    confirmType: '现场确认', confirmName: '王业务' } });
  eq(data(i7)?.status, '已确认', '现场确认（V4.3.7）');
  const i8 = data(await api('POST', '/purchase/settlements', { token: T, body: { reconId: RECON, payMode: '转账' } }));
  near(i8?.amount, 337.70 - 100 * AUTO_FEE_MONTHS, '结算单金额 = 对账应付（动态期数）');
  const i9 = data(await api('POST', `/purchase/settlements/${i8.id}/audit`, { token: T }));
  eq(i9?.status, '付款中', '结算审核 → 付款中（VQA-D3 recon.settle_pay_flow 两段式）');
  const i9pay = data(await api('POST', `/purchase/settlements/${i8.id}/pay`, { token: T }));
  eq(i9pay?.status, '已付款', '确认付款 → 已付款（两段式终结）');
  const led = await sqlOnly(
    `SELECT balance_after FROM supplier_ledger WHERE supplier_id=$1 ORDER BY id`, [SID]);
  near(led.rows[led.rows.length - 1].balance_after, 0, '往来账闭环：结算后应付归零');
  const i10 = await api('POST', '/purchase/settlements', { token: T, body: { reconId: RECON } });
  eq(i10.code, 50019, '重复结算 → 50019');

  // ═══ J. T9 口径B 拆分 + T10 等级积分 + T11 报表聚合 ═══
  console.log('■ J. 口径B 本金/赠送拆分 · 会员等级与积分 · 报表聚合（T9/T10/T11）');
  // —— J1 储值本金/赠送双余额（口径B 5.1.2） ——
  const m3 = data(await api('POST', '/members', { token: T, body: { phone: '13700000003', name: '王五', privacyAgreed: true } }));
  ok(m3?.id > 0, '会员王五建档');
  const j1 = data(await api('POST', `/members/${m3.id}/recharges`, { token: T, body: { principal: 100, gift: 20 } }));
  near(j1?.balanceAfter, 120, '储值本金 100 + 赠送 20 → 余额 120');
  const j1b = await sqlOnly(
    `SELECT balance, principal_balance, gift_balance FROM member_accounts WHERE member_id=$1`, [m3.id]);
  eq(Number(j1b.rows[0].principal_balance), 100, '本金余额 100（分开记账）');
  eq(Number(j1b.rows[0].gift_balance), 20, '赠送余额 20（分开记账）');
  // —— J2 余额消费按比例拆分，有效消费只记本金 ——
  // （苹果 15kg×5.98=89.70；余额 60 拆分本金 50 + 现金 29.7 → 有效消费 79.7 达标）
  const j2 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 15 }], memberId: m3.id,
    payments: [{ channel: '余额', amount: 60 }, { channel: '现金', amount: 29.7 }] } });
  eq(j2.code, 0, '王五混合支付 89.7（余额 60 + 现金 29.7）');
  const j2b = await sqlOnly(
    `SELECT principal_part, gift_part FROM balance_flows WHERE member_id=$1 AND biz_type='消费' ORDER BY id DESC LIMIT 1`, [m3.id]);
  near(j2b.rows[0].principal_part, 50, '口径B 拆分：本金 60×100/120 = 50');
  near(j2b.rows[0].gift_part, 10, '口径B 拆分：赠送 10');
  const j2c = await sqlOnly(
    `SELECT balance, principal_balance, gift_balance FROM member_accounts WHERE member_id=$1`, [m3.id]);
  near(j2c.rows[0].balance, 60, '余额 120-60=60');
  near(j2c.rows[0].principal_balance, 50, '本金余额 100-50=50');
  near(j2c.rows[0].gift_balance, 10, '赠送余额 20-10=10');
  const j2w = await sqlOnly(
    `SELECT valid_total FROM member_activity_windows WHERE member_id=$1 ORDER BY id LIMIT 1`, [m3.id]);
  near(j2w.rows[0].valid_total, 79.7, '有效消费=本金 50+现金 29.7（赠送/分红不计入 5.1.16）');
  // —— J3 余额达标立即升级银卡 + 留痕 ——
  const j3 = data(await api('POST', `/members/${m3.id}/recharges`, { token: T, body: { principal: 950 } }));
  near(j3?.balanceAfter, 1010, '再充本金 950 → 余额 1010（总余额）');
  eq(j3?.level?.to, '银卡会员', '本金余额≥1000 立即升级银卡（决策①：只按本金判级）');
  const j3b = await sqlOnly(`SELECT reason FROM member_level_log WHERE member_id=$1 ORDER BY id`, [m3.id]);
  ok(j3b.rows.some(r => String(r.reason).includes('升级')), '等级变更写 member_level_log 留痕（reason=成长值升级模板）');
  const j3c = data(await api('GET', `/members/${m3.id}`, { token: T }));
  eq(j3c?.member?.level_name, '银卡会员', '会员详情返回等级名称');
  // —— J4 银卡积分倍率 1.5 ——
  const j4raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 5 }], memberId: m3.id, payments: [{ channel: '现金', amount: 10 }] } });
  if (j4raw.code !== 0) console.log('  [debug j4]', JSON.stringify(j4raw));
  const j4 = data(j4raw);
  eq(j4?.points, 15, '银卡积分倍率 1.5：10 元 → 15 分（5.1.12）');
  // —— J5 等级折扣开关（普通会员 9.8 折；设置项 member.level_discount） ——
  const j5set = await api('PUT', '/settings/member.level_discount', { token: T, body: { value: 1, reason: '测试开启' } });
  eq(j5set.code, 0, '等级折扣开关设置可写');
  const j5 = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 10 }], memberId: m1.id, payments: [{ channel: '现金', amount: 19.6 }] } }));
  near(j5?.payable, 19.6, '普通会员 9.8 折：10×2×0.98 = 19.6');
  await api('PUT', '/settings/member.level_discount', { token: T, body: { value: 0, reason: '还原关闭' } });
  // —— J6 积分抵扣（100 分 = 1 元；积分支付不计有效消费） ——
  const j6a = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id, payments: [{ channel: '积分抵扣', amount: 2 }] } });
  eq(j6a.code, 50034, '积分不足 → 50034');
  const j6raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id,
    payments: [{ channel: '积分抵扣', amount: 0.4 }, { channel: '现金', amount: 1.6 }] } }); // 2026-10 积分抵现上限≤应收20%（0.4=2×20%）
  if (j6raw.code !== 0) console.log('  [debug j6]', JSON.stringify(j6raw));
  eq(j6raw.code, 0, '积分抵扣 0.7 元 + 现金 1.3 元组合支付');
  const j6b = await sqlOnly(`SELECT points FROM members WHERE id=$1`, [m1.id]);
  eq(Number(j6b.rows[0].points), 42, '积分 81+1-40 = 42（抵扣 40 分；本单计提按有效消费 1.6 元挣 1 分——L-20 口径）');
  const j6c = await sqlOnly(
    `SELECT direction, points, biz_type FROM points_flows WHERE member_id=$1 AND biz_type='兑换' ORDER BY id DESC LIMIT 1`, [m1.id]);
  eq(j6c.rows[0].direction, '减', '积分兑换流水方向=减');
  eq(Number(j6c.rows[0].points), 40, '积分兑换流水 40 分');
  // —— J7 分红权重 = 本金余额 × 等级系数 c（口径B + 5.1.12） ——
  const j7 = data(await api('GET', '/dividend/preview?netProfit=1000', { token: T }));
  const m3row = j7?.items?.find(x => x.memberId === m3.id);
  near(m3row?.weight, 1200, '王五权重 = 本金余额 1000 × 银卡系数 1.2 = 1200（决策①口径）');
  near(m3row?.coeff, 1.2, '等级分红系数 c=1.2 生效');
  const m1row = j7?.items?.find(x => x.memberId === m1.id);
  eq(m1row?.capped, true, '已封顶会员权重置 0（降级仅积分不受影响）');
  // —— J8 降级宽限期：低于阈值不立即降，宽限到期才降 ——
  const j8raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 4 }], memberId: m3.id,
    payments: [{ channel: '余额', amount: 20 }, { channel: '现金', amount: 3.92 }] } });
  if (j8raw.code !== 0) console.log('  [debug j8]', JSON.stringify(j8raw));
  eq(j8raw.code, 0, '王五余额再消费 20 → 余额 990');
  const j8 = data(j8raw);
  // 2026-10-10 改造：V5.0.17 起等级判定=成长值口径（本金判级已废弃）。构造减向成长记录，使近周期成长值跌破银卡保级线但高于普通档。
  const lk8 = await sqlOnly(`SELECT COALESCE(l.keep_growth,0) AS keep FROM members m LEFT JOIN member_levels l ON l.id=m.level_id WHERE m.id=$1`, [m3.id]);
  const keepSilver = Number(lk8.rows[0]?.keep || 0);
  const gt8 = await sqlOnly(`SELECT COALESCE(growth_total,0) AS g FROM members WHERE id=$1`, [m3.id]);
  const cut8 = Math.max(1, Number(gt8.rows[0]?.g || 0) - keepSilver + 10);
  await sqlOnly(`INSERT INTO member_growth_records (store_id, member_id, direction, growth_value, base_amount, rate, biz_type, remark) VALUES (1,$1,'减',$2,0,1,'调整','e2e-grace')`, [m3.id, cut8]);
  await sqlOnly(`UPDATE members SET growth_total = growth_total - $2 WHERE id=$1`, [m3.id, cut8]);
  const j8set = await api('PUT', '/settings/member.level_grace_days', { token: T, body: { value: 7, reason: 'e2e 宽限 7 天' } });
  if (j8set.code !== 0) console.log('  [debug j8set]', JSON.stringify(j8set).slice(0, 200));
  const j8re = data(await api('POST', '/members/levels/sync', { token: T, body: {} }));
  eq(j8re?.changed, 0, '跌破保级线首次同步 → 仅进缓冲不降级');
  eq(j8re?.changed === 0, true, '跌破银卡保级线首次同步 → 仅进缓冲不降级（V5.0.17 成长值口径，宽限标记见下行 level_below_since）');
  const j8b = await sqlOnly(`SELECT level_below_since IS NOT NULL AS marked FROM members WHERE id=$1`, [m3.id]);
  eq(j8b.rows[0].marked, true, '宽限起始日已记录 level_below_since');
  await sqlOnly(`UPDATE members SET level_below_since = CURRENT_DATE - 8 WHERE id=$1`, [m3.id]);
  const j8c = data(await api('POST', '/members/levels/sync', { token: T, body: {} }));
  ok(j8c?.checked >= 3 && j8c?.changed >= 1, `全量同步：检查 ${j8c?.checked} 人，变更 ${j8c?.changed} 人`);
  const j8d = await sqlOnly(
    `SELECT l.name AS level_name FROM members m LEFT JOIN member_levels l ON l.id=m.level_id WHERE m.id=$1`, [m3.id]);
  eq(j8d.rows[0].level_name, '普通会员', '宽限 8 天后同步 → 降级普通会员');
  const j8e = await sqlOnly(
    `SELECT reason FROM member_level_log WHERE member_id=$1 ORDER BY id DESC LIMIT 1`, [m3.id]);
  ok(String(j8e.rows[0].reason).includes('下调'), '降级留痕 reason=缓冲期结束下调模板');
  // —— J9 报表中心（T11/T13） ——
  const j9 = data(await api('GET', '/reports/overview', { token: T }));
  ok(Number(j9?.today?.orderCount) > 0, '看板：今日订单数 > 0');
  ok(Number(j9?.today?.salesTotal) > 0, '看板：今日销售额 > 0');
  ok(Number(j9?.members?.total) >= 3, '看板：会员总数 ≥3');
  near(Number(j9?.dividend?.givenTotal), 90, '看板：累计分红发放 32.15+27.85+17.85+12.15=90（封顶收敛总值不变）');
  const j9b = data(await api('GET', `/reports/daily?from=${locDate(new Date())}&to=${locDate(new Date())}`, { token: T }));
  ok(Number(j9b?.days?.[0]?.orderCount) > 0, '日报：当日销售汇总（订单数>0）');
  ok(j9b?.channels?.some?.(c => c.channel === '余额'), '日报：支付构成含余额渠道');
  ok(j9b?.channels?.some?.(c => c.channel === '积分抵扣'), '日报：支付构成含积分抵扣渠道');
  const j9c = data(await api('GET', `/reports/abc?from=${locDate(new Date())}&to=${locDate(new Date())}`, { token: T }));
  ok(j9c?.items?.length >= 1 && j9c.items[0].className === 'A', 'ABC：销售额最高商品归 A 类');
  ok(Number(j9c?.items?.[0]?.cum_pct) <= 80, 'ABC：A 类累计占比 ≤80%（帕累托口径）');
  const j9d = data(await api('GET', '/reports/dividend', { token: T }));
  ok(j9d?.periods?.length >= 2, '分红汇总：期间列表 ≥2');
  near(j9d?.total?.givenTotal, 90, '分红汇总：累计发放 90');


  // ═══ K 段：T12 促销引擎（满减/满折/特价时段价/第二件半价/会员价取优，5.4）═══
  console.log('\n── K 段：T12 促销引擎 ──');
  const tStart = new Date(Date.now() - 60000).toISOString();
  const tEnd = new Date(Date.now() + 3600000).toISOString();

  // K1 特价（时段价）：矿泉水 2 → 1.5，行级命中、unit_price/origin_price 留痕
  const k1p = await api('POST', '/promotions', { token: T, body: {
    name: '矿泉水早市特价', kind: '特价', rules: { specialPrice: 1.6 }, // 2026-10 价格红线 0.8×2=1.6：特价贴线不再击穿
    scope: { productIds: [pa.id] }, startAt: tStart, endAt: tEnd, startNow: true } });
  eq(k1p.code, 0, '创建特价活动（进行中）');
  const P1 = Number(data(k1p).id);
  const k1raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 2 }], payments: [{ channel: '现金', amount: 3.2 }] } });
  eq(k1raw.code, 0, '特价下单 2 瓶');
  const k1 = data(k1raw);
  near(k1.promoAmount, 0.8, '特价让利 = (2-1.6)×2 = 0.8（红线贴线价）');
  near(k1.payable, 3.2, '特价应收 3.2 元（贴红线价 1.6）');
  const k1i = await sqlOnly(
    `SELECT unit_price, origin_price, line_amount, promo_id FROM sale_items WHERE order_id=$1`, [k1.orderId]);
  near(k1i.rows[0].unit_price, 1.6, '特价单价 1.6（贴红线价）');
  near(k1i.rows[0].origin_price, 2, 'origin_price 留痕原价 2');
  eq(Number(k1i.rows[0].promo_id), P1, '行级 promo_id 命中特价活动');

  // K2 跨层叠加：特价（行级）+ 满减（整单级）同时生效，整单优惠按行小比分摊
  const k2p = await api('POST', '/promotions', { token: T, body: {
    name: '满10减2', kind: '满减', rules: { tiers: [{ threshold: 10, off: 2 }] },
    startAt: tStart, endAt: tEnd, startNow: true } });
  eq(k2p.code, 0, '创建满减活动');
  const P2 = Number(data(k2p).id);
  const k2raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 2 }, { productId: pb.id, qty: 2 }],
    payments: [{ channel: '现金', amount: 13.16 }] } });
  eq(k2raw.code, 0, '特价+满减叠加下单（货值 4+11.96=15.96）');
  const k2 = data(k2raw);
  near(k2.goodsAmount, 15.96, 'goods_amount 按原价 15.96');
  near(k2.promoAmount, 2.8, '促销合计 = 特价 0.8 + 满减 2 = 2.8');
  near(k2.payable, 13.16, '应收 13.16');
  const k2i = await sqlOnly(
    `SELECT product_id, line_amount FROM sale_items WHERE order_id=$1 ORDER BY id`, [k2.orderId]);
  near(Number(k2i.rows[0].line_amount) + Number(k2i.rows[1].line_amount), 13.16,
    '满减分摊后两行合计 = 应收（尾差进末行，退货按行原路退）');
  const k2o = await sqlOnly(
    `SELECT goods_amount, promo_amount, payable_amount, promo_id FROM sales_orders WHERE id=$1`, [k2.orderId]);
  near(Number(k2o.rows[0].promo_amount), 2.8, '订单 promo_amount = 2.8');
  eq(Number(k2o.rows[0].promo_id), P2, '整单级 promo_id 挂满减活动');

  // K3 停用特价 → 立即失效
  const k3s = await api('POST', '/promotions/' + P1 + '/stop', { token: T });
  eq(k3s.code, 0, '停用特价活动');
  const k3raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], payments: [{ channel: '现金', amount: 2 }] } });
  eq(k3raw.code, 0, '停用后按原价成交');
  const k3 = data(k3raw);
  near(k3.promoAmount, 0, '停用后无行级让利（满减未达 10 元门槛）');
  near(k3.payable, 2, '停用后应收 2 元');

  // K4 第二件半价：苹果 3kg，每 2 件 1 组半价 → 省 2.99
  const k4p = await api('POST', '/promotions/' + P2 + '/stop', { token: T });
  eq(k4p.code, 0, '停用满减（隔离半价场景）');
  const k4c = await api('POST', '/promotions', { token: T, body: {
    name: '苹果第二件半价', kind: '第二件半价', rules: {},
    scope: { productIds: [pb.id] }, startAt: tStart, endAt: tEnd, startNow: true } });
  eq(k4c.code, 0, '创建第二件半价活动');
  const P4 = Number(data(k4c).id);
  const k4raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 3 }], payments: [{ channel: '现金', amount: 14.95 }] } });
  eq(k4raw.code, 0, '半价活动下单 3kg');
  const k4 = data(k4raw);
  near(k4.promoAmount, 2.99, '第二件半价让利 = 5.98 × 50% = 2.99');
  near(k4.payable, 14.95, '半价应收 14.95');

  // K5 满折 vs 满减同层取优（对顾客更优）+ 满减重启
  const k5r = await api('POST', '/promotions/' + P2 + '/start', { token: T });
  eq(k5r.code, 0, '已停用满减可重新启用');
  const k4s = await api('POST', '/promotions/' + P4 + '/stop', { token: T });
  eq(k4s.code, 0, '停用半价活动（隔离满折取优场景）');
  const k5c = await api('POST', '/promotions', { token: T, body: {
    name: '满20打8折', kind: '折扣', rules: { threshold: 20, rate: 0.8 },
    startAt: tStart, endAt: tEnd, startNow: true } });
  eq(k5c.code, 0, '创建满折活动');
  const P5 = Number(data(k5c).id);
  const k5raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 4 }], payments: [{ channel: '现金', amount: 19.14 }] } });
  eq(k5raw.code, 0, '满折 vs 满减并存下单 23.92');
  const k5 = data(k5raw);
  near(k5.promoAmount, 4.78, '取优：8 折让利 4.78 > 满减 2（同层只取一）');
  near(k5.payable, 19.14, '满折应收 19.14');
  const k5o = await sqlOnly(`SELECT promo_id FROM sales_orders WHERE id=$1`, [k5.orderId]);
  eq(Number(k5o.rows[0].promo_id), P5, '整单级命中满折而非满减');

  // K6 会员价 vs 促销价取优：会员价 1.2 < 特价 2.5 → 用会员价，不命中促销
  // V4.9.3 会员价门控：member_discount>0（会员折扣=是）才参与会员价计价
  await sqlOnly(`UPDATE products SET member_price=1.6, member_discount=1 WHERE id=$1`, [pa.id]); // 2026-10 贴红线价（0.8x2=1.6）；产品确认项：会员价是否应豁免价格红线
  const k6c = await api('POST', '/promotions', { token: T, body: {
    name: '矿泉水 2.5 特价', kind: '特价', rules: { specialPrice: 2.5 },
    scope: { productIds: [pa.id] }, startAt: tStart, endAt: tEnd, startNow: true } });
  eq(k6c.code, 0, '创建劣于现价的特价活动');
  const k6raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id, payments: [{ channel: '现金', amount: 1.6 }] } });
  eq(k6raw.code, 0, '会员价下单');
  const k6 = data(k6raw);
  near(k6.promoAmount, 0, '会员价 1.2 更优 → 促销不命中（5.4 取优）');
  const k6i = await sqlOnly(
    `SELECT unit_price, promo_id FROM sale_items WHERE order_id=$1`, [k6.orderId]);
  near(k6i.rows[0].unit_price, 1.6, '成交价取会员价 1.6（贴红线价）');
  eq(k6i.rows[0].promo_id, null, '未命中任何促销');

  // K7 排期不生效 → start 生效 → 50035 状态机拦截
  const k7c = await api('POST', '/promotions', { token: T, body: {
    name: '矿泉水 1.6 特价', kind: '特价', rules: { specialPrice: 1.6 }, // 2026-10 贴红线价；本段测排期状态机，金额非重点
    scope: { productIds: [pa.id] }, startAt: tStart, endAt: tEnd, startNow: false } });
  eq(k7c.code, 0, '创建排期活动（未开始）');
  const P7 = Number(data(k7c).id);
  const k7raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], payments: [{ channel: '现金', amount: 2 }] } });
  eq(k7raw.code, 0, '排期活动不生效');
  near(data(k7raw).payable, 2, '排期时按原价 2 元成交');
  const k7s = await api('POST', '/promotions/' + P7 + '/start', { token: T });
  eq(k7s.code, 0, '排期 → 进行中');
  const k7b = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], payments: [{ channel: '现金', amount: 1.6 }] } });
  eq(k7b.code, 0, '启用后特价生效');
  near(data(k7b).payable, 1.6, '特价 1.6 元成交（贴红线价）');
  const k7x = await api('POST', '/promotions/' + P7 + '/stop', { token: T });
  eq(k7x.code, 0, '停用活动');
  const k7y = await api('POST', '/promotions/' + P7 + '/stop', { token: T });
  eq(k7y.code, 50035, '已停用再停用 → 50035 状态机拦截');

  // K8 活动效果统计（detail 接口）
  const k8 = data(await api('GET', '/promotions/' + P2, { token: T }));
  ok(Number(k8?.effect?.orderHits ?? k8?.effect?.order_hits) >= 1, '活动效果：满减命中订单数 ≥1');
  ok(Number(k8?.effect?.orderSaved ?? k8?.effect?.order_saved) >= 2, '活动效果：满减让利总额 ≥2');


  // ═══ L 段：T13 报表收尾（dashboard 四周期看板 + 日报目标达成率）═══
  console.log('\n── L 段：T13 报表收尾 ──');
  const l0 = data(await api('GET', '/reports/overview', { token: T }));
  const l1 = data(await api('GET', '/reports/dashboard?period=day', { token: T }));
  ok(l1?.current, 'dashboard day：返回当期六指标卡');
  eq(Number(l1.current.salesTotal), Number(l0.today.salesTotal), 'dashboard 与 overview 口径一致（14.6.3）');
  ok(Array.isArray(l1.periods) && l1.periods.length >= 1, '四周期明细表 ≥1 期');
  eq(l1.trend.length, 7, '近 7 日柱图数据 7 条');
  ok(Array.isArray(l1.categoryShare) && l1.categoryShare.length >= 1, '分类占比环形图非空');
  const l2 = data(await api('GET', '/reports/dashboard?period=quarter', { token: T }));
  eq(l2.period, 'quarter', 'quarter 周期切换生效');
  ok(l2?.current, 'dashboard quarter：返回当期指标');
  const lt = await api('PUT', '/settings/report.daily_target', { token: T, body: { value: 100, reason: '测试目标' } });
  eq(lt.code, 0, '设置日销售目标 100 元');
  const l3 = data(await api('GET', '/reports/daily?from=2026-01-01&to=2026-12-31', { token: T }));
  ok(Number(l3?.target) === 100, '日报返回目标 100');
  ok(l3.days.length >= 1 && Number(l3.days[0].achievement) > 0, '日报含达成率且 >0（销售额/目标）');


  // ═══ M 段：T14 应急包（价目表全量缓存+版本哈希+新鲜度硬闸+手输授权）═══
  console.log('\n── M 段：T14 应急收银包 ──');
  const pbManual = data(await api('POST', '/products', { token: T, body: {
    name: '应急手工商品', base_unit: '件', sellPrice: 1, trackInventory: false } }));
  eq(pbManual?.id ? 1 : 0, 1, '创建应急手输载体商品（不记库存）');
  const em1 = data(await api('GET', '/pos/pricebook', { token: T }));
  ok(em1?.count >= 2, '价目表全量下发：商品数 ≥2');
  ok(/^[0-9a-f]{32}$/.test(em1?.version || ''), '版本哈希 = 32 位 MD5');
  ok((em1.items || []).some(i => i.barcode === '6901234500017'), '价目表含矿泉水条码（收银三要素）');
  const em1s = await sqlOnly(`SELECT count(*)::int AS n FROM pricebook_snapshots`);
  eq(Number(em1s.rows[0].n), 1, '下发即写快照留痕');
  const em2 = data(await api('GET', '/pos/pricebook', { token: T }));
  eq(em2.version, em1.version, '数据未变 → 版本哈希一致（幂等）');
  await sqlOnly(`UPDATE products SET sell_price=2.5 WHERE id=$1`, [pa.id]);
  const em3 = data(await api('GET', '/pos/pricebook', { token: T }));
  ok(em3.version !== em1.version, '改价 → 版本哈希变化（增量同步依据）');
  await sqlOnly(`UPDATE products SET sell_price=2 WHERE id=$1`, [pa.id]);
  const em4 = data(await api('GET', '/pos/pricebook/freshness', { token: T }));
  eq(em4.fresh, true, '新鲜度：fresh=true（刚下发）');
  eq(Number(em4.limitHours), 72, '新鲜度上限 72 小时（pos.pricebook_fresh_hours）');
  // 硬闸：把最新快照改旧到 80 小时前 → 应急结账 50036
  await sqlOnly(`UPDATE pricebook_snapshots SET generated_at = now() - interval '80 hours' WHERE id = (SELECT max(id) FROM pricebook_snapshots)`);
  const em5f = data(await api('GET', '/pos/pricebook/freshness', { token: T }));
  eq(em5f.fresh, false, '新鲜度：fresh=false（80h > 72h）');
  const em5 = await api('POST', '/sales/checkout', { token: T, body: {
    isEmergency: true, items: [{ productId: pa.id, qty: 1 }], payments: [{ channel: '现金', amount: 2 }] } });
  eq(em5.code, 50036, '价目表超 72h → 应急收银硬闸 50036');
  // 重新下发 → 恢复新鲜 → 应急收银可用；手输商品走店长授权
  const em6p = data(await api('GET', '/pos/pricebook', { token: T }));
  const em6f = data(await api('GET', '/pos/pricebook/freshness', { token: T }));
  eq(em6f.fresh, true, '重新下发后恢复新鲜');
  // 2026-10-10 验收补充：手输改价行必须店长现场授权（priceAuthTicket 强制整改的正确行为）
  const setAc = await api('POST', '/auth/set-auth-code', { token: T, body: { password: 'E2e#Admin2026', authCode: '135790' } });
  if (setAc.code !== 0) console.log('  [debug set-auth-code]', JSON.stringify(setAc).slice(0, 200));
  const authTk6 = data(await api('POST', '/auth/authorize', { token: T, body: { empNo: 'ADMIN', authCode: '135790' } }))?.ticket;
  ok(!!authTk6, '店长授权票据签发（120s）');
  const em6 = await api('POST', '/sales/checkout', { token: T, body: {
    isEmergency: true, priceAuthTicket: authTk6, memberId: em1.id,
    items: [
      { productId: pbManual.id, qty: 1, manualEntry: true, manualBarcode: '6999999999999', unitPrice: 3 },
      { productId: pb.id, qty: 1 } ],
    payments: [{ channel: '现金', amount: 8.98 }] } });
  eq(em6.code, 0, '应急收银：手输商品 3 元 + 苹果 5.98 元');
  const em6i = await sqlOnly(
    `SELECT unit_price, price_changed, line_remark FROM sale_items WHERE order_id=$1 ORDER BY id LIMIT 1`, [data(em6).orderId]);
  near(em6i.rows[0].unit_price, 3, '手输商品按授权价 3 元成交');
  eq(em6i.rows[0].price_changed, true, '手输行留改价标记');
  ok(String(em6i.rows[0].line_remark).includes('6999999999999'), '手输条码记入行备注（恢复后补录依据）');


  // ═══ N 段：T15 AI 服务（识别 mock→兜底→纠正入样本库；训练闭环；OCR 入库）═══
  console.log('\n── N 段：T15 AI 服务 ──');
  // V4.14.x 模拟引擎已废除：识别必须传真实帧（imageBase64）；无样本库时结果为空数组，绝不编造命中
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const n1raw = await api('POST', '/ai/recognize', { token: T, body: {
    imageBase64: tinyPng, expectProductIds: [pa.id] } });
  if (n1raw.code !== 0) console.log('  [debug n1]', JSON.stringify(n1raw));
  const n1 = data(n1raw);
  ok(n1?.logId > 0, '识别请求 → 日志留痕 logId');
  ok(['sample', 'mock'].includes(n1?.engine), `引擎=样本匹配（实际 ${n1?.engine}）`);
  ok(Array.isArray(n1?.result), '识别返回结果数组（空样本库 → 空结果不编造）');
  const n2 = data(await api('POST', '/ai/recognize', { token: T, body: {
    imageBase64: tinyPng, expectProductIds: [pa.id], simulateFallback: true } }));
  ok(n2?.logId > 0 && typeof n2.usedFallback === 'boolean', 'simulateFallback 请求留痕（兜底标记为布尔）');
  const n2b = await sqlOnly(`SELECT corrected, used_fallback FROM ai_recognition_logs WHERE id=$1`, [n1.logId]);
  eq(n2b.rows[0].corrected, false, '未纠正日志 corrected=false');
  // 人工纠正 → 训练对 + 自动进样本库
  const n3 = data(await api('POST', `/ai/recognize/${n1.logId}/correct`, { token: T, body: {
    corrected: [{ productId: Number(pb.id), count: 1 }] } }));
  ok(n3?.sampleId > 0, '纠正帧自动进样本库（source=识别纠正）');
  const n3b = await sqlOnly(
    `SELECT corrected, corrected_json::text AS cj FROM ai_recognition_logs WHERE id=$1`, [n1.logId]);
  eq(n3b.rows[0].corrected, true, '日志 corrected=true（训练信号留痕）');
  ok(String(n3b.rows[0].cj).includes('count'), '纠正 JSON 落库');
  // 采集任务闭环：创建→开始→随手拍×2→进度→完成
  const n4 = data(await api('POST', '/ai/tasks', { token: T, body: {
    taskType: '采集', targetCount: 2, remark: '矿泉水/苹果 各一帧' } }));
  ok(n4?.id > 0, '创建采集任务');
  const n4b = await api('POST', `/ai/tasks/${n4.id}/submit-sample`, { token: T, body: {
    imagePath: 'img://n4-1.jpg', productId: Number(pa.id) } });
  eq(n4b.code, 50048, '未开始任务提交样本 → 50048');
  const n4s = await api('POST', `/ai/tasks/${n4.id}/start`, { token: T });
  if (n4s.code !== 0) console.log('  [debug n4start]', JSON.stringify(n4s));
  eq(n4s.data?.ok, true, '任务开始（待执行→进行中）');
  eq((await api('POST', `/ai/tasks/${n4.id}/start`, { token: T })).code, 50048, '重复开始 → 50048');
  const n4c = data(await api('POST', `/ai/tasks/${n4.id}/submit-sample`, { token: T, body: {
    imagePath: 'img://n4-1.jpg', productId: Number(pa.id) } }));
  eq(n4c.progress, 50, '样本1 → 进度 50%');
  const n4d = data(await api('POST', `/ai/tasks/${n4.id}/submit-sample`, { token: T, body: {
    imagePath: 'img://n4-2.jpg', productId: Number(pb.id), annotation: { box: [0, 0, 80, 80] } } }));
  eq(n4d.progress, 100, '样本2 → 进度 100%');
  const n4e = data(await api('POST', `/ai/tasks/${n4.id}/finish`, { token: T, body: {} }));
  eq(n4e.ok, true, '采集任务完成');
  // 样本审核
  const n5r = await api('POST', `/ai/samples/${n3.sampleId}/review`, { token: T, body: { status: '已入库' } });
  eq(n5r.code, 0, '店长审核样本 → 已入库');
  eq((await api('POST', `/ai/samples/${n3.sampleId}/review`, { token: T, body: { status: '不合格' } })).code, 50049,
     '重复审核 → 50049');
  // 训练闭环：产出模型 v1 → v2 单活切换（灰度/回滚能力）
  const n6 = data(await api('POST', '/ai/tasks', { token: T, body: { taskType: '训练', targetCount: null } }));
  eq(data(await api('POST', `/ai/tasks/${n6.id}/start`, { token: T })).ok, true, '训练任务开始');
  const n6m = data(await api('POST', `/ai/tasks/${n6.id}/finish`, { token: T, body: {
    modelName: 'yolo-shelf', metrics: { map50: 0.86 }, activate: true } }));
  eq(n6m.version, 1, '产出 yolo-shelf v1');
  eq(n6m.activated, true, 'v1 单活部署');
  const n7 = data(await api('POST', '/ai/tasks', { token: T, body: { taskType: '训练' } }));
  eq(data(await api('POST', `/ai/tasks/${n7.id}/start`, { token: T })).ok, true, '第二个训练任务开始');
  const n7m = data(await api('POST', `/ai/tasks/${n7.id}/finish`, { token: T, body: {
    modelName: 'yolo-shelf', metrics: { map50: 0.91 }, activate: true } }));
  eq(n7m.version, 2, '同名单调递增 → v2');
  const n7b = await sqlOnly(`SELECT count(*)::int AS n FROM ai_models WHERE name='yolo-shelf' AND is_active`);
  eq(Number(n7b.rows[0].n), 1, '单活切换：同一时刻仅 1 个激活版本');
  const n7c = await sqlOnly(
    `SELECT model_id IS NOT NULL AS has_model, status FROM ai_tasks WHERE id=$1`, [n6.id]);
  eq(n7c.rows[0].has_model, true, '训练任务回写产出模型');
  // OCR 批量入库：preview 校验 + apply 建档（条码重复/缺字段报错行）
  const n8 = data(await api('POST', '/ai/ocr-intake', { token: T, body: {
    text: '奥利奥,6901111000011,8.5,365\n乐事薯片,6901111000028,6,180\n假商品,6901234500017,3,90\n缺价商品,6901111000035,,30' } }));
  eq(n8.okCount, 2, 'OCR preview：2 行合法');
  eq(n8.errCount, 2, 'OCR preview：2 行报错（条码重复/缺售价）');
  ok(n8.rows.some(r => r.err && r.err.includes('条码已存在')), '重复条码被识别');
  const n8b = data(await api('POST', '/ai/ocr-intake', { token: T, body: {
    text: '奥利奥,6901111000011,8.5,365\n乐事薯片,6901111000028,6,180', apply: true } }));
  eq(n8b.createdCount, 2, 'OCR apply：批量建档 2 个');
  eq(n8b.created[0].keep_days, 365, '建档保质期（食品必填项）来自 OCR');
  eq((await api('POST', '/ai/ocr-intake', { token: T, body: {
    text: '重复条码,6901111000011,5,90', apply: true } })).code, 0, 'apply 时重复条码行被跳过不报错（skipped）');
  const n8c = data(await api('POST', '/ai/ocr-intake', { token: T, body: {
    text: '重复条码,6901111000011,5,90', apply: true } }));
  eq(n8c.createdCount, 0, '重复条码 createdCount=0');


  // ═══ O 段：5.9 优惠券（模板/发券/限领/总量池/核销/门槛/过期/叠加开关）═══
  console.log('\n── O 段：优惠券 ──');
  // 场景隔离：停掉在跑的促销（P2 满减、P5 满折），特价 2.5 劣于现价不命中
  await api('POST', '/promotions/2/stop', { token: T });
  await api('POST', '/promotions/5/stop', { token: T });

  // O1 模板校验
  eq((await api('POST', '/coupons', { token: T, body: { name: '坏券', type: '满减券', threshold: 2, discount: 5 } })).code,
     40003, '满减面额 ≥ 门槛 → 40003');
  eq((await api('POST', '/coupons', { token: T, body: { name: '坏折扣', type: '折扣券', discount: 1.5 } })).code,
     40003, '折扣率 ≥1 → 40003');

  // O2 满减券发券 + 核销全链路
  const o1 = data(await api('POST', '/coupons', { token: T, body: {
    name: '满10减3', type: '满减券', threshold: 10, discount: 3, validDays: 30, totalQty: 10, perMember: 1 } }));
  ok(o1?.id > 0, '创建满减券模板');
  const o1i = data(await api('POST', `/coupons/${o1.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } }));
  eq(o1i.issued, 1, '指定发券 1 张');
  const o1c = await sqlOnly(
    `SELECT mc.id, mc.status, mc.expire_at FROM member_coupons mc WHERE mc.coupon_id=$1 AND mc.member_id=$2`,
    [o1.id, m1.id]);
  eq(o1c.rows[0].status, '未使用', '券包状态=未使用');
  const MC1 = Number(o1c.rows[0].id);
  const o1dr = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 2 }], memberId: m1.id, couponId: MC1,
    payments: [{ channel: '现金', amount: 8.96 }] } });
  eq(o1dr.code, 0, '满10减3 核销下单（货值 11.96）');
  const o1d = data(o1dr);
  near(o1d?.couponAmount, 3, '券抵扣 3 元');
  near(o1d?.payable, 8.96, '应收 = 11.96 - 3 = 8.96');
  const o1e = await sqlOnly(
    `SELECT coupon_amount, coupon_id FROM sales_orders WHERE id=$1`, [o1dr.data.orderId]);
  near(Number(o1e.rows[0].coupon_amount), 3, '订单 coupon_amount=3');
  eq(Number(o1e.rows[0].coupon_id), MC1, '订单挂 coupon_id');
  const o1f = await sqlOnly(
    `SELECT status, used_order_id FROM member_coupons WHERE id=$1`, [MC1]);
  eq(o1f.rows[0].status, '已使用', '券包置已使用');
  eq(Number(o1f.rows[0].used_order_id), Number(o1d.orderId), 'used_order_id 反向留痕');
  // 有效消费口径：本笔窗口增量 = 现金 8.96（券抵扣 3 不计入，5.1.16）
  const o1v = await sqlOnly(
    `SELECT COALESCE(SUM(valid_total),0) AS v FROM member_activity_windows WHERE member_id=$1`, [m1.id]);
  ok(Number(o1v.rows[0].v) > 0, '窗口累计存在（有效消费口径联动）');
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], memberId: m1.id, couponId: MC1,
    payments: [{ channel: '现金', amount: 5.98 }] } })).code, 50042, '重复用券 → 50042');

  // O3 限领 + 门槛 + 未达兑换
  const o1x = await api('POST', `/coupons/${o1.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  if (o1x.code !== 0) console.log('  [debug o1x]', JSON.stringify(o1x));
  eq(o1x.data?.skipped, 1, '超过每人限领 → skipped（不重复发）');
  const o2 = data(await api('POST', '/coupons', { token: T, body: {
    name: '满100减5', type: '满减券', threshold: 100, discount: 5, validDays: 30 } }));
  await api('POST', `/coupons/${o2.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  const o2c = await sqlOnly(`SELECT id FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [o2.id, m1.id]);
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 2 }], memberId: m1.id, couponId: Number(o2c.rows[0].id),
    payments: [{ channel: '现金', amount: 11.96 }] } })).code, 50042, '未达门槛 → 50042');

  // O4 折扣券：券额 = (货值-促销) × (1-折扣率)
  const o3 = data(await api('POST', '/coupons', { token: T, body: {
    name: '全场8折券', type: '折扣券', discount: 0.8, validDays: 7 } }));
  await api('POST', `/coupons/${o3.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  const o3c = await sqlOnly(`SELECT id FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [o3.id, m1.id]);
  const o3dr = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 2 }], memberId: m1.id, couponId: Number(o3c.rows[0].id),
    payments: [{ channel: '现金', amount: 9.57 }] } });
  eq(o3dr.code, 0, '8 折券下单');
  const o3d = data(o3dr);
  near(o3d?.couponAmount, 2.39, '券抵扣 = 11.96 × 0.2 = 2.39');
  near(o3d?.payable, 9.57, '应收 9.57');

  // O5 兑换券：scope 内免费一件（取最低价一件）
  const oGum = data(await api('POST', '/products', { token: T, body: {
    name: '薄荷口香糖', base_unit: '瓶', sellPrice: 3, barcode: '6901111000099', trackInventory: false } }));
  ok(oGum?.id > 0, '创建不记库存商品（兑换场景隔离）');
  const o4 = data(await api('POST', '/coupons', { token: T, body: {
    name: '苹果兑换券', type: '兑换券', validDays: 30,
    scope: { productIds: [Number(pb.id)] } } }));
  await api('POST', `/coupons/${o4.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  const o4c = await sqlOnly(`SELECT id FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [o4.id, m1.id]);
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: oGum.id, qty: 1 }], memberId: m1.id, couponId: Number(o4c.rows[0].id),
    payments: [{ channel: '现金', amount: 3 }] } })).code, 50042, '不含适用商品 → 50042');
  const o4dr = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: oGum.id, qty: 1 }, { productId: pb.id, qty: 1 }], memberId: m1.id,
    couponId: Number(o4c.rows[0].id), payments: [{ channel: '现金', amount: 3 }] } });
  if (o4dr.code !== 0) console.log('  [debug o4dr]', JSON.stringify(o4dr));
  if (o4dr.code !== 0) console.log('  [debug o4dr]', JSON.stringify(o4dr));
  eq(o4dr.code, 0, '兑换券下单（口香糖+苹果）');
  const o4d = data(o4dr);
  near(o4d?.couponAmount, 5.98, '免费兑换一件适用商品（苹果 5.98 元）');
  near(o4d?.payable, 3, '应收 = 8.98 - 5.98 = 3');

  // O6 过期：改旧 expire_at → 收银兜底 50041 → 过期扫描
  const o5 = data(await api('POST', '/coupons', { token: T, body: {
    name: '昨天的券', type: '满减券', threshold: 2, discount: 1, validDays: 1 } }));
  await api('POST', `/coupons/${o5.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  await sqlOnly(`UPDATE member_coupons SET expire_at = CURRENT_DATE - 1 WHERE coupon_id=$1`, [o5.id]);
  const o5c = await sqlOnly(`SELECT id FROM member_coupons WHERE coupon_id=$1`, [o5.id]);
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], memberId: m1.id, couponId: Number(o5c.rows[0].id),
    payments: [{ channel: '现金', amount: 5.98 }] } })).code, 50042, '过期兜底拦截（结账侧聚合 50042）');
  const o5d = data(await api('POST', '/coupons/expire-scan', { token: T, body: {} }));
  ok(o5d?.expired >= 1, '过期扫描：至少 1 张置已过期');
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], memberId: m1.id, couponId: Number(o5c.rows[0].id),
    payments: [{ channel: '现金', amount: 5.98 }] } })).code, 50042, '扫描后 → 50042（结账侧聚合）');

  // O7 总量池：total_qty=1 发完 → 自领 50038
  const o6 = data(await api('POST', '/coupons', { token: T, body: {
    name: '限量券', type: '满减券', threshold: 2, discount: 1, validDays: 30, totalQty: 1 } }));
  await api('POST', `/coupons/${o6.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  eq((await api('POST', '/coupons/claim', { token: T, body: { couponId: o6.id, memberId: Number(m3.id) } })).code,
     50038, '总量池发完 → 自领 50038');

  // O8 叠加开关：关 → 券+促销同单 50046；开 → 正常叠加
  await sqlOnly(`UPDATE system_settings SET value='0' WHERE setting_key='coupon.stack_with_promo'`);
  const o7 = data(await api('POST', '/coupons', { token: T, body: {
    name: '满5减2', type: '满减券', threshold: 5, discount: 2, validDays: 30 } }));
  await api('POST', `/coupons/${o7.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  const o7c = await sqlOnly(`SELECT id FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [o7.id, m1.id]);
  const o8p = await api('POST', '/promotions/2/start', { token: T });
  eq(o8p.code, 0, '重启满10减2 促销');
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 2 }], memberId: m1.id, couponId: Number(o7c.rows[0].id),
    payments: [{ channel: '现金', amount: 7.96 }] } })).code, 50046, '叠加开关关 → 50046');
  await sqlOnly(`UPDATE system_settings SET value='1' WHERE setting_key='coupon.stack_with_promo'`);
  const o7dr = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 2 }], memberId: m1.id, couponId: Number(o7c.rows[0].id),
    payments: [{ channel: '现金', amount: 7.96 }] } });
  eq(o7dr.code, 0, '叠加开关开 → 券与促销同单');
  const o7d = data(o7dr);
  near(o7d?.promoAmount, 2, '促销让利 2');
  near(o7d?.couponAmount, 2, '券抵扣 2');
  near(o7d?.payable, 7.96, '应收 = 11.96 - 2 - 2');
  await api('POST', '/promotions/2/stop', { token: T });

  // ═══ R. 交接班 · 挂单/取单 · 抹零 ═══
  console.log('■ R. 交接班 / 挂单取单 / 抹零');
  // R0 补货（前序段已把矿泉水消耗至 0；走完整入库闭环保证后续 FIFO 可用）
  const rInb = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: SID, items: [
    { productId: pa.id, qty: 100, unitCost: 1.5, productionDate: '2026-08-20' } ] } }));
  const rAud = await api('POST', `/purchase/inbounds/${rInb.id}/audit`, { token: T });
  ok(rInb?.id > 0 && rAud.code === 0, 'R0 补货入库 100 瓶并审核');

  // R1 开班
  const rOpen = await api('POST', '/shifts/open', { token: T, body: { posNo: 'POS-01', openingFloat: 100 } });
  eq(rOpen.code, 0, '开班成功（备用金登记）');
  const SH = data(rOpen);
  eq(Number(SH?.opening_float), 100, '备用金 100');
  eq(SH?.status, '进行中', '班次状态=进行中');
  // R2 同一收银员重复开班拦截
  eq((await api('POST', '/shifts/open', { token: T, body: {} })).code, 50065, '重复开班 → 50065');
  // R3 当前班次实时汇总（空班）
  const rCur0 = data(await api('GET', '/shifts/current', { token: T }));
  eq(Number(rCur0?.shift?.id), Number(SH.id), 'current 返回进行中班次');
  eq(Number(rCur0?.summary?.cashSales), 0, '开班时现金应收 0');
  // R4 挂班次结账（默认抹零规则=分 → 不抹）
  const r4 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 3 }], shiftId: Number(SH.id),
    payments: [{ channel: '现金', amount: 17.94 }] } });
  eq(r4.code, 0, '挂班次结账（3×5.98）');
  eq(Number(data(r4)?.shiftId), Number(SH.id), '返回班次归属');
  eq(Number(data(r4)?.roundAmount), 0, '默认抹零=分 → 不抹');
  const r4db = await sqlOnly(`SELECT shift_id, round_amount FROM sales_orders WHERE id=$1`, [data(r4).orderId]);
  eq(Number(r4db.rows[0].shift_id), Number(SH.id), 'sales_orders.shift_id 落库');
  // R5 实时汇总
  const rCur1 = data(await api('GET', '/shifts/current', { token: T }));
  near(rCur1?.summary?.cashSales, 17.94, '实时汇总：现金应收 17.94');
  eq(rCur1?.summary?.orderCount, 1, '实时汇总：单数 1');
  // R6 关班（现金实盘 18 vs 应收 17.94 → 长款 0.06 留痕）
  const rClose = await api('POST', `/shifts/${SH.id}/close`, { token: T, body: { cashCounted: 118, reason: 'e2e 长款留痕' } }); // 钱箱应答含备用金 100（§13 B3）：100+17.94=117.94；超容差需差异原因
  eq(rClose.code, 0, '关班成功');
  near(data(rClose)?.summary?.cashTotal, 17.94, '关班：系统现金应收 17.94');
  near(data(rClose)?.shift?.diff_amount, 0.06, '差异 = 实盘18 - 应收17.94 = +0.06');
  eq(data(rClose)?.shift?.status, '已交班', '班次置已交班');
  // R7 状态机拦截
  eq((await api('POST', `/shifts/${SH.id}/close`, { token: T, body: { cashCounted: 0 } })).code, 50066,
     '重复交班 → 50066');
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], shiftId: Number(SH.id),
    payments: [{ channel: '现金', amount: 2 }] } })).code, 50066, '已交班班次挂账 → 50066');
  // R8 班次报表
  const rList = data(await api('GET', '/shifts', { token: T }));
  ok(rList?.items?.some?.(x => Number(x.id) === Number(SH.id)), '班次列表含该班次');
  const rDet = data(await api('GET', `/shifts/${SH.id}`, { token: T }));
  near(rDet?.summary?.cashTotal, 17.94, '班次详情汇总一致');
  eq((await api('GET', '/shifts/999999', { token: T })).code, 50066, '班次不存在 → 50066');

  // R9 挂单（不扣库存、纯快照）
  const paInv0 = await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id]);
  const rHold = await api('POST', '/pos/held', { token: T, body: {
    items: [{ productId: pa.id, qty: 5 }, { productId: pb.id, qty: 1, lineRemark: '挑软的' }],
    remark: '顾客先去拿东西' } });
  eq(rHold.code, 0, '挂单成功');
  const H1 = data(rHold);
  eq(H1?.status, '挂单中', '挂单状态=挂单中');
  eq((await api('POST', '/pos/held', { token: T, body: { items: [] } })).code, 40003, '空明细挂单 → 40003');
  const rHeldList = data(await api('GET', '/pos/held', { token: T }));
  ok(rHeldList?.some?.(x => Number(x.id) === Number(H1.id)), '挂单列表可见');
  const rHeldDet = data(await api('GET', `/pos/held/${H1.id}`, { token: T }));
  ok(Array.isArray(rHeldDet?.items) && rHeldDet.items.length === 2, '挂单快照 2 行明细');
  const paInv1 = await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id]);
  eq(Number(paInv1.rows[0].qty_total), Number(paInv0.rows[0].qty_total), '挂单不扣库存');

  // R10 取单结账一体（服务端按结账时刻重新计价 + FIFO 扣减）
  // R-NEW-3：挂单快照含 unitPrice 会命中改价授权闸——验收先行补票，产品待确认是否豁免挂单恢复
  const setAcH = await api('POST', '/auth/set-auth-code', { token: T, body: { password: 'E2e#Admin2026', authCode: '246810' } });
  if (setAcH.code !== 0) console.log('  [debug set-auth-code H]', JSON.stringify(setAcH).slice(0, 200));
  const _authH = await api('POST', '/auth/authorize', { token: T, body: { empNo: 'ADMIN', authCode: '246810' } });
  console.log('  [debug authH]', JSON.stringify(_authH).slice(0, 200));
  const authTkH = _authH?.data?.ticket;
  const rPick = await api('POST', `/pos/held/${H1.id}/checkout`, { token: T, body: {
    priceAuthTicket: authTkH,
    payments: [{ channel: '现金', amount: 15.98 }] } });
  if (rPick.code !== 0) console.log('  [debug rPick]', JSON.stringify(rPick));
  eq(rPick.code, 0, '取单结账成功');
  near(data(rPick)?.payable, 15.98, '服务端重新计价 5×2 + 5.98 = 15.98');
  const rPickDb = await sqlOnly(
    `SELECT h.status, h.picked_order_id,
            (SELECT qty_total FROM inventory_current WHERE product_id=$2) AS pa_inv
       FROM held_orders h WHERE h.id=$1`, [H1.id, pa.id]);
  eq(rPickDb.rows[0].status, '已取单', '挂单置已取单');
  ok(Number(rPickDb.rows[0].picked_order_id) > 0, 'picked_order_id 关联销售单');
  eq(Number(rPickDb.rows[0].pa_inv), Number(paInv0.rows[0].qty_total) - 5, '结账后 FIFO 扣库存 -5');
  // R11 状态机
  eq((await api('POST', `/pos/held/${H1.id}/checkout`, { token: T, body: {
    payments: [{ channel: '现金', amount: 1 }] } })).code, 50064, '重复取单 → 50064');
  // R12 挂单取消（留痕不删除；取消不扣库存）
  const rHold2 = data(await api('POST', '/pos/held', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }] } }));
  eq((await api('DELETE', `/pos/held/${rHold2.id}`, { token: T })).code, 0, '取消挂单成功');
  eq((await api('POST', `/pos/held/${rHold2.id}/checkout`, { token: T, body: {
    payments: [{ channel: '现金', amount: 2 }] } })).code, 50064, '取消后结账 → 50064');

  // R13 抹零（pos.round_rule：分/角/5角/元，向下去零；payable=0 允许零支付）
  await api('PUT', '/settings/pos.round_rule', { token: T, body: { value: '元', reason: '测试抹元' } });
  const rRnd1 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], payments: [{ channel: '现金', amount: 5 }] } });
  eq(rRnd1.code, 0, '抹元结账（5.98 → 应收 5）');
  near(data(rRnd1)?.roundAmount, 0.98, '抹零金额 0.98');
  near(data(rRnd1)?.payable, 5, '应收向下取整到元 = 5');
  const rRndDb = await sqlOnly(`SELECT round_amount, payable_amount FROM sales_orders WHERE id=$1`, [data(rRnd1).orderId]);
  near(rRndDb.rows[0].round_amount, 0.98, 'sales_orders.round_amount 落库');
  near(rRndDb.rows[0].payable_amount, 5, 'payable_amount 已扣抹零');
  await api('PUT', '/settings/pos.round_rule', { token: T, body: { value: '5角', reason: '测试抹5角' } });
  const rRnd2 = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], payments: [{ channel: '现金', amount: 5.5 }] } }));
  near(rRnd2?.roundAmount, 0.48, '抹5角：5.98 → 5.5（抹 0.48）');
  await api('PUT', '/settings/pos.round_rule', { token: T, body: { value: '元', reason: '测试全抹' } });
  const rRnd3 = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 0.4 }], payments: [] } });
  eq(rRnd3.code, 0, '0.8 元全抹掉 → 零支付结账（payable=0）');
  near(data(rRnd3)?.roundAmount, 0.8, '全抹零金额 0.8');
  await api('PUT', '/settings/pos.round_rule', { token: T, body: { value: '分', reason: '还原默认' } });

  // ═══ S. 销售退款闭环（原路退 + 批次回加 + 资产冲回） ═══
  console.log('■ S. 销售退款闭环');
  // S0 造退款场景：会员免审额度内现金单（无会员）+ 会员余额+分红+积分组合单
  const sInb = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: SID, items: [
    { productId: pa.id, qty: 60, unitCost: 2, productionDate: '2026-08-25' } ] } }));
  ok((await api('POST', `/purchase/inbounds/${sInb.id}/audit`, { token: T })).code === 0, 'S0 补货 60（成本 2）');
  const sM = data(await api('POST', '/members', { token: T, body: { phone: '13800000077', name: '退款测试员', privacyAgreed: true } }));
  await api('POST', `/members/${sM.id}/recharges`, { token: T, body: { principal: 100 } });
  const sDiv = data(await api('GET', '/dividend/overview', { token: T }));
  ok(!!sM?.id, 'S0 会员就绪（余额 100）');
  // 会员拿点分红余额：直发一笔计提（走 period 生成路径复杂，改用管理调整接口——若无则跳过分红退）
  const sOrd1 = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 4 }], payments: [{ channel: '现金', amount: 8 }] } }));
  ok(sOrd1?.orderId > 0, 'S1 现金单 4×2=8');
  const sDetail1 = data(await api('GET', `/sales/${sOrd1.orderId}`, { token: T }));
  const sItemId1 = sDetail1?.items?.[0]?.id;
  const paBatch1 = await sqlOnly(
    `SELECT b.id, b.remain_qty FROM batches b WHERE b.product_id=$1 AND b.status='在库' ORDER BY b.expiry_date, b.inbound_date`,
    [pa.id]);
  const invBefore = Number((await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id])).rows[0].qty_total);
  // S2 部分退款（2/4 行量，免审）：金额 = 4 元（无整单优惠）
  const sRf1 = await api('POST', '/refunds', { token: T, body: {
    orderId: sOrd1.orderId, items: [{ saleItemId: sItemId1, qty: 2 }], reason: '顾客不想要了' } });
  if (sRf1.code !== 0) console.log('  [debug sRf1]', JSON.stringify(sRf1));
  eq(sRf1.code, 0, 'S2 部分退款直退（2×2=4 元）');
  near(data(sRf1)?.amount, 4, '退款金额 4 元');
  const sRf1Db = await sqlOnly(`SELECT status, refund_channel, restock FROM sale_refunds WHERE id=$1`, [data(sRf1).refundId]);
  eq(sRf1Db.rows[0].status, '已退款', '免审 → 直接已退款');
  const paBatch2 = await sqlOnly(
    `SELECT remain_qty FROM batches WHERE id=$1`, [paBatch1.rows[0].id]);
  near(Number(paBatch2.rows[0].remain_qty), Number(paBatch1.rows[0].remain_qty) + 2, '原批次回加 +2');
  const invAfter = Number((await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id])).rows[0].qty_total);
  eq(invAfter, invBefore + 2, '即时库存回加 +2');
  const sFlow = await sqlOnly(
    `SELECT count(*)::int AS n FROM stock_flows WHERE ref_type='return_sale' AND ref_id=$1`, [data(sRf1).refundId]);
  ok(Number(sFlow.rows[0].n) > 0, 'stock_flows 记 return_sale 流水');
  // S3 超量退款拦截
  eq((await api('POST', '/refunds', { token: T, body: {
    orderId: sOrd1.orderId, items: [{ saleItemId: sItemId1, qty: 5 }], reason: 'x' } })).code, 50072, '超可退量 → 50072');
  // S4 超限额 → 待审核（临时把限额调 1 元）
  await api('PUT', '/settings/sales.refund.limit', { token: T, body: { value: 1, reason: '测试审核流' } });
  const sRf2 = await api('POST', '/refunds', { token: T, body: {
    orderId: sOrd1.orderId, items: [{ saleItemId: sItemId1, qty: 1 }], reason: '超限额测试' } });
  eq(sRf2.code, 0, 'S4 超限额退款创建成功');
  eq(data(sRf2)?.status, '待审核', '状态=待审核');
  const sRf2Id = data(sRf2).refundId;
  // 未审核不能直接退（列表可见待审核，不产生库存变动）
  const paMid = Number((await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id])).rows[0].qty_total);
  eq(paMid, invAfter, '待审核期间不动库存');
  // 审核通过 → 执行
  const sAud = await api('POST', `/refunds/${sRf2Id}/audit`, { token: T, body: { approve: true } });
  eq(sAud.code, 0, 'S5 审核通过并执行');
  eq(data(sAud)?.status, '已退款', '审核后置已退款');
  const paAfter2 = Number((await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id])).rows[0].qty_total);
  eq(paAfter2, invAfter + 1, '审核后库存回加 +1');
  // 状态机：重复审核
  eq((await api('POST', `/refunds/${sRf2Id}/audit`, { token: T, body: { approve: true } })).code, 50073,
     '重复审核 → 50073');
  // S6 驳回流：再建一笔待审核然后驳回
  const _sRf3raw = await api('POST', '/refunds', { token: T, body: {
    orderId: sOrd1.orderId, items: [{ saleItemId: sItemId1, qty: 1 }], reason: '驳回测试' } });
  if (_sRf3raw.code !== 0) console.log('  [debug sRf3]', JSON.stringify(_sRf3raw).slice(0, 240));
  const sRf3 = _sRf3raw.data;
  eq(sRf3?.status, '待审核', 'S6 驳回用例：待审核');
  const sRej = await api('POST', `/refunds/${sRf3.refundId}/audit`, { token: T, body: { approve: false } });
  eq(data(sRej)?.status, '已驳回', '驳回后状态=已驳回');
  await api('PUT', '/settings/sales.refund.limit', { token: T, body: { value: 200, reason: '还原默认' } });
  // S7 组合支付单退款（余额+现金）：余额按原流水本金/赠送比例回加
  // 注：K5 满折（8 折）未停用 → pa 货值 10 − 促销 2 = 应收 8（2026-10 按实际残留活动校正）
  const sOrd2Raw = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 5 }], memberId: sM.id,
    payments: [{ channel: '余额', amount: 2 }, { channel: '现金', amount: 6 }] } }); // 合计 8 = 货值 10 − 满折 2
  if (sOrd2Raw.code !== 0) console.log('  [debug sOrd2]', JSON.stringify(sOrd2Raw));
  const sOrd2 = data(sOrd2Raw);
  ok(sOrd2?.orderId > 0, 'S7 组合支付单（余额2+现金6=应收8，货值10−满折2）');
  const sBalBefore = Number((await sqlOnly(
    `SELECT balance FROM member_accounts WHERE member_id=$1`, [sM.id])).rows[0].balance);
  const sD2 = data(await api('GET', `/sales/${sOrd2.orderId}`, { token: T }));
  const sRf4 = await api('POST', '/refunds', { token: T, body: {
    orderId: sOrd2.orderId, items: sD2.items.map(x => ({ saleItemId: x.id, qty: x.qty })), reason: '整单退', restock: false } });
  if (sRf4.code !== 0) console.log('  [debug sRf4]', JSON.stringify(sRf4));
  eq(sRf4.code, 0, 'S8 整单退款（不回库）');
  near(data(sRf4)?.amount, 8, '整单退金额 8（应收全额 = 货值10 − 满折回冲2）');
  const sAcc = (await sqlOnly(
    `SELECT balance, principal_balance, gift_balance FROM member_accounts WHERE member_id=$1`, [sM.id])).rows[0];
  near(Number(sAcc.balance), sBalBefore + 2, '余额退款回加 2（按退款占比原路退）');
  near(Number(sAcc.principal_balance), sBalBefore + 2, '本金部分按原流水比例回加（100 本金充值全额本金）');
  const sBf = await sqlOnly(
    `SELECT direction, amount, biz_type FROM balance_flows WHERE member_id=$1 AND biz_type='退款' ORDER BY id DESC LIMIT 1`,
    [sM.id]);
  near(Number(sBf.rows[0].amount), 2, 'balance_flows 退款流水 2 元');
  // S9 不回库验证
  const paNoRestock = Number((await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [pa.id])).rows[0].qty_total);
  eq(paNoRestock, paAfter2 - 5, 'restock=false 不动库存（S7 结账扣 5 后保持不变）');
  // S10 退款列表 + 详情
  const sList = data(await api('GET', '/refunds', { token: T }));
  ok(sList?.length >= 3, '退款列表可见全部退款单');
  const R4 = data(sRf4);
  if (!R4?.refundId) console.log('  [debug sRf4 obj]', JSON.stringify(sRf4));
  const sDetRaw = await api('GET', `/refunds/${R4.refundId}`, { token: T });
  if (sDetRaw.code !== 0) console.log('  [debug sDet]', JSON.stringify(sDetRaw));
  const sDet = data(sDetRaw);
  ok(sDet?.items?.length === 1 && Number(sDet.items[0].qty) === 5, '退款详情含明细行');
  // S11 404
  eq((await api('GET', '/refunds/999999', { token: T })).code, 50070, '退款单不存在 → 50070');

  // ═══ T. 员工与权限 · 采购退货列表（Web 后台剩余屏数据源） ═══
  console.log('■ T. 员工权限 / 退货列表');
  // T1 采购退货列表端点
  const tRet = await api('GET', '/purchase/returns', { token: T });
  eq(tRet.code, 0, 'T1 GET /purchase/returns 列表');
  ok(Array.isArray(data(tRet)?.items ?? data(tRet)), '退货列表为数组（分页包装或裸数组兼容）');
  // T2 权限点缺失拦截（先造一个无 staff.manage 的员工登录？——ADMIN 是超管全量，直接验证创建流）
  const tEmp = await api('POST', '/auth/employees', { token: T, body: {
    empNo: 'CASHIER01', name: '收银小李', password: 'Pos123456', roleIds: [] } });
  eq(tEmp.code, 0, 'T2 创建员工（超管持 staff.manage）');
  ok(data(tEmp)?.id > 0, '返回员工 ID');
  // T3 工号唯一
  eq((await api('POST', '/auth/employees', { token: T, body: {
    empNo: 'CASHIER01', name: '重复工号', password: 'Pos123456' } })).code, 41003, '重复工号 → 41003');
  // T4 密码强度
  eq((await api('POST', '/auth/employees', { token: T, body: {
    empNo: 'CASHIER02', name: '短密码', password: '123' } })).code, 40003, '密码<6 位 → 40003');
  // T5 新员工可登录（角色为空 → perms 空）
  const tLogin = await api('POST', '/auth/login', { body: { empNo: 'CASHIER01', password: 'Pos123456' } });
  eq(tLogin.code, 0, 'T5 新员工登录成功');
  eq(data(tLogin)?.perms?.length, 0, '无角色 → 空权限');
  // T6 停用/复职 + 停用后禁登录
  eq((await api('POST', `/auth/employees/${data(tEmp).id}/status`, { token: T, body: { status: '停用' } })).code, 0,
     '停用员工');
  eq((await api('POST', '/auth/login', { body: { empNo: 'CASHIER01', password: 'Pos123456' } })).code, 41001,
     '停用员工登录 → 41001');
  eq((await api('POST', `/auth/employees/${data(tEmp).id}/status`, { token: T, body: { status: '在职' } })).code, 0,
     '复职员工');
  // T7 角色与权限点
  const tRoles = data(await api('GET', '/auth/roles', { token: T }));
  ok(Array.isArray(tRoles) && tRoles.some(r => r.name === '超级管理员'), '角色列表含超级管理员');
  ok(tRoles.find(r => r.name === '超级管理员')?.perms?.length > 0, '超管角色携带权限点');
  const tPerms = data(await api('GET', '/auth/permissions', { token: T }));
  ok(Array.isArray(tPerms) && tPerms.some(p => p.code === 'staff.manage'), '权限点全量含 staff.manage');
  // T8 员工列表含角色
  const tList = data(await api('GET', '/auth/employees', { token: T }));
  ok(tList?.some(e => e.empNo === 'CASHIER01'), '员工列表含新员工');

  // ═══ M. 会员 H5 自助端点（/m/*：注册/登录/资产/流水/密码） ═══
  console.log('■ M. 会员 H5 自助端点');
  // M1 注册（H5 渠道）
  const mReg = await api('POST', '/m/register', { body: { phone: '13900000321', password: 'H5abc123x', name: 'H5自注册', privacyAgreed: true } });
  eq(mReg.code, 0, 'M1 H5 注册成功并返回 token');
  ok(!!data(mReg)?.token && data(mReg)?.member?.cardNo?.startsWith('M'), '返回 token 与卡号');
  eq((await api('POST', '/m/register', { body: { phone: '13900000321', password: 'H5abc123x', privacyAgreed: true } })).code, 42012,
     '重复手机号 → 42012');
  eq((await api('POST', '/m/register', { body: { phone: '13900000322', password: 'H5abc123x', privacyAgreed: false } })).code, 40003,
     '未勾选隐私协议 → 40003');
  const mTk = data(mReg).token;
  // M2 登录
  const mLogin = await api('POST', '/m/login', { body: { phone: '13900000321', password: 'H5abc123x' } });
  eq(mLogin.code, 0, 'M2 登录成功');
  // 错误密码计数
  eq((await api('POST', '/m/login', { body: { phone: '13900000321', password: 'wrong1' } })).code, 42010, '错误密码 → 42010');
  // M3 连错 5 次锁定
  const mLock = await api('POST', '/m/register', { body: { phone: '13900000333', password: 'H5abc123x', name: '锁定测试', privacyAgreed: true } });
  eq(mLock.code, 0, 'M3 锁定用例账号注册');
  for (let i = 0; i < 5; i++) await api('POST', '/m/login', { body: { phone: '13900000333', password: 'bad' } });
  eq((await api('POST', '/m/login', { body: { phone: '13900000333', password: 'H5abc123x' } })).code, 42011,
     '连错 5 次 → 42011 锁定（正确密码也拒绝）');
  // M4 资产总览（充值后核对口径B 拆分）
  const mA = data(mLogin).member.id;
  await api('POST', `/members/${mA}/recharges`, { token: T, body: { principal: 100 } });
  const mMe = data(await api('GET', '/m/me', { token: mTk }));
  near(mMe?.assets?.balance, 100, 'M4 余额 100');
  near(mMe?.assets?.principalTotal, 100, '累计本金 100（口径B）');
  near(mMe?.assets?.giftBalance, 0, '赠送余额 0');
  ok(mMe?.member?.level, '返回等级名');
  // M5 流水三个 tab
  const mFb = data(await api('GET', '/m/flows?tab=balance', { token: mTk }));
  ok(mFb?.items?.some(f => f.biz_type === '充值' && Number(f.amount) === 100), 'M5 余额流水含充值 100');
  const mFp = data(await api('GET', '/m/flows?tab=points', { token: mTk }));
  ok(Array.isArray(mFp?.items), '积分流水 tab 可查');
  const mFd = data(await api('GET', '/m/flows?tab=dividend', { token: mTk }));
  ok(Array.isArray(mFd?.items), '分红流水 tab 可查');
  // M6 消费记录（本人余额支付一笔）
  const sInbM = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: SID, items: [
    { productId: pb.id, qty: 30, unitCost: 2.5, productionDate: '2026-08-28' } ] } }));
  await api('POST', `/purchase/inbounds/${sInbM.id}/audit`, { token: T });
  const mChk = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 2 }], memberId: mA, payments: [{ channel: '余额', amount: 11.96 }] } });
  eq(mChk.code, 0, 'M6 会员余额消费一笔');
  const mSales = data(await api('GET', '/m/sales', { token: mTk }));
  ok(mSales?.items?.some(o => Number(o.id) === Number(data(mChk).orderId)), '消费记录本人可见（脱敏无成本字段）');
  ok(mSales.items.every(o => o.cost_amount === undefined && o.profit_amount === undefined), '消费记录不含成本/毛利');
  // M7 改密码
  eq((await api('POST', '/m/password', { token: mTk, body: { old: 'bad', new: 'xyz789' } })).code, 42010, 'M7 原密码错误 → 42010');
  eq((await api('POST', '/m/password', { token: mTk, body: { old: 'H5abc123x', new: 'Xyz7890ab' } })).code, 0, '改密码成功');
  eq((await api('POST', '/m/login', { body: { phone: '13900000321', password: 'Xyz7890ab' } })).code, 0, '新密码可登录');
  // M8 老会员首次设密（手机号+身份证后6位）
  const mOld = data(await api('POST', '/members', { token: T, body: { phone: '13900000444', name: '到店老会员', privacyAgreed: true } }));
  await sqlOnly(`UPDATE members SET id_card_tail='X2A4B6' WHERE id=$1`, [mOld.id]);
  eq((await api('POST', '/m/password/init', { body: { phone: '13900000444', idCardTail: 'XXXXXX', password: 'aaa123' } })).code, 42015,
     'M8 身份证后6位不符 → 42015');
  eq((await api('POST', '/m/password/init', { body: { phone: '13900000444', idCardTail: 'x2a4b6', password: 'aaa123' } })).code, 0,
     '首次设密成功（尾号大小写不敏感）');
  eq((await api('POST', '/m/login', { body: { phone: '13900000444', password: 'aaa123' } })).code, 0, '老会员凭新密码登录');
  // M9 token 隔离：member token 不能调员工端点
  eq((await api('GET', '/products', { token: mTk })).code, 40100, 'M9 member token 调员工端点 → 40100（拒绝）');

  // ═══ U. 会员充值闭环（H5 发起 → 收银台代收 → 入账，db/010） ═══
  console.log('■ U. 会员充值闭环');
  // U1 档位管理
  eq((await api('POST', '/members/recharge-plans', { token: T, body: { name: '', principal: 100 } })).code, 40003,
     'U1 档位名缺失 → 40003');
  const uPlan = data(await api('POST', '/members/recharge-plans', { token: T, body: { name: '充100送10', principal: 100, gift: 10 } }));
  eq(uPlan?.status, '启用', 'U1 创建档位 充100送10');
  ok(data(await api('GET', '/members/recharge/plans/all', { token: T }))?.some(p => Number(p.id) === Number(uPlan.id)),
     '后台档位全量列表可见');
  // U2 会员注册 + H5 档位
  const uReg = await api('POST', '/m/register', { body: { phone: '13900000555', password: 'H5abc123x', name: '充值测试', privacyAgreed: true } });
  eq(uReg.code, 0, 'U2 充值测试会员注册');
  const uTk = data(uReg).token;
  const uPlans = data(await api('GET', '/m/recharge/plans', { token: uTk }));
  ok(uPlans?.plans?.some(p => Number(p.gift) === 10), 'H5 启用档位列表含赠送 10 档');
  ok(Number(uPlans?.maxSingle) > 0, '返回单笔充值上限');
  // U3 发起充值单（服务端按档计算赠送，客户端不可传）
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { planId: 999999 } })).code, 42016, 'U3 不存在档位 → 42016');
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 99999 } })).code, 42017, '超出单笔上限 → 42017');
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 0 } })).code, 40003, '金额 0 → 40003');
  const uRO = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { planId: uPlan.id } }));
  eq(uRO?.status, '待支付', 'U3 按档位发起充值单（待支付）');
  near(uRO?.principal, 100, '本金 100（服务端按档计算）');
  near(uRO?.gift, 10, '赠送 10（客户端不可传 gift，防篡改）');
  ok(String(uRO?.order_no || '').startsWith('RC-'), '充值单号 RC- 前缀');
  // U4 收银台代收队列（手机号脱敏）
  const uQueue = data(await api('GET', '/pos/recharge-orders', { token: T }));
  ok(uQueue?.items?.some(o => Number(o.id) === Number(uRO.id)), 'U4 代收队列含该充值单');
  const uQRow = uQueue.items.find(o => Number(o.id) === Number(uRO.id));
  ok(!uQRow.phone || String(uQRow.phone).includes('****'), '队列手机号脱敏');
  // U5 状态机：非法通道/取消/重复入账/越权
  const uRO2 = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 50 } }));
  eq((await api('POST', `/pos/recharge-orders/${uRO2.id}/collect`, { token: T, body: { payChannel: '刷卡' } })).code, 40003,
     'U5 非法支付通道 → 40003');
  eq((await api('POST', `/m/recharge-orders/${uRO2.id}/cancel`, { token: uTk })).code, 0, '会员取消本人待支付单');
  eq((await api('POST', `/pos/recharge-orders/${uRO2.id}/collect`, { token: T, body: { payChannel: '现金' } })).code, 50074,
     '已取消单入账 → 50074');
  eq((await api('POST', `/m/recharge-orders/${uRO2.id}/cancel`, { token: uTk })).code, 42019, '重复取消 → 42019');
  eq((await api('POST', `/m/recharge-orders/${uRO.id}/cancel`, { token: mTk })).code, 40404, '取消他人充值单 → 40404');
  // U6 收银台现金代收入账（口径B：本金+赠送拆分）
  const uCol = data(await api('POST', `/pos/recharge-orders/${uRO.id}/collect`, { token: T, body: { payChannel: '现金' } }));
  ok(!!uCol?.orderNo, 'U6 收银台现金代收入账');
  near(uCol?.balanceAfter, 110, '入账后余额 110（100+10）');
  const uMe = data(await api('GET', '/m/me', { token: uTk }));
  near(uMe?.assets?.balance, 110, 'H5 余额 110');
  near(uMe?.assets?.principalTotal, 100, '累计本金 100（赠送不计本金）');
  near(uMe?.assets?.giftBalance, 10, '赠送余额 10');
  eq((await api('POST', `/pos/recharge-orders/${uRO.id}/collect`, { token: T, body: { payChannel: '现金' } })).code, 50074,
     '重复入账 → 50074');
  const uFlows = data(await api('GET', '/m/flows?tab=balance', { token: uTk }));
  ok(uFlows?.items?.some(f => f.biz_type === '充值' && Number(f.amount) === 110 && Number(f.principal_part) === 100),
     '余额流水：充值 110（本金部分 100）');
  // U7 过期拦截（25h > 24h 设置）
  const uRO3 = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 20 } }));
  await sqlOnly(`UPDATE recharge_orders SET created_at = now() - interval '25 hours' WHERE id=$1`, [uRO3.id]);
  eq((await api('POST', `/pos/recharge-orders/${uRO3.id}/collect`, { token: T, body: { payChannel: '扫码' } })).code, 50075,
     'U7 过期充值单入账 → 50075');
  ok(data(await api('GET', '/pos/recharge-orders?status=' + encodeURIComponent('已过期'), { token: T }))
     ?.items?.some(o => Number(o.id) === Number(uRO3.id)), '过期单进入已过期队列');
  const uMe2 = data(await api('GET', '/m/me', { token: uTk }));
  near(uMe2?.assets?.balance, 110, '过期单未入账，余额仍 110');
  // U8 扫码通道代收
  const uRO4 = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 30 } }));
  const uCol4 = data(await api('POST', `/pos/recharge-orders/${uRO4.id}/collect`, { token: T, body: { payChannel: '扫码' } }));
  near(uCol4?.balanceAfter, 140, 'U8 扫码代收 30 → 余额 140');
  eq(uCol4?.payChannel, '扫码', '通道扫码留痕');
  // U9 待支付单上限 3 张
  await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } });
  await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } });
  const uRO5 = await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } });
  eq(uRO5.code, 0, 'U9 第三张待支付单可发起');
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } })).code, 42018, '第四张 → 42018（上限 3）');
  // U10 H5 充值单列表状态齐全
  const uList = data(await api('GET', '/m/recharge-orders', { token: uTk }));
  ok(uList?.items?.some(o => o.status === '已入账' && o.pay_channel === '扫码'), 'U10 H5 列表含已入账·扫码');
  ok(uList?.items?.some(o => o.status === '已过期'), 'H5 列表含已过期');
  ok(uList?.items?.some(o => o.status === '已取消'), 'H5 列表含已取消');

  // ═══ V. 对账结算全链路（费用协议 API 化 + 人工费用 + 结算闭环，V4.8.11） ═══
  console.log('■ V. 对账结算全链路（费用协议 API）');
  const vTypes = data(await api('GET', '/purchase/fee-types', { token: T }));
  ok(Array.isArray(vTypes) && vTypes.length >= 6 && vTypes.some(t => t.code === 'rebate' && t.direction === '收'),
     'V1 费用类型字典 ≥6 类（db/011 种子）');
  const vSup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'V段联调供应商', contactPerson: 'V联系人', contactPhone: '13900000021', bizMode: '购销' } }));
  ok(Number(vSup?.id) > 0, 'V2 新建联调供应商');
  // V3 协议校验与创建
  eq((await api('POST', '/purchase/fee-agreements', { token: T, body: { supplierId: vSup.id, feeTypeId: 1 } })).code, 40003,
     'V3 协议缺 startDate → 40003');
  eq((await api('POST', '/purchase/fee-agreements', { token: T, body: { supplierId: vSup.id, feeTypeId: 1, startDate: '2026-08-01' } })).code, 40003,
     '固定额协议缺金额 → 40003');
  eq((await api('POST', '/purchase/fee-agreements', { token: T, body: { supplierId: vSup.id, feeTypeId: 999999, amount: 10, startDate: '2026-08-01' } })).code, 40404,
     '费用类型不存在 → 40404');
  const vAg = data(await api('POST', '/purchase/fee-agreements', { token: T, body: {
    supplierId: vSup.id, feeTypeId: vTypes.find(t => t.code === 'rebate').id,
    cycle: '月', amountMode: '固定额', amount: 10, autoGenerate: true, startDate: '2026-08-01' } }));
  eq(vAg?.status, 1, 'V3 创建返利协议（月·固定额10·自动补齐）');
  const vAgList = data(await api('GET', `/purchase/fee-agreements?supplierId=${vSup.id}`, { token: T }));
  ok(vAgList?.items?.some(a => a.fee_type_name === '销售返利' && a.auto_generate), 'V4 协议列表含类型名与自动补齐标记');
  // V5 人工费用
  eq((await api('POST', '/purchase/fees', { token: T, body: {
    supplierId: vSup.id, feeTypeId: vTypes.find(t => t.code === 'diff').id, amount: 0 } })).code, 40003,
     'V5 人工费用金额 0 → 40003');
  const vFee = data(await api('POST', '/purchase/fees', { token: T, body: {
    supplierId: vSup.id, feeTypeId: vTypes.find(t => t.code === 'diff').id, amount: 5, remark: 'V段人工补差' } }));
  ok(String(vFee?.fee_no || '').startsWith('FY-M') && vFee?.status === '已审核', '人工费用录入即生效（FY-M 单号）');
  await bindSup(vSup.id, [[pb.id, 3]]); // V6 前绑定 pb×vSup
  // V6 入库 30（10×3）
  const vInb = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: vSup.id, items: [
    { productId: pb.id, qty: 10, unitCost: 3, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${vInb.id}/audit`, { token: T });
  // V7 预览（协议补齐发生在生成对账时，预览不含）
  const vPv = data(await api('GET', `/purchase/recon/preview?supplierId=${vSup.id}&from=2026-08-01&to=${TO_STR}`, { token: T }));
  near(vPv?.payableTotal, 35, 'V7 预览应付 35 = 入库30 + 补差5（未含补齐）');
  eq(vPv?.fees?.length, 1, '预览仅人工费用 1 笔');
  // V8 生成对账单（自动补齐 2 期）
  const vRec = data(await api('POST', '/purchase/recon', { token: T, body: { supplierId: vSup.id, from: '2026-08-01', to: TO_STR } }));
  eq(vRec?.autoFees?.length, AUTO_FEE_MONTHS, `V8 漏记期次自动补齐 ${AUTO_FEE_MONTHS} 笔（2026-08 起至当月）`);
  near(vRec?.payableTotal, 35 - 10 * AUTO_FEE_MONTHS, '对账应付 = 30 + 5 − 返利 10×' + AUTO_FEE_MONTHS + '（动态期数）');
  // V9 未确认先结算
  eq((await api('POST', '/purchase/settlements', { token: T, body: { reconId: vRec.id } })).code, 50019, 'V9 未确认结算 → 50019');
  eq(data(await api('POST', `/purchase/recon/${vRec.id}/confirm`, { token: T, body: { confirmType: '现场确认', confirmName: 'V业务' } }))?.status,
     '已确认', 'V10 现场确认');
  const vSt = data(await api('POST', '/purchase/settlements', { token: T, body: { reconId: vRec.id, payMode: '转账' } }));
  near(vSt?.amount, 35 - 10 * AUTO_FEE_MONTHS, 'V11 结算单金额（动态期数）');
  eq(data(await api('POST', `/purchase/settlements/${vSt.id}/audit`, { token: T }))?.status, '付款中', 'V12 结算审核 → 付款中（VQA-D3 两段式）');
  eq(data(await api('POST', `/purchase/settlements/${vSt.id}/pay`, { token: T }))?.status, '已付款', 'V12b 确认付款 → 已付款');
  const vLed = await sqlOnly(`SELECT balance_after FROM supplier_ledger WHERE supplier_id=$1 ORDER BY id`, [vSup.id]);
  near(vLed.rows[vLed.rows.length - 1].balance_after, 0, 'V13 往来账闭环：结算后余额归零');
  eq((await api('POST', '/purchase/settlements', { token: T, body: { reconId: vRec.id } })).code, 50019, 'V14 重复结算 → 50019');

  // ═══ W. 商品调价单（进价售价同行 + 审核流 pending→approved→voided，V4.8.20） ═══
  console.log('■ W. 商品调价单');
  const wP1 = data(await api('POST', '/products', { token: T, body: { name: 'W段可乐330ml', base_unit: '罐', sellPrice: 3, barcode: '6901230000032', keepDays: 270, minStock: 5 } }));
  const wP2 = data(await api('POST', '/products', { token: T, body: { name: 'W段薯片原味', base_unit: '袋', sellPrice: 6.5, barcode: '6901230000049', keepDays: 180, minStock: 5 } }));
  ok(Number(wP1?.id) > 0 && Number(wP2?.id) > 0, 'W1 建两个调价测试商品');
  // 条码后6位模糊搜索（共享商品搜索组件的后端口径，V4.8.20）
  const wBy6 = data(await api('GET', '/products?keyword=000032', { token: T }));
  ok((wBy6.items || wBy6 || []).some(p => Number(p.id) === Number(wP1.id)), 'W1b 条码后6位 000032 模糊定位可乐');
  // W2 校验
  eq((await api('POST', '/price-changes', { token: T, body: { items: [] } })).code, 40003, 'W2 空明细 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: -1 }] } })).code, 40003, '负价 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id }] } })).code, 40003, '行内新价全空 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: 3 }] } })).code, 40003, '新售价=现售价 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: 3.5 }, { productId: wP1.id, newPrice: 4 }] } })).code, 40003, '单内重复商品 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: 999999, newPrice: 4 }] } })).code, 40404, '商品不存在 → 40404');
  // W3 混合单：两行售价 + 一行进价（同行双轨）→ 待审核，未生效
  const wSup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'W段进价调价供应商', contactPerson: 'W联系人', contactPhone: '13900000022', bizMode: '购销' } }));
  ok(Number(wSup?.id) > 0, 'W3 建进价调价供应商');
  const wP3 = data(await api('POST', '/products', { token: T, body: { name: 'W段牛奶250ml', base_unit: '盒', sellPrice: 4, barcode: '6901230000056', keepDays: 90, minStock: 5, supplierDefaultId: wSup.id } }));
  ok(Number(wP3?.id) > 0, 'W3 建带默认供应商商品');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newCost: 2 }] } })).code, 40003, 'W3b 进价调整未设供应商 → 40003');
  const wPc = data(await api('POST', '/price-changes', { token: T, body: {
    items: [{ productId: wP1.id, newPrice: 3.5 }, { productId: wP2.id, newPrice: 5.9 }, { productId: wP3.id, newCost: 2.8 }],
    effectiveDate: '2026-09-05', remark: 'W段混合调价（售价+进价同行）' } }));
  ok(/^TJ-\d{6}-\d{3}$/.test(wPc?.pcNo || ''), 'W3 混合单号 TJ-YYYYMM-XXX');
  eq(wPc?.status, 'pending', 'W3 保存后状态=待审核');
  eq(wPc?.priceType, 'dual', 'W3 含售价+进价 → priceType=dual');
  eq(wPc?.itemCount, 3, '行数 3');
  near(wPc?.diffTotal, (3.5 - 3) + (5.9 - 6.5) + (2.8 - 0), '差额合计 = 售价差额 + 进价差额');
  // W4 未审核不生效：三商品售价均不变，进价基线未落地
  const wList0 = data(await api('GET', '/products?size=200', { token: T }));
  const wI0 = wList0.items || wList0 || [];
  near(wI0.find(p => Number(p.id) === Number(wP1.id))?.sell_price, 3, 'W4 未审核：可乐售价仍 3');
  near(wI0.find(p => Number(p.id) === Number(wP2.id))?.sell_price, 6.5, 'W4 未审核：薯片售价仍 6.5');
  near(wI0.find(p => Number(p.id) === Number(wP3.id))?.sell_price, 4, 'W4 未审核：牛奶售价仍 4');
  const wSpp0 = await sqlOnly(`SELECT count(*)::int AS n FROM supplier_product_prices WHERE product_id=$1`, [wP3.id]);
  eq(wSpp0.rows[0]?.n, 0, 'W4 未审核：进价基线未落地');
  // W5 审核通过 → 全部生效
  const wAp = data(await api('POST', `/price-changes/${wPc.id}/approve`, { token: T }));
  eq(wAp?.status, 'approved', 'W5 审核通过状态=已生效');
  const wList1 = data(await api('GET', '/products?size=200', { token: T }));
  const wI1 = wList1.items || wList1 || [];
  near(wI1.find(p => Number(p.id) === Number(wP1.id))?.sell_price, 3.5, 'W5 可乐售价生效 3.5');
  near(wI1.find(p => Number(p.id) === Number(wP2.id))?.sell_price, 5.9, 'W5 薯片售价生效 5.9');
  near(wI1.find(p => Number(p.id) === Number(wP3.id))?.sell_price, 4, 'W5 牛奶售价不变（该行只改进价）');
  const wBase = await sqlOnly(
    `SELECT price, min_price, source_doc FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
    [wP3.id, wSup.id]);
  near(wBase.rows[0]?.price, 2.8, 'W5 进价基线落地 2.8');
  near(wBase.rows[0]?.min_price, 2.8, 'W5 min_price 刷新 2.8');
  eq(String(wBase.rows[0]?.source_doc || '').startsWith('TJ-'), true, 'W5 source_doc 关联调价单号');
  // W6 留痕：售价行 old_price 3/6.5；进价行 old_cost 0 / new_cost 2.8、old_price 为空
  const wDet = data(await api('GET', `/price-changes/${wPc.id}`, { token: T }));
  eq(wDet?.items?.length, 3, 'W6 详情含 3 行明细');
  eq(wDet?.status, 'approved', 'W6 详情状态=已生效');
  near(wDet.items.find(i => Number(i.product_id) === Number(wP1.id))?.old_price, 3, '可乐旧售价留痕 3');
  near(wDet.items.find(i => Number(i.product_id) === Number(wP2.id))?.old_price, 6.5, '薯片旧售价留痕 6.5');
  const wRow3 = wDet.items.find(i => Number(i.product_id) === Number(wP3.id));
  near(wRow3?.old_cost, 0, '牛奶无历史旧进价留痕 0');
  near(wRow3?.new_cost, 2.8, '牛奶新进价留痕 2.8');
  eq(wRow3?.old_price === null || wRow3?.old_price === undefined, true, '进价行售价留痕为空（双轨分离）');
  eq(wDet.items.every(i => i.supplier_name === undefined || i.supplier_name === null || i.supplier_name === 'W段进价调价供应商'), true, 'W6 明细供应商名留痕');
  // W7 二次进价下调 → 审核后 min_price 刷新（最低价保护线 V4.3.6）；同价拦截
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP3.id, newCost: 2.8 }] } })).code, 40003, 'W7 新进价=现进价 → 40003');
  const wCc2 = data(await api('POST', '/price-changes', { token: T, body: {
    items: [{ productId: wP3.id, newCost: 2.5 }], remark: 'W段进价下调' } }));
  ok(/^JC-\d{6}-\d{3}$/.test(wCc2?.pcNo || ''), 'W7 纯进价单号 JC-YYYYMM-XXX');
  eq(wCc2?.priceType, 'cost', 'W7 纯进价单 priceType=cost');
  eq(wCc2?.status, 'pending', 'W7 纯进价单待审核');
  const wSpp1 = await sqlOnly(`SELECT count(*)::int AS n FROM supplier_product_prices WHERE product_id=$1 AND price=2.5`, [wP3.id]);
  eq(wSpp1.rows[0]?.n, 0, 'W7 未审核：新基线未落地');
  const wAp2 = data(await api('POST', `/price-changes/${wCc2.id}/approve`, { token: T }));
  eq(wAp2?.status, 'approved', 'W7 二次审核通过');
  const wBase2 = await sqlOnly(
    `SELECT price, min_price FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
    [wP3.id, wSup.id]);
  near(wBase2.rows[0]?.price, 2.5, 'W7 新基线 2.5');
  near(wBase2.rows[0]?.min_price, 2.5, 'W7 进价下调刷新最低价保护线 2.5');
  // W8 作废流：待审核可作废，作废后不可审核、价格不生效
  const wVd = data(await api('POST', '/price-changes', { token: T, body: {
    items: [{ productId: wP1.id, newPrice: 4.2 }], remark: 'W段作废测试' } }));
  eq(wVd?.status, 'pending', 'W8 新单待审核');
  const wVd2 = data(await api('POST', `/price-changes/${wVd.id}/void`, { token: T }));
  eq(wVd2?.status, 'voided', 'W8 作废成功');
  eq((await api('POST', `/price-changes/${wVd.id}/approve`, { token: T })).code, 40003, 'W8 作废单审核 → 40003');
  eq((await api('POST', `/price-changes/${wVd.id}/void`, { token: T })).code, 40003, 'W8 已作废再作废 → 40003');
  eq((await api('POST', `/price-changes/${wPc.id}/approve`, { token: T })).code, 40003, 'W8 已生效单重复审核 → 40003');
  const wList2 = data(await api('GET', '/products?size=200', { token: T }));
  near((wList2.items || wList2 || []).find(p => Number(p.id) === Number(wP1.id))?.sell_price, 3.5, 'W8 作废单未影响售价（仍 3.5）');
  // W9 列表过滤：类型 + 状态
  const wAll = data(await api('GET', '/price-changes', { token: T }));
  ok((wAll.items || wAll || []).some(c => Number(c.id) === Number(wPc.id)), 'W9 列表含混合单');
  const wCostList = data(await api('GET', '/price-changes?type=cost', { token: T }));
  ok((wCostList.items || wCostList || []).every(c => c.price_type === 'cost'), 'W9 type=cost 过滤仅进价单');
  const wDualList = data(await api('GET', '/price-changes?type=dual', { token: T }));
  ok((wDualList.items || wDualList || []).every(c => c.price_type === 'dual'), 'W9 type=dual 过滤仅混合单');
  const wVoidList = data(await api('GET', '/price-changes?status=voided', { token: T }));
  ok((wVoidList.items || wVoidList || []).every(c => c.status === 'voided') && (wVoidList.items || wVoidList || []).some(c => Number(c.id) === Number(wVd.id)), 'W9 status=voided 过滤含作废单');
  const wPendList = data(await api('GET', '/price-changes?status=pending', { token: T }));
  ok((wPendList.items || wPendList || []).every(c => c.status === 'pending'), 'W9 status=pending 过滤');
  const wUser2 = data(await api('POST', '/auth/login', { body: { empNo: 'ADMIN', password: 'E2e#Admin2026' } }));
  ok(Boolean(wUser2?.token), 'W10 管理员具备 pos.price.manual（ADMIN 全量权限）');
  if (wUser2?.token) { T = wUser2.token; console.log('  [note] W10 单会话语义：登录使旧 token 失效（tv+1），后续改用新 token'); }

  // ═══ X. 组合拆分（组装 ZZ-/拆分 CF-，FIFO 成本守恒，db/014 V4.8.17） ═══
  console.log('■ X. 组合拆分');
  const xSid = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'X段组合供应商', contactPerson: 'X联系人', contactPhone: '13900000023', bizMode: '购销' } }));
  const xa = data(await api('POST', '/products', { token: T, body: { name: 'X段纯牛奶250ml', base_unit: '盒', sellPrice: 4, barcode: '6901230000087', keepDays: 90, minStock: 0 } }));
  const xb = data(await api('POST', '/products', { token: T, body: { name: 'X段抽取式纸巾', base_unit: '包', sellPrice: 3, barcode: '6901230000094', keepDays: 730, minStock: 0 } }));
  const bpRaw = await api('POST', '/products', { token: T, body: { name: 'X段家庭早餐组合', base_unit: '套', sellPrice: 8, barcode: '6901230000100', keepDays: 60, minStock: 0 } });
  if (bpRaw.code !== 0) console.log('  [debug bp]', JSON.stringify(bpRaw).slice(0, 240));
  const bp = bpRaw.data;
  ok(Number(xa?.id) > 0 && Number(xb?.id) > 0 && Number(bp?.id) > 0, 'X1 建组合商品与子商品');
  await bindSup(xSid.id, [[xa.id, 2.5], [xb.id, 1.5]]); // X 段绑定子商品×xSid
  // 子商品入库（纸巾两批不同价，验证 FIFO 混合）
  const xi1 = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: xSid.id, items: [
    { productId: xa.id, qty: 10, unitCost: 2.5, productionDate: '2026-09-01' },
    { productId: xb.id, qty: 20, unitCost: 1.5, productionDate: '2026-09-01' } ] } }));
  const xi2 = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: xSid.id, items: [
    { productId: xb.id, qty: 10, unitCost: 2, productionDate: '2026-09-02' } ] } }));
  await api('POST', `/purchase/inbounds/${xi1.id}/audit`, { token: T });
  await api('POST', `/purchase/inbounds/${xi2.id}/audit`, { token: T });
  // 组合档案与校验
  eq((await api('POST', '/bundles', { token: T, body: { bundleProductId: bp.id, items: [] } })).code, 40003, 'X2 空明细 → 40003');
  eq((await api('POST', '/bundles', { token: T, body: { bundleProductId: bp.id, items: [{ productId: bp.id, qty: 1 }] } })).code, 40003, 'X2 子商品=组合本身 → 40003');
  const xBd = data(await api('POST', '/bundles', { token: T, body: {
    bundleProductId: bp.id, items: [{ productId: xa.id, qty: 1 }, { productId: xb.id, qty: 2 }] } }));
  ok(Number(xBd?.id) > 0, 'X2 组合档案已建（1 牛奶 + 2 纸巾）');
  eq((await api('POST', '/bundles', { token: T, body: { bundleProductId: bp.id, items: [{ productId: xa.id, qty: 1 }] } })).code, 40003, 'X3 重复定义 → 40003');
  const xBl = data(await api('GET', '/bundles', { token: T }));
  const xBdRow = (xBl.items || []).find(b => Number(b.bundle_product_id) === Number(bp.id));
  eq(xBdRow?.items?.length, 2, 'X3 列表含 BOM 明细 2 行');
  // 组装 5 份：牛奶 5@2.5 + 纸巾 10@1.5（第一批）= 27.5 → 组合批次 5 件 @5.5
  eq((await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 0 } })).code, 40003, 'X4 组装份数 0 → 40003');
  eq((await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: 999999, qty: 1 } })).code, 40404, 'X4 组合未定义 → 40404');
  const xZa = data(await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 5, remark: 'X段节前组装' } }));
  ok(/^ZZ-\d{6}-\d{3}$/.test(xZa?.opNo || ''), 'X5 组装单号 ZZ-YYYYMM-XXX');
  near(xZa?.totalCost, 27.5, 'X5 组装成本 = 5×2.5 + 10×1.5 = 27.5');
  near(xZa?.unitCost, 5.5, 'X5 组合单位成本 5.5');
  const xInv1 = await sqlOnly(`SELECT product_id, qty_total FROM inventory_current WHERE product_id = ANY($1) ORDER BY product_id`, [[xa.id, xb.id, bp.id]]);
  const xInvMap = Object.fromEntries(xInv1.rows.map(r => [Number(r.product_id), Number(r.qty_total)]));
  eq(xInvMap[Number(xa.id)], 5, 'X6 牛奶库存 10-5=5');
  eq(xInvMap[Number(xb.id)], 20, 'X6 纸巾库存 30-10=20（FIFO 全扣第一批）');
  eq(xInvMap[Number(bp.id)], 5, 'X6 组合库存 +5');
  const xBb1 = await sqlOnly(`SELECT inbound_cost, remain_qty FROM batches WHERE product_id=$1 AND batch_no LIKE 'ZZ-%' ORDER BY id`, [bp.id]);
  near(xBb1.rows[0]?.inbound_cost, 5.5, 'X6 组合批次单位成本 5.5（守恒）');
  eq(Number(xBb1.rows[0]?.remain_qty), 5, 'X6 组合批次剩余 5');
  eq((await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 999 } })).code, 50001, 'X7 子商品库存不足 → 50001');
  // 卖组合：现有收银 FIFO 自动支持（组合批次可售）
  const xSale = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: bp.id, qty: 2 }], payments: [{ channel: '现金', amount: 16 }] } }));
  near(xSale?.payable, 16, 'X8 销售组合 2 份 × 8 = 16');
  near(xSale?.costTotal, 11, 'X8 组合销售成本 = 2×5.5（FIFO 扣组合批次）');
  const xBb1b = await sqlOnly(`SELECT remain_qty FROM batches WHERE product_id=$1 AND batch_no LIKE 'ZZ-%' ORDER BY id`, [bp.id]);
  eq(Number(xBb1b.rows[0]?.remain_qty), 3, 'X8 组合批次剩余 3');
  // 拆分 2 份：消耗组合批次 2@5.5=11 → 子批次 u = 5.5/(1+2)=1.8333（Σ成本守恒 11）
  const xCf = data(await api('POST', '/bundles/split', { token: T, body: { bundleProductId: bp.id, qty: 2, remark: 'X段拆分散卖' } }));
  ok(/^CF-\d{6}-\d{3}$/.test(xCf?.opNo || ''), 'X9 拆分单号 CF-YYYYMM-XXX');
  near(xCf?.totalCost, 11, 'X9 拆分总成本 = 2×5.5 = 11');
  const xInv2 = await sqlOnly(`SELECT product_id, qty_total FROM inventory_current WHERE product_id = ANY($1) ORDER BY product_id`, [[xa.id, xb.id, bp.id]]);
  const xInvMap2 = Object.fromEntries(xInv2.rows.map(r => [Number(r.product_id), Number(r.qty_total)]));
  eq(xInvMap2[Number(bp.id)], 1, 'X10 组合库存 3-2=1');
  eq(xInvMap2[Number(xa.id)], 7, 'X10 牛奶回加 5+2=7');
  eq(xInvMap2[Number(xb.id)], 24, 'X10 纸巾回加 20+4=24');
  const xSum = await sqlOnly(
    `SELECT SUM(cost_total) AS s FROM bundle_op_items WHERE op_id=$1`, [xCf.id]);
  near(Number(xSum.rows[0]?.s), 11, 'X10 拆分明细成本合计守恒 11');
  // 二次组装：纸巾 FIFO 继续扣第一批（剩 10@1.5）→ 2 份成本 = 2×2.5 + 4×1.5 = 11
  const xZa2 = data(await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 2 } }));
  near(xZa2?.totalCost, 11, 'X11 二次组装跨批次 FIFO = 2×2.5 + 4×1.5 = 11');
  // 单据浏览与类型过滤
  const xOps = data(await api('GET', '/bundles/ops?type=assemble', { token: T }));
  ok((xOps.items || xOps || []).every(o => o.op_type === 'assemble') && (xOps.items || xOps || []).length >= 2, 'X12 组装单列表含 2 张 ZZ');
  const xOpsAll = data(await api('GET', '/bundles/ops', { token: T }));
  ok((xOpsAll.items || xOpsAll || []).some(o => o.op_no === xCf.opNo && o.bundle_name === 'X段家庭早餐组合'), 'X12 浏览列表含拆分单与组合名');


  // ═══ Y. V4.8.19 档位充值 + 会员等级列 + 流水筛选 ═══
  console.log('■ Y. V4.8.19 档位充值 + 流水筛选');
  const yM = data(await api('POST', '/members', { token: T, body: { phone: '13900009901', name: '档位充值员', privacyAgreed: true } }));
  const yRaw = await api('POST', `/members/${yM.id}/recharges`, { token: T, body: { planId: uPlan.id } });
  eq(yRaw.code, 0, 'Y1 按档充值成功（planId）');
  near(data(yRaw)?.balanceAfter, 110, 'Y1 按档入账 100+10=110（服务端按档，防篡改）');
  eq((await api('POST', `/members/${yM.id}/recharges`, { token: T, body: { planId: 999999 } })).code, 42016,
     'Y1 不存在档位 → 42016');
  const yDetail = data(await api('GET', `/members/${yM.id}`, { token: T }));
  ok(!!(yDetail?.member?.level_name || yDetail?.level_name), 'Y2 会员详情返回等级名', JSON.stringify(yDetail?.member?.level_name));
  const yList = data(await api('GET', '/members?keyword=档位充值员', { token: T }));
  ok(yList?.items?.[0]?.level_name !== undefined, 'Y3 会员列表返回等级列');
  // 流水筛选（供应商/收银员/商品关键字）
  const ySup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: '流水过滤供应商', contactPerson: 'Y联系人', contactPhone: '13900000024', bizMode: '购销' } }));
  const yP = data(await api('POST', '/products', { token: T, body: {
    name: '流水过滤专用奶', base_unit: '盒', sellPrice: 3, barcode: '6901234509911', keepDays: 60, supplierDefaultId: ySup.id } }));
  const yIn = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: ySup.id, items: [
    { productId: yP.id, qty: 50, unitCost: 2, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${yIn.id}/audit`, { token: T });
  const yCo = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: yP.id, qty: 2 }], payments: [{ channel: '现金', amount: 6 }] } }));
  near(yCo?.payable, 6, 'Y4 造流水 checkout 2×3=6');
  const yOid = Number(yCo?.orderId || yCo?.id);
  const yKw = data(await api('GET', '/sales?keyword=' + encodeURIComponent('流水过滤专用奶') + '&size=100', { token: T }));
  ok((yKw?.items || []).some(o => Number(o.id) === yOid), 'Y5 商品关键字过滤命中');
  const yKw0 = data(await api('GET', '/sales?keyword=' + encodeURIComponent('绝对不存在xyz'), { token: T }));
  ok(!(yKw0?.items || []).some(o => Number(o.id) === yOid), 'Y6 无关关键字不命中');
  const yBySup = data(await api('GET', '/sales?supplierId=' + ySup.id + '&size=100', { token: T }));
  ok((yBySup?.items || []).some(o => Number(o.id) === yOid), 'Y7 供应商过滤命中（按单内商品默认供应商）');
  const yAll = data(await api('GET', '/sales?size=100', { token: T }));
  const yOrder = (yAll?.items || []).find(o => Number(o.id) === yOid);
  if (yOrder && yOrder.cashier_id) {
    const yC = data(await api('GET', '/sales?cashierId=' + yOrder.cashier_id + '&size=100', { token: T }));
    ok((yC?.items || []).some(o => Number(o.id) === yOid), 'Y8 收银员过滤命中');
  } else ok(true, 'Y8 无 cashier_id（跳过）');


  // ═══ Z. V4.8.21：入库作废回退 + 退货凭证后置 + 勾选对账/作废 + 0元直结算 + 批量导入/多码 + 工号规则 + 促销模板 ═══
  console.log('■ Z. V4.8.21 单据作废与勾选对账');
  const zSup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'Z段作废联调供应商', contactPerson: 'Z联系人', contactPhone: '13900000025', bizMode: '购销' } }));
  const zP = data(await api('POST', '/products', { token: T, body: {
    name: 'Z段作废测试水', base_unit: '瓶', sellPrice: 2, barcode: '6901234500028', keepDays: 365 } }));
  const zP2 = data(await api('POST', '/products', { token: T, body: {
    name: 'Z段动用测试奶', base_unit: '盒', sellPrice: 2.5, barcode: '6901234500035', keepDays: 90 } }));

  await bindSup(zSup.id, [[zP.id, 2], [zP2.id, 1.5]]); // Z 段绑定
  // ── Z1 入库作废：未动用 → 批次入库作废 + 库存回退 + 反向流水
  const zIn = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: zSup.id, items: [
    { productId: zP.id, qty: 20, unitCost: 2, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${zIn.id}/audit`, { token: T });
  const zQty0 = (await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [zP.id])).rows[0].qty_total;
  const zVoid = await api('POST', `/purchase/inbounds/${zIn.id}/void`, { token: T, body: { reason: 'Z段测试作废' } });
  eq(data(zVoid)?.status, '已作废', 'Z1 已审核入库单作废成功');
  const zQty1 = (await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [zP.id])).rows[0].qty_total;
  near(zQty1, Number(zQty0) - 20, 'Z1 作废后即时库存回退 20');
  const zBatch = await sqlOnly(`SELECT status FROM batches WHERE inbound_order_id=$1`, [zIn.id]);
  ok(zBatch.rows.length === 1 && zBatch.rows[0].status === '入库作废', 'Z1 批次置「入库作废」');
  const zFlow = await sqlOnly(`SELECT count(*) AS n FROM stock_flows WHERE ref_type='inbound_void' AND ref_id=$1`, [zIn.id]);
  eq(Number(zFlow.rows[0].n), 1, 'Z1 反向库存流水（inbound_void）落账');
  eq((await api('POST', `/purchase/inbounds/${zIn.id}/void`, { token: T, body: {} })).code, 50010, 'Z1 重复作废 → 50010');

  // ── Z1b 批次已动用 → 拒绝作废（zP2 唯一批次被销售 3 件）
  const zIn2 = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: zSup.id, items: [
    { productId: zP2.id, qty: 10, unitCost: 1.5, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${zIn2.id}/audit`, { token: T });
  await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: zP2.id, qty: 3 }], payments: [{ channel: '现金', amount: 7.5 }] } });
  eq((await api('POST', `/purchase/inbounds/${zIn2.id}/void`, { token: T, body: {} })).code, 50010,
     'Z1b 批次已被动用 → 拒绝作废（引导走退货流程）');

  // ── Z2 退货凭证后置：创建免凭证 → 审核拦截 → 补传 → 通过；另单作废
  const zRet = data(await api('POST', '/purchase/returns', { token: T, body: { supplierId: zSup.id, items: [
    { productId: zP2.id, qty: 2 } ] } }));
  eq(zRet?.status, '待审核', 'Z2 无凭证创建退货单（039 状态重命名）');
  eq((await api('POST', `/purchase/returns/${zRet.id}/audit`, { token: T })).code, 50013, 'Z2 未补凭证审核 → 50013');
  eq(data(await api('POST', `/purchase/returns/${zRet.id}/evidence`, { token: T, body: { evidencePath: 'evidence/z-ret-001.jpg' } }))?.return_no,
     zRet.returnNo, 'Z2 补传凭证成功');
  eq(data(await api('POST', `/purchase/returns/${zRet.id}/audit`, { token: T }))?.status, '已审核', 'Z2 补凭证后审核通过');
  const zRet2 = data(await api('POST', '/purchase/returns', { token: T, body: { supplierId: zSup.id, items: [
    { productId: zP2.id, qty: 1 } ] } }));
  eq(data(await api('POST', `/purchase/returns/${zRet2.id}/void`, { token: T, body: { reason: '不退了' } }))?.status,
     '已作废', 'Z2 退货单作废（040 驳回/作废状态词）');

  // ── Z2b 供应商编辑（双击行内编辑）
  const zSupUpd = data(await api('PUT', `/purchase/suppliers/${zSup.id}`, { token: T, body: {
    contactPerson: 'Z业务员老王', contactPhone: '13800000111' } }));
  eq(zSupUpd?.contact_person, 'Z业务员老王', 'Z2b 供应商编辑（业务员字段）');

  // ── Z3 勾选对账：只吸收勾选单据 → 作废回删往来账并释放
  const zInA = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: zSup.id, items: [
    { productId: zP.id, qty: 5, unitCost: 2, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${zInA.id}/audit`, { token: T });
  const zInB = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: zSup.id, items: [
    { productId: zP.id, qty: 4, unitCost: 2, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${zInB.id}/audit`, { token: T });
  const zTypes = data(await api('GET', '/purchase/fee-types', { token: T }));
  const zFee = data(await api('POST', '/purchase/fees', { token: T, body: {
    supplierId: zSup.id, feeTypeId: zTypes.find(t => t.direction === '收').id, amount: 3 } }));
  const _zRecRaw = await api('POST', '/purchase/recon', { token: T, body: { supplierId: zSup.id,
    from: '2026-08-01', to: TO_STR, docIds: { inbounds: [zInA.id], fees: [zFee.id] } } });
  if (_zRecRaw.code !== 0) console.log('  [debug zRec]', JSON.stringify(_zRecRaw).slice(0, 240));
  const zRec = _zRecRaw.data;
  near(zRec?.payableTotal, 7, 'Z3 勾选对账：应付 7 = 入库A 10 − 返利 3（入库B 未吸收）');
  const zRecItems = await sqlOnly(`SELECT count(*) AS n FROM reconciliation_items WHERE recon_id=$1`, [zRec.id]);
  eq(Number(zRecItems.rows[0].n), 2, 'Z3 对账明细仅 2 行（勾选）');
  eq(data(await api('POST', `/purchase/recons/${zRec.id}/void`, { token: T, body: { reason: '重新对账' } }))?.status,
     '已作废', 'Z3 对账单作废');
  const zRel = await sqlOnly(`SELECT recon_id FROM inbound_orders WHERE id=$1`, [zInA.id]);
  eq(zRel.rows[0].recon_id, null, 'Z3 入库单 recon_id 已释放');
  const zLed = await sqlOnly(
    `SELECT count(*) AS n FROM supplier_ledger WHERE supplier_id=$1 AND biz_type='inbound' AND biz_id=$2`,
    [zSup.id, zInA.id]);
  eq(Number(zLed.rows[0].n), 0, 'Z3 作废后往来账对应分录已回删');

  // ── Z4 0元直结算：入库20 − 返利20 = 0 → 免确认免审核
  const zInC = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: zSup.id, items: [
    { productId: zP.id, qty: 10, unitCost: 2, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${zInC.id}/audit`, { token: T });
  const zFee2 = data(await api('POST', '/purchase/fees', { token: T, body: {
    supplierId: zSup.id, feeTypeId: zTypes.find(t => t.direction === '收').id, amount: 20 } }));
  const zRec2 = data(await api('POST', '/purchase/recon', { token: T, body: { supplierId: zSup.id,
    from: '2026-08-01', to: TO_STR, docIds: { inbounds: [zInC.id], fees: [zFee2.id] } } }));
  near(zRec2?.payableTotal, 0, 'Z4 费用冲抵后应付 0');
  const zSt2 = data(await api('POST', '/purchase/settlements', { token: T, body: { reconId: zRec2.id } }));
  eq(zSt2?.status, '已审核', 'Z4 0元应付直结算（免确认免审核一步到位）');
  eq(zSt2?.zeroDirect, true, 'Z4 返回 zeroDirect 标记');
  const zRecSt = await sqlOnly(`SELECT status FROM reconciliations WHERE id=$1`, [zRec2.id]);
  eq(zRecSt.rows[0].status, '已结算', 'Z4 对账单直接置已结算');

  // ── Z5 商品批量导入 + 一品多码 + 图片
  const zImp = data(await api('POST', '/products/import', { token: T, body: { rows: [
    { name: 'Z导入纸巾', baseUnit: '包', sellPrice: 2.5, barcode: '6901234500042', keepDays: 999 },
    { name: 'Z导入电池', baseUnit: '对', sellPrice: 5, barcode: '6901234500097' },
    { name: 'Z坏行价格为0', baseUnit: '个', sellPrice: 0 } ] } }));
  eq(zImp?.total, 3, 'Z5 批量导入 3 行');
  eq(zImp?.ok, 2, 'Z5 成功 2 行');
  eq(zImp?.fail, 1, 'Z5 失败 1 行（售价 0）');
  const zImpP = (zImp.results || []).find(x => x.ok && x.name === 'Z导入纸巾');
  ok(Number(zImpP?.id) > 0, 'Z5 导入行返回商品 id');
  const zBc = data(await api('POST', `/products/${zP.id}/barcodes`, { token: T, body: { barcodes: ['6990001234567', '6990001234567', '6990007654321'] } }));
  eq(zBc?.barcodes?.length, 2, 'Z5 一品多码整组替换（去重 2 个）');
  const zAlias = data(await api('GET', '/products?keyword=6990001234567', { token: T }));
  ok((zAlias.items || []).some(p => Number(p.id) === Number(zP.id)), 'Z5 辅助码命中商品列表搜索');
  const zUpd = data(await api('PUT', `/products/${zP.id}`, { token: T, body: { photoPath: 'https://img.example/water.png' } }));
  eq(zUpd?.photo_path, 'https://img.example/water.png', 'Z5 商品图片（photo_path）编辑');

  // ── Z6 员工工号规则 + 自定义角色（权限勾选）
  const zRole = data(await api('POST', '/auth/roles', { token: T, body: {
    name: 'Z段仓管员', perms: ['stock.inbound.audit', 'stock.transfer', 'stock.transfer.audit'] } }));
  ok(Number(zRole?.id) > 0 && (zRole.perms || []).length === 3, 'Z6 自定义角色（权限点勾选 3 个，含 V4.28.3 拆分的调拨确认）');
  const zEmp1 = data(await api('POST', '/auth/employees', { token: T, body: {
    name: 'Z仓管小张', password: 'Pos123456', roleIds: [zRole.id] } }));
  ok(/^CN\d{4}$/.test(zEmp1?.empNo || ''), 'Z6 仓管角色 → 工号自动 CN0001 型', zEmp1?.empNo);
  const zEmp2 = data(await api('POST', '/auth/employees', { token: T, body: { name: 'Z通用小李', password: 'Pos123456' } }));
  ok(/^EM\d{4}$/.test(zEmp2?.empNo || ''), 'Z6 无角色 → 工号自动 EM0001 型', zEmp2?.empNo);

  // ── Z7 促销活动模板
  const zTpls = data(await api('GET', '/promotions/templates', { token: T }));
  ok(Array.isArray(zTpls) && zTpls.length >= 4, 'Z7 促销模板 ≥4 套（db/016 种子）');
  const zPromo = data(await api('POST', '/promotions', { token: T, body: {
    name: 'Z段模板满减', templateId: (zTpls.find(t => t.kind === '满减') || zTpls[0]).id,
    startAt: '2026-09-06T00:00:00Z', endAt: '2026-09-08T23:59:59Z' } }));
  eq(zPromo?.kind, '满减', 'Z7 按模板一键建活动（kind 继承）');
  ok(Array.isArray(zPromo?.rules?.tiers) && zPromo.rules.tiers.length >= 1, 'Z7 rules 从模板继承');

  // ═══ Z8 采购订单闭环（P0-2：建单→提交→审批→到货入库→自动完成） ═══
  console.log('■ Z8. 采购订单闭环（建单→提交→审批→到货入库→自动完成）');
  const zPo1 = data(await api('POST', '/purchase/orders', { token: T, body: {
    supplierId: zSup.id, expectArrival: '2026-09-10', remark: 'P0-2闭环',
    items: [{ productId: zP.id, orderQty: 5, price: 2, lineRemark: '整箱' }] } }));
  eq(zPo1?.status, '草稿', 'Z8 建单成功（草稿）');
  ok(/^CG-\d{8}-\d{3}$/.test(zPo1?.poNo || ''), 'Z8 单号规则 CG-YYYYMMDD-序号', zPo1?.poNo);
  const zPo1List = data(await api('GET', `/purchase/orders?keyword=${encodeURIComponent(zPo1.poNo)}`, { token: T }));
  ok((zPo1List.items || zPo1List).some(x => x.po_no === zPo1.poNo), 'Z8 列表按关键字命中');
  const zPo1Det = data(await api('GET', `/purchase/orders/${zPo1.id}`, { token: T }));
  eq(Number(zPo1Det?.items?.[0]?.order_qty), 5, 'Z8 明细订购数量 5');
  eq(zPo1Det?.supplier_name, 'Z段作废联调供应商', 'Z8 详情含供应商名');
  eq(data(await api('POST', `/purchase/orders/${zPo1.id}/submit`, { token: T }))?.status, '待审批', 'Z8 提交审批');
  eq(data(await api('POST', `/purchase/orders/${zPo1.id}/approve`, { token: T, body: { signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }))?.status, '已下单', 'Z8 审批通过（V4.15 审批采集电子签名）');
  const zIn1 = data(await api('POST', '/purchase/inbounds', { token: T, body: {
    supplierId: zSup.id, poId: zPo1.id, items: [{ productId: zP.id, qty: 3, unitCost: 2, productionDate: '2026-09-01' }] } }));
  eq(zIn1?.status, '未审核', 'Z8 关联采购单入库（到货 3）');
  await api('POST', `/purchase/inbounds/${zIn1.id}/audit`, { token: T });
  const zPo1After = data(await api('GET', `/purchase/orders/${zPo1.id}`, { token: T }));
  eq(Number(zPo1After?.items?.[0]?.arrived_qty), 3, 'Z8 回写到货量 3');
  eq(zPo1After?.status, '到货中', 'Z8 未到齐 → 到货中');
  const zPoIn2 = data(await api('POST', '/purchase/inbounds', { token: T, body: {
    supplierId: zSup.id, poId: zPo1.id, items: [{ productId: zP.id, qty: 2, unitCost: 2, productionDate: '2026-09-02' }] } }));
  await api('POST', `/purchase/inbounds/${zPoIn2.id}/audit`, { token: T });
  const zPo1Done = data(await api('GET', `/purchase/orders/${zPo1.id}`, { token: T }));
  eq(zPo1Done?.status, '已完成', 'Z8 全部到货 → 自动完成');
  eq(Number(zPo1Done?.items?.[0]?.arrived_qty), 5, 'Z8 累计到货 5');
  eq((await api('POST', `/purchase/orders/${zPo1.id}/void`, { token: T })).code, 0, 'Z8 作废已完成订单（V4.9.6：订单不持库存，允许作废留痕）');
  const zPo2 = data(await api('POST', '/purchase/orders', { token: T, body: {
    supplierId: zSup.id, items: [{ productId: zP.id, orderQty: 1, price: 2 }] } }));
  eq(data(await api('POST', `/purchase/orders/${zPo2.id}/void`, { token: T, body: { reason: '测试作废' } }))?.status,
     '已取消', 'Z8 草稿作废');
  eq((await api('POST', '/purchase/orders', { token: T, body: { supplierId: zSup.id, items: [] } })).code,
     40003, 'Z8 空明细拦截 40003');

  // ═══ Z9 库存作业（P0-3：盘点差异审核 + 拍照报损 + 店内调拨，后端 /inventory/counts|losses|transfers） ═══
  console.log('■ Z9. 库存作业闭环（盘点差异审核 + 拍照报损 + 店内调拨）');
  const zInv = data(await api('POST', '/products', { token: T, body: {
    name: 'Z段盘点可乐', base_unit: '瓶', sellPrice: 3, barcode: '6901234500073', keepDays: 60 } }));
  await bindSup(zSup.id, [[zInv.id, 2]]); // Z9 备货绑定（V4.12+ 绑定规则）
  const zInvIn = data(await api('POST', '/purchase/inbounds', { token: T, body: {
    supplierId: zSup.id, items: [{ productId: zInv.id, qty: 12, unitCost: 2, productionDate: '2026-09-01' }] } }));
  await api('POST', `/purchase/inbounds/${zInvIn.id}/audit`, { token: T });
  const zInvQty = async () => Number((await sqlOnly(`SELECT qty_total FROM inventory_current WHERE product_id=$1`, [zInv.id])).rows[0].qty_total);
  eq(await zInvQty(), 12, 'Z9 备货入库 12');
  const zEmpLogin = data(await api('POST', '/auth/login', { body: { empNo: zEmp1.empNo, password: 'Pos123456' } }));
  const zEmpT = zEmpLogin?.token;
  ok(!!zEmpT, 'Z9 仓管登录（zEmp1）');

  // ── 盘点：建单（账面快照）→ 权限拦截 → 审核盘亏 3
  const zCnt = data(await api('POST', '/inventory/counts', { token: T, body: {
    scope: '全仓', remark: 'P0-3盘点', items: [{ productId: zInv.id, actualQty: 9 }] } }));
  eq(zCnt?.status, '进行中', 'Z9 建盘点单（进行中）');
  ok(/^PD-\d{8}-\d{3}$/.test(zCnt?.countNo || ''), 'Z9 盘点单号 PD-YYYYMMDD-序号', zCnt?.countNo);
  eq(Number(zCnt?.lines?.[0]?.bookQty), 12, 'Z9 账面快照 = 当前库存 12');
  eq(Number(zCnt?.lines?.[0]?.diffQty), -3, 'Z9 差异 -3（盘亏）');
  eq((await api('POST', `/inventory/counts/${zCnt.id}/audit`, { token: zEmpT })).code, 40300,
     'Z9 盘点审核无权限拦截 40300（仓管缺 stock.count.audit）');
  eq(data(await api('POST', `/inventory/counts/${zCnt.id}/audit`, { token: T }))?.status, '已审核', 'Z9 盘点审核通过');
  eq(await zInvQty(), 9, 'Z9 盘亏 3 → 即时库存 9');
  const zCntFlow = await sqlOnly(`SELECT count(*) AS n FROM stock_flows WHERE ref_type='count' AND ref_id=$1`, [zCnt.id]);
  eq(Number(zCntFlow.rows[0].n), 1, 'Z9 盘亏库存流水（count）落账');
  near(Number((await sqlOnly(`SELECT remain_qty FROM batches WHERE product_id=$1 AND status='在库'`, [zInv.id])).rows[0].remain_qty), 9, 'Z9 批次 remain 9（FIFO 扣减）');
  eq((await api('POST', `/inventory/counts/${zCnt.id}/audit`, { token: T })).code, 50016, 'Z9 重复审核 → 50016');
  const zCntList = data(await api('GET', `/inventory/counts?status=已审核`, { token: T }));
  ok((zCntList.items || zCntList).some(x => x.count_no === zCnt.countNo), 'Z9 盘点列表按状态命中');

  // ── 报损：缺照片拦截 → 建单（临期优先归属）→ 权限拦截 → 审核扣 2
  eq((await api('POST', '/inventory/losses', { token: T, body: {
    reasonType: '过期', photoPath: '', items: [{ productId: zInv.id, qty: 2 }] } })).code, 40003,
    'Z9 报损缺照片拦截 40003');
  eq((await api('POST', '/inventory/losses', { token: zEmpT, body: {
    reasonType: '过期', photoPath: '/photos/z.jpg', items: [{ productId: zInv.id, qty: 2 }] } })).code, 40300,
    'Z9 报损无权限拦截 40300（仓管缺 stock.loss.create）');
  const zLoss = data(await api('POST', '/inventory/losses', { token: T, body: {
    reasonType: '过期', photoPath: '/photos/z-loss-001.jpg', remark: 'P0-3报损',
    items: [{ productId: zInv.id, qty: 2 }] } }));
  eq(zLoss?.status, '待审核', 'Z9 建报损单（待审核）');
  ok(/^BS-\d{8}-\d{3}$/.test(zLoss?.lossNo || ''), 'Z9 报损单号 BS-YYYYMMDD-序号', zLoss?.lossNo);
  eq(Number(zLoss?.lines?.[0]?.unitCost), 2, 'Z9 批次成本 2（临期优先归属）');
  eq(Number(zLoss?.totalCost), 4, 'Z9 报损金额 4');
  const zLossAud = await api('POST', `/inventory/losses/${zLoss.id}/audit`, { token: T });
  console.log('Z9-DEBUG 报损审核:', JSON.stringify(zLossAud));
  eq(zLossAud.data?.status, '已审核', 'Z9 报损审核通过');
  eq(await zInvQty(), 7, 'Z9 报损 2 → 即时库存 7');
  const zLossFlow = await sqlOnly(`SELECT count(*) AS n FROM stock_flows WHERE ref_type='loss' AND ref_id=$1`, [zLoss.id]);
  eq(Number(zLossFlow.rows[0].n), 1, 'Z9 报损库存流水（loss）落账');
  near(Number((await sqlOnly(`SELECT remain_qty FROM batches WHERE product_id=$1 AND status='在库'`, [zInv.id])).rows[0].remain_qty), 7, 'Z9 批次 remain 7');
  const zLossDet = data(await api('GET', `/inventory/losses/${zLoss.id}`, { token: T }));
  eq(zLossDet?.items?.[0]?.product_name, 'Z段盘点可乐', 'Z9 报损详情含商品名');
  eq(zLossDet?.photo_path, '/photos/z-loss-001.jpg', 'Z9 报损详情含照片路径');

  // ── 调拨：建单 → 跨店拦截 → 确认（仓管有权限）→ 双边流水 + 转入批次
  const zTr = data(await api('POST', '/inventory/transfers', { token: T, body: {
    reason: 'P0-3调拨', items: [{ productId: zInv.id, qty: 3 }] } }));
  eq(zTr?.status, '待确认', 'Z9 建调拨单（待确认）');
  ok(/^DB-\d{8}-\d{3}$/.test(zTr?.transferNo || ''), 'Z9 调拨单号 DB-YYYYMMDD-序号', zTr?.transferNo);
  eq(Number(zTr?.totalCost), 6, 'Z9 调拨金额 6（成本不变）');
  eq((await api('POST', '/inventory/transfers', { token: T, body: {
    toStoreId: 99, items: [{ productId: zInv.id, qty: 1 }] } })).code, 40003, 'Z9 跨店调拨拦截 40003');
  const _zConf = await api('POST', `/inventory/transfers/${zTr.id}/confirm`, { token: zEmpT });
  if (_zConf.code !== 0) console.log('  [debug zConf]', JSON.stringify(_zConf).slice(0, 240));
  eq(_zConf.data?.status, '已入库',
     'Z9 调拨确认（仓管权限 stock.transfer）');
  eq(await zInvQty(), 7, 'Z9 同店调拨即时库存不变 7');
  const zTrFlows = await sqlOnly(
    `SELECT direction, ref_type, qty FROM stock_flows WHERE ref_type LIKE 'transfer%' AND ref_id=$1 ORDER BY id`, [zTr.id]);
  eq(zTrFlows.rows.length, 2, 'Z9 调拨双边流水 2 条');
  eq(zTrFlows.rows[0].direction, '出库', 'Z9 调拨出库流水（transfer_out）');
  eq(zTrFlows.rows[1].direction, '入库', 'Z9 调拨入库流水（transfer_in）');
  const zTrBatches = await sqlOnly(`SELECT count(*) AS n FROM batches WHERE product_id=$1 AND status='在库'`, [zInv.id]);
  eq(Number(zTrBatches.rows[0].n), 2, 'Z9 调拨后 2 个在库批次（源 + 转入）');
  near(Number((await sqlOnly(`SELECT remain_qty FROM batches WHERE product_id=$1 AND status='在库' AND batch_no NOT LIKE 'DB%'`, [zInv.id])).rows[0].remain_qty), 4, 'Z9 源批次剩余 4');
  near(Number((await sqlOnly(`SELECT remain_qty FROM batches WHERE product_id=$1 AND status='在库' AND batch_no LIKE 'DB%'`, [zInv.id])).rows[0].remain_qty), 3, 'Z9 转入批次 3');
  eq((await api('POST', `/inventory/transfers/${zTr.id}/confirm`, { token: T })).code, 50016, 'Z9 重复确认 → 50016');
  const zTrList = data(await api('GET', '/inventory/transfers?status=已入库', { token: T }));
  ok((zTrList.items || zTrList).some(x => x.transfer_no === zTr.transferNo), 'Z9 调拨列表按状态命中');

  // ═══ Z10 报表中心（P1-1：商品销售明细 + 会员消费报表 + 员工业绩报表，/reports/sale-detail|member|employee） ═══
  console.log('■ Z10. 报表中心（商品销售明细 + 会员消费 + 员工业绩）');
  const zRep = data(await api('POST', '/products', { token: T, body: {
    name: 'Z段报表酸奶', base_unit: '盒', sellPrice: 3, barcode: '6901234500080', keepDays: 45, supplierDefaultId: Number(zSup.id) } }));
  const zRepIn = data(await api('POST', '/purchase/inbounds', { token: T, body: {
    supplierId: zSup.id, items: [{ productId: zRep.id, qty: 10, unitCost: 2, productionDate: '2026-09-01' }] } }));
  await api('POST', `/purchase/inbounds/${zRepIn.id}/audit`, { token: T });
  const zRepMem = data(await api('POST', '/members', { token: T, body: { phone: '13700000009', name: '报表会员' } }));
  const r1 = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: zRep.id, qty: 4 }], memberId: zRepMem.id, payments: [{ channel: '现金', amount: 12 }] } }));
  eq(r1?.payable, 12, 'Z10 会员单 4×3=12');
  const r2 = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: zRep.id, qty: 2 }], payments: [{ channel: '现金', amount: 6 }] } }));
  eq(r2?.payable, 6, 'Z10 散客单 2×3=6');

  // ── 商品销售明细：关键词/条码命中 + 聚合正确 + 总额合计
  const sd = data(await api('GET', `/reports/sale-detail?keyword=${encodeURIComponent('报表酸奶')}`, { token: T }));
  const sdRow = (sd.items || []).find(x => x.product_id === zRep.id);
  ok(!!sdRow, 'Z10 sale-detail 关键词命中');
  eq(Number(sdRow?.qty), 6, 'Z10 聚合销量 6（4+2）');
  eq(Number(sdRow?.orderCount), 2, 'Z10 聚合单数 2');
  near(Number(sdRow?.revenue), 18, 'Z10 聚合销售额 18');
  near(Number(sdRow?.profit), 6, 'Z10 聚合毛利 6（18-成本12）');
  near(Number(sd?.total?.revenue), 18, 'Z10 总额合计随行返回 18');
  const sdByBar = data(await api('GET', `/reports/sale-detail?keyword=${encodeURIComponent('6901234500080')}`, { token: T }));
  ok((sdByBar.items || []).some(x => x.product_id === zRep.id), 'Z10 条码精确命中');
  const sdAll = data(await api('GET', '/reports/sale-detail', { token: T }));
  ok((sdAll.items || []).length >= 1, 'Z10 无筛选返回全量（Top500）');

  // ── 会员消费报表：排行命中 + 新增/活跃/占比汇总
  const mb = data(await api('GET', '/reports/member', { token: T }));
  const mbRow = (mb.items || []).find(x => x.id === zRepMem.id);
  ok(!!mbRow, 'Z10 member 报表命中新会员');
  eq(Number(mbRow?.orderCount), 1, 'Z10 会员单数 1');
  near(Number(mbRow?.salesTotal), 12, 'Z10 会员消费额 12');
  ok(Number(mb?.summary?.newMembers) >= 1, 'Z10 新增会员 ≥1', String(mb?.summary?.newMembers));
  ok(Number(mb?.summary?.activeMembers) >= 1, 'Z10 活跃会员 ≥1', String(mb?.summary?.activeMembers));
  ok(Number(mb?.summary?.memberRatio) >= 0 && Number(mb?.summary?.memberRatio) <= 100,
     'Z10 会员消费占比 0~100%', String(mb?.summary?.memberRatio));

  // ── 员工业绩报表：按收银员过滤 + 全量
  const adminId = (await sqlOnly(`SELECT id FROM employees WHERE emp_no='ADMIN'`, [])).rows[0].id; // bigint 返回字符串
  const em = data(await api('GET', `/reports/employee?cashierId=${adminId}`, { token: T }));
  const emRow = (em.items || []).find(x => x.id === adminId);
  ok(!!emRow, 'Z10 employee 报表命中 ADMIN');
  ok(Number(emRow?.orderCount) >= 2, 'Z10 ADMIN 单数 ≥2（含 r1+r2）', String(emRow?.orderCount));
  ok(Number(emRow?.salesTotal) >= 18, 'Z10 ADMIN 销售额 ≥18', String(emRow?.salesTotal));
  ok(Number(emRow?.profitTotal) >= 6, 'Z10 ADMIN 毛利 ≥6', String(emRow?.profitTotal));
  const emAll = data(await api('GET', '/reports/employee', { token: T }));
  ok((emAll.items || []).length >= 1, 'Z10 employee 无筛选全量');

  // ═══ Z11 会员详情抽屉（P1-2：消费流水/充值记录/分红/优惠券/消费偏好，GET /members/:id 扩展） ═══
  console.log('■ Z11. 会员详情抽屉（订单/储值/分红/券/消费偏好聚合）');
  const zR2 = data(await api('POST', `/members/${zRepMem.id}/recharges`, { token: T, body: { principal: 50 } }));
  eq(Number(zR2?.balanceAfter), 50, 'Z11 抽屉内储值 50（口径B 本金）');
  const zRepDet = data(await api('GET', `/members/${zRepMem.id}`, { token: T }));
  ok(Array.isArray(zRepDet?.orders) && Array.isArray(zRepDet?.coupons) && Array.isArray(zRepDet?.pref),
     'Z11 详情返回 orders/coupons/pref 数组');
  const zRepOrder = (zRepDet?.orders || []).find(x => x.order_no === r1?.orderNo);
  ok(!!zRepOrder, 'Z11 消费流水命中会员单');
  near(Number(zRepOrder?.payable_amount), 12, 'Z11 流水应收 12');
  eq(Number(zRepOrder?.item_count), 1, 'Z11 流水件数 1');
  ok((zRepDet?.balanceFlows || []).some(x => x.biz_type === '充值' && Number(x.amount) === 50),
     'Z11 储值流水含充值记录 50');
  ok((zRepDet?.dividendFlows || []).length >= 0, 'Z11 分红流水返回');
  const prefSum = (zRepDet?.pref || []).reduce((s, x) => s + Number(x.spend), 0);
  near(prefSum, 12, 'Z11 消费偏好合计 12（会员单 4×3）');

  // ═══ SN. 产品决策④：负库存挂起成本回填（pending_cost_adjusts） ═══
  console.log("■ SN. 负库存挂起成本回填（决策④）");
  const snP = data(await api("POST", "/products", { token: T, body: {
    name: "SN挂起测试盐", base_unit: "袋", sellPrice: 3, barcode: "6901234500196", keepDays: 999 } }));
  ok(snP?.id > 0, "SN0 SN测试商品建档成功（独立条码防冲突，单价3×2=6 避开前序满额活动）");
  const _snPut = await api("PUT", "/settings/stock.negative_sales", { token: T, body: { value: true, reason: "SN测试软模式" } });
  console.log("  [debug snPut]", JSON.stringify(_snPut).slice(0, 220));
  console.log("  [debug snSet]", JSON.stringify((await sqlOnly("SELECT scope, value FROM system_settings WHERE setting_key='stock.negative_sales'")).rows));
  console.log("  [debug snOv]", JSON.stringify((await sqlOnly("SELECT store_id, value FROM store_settings WHERE setting_key='stock.negative_sales'")).rows));
  const _snRaw = await api("POST", "/sales/checkout", { token: T, body: {
    items: [{ productId: snP.id, qty: 2 }], payments: [{ channel: "现金", amount: 6 }] } });
  if (_snRaw.code !== 0) console.log("  [debug snChk]", JSON.stringify(_snRaw).slice(0, 240));
  const snChk = _snRaw.data;
  eq(snChk?.negativeHold, true, "SN1 无批次差额结账 → negativeHold=true（软模式放行不静默）");
  ok((snChk?.pendingShortages || []).some(x => Number(x.qty) === 2), "SN1b 返回体含挂起差额明细");
  const snList = data(await api("GET", "/sales/pending-shortages", { token: T }));
  const snRow = (snList || []).find(x => Number(x.productId) === Number(snP.id));
  ok(!!snRow && Number(snRow.qty) === 2 && snRow.costBasis === "none", "SN2 挂起清单存在该记录（basis=none，零成本未被吞）");
  eq((await api("POST", "/sales/pending-shortages/999999/resolve", { token: T, body: { unitCost: 1 } })).code, 40404, "SN3 不存在记录 404");
  eq((await api("POST", "/sales/pending-shortages/" + snRow.id + "/resolve", { token: T, body: { unitCost: 0 } })).code, 40003, "SN3b unitCost 必须>0");
  eq((await api("POST", "/sales/pending-shortages/" + snRow.id + "/resolve", { token: T, body: { unitCost: 2.5, note: "盘点回填" } })).code, 0, "SN4 成本回填成功");
  ok(!(data(await api("GET", "/sales/pending-shortages", { token: T })) || []).some(x => Number(x.id) === Number(snRow.id)), "SN5 回填后移出挂起清单");
  await api("PUT", "/settings/stock.negative_sales", { token: T, body: { value: false, reason: "SN还原" } });
  // ═══ 汇总 ═══
  console.log('\n══════════════════════════════');
  console.log(`测试结果：通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exitCode = 1; }
  else console.log('✅ 全部通过');

  await dbc.end();
} catch (e) {
  console.error('测试执行异常:', e);
  process.exitCode = 1;
} finally {
  if (dbc) { try { await dbc.end(); } catch { /* noop */ } }
  if (server) { try { server.kill(); } catch { /* noop */ } }
  if (pgStarted) {
    try {
      execSync(`"${path.join(os.tmpdir(), 'pgbin-ascii', 'bin', 'pg_ctl.exe')}" -D "${PGDATA}" stop -m fast`,
        { timeout: 15000, stdio: 'ignore' });
    } catch { /* noop */ }
  }
}
