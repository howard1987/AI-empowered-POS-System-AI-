-- ═══ 070: V4.15.9 可视化模版排版编辑器 ═══
-- 执行方式：init-db.js 语句级顺序执行；幂等
-- 内容：标准价签/秤贴预置模板升级为 version:2 排版 JSON（elements mm 坐标，可拖拽编辑）
--       仅升级「未被编辑过」的 v1 模板（content->>'version' 为空才动；用户改过的不动）
-- 说明：content 为 jsonb，无需改表结构；v2 schema：
--   { version:2, title, paper:{wmm,hmm}, elements:[{id,type,x,y,w,h,text,key,label,fontSize,bold,align,rotate,show}] }

-- 1) 标准价签 40x30：品名居中 → 售价大字（有促销价自动划线）→ 单位·规格·保质期 → 条码
UPDATE print_templates SET content = '{
  "version": 2, "title": "商品价签", "paper": {"wmm": 40, "hmm": 30},
  "elements": [
    {"id":"e1","type":"field","key":"name","x":2,"y":1.5,"w":36,"h":5,"fontSize":3,"align":"center","show":true},
    {"id":"e2","type":"field","key":"price","x":2,"y":8,"w":22,"h":7,"fontSize":6,"align":"left","show":true},
    {"id":"e3","type":"field","key":"info","x":2,"y":17,"w":36,"h":4,"fontSize":2.5,"align":"left","show":true},
    {"id":"e4","type":"barcode","key":"barcode","x":3,"y":22,"w":34,"h":7.5,"show":true}
  ]}'::jsonb
WHERE kind='标签' AND biz_type='pricetag' AND name='标准价签'
  AND content->>'version' IS NULL;

-- 2) 标准秤贴 40x30：品名+时间 → 单价/重量 → 金额大字 → 条码
UPDATE print_templates SET content = '{
  "version": 2, "title": "称重标签", "paper": {"wmm": 40, "hmm": 30},
  "elements": [
    {"id":"e1","type":"field","key":"name","x":2,"y":1.5,"w":26,"h":5,"fontSize":3,"align":"left","show":true},
    {"id":"e2","type":"field","key":"time","x":28,"y":2,"w":10,"h":4,"fontSize":2,"align":"right","show":true},
    {"id":"e3","type":"field","key":"unitPrice","x":2,"y":8,"w":22,"h":4,"fontSize":2.5,"align":"left","show":true},
    {"id":"e4","type":"field","key":"weight","x":2,"y":13,"w":22,"h":4,"fontSize":2.5,"align":"left","show":true},
    {"id":"e5","type":"field","key":"amount","x":2,"y":17.5,"w":24,"h":6,"fontSize":5,"align":"left","show":true},
    {"id":"e6","type":"barcode","key":"barcode","x":3,"y":24,"w":34,"h":5.5,"show":true}
  ]}'::jsonb
WHERE kind='标签' AND biz_type='scale' AND name='标准秤贴'
  AND content->>'version' IS NULL;
