-- V5.0.18g 大客户账期：账款按账期（月）滚动结算；0=现结
ALTER TABLE big_customers ADD COLUMN IF NOT EXISTS payment_term_months SMALLINT NOT NULL DEFAULT 0;
