-- ═══ 018: P2-3 联营对账 / 电子签字放开 / 次卡计次（5.7 / 5.6.8 / 5.3） ═══
-- 执行方式：init-db.ts 顺序执行 db/0*.sql；幂等

-- 1) 商品档案联营标记（5.7.8：purchase 购销 / consignment 联营 / rent 租赁，本版先支持购销/联营）
ALTER TABLE products ADD COLUMN IF NOT EXISTS biz_mode VARCHAR(8) NOT NULL DEFAULT '购销';
COMMENT ON COLUMN products.biz_mode IS '购销/联营：联营商品销售按供应商聚合对账（5.7）';

-- 2) 销售明细冗余供应商与模式（5.7.8：sale_item 冗余记录，收银下单时从商品带出）
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS supplier_id BIGINT;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS biz_mode VARCHAR(8) NOT NULL DEFAULT '购销';
CREATE INDEX IF NOT EXISTS idx_sitem_supplier ON sale_items (supplier_id, biz_mode, order_id);

-- 3) 次卡计次（5.3：购买 N 次卡按次核销；times_used 累计核销次数）
ALTER TABLE member_coupons ADD COLUMN IF NOT EXISTS times_used INT NOT NULL DEFAULT 0;
COMMENT ON COLUMN member_coupons.times_used IS '次卡已核销次数（discount=总次数，剩余=discount-times_used）';

-- 4) 电子签字放开现场补签：调用记录允许无模板（现场手写直存，5.6.8）
ALTER TABLE signature_records ALTER COLUMN template_id DROP NOT NULL;

-- 5) 联营对账单（5.7.6：销售汇总 → 扣点与保底 → 联营费用 → 对账 → 确认 → 结算）
CREATE TABLE IF NOT EXISTS consign_recons (
  id                BIGSERIAL PRIMARY KEY,
  store_id          BIGINT NOT NULL,
  recon_no          VARCHAR(32) UNIQUE NOT NULL,          -- LC-202609-001
  supplier_id       BIGINT NOT NULL REFERENCES suppliers(id),
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  sales_total       NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 销售额
  return_total      NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 退货额
  net_sales         NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 净销售额 = 销售额 - 退货额
  deduction_rate    NUMERIC(5,4),                         -- 扣点率快照
  deduction_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 超市扣点收益 = max(实际销售额, 保底销售额) × 扣点率
  guarantee_sales   NUMERIC(12,2),                        -- 保底销售额快照
  guarantee_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 保底补差（未达标差额按扣点计提）
  fee_total         NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 联营费用合计（水电/促销/POP/人员/耗材/损耗，收方向）
  payable_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 应结 = 净销售额 - 扣点 - 保底补差 - 费用
  status            VARCHAR(16) NOT NULL DEFAULT '生成',   -- 生成/待供应商确认/已确认/已结算/已作废
  confirm_type      VARCHAR(16),
  confirm_name      VARCHAR(32),
  sign_record_id    BIGINT,
  confirmed_at      TIMESTAMPTZ,
  employee_id       BIGINT,
  remark            VARCHAR(128),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cr_supplier ON consign_recons (supplier_id, period_start);

-- 6) 联营对账明细（可下钻到每一笔销售小票，5.7.6 ④）
CREATE TABLE IF NOT EXISTS consign_recon_items (
  id          BIGSERIAL PRIMARY KEY,
  recon_id    BIGINT NOT NULL REFERENCES consign_recons(id) ON DELETE CASCADE,
  order_id    BIGINT NOT NULL,
  order_no    VARCHAR(32) NOT NULL,
  order_date  DATE NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  qty         NUMERIC(12,3) NOT NULL DEFAULT 0,
  UNIQUE (recon_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_cri_recon ON consign_recon_items (recon_id);
