-- ═══ V4.16.3 AI 增长四件套（073）═══
--  ① ref_product_pool 外部商品池：供应商目录/行业条码库 Excel 导入的"参考商品数据"（不进正式档案）
--     建档/扫码查询链：本店库 → 确认缓存 → 外部商品池（本地秒回）→ 在线源 → 爬虫
--  ② member_portraits 会员 AI 画像缓存：SQL 聚合 + Ollama 人话建模结果
--  ③ 设置种子：自定义节日表 / 会员画像 / 预测地点因子与天气权重
-- 幂等防线：NOT EXISTS 种子 + 唯一约束

-- ── ① 外部商品池 ──
CREATE TABLE IF NOT EXISTS ref_product_pool (
  id           BIGSERIAL PRIMARY KEY,
  barcode      VARCHAR(20)  NOT NULL,
  name         VARCHAR(120) NOT NULL DEFAULT '',
  spec         VARCHAR(60)  DEFAULT '',
  unit         VARCHAR(20)  DEFAULT '',
  brand        VARCHAR(60)  DEFAULT '',
  category     VARCHAR(60)  DEFAULT '',
  price        NUMERIC(12,2),
  source       VARCHAR(30)  DEFAULT 'import',
  batch_no     VARCHAR(40)  DEFAULT '',
  hits         INT          DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT uq_ref_pool_barcode UNIQUE (barcode)
);
CREATE INDEX IF NOT EXISTS idx_ref_pool_name ON ref_product_pool (name);

-- ── ② 会员 AI 画像 ──
CREATE TABLE IF NOT EXISTS member_portraits (
  id           BIGSERIAL PRIMARY KEY,
  store_id     BIGINT NOT NULL,
  member_id    BIGINT NOT NULL,
  payload      JSONB  NOT NULL DEFAULT '{}'::jsonb,
  text         TEXT   DEFAULT '',
  engine       VARCHAR(20) DEFAULT 'rule',
  generated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_member_portrait UNIQUE (store_id, member_id)
);

-- ── ③ 设置种子 ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.holiday.custom', '自定义节日表', '[]'::jsonb, '[]'::jsonb, 'json',
       '外部导入入口：JSON 数组，格式 [{"name":"店庆日","m":9,"d":20,"factor":1.5}]（m/d=公历月日，y 可选指定年份，factor=客流系数）；保存后立即生效，与内置节日表合并（同名以自定义为准），可在下方粘贴编辑'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.holiday.custom');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.member.portrait.enabled', '会员 AI 画像', 'true'::jsonb, 'true'::jsonb, 'bool',
       '开启后「生成会员画像」用 SQL 聚合常购商品/品类偏好/到店时段/价格带/流失前兆，Ollama 开启时额外生成一人一段人话画像（数据不出店）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.member.portrait.enabled');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.member.portrait.top', '画像生成会员数上限', '30'::jsonb, '30'::jsonb, 'number',
       '单次生成按近 180 天消费额取 TOP N 位会员（大模型逐人生成耗时，防阻塞）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.member.portrait.top');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.forecast.location_factor', '门店/商圈客流系数', '1'::jsonb, '1'::jsonb, 'number',
       '多因子预测地点因子：>1 上调预测（如社区密集/临街），<1 下调（如位置偏僻）；直接乘在预测基线上'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.forecast.location_factor');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI赋能', 'ai.forecast.weather_weight', '天气影响权重', '0.3'::jsonb, '0.3'::jsonb, 'number',
       '多因子预测天气权重 w：预测量 = 基线 × (1−w + w×天气客流系数)；0=不参与，1=完全跟随天气'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.forecast.weather_weight');
