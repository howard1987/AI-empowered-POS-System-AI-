/**
 * audit-settings.mjs · 设置项孤儿/重复审计工具（V4.28.9 转正自一次性审计脚本）
 *
 * 用途：新增/修改 system_settings 设置项后自查——凡"库里存在、四端代码零引用"的键即孤儿（摆设），
 *      会在下次审计中现形。上一轮已借此清理 4 个孤儿键（points.redeem_rate 等，迁移 139）。
 *
 * 方法：库内全部 setting_key → 在四端代码（backend/src、backend/public、frontend-web、
 *      frontend-desktop）做字面引用扫描（排除 db 种子自身与 node_modules/dist 等构建目录）；
 *      零直接命中再用前缀（前两段）扫一遍（兼容 scale.tx.* 这类动态拼键）→ 仍零命中 = 孤儿候选。
 *
 * 用法：node scripts/audit-settings.mjs          （需能连到运行中的内置 PG，端口 54329）
 *      DATABASE_URL=postgres://... node scripts/audit-settings.mjs   （外部库）
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const ROOTUP = path.resolve(BACKEND, '..');
const SCANS = [
  ['backend/src', path.join(BACKEND, 'src')],
  ['backend/public', path.join(BACKEND, 'public')],
  ['frontend-web', path.join(ROOTUP, 'frontend-web')],
  ['frontend-desktop', path.join(ROOTUP, 'frontend-desktop')],
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-build', 'dist-modern', 'dist-win7', '.git', 'logs', '.runtime', 'certs', 'release']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.json', '.vue', '.xml']);

function walk(dir, files = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, files); }
    else if (TEXT_EXT.has(path.extname(e.name))) files.push(full);
  }
  return files;
}
function buildIndex() {
  const idx = [];
  for (const [area, dir] of SCANS) for (const f of walk(dir)) {
    try { idx.push({ area, file: f, content: fs.readFileSync(f, 'utf8') }); } catch { /* skip */ }
  }
  return idx;
}
const countHits = (idx, needle) => {
  let n = 0;
  for (const doc of idx) {
    let i = doc.content.indexOf(needle);
    while (i !== -1) { n++; i = doc.content.indexOf(needle, i + needle.length); }
  }
  return n;
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@127.0.0.1:54329/postgres' });
const r = await pool.query(`SELECT setting_key, group_name, display_name, remark FROM system_settings ORDER BY group_name, setting_key`);
await pool.end();
console.log(`库内设置键总数: ${r.rows.length}`);
const idx = buildIndex();
console.log(`扫描文件数: ${idx.length}\n`);

const orphans = [], prefixOnly = [];
for (const k of r.rows) {
  const key = k.setting_key;
  if (countHits(idx, key) > 0) continue;
  const segs = key.split('.');
  const prefix = segs.slice(0, 2).join('.') + '.';
  const prefixHits = countHits(idx, prefix);
  if (prefixHits > 0) prefixOnly.push({ key, prefix, prefixHits, group: k.group_name, name: k.display_name });
  else orphans.push({ key, group: k.group_name, name: k.display_name, remark: (k.remark || '').slice(0, 60) });
}

console.log('══ 孤儿候选（全代码零引用，含前缀）——应删除或接线 ══');
orphans.forEach(o => console.log(`  [${o.group}] ${o.key} ｜ ${o.name} ｜ ${o.remark}`));
console.log('\n══ 仅前缀命中（动态拼键，人工确认前缀是否真消费到该键）══');
prefixOnly.forEach(o => console.log(`  [${o.group}] ${o.key} ｜ 前缀 ${o.prefix}（${o.prefixHits} 处）｜ ${o.name}`));
console.log(`\n结果：孤儿候选 ${orphans.length} 个；仅前缀命中 ${prefixOnly.length} 个`);
process.exit(orphans.length ? 1 : 0);   // 非零退出码便于 CI/脚本联用
