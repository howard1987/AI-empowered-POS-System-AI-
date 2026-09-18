-- 044 · V4.11.3 M4 长期闭环：识别质量报表
-- 1) ai_recognition_logs 补 layer 列（识别层级分布统计用；存量行为 NULL，报表归"未知"）
ALTER TABLE ai_recognition_logs ADD COLUMN IF NOT EXISTS layer text;
CREATE INDEX IF NOT EXISTS idx_reco_logs_created ON ai_recognition_logs (store_id, created_at);
