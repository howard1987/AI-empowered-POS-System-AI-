-- 077 产品决策落地（2026-09-11 第四批）
-- 决策②：会员归属总部（HQ 门店 id 可配）+ 门店经纬度（客户端「就近分配」计算数据源）
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lng NUMERIC(10,7);
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES ('权限与安全','member.hq_store_id','会员归属总部门店 ID','1','1','number','新会员注册/建档归属门店（决策②）；消费记账按实际交易门店（动态），会员主档统一归总部')
ON CONFLICT (setting_key) DO NOTHING;
-- 决策④：负库存差额「挂起成本」回填队列——无批次可挂的差额不再按 0 成本静默吞掉，
-- 统一进本表由盘点/财务回填实际成本（cost_basis 记录挂账依据）
CREATE TABLE IF NOT EXISTS pending_cost_adjusts (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL DEFAULT 1,
  product_id   BIGINT NOT NULL,
  order_id     BIGINT NOT NULL,
  sale_item_id BIGINT,
  qty          NUMERIC(12,3) NOT NULL,
  cost_basis   VARCHAR(32) NOT NULL DEFAULT 'none',
  status       VARCHAR(16) NOT NULL DEFAULT '挂起',
  unit_cost    NUMERIC(12,4),
  note         TEXT,
  resolved_by  BIGINT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pca_open ON pending_cost_adjusts (store_id, status, product_id);
