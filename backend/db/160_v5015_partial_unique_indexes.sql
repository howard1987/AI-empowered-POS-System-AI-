-- V5.0.15 极限测试发现：唯一索引建在全表，软删记录仍占用键值
--   现象：会员注销后同一手机号/卡号无法重新注册；商品删除后同一货号无法重新建档
--        （当前库已有 88 个软删商品持续占用货号，要重建同货号商品必然失败）
--   修复：改为 partial unique index（WHERE deleted_at IS NULL），只约束在用记录。
--   安全性：原全表唯一约束保证「在用记录」本来就唯一，故建 partial 索引不会失败；
--           索引名保持不变，代码中按名引用处不受影响。
--   注意：这 4 个是「UNIQUE 约束」（pg_constraint 支撑，pg_indexes 里也显示为索引），
--         DROP INDEX 会被 2BP01 拒绝，必须先 ALTER TABLE ... DROP CONSTRAINT。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_card_no_key;
CREATE UNIQUE INDEX members_card_no_key ON members (card_no) WHERE deleted_at IS NULL;

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_phone_key;
CREATE UNIQUE INDEX members_phone_key ON members (phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;

ALTER TABLE members DROP CONSTRAINT IF EXISTS members_wechat_openid_key;
CREATE UNIQUE INDEX members_wechat_openid_key ON members (wechat_openid) WHERE deleted_at IS NULL AND wechat_openid IS NOT NULL;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_goods_no_key;
CREATE UNIQUE INDEX products_goods_no_key ON products (goods_no) WHERE deleted_at IS NULL;
