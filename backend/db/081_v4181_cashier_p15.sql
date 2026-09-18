-- ═══ V4.18.1 P15 收银业务深度（081）═══
--  ① member_credits：会员挂账欠款（结算「赊账」通道落此表；限额/超期/销账闭环）
--  ② credit_pays：挂账销账流水（默认最旧优先可自选，支持部分销账 partial）
--  ③ cashbox_flows：钱箱存取流水（开班备用金/班中存入取出，必选原因留痕，交接班应答口径）
--  ④ P15 设置键：积分抵现比例/上限、挂账限额、退货限额、备用金默认、容差
-- 幂等防线：CREATE TABLE IF NOT EXISTS / NOT EXISTS 种子
-- 底座复用（已有，勿重复建）：shifts（含 opening_float/cash_total/cash_counted/diff_amount）、
--   points_flows（含 balance_after）、daily_settlement、sale_refunds、pay_channel_t 枚举（含 赊账/积分抵扣）

-- ── ① 会员挂账欠款 ──
CREATE TABLE IF NOT EXISTS member_credits (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  member_id     BIGINT NOT NULL,
  order_id      BIGINT,                          -- 产生欠款的销售单（NULL=手工登记）
  amount        NUMERIC(10,2) NOT NULL,          -- 欠款本金
  paid_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  status        VARCHAR(12) NOT NULL DEFAULT '未结',   -- 未结/部分结清/已结清/已核销/已关闭
  due_date      DATE,                            -- 超期提醒口径
  reason        VARCHAR(200),                    -- 挂账原因（整单备注同步）
  creator_id    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mc_member  ON member_credits (member_id, status);
CREATE INDEX IF NOT EXISTS idx_mc_store   ON member_credits (store_id, status, due_date);
COMMENT ON TABLE member_credits IS '会员挂账欠款（V4.18.1 P15）：一笔挂账=一笔独立欠款，销账默认最旧优先可自选（§13 B2）';

-- ── ② 挂账销账流水 ──
CREATE TABLE IF NOT EXISTS credit_pays (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  credit_id     BIGINT NOT NULL REFERENCES member_credits(id),
  amount        NUMERIC(10,2) NOT NULL,          -- 本次销账金额（部分销账<欠款余额）
  channel       pay_channel_t NOT NULL DEFAULT '现金',
  mode          VARCHAR(10) NOT NULL DEFAULT 'full',   -- full/partial
  emp_id        BIGINT,
  order_id      BIGINT,                          -- 关联收款销售单（如有）
  remark        VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cp_credit ON credit_pays (credit_id);
COMMENT ON TABLE credit_pays IS '挂账销账流水（V4.18.1 P15）：逐笔留痕，欠款回冲不退现金（§13 B2）';

-- ── ③ 钱箱存取流水 ──
CREATE TABLE IF NOT EXISTS cashbox_flows (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  shift_id      BIGINT,                          -- 所属班次（交接班应答=备用金+现金收入±存取）
  emp_id        BIGINT NOT NULL,
  type          VARCHAR(10) NOT NULL,            -- 备用金/存入/取出
  amount        NUMERIC(10,2) NOT NULL,
  reason        VARCHAR(100) NOT NULL,           -- 必选原因：换零/取现/备用金补充/对账调整 等
  order_id      BIGINT,                          -- 关联单据（如有）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cf_shift ON cashbox_flows (shift_id, type);
COMMENT ON TABLE cashbox_flows IS '钱箱过程管理流水（V4.18.1 P15）：班中存入/取出必选原因留痕，交接班应答口径备用金+现金收入±存取（§13/银豹借鉴）';

-- ── ④ P15 设置键 ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.points.rate', '积分抵现比例(分/百积分)', '100'::jsonb, '100'::jsonb, 'number',
       '每 100 积分抵 1 元（本键存每百积分对应「分」，100=1 元）；0=关闭积分抵现'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.points.rate');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.points.max_pct', '积分抵现单笔上限(%)', '20'::jsonb, '20'::jsonb, 'number',
       '单笔订单积分抵现金额不超过应收的该百分比'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.points.max_pct');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.credit.limit', '会员挂账单笔限额(元)', '500'::jsonb, '500'::jsonb, 'number',
       '单笔挂账超过该限额需店长放行；0=不设限'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.credit.limit');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.credit.due_days', '挂账默认账期(天)', '30'::jsonb, '30'::jsonb, 'number',
       '挂账单默认到期天数（超期进店长提醒列表）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.credit.due_days');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.refund.limit', '收银员退货限额(元)', '200'::jsonb, '200'::jsonb, 'number',
       '退货金额该限额内收银员直接退，超过需店长输密放行；0=一律店长'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.refund.limit');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.cashbox.float_default', '开班备用金默认(元)', '200'::jsonb, '200'::jsonb, 'number',
       '开班录入钱箱备用金的默认值'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.cashbox.float_default');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.shift.diff_tolerance', '交接班现金容差(元)', '5'::jsonb, '5'::jsonb, 'number',
       '实点与应答差异超过该值强制填写原因；0=不容差'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.shift.diff_tolerance');
