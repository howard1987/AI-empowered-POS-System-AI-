-- V5.0.17b：设置项清理收尾（老板 2026-10-07 逐项拍板）
--   依据：backend/tools/audit-settings.mjs 全量核查 + 逐项代码核对。
--   修正核查工具的两个误报（键写在 /settings/key/<key> 路径字符串里，脚本已补该匹配模式）：
--     doc.print.auto_a5（docprint.js 审核后自动弹 A5，在用）、mobile.hand（移动收银左右手，在用）、
--     voice.assistant.enabled（老板端智能客服朗读开关，在用）—— 三项保留。
--
-- ① 删除确认废弃（前后端均无任何引用，改了也不生效）
DELETE FROM system_settings WHERE setting_key IN (
  'voice.tts.mode',            -- piper 引擎不支持音色风格调节，被 voice.tts.voice 取代
  'voice.tts.pitch',           -- piper 引擎不支持音调调节
  'pos.cashier.print',         -- 与 pos.print.auto / pos.receipt.auto_print 重复
  'chain.enabled',             -- 连锁模式实际由 chainEnabled() 按总部组织行(stores.org_type='hq')自动判定，此项从不被读取
  'member.level_price_mode'    -- 纯说明文案用，已改为前端常量（members.js）
);

-- ② ai.engine：删除误导性的 mock 选项 —— 其实现早已是真实的 dHash 样本匹配（与 sample 完全相同），
--    「模拟联调（不做真实识别）」的标注是错的；历史值 mock 迁移为 sample。
UPDATE system_settings SET value='"sample"' WHERE setting_key='ai.engine' AND value::text = '"mock"';
UPDATE system_settings SET
  enum_options='[{"v":"yolo","label":"YOLO 检测模型（推荐：拍照样本训练后使用）"},{"v":"vl","label":"视觉大模型（需本地部署 Ollama 多模态模型，准确但较慢）"},{"v":"sample","label":"样本哈希匹配（dHash 真实样本相似度，免训练兜底）"}]'::jsonb,
  remark='商品识别的底层引擎；实际收银时仍按「条码 → 图像检索 → 模型」自动分层调度。原「模拟联调 mock」选项已删除：其实现早已是真实的 dHash 样本匹配，与 sample 相同，为避免误导已合并'
 WHERE setting_key='ai.engine';

-- ③ OCR 引擎默认地址：项目自带 backend/tools/ocr-server.py（PaddleOCR，默认端口 9000），
--    默认值与未配置的当前值一并填上（部署了 ocr-server 即开即用；没部署时连接被拒秒级回退 VLM，无长阻塞）。
UPDATE system_settings SET default_value='"http://127.0.0.1:9000/ocr"' WHERE setting_key='ai.ocr.engine_url';
UPDATE system_settings SET value='"http://127.0.0.1:9000/ocr"'
 WHERE setting_key='ai.ocr.engine_url' AND value::text = '""';

-- ④ remark 正名/澄清（消除管理员误解）
UPDATE system_settings SET remark='票据/证照识别的主力是「OCR引擎地址」的专用 OCR（认字快而准，不用大模型）；本项仅当 OCR 未配置或不可达时才兜底"看图识字"——正常部署了 OCR 就用不上它'
 WHERE setting_key='ai.ocr.vl_model';
UPDATE system_settings SET remark='审核通过后自动弹出 A5 单据打印（已接入：采购入库/采购退货/采购订单/盘点/报损/调拨/对账确认），需 docs.print.a5 权限；是前端弹打印预览，非服务端静默打印'
 WHERE setting_key='doc.print.auto_a5';
UPDATE system_settings SET remark='老板端「经营问答」答案自动朗读的开关（已生效，boss 端实时读取）；音色/语速在「语音播报」小节统一配置'
 WHERE setting_key='voice.assistant.enabled';
UPDATE system_settings SET remark='移动收银与作业模块的左右手镜像（已生效：扫码区/工具按钮/数量步进器按习惯反向排布），端上读取后缓存到本地'
 WHERE setting_key='mobile.hand';