-- ═══════════════════════════════════════════════════════════════
-- 030_stocktake_tasks.sql（V4.8.25）：盘点任务化改造
--   盘点 = 后台「创建盘点任务」（按品类/按供应商/全仓）→ 指派店员
--         → 店员手机端（员工 PWA）收到任务，按分类逐项实盘、提交
--         → 后台审核：生成盘点单 inventory_counts 并按 FIFO 生效差异
--   stocktake_tasks  : 任务头（范围/指派/状态/关联盘点单/签字）
--   stocktake_task_items : 任务明细快照（建任务时的账面数量 + 实盘数量）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stocktake_tasks (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL REFERENCES stores(id),
  task_no        VARCHAR(32) UNIQUE NOT NULL,
  name           VARCHAR(64)  NOT NULL,
  scope_type     VARCHAR(16)  NOT NULL DEFAULT '按分类',   -- 全仓 / 按分类 / 按供应商
  category_ids   JSONB        NOT NULL DEFAULT '[]',       -- 按分类盘点的品类 ID 数组
  category_names VARCHAR(256),                             -- 冗余展示，如「香烟/水饮」
  supplier_id    BIGINT       REFERENCES suppliers(id),
  status         VARCHAR(16)  NOT NULL DEFAULT '待执行',   -- 待执行/执行中/待审核/已完成/已取消
  assignee_id    BIGINT       REFERENCES employees(id),    -- 执行店员
  assignee_name  VARCHAR(32),
  due_date       DATE,
  remark         VARCHAR(256),
  total_sku      INT          NOT NULL DEFAULT 0,
  counted_sku    INT          NOT NULL DEFAULT 0,
  count_id       BIGINT       REFERENCES inventory_counts(id),  -- 审核后生成的盘点单
  sign_record_id BIGINT,
  created_by     BIGINT       REFERENCES employees(id),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stt_status ON stocktake_tasks (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_stt_assignee ON stocktake_tasks (assignee_id, status);

CREATE TABLE IF NOT EXISTS stocktake_task_items (
  id          BIGSERIAL PRIMARY KEY,
  task_id     BIGINT NOT NULL REFERENCES stocktake_tasks(id) ON DELETE CASCADE,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  category_id BIGINT,
  book_qty    NUMERIC(12,3) NOT NULL DEFAULT 0,   -- 建任务时快照的账面库存
  actual_qty  NUMERIC(12,3),                      -- 店员实盘录入
  diff_qty    NUMERIC(12,3),                      -- 实盘 - 账面（提交/审核时计算）
  counted_at  TIMESTAMPTZ,
  counted_by  BIGINT REFERENCES employees(id),
  remark      VARCHAR(128),
  UNIQUE (task_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_stti_task ON stocktake_task_items (task_id);

INSERT INTO permission_points (code, module, name, risk_level) VALUES
  ('stock.count.task', '进销存', '盘点任务创建与审核', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points WHERE code='stock.count.task'
ON CONFLICT DO NOTHING;
