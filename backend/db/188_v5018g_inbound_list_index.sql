-- V5.0.18g 入库单列表服务端分页的查询索引：状态筛选 + 时间倒序高频组合
CREATE INDEX IF NOT EXISTS idx_inbound_status_created ON inbound_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_created ON inbound_orders (created_at DESC);
