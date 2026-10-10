-- P-08：五类热查询缺失索引（对照 001_init.sql 索引清单与查询热点核验）
--   会员详情按 target 直查审计 / 价目表按 product_id 反查多码 / 收货审核按 po_id 拉行 /
--   退款上限校验按 refund_id 拉行 / 券核销按 coupon_id 统计——此前均全表扫描。
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_pbarcode_product ON product_barcodes (product_id);
CREATE INDEX IF NOT EXISTS idx_poitem_po ON purchase_order_items (po_id);
CREATE INDEX IF NOT EXISTS idx_refitem_refund ON sale_refund_items (refund_id);
CREATE INDEX IF NOT EXISTS idx_mcoupon_coupon ON member_coupons (coupon_id);
