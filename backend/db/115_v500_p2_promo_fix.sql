-- ═══════════════════════════════════════════════════════════════
-- V5.0.0 P2-5 连锁促销投放（迁移 115，修正 114）
--   部分唯一索引（WHERE NOT NULL）不能作为 ON CONFLICT (hq_promo_id) 的推断依据
--   → 换普通唯一索引：PG 默认 NULLS DISTINCT，多个 NULL（门店自建促销）互不冲突，
--     投流行（hq_promo_id 非 NULL）保持唯一 → upsertRow 的 ON CONFLICT 可用
--   幂等：可重复执行
-- ═══════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS uq_promotions_hq_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_hq_id ON promotions (hq_promo_id);
