-- ─────────────────────────────────────────────────────────────────────────────
-- 141 · V5.0.2 连锁大客户/促销/设置 组合迁移
--  ① sales_orders.customer_name：大客户团购单下单时快照客户名——此后客户改名不影响历史业务数据展示
--  ② big_customer_payments.kind：区分 recharge（预充值）/collect（赊账回款），存量按 remark 回填
--  ③ promotions.is_stackable：单活动「是否叠加」开关（结算叠加全局策略仍由 promo.stack_layers 主导）
--  ④ 系统设置组归并：group_name='营销' → '营销与线上'（老板反馈十四）
-- 幂等；禁改 001~139 已应用迁移。
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(64);

ALTER TABLE big_customer_payments ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'collect';
UPDATE big_customer_payments SET kind='recharge' WHERE remark = '预充值' AND kind = 'collect';

ALTER TABLE promotions ADD COLUMN IF NOT EXISTS is_stackable BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN promotions.is_stackable IS '是否叠加：true=可与其它促销叠加；false=排他（结算取最优单活动）';

UPDATE system_settings SET group_name = '营销与线上' WHERE group_name = '营销';
