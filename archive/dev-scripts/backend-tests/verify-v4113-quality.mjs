/**
 * V4.11.3 回归：M4 长期闭环（纠正回传 + 识别质量报表）
 *   A 迁移/接口就绪；B 识别落日志带 layer；C 纠正回传（保留件→样本库）；
 *   D 全移除纠正（不建样本）；E quality 统计口径；F 前端静态接入点。
 * 运行：node tests/verify-v4113-quality.mjs（需后端 :3100 + PG 54329 已应用 044 迁移）
 */
import { Client } from 'pg';
import Jimp from 'jimp';

const API = 'http://localhost:3100';
const PG = 'postgres://postgres:password@localhost:54329/postgres';
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
const api = async (method, path, token, body) => {
  const r = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(r => r.json());
  if (r.code !== 0) throw new Error(`${path} → #${r.code} ${r.msg}`);
  return r.data;
};

/** 生成一帧纯色测试图（走完整识别链路落日志；无匹配样本时 result 为空不影响） */
async function frame() {
  const img = new Jimp(640, 480, '#e8e4dc');
  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
  return buf.toString('base64');
}

try {
  await pg.connect();
  console.log('A · 迁移与接口就绪');
  const col = await pg.query(`SELECT 1 FROM information_schema.columns WHERE table_name='ai_recognition_logs' AND column_name='layer'`);
  ok(col.rows.length === 1, 'A1 ai_recognition_logs.layer 列已建');

  const T = await login();
  ok(!!T, 'A2 ADMIN 登录');

  const q0 = await api('GET', '/ai/quality', T);
  ok(q0 && q0.summary && Array.isArray(q0.trend) && Array.isArray(q0.layerDist)
     && Array.isArray(q0.sceneDist) && Array.isArray(q0.corrTop) && Array.isArray(q0.recent),
     'A3 GET /ai/quality 六段结构齐全', `近30天 total=${q0.summary.total}`);

  console.log('B · 识别落日志（layer 列）');
  const before = (await pg.query(`SELECT count(*)::int AS n FROM ai_recognition_logs`)).rows[0].n;
  const rec = await api('POST', '/ai/recognize', T, { imageBase64: await frame(), scene: 'checkout', mode: 'multi' });
  ok(!!rec?.logId, 'B1 recognize 返回 logId', `layer=${rec?.layer}`);
  const after = (await pg.query(`SELECT count(*)::int AS n FROM ai_recognition_logs`)).rows[0].n;
  ok(after === before + 1, 'B2 识别日志 +1');
  const lastLog = (await pg.query(`SELECT id, layer, scene FROM ai_recognition_logs ORDER BY id DESC LIMIT 1`)).rows[0];
  ok(Number(lastLog.id) === Number(rec.logId), 'B3 日志 ID 与响应一致');
  ok(lastLog.layer === (rec.layer ?? null), 'B4 layer 已落库', `db=${lastLog.layer}`);

  console.log('C · 纠正回传（保留件 → 样本库）');
  const prod = (await pg.query(`SELECT id, name FROM products WHERE store_id=1 AND deleted_at IS NULL AND status=1 ORDER BY id LIMIT 1`)).rows[0];
  ok(!!prod, 'C0 取到测试商品', `#${prod?.id} ${prod?.name}`);
  const sBefore = (await pg.query(`SELECT count(*)::int AS n FROM ai_samples WHERE source='识别纠正'`)).rows[0].n;
  const c1 = await api('POST', `/ai/recognize/${rec.logId}/correct`, T, { corrected: [{ productId: prod.id, count: 2 }] });
  ok(c1?.ok === true && Number(c1?.sampleId) > 0, 'C1 correct 保留件纠正成功且建样本', `sampleId=${c1?.sampleId}`);
  const sAfter = (await pg.query(`SELECT count(*)::int AS n FROM ai_samples WHERE source='识别纠正'`)).rows[0].n;
  ok(sAfter === sBefore + 1, 'C2 识别纠正样本 +1');
  const logC = (await pg.query(`SELECT corrected, corrected_json FROM ai_recognition_logs WHERE id=$1`, [rec.logId])).rows[0];
  const cj = typeof logC.corrected_json === 'string' ? JSON.parse(logC.corrected_json) : logC.corrected_json;
  ok(logC.corrected === true && Array.isArray(cj) && Number(cj[0]?.count) === 2, 'C3 日志 corrected=true 且纠正数落库');

  console.log('D · 全移除纠正（count=0 不建样本）');
  const rec2 = await api('POST', '/ai/recognize', T, { imageBase64: await frame(), scene: 'count', mode: 'multi' });
  const sBefore2 = (await pg.query(`SELECT count(*)::int AS n FROM ai_samples WHERE source='识别纠正'`)).rows[0].n;
  const c2 = await api('POST', `/ai/recognize/${rec2.logId}/correct`, T, { corrected: [{ productId: prod.id, count: 0 }] });
  ok(c2?.ok === true && (c2?.sampleId ?? null) === null, 'D1 全移除纠正成功且不建样本');
  const sAfter2 = (await pg.query(`SELECT count(*)::int AS n FROM ai_samples WHERE source='识别纠正'`)).rows[0].n;
  ok(sAfter2 === sBefore2, 'D2 样本数不变');

  console.log('D2 · V4.11.5 manualAdd 不建样本 + 多保留品各建样本');
  const prod2 = (await pg.query(`SELECT id FROM products WHERE store_id=1 AND deleted_at IS NULL AND status=1 AND id<>$1 ORDER BY id LIMIT 1`, [prod.id])).rows[0];
  ok(!!prod2, 'D2a 取到第二测试商品', `#${prod2?.id}`);
  const rec3 = await api('POST', '/ai/recognize', T, { imageBase64: await frame(), scene: 'checkout', mode: 'multi' });
  const sB3 = (await pg.query(`SELECT count(*)::int AS n FROM ai_samples WHERE source='识别纠正'`)).rows[0].n;
  const c3 = await api('POST', `/ai/recognize/${rec3.logId}/correct`, T, {
    corrected: [{ productId: prod.id, count: 1 }, { productId: prod2.id, count: 1, manualAdd: true }],
  });
  ok(c3?.ok === true && Array.isArray(c3?.sampleIds) && c3.sampleIds.length === 1,
     'D3 manualAdd 不建样本，仅保留品建 1 条', JSON.stringify(c3?.sampleIds));
  const rec4 = await api('POST', '/ai/recognize', T, { imageBase64: await frame(), scene: 'checkout', mode: 'multi' });
  const c4 = await api('POST', `/ai/recognize/${rec4.logId}/correct`, T, {
    corrected: [{ productId: prod.id, count: 1 }, { productId: prod2.id, count: 2 }],
  });
  ok(c4?.ok === true && Array.isArray(c4?.sampleIds) && c4.sampleIds.length === 2,
     'D4 两个保留品各建一条样本', JSON.stringify(c4?.sampleIds));
  const sA3 = (await pg.query(`SELECT count(*)::int AS n FROM ai_samples WHERE source='识别纠正'`)).rows[0].n;
  ok(sA3 === sB3 + 3, 'D5 识别纠正样本总数 +3（1+2）', `${sB3} → ${sA3}`);
  let d6 = '';
  try { await api('POST', `/ai/recognize/${rec4.logId}/correct`, T, { corrected: [] }); d6 = 'no-throw(未拒绝!)'; }
  catch (e) { d6 = String(e?.message || e); }
  ok(d6.includes('40003'), 'D6 空纠正仍拒绝（40003）', d6);

  console.log('E · quality 统计口径');
  const q1 = await api('GET', '/ai/quality', T);
  ok(q1.summary.total >= q0.summary.total + 2, 'E1 识别总量含本轮新增', `${q0.summary.total} → ${q1.summary.total}`);
  ok(q1.summary.corrected >= 2, 'E2 纠正数 ≥2', `corrected=${q1.summary.corrected}`);
  ok(q1.summary.low_conf >= 0 && q1.summary.low_conf_closed >= 0, 'E3 低置信/闭环字段存在');
  ok((q1.sceneDist || []).some(x => x.scene === 'count'), 'E4 场景分布含 count');
  ok((q1.recent || []).some(x => x.corrected === true), 'E5 最近记录含已纠正');
  ok((q1.corrTop || []).some(x => Number(x.productId) === Number(prod.id)), 'E6 纠正TOP 含测试商品');
  const avgOk = q1.summary.avg_ms >= 0;
  ok(avgOk, 'E7 平均时延字段有效', `avg=${q1.summary.avg_ms}ms`);

  console.log('F · 前端静态接入点');
  const { readFileSync } = await import('fs');
  const scan = readFileSync('public/pwa/ai-scan.js', 'utf8');
  ok(scan.includes('/ai/recognize/${lastLogId}/correct'), 'F1 PWA ai-scan 已接纠正回传');
  ok(scan.includes('reportCorrection') && scan.includes('aiCount'), 'F2 纠正比对基准（AI 断言冻结）存在');
  const boss = readFileSync('public/boss/app.js', 'utf8');
  ok(boss.includes("'/ai/quality'") && boss.includes('View.aiQuality'), 'F3 老板端报表已接入 /ai/quality');
  ok(boss.includes('rAiQ'), 'F4 报表入口卡片已挂');
  ok(scan.includes('manualAdd: true'), 'F5 V4.11.5 手输补录打 manualAdd 标记');
  ok(scan.includes('cropBox: it.cropBox'), 'F6 候选/命中回传携带 cropBox');
  ok(/reportCorrection\(chosen\);\s*\n\s*if \(chosen\.length\)/.test(scan), 'F7 整单全取消也回传（回传移出 chosen.length 分支）');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('FATAL', e.message);
  process.exitCode = 1;
} finally {
  try { await pg.end(); } catch { /* ignore */ }
}
