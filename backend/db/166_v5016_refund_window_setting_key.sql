-- V5.0.16：按分类退货时限界键归位
--   缺陷：迁移 162 建的键是 refund.window_by_category，但设置屏「通用设置-收银与小票钱箱」
--   只按前缀 pos. / sales.refund 过滤分组 → 该设置根本不渲染，管理员看不到入口（等于白做）。
--   归位到 sales.refund.window_by_category，与 sales.refund.window_days 同族，自动出现在该分组。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。
UPDATE system_settings
   SET setting_key = 'sales.refund.window_by_category',
       group_name  = '收银台'
 WHERE setting_key = 'refund.window_by_category'
   AND NOT EXISTS (SELECT 1 FROM system_settings x WHERE x.setting_key = 'sales.refund.window_by_category');