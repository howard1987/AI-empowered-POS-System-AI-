-- 075 安全整改 P0：新增权限点（商品档案管理），绑定超级管理员/店长/库管
-- 背景：F1 修复为商品建档/编辑/删除/导入挂 product.manage；此前仅有 pos.price.manual 约束调价单
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('product.manage', '商品', '商品档案与分类管理', 1)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id FROM roles r JOIN permission_points pp ON pp.code='product.manage'
WHERE r.name IN ('超级管理员','店长','库管') AND NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id=r.id AND x.permission_id=pp.id);

-- 收银员补「发起退款」权限点（pos.refund.apply 在 001 已种但收银员角色未绑——退款发起是收银岗位工作）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id FROM roles r JOIN permission_points pp ON pp.code='pos.refund.apply'
WHERE r.name = '收银员' AND NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id=r.id AND x.permission_id=pp.id);
