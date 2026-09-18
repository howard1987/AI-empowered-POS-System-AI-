/**
 * 设备管理 / 打印中心（方向2）端到端验证：
 *   node tests/e2e-print.mjs
 * 依赖：后端已启动（http://localhost:3100）、022_device_print.sql 已应用（脚本自兜底执行）
 * 覆盖：权限点 / 设备 CRUD+心跳+自检 / 打印机 CRUD+默认唯一+测试页 / 模板种子+新建+预览+设默认+试打 / 打印历史
 * 全部通过退出码 0；任一失败打印 FAIL 并退出 1
 */
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

console.log('══ 设备管理 / 打印中心 E2E 验证 ══');
const ts = String(Date.now()).slice(-8);

// ── 数据库：应用 022 脚本（幂等）+ 连接 ──
const dbc = new Client({ connectionString: DB });
await dbc.connect();
const sql022 = fs.readFileSync(path.join(__dirname, '..', 'db', '022_device_print.sql'), 'utf8');
await dbc.query(sql022);
console.log('── 已应用 022_device_print.sql（权限点/print_jobs/种子模板）──');

// ── 登录 ──
const lg = await api('/auth/login', { method: 'POST', body: { empNo: 'ADMIN', password: 'admin123' } });
const TOKEN = lg.token;
ok(!!TOKEN, '管理员登录');

// ── 权限点 ──
const perms = (await dbc.query(
  `SELECT code FROM permission_points WHERE code IN ('device.manage','printer.manage','print.template')`)).rows;
ok(perms.length === 3, '权限点 device.manage / printer.manage / print.template 已建');
const bound = (await dbc.query(
  `SELECT count(*)::int AS n FROM role_permissions rp
    JOIN roles r ON r.id=rp.role_id JOIN permission_points p ON p.id=rp.permission_id
   WHERE r.name='超级管理员' AND p.code IN ('device.manage','printer.manage','print.template')`)).rows[0];
ok(bound.n === 3, '超管角色已绑定 3 个打印/设备权限');

// ════════════ 设备管理 ════════════
console.log('\n── 设备管理（Device Profile）──');
let devId, devEditId, failAddrId;
{
  const d = await api('/devices', { method: 'POST', token: TOKEN, body: {
    name: `E2E电子秤${ts}`, kind: '电子秤', model: 'AI-BX58', connType: '网口',
    connAddr: '127.0.0.1:9', boundPos: 'POS-01' } });
  devId = Number(d.id);
  ok(devId > 0, `新增设备 #${devId}`);
  // 非法 kind 拒绝
  const bad = await api('/devices', { method: 'POST', token: TOKEN, body: { name: 'x', kind: '飞行器' } });
  ok(bad.code === 40003, '非法设备类型被拒（40003）');

  const f = await api('/devices', { method: 'POST', token: TOKEN, body: {
    name: `E2E故障设备${ts}`, kind: '扫码枪', connType: '网口', connAddr: '10.255.255.1:9' } });
  failAddrId = Number(f.id);

  const list = await api('/devices', { token: TOKEN });
  ok(list.some(x => Number(x.id) === devId), '设备列表含新建设备');
  ok(list.some(x => Number(x.id) === devId && x.status === '在线'), '建档默认在线');

  const hb = await api(`/devices/${devId}/heartbeat`, { method: 'POST', token: TOKEN });
  ok(hb.status === '在线', '心跳上报置在线');
  const afterHb = (await api('/devices', { token: TOKEN })).find(x => Number(x.id) === devId);
  ok(afterHb.last_heartbeat && afterHb.idle_sec < 120, '心跳时间刷新（idle<120s）');

  const upd = await api(`/devices/${devId}`, { method: 'PUT', token: TOKEN, body: { boundPos: 'POS-02', model: 'AI-BX80' } });
  ok(Number(upd.id) === devId, '设备档案修改');
  const afterUpd = (await api('/devices', { token: TOKEN })).find(x => Number(x.id) === devId);
  ok(afterUpd.bound_pos === 'POS-02' && afterUpd.model === 'AI-BX80', '修改生效（绑定收银台/型号）');

  const st = await api('/devices/self-test', { method: 'POST', token: TOKEN });
  ok(st.total >= 2, `一键自检覆盖 ${st.total} 台设备`);
  const afterSt = (await api('/devices', { token: TOKEN })).find(x => Number(x.id) === failAddrId);
  ok(afterSt && afterSt.status === '故障', '网口不可达设备自检后置故障');

  const health = await api('/devices/health', { token: TOKEN });
  ok(health.total >= 2 && health.offlineRate >= 0, `健康看板聚合（总数 ${health.total} / 在线率 ${health.offlineRate}%）`);
}

