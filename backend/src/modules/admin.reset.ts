/**
 * 系统初始化（V4.12）：开业前/调试后一键清库，让软件回到初始化状态。
 *  - GET  /admin/reset/preview   分组实时计数（不改动任何数据）
 *  - POST /admin/reset/execute   单事务 TRUNCATE ... RESTART IDENTITY CASCADE
 *
 * 安全设计（高危操作四重防护）：
 *  1) 表清单全部为服务端白名单硬编码，绝不接受客户端传入表名；
 *  2) 永不清骨架表：stores / employees / roles / permission_points / role_permissions /
 *     employee_roles / system_settings / ai_models（登录、权限、功能配置、模型资产）；
 *  3) 执行需 confirm='初始化' 且模式二选一：full=全部业务+档案清空（出厂）；
 *     keep-master=保留商品/供应商/客户等基础档案（开业档案已建好的情况）；
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

/** 业务数据（两种模式都清）：交易 / 库存单据 / 会员分红营销 / 供应商往来 / AI 数据 / 日志 */
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

/** 基础档案（full 模式清空；keep-master 模式保留——开业前已建好真实档案时勾它） */
const MASTER_DATA = [
  'categories', 'products', 'product_barcodes', 'product_units',
  'product_bundles', 'product_bundle_items', 'product_aliases',
  'suppliers', 'supplier_product_prices', 'supplier_fee_agreements', 'supplier_fee_types',
  'member_levels', 'big_customers', 'big_customer_prices', 'promotion_templates',
];

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
  /** 预览：各分组实时行数（只读） */
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
    const mn = await countRows(MASTER_DATA);
    const masterItems = MASTER_DATA.map(t => ({ name: t, n: mn[t] ?? 0 }));
    const masterTotal = masterItems.reduce((s, x) => s + x.n, 0);
    groups.push({ key: 'master', label: '基础档案（全量初始化清空 / 保留档案模式保留）', tables: masterItems });
    const dn = await countRows(DEVICE_CONFIG);
    const deviceItems = DEVICE_CONFIG.map(t => ({ name: t, n: dn[t] ?? 0 }));
    groups.push({ key: 'device', label: '设备与模板配置（默认保留，可选清空）', tables: deviceItems });
    const kept = await countRows([...KEEP_ALWAYS]);
    return {
      groups, total,
      masterTotal, deviceTotal: deviceItems.reduce((s, x) => s + x.n, 0),
      keepAlways: Object.entries(kept).map(([name, n]) => ({ name, n })),
    };
  }

  /** 执行初始化。body: { mode:'full'|'keep-master', clearDevices?: boolean, clearKeep?: string[], confirm:'初始化' }
   *  V4.25.2：clearKeep 允许把「默认保留」的骨架表白名单子集也一并清空（如二次开业清员工/角色）；
   *  安全面不变：客户端只能从 KEEP_ALWAYS 白名单里挑，传入其他表名一律忽略，清单外仍然无法触达。 */
  @Post('execute')
  @RequirePerms('sys.data.backup')
  async execute(@Body() b: { mode?: string; clearDevices?: boolean; clearKeep?: string[]; confirm?: string },
                @CurrentUser() user: AuthUser) {
    if (b.confirm !== '初始化') throw new BizException(40003, '确认文字不符：请输入「初始化」后再执行');
    if (b.mode !== 'full' && b.mode !== 'keep-master') {
      throw new BizException(40003, '模式非法：full=出厂全清 / keep-master=保留基础档案');
    }
    // 服务端白名单拼表清单（客户端只能选模式，永远传不了表名）
    const tables: string[] = Object.values(CLEAR_ALWAYS).flat();
    const masterKept = b.mode === 'keep-master';
    if (!masterKept) tables.push(...MASTER_DATA);
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
      mode: b.mode, clearDevices: !!b.clearDevices, clearKeep, tables: final.length,
      rowsCleared: grandTotal, by: `${user.empNo}(${user.name})`,
    });
    return {
      ok: true, mode: b.mode, masterKept, clearKeep, tables: final.length,
      rowsCleared: grandTotal, detail: before,
      notice: clearKeep.includes('employees') || clearKeep.includes('roles')
        ? '已按勾选清空勾选的账号/角色等骨架数据，系统回到出厂状态'
        : (masterKept
          ? '已保留商品/供应商/客户等基础档案；交易、库存、会员、AI 数据与日志已全部清空'
          : '系统已回到初始化状态：仅保留登录账号、角色权限与系统配置'),
    };
  }
}

@Module({ controllers: [AdminResetController] })
export class AdminResetModule {}
