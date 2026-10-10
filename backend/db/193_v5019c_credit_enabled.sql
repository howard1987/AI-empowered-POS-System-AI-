-- 挂账落欠款修复（2026-10-09）：赊账通道停用（P2-3）后 member_credits 挂账块成死路径。
-- 现支持收银端显式挂账：dto.creditAmount（元），须开启本开关 + 指定会员；
-- Σ(支付+挂账)=应收，挂账落 member_credits（账期=pos.credit.due_days）并置 pay_paid_at=NULL。
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, unit, remark, scope)
SELECT '通用设置', 'pos.credit.enabled', '允许收银挂账',
       'false'::jsonb, 'false'::jsonb, 'bool', NULL, NULL,
       '开启后收银结账可传挂账金额（creditAmount）：当场不支付部分转会员账期欠款（member_credits，账期=挂账默认账期），需指定会员且 Σ(支付+挂账)=应收；关闭时传挂账金额直接拒绝',
       'hq'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.credit.enabled');
