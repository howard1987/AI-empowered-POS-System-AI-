-- V5.0.14 分红「零发放次日失效」规则落地
--   规则：当日计提金额无任何成功发放（无符合资格会员/全员封顶 → 零发放）时，
--   该笔计提次日自动失效，不再进入分红池；计提明细记「失效」记录并注明失效原因。
--   ① 失效记录是「整期级」，没有具体会员 → dividend_records.member_id 放开为可空
ALTER TABLE dividend_records ALTER COLUMN member_id DROP NOT NULL;
--   ② record_type 枚举新增「失效」（既有：计提/抵扣/调整/失效回冲——「失效回冲」是
--      30 天未消费的会员级回冲，与本期新增的「整期零发放失效」语义不同，不混用）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'dividend_record_t' AND e.enumlabel = '失效'
  ) THEN
    ALTER TYPE dividend_record_t ADD VALUE '失效';
  END IF;
END $$;
