-- ═══ 105_v500_store_products.sql · V5.0.0 连锁批次3~4 地基：门店商品下发台账 + 同步表 + 调拨/批次血缘 ═══
-- 依据：超市收银系统-连锁版改造方案.md §3.3.2（store_products）/ §3.4.3（拆批调拨）/ §3.4.5（视图）/ §3.4.7（血缘）/ §4.2（同步六表）
--
-- 设计原则（单店零回归）：
--   ① store_products 单店为空 → PRODUCT_VISIBLE() 退化为「仅本店建档」→ 与改造前 100% 一致；
--   ② 本迁移只建表/加列，不改动任何业务数据语义（唯一例外：products.standard_cost 默认 NULL，
--      红线取 GREATEST(0, min_price 或 售价×0.6) 的行为在 standard_cost 为空时不变化）；
--   ③ 同步六表在单店下永远为空（无 hq 行 → 同步层休眠）。
--
-- 幂等：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING。

-- ─────────────────────────────────────────────────────────────
-- ① 门店商品下发台账（方案 §3.3.2）——「可售」的唯一依据
--    ⚠️ 本表不存价格：价格唯一由 product_store_prices 承载（杜绝双价源）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store_products (
  store_id      BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id    BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  is_listed     BOOLEAN NOT NULL DEFAULT true,      -- 门店上架状态（沽清 = false）
  is_forced_off BOOLEAN NOT NULL DEFAULT false,     -- 总部强制停售（门店不可覆盖，优先级最高）
  min_stock     NUMERIC(12,3),                      -- 门店级补货下限（空 = 用总部）
  max_stock     NUMERIC(12,3),                      -- 门店级目标库存（空 = 用总部）
  source        VARCHAR(12) NOT NULL DEFAULT 'hq',  -- hq 总部下发 / local 门店自建
  version       BIGINT NOT NULL DEFAULT 0,          -- 下发版本（同步冲突 LWW by version）
  published_at  TIMESTAMPTZ,                        -- 最近一次下发时间
  synced_at     TIMESTAMPTZ,                        -- 最近一次上行确认时间
  updated_by    BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_sp_product      ON store_products (product_id);
CREATE INDEX IF NOT EXISTS idx_sp_store_listed ON store_products (store_id, is_listed);
CREATE INDEX IF NOT EXISTS idx_sp_forced_off   ON store_products (store_id) WHERE is_forced_off;

COMMENT ON TABLE  store_products             IS '门店商品下发台账（V5.0.0）：商品能否在本店「可售」的唯一依据；不存价格';
COMMENT ON COLUMN store_products.is_listed   IS '门店上架=true / 本店沽清=false；总部强制停售时本列无意义（is_forced_off 优先）';
COMMENT ON COLUMN store_products.is_forced_off IS '总部强制停售：价目表直接过滤，门店不可覆盖（HQ-WINS）';
COMMENT ON COLUMN store_products.source      IS 'hq 总部下发 / local 门店自建（门店自建品仅本店可售，收编前不参与下发）';

-- ─────────────────────────────────────────────────────────────
-- ② 门店商品申请台账（方案 §3.3.2 配套表 / R2）
--    门店看到总部档案想要卖 → 申请上架；门店自建品 → 收编申请
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store_product_requests (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind         VARCHAR(16) NOT NULL DEFAULT 'apply',    -- apply 申请上架 / local_adopt 店建品收编
  status       VARCHAR(12) NOT NULL DEFAULT 'pending',  -- pending/approved/rejected
  reason       VARCHAR(128),
  audit_remark VARCHAR(128),
  audited_by   BIGINT,
  audited_at   TIMESTAMPTZ,
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, product_id, kind, status)           -- 同商品同类型只允许一条待审
);
CREATE INDEX IF NOT EXISTS idx_spr_status ON store_product_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spr_store  ON store_product_requests (store_id, created_at DESC);
COMMENT ON TABLE store_product_requests IS '门店申请上架 / 店建品收编台账（V5.0.0，R2）；单店部署为空';

-- ─────────────────────────────────────────────────────────────
-- ③ products：标准进价 L1（方案 §5.1.6-⓪ 三层成本模型）
--    L1 是「价格红线的唯一进价依据」；门店不可写，只有总部可维护。
--    ⚠️ 默认 NULL：红线在 L1 为空时行为与改造前完全一致（零回归）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS standard_cost NUMERIC(12,4);
COMMENT ON COLUMN products.standard_cost IS '标准进价 L1（V5.0.0，R8）：价格红线的唯一进价依据；仅总部可写，门店只读 + 差异申请';

