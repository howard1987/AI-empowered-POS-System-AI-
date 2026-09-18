-- 054：设置可用性三轮整改（用户截图反馈两项）
--   ① 单位（天/元/%/秒/小时…）不再放说明列 → 新增 unit 列；前端把单位拼在「当前值」「默认值」后面，
--      说明列只放真正的说明文字
--   ② 剩余黑话说明人话化：dividend.cap_mode 枚举 label 去掉「离散/连续」、cap_rate「终身封顶率R」改名、
--      「round_amount ≥0」「金额≥auth.sign_threshold」等键名引用改白话；纯单位的说明（天/元/%）补齐真说明
-- 幂等：全部语句可重放

-- ── ① 新增单位列 ──
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS unit VARCHAR(16);

-- ── ② 数字型设置补单位（前端展示用，不改数值）──
UPDATE system_settings SET unit='天'  WHERE setting_key IN (
  'ai.restock.coverage_days','ai.restock.safety_days','ai.forecast.history_days',
  'ai.forecast.lgbm.min_days','ai.fraud.window_days','ai.pricing.expiry_days',
  'ai.pricing.stale_days','ai.assortment.window_days','ai.assortment.max_turnover_days',
  'dividend.window_days','dividend.expire_days','member.level_grace_days','auth.audit_retention');
UPDATE system_settings SET unit='元'  WHERE setting_key IN (
  'ai.fraud.cash_gap','delivery.fee','delivery.free_above','h5.scan_go_limit',
  'dividend.min_single','dividend.min_window','member.recharge.max_single',
  'pos.refund_limit','sales.refund.limit','auth.sign_threshold',
  'ops.emergency_amount_cap','report.daily_target');
UPDATE system_settings SET unit='%'   WHERE setting_key IN (
  'dividend.ratio','dividend.cap_rate','dividend.orange_alert','dividend.red_alert');
UPDATE system_settings SET unit='小时' WHERE setting_key IN (
  'stock.expiry_disposal_hours','member.recharge.orders_expire_hours','pos.pricebook_fresh_hours');
UPDATE system_settings SET unit='秒'  WHERE setting_key IN (
  'finance.billrecon.window_seconds','pos.heartbeat_timeout',
  'pay.gateway.userpaying_interval_sec');
UPDATE system_settings SET unit='次'  WHERE setting_key IN (
  'barcode.crawler.daily_limit','pay.gateway.userpaying_polls');
UPDATE system_settings SET unit='件'  WHERE setting_key='ai.pricing.stale_qty';
UPDATE system_settings SET unit='单'  WHERE setting_key='ai.fraud.discount_n';
UPDATE system_settings SET unit='张'  WHERE setting_key='ai.emb.topk';
UPDATE system_settings SET unit='积分' WHERE setting_key='points.redeem_rate';
UPDATE system_settings SET unit='km'  WHERE setting_key='delivery.radius_km';
UPDATE system_settings SET unit='kg'  WHERE setting_key='antileak.weight.tolerance';

-- ── ③ 名称里的单位后缀去掉（单位已在值后面展示，避免「单笔充值上限(元) 5000元」重复）──
UPDATE system_settings SET display_name='单笔充值上限'             WHERE setting_key='member.recharge.max_single';
UPDATE system_settings SET display_name='充值单待支付有效期'       WHERE setting_key='member.recharge.orders_expire_hours';
UPDATE system_settings SET display_name='日销售目标'               WHERE setting_key='report.daily_target';
UPDATE system_settings SET display_name='应急价目表新鲜度上限'     WHERE setting_key='pos.pricebook_fresh_hours';
UPDATE system_settings SET display_name='退款免审限额'             WHERE setting_key='sales.refund.limit';
UPDATE system_settings SET display_name='收银差异阈值'             WHERE setting_key='ai.fraud.cash_gap';
UPDATE system_settings SET display_name='销量预测历史窗口'         WHERE setting_key='ai.forecast.history_days';
UPDATE system_settings SET display_name='LGBM 数据门槛'            WHERE setting_key='ai.forecast.lgbm.min_days';
UPDATE system_settings SET display_name='防损基线窗口'             WHERE setting_key='ai.fraud.window_days';
UPDATE system_settings SET display_name='安全库存系数'             WHERE setting_key='ai.restock.safety_days';
UPDATE system_settings SET display_name='选品观察窗口'             WHERE setting_key='ai.assortment.window_days';
UPDATE system_settings SET display_name='对账时间窗口'             WHERE setting_key='finance.billrecon.window_seconds';
UPDATE system_settings SET display_name='配送费'                   WHERE setting_key='delivery.fee';
UPDATE system_settings SET display_name='免配送费门槛'             WHERE setting_key='delivery.free_above';
UPDATE system_settings SET display_name='配送半径'                 WHERE setting_key='delivery.radius_km';
UPDATE system_settings SET display_name='临期处置时限'             WHERE setting_key='stock.expiry_disposal_hours';
UPDATE system_settings SET display_name='支付确认轮询间隔'         WHERE setting_key='pay.gateway.userpaying_interval_sec';
UPDATE system_settings SET display_name='称重容差'                 WHERE setting_key='antileak.weight.tolerance';

