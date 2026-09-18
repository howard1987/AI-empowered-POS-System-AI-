-- ═══════════════════════════════════════════════════════════════════════════
-- 004 报表中心收尾（T13，方案 4.7 / 14.6.3）：日报目标设置项
-- 规范：禁改 001 基线；本文件幂等，可重复执行
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('收银与小票','report.daily_target','日销售目标（元）','0','0','number','>0 时日报显示达成率；0=不设目标')
ON CONFLICT (setting_key) DO NOTHING;
