-- ==============================================================================
-- 社区超市收银系统 · 数据库建表 SQL · v1.1（PostgreSQL 15+，配套设计方案 V4.8.0）
-- v1.1：pgvector 优雅降级（扩展不可用时 ai_kb_chunks.embedding 降级 TEXT，其余功能不受影响）
-- 由 6 个分部文件合并：00 枚举 / 01 基础组织 / 02 商品库存 / 03 采购供应商 / 04 会员销售 / 05 AI / 06 种子数据
-- 执行顺序即文件顺序
-- ==============================================================================

-- ============================================================================
-- 社区超市收银系统 · 数据库建表 SQL · Part 0/6：全局约定与枚举
-- 数据库：PostgreSQL 15+   版本：V1.0（配套方案 V4.6.9）
-- 约定：
--   * 所有业务表带 store_id（当前单店默认 1，预留多店）；created_at/updated_at 默认 now()
--   * 金额 NUMERIC(12,2)；数量 NUMERIC(12,3)（支持称重 0.001kg）；单价 NUMERIC(12,4)
--   * 状态字段用 ENUM；软删除仅用于商品/会员等主数据（deleted_at）
--   * 每张表用 -- 注释说明业务含义，与《超市收银系统设计方案》章节号对应
-- ============================================================================

-- 可选扩展：pgvector 用于 9.8 店内知识库向量检索（不用知识库可去掉）

-- ----------------------------------------------------------------------------
-- 枚举类型
-- ----------------------------------------------------------------------------
CREATE TYPE employee_status_t     AS ENUM ('在职', '停用');
CREATE TYPE dividend_record_t     AS ENUM ('计提', '抵扣', '失效回冲', '调整');       -- 5.7/5.1.8.1
CREATE TYPE batch_status_t        AS ENUM ('在库', '售罄', '退货清零', '报损', '调出');
CREATE TYPE flow_direction_t      AS ENUM ('入库', '出库');
CREATE TYPE po_status_t           AS ENUM ('草稿', '待审批', '已下单', '到货中', '已完成', '已取消'); -- 5.2 采购
CREATE TYPE inbound_status_t      AS ENUM ('草稿', '未审核', '已审核', '已对账');      -- 5.6.2 审核后置
CREATE TYPE return_status_t       AS ENUM ('待预审', '已预审', '待审核', '已审核', '已取消'); -- 5.8 退货影像/预审
CREATE TYPE recon_status_t        AS ENUM ('生成', '待供应商确认', '已确认', '部分异议', '已结算'); -- 5.6.5
CREATE TYPE settlement_status_t   AS ENUM ('待审核', '已审核', '付款中', '已付款', '已关闭'); -- 5.6.5
CREATE TYPE fee_cycle_t           AS ENUM ('单次', '月', '半月', '旬', '自定义区间');   -- 5.6.3 周期费用
CREATE TYPE member_status_t       AS ENUM ('正常', '冻结', '注销');
CREATE TYPE order_channel_t       AS ENUM ('收银台', '扫码购', '小程序', 'H5', '外卖', '大客户团购'); -- 6.x
CREATE TYPE order_status_t        AS ENUM ('挂单', '待付款', '已完成', '已退款', '部分退款', '已取消');
CREATE TYPE pay_channel_t         AS ENUM ('现金', '微信', '支付宝', '余额', '分红抵扣', '积分', '赊账', '应收'); -- H5直付开通后 微信/支付宝 同名复用
CREATE TYPE count_status_t        AS ENUM ('进行中', '待差异处理', '已生成差异', '已审核');
CREATE TYPE transfer_status_t     AS ENUM ('待确认', '在途', '已入库', '已取消');       -- 调拨
CREATE TYPE coupon_type_t         AS ENUM ('满减券', '折扣券', '兑换券', '次卡');
CREATE TYPE promo_status_t        AS ENUM ('排期', '进行中', '已结束', '已停用');
CREATE TYPE promo_kind_t          AS ENUM ('满减', '折扣', '第二件半价', '特价', '临期自动', '会员日'); -- 5.9/自动营销
CREATE TYPE ai_task_t             AS ENUM ('采集', '训练', '评估');                    -- 9.4
CREATE TYPE ai_task_status_t      AS ENUM ('待执行', '进行中', '待审核', '已完成', '已取消');
CREATE TYPE suggestion_domain_t   AS ENUM ('补货', '定价', '促销', '营销推送', '防损', '其他'); -- 9.8 智能决策
CREATE TYPE suggestion_status_t   AS ENUM ('待处理', '已执行', '已否决', '已过期');     -- 建议-执行-结果三段留痕
CREATE TYPE device_kind_t         AS ENUM ('收银主机', '扫码枪', '电子秤', 'AI秤摄像头', '小票机', '副屏', '钱箱', '人脸设备');
CREATE TYPE print_template_t      AS ENUM ('小票58', '小票80', 'A5单据', 'A4单据', '标签'); -- 9.9 打印中心
CREATE TYPE biz_mode_t            AS ENUM ('购销', '联营');                            -- 5.6 购销/联营分离
-- ============================================================================
-- Part 1/6：基础与组织（门店 · 员工 · 权限点 · 电子签字 · 设备打印 · 系统设置）
-- 对应方案：十 权限与数据安全 / 5.6.8 电子签字 / 9.9 打印中心 / ⑪ 系统设置
-- ============================================================================

