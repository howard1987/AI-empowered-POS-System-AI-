-- ═══ 012_price_changes.sql · V4.8.15 商品调价单（录入即生效 + 留痕可追溯） ═══
-- 权限：pos.price.manual（复用收银"手工改价"权限点）
CREATE TABLE IF NOT EXISTS price_changes (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL DEFAULT 1,
  pc_no           VARCHAR(32) NOT NULL UNIQUE,          -- TJ-YYYYMM-XXX
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,   -- 生效日期
  remark          VARCHAR(200) NOT NULL DEFAULT '',
  item_count      INT NOT NULL DEFAULT 0,
  diff_total      NUMERIC(12,2) NOT NULL DEFAULT 0,     -- Σ(新-旧)
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_change_items (
  id           BIGSERIAL PRIMARY KEY,
  change_id    BIGINT NOT NULL REFERENCES price_changes(id),
  product_id   BIGINT NOT NULL REFERENCES products(id),
  old_price    NUMERIC(10,2) NOT NULL,
  new_price    NUMERIC(10,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_items_change ON price_change_items(change_id);
CREATE INDEX IF NOT EXISTS idx_pc_created ON price_changes(created_at);
