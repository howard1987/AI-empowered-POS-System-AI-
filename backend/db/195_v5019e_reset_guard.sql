-- V5.0.19e · 高危操作留痕与审计防篡改
--
-- 背景（2026-10-09 事故取证）：业务库被清空（sales_orders 1893 → 0，序列 2478 → 1），
-- 而 audit_logs 里**没有任何一条**「系统初始化」留痕 —— 清库走的是绕过应用留痕的路径，
-- 事后无法追溯「谁 / 何时 / 清了什么」。本迁移补上两条底线：
--   ① 高危操作史 data_reset_history：清库/恢复必写，且既不可改也不可删（连清库清单都碰不到它）；
--   ② 审计防篡改：audit_logs 允许归档删除（d3.care 的保留期清理需要），但禁止 UPDATE 抹改历史。
--
-- ⚠ 设计纪律：data_reset_history 必须加入 admin.reset.ts 的 KEEP_ALWAYS（永不清骨架表），
--    且不得出现在任何 TRUNCATE 清单里 —— 否则"留痕"会在清库时被自己清掉，形同虚设。

CREATE TABLE IF NOT EXISTS data_reset_history (
  id            BIGSERIAL PRIMARY KEY,
  op            VARCHAR(32)  NOT NULL,                  -- reset（清库）/ restore（恢复）
  store_id      BIGINT,
  employee_id   BIGINT,
  emp_no        VARCHAR(64),
  emp_name      VARCHAR(64),
  ip            VARCHAR(64),
  keep          TEXT[]       NOT NULL DEFAULT '{}',     -- 勾选保留的档案组
  clear_groups  TEXT[]       NOT NULL DEFAULT '{}',     -- 勾选清空的业务模块
  tables        INT          NOT NULL DEFAULT 0,        -- 实际清空表数
  rows_cleared  INT          NOT NULL DEFAULT 0,        -- 实际清空行数
  backup_name   VARCHAR(128),                           -- 执行前自动备份目录名（唯一可回滚凭据）
  detail        JSONB,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_reset_history_created ON data_reset_history (created_at DESC);

-- 审计防篡改：归档（DELETE）照常放行，历史条目禁止 UPDATE（防止事后抹改留痕）
DROP RULE IF EXISTS audit_logs_no_update ON audit_logs;
CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;

-- 高危操作史：不可改、不可删（含 TRUNCATE 也清不掉：TRUNCATE 会绕过 RULE，
-- 故同时依赖 admin.reset.ts 的 KEEP_ALWAYS 白名单在应用侧兜底）
DROP RULE IF EXISTS data_reset_history_no_update ON data_reset_history;
CREATE RULE data_reset_history_no_update AS ON UPDATE TO data_reset_history DO INSTEAD NOTHING;
DROP RULE IF EXISTS data_reset_history_no_delete ON data_reset_history;
CREATE RULE data_reset_history_no_delete AS ON DELETE TO data_reset_history DO INSTEAD NOTHING;
