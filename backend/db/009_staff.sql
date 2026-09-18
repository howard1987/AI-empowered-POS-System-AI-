-- ═══ 009: 员工管理权限点（Web 后台员工与权限屏） ═══
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('staff.manage', '系统', '员工与权限管理', 3)
ON CONFLICT (code) DO NOTHING;

-- 绑定超级管理员
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points
 WHERE code='staff.manage'
ON CONFLICT DO NOTHING;
