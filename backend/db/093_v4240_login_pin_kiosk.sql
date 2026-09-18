-- ═══ V4.24.0 收银端登录与退班体验（093）═══
-- 背景（老板实测反馈 9 项）：
--   ① 登录界面照银豹仿（标题栏 + 卡片 + 窗口按钮 + 交接班记录入口）
--   ② 收银台退出缺「交接班 → 日结（含打印小票）」步骤
--   ③ 小眼睛要在密码框内
--   ④ 收银端缺「查看库存」快捷键与弹窗
--   ⑤「关闭程序」改为窗口 最小化/最大化/关闭 三按钮
--   ⑥ 不能写死 ADMIN/admin123：改为首次启动检测无管理员则引导创建
--   ⑦ 「全屏 + 不可切走」的强 kiosk 应作后台开关而非默认
--   ⑧ 挂单只拦本人/本班（需 held_by / shift_id 过滤）
--   ⑨ 登录升级为「只记工号 + 记住 PIN」
-- 本文件：⑥⑨ 的数据结构 + ⑦ 的开关种子。幂等，可重复执行。

-- ── ① PIN 登录：工号 + PIN 免密码快速登录（与登录密码独立、bcrypt 存储）──
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMPTZ;

-- 已设过 PIN 的员工：清空旧的明文风险（本列为新增，无需回填）

-- ── ② 强 Kiosk 开关（⑦）：默认关；开=全屏强制置顶（Alt+Tab 也切不走）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '设备管理', 'pos.desktop.kiosk_topmost', '全屏强制置顶（强 Kiosk）',
       'false'::jsonb, 'false'::jsonb, 'bool',
       '开=收银台全屏并强制置顶（盖住任务栏、Alt+Tab 也切不走，适合顾客可触碰的收银机）；关=全屏但可切换其他程序（默认）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'pos.desktop.kiosk_topmost');

-- ── ③ 快捷功能「库存查询」按键映射随 hotkey_map 走，无需新设置键 ──
-- V4.21.0 的 pos.cashier.hotkey_map 为 JSON，新增 stock 槽位；此处仅补默认值说明（不改动门店已存值）
UPDATE system_settings
   SET remark = '收银台键位映射 JSON：pay/hold/take/repeat/print/lock/stock 七槽；stock=库存查询（默认 F10）'
 WHERE setting_key = 'pos.cashier.hotkey_map';
