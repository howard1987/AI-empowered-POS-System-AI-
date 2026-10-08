-- V5.0.18g 员工删除冷静期：停用满 90 天方可删除；删除时保留关联业务快照
-- 方案：无业务记录 → 物理删除；有业务记录 → 「注销归档」（全量快照入 employee_delete_archive，
--       员工行转「已注销」并作废敏感字段；业务单据外键与操作人姓名完整保留，审计可追溯）

-- 停用时间（冷静期起点）：停用时写入，复职清空
ALTER TABLE employees ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- 状态枚举扩展「已注销」（登录守卫 status!=='在职' 自动拦截）
ALTER TYPE employee_status_t ADD VALUE IF NOT EXISTS '已注销';

-- 删除归档快照表
CREATE TABLE IF NOT EXISTS employee_delete_archive (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL REFERENCES stores(id),
  emp_no      VARCHAR(32) NOT NULL,
  name        VARCHAR(32) NOT NULL,
  snapshot    JSONB NOT NULL,                 -- 员工全字段 + 角色列表 + 业务记录统计
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by BIGINT                          -- 执行删除的管理员（employees.id，删自身档案场景允许 NULL）
);
CREATE INDEX IF NOT EXISTS idx_eda_store ON employee_delete_archive(store_id, archived_at);

-- 存量回填：已停用员工以 updated_at 近似停用时间（停用操作本就会刷新 updated_at）；在职清空
UPDATE employees SET disabled_at = updated_at WHERE status = '停用' AND disabled_at IS NULL;
UPDATE employees SET disabled_at = NULL WHERE status = '在职' AND disabled_at IS NOT NULL;
