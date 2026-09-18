-- ═══ 062: V4.14.8 签字画像 + H5 会员端设置 ═══
-- 执行方式：init-db.ts 顺序重放；幂等

-- ── A：签字样本画像（V4.14.8 签字3：≥3 次采集形成画像，提升识别/比对精度）──
ALTER TABLE signature_templates ADD COLUMN IF NOT EXISTS profile JSONB;          -- {images:[...], strokes:[...], collected_at}
ALTER TABLE signature_templates ADD COLUMN IF NOT EXISTS sample_count SMALLINT NOT NULL DEFAULT 1;

-- ── B：H5 会员端设置（营销与线上组；入口地址供设置页二维码卡与快捷入口默认值）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT v.group_name, v.setting_key, v.display_name, to_jsonb(v.value), to_jsonb(v.value), v.value_type, v.remark
FROM (VALUES
  ('营销与线上', 'member.h5.enabled', '会员 H5 门户开关', 'true', 'bool',
   '开=会员掌上 H5（/member/）可访问；关=仅内部使用（入口二维码与快捷入口提示已关闭）'),
  ('营销与线上', 'member.h5.allow_register', 'H5 允许自助注册', 'true', 'bool',
   '开=会员手机号自助注册建档（含密保设置）；关=仅员工/后台建档'),
  ('营销与线上', 'member.h5.entry_url', 'H5 入口地址', '', 'string',
   '会员手机访问的完整地址（如 https://192.168.1.10:3443/member/）；留空=后台自动按当前服务器地址拼接。设置页「会员 H5 入口」二维码与首页快捷入口使用此值')
) AS v(group_name, setting_key, display_name, value, value_type, remark)
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = v.setting_key);