-- 门店（单店默认 1 行，字段预留多店）
CREATE TABLE stores (
  id            BIGSERIAL PRIMARY KEY,
  name          VARCHAR(64)  NOT NULL,                 -- 店名（小票抬头）
  address       VARCHAR(128),
  phone         VARCHAR(20),
  business_hours VARCHAR(64) DEFAULT '07:30-22:00',
  license_no    VARCHAR(64),                           -- 营业执照号（支付签约用）
  status        SMALLINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 员工（收银员/店长/库管/老板…角色见 role 绑定）
CREATE TABLE employees (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id),
  emp_no        VARCHAR(32) UNIQUE NOT NULL,            -- 工号
  name          VARCHAR(32) NOT NULL,
  phone         VARCHAR(20),
  password_hash VARCHAR(128),                           -- 后台登录（argon2/bcrypt）
  pinyin_code   VARCHAR(32),                            -- 拼音码检索
  status        employee_status_t NOT NULL DEFAULT '在职',
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 角色（管理员自定义，颗粒化权限点绑定；三权分立底线在应用层校验 5.6.7/十）
CREATE TABLE roles (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL REFERENCES stores(id),
  name        VARCHAR(32) NOT NULL,                     -- 店长/收银员/库管/财务…
  is_system   BOOLEAN NOT NULL DEFAULT false,           -- 系统内置角色不可删
  remark      VARCHAR(128),
  UNIQUE (store_id, name)                               -- 重放/重初始化幂等防线
);

-- 权限点（颗粒化：功能+数据+操作权限，如 改价/退货/折扣/审核 5.11）
CREATE TABLE permission_points (
  id          BIGSERIAL PRIMARY KEY,
  code        VARCHAR(64) UNIQUE NOT NULL,              -- 如 pos.discount.manual
  module      VARCHAR(32) NOT NULL,                     -- 收银/进销存/会员/财务/AI/系统
  name        VARCHAR(64) NOT NULL,
  risk_level  SMALLINT NOT NULL DEFAULT 0,              -- 0普通 1敏感（审计标色）2高危（二次确认）
  remark      VARCHAR(128)
);

CREATE TABLE role_permissions (
  role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permission_points(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE employee_roles (
  employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, role_id)
);

-- 全量操作审计（敏感操作标色、保留期可配 ⑪）
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT,
  employee_id BIGINT,
  module      VARCHAR(32) NOT NULL,                     -- 收银/进销存/会员/分红/设置…
  action      VARCHAR(64) NOT NULL,                     -- 如 settings.change / refund.audit
  target_type VARCHAR(32),
  target_id   BIGINT,
  detail      JSONB,                                    -- 旧值→新值等
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_module_time ON audit_logs (module, created_at DESC);
CREATE INDEX idx_audit_employee    ON audit_logs (employee_id, created_at DESC);

-- 系统设置（⑪ 九大分组：key-value + 默认值 + 管理员可改 + 全量留痕）
CREATE TABLE system_settings (
  id           BIGSERIAL PRIMARY KEY,
  group_name   VARCHAR(32) NOT NULL,                    -- 分红与会员/商品与库存/收银与小票/促销营销/采购与供应商/AI与设备/权限与安全/线上渠道/门店与运维
  setting_key  VARCHAR(64) UNIQUE NOT NULL,             -- 如 dividend.ratio
  display_name VARCHAR(64) NOT NULL,
  value        JSONB NOT NULL,
  default_value JSONB NOT NULL,
  value_type   VARCHAR(16) NOT NULL DEFAULT 'string',   -- string/number/bool/json/enum
  enum_options JSONB,
  remark       VARCHAR(256),
  updated_by   BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 设置变更留痕（谁改的/何时/旧值→新值；敏感组二次确认在应用层）
CREATE TABLE setting_change_logs (
  id           BIGSERIAL PRIMARY KEY,
  setting_key  VARCHAR(64) NOT NULL,
  old_value    JSONB,
  new_value    JSONB,
  operator_id  BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_setting_chg ON setting_change_logs (setting_key, created_at DESC);

-- 电子签字·预采集模板（5.6.8：供应商业务员到店免签，调用时选人自动带出）
CREATE TABLE signature_templates (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id),
  person_name   VARCHAR(32) NOT NULL,                   -- 签字人
  id_card_tail  VARCHAR(6),                             -- 身份证后6位（核对用，不存全号）
  role_title    VARCHAR(32),                            -- 业务员/店长/客户经办
  image_path    VARCHAR(256) NOT NULL,                  -- 预采集签字图（本地文件路径）
  valid_until   DATE,                                   -- 授权有效期
  status        SMALLINT NOT NULL DEFAULT 1,            -- 1有效 0停用
  collected_by  BIGINT,                                 -- 采集操作人
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sig_tpl_person ON signature_templates (person_name, status);

-- 电子签字·调用记录（预采签字+调用+单据哈希构成证据链 5.6.8）
CREATE TABLE signature_records (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  template_id   BIGINT NOT NULL REFERENCES signature_templates(id),
  biz_type      VARCHAR(32) NOT NULL,                   -- 对账确认/退货签收/大额签字…
  biz_id        BIGINT NOT NULL,                        -- 业务单据 id
  doc_hash      VARCHAR(64),                            -- 单据内容哈希（防篡改证据链）
  scene         VARCHAR(16) NOT NULL DEFAULT '调用',     -- 调用 / 现场补签
  sms_confirmed BOOLEAN NOT NULL DEFAULT false,          -- 大额短信确认（阈值可配 5000）
  used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_by       BIGINT
);
CREATE INDEX idx_sig_rec_biz ON signature_records (biz_type, biz_id);

-- 设备管理（Device Profile：秤/摄像头/扫码枪/副屏 在线状态 ⑪/9.1）
CREATE TABLE devices (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id),
  kind          device_kind_t NOT NULL,
  name          VARCHAR(64) NOT NULL,
  model         VARCHAR(64),
  conn_type     VARCHAR(16),                            -- USB/网口/蓝牙/串口（9.9.1）
  conn_addr     VARCHAR(64),                            -- IP:port / COM口 / MAC
  bound_pos     VARCHAR(32),                            -- 绑定收银台
  status        VARCHAR(16) NOT NULL DEFAULT '离线',     -- 在线/离线/故障
  last_heartbeat TIMESTAMPTZ,
  profile       JSONB,                                  -- 厂商参数（分辨率/DPI/精度）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 打印机（9.9.1：USB/蓝牙/网口三通道，多打印机并存，默认机指定）
CREATE TABLE printers (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id),
  name          VARCHAR(64) NOT NULL,                   -- 前台小票机/后厨单/便携应急机
  conn_type     VARCHAR(16) NOT NULL CHECK (conn_type IN ('USB','网口','蓝牙')),
  conn_addr     VARCHAR(128) NOT NULL,                  -- IP:port / 蓝牙MAC / USB路径
  width_mm      SMALLINT NOT NULL DEFAULT 80,           -- 58/80
  is_default    BOOLEAN NOT NULL DEFAULT false,
  auto_reconnect BOOLEAN NOT NULL DEFAULT true,         -- 断电重连自动恢复
  status        VARCHAR(16) NOT NULL DEFAULT '离线',
  last_test_at  TIMESTAMPTZ,                            -- 最近测试页时间
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 打印模板（9.9.2/9.9.3：小票 + A5 单据，字段显隐排序/抬头/联次均可配，实时预览）
CREATE TABLE print_templates (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id),
  name          VARCHAR(64) NOT NULL,                   -- 抬头文字可自定义：如"进货单"/"入库单"
  kind          print_template_t NOT NULL,
  biz_type      VARCHAR(32) NOT NULL,                   -- receipt/inbound/return/transfer/count/loss/recon/settlement
  content       JSONB NOT NULL,                         -- 字段显隐与列序/抬头logo/联次份数/行高字号/切刀/钱箱联动
  is_default    BOOLEAN NOT NULL DEFAULT false,
  copies        SMALLINT NOT NULL DEFAULT 1,            -- 一式多联（存根联/供应商联）
  updated_by    BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, biz_type, kind, name)
);

-- 交接班（收银员日结：现金对账/单据数/时间）
CREATE TABLE shifts (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL,
  cashier_id     BIGINT NOT NULL REFERENCES employees(id),
  pos_no         VARCHAR(32) NOT NULL DEFAULT 'POS-01',
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  opening_float  NUMERIC(12,2) NOT NULL DEFAULT 0,      -- 开班备用金
  cash_total     NUMERIC(12,2),                         -- 现金应收（结账时算）
  cash_counted   NUMERIC(12,2),                         -- 现金实盘
  diff_amount    NUMERIC(12,2),                         -- 差异
  order_count    INT,
  refund_count   INT,
  status         VARCHAR(8) NOT NULL DEFAULT '进行中'     -- 进行中/已交班
);
CREATE INDEX idx_shift ON shifts (store_id, opened_at DESC);
-- ============================================================================
-- Part 2/6：商品与库存（分类树 · 商品档案 · 多单位 · 批次FIFO · 调拨 · 盘点 · 报损）
-- 对应方案：5.1 商品 / 5.4 库存与批次 / 5.2.7 报损 / 多供应商同商品（批次=供应商×入库单×批次号）
-- ============================================================================

-- 分类（三级树，参考银豹；香烟/水果/零食等 V4.4.7）
CREATE TABLE categories (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL REFERENCES stores(id),
  parent_id   BIGINT REFERENCES categories(id),
  name        VARCHAR(32) NOT NULL,
  level       SMALLINT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  sort_no     SMALLINT NOT NULL DEFAULT 0,
  path        VARCHAR(128),                             -- 物化路径 /1/5/12/ 便于子树查询
  status      SMALLINT NOT NULL DEFAULT 1
);
CREATE INDEX idx_cat_path ON categories (path);

-- 商品档案（列表优先 V4.5.3；建档保质期必填 V4.3.6）
CREATE TABLE products (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL REFERENCES stores(id),
  category_id     BIGINT REFERENCES categories(id),
  goods_no        VARCHAR(32) UNIQUE NOT NULL,          -- 货号 SKU-xxxx
  barcode         VARCHAR(32),                          -- 主条码（预包装）；散货空
  name            VARCHAR(64) NOT NULL,
  pinyin_code     VARCHAR(48),                          -- 拼音码即输即查
  short_name      VARCHAR(32),                          -- 小票简称
  spec            VARCHAR(32),                          -- 规格 550ml
  base_unit       VARCHAR(8)  NOT NULL,                 -- 基本单位：个/kg/袋
  is_weighted     BOOLEAN NOT NULL DEFAULT false,       -- 称重商品（AI秤）
  keep_days       SMALLINT,                             -- 保质期天数（食品建档必填，应用层校验禁售 V4.4.5）
  purchase_tax    NUMERIC(5,4) DEFAULT 0,
  sell_price      NUMERIC(12,2) NOT NULL,               -- 零售价
  member_price    NUMERIC(12,2),                        -- 会员价（空=零售价）
  cost_method     VARCHAR(8)  NOT NULL DEFAULT 'FIFO',  -- FIFO 批次法
  min_stock       NUMERIC(12,3) DEFAULT 0,              -- 下限（补货提醒）
  max_stock       NUMERIC(12,3) DEFAULT 0,              -- 上限（目标库存）
  track_inventory BOOLEAN NOT NULL DEFAULT true,        -- 是否记库存（服务/费用类商品可不记）
  photo_path      VARCHAR(256),                         -- 主图（AI 训练库提取正面图 V4.4.5）
  status          SMALLINT NOT NULL DEFAULT 1,          -- 1在售 0停用 2禁售(待补保质期)
  abc_class       CHAR(1),                              -- ABC 分层（5.9，报表联动安全库存）
  supplier_default_id BIGINT,                           -- 默认供应商
  remark          VARCHAR(128),
  deleted_at      TIMESTAMPTZ,                          -- 软删除
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prod_barcode ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_prod_name    ON products (name);
CREATE INDEX idx_prod_pinyin  ON products (pinyin_code);
CREATE INDEX idx_prod_cat     ON products (category_id);

-- 多单位换算（V4.4.3：1箱=24瓶，收银可切换大小单位）
CREATE TABLE product_units (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_name   VARCHAR(8) NOT NULL,                      -- 箱/件/提
  rate        NUMERIC(12,4) NOT NULL,                   -- 相对基本单位换算率（>1）
  barcode     VARCHAR(32),                              -- 大单位条码（整箱条码）
  price       NUMERIC(12,2),                            -- 该单位售价（空=零售价×率）
  is_default_sale BOOLEAN NOT NULL DEFAULT false,       -- 收银默认销售单位
  UNIQUE (product_id, unit_name)
);

-- 商品辅助条码（同一商品多码：称重码/旧码/厂商多码）
CREATE TABLE product_barcodes (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode     VARCHAR(32) UNIQUE NOT NULL,
  source      VARCHAR(16) NOT NULL DEFAULT '手动'        -- 手动/称重前缀/AI训练学习
);

-- 商品照片（AI 训练样本库来源之一 9.4⑦ / V4.4.5）
CREATE TABLE product_photos (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_path  VARCHAR(256) NOT NULL,                    -- 本地文件路径
  angle       VARCHAR(16) NOT NULL DEFAULT '正面',       -- 正面/侧面/顶部
  is_master   BOOLEAN NOT NULL DEFAULT false,
  used_in_training BOOLEAN NOT NULL DEFAULT false,      -- 是否已入训练集
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 供应商商品进价记录（进价保护：无调价通知取历史最低价 V4.3.6）
CREATE TABLE supplier_product_prices (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  supplier_id  BIGINT NOT NULL,                          -- FK 建于 Part3
  price        NUMERIC(12,4) NOT NULL,                   -- 本次进价
  min_price    NUMERIC(12,4) NOT NULL,                   -- 历史最低价（冗余维护）
  source_doc   VARCHAR(32),                              -- 来源单据（入库单号）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_spp_lookup ON supplier_product_prices (product_id, supplier_id, created_at DESC);

-- 库存批次（FIFO 核心：批次=供应商×入库单×批次号；生产日期必填→自动到期日 V4.3.6）
CREATE TABLE batches (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL REFERENCES stores(id),
  product_id     BIGINT NOT NULL REFERENCES products(id),
  supplier_id    BIGINT NOT NULL,                       -- 多供应商同商品：批次归属供应商（账务归属非实物约束 V4.3.5）
  inbound_order_id BIGINT,                              -- 来源入库单（FK 建于 Part3）
  batch_no       VARCHAR(48) NOT NULL,                  -- 批次号：RK单号-序号
  inbound_date   DATE NOT NULL,
  production_date DATE NOT NULL,                        -- 入库必填（应用层强制）
  expiry_date    DATE NOT NULL,                         -- = 生产日期 + keep_days 自动推算
  inbound_cost   NUMERIC(12,4) NOT NULL,                -- 批次单位成本（退货按原批次原价 V4.3.4）
  inbound_qty    NUMERIC(12,3) NOT NULL,
  remain_qty     NUMERIC(12,3) NOT NULL DEFAULT 0,
  status         batch_status_t NOT NULL DEFAULT '在库',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inbound_order_id, batch_no)
);
CREATE INDEX idx_batch_fifo    ON batches (store_id, product_id, status, expiry_date, inbound_date);
CREATE INDEX idx_batch_expiry  ON batches (expiry_date) WHERE status = '在库';  -- 临期预警
CREATE INDEX idx_batch_supplier ON batches (supplier_id);

-- 库存流水（一切出入库的唯一事实：销售/退货/盘点/报损/调拨/入库统一记账）
CREATE TABLE stock_flows (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  batch_id     BIGINT REFERENCES batches(id),
  direction    flow_direction_t NOT NULL,
  qty          NUMERIC(12,3) NOT NULL,                  -- 正数；方向由 direction 表达
  unit_cost    NUMERIC(12,4),                           -- 出库时批次成本
  ref_type     VARCHAR(32) NOT NULL,                    -- inbound/sale/return_sale/return_purchase/count/loss/transfer_in/transfer_out
  ref_id       BIGINT NOT NULL,
  ref_item_id  BIGINT,
  employee_id  BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_flow_ref   ON stock_flows (ref_type, ref_id);
CREATE INDEX idx_flow_prod  ON stock_flows (product_id, created_at DESC);

-- 商品即时库存（batches remain 汇总的物化冗余，避免高频聚合；夜间或触发器维护）
CREATE TABLE inventory_current (
  store_id    BIGINT NOT NULL,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  qty_total   NUMERIC(12,3) NOT NULL DEFAULT 0,
  qty_on_order NUMERIC(12,3) NOT NULL DEFAULT 0,        -- 在途（采购在途 V4.5.2）
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

-- 调拨单（门店间/店内容器间；批次整体转移成本不变 5.4；调拨单打印 9.9.3）
CREATE TABLE stock_transfers (
  id           BIGSERIAL PRIMARY KEY,
  transfer_no  VARCHAR(32) UNIQUE NOT NULL,
  from_store_id BIGINT NOT NULL REFERENCES stores(id),
  to_store_id  BIGINT REFERENCES stores(id),            -- 空=店内库位调拨
  status       transfer_status_t NOT NULL DEFAULT '待确认',
  reason       VARCHAR(128),
  total_cost   NUMERIC(12,2),
  employee_id  BIGINT,
  audited_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_transfer_items (
  id         BIGSERIAL PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id   BIGINT NOT NULL REFERENCES batches(id),    -- 批次整体转移
  qty        NUMERIC(12,3) NOT NULL,
  unit_cost  NUMERIC(12,4) NOT NULL
);

-- 盘点单（账实分离：录入即生效、审核后置 V4.3.5）
CREATE TABLE inventory_counts (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  count_no     VARCHAR(32) UNIQUE NOT NULL,
  scope        VARCHAR(64) NOT NULL DEFAULT '全仓',      -- 全仓/按分类/按供应商
  status       count_status_t NOT NULL DEFAULT '进行中',
  employee_id  BIGINT,
  audited_by   BIGINT,
  audited_at   TIMESTAMPTZ,
  remark       VARCHAR(128),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_count_items (
  id           BIGSERIAL PRIMARY KEY,
  count_id     BIGINT NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  book_qty     NUMERIC(12,3) NOT NULL,                  -- 账面（盘点时点快照）
  actual_qty   NUMERIC(12,3) NOT NULL,                  -- 实盘
  diff_qty     NUMERIC(12,3) GENERATED ALWAYS AS (actual_qty - book_qty) STORED,
  diff_cost    NUMERIC(12,2),                           -- 差异成本（审核时按批次先进先出估）
  remark       VARCHAR(64)
);

-- 报损单（拍照报损 V4.4.0：整单拍照即可，原因留痕）
CREATE TABLE loss_records (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  loss_no      VARCHAR(32) UNIQUE NOT NULL,
  reason_type  VARCHAR(16) NOT NULL DEFAULT '损耗',      -- 损耗/过期/破损/质量问题
  total_cost   NUMERIC(12,2),
  photo_path   VARCHAR(256),                            -- 整单拍照（≥1张应用层强制）
  status       VARCHAR(8) NOT NULL DEFAULT '待审核',
  employee_id  BIGINT,
  audited_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loss_items (
  id         BIGSERIAL PRIMARY KEY,
  loss_id    BIGINT NOT NULL REFERENCES loss_records(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id   BIGINT NOT NULL REFERENCES batches(id),    -- 报损指定批次（优先临期）
  qty        NUMERIC(12,3) NOT NULL,
  unit_cost  NUMERIC(12,4) NOT NULL,
  remark     VARCHAR(64)
);
-- ============================================================================
-- Part 3/6：采购与供应商（供应商 · 周期费用 · 采购单 · 入库 · 退货 · 购销对账 · 结算 · 往来）
-- 对应方案：5.2 采购 / 5.5 供应商 / 5.6 购销对账（现场确认/结算） / 5.8 退货影像
-- ============================================================================

-- 供应商档案
CREATE TABLE suppliers (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL REFERENCES stores(id),
  name           VARCHAR(64) NOT NULL,
  pinyin_code    VARCHAR(48),
  contact_person VARCHAR(32),                           -- 常驻业务员（签字预采集对象）
  contact_phone  VARCHAR(20),
  address        VARCHAR(128),
  biz_mode       biz_mode_t NOT NULL DEFAULT '购销',     -- 购销/联营（5.6 数据模型分离）
  deduction_rate NUMERIC(5,4),                          -- 联营扣点（如 0.15）
  guarantee_min  NUMERIC(12,2),                         -- 联营保底
  settle_period  VARCHAR(16) NOT NULL DEFAULT '月结',    -- 现结/周结/月结/旬结
  settle_day     SMALLINT,                              -- 结算日
  status         SMALLINT NOT NULL DEFAULT 1,
  remark         VARCHAR(128),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_supplier_pinyin ON suppliers (pinyin_code);

-- 费用类型字典（陈列/进场/返利/促销/补差/损耗补偿…可自定义 V4.3.6；默认不计分红池）
CREATE TABLE supplier_fee_types (
  id            BIGSERIAL PRIMARY KEY,
  code          VARCHAR(32) UNIQUE NOT NULL,            -- display_fee / entry_fee / rebate / promo_fee / diff / loss_comp
  name          VARCHAR(32) NOT NULL,
  to_dividend_pool BOOLEAN NOT NULL DEFAULT false,      -- supplier_income_to_dividend_pool 关（V4.3.6 拍板）
  direction     VARCHAR(8)  NOT NULL DEFAULT '收'       -- 收（供应商给店）/ 付（补给供应商）
);

-- 周期费用协议（自动补齐漏记期次 V4.3.6；对账时自动生成费用单）
CREATE TABLE supplier_fee_agreements (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL,
  supplier_id    BIGINT NOT NULL REFERENCES suppliers(id),
  fee_type_id    BIGINT NOT NULL REFERENCES supplier_fee_types(id),
  cycle          fee_cycle_t NOT NULL DEFAULT '月',
  cycle_anchor   SMALLINT,                              -- 锚点：每月几号/旬序
  amount_mode    VARCHAR(8) NOT NULL DEFAULT '固定额',   -- 固定额/按销售额比例
  amount         NUMERIC(12,2),                         -- 固定额
  ratio          NUMERIC(5,4),                          -- 比例（联营扣点类）
  auto_generate  BOOLEAN NOT NULL DEFAULT true,         -- 对账时自动补齐漏记期次
  start_date     DATE NOT NULL,
  end_date       DATE,
  status         SMALLINT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 采购订单（含智能生成建议单 5.2.8：建议≠自动下单，逐行可改留痕）
CREATE TABLE purchase_orders (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  po_no           VARCHAR(32) UNIQUE NOT NULL,
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id),
  status          po_status_t NOT NULL DEFAULT '草稿',
  source          VARCHAR(16) NOT NULL DEFAULT '手动',   -- 手动/智能生成/补货建议/订货申请
  suggest_meta    JSONB,                                -- 智能生成因素留痕（加权日均/安全库存/在途/季节/促销系数/模型置信度）
  expect_arrival  DATE,                                 -- 到货日期（lead time 到期未到标橙催货 V4.6.1）
  total_amount    NUMERIC(12,2),
  total_qty       NUMERIC(12,3),
  budget_amount   NUMERIC(12,2),                        -- 预算控制（一键生成时）
  applicant_id    BIGINT,
  approver_id     BIGINT,                               -- 推送店长审批（每日6:00定时任务）
  approved_at     TIMESTAMPTZ,
  remark          VARCHAR(128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_supplier ON purchase_orders (supplier_id, status);

CREATE TABLE purchase_order_items (
  id           BIGSERIAL PRIMARY KEY,
  po_id        BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  order_qty    NUMERIC(12,3) NOT NULL,
  arrived_qty  NUMERIC(12,3) NOT NULL DEFAULT 0,
  price        NUMERIC(12,4),                           -- 议价（可为空，入库实价为准）
  line_remark  VARCHAR(64),
  suggest_factor JSONB                                  -- 该行智能因素气泡（V4.5.2）
);

-- 入库单（录入即生效、审核后置 V4.3.5；OCR 表单识别 9.7；审核触发批次生成与最低价保护）
CREATE TABLE inbound_orders (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  inbound_no      VARCHAR(32) UNIQUE NOT NULL,          -- RK-20260904-012
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id),
  po_id           BIGINT REFERENCES purchase_orders(id),
  status          inbound_status_t NOT NULL DEFAULT '未审核',
  total_amount    NUMERIC(12,2),
  ocr_source_path VARCHAR(256),                         -- 送货单拍照（OCR 建单）
  device_id       BIGINT,                               -- 移动收货设备（8.5）
  employee_id     BIGINT,
  audited_by      BIGINT,
  audited_at      TIMESTAMPTZ,
  recon_id        BIGINT,                               -- 被哪张对账单吸收（FK 建于下方）
  remark          VARCHAR(128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inbound_supplier ON inbound_orders (supplier_id, status);

CREATE TABLE inbound_order_items (
  id             BIGSERIAL PRIMARY KEY,
  inbound_id     BIGINT NOT NULL REFERENCES inbound_orders(id) ON DELETE CASCADE,
  product_id     BIGINT NOT NULL REFERENCES products(id),
  production_date DATE NOT NULL,                        -- 必填（V4.3.6）
  qty            NUMERIC(12,3) NOT NULL,                -- 按基本单位
  unit_cost      NUMERIC(12,4) NOT NULL,                -- 实际进价（审核时与历史最低价比对告警）
  batch_id       BIGINT REFERENCES batches(id),         -- 审核时生成的批次
  gift           BOOLEAN NOT NULL DEFAULT false,        -- 赠品入库（成本为0但入批次）
  line_remark    VARCHAR(64)
);

-- 采购退货单（批次自动归属 V4.3.4：系统自动选最早有剩余批次可拆分；整单拍照≥1张 V4.4.4）
CREATE TABLE purchase_returns (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL,
  return_no      VARCHAR(32) UNIQUE NOT NULL,           -- TH-20260904-003
  supplier_id    BIGINT NOT NULL REFERENCES suppliers(id),
  status         return_status_t NOT NULL DEFAULT '待预审',
  total_amount   NUMERIC(12,2),
  evidence_path  VARCHAR(256),                          -- 退货凭证（凭据拍照，强制上传 V4.3.6）
  sign_record_id BIGINT REFERENCES signature_records(id), -- 业务员签收（电子签字调用）
  employee_id    BIGINT,
  audited_by     BIGINT,
  audited_at     TIMESTAMPTZ,
  preaudit_at    TIMESTAMPTZ,                           -- 预审时间（可先打印退货单 V4.3.7）
  print_flag     BOOLEAN NOT NULL DEFAULT false,
  remark         VARCHAR(128),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_return_items (
  id          BIGSERIAL PRIMARY KEY,
  return_id   BIGINT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  qty         NUMERIC(12,3) NOT NULL,                   -- 只清点数量（校验=商品总库存，账实脱钩 V4.3.4）
  unit_cost   NUMERIC(12,4) NOT NULL,                   -- 归属批次原价
  line_remark VARCHAR(64)
);

-- 退货批次归属明细（自动归属结果，可人工改，改动留痕）
CREATE TABLE return_batch_allocs (
  id          BIGSERIAL PRIMARY KEY,
  return_item_id BIGINT NOT NULL REFERENCES purchase_return_items(id) ON DELETE CASCADE,
  batch_id    BIGINT NOT NULL REFERENCES batches(id),
  qty         NUMERIC(12,3) NOT NULL,
  unit_cost   NUMERIC(12,4) NOT NULL,
  alloc_rule  VARCHAR(16) NOT NULL DEFAULT '自动',       -- 自动（最早剩余批次）/人工指定
  adjusted_by BIGINT
);

-- 购销对账单（对账前置 V4.4.3：先审核单据后选单生成；现场已确认+电子签字 V4.3.7）
CREATE TABLE reconciliations (
  id               BIGSERIAL PRIMARY KEY,
  store_id         BIGINT NOT NULL,
  recon_no         VARCHAR(32) UNIQUE NOT NULL,         -- DZ-202609-015
  supplier_id      BIGINT NOT NULL REFERENCES suppliers(id),
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  status           recon_status_t NOT NULL DEFAULT '生成',
  goods_total      NUMERIC(12,2) NOT NULL DEFAULT 0,    -- 单据金额合计
  fee_income_total NUMERIC(12,2) NOT NULL DEFAULT 0,    -- 收入类费用（返利/陈列…）
  fee_pay_total    NUMERIC(12,2) NOT NULL DEFAULT 0,    -- 付出类费用（补差…）
  payable_total    NUMERIC(12,2) GENERATED ALWAYS AS (goods_total + fee_pay_total - fee_income_total) STORED,
  confirm_type     VARCHAR(16),                         -- 现场确认 / PDF打印签字 / 口头确认
  confirm_name     VARCHAR(32),                         -- 确认人（业务员）
  sign_record_id   BIGINT REFERENCES signature_records(id),
  confirm_photos   JSONB,                               -- 现场拍照留底
  confirmed_at     TIMESTAMPTZ,
  employee_id      BIGINT,
  remark           VARCHAR(128),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recon_supplier ON reconciliations (supplier_id, period_start);

-- 对账明细（吸收的原始单据：入库单/退货单/费用单，原始单号列 V4.3.7 8列精简）
CREATE TABLE reconciliation_items (
  id             BIGSERIAL PRIMARY KEY,
  recon_id       BIGINT NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  doc_type       VARCHAR(16) NOT NULL,                  -- inbound/return/fee
  doc_id         BIGINT NOT NULL,
  doc_no         VARCHAR(32) NOT NULL,                  -- 原始单号
  doc_date       DATE NOT NULL,
  amount         NUMERIC(12,2) NOT NULL,
  unpaid_amount  NUMERIC(12,2),                         -- 未付金额
  round_amount   NUMERIC(12,2) DEFAULT 0,               -- 抹零
  line_remark    VARCHAR(64),
  UNIQUE (recon_id, doc_type, doc_id)
);

-- 供应商费用单（周期协议自动生成 + 临时费用；对账时吸收）
CREATE TABLE supplier_fees (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL,
  fee_no         VARCHAR(32) UNIQUE NOT NULL,
  supplier_id    BIGINT NOT NULL REFERENCES suppliers(id),
  fee_type_id    BIGINT NOT NULL REFERENCES supplier_fee_types(id),
  agreement_id   BIGINT REFERENCES supplier_fee_agreements(id),
  period_start   DATE,
  period_end     DATE,
  amount         NUMERIC(12,2) NOT NULL,
  to_dividend_pool BOOLEAN NOT NULL DEFAULT false,      -- 冗余自类型字典（时点快照）
  status         VARCHAR(8) NOT NULL DEFAULT '待审核',
  employee_id    BIGINT,
  remark         VARCHAR(128),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 结算单（A5 打印 9.9.3；付款流程受 enable_payment_flow 开关控制 5.6.5）
CREATE TABLE settlements (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  settle_no       VARCHAR(32) UNIQUE NOT NULL,          -- JS-202609-008
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id),
  recon_id        BIGINT NOT NULL REFERENCES reconciliations(id),
  amount          NUMERIC(12,2) NOT NULL,               -- 本次结算金额
  status          settlement_status_t NOT NULL DEFAULT '待审核',
  pay_mode        VARCHAR(16),                          -- 现金/转账/微信/支付宝
  paid_at         TIMESTAMPTZ,
  pay_voucher_path VARCHAR(256),                        -- 付款凭证
  employee_id     BIGINT,
  audited_by      BIGINT,
  remark          VARCHAR(128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 供应商往来账流水（往来账簿与账龄分析 5.6.6；应付=入库-退货+付费-收费用-结算）
CREATE TABLE supplier_ledger (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  supplier_id   BIGINT NOT NULL REFERENCES suppliers(id),
  biz_type      VARCHAR(16) NOT NULL,                   -- inbound/return/fee_in/fee_out/settlement/adjust
  biz_id        BIGINT,
  biz_no        VARCHAR(32),
  debit         NUMERIC(12,2) NOT NULL DEFAULT 0,       -- 借：应付增加
  credit        NUMERIC(12,2) NOT NULL DEFAULT 0,       -- 贷：应付减少
  balance_after NUMERIC(12,2) NOT NULL,                 -- 余额（应付余额快照）
  doc_date      DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_supplier ON supplier_ledger (supplier_id, doc_date);
-- ============================================================================
-- Part 4/6：会员与销售（会员 · 分红引擎 · 储值 · 积分券 · 促销 · 销售单 · 配送码）
-- 对应方案：5.7 会员分红（合规红线）/ 5.9 促销营销 / 5.10 大客户 / 6.4 线上 / 7 收银
-- ============================================================================

-- 会员等级（权益可配 ⑪）
CREATE TABLE member_levels (
  id            BIGSERIAL PRIMARY KEY,
  name          VARCHAR(16) NOT NULL,                   -- 普通/银卡/金卡/钻石
  sort_no       SMALLINT NOT NULL DEFAULT 0,
  upgrade_score NUMERIC(12,2) DEFAULT 0,                -- 升级门槛（累计消费）
  discount      NUMERIC(5,4) DEFAULT 1,                 -- 折扣（1=无）
  point_rate    NUMERIC(5,4) NOT NULL DEFAULT 1,        -- 积分倍率
  perks         JSONB                                   -- 权益描述
);

-- 会员档案（V4.5.2 快速查询：手机/卡号/姓名/拼音码/会员码；密码登录 V4.6.6）
CREATE TABLE members (
  id               BIGSERIAL PRIMARY KEY,
  store_id         BIGINT NOT NULL REFERENCES stores(id),
  card_no          VARCHAR(32) UNIQUE NOT NULL,          -- 卡号（扫码即输即查）
  phone            VARCHAR(20) UNIQUE,                   -- 登录主键之一
  name             VARCHAR(32),
  pinyin_code      VARCHAR(48),
  password_hash    VARCHAR(128),                         -- H5/小程序密码登录（argon2 V4.6.6；后台仅解锁不代设）
  password_set_at  TIMESTAMPTZ,
  login_fail_count SMALLINT NOT NULL DEFAULT 0,          -- 连错5次锁30分
  locked_until     TIMESTAMPTZ,
  level_id         BIGINT REFERENCES member_levels(id),
  balance_alert    BOOLEAN NOT NULL DEFAULT true,
  id_card_tail     VARCHAR(6),                           -- 身份证后6位（到店找回核对 V4.5.2）
  gender           VARCHAR(4),
  birthday         DATE,
  wechat_openid    VARCHAR(64) UNIQUE,                   -- 小程序/公众号绑定
  wechat_unionid   VARCHAR(64),
  register_channel VARCHAR(16) NOT NULL DEFAULT '到店',   -- 到店/小程序/H5/收银台
  last_active_date DATE,                                 -- 有效消费判定（分红停发 5.7）
  invalid_at       DATE,                                 -- 分红失效日（30天未有效消费）
  points           INT NOT NULL DEFAULT 0,               -- 冗余积分（明细见 points_flows）
  status           member_status_t NOT NULL DEFAULT '正常',
  privacy_agreed   BOOLEAN NOT NULL DEFAULT false,       -- 个保法隐私勾选
  remark           VARCHAR(128),
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_member_phone  ON members (phone);
CREATE INDEX idx_member_pinyin ON members (pinyin_code);
CREATE INDEX idx_member_active ON members (last_active_date);

-- 会员资产账户（余额加权分红：本金消耗联动 P4 预留）
CREATE TABLE member_accounts (
  member_id        BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  balance          NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 储值余额（消费主导加权基数）
  principal_total  NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 累计充值本金（口径B连续计算）
  points           INT NOT NULL DEFAULT 0,
  dividend_balance NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 分红账户余额（仅消费抵扣）
  dividend_cumulative NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 累计已得分红（终身封顶 R 用）
  dividend_capped  BOOLEAN NOT NULL DEFAULT false,       -- 达 R=30% 封顶 → 降级仅积分（V4.3.1 拍板）
  dividend_weight  NUMERIC(12,4) NOT NULL DEFAULT 0,     -- 当前分红权重快照
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 储值流水（充值/消费扣减/退款回加/调整；充值赠送规则在 settings）
CREATE TABLE balance_flows (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  member_id    BIGINT NOT NULL REFERENCES members(id),
  direction    VARCHAR(8) NOT NULL,                     -- 入/出
  amount       NUMERIC(12,2) NOT NULL,
  principal_part NUMERIC(12,2) NOT NULL DEFAULT 0,      -- 其中本金部分（口径B）
  gift_part    NUMERIC(12,2) NOT NULL DEFAULT 0,        -- 其中赠送部分
  biz_type     VARCHAR(16) NOT NULL,                    -- 充值/消费/退款/调整/本金消耗联动
  ref_type     VARCHAR(16),
  ref_id       BIGINT,
  balance_after NUMERIC(12,2) NOT NULL,
  employee_id  BIGINT,
  remark       VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_balfow_member ON balance_flows (member_id, created_at DESC);

-- 分红计提批次（每日自动：昨日净利 × 比例；预警 25%橙/35%红 V4.3.1）
CREATE TABLE dividend_periods (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  biz_date        DATE NOT NULL UNIQUE,                 -- 分红归属日（昨日）
  net_profit      NUMERIC(12,2) NOT NULL,               -- 昨日净利
  ratio           NUMERIC(5,4) NOT NULL,                -- 时点比例快照（默认5%）
  pool_amount     NUMERIC(12,2) NOT NULL,               -- 分红池
  member_count    INT,                                  -- 参与会员数
  weight_total    NUMERIC(14,4),                        -- 权重总和
  orange_alert    BOOLEAN NOT NULL DEFAULT false,       -- 年化 25% 橙
  red_alert       BOOLEAN NOT NULL DEFAULT false,       -- 年化 35% 红（触发复核）
  pub_text        TEXT,                                 -- 公示文本（合规话术模板 5.7）
  status          VARCHAR(8) NOT NULL DEFAULT '已发放',  -- 待复核/已发放
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 分红明细（计提/抵扣/失效回冲 5.1.8.1：失效直接作废+费用回冲，不回收再分配）
CREATE TABLE dividend_records (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  member_id     BIGINT NOT NULL REFERENCES members(id),
  period_id     BIGINT REFERENCES dividend_periods(id),
  record_type   dividend_record_t NOT NULL,
  amount        NUMERIC(12,4) NOT NULL,
  weight_snapshot NUMERIC(12,4),                        -- 计提时权重快照（可追溯）
  balance_after NUMERIC(12,2),
  expire_at     DATE,                                   -- 失效日（计提时+30天窗口）
  ref_type      VARCHAR(16),                            -- 抵扣关联销售单
  ref_id        BIGINT,
  operator_id   BIGINT,
  remark        VARCHAR(128),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_div_member ON dividend_records (member_id, created_at DESC);
CREATE INDEX idx_div_expire ON dividend_records (expire_at) WHERE record_type = '计提';

-- 有效消费窗口（单笔≥5元 + 窗口累计≥50元 判定 V4.3.2；参数在 settings）
CREATE TABLE member_activity_windows (
  id            BIGSERIAL PRIMARY KEY,
  member_id     BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  window_start  DATE NOT NULL,
  window_end    DATE NOT NULL,
  valid_total   NUMERIC(12,2) NOT NULL DEFAULT 0,       -- 窗口内有效消费累计
  qualified     BOOLEAN NOT NULL DEFAULT false,         -- 是否达成 50 元
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, window_start)
);

-- 积分流水
CREATE TABLE points_flows (
  id           BIGSERIAL PRIMARY KEY,
  member_id    BIGINT NOT NULL REFERENCES members(id),
  direction    VARCHAR(4) NOT NULL,                     -- 加/减
  points       INT NOT NULL,
  biz_type     VARCHAR(16) NOT NULL,                    -- 消费/兑换/过期/分红降级补偿
  ref_type     VARCHAR(16),
  ref_id       BIGINT,
  balance_after INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 优惠券/次卡模板
CREATE TABLE coupons (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  name         VARCHAR(32) NOT NULL,
  type         coupon_type_t NOT NULL,
  threshold    NUMERIC(12,2),                           -- 满减门槛
  discount     NUMERIC(12,2),                           -- 面额/折扣
  valid_days   SMALLINT NOT NULL DEFAULT 30,            -- 领取后有效天数
  total_qty    INT,                                     -- 发放总量（空=不限）
  issued_qty   INT NOT NULL DEFAULT 0,
  per_member   SMALLINT NOT NULL DEFAULT 1,             -- 每人限领
  scope        JSONB,                                   -- 适用商品/分类范围
  status       SMALLINT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE member_coupons (
  id           BIGSERIAL PRIMARY KEY,
  coupon_id    BIGINT NOT NULL REFERENCES coupons(id),
  member_id    BIGINT NOT NULL REFERENCES members(id),
  status       VARCHAR(8) NOT NULL DEFAULT '未使用',     -- 未使用/已使用/已过期
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expire_at    DATE NOT NULL,
  used_at      TIMESTAMPTZ,
  used_order_id BIGINT
);
CREATE INDEX idx_mcoupon_member ON member_coupons (member_id, status);

-- 促销活动（进行中/排期 V4.5.2 报表联动；临期自动折扣档位 5.9）
CREATE TABLE promotions (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  name         VARCHAR(64) NOT NULL,
  kind         promo_kind_t NOT NULL,
  rules        JSONB NOT NULL,                          -- 满减档位/折扣率/特价（结构化）
  scope        JSONB,                                   -- 商品/分类范围
  auto_rule    JSONB,                                   -- 自动营销触发（临期N天/沉默会员唤醒）
  start_at     TIMESTAMPTZ NOT NULL,
  end_at       TIMESTAMPTZ NOT NULL,
  status       promo_status_t NOT NULL DEFAULT '排期',
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 大客户（团购 5.10：档案/专属价目/整单折扣/应收台账）
CREATE TABLE big_customers (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  name         VARCHAR(64) NOT NULL,                    -- 公司/单位
  contact      VARCHAR(32),
  phone        VARCHAR(20),
  credit_limit NUMERIC(12,2) DEFAULT 0,                 -- 赊账额度
  default_discount NUMERIC(5,4) DEFAULT 1,              -- 整单折扣
  price_list_id BIGINT,                                 -- 默认价目表
  status       SMALLINT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 大客户价目表（单客户×商品×生效期；成本之上零售价之下 应用层校验 V4.4.1）
CREATE TABLE big_customer_prices (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES big_customers(id) ON DELETE CASCADE,
  product_id    BIGINT NOT NULL REFERENCES products(id),
  price         NUMERIC(12,4) NOT NULL,
  valid_from    DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to      DATE,
  created_by    BIGINT,
  UNIQUE (customer_id, product_id, valid_from)
);

-- 销售单（全渠道统一：收银台/扫码购/小程序/H5/外卖/团购；应急收银单标 V4.6.2）
CREATE TABLE sales_orders (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  order_no        VARCHAR(32) UNIQUE NOT NULL,
  channel         order_channel_t NOT NULL DEFAULT '收银台',
  is_emergency    BOOLEAN NOT NULL DEFAULT false,       -- ⚡应急收银单（停电兜底 8.5.1）
  member_id       BIGINT REFERENCES members(id),
  big_customer_id BIGINT REFERENCES big_customers(id),
  cashier_id      BIGINT REFERENCES employees(id),
  shift_id        BIGINT REFERENCES shifts(id),
  status          order_status_t NOT NULL DEFAULT '已完成',
  goods_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 商品原价合计
  promo_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 促销优惠
  coupon_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 券抵扣
  member_discount NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 会员等级折扣
  round_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 抹零（规则 settings）
  payable_amount  NUMERIC(12,2) NOT NULL,               -- 应收=goods-promo-coupon-discount+round
  cost_amount     NUMERIC(12,2),                        -- 混合成本合计（FIFO）
  profit_amount   NUMERIC(12,2),                        -- 毛利
  points_earned   INT NOT NULL DEFAULT 0,
  pickup_mode     VARCHAR(8)  NOT NULL DEFAULT '自提',   -- 自提/配送
  address_id      BIGINT,                               -- 收货地址（线上）
  delivery_code   VARCHAR(16),                          -- 配送码（仅客户端展示 6.11）
  code_verified_at TIMESTAMPTZ,                         -- 配送码核销时间
  remark          VARCHAR(128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_member ON sales_orders (member_id, created_at DESC);
CREATE INDEX idx_order_time   ON sales_orders (store_id, created_at DESC);
CREATE INDEX idx_order_channel ON sales_orders (channel, created_at DESC);

-- 销售明细（多单位下单；成本按 FIFO 混合）
CREATE TABLE sale_items (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  unit_name    VARCHAR(8) NOT NULL DEFAULT '基本',       -- 销售单位（大单位自动折算基本量）
  qty          NUMERIC(12,3) NOT NULL,                   -- 基本单位数量（称重 3 位小数）
  unit_price   NUMERIC(12,4) NOT NULL,                   -- 折算单价
  origin_price NUMERIC(12,4) NOT NULL,                   -- 原价（留痕改价/促销前）
  line_amount  NUMERIC(12,2) NOT NULL,
  line_cost    NUMERIC(12,2),                            -- 该行混合成本
  line_profit  NUMERIC(12,2),
  promo_id     BIGINT REFERENCES promotions(id),         -- 命中的促销
  price_changed BOOLEAN NOT NULL DEFAULT false,          -- 手工改价标记（权限点+留痕）
  changed_by   BIGINT,
  line_remark  VARCHAR(64)
);
CREATE INDEX idx_sitem_prod ON sale_items (product_id);
CREATE INDEX idx_sitem_order ON sale_items (order_id);

-- 销售批次消耗明细（FIFO 自动混合成本：一单拆多批次可追溯；分红/毛利报表的数据源）
CREATE TABLE sale_item_batches (
  id           BIGSERIAL PRIMARY KEY,
  sale_item_id BIGINT NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  batch_id     BIGINT NOT NULL REFERENCES batches(id),
  qty          NUMERIC(12,3) NOT NULL,
  unit_cost    NUMERIC(12,4) NOT NULL
);

-- 支付流水（一单多支付方式组合；储值/分红扣减关联资产流水）
CREATE TABLE sale_payments (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  channel       pay_channel_t NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  balance_flow_id BIGINT REFERENCES balance_flows(id),  -- 余额支付对应储值流水
  dividend_flow_id BIGINT REFERENCES dividend_records(id), -- 分红抵扣对应明细
  external_no   VARCHAR(64),                            -- 微信/支付宝交易号（H5直付/线下码）
  offline_pending BOOLEAN NOT NULL DEFAULT false,        -- 应急模式离线暂缓（恢复后校验入账 8.5.1）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 销售退款单（退款权限点+限额 settings；退款回加库存/余额/冲减分红）
CREATE TABLE sale_refunds (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL,
  refund_no      VARCHAR(32) UNIQUE NOT NULL,
  order_id       BIGINT NOT NULL REFERENCES sales_orders(id),
  amount         NUMERIC(12,2) NOT NULL,
  reason         VARCHAR(128),
  restock        BOOLEAN NOT NULL DEFAULT true,         -- 是否回库存（按批次回加）
  dividend_reversed NUMERIC(12,2) NOT NULL DEFAULT 0,   -- 冲减的分红
  employee_id    BIGINT,
  audited_by     BIGINT,                                -- 退款审核（限额之上）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sale_refund_items (
  id           BIGSERIAL PRIMARY KEY,
  refund_id    BIGINT NOT NULL REFERENCES sale_refunds(id) ON DELETE CASCADE,
  sale_item_id BIGINT NOT NULL REFERENCES sale_items(id),
  qty          NUMERIC(12,3) NOT NULL,
  amount       NUMERIC(12,2) NOT NULL
);

-- 收货地址（线上订单）
CREATE TABLE member_addresses (
  id         BIGSERIAL PRIMARY KEY,
  member_id  BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  contact    VARCHAR(32) NOT NULL,
  phone      VARCHAR(20) NOT NULL,
  address    VARCHAR(128) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false
);

-- 会员消费偏好汇总（精准推送千人千券 9.8；夜间任务从 sale_items 聚合）
CREATE TABLE member_pref_stats (
  member_id     BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  category_id   BIGINT NOT NULL REFERENCES categories(id),
  buy_count     INT NOT NULL DEFAULT 0,
  buy_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_buy_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, category_id)
);
-- ============================================================================
-- Part 5/6：AI 与智能决策（识别日志 · 训练样本 · 采集任务 · 模型管理 · 智能建议 · 知识库）
-- 对应方案：9.2 AI秤 / 9.4 AI训练台 / 9.7 OCR / 9.8 越用越聪明（五步闭环）
-- ============================================================================

-- AI 识别日志（AI秤每次识别：结果/置信度/人工纠正——纠正是重要训练信号 9.2.6）
CREATE TABLE ai_recognition_logs (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT,
  device_id     BIGINT REFERENCES devices(id),
  image_path    VARCHAR(256),                           -- 俯拍帧路径（保留策略可配）
  raw_result    JSONB,                                  -- 原始输出：[{product_id?, class, count, bbox, conf}]
  used_fallback BOOLEAN NOT NULL DEFAULT false,          -- 是否走了本地大模型兜底（Qwen-VL GGUF 9.2.7）
  fallback_model VARCHAR(32),
  corrected     BOOLEAN NOT NULL DEFAULT false,         -- 收银员是否人工纠正
  corrected_json JSONB,                                 -- 纠正后结果（ negatives/positives 训练对）
  order_id      BIGINT,                                 -- 关联销售单
  latency_ms    INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recog_time ON ai_recognition_logs (store_id, created_at DESC);
CREATE INDEX idx_recog_corrected ON ai_recognition_logs (corrected) WHERE corrected = true;

-- 训练样本库（来源：商品照片/AI采集任务/退货拍照/识别纠正帧）
CREATE TABLE ai_samples (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  product_id   BIGINT REFERENCES products(id),
  image_path   VARCHAR(256) NOT NULL,
  source       VARCHAR(16) NOT NULL,                    -- 商品档案/采集任务/识别纠正/报损拍照
  annotation   JSONB,                                   -- 标注框（有则监督训练）
  sample_split VARCHAR(8) NOT NULL DEFAULT 'train',      -- train/val/test
  in_dataset   BOOLEAN NOT NULL DEFAULT false,          -- 是否已进入某次训练集
  status       VARCHAR(8) NOT NULL DEFAULT '待审核',     -- 待审核/已入库/不合格
  reviewed_by  BIGINT,                                  -- 店长审核（8.5 采集任务流程）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sample_prod ON ai_samples (product_id, status);

-- AI 采集/训练任务（店长发起/员工随手拍执行/老板看进度 8.5 作业Tab）
CREATE TABLE ai_tasks (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  task_type    ai_task_t NOT NULL,
  status       ai_task_status_t NOT NULL DEFAULT '待执行',
  scope        JSONB,                                   -- 目标商品清单/分类/识别率阈值
  assigned_to  BIGINT REFERENCES employees(id),
  progress     SMALLINT NOT NULL DEFAULT 0,             -- 0-100
  target_count INT,                                     -- 目标样本数
  done_count   INT NOT NULL DEFAULT 0,
  model_id     BIGINT,                                  -- 训练任务产出模型
  metrics      JSONB,                                   -- 训练结果（mAP/准确率/验证集损失）
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_by   BIGINT NOT NULL,
  remark       VARCHAR(128),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 模型版本管理（YOLO 检测/分类模型；灰度/回滚）
CREATE TABLE ai_models (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT,
  name         VARCHAR(64) NOT NULL,                    -- yolo-shelf-v12
  task         VARCHAR(16) NOT NULL,                    -- detect/classify/ocr/vlm
  version      SMALLINT NOT NULL DEFAULT 1,
  file_path    VARCHAR(256) NOT NULL,                   -- 本地权重路径（.onnx/.pt/.gguf）
  base_model   VARCHAR(64),                             -- 底座（如 qwen2-vl-2b-instruct-gguf）
  metrics      JSONB,                                   -- mAP / top1 / MAE 等验收指标
  is_active    BOOLEAN NOT NULL DEFAULT false,          -- 当前部署版本（单活）
  deployed_at  TIMESTAMPTZ,
  trained_task_id BIGINT REFERENCES ai_tasks(id),
  remark       VARCHAR(128),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- 智能建议（9.8 五步闭环：建议→执行/否决→效果回收→再训练；人工否决也是训练信号）
CREATE TABLE ai_suggestions (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  domain        suggestion_domain_t NOT NULL,           -- 补货/定价/促销/营销推送/防损
  model_id      BIGINT REFERENCES ai_models(id),        -- 产出模型（补货预测版等）
  biz_ref_type  VARCHAR(16),                            -- 补货→purchase_order / 营销→coupon
  biz_ref_id    BIGINT,                                 -- 执行后关联单据
  payload       JSONB NOT NULL,                         -- 建议内容（补货量/折扣档/推送人群）
  reason        JSONB,                                  -- 依据（特征重要性/历史效果/置信度）
  confidence    NUMERIC(5,4),                           -- 模型置信度（0-1）
  status        suggestion_status_t NOT NULL DEFAULT '待处理',
  decided_by    BIGINT,                                 -- 执行/否决人
  decided_at    TIMESTAMPTZ,
  reject_reason VARCHAR(128),                           -- 否决原因（训练信号）
  effect        JSONB,                                  -- 效果回收：执行后指标（报损率/毛利率/核销率）
  effect_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sugg_domain ON ai_suggestions (store_id, domain, status);

-- 知识库文档（9.8 店内知识库：经营文档/合规话术/供应商协议摘要，全部不出店）
CREATE TABLE ai_kb_documents (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  title        VARCHAR(128) NOT NULL,
  source_type  VARCHAR(16) NOT NULL DEFAULT '上传',      -- 上传/经营日报自动生成/系统摘要
  file_path    VARCHAR(256),
  content_text TEXT,
  status       VARCHAR(8) NOT NULL DEFAULT '已收录',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 知识库向量块（pgvector；本地 embedding 模型如 bge-small-zh）
-- 优雅降级：pgvector 扩展不可用时以 TEXT 存储嵌入（禁用向量检索），系统其余功能不受影响
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE ai_kb_chunks (
      id          BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES ai_kb_documents(id) ON DELETE CASCADE,
      chunk_no    INT NOT NULL,
      content     TEXT NOT NULL,
      embedding   vector(512),                            -- 维度按所用本地 embedding 模型调整
      metadata    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (document_id, chunk_no)
    );
  ELSE
    CREATE TABLE ai_kb_chunks (
      id          BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES ai_kb_documents(id) ON DELETE CASCADE,
      chunk_no    INT NOT NULL,
      content     TEXT NOT NULL,
      embedding   TEXT,                                   -- 降级占位：部署机启用 pgvector 后迁移
      metadata    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (document_id, chunk_no)
    );
    RAISE NOTICE 'pgvector 不可用：ai_kb_chunks.embedding 已降级为 TEXT（向量检索待部署环境启用）';
  END IF;
END $$;

-- 预测快照（补货预测版 5.2.8：每日 03:00 再训练后的预测值与置信度，供效果回收比对）
CREATE TABLE forecast_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  horizon_date DATE NOT NULL,                           -- 预测哪一天
  model_id     BIGINT REFERENCES ai_models(id),
  predict_qty  NUMERIC(12,3) NOT NULL,                  -- 预测销量
  confidence   NUMERIC(5,4),
  factors      JSONB,                                   -- 季节/节假日/促销/趋势特征值
  actual_qty   NUMERIC(12,3),                           -- 实际销量（事后回填，算 MAE）
  mae_after    NUMERIC(8,4),                            -- 回填后单点绝对误差
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, horizon_date)
);
-- ============================================================================
-- Part 6/6：种子数据（默认门店 · 系统角色 · 权限点 · 系统设置默认值）
-- 原则：大多数待确认项做成系统设置项（默认值+管理员可改，十三·处理原则）
-- ============================================================================

-- 默认门店
INSERT INTO stores (id, name, address, phone) VALUES (1, '绿源社区超市', '示例地址', '00000000000')
ON CONFLICT (id) DO NOTHING;

-- 系统内置角色（三权分立底线不可绕过 5.6.7）
-- 幂等不依赖唯一约束（存量库 060 才补约束）：NOT EXISTS 防重放插重
INSERT INTO roles (store_id, name, is_system, remark)
SELECT v.store_id, v.name, v.is_system, v.remark FROM (VALUES
 (1, '超级管理员', true, '老板/系统管理员，全部权限'),
 (1, '店长',       true, '审批/退货审核/对账确认/应急收银开关'),
 (1, '收银员',     true, '收银/挂单/会员查询，改价退货受限'),
 (1, '库管',       true, '入库/盘点/报损/调拨'),
 (1, '财务',       true, '购销对账/结算/往来账簿')
) AS v(store_id, name, is_system, remark)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.store_id = v.store_id AND r.name = v.name
);

-- 权限点（颗粒化示例集：高频敏感操作；后续按需扩展）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('pos.sell',            '收银', '收银结账',        0),
 ('pos.price.manual',    '收银', '手工改价',        2),
 ('pos.hang',            '收银', '挂单/取单',       0),
 ('pos.refund.apply',    '收银', '发起退款',        1),
 ('pos.refund.audit',    '收银', '退款审核',        2),
 ('pos.emergency',       '收银', '应急收银（停电模式）', 2),   -- 8.5.1
 ('stock.inbound.audit', '进销存', '入库审核',      1),
 ('stock.return.audit',  '进销存', '采购退货审核',  2),
 ('stock.count.audit',   '进销存', '盘点差异审核',  1),
 ('stock.loss.create',   '进销存', '拍照报损',      1),
 ('stock.transfer',      '进销存', '调拨',          1),
 ('purchase.po.approve', '进销存', '采购单审批',    1),
 ('recon.confirm',       '财务', '对账现场确认',    1),       -- 5.6.5
 ('recon.settle.audit',  '财务', '结算审核',        2),
 ('settle.pay.close',    '财务', '关闭付款流程',    2),       -- enable_payment_flow
 ('member.register',     '会员', '会员注册',        0),
 ('member.balance.recharge', '会员', '储值收款',    1),
 ('member.balance.adjust',   '会员', '储值人工调整',2),
 ('member.dividend.adjust',  '会员', '分红人工调整',2),     -- 5.7
 ('member.info.view',    '会员', '会员信息查看',    0),
 ('member.export',       '会员', '会员数据导出',    2),
 ('promo.manage',        '营销', '促销活动管理',    1),
 ('report.view.all',     '报表', '全店报表查看',    0),
 ('ai.train.launch',     'AI',   '发起AI训练',      1),       -- 9.4
 ('ai.suggestion.decide','AI',   '智能建议执行/否决',1),      -- 9.8
 ('sys.settings',        '系统', '系统设置修改',    2),       -- 敏感组二次确认
 ('sys.user.manage',     '系统', '员工与角色管理',  2),
 ('sys.data.backup',     '系统', '备份恢复操作',    2);

-- 绑定：超级管理员 = 全部权限点
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员' AND store_id=1), id FROM permission_points
ON CONFLICT DO NOTHING;

-- 系统设置默认值（九大分组精选；全部管理员可改，改动全量留痕 setting_change_logs）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
-- 💰 分红与会员（5.7 已锁定参数 V4.3.1-V4.3.2）
('分红与会员','dividend.ratio','分红比例','5','5','number','净利×比例，后台可调'),
('分红与会员','dividend.cap_rate','终身封顶率R','30','30','number','累计分红≤净充值×R，达顶降级仅积分'),
('分红与会员','dividend.cap_mode','上限口径','"B"','"B"','enum','B连续/A离散'),
('分红与会员','dividend.min_single','有效消费单笔门槛','5','5','number','元，防微额刷单'),
('分红与会员','dividend.min_window','有效消费窗口累计','50','50','number','元/窗口期'),
('分红与会员','dividend.window_days','有效消费窗口天数','30','30','number','天'),
('分红与会员','dividend.expire_days','分红有效期','30','30','number','天，失效作废+费用回冲5.1.8.1'),
('分红与会员','dividend.orange_alert','年化橙色预警','25','25','number','%'),
('分红与会员','dividend.red_alert','年化红色预警','35','35','number','%'),
('分红与会员','dividend.consume_weighted','消费主导加权','true','true','bool','余额加权+预留消费主导开关'),
-- 🛒 商品与库存
('商品与库存','product.keep_days_required','未填保质期禁售','true','true','bool','V4.4.5 拍板'),
('商品与库存','stock.negative_return','负库存退货','false','false','bool','V4.3.6 默认关'),
('商品与库存','stock.expiry_warn_days','临期预警天数','[7,3]','[7,3]','json','7天黄/3天橙，档位可调'),
('商品与库存','po.suggest_enabled','智能补货建议单','true','true','bool','5.2.8 每日6:00生成'),
('商品与库存','po.suggest_auto_send','建议单自动推送审批','true','true','bool','推送店长，建议≠自动下单'),
-- 🧾 收银与小票
('收银与小票','pos.round_rule','抹零规则','"分"','"分"','enum','分/角/5角/元，去零就近'),
('收银与小票','pos.voice_broadcast','语音播报','true','true','bool','收银语音（P0 一期）'),
('收银与小票','pos.refund_limit','免审退款限额','100','100','number','元以上需审核'),
('收银与小票','pos.heartbeat_timeout','收银端心跳超时','10','10','number','秒，超时弹窗引导应急收银'),
-- 📣 促销营销
('促销营销','promo.stack_rule','优惠叠加取优','"取优"','"取优"','enum','取优/叠加'),
('促销营销','promo.expiry_auto_discount','临期自动折扣档位','[{"days":3,"pct":80},{"days":1,"pct":70}]','[{"days":3,"pct":80},{"days":1,"pct":70}]','json','临期N天自动折扣'),
-- 📦 采购与供应商
('采购与供应商','recon.settle_pay_flow','结算付款流程','true','true','bool','enable_payment_flow 关=审核即终结'),
('采购与供应商','recon.fee_to_dividend','供应商费用计入分红池','false','false','bool','V4.3.6 默认关'),
('采购与供应商','po.suggest_budget','建议单预算控制','false','false','bool','一键生成时启用'),
-- 🤖 AI 与设备
('AI与设备','ai.recog.confidence','识别置信度阈值','0.75','0.75','number','低于阈值转大模型兜底'),
('AI与设备','ai.vlm_fallback','本地大模型兜底','true','true','bool','Qwen-VL GGUF 9.2.7'),
('AI与设备','ai.suggest.auto','智能建议自动生成','true','true','bool','9.8 每日循环'),
('AI与设备','ai.kb.enabled','店内知识库','true','true','bool','需 pgvector'),
-- 🔐 权限与安全
('权限与安全','auth.sign_threshold','大额签字阈值','5000','5000','number','元，短信确认或现场补签'),
('权限与安全','auth.password_policy','密码强度策略','"8位字母数字"','"8位字母数字"','string','会员/员工通用'),
('权限与安全','auth.audit_retention','审计日志保留期','365','365','number','天'),
-- 🌐 线上渠道
('线上渠道','h5.enabled','H5移动端开关','true','true','bool','8.4/6.4.1'),
('线上渠道','h5.direct_pay','H5微信支付宝直付','false','false','bool','V4.6.5 默认关，需备案域名+商户号'),
('线上渠道','h5.scan_go_limit','扫码购单笔限额','500','500','number','元'),
('线上渠道','h5.in_store_direct','H5店内直连模式','true','true','bool','V4.6.6 到店WiFi直连本地服务器'),
('线上渠道','member.login.password_h5','会员H5密码登录','true','true','bool','V4.6.6 默认开'),
('线上渠道','member.login.password_mini','会员小程序密码登录','false','false','bool','V4.6.6 默认关'),
-- 🏪 门店与运维
('门店与运维','ops.backup_hour','每日备份时间','"02:30"','"02:30"','string','全量+双硬盘轮换'),
('门店与运维','ops.emergency_pay','应急收银角色开关','["店长","收银员"]','["店长","收银员"]','json','8.5.1'),
('门店与运维','ops.emergency_amount_cap','应急收银单笔上限','500','500','number','元，日累计另配'),
('门店与运维','ops.printer_reconnect','打印机断线自动重连','true','true','bool','9.9.1');