-- ── ④ 剩余黑话说明人话化 ──

-- ④-1 上限口径：label 去掉「离散/连续」（值 A/B 不变，读端逻辑不受影响）
UPDATE system_settings SET enum_options='[
  {"v":"B","label":"按累计充值金额封顶"},
  {"v":"A","label":"按分红发放次数封顶"}
]'::jsonb, remark='终身分红封顶按什么口径累计：累计充值金额，或分红发放次数'
 WHERE setting_key='dividend.cap_mode';

-- ④-2 终身封顶率R → 人话名 + 人话说明
UPDATE system_settings SET display_name='分红终身封顶比例',
       remark='每位会员累计领的分红 ≤ 其累计充值 × 该比例；达到封顶后新分红只发积分，不再发现金'
 WHERE setting_key='dividend.cap_rate';

-- ④-3 纯单位说明的分红项补齐真说明
UPDATE system_settings SET remark='每日分红池 = 昨日净利润 × 该比例'                                   WHERE setting_key='dividend.ratio';
UPDATE system_settings SET remark='单笔消费满该金额才计入分红资格，防微额刷单'                          WHERE setting_key='dividend.min_single';
UPDATE system_settings SET remark='统计窗口内累计消费满该金额才具备分红资格'                            WHERE setting_key='dividend.min_window';
UPDATE system_settings SET remark='「窗口内累计消费」的统计天数范围'                                    WHERE setting_key='dividend.window_days';
UPDATE system_settings SET remark='分红年化达到该比例时橙色预警，提醒关注分红支出'                      WHERE setting_key='dividend.orange_alert';
UPDATE system_settings SET remark='分红年化达到该比例时红色预警，须立即干预（低于橙色档）'              WHERE setting_key='dividend.red_alert';

-- ④-4 其他黑话/键名引用
UPDATE system_settings SET remark='收银合计的抹零口径，只抹不加'                                        WHERE setting_key='pos.round_rule';
UPDATE system_settings SET remark='收银端与服务器断联超过该时长，弹窗引导进入应急收银'                  WHERE setting_key='pos.heartbeat_timeout';
UPDATE system_settings SET remark='单据金额超过该值需短信确认或现场补签'                                WHERE setting_key='auth.sign_threshold';
UPDATE system_settings SET remark='单据金额超过「大额签字阈值」时的确认方式'                            WHERE setting_key='auth.sign_large_mode';
UPDATE system_settings SET remark='商品临近保质期提前提醒：先黄色提示、后橙色加急；两个档位可改'        WHERE setting_key='stock.expiry_warn_days';
UPDATE system_settings SET remark='商品临期自动打折：剩 3 天打 8 折、剩 1 天打 7 折；档位与折扣可改'    WHERE setting_key='promo.expiry_auto_discount';
UPDATE system_settings SET remark='智能调价的建议价至少保证该毛利率（0.05 = 至少加价 5%）'              WHERE setting_key='ai.pricing.min_margin';
UPDATE system_settings SET remark='购物篮规则的最低可信度（0~1，越高规则越严格）'                       WHERE setting_key='ai.assoc.min_conf';
UPDATE system_settings SET remark='折扣力度超过商品原价该比例记异常折扣单（0.3 = 30%）'                 WHERE setting_key='ai.fraud.discount_floor';
UPDATE system_settings SET remark='近 30 天退货单占比超过该值记异常（0.1 = 10%）'                       WHERE setting_key='ai.fraud.return_floor';
UPDATE system_settings SET remark='审计日志保留天数，到期自动归档清理'                                  WHERE setting_key='auth.audit_retention';
