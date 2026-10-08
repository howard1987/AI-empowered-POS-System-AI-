-- V5.0.16：分红台账枚举补值「冲回」「冲减」
--   缺陷：refund.module.ts / member-chain.module.ts 已在写 record_type='冲回'/'冲减'，
--   但 dividend_record_t 枚举里没有这两个值 → 退款/连锁回补时会抛 invalid input value for enum。
--   用 PG 原生 ADD VALUE IF NOT EXISTS（不写 PL/pgSQL 块，迁移执行器按分号拆句安全）。
--   注意：ALTER TYPE ... ADD VALUE 不能在同一事务里立即使用新值，本文件仅做加值、不使用。
ALTER TYPE dividend_record_t ADD VALUE IF NOT EXISTS '冲回';
ALTER TYPE dividend_record_t ADD VALUE IF NOT EXISTS '冲减';