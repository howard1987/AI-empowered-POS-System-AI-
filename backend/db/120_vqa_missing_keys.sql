-- VQA 体检批次（2026-09-19）：补注册代码在用但 system_settings 缺席的键（后台可见/可配）
-- 幂等：随启动按序重放

-- GAP 体检1a：跨店退货现金腿开关（return-chain.module getBool('chain.return.cross_cash', false)）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '连锁设置', 'chain.return.cross_cash', '跨店退货现金退付', to_jsonb(false), to_jsonb(false), 'boolean',
       'true=允许受理店以现金直接退付他店订单（资金走店间往来台账）；false=强制走跨店冲减流程。默认关'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='chain.return.cross_cash');

-- GAP 体检1a：盘点差异上调 L1 开关（return-chain.module getBool('chain.variance.pickup_raise_l1', true)）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '连锁设置', 'chain.variance.pickup_raise_l1', '盘盈上调标准进价L1', to_jsonb(true), to_jsonb(true), 'boolean',
       'true=盘点盈余按棘轮规则允许抬高 L1 进价基准；false=盘盈只调数量不调价'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='chain.variance.pickup_raise_l1');
