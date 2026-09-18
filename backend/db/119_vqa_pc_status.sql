-- VQA-GAP07 补丁：price_changes.status 扩容（'scheduled' 9 字符 > varchar(8)）
ALTER TABLE price_changes ALTER COLUMN status TYPE varchar(24);
COMMENT ON COLUMN price_changes.status IS 'pending=待审核 scheduled=已排程(未到预约生效日) approved=已生效 voided=已作废';
