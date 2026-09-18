-- 019 员工移动端二期（M15）：配货拣货 + 配送码核销
-- 呼应 6.11 拣货单（扫码校验→缺货登记→打包完成）与 V4.2 配送核销（核销人/时间/签收照片）
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS

-- 拣货状态（待拣货 → 拣货中 → 已拣货 / 缺货）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS picking_status VARCHAR(8) DEFAULT '待拣货';
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS picked_by BIGINT REFERENCES employees(id);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ;

-- 配送核销（核销人 / 签收照片）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS code_verified_by BIGINT REFERENCES employees(id);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS delivery_photo VARCHAR(256);

-- 拣货缺货登记（移动端留痕：缺货商品/数量/原因）
CREATE TABLE IF NOT EXISTS picking_shortages (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  qty        NUMERIC(12,3) NOT NULL,
  reason     VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pick_short_order ON picking_shortages (order_id);
