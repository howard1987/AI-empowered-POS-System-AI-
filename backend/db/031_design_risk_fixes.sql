-- ============================================================================
-- 031_design_risk_fixes.sql · 设计风险修复（PWA 全功能测试报告 2026-09-06）
-- ① 离线补传幂等：sales_orders.client_ref 客户端单号（PWA 离线队列生成），
--    部分唯一索引：同 ref 重发直接返回原单，杜绝补传中断重试重复入账
-- ④ 手输条码独立留痕：sale_items.manual_barcode（原仅拼入 line_remark 文本）
-- 支持重复执行（IF NOT EXISTS）
-- ============================================================================
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS client_ref VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_client_ref
  ON sales_orders(client_ref) WHERE client_ref IS NOT NULL;
COMMENT ON COLUMN sales_orders.client_ref IS '客户端幂等单号（离线补传去重，8.5.1）';

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS manual_barcode VARCHAR(64);
COMMENT ON COLUMN sale_items.manual_barcode IS '手输条码独立留痕（manualEntry 时的扫码/输入值）';
