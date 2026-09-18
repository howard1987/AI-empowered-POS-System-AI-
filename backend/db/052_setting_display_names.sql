-- 052：设置显示名消歧——渠道前缀补全（配合前端小节聚类，用户一眼知道改的是微信还是支付宝）
-- 幂等：仅当显示名不一致时更新
UPDATE system_settings SET display_name='微信商户 API 私钥'   WHERE setting_key='pay.wechat.private_key'  AND display_name <> '微信商户 API 私钥';
UPDATE system_settings SET display_name='微信 APIv3 密钥'     WHERE setting_key='pay.wechat.apiv3_key'    AND display_name <> '微信 APIv3 密钥';
UPDATE system_settings SET display_name='微信商户证书序列号'   WHERE setting_key='pay.wechat.cert_serial'  AND display_name <> '微信商户证书序列号';
UPDATE system_settings SET display_name='支付确认轮询次数（顾客输密中）' WHERE setting_key='pay.gateway.userpaying_polls' AND display_name NOT LIKE '支付确认轮询次数%';
UPDATE system_settings SET display_name='支付确认轮询间隔（秒）' WHERE setting_key='pay.gateway.userpaying_interval_sec' AND display_name <> '支付确认轮询间隔（秒）';
