-- ============================================================================
-- 116_v500_p3_bc_profit_dividend.sql · V5.0.0 P3-1/P3-2
--   ① 大客户专属价申请-审批（bc_price_requests）：门店提交申请 → 总部审批 → 价目生效；
--      提货仍在门店（下单 FIFO 扣本店库存不变）；申请表沿用 cost_diff_requests
--      「申请/审批同库」模式（与 P1 批次4 进价差异申请一致）
--   ② 门店对账核销（hq_recon_settlements）：会员消费/大客户消费按店按期汇总，
--      总部核销记账（权限点复用 hq.finance.view）
--   ③ 每日净利：daily_settlement 补 hard_cost_daily / net_profit（净利 = 毛利 − 硬消耗日摊）；
--      dividend_periods 补 gross_profit / hard_cost（公示口径）
--   ④ 设置键：store.cost.*（月房租/水电/折旧/其他，scope='store' 门店自治 + 总部可下发）+
--      dividend.auto.enabled（自动每日分红总开关，scope='hq'）—— 全部已接线，无死键
-- 幂等：语句级重放；单店零回归：新列带默认值、新键默认安全值
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 大客户专属价申请
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bc_price_requests (
  id             BIGSERIAL PRIMARY KEY,
  req_no         VARCHAR(32) NOT NULL UNIQUE,          -- SQ-yyyymmdd-xxxx
  store_id       BIGINT NOT NULL REFERENCES stores(id),-- 申请门店
  customer_id    BIGINT NOT NULL REFERENCES big_customers(id),
  product_id     BIGINT NOT NULL REFERENCES products(id),
  req_price      NUMERIC(12,4) NOT NULL,               -- 申请价
  base_price     NUMERIC(12,4),                        -- 申请时零售价快照
  wholesale_price NUMERIC(12,4),                       -- 申请时批发价快照（无则 NULL）
  reason         VARCHAR(200),
  status         VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending/approved/rejected
  approved_price NUMERIC(12,4),                        -- 审批通过价（可改）
  audit_remark   VARCHAR(200),
  audited_by     BIGINT, audited_at TIMESTAMPTZ,
  created_by     BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bcpr_store_status ON bc_price_requests (store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bcpr_cust         ON bc_price_requests (customer_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 门店对账核销台账
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hq_recon_settlements (
  id               BIGSERIAL PRIMARY KEY,
  settle_no        VARCHAR(32) NOT NULL UNIQUE,        -- HX-yyyymmdd-xxxx
  store_id         BIGINT NOT NULL REFERENCES stores(id),
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  sales_total      NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 期内销售额（已完成单）
  cost_total       NUMERIC(12,2) NOT NULL DEFAULT 0,
  profit_total     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 毛利
  member_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 其中会员消费（含余额/分红抵扣）
  bc_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 其中大客户团购消费
  bc_credit_unpaid NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 大客户赊账未回款（参考值不参与核销）
  settled_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 本次核销金额（默认=毛利，可改）
  status           VARCHAR(12) NOT NULL DEFAULT 'settled',
  note             VARCHAR(200),
  settled_by       BIGINT, settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hrs_store ON hq_recon_settlements (store_id, period_to DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 每日净利列（净利 = 毛利 − 门店硬消耗日摊）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE daily_settlement ADD COLUMN IF NOT EXISTS hard_cost_daily NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE daily_settlement ADD COLUMN IF NOT EXISTS net_profit      NUMERIC(12,2) NOT NULL DEFAULT 0;
-- 历史行回填：净利=毛利（当时未计硬消耗）
UPDATE daily_settlement SET net_profit = profit_total WHERE net_profit = 0 AND profit_total <> 0;

ALTER TABLE dividend_periods ADD COLUMN IF NOT EXISTS gross_profit NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE dividend_periods ADD COLUMN IF NOT EXISTS hard_cost    NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ 设置键（数字键必填 unit；scope='store' 门店自治/总部可下发；全部已接线）
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO system_settings
  (group_name, setting_key, display_name, value, default_value, value_type, unit, enum_options, remark, scope)
VALUES
  ('门店硬消耗（分红口径）','store.cost.rent',         '月房租',       '0'::jsonb,'0'::jsonb,'number','元/月',NULL,
   '每月房租总额；日摊 = 月值 ÷ 当月天数，计入每日净利（分红基数）扣减', 'store'),
  ('门店硬消耗（分红口径）','store.cost.utility',      '月水电费',     '0'::jsonb,'0'::jsonb,'number','元/月',NULL,
   '每月水电燃气等总额；按月估值日摊计入净利', 'store'),
  ('门店硬消耗（分红口径）','store.cost.depreciation', '月折旧摊销',   '0'::jsonb,'0'::jsonb,'number','元/月',NULL,
   '设备装修等按月折旧摊销额；日摊计入净利', 'store'),
  ('门店硬消耗（分红口径）','store.cost.other',        '月其他固定消耗','0'::jsonb,'0'::jsonb,'number','元/月',NULL,
   '物业/网费/固定人工外包等其他月度固定支出；日摊计入净利', 'store'),
  ('分红与会员','dividend.auto.enabled', '自动每日分红', 'true'::jsonb,'true'::jsonb,'bool',NULL,NULL,
   '开启后每日 02:35 自动按昨日净利 × dividend.ratio 计提分红（幂等，与手动计提互斥）；关闭则仅手动计提', 'hq')
ON CONFLICT (setting_key) DO NOTHING;
