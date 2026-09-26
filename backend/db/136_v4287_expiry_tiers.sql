-- 136 · V4.28.7 临期折扣档位可配置化（原先写死 ≤7天5折/≤15天7折/其余8.5折）
-- 幂等：ON CONFLICT DO NOTHING。
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
('AI经营','ai.pricing.expiry_tiers','临期折扣档位','[{"maxDays":7,"rate":50},{"maxDays":15,"rate":70},{"maxDays":30,"rate":85}]',
 '[{"maxDays":7,"rate":50},{"maxDays":15,"rate":70},{"maxDays":30,"rate":85}]','json',
 '临期调价档位：JSON 数组 [{"maxDays":剩余天数上限,"rate":折扣百分数}]（rate 50=5折）。按 maxDays 从小到大匹配（剩余天数≤maxDays 即命中），超出全部档位按最深折扣兜底；格式错误回落默认档，rate 需 1~99。配合「临期允许低于进价」两开关实现低于进价去化')
ON CONFLICT (setting_key) DO NOTHING;
