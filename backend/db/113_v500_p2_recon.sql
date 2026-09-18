-- ============================================================================
-- 113_v500_p2_recon.sql · V5.0.0 连锁 P2-2（对账健壮）+ 拒付补付（老板 2026-09-18 拍板）
--   ① 拒付补付：member_offline_credits 补 settle_channel（现金/微信/支付宝补录结清）
--   ② nonce 去重：sync_nonces（NodeGuard 防重放第二道闸，±300s 窗口内一次性）
--   ③ 逐批明细链：sync_sale_batches（sale_order 上行批次明细落总部，对账专用无 FK）
--   ④ hq_sales_daily 物化：mv_hq_sales_daily + CONCURRENTLY 刷新函数（总部报表提速）
-- 幂等：语句级重放；单店零回归：全部新对象，不改既有列语义
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 拒付补付（口径：挂账清算被总部拒付（余额不足）→ 门店向会员收取现金/微信/支付宝
--    结清该笔，总部不再扣余额；rejected → settled 并留补付通道凭证 OFFPAY-{id}）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE member_offline_credits ADD COLUMN IF NOT EXISTS settle_channel VARCHAR(12);  -- 补付通道：现金/微信/支付宝

-- ─────────────────────────────────────────────────────────────────────────────
-- ② nonce 去重（方案 §4.9 P2 强化）：同节点同 nonce 只放行一次；
--    老请求只带 x-sync-ts 时以 ts 值兜底作 nonce（同毫秒两请求视为重放——现实请求间隔远大于 1ms）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_nonces (
  node_code VARCHAR(32)  NOT NULL,
  nonce     VARCHAR(80)  NOT NULL,
  seen_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (node_code, nonce)
);
CREATE INDEX IF NOT EXISTS idx_sync_nonces_seen ON sync_nonces (seen_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 逐批明细链（方案 §4.2 P2 补齐）：sale_order 上行带 batches（goodsNo/batchNo/qty/unitCost）
--    → 总部落本表；每日对账核「单级成本恒等」：Σ(qty×unit_cost) 与 sales_orders.cost_amount 偏差
--    → sync_recon_daily kind='batch'。对账专用快照，不做 batches FK（总部无门店批次主档）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_sale_batches (
  id         BIGSERIAL PRIMARY KEY,
  store_id   BIGINT       NOT NULL,
  order_no   VARCHAR(32)  NOT NULL,
  goods_no   VARCHAR(32)  NOT NULL,
  batch_no   VARCHAR(48)  NOT NULL,
  qty        NUMERIC(12,3) NOT NULL DEFAULT 0,
  unit_cost  NUMERIC(12,4) NOT NULL DEFAULT 0,
  idem_key   VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_ssb_idem UNIQUE (idem_key)
);
CREATE INDEX IF NOT EXISTS idx_ssb_store_day ON sync_sale_batches (store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ssb_order ON sync_sale_batches (order_no);

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ hq_sales_daily 物化（方案 §5.3.4）：总部三张跨店报表（store-daily/rank/compare）
--    从「实时扫 sales_orders」改为「读物化 + 推送后去抖刷新」（近实时）；
--    单店库同样建（store-daily 行为不变，只是数据源走 MV）。
--    CONCURRENTLY 要求唯一索引 → (store_id, sale_day)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hq_sales_daily AS
SELECT store_id,
       created_at::date AS sale_day,
       COUNT(*)::int    AS order_count,
       COALESCE(SUM(payable_amount),0) AS sales_total,
       COALESCE(SUM(cost_amount),0)    AS cost_total,
       COALESCE(SUM(profit_amount),0)  AS profit_total
  FROM sales_orders
 WHERE status='已完成'
 GROUP BY store_id, created_at::date;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_hq_sales_daily ON mv_hq_sales_daily (store_id, sale_day);
CREATE INDEX IF NOT EXISTS idx_mv_hq_sales_day ON mv_hq_sales_daily (sale_day);

-- 刷新（CONCURRENTLY 不锁读；失败退普通 REFRESH 兜底）
CREATE OR REPLACE FUNCTION refresh_hq_sales_daily() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hq_sales_daily;
EXCEPTION WHEN OTHERS THEN
  REFRESH MATERIALIZED VIEW mv_hq_sales_daily;
END;
$$ LANGUAGE plpgsql;
