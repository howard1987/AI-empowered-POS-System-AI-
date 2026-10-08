-- V5.0.18：补注册「代码在用但设置页无入口」的隐形配置（audit-ghost-keys.mjs 核查结果）
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。

-- 1) PP-ShiTu 引擎阈值组（V5.0.13 引入引擎分组时漏注册，代码 ai.emb.ts 一直按代码内默认值运行）：
--    两引擎量纲完全不同（PP 跨商品相似度约 -0.05~0.08，CLIP 约 0.9+），必须独立成组可调。
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('ai.emb.pp.min_conf', 'AI识别', '自动采信阈值(PP-ShiTu)', '0.15', '0.15', 'number',
  'PP-ShiTu 引擎的 Top-1 相似度自动命中线（PP 空间量纲与 CLIP 完全不同，勿与 ai.emb.min_conf 混用）')
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('ai.emb.pp.strict_conf', 'AI识别', '高置信快速通道(PP-ShiTu)', '0.55', '0.55', 'number',
  'PP-ShiTu 引擎的近乎样本复拍快速命中线（无需边距直接命中）')
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('ai.emb.pp.margin', 'AI识别', 'Top1-Top2 边距(PP-ShiTu)', '0.12', '0.12', 'number',
  'PP-ShiTu 引擎的 Top1 领先 Top2 的最小差值，不足则转候选卡片')
ON CONFLICT (setting_key) DO NOTHING;

-- 2) 连锁跨店单日入向限额（member-chain.module.ts 防凭空造币 审计F-02，代码默认 20000 元，从未有配置入口）
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('hq.member.cross_daily_limit', '连锁管理', '跨店单日回补限额(元)', '20000', '20000', 'number',
  '单节点单日「退款/回补」入向总额上限，防会员资产被凭空增发（审计 F-02）。0=不限制（不建议）')
ON CONFLICT (setting_key) DO NOTHING;