-- V5.0.18g 补齐 T6 本店配送依赖：
-- ① sales_orders.delivered_at（deliveryComplete 引用，历史迁移从未建过）
-- ② order_status_t 枚举补「已撤销」「配送中」（T6 deliveryList 的 NOT IN 过滤 / deliveryDispatch 的出车状态）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TYPE order_status_t ADD VALUE IF NOT EXISTS '已撤销';
ALTER TYPE order_status_t ADD VALUE IF NOT EXISTS '配送中';
