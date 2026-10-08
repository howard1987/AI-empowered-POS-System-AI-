-- V5.0.17：OCR / 入库低价保护类设置项归位到正确分组
--   背景：ai.ocr.* 四个设置项历史上都被塞在「AI与设备」分组，但语义分属两处：
--     1) ai.ocr.engine_url（OCR引擎地址）+ ai.ocr.vl_model（票据OCR视觉模型）属 AI 识别域
--        -> 迁到「AI识别」，与「识别帧与票据 OCR」卡片并列。
--     2) ai.ocr.low_price / ai.ocr.low_price_mode 是「入库低价保护」，属进销存业务域，
--        与 OCR 毫无关系，只是历史上借用了 ai.ocr.* 前缀 -> 迁到「商品管理」。
--   同时澄清两个 OCR 设置项的关系（不冲突，是两级串联）：
--        专用 OCR 引擎(engine_url) 负责「认字」；仅当它未部署/不可达时，
--        才回退到 Ollama 多模态(vl_model) 直接「看图识字」。见 ai.ocr.ts recognizeDocument。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。

UPDATE system_settings SET group_name = 'AI识别' WHERE setting_key = 'ai.ocr.engine_url';
UPDATE system_settings SET group_name = 'AI识别' WHERE setting_key = 'ai.ocr.vl_model';
UPDATE system_settings SET group_name = '商品管理' WHERE setting_key = 'ai.ocr.low_price';
UPDATE system_settings SET group_name = '商品管理' WHERE setting_key = 'ai.ocr.low_price_mode';

UPDATE system_settings SET remark = '专用 OCR 引擎（如 PaddleOCR）的 HTTP 地址，例如 http://127.0.0.1:9000/ocr。优先用它认字；留空或不可达时才回退到下方「票据OCR视觉模型」看图识字（二者是两级串联，不重复）'
 WHERE setting_key = 'ai.ocr.engine_url';
UPDATE system_settings SET remark = '本地多模态模型（Ollama）。仅当未配置或连不上「OCR引擎地址」时，才用它直接看图识字；正常装了专用 OCR 引擎时此项不生效'
 WHERE setting_key = 'ai.ocr.vl_model';
UPDATE system_settings SET remark = '入库价低于历史最低进价时拦截（可强推）。属进销存业务规则，与 OCR 无关，放在「商品管理」'
 WHERE setting_key = 'ai.ocr.low_price';