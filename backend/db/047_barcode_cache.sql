-- V4.9.12 条码数据升级：①纠错回写缓存表（建档保存回写人工确认数据，优先级压过在线源）
--                  ②爬虫互补补库（仅当全部数据源未命中时低频抓必应结果标题，结果标 crawler 待核对）
-- 幂等迁移

-- 1) 条码缓存表：manual=true = 店内人工确认（建档保存/修正时回写），source ∈ manual/crawler/mxnzp/off
CREATE TABLE IF NOT EXISTS barcode_cache (
  id            BIGSERIAL PRIMARY KEY,
  barcode       VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(200) NOT NULL DEFAULT '',
  spec          VARCHAR(100) NOT NULL DEFAULT '',
  unit          VARCHAR(20)  NOT NULL DEFAULT '',
  price         NUMERIC(12,2),
  brand         VARCHAR(100) NOT NULL DEFAULT '',
  source        VARCHAR(20)  NOT NULL DEFAULT 'manual',
  manual        BOOLEAN      NOT NULL DEFAULT FALSE,
  hits          INTEGER      NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_barcode_cache_manual ON barcode_cache(barcode) WHERE manual;
CREATE INDEX IF NOT EXISTS idx_barcode_cache_source ON barcode_cache(source, barcode);

COMMENT ON TABLE barcode_cache IS '条码大数据缓存（V4.9.12）：人工纠错回写优先，爬虫结果仅参考待核对';

-- 2) 爬虫开关与限速设置
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '商品与库存', 'barcode.crawler.enable', '条码爬虫补库（必应兜底）', 'true', 'true', 'bool',
       '全部数据源未命中时低频抓取必应中国结果标题补库（限速：码间≥3秒、每日≤上限）；结果标注"参考数据请核对"'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'barcode.crawler.enable');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '商品与库存', 'barcode.crawler.daily_limit', '条码爬虫每日上限', '50', '50', 'number',
       '每日爬虫补库次数上限，防触发反爬与流量滥用；0=禁用爬虫'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'barcode.crawler.daily_limit');
