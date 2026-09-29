-- ═══ 147: V5.0.5 常用价签模板预置 ═══
-- 执行方式：init-db.js 语句级顺序执行；幂等
-- 内容：把用户提供的 5 款常见物价局监制/特价/醒目/大规格版式预置到模板库。
--       标签机多为单色热敏，因此彩色（红框/黄底）以黑框+文字模拟；字段位置按图片版式摆放。
--       不强制设默认，避免覆盖用户现有默认模板；用户可在「打印中心→打印模板」里选用。

DO $$
DECLARE
  s RECORD;
  t50_gov jsonb;
  t70_gov jsonb;
  t70_promo jsonb;
  t50_yellow jsonb;
  t90_white jsonb;
BEGIN
  t50_gov := $JSON$
{
  "version": 2, "title": "商品标价签",
  "paper": {"wmm": 50, "hmm": 30},
  "elements": [
    {"id":"r1","type":"rect","x":1,"y":1,"w":48,"h":28,"th":0.5,"show":true},
    {"id":"t_title","type":"text","x":2,"y":2,"w":22,"h":4,"fontSize":3,"bold":true,"text":"商品标价签","show":true},
    {"id":"l_top","type":"line","x":1,"y":7,"w":48,"h":0.3,"show":true},
    {"id":"kv_name","type":"kv","x":3,"y":8,"w":44,"h":4,"fontSize":2.5,"label":"品名：","key":"name","show":true},
    {"id":"kv_unit","type":"kv","x":3,"y":13,"w":20,"h":3.5,"fontSize":2,"label":"单位：","key":"unit","show":true},
    {"id":"kv_spec","type":"kv","x":25,"y":13,"w":20,"h":3.5,"fontSize":2,"label":"规格：","key":"spec","show":true},
    {"id":"kv_barcode","type":"kv","x":3,"y":17,"w":24,"h":3.5,"fontSize":2,"label":"条码：","key":"barcode","show":true},
    {"id":"kv_keep","type":"kv","x":25,"y":17,"w":20,"h":3.5,"fontSize":2,"label":"保质：","key":"keepDays","show":true},
    {"id":"t_retail","type":"text","x":32,"y":10,"w":15,"h":3,"fontSize":2.5,"align":"center","text":"零售价","show":true},
    {"id":"f_price","type":"field","x":30,"y":13,"w":18,"h":7,"fontSize":5,"align":"center","key":"price","show":true},
    {"id":"t_member","type":"text","x":32,"y":21,"w":15,"h":3,"fontSize":2,"align":"center","text":"会员价","show":true},
    {"id":"f_member","type":"field","x":30,"y":24,"w":18,"h":4,"fontSize":3,"align":"center","key":"memberPrice","show":true},
    {"id":"t_footer","type":"text","x":3,"y":26,"w":44,"h":2.5,"fontSize":1.8,"text":"物价局监制 监督电话：12315","show":true}
  ]
}
$JSON$::jsonb;

  t70_gov := $JSON$
{
  "version": 2, "title": "商品标价签",
  "paper": {"wmm": 70, "hmm": 38},
  "elements": [
    {"id":"r1","type":"rect","x":1,"y":1,"w":68,"h":36,"th":0.5,"show":true},
    {"id":"t_title","type":"text","x":2,"y":2,"w":24,"h":5,"fontSize":3.5,"bold":true,"text":"商品标价签","show":true},
    {"id":"l_top","type":"line","x":1,"y":8,"w":68,"h":0.3,"show":true},
    {"id":"kv_name","type":"kv","x":3,"y":9,"w":64,"h":5,"fontSize":3,"label":"品名：","key":"name","show":true},
    {"id":"kv_unit","type":"kv","x":3,"y":15,"w":28,"h":4,"fontSize":2.5,"label":"单位：","key":"unit","show":true},
    {"id":"kv_spec","type":"kv","x":33,"y":15,"w":28,"h":4,"fontSize":2.5,"label":"规格：","key":"spec","show":true},
    {"id":"kv_barcode","type":"kv","x":3,"y":20,"w":32,"h":4,"fontSize":2.5,"label":"条码：","key":"barcode","show":true},
    {"id":"kv_keep","type":"kv","x":33,"y":20,"w":28,"h":4,"fontSize":2.5,"label":"保质：","key":"keepDays","show":true},
    {"id":"t_retail","type":"text","x":45,"y":12,"w":22,"h":4,"fontSize":3,"align":"center","text":"零售价","show":true},
    {"id":"f_price","type":"field","x":42,"y":16,"w":26,"h":10,"fontSize":7,"align":"center","key":"price","show":true},
    {"id":"t_member","type":"text","x":45,"y":28,"w":22,"h":3,"fontSize":2.5,"align":"center","text":"会员价","show":true},
    {"id":"f_member","type":"field","x":42,"y":31.5,"w":26,"h":5,"fontSize":4,"align":"center","key":"memberPrice","show":true},
    {"id":"t_footer","type":"text","x":3,"y":34,"w":64,"h":3,"fontSize":2,"text":"物价局监制 监督电话：12315","show":true}
  ]
}
$JSON$::jsonb;

  t70_promo := $JSON$
{
  "version": 2, "title": "特价促销签",
  "paper": {"wmm": 70, "hmm": 38},
  "elements": [
    {"id":"r1","type":"rect","x":1,"y":1,"w":68,"h":36,"th":0.5,"show":true},
    {"id":"f_name","type":"field","x":3,"y":2,"w":64,"h":6,"fontSize":4,"key":"name","show":true},
    {"id":"r_promo","type":"rect","x":3,"y":9,"w":28,"h":24,"th":0.5,"show":true},
    {"id":"t_promo_tag","type":"text","x":5,"y":11,"w":12,"h":4,"fontSize":3,"bold":true,"text":"特价","show":true},
    {"id":"f_promo_price","type":"field","x":5,"y":15,"w":24,"h":10,"fontSize":7,"align":"center","key":"promoPrice","show":true},
    {"id":"kv_origin_price","type":"kv","x":5,"y":26,"w":24,"h":4,"fontSize":2.5,"label":"原价：","key":"price","show":true},
    {"id":"kv_unit","type":"kv","x":35,"y":12,"w":30,"h":4,"fontSize":2.5,"label":"单位：","key":"unit","show":true},
    {"id":"kv_spec","type":"kv","x":35,"y":17,"w":30,"h":4,"fontSize":2.5,"label":"规格：","key":"spec","show":true},
    {"id":"kv_keep","type":"kv","x":35,"y":22,"w":30,"h":4,"fontSize":2.5,"label":"保质：","key":"keepDays","show":true},
    {"id":"bc_barcode","type":"barcode","x":35,"y":27,"w":32,"h":6,"key":"barcode","show":true},
    {"id":"t_footer","type":"text","x":3,"y":34,"w":64,"h":3,"fontSize":2,"text":"价格投诉举报电话：12315","show":true}
  ]
}
$JSON$::jsonb;

  t50_yellow := $JSON$
{
  "version": 2, "title": "醒目标价签",
  "paper": {"wmm": 50, "hmm": 30},
  "elements": [
    {"id":"r1","type":"rect","x":1,"y":1,"w":48,"h":28,"th":0.6,"show":true},
    {"id":"kv_name","type":"kv","x":3,"y":2.5,"w":44,"h":4,"fontSize":2.5,"label":"品名：","key":"name","show":true},
    {"id":"kv_unit","type":"kv","x":3,"y":8,"w":20,"h":3.5,"fontSize":2,"label":"单位：","key":"unit","show":true},
    {"id":"kv_spec","type":"kv","x":25,"y":8,"w":20,"h":3.5,"fontSize":2,"label":"规格：","key":"spec","show":true},
    {"id":"kv_keep","type":"kv","x":3,"y":12.5,"w":20,"h":3.5,"fontSize":2,"label":"保质：","key":"keepDays","show":true},
    {"id":"kv_barcode","type":"kv","x":3,"y":17,"w":24,"h":3.5,"fontSize":2,"label":"条码：","key":"barcode","show":true},
    {"id":"t_retail","type":"text","x":32,"y":8,"w":15,"h":3,"fontSize":2.5,"align":"center","text":"零售价","show":true},
    {"id":"f_price","type":"field","x":28,"y":11,"w":20,"h":9,"fontSize":6,"align":"center","key":"price","show":true},
    {"id":"t_member","type":"text","x":32,"y":21,"w":15,"h":3,"fontSize":2,"align":"center","text":"会员价","show":true},
    {"id":"f_member","type":"field","x":28,"y":24,"w":20,"h":4,"fontSize":3,"align":"center","key":"memberPrice","show":true},
    {"id":"t_footer","type":"text","x":3,"y":26,"w":44,"h":2.5,"fontSize":1.8,"text":"物价局监制 监督电话：12315","show":true}
  ]
}
$JSON$::jsonb;

  t90_white := $JSON$
{
  "version": 2, "title": "标准价签",
  "paper": {"wmm": 90, "hmm": 50},
  "elements": [
    {"id":"r1","type":"rect","x":1,"y":1,"w":88,"h":48,"th":0.5,"show":true},
    {"id":"kv_name","type":"kv","x":3,"y":3,"w":54,"h":6,"fontSize":3.5,"label":"品名：","key":"name","show":true},
    {"id":"kv_unit","type":"kv","x":3,"y":11,"w":26,"h":4,"fontSize":2.5,"label":"单位：","key":"unit","show":true},
    {"id":"kv_spec","type":"kv","x":33,"y":11,"w":26,"h":4,"fontSize":2.5,"label":"规格：","key":"spec","show":true},
    {"id":"kv_keep","type":"kv","x":3,"y":17,"w":26,"h":4,"fontSize":2.5,"label":"保质：","key":"keepDays","show":true},
    {"id":"kv_barcode","type":"kv","x":33,"y":17,"w":26,"h":4,"fontSize":2.5,"label":"条码：","key":"barcode","show":true},
    {"id":"bc_barcode","type":"barcode","x":3,"y":23,"w":40,"h":8,"key":"barcode","show":true},
    {"id":"t_retail","type":"text","x":55,"y":12,"w":32,"h":4,"fontSize":3,"align":"center","text":"零售价","show":true},
    {"id":"f_price","type":"field","x":55,"y":17,"w":32,"h":14,"fontSize":9,"align":"center","key":"price","show":true},
    {"id":"kv_print_date","type":"kv","x":55,"y":34,"w":32,"h":4,"fontSize":2.5,"label":"打印日期：","key":"printDate","show":true},
    {"id":"t_footer","type":"text","x":3,"y":42,"w":84,"h":3,"fontSize":2,"text":"物价局监制 监督电话：12315","show":true}
  ]
}
$JSON$::jsonb;

  FOR s IN SELECT id FROM stores LOOP
    INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
    SELECT s.id, '物价局监制 50×30', '标签', 'pricetag', t50_gov, false, 1
    WHERE NOT EXISTS (SELECT 1 FROM print_templates WHERE store_id=s.id AND kind='标签' AND biz_type='pricetag' AND name='物价局监制 50×30');

    INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
    SELECT s.id, '物价局监制 70×38', '标签', 'pricetag', t70_gov, false, 1
    WHERE NOT EXISTS (SELECT 1 FROM print_templates WHERE store_id=s.id AND kind='标签' AND biz_type='pricetag' AND name='物价局监制 70×38');

    INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
    SELECT s.id, '特价促销 70×38', '标签', 'pricetag', t70_promo, false, 1
    WHERE NOT EXISTS (SELECT 1 FROM print_templates WHERE store_id=s.id AND kind='标签' AND biz_type='pricetag' AND name='特价促销 70×38');

    INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
    SELECT s.id, '黄底醒目 50×30', '标签', 'pricetag', t50_yellow, false, 1
    WHERE NOT EXISTS (SELECT 1 FROM print_templates WHERE store_id=s.id AND kind='标签' AND biz_type='pricetag' AND name='黄底醒目 50×30');

    INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
    SELECT s.id, '标准白底 90×50', '标签', 'pricetag', t90_white, false, 1
    WHERE NOT EXISTS (SELECT 1 FROM print_templates WHERE store_id=s.id AND kind='标签' AND biz_type='pricetag' AND name='标准白底 90×50');
  END LOOP;
END $$;
