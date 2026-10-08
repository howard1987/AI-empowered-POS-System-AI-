-- V5.0.18g 候选展示阈值（用户需求：上百 SKU 建库后，低置信商品不得涌入候选卡片淹没收银员判定）
-- 纯展示过滤：只影响候选卡片，不影响自动命中判定（gateClip 三门槛独立判）。
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('ai.emb.pp.cand_min_conf', 'AI识别', '候选展示阈值(PP-ShiTu)', '0.10', '0.10', 'number',
  '低于该图像相似度的检索结果不进候选卡片（纯展示过滤，不影响自动命中线）。PP 空间跨商品噪声通常 ≤0.09，类内 0.1~0.85')
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('ai.emb.cand_min_conf', 'AI识别', '候选展示阈值(CLIP)', '0.40', '0.40', 'number',
  '低于该图像相似度的检索结果不进候选卡片。适用于 Chinese-CLIP 引擎（量纲与 PP-ShiTu 完全不同）')
ON CONFLICT (setting_key) DO NOTHING;
