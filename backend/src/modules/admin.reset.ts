/**
 * 系统初始化（V4.12 原版 / V4.27.9 勾选式保留重构）：开业前/调试后一键清库，从头开始。
 * 定位：开业前的"从零开始"——清空所有经营数据记录；建档类数据（商品/供应商/会员大客户/AI训练数据）
 *       可按勾选保留（如测试期导入的商品档案、已采集的 AI 样本），也可一并清空。
 *  - GET  /admin/reset/preview   分组实时计数 + 可保留档案组（不改动任何数据）
 *  - POST /admin/reset/execute   单事务 TRUNCATE ... RESTART IDENTITY CASCADE
 *
 * 安全设计（高危操作四重防护）：
 *  1) 表清单全部为服务端白名单硬编码，绝不接受客户端传入表名；
 *  2) 永不清骨架表：stores / employees / roles / permission_points / role_permissions /
 *     employee_roles / system_settings / ai_models（登录、权限、功能配置、模型资产）；
 *  3) 执行需 confirm='初始化'；保留范围 = keep 勾选（白名单交集）；
 *     兼容旧模式：mode='keep-master' 等价 keep 全勾，mode='full' 等价 keep 空；
 *  4) 仅 ADMIN 或 sys.data.backup 权限；执行后写 audit_logs（初始化日志本身在清空后补写）。
 */
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q, tx, audit } from '../common/db';

/** 永不清（系统骨架）——任何模式/参数都无法触达 */
const KEEP_ALWAYS = [
  'stores', 'employees', 'roles', 'permission_points', 'role_permissions',
  'employee_roles', 'system_settings', 'ai_models',
] as const;

/** 业务数据（默认清空）：交易 / 库存单据 / 会员分红营销 / 供应商往来 / AI 数据 / 日志 */
const CLEAR_ALWAYS: Record<string, string[]> = {
  '交易与结算': [
    'sales_orders', 'sale_items', 'sale_payments', 'sale_refunds', 'sale_refund_items',
    'sale_item_batches', 'return_batch_allocs', 'settlements', 'shifts', 'held_orders',
    'recharge_orders', 'print_jobs',
  ],
  '库存与单据': [
    'batches', 'stock_flows', 'inventory_current',
    'inbound_orders', 'inbound_order_items', 'purchase_orders', 'purchase_order_items',
    'purchase_returns', 'purchase_return_items', 'loss_records', 'loss_items',
    'reconciliations', 'reconciliation_items', 'inventory_counts', 'inventory_count_items',
    'stocktake_tasks', 'stocktake_task_items', 'stock_transfers', 'stock_transfer_items',
    'bundle_ops', 'bundle_op_items', 'expiry_disposals', 'picking_shortages',
    'consign_recons', 'consign_recon_items', 'price_changes', 'price_change_items',
    'pricebook_snapshots',
  ],
  '会员与分红': [
    'members', 'member_accounts', 'member_profiles', 'member_activity_windows',
    'member_addresses', 'member_coupons', 'member_level_log',
    'points_flows', 'balance_flows', 'dividend_periods', 'dividend_records',
    'big_customer_payments', 'coupons', 'promotions', 'marketing_rules', 'marketing_touches',
  ],
  '供应商往来': ['supplier_ledger', 'supplier_fees'],
  'AI 数据': [
    'ai_recognition_logs', 'ai_samples', 'ai_name_embs', 'ai_tasks', 'ai_suggestions',
    'forecast_snapshots', 'ai_kb_documents', 'ai_kb_chunks',
  ],
  '操作日志': ['audit_logs', 'setting_change_logs'],
};

