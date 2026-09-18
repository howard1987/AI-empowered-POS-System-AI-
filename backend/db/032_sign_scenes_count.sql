-- 032: 必签场景矩阵补齐 count（盘点）——对齐设计文档 5.6.8⑤ 触发场景矩阵
-- 背景：PWA 全功能测试（pwa_full B/F 段）发现未签字盘点单可直接过审；
-- 且该配置曾被设置页整组保存覆盖回退。本迁移同时修正 value 与 default_value，
-- 使"恢复默认"与页面整组保存后的语义仍包含盘点必签。
UPDATE system_settings
   SET value         = '["inbound","return","loss","recon","count"]'::jsonb,
       default_value = '["inbound","return","loss","recon","count"]'::jsonb,
       updated_at    = now()
 WHERE setting_key = 'auth.sign_required_scenes'
   AND NOT (value @> '["count"]'::jsonb);
