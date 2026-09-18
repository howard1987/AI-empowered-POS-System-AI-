-- ═══════════════════════════════════════════════════════════════
-- 016_batch_ops.sql（V4.8.21）：13条反馈批次改造
--   1) 入库单作废：inbound_status_t 增加「已作废」，batch_status_t 增加「入库作废」
--   2) 退货凭证后置：复用 evidence_path（创建时可空，审核前必须补传）
--   3) 对账单作废：复用 recon_status_t「生成」可删；供应商往来账按单回删重算
--   4) 促销活动模板：promotion_templates（一键按模板建活动）
-- ═══════════════════════════════════════════════════════════════

ALTER TYPE inbound_status_t ADD VALUE IF NOT EXISTS '已作废' AFTER '已对账';
ALTER TYPE batch_status_t  ADD VALUE IF NOT EXISTS '入库作废' AFTER '调出';
ALTER TYPE recon_status_t  ADD VALUE IF NOT EXISTS '已作废' AFTER '部分异议';

ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS voided_by    BIGINT;
ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS voided_at    TIMESTAMPTZ;
ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS void_reason  VARCHAR(128);

CREATE TABLE IF NOT EXISTS promotion_templates (
  id             BIGSERIAL PRIMARY KEY,
  name           VARCHAR(64) NOT NULL,
  kind           promo_kind_t NOT NULL,
  rules_template JSONB NOT NULL,
  remark         VARCHAR(128),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO promotion_templates (name, kind, rules_template, remark) VALUES
  ('满100减20（经典档位）', '满减', '{"tiers":[{"threshold":100,"off":20},{"threshold":200,"off":50}]}', '整单满减双档位，可改阈值'),
  ('全场8折（满200）',      '折扣', '{"threshold":200,"rate":0.8}', '整单满折，rate 0.8=8折'),
  ('第二件半价',            '第二件半价', '{}', '行级：同商品每2件省1件半价'),
  ('爆品特价3.5元',         '特价', '{"specialPrice":3.5}', '行级时段特价，起止即活动起止')
ON CONFLICT DO NOTHING;
