-- 033: 角色默认权限种子修复（幂等）
-- 背景：初始种子只给了超管权限，店长/收银员/库管/财务均为空或残缺 →
--       收银员扫码结账被拦"无操作权限（需要权限点 pos.sell）"。
-- 原则（001_init.sql 种子备注"收银/挂单/会员查询，改价退货受限"）：
--   收银员：收银/挂单/应急/交接班/会员注册查询/储值收款
--   店长  ：门店全权（AI 训练、系统备份、员工角色管理留给超管）
--   库管  ：采购审批/对账/盘点/入库审核/报损/退货审核/调拨
--   财务  ：报表/退款审核/结算审核/关账/储值分红调整/导出/备份
-- 已有自定义授权不受影响（只补缺，不回收）。

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
FROM roles r
JOIN permission_points pp ON pp.code = ANY (ARRAY[
  -- 收银员
  'pos.sell','pos.hang','pos.emergency','shift.manage',
  'member.register','member.info.view','member.balance.recharge'
]::VARCHAR[])
WHERE r.name = '收银员'
  AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
FROM roles r
JOIN permission_points pp ON true
WHERE r.name = '店长'
  AND pp.code NOT IN ('ai.train.launch','sys.data.backup','sys.user.manage')
  -- V5.0.0：hq.* 为总部专属权限点，一律不授门店角色（R5：跨店调拨审核等不授门店）
  AND pp.code NOT LIKE 'hq.%'
  AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
FROM roles r
JOIN permission_points pp ON pp.code = ANY (ARRAY[
  -- 库管
  'purchase.po.approve','recon.confirm','stock.count.audit','stock.count.task',
  'stock.inbound.audit','stock.loss.create','stock.return.audit','stock.transfer'
]::VARCHAR[])
WHERE r.name = '库管'
  AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
FROM roles r
JOIN permission_points pp ON pp.code = ANY (ARRAY[
  -- 财务
  'report.view.all','pos.refund.audit','sales.refund.audit','recon.settle.audit',
  'settle.pay.close','member.balance.adjust','member.dividend.adjust','member.export','sys.data.backup'
]::VARCHAR[])
WHERE r.name = '财务'
  AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);
