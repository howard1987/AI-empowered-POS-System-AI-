-- ============================================================================
-- V5.0.0 连锁改造 · 连锁设置键（**唯一所有者**）
--
-- 背景：105/106 两期各自种了一批 `chain.*` 键，出现三类问题：
--   ① 同义重复：chain.cost.pickup_raise_l1 ↔ chain.variance.pickup_raise_l1、
--      chain.cost.dev_threshold ↔ chain.cost.high_threshold、
--      chain.variance.default_disposition ↔ chain.variance.default_action；
--   ② 同键两处种、默认值与名称相反：chain.product.self_apply
--      （105 种「门店申请上架免批」默认 false / 106 种「门店申请上架需总部批」默认 true；
--        105 先执行生效，106 那行被 ON CONFLICT 丢弃 → 设置页名称与实际语义相反）；
--   ③ 死键：41 个 `chain.*` 键里代码真正读取的只有 5 个 → 设置页出现大量「拨了没反应」的开关，
--      违反老板硬约束「设置页要看得懂、易于设置」。
--
-- 本迁移收口原则（2026-09-18 定）：
--   · **键只在代码接线后才种**（正向铁律「新键必须当期补种子」的反向同伴：没接线就不种）；
--   · `chain.*` 键**只允许出现在本文件**，后续批次新增时追加到本文件，
--     禁止再在别的迁移里重复种同一个键；
--   · 待接线的键登记在文件末尾「预留键」注释区，接线后移入 INSERT。
--
-- ⚠️ 幂等 + 不吞老板配置：
--   DELETE 只清理「值仍等于默认值 **且** 从未有过变更日志」的行：
--     · 老板改过任何一键 → 该行永不被本迁移触碰；
--     · 重放本迁移（init-db 语句级重放）= 删掉刚种下的默认行再种回来 = 净空操作。
-- ============================================================================

-- ── ① 清理未接线/重复的链锁键（值非默认或改过的保留，绝不误删）──────────────
DELETE FROM system_settings s
 WHERE s.setting_key LIKE 'chain.%'
   AND s.value = s.default_value
   AND NOT EXISTS (SELECT 1 FROM setting_change_logs l WHERE l.setting_key = s.setting_key);

-- ── ② 已接线键种子（scope='hq'：总部级，门店只接收下发，改会被 403 + 审计）────
INSERT INTO system_settings
  (group_name, setting_key, display_name, value, default_value, value_type, unit, enum_options, remark, scope)
VALUES
  ('连锁管理','chain.enabled',                 '启用连锁模式',        'false'::jsonb,'false'::jsonb,'bool',  NULL,  NULL,
   '关闭（默认）= 单店，后台不显示连锁视图；建总部行后开启', 'hq'),
  ('连锁管理','chain.product.self_apply',      '门店申请上架免批',    'false'::jsonb,'false'::jsonb,'bool',  NULL,  NULL,
   '关闭（默认）= 门店申请上架需总部批准；开启 = 申请即生效。总控权始终在总部（R2）', 'hq'),
  ('连锁管理','chain.cost.auto_adopt_new',     '新品首进自动采纳进价','true'::jsonb, 'true'::jsonb, 'bool',  NULL,  NULL,
   '总部尚无该商品进价时，首笔入库实价自动成为标准进价 L1 → 新品立刻获得红线保护（R8）', 'hq'),
  ('连锁管理','chain.cost.adjust_window_h',    '高进价处置时限',      '24'::jsonb,   '24'::jsonb,   'number','小时',NULL,
   '进价差异单超时未裁决 → 自动结案（认可）并升级告警', 'hq'),
  ('连锁管理','chain.cost.merge_days',         '进价差异单合并窗口',  '7'::jsonb,    '7'::jsonb,    'number','天',  NULL,
   '同店同商品同向差异在该窗口内合并为一条，防刷屏', 'hq')
ON CONFLICT (setting_key) DO NOTHING;

-- ── ③ 兜底：链锁键一律总部级（修 106 漏标 scope → 曾被当门店级键，门店可改）──
UPDATE system_settings SET scope = 'hq'
 WHERE setting_key LIKE 'chain.%' AND scope <> 'hq';

-- ── ④ 预留键登记（**故意不种**；接线后移入上面 INSERT）──────────────────────
-- 键名以 `超市收银系统-连锁版改造方案.md` §5.1.6 / §5.8.3 的设置键表为准（此处不另起名）。
--  批次4 · 同步：chain.sync.enabled / interval_sec / batch_size / offline_hours / pull_interval_sec
--  批次4 · 进价：chain.cost.mode / quote_valid_days / auto_approve_delta / gate1 / high_policy
--                chain.cost.anomaly_high_pct / anomaly_low_pct / anomaly_fresh_high_pct / anomaly_fresh_low_pct
--                chain.cost.escalate_cnt
--  批次4 · 对账：chain.variance.settle_price_source / sla_days / alert_days / force_close_days
--                chain.variance.default_action / pickup_raise_l1 / pickup_carry_immediate
--  批次4 · 退货：chain.return.cross_enabled / cross_cash
--  批次6 · 调拨：chain.transfer.audit_hq / intransit_days
--  批次6 · 库存：chain.stock.hq_negative / hq_negative_max / hq_negative_days
--
-- ── ⑤ 已废弃键名（**禁止再使用**，历史种子里出现过）────────────────────────
--  chain.node_role                 —— 「是否连锁」由是否存在 org_type='hq' 行判定，
--                                     与 chain.enabled（后台视图开关）分工已明确，不再引入第三个概念
--  chain.cost.hq_only / chain.product.adopt_auto / chain.return.cross_window_days /
--  chain.return.restock_policy / chain.transfer.hq_audit / chain.transfer.emergency_post
--                                  —— 方案草案名，落地时改名为 audit_hq / cross_* 等，见上面预留区
--  chain.cost.dev_threshold        —— 同义于 chain.cost.anomaly_high_pct
--  chain.cost.fresh_threshold      —— 同义于 chain.cost.anomaly_fresh_high_pct（且缺「过低生鲜」一档）
--  chain.cost.pickup_raise_l1      —— 同义于 chain.variance.pickup_raise_l1（差异单行为，归 variance）
--  chain.variance.default_disposition —— 第三、四轮的「处置归属三选一」已被第五轮的两个出口
--                                     （pickup 补差 / writeoff 冲差）替代 → 见 chain.variance.default_action
--  chain.variance.carry_mode       —— 同义于 chain.variance.pickup_carry_immediate
--  chain.cost.allow_zero           —— 决策未定，接线时再定名，先不登记
--
-- 命名与写法约定（避免再出同义键）：
--   · 名称为「主体.对象.动作/阈值」，阈值放 `_pct`/`_days`/`_h` 后缀，不写 dev/fresh 之类的黑话；
--   · `value_type='enum'` 时 `enum_options` 用 `[{"v":"x","label":"中文说明"}]`；
--   · `value_type='number'` 时**必须填 unit**（设置页单位后置，说明列不再重复写单位）。
