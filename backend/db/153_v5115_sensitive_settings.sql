-- === V5.0.11e P0 安全修复：敏感设置标记为 secret ===
--
-- 【漏洞】真机多身份联调发现：GET /settings 只有 PUT 有 sys.settings 守卫，
--   任何登录用户（含收银员 SY0001，仅 8 项权限、无 sys.settings）都能读到全部 256 条设置：
--     pos.device.recovery.hint = POS-RECOVERY-****   <- 应急恢复码
--     ai.weather.qweather_key                         <- 第三方 API Key（裸明文，未标 secret）
--   拿到恢复码即可在任何设备上直接授权登录，V5.0.11 的整套设备授权被清零。
--
-- 【修复两层】
--   1 代码层 settings.module.ts：GET /settings 按权限过滤敏感项，非管理员连键名都拿不到。
--     不能给整个接口加 sys.settings 守卫 —— 收银端 pwa/cashier.js 要读「设备管理」「收银台」
--     分组、scale.js 要读全量，一刀切会把收银员打回原形。
--   2 数据层（本迁移）：把漏标 secret 的凭据类设置补上 value_type=secret，
--     复用既有 maskSecret 掩码，做到不依赖「是否记得标 secret」的人工约定。

UPDATE system_settings SET value_type = 'secret'
 WHERE value_type <> 'secret'
   AND setting_key ~* '(recovery|secret|private_key|public_key|api_key|apikey|app_key|app_secret|password|passwd|credential|token|mch_key|sign_key)';
