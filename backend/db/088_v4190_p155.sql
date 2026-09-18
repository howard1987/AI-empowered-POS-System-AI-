-- ═══ V4.19.0 P15.5 十项收口：离线退货幂等 / 券码手输 / 设备埋点 ═══
-- 1) 离线退货（C2）：sale_refunds 加 client_ref（客户端幂等单号，复用销售补传管道防重）
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS client_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_srefund_client_ref ON sale_refunds (client_ref) WHERE client_ref IS NOT NULL;

-- 2) 券码手输（A2 后半）：member_coupons 加 code（发券即生成 MC+8位序号，打印在纸质券上可手输核销）
ALTER TABLE member_coupons ADD COLUMN IF NOT EXISTS code VARCHAR(24);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcoupon_code ON member_coupons (code) WHERE code IS NOT NULL;
UPDATE member_coupons SET code = 'MC' || lpad(id::text, 8, '0') WHERE code IS NULL;

-- 3) 设备埋点（H1）：打印失败/连接失败/补传失败/秤离线统一留痕；severity=warn 同步推老板端消息中心（H2）
CREATE TABLE IF NOT EXISTS device_events (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL,
  device_type VARCHAR(16) NOT NULL,              -- printer/drawer/scale/scanner/sync
  device_name VARCHAR(64),                       -- 设备名（可空）
  event_type  VARCHAR(24) NOT NULL,              -- print_fail/connect_fail/sync_fail/scale_offline/low_paper
  severity    VARCHAR(8)  NOT NULL DEFAULT 'info', -- info / warn
  detail      JSONB,                             -- 通道/错误信息等
  employee_id BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_events_store ON device_events (store_id, created_at DESC);
