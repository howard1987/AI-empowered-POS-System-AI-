-- VQA 设置分组归并（2026-09-19）：消除碎组/重复组，设置页 tab 由 14 组归并为 10 组
-- 幂等：按 setting_key 精确归组，可任意重放

-- ①「收银设置」(1) → 「通用设置」（pos./sales. 日常口径本就在通用组）
UPDATE system_settings SET group_name = '通用设置'
 WHERE group_name = '收银设置' AND setting_key = 'sales.refund.window_days';

-- ②「连锁设置」(2) → 「连锁管理」（语义重复的连锁组）
UPDATE system_settings SET group_name = '连锁管理'
 WHERE group_name = '连锁设置' AND setting_key IN ('chain.return.cross_cash', 'chain.variance.pickup_raise_l1');

-- ③「智能与打印」(2) → 「AI赋能」（ai.scale.* 系列同域）
UPDATE system_settings SET group_name = 'AI赋能'
 WHERE group_name = '智能与打印' AND setting_key IN ('ai.scale.check_verify', 'ai.scale.label_valid_days');

-- ④「门店硬消耗（分红口径）」(4) → 「财务管理」（分红/对账同域）
UPDATE system_settings SET group_name = '财务管理'
 WHERE group_name = '门店硬消耗（分红口径）' AND setting_key LIKE 'store.cost.%';
