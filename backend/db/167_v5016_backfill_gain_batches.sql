-- V5.0.16：修复历史遗留的「无批次盘盈」——把 stock_flows 中 batch_id IS NULL 的盘盈/调整入库补建批次
--   背景：旧实现的盘盈只写 inventory_current 与 batch_id=NULL 的流水，而 FIFO 出库只扫 batches 表
--         → 这些数量永远无法被销售消耗，造成「账面有货但卖不出 / 库存对不上」的长期漂移。
--   本迁移为每条历史无批次盘盈流水补建一个批次（成本沿用原流水 unit_cost，无则 0；到期日按 +365 天兜底），
--   并回填 stock_flows.batch_id。注意 inventory_current 已含这部分数量，本迁移只补批次维度，不重复加库存。
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。
INSERT INTO batches (store_id, product_id, supplier_id, inbound_order_id, batch_no, inbound_date,
                      production_date, expiry_date, inbound_cost, inbound_qty, remain_qty, status)
SELECT f.store_id, f.product_id, COALESCE(p.supplier_default_id, 0), NULL,
       'FIX-' || to_char(f.created_at, 'YYYYMMDD') || '-' || f.id::text,
       f.created_at::date, f.created_at::date, (f.created_at::date + 365),
       COALESCE(f.unit_cost, 0), f.qty, f.qty, '在库'
  FROM stock_flows f
  JOIN products p ON p.id = f.product_id
 WHERE f.batch_id IS NULL
   AND f.direction = '入库'
   AND f.ref_type IN ('count', 'adjust');

UPDATE stock_flows f
   SET batch_id = b.id
  FROM batches b
 WHERE f.batch_id IS NULL
   AND f.direction = '入库'
   AND f.ref_type IN ('count', 'adjust')
   AND b.batch_no = 'FIX-' || to_char(f.created_at, 'YYYYMMDD') || '-' || f.id::text;