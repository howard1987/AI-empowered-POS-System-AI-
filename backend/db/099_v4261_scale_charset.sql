-- 099_v4261_scale_charset.sql
-- V4.26.1 · 传秤小工具：网口 TCP 传秤 + 中文化秤名编码
--   1) 新增秤端编码设置 scale.tx.charset
--      - gbk    ：中文标签秤通用（推荐，2 字节/汉字）
--      - gb2312 ：老国标，GBK 子集
--      - ascii  ：仅英文/数字，用于不支持中文的老秤
--   2) 说明：中文名由后端 iconv-lite 编码为字节后下发，前端按双字节边界裁剪，不截断汉字
-- 幂等：可重复执行
-- =====================================================================

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
  ('传秤工具', 'scale.tx.charset', '秤端编码', '"gbk"'::jsonb, '"gbk"'::jsonb, 'string',
   'gbk=中文标签秤通用（推荐）/ gb2312=老国标 / ascii=仅英文（不支持中文的秤）')
ON CONFLICT (setting_key) DO NOTHING;
