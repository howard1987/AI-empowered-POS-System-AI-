-- ═══════════════════════════════════════════════════════════════
-- 158_ai_ocr_engine.sql（T3 增强）：OCR 引擎地址配置
--   架构：专用 OCR 引擎做主力文本提取；留空则回退本地大模型(Ollama)看图识字
-- ═══════════════════════════════════════════════════════════════
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('AI与设备', 'ai.ocr.engine_url', 'OCR引擎地址', '', '', 'string', '专用 OCR 引擎（如 PaddleOCR）的 HTTP 地址，例如 http://127.0.0.1:9000/ocr；留空则回退本地大模型(Ollama)看图识字')
ON CONFLICT (setting_key) DO NOTHING;
