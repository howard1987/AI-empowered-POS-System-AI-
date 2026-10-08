-- V5.0.18g 员工级权限覆盖（在角色权限基础上按人增减）
-- 有效权限 = (角色权限 ∪ 本表 allow) − 本表 deny；空表 = 完全随角色。
CREATE TABLE IF NOT EXISTS employee_perm_overrides (
  employee_id   BIGINT NOT NULL,
  permission_id BIGINT NOT NULL REFERENCES permission_points(id),
  mode          VARCHAR(8) NOT NULL CHECK (mode IN ('allow','deny')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_epo_employee ON employee_perm_overrides(employee_id);
