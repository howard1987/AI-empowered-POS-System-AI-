-- ═══ V4.16.5 十二项整改（074）═══
--  ① products.mall_image：商品商城图（后台/收银端/会员商城/移动端展示）
--  ② remote_sign_requests 扩列：手机采集三张样本 + 预览签收/退回重签
--  ③ weather_daily：每日实际天气本地沉淀（天气-销量回归训练数据源，P12 收口）
--  ④ 设置种子：商店信息 / 条码秤格式
-- 幂等防线：IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / NOT EXISTS 种子

-- ── ① 商品商城图 ──
ALTER TABLE products ADD COLUMN IF NOT EXISTS mall_image VARCHAR(200) DEFAULT '';

-- ── ② 远程签字：三样本 + 签收流程 ──
ALTER TABLE remote_sign_requests ADD COLUMN IF NOT EXISTS result_images JSONB;                 -- 全部样本路径数组
ALTER TABLE remote_sign_requests ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;              -- 退回重签次数
ALTER TABLE remote_sign_requests ADD COLUMN IF NOT EXISTS return_note VARCHAR(200);            -- 最近一次退回原因
-- status 语义扩展：待签字 → 待签收（手机已提交，等后台预览签收）→ 已签字 / 退回(置回待签字) / 已取消 / 已过期

-- ── ③ 每日实际天气（回归训练沉淀） ──
CREATE TABLE IF NOT EXISTS weather_daily (
  id         BIGSERIAL PRIMARY KEY,
  store_id   BIGINT NOT NULL DEFAULT 1,
  wdate      DATE   NOT NULL,
  temp_max   NUMERIC(6,1),
  temp_min   NUMERIC(6,1),
  precip_mm  NUMERIC(8,1),
  cond_text  VARCHAR(40) DEFAULT '',
  wind_max   NUMERIC(6,1),
  source     VARCHAR(16) DEFAULT 'cache',     -- cache=来自 weather_cache 沉淀 / manual
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_weather_daily UNIQUE (store_id, wdate)
);

-- ── ④ 设置种子 ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '门店与运维', 'store.info.name', '商店名称', to_jsonb(''::text), to_jsonb(''::text), 'string',
       '留空用门店档案名；小票抬头/商城/门头动态取此值'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='store.info.name');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '门店与运维', 'store.info.address', '商店地址', to_jsonb(''::text), to_jsonb(''::text), 'string', '展示于小票/商城页脚等'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='store.info.address');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '门店与运维', 'store.info.contact', '联系人', to_jsonb(''::text), to_jsonb(''::text), 'string', ''
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='store.info.contact');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '门店与运维', 'store.info.phone', '联系电话', to_jsonb(''::text), to_jsonb(''::text), 'string', ''
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='store.info.phone');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.scale.barcode_format', '条码秤格式', to_jsonb(''::text), to_jsonb(''::text), 'string',
       '空=不解析秤码。模板字符：F前缀 W重量(克) E金额(分→元) N商品码 P单价(分→元) C校验 D忽略位 . 小数点，如 FWWWWWWEEEEEC'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.scale.barcode_format');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.scale.custom_format', '自定义秤码格式', to_jsonb(''::text), to_jsonb(''::text), 'string',
       '条码秤格式选「自定义」时生效，字符集同上'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.scale.custom_format');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.touch.silent_days', '沉默会员判定天数', '30'::jsonb, '30'::jsonb, 'number',
       '超过该天数无有效消费且有余额/未用券 → 进入「沉默唤醒」推送名单（原 30 天硬编码提升为可改）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.touch.silent_days');
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.touch.limit', '单次唤醒名单上限', '20'::jsonb, '20'::jsonb, 'number',
       '每次生成沉默唤醒名单的最多人数（按余额排序取前 N）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.touch.limit');
