-- V5.0.15：最低售价兜底比率（原硬编码「售价 6 折」）
--   超市综合毛利普遍 ≤20%（成本约占售价 80%），6 折意味着每卖一件亏约 20%，红线形同虚设。
--   改为可配置：默认 0.8（最多打 8 折，保留 20% 毛利空间）。
--   生效范围：商品未设 min_price 时，红线价 = 售价 × 本比率；最终红线仍取 max(兜底价, 进价)。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('sales.floor_guard_rate', '收银台', '最低售价兜底比率',
        '0.8'::jsonb, '0.8'::jsonb, 'number',
        '商品未设「最低卖价」时的价格红线 = 售价 × 本比率。0.8=最多打 8 折。超市毛利通常 ≤20%，不建议低于 0.8；设 1 表示不允许低于售价')
ON CONFLICT (setting_key) DO NOTHING;
