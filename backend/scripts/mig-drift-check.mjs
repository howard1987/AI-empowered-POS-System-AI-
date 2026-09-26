/* 临时工具：比对 db/*.sql 的 sha256 与 schema_migrations 记账，列出漂移；
   --fix 模式把漂移记录的 checksum 更新为当前文件值（承认新基线，仅用于有意修改过的历史迁移）。
   背景：001_init.sql 在历史批次中被有意扩充（列/索引），实际 schema 变更均已通过后续迁移应用，
   重放 001 反而有种子重复风险 → 采用"更新基线"而非"删除记录重跑"。 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require2 = createRequire(path.join(ROOT, 'package.json'));
const { Client } = require2('pg');

const DB = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:54329/postgres';
const fix = process.argv.includes('--fix');

const c = new Client({ connectionString: DB });
await c.connect();
const known = (await c.query(`SELECT name, checksum FROM schema_migrations`)).rows;
const dir = path.join(ROOT, 'db');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
const drifted = [];
for (const f of files) {
  const sum = createHash('sha256').update(fs.readFileSync(path.join(dir, f), 'utf8')).digest('hex');
  const rec = known.find(k => k.name === f);
  if (!rec) continue;                      // 未记账（新文件）→ 由 init-db 正常执行
  if (rec.checksum !== sum) drifted.push({ f, old: rec.checksum.slice(0, 12), now: sum });
}
if (!drifted.length) {
  console.log('✅ 无漂移：全部 ' + known.length + ' 条记账与文件一致');
} else {
  console.log('漂移文件 ' + drifted.length + ' 个：');
  drifted.forEach(d => console.log(`  ${d.f}  记账=${d.old}…  当前=${d.now}…`));
  if (fix) {
    for (const d of drifted) {
      const sum = createHash('sha256').update(fs.readFileSync(path.join(dir, d.f), 'utf8')).digest('hex');
      await c.query(`UPDATE schema_migrations SET checksum=$2 WHERE name=$1`, [d.f, sum]);
    }
    console.log('✅ 已将 ' + drifted.length + ' 条记账更新为当前文件校验和（新基线）');
  } else {
    console.log('（仅列出；加 --fix 才更新）');
  }
}
await c.end();
