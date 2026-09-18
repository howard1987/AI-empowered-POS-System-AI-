-- 101_v4265_scale_enum.sql
-- V4.26.5 · 传秤工具（生鲜管理）多选项改为下拉选择，不再让用户手填
--   scale.tx.protocol / scale.tx.port_type / scale.tx.charset 由 string → enum，并补齐 enum_options
--   （use_member_price 本就是 bool，渲染为开关，无需处理）
-- 幂等：可重复执行
-- =====================================================================

UPDATE system_settings
SET value_type = 'enum',
    enum_options = '[{"v":"dahua","label":"大华"},{"v":"topping","label":"顶尖"},{"v":"digi","label":"寺冈 DIGI"},{"v":"mettler","label":"托利多"},{"v":"cas","label":"凯士 CAS"},{"v":"generic","label":"通用/测试"}]'::jsonb,
    remark = '默认协议品牌（下拉选择）'
WHERE setting_key = 'scale.tx.protocol' AND value_type <> 'enum';

UPDATE system_settings
SET value_type = 'enum',
    enum_options = '[{"v":"serial","label":"串口 RS232"},{"v":"tcp","label":"网口 TCP"}]'::jsonb,
    remark = '默认连接方式（下拉选择）'
WHERE setting_key = 'scale.tx.port_type' AND value_type <> 'enum';

UPDATE system_settings
SET value_type = 'enum',
    enum_options = '[{"v":"gbk","label":"GBK · 中文标签秤通用（推荐）"},{"v":"gb2312","label":"GB2312 · 老国标"},{"v":"ascii","label":"ASCII · 仅英文（老秤）"}]'::jsonb,
    remark = '秤端编码（下拉选择，中文标签秤通用 GBK）'
WHERE setting_key = 'scale.tx.charset' AND value_type <> 'enum';
