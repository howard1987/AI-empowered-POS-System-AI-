-- 100 · V4.27.0 AI 多件识别升级（借鉴 ultralytics）：YOLO 检测式定位 + 多帧跟踪平滑
-- 原则：幂等（ON CONFLICT DO NOTHING）；代码侧全部带默认值回落，缺本迁移不影响运行

-- ── 设置种子 ──
-- ai.seg.model_id：多件识别定位模型（ai_models.id）。指定后多件识别优先用该 detect 模型框出每件商品
--   （单类 "商品" 检测模型，训练包见 backend/ai-train/），0=沿用零训练轮廓分割（ai.seg.ts）
-- ai.track.*：连续帧跟踪平滑，只做"稳定确认"标注与置信度 EMA 展示，不改变三门槛命中判定（铁律不变）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('AI赋能','ai.seg.model_id','多件定位模型','0','0','number','多件识别定位模型（ai_models.id，建议单类 detect 模型；0=轮廓分割兜底，backend/ai-train 训练包产出）'),
('AI赋能','ai.seg.yolo_min_conf','YOLO 定位置信度','0.25','0.25','number','定位模型检出框的最低置信度（低于则丢弃该框）'),
('AI赋能','ai.track.enabled','多帧跟踪平滑','true','true','bool','连续帧同品命中做 IoU/同品匹配与稳定标注（不改变命中判定门槛）'),
('AI赋能','ai.track.stable_frames','稳定确认帧数','2','2','number','连续命中同一商品达到该帧数即标记「稳定确认」')
ON CONFLICT (setting_key) DO NOTHING;
