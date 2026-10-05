-- ═══ V5.0.11c 防引导死锁：回环地址豁免 ═══
--
-- 【问题】设备授权天然形成死锁：要授权设备得先登录，要登录得先被授权。
--   管理员换新电脑/新手机后，登录被拒 → 进不了后台 → 无法授权 → 永远登不上。
--   （V5.0.11 上线当天即触发：老板本机 D2600AD96 未授权，管理后台登录被 40307 拦死。）
--
-- 【解法】回环地址豁免：来自 127.0.0.0/8 或 ::1 的请求跳过设备授权。
--   理由：这种请求的进程就跑在服务器本机上，攻击者已具备本机管理员权限，
--   设备授权（防的是「抄走设备码在别人设备上登录」）对它已无意义。
--   **不影响远程安全**：手机、同事电脑走的是 192.168.x.x，仍必须被授权。
--
-- 【另配两道保险】
--   ① 应急恢复码 DEVICE_RECOVERY_CODE / pos.device.recovery.hint —— 管理后台前端已接入输入框
--   ② break-glass CLI：npm run device:grant -- <设备码>   —— 需要服务器控制台权限
--
-- 【可关闭】若不接受「本机免授权」，设为 false，此时只剩上面①②两条脱困路径。

INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.auth.loopback.bypass', 'true'::jsonb, 'bool', '设备管理', '本机（127.0.0.1）免设备授权', 'true'::jsonb,
       '从服务器本机（127.0.0.1 / ::1）发起的登录跳过设备授权校验，用于避免「授权需要登录、登录需要授权」的引导死锁。手机与局域网其它电脑不受影响，仍须授权。不接受可关闭，但关闭后管理员换设备须靠恢复码或 npm run device:grant 解封'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.auth.loopback.bypass');
