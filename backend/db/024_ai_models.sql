-- M1 · AI 模型管理：本地大模型接入模式/手动路径设置项（幂等种子，重启自动执行）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI与设备','ai.llm.mode','大模型接入模式','"auto"','"auto"','string','auto=自动探测 / manual=手动路径 / none=未接入（规则引擎兜底）'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.llm.mode');

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT 'AI与设备','ai.llm.path','Ollama 安装/数据路径','null','null','string','手动识别时填写（可含 models/manifests），留空则仅按服务地址探测'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.llm.path');
