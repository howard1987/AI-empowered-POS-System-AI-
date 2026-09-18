-- VQA 缺口批次（2026-09-18）：GAP-01 退货时限 / GAP-06 秤签时效 / GAP-04 大客户可见范围
-- 幂等：随启动按序重放

-- GAP-01：退货时限（自然日，自原单创建日起算；0=不限）——行业惯例默认 7 天，可按门店调整
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银设置', 'sales.refund.window_days', '退货时限（天）', to_jsonb('7'::text), to_jsonb('7'::text), 'string',
       '原单创建超过 N 天拒绝收银台退货（50077）；0=不限（回到旧行为）；隔日退口径见测试用例 M9-06'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='sales.refund.window_days');

-- GAP-06：秤签有效期天数（仅当秤码模板含 T 段时间段时生效；1=当日有效）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '智能与打印', 'ai.scale.label_valid_days', '秤签有效期（天）', to_jsonb('1'::text), to_jsonb('1'::text), 'string',
       '模板含 T 段（6位 YYMMDD 或 8位 YYYYMMDD 打印日期）时校验：超出 N 天或未来日期拒收；无 T 段的模板不受影响'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.scale.label_valid_days');

-- GAP-04：大客户可见范围（'store'=仅建档门店（默认，现状不变）| 'all'=全部门店可见可挂 | [门店id数组]=部分可见）
ALTER TABLE big_customers ADD COLUMN IF NOT EXISTS share_scope JSONB NOT NULL DEFAULT '"store"'::jsonb;
COMMENT ON COLUMN big_customers.share_scope IS 'VQA-GAP04 跨店可见范围：总部开关；额度/编辑仍归建档门店';
