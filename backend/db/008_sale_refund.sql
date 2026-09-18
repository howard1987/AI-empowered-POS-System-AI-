-- ═══ 008: 销售退款闭环（5.2.6 售后） ═══
-- 执行方式：init-db.ts 顺序执行 db/0*.sql；幂等

-- 1) sale_refunds 增加状态机（创建即执行=已退款；超限额=待审核，审核后执行/驳回）
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT '已退款';
COMMENT ON COLUMN sale_refunds.status IS '已退款（直退）/待审核/已驳回';
-- 退款渠道（原路退：现金/微信/支付宝/余额/分红抵扣/积分抵扣组合取主渠道；班次现金冲减只算现金退款）
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS refund_channel VARCHAR(16) NOT NULL DEFAULT '现金';

-- 2) 权限点：退款审核（限额之上需审核，权限点颗粒化）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('sales.refund.audit', '销售', '退款审核', 2)
ON CONFLICT (code) DO NOTHING;

-- 绑定超级管理员（001 的全量绑定发生在新权限点插入之前）
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points
 WHERE code='sales.refund.audit'
ON CONFLICT DO NOTHING;

-- 3) 设置项：免审限额（管理员可改）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
 ('销售', 'sales.refund.limit', '退款免审限额(元)', '200', '200', 'num', '退款金额 ≤ 限额直接执行；超过则创建为「待审核」，需 sales.refund.audit 权限审核')
ON CONFLICT (setting_key) DO NOTHING;
