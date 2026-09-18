-- ═══ V4.18.9 收银台小票打印开关（F7 快捷切换；默认开）═══
--  价值：扫码枪收银高峰不想出小票时一键关；与 pos.print.auto（后台打印中心总开关）叠加生效
--  幂等防线：NOT EXISTS 种子

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.print', '小票打印', 'true'::jsonb, 'true'::jsonb, 'bool',
       '收银台小票打印开关（F7 快捷切换，默认开）；关闭时收款/钱箱/语音不受影响'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.print');
