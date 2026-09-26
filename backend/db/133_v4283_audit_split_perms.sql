-- 133 · V4.28.3 P1-10 审批权限拆分：报损审核、调拨确认 与 创建/执行 分离
-- 原则（沿 033）：只补缺、不回收——已有自定义授权不受影响；库管既有的 recon.confirm 不自动回收，
-- 如需"财务审对账"的严格拆分，老板可在「角色管理」取消库管的该权限点。
-- 幂等：可重复执行。

-- ① 新增权限点（创建/审核分离后，审核为独立权限点；risk_level=2 敏感）
INSERT INTO permission_points (code, module, name, risk_level)
SELECT v.code, v.module, v.name, v.risk FROM (VALUES
  ('stock.loss.audit',     '进销存', '报损审核/驳回', 2),
  ('stock.transfer.audit', '进销存', '调拨确认/取消', 2)
) AS v(code, module, name, risk)
WHERE NOT EXISTS (SELECT 1 FROM permission_points x WHERE x.code = v.code);

-- ② 库管：补报损审核 + 调拨确认/取消（原 stock.loss.create 只能创建报损；stock.transfer 只能发货收货）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
FROM roles r
JOIN permission_points pp ON pp.code = ANY (ARRAY[
  'stock.loss.audit','stock.transfer.audit'
]::VARCHAR[])
WHERE r.name IN ('库管', '店长')
  AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);

-- ③ 财务：补对账现场确认（P1-10「财务审对账」；财务已有结算审核 recon.settle.audit，补齐确认环节）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
FROM roles r
JOIN permission_points pp ON pp.code = 'recon.confirm'
WHERE r.name = '财务'
  AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);
