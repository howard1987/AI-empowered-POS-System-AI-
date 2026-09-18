-- V4.9.11 建档条码大数据自动填充：系统设置项（幂等；输码/扫码 → 本店库 → mxnzp → Open Food Facts 预填，可改）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '商品与库存', 'barcode.lookup.enable', '建档条码库自动查询', 'true', 'true', 'bool',
       '输码/扫码后自动查询本店库与在线条码库，预填商品名称/规格/单位/预估售价（只填空位不覆盖，均可修改）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'barcode.lookup.enable');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '商品与库存', 'barcode.lookup.mxnzp.app_id', '条码库mxnzp app_id', '""', '""', 'string',
       '国内条码库 https://www.mxnzp.com 免费自助申请；留空则跳过该数据源'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'barcode.lookup.mxnzp.app_id');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '商品与库存', 'barcode.lookup.mxnzp.app_secret', '条码库mxnzp app_secret', '""', '""', 'string',
       '与 app_id 配套；Open Food Facts 免 key 始终兜底'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'barcode.lookup.mxnzp.app_secret');
