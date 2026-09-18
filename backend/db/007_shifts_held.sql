-- ═══════════════════════════════════════════════════════════════════════════
-- 007 交接班（班次实时汇总/现金盘点差异）+ 挂单/取单（收银流程外围补齐）
-- 规范：禁改 001 基线；本文件幂等，可重复执行
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) 挂单表（挂单不扣库存、不产生任何业务流水；结账时才走 FIFO 与支付）
--    items 为快照 JSONB：[{productId, qty, unitName, unitPrice?, lineRemark?}]
CREATE TABLE IF NOT EXISTS held_orders (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  pos_no          VARCHAR(32) NOT NULL DEFAULT 'POS-01',
  shift_id        BIGINT REFERENCES shifts(id),
  member_id       BIGINT REFERENCES members(id),
  items           JSONB NOT NULL,                       -- 购物车快照（结账时重新计价，以服务端为准）
  remark          VARCHAR(128),
  status          VARCHAR(8) NOT NULL DEFAULT '挂单中', -- 挂单中/已取单/已取消
  held_by         BIGINT REFERENCES employees(id),
  picked_order_id BIGINT,                               -- 取单结账后的销售单
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_held_store ON held_orders (store_id, created_at DESC);

-- 2) 权限点：交接班管理（开班/关班/班次报表）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('shift.manage', '收银', '交接班管理', 1)
ON CONFLICT (code) DO NOTHING;

-- 绑定超级管理员（001 的全量绑定发生在新权限点插入之前）
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points
 WHERE code='shift.manage'
ON CONFLICT DO NOTHING;
