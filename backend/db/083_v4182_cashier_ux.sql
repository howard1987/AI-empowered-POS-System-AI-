-- ═══ V4.18.2 收银台首轮真机反馈修复（083）═══
--  收银台设置组新增：每行商品数 / 键盘快捷键开关 / 语音播报开关
--  幂等防线：NOT EXISTS 种子

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.grid_cols', '每行商品数', '5'::jsonb, '5'::jsonb, 'number',
       '商品展示区每行卡片数量（4~8，默认 5）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.grid_cols');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.hotkeys', '键盘快捷键', 'true'::jsonb, 'true'::jsonb, 'bool',
       '收银台快捷键：F2=挂单 F4=取单 F6=重复上一单 F8=锁屏 F9=结算；数字键盘回车=扫码确认。EXE 桌面端将支持自定义'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.hotkeys');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.tts', '语音播报', 'true'::jsonb, 'true'::jsonb, 'bool',
       '收款成功后语音播报金额（收银台语音）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.tts');
