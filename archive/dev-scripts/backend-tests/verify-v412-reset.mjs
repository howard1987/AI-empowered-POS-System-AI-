/**
 * V4.12 回归：系统初始化（开业前清库）
 *   A preview 结构；B 防护（confirm/模式非法）；C 保留档执行真清并断言；
 *   D ai_samples/ai_name_embs 备份→恢复（保护 CLIP 回归资产）；E 骨架完好 smoke。
 * ⚠️ 本脚本会真实清空联调库业务数据（ai_samples 已自动备份恢复，其余为调试数据不恢复）。
 * 运行：node tests/verify-v412-reset.mjs
 */
import { Client } from 'pg';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const API = 'http://localhost:3100';
const PG = 'postgres://postgres:password@localhost:54329/postgres';
const BAK = fileURLToPath(new URL('./fixtures/reset-ai-samples-backup.json', import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' ｜ ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' ｜ ' + extra : ''}`); }
};
const pg = new Client({ connectionString: PG });

async function login() {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }),
  }).then(r => r.json());
  return r.data?.token;
}
const apiRaw = async (method, path, token, body) => fetch(`${API}${path}`, {
  method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}).then(r => r.json());
const cnt = async (t) => (await pg.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
const toJsonbSafe = v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

async function backupAI() {
  const dump = {};
  for (const t of ['ai_samples', 'ai_name_embs']) {
    dump[t] = (await pg.query(`SELECT * FROM "${t}" ORDER BY id`)).rows;
  }
  writeFileSync(BAK, JSON.stringify(dump));
  return dump;
}
async function restoreAI(dump) {
  for (const [t, rows] of Object.entries(dump)) {
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    for (const r0 of rows) {
      // ai_samples.task_id 引用 ai_tasks（调试期任务，已被初始化清空）→ 置空元数据链接，样本本体保留
      const r = { ...r0, ...(t === 'ai_samples' ? { task_id: null } : {}) };
      const vals = cols.map(c => toJsonbSafe(r[c]));
      await pg.query(
        `INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
         ON CONFLICT DO NOTHING`, vals);
    }
    await pg.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT max(id) FROM "${t}"), 1))`);
  }
}

try {
  await pg.connect();
  console.log('A · 预览接口');
  const T = await login();
  ok(!!T, 'A1 ADMIN 登录');
  const p = await apiRaw('GET', '/admin/reset/preview', T);
  ok(p.code === 0 && p.data?.groups?.length >= 6 && Array.isArray(p.data.keepAlways),
     'A2 preview 分组结构齐全', `business=${p.data.total} master=${p.data.masterTotal} device=${p.data.deviceTotal}`);
  ok(p.data.keepAlways.some(x => x.name === 'employees' && x.n > 0), 'A3 骨架表在永不清清单中');

  console.log('B · 执行防护');
  const bad1 = await apiRaw('POST', '/admin/reset/execute', T, { mode: 'full', confirm: '清空' });
  ok(bad1.code !== 0, 'B1 confirm 文字不符被拒', bad1.msg);
  const bad2 = await apiRaw('POST', '/admin/reset/execute', T, { mode: 'wipe-all', confirm: '初始化' });
  ok(bad2.code !== 0, 'B2 非法模式被拒', bad2.msg);

  console.log('C · 保留档模式执行（真清）');
  // 先丢一条垃圾日志进清空范围，验证确实被清
  await pg.query(`INSERT INTO audit_logs (store_id, employee_id, module, action) VALUES (1, 1, '测试', '垃圾数据')`);
  const before = {
    products: await cnt('products'), suppliers: await cnt('suppliers'),
    sales_orders: await cnt('sales_orders'), members: await cnt('members'),
    batches: await cnt('batches'), devices: await cnt('devices'),
    employees: await cnt('employees'), system_settings: await cnt('system_settings'),
  };
  console.log('  · 清前基线：', JSON.stringify(before));
  const dump = await backupAI();
  console.log(`  · AI 样本已备份：ai_samples=${dump.ai_samples.length} ai_name_embs=${dump.ai_name_embs.length} → ${BAK}`);

  const ex = await apiRaw('POST', '/admin/reset/execute', T, { mode: 'keep-master', confirm: '初始化' });
  ok(ex.code === 0 && ex.data?.ok === true, 'C1 保留档初始化执行成功', `${ex.data?.tables} 表 / ${ex.data?.rowsCleared} 行`);
  ok(await cnt('sales_orders') === 0 && before.sales_orders >= 0, 'C2 交易表已清空');
  ok(await cnt('members') === 0, 'C3 会员数据已清空');
  ok(await cnt('batches') === 0, 'C4 库存批次已清空');
  ok(await cnt('audit_logs') === 1, 'C5 日志表仅剩本次初始化留痕');
  const initLog = (await pg.query(`SELECT module, action FROM audit_logs ORDER BY id DESC LIMIT 1`)).rows[0];
  ok(initLog?.action === '系统初始化', 'C6 审计记录=系统初始化', `${initLog?.module}`);
  ok(await cnt('products') === before.products, 'C7 商品档案保留', `${before.products} 行`);
  ok(await cnt('suppliers') === before.suppliers, 'C8 供应商档案保留');
  ok(await cnt('devices') === before.devices, 'C9 设备配置默认保留');
  ok(await cnt('ai_samples') === 0, 'C10 AI 样本已清（稍后恢复）');

  console.log('D · AI 样本恢复（保护 CLIP 回归资产）');
  await restoreAI(dump);
  ok(await cnt('ai_samples') === dump.ai_samples.length, 'D1 ai_samples 已恢复', `${dump.ai_samples.length} 行`);
  ok(await cnt('ai_name_embs') === dump.ai_name_embs.length, 'D2 ai_name_embs 已恢复', `${dump.ai_name_embs.length} 行`);

  console.log('E · 骨架完好 smoke');
  const T2 = await login();
  ok(!!T2, 'E1 初始化后 ADMIN 仍可登录');
  ok(await cnt('system_settings') === before.system_settings, 'E2 系统配置完好');
  const p2 = await apiRaw('GET', '/admin/reset/preview', T2);
  ok(p2.code === 0 && p2.data.total < 50, 'E2 业务数据近乎归零', `剩余 business=${p2.data.total}（AI 样本已恢复部分）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('FATAL', e.message);
  process.exitCode = 1;
} finally {
  try { await pg.end(); } catch { /* ignore */ }
}
