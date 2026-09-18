-- ═══ 069: V4.15.8 P4 模版编辑器完善 + P5 多联/重打 ═══
-- 执行方式：init-db.js 语句级顺序执行；幂等
-- 内容：① print_jobs 加 biz_no/biz_id（历史按单号筛选 + A5 重打入口）
--       ② 标签预置模板（价签/秤贴，每店各一份默认）

-- 1) 打印历史：业务单号 / 业务单据 id（A5 重打凭 id 重新取数渲染）
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS biz_no VARCHAR(64);
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS biz_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_print_jobs_bizno ON print_jobs (store_id, biz_no);

-- 2) 标签预置模板（kind='标签'，业务类型 pricetag=价签 / scale=秤贴）
DO $$
DECLARE s BIGINT := (SELECT id FROM stores ORDER BY id LIMIT 1);
BEGIN
  IF s IS NULL THEN RETURN; END IF;

  INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
  SELECT s, '标准价签', '标签', 'pricetag',
   '{"title":"商品价签","fields":[
     {"key":"name","label":"品名","show":true},
     {"key":"price","label":"售价","show":true},
     {"key":"promoPrice","label":"促销价","show":true},
     {"key":"barcode","label":"条码","show":true},
     {"key":"unit","label":"单位","show":true},
     {"key":"spec","label":"规格","show":true},
     {"key":"keepDays","label":"保质期","show":true}],
    "options":{}}', true, 1
  WHERE NOT EXISTS (SELECT 1 FROM print_templates WHERE store_id=s AND biz_type='pricetag' AND kind='标签' AND name='标准价签');

  INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
  SELECT s, '标准秤贴', '标签', 'scale',
   '{"title":"称重标签","fields":[
     {"key":"name","label":"品名","show":true},
     {"key":"unitPrice","label":"单价","show":true},
     {"key":"weight","label":"重量","show":true},
     {"key":"amount","label":"金额","show":true},
     {"key":"barcode","label":"条码","show":true},
     {"key":"time","label":"称重时间","show":true}],
    "options":{}}', true, 1
  WHERE NOT EXISTS (SELECT 1 FROM print_templates WHERE store_id=s AND biz_type='scale' AND kind='标签' AND name='标准秤贴');
END $$;
