-- V4.17.0 样本操作留痕：signature_records 加 note 列（编辑操作的原因说明：离职/调岗等）
-- 幂等：可重放
ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS note text;
