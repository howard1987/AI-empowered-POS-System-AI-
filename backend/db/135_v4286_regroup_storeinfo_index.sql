-- 135 · V4.28.6 设置归集整理 + 连锁门店信息 + 热点索引 + 临期折扣放开种子
-- 幂等：可重复执行。

-- ══ ① 设备类设置统一归集到「设备管理」组（此前散落在 通用设置/AI经营）══
UPDATE system_settings SET group_name='设备管理' WHERE setting_key IN (
  -- 小票/单据打印
  'pos.print.auto','pos.print.copies','pos.receipt.auto_print','pos.receipt.width',
  'doc.print.auto_a5','ops.printer_reconnect',
  -- 电子秤
  'scale.enabled','scale.baud',
  -- 语音播报
  'pos.voice_broadcast','voice.tts.mode','voice.tts.pitch','voice.tts.rate','voice.tts.voice',
  'voice.product.enabled','voice.assistant.enabled','voice.price.enabled','ai.voice.alerts'
);
UPDATE system_settings SET group_name='设备管理' WHERE setting_key LIKE 'scale.tx.%';
UPDATE system_settings SET group_name='设备管理' WHERE setting_key LIKE 'ai.scale.%';
UPDATE system_settings SET group_name='设备管理' WHERE setting_key LIKE 'display.%' AND group_name <> '设备管理';
UPDATE system_settings SET group_name='设备管理' WHERE setting_key LIKE 'tts.%' AND group_name <> '设备管理';
-- 散组收编：仅 2 键的「门店与运维」并入「通用设置」，避免多余页签
UPDATE system_settings SET group_name='通用设置' WHERE group_name='门店与运维';
-- 归集后的人话备注校准
UPDATE system_settings SET remark='小票机结账后自动打印（关=只收款不打印，可用「补打上一单」补票）' WHERE setting_key='pos.print.auto';
UPDATE system_settings SET remark='每单打印联数（默认 1；双联存根请设 2）' WHERE setting_key='pos.print.copies';
UPDATE system_settings SET remark='小票纸宽度（毫米，常见 80 / 58，与打印机实际纸宽一致）' WHERE setting_key='pos.receipt.width';
UPDATE system_settings SET remark='电子秤自动读重总开关：关=收银时手动输重量（串口参数 scale.tx.* 见下）' WHERE setting_key='scale.enabled';
UPDATE system_settings SET remark='电子秤串口波特率（与秤说明书一致，常见 9600 / 4800）' WHERE setting_key='scale.baud';

-- ══ ② 连锁门店档案补「负责人」列（店名/地址/电话/营业时间已有）══
ALTER TABLE stores ADD COLUMN IF NOT EXISTS contact_person VARCHAR(32);

-- ══ ③ 临期折扣放开（低于进价去化）开关种子 ══
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
('通用设置','sales.floor_guard_expiry_exempt','临期商品豁免成交价下限闸','true','true','bool',
 '开=在库临期批次（≤ai.pricing.expiry_days 天到期）的商品不计入成交价下限校验，临期折扣可低于进价销售（去化优先）；关=临期商品同样受下限闸约束'),
('AI经营','ai.pricing.expiry_below_cost','临期调价建议允许低于进价','true','true','bool',
 '开=临期调价档位（≤7天5折/≤15天7折/其余8.5折）不设成本底线，可直接建议低于进价的价格；关=维持进价×(1+成本底线毛利率)下限。滞销类建议不受此开关影响')
ON CONFLICT (setting_key) DO NOTHING;

-- ══ ④ 热点索引补齐（性能体检：高频外键/过滤列无索引，全表扫描风险）══
CREATE INDEX IF NOT EXISTS idx_sale_items_order   ON sale_items (order_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_order ON sale_payments (order_id);
CREATE INDEX IF NOT EXISTS idx_sale_refunds_order  ON sale_refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_dividend_records_member ON dividend_records (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loss_items_loss     ON loss_items (loss_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON stock_transfer_items (transfer_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_items_count   ON inventory_count_items (count_id);
CREATE INDEX IF NOT EXISTS idx_ai_samples_store_status       ON ai_samples (store_id, status, id DESC);