/** V4.27.9 可勾选保留的档案组：初始化时勾哪个组，该组建档数据就保留（其余照清） */
const KEEP_GROUPS: Record<string, { label: string; desc: string; tables: string[] }> = {
  products: {
    label: '商品档案', desc: '商品、分类、条码、单位、组合装、别名（测试期导入/已建好的商品）',
    tables: ['categories', 'products', 'product_barcodes', 'product_units',
             'product_bundles', 'product_bundle_items', 'product_aliases'],
  },
  suppliers: {
    label: '供应商资料', desc: '供应商、供货价、费用协议（已谈好的供货关系）',
    tables: ['suppliers', 'supplier_product_prices', 'supplier_fee_agreements', 'supplier_fee_types'],
  },
  customers: {
    label: '会员与大客户', desc: '会员等级定义、大客户及其价格、促销模板',
    tables: ['member_levels', 'big_customers', 'big_customer_prices', 'promotion_templates'],
  },
  training: {
    label: 'AI 训练数据', desc: '采集的商品样本图（含向量索引）与训练任务记录——重新采集很费人力，建议保留',
    tables: ['ai_tasks', 'ai_samples', 'ai_name_embs'],
  },
};

/** 全部可保留档案表（= 各组并集；不勾的照常清空） */
const MASTER_DATA = Object.values(KEEP_GROUPS).flatMap(g => g.tables);

/** 设备与模板配置（默认保留，可选一并清空） */
const DEVICE_CONFIG = ['devices', 'printers', 'print_templates', 'signature_templates'];

/** 仅统计真实存在的表（防白名单与库结构漂移时 preview 报错） */
async function countRows(tables: string[]): Promise<Record<string, number>> {
  if (!tables.length) return {};
  const exist = await q(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)`, [tables]);
  const names = exist.map((r: any) => String(r.tablename));
  if (!names.length) return {};
  const sql = names.map(t => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}"`).join(' UNION ALL ');
  const rows = await q(sql);
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.t)] = Number(r.n);
  return out;
}

@Controller('admin/reset')
export class AdminResetController {
  /** 预览：各分组实时行数（只读）；V4.27.9 附带可勾选保留的档案组 */
  @Get('preview')
  @RequirePerms('sys.data.backup')
  async preview() {
    const groups: { key: string; label: string; tables: { name: string; n: number }[] }[] = [];
    let total = 0;
    for (const [label, tables] of Object.entries(CLEAR_ALWAYS)) {
      const n = await countRows(tables);
      const items = tables.map(t => ({ name: t, n: n[t] ?? 0 }));
      total += items.reduce((s, x) => s + x.n, 0);
      groups.push({ key: 'business', label, tables: items });
    }
    const dn = await countRows(DEVICE_CONFIG);
    const deviceItems = DEVICE_CONFIG.map(t => ({ name: t, n: dn[t] ?? 0 }));
    groups.push({ key: 'device', label: '设备与模板配置（默认保留，可选清空）', tables: deviceItems });
    const keepGroups = [];
    for (const [key, g] of Object.entries(KEEP_GROUPS)) {
      const n = await countRows(g.tables);
      const tables = g.tables.map(t => ({ name: t, n: n[t] ?? 0 }));
      keepGroups.push({ key, label: g.label, desc: g.desc, tables,
                        total: tables.reduce((s, x) => s + x.n, 0) });
    }
    const kept = await countRows([...KEEP_ALWAYS]);
    return {
      groups, total,
      deviceTotal: deviceItems.reduce((s, x) => s + x.n, 0),
      keepGroups,
      keepAlways: Object.entries(kept).map(([name, n]) => ({ name, n })),
    };
  }

