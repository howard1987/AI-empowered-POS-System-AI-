-- ═══ 013_price_change_cost.sql · V4.8.16 调价单支持进价调价 ═══
-- price_type: 'sale' 售价调价（默认，历史单兼容）| 'cost' 进价调价（供应商×商品基线，调价通知语义 V4.3.6）
ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS price_type VARCHAR(8) NOT NULL DEFAULT 'sale';
DO $$ BEGIN
  ALTER TABLE price_changes ADD CONSTRAINT ck_pc_type CHECK (price_type IN ('sale','cost')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 进价调价明细的供应商维度（sale 单恒为 NULL）
ALTER TABLE price_change_items ADD COLUMN IF NOT EXISTS supplier_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_pc_type ON price_changes(price_type);
