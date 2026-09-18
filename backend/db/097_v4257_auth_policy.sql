-- ═══ V4.25.7 店长授权策略可配置（097）═══
-- 背景（老板需求）：①「授权复用」与「店长本人操作是否免输授权码」两个开关放到
--   后台「系统设置 → 设备管理」中配置，收银端自动同步生效；② 授权码管理移到后台员工管理。
-- 本文件：两个授权策略设置种子。幂等，可重复执行。

-- ── ① 授权复用：batch=一次授权后本单/120 秒内连续改价免再输码（默认）；once=每次改价都弹窗输码 ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '设备管理', 'pos.price.auth_reuse', '改价授权复用',
       '"batch"'::jsonb, '"batch"'::jsonb, 'enum',
       '收银员改价/打折的授权频次：batch=一次授权后本单连续操作免再输码（票据120秒、结算作废）；once=每次改价都弹窗要求店长输授权码'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'pos.price.auth_reuse');

-- ── ② 店长本人操作：on=店长（持授权资格者）自己在收银台改价时免输授权码（静默自授权，仍留痕）；off=店长本人也需输码 ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '设备管理', 'pos.price.auth_self', '店长本人免输授权码',
       '"off"'::jsonb, '"off"'::jsonb, 'enum',
       'on=持「改价/折扣授权」权限的员工本人在收银台操作价格时自动授权免输码（仍留痕，授权人=操作人）；off=本人操作同样需要输授权码（责任最严）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'pos.price.auth_self');
