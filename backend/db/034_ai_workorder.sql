-- 034: AI 采集/训练任务工单化（V4.9.1）
--   1) ai_tasks 增加工单号 task_no：采集=AICJ+YYYYMMDD+4位序号 / 训练=AIXL… / 评估=AIPG…
--   2) ai_samples 增加 task_id 关联工单：审核以工单为单位（店长预检 合格/回退 → 审核通过）
--   幂等：可重复执行

ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS task_no VARCHAR(24);
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS review_result VARCHAR(8);      -- NULL=未审核 / '合格' / '回退'
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS review_remark VARCHAR(128);
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_tasks_no ON ai_tasks (task_no) WHERE task_no IS NOT NULL;

ALTER TABLE ai_samples ADD COLUMN IF NOT EXISTS task_id BIGINT REFERENCES ai_tasks(id);
CREATE INDEX IF NOT EXISTS idx_ai_samples_task ON ai_samples (task_id);

-- 回填存量任务工单号（按类型×日期分日序号）
UPDATE ai_tasks t SET task_no = n.no FROM (
  SELECT id,
    CASE task_type::text WHEN '采集' THEN 'AICJ' WHEN '训练' THEN 'AIXL' ELSE 'AIPG' END
      || to_char(created_at, 'YYYYMMDD')
      || lpad((row_number() OVER (PARTITION BY task_type::text, created_at::date ORDER BY id))::text, 4, '0') AS no
  FROM ai_tasks WHERE task_no IS NULL
) n WHERE t.id = n.id;
