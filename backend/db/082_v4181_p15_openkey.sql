-- ═══ V4.18.1 P15 批1（082）：开放键临时行 + 占位商品 ═══
--  开放键：无码杂货手输 品名+价格+备注 进临时行（不建档案不碰库存）
--  方案：sale_items 加 custom_name（可空，展示 COALESCE(custom_name, p.name)）；
--        每店一个占位商品（barcode='OPENKEY'，track_inventory=false，售 0 元）——
--        product_id 保持 NOT NULL，既有报表/退货/对账 JOIN 零破坏，开放键营收归「开放键临时行」

-- ── ① 临时行品名列 ──
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS custom_name VARCHAR(100);
COMMENT ON COLUMN sale_items.custom_name IS '开放键临时行品名（V4.18.1 P15）：非空时前端展示优先于 products.name';

-- ── ② 每店占位商品（幂等）──
INSERT INTO products (store_id, category_id, goods_no, name, barcode, sell_price, member_price, member_discount,
                      base_unit, track_inventory, status, min_price, spec)
SELECT s.id, NULL, 'OPENKEY-' || s.id, '开放键临时行', 'OPENKEY', 0, NULL, NULL, '件', false, 1, 0, NULL
  FROM stores s
 WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.store_id = s.id AND p.barcode = 'OPENKEY' AND p.deleted_at IS NULL);
