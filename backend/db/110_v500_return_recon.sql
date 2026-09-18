-- ============================================================================
-- 110_v500_return_recon.sql · V5.0.0 连锁 批次4B（M4-11~M4-20）
--   退货门店绑定 + 门店往来台账 + 跨店退货任务 + 进价差异单(R17 两出口)
--   + 对账三层金额 + 费用分摊规则 + 供应商退货连锁字段 + 权限点
-- 幂等：语句级重放；单店零回归：新表恒空、新列带默认值、CHECK 均 NOT VALID
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 退货单「三个门店字段」（方案 §5.7.2，R9）——同店退货业务零改动，仅补字段
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS origin_store_id BIGINT;      -- 原销售门店（快照）
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS bind_store_id   BIGINT;      -- 冲减归属门店（默认=origin）
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS is_cross_store  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS authorize_type  VARCHAR(12); -- 'hq' / 'store'(P2) / NULL 同店
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS authorize_by    BIGINT;
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS authorize_at    TIMESTAMPTZ;
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS source_node     VARCHAR(32); -- 生成节点：店 node_code / 'HQ'
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS settle_status   VARCHAR(12) NOT NULL DEFAULT 'none';
--   none 无需调账 / pending 待调账（门店往来）/ settled 已调账
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS recv_status     VARCHAR(12); -- 跨店：待收货/已入库/不入库（受理店回执）
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS recv_remark     VARCHAR(200);
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS sync_version    BIGINT NOT NULL DEFAULT 0;

