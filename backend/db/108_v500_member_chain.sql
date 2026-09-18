-- ============================================================================
-- 108_v500_member_chain.sql · V5.0.0 连锁 批次5（M5-0，方案 §5.2 / §3.5）
--   会员连锁：档案连锁字段 + 跨店资产流水台账 + 离线挂账备用表 + 权限点
--   权威账本在总部（R3/R4）：门店镜像由 member_mirror 下行覆盖；
--   门店余额/积分/分红消费在线走 /hq/member/debit（ticket 作支付凭证）
-- 幂等：语句级重放；单店零回归：新表恒空、新列带默认值
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ① members 连锁字段（档案总部权威：谁在哪个节点建档 / 跨店累计消费）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE members ADD COLUMN IF NOT EXISTS source_store_id BIGINT;            -- 注册门店（总部/单店建档=本店）
ALTER TABLE members ADD COLUMN IF NOT EXISTS source_node     VARCHAR(32);       -- 注册节点：店 node_code / 'HQ'
ALTER TABLE members ADD COLUMN IF NOT EXISTS total_consume   NUMERIC(12,2) NOT NULL DEFAULT 0;  -- 跨店累计消费（R4，总部累加）
CREATE INDEX IF NOT EXISTS idx_member_source ON members (source_store_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 跨店资产流水台账（总部侧记账；ticket=MCF 单号，随 sale_payments.external_no 留凭证）
-- ─────────────────────────────────────────────────────────────────────────────
-- 原流水表 ref_id 是 BIGINT（本地单据 id）；连锁凭证号是字符串单号 → 补 ref_no（可空，零回归）
ALTER TABLE balance_flows   ADD COLUMN IF NOT EXISTS ref_no VARCHAR(40);
ALTER TABLE dividend_records ADD COLUMN IF NOT EXISTS ref_no VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_bflow_refno  ON balance_flows (ref_no) WHERE ref_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS member_cross_store_flows (
  id            BIGSERIAL PRIMARY KEY,
  txn_no        VARCHAR(40) NOT NULL UNIQUE,       -- 凭证号 MCF-{日期}-{序号}
  store_id      BIGINT NOT NULL REFERENCES stores(id),   -- 消费/交易门店
  node_code     VARCHAR(32) NOT NULL,              -- 发起节点
  member_id     BIGINT NOT NULL REFERENCES members(id),
  asset         VARCHAR(12) NOT NULL,              -- balance 余额 / dividend 分红 / points 积分
  direction     VARCHAR(4)  NOT NULL,              -- 出(扣) / 入(回补)
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 金额（积分动作为 0）
  points        INT NOT NULL DEFAULT 0,            -- 积分数量（金额动作为 0）
  principal_part NUMERIC(12,2) NOT NULL DEFAULT 0, -- 余额动作：本金拆分（有效消费口径）
  gift_part      NUMERIC(12,2) NOT NULL DEFAULT 0, -- 余额动作：赠送拆分
  balance_after NUMERIC(12,2),                     -- 动作后快照（balance / dividend / points 语义随 asset）
  ref_no        VARCHAR(40),                       -- 关联单号（orderNo / refundNo）
  biz_type      VARCHAR(20) NOT NULL,              -- 消费/退款/兑换/调整…
  status        VARCHAR(14) NOT NULL DEFAULT 'done',   -- done / pending_order（有扣款无订单，对账 job 标记）
  idem_key      VARCHAR(128) NOT NULL UNIQUE,      -- 节点:动作:单号 → 幂等重放直接回 ticket
  biz_ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcsf_member ON member_cross_store_flows (member_id, biz_ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcsf_store  ON member_cross_store_flows (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcsf_ref    ON member_cross_store_flows (ref_no);
CREATE INDEX IF NOT EXISTS idx_mcsf_status ON member_cross_store_flows (status) WHERE status <> 'done';

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 会员离线挂账（M5-0 建表备用，P2 启用：断网时余额消费先挂账、恢复后冲抵）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_offline_credits (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id),
  member_id     BIGINT NOT NULL REFERENCES members(id),
  amount        NUMERIC(12,2) NOT NULL,
  balance_after NUMERIC(12,2),
  ref_no        VARCHAR(40),
  remark        VARCHAR(200),
  status        VARCHAR(12) NOT NULL DEFAULT 'pending',   -- pending / settled / reversed
  settled_flow_id BIGINT,                                  -- 恢复在线后对应的 cross_store_flow
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_moc_status ON member_offline_credits (status, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ 权限点（会员跨店明细涉商业敏感，方案 §5.2.4：默认不给门店）
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO permission_points (code, name, module)
VALUES ('hq.member.crossview', '会员跨店消费明细查看', '总部会员')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
  FROM roles r CROSS JOIN permission_points pp
 WHERE r.name = '超级管理员'
   AND pp.code = 'hq.member.crossview'
ON CONFLICT DO NOTHING;
