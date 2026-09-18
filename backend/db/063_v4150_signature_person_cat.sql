-- V4.15.0 签字3：电子签名管理严格人员分类（门店人员/供应商人员/大客户人员）
-- 幂等：仅修正与绑定关系不一致的行（绑定供应商→供应商人员、绑定员工→门店人员、余者→大客户人员）
ALTER TABLE signature_templates ADD COLUMN IF NOT EXISTS person_cat text NOT NULL DEFAULT '门店人员';

UPDATE signature_templates
   SET person_cat = CASE
     WHEN supplier_id IS NOT NULL THEN '供应商人员'
     WHEN ref_employee_id IS NOT NULL THEN '门店人员'
     ELSE '大客户人员'
   END
 WHERE (supplier_id IS NOT NULL AND person_cat <> '供应商人员')
    OR (supplier_id IS NULL AND ref_employee_id IS NOT NULL AND person_cat <> '门店人员')
    OR (supplier_id IS NULL AND ref_employee_id IS NULL AND person_cat <> '大客户人员');
