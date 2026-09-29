-- V5.0.4：打印机「默认用途」维度（每业务一个默认机，替代全局唯一默认）
-- 目标：小票(receipt) / 价签(pricetag) / 秤贴(scale) / 单据(a5) 各可设一台默认机，
--       打价签/打秤贴/出小票时按业务自动路由到对应默认机，无需每次手动选打印机。
ALTER TABLE printers ADD COLUMN IF NOT EXISTS default_for VARCHAR(16);

-- 历史数据兼容：原有全局默认机（is_default=true）按设备类型补 default_for
--  小票机 → receipt；标签机 → pricetag（价签/秤贴同属标签机，统一先归 pricetag，用户可在打印中心改）
UPDATE printers
   SET default_for = CASE WHEN printer_type = '标签' THEN 'pricetag' ELSE 'receipt' END
 WHERE is_default = true AND default_for IS NULL;

COMMENT ON COLUMN printers.default_for IS '默认用途：receipt小票 / pricetag价签 / scale秤贴 / a5单据；同值唯一默认';
