-- 053：设置可用性二轮整改（用户反馈四项）
--   ① 1=xxx/0=xxx 型数字设置 → enum 中文下拉（值不变，读端 getNum/String 兼容 "1"/"0"）
--   ② 条码库 mxnzp app_secret → secret（加密落库、界面脱敏；读端 decryptSecret 兼容明文透传）
--   ③ 备注全面人话化：删除版本号/设计文档编号（V4.x.x、5.4、8.4/6.4.1、50046 等），改为用户能懂的白话
-- 幂等：全部语句可重放

-- ── ① 数字 1/0 / 字符串枚举 → enum 下拉 ──
UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"1","label":"开通（配送/外卖）"},
  {"v":"0","label":"仅自提"}
]'::jsonb, remark='开通后 H5 支持配送/外卖下单；关闭则仅支持到店自提'
 WHERE setting_key='delivery.serving' AND value_type<>'enum';

UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"1","label":"开启（商品会员价优先于等级折扣）"},
  {"v":"0","label":"关闭"}
]'::jsonb, remark='开启后按会员等级打折计价'
 WHERE setting_key='member.level_discount' AND value_type<>'enum';

UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"1","label":"同层多个促销取对顾客更优"},
  {"v":"0","label":"按创建顺序取第一个"}
]'::jsonb, remark='同一层多个促销同时命中时的取舍口径'
 WHERE setting_key='promo.take_best' AND value_type<>'enum';

UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"1","label":"叠加（商品行优惠 + 整单优惠都生效）"},
  {"v":"0","label":"只生效一层（商品行优惠优先）"}
]'::jsonb, remark='商品行级优惠（特价/第二件半价）与整单级优惠（满减/满折）能否同时享受'
 WHERE setting_key='promo.stack_layers' AND value_type<>'enum';

UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"auto","label":"自动探测 Ollama 服务"},
  {"v":"manual","label":"手动指定安装路径"},
  {"v":"none","label":"未接入（规则引擎兜底）"}
]'::jsonb, remark='本地大模型的接入方式；未接入时问答/日报走规则引擎'
 WHERE setting_key='ai.llm.mode' AND value_type<>'enum';

UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"block","label":"拦截入库（店长可强制通过）"},
  {"v":"warn","label":"仅标黄提示，不拦截"}
]'::jsonb, remark='入库价低于历史最低进价时的处理方式'
 WHERE setting_key='ai.ocr.low_price_mode' AND value_type<>'enum';

UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"baseline","label":"规则引擎（星期系数+趋势，推荐）"},
  {"v":"lgbm","label":"LightGBM 模型服务（数据量足时更准）"}
]'::jsonb, remark='销量预测引擎；LightGBM 需本地模型服务已部署且数据量达标，失败自动回落规则引擎'
 WHERE setting_key='ai.forecast.engine' AND value_type<>'enum';

UPDATE system_settings SET value_type='enum', enum_options='[
  {"v":"auto","label":"自动识别"},
  {"v":"dahua","label":"大华电子秤"},
  {"v":"topping","label":"顶尖电子秤"},
  {"v":"generic","label":"通用连续帧"}
]'::jsonb, remark='电子秤串口数据格式，一般保持自动识别即可'
 WHERE setting_key='scale.protocol' AND value_type<>'enum';

-- ── ② mxnzp app_secret → secret（明文存量读取兼容：decryptSecret 对非密文原样透传）──
UPDATE system_settings SET value_type='secret',
       remark='与 app_id 配套的密钥——加密落库，界面只显尾号；留空保存=不修改'
 WHERE setting_key='barcode.lookup.mxnzp.app_secret' AND value_type<>'secret';

