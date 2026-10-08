-- V5.0.17：修正「按分类退货时限」设置项的页签归属（V5.0.16 归位时改错了页签）
--   根因：设置屏页签按 system_settings.group_name 生成，页签内卡片再按 settings.js 的
--         SECTIONS[group].prefixes 划分。迁移 166 把 group_name 设为 '收银台'，
--         但 'sales.refund.*' 前缀不在 SECTIONS['收银台'] 的任何卡片里 → 落到「其他」卡片；
--         而管理员是在「通用设置」页签找「退货时限（天）」的邻居，故完全看不到。
--   修正：与 sales.refund.window_days / sales.refund.limit 同组（通用设置），
--         前缀 'sales.refund' 命中「收银与小票钱箱」卡片，与「退货时限（天）」并列显示。
UPDATE system_settings
   SET group_name = '通用设置'
 WHERE setting_key = 'sales.refund.window_by_category'
   AND group_name <> '通用设置';