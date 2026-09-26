-- 132 · V4.28.1 gstack 报告 P0-1/P0-2 配套设置
-- 幂等：ON CONFLICT DO NOTHING（不覆盖已调值）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
('通用设置','sales.price_floor_guard','成交价下限闸','true','true','bool',
 '开=整单优惠（促销/券/会员价/整单折扣/抹零）叠加后低于商品最低售价合计时，需店长现场授权（工号+授权码）才能收款，全额审计留痕；关=不拦截（不建议，正式开业请保持开启）'),
('支付','pay.gateway.allow_mock','允许模拟支付通道（联调）','true','true','bool',
 '开=允许 mock 假扣款（联调用，付款码尾号 0000 模拟失败）；【正式开业前必须关闭】——关闭后扫码支付只走真实通道，收银台结算弹窗不再出现模拟通道提示')
ON CONFLICT (setting_key) DO NOTHING;
