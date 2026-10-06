-- V5.0.15 QA-P0 缺陷修复：退货成本回冲
--   现象：refund.module 只回补 batches.remain_qty 与 stock_flows，不回冲成本，
--         退 2 件后 sales_orders.cost_amount / sale_items.line_cost 原封不动
--         → 退货后订单毛利虚高，日报/销售明细/分红基数全部失真。
--   修复：退货执行时按「退回批次数量 × 该批次单位成本」累计，回写
--         sale_items.line_cost/line_profit 与 sales_orders.cost_amount/profit_amount，
--         并在退款单上留痕 cost_amount，便于对账与审计。
--   说明：sale_refunds 此前没有成本字段，故新增；默认 0 兼容历史退款单。
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS cost_amount numeric(12,2) NOT NULL DEFAULT 0;
