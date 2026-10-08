-- V5.0.17：会员等级重设计 —— 成长值体系（累计充值 + 实付消费 → 三档等级 + 周期考核 + 保级缓冲）
--   现状问题：等级按「储值本金余额」判定（members.module syncMemberLevel），本金花掉就降级，
--             且无自动考核（只能管理员手动 sync），与「消费越多等级越高」的经营诉求不符。
--   新口径：成长值 = 累计实付充值本金×充值倍率 + 直接买单实付消费金额×消费倍率；余额消费/券抵扣/
--             赠送补贴/指定排除商品不计；等级按成长值判定，滚动 6 个月考核 + 30 天保级缓冲。
--
-- ① 成长值流水（近 6 个月成长值靠它滚动汇总，必须留痕）
CREATE TABLE IF NOT EXISTS member_growth_records (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL DEFAULT 1,
  member_id    BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  direction    VARCHAR(4)  NOT NULL,                     -- 加 / 减
  growth_value NUMERIC(12,2) NOT NULL,                   -- 成长值（正数；方向由 direction 表达）
  base_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,         -- 基础金额（充值本金 / 消费实付）
  rate         NUMERIC(6,4) NOT NULL DEFAULT 1,          -- 计入时使用的倍率（快照）
  biz_type     VARCHAR(16) NOT NULL,                     -- 充值 / 消费 / 退货 / 调整
  ref_type     VARCHAR(16),
  ref_id       BIGINT,
  remark       VARCHAR(128),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_growth_member ON member_growth_records (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_recent ON member_growth_records (member_id, created_at);

-- ② 会员累计成长值（冗余，升级判定用；滚动值实时汇总避免热点表膨胀）
ALTER TABLE members ADD COLUMN IF NOT EXISTS growth_total NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ③ 等级档位增加「成长值升级门槛 / 保级门槛」（保级略低于升级，降低压力）
ALTER TABLE member_levels ADD COLUMN IF NOT EXISTS upgrade_growth NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE member_levels ADD COLUMN IF NOT EXISTS keep_growth   NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ④ 等级门槛默认值（老板 2026-10-07 拍板：银卡 升级800/保级500，金卡 升级2000/保级1300）
UPDATE member_levels SET upgrade_growth = 800,  keep_growth = 500  WHERE name = '银卡会员';
UPDATE member_levels SET upgrade_growth = 2000, keep_growth = 1300 WHERE name = '金卡会员';

-- ⑤ 成长值规则设置项（倍率可调；排除项由管理员指定商品/分类）
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark) VALUES
 ('member.growth.enabled',          '会员管理', '成长值体系',      'true', 'true', 'boolean', '关闭后成长值不再累计（已产生的成长值与等级仍保留）'),
 ('member.growth.recharge_rate',    '会员管理', '充值成长倍率',    '1',    '1',    'number',  '每充值 1 元本金计多少成长值。默认 1 元=1 分；赠送金额不计'),
 ('member.growth.consume_rate',     '会员管理', '消费成长倍率',    '0.8',  '0.8',  'number',  '每实付消费 1 元计多少成长值。默认 1 元=0.8 分；余额/券抵扣/赠送不计'),
 ('member.growth.period_months',    '会员管理', '等级考核周期(月)','6',    '6',    'number',  '滚动考核窗口月数。默认近 6 个月成长值决定保级'),
 ('member.level.grace_days',       '会员管理', '等级保护缓冲期(天)','30', '30',   'number',  '近周期成长值不达保级线后进入缓冲期，期间保留全部权益；到期仍不达标才降级'),
 ('member.growth.exclude_products', '会员管理', '成长值排除商品',  '[]',   '[]',   'json',    '商品ID数组 JSON。例 [12,35]；这些商品消费不计成长值（如香烟）'),
 ('member.growth.exclude_categories','会员管理','成长值排除分类',  '[]',   '[]',   'json',    '分类ID数组 JSON。整类消费不计成长值'),
 ('member.growth.exclude_promo',    '会员管理', '特价商品不计成长','true', 'true', 'boolean', '命中特价/折扣活动的商品消费不计成长值')
ON CONFLICT (setting_key) DO NOTHING;

-- ⑥ 缓冲期语义改为「等级保护缓冲期」（原 member.level_grace_days=7 为本金判级宽限，现统一 30 天）
UPDATE system_settings SET value = '30', default_value = '30', remark = '近周期成长值不达保级线后进入缓冲期，期间保留全部权益；到期仍不达标才降级'
 WHERE setting_key = 'member.level_grace_days';