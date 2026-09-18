-- V4.13.2 支付通道适配层（模拟通道先行）：付款码支付网关流水
-- 流程对齐成熟收银：扫顾客付款码 → 通道扣款 → 成功应答落单（免人工核对到账）
-- out_trade_no 唯一 = 幂等键：同单号重放返回原应答，杜绝重复扣款

CREATE TABLE IF NOT EXISTS pay_gateway_txns (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL,
  out_trade_no   VARCHAR(64) NOT NULL,          -- 我方单号（收银端生成，幂等键）
  channel        VARCHAR(16) NOT NULL,          -- 微信 / 支付宝（付款码前缀识别）
  auth_code_last4 VARCHAR(8),                   -- 付款码后 4 位留痕（全码不落库）
  amount_cents   BIGINT NOT NULL,               -- 扣款金额（整数分）
  status         VARCHAR(16) NOT NULL DEFAULT 'PENDING',
                 -- SUCCESS / FAIL / PART_REFUNDED / REFUNDED
  transaction_id VARCHAR(64),                   -- 通道流水号（写入 sale_payments.external_no）
  fail_code      VARCHAR(64),
  fail_msg       VARCHAR(255),
  order_id       BIGINT,                        -- 结账成功后回填关联销售单
  refund_cents   BIGINT NOT NULL DEFAULT 0,     -- 已原路退回累计（分）
  refund_no      VARCHAR(64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ,
  refunded_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_paygw_out_trade_no ON pay_gateway_txns(out_trade_no);
CREATE INDEX IF NOT EXISTS ix_paygw_order  ON pay_gateway_txns(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_paygw_txn_id ON pay_gateway_txns(transaction_id) WHERE transaction_id IS NOT NULL;

-- 通道模式：mock=模拟通道（默认，资质下来切真适配器）/ off=记账式收款（回退二次确认）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '支付', 'pay.gateway.mode', '支付通道模式', '"mock"'::jsonb, '"mock"'::jsonb, 'string',
       'mock=模拟通道（付款码扣款+原路退款，成功应答自动落单，无需人工核对到账）；off=记账式收款（手记流水，保留 V4.13.1 二次确认）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'pay.gateway.mode');
