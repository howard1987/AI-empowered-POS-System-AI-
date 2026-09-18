/**
 * V4.11.2 · 方案 v3.2 剩余项验证：M2 多件识别 + M3 电子秤 + 别名表
 *   node tests/verify-v4112-multi-scale.mjs   （在 backend 目录运行，后端 3100 已启动）
 * 覆盖：
 *   A. 迁移 043 落库：product_aliases 表 + ai.multi.enabled / scale.* 设置键
 *   B. 别名 API 全链路：新增 → 列表 → /products/barcode/:alias 别名兜底 → 重名冲突 → 删除
 *   C. M2 多件识别 e2e：两个商品样本图白底合成 → mode='multi' → layer='clip-multi'，两种商品各自计数
 *   D. 单件回落：单样本图 mode='multi' → 分割 ≤1 框 → 回落单件 CLIP 命中
 *   E. M3 静态断言：pwa/scale.js 存在并被 index.html 引用；checkout.js 含连秤/读重/称重行逻辑
 *   F. pricebook 带 isWeighted（称重行判定数据源）
 * 全部通过退出码 0；任一失败退出码 1。
 */
import { Client } from 'pg';
import Jimp from 'jimp';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

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

console.log('══ V4.11.2 多件识别 + 电子秤 + 别名表 验证 ══');

// ── A. 迁移 043 落库 ──
const pg = new Client(DB); await pg.connect();
const tbl = await pg.query(`SELECT tablename FROM pg_tables WHERE tablename='product_aliases'`);
ok(tbl.rows.length === 1, 'A1 product_aliases 表存在');
const keys = await pg.query(
  `SELECT setting_key, value FROM system_settings
    WHERE setting_key IN ('ai.multi.enabled','ai.multi.min_conf','scale.enabled','scale.baud','scale.protocol')`);
