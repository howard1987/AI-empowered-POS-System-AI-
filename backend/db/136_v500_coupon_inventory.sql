-- ═══ 136: 购物券库存闭环（生成入库 → 发放出库 → 核销出库 → 报表可追溯） ═══
-- 执行方式：init-db.ts 按文件名排序顺序执行；幂等（IF NOT EXISTS / 已记账跳过）
-- 设计依据：购物券=一次性库存商品；coupons 为券商品主档(大类码)，member_coupons 为会员持有实例(小码)
--   库存漏斗恒等式：total_qty = 在库未发 + 会员持有 + 已核销 + 已过期 + 已作废
--   可用库存 stock = total_qty − 已核销 − 已过期 − 已作废
--   规则：创建=入库总量；发放=内部调拨(可用库存不变，仅转移在库→会员持有)；核销/过期=不可逆出库减库存；
--        退货不碰券(券恒为已使用)；已作废仅商家召回未使用券(退库+1)

-- 1) coupons 增加大类码（营销活动精确匹配键，按门店唯一；空=自动生成 CP+序号）
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS code VARCHAR(32);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_code ON coupons (store_id, code) WHERE code IS NOT NULL;

-- 2) member_coupons 发放/来源留痕
ALTER TABLE member_coupons ADD COLUMN IF NOT EXISTS operator_id BIGINT;        -- 发放经手人(员工id)
ALTER TABLE member_coupons ADD COLUMN IF NOT EXISTS issue_source VARCHAR(16) NOT NULL DEFAULT '手动';
--   status 现有：未使用/已使用/已过期；新增 已作废（商家召回未使用券，退库回可用库存）

-- 3) 券出入库流水（对标商品 stock_flows，全链路可查）
CREATE TABLE IF NOT EXISTS coupon_stock_log (
  id               BIGSERIAL PRIMARY KEY,
  store_id         BIGINT NOT NULL,
  coupon_id        BIGINT NOT NULL REFERENCES coupons(id),                    -- 券商品(大类型)
  member_coupon_id BIGINT REFERENCES member_coupons(id),                      -- 券实例(个人小码)，入库行为可空
  move_type        VARCHAR(12) NOT NULL,   -- 入库/发放出库/核销出库/过期出库/退库
  qty              INT NOT NULL,           -- 可用库存变动：入库+/核销-/过期-/退库+；发放出库=0(仅调拨记录)
  member_id        BIGINT,                 -- 领取/使用的会员
  operator_id      BIGINT,                 -- 经手人/收银员
  related_doc_no   VARCHAR(64),            -- 关联单据号(订单号/发券批次号/活动号)
  stock_after      INT,                    -- 变动后可用库存(对账用)
  remark           VARCHAR(128),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cplog_coupon ON coupon_stock_log (coupon_id);
CREATE INDEX IF NOT EXISTS idx_cplog_mc    ON coupon_stock_log (member_coupon_id);
CREATE INDEX IF NOT EXISTS idx_cplog_doc   ON coupon_stock_log (related_doc_no);
CREATE INDEX IF NOT EXISTS idx_cplog_time  ON coupon_stock_log (created_at);

-- 4) sales_orders 支持一单多券核销留痕（coupon_id 保留首张兼容，coupon_ids 记全部）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS coupon_ids JSONB;
