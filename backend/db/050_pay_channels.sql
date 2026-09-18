-- V4.13.3 支付设置：微信/支付宝通道配置项（密钥类 value_type='secret' 加密落库、界面脱敏）
-- 配套真适配器（微信 V3 付款码支付 / 支付宝当面付）：填齐 API 配置 + pay.gateway.mode='real' 即正式启用

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark)
SELECT v.group_name, v.setting_key, v.display_name, v.value, v.default_value, v.value_type, NULLIF(v.enum_options,'')::jsonb, v.remark
FROM (VALUES
  -- 通道模式：off=记账式（回退二次确认）/ mock=模拟通道 / real=真实通道（按渠道走下方配置）
  ('支付', 'pay.gateway.mode', '支付通道模式', '"mock"'::jsonb, '"mock"'::jsonb, 'enum', NULL,
   'off=记账式收款（手记流水+二次确认）/ mock=模拟通道（联调）/ real=真实通道（需下方配置填齐并启用渠道）'),

  ('支付', 'pay.wechat.enabled', '微信真通道启用', 'false'::jsonb, 'false'::jsonb, 'bool', NULL,
   'real 模式下微信付款码走微信支付 V3 codepay；需填齐商户号/APPID/APIv3密钥/证书序列号/商户私钥'),
  ('支付', 'pay.wechat.mchid', '微信商户号', '""'::jsonb, '""'::jsonb, 'string', NULL, '微信支付商户平台 mchid，如 1900000109'),
  ('支付', 'pay.wechat.appid', '微信 APPID', '""'::jsonb, '""'::jsonb, 'string', NULL, '绑定的公众号/小程序/APP appid'),
  ('支付', 'pay.wechat.cert_serial', '商户证书序列号', '""'::jsonb, '""'::jsonb, 'string', NULL, '商户API证书序列号（商户平台 API 安全页）'),
  ('支付', 'pay.wechat.apiv3_key', 'APIv3 密钥', '""'::jsonb, '""'::jsonb, 'secret', NULL, '32 位 APIv3 密钥——加密落库，界面只显尾号；留空保存=不修改'),
  ('支付', 'pay.wechat.private_key', '商户 API 私钥', '""'::jsonb, '""'::jsonb, 'secret', NULL, 'apiclient_key.pem 全文（BEGIN PRIVATE KEY）——加密落库，界面只显尾号'),
  ('支付', 'pay.wechat.gateway', '微信网关地址', '"https://api.mch.weixin.qq.com"'::jsonb, '"https://api.mch.weixin.qq.com"'::jsonb, 'string', NULL, '正式网关；仿真/联调可改（如微信支付仿真系统）'),

  ('支付', 'pay.alipay.enabled', '支付宝真通道启用', 'false'::jsonb, 'false'::jsonb, 'bool', NULL,
   'real 模式下支付宝付款码走当面付 alipay.trade.pay；需填齐 APPID/应用私钥/支付宝公钥'),
  ('支付', 'pay.alipay.app_id', '支付宝 APPID', '""'::jsonb, '""'::jsonb, 'string', NULL, '开放平台应用 APPID，需签约「当面付」'),
  ('支付', 'pay.alipay.private_key', '支付宝应用私钥', '""'::jsonb, '""'::jsonb, 'secret', NULL, '应用私钥（PKCS8）全文——加密落库，界面只显尾号；留空保存=不修改'),
  ('支付', 'pay.alipay.public_key', '支付宝公钥', '""'::jsonb, '""'::jsonb, 'secret', NULL, '支付宝公钥全文——加密落库，用于应答验签；留空保存=不修改'),
  ('支付', 'pay.alipay.gateway', '支付宝网关', '"https://openapi.alipay.com/gateway.do"'::jsonb, '"https://openapi.alipay.com/gateway.do"'::jsonb, 'string', NULL, '正式网关；沙箱联调改 https://openapi-sandbox.dl.alipaydev.com/gateway.do')
) AS v(group_name, setting_key, display_name, value, default_value, value_type, enum_options, remark)
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = v.setting_key);

-- 049 已将 mode 建为 string：升级为 enum（三态），保留现值
UPDATE system_settings
   SET value_type='enum',
       remark='off=记账式收款（手记流水+二次确认）/ mock=模拟通道（联调）/ real=真实通道（需下方配置填齐并启用渠道）'
 WHERE setting_key='pay.gateway.mode' AND value_type<>'enum';
