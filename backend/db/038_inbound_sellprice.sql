-- V4.9.5 ① 入库明细记录售价（入库时调整售价 → 审核后自动更新商品档案最新售价；历史单据价格不受影响）
ALTER TABLE inbound_order_items ADD COLUMN IF NOT EXISTS sell_price numeric(12,2);
-- V4.9.5 ② 记录入库前的档案原售价（审核后单据若作废 → 售价回退，"改价无效"）
ALTER TABLE inbound_order_items ADD COLUMN IF NOT EXISTS prev_sell_price numeric(12,2);
-- V4.9.5 ③ 退货凭证移动端拍摄指令时间（PC 端派单 → 同账号移动端消息页置顶提醒）
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS evidence_requested_at timestamptz;
