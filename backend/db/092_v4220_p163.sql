-- V4.22.0 P16 批3：设置本机化备注（grid_cols 已改为收银台本机设置；后台值仅作新机初始默认）
-- 幂等：UPDATE 天然幂等
UPDATE system_settings SET remark = '本机设置：在收银台「设置」面板调整，仅本机生效；此处值仅作新收银台初始默认'
 WHERE setting_key = 'pos.cashier.grid_cols';
