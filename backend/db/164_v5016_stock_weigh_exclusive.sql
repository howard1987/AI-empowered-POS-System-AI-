-- V5.0.16：商品属性「记库存」与「称重」改为互斥二选一
--   历史数据中可能存在 track_inventory=true 且 is_weighted=true 的冲突档案（下游是否入库/是否传秤/盘点口径判定冲突）。
--   按业务优先级保留「记库存」（绝大多数商品都需记库存，称重是特殊子类），将冲突项的「称重」置为 false。
--   说明：此前 products.update 未更新这两个字段，UI 无法制造冲突，冲突数据极少；本迁移做存量兜底清理。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。
UPDATE products
   SET is_weighted = false
 WHERE track_inventory = true
   AND is_weighted = true;