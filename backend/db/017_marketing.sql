-- ═══════════════════════════════════════════════════════════════
-- 017_marketing.sql（P2-1 + 方向1 补全）：智能营销引擎
--   规则表 marketing_rules + 触达记录 marketing_touches
--   默认 7 条规则：生日触达 / 临期折扣 / 分红到期提醒 / 沉默唤醒 / 低余额提醒 / 散客转会员 / 大客户催收
--   触达当天同对象去重；权限点 marketing.manage；执行时刻设置 marketing.run_time
-- ═══════════════════════════════════════════════════════════════

-- 规则配置（每店每规则唯一；config JSONB：lead_days 提前天数 / discount 建议折扣等）
CREATE TABLE IF NOT EXISTS marketing_rules (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL DEFAULT 1,
  rule_key     VARCHAR(16) NOT NULL,             -- birthday / expiry / dividend
  name         VARCHAR(32) NOT NULL,
  description  VARCHAR(128),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  config       JSONB NOT NULL DEFAULT '{}',
  last_run_at  TIMESTAMPTZ,                      -- 上次执行时刻（定时器按日去重）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, rule_key)
);

-- 触达记录（留痕；channel 预留 H5 推送，初版站内信）
CREATE TABLE IF NOT EXISTS marketing_touches (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL DEFAULT 1,
  rule_id      BIGINT NOT NULL REFERENCES marketing_rules(id),
  member_id    BIGINT REFERENCES members(id),
  product_id   BIGINT REFERENCES products(id),
  batch_id     BIGINT REFERENCES batches(id),
  touch_type   VARCHAR(16) NOT NULL,             -- birthday / expiry / dividend
  title        VARCHAR(64) NOT NULL,
  content      TEXT NOT NULL,
  payload      JSONB,                            -- 折扣建议/批次/到期日等
  status       VARCHAR(8) NOT NULL DEFAULT '待处理',  -- 待处理 / 已处理 / 已忽略
  channel      VARCHAR(16) NOT NULL DEFAULT '站内信',
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_touch   ON marketing_touches (store_id, touch_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_dedup   ON marketing_touches (touch_type, member_id, batch_id, created_at);

-- 默认规则（幂等种子）
INSERT INTO marketing_rules (store_id, rule_key, name, description, enabled, config) VALUES
  (1, 'birthday',      '生日触达',   '会员生日前 3 天站内提醒（可用积分/券权益）', true, '{"lead_days":3}'),
  (1, 'expiry',        '临期折扣',   '库存批次距过期 15 天预警，建议按 8 折促销去化', true, '{"lead_days":15,"discount":0.8}'),
  (1, 'dividend',      '分红到期提醒', '分红有效期前 3 天提醒会员到店使用', true, '{"lead_days":3}'),
  (1, 'dormant',       '沉默唤醒',   '超过 30 天未到店消费的正常会员，提醒回店', true, '{"silent_days":30}'),
  (1, 'low_balance',   '低余额提醒', '余额低于 20 元且近期消费过的会员，建议充值', true, '{"threshold":20}'),
  (1, 'guest_convert', '散客转会员', '近 90 天散客单达 3 次的顾客（留有电话），引导办卡', true, '{"min_visits":3,"days":90}'),
  (1, 'receivable',    '大客户催收', '大客户应收未结超 30 天，提醒催收对账', true, '{"aging_days":30}')
ON CONFLICT (store_id, rule_key) DO NOTHING;

-- 权限点：营销引擎管理（改规则/手动执行；查看触达记录用 report.view.all）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
  ('marketing.manage', '营销', '营销引擎管理', 1)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points WHERE code='marketing.manage'
ON CONFLICT DO NOTHING;

-- 执行时刻设置（每日自动扫描；24 小时制 HH:MM）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('促销营销', 'marketing.run_time', '营销引擎每日执行时刻', '"08:30"', '"08:30"', 'string', '到时自动扫描生日/临期/分红到期并生成触达')
ON CONFLICT (setting_key) DO NOTHING;
