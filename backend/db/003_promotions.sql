-- ═══════════════════════════════════════════════════════════════════════════
-- 003 促销引擎（T12，方案 5.4）：满减/满折/特价(时段价)/第二件半价/会员价
-- 规范：禁改 001 基线；本文件幂等，可重复执行
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) 整单级促销挂单列（行级促销已由 sale_items.promo_id 承载；满减/满折按行小比分摊）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS promo_id BIGINT REFERENCES promotions(id);

-- 2) 新增设置项（与既有种子同结构，管理员可改、改动留痕）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('促销营销','promo.take_best','促销冲突取优','1','1','number','1=同层多个促销取对顾客更优（5.4 默认）；0=按创建顺序取第一个'),
('促销营销','promo.stack_layers','跨层叠加开关','1','1','number','1=行级(特价/半价)与整单级(满减/满折)叠加；0=只生效一层（行级优先）')
ON CONFLICT (setting_key) DO NOTHING;