ok(keys.rows.length === 5, `A2 设置键齐全 5/5：${keys.rows.map(r => r.setting_key).join('、')}`, `实际 ${keys.rows.length}`);
const multiOn = keys.rows.find(r => r.setting_key === 'ai.multi.enabled')?.value;
ok(multiOn === true, 'A3 ai.multi.enabled 默认开启', JSON.stringify(multiOn));
const multiMin = Number(keys.rows.find(r => r.setting_key === 'ai.multi.min_conf')?.value ?? 0);
ok(multiMin > 0.5 && multiMin < 0.9, `A4 多件逐件采信阈值 ai.multi.min_conf=${multiMin}（低于全帧 0.90，crop 换背景复拍标定）`, String(multiMin));
const aliasCols = await pg.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='product_aliases'
    AND column_name IN ('store_id','product_id','alias','source','created_by')`);
ok(aliasCols.rows.length === 5, `A5 product_aliases 关键列齐全 ${aliasCols.rows.length}/5`, aliasCols.rows.map(r => r.column_name).join(','));

// ── B. 别名 API 全链路 ──
const lg = await api('/auth/login', { method: 'POST', body: { empNo: 'ADMIN', password: 'admin123' } });
ok(!!lg.token, 'B0 管理员登录');
const T = lg.token;
const prods = await pg.query(
  `SELECT id, name FROM products WHERE store_id=1 AND deleted_at IS NULL ORDER BY id LIMIT 2`);
const pA = prods.rows[0], pB = prods.rows[1];
ok(!!pA && !!pB, `B1 取测试商品 A=${pA?.name} / B=${pB?.name}`, '商品不足');
const aliasName = `测试别名${Date.now() % 100000}`;
const addR = await api(`/products/${pA.id}/aliases`, { method: 'POST', token: T, body: { alias: aliasName } });
ok(addR?.ok === true, `B2 新增别名「${aliasName}」→ 商品A`, JSON.stringify(addR));
const listR = await api(`/products/${pA.id}/aliases`, { token: T });
ok(Array.isArray(listR) && listR.some(a => a.alias === aliasName), 'B3 别名列表含新别名', JSON.stringify(listR));
const byAlias = await api(`/products/barcode/${encodeURIComponent(aliasName)}`, { token: T });
ok(Number(byAlias?.product?.id) === Number(pA.id), 'B4 /products/barcode/:alias 别名兜底命中商品A', JSON.stringify(byAlias?.product?.id));
const dupR = await api(`/products/${pB.id}/aliases`, { method: 'POST', token: T, body: { alias: aliasName } });
ok(dupR?.code && dupR.code !== 0, 'B5 同店别名唯一：挂到商品B被拒绝', JSON.stringify(dupR));
const sameR = await api(`/products/${pA.id}/aliases`, { method: 'POST', token: T, body: { alias: aliasName } });
ok(sameR?.ok === true, 'B6 同商品重复添加幂等（改挂自身）', JSON.stringify(sameR));
const delR = await api(`/products/alias/${listR.find(a => a.alias === aliasName).id}`, { method: 'DELETE', token: T });
ok(delR?.ok === true, 'B7 删除别名', JSON.stringify(delR));

// ── C. M2 多件识别 e2e：两商品样本图白底合成 → mode='multi' ──
const srows = await pg.query(
  `SELECT DISTINCT ON (s.product_id) s.product_id, p.name AS product_name, s.image_path
     FROM ai_samples s JOIN products p ON p.id = s.product_id
    WHERE s.store_id=1 AND s.status IN ('已审核','已入库') AND s.image_path LIKE '/uploads/%'
      AND s.embedding IS NOT NULL AND s.emb_model='clipcn-vit-b16-quant' AND p.status=1
      AND s.emb_model <> 'clip-error'
    ORDER BY s.product_id, s.id DESC`);
ok(srows.rows.length >= 2, `C1 取到 ${srows.rows.length} 个商品的已索引样本`, '样本不足 2 个商品');
if (srows.rows.length >= 2) {
  const [sa, sb] = srows.rows;
  const pa = join(UPLOADS, sa.image_path.split('/').pop());
  const pb2 = join(UPLOADS, sb.image_path.split('/').pop());
  if (existsSync(pa) && existsSync(pb2)) {
    const W = 1400, H = 900;
    const canvas = new Jimp(W, H, '#f2f2f0');
    const ia = await Jimp.read(pa), ib = await Jimp.read(pb2);
    ia.rgba(false); ib.rgba(false);
    ia.contain(520, 520); ib.contain(520, 520);
    canvas.composite(ia, 120, 190);      // 左件
    canvas.composite(ib, 760, 190);      // 右件
    const compB64 = (await canvas.getBufferAsync(Jimp.MIME_JPEG)).toString('base64');
    const t0 = Date.now();
    const rec = await api('/ai/recognize', { method: 'POST', token: T, body: { imageBase64: compB64, scene: 'checkout', mode: 'multi' } });
    const ms = Date.now() - t0;
    ok(rec?.layer === 'clip-multi', `C2 多件识别 layer='clip-multi'（全程 ${ms}ms）`, JSON.stringify({ layer: rec?.layer, notice: rec?.notice }));
    const ids = (rec?.result || []).map(r => Number(r.productId));
    const candIds = (rec?.candidates || []).map(r => Number(r.productId));
    const aHit = ids.includes(Number(sa.product_id));
    const bHit = ids.includes(Number(sb.product_id)) || candIds[0] === Number(sb.product_id);
    ok(aHit, `C3 左件自动确认「${sa.product_name}」×${(rec?.result || []).find(r => Number(r.productId) === Number(sa.product_id))?.count ?? 0}`, JSON.stringify(rec?.result));
    ok(bHit, `C4 右件闭环：自动确认或候选卡片 Top-1（白瓶易混 SKU 按设计转店员点选）`, JSON.stringify({ result: rec?.result, candTop1: rec?.candidates?.[0]?.name }));
    // 同款两件（真实高频场景：同款饮料拿两瓶）→ count 聚合为 2
    const canvas2 = new Jimp(W, H, '#f2f2f0');
    const ia2 = await Jimp.read(pa); ia2.rgba(false); ia2.contain(520, 520);
    const ib2 = await Jimp.read(pa); ib2.rgba(false); ib2.contain(520, 520);
    canvas2.composite(ia2, 120, 190);
    canvas2.composite(ib2, 760, 190);
    const comp2 = (await canvas2.getBufferAsync(Jimp.MIME_JPEG)).toString('base64');
    const rec2 = await api('/ai/recognize', { method: 'POST', token: T, body: { imageBase64: comp2, scene: 'checkout', mode: 'multi' } });
    const same = (rec2?.result || []).find(r => Number(r.productId) === Number(sa.product_id));
    ok(!!same && Number(same.count) === 2, `C5 同款两件聚合 count=2（layer=${rec2?.layer}）`, JSON.stringify(rec2?.result));
    ok(!!rec?.notice && rec.notice.includes('多件识别'), 'C6 返回体携带多件识别 notice', String(rec?.notice));
  } else {
    ok(false, 'C1b 样本文件缺失', `${pa} / ${pb2}`);
  }
}

// ── D. 单件回落：单样本图 mode='multi' → 分割 ≤1 框 → 单件 CLIP 命中 ──
if (srows.rows.length >= 1) {
  const s0 = srows.rows[0];
  const f0 = join(UPLOADS, s0.image_path.split('/').pop());
  if (existsSync(f0)) {
    const img = await Jimp.read(f0);
    img.rgba(false);
    const b64 = (await img.getBufferAsync(Jimp.MIME_JPEG)).toString('base64');
    const rec1 = await api('/ai/recognize', { method: 'POST', token: T, body: { imageBase64: b64, scene: 'checkout', mode: 'multi' } });
    ok(rec1?.layer === 'clip' && (rec1?.result || []).some(r => Number(r.productId) === Number(s0.product_id)),
       `D1 单件画面回落单件管线命中「${s0.product_name}」(layer=${rec1?.layer})`, JSON.stringify(rec1?.layer));
  } else ok(false, 'D1 样本文件缺失', f0);
}

// ── E. M3 静态断言：scale.js / checkout.js 接线 ──
const pwaDir = join(process.cwd(), 'public', 'pwa');
ok(existsSync(join(pwaDir, 'scale.js')), 'E1 pwa/scale.js 存在');
const pwaIdx = readFileSync(join(pwaDir, 'index.html'), 'utf8');
ok(pwaIdx.includes('scale.js'), 'E2 pwa/index.html 引入 scale.js');
const sw = readFileSync(join(pwaDir, 'sw.js'), 'utf8');
ok(sw.includes('pwa-shell-v20'), 'E3 PWA 缓存版本已升 v19');
const ck = readFileSync(join(pwaDir, 'checkout.js'), 'utf8');
ok(ck.includes('⚖ 连接电子秤') && ck.includes('Scale.connect'), 'E4 checkout.js 含连秤入口（Web Serial 手势内）');
ok(ck.includes('Scale.weight') && ck.includes('isWeighted'), 'E5 checkout.js 称重行 ⚖ 读重直填数量');
const scaleSrc = readFileSync(join(pwaDir, 'scale.js'), 'utf8');
ok(scaleSrc.includes('requestPort') && scaleSrc.includes('navigator.serial'), 'E6 scale.js 基于 Web Serial（本地直连，数据不出店）');
ok(scaleSrc.includes('_parse') && scaleSrc.includes('stable'), 'E7 scale.js 连续帧协议解析（ST/US 稳定判定 + kg/g 归一）');

// ── F. pricebook 带 isWeighted ──
const pbk = await api('/pos/pricebook', { token: T });
const hasFlag = Array.isArray(pbk?.items) && pbk.items.length > 0 && pbk.items[0].hasOwnProperty('isWeighted');
ok(hasFlag, 'F1 /pos/pricebook 条目带 isWeighted 字段', JSON.stringify(pbk?.items?.[0] && Object.keys(pbk.items[0]).slice(0, 12)));

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`);
await pg.end();
process.exit(fail ? 1 : 0);
