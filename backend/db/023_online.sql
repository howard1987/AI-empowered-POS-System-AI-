-- ═══════════════════════════════════════════════════════════════
-- 023_online.sql（在线业务·方向4）：在线商城 + 配送/自提/外卖
--   1) products.online_visible：商品是否上架商城（店控开关，默认上架）
--   2) sales_orders 扩展：配送费/收货快照/配送中时间/取消留痕
--   3) 配送参数（运费/免邮门槛/配送半径/开通开关）+ 门店中心坐标（围栏校验用）
--   4) 启用 member_addresses（会员收货地址簿，此前为零引用表）
--   幂等：ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE products ADD COLUMN IF NOT EXISTS online_visible BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS delivery_fee     NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS receiver         VARCHAR(32);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS receiver_phone   VARCHAR(20);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS receiver_address VARCHAR(128);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS dispatched_at    TIMESTAMPTZ;   -- 配送装车出发时间（拣货完成自动置位）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ;   -- 线上订单取消（顾客自助）留痕
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS cancel_reason    VARCHAR(128);

-- 配送参数（线上渠道组；value_type 与 default_value 对齐）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('线上渠道', 'delivery.serving',     '开通在线配送',   '1',    '1',    'number', '1=开通（配送/外卖）；0=仅自提'),
  ('线上渠道', 'delivery.fee',         '配送费(元)',     '3',    '3',    'number', '未达免邮门槛时收取'),
  ('线上渠道', 'delivery.free_above',  '免配送费门槛(元)','50',  '50',    'number', '订单应付 ≥ 该值免配送费'),
  ('线上渠道', 'delivery.radius_km',   '配送半径(km)',   '0',    '0',    'number', '0=不限；>0 时超出配送围栏拒绝配送（需门店坐标）'),
  ('线上渠道', 'store.lat',            '门店纬度',       '0',    '0',    'number', '配送围栏圆心纬度（delivery.radius_km>0 时生效）'),
  ('线上渠道', 'store.lng',            '门店经度',       '0',    '0',    'number', '配送围栏圆心经度（delivery.radius_km>0 时生效）')
ON CONFLICT (setting_key) DO NOTHING;
