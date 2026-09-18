-- 059 · V4.14.2：日结快照表（RV-09）+ 关单补偿设置项（RV-03/05）+ 变更单留痕明细注释
-- 幂等：init-db.js 按序重放不报错

-- ① daily_settlement：每日固化昨日汇总（防事后补单影响历史报表）
CREATE TABLE IF NOT EXISTS daily_settlement (
  id              BIGSERIAL PRIMARY KEY,
  settle_date     DATE NOT NULL,
  store_id        BIGINT NOT NULL DEFAULT 1,
  order_count     INTEGER NOT NULL DEFAULT 0,
  cash_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  scan_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  dividend_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  points_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  sales_total     NUMERIC(12,2) NOT NULL DEFAULT 0,
  cost_total      NUMERIC(12,2) NOT NULL DEFAULT 0,
  profit_total    NUMERIC(12,2) NOT NULL DEFAULT 0,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(settle_date, store_id)
);
COMMENT ON TABLE daily_settlement IS '日结快照单（V4.14.2 RV-09）：每日 00:05 固化昨日汇总，事后补单不改历史报表';

-- ② 关单补偿超时分钟数（RV-03：待付款超时关单+回冲批次；0=关闭 job）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark, unit)
SELECT '通用设置', 'sales.close_order_minutes', '待付款订单自动关单超时',
       '5', '5', 'number',
       '在线支付（扫码付）下单后未收到支付结果的单，超过该分钟数自动关单并回冲库存（关单前先查支付通道确认未支付）；填 0 关闭自动关单', '分钟'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'sales.close_order_minutes');
