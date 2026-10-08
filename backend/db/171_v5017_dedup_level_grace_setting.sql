-- V5.0.17：消除「等级宽限期」重复设置项
--   根因：历史 key 为 member.level_grace_days（下划线），迁移 168 又误插入了一个
--         member.level.grace_days（点号），二者语义完全相同 → 设置页出现两个相似项，
--         且改其中一个不影响读另一个（引擎读点号、历史逻辑读下划线）。
--   处理：以历史 key（下划线）为准（兼容既有引用），删除误插入的点号 key。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。
DELETE FROM system_settings WHERE setting_key = 'member.level.grace_days';