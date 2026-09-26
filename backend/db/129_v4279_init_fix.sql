-- 129 · V4.27.9 初始化级联安全 + 打印/语音设置去歧义
-- ═══ ① 级联安全（勾选式保留的前置修复）═══
-- TRUNCATE ... CASCADE 会沿外键级联清空"引用被清表"的表。两处外键把"永不清"的表挂在
-- "会被清"的表下面，必须解除（列保留，只断外键）：
--   ai_models.trained_task_id → ai_tasks：初始化清训练任务会连模型注册表一起清掉（历史隐患）
ALTER TABLE ai_models DROP CONSTRAINT IF EXISTS ai_models_trained_task_id_fkey;
--   signature_templates.supplier_id → suppliers：清供应商档案会连签字模板一起清掉
ALTER TABLE signature_templates DROP CONSTRAINT IF EXISTS signature_templates_supplier_id_fkey;

-- ═══ ② 打印三开关去歧义（此前两个同名"结账自动打印小票"，老板分不清）═══
UPDATE system_settings SET
  display_name='结账自动打印小票（小票机）',
  remark='结账成功后自动向默认小票机出票（网口/串口直驱）；收银台内 F7 可临时开关，两者叠加生效'
 WHERE setting_key='pos.print.auto';
UPDATE system_settings SET
  display_name='浏览器打印小票（无小票机时）',
  remark='仅在未连接小票机、走浏览器打印通道时生效；连接小票机后以上一条「结账自动打印小票（小票机）」为准'
 WHERE setting_key='pos.receipt.auto_print';

-- ═══ ③ 收银台语音项命名澄清（与老板端"播报音色/语速"同名易混淆）═══
UPDATE system_settings SET display_name='收银台播报音色',
  remark='收银台专用；留空 = 跟随老板端「播报音色」'
 WHERE setting_key='pos.cashier.tts.voice';
UPDATE system_settings SET display_name='收银台播报语速',
  remark='收银台专用；留空 = 跟随老板端「播报语速」'
 WHERE setting_key='pos.cashier.tts.rate';
