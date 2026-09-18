-- ═══ V4.21.1 P16 批2.5：收银机授权管理 + 局域网接入 ═══
-- 背景：自研 CORS 中间件曾只放行回环来源，同网段收银机/手机扫码登录报「CORS 未授权来源」；
--       老板要求后台可授权收银机（浏览器拿不到 MAC，采用 设备码+UA 指纹 + 服务端审批 白名单，强于 MAC 绑定）。

-- ── 收银机授权档案（首登自动登记为「待授权」，管理员审批后放行）──
CREATE TABLE IF NOT EXISTS pos_devices (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL DEFAULT 1,
  device_code   VARCHAR(32) NOT NULL,             -- 客户端生成并持久化的设备码（如 D+8位HEX）
  device_name   VARCHAR(60),                      -- 管理员备注名（如「1号收银机」）
  ua            TEXT,                             -- 首登记浏览器 UA（辅助人工识别）
  status        VARCHAR(10) NOT NULL DEFAULT '待授权',   -- 待授权/已授权/已停用
  approved_by   BIGINT,
  approved_at   TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  last_ip       VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, device_code)
);
CREATE INDEX IF NOT EXISTS idx_pos_devices_store ON pos_devices(store_id, status);

-- ── 开关：设备授权（默认关，开启后员工登录须设备已授权；ADMIN 超管豁免防锁死）──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.auth', 'false'::jsonb, 'bool', '收银', '收银机授权（设备白名单）', 'false'::jsonb,
       '开启后：新设备首次登录自动登记为待授权，管理员在「系统设置→收银机授权」审批；已授权设备才可登录员工账号（超管豁免）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'pos.device.auth');
