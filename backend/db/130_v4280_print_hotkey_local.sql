-- 130 · V4.27.9 打印/快捷键开关改为收银机本机记忆（F7/F3 不再写全局）
-- 层级：后台两键保留为「新收银机初始默认」；运行中的开关在收银台本机
-- （F7/F3 或收银台设置面板，存本机 localStorage，按收银机隔离互不干扰）。
UPDATE system_settings SET remark='小票自动打印的新收银机初始默认值；运行中的开关在收银台本机（F7 或收银台设置面板，仅本机生效）'
 WHERE setting_key='pos.cashier.print';
UPDATE system_settings SET remark='键盘快捷键的新收银机初始默认值；F3 总开关在收银台本机生效（仅本机）'
 WHERE setting_key='pos.cashier.hotkeys';
