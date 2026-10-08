-- V5.0.15：退货时限按商品分类分别配置
--   原实现整单统一 sales.refund.window_days（默认 7 天），生鲜当天就变质却仍可退 7 天，
--   百货日化本可放宽却被一并卡死 —— 现支持按分类设置不同时限。
--   取值：JSON 对象，键=分类名称（商品所属分类或其父分类），值=允许退货天数（1=当天，0=不限）。
--   未命中分类的，回退到 sales.refund.window_days。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('refund.window_by_category', '收银台', '退货时限（按分类）',
        '{"生鲜":1,"蔬菜":1,"水果":1,"肉禽蛋":1,"水产":1,"熟食":1,"烘焙":1,"百货":7,"日化":7,"食品":7,"酒水":7,"针织":7}'::jsonb,
        '{"生鲜":1,"蔬菜":1,"水果":1,"肉禽蛋":1,"水产":1,"熟食":1,"烘焙":1,"百货":7,"日化":7,"食品":7,"酒水":7,"针织":7}'::jsonb,
        'json',
        '按商品分类设置退货天数（1=仅限当天）。生鲜类建议 1 天，百货日化可放宽至 7 天；未在此列出的分类回退到 sales.refund.window_days')
ON CONFLICT (setting_key) DO NOTHING;
