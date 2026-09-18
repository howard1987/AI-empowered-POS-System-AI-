-- V4.15.6 P1 打印底座（修订版：复用既有 printers/print_templates/print_jobs 底座）
-- 说明：device.module.ts 已有 /printers（多机并存/默认机/试打）、/print-templates（字段池/预览/联次）、
--       /print-jobs（打印历史）。本迁移只补缺口，不建重复表。
--   ① 清理误建的 print_devices（已由 printers 表覆盖）
--   ② printers 加 brand（品牌通用适配）、预留 remark
--   ③ 收银自动打印开关 pos.print.auto / 联数 pos.print.copies

DROP TABLE IF EXISTS print_devices;

ALTER TABLE printers ADD COLUMN IF NOT EXISTS brand VARCHAR(32) NOT NULL DEFAULT '通用';

-- conn_type 扩展「串口」（浏览器 WebSerial 指令直驱）；幂等：存在即跳过
DO $$ BEGIN
  ALTER TABLE printers DROP CONSTRAINT printers_conn_type_check;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE printers ADD CONSTRAINT printers_conn_type_check
  CHECK (conn_type::text = ANY (ARRAY['USB'::text, '网口'::text, '蓝牙'::text, '串口'::text]));

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark) VALUES
 ('收银', 'pos.print.auto', '结账自动打印小票', '1', '1', 'enum',
  '[{"v":"1","label":"自动打印（推荐）"},{"v":"0","label":"不自动打印，手动补打"}]',
  '结账成功后自动向默认小票机出票 1 联（网口/串口直驱）；无可用设备时回落浏览器打印'),
 ('收银', 'pos.print.copies', '小票联数', '1', '1', 'enum',
  '[{"v":"1","label":"1 联（顾客联）"},{"v":"2","label":"2 联（顾客联+存根联）"}]',
  '2 联时存根联含金额大写与签名区，连续出票（P5 完整存根联版式）')
ON CONFLICT (setting_key) DO NOTHING;
