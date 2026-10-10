-- V5.0.18g 列表服务端分页配套索引：各业务单据表按「门店 + id 倒序」（列表排序路径）
CREATE INDEX IF NOT EXISTS idx_preturn_store_id ON purchase_returns (store_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_counts_created ON inventory_counts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_counts_status ON inventory_counts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loss_created ON loss_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loss_status ON loss_records (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_created ON stock_transfers (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_so_store_id ON sales_orders (store_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_aitask_store_id ON ai_tasks (store_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_antileak_store ON antileak_alerts (store_id, id DESC);
