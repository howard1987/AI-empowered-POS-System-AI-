-- 043_multi_scale_alias.sql
-- V4.11.2 · 方案 v3.2 剩余项落地：M2 多件识别 + M3 电子秤对接 + 别名表
--   1) product_aliases 商品别名表：
--      - 收银/识别链路的"叫法"与档案名解耦：口语别名（如"农夫山泉550"→农夫山泉550ml）
--      - source：手动（店员维护）/ 称重前缀（电子秤 plu 码映射）/ AI训练学习（纠正链路沉淀）
--      - lookupProduct 扫码兜底 + CLIP rerank 文本信号纳入别名（同商品任一叫法命中即可）
--   2) 电子秤设置键：scale.enabled / scale.baud / scale.protocol（大华/顶尖/通用连续帧自动解析）
--   3) 多件识别设置键：ai.multi.enabled（轮廓分割 + 逐件 CLIP 检索，默认开）
--   幂等：可重复执行
-- =====================================================================

CREATE TABLE IF NOT EXISTS product_aliases (
  id          SERIAL PRIMARY KEY,
  store_id    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alias       VARCHAR(200) NOT NULL,
  source      VARCHAR(16) NOT NULL DEFAULT '手动',
  created_by  INTEGER,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_product_alias ON product_aliases (store_id, alias);
CREATE INDEX IF NOT EXISTS idx_product_alias_pid ON product_aliases (product_id);

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
  ('AI 引擎', 'ai.multi.enabled', '多件识别（轮廓分割）', 'true'::jsonb, 'true'::jsonb, 'bool',
   '俯拍多件场景：零训练轮廓分割定位每件商品 → 逐件 Chinese-CLIP 检索 → 按商品聚合计数；单件画面自动回落单件管线'),
  ('AI 引擎', 'ai.multi.min_conf', '多件逐件采信阈值', '0.85'::jsonb, '0.85'::jsonb, 'number',
   '多件 crop 相对样本是"换背景/换构图"复拍，相似度系统性低于全帧复拍，故逐件采信阈值低于全帧 min_conf(0.90)；低于该值不进判定直接回落候选卡片。现场标定后可调'),
  ('收银', 'scale.enabled', '电子秤自动读重', 'true'::jsonb, 'true'::jsonb, 'bool',
   '称重商品（is_weighted）收银时经 Web Serial 从串口电子秤自动读重（大华/顶尖/通用连续帧协议）'),
  ('收银', 'scale.baud', '电子秤波特率', '9600'::jsonb, '9600'::jsonb, 'number',
   '串口波特率，商用电子秤出厂常见 9600'),
  ('收银', 'scale.protocol', '电子秤协议', '"auto"'::jsonb, '"auto"'::jsonb, 'string',
   'auto=自动识别连续帧格式；可选 dahua（大华）/ topping（顶尖）/ generic（ST,GS,±x.xxx kg 通用帧）')
ON CONFLICT (setting_key) DO NOTHING;
