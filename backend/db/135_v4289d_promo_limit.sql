-- V4.28.9d 促销活动数量约束：
--   1) member_coupons 增加 promo_id —— 「消费后奖励-发券」活动与所发券建立关联，
--      活动总发放次数 / 单会员参与次数才有统一统计口径（历史行 NULL 不计入）。
--   2) 活动约束存于 promotions.rules JSONB（totalLimit / perMemberLimit / couponQty），无需建列。
ALTER TABLE member_coupons ADD COLUMN IF NOT EXISTS promo_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_mcoupon_promo ON member_coupons (promo_id) WHERE promo_id IS NOT NULL;
