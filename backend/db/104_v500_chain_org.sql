-- ═══ 104_v500_chain_org.sql · V5.0.0 连锁改造批次1「地基」：组织层级 + 数据范围 + 设置作用域 ═══
-- 依据：超市收银系统-连锁版改造方案.md §2.3 / §2.4 / §2.5 / §3.1 / §3.7（M1-1）
--
-- 设计原则（单店零回归）：
--   ① 所有新列均带安全默认值（org_type='store' / scope_type='store' / data_scope='self'）
--      → 单店部署行为与改造前 100% 一致（单店下 self 就是全部数据）
--   ② 本迁移【不改动任何业务数据】（不建总部行、不搬商品、不改 store_id）——
--      总部行建立与商品升格属 §7.4 迁移脚本（M7-1，需与 M3 商品总部化同批上线）
--   ③ 代码侧以「是否存在 org_type='hq' 的行」判定是否启用连锁作用域：
--      单店无总部行 → 作用域校验整体跳过 → 不存在任何回归面
--
-- 幂等：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING / NOT EXISTS 防重放。

-- ─────────────────────────────────────────────────────────────
-- ① stores：组织层级与同步节点信息（方案 §3.1）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_no       VARCHAR(16);                              -- 门店编码 S001
ALTER TABLE stores ADD COLUMN IF NOT EXISTS org_type       VARCHAR(8)  NOT NULL DEFAULT 'store';     -- hq 总部 / region 区域 / store 门店
ALTER TABLE stores ADD COLUMN IF NOT EXISTS parent_id      BIGINT REFERENCES stores(id);             -- 上级组织
ALTER TABLE stores ADD COLUMN IF NOT EXISTS region         VARCHAR(32);                              -- 区域（如「川东片区」）
ALTER TABLE stores ADD COLUMN IF NOT EXISTS franchise      VARCHAR(8)  NOT NULL DEFAULT '直营';      -- 直营/加盟
ALTER TABLE stores ADD COLUMN IF NOT EXISTS open_date      DATE;                                     -- 开业日期
ALTER TABLE stores ADD COLUMN IF NOT EXISTS close_date     DATE;                                     -- 闭店日期
ALTER TABLE stores ADD COLUMN IF NOT EXISTS mgr_employee_id BIGINT;                                  -- 店长（employee id）
ALTER TABLE stores ADD COLUMN IF NOT EXISTS node_code      VARCHAR(32);                              -- 同步节点唯一码（如 S001-A7F3）
ALTER TABLE stores ADD COLUMN IF NOT EXISTS node_api_base  VARCHAR(128);                             -- 门店服务地址（内网/公网，仅参考展示）
ALTER TABLE stores ADD COLUMN IF NOT EXISTS sync_enabled   BOOLEAN NOT NULL DEFAULT true;            -- 是否参与同步
ALTER TABLE stores ADD COLUMN IF NOT EXISTS last_sync_at   TIMESTAMPTZ;                              -- 最近一次成功同步
ALTER TABLE stores ADD COLUMN IF NOT EXISTS node_secret    VARCHAR(64);                              -- 节点密钥（同步鉴权，方案 §4.2）
ALTER TABLE stores ADD COLUMN IF NOT EXISTS remark         VARCHAR(128);                             -- 备注（stores 原无备注列）

-- status 语义扩展（沿用原列）：1 营业 / 0 停业 / 2 闭店
COMMENT ON COLUMN stores.status     IS '1 营业 / 0 停业 / 2 闭店（闭店后节点下线、不再下发，历史数据保留）';
COMMENT ON COLUMN stores.org_type   IS 'hq 总部 / region 区域 / store 门店；单店部署可无 hq 行（此时节点即总部）';
COMMENT ON COLUMN stores.node_code  IS '同步节点唯一码，门店节点自注册时生成';
COMMENT ON COLUMN stores.franchise  IS '直营 / 加盟（加盟分账 P2+）';

CREATE UNIQUE INDEX IF NOT EXISTS uq_store_no   ON stores (store_no)  WHERE store_no  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_node ON stores (node_code) WHERE node_code IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_store_org ON stores (org_type, parent_id);

