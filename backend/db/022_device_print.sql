-- ═══ 022: 设备管理 / 打印中心（9.9、⑨）═══
-- 执行方式：init-db.ts 顺序执行 db/0*.sql；幂等
-- 内容：权限点 + 打印历史表 + 模板种子（小票 58/80 + A5 单据 8 类）

-- 1) 打印历史（打印中心健康看板/留痕：每次打印与测试页）
CREATE TABLE IF NOT EXISTS print_jobs (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL REFERENCES stores(id),
  printer_id  BIGINT REFERENCES printers(id),
  template_id BIGINT REFERENCES print_templates(id),
  biz_type    VARCHAR(32),
  job_type    VARCHAR(16) NOT NULL DEFAULT '打印',     -- 打印/测试页
  status      VARCHAR(16) NOT NULL DEFAULT '成功',     -- 成功/失败
  content     TEXT,                                    -- 渲染内容（留痕）
  cost_ms     INT,
  operator_id BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_print_jobs ON print_jobs (store_id, created_at DESC);

-- 2) 权限点
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('device.manage',  '系统', '设备管理', 1),
 ('printer.manage', '系统', '打印中心', 1),
 ('print.template', '系统', '打印模板编辑', 1)
ON CONFLICT (code) DO NOTHING;

-- 绑定超级管理员
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points
 WHERE code IN ('device.manage','printer.manage','print.template')
ON CONFLICT DO NOTHING;

