-- 027：移动作业签名关联增强（M3b V2）
--   1) signature_templates 增加 supplier_id：业务员=供应商业务员（suppliers.contact_person 对应模板）
--   2) signature_records 增加现场签名快照字段（模板为空时仍可完整留痕：签字人/签名图/操作员）
-- 幂等：全部 IF NOT EXISTS / IF EXISTS

ALTER TABLE signature_templates ADD COLUMN IF NOT EXISTS supplier_id BIGINT REFERENCES suppliers(id);
CREATE INDEX IF NOT EXISTS idx_sig_tpl_sup ON signature_templates (supplier_id, status);

ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS person_name VARCHAR(32);
ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS image_path VARCHAR(256);
ALTER TABLE signature_records ADD COLUMN IF NOT EXISTS operator_name VARCHAR(32);
CREATE INDEX IF NOT EXISTS idx_sig_rec_biz ON signature_records (biz_type, biz_id);
