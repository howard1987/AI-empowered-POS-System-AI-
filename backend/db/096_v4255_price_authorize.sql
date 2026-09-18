-- ═══ V4.25.5 店长授权改价/打折（096）═══
-- 背景（老板需求）：收银员改价/打折时，需弹窗由店长现场授权——仅授权本次价格操作，
--   不是全权登录收银端。授权凭据 = 店长工号 + 授权码（独立于登录密码单独设置）。
-- 本例：A 商品售价 5 元、最低售价 3 元，店员改价 4 元（未越线）→ 仍需店长授权码。
-- 本文件：① 授权码列；② 授权权限点并绑定给已持有店长放行权的角色。幂等，可重复执行。

-- ── ① 授权码（与登录密码分离；bcrypt 存储）──
ALTER TABLE employees ADD COLUMN IF NOT EXISTS auth_code_hash VARCHAR(100);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS auth_code_set_at TIMESTAMPTZ;

COMMENT ON COLUMN employees.auth_code_hash IS
  '店长授权码哈希（V4.25.5）：收银端改价/打折/赠品时的现场授权凭据，独立于登录密码；需登录密码确认才能设置';

-- ── ② 授权权限点：谁有资格授权（收银端价格操作授权）──
INSERT INTO permission_points (code, module, name, risk_level, remark)
SELECT 'pos.price.authorize', '收银', '改价/折扣授权（店长授权码）', 1,
       '收银端改价/单品折扣/整单折扣/赠品需持本权限者输入授权码现场授权（V4.25.5）'
WHERE NOT EXISTS (SELECT 1 FROM permission_points WHERE code = 'pos.price.authorize');

-- ── ③ 绑定：凡已持有「店长放行权 pos.emergency.manual」的角色，自动获得授权资格（只补缺，不回收）──
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, pp.id
FROM role_permissions rp
JOIN permission_points ep ON ep.id = rp.permission_id AND ep.code = 'pos.emergency.manual'
JOIN permission_points pp ON pp.code = 'pos.price.authorize'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = pp.id
);

-- 超级管理员角色（绑定「超级管理员」名的角色）兜底绑定一次
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
FROM roles r
JOIN permission_points pp ON pp.code = 'pos.price.authorize'
WHERE r.name = '超级管理员'
  AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);
