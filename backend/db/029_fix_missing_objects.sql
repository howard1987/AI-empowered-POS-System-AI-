-- ═══════════════════════════════════════════════════════════════
-- 029_fix_missing_objects.sql（V4.8.25 缺陷修复迁移）
--   1) products 缺 biz_mode（购销/联营）：001 基线只建在 suppliers 上，
--      但 products.module / sales.module / bigcustomer.module 均有引用
--      → 报错 column "biz_mode" of relation "products" does not exist
--      → 影响：商品建档保存、商品列表搜索、采购订单开单、调价单扫码
--   2) 兜底补齐大客户回款登记（020）：relation "big_customer_payments" does not exist
--   幂等：全部 IF NOT EXISTS / DO 守卫，可安全重复执行
-- ═══════════════════════════════════════════════════════════════

-- 1) products.biz_mode（购销 / 联营，默认购销；与 suppliers.biz_mode 同枚举）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='products' AND column_name='biz_mode'
  ) THEN
    ALTER TABLE products ADD COLUMN biz_mode biz_mode_t NOT NULL DEFAULT '购销';
    COMMENT ON COLUMN products.biz_mode IS '经营方式：购销（自采自营）/ 联营（扣点结算）';
  END IF;
END $$;

-- 2) 大客户回款登记表兜底（与 020 完全一致；已存在则跳过）
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

INSERT INTO permission_points (code, module, name, risk_level) VALUES
  ('bigcustomer.manage', '大客户', '大客户与团购管理', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points WHERE code='bigcustomer.manage'
ON CONFLICT DO NOTHING;
