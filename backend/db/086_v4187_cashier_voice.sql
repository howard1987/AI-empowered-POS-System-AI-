-- ═══ V4.18.7 收银台播报音色可选拟人化（086）═══
--  收银台语音设置增强：音色/语速可选，空值=跟随老板端（voice.tts.*，055 拟人引擎键）
--  幂等防线：NOT EXISTS 种子

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.tts.voice', '播报音色', '""'::jsonb, '""'::jsonb, 'string',
       '收银台播报音色：空=跟随老板端设置（voice.tts.voice）；可选本机中文音色（优先拟真人声）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.tts.voice');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.tts.rate', '播报语速', '""'::jsonb, '""'::jsonb, 'string',
       '收银台播报语速：空=跟随老板端设置（voice.tts.rate）；0.85~1.3 倍'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.tts.rate');
