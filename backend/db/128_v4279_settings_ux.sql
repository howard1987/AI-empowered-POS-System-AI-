-- 128 · V4.27.9 设置页治理：控件类型修正 / 下拉枚举补齐 / 文案人话化 / 按功能重新分组
-- 原则：设置页要看得懂、点得动——去掉设计文档腔（版本号/方案号/内部术语），只留"这个设置管什么、改了会怎样"。
-- 幂等：全部语句级 UPDATE，重放净空操作。

-- ═══ ① 控件类型修正（错误类型导致渲染成错误的控件）═══
UPDATE system_settings SET value_type='number' WHERE value_type='num';       -- 5 键：数字被当文本
UPDATE system_settings SET value_type='bool'    WHERE value_type='boolean';  -- 2 键：开关被当文本
UPDATE system_settings SET value_type='string'  WHERE value_type='text';     -- 1 键：长文本被当未知类型

-- ═══ ② 下拉枚举修正 / 补齐 ═══
-- 识别引擎：去掉"预留/模拟"陈旧项，按当前真实能力排序
UPDATE system_settings SET
  enum_options='[{"v":"yolo","label":"YOLO 检测模型（推荐：拍照样本训练后使用）"},{"v":"vl","label":"本地视觉大模型（Ollama，准确但较慢）"},{"v":"sample","label":"样本相似度匹配（dHash，兜底）"},{"v":"mock","label":"模拟联调（不做真实识别）"}]'::jsonb,
  remark='商品识别的底层引擎；实际收银时仍按「条码 → 图像检索 → 模型」自动分层调度'
 WHERE setting_key='ai.engine';

-- 自动训练底座：文本 → 下拉
UPDATE system_settings SET value_type='enum',
  enum_options='[{"v":"yolo26n.pt","label":"YOLO26 nano（推荐，最新最快）"},{"v":"yolo11n.pt","label":"YOLO11 nano"},{"v":"yolov8n.pt","label":"YOLOv8 nano（与旧版一致）"}]'::jsonb,
  remark='训练用哪个预训练底座，一般用默认即可'
 WHERE setting_key='ai.autotrain.model';

-- 自动训练星期：数字 → 下拉
UPDATE system_settings SET value_type='enum',
  enum_options='[{"v":"0","label":"周日"},{"v":"1","label":"周一"},{"v":"2","label":"周二"},{"v":"3","label":"周三"},{"v":"4","label":"周四"},{"v":"5","label":"周五"},{"v":"6","label":"周六"}]'::jsonb,
  remark='每周几自动训练（建议选收银最闲的日子）'
 WHERE setting_key='ai.autotrain.day_of_week';

-- 自动训练设备：数字 → 下拉
UPDATE system_settings SET value_type='enum',
  enum_options='[{"v":"0","label":"GPU 0（推荐，有 NVIDIA 显卡时）"},{"v":"1","label":"GPU 1"},{"v":"cpu","label":"CPU（无显卡时用，速度慢很多）"}]'::jsonb,
  remark='训练用哪个设备：有 NVIDIA 显卡选 GPU；没有选 CPU（速度慢很多）'
 WHERE setting_key='ai.autotrain.device';

-- ═══ ③ 文案人话化（去设计文档腔：版本号 / 方案编号 / 内部术语）═══
UPDATE system_settings SET remark='开=结算单审核通过后，还需再点「确认已付款」才算完结；关=审核通过即完结'
 WHERE setting_key='recon.settle_pay_flow';
UPDATE system_settings SET remark='没连接小票机时，是否允许弹出浏览器打印窗口作为兜底'
 WHERE setting_key='pos.print.browser_fallback';
UPDATE system_settings SET remark='关=门店申请新商品上架需要总部批准；开=申请后直接生效'
 WHERE setting_key='chain.product.self_apply';
UPDATE system_settings SET remark='总部还没维护过某商品进价时，第一笔入库的实际进价自动作为标准进价，新品立即受进价保护'
 WHERE setting_key='chain.cost.auto_adopt_new';
UPDATE system_settings SET remark='下单超过 N 天的订单不能在收银台退货；0 = 不限时间'
 WHERE setting_key='sales.refund.window_days';
UPDATE system_settings SET remark='收银合计金额的抹零方式（只抹零、不多收）'
 WHERE setting_key='pos.round_rule';
UPDATE system_settings SET remark='员工/会员密码的强度要求：新建账号、修改密码、重置密码都按此校验'
 WHERE setting_key='auth.password_policy';
UPDATE system_settings SET remark='同一单同时命中多个促销时，自动按对顾客最优惠的一个执行'
 WHERE setting_key='promo.take_best';
UPDATE system_settings SET remark='开=库存不足也允许卖出（系统记为负库存，进货后自动冲抵）；关=库存不足时拦截销售'
 WHERE setting_key='stock.negative_sales';
UPDATE system_settings SET remark='开=向供应商收取的费用自动计入分红池'
 WHERE setting_key='recon.fee_to_dividend';
UPDATE system_settings SET remark='在系统内置节日之外补充自定义节日（如店庆日）：填名称、月、日和客流倍数，供备货建议参考；可逐行编辑，也可联网一键导入法定节日'
 WHERE setting_key='ai.holiday.custom';
UPDATE system_settings SET display_name='在线条码库 AppID（mxnzp）',
  remark='在 mxnzp.com 免费申请；填写后建档扫码可自动带出商品资料；留空=不使用该数据源'
 WHERE setting_key='barcode.lookup.mxnzp.app_id';
UPDATE system_settings SET display_name='在线条码库密钥（mxnzp）',
  remark='与上面 AppID 配套的密钥；加密保存，界面只显示尾号'
 WHERE setting_key='barcode.lookup.mxnzp.app_secret';

-- ═══ ④ 按功能重新分组 ═══
-- 收银台：从「设备管理」迁出收银行为/积分/挂账/班次/折扣授权等（设备管理只留设备与外设）
UPDATE system_settings SET group_name='收银台'
 WHERE group_name='设备管理' AND (setting_key LIKE 'pos.cashier.%' OR setting_key LIKE 'pos.points.%'
   OR setting_key LIKE 'pos.credit.%' OR setting_key LIKE 'pos.cashbox.%' OR setting_key LIKE 'pos.shift.%'
   OR setting_key LIKE 'pos.discount.%' OR setting_key LIKE 'pos.price.%' OR setting_key LIKE 'pos.held.%');

-- AI识别：从「AI赋能」拆出商品识别/样本/训练相关（AI 秤拍照识别是核心功能，独立成组）
UPDATE system_settings SET group_name='AI识别'
 WHERE group_name='AI赋能' AND setting_key ~ '^(ai\.(engine|fallback_conf|vlm_fallback|frames|autotrain|seg\.|track\.|rerank|multi\.|emb\.|sample|recog|ocr\.))';

-- 剩余 AI赋能 → AI经营（补货/定价/防损/预测/日报/问答等经营分析类）
UPDATE system_settings SET group_name='AI经营' WHERE group_name='AI赋能';