-- ── ③ 备注人话化（删版本号/文档编号/错误码黑话）──
UPDATE system_settings SET remark='建档/改档未填保质期的商品，禁止上架销售'                 WHERE setting_key='product.keep_days_required';
UPDATE system_settings SET remark='库存不足时仍允许退货出库（按负库存入账）'               WHERE setting_key='stock.negative_return';
UPDATE system_settings SET remark='向供应商收取的费用自动计入分红池'                       WHERE setting_key='recon.fee_to_dividend';
UPDATE system_settings SET remark='每日 6:00 自动生成智能补货建议单'                       WHERE setting_key='po.suggest_enabled';
UPDATE system_settings SET remark='开启后建议单自动推送店长审批（建议≠自动下单）'           WHERE setting_key='po.suggest_auto_send';
UPDATE system_settings SET remark='开启后结算付款完成流程才终结；关闭则审核通过即终结'      WHERE setting_key='recon.settle_pay_flow';
UPDATE system_settings SET remark='开启=优惠券可与促销活动同单叠加；关闭=同单已有促销时用券会被拒绝' WHERE setting_key='coupon.stack_with_promo';
UPDATE system_settings SET remark='关闭后顾客无法访问 H5 线上商城'                         WHERE setting_key='h5.enabled';
UPDATE system_settings SET remark='扫码购直接拉起微信/支付宝支付；需已备案域名并配置商户号' WHERE setting_key='h5.direct_pay';
UPDATE system_settings SET remark='扫码购单笔应付金额上限（元），超出需店员协助下单'        WHERE setting_key='h5.scan_go_limit';
UPDATE system_settings SET remark='顾客连门店 WiFi 时 H5 直连本地服务器，响应更快'          WHERE setting_key='h5.in_store_direct';
UPDATE system_settings SET remark='允许会员在 H5 用密码登录（关闭则仅验证码登录）'          WHERE setting_key='member.login.password_h5';
UPDATE system_settings SET remark='允许会员在小程序用密码登录（关闭则仅验证码登录）'        WHERE setting_key='member.login.password_mini';
UPDATE system_settings SET remark='过期未用的分红自动作废抹零，对应费用回冲分红池'          WHERE setting_key='dividend.expire_days';
UPDATE system_settings SET remark='分红按会员账户余额占比加权发放'                         WHERE setting_key='dividend.consume_weighted';
UPDATE system_settings SET remark='连续 N 天低于档位消费阈值才降级，偶尔波动不降级'         WHERE setting_key='member.level_grace_days';
UPDATE system_settings SET remark='会员 H5 发起充值的单笔上限（元），超出拒绝'             WHERE setting_key='member.recharge.max_single';
UPDATE system_settings SET remark='充值单超过该时长未支付即失效，会员可取消后重新发起'      WHERE setting_key='member.recharge.orders_expire_hours';
UPDATE system_settings SET remark='断网等应急场景下允许执行应急收银的角色'                 WHERE setting_key='ops.emergency_pay';
UPDATE system_settings SET remark='应急收银单笔金额上限（元）；日累计上限另行管控'          WHERE setting_key='ops.emergency_amount_cap';
UPDATE system_settings SET remark='打印机断线后自动尝试重连'                               WHERE setting_key='ops.printer_reconnect';
UPDATE system_settings SET remark='收银时语音播报金额与找零'                               WHERE setting_key='pos.voice_broadcast';
UPDATE system_settings SET remark='价目表超过该时长未更新则禁止进入应急收银；未命中商品仅限店长授权手输' WHERE setting_key='pos.pricebook_fresh_hours';
UPDATE system_settings SET remark='退款金额超过该值（元）需走审核'                         WHERE setting_key='pos.refund_limit';
UPDATE system_settings SET remark='勾选后对应单据必须签字才能过审'                         WHERE setting_key='auth.sign_required_scenes';
UPDATE system_settings SET remark='开启后识别不确定时用本地 Qwen-VL 大模型兜底'            WHERE setting_key='ai.vlm_fallback';
UPDATE system_settings SET remark='每日自动生成智能经营建议'                               WHERE setting_key='ai.suggest.auto';
UPDATE system_settings SET remark='主识别模型置信度低于该值时，启用本地大模型兜底'          WHERE setting_key='ai.fallback_conf';
UPDATE system_settings SET remark='商品多图知识库向量检索（需数据库支持 pgvector 扩展）'    WHERE setting_key='ai.kb.enabled';
UPDATE system_settings SET remark='开启后 AI 问答/日报由本地 Ollama 大模型生成，未就绪自动回落规则引擎' WHERE setting_key='ai.llm.enabled';
UPDATE system_settings SET remark='Ollama 服务地址（如 http://127.0.0.1:11434），仅本地大模型开启时使用' WHERE setting_key='ai.llm.base';
UPDATE system_settings SET remark='Top1 须领先 Top2 至少该差值才自动命中；不足则转候选卡片由店员点选'    WHERE setting_key='ai.emb.margin';
UPDATE system_settings SET remark='多件识别逐件采信阈值；低于该值回落为候选卡片由店员确认'  WHERE setting_key='ai.multi.min_conf';
UPDATE system_settings SET remark='累计分红 ≤ 净充值 × 该比例，达顶后仅发积分'              WHERE setting_key='dividend.cap_rate';
