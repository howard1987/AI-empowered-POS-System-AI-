-- 139 · V4.28.9 设置项全面审计落地：清理孤儿/重复键 + 高混淆备注校准
-- 审计方法：248 键逐一在四端代码（backend/src、backend/public、frontend-web、frontend-desktop）做引用面扫描。

-- ① 删除真孤儿/重复键（全代码零消费）：
--    points.redeem_rate 与 pos.points.rate（收银台·积分抵现比例(分/百积分)，cashier.js 消费）语义重复且未落地；
--    store.info.address/contact/phone 三键零消费（仅 store.info.name 被 PWA 小票抬头使用，保留）
DELETE FROM system_settings WHERE setting_key IN (
  'points.redeem_rate',
  'store.info.address','store.info.contact','store.info.phone'
);

-- ② 备注校准（防误读，不动值）：
--    商店名称：说明其"小票抬头显示名"定位与回退语义（不是与门店档案重复，是可覆盖的显示层）
UPDATE system_settings SET remark='小票抬头/收银台门头显示名（后台可改）；留空回退连锁门店档案的门店名。注意：address/contact/phone 三个同名前缀键已废弃删除，门店地址电话以「连锁管理-门店管理」档案为准' WHERE setting_key='store.info.name';

--    打印三键分工（此前备注未说清，最易混淆）：
UPDATE system_settings SET remark='小票机自动出票总开关（已配默认小票机时生效）；没配小票机走浏览器兜底，由「浏览器兜底打印」控制' WHERE setting_key='pos.print.auto';
UPDATE system_settings SET remark='未配置小票机时：开=自动弹浏览器打印预览兜底出票；关=绝不弹预览（明示未出票，可补打）。与小票机路径的「结账自动打印小票」互补' WHERE setting_key='pos.print.browser_fallback';
UPDATE system_settings SET remark='浏览器打印路径的自动出票开关（receipt 模块）；是否走浏览器兜底路径由「浏览器兜底打印」决定，本键只管该路径内是否自动打' WHERE setting_key='pos.receipt.auto_print';
