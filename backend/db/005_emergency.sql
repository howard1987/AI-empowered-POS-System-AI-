-- ═══════════════════════════════════════════════════════════════════════════
-- 005 移动收银应急包（T14，方案 8.5.1 / V4.6.3）：价目表快照 + 新鲜度硬闸 + 应急手输权限
-- 规范：禁改 001 基线；本文件幂等，可重复执行
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) 价目表下发快照（版本哈希留痕：新鲜度硬闸与版本比对的数据源）
CREATE TABLE IF NOT EXISTS pricebook_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL,
  version       VARCHAR(40) NOT NULL,                 -- 全量内容 MD5（含价/会员价/多单位/启停）
  item_count    INT NOT NULL,
  generated_by  BIGINT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta          JSONB
);
CREATE INDEX IF NOT EXISTS idx_pbook_store_time ON pricebook_snapshots (store_id, generated_at DESC);

-- 2) 应急手输权限（价目表未命中商品仅店长授权可手输，V4.6.3）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
('pos.emergency.manual', '收银', '应急手输商品（价目表未命中）', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points
 WHERE code='pos.emergency.manual'
ON CONFLICT DO NOTHING;

-- 3) 新鲜度上限设置项（默认 72 小时，管理员可改）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('收银与小票','pos.pricebook_fresh_hours','应急价目表新鲜度上限（小时）','72','72','number','超上限禁止进入应急收银模式（V4.6.3 硬闸）；未命中商品仅店长授权手输')
ON CONFLICT (setting_key) DO NOTHING;
