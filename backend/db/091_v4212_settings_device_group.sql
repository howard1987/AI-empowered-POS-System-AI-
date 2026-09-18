-- ═══ V4.21.2 系统设置整改：收银台/收银合并「设备管理」+ 选项人性化（091）═══
-- 背景：Web 后台设置页按 group_name 分组渲染；「收银台」「收银」两组碎片化，
--       且 number 型开关显示 1/0、JSON 型（折扣预设/客显轮播/键位映射）裸 JSON 看不懂。
-- 方案：分组物理合并 + 类型改造（bool/enum），前端配合结构化编辑器。

-- ── ① 分组合并：收银台 + 收银 → 设备管理（收银机授权 pos.device.auth 所在组一并并入）──
UPDATE system_settings SET group_name = '设备管理'
 WHERE group_name IN ('收银台', '收银');

-- ── ② 新版收银台开关：number 1/0 → bool（前台显示 开/关 拨杆）──
UPDATE system_settings
   SET value_type   = 'bool',
       value        = to_jsonb((value#>>'{}')::int = 1),
       default_value= to_jsonb((default_value#>>'{}')::int = 1),
       remark       = '开=登录直落新收银台；关=回退旧版「作业-收银」视图（严重问题一键回退预案）'
 WHERE setting_key = 'pos.cashier.new_ui' AND value_type = 'number';

-- ── ③ 库存硬拦：number 0/1 → enum 是/否（下拉中文选项）──
UPDATE system_settings
   SET value_type  = 'enum',
       enum_options = '[{"v":1,"label":"是（超库存一律拒绝）"},{"v":0,"label":"否（容许负库存+留痕）"}]'::jsonb,
       display_name = '库存硬拦',
       remark       = '是=账实不符时超库存一律拒绝（谨慎型门店）；否=确认后按负库存售卖（留痕进负库存清单）'
 WHERE setting_key = 'pos.cashier.stock_hard' AND value_type = 'number';

-- ── ④ 锁屏闲置超时：默认 5 → 15 分钟（门店已显式改过的不动，只抬默认）──
UPDATE system_settings
   SET default_value = '15'::jsonb,
       remark        = '收银台无操作自动锁屏时间（1~30 分钟，0=不自动锁）；默认 15 分钟'
 WHERE setting_key = 'pos.cashier.lock_timeout';
UPDATE system_settings SET value = '15'::jsonb
 WHERE setting_key = 'pos.cashier.lock_timeout' AND (value#>>'{}') = '5';

-- ── ⑤ 重复扫防抖：number 1/0 → bool（开=同码 2 秒内连扫不重复加件）──
UPDATE system_settings
   SET value_type   = 'bool',
       value        = to_jsonb((value#>>'{}')::int = 1),
       default_value= 'true'::jsonb,
       remark       = '开=同码 2 秒内连扫不重复加件（弹条可撤销，默认 2 秒）；关=关闭防抖'
 WHERE setting_key = 'pos.cashier.debounce' AND value_type = 'number';
