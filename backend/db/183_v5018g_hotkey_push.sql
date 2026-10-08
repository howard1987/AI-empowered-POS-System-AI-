-- V5.0.18g 快捷键下发式重置 + AI 设置项归组清理（用户拍板）
-- 1) 候选展示阈值并入「AI管理」组（不另设设置页）
UPDATE system_settings SET group_name='AI管理' WHERE setting_key IN ('ai.emb.pp.cand_min_conf','ai.emb.cand_min_conf');
-- 2) 候选卡片排序已改为纯置信度降序（V5.0.18g），频率权重不再参与排序 → 清理失效项
DELETE FROM system_settings WHERE setting_key='ai.rerank.freq_weight';
-- 3) 快捷键重置改「下发式」（连锁管理方式）：后台显式下发重置指令（全部或指定收银机），
--    收银机轮询设置时收到指令才清本机自定义；后台仅修改键位值不再触发全员重置。
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('pos.cashier.hotkey_reset', '设备管理', '快捷键重置下发', '{"seq":0,"devices":""}', '{"seq":0,"devices":""}', 'json',
  '系统自动维护：seq=下发序号（每次下发 +1）；devices=目标收银机设备码（逗号分隔，空=全部）。收银机收到比自己已处理序号更大且指向自己的指令后，清空本机自定义并恢复为「快捷键映射」兜底键位。后台「快捷键映射」编辑器的「下发重置」按钮写入。')
ON CONFLICT (setting_key) DO NOTHING;
-- 4) hotkey_map 语义更新：仅兜底值，修改值本身不再触发重置（重置走显式下发）
UPDATE system_settings SET remark='收银台快捷键兜底键位：仅作为新收银机的初始键位。各收银机可在收银台「设置 → 快捷键自定义（本机）」自行修改并存本机，互不影响；修改/保存本项<b>不会</b>重置已自定义的收银机——需重置时用下方「下发重置到收银机」按钮（全部或指定设备码）。'
 WHERE setting_key='pos.cashier.hotkey_map';