CREATE INDEX IF NOT EXISTS idx_products_std_cost ON products (standard_cost) WHERE standard_cost IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- ④ 批次血缘四字段（方案 §3.4.7）——拆批调拨后的溯源链
--    小票 → sale_item_batches → batches → origin_batch_no → 入库单 → 采购单 → 供应商
-- ─────────────────────────────────────────────────────────────
ALTER TABLE batches ADD COLUMN IF NOT EXISTS origin_batch_no    VARCHAR(48);  -- 根批次号（首跳即固化，永不改）
ALTER TABLE batches ADD COLUMN IF NOT EXISTS source_batch_id    BIGINT;       -- 上一跳批次
ALTER TABLE batches ADD COLUMN IF NOT EXISTS source_transfer_id BIGINT;       -- 来源调拨单
ALTER TABLE batches ADD COLUMN IF NOT EXISTS origin_inbound_id  BIGINT;       -- 最初入库单（供应商退货溯源）

COMMENT ON COLUMN batches.origin_batch_no    IS '血缘根批次号（V5.0.0）：调拨、退货、拆批全程承袭，永不更改；守恒校验的 key';
COMMENT ON COLUMN batches.source_batch_id    IS '上一跳批次 id（拆批调拨前身）';
COMMENT ON COLUMN batches.source_transfer_id IS '来源调拨单 id';
COMMENT ON COLUMN batches.origin_inbound_id  IS '最初入库单 id（供应商退货按此溯源）';

CREATE INDEX IF NOT EXISTS idx_batch_origin ON batches (origin_batch_no) WHERE origin_batch_no IS NOT NULL;

-- 存量数据回填：首跳批次（无来源）的根批次号 = 自身批次号；origin_inbound_id = 自身入库单
UPDATE batches SET origin_batch_no = batch_no
 WHERE origin_batch_no IS NULL;
UPDATE batches SET origin_inbound_id = inbound_order_id
 WHERE origin_inbound_id IS NULL AND inbound_order_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- ⑤ 调拨拆批与在途（方案 §3.4.3 / §3.4.4）
--    原表 batch_id NOT NULL = 只能整批转移；连锁必须支持「按批次拆量」
-- ─────────────────────────────────────────────────────────────
ALTER TABLE stock_transfer_items ADD COLUMN IF NOT EXISTS qty              NUMERIC(12,3);  -- 调拨数量（拆批后的量）
ALTER TABLE stock_transfer_items ADD COLUMN IF NOT EXISTS recv_qty         NUMERIC(12,3);  -- 实收数量（空 = 待收）
ALTER TABLE stock_transfer_items ADD COLUMN IF NOT EXISTS diff_qty         NUMERIC(12,3);  -- 差异（生成差异报损 / 补单）
ALTER TABLE stock_transfer_items ADD COLUMN IF NOT EXISTS recv_batch_id    BIGINT;          -- 收货方新建批次（批次账本分离）
ALTER TABLE stock_transfer_items ADD COLUMN IF NOT EXISTS origin_batch_no  VARCHAR(48);     -- 承袭的根批次号
ALTER TABLE stock_transfers      ADD COLUMN IF NOT EXISTS sync_version     BIGINT NOT NULL DEFAULT 0;
ALTER TABLE stock_transfers      ADD COLUMN IF NOT EXISTS hq_audit_by      BIGINT;          -- 总部审核人（R5：唯一审核方）
ALTER TABLE stock_transfers      ADD COLUMN IF NOT EXISTS hq_audited_at    TIMESTAMPTZ;
ALTER TABLE stock_transfers      ADD COLUMN IF NOT EXISTS biz_scope        VARCHAR(12) NOT NULL DEFAULT 'hq2store'; -- hq2store 配送 / store2store 店间 / direct 直送

COMMENT ON COLUMN stock_transfer_items.qty             IS '调拨数量（V5.0.0 拆批）：与 batch_id 组合 = 从该批次调出多少';
COMMENT ON COLUMN stock_transfer_items.origin_batch_no IS '承袭的根批次号（血缘，收货方新建批次时写入）';
COMMENT ON COLUMN stock_transfers.biz_scope            IS 'hq2store 总部配送 / store2store 门店间调拨 / direct 供应商直送（两步记账）';

-- 存量回填：qty 空则取批次整批入库量（保持原「整批转移」语义）
UPDATE stock_transfer_items i SET qty = b.inbound_qty
  FROM batches b
 WHERE i.qty IS NULL AND i.batch_id = b.id;
