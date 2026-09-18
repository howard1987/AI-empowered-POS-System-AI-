-- ══════════════════════════════════════════════════════════════════════════════
-- 109_v500_sync_seed.sql · V5.0.0 连锁改造 批次4A「同步层地基」
--
-- 内容（方案 §4.2 / §4.7 / §4.9 / §4.10）：
--   ① 同步时钟基础设施：sync_seq 节点内单调序列 + sync_hlc 单行 HLC 表
--   ② sync_outbox 补 HLC 字段（hlc_counter / next_retry_at）——105 建表时未含
--   ③ sync_nodes 补节点自认字段（is_self / self_token / hq_base / last_report / paused_until）
--   ④ 本节点自注册：总部（含单店）自动登记一行 node_role='hq'、is_self=true
--   ⑤ 每日对账异常表 sync_recon_daily（M4-10）
--   ⑥ 门店角色作用域校准（把 scope_type='store' 的角色里误授的 hq.* 权限点清掉）
--
-- 【单店零回归的铁律】本文件在单店库上跑完的效果必须是：
--   · sync_nodes 有且仅有 1 行（node_role='hq', is_self=true）→ nodeIdentity() 返回 role='hq'
--   · enqueueSync() 在 role='hq' 时【直接 no-op】→ sync_outbox 恒为 0 行，业务零影响
--   · sync_outbox / sync_inbox / sync_changes / sync_conflicts 保持空表
--   · 06 门店角色校准在单店下只作用于"非超管"角色，超管（scope_type='hq'）不受影响
--
-- 【幂等】全部语句级幂等；init-db 为语句级重放，禁 ALTER TYPE ... ADD VALUE（本文件未用）
-- ══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 同步时钟基础设施
-- ─────────────────────────────────────────────────────────────────────────────

-- 节点内单调序号（方案 §4.3.1 的 nextval('sync_seq')）。
-- 语义：只在【单个节点的库】内单调，用于同节点内保序；跨节点比较必须带 node_code。
CREATE SEQUENCE IF NOT EXISTS sync_seq;
COMMENT ON SEQUENCE sync_seq IS 'V5.0.0：上行发件箱节点内单调序号（跨节点比较须带 node_code）';

-- HLC 混合逻辑时钟（方案 §4.7）：physical 毫秒 + counter，落库保证多进程/重启后不回退。
-- 单行表（id 恒 = 1）。enqueueSync 在同事务内推进它。
CREATE TABLE IF NOT EXISTS sync_hlc (
  id         INT PRIMARY KEY DEFAULT 1,
  physical   BIGINT NOT NULL DEFAULT 0,          -- 毫秒时间戳（HLC 的物理部分）
  counter    BIGINT NOT NULL DEFAULT 0,          -- 同毫秒内计数（HLC 的逻辑部分）
  node_code  VARCHAR(32),                        -- 最后推进它的节点（诊断用）
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_sync_hlc_single CHECK (id = 1)
);
INSERT INTO sync_hlc (id, physical, counter) VALUES (1, 0, 0)
  ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE sync_hlc IS 'V5.0.0 HLC 混合逻辑时钟（方案 §4.7）：跨店业务先后一律用 (biz_ts,node_code,seq) 排序，绝不用纯 created_at';

-- ─────────────────────────────────────────────────────────────────────────────
-- ② sync_outbox 补 HLC / 退避字段（105 建表时未含）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS hlc_counter   BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
COMMENT ON COLUMN sync_outbox.hlc_counter   IS 'V5.0.0：HLC 逻辑计数（与 biz_ts/node_code 组成全序排序键）';
COMMENT ON COLUMN sync_outbox.next_retry_at IS 'V5.0.0：指数退避的下次可发送时刻（NULL = 立即可发）';

-- 退避取件索引（pushOnce 的 WHERE status IN ('pending','failed') AND (next_retry_at IS NULL OR next_retry_at <= now())）
CREATE INDEX IF NOT EXISTS idx_outbox_retry ON sync_outbox (next_retry_at)
  WHERE status IN ('pending','failed');

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ sync_nodes 补节点自认 / 运行态字段
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE sync_nodes ADD COLUMN IF NOT EXISTS is_self       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sync_nodes ADD COLUMN IF NOT EXISTS self_token    VARCHAR(128);   -- 门店本地：明文节点令牌（总部侧为 NULL）
ALTER TABLE sync_nodes ADD COLUMN IF NOT EXISTS hq_base       VARCHAR(160);   -- 门店本地：总部基地址（如 http://192.168.1.10:3100）
ALTER TABLE sync_nodes ADD COLUMN IF NOT EXISTS last_report   JSONB;          -- 末次心跳上报的本地统计（对账 M4-10 用）
ALTER TABLE sync_nodes ADD COLUMN IF NOT EXISTS paused_until  TIMESTAMPTZ;    -- 熔断（§4.8：同店连续 3 批失败暂停 30 分钟）
ALTER TABLE sync_nodes ADD COLUMN IF NOT EXISTS last_nonce    VARCHAR(64);    -- 重放防护（§4.9：同 nonce 5 分钟内只受理一次）
ALTER TABLE sync_nodes ADD COLUMN IF NOT EXISTS last_nonce_at TIMESTAMPTZ;

