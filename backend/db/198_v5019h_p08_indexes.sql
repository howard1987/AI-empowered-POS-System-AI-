-- V5.0.19h · P-08 五类热查询缺索引 —— 补齐剩余两条
--
-- 报告核验的五个热点中，三条已有既有索引覆盖：
--   audit_logs(target_type,target_id) = idx_audit_target ✓
--   purchase_order_items(po_id)       = idx_poitem_po   ✓
--   member_coupons(coupon_id)         = idx_mcoupon_coupon ✓
-- 本迁移补齐确实缺失的两条（沿用 188~190 号 list_indexes 迁移惯例）：
--
-- ① product_barcodes(product_id)：价目表（304 指纹 json_agg 按商品聚合条码）与档案编辑
--    反查条码的热路径 —— 此前每查全表扫描，条码表随 SKU 增长线性变慢。
-- ② sale_refund_items(refund_id)：退款单明细聚合 / 退款上限校验 —— 同样每查全扫。
--
-- 幂等：CREATE INDEX IF NOT EXISTS，可重复执行。

CREATE INDEX IF NOT EXISTS idx_pbarcodes_product ON product_barcodes (product_id);
CREATE INDEX IF NOT EXISTS idx_refitems_refund   ON sale_refund_items (refund_id);
