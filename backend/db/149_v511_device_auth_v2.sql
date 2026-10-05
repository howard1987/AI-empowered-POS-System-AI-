-- ═══ V5.0.11 设备授权加固：员工绑定 + 角色配额 + 门店总量 + 硬件级设备身份 ═══
-- 背景（真实安全缺陷，三层叠加导致「知道账密即可任意设备登录」）：
--   ① pos.device.auth 默认 false → 设备授权根本没开启；
--   ② isSuperAdmin() 无条件豁免 → 超管可在任意设备登录；
--   ③ deviceCode 由前端 crypto.getRandomValues 自生成并存 localStorage，
--      攻击者改一下本地存储就是一个「新设备」，设备码本身不构成身份。
--
-- 本次改造（P0 + P1）：
--   P0 设备绑定员工（一台设备固定一个员工）+ 按角色配额（收银员/库管 1 台、店长/财务/管理员 2 台）
--       + 门店授权设备总量上限 + 同一时间一个账号只允许一台设备在线（复用 token_version 吊销）
--       + 超管不再豁免，改由「应急恢复码」兜底（防把自己锁在门外）
--   P1 设备身份强化：客户端用不可导出的密钥对（Android Keystore / WebCrypto）对登录挑战签名，
--       服务端验签 → 设备码被抄到别的设备也登不进去（TOFU 首次登记公钥）。
--
-- 兼容性：pos_devices 既有记录 employee_id 为空 → 首次成功登录时自动绑定（不影响已授权设备继续使用）。

-- ── ① pos_devices 扩展：设备绑定员工 + 设备类型 + 公钥（P1 验签）──
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS employee_id BIGINT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS bound_at TIMESTAMPTZ;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS device_type VARCHAR(16);      -- pc / mobile / pad
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS pubkey TEXT;                  -- P1：base64 SPKI 公钥
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS sig_algo VARCHAR(24);         -- P1：RSA-SHA256
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
COMMENT ON COLUMN pos_devices.employee_id IS '绑定的员工；为空表示尚未绑定，首次登录时按 TOFU 绑定。4A 决策：一台设备固定一个员工';
COMMENT ON COLUMN pos_devices.pubkey IS 'P1 硬件级设备身份：客户端不可导出私钥的公钥（base64 SPKI），服务端据此验签';
CREATE INDEX IF NOT EXISTS idx_pos_devices_emp ON pos_devices(store_id, employee_id, status);

-- ── ② 开关：设备授权总闸（本次改为默认开启）──
UPDATE system_settings
   SET value = 'true'::jsonb,
       default_value = 'true'::jsonb,
       value_type = 'bool',
       remark = '开=员工登录必须使用「已授权设备」，新设备自动登记为待授权并上报管理后台；关=任何人知道账密即可在任意设备登录（不建议）'
 WHERE setting_key = 'pos.device.auth';

-- ── ③ 角色配额：收银员/库管 1 台，店长/财务/管理员 2 台（可在后台改）──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.limit.cashier', '1'::jsonb, 'number', '设备管理', '收银员/库管 可授权设备数', '1'::jsonb,
       '收银员、库管 默认只允许 1 台设备（一台设备固定一个员工）；共享收银台请调高或关闭「设备绑定员工」'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.limit.cashier');

INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.limit.manager', '2'::jsonb, 'number', '设备管理', '店长/财务/管理员 可授权设备数', '2'::jsonb,
       '店长、财务、超级管理员 默认允许 2 台（手机 + 电脑/_PAD 各一）；超管另有应急恢复码兜底'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.limit.manager');

-- ── ④ 设备↔员工绑定开关（4A 决策=一台设备固定一个员工）──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.bind.employee', 'true'::jsonb, 'bool', '设备管理', '设备绑定员工（一机一人）', 'true'::jsonb,
       '开=一台设备固定绑定一个员工，别人无法在该设备登录（更安全，但收银台不能共用）；关=设备仅按门店授权，谁都能用（适合共用收银台）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.bind.employee');

-- ── ⑤ 单会话：同一时间一个账号只允许一台设备在线 ──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.single.session', 'true'::jsonb, 'bool', '设备管理', '单账号单设备在线', 'true'::jsonb,
       '开=新设备登录后，旧设备的会话在 60 秒内失效（防同账号多地同时收银/改价）；关=允许多设备同时在线'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.single.session');

-- ── ⑥ 门店授权设备总量上限（0 = 不限）──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.store.cap', '0'::jsonb, 'number', '设备管理', '门店授权设备总量上限', '0'::jsonb,
       '0=不限。超过上限后新设备无法登记为待授权（防门店设备无限膨胀）。建议按「收银台数 + 备用机」设定，如 8'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.store.cap');

-- ── ⑦ P1：强制设备签名（老客户端无签名能力，故默认关；新前端/新 APK 上线后可开启）──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.require.signature', 'false'::jsonb, 'bool', '设备管理', '强制设备签名校验（P1）', 'false'::jsonb,
       '开=设备必须用硬件私钥对登录挑战签名（设备码被抄到别的电脑/手机也登不进去）。需前端与 APK 均升级后再开启，否则旧设备全部无法登录'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.require.signature');

-- ── ⑧ 应急恢复码（超管不豁免后的防锁死通道）──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.recovery.hint', to_jsonb(''::text), 'text', '设备管理', '设备授权应急恢复码', to_jsonb(''::text),
       '超管被挡在门外时的兜底：登录时填写此码可强制通过并自动授权本设备。留空表示未启用（改用环境变量 DEVICE_RECOVERY_CODE）。生成后请妥善保管'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.recovery.hint');