COMMENT ON COLUMN sync_nodes.is_self      IS 'V5.0.0：true = 本行描述的是「本节点自己」（总部库 = hq 行；门店库 = store 行）';
COMMENT ON COLUMN sync_nodes.self_token   IS 'V5.0.0：本节点持有的明文令牌（仅本库自身行有值；总部侧存 bcrypt 于 secret_hash）';
COMMENT ON COLUMN sync_nodes.hq_base      IS 'V5.0.0：门店节点要推往的总部基地址；总部节点自身为 NULL';
COMMENT ON COLUMN sync_nodes.last_report  IS 'V5.0.0：节点心跳上报 {date,orders,amount,stockSku,pending}（每日对账比对基准）';
COMMENT ON COLUMN sync_nodes.paused_until IS 'V5.0.0：熔断截止时刻（连续失败 3 批 → 暂停 30 分钟，避免打爆总部）';

-- 每节点只能有一行 is_self=true（防「门店库混入第二条自身行」导致身份二义）
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_nodes_self ON sync_nodes ((is_self)) WHERE is_self;

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ 本节点自注册（总部 / 单店）
--    连锁库：org_type='hq' 的行 = 本节点；单店库（批次1 口径：无 hq 行）：id 最小的店行即本节点。
--    两种形态都登记为 node_role='hq' —— enqueueSync() 对 role='hq' 直接 no-op（单店零回归）。
--    幂等：仅当库里没有任何 is_self 行时才插入；门店库的自身行由配置向导写入（不经此语句）
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO sync_nodes (node_code, store_id, name, node_role, is_self, status)
SELECT 'HQ-' || LPAD(s.id::text, 6, '0'), s.id, s.name, 'hq', true, '启用'
  FROM stores s
 WHERE (s.org_type = 'hq'
        OR (NOT EXISTS (SELECT 1 FROM stores WHERE org_type = 'hq')
            AND s.id = (SELECT MIN(id) FROM stores)))
   AND NOT EXISTS (SELECT 1 FROM sync_nodes WHERE is_self)
 ORDER BY s.id
 LIMIT 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- ⑤ 每日对账异常表（方案 §4.10；M4-10）
--    kind: count 单量 / amount 金额 / stock 库存抽样 / member 会员资产 / lineage 批次血缘
--    UNIQUE(recon_date, store_id, kind) → 同日同店同口径只有一条，重跑覆盖（幂等）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_recon_daily (
  id          BIGSERIAL PRIMARY KEY,
  recon_date  DATE NOT NULL,
  store_id    BIGINT NOT NULL,
  node_code   VARCHAR(32),
  kind        VARCHAR(12) NOT NULL,                  -- count/amount/stock/member/lineage
  hq_value    NUMERIC(16,4) NOT NULL DEFAULT 0,      -- 总部侧口径值
  node_value  NUMERIC(16,4) NOT NULL DEFAULT 0,      -- 门店上报口径值
  diff        NUMERIC(16,4) NOT NULL DEFAULT 0,      -- hq_value - node_value
  detail      JSONB,                                 -- 定位信息（缺失单号区间 / 差异 SKU 列表）
  status      VARCHAR(12) NOT NULL DEFAULT '异常',    -- 异常/已处理/已忽略
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recon_date, store_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_syncrecon_date ON sync_recon_daily (recon_date DESC, store_id);
CREATE INDEX IF NOT EXISTS idx_syncrecon_open ON sync_recon_daily (status, recon_date DESC) WHERE status = '异常';
COMMENT ON TABLE sync_recon_daily IS 'V5.0.0 每日对数异常（方案 §4.10）：差异≠0 才落行；同日同店同口径唯一，重跑即覆盖';

-- ─────────────────────────────────────────────────────────────────────────────
-- ⑥ 门店角色作用域校准
--    门店作用域角色（scope_type='store'）不得持有总部权限点（hq.*）——
--    批次2 已修种子（033_role_default_perms.sql）；此处清理【存量库】里已误授的行。
--    超管角色 scope_type='hq'，不在清理范围（单店零回归）。
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM role_permissions rp
 USING permission_points pp, roles r
 WHERE rp.permission_id = pp.id
   AND rp.role_id = r.id
   AND COALESCE(r.scope_type, 'store') = 'store'
   AND pp.code LIKE 'hq.%';

-- 存量角色补默认作用域（104 已设默认值，此处兜底历史 NULL 行）
UPDATE roles SET scope_type = 'store', data_scope = 'self'
 WHERE scope_type IS NULL OR data_scope IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- ⑦ 同步管理权限点（批次4 前端「数据同步」页用；超管同步授予）
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO permission_points (code, name, module)
VALUES ('hq.sync.view',   '查看数据同步（节点水位/失败明细）', '总部同步'),
       ('hq.sync.manage', '同步管理操作（重推/节点启停）',     '总部同步')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
  FROM roles r CROSS JOIN permission_points pp
 WHERE r.name = '超级管理员' AND pp.code IN ('hq.sync.view', 'hq.sync.manage')
ON CONFLICT DO NOTHING;
