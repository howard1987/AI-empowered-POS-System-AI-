-- ═══ V4.25.0 登录即开班 + 取单默认本人（094）═══
-- 背景（老板实测反馈 5 项）：
--   ① 登录即开班：弹「开班确认框」（收银员/机号/班次号/备用金，备用金记忆，回车进收银）
--   ② 老板端补同一套 bootstrap（无管理员引导创建）
--   ③ 锁屏解锁改用 PIN（未设 PIN 自动回退密码）
--   ④ 取单列表默认只看本人，后台可设「本人/全店」开关
--   ⑤ 讲述人拟真语音打包不可行（Windows 讲述人不注册 SAPI/OneCore，Chromium 枚举不到），维持 piper 离线神经语音
-- 本文件：① 的班次号列 + ④ 的取单默认范围开关种子。幂等，可重复执行。

-- ── ① 班次号（机号之外的班次标识，如 1/A/早班/晚班）──
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS shift_no VARCHAR(16);

-- ── ④ 取单默认范围：mine=只看本人 / all=全店（后台开关；前端取单默认按此，可临时切全店）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.held.default_scope', '取单默认范围',
       '"mine"'::jsonb, '"mine"'::jsonb, 'enum',
       '取单列表默认范围：mine=只看本人挂的单；all=全店所有挂单（店长/主管查全店时用）。可临时切换，本开关为默认态'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'pos.held.default_scope');

-- 开班备用金默认（收银台开班框预填；前端记忆优先于本值）—— 防御性补种（历史版本已引用）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashbox.float_default', '开班备用金默认（元）',
       '200'::jsonb, '200'::jsonb, 'number',
       '开班备用金默认值；登录即开班框与班次开班框预填，用户本机记忆优先于本值'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'pos.cashbox.float_default');
