-- 045 · V4.13 六项智能能力落地：
--   ① 漏扫检测 MVP（antileak_alerts + 自助收银一致性校验开关）
--   ② 支付账单导入对账（payment_bills + bill_recon_runs）
--   ③ AI 选品建议（suggestion_domain_t 增 '选品' 域）
--   ④ qa 预置问题（静态清单，无表）
--   ⑤ 语音查价单点（voice.price.enabled 开关）
--   ⑥ 预测引擎升级开关（ai.forecast.engine = baseline | lgbm）
-- 全部幂等，可重复重放。

-- 1) 建议域枚举补 '选品'（PG12+ 允许事务内 ADD VALUE，只要本文件内不使用该新值写行）
ALTER TYPE suggestion_domain_t ADD VALUE IF NOT EXISTS '选品';

-- 2) 支付平台账单行（微信/支付宝导出 CSV 逐行入库）
CREATE TABLE IF NOT EXISTS payment_bills (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  batch_no        VARCHAR(32) NOT NULL,                -- 导入批次号（一次导入一批）
  channel         VARCHAR(16) NOT NULL,                -- 微信 / 支付宝
  external_no     VARCHAR(64) NOT NULL,                -- 平台交易单号（对账主键）
  amount          NUMERIC(12,2) NOT NULL,              -- 收入金额（正数；支出/退款行过滤另计）
  pay_time        TIMESTAMPTZ,                         -- 平台侧支付/入账时间
  bill_status     VARCHAR(64),                         -- 平台侧状态原文（成功/退款等）
  direction       VARCHAR(8),                          -- 收入/支出（原始）
  raw             JSONB,                               -- 原始行（列名→值），留痕可追溯
  match_status    VARCHAR(16) NOT NULL DEFAULT '未匹配', -- 未匹配/已匹配/金额差异/疑似重复/已忽略
  matched_order_id BIGINT REFERENCES sales_orders(id),
  matched_payment_id BIGINT,
  match_note      VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pb_batch ON payment_bills (store_id, batch_no);
CREATE UNIQUE INDEX IF NOT EXISTS uk_pb_ext ON payment_bills (store_id, channel, external_no, batch_no);
CREATE INDEX IF NOT EXISTS idx_pb_match ON payment_bills (store_id, channel, match_status);

-- 3) 对账批次（一次运行 = 导入 + 自动对齐 + 差异清单）
CREATE TABLE IF NOT EXISTS bill_recon_runs (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  batch_no        VARCHAR(32) NOT NULL,
  channel         VARCHAR(16) NOT NULL,
  bill_date       DATE,
  bill_rows       INT NOT NULL DEFAULT 0,              -- 账单行数
  bill_total      NUMERIC(12,2) NOT NULL DEFAULT 0,    -- 账单收入合计
  matched_rows    INT NOT NULL DEFAULT 0,              -- 已对上行数
  matched_total   NUMERIC(12,2) NOT NULL DEFAULT 0,    -- 已对上金额
  local_total     NUMERIC(12,2) NOT NULL DEFAULT 0,    -- 本地同期该渠道收款合计
  diff_rows       INT NOT NULL DEFAULT 0,              -- 差异行数（账单有本地无 + 疑似重复）
  summary         JSONB,                               -- 汇总与明细（差异清单）
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brr_store ON bill_recon_runs (store_id, created_at DESC);

-- 4) 漏扫/称重差异告警（自助收银复核闭环）
CREATE TABLE IF NOT EXISTS antileak_alerts (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL,
  member_id       BIGINT,                              -- 触发会员（自助收银）
  kind            VARCHAR(16) NOT NULL,                -- 件数差异 / 重量差异
  detail          JSONB NOT NULL,                      -- 差异明细
  status          VARCHAR(16) NOT NULL DEFAULT '待复核', -- 待复核 / 已放行 / 已拦截
  handled_by      BIGINT,
  handled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ala_store ON antileak_alerts (store_id, status, created_at DESC);

-- 5) 设置开关（group=智能能力；老板端设置页可切换）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
  ('智能能力', 'antileak.selfcheckout.enabled', '自助收银漏扫校验', 'true'::jsonb, 'true'::jsonb, 'bool',
   '扫码购/自助结算时校验 AI 识别件数 vs 结算件数、理论重量 vs 实秤重量；差异即暂停待店员复核'),
  ('智能能力', 'antileak.weight.tolerance', '称重容差(kg)', '0.05'::jsonb, '0.05'::jsonb, 'number',
   '称重商品理论重量与实秤重量允许偏差；超出即判定重量差异'),
  ('智能能力', 'antileak.count.strict', '件数校验严格模式', 'true'::jsonb, 'true'::jsonb, 'bool',
   '严格=结算件数少于识别件数即拦截；宽松=仅缺件 ≥2 时拦截'),
  ('智能能力', 'finance.billrecon.enabled', '支付账单导入对账', 'true'::jsonb, 'true'::jsonb, 'bool',
   '微信/支付宝账单 CSV 导入 → 金额+时间窗口对齐本地流水 → 差异清单进日结'),
  ('智能能力', 'finance.billrecon.window_seconds', '对账时间窗口(秒)', '300'::jsonb, '300'::jsonb, 'number',
   '本地收款时间与平台入账时间的最大允许偏移；平台入账有延迟，默认 ±5 分钟'),
  ('智能能力', 'ai.assortment.enabled', 'AI 选品建议', 'true'::jsonb, 'true'::jsonb, 'bool',
   '动销/周转打分 → 淘汰清仓清单 + 品类扩容建议进决策中心待处理建议流'),
  ('智能能力', 'ai.assortment.window_days', '选品观察窗口(天)', '30'::jsonb, '30'::jsonb, 'number',
   '动销统计窗口；窗口内动销天数 ≤阈值 且 库存偏高 → 建议淘汰'),
  ('智能能力', 'ai.assortment.max_turnover_days', '淘汰周转天数阈值', '60'::jsonb, '60'::jsonb, 'number',
   '库存可售天数超过该值且动销低迷 → 进入淘汰清单'),
  ('智能能力', 'voice.price.enabled', '语音查价', 'false'::jsonb, 'false'::jsonb, 'bool',
   'PWA 收银台语音查价单点（浏览器 Web Speech API 本地识别 + TTS 报价，零云端依赖）；默认关，店员验证后再开'),
  ('智能能力', 'ai.forecast.engine', '销量预测引擎', '"baseline"'::jsonb, '"baseline"'::jsonb, 'string',
   'baseline=星期系数+趋势（现役规则引擎）；lgbm=LightGBM 模型服务（需数据 ≥ ai.forecast.lgbm.min_days 且服务可达，失败自动回落 baseline）'),
  ('智能能力', 'ai.forecast.lgbm.url', 'LightGBM 服务地址', '"http://localhost:9101"'::jsonb, '"http://localhost:9101"'::jsonb, 'string',
   '本地 Python LightGBM 微服务（ai-forecast-svc/）；未部署时保持 baseline 引擎即可'),
  ('智能能力', 'ai.forecast.lgbm.min_days', 'LGBM 数据门槛(天)', '56'::jsonb, '56'::jsonb, 'number',
   '全店累计有流水天数达到该值才允许 lgbm 引擎生效（8 周起步，防过拟合空转）')
ON CONFLICT (setting_key) DO NOTHING;
