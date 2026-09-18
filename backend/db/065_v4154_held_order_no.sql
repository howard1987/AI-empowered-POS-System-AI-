-- V4.15.4：挂单单据号（GD+日期-4位序号），供挂单列表查询/展示/详情弹窗
-- 幂等：列存在即跳过；历史行回填一次；唯一索引防重

ALTER TABLE held_orders ADD COLUMN IF NOT EXISTS order_no varchar(24);

UPDATE held_orders
   SET order_no = 'GD' || to_char(created_at, 'YYYYMMDD') || '-' || lpad(id::text, 4, '0')
 WHERE order_no IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uk_held_orders_order_no ON held_orders(order_no) WHERE order_no IS NOT NULL;

COMMENT ON COLUMN held_orders.order_no IS '挂单单据号：GD+yyyymmdd-4位序号（V4.15.4）';
