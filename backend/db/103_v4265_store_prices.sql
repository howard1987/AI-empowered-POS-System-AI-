-- ═══ 103_v4265_store_prices.sql · V4.26.5 门店覆盖价：真正「按门店隔离价格」 ═══
-- 背景更正：102 注释里写「products 表为全局（无 store_id）」有误 —— products 实际带 store_id
--           （001_init.sql:270），但 goods_no 为全局唯一，多店共用同一商品档案行，
--           因此「同一商品在不同门店卖不同价」无法用 products 单表表达，必须走覆盖表。
--
-- 设计（读价一律 COALESCE 兜底，无覆盖行 = 用商品基线价 → 单店部署零回归）：
--   ① 整体调价（apply_scope='all'）：改 products 基线价 + 清空该商品全部门店覆盖行 → 全门店生效
--   ② 本地门店调价（apply_scope='local'）：不动基线，仅 upsert 本行 → 只该门店生效
--   ③ 商品档案直接改价：等同改基线，同时清空该商品门店覆盖行（避免「改了价不生效」的隐形优先级坑）
--
-- 覆盖价优先级：product_store_prices.sell_price > products.sell_price
--               成员价同理：product_store_prices.member_price > products.member_price

CREATE TABLE IF NOT EXISTS product_store_prices (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id    BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sell_price    NUMERIC(12,2),                          -- 门店零售价（NULL=沿用基线）
  member_price  NUMERIC(12,2),                          -- 门店会员价（NULL=沿用基线）
  source_pc_id  BIGINT,                                 -- 来源调价单 id（可追溯）
  source_pc_no  VARCHAR(32),                            -- 来源调价单号
  remark        VARCHAR(128),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_psp_store   ON product_store_prices (store_id);
CREATE INDEX IF NOT EXISTS idx_psp_product ON product_store_prices (product_id);

COMMENT ON TABLE  product_store_prices             IS '门店覆盖价（V4.26.5）：只存与 products 基线价不同的门店；读取按 COALESCE(门店价, 基线价) 兜底';
COMMENT ON COLUMN product_store_prices.sell_price   IS '门店零售价；NULL 表示该门店沿用商品基线价';
COMMENT ON COLUMN product_store_prices.member_price IS '门店会员价；NULL 表示沿用基线会员价';
COMMENT ON COLUMN product_store_prices.source_pc_id IS '来源调价单 id（本地门店调价单审核后写入，可追溯）';

-- 一致性基线：已存在的门店 × 商品不预生成覆盖行（NULL 语义即沿用基线），保持表轻量。