-- 3) 模板种子（默认模板：小票 58/80 + A5 单据 8 类；content 字段显隐/抬头/联次/切刀/钱箱）
DO $$
DECLARE s BIGINT := (SELECT id FROM stores ORDER BY id LIMIT 1);
BEGIN
  IF s IS NULL THEN RETURN; END IF;

  -- 小票 receipt（58/80 两档宽度，字段池一致）
  INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies) VALUES
  (s, '标准小票58', '小票58', 'receipt',
   '{"title":"绿源社区超市","subtitle":"小票","fields":[
     {"key":"store","label":"门店","show":true},
     {"key":"orderNo","label":"单号","show":true},
     {"key":"time","label":"时间","show":true},
     {"key":"cashier","label":"收银员","show":true},
     {"key":"items","label":"商品明细","show":true},
     {"key":"subtotal","label":"合计","show":true},
     {"key":"discount","label":"优惠","show":true},
     {"key":"member","label":"会员","show":true},
     {"key":"coupon","label":"券抵扣","show":true},
     {"key":"pay","label":"支付","show":true},
     {"key":"change","label":"找零","show":true},
     {"key":"points","label":"积分","show":true},
     {"key":"thanks","label":"感谢语","show":true}],
    "options":{"qr":true,"ad":true,"cut":true,"cashDrawer":false,"lineHeight":24,"fontSize":2}}',
   true, 1),
  (s, '标准小票80', '小票80', 'receipt',
   '{"title":"绿源社区超市","subtitle":"小票","fields":[
     {"key":"store","label":"门店","show":true},
     {"key":"orderNo","label":"单号","show":true},
     {"key":"time","label":"时间","show":true},
     {"key":"cashier","label":"收银员","show":true},
     {"key":"items","label":"商品明细","show":true},
     {"key":"subtotal","label":"合计","show":true},
     {"key":"discount","label":"优惠","show":true},
     {"key":"member","label":"会员","show":true},
     {"key":"coupon","label":"券抵扣","show":true},
     {"key":"pay","label":"支付","show":true},
     {"key":"change","label":"找零","show":true},
     {"key":"points","label":"积分","show":true},
     {"key":"thanks","label":"感谢语","show":true}],
    "options":{"qr":true,"ad":true,"cut":true,"cashDrawer":false,"lineHeight":26,"fontSize":2}}',
   false, 1),
  -- A5 单据（入库/退货/调拨/盘点/报损/对账/结算/收货，字段勾选+列序，一式多联）
  (s, '标准入库单', 'A5单据', 'inbound',
   '{"title":"进货单","fields":[
     {"key":"store","label":"门店","show":true},{"key":"orderNo","label":"单号","show":true},
     {"key":"supplier","label":"供应商","show":true},{"key":"time","label":"日期","show":true},
     {"key":"operator","label":"经手人","show":true},{"key":"items","label":"明细","show":true},
     {"key":"total","label":"合计","show":true},{"key":"remark","label":"备注","show":true}],
    "options":{"lineHeight":26,"fontSize":2}}',
   true, 2),
  (s, '标准退货单', 'A5单据', 'return',
   '{"title":"退货单","fields":[
     {"key":"store","label":"门店","show":true},{"key":"orderNo","label":"单号","show":true},
     {"key":"supplier","label":"供应商","show":true},{"key":"time","label":"日期","show":true},
     {"key":"operator","label":"经手人","show":true},{"key":"items","label":"明细","show":true},
     {"key":"total","label":"合计","show":true},{"key":"reason","label":"退货原因","show":true},
     {"key":"remark","label":"备注","show":true}],
    "options":{"lineHeight":26,"fontSize":2}}',
   true, 2),
  (s, '标准调拨单', 'A5单据', 'transfer',
   '{"title":"调拨单","fields":[
     {"key":"store","label":"门店","show":true},{"key":"orderNo","label":"单号","show":true},
     {"key":"from","label":"调出","show":true},{"key":"to","label":"调入","show":true},
     {"key":"time","label":"日期","show":true},{"key":"operator","label":"经手人","show":true},
     {"key":"items","label":"明细","show":true},{"key":"total","label":"合计","show":true},
     {"key":"remark","label":"备注","show":true}],
    "options":{"lineHeight":26,"fontSize":2}}',
   true, 2),
  (s, '标准盘点单', 'A5单据', 'count',
   '{"title":"盘点单","fields":[
     {"key":"store","label":"门店","show":true},{"key":"orderNo","label":"单号","show":true},
     {"key":"time","label":"日期","show":true},{"key":"counter","label":"盘点人","show":true},
     {"key":"items","label":"明细","show":true},{"key":"diff","label":"差异","show":true},
     {"key":"remark","label":"备注","show":true}],
    "options":{"lineHeight":26,"fontSize":2}}',
   true, 1),
  (s, '标准报损单', 'A5单据', 'loss',
   '{"title":"报损单","fields":[
     {"key":"store","label":"门店","show":true},{"key":"orderNo","label":"单号","show":true},
     {"key":"time","label":"日期","show":true},{"key":"operator","label":"经手人","show":true},
     {"key":"items","label":"明细","show":true},{"key":"total","label":"合计","show":true},
     {"key":"reason","label":"报损原因","show":true},{"key":"remark","label":"备注","show":true}],
    "options":{"lineHeight":26,"fontSize":2}}',
   true, 1),
  (s, '标准对账单', 'A5单据', 'recon',
   '{"title":"对账单","fields":[
     {"key":"store","label":"门店","show":true},{"key":"supplier","label":"供应商","show":true},
     {"key":"period","label":"账期","show":true},{"key":"orderNo","label":"单号","show":true},
     {"key":"time","label":"日期","show":true},{"key":"items","label":"明细","show":true},
     {"key":"total","label":"应付合计","show":true},{"key":"confirm","label":"确认","show":true},
     {"key":"remark","label":"备注","show":true}],
    "options":{"lineHeight":26,"fontSize":2}}',
   true, 2),
  (s, '标准结算单', 'A5单据', 'settlement',
   '{"title":"结算单","fields":[
     {"key":"store","label":"门店","show":true},{"key":"supplier","label":"供应商","show":true},
     {"key":"period","label":"账期","show":true},{"key":"orderNo","label":"单号","show":true},
     {"key":"time","label":"日期","show":true},{"key":"items","label":"明细","show":true},
     {"key":"total","label":"结算金额","show":true},{"key":"sign","label":"签字","show":true},
     {"key":"remark","label":"备注","show":true}],
    "options":{"lineHeight":26,"fontSize":2}}',
   true, 2)
  ON CONFLICT (store_id, biz_type, kind, name) DO NOTHING;
END $$;
