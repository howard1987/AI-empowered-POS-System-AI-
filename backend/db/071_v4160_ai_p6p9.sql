-- 071 · V4.16.0 AI 路线 P6~P9（识别增强 / 决策自动化 / 销售预测联动 / 问答对账语音）
-- 原则：幂等（IF NOT EXISTS / ON CONFLICT）；新增枚举值先 ADD VALUE 再使用（本文件语句级执行，无同事务使用）

-- ── P7 决策自动化：建议表增加自动执行与回滚留痕 ──
ALTER TABLE ai_suggestions ADD COLUMN IF NOT EXISTS auto_executed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ai_suggestions ADD COLUMN IF NOT EXISTS rollback_json JSONB;
ALTER TABLE ai_suggestions ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;

-- ── P8 节假日备货：建议域新增「备货」 ──
ALTER TYPE suggestion_domain_t ADD VALUE IF NOT EXISTS '备货';

-- ── 设置种子（P6 rerank 权重 / P7 三档开关与成熟度门槛 / P8 备货提前天数） ──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('AI赋能','ai.rerank.text_weight','识别 rerank 文本权重','0.1','0.1','number','图文对齐信号对候选排序的最大拉动（0~0.3，越大越信瓶身文字）'),
('AI赋能','ai.rerank.freq_weight','候选卡片频率权重','0.03','0.03','number','近30天销量对候选卡片展示顺序的加成（只影响展示排序，不影响命中判定）'),
('AI赋能','ai.decision.modes','决策自动化三档开关','{"定价":"手动确认","补货":"手动确认"}','{"定价":"手动确认","补货":"手动确认"}','json','两域各自三档：手动确认 / 半自动(生成草稿待确认) / 全自动(成熟度解锁后直接执行+留痕+可回滚)'),
('AI赋能','ai.decision.maturity','决策自动化成熟度门槛','{"minAcceptRate":70,"minWeeks":2,"minDecided":5}','{"minAcceptRate":70,"minWeeks":2,"minDecided":5}','json','解锁全自动条件：近4周采纳率≥minAcceptRate% 且近 minWeeks 周连续达标 且已决策样本≥minDecided 条'),
('AI赋能','ai.holiday.lead_days','节假日备货提前天数','14','14','number','节日/周末备货提醒提前量（生成备货建议清单）'),
('AI赋能','ai.voice.alerts','语音告警播报','true','true','bool','PWA 作业页未读经营告警的语音播报开关（收款播报另由 pos.voice_broadcast 控制）')
ON CONFLICT (setting_key) DO NOTHING;
