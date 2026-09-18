-- V4.9.4：采购订单审批电子签名
-- 审批通过时采集审批人手写签名，落库路径 + 审批留痕（审批人姓名经 approver_id JOIN employees 得出）
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approver_sign_path VARCHAR(256);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS void_reason VARCHAR(128);
