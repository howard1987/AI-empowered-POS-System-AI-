/**
 * 销售批次消耗落账 —— 销售单（sales.module）与大客户团购（bigcustomer.module）共用。
 *
 * 收敛原因（V5.0.6）：两条落单路径原各写一份同样的三条 SQL，任何一处调整（阈值口径、状态枚举、
 * 流水字段）都会让 FIFO 成本与批次余量对不上，且极难发现。
 *
 * 逐行批次占用：
 *   ① sale_item_batches 记录本行占用的批次与成本（FIFO 成本回溯依据）
 *   ② batches 扣减余量，扣到 ≤0 置「售罄」（batch_status_t 无「正常」值，勿改）
 *   ③ stock_flows 记「出库」流水（ref_type='sale'）
 *
 * P-03 批量化：consumeBatchesMany 一次落 N 行（原每 alloc 3 条语句 → 固定 3 条）。
 *   - sale_item_batches / stock_flows 保留逐 alloc 粒度（多值 INSERT）；
 *   - batches 扣减按「同批次聚合净扣减量」一条 UPDATE（UPDATE..FROM 同 id 只命中一次，
 *     必须先聚合；末态等价：售罄判定只看最终余量）。
 *   金额/数量口径与原逐条版本一致；单行入口 consumeBatches 保留为委托（兼容团购路径）。
 */
import { cx } from '../common/db';
import { aggregateBatchDeductions } from './sales.pure';

export interface BatchAlloc { batchId: number; qty: number; cost: number }

export interface ConsumeRow {
  storeId: number; productId: number; saleItemId: number; orderId: number;
  allocs: BatchAlloc[]; employeeId: number;
}

/** 批量落账（P-03）：N 行 × M alloc → 恒 3 条语句 */
export async function consumeBatchesMany(c: any, rows: ConsumeRow[]): Promise<void> {
  const flat = rows.flatMap(r => r.allocs.map(a => ({ r, a })));
  if (!flat.length) return;

  // ① sale_item_batches：逐 alloc 粒度多值插入
  await cx(c,
    `INSERT INTO sale_item_batches (sale_item_id, batch_id, qty, unit_cost)
     SELECT u.sid, u.bid, u.qty, u.cost
       FROM unnest($1::bigint[], $2::bigint[], $3::numeric[], $4::numeric[]) AS u(sid, bid, qty, cost)`,
    [flat.map(x => x.r.saleItemId), flat.map(x => x.a.batchId), flat.map(x => x.a.qty), flat.map(x => x.a.cost)]);

  // ② batches：同批次聚合净扣减量（售罄判定与逐条顺序扣减末态等价）
  const agg = aggregateBatchDeductions(flat.map(x => x.a));
  await cx(c,
    `UPDATE batches b
        SET remain_qty = b.remain_qty - v.qty,
            status = CASE WHEN b.remain_qty - v.qty <= 0 THEN '售罄' ELSE b.status END
       FROM unnest($1::bigint[], $2::numeric[]) AS v(bid, qty)
      WHERE b.id = v.bid`,
    [agg.map(x => x.batchId), agg.map(x => x.qty)]);

  // ③ stock_flows：逐 alloc 粒度出库流水
  await cx(c,
    `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
     SELECT u.sid, u.pid, u.bid, '出库', u.qty, u.cost, 'sale', u.oid, u.iid, u.eid
       FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::numeric[], $5::numeric[],
                   $6::bigint[], $7::bigint[], $8::bigint[]) AS u(sid, pid, bid, qty, cost, oid, iid, eid)`,
    [flat.map(x => x.r.storeId), flat.map(x => x.r.productId), flat.map(x => x.a.batchId),
     flat.map(x => x.a.qty), flat.map(x => x.a.cost),
     flat.map(x => x.r.orderId), flat.map(x => x.r.saleItemId), flat.map(x => x.r.employeeId)]);
}

/** 单行落账（兼容团购路径）：委托批量版 */
export async function consumeBatches(c: any, o: ConsumeRow): Promise<void> {
  await consumeBatchesMany(c, [o]);
}
