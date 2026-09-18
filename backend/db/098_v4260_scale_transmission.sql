-- 044_scale_transmission.sql
-- V4.26.0 · 集成传秤小工具：条码秤/标签秤 PLU 下发
--   1) products 扩展秤相关字段：秤内码、是否传秤、热键、部门号
--   2) scale_transmission_logs 下发记录与逐行结果
--   3) system_settings 默认配置（协议/串口/波特率/部门号）
--   幂等：可重复执行
-- =====================================================================

-- products 扩展字段
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS scale_plu_code   VARCHAR(32),   -- 秤内码/PLU（通常 4~7 位）
  ADD COLUMN IF NOT EXISTS scale_enabled    BOOLEAN NOT NULL DEFAULT false, -- 是否参与传秤
  ADD COLUMN IF NOT EXISTS scale_hotkey     VARCHAR(8),    -- 秤热键编号（可选）
  ADD COLUMN IF NOT EXISTS scale_department VARCHAR(8) DEFAULT '01'; -- 部门号

CREATE INDEX IF NOT EXISTS idx_prod_scale ON products (store_id, scale_enabled) WHERE scale_enabled = true;

-- 传秤任务/日志
CREATE TABLE IF NOT EXISTS scale_transmission_logs (
  id            BIGSERIAL PRIMARY KEY,
  store_id      BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  employee_id   BIGINT REFERENCES employees(id),
  task_no       VARCHAR(32) NOT NULL,                      -- 任务流水号
  protocol      VARCHAR(32) NOT NULL,                     -- 使用协议
  port_type     VARCHAR(16) NOT NULL DEFAULT 'serial',     -- serial / tcp
  port_path     VARCHAR(64),                                -- COM3 / 192.168.1.100:9100
  total_count   INTEGER NOT NULL DEFAULT 0,
  ok_count      INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  detail        JSONB DEFAULT '[]'::jsonb,                   -- 逐行结果
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',     -- pending/running/done/failed
  error_msg     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_scale_log_task ON scale_transmission_logs (store_id, task_no);
CREATE INDEX IF NOT EXISTS idx_scale_log_created ON scale_transmission_logs (store_id, created_at DESC);

-- 系统设置默认值
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
  ('传秤工具', 'scale.tx.protocol', '默认协议', '"dahua"'::jsonb, '"dahua"'::jsonb, 'string',
   'dahua=大华 / topping=顶尖 / digi=寺冈SM300 / mettler=托利多 / cas=凯士 / generic=通用测试'),
  ('传秤工具', 'scale.tx.port_type', '默认连接方式', '"serial"'::jsonb, '"serial"'::jsonb, 'string',
   'serial=串口 / tcp=网口'),
  ('传秤工具', 'scale.tx.port', '默认串口号', '"COM3"'::jsonb, '"COM3"'::jsonb, 'string', '如 COM3 / COM4'),
  ('传秤工具', 'scale.tx.baud', '默认波特率', '9600'::jsonb, '9600'::jsonb, 'number', '常见 9600'),
  ('传秤工具', 'scale.tx.tcp_host', '网口秤 IP', '"192.168.1.100"'::jsonb, '"192.168.1.100"'::jsonb, 'string', '网口秤 IP'),
  ('传秤工具', 'scale.tx.tcp_port', '网口秤端口', '9100'::jsonb, '9100'::jsonb, 'number', '常见 9100'),
  ('传秤工具', 'scale.tx.department', '默认部门号', '"01"'::jsonb, '"01"'::jsonb, 'string', '2位部门号'),
  ('传秤工具', 'scale.tx.barcode_prefix', '生鲜码前缀', '"22"'::jsonb, '"22"'::jsonb, 'string',
   '条码秤打印条码的前两位识别码（FFWWWWW 中的 FF）'),
  ('传秤工具', 'scale.tx.use_member_price', '同步会员价', 'false'::jsonb, 'false'::jsonb, 'bool',
   '是否同时下发会员价（依赖秤型号支持）')
ON CONFLICT (setting_key) DO NOTHING;
