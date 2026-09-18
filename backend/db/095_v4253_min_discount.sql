-- ═══ V4.25.3 商品最低折扣 + 收银端改价/单品折扣红线（095）═══
-- 背景（老板明确需求）：
--   ① 收银端：商品改价 + 单品折扣 + 整单折扣 都要有快捷键与功能；
--   ② 后台商品档案可设「最低卖价」（min_price 已有，本次仅补前端入口）与「最低折扣」；
--   ③ 收银员可改价/打折，但不得低于最低卖价、不得低于最低折扣。
-- 本文件：新增 products.min_discount_rate。幂等，可重复执行。

-- ── 商品最低折扣率（百分数：80 = 最低 8 折；100 = 不允许打折；NULL = 不限制，仅受最低卖价约束）──
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_discount_rate NUMERIC(5,2);

COMMENT ON COLUMN products.min_discount_rate IS
  '最低折扣率（V4.25.3）：80=最低8折，100=不允许打折，NULL=不限制；收银端单品/整单折扣折后价低于 sell_price*min_discount_rate/100 时服务端硬拦，店长 pos.emergency.manual 放行留痕';

-- 索引：收银端取商品时按 id 命中主键即可，无需额外索引（本列仅随行读取）
