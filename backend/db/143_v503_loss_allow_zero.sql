-- V5.0.3 商品与报损：零库存（负库存）允许报损开关
-- 开启后：零/负库存商品可登记报损——无在库批次可归属时按「无批次」记账
--（loss_items.batch_id 允许为空，成本取商品进货价），审核跳过批次剩余校验，即时库存允许扣成负数。
ALTER TABLE loss_items ALTER COLUMN batch_id DROP NOT NULL;

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES ('商品与库存','stock.loss_allow_zero','零库存（负库存）允许报损','false','false','bool',
        '开启后：零/负库存商品可登记报损（无在库批次可归属时按无批次记账，成本取商品进货价），审核跳过批次剩余校验')
ON CONFLICT (setting_key) DO NOTHING;

UPDATE system_settings SET scope='store' WHERE setting_key='stock.loss_allow_zero';
