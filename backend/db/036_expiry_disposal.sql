-- ═══ V4.9.3 临期预警处置闭环 ═══
-- 1) 处置表：预警批次 → 店长/店员处置（未处理/处理中/已退换），超时未处置标记处罚
-- 2) 设置项：处置时限小时数（stock.expiry_disposal_hours，默认 48h）
CREATE TABLE IF NOT EXISTS expiry_disposals (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL DEFAULT 1,
  batch_id      BIGINT NOT NULL UNIQUE REFERENCES batches(id),
  product_id    BIGINT NOT NULL REFERENCES products(id),
  status        VARCHAR(12) NOT NULL DEFAULT '未处理',  -- 未处理 | 处理中 | 已退换
  deadline_at   TIMESTAMPTZ,                            -- 处置时限（首次见警时按设置生成）
  started_at    TIMESTAMPTZ,                            -- 开始处置时间
  handled_at    TIMESTAMPTZ,                            -- 处置到位时间（退货已审核/换货已入库）
  handler_id    BIGINT,
  handler_name  VARCHAR(40),
  return_doc_no VARCHAR(48),                            -- 关联退/换货单号（一键联动回写）
  penalized     BOOLEAN NOT NULL DEFAULT FALSE,         -- 超时未处置 → 处罚标记
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expdisp_status ON expiry_disposals (status);

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES ('商品与库存', 'stock.expiry_disposal_hours', '临期处置时限（小时）', '48', '48', 'number',
        '临期预警产生后，店长/店员须在该时限内处置到位（退换货流程完成）；超时未处置记处罚')
ON CONFLICT (setting_key) DO NOTHING;
