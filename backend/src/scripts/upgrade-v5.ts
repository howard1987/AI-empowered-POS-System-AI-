import 'dotenv/config';
import { Pool } from 'pg';
import { initChain } from './chain-init';

/**
 * V5.0.0 批次7（M7-1 / §7.1.2 十步）· 旧单机 → 连锁 升级总控
 *
 * ⚠️ 停业窗口执行；执行前必备份（脚本只做业务迁移，目录备份见 deploy/README-SERVER.md 连锁章节）。
 * 幂等：可重复执行，已完成的步骤自动跳过。
 *
 * 用法：
 *   node dist/scripts/init-db.js          # 先跑迁移（步骤 1）
 *   node dist/scripts/upgrade-v5.js --dry-run   # 预演：只打印将执行的动作
 *   node dist/scripts/upgrade-v5.js             # 正式执行（步骤 2~7 业务部分）
 *   node dist/scripts/recon-report.js --label 升级后 --out 对数报告.md   # 步骤 9
 */

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/cashier',
  });
  const q = (s: string, p: any[] = []) => pool.query(s, p).then(r => r.rows);
  const L: string[] = [];
  const log = (s: string) => { L.push(s); console.log(s); };

  try {
    log('═══ V5.0.0 单店→连锁 升级总控（§7.1.2 十步）═══');
    if (dryRun) log('（dry-run 预演模式：不写任何数据）');

    // ── 步骤 0/1 提醒（人工动作，不在本脚本内）──
    log('\n【步骤 0】备份与基线（人工确认）');
    log('  ① 已停后端并备份 PG 数据目录（robocopy /MIR C:\\ProgramData\\pos-cashier → 备份盘）');
    log('  ② 基线对数：node dist/scripts/recon-report.js --label 升级前 --out 对数-升级前.md');
    log('【步骤 1】迁移：node dist/scripts/init-db.js  （幂等，只加列/建表）');

    // ── 步骤 2/3/7：总部行 + 门店升格 + 角色（chain-init 幂等实现）──
    log('\n【步骤 2/3/7】总部行 + 门店编码 + 超管范围');
    const chain = await initChain(pool, { dryRun });
    for (const n of chain.notes) log('  · ' + n);
    for (const s of chain.stores) log(`  · 门店 #${s.id} ${s.name} → ${s.storeNo} / 节点 ${s.nodeCode || '—'}`);
    const hqId = chain.hqId;

    if (hqId > 0) {
      // ── 步骤 4：商品档案升格为总部主档（幂等）──
      log('\n【步骤 4】商品升格为总部主档');
      const moved = await q(
        `SELECT count(*)::int AS n FROM products WHERE store_id <> $1 AND store_id IN (SELECT id FROM stores WHERE org_type <> 'hq')`, [hqId]);
      if (moved[0].n === 0) {
        log('  · 已全部是总部主档，跳过');
      } else if (dryRun) {
        log(`  · [dry-run] 将把 ${moved[0].n} 个门店建档商品升格为总部主档（原店保留下发台账行）`);
      } else {
        await pool.query('BEGIN');
        try {
          // 每个原建档店保留下发台账（可售状态 = 上架状态），再把档案移到总部
          await pool.query(
            `INSERT INTO store_products (store_id, product_id, is_listed, source, version, published_at)
             SELECT p.store_id, p.id, (p.status = 1), 'hq', 1, now()
               FROM products p
              WHERE p.store_id IN (SELECT id FROM stores WHERE org_type <> 'hq')
               AND NOT EXISTS (SELECT 1 FROM store_products sp WHERE sp.store_id = p.store_id AND sp.product_id = p.id)`);
          await pool.query(
            `UPDATE products SET store_id = $1
              WHERE store_id IN (SELECT id FROM stores WHERE org_type <> 'hq')`, [hqId]);
          await pool.query('COMMIT');
          log(`  · 已升格 ${moved[0].n} 个商品（原店台账已保留，收银价目不受影响）`);
        } catch (e: any) {
          await pool.query('ROLLBACK');
          throw new Error(`步骤 4 失败已回滚: ${e.message}`);
        }
      }

      // ── 步骤 5：会员升格（补来源店/来源节点，幂等）──
      log('\n【步骤 5】会员升格（补 source_store_id / source_node）');
      const mem = await q(
        `SELECT count(*)::int AS n FROM members WHERE source_store_id IS NULL AND deleted_at IS NULL`);
      if (mem[0].n === 0) {
        log('  · 无缺失，跳过');
      } else if (dryRun) {
        log(`  · [dry-run] 将为 ${mem[0].n} 个会员补 source_store_id（=本店）/ source_node`);
      } else {
        await pool.query(
          `UPDATE members m SET source_store_id = s.id,
                                source_node = COALESCE(s.node_code, 'S' || lpad(s.id::text, 3, '0'))
             FROM stores s
            WHERE m.source_store_id IS NULL AND m.deleted_at IS NULL
              AND m.store_id = s.id AND s.org_type <> 'hq'`);
        // 店列缺失兜底：挂到最小门店
        await pool.query(
          `UPDATE members m SET source_store_id = s.id,
                                source_node = COALESCE(s.node_code, 'S' || lpad(s.id::text, 3, '0'))
             FROM stores s
            WHERE m.source_store_id IS NULL AND m.deleted_at IS NULL AND s.org_type <> 'hq'
              AND s.id = (SELECT min(id) FROM stores WHERE org_type <> 'hq')`);
        log(`  · 已补 ${mem[0].n} 个会员`);
      }

      // ── 步骤 6：设置作用域（迁移 104/107 已归类；此处只校验打印）──
      log('\n【步骤 6】设置作用域（104/107 迁移已归类，此处校验）');
      const sc = await q(
        `SELECT scope, count(*)::int AS n FROM system_settings GROUP BY 1 ORDER BY 1`).catch((): any[] => []);
      for (const x of sc) log(`  · scope=${x.scope}: ${x.n} 键`);
      const hqKeys = await q(
        `SELECT setting_key, value FROM system_settings WHERE scope='hq' ORDER BY setting_key LIMIT 20`).catch((): any[] => []);
      log(`  · 总部级键 ${hqKeys.length} 个（分红/进价/同步参数在「设置」页复核，防被默认值重置）`);

      // ── 步骤 8：同步初始化（109 迁移已自注册本节点；打印状态）──
      log('\n【步骤 8】同步初始化');
      const nodes = await q(
        `SELECT node_code, store_id, node_role, is_self, status FROM sync_nodes ORDER BY id`).catch((): any[] => []);
      for (const n of nodes) log(`  · 节点 ${n.node_code}（店#${n.store_id}，${n.node_role}${n.is_self ? '/本机' : ''}，${n.status}）`);
      log('  · 新门店节点：总部「门店管理」建店生成密钥 → 门店端「数据同步」页填三要素即可上线');

      // ── 步骤 9/10 提醒 ──
      log('\n【步骤 9】对数（不通过不上线）');
      log('  node dist/scripts/recon-report.js --label 升级后 --out 对数-升级后.md');
      log('  → 与「对数-升级前.md」逐项 diff：销售/库存/会员/商品 四类差异必须为 0');
      log('\n【步骤 10】灰度：D1 总部只读观察 → D2 开报表与下发 → 一周稳定后正式切换');
    } else {
      log('\n（dry-run：步骤 4~10 将在正式执行时处理）');
    }

    log('\n═══ 完成（幂等，可重复执行；异常回滚见 deploy/README-SERVER.md 连锁章节）═══');
    void L;
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('升级失败:', e.message); process.exit(1); });
