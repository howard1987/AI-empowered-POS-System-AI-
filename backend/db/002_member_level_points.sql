-- ═══════════════════════════════════════════════════════════════════════════
-- 002 会员等级/积分/口径B 本金赠送拆分（T9 剩余 + T10，方案 5.1.2 / 5.1.12 / 5.3）
-- 规范：禁改 001 基线；本文件幂等，可重复执行
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) 会员等级：新增分红系数 c（5.1.7 W = 有效本金 B × 等级系数 c；5.1.12 等级表）
--    upgrade_score 兼作储值余额升级门槛（余额 ≥ upgrade_score 即达该档）
ALTER TABLE member_levels ADD COLUMN IF NOT EXISTS dividend_coeff NUMERIC(8,4) NOT NULL DEFAULT 1.0;

INSERT INTO member_levels (name, sort_no, upgrade_score, discount, point_rate, dividend_coeff, perks)
SELECT '普通会员', 1, 0,    0.98, 1.0, 1.0, '{"折扣":"9.8折","积分倍率":1.0,"分红系数":1.0}'
WHERE NOT EXISTS (SELECT 1 FROM member_levels WHERE name='普通会员');

INSERT INTO member_levels (name, sort_no, upgrade_score, discount, point_rate, dividend_coeff, perks)
SELECT '银卡会员', 2, 1000, 0.95, 1.5, 1.2, '{"折扣":"9.5折","积分倍率":1.5,"分红系数":1.2}'
WHERE NOT EXISTS (SELECT 1 FROM member_levels WHERE name='银卡会员');

INSERT INTO member_levels (name, sort_no, upgrade_score, discount, point_rate, dividend_coeff, perks)
SELECT '金卡会员', 3, 5000, 0.90, 2.0, 1.5, '{"折扣":"9折","积分倍率":2.0,"分红系数":1.5}'
WHERE NOT EXISTS (SELECT 1 FROM member_levels WHERE name='金卡会员');

-- 2) 会员降级宽限跟踪（5.1.12：升级立即生效；连续 N 天低于阈值才降级，避免等级跳动）
ALTER TABLE members ADD COLUMN IF NOT EXISTS level_below_since DATE;      -- 低于当前档阈值的首日
ALTER TABLE members ADD COLUMN IF NOT EXISTS level_synced_at TIMESTAMPTZ; -- 最近一次等级同步时间

-- 3) 口径B：资产账户本金/赠送双余额（5.1.2 消费按比例拆分记账；分红权重只按本金）
ALTER TABLE member_accounts ADD COLUMN IF NOT EXISTS principal_balance NUMERIC(12,2) NOT NULL DEFAULT 0; -- 本金余额
ALTER TABLE member_accounts ADD COLUMN IF NOT EXISTS gift_balance     NUMERIC(12,2) NOT NULL DEFAULT 0; -- 赠送余额
-- 存量回填：启用拆分前的历史余额全部视为本金（此前只有本金充值入口）
UPDATE member_accounts SET principal_balance = principal_total
 WHERE principal_balance = 0 AND principal_total > 0;

-- 4) 等级变更日志（5.1.12：会员端可查历史）
CREATE TABLE IF NOT EXISTS member_level_log (
  id            BIGSERIAL PRIMARY KEY,
  member_id     BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  from_level_id BIGINT,
  to_level_id   BIGINT NOT NULL,
  reason        VARCHAR(32) NOT NULL,                 -- 初始化/升级/降级(宽限N天)
  operator_id   BIGINT,                               -- 手动同步时的操作员；系统自动为 NULL
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mlvl_log_member ON member_level_log (member_id, created_at DESC);

-- 5) 收银支付方式：新增「积分抵扣」（5.3 积分抵现；分红/积分支付不计有效消费 5.1.16）
ALTER TYPE pay_channel_t ADD VALUE IF NOT EXISTS '积分抵扣';
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS points_flow_id BIGINT REFERENCES points_flows(id);

-- 6) 新增设置项（管理员可改，与 40 项种子同结构）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('分红与会员','member.level_discount','会员等级折扣开关','0','0','number','1=按等级折扣计价（商品会员价优先于等级折扣）；0=关闭'),
('分红与会员','member.level_grace_days','等级降级宽限天数','7','7','number','连续 N 天低于档位阈值才降级（5.1.12）'),
('分红与会员','points.redeem_rate','积分抵现比例','100','100','number','多少积分抵 1 元，收银「积分抵扣」用')
ON CONFLICT (setting_key) DO NOTHING;
