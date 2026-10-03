-- V5.0.6 供应商停用/启用 + 停用满 90 天方可删除
-- suppliers.status 语义：1=启用（正常） 2=停用 0=已删除（软删，列表不显示）
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
COMMENT ON COLUMN suppliers.status IS '1=启用, 2=停用, 0=已删除(软删)';
COMMENT ON COLUMN suppliers.disabled_at IS '最近一次停用的时间；停用满 90 天后允许删除';
