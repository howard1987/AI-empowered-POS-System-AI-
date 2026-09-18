-- 028 签字治理 P1-P3（5.6.8③⑤⑦ + P3-2 盘点）
-- P1-1 大额确认方式可配（短信确认/现场补签）；P1-2 必签场景矩阵；P3-1 员工离职模板作废；P3-2 盘点签名

ALTER TABLE signature_templates ADD COLUMN IF NOT EXISTS ref_employee_id BIGINT REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_sig_tpl_emp ON signature_templates (ref_employee_id, status);

ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS sms_code VARCHAR(6);
ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS sms_sent_at TIMESTAMPTZ;
ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS sms_try SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS sms_confirmed_at TIMESTAMPTZ;

ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS sign_record_id BIGINT;

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark, updated_by)
VALUES
('权限与安全','auth.sign_large_mode','大额签字确认方式', '"现场补签"', '"现场补签"', 'enum',
 '大额单据（金额≥auth.sign_threshold）确认方式：现场补签 / 短信确认（无短信通道时确认码线下核对，记录 sms_confirmed 留痕）', 1),
('权限与安全','auth.sign_required_scenes','必签才能过审的单据', '["inbound","return","loss","recon"]', '["inbound","return","loss","recon"]', 'json',
 '哪些单据必须签字后才能过审：inbound入库 / return退货 / loss报损 / recon对账 / count盘点（5.6.8⑤ 触发场景矩阵可配）', 1)
ON CONFLICT (setting_key) DO NOTHING;
