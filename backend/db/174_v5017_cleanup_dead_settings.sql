-- V5.0.17：清理已明确废弃的设置项（前后端零引用，改了也不生效）
--   依据：backend/tools/audit-settings.mjs 全量核查 267 个设置项的结果（前后端均无引用）。
--   本次仅清理「证据最硬」的一项，其余 9 项因可能仍在前端本地逻辑/待产品决策，暂保留并已在
--   核查报告中列出，避免误删用户已配置的值。
--
--   ai.vlm_fallback「本地大模型兜底」：功能已随 Qwen-VL 方案移除而废弃
--   （当前识别链路为 条码 → PP-ShiTuTuV2/CLIP 向量检索 → dHash 样本匹配 → YOLO/轮廓定位），
--   代码中已无任何读取，remark 仍指向已不用的 Qwen-VL GGUF 9.2.7，属误导性残留。
DELETE FROM system_settings WHERE setting_key = 'ai.vlm_fallback';