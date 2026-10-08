-- V5.0.18：mv_hq_sales_daily 归属口径统一为「支付完成时间」
--   与日结快照/分红/报表/AI 同批改造（sales.jobs.ts 等 58 行），业务日 = COALESCE(pay_paid_at, created_at)。
--   MV 不支持 CREATE OR REPLACE，重建（物化数据由下方 REFRESH 重算；存量 pay_paid_at 已在 048 回填=created_at，
--   故历史数值不变，仅未来跨日支付单归到支付完成日）。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。
DROP MATERIALIZED VIEW IF EXISTS mv_hq_sales_daily;
CREATE MATERIALIZED VIEW mv_hq_sales_daily AS
SELECT store_id,
       COALESCE(pay_paid_at, created_at)::date AS sale_day,
       COUNT(*)::int    AS order_count,
       COALESCE(SUM(payable_amount),0) AS sales_total,
       COALESCE(SUM(cost_amount),0)    AS cost_total,
       COALESCE(SUM(profit_amount),0)  AS profit_total
  FROM sales_orders
 WHERE status='已完成'
 GROUP BY store_id, COALESCE(pay_paid_at, created_at)::date;
CREATE UNIQUE INDEX uq_mv_hq_sales_daily ON mv_hq_sales_daily (store_id, sale_day);
CREATE INDEX idx_mv_hq_sales_day ON mv_hq_sales_daily (sale_day);
REFRESH MATERIALIZED VIEW mv_hq_sales_daily;