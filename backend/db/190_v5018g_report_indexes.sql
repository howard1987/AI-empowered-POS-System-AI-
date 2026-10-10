-- V5.0.18g 报表查询配套索引：报表普遍按「已完成订单 + 区间」聚合，以及按商品/收银员/会员维度分组
CREATE INDEX IF NOT EXISTS idx_so_status_created ON sales_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_so_cashier_created ON sales_orders (cashier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_so_member_created ON sales_orders (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_si_product ON sale_items (product_id);
CREATE INDEX IF NOT EXISTS idx_sf_product_created ON stock_flows (product_id, created_at DESC);
