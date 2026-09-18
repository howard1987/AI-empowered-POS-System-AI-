-- ═══════════════════════════════════════════════════════════════
-- V4.14.0 批量整改（09-09 晚）
--   A  费用协议：协议性质（周期性/一次性）+ 期数上限
--   S  扫码购开关（sales.scanpay_enabled）
--   C  大客户：预充值余额 + 业务电子签字
--   M  会员：密保问题（JSONB 哈希）+ 隐私协议文本设置项 + 等级价格模式说明
-- 幂等：全部 IF NOT EXISTS / ON CONFLICT
-- ═══════════════════════════════════════════════════════════════

-- A：费用协议 协议性质 + 期数（一次性=1 期；周期性 NULL=不限期）
ALTER TABLE supplier_fee_agreements ADD COLUMN IF NOT EXISTS fee_nature    VARCHAR(8)  NOT NULL DEFAULT '周期性';
ALTER TABLE supplier_fee_agreements ADD COLUMN IF NOT EXISTS total_periods SMALLINT;

-- S：扫码购开关（关=会员端自助结算入口停用，后台流水仍可查）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark)
VALUES ('销售', 'sales.scanpay_enabled', '扫码购功能',
        '"关"', '"关"', 'enum',
        '[{"v":"开","label":"开（顾客可自助扫码购）"},{"v":"关","label":"关（停用自助扫码购）"}]',
        '开启后会员端可自助扫码购并生成核销码；核销抽检在收银台前台「扫码购核销」进行，后台仅展示流水')
ON CONFLICT (setting_key) DO NOTHING;

-- C：大客户 预充值余额 + 业务电子签字（建档/编辑时采集）
ALTER TABLE big_customers ADD COLUMN IF NOT EXISTS balance        NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE big_customers ADD COLUMN IF NOT EXISTS signature_path VARCHAR(255);

-- M：会员密保问题（[{question, answerHash}]，答案 bcrypt 哈希不落明文）
ALTER TABLE members ADD COLUMN IF NOT EXISTS security_questions JSONB;

-- M：隐私协议文本（建档勾选处点击可查看；有权限者可在此更新）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES ('会员', 'member.privacy_text', '会员隐私协议文本',
        '"本店承诺仅将您的手机号、姓名、生日与消费记录用于会员服务（积分、储值、分红、优惠），不对外提供，不用于其他用途。您可随时到店申请查询、更正或注销个人信息。"',
        '"本店承诺仅将您的手机号、姓名、生日与消费记录用于会员服务（积分、储值、分红、优惠），不对外提供，不用于其他用途。您可随时到店申请查询、更正或注销个人信息。"',
        'text', '会员建档勾选「隐私协议」处点击可查看全文；有系统设置权限者可在此更新（更新后新建档按新文本）')
ON CONFLICT (setting_key) DO NOTHING;

-- M：会员等级价格模式（说明现有三选一行为；当前实现=商品档案会员价优先，等级折扣开关叠加）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark)
VALUES ('会员', 'member.level_price_mode', '会员等级价格模式',
        '"商品档案会员价优先"', '"商品档案会员价优先"', 'enum',
        '[{"v":"商品档案会员价优先","label":"商品档案会员价优先（当前实现：先取商品会员价，等级折扣开关叠加）"},{"v":"仅等级折扣","label":"仅等级折扣（关闭会员价）"},{"v":"仅商品会员价","label":"仅商品会员价（关闭等级折扣）"}]',
        '当前实现：商品档案设了会员价(member_price/member_discount)的商品按会员价；未设会员价且开启 member.level_discount 时按会员等级折扣。改档位等级不会覆盖商品会员价')
ON CONFLICT (setting_key) DO NOTHING;

-- C：大客户预存余额支付通道（枚举值；PG 12+ 事务内加值安全）
ALTER TYPE pay_channel_t ADD VALUE IF NOT EXISTS '预存余额';
