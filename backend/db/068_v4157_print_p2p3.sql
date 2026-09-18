-- V4.15.7 P2 标签打印 + P3 A5 业务单据
--   ① printers 加 printer_type（小票/标签）与 label_size（标签纸型）
--   ② 权限点 docs.print.a5（A5 单据打印，店长及以上）
--   ③ 设置 doc.print.auto_a5（审核通过后自动弹 A5 打印，默认关）

-- ① 打印机设备类型：小票机（ESC/POS 58/80）/ 标签机（TSPL/ZPL 40x30/50x30/60x40）
ALTER TABLE printers ADD COLUMN IF NOT EXISTS printer_type VARCHAR(8) NOT NULL DEFAULT '小票';
ALTER TABLE printers ADD COLUMN IF NOT EXISTS label_size  VARCHAR(16) NOT NULL DEFAULT '40x30';

DO $$ BEGIN
  ALTER TABLE printers DROP CONSTRAINT printers_printer_type_check;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE printers ADD CONSTRAINT printers_printer_type_check
  CHECK (printer_type::text = ANY (ARRAY['小票'::text, '标签'::text]));

DO $$ BEGIN
  ALTER TABLE printers DROP CONSTRAINT printers_label_size_check;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE printers ADD CONSTRAINT printers_label_size_check
  CHECK (label_size::text = ANY (ARRAY['40x30'::text, '50x30'::text, '60x40'::text]));

-- ② 权限点：A5 业务单据打印（店长及以上；打印动作本身在前端浏览器，此处约束留痕端点与按钮显隐）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('docs.print.a5', '打印', 'A5单据打印（七类业务单据）', 1)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM permission_points p, roles r
 WHERE p.code = 'docs.print.a5' AND r.name IN ('超级管理员', '店长')
ON CONFLICT DO NOTHING;

-- ③ 设置：审核通过后自动弹 A5 打印（列表审核动作成功后触发；默认关避免打断）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark) VALUES
 ('通用设置', 'doc.print.auto_a5', '审核后自动弹 A5 打印', '0', '0', 'enum',
  '[{"v":"1","label":"开启（审核通过自动弹打印窗口）"},{"v":"0","label":"关闭（仅手动打印）"}]',
  '入库/退货/报损/盘点单审核通过后，自动弹出该单据的 A5 打印窗口（需 A5单据打印 权限）')
ON CONFLICT (setting_key) DO NOTHING;
