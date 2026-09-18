-- ═══ 011: 供应商费用类型字典种子（T8 对账费用自动补齐的字典基础，5.6） ═══
-- 执行方式：init-db.ts 顺序执行 db/0*.sql；幂等
-- 此前字典仅在 e2e 中临时 INSERT，生产初始化缺省——对账屏无法配置费用协议

INSERT INTO supplier_fee_types (code, name, direction) VALUES
 ('display_fee', '陈列费',   '收'),
 ('entry_fee',   '进场费',   '收'),
 ('rebate',      '销售返利', '收'),
 ('promo_fee',   '促销费',   '收'),
 ('diff',        '价补差',   '付'),
 ('loss_comp',   '损耗补偿', '付')
ON CONFLICT (code) DO NOTHING;
