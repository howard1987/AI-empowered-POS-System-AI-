-- ═══ 056: V4.13.9 批量整改 ═══
-- A3 负库存销售开关 / A4 系统初始化设置组 / B1 移动端左右手习惯
-- B8 员工密保问题字段 / D1 费用单·费用协议行级方向（供应商应付- / 供应商应收+）
-- 执行方式：init-db.ts 顺序重放；幂等

-- ── A3：零库存（负库存）是否允许销售（默认关 = 现行为：库存不足拦截 50001）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '商品管理', 'stock.negative_sales', '零库存（负库存）允许销售', 'false'::jsonb, 'false'::jsonb, 'bool',
       '开=库存不足也允许销售（FIFO 差额挂末位批次记负数，先卖后补）；关=库存不足直接拦截收银（默认）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='stock.negative_sales');

-- ── A4：系统初始化设置组（开业时的初始设置）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT v.group_name, v.setting_key, v.display_name, to_jsonb(v.value), to_jsonb(v.value), v.value_type,
       v.remark
FROM (VALUES
  ('系统初始化', 'init.opening_date', '开业日期', '', 'string',
   '门店开业日期（YYYY-MM-DD），作为经营报表起算日与会员分红资格窗口的基准'),
  ('系统初始化', 'init.opening_stock_mode', '开业库存基准', '开业大盘点导入', 'enum',
   '开业时商品初始库存的录入方式：开业大盘点导入 / 首张入库单 / 手工建档录入'),
  ('系统初始化', 'init.opening_note', '开业初始说明', '', 'string',
   '开业时的一次性说明（展示给员工）；数据级初始化（清空演示数据/重置系统）请用「系统工具 → 系统初始化」页')
) AS v(group_name, setting_key, display_name, value, value_type, remark)
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = v.setting_key);

UPDATE system_settings SET enum_options = '[{"v":"开业大盘点导入","label":"开业大盘点导入"},{"v":"首张入库单","label":"首张入库单"},{"v":"手工建档录入","label":"手工建档录入"}]'::jsonb
 WHERE setting_key='init.opening_stock_mode' AND enum_options IS NULL;

-- ── B1：移动端左右手习惯（右手 = 常用按钮靠右侧；左手 = 镜像到左侧）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '通用设置', 'mobile.hand', '移动端左右手习惯', '"right"'::jsonb, '"right"'::jsonb, 'enum',
       '右手习惯=常用按钮（AI拍多件/数量步进）靠屏幕右侧；左手习惯=镜像到左侧。移动收银等模块自动按此切换'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='mobile.hand');

UPDATE system_settings SET enum_options = '[{"v":"right","label":"右手习惯"},{"v":"left","label":"左手习惯"}]'::jsonb
 WHERE setting_key='mobile.hand' AND enum_options IS NULL;

-- ── B8：员工密保问题（3 问 3 答，答案 bcrypt 哈希；登录页忘记密码自助找回）──
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sec_question1   VARCHAR(80);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sec_answer1_hash VARCHAR(128);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sec_question2   VARCHAR(80);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sec_answer2_hash VARCHAR(128);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sec_question3   VARCHAR(80);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sec_answer3_hash VARCHAR(128);

-- ── D1：费用行级方向（NULL=沿用类型字典）；「供应商应付」=收（对账扣减-）、「供应商应收」=付（对账增加+）──
ALTER TABLE supplier_fees        ADD COLUMN IF NOT EXISTS direction VARCHAR(8);
ALTER TABLE supplier_fee_agreements ADD COLUMN IF NOT EXISTS direction VARCHAR(8);
