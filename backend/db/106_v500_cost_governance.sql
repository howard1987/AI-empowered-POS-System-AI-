-- ============================================================================
-- V5.0.0 连锁改造 · 进价治理（R8 乙模型 · 方案 §5.1.6）
--
-- 本迁移补齐「标准进价 L1」的**证据链**与配置：
--   ① product_standard_cost_logs —— L1 每次变更的台账（谈判证据链，方案 ⓪ 硬约束 2）
--   ② cost_diff_requests         —— 进价异常处置单（低于 L1 待采纳 / 高于 L1 高进价处置）
--   ③ chain.cost.* / chain.variance.* 设置键种子
--
-- ⚠️ 幂等（项目铁律）：全部 CREATE TABLE IF NOT EXISTS / ALTER ... ADD COLUMN IF NOT EXISTS /
--    INSERT ... ON CONFLICT DO NOTHING；**无** ALTER TYPE ADD VALUE（避免事务安全报错）。
--
-- ⚠️ 单店零回归：单店下这些表**恒为空**（该店即总部，走同一账号内的原有流程），
--    不改变任何现有查询行为。
-- ============================================================================

-- ── ① 标准进价 L1 变更台账（append-only，永不 UPDATE/DELETE）────────────────
-- 为什么必须留：半年后拿「历史低价」去跟供应商谈判时，必须能证明这个价**从哪来、是否真实**，
-- 否则筹码是废的。同时它也是唯一能回答「这条红线是什么时候、被谁、依据哪张单改的」的地方。
CREATE TABLE IF NOT EXISTS product_standard_cost_logs (
  id            BIGSERIAL PRIMARY KEY,
  product_id    BIGINT NOT NULL REFERENCES products(id),
  old_cost      NUMERIC(12,4),                  -- 变更前 L1（NULL = 原本为空/新品首进）
  new_cost      NUMERIC(12,4) NOT NULL,         -- 变更后 L1
  delta         NUMERIC(12,4),                  -- 变化量（正=抬升，负=下调）
  source        VARCHAR(24) NOT NULL,           -- hq_manual 总部维护 / inbound_adopt 入库采纳 / price_change 调价单 / inbound_adopt_lower 低进价采纳 / variance_pickup 补差联动
  ref_doc_no    VARCHAR(48),                    -- 依据单据号（入库单/调价单/处置单）
  ref_id        BIGINT,                         -- 依据单据 id
  store_id      BIGINT,                         -- 来源门店（进价采纳场景记录是哪家店报的价）
  supplier_id   BIGINT,                         -- 来源供应商（渠道溯源）
  reason        VARCHAR(200),
  operator_id   BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pscl_product ON product_standard_cost_logs (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pscl_source  ON product_standard_cost_logs (source, created_at DESC);

-- ── ② 进价异常处置单（low 低进价待采纳 / high 高进价待处置）──────────────────
-- 设计要点（方案 §5.1.6-⑧⑨）：
--   · low  = 实价 < L1 → 需总部审核；通过才降 L1（防止不可复现的低价长期压全连锁红线）
--   · high = 实价 > L1 → L1 不动，总部四选一裁决；判据来自**已审核入库单**
--   · 双向共用一张表：一次裁决、两个结果，总部不会被同一件事审两遍
CREATE TABLE IF NOT EXISTS cost_diff_requests (
  id            BIGSERIAL PRIMARY KEY,
  anomaly       VARCHAR(8) NOT NULL DEFAULT 'low',   -- low 低于L1待采纳 / high 高于L1待处置
  store_id      BIGINT NOT NULL REFERENCES stores(id),
  product_id    BIGINT NOT NULL REFERENCES products(id),
  supplier_id   BIGINT,
  inbound_id    BIGINT,                              -- 依据入库单（**必须已审核**，硬约束 1）
  doc_no        VARCHAR(48),                         -- 单据号（人可读留证）
  qty           NUMERIC(12,3),
  l1_at_request NUMERIC(12,4),                       -- 提交时的 L1（留证，防止事后 L1 变化导致对不上）
  actual_cost   NUMERIC(12,4) NOT NULL,              -- 实价（= 已落账的 L2 批次成本）
  gap_amount    NUMERIC(14,2),                       -- 差异金额（对账口径，恒取实价：_取不到 L1 时为 NULL）
  status        VARCHAR(12) NOT NULL DEFAULT 'pending',   -- pending / adopted(已采纳) / rejected(驳回) / accepted(高进价已认可) / adjusted(已调账) / returned(已退供)
  verdict       VARCHAR(16),                         -- accept / adjust_to_l1 / reject_inbound / return_supplier
  adopted_l1    NUMERIC(12,4),                       -- 采纳/调整后的 L1
  adjust_amount NUMERIC(14,2),                       -- 调账金额（**记账口径**，绝不等于对账金额）
  remark        VARCHAR(200),
  audit_remark  VARCHAR(200),
  due_at        TIMESTAMPTZ,                         -- 高进价处置时限（超时自动 accept + 告警）
  audited_by    BIGINT, audited_at TIMESTAMPTZ,
  created_by    BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_cdr_anomaly CHECK (anomaly IN ('low','high'))
);
CREATE INDEX IF NOT EXISTS idx_cdr_status  ON cost_diff_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdr_product ON cost_diff_requests (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdr_store   ON cost_diff_requests (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdr_due     ON cost_diff_requests (due_at) WHERE status = 'pending';

-- ── ③ 进价渠道台账（用于比价与谈判；**只有 adopted_l1=true 的才影响红线**）──
-- 说明：真正的「渠道流水」沿用既有 supplier_product_prices（append-only），
--       本表只补充「这笔价来自哪家店、哪张入库单、是否被采纳为 L1」三个信息，
--       避免再去改 supplier_product_prices 的结构（那是全后端 6 处读价依赖的表）。
CREATE TABLE IF NOT EXISTS supplier_quote_channels (
  id            BIGSERIAL PRIMARY KEY,
  product_id    BIGINT NOT NULL REFERENCES products(id),
  supplier_id   BIGINT,
  store_id      BIGINT,
  source_type   VARCHAR(16) NOT NULL DEFAULT 'inbound',  -- inbound 入库 / price_change 调价单 / manual 总部维护
  price         NUMERIC(12,4) NOT NULL,
  qty           NUMERIC(12,3),
  inbound_id    BIGINT,
  doc_no        VARCHAR(48),
  adopted_l1    BOOLEAN NOT NULL DEFAULT false,          -- 是否被采纳为标准进价（比价/谈判时标注）
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sqc_product ON supplier_quote_channels (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sqc_supplier ON supplier_quote_channels (product_id, supplier_id, price);

-- ── ⑤ 进价渠道比价视图（总部「进价渠道榜」直接消费；谈判原料）──────────────
-- 语义：每个商品 → 各渠道报价的最低价 / 最高价 / 供应商数 / 与当前 L1 的差额。
-- 「差额 > 0」= 有供应商能比当前标准进价更低 → 总部可直接拿去压价。
CREATE OR REPLACE VIEW v_cost_channel_rank AS
SELECT p.id            AS product_id,
       p.name          AS product_name,
       p.barcode,
       p.base_unit,
       p.standard_cost,
       MIN(sqc.price)  AS channel_min,
       MAX(sqc.price)  AS channel_max,
       COUNT(DISTINCT sqc.supplier_id) AS supplier_count,
       COUNT(*)        AS quote_count,
       MAX(sqc.created_at) AS last_quote_at,
       (p.standard_cost - MIN(sqc.price)) AS gap_to_min
  FROM products p
  JOIN supplier_quote_channels sqc ON sqc.product_id = p.id
 WHERE p.deleted_at IS NULL
 GROUP BY p.id, p.name, p.barcode, p.base_unit, p.standard_cost;


-- 与既有 system_settings 同构：value 是 JSONB，键为 setting_key；作用域 hq。
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark)
VALUES
  ('连锁管理', 'chain.enabled',                   '启用连锁模式',            'false'::jsonb, 'false'::jsonb, 'bool',   NULL, '开启后总部/门店两级视图与数据范围隔离生效；单店保持关闭（零回归）'),
  ('连锁管理', 'chain.cost.mode',                 '进价管理模型',            '"yi"'::jsonb,  '"yi"'::jsonb,  'enum',   '[{"v":"yi","label":"乙｜最低价采纳（推荐）"}]'::jsonb, '乙模型：L1 只可能被拉低、不可能被门店抬高（R8）'),
  ('连锁管理', 'chain.cost.auto_adopt_new',       '新品首进自动采纳进价',    'true'::jsonb,  'true'::jsonb,  'bool',   NULL, 'L1 为空（新品首到货）时自动采纳本次实价 → 新品立刻获得红线保护'),
  ('连锁管理', 'chain.cost.quote_valid_days',     '低价有效期（天）',        '90'::jsonb,    '90'::jsonb,    'number', NULL, '一次极低价只在这么多天内作为红线兜底，超期自动降级为参考价'),
  ('连锁管理', 'chain.cost.auto_approve_delta',   '小额差异免审阈值（元）',  '0'::jsonb,     '0'::jsonb,     'number', NULL, '0 = 一律人工审；>0 时低于该差额的采纳申请自动通过'),
  ('连锁管理', 'chain.cost.allow_zero',           '无基准允许以 0 入账',     'true'::jsonb,  'true'::jsonb,  'bool',   NULL, '开：现场不断货（挂待办）；关：禁止提交并提示先维护进价'),
  ('连锁管理', 'chain.cost.gate1',                '采购事前闸门',            '"on"'::jsonb,  '"on"'::jsonb,  'enum',   '[{"v":"on","label":"开启（采购申请超阈转总部批准）"},{"v":"off","label":"关闭"}]'::jsonb, '事前闸门：此时一分钱没花，拒绝成本为 0（R15）'),
  ('连锁管理', 'chain.cost.dev_threshold',        '标品进价偏离阈值（%）',   '15'::jsonb,    '15'::jsonb,    'number', NULL, '门店自采/入库实价高于 L1 超过该比例即触发异常'),
  ('连锁管理', 'chain.cost.fresh_threshold',      '生鲜进价偏离阈值（%）',   '25'::jsonb,    '25'::jsonb,    'number', NULL, '生鲜价格波动大，阈值放宽'),
  ('连锁管理', 'chain.cost.high_policy',          '高进价处理策略',          '"monitor"'::jsonb, '"monitor"'::jsonb, 'enum', '[{"v":"monitor","label":"只通知（推荐）"},{"v":"review","label":"需总部裁决"},{"v":"block","label":"先入待审（24h 超时自动认可）"}]'::jsonb, '不阻断收货：货到门口拒不了物流，硬拦会让现场编假价绕过'),
  ('连锁管理', 'chain.cost.adjust_window_h',      '调账时限（小时）',        '24'::jsonb,    '24'::jsonb,    'number', NULL, '高进价处置单超时自动结案时限'),
  ('连锁管理', 'chain.cost.notify_channel',       '异常通知渠道',            '"inapp"'::jsonb, '"inapp"'::jsonb, 'enum', '[{"v":"inapp","label":"站内消息（推荐）"},{"v":"inapp,sms","label":"站内 + 短信"}]'::jsonb, '异常进价通知方式'),
  ('连锁管理', 'chain.variance.enabled',          '启用对账差异单',          'true'::jsonb,  'true'::jsonb,  'bool',   NULL, '对账按 L1 结算时，实价差额自动生成进价差异单（R17）'),
  ('连锁管理', 'chain.variance.pickup_raise_l1',  '补差时同步上调 L1',       'true'::jsonb,  'true'::jsonb,  'bool',   NULL, '补差=承认实价为真价；不开则下期会再次生成同样的差异单（会重复多付）'),
  ('连锁管理', 'chain.variance.carry_mode',       '补差计入方式',            '"next_recon"'::jsonb, '"next_recon"'::jsonb, 'enum', '[{"v":"next_recon","label":"计入下期对账（推荐）"},{"v":"immediate","label":"即时挂账"}]'::jsonb, '补差的挂账时机'),
  ('连锁管理', 'chain.variance.default_disposition', '差异默认处置',         '"writeoff"'::jsonb, '"writeoff"'::jsonb, 'enum', '[{"v":"pickup","label":"补差（计入下次对账，付给供应商）"},{"v":"writeoff","label":"冲差（审核落库，不再参与对账）"}]'::jsonb, '差异单两个出口之一（R17）'),
  ('连锁管理', 'chain.variance.sla_days',         '差异单账龄提醒（天）',    '30'::jsonb,    '30'::jsonb,    'number', NULL, '超期转「交涉中」并提醒总部'),
  ('连锁管理', 'chain.variance.alert_days',       '差异单告警（天）',        '60'::jsonb,    '60'::jsonb,    'number', NULL, '超期升级告警'),
  ('连锁管理', 'chain.variance.force_close_days', '差异单强制结案（天）',    '90'::jsonb,    '90'::jsonb,    'number', NULL, '超期默认按「冲差」结案（宁可少付，不轻易承诺付款）'),
  ('连锁管理', 'chain.return.cross_enabled',      '允许跨店退货',            'true'::jsonb,  'true'::jsonb,  'bool',   NULL, 'R6：A 店购买可到 B 店退（受理店出钱、原销店冲业绩）'),
  ('连锁管理', 'chain.return.cross_cash',         '跨店退货允许现金',        'false'::jsonb, 'false'::jsonb, 'bool',   NULL, '默认禁：现金在受理店出、受益方是原销店 → 会造成钱箱短款与店间往来'),
  ('连锁管理', 'chain.transfer.hq_audit',         '店间调拨须总部审核',      'true'::jsonb,  'true'::jsonb,  'bool',   NULL, 'R5：唯一审核方 = 总部，门店角色不授 hq.stock.transfer.audit'),
  ('连锁管理', 'chain.product.self_apply',        '门店申请上架需总部批',    'true'::jsonb,  'true'::jsonb,  'bool',   NULL, 'R2：关掉则门店申请即时生效（不推荐）'),
  ('连锁管理', 'chain.stock.hq_negative',         '总部仓允许负库存',        'true'::jsonb,  'true'::jsonb,  'bool',   NULL, 'R12 C 方案：仅总部仓可负（强制挂采购需求）；门店端恒禁止'),
  ('连锁管理', 'chain.sync.enabled',              '启用数据同步',            'false'::jsonb, 'false'::jsonb, 'bool',   NULL, '批次4：门店节点主动推送销售/库存到总部'),
  ('连锁管理', 'chain.sync.interval_sec',         '同步间隔（秒）',          '30'::jsonb,    '30'::jsonb,    'number', NULL, '门店节点推送周期'),
  ('连锁管理', 'chain.sync.batch_size',           '同步批量',                '200'::jsonb,   '200'::jsonb,   'number', NULL, '单次推送的最大记录数'),
  ('连锁管理', 'chain.sync.offline_hours',        '离线告警（小时）',        '24'::jsonb,    '24'::jsonb,    'number', NULL, '门店最老待推记录超过该时长 → 总部告警'),
  ('连锁管理', 'chain.sync.pull_interval_sec',    '下行拉取间隔（秒）',      '60'::jsonb,    '60'::jsonb,    'number', NULL, '门店拉取总部商品/价格/设置的周期')
ON CONFLICT (setting_key) DO NOTHING;
