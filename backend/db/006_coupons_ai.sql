-- ═══ 006: 优惠券模块（5.9 券管理）+ AI 服务设置（9 章 T15） ═══
-- 执行方式：init-db.ts 顺序执行 db/0*.sql；幂等

-- 1) sales_orders 挂核销券（member_coupons.used_order_id 反向留痕，此列便于订单侧直查）
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS coupon_id BIGINT REFERENCES member_coupons(id);

-- 2) 权限点：券管理
INSERT INTO permission_points (code, module, name, risk_level) VALUES
 ('coupon.manage', '营销', '优惠券管理', 1)
ON CONFLICT (code) DO NOTHING;

-- 绑定超级管理员（001 的全量绑定发生在新权限点插入之前）
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points
 WHERE code='coupon.manage'
ON CONFLICT DO NOTHING;

-- 3) 设置项（管理员可改，全量留痕）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
 ('营销', 'coupon.stack_with_promo', '券与促销叠加', '1', '1', 'bool', '开启=券与促销活动可同单叠加（5.9）；关闭=同单已有促销时用券报 50046'),
 ('AI',   'ai.engine',               '识别引擎',       '"mock"', '"mock"', 'enum', 'mock=本地模拟（联调）/yolo=本地 YOLO 检测模型（真机部署后切换）；JSONB 列，字符串须带引号'),
 ('AI',   'ai.fallback_conf',        '兜底置信阈值',    '0.60', '0.60', 'num', '主模型置信度低于该值 → 启用本地多模态大模型兜底（Qwen-VL GGUF 9.2.7）')
ON CONFLICT (setting_key) DO NOTHING;
