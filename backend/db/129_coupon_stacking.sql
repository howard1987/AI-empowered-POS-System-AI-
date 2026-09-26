-- 129 优惠券叠加规则（5.9 券管理延伸）
--   ① 每券「可叠加使用」开关：stackable=false 表示互斥券，不能与任何其他券同单使用
--   ② 多券使用模式 coupon.mode（营销 ▸ 促销与优惠叠加，自动渲染为下拉）：
--        manual = 收银员手动多选（受每券 stackable 约束）
--        single = 一单仅用一张，系统自动取抵扣最大者
--        auto   = 系统自动挑选可叠加组合，求总抵扣最大
-- 幂等：全部语句可重放

-- ① 券模板增加「可叠加使用」开关（默认 true = 可叠加）
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS stackable BOOLEAN NOT NULL DEFAULT true;

-- ② 多券使用模式设置项（enum 下拉）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark)
VALUES ('营销', 'coupon.mode', '多券使用模式', '"manual"', '"manual"', 'enum',
        '[{"v":"manual","label":"手动多选（收银员勾选，受叠加规则约束）"},{"v":"single","label":"单张最大优惠（系统取抵扣最大的一张）"},{"v":"auto","label":"自动组合最优（系统自动选可叠加组合求最大抵扣）"}]'::jsonb,
        '多券使用规则：manual=收银员手动多选（受每券「可叠加使用」开关约束）；single=一单仅用一张、系统自动取最优惠；auto=系统自动挑选可叠加组合求总抵扣最大')
ON CONFLICT (setting_key) DO NOTHING;
