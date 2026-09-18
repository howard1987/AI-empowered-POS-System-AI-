-- ═══════════════════════════════════════════════════════════════
-- 021_aibrain.sql（智能决策中心 9.8）：权限点 + 决策参数默认值
--   应用：9 项智能应用（补货/推送/预测/定价/损耗/关联/问答/防损/日报）
--   底座：轻量规则引擎（零依赖）+ 预留 Ollama 本地大模型接口（ai.llm.enabled 默认关）
--   建议一律"辅助决策"：下单权/定价权/发送权在人（5.2.8 边界）
-- ═══════════════════════════════════════════════════════════════

-- 权限点：智能决策中心（查看不设权限，全体登录可见；执行/生成建议需此权限）
INSERT INTO permission_points (code, module, name, risk_level) VALUES
  ('ai.decision', 'AI', '智能决策中心（生成/执行建议）', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='超级管理员'), id FROM permission_points WHERE code='ai.decision'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='店长'), id FROM permission_points WHERE code='ai.decision'
ON CONFLICT DO NOTHING;

-- 决策参数默认值（value_type 与 default_value 对齐；管理员可改）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('AI与设备', 'ai.decision.enabled',      '智能决策中心开关',      'true',  'true',  'bool',   '总开关：关则定时不自动生成建议'),
  ('AI与设备', 'ai.llm.enabled',           '本地大模型(Ollama)开关', 'false', 'false', 'bool',   '预留：开则问答/日报经 Ollama 生成（规则引擎兜底）'),
  ('AI与设备', 'ai.llm.base',              'Ollama 服务地址',       '"http://localhost:11434"', '"http://localhost:11434"', 'string', '仅 ai.llm.enabled=on 时使用'),
  ('AI与设备', 'ai.llm.model',             '问答模型名',            '"qwen2.5:7b"', '"qwen2.5:7b"', 'string', 'Ollama 已拉取的模型 tag'),
  ('AI与设备', 'ai.restock.coverage_days', '补货覆盖天数',          '7',     '7',     'number', '建议补货量覆盖未来 N 天销量'),
  ('AI与设备', 'ai.restock.safety_days',   '安全库存系数(天)',      '1.5',   '1.5',   'number', '安全库存 = 日均销 × 系数'),
  ('AI与设备', 'ai.forecast.history_days', '销量预测历史窗口(天)',  '90',    '90',    'number', '预测模型回看窗口'),
  ('AI与设备', 'ai.assoc.min_conf',        '关联规则最低置信度',    '0.2',   '0.2',   'number', '购物篮规则过滤阈值（0-1）'),
  ('AI与设备', 'ai.fraud.window_days',     '防损基线窗口(天)',      '30',    '30',    'number', '收银行为基线统计窗口'),
  ('AI与设备', 'ai.restock.time',          '补货建议生成时刻',      '"06:00"', '"06:00"', 'string', '每日定时（HH:MM，进程内检查）'),
  ('AI与设备', 'ai.daily_report.time',     'AI 日报生成时刻',       '"23:59"', '"23:59"', 'string', '每日定时（HH:MM）')
ON CONFLICT (setting_key) DO NOTHING;
