-- V4.9.8 手机端审批（8.3 老板看板）：单据驳回留痕
-- 背景：老板在手机上只能"看"待办不能"办"；驳回必须留原因与处理人，避免口头驳回造成账实脱节。

-- 1) 驳回状态：入库 / 退货 / 盘点 状态枚举扩展（报损 loss_records.status 为 VARCHAR，无需改枚举）
ALTER TYPE inbound_status_t ADD VALUE IF NOT EXISTS '已驳回' AFTER '未审核';
ALTER TYPE return_status_t  ADD VALUE IF NOT EXISTS '已驳回' AFTER '待审核';
ALTER TYPE count_status_t   ADD VALUE IF NOT EXISTS '已驳回' AFTER '待差异处理';

-- 2) 驳回原因与处理人（统一字段，便于事后追溯与员工绩效归因）
ALTER TABLE inbound_orders   ADD COLUMN IF NOT EXISTS reject_reason VARCHAR(128);
ALTER TABLE inbound_orders   ADD COLUMN IF NOT EXISTS rejected_by   BIGINT;
ALTER TABLE inbound_orders   ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ;

ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS reject_reason VARCHAR(128);
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS rejected_by   BIGINT;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ;

ALTER TABLE loss_records     ADD COLUMN IF NOT EXISTS reject_reason VARCHAR(128);
ALTER TABLE loss_records     ADD COLUMN IF NOT EXISTS rejected_by   BIGINT;
ALTER TABLE loss_records     ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ;

ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS reject_reason VARCHAR(128);
ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS rejected_by   BIGINT;
ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ;