-- ─────────────────────────────────────────────────────────────
-- ② roles：作用域与数据范围（方案 §2.3）
--    兼容性：DEFAULT 'store' + DEFAULT 'self' → 现有全部角色行为 100% 不变
-- ─────────────────────────────────────────────────────────────
ALTER TABLE roles ADD COLUMN IF NOT EXISTS scope_type VARCHAR(8)  NOT NULL DEFAULT 'store';  -- hq 总部角色 / store 门店角色
ALTER TABLE roles ADD COLUMN IF NOT EXISTS data_scope VARCHAR(12) NOT NULL DEFAULT 'self';   -- all 全部门店 / region 本区域 / self 仅本店
ALTER TABLE roles ADD COLUMN IF NOT EXISTS region     VARCHAR(32);                           -- data_scope='region' 时的区域标识，对应 stores.region

COMMENT ON COLUMN roles.scope_type IS 'hq 总部角色（归属总部，作用域跨店）/ store 门店角色';
COMMENT ON COLUMN roles.data_scope IS 'all 全部门店 / region 本区域 / self 仅本店；决定读路径可见范围与写路径授权范围';
CREATE INDEX IF NOT EXISTS idx_roles_scope ON roles (scope_type, data_scope);

-- ─────────────────────────────────────────────────────────────
-- ③ employees：个例数据范围覆盖（区域经理等）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS data_scope_override VARCHAR(12);
COMMENT ON COLUMN employees.data_scope_override IS '覆盖角色数据范围（个例，如区域经理）；NULL = 按角色取值';

-- ─────────────────────────────────────────────────────────────
-- ④ system_settings：作用域 + 门店级设置覆盖表（方案 §3.7）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS scope        VARCHAR(12) NOT NULL DEFAULT 'store';  -- hq 总部级（门店只接收下发）/ store 门店级
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value_source VARCHAR(12) NOT NULL DEFAULT 'local';  -- hq 值来自总部下发 / local 本节点自管
COMMENT ON COLUMN system_settings.scope IS 'hq 总部级键（门店不可改，只接收下发）/ store 门店级键（各店可不同）；单店部署无 hq 行时作用域校验跳过';

CREATE TABLE IF NOT EXISTS store_settings (
  store_id    BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  setting_key VARCHAR(64) NOT NULL,
  value       JSONB NOT NULL,
  updated_by  BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, setting_key)
);
COMMENT ON TABLE store_settings IS '门店级设置实际值（V5.0.0）：门店级键优先读此表，未命中回落 system_settings.value';

-- 分组归类：总部级键（写入后门店不可改，只接收下发）
UPDATE system_settings SET scope='hq' WHERE setting_key IN (
  'dividend.ratio','dividend.cap_rate','dividend.cap_mode','dividend.min_single',
  'dividend.min_window','dividend.window_days','dividend.expire_days',
  'dividend.orange_alert','dividend.red_alert','dividend.consume_weighted',
  'promo.stack_rule','recon.settle_pay_flow','recon.fee_to_dividend',
  'auth.sign_threshold','ai.recog.confidence','ai.vlm_fallback','ai.suggest.auto'
);
-- 门店级键（各店可不同）
UPDATE system_settings SET scope='store' WHERE setting_key IN (
  'pos.round_rule','pos.voice_broadcast','pos.refund_limit','pos.heartbeat_timeout',
  'product.keep_days_required','stock.negative_return','stock.expiry_warn_days',
  'po.suggest_enabled','po.suggest_auto_send','po.suggest_budget',
  'promo.expiry_auto_discount','ai.kb.enabled',
  'ui.glass.enabled','scale.tx.protocol','scale.tx.port_type','scale.tx.charset'
);