  /** 执行初始化。body: { keep?: ('products'|'suppliers'|'customers'|'training')[], clearGroups?: string[],
   *                     mode?: 'full'|'keep-master', clearDevices?: boolean, clearKeep?: string[], confirm:'初始化' }
   *  V4.27.9：keep 勾选式保留（白名单交集校验，只能从 KEEP_GROUPS 的组名里挑）；
   *           clearGroups 勾选要清空的业务模块（白名单 = CLEAR_ALWAYS 组名；未传 = 全清）。
   *  兼容旧模式：mode='keep-master' → keep 全勾；mode='full' → keep 空。
   *  V4.25.2：clearKeep 允许把「默认保留」的骨架表白名单子集也一并清空（如二次开业清员工/角色）；
   *  安全面不变：客户端永远传不了表名，清单外无法触达。 */
  @Post('execute')
  @RequirePerms('sys.data.backup')
  async execute(@Body() b: { keep?: string[]; clearGroups?: string[]; mode?: string; clearDevices?: boolean; clearKeep?: string[]; confirm?: string },
                @CurrentUser() user: AuthUser) {
    if (b.confirm !== '初始化') throw new BizException(40003, '确认文字不符：请输入「初始化」后再执行');
    // 保留组解析：keep 勾选（新）或 mode（旧，兼容）
    const validKeeps = Object.keys(KEEP_GROUPS);
    let keep: string[];
    if (Array.isArray(b.keep)) {
      keep = [...new Set(b.keep.map(String))].filter(k => validKeeps.includes(k));
    } else if (b.mode === 'keep-master') {
      keep = [...validKeeps];
    } else if (b.mode === 'full') {
      keep = [];
    } else {
      keep = [];   // 默认：全部清空（从零开始），保留靠显式勾选
    }
    // 训练样本挂在商品档案下（product_id 外键）：保留训练数据必须连带保留商品档案，
    // 否则 TRUNCATE products CASCADE 会把样本一并清掉（级联方向：products ← ai_samples/ai_name_embs）
    if (keep.includes('training') && !keep.includes('products')) keep.push('products');

    // 服务端白名单拼表清单（客户端只能选保留组/模块，永远传不了表名）
    // clearGroups：勾选要清空的业务模块（未传/为空数组视为全选，保持旧行为）
    const groupKeys = Object.keys(CLEAR_ALWAYS);
    let clearGroupKeys = groupKeys;
    if (Array.isArray(b.clearGroups)) {
      const picked = new Set(b.clearGroups.map(String).filter(k => groupKeys.includes(k)));
      clearGroupKeys = groupKeys.filter(k => picked.has(k));
    }
    const keptTables = new Set(keep.flatMap(k => KEEP_GROUPS[k].tables));
    const tables: string[] = clearGroupKeys.flatMap(k => CLEAR_ALWAYS[k]);
    for (const t of MASTER_DATA) if (!keptTables.has(t)) tables.push(t);
    if (b.clearDevices) tables.push(...DEVICE_CONFIG);
    // V4.25.2：骨架表默认保留；仅当客户端显式勾选「删除」时才加入清空清单（白名单交集校验）
    const keepList = KEEP_ALWAYS as readonly string[];
    const clearKeep = Array.isArray(b.clearKeep) ? [...new Set(b.clearKeep)].filter(t => keepList.includes(t)) : [];
    tables.push(...clearKeep);
    // 过滤掉库里不存在的表 + 双重保险：未显式勾选删除的骨架表一律剔除
    const exist = new Set((await q(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`)).map((r: any) => String(r.tablename)));
    const final = tables.filter(t => exist.has(t) && (clearKeep.includes(t) || !keepList.includes(t)));
    if (!final.length) throw new BizException(40003, '清空清单为空，已取消执行');

    // 预清点（审计留档用）
    const before = await countRows(final);
    const grandTotal = Object.values(before).reduce((s, n) => s + n, 0);

    await tx(async c => {
      await c.query(`TRUNCATE TABLE ${final.map(t => `"${t}"`).join(', ')} CASCADE`);
    });
    // audit_logs 已被清空 → 事后补写本次初始化记录（永久留存的第一条日志）
    await audit(user.storeId, user.sub, '系统', '系统初始化', 'system', null, {
      mode: b.mode ?? 'keep', keep, clearDevices: !!b.clearDevices, clearKeep, tables: final.length,
      rowsCleared: grandTotal, by: `${user.empNo}(${user.name})`,
    });
    const keptLabels = keep.map(k => KEEP_GROUPS[k].label);
    return {
      ok: true, keep, keptGroups: keptLabels, clearKeep, tables: final.length,
      rowsCleared: grandTotal, detail: before,
      notice: clearKeep.includes('employees') || clearKeep.includes('roles')
        ? '已按勾选清空勾选的账号/角色等骨架数据，系统回到出厂状态'
        : (keptLabels.length
          ? `已从零清空经营数据；按勾选保留了：${keptLabels.join('、')}`
          : '系统已回到从零状态：仅保留登录账号、角色权限、系统设置与AI模型'),
    };
  }
}

@Module({ controllers: [AdminResetController] })
export class AdminResetModule {}
