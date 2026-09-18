-- V4.9.6 采购退货状态文案统一：待预审/已预审 → 待审核（已取消保留；作废改置「已作废」）
UPDATE purchase_returns SET status = '待审核' WHERE status IN ('待预审', '已预审');

-- 枚举扩展：已作废（作废单据状态）
ALTER TYPE return_status_t ADD VALUE IF NOT EXISTS '已作废';