-- ─────────────────────────────────────────────────────────────
-- ⑤ 权限点：连锁相关新增（方案 §2.5）
-- ─────────────────────────────────────────────────────────────
INSERT INTO permission_points (code, module, name, risk_level, remark) VALUES
-- 组织与门店
('hq.store.manage',         '总部',   '门店新建/启停/编辑',              2, '仅总部'),
('hq.store.view',           '总部',   '门店列表与状态查看',              0, '总部/区域'),
-- 商品下发
('hq.product.publish',      '总部',   '商品建档与下发',                  1, '总部商品运营'),
('hq.product.recall',       '总部',   '商品强制下架/回收',               2, '总部，优先级最高'),
('hq.price.publish.all',    '总部',   '整体调价（全门店）',              2, '总部，等价现有整体调价'),
-- 数据同步
('hq.sync.manage',          '总部',   '同步节点管理与重推',              2, '仅总部'),
('hq.sync.conflict',        '总部',   '同步冲突人工裁决',                2, '仅总部'),
-- 跨店数据
('hq.report.allstore',      '报表',   '全部门店报表查看',                1, '对应现有 report.view.all'),
('hq.member.crossview',     '会员',   '跨店会员消费查询',                1, '总部/店长'),
('hq.stock.transfer.hq',    '进销存', '总部发起配送/调拨',               2, '总部仓配'),
('hq.stock.transfer.audit', '进销存', '跨店调拨审核',                    1, '仅总部（R5：一律不授门店）'),
('hq.purchase.central',     '进销存', '总部集采与下发',                  1, '总部采购'),
-- 进价与退货（R8 / R10）
('hq.cost.manage',          '进销存', '标准进价 L1 管理与采纳审核',      2, '仅总部（不授门店）'),
('hq.purchase.return.audit','进销存', '供应商退货审核',                  2, '仅总部（R10）'),
('hq.return.crossaudit',    '收银',   '跨店退货授权',                    2, '仅总部（P1 唯一授权方，R6）'),
('hq.finance.view',         '财务',   '对账中心/门店往来/费用分摊',       1, '总部财务'),
-- 门店自建商品（原单机版无此概念，收银端需要）
('pos.product.local.create','收银',   '门店自建商品',                    1, '临时品/地方品'),
('pos.product.unlist',      '收银',   '本店上下架（沽清）',              0, '')
ON CONFLICT (code) DO NOTHING;

-- 绑定：所有名为「超级管理员」的角色获得全部新权限点
-- （超管在鉴权层靠 perms 含 '*' 豁免，此处绑定为「前端权限位展示 + 角色可复制」兜底）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
  FROM roles r
 CROSS JOIN permission_points pp
 WHERE r.name = '超级管理员'
   AND pp.code IN (
     'hq.store.manage','hq.store.view','hq.product.publish','hq.product.recall','hq.price.publish.all',
     'hq.sync.manage','hq.sync.conflict','hq.report.allstore','hq.member.crossview',
     'hq.stock.transfer.hq','hq.stock.transfer.audit','hq.purchase.central',
     'hq.cost.manage','hq.purchase.return.audit','hq.return.crossaudit','hq.finance.view',
     'pos.product.local.create','pos.product.unlist'
   )
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- ⑥ 现有「超级管理员」角色升格为总部角色（M1-4）
--    保证老板账号改造后仍全权：data_scope='all' → 不加任何门店限制
-- ─────────────────────────────────────────────────────────────
UPDATE roles SET scope_type='hq', data_scope='all', region=NULL
 WHERE name = '超级管理员' AND (scope_type <> 'hq' OR data_scope <> 'all');

-- 其余内置角色保持默认（scope_type='store', data_scope='self'）——单店下等价改造前行为
UPDATE roles SET scope_type='store', data_scope='self'
 WHERE name IN ('店长','收银员','库管','财务') AND data_scope <> 'self';

-- ⑦ 收敛：hq.* 权限点只属于总部角色（超级管理员）
--    背景：033_role_default_perms.sql 给「店长」是全量授权（pp.code NOT IN 三个），
--    本节新增的 hq.* 权限点会被它连带授给门店店长 → 违反 R5（跨店审核/进价/门店管理等不授门店）。
--    033 已加 `pp.code NOT LIKE 'hq.%'` 防新增；此处再兜底清理历史已授（幂等）。
DELETE FROM role_permissions rp
 USING roles r, permission_points pp
 WHERE rp.role_id = r.id AND rp.permission_id = pp.id
   AND r.name <> '超级管理员'
   AND pp.code LIKE 'hq.%';


-- 说明（M2-1 实现依据）：新门店创建时由服务端按内置模板 clone 角色，
--   模板定义在 src/modules/chain-roles.ts（代码内常量），不落库为「模板角色行」——
--   避免模板行污染各店角色列表（现有角色列表 SQL 为 WHERE r.store_id=$1 OR r.is_system）。
