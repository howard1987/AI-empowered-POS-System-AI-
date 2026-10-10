import 'dotenv/config';
import { Pool } from 'pg';
import * as crypto from 'crypto';

/**
 * V5.0.0 连锁改造（方案 §7.4 步骤 2~3 / M1-4）· 总部行初始化
 *
 * 作用（幂等，可重复执行）：
 *   ① 建立总部组织行 `org_type='hq'`（store_no='HQ'）—— 它是「连锁模式」的开关：
 *      存在总部行 → 数据范围/设置作用域等连锁约束生效；不存在 → 单店模式（逻辑整体休眠）
 *   ② 现有门店补 `store_no`（S001、S002…）、`parent_id=总部`、`node_code`（同步节点码）
 *   ③ 「超级管理员」角色置 `scope_type='hq', data_scope='all'`（保证老板/管理员仍全权）
 *
 * ⚠️ 本脚本**不搬动任何业务数据**（商品仍归属原门店、库存/会员/单据一概不动）。
 *    商品的「升格为总部主档 + 下发各店」属 §7.4 步骤 4，必须与「商品总部化」（批次3）同批上线，
 *    否则收银价目表会因 store_id 变化而查不到商品。
 *
 * 用法：
 *   node dist/scripts/chain-init.js                     # 用默认总部名「<原店名>连锁总部」
 *   node dist/scripts/chain-init.js --name "某某连锁总部"
 *   node dist/scripts/chain-init.js --dry-run           # 只打印将执行的动作
 */

interface Opts { name?: string; dryRun?: boolean }

export interface ChainInitResult {
  hqId: number;
  hqName: string;
  stores: Array<{ id: number; name: string; storeNo: string; nodeCode: string | null }>;
  created: boolean;
  notes: string[];
}

function genNodeCode(storeNo: string): string {
  return `${storeNo}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

/** 建立总部行并补齐门店编码（幂等；可被「门店管理」接口复用） */
export async function initChain(pool: Pool, opts: Opts = {}): Promise<ChainInitResult> {
  const notes: string[] = [];
  let created = false;

  const hqRow = (await pool.query(
    `SELECT id, name, store_no FROM stores WHERE org_type='hq' ORDER BY id LIMIT 1`)).rows[0] as any;

  let hqId: number;
  let hqName: string;
  if (hqRow) {
    hqId = Number(hqRow.id);
    hqName = String(hqRow.name);
    notes.push(`总部行已存在（id=${hqId}，${hqName}），跳过创建`);
  } else {
    const base = (await pool.query(
      `SELECT name FROM stores WHERE org_type <> 'hq' ORDER BY id LIMIT 1`)).rows[0] as any;
    hqName = (opts.name && opts.name.trim()) || `${base?.name || '本店'}连锁总部`;
    if (opts.dryRun) {
      notes.push(`[dry-run] 将新建总部行：${hqName}（store_no=HQ）`);
      hqId = -1;
    } else {
      const ins = await pool.query(
        `INSERT INTO stores (name, org_type, store_no, status, remark)
         VALUES ($1, 'hq', 'HQ', 1, 'V5.0.0 连锁总部（由 chain-init 建立）') RETURNING id`, [hqName]);
      hqId = Number(ins.rows[0].id);
      created = true;
      notes.push(`已新建总部行：id=${hqId}，${hqName}（store_no=HQ）`);
    }
  }

  // 现有门店补齐编码 / 上级 / 节点码（按 id 顺序编号，已填过的跳过）
  const stores = (await pool.query(
    `SELECT id, name, store_no, node_code FROM stores
      WHERE org_type <> 'hq' ORDER BY id`)).rows as any[];
  let seq = 0;
  const out: ChainInitResult['stores'] = [];
  for (const s of stores) {
    seq += 1;
    const wantNo = String(s.store_no || `S${String(seq).padStart(3, '0')}`);
    const wantNode = s.node_code || genNodeCode(wantNo);
    if (!s.store_no || !s.node_code || hqId > 0) {
      if (opts.dryRun) {
        notes.push(`[dry-run] 将更新门店 ${s.id} ${s.name} → store_no=${wantNo}, parent_id=${hqId}, node_code=${wantNode}`);
      } else if (hqId > 0) {
        await pool.query(
          `UPDATE stores SET store_no=COALESCE(store_no,$2), parent_id=COALESCE(parent_id,$3),
                             node_code=COALESCE(node_code,$4), updated_at=now()
            WHERE id=$1`, [Number(s.id), wantNo, hqId, wantNode]);
        notes.push(`门店 ${s.id} ${s.name} → ${wantNo}（node=${wantNode}）`);
      }
    }
    out.push({ id: Number(s.id), name: String(s.name), storeNo: wantNo, nodeCode: s.node_code || wantNode });
  }

  // 超级管理员 = 总部角色 + 全部门店范围（保证管理员账号仍全权）
  if (!opts.dryRun) {
    const r = await pool.query(
      `UPDATE roles SET scope_type='hq', data_scope='all', region=NULL
        WHERE name='超级管理员' AND (scope_type<>'hq' OR data_scope<>'all')`);
    if (r.rowCount) notes.push(`已升格「超级管理员」角色 ${r.rowCount} 个为 hq + all`);
  }

  return { hqId, hqName, stores: out, created, notes };
}

async function main() {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf('--name');
  const opts: Opts = {
    name: nameIdx >= 0 ? args[nameIdx + 1] : undefined,
    dryRun: args.includes('--dry-run'),
  };
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('[chain-init] 致命：缺少 DATABASE_URL 环境变量，拒绝以弱口令默认值连接。请在 .env 配置 DATABASE_URL');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: DATABASE_URL,
    options: '-c TimeZone=Asia/Shanghai',
  });
  try {
    const r = await initChain(pool, opts);
    console.log('══════ 连锁总部初始化 ══════');
    console.log(`总部：id=${r.hqId}  ${r.hqName}`);
    console.log(`门店：${r.stores.length} 家`);
    for (const n of r.notes) console.log('  · ' + n);
    console.log('');
    console.log(r.created
      ? '✅ 连锁模式已启用（库中已有总部行 → 数据范围/设置作用域开始生效）'
      : 'ℹ️ 总部行已存在，本次为幂等重放（无破坏性动作）');
    console.log('⚠️ 商品仍归属原门店（未搬动）。商品总部化（升格主档 + 下发）需与批次3同批上线。');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(e => { console.error('❌ 初始化失败：', e?.message || e); process.exit(1); });
}
