/**
 * V4.11 · Chinese-CLIP 换模型 + 文本 rerank 验证脚本（原 V4.10.1 CLIP 管线验证，持续演进）
 *   node tests/verify-v4910-clip.mjs   （在 backend 目录运行，后端 3100 已启动）
 * 覆盖：
 *   A. 登录 / 向量索引状态接口
 *   B. 一键建索引（force 全量重算，clipcn-vit-b16-quant）→ DB 断言 embedding/emb_model 落库
 *   C. E2E 识别分流：样本原图识别 → layer='clip'、Top-1 命中原商品、耗时 <3s、候选卡片存在
 *   D. 负样本（纯灰图）→ 不触发 clip 自动命中（layer !== 'clip'），管线不误报
 *   E. 兼容性：recognize 返回体保留旧字段 + ai.emb.* 设置键齐全
 *   F. 易混 SKU（V4.11）：益达实拍帧 → 图像塔直接正确命中（旧模型曾误报宜简水）
 * 全部通过退出码 0；任一失败退出码 1。
 */
import { Client } from 'pg';
import Jimp from 'jimp';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const BASE = 'http://localhost:3100';
const DB = 'postgres://postgres:password@localhost:54329/postgres';
const UPLOADS = join(process.cwd(), 'public', 'uploads');
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

console.log('══ V4.10.1 CLIP 向量识别管线 验证 ══');

// ── A. 登录与状态 ──
const lg = await api('/auth/login', { method: 'POST', body: { empNo: 'ADMIN', password: 'admin123' } });
ok(!!lg.token, 'A1 管理员登录');
const T = lg.token;
const st = await api('/ai/emb/status', { token: T });
ok(st && st.enabled === true, 'A2 /ai/emb/status 可用且 CLIP 层默认开启', JSON.stringify(st));
ok(st.modelReady === true, 'A3 CLIP 模型文件就绪', JSON.stringify(st));
ok(st.total > 0, `A4 门店已审核样本 ${st.total} 张`, 'total=0 无法验证检索');

// ── B. 全量建索引 ──
const ri = await api('/ai/emb/reindex', { method: 'POST', token: T, body: { force: true } });
ok(ri.ok && ri.found > 0, `B1 一键建索引：扫描 ${ri.found} 张，成功 ${ri.indexed} 张，失败 ${ri.failed} 张（${ri.ms}ms）`, JSON.stringify(ri));
ok(ri.indexed + ri.failed === ri.found, 'B2 索引完成度：成功+失败=扫描数（失败样本标记 clip-error 不再重试）', JSON.stringify(ri));
const pg = new Client(DB); await pg.connect();
const embCnt = await pg.query(
  `SELECT count(*)::int AS n FROM ai_samples WHERE embedding IS NOT NULL AND emb_model='clipcn-vit-b16-quant'`);
ok(embCnt.rows[0].n >= ri.indexed && embCnt.rows[0].n > 0, `B3 DB 落库向量 ${embCnt.rows[0].n} 条`, 'embedding 为空');
const dimChk = await pg.query(
  `SELECT id, jsonb_array_length(embedding) AS dim FROM ai_samples WHERE embedding IS NOT NULL LIMIT 1`);
ok(Number(dimChk.rows[0].dim) === 512, 'B4 向量维度 = 512', String(dimChk.rows[0].dim));
const st2 = await api('/ai/emb/status', { token: T });
ok(st2.indexed + st2.error === st2.total, `B5 状态同步：已索引 ${st2.indexed} + 解码失败 ${st2.error} = 总数 ${st2.total}，覆盖 ${st2.products} 个商品`, JSON.stringify(st2));
const ri2 = await api('/ai/emb/reindex', { method: 'POST', token: T, body: {} });
ok(ri2.found === 0, 'B6 增量建索引幂等：无待索引样本', JSON.stringify(ri2));

// ── C. E2E：用已索引样本原图识别 → CLIP 自动命中 ──
const srow = await pg.query(
  `SELECT s.id, s.product_id, p.name AS product_name, s.image_path
     FROM ai_samples s JOIN products p ON p.id = s.product_id
    WHERE s.embedding IS NOT NULL AND s.emb_model='clipcn-vit-b16-quant' AND s.image_path LIKE '/uploads/%'
    ORDER BY s.id DESC LIMIT 1`);
