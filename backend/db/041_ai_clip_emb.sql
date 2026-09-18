-- 041_ai_clip_emb.sql
-- V4.10.1 · M2 实时识别提速（CLIP 向量检索层）
--   1) ai_samples 增加向量索引列：embedding(JSONB 512维) / emb_model / emb_at
--      pgvector 在本机 PG 不可用 → JSONB + 应用层余弦（数千样本内毫秒级）
--   2) 系统设置：ai.emb.enabled（默认开）/ ai.emb.min_conf（0.90）/ ai.emb.strict_conf（0.97）
--                / ai.emb.margin（Top1-Top2 边距 0.03）/ ai.emb.topk（候选卡片张数）
-- 阈值标定（2026-09-08，31 张真实样本 465 对相似度实测）：
--   同商品对不同角度：p25=0.95 / p5=0.915 / min=0.875；纯背景（灰图）≈0.874；跨商品 p95=0.961（含近重复样本对）
--   → min_conf=0.90 拒绝纯背景、保留绝大多数真实命中；strict_conf=0.97 快速通道覆盖 self-match（1.0，
--     边距仅 0.027）场景；margin=0.03 拦截易混 SKU（V4.10.2 实测：益达口香糖实拍帧 宜简水 0.961 vs 益达 0.939，
--     边距 0.021 → 不自动采信，候选卡片店员点选），未自动命中一律携带候选卡片人工确认。
-- 识别管线分工（方案 v3.1）：条码先行（前端，conf=1）→ CLIP 向量检索（本迁移配套）→ VL 兜底 → dHash → 扫码枪/人工

ALTER TABLE ai_samples ADD COLUMN IF NOT EXISTS embedding jsonb;
ALTER TABLE ai_samples ADD COLUMN IF NOT EXISTS emb_model varchar(64);
ALTER TABLE ai_samples ADD COLUMN IF NOT EXISTS emb_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_ai_samples_emb_ready
  ON ai_samples (store_id, product_id)
  WHERE embedding IS NOT NULL;

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
  ('AI 引擎', 'ai.emb.enabled', 'CLIP 向量检索', 'true'::jsonb, 'true'::jsonb, 'bool',
   '实时识别的图像主路径：样本向量检索（毫秒级），关闭后直接走 VL/dHash'),
  ('AI 引擎', 'ai.emb.min_conf', 'CLIP 自动采信阈值', '0.9'::jsonb, '0.9'::jsonb, 'number',
   'Top-1 相似度达到该值才进入命中判定（实测标定：纯背景≈0.87，同商品 p5≈0.915）；未达则走 VL/人工链路'),
  ('AI 引擎', 'ai.emb.strict_conf', 'CLIP 高置信快速通道', '0.97'::jsonb, '0.97'::jsonb, 'number',
   'Top-1 达到该值视为近乎样本复拍，无需边距直接命中（self-match≈1.0 但同库聚簇 0.95+，边距可能不足）'),
  ('AI 引擎', 'ai.emb.margin', 'CLIP Top1-Top2 边距', '0.03'::jsonb, '0.03'::jsonb, 'number',
   'Top-1 未达快速通道时须领先 Top-2 至少该边距才自动命中；不足 → 候选卡片店员点选（防易混 SKU 误判，实测益达口香糖 vs 宜简水边距仅 0.021）'),
  ('AI 引擎', 'ai.emb.topk', 'CLIP 候选张数', '3'::jsonb, '3'::jsonb, 'number',
   '向量检索返回的候选商品数（识别→候选卡片→店员点选确认）')
ON CONFLICT (setting_key) DO NOTHING;
