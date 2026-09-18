-- ============================================================================
-- 112_v500_p2_member.sql · V5.0.0 连锁 P2-1（会员资金安全）
--   ① 离线余额挂账启用：member_offline_credits 补列（资产类型/积分/节点/清算凭证）
--   ② 设置键：member.offline.*（挂账开关 + 单笔/日累计限额，门店自治 scope='store'）
--   ③ 孤儿扣款自动冲正：member_cross_store_flows.status 增 'reversed'（无 CHECK，直接用）
-- 幂等：语句级重放；单店零回归：新列带默认值、新键默认关
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ① member_offline_credits 补列（108 已建表：store_id/member_id/amount/ref_no/
--    status pending|settled|reversed/settled_flow_id/balance_after）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE member_offline_credits ADD COLUMN IF NOT EXISTS asset        VARCHAR(12) NOT NULL DEFAULT 'balance'; -- P2 先只挂余额；预留 points
ALTER TABLE member_offline_credits ADD COLUMN IF NOT EXISTS points       INT NOT NULL DEFAULT 0;
ALTER TABLE member_offline_credits ADD COLUMN IF NOT EXISTS node_code    VARCHAR(32);
ALTER TABLE member_offline_credits ADD COLUMN IF NOT EXISTS settled_txn  VARCHAR(40);   -- 清算成功后的总部 MCF 凭证
ALTER TABLE member_offline_credits ADD COLUMN IF NOT EXISTS card_no      VARCHAR(24);   -- 冗余卡号（清算直调总部 debit 用）
-- 防重：同一订单只允许一笔挂账（重复结账/重试不会双挂）
CREATE UNIQUE INDEX IF NOT EXISTS uq_moc_refno ON member_offline_credits (ref_no) WHERE ref_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_moc_store_day ON member_offline_credits (store_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 设置键（「分红与会员」组；数字键必填 unit；scope='store' 门店自治）
--    铁律：没接线不准种 —— 三键均已接线（member-chain.offlineBalanceCredit）
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO system_settings
  (group_name, setting_key, display_name, value, default_value, value_type, unit, enum_options, remark, scope)
VALUES
  ('分红与会员','member.offline.enabled',    '断网余额挂账',       'false'::jsonb,'false'::jsonb,'bool',  NULL, NULL,
   '连锁门店断网时允许会员余额先记账后清算（P2）。关闭（默认）= 断网时余额不可用，收银员改用其他支付方式', 'store'),
  ('分红与会员','member.offline.max_single', '挂账单笔限额',       '100'::jsonb,  '100'::jsonb,  'number','元',  NULL,
   '断网挂账单笔上限；超过则拒绝余额支付（防大额资金风险）', 'store'),
  ('分红与会员','member.offline.max_daily',  '挂账日累计限额',     '500'::jsonb,  '500'::jsonb,  'number','元',  NULL,
   '断网挂账当日累计上限（含待清算与当日已清算）；超过则当日余额支付全部拒绝', 'store')
ON CONFLICT (setting_key) DO NOTHING;
