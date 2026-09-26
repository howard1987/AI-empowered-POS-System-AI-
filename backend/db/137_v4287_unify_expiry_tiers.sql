-- 137 · V4.28.7 临期折扣档位统一：以「临期自动折扣档位」(promo.expiry_auto_discount) 为唯一数据源
-- ① 删除重复键 ai.pricing.expiry_tiers（V4.28.6 引入，与临期自动折扣档位功能重复，AI 调价建议改读后者）
DELETE FROM system_settings WHERE setting_key = 'ai.pricing.expiry_tiers';

-- ② 收银端「临期自动折扣」开关（档位真正落地为结算自动促销层；默认关，开启后临期商品收银时自动按档位折价）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
('营销与线上','promo.expiry_auto.enabled','临期自动折扣（收银）','false','false','bool',
 '开=收银结算时，购物车中有在库临期批次的商品自动按「临期自动折扣档位」折价（剩余天数≤days 取最深档）；与门店促销互斥（促销优先、临期兜底，防双重折扣）；低于进价由「临期商品豁免成交价下限闸」协同放行。默认关——开启前请先确认档位配置符合预期')
ON CONFLICT (setting_key) DO NOTHING;

-- ③ 档位键备注校准：说明它现在是收银自动折扣 + AI 调价建议的共同数据源
UPDATE system_settings SET remark='临期N天自动按档位折价：[{"days":剩余天数上限,"pct":售价百分数}]（pct 80=8折），天数从小到大匹配、取最深档。收银自动折扣（promo.expiry_auto.enabled 开启时）与 AI 临期调价建议共用此档位' WHERE setting_key='promo.expiry_auto_discount';
