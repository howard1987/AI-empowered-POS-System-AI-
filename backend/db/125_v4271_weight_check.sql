-- 101 · V4.27.1 生鲜称重复核：商品单件重量期望区间（视觉/扫码 ↔ 称重 双校验）
-- 语义：单件/单份净重区间（克）。称重链路（条码秤码解析 kg / 串口秤读重）拿到重量后调
--       POST /ai/weight-check 比对，越界前端提示复核。NULL = 不设限（非生鲜/未维护商品不校验）。
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_min_g NUMERIC(10, 1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_max_g NUMERIC(10, 1);
COMMENT ON COLUMN products.weight_min_g IS '单件重量期望下限（克，生鲜称重复核用，NULL=不校验）';
COMMENT ON COLUMN products.weight_max_g IS '单件重量期望上限（克，生鲜称重复核用，NULL=不校验）';