UPDATE stock_transfer_items i SET origin_batch_no = b.origin_batch_no
  FROM batches b
 WHERE i.origin_batch_no IS NULL AND i.batch_id = b.id;
UPDATE stock_transfers SET biz_scope = 'store2store'
 WHERE from_store_id IS NOT NULL AND to_store_id IS NOT NULL;

-- 门店非负库存约束（方案 §3.4.6 C 方案：门店严禁负库存，总部仓可为负）
-- 用 CHECK 表达「非总部仓不得为负」需要跨表条件（PG 不支持 CHECK 引用他表）→
-- 故约束在应用层实现（store-price/transfer 写入前校验），此处只加索引便于核查。
CREATE INDEX IF NOT EXISTS idx_invc_negative ON inventory_current (store_id, product_id) WHERE qty_total < 0;
COMMENT ON INDEX idx_invc_negative IS '负库存核查索引（V5.0.0）：门店出现负库存即为异常，门店端严禁；仅总部仓允许';

-- ─────────────────────────────────────────────────────────────
-- ⑥ 同步六表（方案 §4.2）——单店部署永远为空（同步层休眠）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_outbox (
  id         BIGSERIAL PRIMARY KEY,
  node_code  VARCHAR(32) NOT NULL,
  entity     VARCHAR(32) NOT NULL,
  entity_id  BIGINT,
  op         VARCHAR(8)  NOT NULL,        -- upsert/append/delete
  payload    JSONB NOT NULL,
  biz_ts     TIMESTAMPTZ NOT NULL,
  seq        BIGINT NOT NULL,
  idem_key   VARCHAR(128) NOT NULL,
  status     VARCHAR(12) NOT NULL DEFAULT 'pending',  -- pending/sent/failed/dead
  retry      INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at    TIMESTAMPTZ,
  UNIQUE (idem_key)
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON sync_outbox (status, id) WHERE status IN ('pending','failed');
COMMENT ON TABLE sync_outbox IS '上行发件箱（V5.0.0）：与业务写【同事务】入队，崩溃/断电也不丢数据';

CREATE TABLE IF NOT EXISTS sync_inbox (
  id         BIGSERIAL PRIMARY KEY,
  from_node  VARCHAR(32) NOT NULL,
  entity     VARCHAR(32) NOT NULL,
  entity_id  BIGINT,
  op         VARCHAR(8)  NOT NULL,
  payload    JSONB NOT NULL,
  version    BIGINT NOT NULL,
  idem_key   VARCHAR(128) NOT NULL UNIQUE,
  status     VARCHAR(12) NOT NULL DEFAULT 'pending',  -- pending/applied/failed
  applied_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inbox_pending ON sync_inbox (status, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS sync_nodes (
  node_code     VARCHAR(32) PRIMARY KEY,
  store_id      BIGINT REFERENCES stores(id),
  name          VARCHAR(64),
  node_role     VARCHAR(8) NOT NULL DEFAULT 'store',   -- hq/store
  api_base      VARCHAR(128),
  secret_hash   VARCHAR(128),
  out_watermark BIGINT NOT NULL DEFAULT 0,             -- 已收到的门店 seq 水位
  in_version    BIGINT NOT NULL DEFAULT 0,             -- 已下发的版本水位
  last_seen_at  TIMESTAMPTZ,
  last_ok_at    TIMESTAMPTZ,
  fail_count    INT NOT NULL DEFAULT 0,
  status        VARCHAR(12) NOT NULL DEFAULT '启用',
  protocol_ver  INT NOT NULL DEFAULT 1,                -- 版本协商
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          BIGSERIAL PRIMARY KEY,
  node_code   VARCHAR(32),
  direction   VARCHAR(8) NOT NULL,       -- push/pull
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  sent        INT DEFAULT 0,
  recv        INT DEFAULT 0,
  failed      INT DEFAULT 0,
  duration_ms INT,
  msg         TEXT
);
CREATE INDEX IF NOT EXISTS idx_syncruns_node ON sync_runs (node_code, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_changes (
  version    BIGSERIAL PRIMARY KEY,      -- 全局单调版本（天然水位）
  entity     VARCHAR(32) NOT NULL,
  entity_id  BIGINT,
  op         VARCHAR(8) NOT NULL,
  payload    JSONB NOT NULL,
  target     VARCHAR(16) NOT NULL DEFAULT 'all',  -- all / store / stores
  target_ids BIGINT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_syncchg_entity ON sync_changes (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_syncchg_ver    ON sync_changes (version);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id           BIGSERIAL PRIMARY KEY,
  entity       VARCHAR(32) NOT NULL,
  entity_id    BIGINT,
  node_code    VARCHAR(32),
  field        VARCHAR(32),
  local_value  TEXT,
  remote_value TEXT,
  rule         VARCHAR(24),              -- hq-wins/store-wins/lww/manual
  status       VARCHAR(12) NOT NULL DEFAULT '待裁决',
  resolution   VARCHAR(12),
  resolved_by  BIGINT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_synccf_status ON sync_conflicts (status, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- ⑦ 总部库存汇总视图（方案 §3.4.5）
--    估值口径按主体区分：门店 = 售价口径；总部仓 = 成本口径（老板第 3 条拍板）
--    ⚠️ 口径写在视图里而不是前端：value_basis 随行返回，避免有人把两类数字加在一起
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_hq_stock_summary AS
SELECT s.id AS store_id, s.name AS store_name, s.store_no, s.org_type,
       COUNT(DISTINCT ic.product_id) AS sku_count,
       CASE WHEN s.org_type = 'hq'
            THEN COALESCE(SUM(ic.qty_total * p.standard_cost), 0)
            ELSE COALESCE(SUM(ic.qty_total * COALESCE(psp.sell_price, p.sell_price)), 0)
       END AS stock_value,
       COALESCE(SUM(ic.qty_total), 0) AS qty_total,
       CASE WHEN s.org_type = 'hq' THEN 'cost' ELSE 'retail' END AS value_basis
  FROM stores s
  LEFT JOIN inventory_current ic ON ic.store_id = s.id
  LEFT JOIN products p ON p.id = ic.product_id
  LEFT JOIN product_store_prices psp ON psp.product_id = ic.product_id AND psp.store_id = s.id
 WHERE s.status = 1
 GROUP BY s.id, s.name, s.store_no, s.org_type;
COMMENT ON VIEW v_hq_stock_summary IS '总部库存汇总（V5.0.0）：门店售价口径 / 总部仓成本口径，value_basis 随行返回；只要门店合计加 WHERE org_type=''store''';

-- ─────────────────────────────────────────────────────────────
-- ⑧ chain.* 设置键种子（总部级，门店不可改，只接收下发）
--    单店部署下这些键默认值即「连锁逻辑关闭」的取值 → 零回归
-- ─────────────────────────────────────────────────────────────
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark, scope) VALUES
('门店与运维','chain.enabled',           '启用连锁模式',        'false'::jsonb,'false'::jsonb,'bool',  NULL,
 '开启后本节点作为总部/门店节点参与多店体系；单店部署保持关闭', 'hq'),
('门店与运维','chain.node_role',         '本节点角色',          '"standalone"'::jsonb,'"standalone"'::jsonb,'enum',
 '["standalone","hq","store"]'::jsonb, '单机 standalone / 总部 hq / 门店 store', 'hq'),
('商品与库存','chain.product.self_apply','门店申请上架免批',    'false'::jsonb,'false'::jsonb,'bool',  NULL,
 '关闭（默认）= 门店申请上架需总部批准；开启 = 自动通过（总控权在总部）', 'hq'),
('商品与库存','chain.product.auto_publish','建档自动下发全部门店','false'::jsonb,'false'::jsonb,'bool', NULL,
 '总部新建商品时是否默认下发到全部门店', 'hq'),
('进销存','chain.stock.hq_negative',      '允许总部仓负库存',    'true'::jsonb, 'true'::jsonb, 'bool',  NULL,
 '总部仓可负（强制挂采购需求），门店严禁负库存（C 方案）', 'hq'),
('进销存','chain.cost.mode',              '进价采纳模型',        '"yi"'::jsonb, '"yi"'::jsonb, 'enum',
 '["yi"]'::jsonb, 'yi = 最低价采纳（L1 只降不升）；第一期仅此一种', 'hq'),
('进销存','chain.cost.auto_adopt_new',    '新品首进自动采纳为L1','true'::jsonb, 'true'::jsonb, 'bool',  NULL,
 '总部无该商品进价时，门店首笔实价自动成为 L1（老板「即建档，写进价」）', 'hq'),
('进销存','chain.cost.quote_valid_days',  '低价有效期(天)',      '90'::jsonb,   '90'::jsonb,   'number',NULL,
 '超期后该低价退出红线兜底（降级为参考价），避免一次极低价长期压低全连锁售价', 'hq'),
('进销存','chain.cost.auto_approve_delta', '小额差异免审额(元)',  '0'::jsonb,    '0'::jsonb,    'number',NULL,
 '0 = 一律人工审；>0 = 低于 L1 的差额小于该值可自动采纳', 'hq'),
('进销存','chain.cost.allow_zero',        '无基准允许以0入账',    'true'::jsonb, 'true'::jsonb, 'bool',  NULL,
 '总部未维护进价时允许以 0 入账并挂待办，保证现场不断货', 'hq'),
('进销存','chain.cost.gate1',             '高进价事前闸门',      '"on"'::jsonb, '"on"'::jsonb, 'enum',
 '["off","on"]'::jsonb, 'on = 门店自采采购申请报价超阈值须总部批准（此时一分钱没花，拒绝成本为 0）', 'hq'),
('进销存','chain.cost.high_policy',       '高进价事中策略',      '"monitor"'::jsonb, '"monitor"'::jsonb, 'enum',
 '["monitor","review","block"]'::jsonb, 'monitor 仅通知 / review 需总部确认 / block=先入账挂待审（绝不阻断收货）', 'hq'),
('进销存','chain.cost.high_threshold',    '高进价阈值-标品(%)',   '15'::jsonb,   '15'::jsonb,   'number',NULL,
 '实价高于 L1 超过该比例即判异常', 'hq'),
('进销存','chain.cost.high_threshold_fresh','高进价阈值-生鲜(%)', '25'::jsonb,   '25'::jsonb,   'number',NULL,
 '生鲜损耗大，阈值放宽', 'hq'),
('进销存','chain.cost.low_threshold',     '低进价阈值-标品(%)',   '20'::jsonb,   '20'::jsonb,   'number',NULL,
 '实价低于 L1 超过该比例即判异常（不可复现的低价要留意）', 'hq'),
('进销存','chain.cost.low_threshold_fresh','低进价阈值-生鲜(%)',  '30'::jsonb,   '30'::jsonb,   'number',NULL, NULL, 'hq'),
('进销存','chain.cost.adjust_window_h',   '事后调账时限(h)',      '24'::jsonb,   '24'::jsonb,   'number',NULL,
 'block 策略下超时自动按 accept 结案并升级告警', 'hq'),
('进销存','chain.cost.merge_days',        '异常合并窗口(天)',     '7'::jsonb,    '7'::jsonb,    'number',NULL,
 '同店同商品同向异常在该窗口内合并为一条，防刷屏', 'hq'),
('进销存','chain.cost.escalate_cnt',      '异常升级笔数',        '3'::jsonb,    '3'::jsonb,    'number',NULL,
 '同向连续N笔升级「疑似异常渠道」告警', 'hq'),
('进销存','chain.cost.pickup_raise_l1',   '补差联动上调L1',      'true'::jsonb, 'true'::jsonb, 'bool',  NULL,
 '差异单选「补差」时同步把 L1 上调至本次实价，避免每期重复补同一笔差', 'hq'),
('进销存','chain.variance.settle_price_source','对账结算价来源',  '"l1"'::jsonb, '"l1"'::jsonb, 'enum',
 '["l1","actual"]'::jsonb, 'l1 = 门店自采买贵时按总部标准进价结算，差额进进价差异单（R17）', 'hq'),
('进销存','chain.variance.remind_days',   '差异单提醒(天)',      '30'::jsonb,   '30'::jsonb,   'number',NULL, NULL, 'hq'),
('进销存','chain.variance.alert_days',    '差异单告警(天)',      '60'::jsonb,   '60'::jsonb,   'number',NULL, NULL, 'hq'),
('进销存','chain.variance.force_close_days','差异单强制结案(天)', '90'::jsonb,   '90'::jsonb,   'number',NULL,
 '超期按「冲差」结案（宁可少付，不轻易承诺付款）', 'hq'),
('进销存','chain.variance.default_action','差异单默认处置',       '"writeoff"'::jsonb,'"writeoff"'::jsonb,'enum',
 '["pickup","writeoff"]'::jsonb, 'pickup 补差（计入下次对账付给供应商）/ writeoff 冲差（审核落库，不再参与对账）', 'hq'),
('收银与小票','chain.return.cross_cash',  '跨店退货允许现金退',   'false'::jsonb,'false'::jsonb,'bool',  NULL,
 '关闭（默认）：跨店退货走余额退回/原路退，避免受理店钱箱短款', 'hq')
ON CONFLICT (setting_key) DO NOTHING;

-- 说明：本迁移不改动任何业务数据；总部行建立与商品升格（products.store_id → HQ）属 §7.4 迁移脚本（M7-1），
--       与 M3 商品总部化同批上线，届时需先备份并做单店回归实测。