ALTER TABLE sale_refunds DROP CONSTRAINT IF EXISTS ck_sr_cross_scope;
ALTER TABLE sale_refunds ADD CONSTRAINT ck_sr_cross_scope CHECK (
  (is_cross_store = false AND (origin_store_id IS NULL OR origin_store_id = store_id))
  OR
  (is_cross_store = true  AND origin_store_id IS NOT NULL AND origin_store_id <> store_id
   AND authorize_type IS NOT NULL)
) NOT VALID;   -- NOT VALID：不校验历史行，仅约束新写入
CREATE INDEX IF NOT EXISTS idx_srefund_origin ON sale_refunds (origin_store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_srefund_cross  ON sale_refunds (is_cross_store, created_at DESC) WHERE is_cross_store;

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 门店往来台账（跨店退货现金代付 / 供应商退货货值转移 / 调拨货款的对账依据，方案 §5.7.3-③）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store_intercompany_ledger (
  id            BIGSERIAL PRIMARY KEY,
  biz_type      VARCHAR(16) NOT NULL,        -- return_cash 退货代付 / supplier_return 退厂货值 / transfer 调拨货款
  biz_ref       VARCHAR(32) NOT NULL,        -- 关联单号（refund_no / return_no / transfer_no）
  from_store_id BIGINT NOT NULL REFERENCES stores(id),   -- 出资/付出方
  to_store_id   BIGINT NOT NULL REFERENCES stores(id),   -- 应还/受益方
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  qty           NUMERIC(12,3),
  product_id    BIGINT,
  status        VARCHAR(12) NOT NULL DEFAULT 'pending',  -- pending / settled
  settled_by    BIGINT, settled_at TIMESTAMPTZ, remark VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (biz_type, biz_ref, from_store_id, to_store_id)
);
CREATE INDEX IF NOT EXISTS idx_ic_ledger_status ON store_intercompany_ledger (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ic_ledger_from   ON store_intercompany_ledger (from_store_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 受理门店侧的跨店退货任务（独立表不引用本地 sales_orders，绕开 FK 约束，方案 §5.7.3-④）
--    总部 publish('cross_returns', ...) 下行 → 受理店 upsert（冲突键 refund_no）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cross_return_tasks (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL REFERENCES stores(id),   -- 受理门店（=总部 refund.store_id）
  hq_refund_id    BIGINT NOT NULL,                          -- 总部 sale_refunds.id（权威单）
  refund_no       VARCHAR(32) NOT NULL UNIQUE,
  origin_store_id BIGINT NOT NULL,
  order_no        VARCHAR(32) NOT NULL,                     -- 原单号（展示用）
  amount          NUMERIC(12,2) NOT NULL,
  status          VARCHAR(12) NOT NULL DEFAULT '待收货',     -- 待收货 / 已入库 / 不入库
  payload         JSONB NOT NULL DEFAULT '{}',              -- 原单/明细快照
  recv_by         BIGINT, recv_at TIMESTAMPTZ, recv_remark VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crt_store ON cross_return_tasks (store_id, status, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ 进价差异单（R17 第四/五轮拍板，方案 §5.8.2/§5.8.3）——头 + 明细
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_variance_sheets (
  id              BIGSERIAL PRIMARY KEY,
  cvd_no          VARCHAR(40) NOT NULL UNIQUE,   -- CVD-供应商编码-账期
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  recon_id        BIGINT,                        -- 归属对账单（对账模块内呈现）
  item_count      INT      NOT NULL DEFAULT 0,
  qty_total       NUMERIC(14,3) NOT NULL DEFAULT 0,
  invoice_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- ① 开票口径（实价）
  settle_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- ② 结算口径（L1）
  variance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,   -- ③ 差异 = ① − ②（可正可负）
  status          VARCHAR(14) NOT NULL DEFAULT 'open',-- open/negotiating/picked_up/carried/written_off/disputed
  -- 两个出口（审核时必选其一）
  action          VARCHAR(12),                        -- pickup 补差 / writeoff 冲差
  audited_by      BIGINT, audited_at TIMESTAMPTZ,
  audit_remark    VARCHAR(200),
  -- 补差专用
  carry_to_recon_id   BIGINT,                         -- 结转至哪张下期对账单
  carried_at          TIMESTAMPTZ,
  settled_in_recon_id BIGINT,                         -- 非空 = 已在下期账单结算（终态 carried）
  -- 冲差专用
  writeoff_amount NUMERIC(14,2),
  responsibility  VARCHAR(12),                        -- store/hq/supplier（仅考核，不影响账务）
  closed_by       BIGINT, closed_at TIMESTAMPTZ,
  due_at          TIMESTAMPTZ,                        -- 账龄 SLA（+60 天）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_cvs_amount CHECK (round(invoice_amount - settle_amount - variance_amount, 2) = 0),
  CONSTRAINT ck_cvs_action CHECK (action IS NULL OR action IN ('pickup','writeoff'))
);
CREATE INDEX IF NOT EXISTS idx_cvs_carry   ON cost_variance_sheets (action, carry_to_recon_id);
CREATE INDEX IF NOT EXISTS idx_cvs_settled ON cost_variance_sheets (action, settled_in_recon_id);
CREATE INDEX IF NOT EXISTS idx_cvs_status  ON cost_variance_sheets (status, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_cvs_supp    ON cost_variance_sheets (supplier_id, period_end DESC);

CREATE TABLE IF NOT EXISTS cost_variance_items (
  id             BIGSERIAL PRIMARY KEY,
  sheet_id       BIGINT NOT NULL REFERENCES cost_variance_sheets(id) ON DELETE CASCADE,
  cdr_id         BIGINT,                          -- 来源处置单 cost_diff_requests（证据链）
  store_id       BIGINT REFERENCES stores(id),    -- 单据发生门店
  product_id     BIGINT NOT NULL,
  product_name   VARCHAR(120) NOT NULL,           -- 快照（防改名对不上）
  barcode        VARCHAR(48),
  base_unit      VARCHAR(16),
  qty            NUMERIC(12,3) NOT NULL DEFAULT 0,
  settle_price   NUMERIC(12,4) NOT NULL,          -- 总部进价（L1）
  actual_price   NUMERIC(12,4) NOT NULL,          -- 供应商进价（实价）
  gap            NUMERIC(12,4) NOT NULL,          -- 差异值 = actual − settle（可正可负）
  gap_amount     NUMERIC(14,2) NOT NULL,          -- 差异金额 = gap × qty
  inbound_id     BIGINT, doc_no VARCHAR(32),
  biz_date       DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cvi_sheet ON cost_variance_items (sheet_id);
CREATE INDEX IF NOT EXISTS idx_cvi_prod  ON cost_variance_items (product_id, biz_date DESC);
CREATE INDEX IF NOT EXISTS idx_cvi_store ON cost_variance_items (store_id, biz_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- ⑤ 对账明细补三层金额 + 单据发生门店（方案 §5.8）；doc_type 为 VARCHAR(16)，
--    'variance_pickup'(15字) 直接可存，无需改类型
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS source_store_id  BIGINT;
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS biz_scope        VARCHAR(16);
--   hq_purchase 总部采购 / store_purchase 门店自采 / transfer 调拨 / supplier_return 供应商退货
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS settle_price     NUMERIC(12,4);
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS invoice_amount   NUMERIC(14,2);
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS settle_amount    NUMERIC(14,2);
ALTER TABLE reconciliation_items ADD COLUMN IF NOT EXISTS variance_amount  NUMERIC(14,2);
CREATE INDEX IF NOT EXISTS idx_recitem_store ON reconciliation_items (source_store_id, doc_type);

-- ⑥ 费用单补分摊规则（按门店计费，方案 §5.8-②）
ALTER TABLE supplier_fees ADD COLUMN IF NOT EXISTS alloc_mode   VARCHAR(12) NOT NULL DEFAULT 'direct';
ALTER TABLE supplier_fees ADD COLUMN IF NOT EXISTS alloc_detail JSONB;

-- ⑦ 供应商退货连锁字段（复用现有 purchase_returns；货从哪个店出已由 store_id 表达）
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS reason_type VARCHAR(16);  -- 临期/滞销/质量问题/错发/其他
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS settle_type VARCHAR(12);  -- 冲应付/供应商退款/换货
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS settle_ref  VARCHAR(32);  -- 关联结算单号
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS ship_at     TIMESTAMPTZ;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS ship_by     BIGINT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ⑧ 权限点（批次4B）
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO permission_points (code, name, module)
VALUES ('hq.return.audit',    '跨店退货总部审核',           '总部退货'),
       ('hq.ledger.view',     '门店往来台账查看',           '总部退货'),
       ('hq.ledger.settle',   '门店往来结清确认',           '总部退货'),
       ('hq.variance.manage', '进价差异单审核（补差/冲差）','总部对账'),
       ('hq.preturn.audit',   '供应商退货总部审核/结清',    '总部采购')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
  FROM roles r CROSS JOIN permission_points pp
 WHERE r.name = '超级管理员'
   AND pp.code IN ('hq.return.audit','hq.ledger.view','hq.ledger.settle',
                   'hq.variance.manage','hq.preturn.audit')
ON CONFLICT DO NOTHING;
