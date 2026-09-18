-- ═══ V4.18.3 P15 批2：积分抵现/会员挂账销账/整单折扣（084）═══
--  ① sales_orders.order_discount：整单折扣金额（促销/券之后、抹零之前冲减应收）
--  ② pos.discount.presets：后台预定义整单折扣规则（套用免权限；自定义折扣率需 pos.discount.custom + 留痕）
--  ③ 权限点：整单自定义折扣 / 挂账超限放行 / 挂账关闭核销（模块沿用 pos.sell 同组）
-- 幂等防线：IF NOT EXISTS / NOT EXISTS

-- ── ① 整单折扣列 ──
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS order_discount NUMERIC(10,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN sales_orders.order_discount IS '整单折扣金额（V4.18.3 P15 批2）：预设规则套用免权限，自定义折扣率需 pos.discount.custom 权限并留痕（§13.1）';

-- ── ② 整单折扣预设规则 ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '收银台', 'pos.discount.presets', '整单折扣预设规则',
       '[{"name":"员工折扣","rate":95},{"name":"会员日","rate":90}]'::jsonb,
       '[{"name":"员工折扣","rate":95},{"name":"会员日","rate":90}]'::jsonb, 'json',
       '收银台结算页可直接套用的命名折扣规则（rate=折数，如 95=95折）；自定义折扣率需 pos.discount.custom 权限'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.discount.presets');

-- ── ③ 权限点（module 沿用 pos.sell 所在模块） ──
INSERT INTO permission_points (code, module, name, risk_level, remark)
SELECT 'pos.discount.custom',
       (SELECT module FROM permission_points WHERE code='pos.sell'),
       '整单自定义折扣', 2, '套用后台预设规则免此权限；手输任意折扣率需此权限并留痕（P15 批2）'
WHERE NOT EXISTS (SELECT 1 FROM permission_points WHERE code='pos.discount.custom');
INSERT INTO permission_points (code, module, name, risk_level, remark)
SELECT 'pos.credit.over',
       (SELECT module FROM permission_points WHERE code='pos.sell'),
       '挂账超限放行', 2, '单笔挂账超过 pos.credit.limit 时需此权限放行（§13.2 B2）'
WHERE NOT EXISTS (SELECT 1 FROM permission_points WHERE code='pos.credit.over');
INSERT INTO permission_points (code, module, name, risk_level, remark)
SELECT 'pos.credit.close',
       (SELECT module FROM permission_points WHERE code='pos.sell'),
       '挂账关闭/核销', 2, '关闭或核销未结挂账限店长权限并留痕（§13.2 B3）'
WHERE NOT EXISTS (SELECT 1 FROM permission_points WHERE code='pos.credit.close');
