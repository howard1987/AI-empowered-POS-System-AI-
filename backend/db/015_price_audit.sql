-- ═══ 015_price_audit.sql · V4.8.20 调价单重构：进价/售价同行 + 审核流 ═══
-- 流程：保存=待审核(pending) → 审核通过=生效(approved，售价更新+进价落地基线) → 作废(voided，仅待审核可作废)
-- 历史单（V4.8.16 之前"录入即生效"时代）统一视为已生效(approved)

ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS status VARCHAR(8) NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_pc_status ON price_changes(status);
ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS audited_by BIGINT;
ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ;
ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS voided_by BIGINT;
ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

-- price_type 允许 'dual'（同一单内售价与进价混调）
DO $$ BEGIN
  ALTER TABLE price_changes DROP CONSTRAINT ck_pc_type;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE price_changes ADD CONSTRAINT ck_pc_type CHECK (price_type IN ('sale','cost','dual')) NOT VALID;

-- 明细双轨价：old_price/new_price 售价留痕（售价行填写），old_cost/new_cost 进价留痕（进价行填写），未涉及的列为 NULL
ALTER TABLE price_change_items ALTER COLUMN old_price DROP NOT NULL;
ALTER TABLE price_change_items ALTER COLUMN new_price DROP NOT NULL;
ALTER TABLE price_change_items ADD COLUMN IF NOT EXISTS old_cost NUMERIC(10,2);
ALTER TABLE price_change_items ADD COLUMN IF NOT EXISTS new_cost NUMERIC(10,2);
