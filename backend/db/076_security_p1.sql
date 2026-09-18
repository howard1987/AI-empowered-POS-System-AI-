-- 076 安全整改 P1
-- ① H5：员工 token 吊销版本号（改密/停用即失效，守卫 60s 缓存比对）
ALTER TABLE employees ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
-- ② H1：分红手工净利覆盖复核权限点（与 member.dividend.adjust 双岗）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('dividend.manual.override', '会员', '分红净利手工覆盖复核', 2)
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id FROM roles r JOIN permission_points pp ON pp.code='dividend.manual.override'
WHERE r.name IN ('超级管理员','财务') AND NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id=r.id AND x.permission_id=pp.id);
