-- ═══ 102_v4265_price_chain.sql · V4.26.5 连锁调价管理：整体调价 / 本地门店调价 ═══
-- 1) apply_scope：调价生效范围
--      'all'  = 整体调价（所有门店生效）
--      'local'= 本地门店调价（仅所调门店生效，连锁调价管理）
-- 2) target_store_id：local 模式指向所调门店；all 模式恒为 NULL
-- 说明：当前 products 表为全局（无 store_id），单店部署 store_id 恒为 1，两种模式行为等价；
--       连锁部署按 apply_scope + target_store_id 隔离（数据已就绪，价格落地隔离待后续 per-store 价格表）。

ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS apply_scope VARCHAR(8) NOT NULL DEFAULT 'all';
ALTER TABLE price_changes ADD COLUMN IF NOT EXISTS target_store_id BIGINT;

ALTER TABLE price_changes DROP CONSTRAINT IF EXISTS price_changes_apply_scope_chk;
ALTER TABLE price_changes ADD CONSTRAINT price_changes_apply_scope_chk
  CHECK (apply_scope IN ('all', 'local'));

ALTER TABLE price_changes DROP CONSTRAINT IF EXISTS price_changes_target_store_fk;
ALTER TABLE price_changes ADD CONSTRAINT price_changes_target_store_fk
  FOREIGN KEY (target_store_id) REFERENCES stores(id) ON DELETE SET NULL;

COMMENT ON COLUMN price_changes.apply_scope IS 'all=整体调价(所有门店生效) / local=本地门店调价(仅所调门店生效)';
COMMENT ON COLUMN price_changes.target_store_id IS 'local 模式目标门店；all 模式为 NULL';

-- 历史数据（若有）默认归为整体调价
UPDATE price_changes SET apply_scope = 'all' WHERE apply_scope IS NULL OR apply_scope NOT IN ('all', 'local');
