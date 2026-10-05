-- === V5.0.11e P0 补漏：qweather_key 未被首版正则命中 ===
--
-- 153 迁移用的正则是 (api_key|apikey|...)，而本键叫 ai.weather.qweather_key，
-- 既不含 api 也不含 apikey，首版漏掉了它 —— 而它是和风天气 API Key（裸明文）。
-- 教训：靠列举前缀的正则会漏，须改成「键名以 _key 结尾」这类**结构特征**判定。
-- 已同步放宽代码侧 SENSITIVE_KEY_RE（加 [._-]key$），这里把数据侧补齐。
--
-- 顺带把 qweather 的密钥形态键一并标 secret（若有 weather/和风 相关配置）。
UPDATE system_settings SET value_type = 'secret'
 WHERE value_type <> 'secret'
   AND setting_key ~* '[._-]key$'
   AND setting_key !~* 'hotkey';
