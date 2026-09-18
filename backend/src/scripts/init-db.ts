import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

/**
 * 数据库初始化（执行文件 T1）：
 *   1) 执行 db/001_init.sql 全量基线（74 表 + 26 枚举 + 种子数据）
 *   2) 管理员账号 V4.24.0 起不再写死：仅检测是否已有超管账号，无则提示登录页引导创建
 * 幂等：SQL 全部 IF NOT EXISTS / ON CONFLICT；管理员检测只读
 */
/**
 * 语句切分：按分号拆分单条 SQL，正确跳过
 * 单引号字符串、dollar-quote 函数体（$$..$$ / $tag$..$tag$）、行/块注释
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let inQuote = false;
  let dollarTag: string | null = null;
  while (i < n) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { cur += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      cur += ch; i++; continue;
    }
    if (inQuote) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
        inQuote = false;
      }
      i++; continue;
    }
    if (ch === "'") { inQuote = true; cur += ch; i++; continue; }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { dollarTag = m[0]; cur += m[0]; i += m[0].length; continue; }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? n : j + 1;
      cur += sql.slice(i, end); i = end; continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      cur += sql.slice(i, end); i = end; continue;
    }
    if (ch === ';') {
      const s = cur.trim();
      if (s) out.push(s + ';');
      cur = ''; i++; continue;
    }
    cur += ch; i++;
  }
  const s = cur.trim();
  if (s) out.push(s);
  return out;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://cashier:cashier123@localhost:5432/cashier',
  });

  const dir = path.join(__dirname, '..', '..', 'db');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  // P3 迁移治理：schema_migrations 记账（sha256 校验和 + 应用时间）。
  // 行为不变（幂等全量重跑保留），但「已应用迁移被事后修改」会显式告警——001 禁改纪律的工具化落地。
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(128) PRIMARY KEY, checksum VARCHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_run_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const crypto = await import('crypto');
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const prev = await pool.query(`SELECT checksum FROM schema_migrations WHERE name=$1`, [f]);
    if (prev.rowCount && prev.rows[0].checksum !== checksum) {
      console.warn(`⚠ 漂移告警：已应用迁移 ${f} 的内容与记账校验和不一致（历史迁移应新增文件而非修改，请确认是否有意为之）`);
    }
    const stmts = splitStatements(sql);
    let skipped = 0;
    try {
      // 逐条执行：每条独立隐式事务。
      // 关键原因：ALTER TYPE ... ADD VALUE 的新枚举值禁止在同一事务内使用，
      // 整文件单事务执行会让「ADD VALUE + INSERT 新枚举值」在同事务内必然报
      // unsafe use of new value（全新库首次初始化必踩，见 058）。
      for (let idx = 0; idx < stmts.length; idx++) {
        try {
          await pool.query(stmts[idx]);
        } catch (e: any) {
          const m = String(e?.message || '');
          if (/already exists|duplicate key/i.test(m)) { skipped++; continue; }
          const snippet = stmts[idx].replace(/\s+/g, ' ').slice(0, 160);
          throw new Error(`第 ${idx + 1}/${stmts.length} 条失败: ${m} | SQL: ${snippet}`);
        }
      }
      await pool.query(
        `INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)
         ON CONFLICT (name) DO UPDATE SET checksum=$2, last_run_at=now()`, [f, checksum]);
      console.log(`✓ SQL: ${f}（${stmts.length} 条${skipped ? `，跳过已存在 ${skipped} 条` : ''}）`);
    } catch (e: any) {
      console.error(`✗ SQL: ${f} 失败：${e.message}`);
      throw e;
    }
  }
  console.log('基线与迁移执行完成（表/枚举/索引/种子数据）');

  // 引导管理员（V4.24.0：不再写死 ADMIN/admin123）
  //  改为：检测是否已有「绑定超级管理员角色」的在职账号；无 → 只打印提示，
  //  由收银端/后台登录页在首次启动时引导用户自定义创建（工号/姓名/密码均由用户输入）。
  const adm = await pool.query(
    `SELECT e.emp_no, e.name FROM employees e
       JOIN employee_roles er ON er.employee_id = e.id
       JOIN roles ro ON ro.id = er.role_id
      WHERE ro.name = '超级管理员' AND e.status = '在职'
      ORDER BY e.id LIMIT 1`);
  if (adm.rowCount === 0) {
    console.log('未检测到管理员账号：请打开收银端（或后台）登录页，按提示「创建管理员账号」完成初始化');
  } else {
    console.log(`管理员已存在（${adm.rows[0].emp_no} / ${adm.rows[0].name}），跳过`);
  }

  const t = await pool.query(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'`);
  console.log(`当前 public schema 表数量: ${t.rows[0].n}`);
  await pool.end();
}

main().catch(e => { console.error('初始化失败:', e.message); process.exit(1); });