ok(srow.rows.length > 0, 'C1 找到已索引样本', '无样本');
if (srow.rows.length) {
  const f = join(UPLOADS, basename(srow.rows[0].image_path));
  ok(existsSync(f), 'C2 样本图片文件存在', f);
  if (existsSync(f)) {
    const b64 = readFileSync(f).toString('base64');
    const rec = await api('/ai/recognize', { method: 'POST', token: T, body: { imageBase64: b64, scene: 'checkout' } });
    ok(rec.layer === 'clip', `C3 识别层 = clip（实际 ${rec.layer}）`, JSON.stringify({ layer: rec.layer, notice: rec.notice }));
    ok(rec.result?.[0] && Number(rec.result[0].productId) === Number(srow.rows[0].product_id),
       `C4 Top-1 命中原商品「${srow.rows[0].product_name}」`, JSON.stringify(rec.result));
    ok(rec.result?.[0]?.conf >= 0.9, `C5 相似度 ${rec.result?.[0]?.conf} ≥ 自动采信阈值 0.90（实测标定）`);
    ok(Array.isArray(rec.candidates) && rec.candidates.length >= 1, `C6 候选卡片 ${rec.candidates?.length} 张随响应返回`);
    ok(Number(rec.latencyMs) < 3000, `C7 识别全程 ${rec.latencyMs}ms < 3000ms`, String(rec.latencyMs));
    ok(!!rec.logId && rec.engine !== undefined && Array.isArray(rec.result) && rec.notice !== undefined,
       'C8 返回体保留旧字段（兼容收银端/PWA 现有调用）');
    console.log(`     ↳ 服务端全程 ${rec.latencyMs}ms；${rec.notice || ''}`);
  }
}

// ── D. 负样本：纯灰图不应触发 clip 自动命中 ──
{
  const img = new Jimp(224, 224, 0x808080FF);
  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
  const rec = await api('/ai/recognize', { method: 'POST', token: T, body: { imageBase64: buf.toString('base64'), scene: 'checkout' } });
  ok(rec.layer !== 'clip', `D1 纯灰图未触发 CLIP 自动命中（实际层 ${rec.layer}）`, JSON.stringify({ layer: rec.layer }));
  const bad = (rec.candidates || []).some(c => (c.rawImgSim ?? c.conf) >= 0.9);
  ok(!bad, 'D2 灰图候选原始图像相似度均低于自动采信阈值 0.90（rerank 融合分不参与判定）', JSON.stringify(rec.candidates?.slice(0, 1)));
}

// ── E. 设置键完整性 ──
const ks = await pg.query(
  `SELECT setting_key FROM system_settings WHERE setting_key IN ('ai.emb.enabled','ai.emb.min_conf','ai.emb.topk','ai.emb.margin','ai.emb.strict_conf')`);
ok(ks.rows.length === 5, 'E1 ai.emb.* 五个设置键齐全', JSON.stringify(ks.rows));

// ── F. 易混 SKU 回归（V4.10.2 误判 → V4.11 Chinese-CLIP 修复）：
//        益达口香糖实拍帧曾被旧模型误自动命中为宜简水（0.961 vs 0.939）。
//        新模型图像塔应把益达排到第 1 且进 strict 快速通道，直接自动命中正确商品
{
  const ff = join(process.cwd(), 'tests', 'fixtures', 'gum-frame-misfire.jpg');
  ok(existsSync(ff), 'F1 易混 SKU 夹具存在（益达口香糖实拍帧）', ff);
  if (existsSync(ff)) {
    const b64 = readFileSync(ff).toString('base64');
    const rec = await api('/ai/recognize', { method: 'POST', token: T, body: { imageBase64: b64, scene: 'intake' } });
    ok(rec.layer === 'clip', `F2 益达帧自动命中（layer=${rec.layer}，V4.10.2 曾误报宜简水）`, JSON.stringify({ layer: rec.layer, result: rec.result }));
    ok(rec.result?.[0] && Number(rec.result[0].productId) === 75,
       `F3 命中正确商品「${rec.result?.[0]?.name}」（pid=${rec.result?.[0]?.productId}，应为 75 益达）`, JSON.stringify(rec.result));
    const top = (rec.candidates || [])[0];
    ok(top && Number(top.productId) === 75 && (top.rawImgSim ?? top.conf) >= 0.95,
       `F4 图像检索 Top1 为益达（图像相似度 ${top?.rawImgSim}）`, JSON.stringify(top));
    ok(Number(rec.latencyMs) < 3000, `F5 响应 ${rec.latencyMs}ms < 3000ms`, String(rec.latencyMs));
    console.log(`     ↳ ${rec.notice || ''}`);
  }
}

await pg.end();
console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`);
process.exit(fail ? 1 : 0);
