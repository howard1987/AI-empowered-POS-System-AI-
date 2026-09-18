-- ═══════════════════════════════════════════════════════════════════
-- 061 · V4.14.6 架构收口（RV-04 校准留痕 / RV-07 对账差异站内触达）
-- 幂等：可重复执行
-- ═══════════════════════════════════════════════════════════════════

-- ① notices 站内提醒（RV-07：对账差异触达到人；后续库存漂移/其它告警可复用）
--    收件范围按权限点（perm）而非逐人展开行：持该权限点的员工都能看到并各自标记已读
CREATE TABLE IF NOT EXISTS notices (
  id         BIGSERIAL PRIMARY KEY,
  store_id   BIGINT      NOT NULL,
  kind       VARCHAR(32) NOT NULL DEFAULT 'recon_diff',   -- recon_diff / stock_drift / ...
  title      VARCHAR(128) NOT NULL,
  detail     JSONB,                                        -- 结构化明细（差异行/批次号等）
  perm       VARCHAR(64) NOT NULL DEFAULT 'sys.settings',  -- 收件权限点（'*'=所有人）
  batch_key  VARCHAR(96),                                  -- 业务去重键（同批次重复导入不重复提醒）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_by    JSONB       NOT NULL DEFAULT '[]'             -- 已读员工 id 数组（轻量，不按人展开）
);
CREATE INDEX IF NOT EXISTS idx_notices_store ON notices (store_id, created_at DESC);
-- 同店同类型同批次唯一 → 通知幂等
CREATE UNIQUE INDEX IF NOT EXISTS uq_notices_batch ON notices (store_id, kind, batch_key) WHERE batch_key IS NOT NULL;
COMMENT ON TABLE notices IS '站内提醒（V4.14.6 RV-07）：对账差异等告警触达，按权限点收件，read_by 记录各人已读';

-- ② daily_settlement 补校准留痕列（RV-04：日结按批次口径重算 inventory_current，记录漂移修正行数）
ALTER TABLE daily_settlement ADD COLUMN IF NOT EXISTS stock_drift_fixed INT NOT NULL DEFAULT 0;
COMMENT ON COLUMN daily_settlement.stock_drift_fixed IS 'RV-04：本次日结时 inventory_current 与批次口径漂移被修正的行数';
