import 'dotenv/config';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

/**
 * V5.0.0 批次7（M7-2 / §7.1.4）· 迁移对数报告
 *
 * 只读：采集销售/库存/会员/商品/同步五类基线数字，输出 Markdown 报告。
 * 用途：① 升级前基线（步骤 0）；② 升级后对数（步骤 9）——两次跑一遍，数字 diff 即《迁移对数报告》。
 *
 * 用法：
 *   node dist/scripts/recon-report.js                 # 打印到控制台
 *   node dist/scripts/recon-report.js --out 报告.md    # 同时写文件
 *   node dist/scripts/recon-report.js --label 升级前   # 报告标题标签
 */

const r2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;

async function main() {
  const args = process.argv.slice(2);
  const argOf = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const label = argOf('--label') || new Date().toISOString().slice(0, 16).replace('T', ' ');
  const outFile = argOf('--out');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/cashier' });
  const q = (s: string, p: any[] = []) => pool.query(s, p).then(r => r.rows);
  const L: string[] = [];

  try {
    L.push(`# 迁移对数报告（${label}）`);
    L.push('');
    L.push(`- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    L.push('- 口径：已完成订单；库存金额 = 即时库存 × 售价（含门店覆盖价）');
    L.push('');

    // ① 销售（近 30 天逐日）
    const sales = await q(
      `SELECT created_at::date AS d, COUNT(*)::int AS orders, SUM(payable_amount) AS amount, SUM(profit_amount) AS profit
         FROM sales_orders WHERE status='已完成' AND created_at::date >= CURRENT_DATE - 30
        GROUP BY 1 ORDER BY 1`);
    const sTotal = sales.reduce((a, x) => ({ o: a.o + Number(x.orders), amt: a.amt + Number(x.amount), pf: a.pf + Number(x.profit) }), { o: 0, amt: 0, pf: 0 });
    L.push('## ① 销售（近 30 天）');
    L.push('');
    L.push(`- 合计：单量 **${sTotal.o}**，金额 **¥${r2(sTotal.amt)}**，毛利 **¥${r2(sTotal.pf)}**`);
    L.push('');
    L.push('| 日期 | 单量 | 金额 | 毛利 |');
    L.push('|---|---:|---:|---:|');
    for (const x of sales) L.push(`| ${x.d.toISOString().slice(0, 10)} | ${x.orders} | ¥${r2(x.amount)} | ¥${r2(x.profit)} |`);
    L.push('');

    // ② 库存（按门店）
    const stores = await q(`SELECT id, name, org_type FROM stores WHERE COALESCE(status,1) <> 2 ORDER BY id`).catch(() => [] as any[]);
    L.push('## ② 库存（即时）');
    L.push('');
    L.push('| 门店 | SKU | 合计数量 | 库存金额 |');
    L.push('|---|---:|---:|---:|');
    for (const s of stores) {
      const r = (await q(
        `SELECT COUNT(DISTINCT ic.product_id)::int AS skus, SUM(ic.qty_total) AS qty,
                SUM(ic.qty_total * COALESCE(ps.sell_price, p.sell_price)) AS value
           FROM inventory_current ic
           JOIN products p ON p.id = ic.product_id AND p.deleted_at IS NULL
           LEFT JOIN product_store_prices ps ON ps.product_id = ic.product_id AND ps.store_id = ic.store_id
          WHERE ic.store_id = $1`, [s.id]))[0];
      L.push(`| ${s.name}(${s.org_type || 'store'}) | ${r.skus} | ${r2(r.qty)} | ¥${r2(r.value)} |`);
    }
    L.push('');

    // ③ 会员资产
    const m = (await q(
      `SELECT COUNT(*)::int AS members, SUM(ma.balance) AS bal, SUM(ma.principal_balance) AS pbal,
              SUM(ma.dividend_balance) AS div, SUM(ma.points) AS pts
         FROM members m LEFT JOIN member_accounts ma ON ma.member_id = m.id
        WHERE m.deleted_at IS NULL`))[0];
    L.push('## ③ 会员资产');
    L.push('');
    L.push(`- 会员数 **${m.members}**；余额 **¥${r2(m.bal)}**（本金 ¥${r2(m.pbal)}）；分红 **¥${r2(m.div)}**；积分 **${m.pts ?? 0}**`);
    L.push('');

    // ④ 商品
    const p = (await q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS alive,
              (SELECT COUNT(*)::int FROM store_products WHERE is_listed) AS listed_rows
         FROM products`))[0];
    L.push('## ④ 商品');
    L.push('');
    L.push(`- 档案总数 **${p.total}**（在用 ${p.alive}）；下发台账行数 **${p.listed_rows}**`);
    L.push('');

    // ⑤ 同步积压
    const ob = await q(`SELECT status, COUNT(*)::int AS n FROM sync_outbox GROUP BY 1 ORDER BY 1`).catch(() => [] as any[]);
    L.push('## ⑤ 同步积压');
    L.push('');
    L.push(ob.length ? ob.map(x => `- ${x.status}: **${x.n}**`).join('\n') : '- （sync_outbox 未建或为空）');
    L.push('');

    // ⑥ 组织与节点
    const nodes = await q(
      `SELECT s.name, s.org_type, n.node_code, n.status AS node_status, s.sync_enabled
         FROM stores s LEFT JOIN sync_nodes n ON n.store_id = s.id
        WHERE COALESCE(s.status,1) <> 2 ORDER BY s.id`).catch(() => [] as any[]);
    L.push('## ⑥ 组织与节点');
    L.push('');
    L.push('| 门店 | 类型 | 节点码 | 节点状态 | 同步 |');
    L.push('|---|---|---|---|---|');
    for (const n of nodes) L.push(`| ${n.name} | ${n.org_type || 'store'} | ${n.node_code || '—'} | ${n.node_status || '未注册'} | ${n.sync_enabled ? '开' : '关'} |`);
    L.push('');

    const text = L.join('\n');
    console.log(text);
    if (outFile) {
      const fp = path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile);
      fs.writeFileSync(fp, text, 'utf8');
      console.error(`\n[recon-report] 已写出: ${fp}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('对数报告失败:', e.message); process.exit(1); });
