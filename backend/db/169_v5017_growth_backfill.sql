-- V5.0.17：从历史数据回填成长值（让「立即按新规则重算等级」有数据基础）
--   充值：recharge_orders 已入账本金 × 充值倍率（赠送 gift 不计）
--   消费：sale_payments 中现金/微信/支付宝 实付 × 消费倍率
--         （余额/分红抵扣/积分抵扣天然被排除；券抵扣已在 payable 中扣除，不在实付内 → 只算顾客实掏的钱）
--   注意：历史订单无法还原「排除商品/特价」标记（当时无该配置），故历史部分不按商品排除。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。

-- ① 历史充值成长值
INSERT INTO member_growth_records
  (store_id, member_id, direction, growth_value, base_amount, rate, biz_type, ref_type, ref_id, remark, created_at)
SELECT r.store_id, r.member_id, '加',
       ROUND(r.principal * (SELECT COALESCE(MAX(NULLIF(value #>> '{}','')::numeric),1) FROM system_settings
                             WHERE setting_key = 'member.growth.recharge_rate'), 2),
       r.principal, 1, '充值', 'recharge_order', r.id, '历史充值回填', r.created_at
  FROM recharge_orders r
 WHERE r.status = '已入账' AND r.member_id IS NOT NULL AND r.principal > 0;

-- ② 历史消费成长值（仅现金/微信/支付宝实付部分）
INSERT INTO member_growth_records
  (store_id, member_id, direction, growth_value, base_amount, rate, biz_type, ref_type, ref_id, remark, created_at)
SELECT p.store_id, p.member_id, '加',
       ROUND(p.cash_paid * (SELECT COALESCE(MAX(NULLIF(value #>> '{}','')::numeric),0.8) FROM system_settings
                             WHERE setting_key = 'member.growth.consume_rate'), 2),
       p.cash_paid, 0.8, '消费', 'sale', p.order_id, '历史消费回填', p.created_at
  FROM (
        SELECT o.id AS order_id, o.store_id, o.member_id, o.created_at,
               COALESCE(SUM(sp.amount) FILTER (WHERE sp.channel::text IN ('现金','微信','支付宝')), 0) AS cash_paid
          FROM sales_orders o
          JOIN sale_payments sp ON sp.order_id = o.id
         WHERE o.member_id IS NOT NULL
           AND o.status = '已完成'
         GROUP BY o.id, o.store_id, o.member_id, o.created_at
       ) p
 WHERE p.cash_paid > 0;

-- ③ 汇总冗余字段 members.growth_total（升级判定用）
UPDATE members m
   SET growth_total = COALESCE(g.s, 0)
  FROM (SELECT member_id, SUM(CASE WHEN direction = '加' THEN growth_value ELSE -growth_value END) AS s
          FROM member_growth_records GROUP BY member_id) g
 WHERE m.id = g.member_id;