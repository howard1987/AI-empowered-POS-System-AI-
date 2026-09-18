-- ═══ V4.17.0 P13 签字样本库专项（077）═══
--  ① 存量 person_cat 回填：有供应商→供应商人员；有员工→门店人员；身份含大客户→大客户人员；三不靠→待确认
--    （废除旧「三不靠一律大客户人员」错误兜底，超级管理员等现场补签落错的样本纠出待确认）
--  ② 存量同名重复行物理合并：同人判定=归一化姓名+person_cat+supplier_id，最早行为主行，
--    其余行画像图并入主行（去重）后删除；与后端 mergeSamples 同一口径
-- 幂等：回填条件可重复执行；合并后无重复组再跑为 no-op

-- ── ① 分类回填（按归属优先级逐层收窄） ──
UPDATE signature_templates SET person_cat = '供应商人员'
 WHERE supplier_id IS NOT NULL AND COALESCE(person_cat,'') <> '供应商人员';

UPDATE signature_templates SET person_cat = '门店人员'
 WHERE supplier_id IS NULL AND ref_employee_id IS NOT NULL AND COALESCE(person_cat,'') <> '门店人员';

UPDATE signature_templates SET person_cat = '大客户人员'
 WHERE supplier_id IS NULL AND ref_employee_id IS NULL
   AND role_title ILIKE '%大客户%' AND COALESCE(person_cat,'') <> '大客户人员';

UPDATE signature_templates SET person_cat = '待确认'
 WHERE supplier_id IS NULL AND ref_employee_id IS NULL AND NOT (role_title ILIKE '%大客户%')
   AND (COALESCE(person_cat,'') NOT IN ('门店人员','供应商人员','大客户人员','待确认')
        OR person_cat = '大客户人员');

-- ── ② 同人重复合并 ──
-- 2.1 并图：组成员（含仅 image_path 无 profile.images 的旧行）的样本图去重并入主行
WITH keys AS (
  SELECT id, store_id, COALESCE(supplier_id, 0) AS sup, person_cat,
         regexp_replace(person_name, '[\s·・.。/、,，\-—_]', '', 'g') AS nname
    FROM signature_templates
),
grp AS (
  SELECT store_id, sup, person_cat, nname, MIN(id) AS master_id
    FROM keys GROUP BY 1,2,3,4 HAVING COUNT(*) > 1
),
imgs AS (
  SELECT g.master_id,
         jsonb_agg(DISTINCT x.img) AS list
    FROM grp g
    JOIN keys k ON k.store_id = g.store_id AND k.sup = g.sup
               AND k.person_cat = g.person_cat AND k.nname = g.nname
    JOIN signature_templates t ON t.id = k.id
   CROSS JOIN LATERAL jsonb_array_elements_text(
       COALESCE(NULLIF(t.profile->'images','[]'::jsonb), jsonb_build_array(t.image_path))) AS x(img)
   WHERE COALESCE(x.img,'') <> ''
   GROUP BY g.master_id
)
UPDATE signature_templates m
   SET profile      = jsonb_build_object('images', imgs.list, 'updated_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
       image_path   = COALESCE(m.image_path, imgs.list->>0),
       sample_count = LEAST(jsonb_array_length(imgs.list), 99)
  FROM imgs WHERE m.id = imgs.master_id;

-- 2.2 调用记录改指向主行（证据链留痕不丢，仅重指到合并后存活的模板；FK: signature_records_template_id_fkey）
WITH keys AS (
  SELECT id, store_id, COALESCE(supplier_id, 0) AS sup, person_cat,
         regexp_replace(person_name, '[\s·・.。/、,，\-—_]', '', 'g') AS nname
    FROM signature_templates
),
grp AS (
  SELECT store_id, sup, person_cat, nname, MIN(id) AS master_id
    FROM keys GROUP BY 1,2,3,4 HAVING COUNT(*) > 1
)
UPDATE signature_records r
   SET template_id = g.master_id
  FROM keys k, grp g
 WHERE r.template_id = k.id AND k.store_id = g.store_id AND k.sup = g.sup
   AND k.person_cat = g.person_cat AND k.nname = g.nname AND k.id <> g.master_id;

-- 2.3 删重复行（保留每组最早 id）
WITH keys AS (
  SELECT id, store_id, COALESCE(supplier_id, 0) AS sup, person_cat,
         regexp_replace(person_name, '[\s·・.。/、,，\-—_]', '', 'g') AS nname
    FROM signature_templates
),
grp AS (
  SELECT store_id, sup, person_cat, nname, MIN(id) AS master_id
    FROM keys GROUP BY 1,2,3,4 HAVING COUNT(*) > 1
)
DELETE FROM signature_templates t
 USING keys k, grp g
 WHERE t.id = k.id AND k.store_id = g.store_id AND k.sup = g.sup
   AND k.person_cat = g.person_cat AND k.nname = g.nname AND k.id <> g.master_id;
