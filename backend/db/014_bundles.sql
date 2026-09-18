-- ═══ 014_bundles.sql · V4.8.17 组合拆分（组合商品组装/拆分，FIFO 守恒） ═══
-- 权限：stock.transfer（库存形态转移）

-- 组合商品档案（BOM：1 份组合 = Σ 子商品×数量；bundle_product_id 本身建档为普通商品，可直接销售）
CREATE TABLE IF NOT EXISTS product_bundles (
  id                BIGSERIAL PRIMARY KEY,
  store_id          BIGINT NOT NULL DEFAULT 1,
  bundle_product_id BIGINT NOT NULL UNIQUE REFERENCES products(id),  -- 组合商品（唯一组合定义）
  name              VARCHAR(64) NOT NULL,
  status            SMALLINT NOT NULL DEFAULT 1,                     -- 1启用 0停用
  remark            VARCHAR(128) NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 组合明细（子商品×数量；qty 支持 0.5 等散货数量）
CREATE TABLE IF NOT EXISTS product_bundle_items (
  id         BIGSERIAL PRIMARY KEY,
  bundle_id  BIGINT NOT NULL REFERENCES product_bundles(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  qty        NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  UNIQUE (bundle_id, product_id)
);

-- 组装/拆分单（录入即生效：ZZ-组装 / CF-拆分；成本 FIFO 守恒）
CREATE TABLE IF NOT EXISTS bundle_ops (
  id                BIGSERIAL PRIMARY KEY,
  store_id          BIGINT NOT NULL DEFAULT 1,
  op_no             VARCHAR(32) NOT NULL UNIQUE,       -- ZZ-YYYYMM-XXX / CF-YYYYMM-XXX
  op_type           VARCHAR(8)  NOT NULL,              -- 'assemble' | 'split'
  bundle_product_id BIGINT NOT NULL REFERENCES products(id),
  qty               NUMERIC(12,3) NOT NULL,            -- 组装/拆分组合份数
  unit_cost         NUMERIC(12,4) NOT NULL,            -- 单位成本：组装=Σ子批次成本/qty；拆分=组合批次单价
  total_cost        NUMERIC(12,2) NOT NULL,
  remark            VARCHAR(200) NOT NULL DEFAULT '',
  created_by        BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 组装/拆分明细（组装：子商品出库 qty 负方向由 op_type 表达，此处记业务数量）
CREATE TABLE IF NOT EXISTS bundle_op_items (
  id         BIGSERIAL PRIMARY KEY,
  op_id      BIGINT NOT NULL REFERENCES bundle_ops(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  qty        NUMERIC(12,3) NOT NULL,                 -- 子商品业务数量（BOM×份数）
  unit_cost  NUMERIC(12,4) NOT NULL,                 -- FIFO 摊销单位成本（拆分=u=U/Σqty 均摊）
  cost_total NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bops_created ON bundle_ops(created_at);
CREATE INDEX IF NOT EXISTS idx_bops_bundle  ON bundle_ops(bundle_product_id);
