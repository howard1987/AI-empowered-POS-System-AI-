-- ═══════════════════════════════════════════════════════════════
-- V5.0.0 P2-5 连锁促销投放（迁移 114）
--   promotions.hq_promo_id：总部投放的源促销 id（幂等键）
--   · 总部库：投放创建时写自己的 id（总部自建促销 hq_promo_id 可为 NULL，不参与下行）
--   · 门店库：下行落地时写 = 总部促销 id，部分唯一索引保证重复 pull 幂等
--   · 用部分唯一索引（WHERE NOT NULL）而非普通 UNIQUE：门店自建促销行该列全 NULL 不受限
--   幂等：可重复执行
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE promotions ADD COLUMN IF NOT EXISTS hq_promo_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_hq_id
  ON promotions (hq_promo_id) WHERE hq_promo_id IS NOT NULL;
