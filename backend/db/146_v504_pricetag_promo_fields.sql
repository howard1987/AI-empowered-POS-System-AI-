-- V5.0.4：标准价签（v2 可视化模板）追加「特价角标」「特价有效期」元素
-- 有促销价时自动印「特价」字样 + 有效期（合规要求），默认显示，可在模板编辑器关闭
-- 仅作用于未加过这两个元素的 v2 标准价签模板（幂等）
UPDATE print_templates
SET content = jsonb_set(
  content, '{elements}',
  COALESCE(content->'elements', '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('id','epromoTag','type','field','key','promoTag','x',27,'y',9,'w',11,'h',4,'fontSize',3,'align','right','show',true),
    jsonb_build_object('id','epromoPeriod','type','field','key','promoPeriod','x',2,'y',20.5,'w',36,'h',3,'fontSize',2.5,'align','left','show',true)
  ))
WHERE kind='标签' AND biz_type='pricetag' AND name='标准价签'
  AND content->>'version'='2'
  AND NOT (content->'elements' @> '[{"key":"promoTag"}]');
