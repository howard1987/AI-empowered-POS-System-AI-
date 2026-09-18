-- V4.13.4 系统设置可用性整改：
-- ① 分组归并 17 → 6（AI赋能 / 商品管理 / 财务管理 / 营销与线上 / 支付 / 通用设置）
-- ② enum 项补 enum_options（[{v,label}] JSONB 数组，前端下拉渲染，替代「取优/叠加（可选：取优/叠加）」式说明文案）
-- ③ 小票打印 / 开钱箱 / USERPAYING 查单轮询 新增设置项
-- 幂等：全部语句可重放

-- ── ① 分组归并（保留原 setting_key 与值，仅改 group_name）──
UPDATE system_settings SET group_name='AI赋能'   WHERE group_name IN ('AI','AI 引擎','AI与设备','智能能力');
UPDATE system_settings SET group_name='商品管理' WHERE group_name IN ('商品与库存','采购与供应商');
UPDATE system_settings SET group_name='财务管理' WHERE group_name IN ('分红与会员','会员');
UPDATE system_settings SET group_name='营销与线上' WHERE group_name IN ('促销营销','营销','线上渠道');
UPDATE system_settings SET group_name='通用设置' WHERE group_name IN ('收银','收银与小票','门店与运维','权限与安全','销售');
-- 支付 独立保留（通道配置敏感，单独一页）

-- ── ② enum 项补选项（前端渲染为下拉，value=落库值，label=用户可读文案）──
UPDATE system_settings SET enum_options='[
  {"v":"分","label":"不抹零（精确到分）"},
  {"v":"角","label":"抹到角（如 12.30 → 12.3）"},
  {"v":"5角","label":"抹到5角（如 12.30 → 12.5）"},
  {"v":"元","label":"抹到元（如 12.30 → 12）"}
]'::jsonb, remark='收银合计的抹零口径，向下去零；抹掉金额记 round_amount ≥0'
 WHERE setting_key='pos.round_rule';

UPDATE system_settings SET enum_options='[
  {"v":"取优","label":"取优：只给顾客最大的一项优惠"},
  {"v":"叠加","label":"叠加：多层优惠可同时享受"}
]'::jsonb, remark='同一订单命中多个促销时的优惠组合口径'
 WHERE setting_key='promo.stack_rule';

UPDATE system_settings SET enum_options='[
  {"v":"A","label":"A 离散：分红封顶按累计次数判定"},
  {"v":"B","label":"B 连续：分红封顶按累计金额判定"}
]'::jsonb, remark='分红上限（dividend.cap_rate）的累计口径'
 WHERE setting_key='dividend.cap_mode';

UPDATE system_settings SET enum_options='[
  {"v":"现场补签","label":"现场补签：店员/顾客当场手写签名"},
  {"v":"短信确认","label":"短信确认：验证码核对（无短信通道时线下核对并留痕）"}
]'::jsonb, remark='大额单据（金额≥auth.sign_threshold）的确认方式'
 WHERE setting_key='auth.sign_large_mode';

UPDATE system_settings SET enum_options='[
  {"v":"vl","label":"VL 视觉大模型（本地 Ollama qwen2.5vl）"},
  {"v":"mock","label":"模拟识别（联调用）"},
  {"v":"yolo","label":"YOLO 检测小模型（预留）"}
]'::jsonb, remark='AI 商品识别的底层引擎，识别管线自动分层调度'
 WHERE setting_key='ai.engine';

UPDATE system_settings SET enum_options='[
  {"v":"off","label":"记账式收款（手记流水 + 核对确认，不连通道）"},
  {"v":"mock","label":"模拟通道（联调用，不发生真实扣款）"},
  {"v":"real","label":"真实通道（微信/支付宝真实扣款，需填齐下方配置并启用渠道）"}
]'::jsonb, remark='支付通道模式：扫码收款走真实扣款还是记账留痕'
 WHERE setting_key='pay.gateway.mode';

-- ── ③ 新增设置项 ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT * FROM (VALUES
  -- 小票 / 钱箱（通用设置）
  ('通用设置', 'pos.receipt.auto_print', '落单自动打印小票', 'true'::jsonb, 'true'::jsonb, 'bool',
   '结账成功后自动打印销售小票（PWA 收银台）；关闭后可在成功提示里手动补打'),
  ('通用设置', 'pos.receipt.width', '小票纸宽(mm)', '80'::jsonb, '80'::jsonb, 'enum',
   '热敏小票打印机纸宽：58 / 80'),
  ('通用设置', 'pos.drawer.enabled', '落单后开钱箱', 'false'::jsonb, 'false'::jsonb, 'bool',
   '现金收款结账成功后向钱箱发弹开指令（WebSerial 连接钱箱/RJ11 接小票机时生效）'),
  -- USERPAYING 查单轮询（支付）
  ('支付', 'pay.gateway.userpaying_polls', '支付确认轮询次数', '8'::jsonb, '8'::jsonb, 'number',
   '微信返回 USERPAYING（顾客输入密码中）时自动查单轮询次数；用尽后可稍后手动查单确认'),
  ('支付', 'pay.gateway.userpaying_interval_sec', '支付确认轮询间隔(秒)', '4'::jsonb, '4'::jsonb, 'number',
   '查单轮询的间隔秒数；次数×间隔 = 最长等待时间')
) AS v(group_name, setting_key, display_name, value, default_value, value_type, remark)
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = v.setting_key);

-- 小票纸宽选项
UPDATE system_settings SET enum_options='[{"v":"58","label":"58mm（便携机）"},{"v":"80","label":"80mm（台式机）"}]'::jsonb
 WHERE setting_key='pos.receipt.width' AND value_type='enum' AND enum_options IS NULL;
