-- ═══════════════════════════════════════════════════════════════
-- 020_big_customer.sql（M9 大客户与团购销售）：回款登记表 + 权限点
--   应收口径：团购单（channel='大客户团购'）应付合计 - 回款登记 - 现结支付
--   台账聚合在接口层（bigcustomer.module.ts），不新建冗余字段
-- ═══════════════════════════════════════════════════════════════

-- 大客户回款登记（赊账回款/现结到账；台账已收口径 = 回款表合计 + 团购单非赊账实收）
CREATE TABLE IF NOT EXISTS big_customer_payments (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES big_customers(id) ON DELETE CASCADE,
  amount       NUMERIC(12,2) NOT NULL,
  method       VARCHAR(16) NOT NULL DEFAULT '现金',   -- 现金 / 转账 / 微信 / 支付宝 / 其他
  remark       VARCHAR(128),
  operator_id  BIGINT REFERENCES employees(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bcpay_customer ON big_customer_payments (customer_id, created_at DESC);

-- 权限点：大客户与团购管理（建档/专价/下单/回款；查看报表用 report.view.all）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
  ('bigcustomer.manage', '大客户', '大客户与团购管理', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points WHERE code='bigcustomer.manage'
ON CONFLICT DO NOTHING;
