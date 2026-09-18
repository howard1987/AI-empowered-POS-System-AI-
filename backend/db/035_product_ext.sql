-- ═══ 035 商品扩展字段 + AI 工单孤儿样本回填（V4.9.2） ═══
-- 1) 商品档案新增 批发价 / 会员折扣（主表格新增列，可空）
ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(12,2);   -- 批发价（大客户/团购价）
ALTER TABLE products ADD COLUMN IF NOT EXISTS member_discount  NUMERIC(5,4);   -- 会员折扣（如 0.9000=9折；NULL=无折扣）

-- 2) AI 工单孤儿样本回填：工单制上线前（task_id 尚无该列）手机采集的样本，
--    按「采集时间前 5 分钟内最近一个进行中/已完成的采集任务」归入对应工单，
--    使工单详情能正确显示历史样本（如「宜简饮用纯净水」）。
UPDATE ai_samples s SET task_id = x.tid
FROM (
  SELECT s2.id AS sid, (
    SELECT t2.id FROM ai_tasks t2
     WHERE t2.task_type = '采集'
       AND t2.status IN ('进行中', '已完成')
       AND t2.created_at <= s2.created_at + interval '5 minutes'
     ORDER BY t2.created_at DESC
     LIMIT 1
  ) AS tid
  FROM ai_samples s2
  WHERE s2.task_id IS NULL AND s2.source = '采集任务'
) x
WHERE s.id = x.sid AND x.tid IS NOT NULL;

-- 3) 受影响任务重算 done_count / progress（与样本数保持一致）
UPDATE ai_tasks t
   SET done_count = c.n,
       progress = CASE WHEN COALESCE(t.target_count, 0) > 0
                       THEN LEAST(100, ROUND(c.n * 100.0 / t.target_count))
                       ELSE t.progress END
FROM (
  SELECT task_id, count(*)::int AS n
    FROM ai_samples
   WHERE task_id IS NOT NULL
   GROUP BY task_id
) c
WHERE t.id = c.task_id;
