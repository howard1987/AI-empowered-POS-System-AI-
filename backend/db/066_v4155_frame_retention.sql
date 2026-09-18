-- V4.15.5：AI 图片存储治理——识别帧保留天数设置（0=关闭清理；默认 30 天）
-- 配套：ai.housekeeping.ts 每 6 小时清理 frame_*.jpg（ai_samples 引用的帧永不删）；
--       AI_UPLOADS_DIR 环境变量可外置图片目录；新图按月分目录 uploads/YYYY-MM/

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
 ('AI', 'ai.frames.retention_days', '识别帧保留天数', '30', '30', 'num',
  'AI 识别过程帧只保留 N 天，到期自动清理释放磁盘（每 6 小时执行一轮）；已进样本库的图片不受影响永久保留；0=关闭自动清理')
ON CONFLICT (setting_key) DO NOTHING;
