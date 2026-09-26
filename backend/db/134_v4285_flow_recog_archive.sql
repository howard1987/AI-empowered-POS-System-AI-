-- 134 · V4.28.5 🟠-3 流水/识别日志归档：大表瘦身（审计日志归档已在 123/d3.care 落地，本迁移补齐另两张增长最快的表）
-- 口径：按月保留热数据，超期行每日 03:40 批量迁移 *_archive 后从主表删除（批次事务，锁窗口小）。
-- 幂等：可重复执行。0=关闭该表归档。

-- ① 归档表（列与主表同构 + archived_at；direction 枚举落为 VARCHAR 防枚举类型跨表引用）
CREATE TABLE IF NOT EXISTS stock_flows_archive (
  id BIGINT, store_id BIGINT, product_id BIGINT, batch_id BIGINT,
  direction VARCHAR(16), qty NUMERIC(12,3), unit_cost NUMERIC(12,4),
  ref_type VARCHAR(32), ref_id BIGINT, ref_item_id BIGINT, employee_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flow_arch_prod ON stock_flows_archive (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_arch_ref  ON stock_flows_archive (ref_type, ref_id);

CREATE TABLE IF NOT EXISTS ai_recognition_logs_archive (
  id BIGINT, store_id BIGINT, device_id BIGINT, image_path VARCHAR(256),
  raw_result JSONB, used_fallback BOOLEAN, fallback_model VARCHAR(32),
  corrected BOOLEAN, corrected_json JSONB, order_id BIGINT, latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recog_arch_time ON ai_recognition_logs_archive (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recog_arch_corr ON ai_recognition_logs_archive (corrected) WHERE corrected = true;

-- ② 归档策略设置（门店与运维组）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
('门店与运维','ops.archive.flow_months','库存流水归档月数','12','12','number',
 '超过该月数的库存流水（stock_flows）每日 03:40 批量迁移 stock_flows_archive 后从主表删除；0=不归档。主表瘦身可显著加快库存查询与盘点'),
('门店与运维','ops.archive.recog_months','AI识别日志归档月数','6','6','number',
 '超过该月数的 AI 识别日志（ai_recognition_logs）每日 03:40 批量迁移 ai_recognition_logs_archive 后从主表删除；0=不归档。难例挖掘等查询只查热表，归档表用于追溯')
ON CONFLICT (setting_key) DO NOTHING;
