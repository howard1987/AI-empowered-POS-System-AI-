-- === V5.0.11l 收银员补门店作业权限（真机反馈：收银员进不了收货/退货/报损）===
--
-- 【问题】收银员角色只有 8 项权限：pos.sell / pos.hang / pos.emergency / shift.manage
--   + member.register / member.info.view / member.balance.recharge / pos.refund.apply。
--   缺 stock.inbound.audit（移动收货）、stock.return.audit（采购退货）、stock.loss.create（拍照报损），
--   门店日常「收货→上架、退货、报损」这些收银员本职操作全部 403，点提交才报错。
--
-- 【业务依据】用户明确：「收银员应该默认有收货、退货、报损的权限，这才是门店正常的操作」。
--   库管角色虽有这三项，但小门店常常不设专职库管，由收银员兼做 —— 不能因此把日常作业堵死。
--
-- 【为什么不给审核权】stock.count.audit（盘点差异审核）、stock.loss.audit（报损审核/驳回）、
--   purchase.po.approve（采购单审批）这些属于「审核」类，仍留在店长/库管，
--   收银员只拿到「发起/录入」侧的权限点，权责边界不变。
--
-- 【幂等】NOT EXISTS 防重复插入；可重复执行。

-- ① 收货 / 退货 / 报损（发起侧）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
  FROM roles r
  JOIN permission_points pp ON pp.code IN ('stock.inbound.audit','stock.return.audit','stock.loss.create')
 WHERE r.name = '收银员'
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);

-- ② 移动盘点（录入实盘数）：盘点任务领取也需要，一并给
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
  FROM roles r
  JOIN permission_points pp ON pp.code = 'stock.count.task'
 WHERE r.name = '收银员'
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = pp.id);