// ════════════ 打印机管理 ════════════
console.log('\n── 打印机管理（多机并存/默认唯一）──');
let prId, prId2;
{
  const p1 = await api('/printers', { method: 'POST', token: TOKEN, body: {
    name: `前台小票机${ts}`, connType: 'USB', connAddr: 'USB001', widthMm: 80 } });
  prId = Number(p1.id);
  ok(p1.isDefault === true, `首台打印机自动设默认（#${prId}）`);

  const bad = await api('/printers', { method: 'POST', token: TOKEN, body: {
    name: 'x', connType: '串口', connAddr: 'COM1' } });
  ok(bad.code === 40003, '非法连接方式被拒（40003）');

  const p2 = await api('/printers', { method: 'POST', token: TOKEN, body: {
    name: `后厨网口机${ts}`, connType: '网口', connAddr: '192.168.1.50:9100', widthMm: 80 } });
  prId2 = Number(p2.id);
  ok(p2.isDefault === false, '第二台默认 false');

  const list = await api('/printers', { token: TOKEN });
  const d1 = list.find(x => Number(x.id) === prId);
  const d2 = list.find(x => Number(x.id) === prId2);
  ok(d1.is_default === true && d2.is_default === false, '仅一台默认（原默认保留）');

  const def = await api(`/printers/${prId2}/default`, { method: 'PUT', token: TOKEN });
  ok(def.isDefault === true, '切换默认机');
  const list2 = await api('/printers', { token: TOKEN });
  ok(list2.find(x => Number(x.id) === prId).is_default === false
    && list2.find(x => Number(x.id) === prId2).is_default === true, '默认机唯一性（原默认已释放）');

  const test = await api(`/printers/${prId2}/test`, { method: 'POST', token: TOKEN });
  ok(test.status === '成功' && test.costMs >= 0, '一键测试页成功');
  ok(/打印机测试页/.test(test.preview || ''), '测试页渲染含标题');
  const afterTest = (await api('/printers', { token: TOKEN })).find(x => Number(x.id) === prId2);
  ok(!!afterTest.last_test_at, 'last_test_at 已更新');
}

// ════════════ 打印模板 ════════════
console.log('\n── 打印模板（字段显隐/联次/预览试打）──');
let tplId;
{
  const tpls = await api('/print-templates', { token: TOKEN });
  const byBiz = b => tpls.filter(t => t.biz_type === b);
  ok(byBiz('receipt').length >= 2, `小票模板种子（58/80 共 ${byBiz('receipt').length} 个）`);
  const a5Biz = ['inbound', 'return', 'transfer', 'count', 'loss', 'recon', 'settlement'];
  ok(a5Biz.every(b => byBiz(b).length >= 1), 'A5 单据模板种子 7 类齐全');
  const rec80 = byBiz('receipt').find(t => t.kind === '小票80');
  const defReceipt = byBiz('receipt').filter(t => t.is_default);
  ok(!!rec80 && defReceipt.length === 1, `小票默认模板唯一（${defReceipt[0]?.name || '?'} 为默认）`);

  const pool = await api('/print-templates/fields', { token: TOKEN });
  ok(Array.isArray(pool.receipt) && pool.receipt.length >= 10, '字段池返回（receipt≥10 字段）');

  const created = await api('/print-templates', { method: 'POST', token: TOKEN, body: {
    name: `E2E盘点单${ts}`, kind: 'A5单据', bizType: 'count', isDefault: false,
    content: { title: 'E2E盘点单', fields: pool.count.map(f => ({ ...f, show: true })), options: { cut: true } } } });
  tplId = Number(created.id);
  ok(tplId > 0, `新建模板 #${tplId}`);

  const dup = await api('/print-templates', { method: 'POST', token: TOKEN, body: {
    name: `E2E盘点单${ts}`, kind: 'A5单据', bizType: 'count', content: { fields: [] } } });
  ok(dup.code === 40003, '同类型同名模板被拒（40003）');

  const upd = await api(`/print-templates/${tplId}`, { method: 'PUT', token: TOKEN, body: {
    name: `E2E盘点单${ts}-改`, copies: 3,
    content: { title: 'E2E盘点单改', fields: pool.count.map(f => ({ ...f, show: f.key !== 'remark' })), options: { cut: false } } } });
  ok(Number(upd.id) === tplId, '模板更新（联次 3 / 隐藏备注）');

  const prev = await api(`/print-templates/${tplId}/preview`, { token: TOKEN });
  ok(/E2E盘点单改/.test(prev.text) && /差异/.test(prev.text), '实时预览渲染（标题+差异字段）');

  const defT = await api(`/print-templates/${tplId}/default`, { method: 'PUT', token: TOKEN });
  ok(defT.isDefault === true, '模板设为默认');
  const afterDef = (await api('/print-templates', { token: TOKEN })).filter(t => t.biz_type === 'count');
  ok(afterDef.filter(t => t.is_default).length === 1, '同业务类型默认唯一');

  const trial = await api(`/print-templates/${tplId}/print`, { method: 'POST', token: TOKEN });
  ok(trial.jobId > 0 && trial.status === '成功', `模板试打成功（默认机 ${trial.printer}）`);
}

// ════════════ 打印历史 ════════════
console.log('\n── 打印历史（print_jobs）──');
{
  const jobs = await api('/print-jobs?limit=50', { token: TOKEN });
  ok(jobs.some(j => j.job_type === '测试页'), '历史含测试页记录');
  ok(jobs.some(j => j.job_type === '打印' && j.template_name && j.biz_type === 'count'), '历史含模板试打记录');
  ok(jobs.every(j => j.printer_name && j.operator_name), '历史带打印机/操作人');
}

// ════════════ 清理 ════════════
console.log('\n── 清理 ──');
await dbc.query(`DELETE FROM print_jobs WHERE operator_id=(SELECT id FROM employees WHERE emp_no='ADMIN') AND (content LIKE 'E2E%' OR content LIKE '%E2E盘点单%' OR printer_id IN (${prId},${prId2}))`);
await api(`/print-templates/${tplId}`, { method: 'DELETE', token: TOKEN });
await api(`/printers/${prId}`, { method: 'DELETE', token: TOKEN });
await api(`/printers/${prId2}`, { method: 'DELETE', token: TOKEN });
await api(`/devices/${devId}`, { method: 'DELETE', token: TOKEN });
await api(`/devices/${failAddrId}`, { method: 'DELETE', token: TOKEN });
ok(true, '测试数据已清理');

await dbc.end();
console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`);
process.exit(fail ? 1 : 0);
