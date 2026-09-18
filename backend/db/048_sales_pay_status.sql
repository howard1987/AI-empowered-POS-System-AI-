-- ═══════════════════════════════════════════════════════════════════════════
-- V4.13.1 · 支付状态机显式化（对比分析报告 P0-4.3 落地：CAS 状态机）
--   pay_status: unpaid 未支付 / paid 已支付 / part_refunded 部分退款 /
--               refunded 全额退款 / closed 超时关闭
--   唯一收钱迁移 unpaid→paid 必须 CAS（UPDATE ... WHERE pay_status='unpaid' 检查 rowcount），
--   由未来 pay_service（微信/支付宝商户 API 层）的 settle 函数调用；
--   存量柜台单均为即时付清 → 默认 'paid'；线上预下单单据显式置 'unpaid'。
-- 幂等：IF NOT EXISTS 全覆盖，可重复执行。
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS pay_status   text        NOT NULL DEFAULT 'paid';
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS pay_paid_at  timestamptz;

-- 存量已支付单补齐支付时间（取单据创建时间）
UPDATE sales_orders SET pay_paid_at = COALESCE(pay_paid_at, created_at)
 WHERE pay_status = 'paid' AND pay_paid_at IS NULL;

-- 未支付/异常单查询索引（部分索引，常态全 paid 不占索引体积）
CREATE INDEX IF NOT EXISTS idx_sales_orders_pay_status
  ON sales_orders (store_id, pay_status) WHERE pay_status <> 'paid';

COMMENT ON COLUMN sales_orders.pay_status IS
  '支付状态机 V4.13.1: unpaid/paid/part_refunded/refunded/closed；unpaid→paid 为唯一收钱迁移，必须 CAS（WHERE pay_status=unpaid + 金额逐分校验）';

-- 047 同批补种：对账反方向（本地有平台无）展示所需无 schema 变更，汇总走 summary JSONB
