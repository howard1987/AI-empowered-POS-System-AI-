-- ═══ V4.18.0 P14 收银台专项（079）═══
--  ① products.min_price：最低售价（改价/行折低于它服务端硬拦；高权限 pos.price.manual 放行并留痕）
--  ② 设置种子：收银台设置组（回退开关 / 快捷格数量 / 库存硬拦 / 锁屏超时 / 防抖开关）
-- 幂等防线：ADD COLUMN IF NOT EXISTS / NOT EXISTS 种子

-- ── ① 最低售价 ──
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_price NUMERIC(10,2);
-- 回填：未维护的按零售价 6 成向下取分（仅未删除商品；手工改价校验空值时同样回退该口径）
UPDATE products
   SET min_price = FLOOR(COALESCE(sell_price, 0) * 0.6 * 100) / 100
 WHERE min_price IS NULL AND deleted_at IS NULL;

COMMENT ON COLUMN products.min_price IS '最低售价（V4.18.0）：手工改价/行折低于它服务端硬拦，pos.price.manual 放行留痕；NULL 按 sell_price*0.6 兜底';

-- ── ② 收银台设置组（system_settings，底层同键；后台设置页/收银设置面板同源可改）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.new_ui', '新版收银台开关', '1'::jsonb, '1'::jsonb, 'number',
       '1=登录直落新收银台；0=回退旧版「作业-收银」视图（严重问题一键回退预案）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.new_ui');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.quick_count', '快捷格数量', '8'::jsonb, '8'::jsonb, 'number',
       '收银台快捷商品格数量（8~12）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.quick_count');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.stock_hard', '库存硬拦', '0'::jsonb, '0'::jsonb, 'number',
       '0=账实不符时确认后按负库存售卖（留痕进负库存清单）；1=超库存一律拒绝（谨慎型门店）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.stock_hard');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.lock_timeout', '锁屏闲置超时(分钟)', '5'::jsonb, '5'::jsonb, 'number',
       '收银台无操作自动锁屏时间（1~30 分钟，0=不自动锁）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.lock_timeout');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.debounce', '重复扫防抖', '1'::jsonb, '1'::jsonb, 'number',
       '1=同码 2 秒内连扫不重复加件（弹条可撤销）；0=关闭防抖'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.debounce');

-- ── ③ 负库存售卖默认开启（§13.10 账实容错：收银不丢单，差异留痕进负库存清单）──
-- 仅补默认：门店此前已显式设置过则尊重原值
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银与库存', 'stock.negative_sales', '允许负库存销售', '1'::jsonb, '1'::jsonb, 'number',
       '1=库存不足时允许按负库存售卖（FIFO 差额挂末位批次并留痕，供盘点校正）；0=库存不足拒绝售卖'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='stock.negative_sales');

