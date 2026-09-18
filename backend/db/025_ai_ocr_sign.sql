-- ═══════════════════════════════════════════════════════════════
-- 025_ai_ocr_sign.sql（M1-M5 增量）：
--   1) ai_recognition_logs.scene —— 手机端多作业识别场景（checkout/intake/return/loss）
--   2) 票据 OCR 入库 + 低价保护参数（ai.ocr.*）
--   3) 移动签名关联：inbound_orders / loss_records 挂 sign_record_id
--   4) 会员智能画像表 member_profiles
--   5) 防损看板参数（异常折扣阈值）
-- ═══════════════════════════════════════════════════════════════

-- 1) 识别日志场景列
ALTER TABLE ai_recognition_logs ADD COLUMN IF NOT EXISTS scene VARCHAR(16) NOT NULL DEFAULT 'checkout';

-- 2) 票据 OCR + 低价保护参数
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('AI与设备', 'ai.ocr.low_price',     '入库低价保护开关',   'true',  'true',  'bool',   '入库价低于历史最低进价时拦截（可强推）'),
  ('AI与设备', 'ai.ocr.low_price_mode','低价保护模式',       '"block"','"block"','string','block=拦截须店长强推 / warn=仅标黄提示'),
  ('AI与设备', 'ai.ocr.vl_model',      '票据OCR视觉模型',   '"qwen2.5-vl:7b"', '"qwen2.5-vl:7b"', 'string', '本地多模态模型（Ollama），图片识别票据文本用')
ON CONFLICT (setting_key) DO NOTHING;

-- 3) 移动签名关联列（操作员电子签名挂单据）
ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS sign_record_id BIGINT REFERENCES signature_records(id);
ALTER TABLE loss_records    ADD COLUMN IF NOT EXISTS sign_record_id BIGINT REFERENCES signature_records(id);

-- 4) 会员智能画像（生命周期/偏好/贡献度标签缓存）
CREATE TABLE IF NOT EXISTS member_profiles (
  member_id  BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  store_id   BIGINT NOT NULL,
  tags       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{k,v}]：生命周期/偏好品类/贡献度/频次
  profile    JSONB,                                -- 明细：总消费/单量/客单价/最近活跃/品类TOP
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_member_profiles_store ON member_profiles (store_id);

-- 5) 防损看板参数（异常折扣判定：单笔折扣率 > 阈值 视为异常折扣单）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('AI与设备', 'ai.fraud.discount_floor', '异常折扣率阈值', '0.3', '0.3', 'number', '折扣金额/商品原价 超过该值记异常折扣单（0-1）')
ON CONFLICT (setting_key) DO NOTHING;
