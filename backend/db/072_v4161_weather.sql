-- 072 · V4.16.1 天气因素接入 AI 决策（P10）
-- 原则：幂等（IF NOT EXISTS / ON CONFLICT DO NOTHING）；语句级执行

-- ── 天气缓存表：每日一行（今日+未来 3 天预报），拉取失败时兜底读旧值 ──
CREATE TABLE IF NOT EXISTS weather_cache (
  id              BIGSERIAL PRIMARY KEY,
  store_id        INT NOT NULL DEFAULT 1,
  provider        VARCHAR(32) NOT NULL,                 -- open-meteo / qweather
  city            VARCHAR(64),
  forecast_date   DATE NOT NULL,
  temp_max        NUMERIC(5,1),
  temp_min        NUMERIC(5,1),
  cond_text       VARCHAR(32),                          -- 中文天气：晴/多云/小雨…
  cond_code       INT,                                  -- WMO weather code（open-meteo）
  precip_mm       NUMERIC(8,1),                         -- 降水量 mm
  wind_max        NUMERIC(6,1),                         -- 最大风速 km/h
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, forecast_date)
);

-- ── 设置种子（开关 / 城市 / 数据源与和风凭据 / 天气自动备货建议） ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('AI赋能','ai.weather.enabled','天气因素接入','true','true','bool','开启后自动拉取本地天气预报：决策中心天气卡 + 天气备货建议 + 语音天气问答；拉取失败自动降级用缓存旧值，不阻塞任何业务'),
('AI赋能','ai.weather.city','天气城市','"北京"','"北京"','string','填写门店所在城市名（如：北京/上海/杭州），系统自动换算经纬度；请改成门店实际所在城市'),
('AI赋能','ai.weather.qweather_key','和风天气 Key','""','""','string','可选：填入和风天气（qweather.com）免费 Key 后切换和风为主源（国内精度更高）；留空使用 Open-Meteo（免注册免 Key）'),
('AI赋能','ai.weather.qweather_host','和风 API Host','"https://devapi.qweather.com"','"https://devapi.qweather.com"','string','和风天气 API Host（新账号为专属 Host，见和风控制台）；仅在填写 Key 后生效'),
('AI赋能','ai.weather.auto_factor','天气自动备货建议','true','true','bool','开启后每日全量刷新自动生成天气备货建议：雨天客流↓、高温冷饮↑、骤冷速冻火锅↑；只做增量建议，下单权在人')
ON CONFLICT (setting_key) DO NOTHING;
