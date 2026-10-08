-- V5.0.17b：AI 识别设置项「正名」批
--   背景：向量检索层（layer clip/clip-multi/clip-cand，代码已正名为 emb/emb-multi/emb-cand）
--   自 V5.0.13 起默认编码器是 PP-ShiTuV2（PPLCNetV2 度量学习），Chinese-CLIP 仅为可配置回滚引擎，
--   但多个设置项的名称/注明仍停留在 V4.11「CLIP 是主力」的语境，会误导排查与调参。
--   同时补注册 ai.feature.engine —— 该键 ai.emb.ts:31 一直在读、却从未登记进 system_settings，
--   设置页完全看不到（属"引擎在用但无配置入口"缺口）。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。

-- ① 补注册向量检索特征引擎（真实在用：ai.emb.ts featureEngine()/activeTag()/embedImage()）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark)
VALUES ('AI识别', 'ai.feature.engine', '向量检索特征引擎', '"auto"', '"auto"', 'enum',
  '[{"v":"auto","label":"自动（默认：PP-ShiTuV2 模型在即用之，缺失自动回退）"},{"v":"ppshitu","label":"PP-ShiTuV2（度量学习，区分度约为 CLIP 的 20 倍，推荐）"},{"v":"clipcn","label":"Chinese-CLIP（旧引擎，支持瓶身文字佐证）"}]'::jsonb,
  '识别「向量检索层」的图像编码引擎：把识别帧/裁剪件编码成向量，再与样本库向量比对。auto=PP-ShiTuV2 模型文件（backend/models/ppshituv2_general.onnx）存在即用之，缺失自动回退 Chinese-CLIP。两引擎阈值各自成组：ai.emb.pp.*（PP）与 ai.emb.*（CLIP）；切换后旧向量视为过期，需在 AI 训练台重建索引。PP-ShiTu 无文本塔，「瓶身文字佐证」仅在 Chinese-CLIP 引擎下生效')
ON CONFLICT (setting_key) DO NOTHING;

-- ② display_name 正名（去掉 CLIP 主语，改为引擎中立的向量检索语义）
UPDATE system_settings SET display_name='向量检索开关'        WHERE setting_key='ai.emb.enabled';
UPDATE system_settings SET display_name='Top1-Top2 边距'     WHERE setting_key='ai.emb.margin';
UPDATE system_settings SET display_name='自动采信阈值'        WHERE setting_key='ai.emb.min_conf';
UPDATE system_settings SET display_name='高置信快速通道'      WHERE setting_key='ai.emb.strict_conf';
UPDATE system_settings SET display_name='候选张数'           WHERE setting_key='ai.emb.topk';
UPDATE system_settings SET display_name='多件识别'           WHERE setting_key='ai.multi.enabled';

-- ③ remark 修正（与真实用途对齐）
UPDATE system_settings SET remark='实时识别的图像主路径：样本向量检索（毫秒级，编码引擎见「向量检索特征引擎」）；关闭后直接走 dHash/VL 兜底。本组阈值适用于 Chinese-CLIP 引擎，PP-ShiTu 引擎请用 ai.emb.pp.* 同名项'
 WHERE setting_key='ai.emb.enabled';
UPDATE system_settings SET remark='Top1 须领先 Top2 至少该差值才自动命中；不足则转候选卡片由店员点选。适用于 Chinese-CLIP 引擎，PP-ShiTu 引擎请用 ai.emb.pp.margin'
 WHERE setting_key='ai.emb.margin';
UPDATE system_settings SET remark='Top-1 相似度达到该值自动命中；未达则携带候选卡片走兜底/人工确认。适用于 Chinese-CLIP 引擎，PP-ShiTu 引擎请用 ai.emb.pp.min_conf'
 WHERE setting_key='ai.emb.min_conf';
UPDATE system_settings SET remark='Top-1 达到该值视为近乎样本复拍，无需边距直接命中。适用于 Chinese-CLIP 引擎，PP-ShiTu 引擎请用 ai.emb.pp.strict_conf'
 WHERE setting_key='ai.emb.strict_conf';
UPDATE system_settings SET remark='向量检索返回的候选商品数（识别→候选卡片→店员点选确认）'
 WHERE setting_key='ai.emb.topk';
UPDATE system_settings SET remark='俯拍多件场景：定位（「多件定位模型」或零训练轮廓分割）→ 逐件裁剪向量检索 → 按商品聚合计数；单件画面自动回落单件管线'
 WHERE setting_key='ai.multi.enabled';
UPDATE system_settings SET remark='图文对齐信号对候选排序的最大拉动（0~0.3，越大越信瓶身文字）。注意：瓶身文字佐证仅在 Chinese-CLIP 引擎下生效，PP-ShiTu 无文本塔，此项自动失效'
 WHERE setting_key='ai.rerank.text_weight';
UPDATE system_settings SET remark='VL 兜底识别与 YOLO 检测（识别引擎=vl/yolo）的最低采信置信度，低于该值的检出结果被丢弃；并非「低于它才触发兜底」的开关'
 WHERE setting_key='ai.fallback_conf';