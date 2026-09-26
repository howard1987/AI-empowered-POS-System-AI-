-- 131 · V4.28.1 SQL 审查修复（gstack 报告 🟠-8 / P1-8 / 🟠-4 重点索引）
-- 幂等：全部 IF NOT EXISTS

-- ── ① 总部对账核销：(store, 期间) 唯一 —— 防同一门店同一期间重复核销打款 ──
CREATE UNIQUE INDEX IF NOT EXISTS uq_hq_recon_settle_store_period
  ON hq_recon_settlements (store_id, period_from, period_to);

-- ── ② 外键热点列补索引（父表 DML / JOIN 全表扫描，见审查 C-6）──
CREATE INDEX IF NOT EXISTS idx_batches_product        ON batches (product_id);
CREATE INDEX IF NOT EXISTS idx_batches_store_status   ON batches (store_id, status);
CREATE INDEX IF NOT EXISTS idx_sale_payments_order    ON sale_payments (order_id);
CREATE INDEX IF NOT EXISTS idx_inbound_items_inbound  ON inbound_order_items (inbound_id);
CREATE INDEX IF NOT EXISTS idx_inbound_items_batch    ON inbound_order_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_inbound_items_product  ON inbound_order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_return_allocs_batch    ON return_batch_allocs (batch_id);
CREATE INDEX IF NOT EXISTS idx_return_allocs_item     ON return_batch_allocs (return_item_id);
CREATE INDEX IF NOT EXISTS idx_sti_transfer           ON stock_transfer_items (transfer_id);
CREATE INDEX IF NOT EXISTS idx_sti_batch              ON stock_transfer_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_loss_items_batch       ON loss_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_sib_sale_item          ON sale_item_batches (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sib_batch              ON sale_item_batches (batch_id);
CREATE INDEX IF NOT EXISTS idx_setting_logs_key       ON setting_change_logs (setting_key, created_at DESC);
