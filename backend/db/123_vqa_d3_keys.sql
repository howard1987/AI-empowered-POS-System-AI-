-- 123_vqa_d3_keys.sql · VQA-D3 僵尸设置键治理（31 个零引用键：14 删 / 17 接线或实现）
-- 依据：全代码引用面扫描（dist+public+src 295 文件，注册 241 键，零命中 31 键）
-- 原则：语义被在用键覆盖或场景不存在的 → 删；有真实落点的 → 本轮代码接线后保留并校准备注。

-- ══ ① 删除 14 个重复/无场景键（各删除项均注明其语义承接方）══
-- 1  ai.kb.enabled        → 向量检索实际由 ai.emb.enabled 门控（店内知识=关键词检索 aibrain.engine）
-- 2  ai.recog.confidence  → 识别阈值实际在 ai.emb.min_conf/strict_conf + ai.fallback_conf
-- 3  po.suggest_enabled   → 补货建议生成实际由 ai.restock.time 驱动的每日刷新承担
-- 4  po.suggest_auto_send → 自动审批实际由 ai.decision.modes 控制
-- 5  dividend.consume_weighted → 分红权重口径已固化=本金余额×等级系数（键名与实现矛盾，命名遗留）
-- 6  dividend.cap_mode    → 封顶口径已固化=净充值×cap_rate（口径B），无发放次数分支
-- 7  pos.refund_limit     → 免审退款限额在用键 sales.refund.limit（同义双登记，保留在用者）
-- 8  pos.refund.limit     → 同上；收银员超限放行统一走 sales.refund.audit 权限点
-- 9  promo.stack_rule     → 叠加口径在用键 promo.take_best + promo.stack_layers（枚举被两 bool 覆盖）
-- 10 member.login.password_mini → 系统无小程序端载体
-- 11 scale.protocol       → 收银秤解析已内置自适应（ST/US+kg/g），协议恒为 auto
-- 12 h5.in_store_direct   → 会员端全同源部署（/m 相对路径），无中转加速场景
-- 13 pos.credit.limit     → Q8 裁决会员挂账通道已停用（挂账走大客户对账/断网挂账各自的在用键）
-- 14 init.opening_stock_mode → 开业库存录入由盘点/入库页面引导，无程序分支
DELETE FROM system_settings WHERE setting_key IN (
  'ai.kb.enabled','ai.recog.confidence','po.suggest_enabled','po.suggest_auto_send',
  'dividend.consume_weighted','dividend.cap_mode','pos.refund_limit','pos.refund.limit',
  'promo.stack_rule','member.login.password_mini','scale.protocol','h5.in_store_direct',
  'pos.credit.limit','init.opening_stock_mode');

-- ══ ② 保留键：备注校准（本轮已在代码中接线，口径以备注为准）══
UPDATE system_settings SET remark='线上商城/扫码购总开关：关=会员端下单入口全面关闭（现由 member-app createOrder 服务端消费）。店内查询不受影响' WHERE setting_key='h5.enabled';
UPDATE system_settings SET remark='会员掌上门户（/member/ 登录·注册·找回）总开关：关=会员端登录注册接口全部返回维护中，仅员工代客操作' WHERE setting_key='member.h5.enabled';
UPDATE system_settings SET remark='开=会员可在 H5 手机号自助注册建档（含密保设置）；关=仅员工/后台建档。现由注册接口服务端消费' WHERE setting_key='member.h5.allow_register';
UPDATE system_settings SET remark='扫码购单笔应付上限（元，0=不设限）。现由下单服务端消费：超限拒单并提示转收银台' WHERE setting_key='h5.scan_go_limit';
UPDATE system_settings SET remark='扫码购允许选微信/支付宝付款；当前为模拟通道记账（pay.gateway mode=mock），真通道需已备案域名+商户号（外部资质）' WHERE setting_key='h5.direct_pay';
UPDATE system_settings SET remark='允许会员在 H5 用密码登录（关=暂停密码登录并提示门店协助；验证码登录依赖短信服务商接入后启用）' WHERE setting_key='member.login.password_h5';
UPDATE system_settings SET remark='收银称重商品（is_weighted）Web Serial 串口自动读重总开关：关=秤连接入口关闭，仍可手输/扫秤码' WHERE setting_key='scale.enabled';
UPDATE system_settings SET remark='收银加购时播报商品名+价格（在 pos.cashier.tts 总开关之下的子开关）' WHERE setting_key='voice.product.enabled';
UPDATE system_settings SET remark='收银端连续无法访问服务器超过该秒数（WiFi 已连但局域网断/服务挂）→ 弹离线收银引导。与 navigator.onLine 双保险' WHERE setting_key='pos.heartbeat_timeout';
UPDATE system_settings SET remark='打印机 USB 刷新后静默自动重连总闸：关=需到设备面板手动重连' WHERE setting_key='ops.printer_reconnect';
UPDATE system_settings SET remark='收银台快捷商品区默认展示格数（8~12）与编辑上限；本机自定义仍可覆盖' WHERE setting_key='pos.cashier.quick_count';
UPDATE system_settings SET remark='开=每日天气备货建议纳入 AI 刷新（ai.weather.enabled 的数据源开关之下）；关=跳过天气备货' WHERE setting_key='ai.weather.auto_factor';
UPDATE system_settings SET remark='开=补货建议一键转采购单时在单据「预算金额」记录预计采购成本快照，供货审批参考' WHERE setting_key='po.suggest_budget';
UPDATE system_settings SET remark='开=结算单审核通过后进入「付款中」，需再点「确认已付款」流程才终结；关=审核即终结（旧口径）。状态值用枚举原生「付款中/已付款」（5.6.5 设计）' WHERE setting_key='recon.settle_pay_flow';
UPDATE system_settings SET remark='开=方向「收」的供应商费用单落库即打计入分红池标记，分红净利口径同步加上当日费用收入' WHERE setting_key='recon.fee_to_dividend';
UPDATE system_settings SET remark='审计日志保留天数（0=关闭清理）：每日 00:10 超期行迁移 audit_logs_archive 后从主表删除' WHERE setting_key='auth.audit_retention';
UPDATE system_settings SET remark='开业日（init.opening_date）当天 00:06 起向全员广播本说明一次（员工端铃铛+老板端消息中心）；留空=不广播' WHERE setting_key='init.opening_note';

-- ══ ③ 审计日志归档表（auth.audit_retention 清理 job 的落点；LIKE 含列缺省）══
CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id BIGINT, store_id BIGINT, employee_id BIGINT, module VARCHAR(32), action VARCHAR(64),
  target_type VARCHAR(32), target_id BIGINT, detail JSONB, ip INET,
  created_at TIMESTAMPTZ NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_arch_time ON audit_logs_archive (created_at DESC);

-- ══ ④ recon.settle_pay_flow：付款步直接采用 settlement_status_t 原生值——
--    审核→'付款中'（5.6.5 设计即预留），确认已付款→'已付款'，无需改表。══
