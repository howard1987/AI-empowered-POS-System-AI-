-- P-01：原子发号计数器表（替代 seqLock 的全局事务级 advisory 锁 + 每笔 LIKE count(*)+1）
-- 由 backend/src/common/db.ts 的 seqLock 使用：首次见到某 (table,col,pattern) 时按其表内匹配行数初始化，
-- 之后纯 O(1) 自增（INSERT … ON CONFLICT DO UPDATE），消除高并发取号串行化与慢前缀扫描。
CREATE TABLE IF NOT EXISTS doc_seq (
  k   TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);
