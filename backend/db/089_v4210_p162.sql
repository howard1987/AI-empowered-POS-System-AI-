-- ═══ V4.21.0 P16 批2：台位档案 / 客显配置 / 快捷键自定义 ═══
-- 1) 台位档案（堂食/休息区）：编号+区域+座位数+状态+绑定设备（副屏/收银机）
CREATE TABLE IF NOT EXISTS dining_tables (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL,
  name        VARCHAR(32) NOT NULL,               -- 台位编号（如 A01）
  area        VARCHAR(32),                        -- 区域（堂食区/休息区…可空）
  seats       INT DEFAULT 0,                      -- 座位数
  status      VARCHAR(8) NOT NULL DEFAULT '空闲',  -- 空闲/使用中/预留/停用
  device_id   BIGINT,                             -- 绑定设备（devices.id，如该台位副屏/收银机）
  note        VARCHAR(200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dining_tables_store ON dining_tables (store_id, status);
-- 销售单挂台位（堂食落单即占用；结账后台手动清台或收银台「清台」释放）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS table_id BIGINT;

-- 2) 客显（副屏）内容配置：欢迎语常驻顶栏 + 空闲轮播（活动图文/分红池公示/会员招募）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'display.welcome', '客显欢迎语', '"欢迎光临，祝您购物愉快"'::jsonb, '"欢迎光临，祝您购物愉快"'::jsonb, 'string',
       '顾客副屏顶栏常驻欢迎语（店招取「商店信息 store.info.name」）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='display.welcome');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'display.ads', '客显空闲轮播', '[{"title":"会员日全场 95 折","sub":"每周三 · 会员积分翻倍","emoji":"🎁"}]'::jsonb,
       '[{"title":"会员日全场 95 折","sub":"每周三 · 会员积分翻倍","emoji":"🎁"}]'::jsonb, 'json',
       '顾客副屏空闲轮播（JSON 数组：[{title,sub,emoji,image?}]，后台设置页可编辑）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='display.ads');

-- 3) 快捷键自定义（P16）：键位映射存收银台组，设置面板可视化编辑；EXE 端经 IPC 全局注册
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashier.hotkey_map', '收银快捷键映射', '{"pay":"F9","hold":"F2","take":"F4","repeat":"F6","print":"F7","lock":"F8"}'::jsonb,
       '{"pay":"F9","hold":"F2","take":"F4","repeat":"F6","print":"F7","lock":"F8"}'::jsonb, 'json',
       '收银台键位映射 {pay结算/hold挂单/take取单/repeat重复上一单/print打印开关/lock锁屏}；F1=键位说明固定'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashier.hotkey_map');

-- 4) 客显推送开关（默认开；只影响主屏→副屏推送，不影响交易）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.display.push', '客显推送', 'true'::jsonb, 'true'::jsonb, 'bool',
       '关闭后主屏不再向顾客副屏推送购物明细/支付引导（副屏显示等待连接）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.display.push');

-- 5) V4.19.0 遗留补种：浏览器兜底打印开关（printers.js printCfg / 收银设置保存链路均引用，缺种会致设置保存 40404 中断）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.print.browser_fallback', '浏览器兜底打印', 'true'::jsonb, 'true'::jsonb, 'bool',
       '未配置默认小票机时是否允许浏览器弹打印预览兜底；关=绝不弹预览（V4.19.0 静默打印收口开关）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.print.browser_fallback');
