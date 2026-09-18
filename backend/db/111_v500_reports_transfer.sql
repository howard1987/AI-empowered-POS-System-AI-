-- ═══════════════════════════════════════════════════════════════════════════
-- V5.0.0 批次6：报表门店维度 + 调拨状态机 + 采购集采（方案 §5.3 / §5.5 / §5.4）
-- 迁移 111 · 幂等（项目铁律）
-- 既有基础：105 已建调拨拆批列（qty/recv_qty/diff_qty/recv_batch_id/origin_batch_no）
--           与 hq_audit_by/hq_audited_at/biz_scope；104 已有 hq.stock.transfer.audit 权限点。
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 调拨状态机扩展（§5.5 状态表）
--    旧枚举：待确认 / 在途 / 已入库 / 已取消
--    新增：  待审核（store2store 申请等总部 R5）· 待发货（总部已批）· 驳回
--    注意：ALTER TYPE ADD VALUE 不能与「使用新值」同事务；init-db 语句级重放天然满足。
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE transfer_status_t ADD VALUE IF NOT EXISTS '待审核';
ALTER TYPE transfer_status_t ADD VALUE IF NOT EXISTS '待发货';
ALTER TYPE transfer_status_t ADD VALUE IF NOT EXISTS '驳回';

-- 调拨单状态机过程字段
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS audit_remark  VARCHAR(255);  -- 审核/驳回意见
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS shipped_at    TIMESTAMPTZ;   -- 发货时间（进入在途）
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS received_at   TIMESTAMPTZ;   -- 收货确认时间
COMMENT ON COLUMN stock_transfers.hq_audit_by IS '总部审核人（R5：唯一审核方，门店角色模板不含 hq.stock.transfer.audit）';

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 采购集采（§5.4.1 / R14 直送两步记账）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_scope        VARCHAR(8)  NOT NULL DEFAULT 'store';
--   hq = 总部集采 / store = 门店自采
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS hq_po_id        BIGINT;     -- 集采总单 id（门店/直送单引用）
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS target_store_id BIGINT;     -- 集采指定送达门店（直送时用）

ALTER TABLE inbound_orders  ADD COLUMN IF NOT EXISTS source_type     VARCHAR(12) NOT NULL DEFAULT 'self';
--   self 门店自采 / hq_po 总部集采入总部仓 / direct 供应商直送门店（两步记账）
ALTER TABLE suppliers       ADD COLUMN IF NOT EXISTS scope           VARCHAR(8)  NOT NULL DEFAULT 'all';
--   all 全连锁可见 / hq 仅总部 / store 门店自采

CREATE INDEX IF NOT EXISTS idx_po_scope      ON purchase_orders (po_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_hq         ON purchase_orders (hq_po_id) WHERE hq_po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_src   ON inbound_orders (source_type) WHERE source_type <> 'self';

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 报表性能（§5.3.4）：日期范围索引兜底（P1 直接聚合，idx_order_time 已存在）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_so_store_date ON sales_orders (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_store_date ON stock_flows   (store_id, created_at DESC);
