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
 */
import { cx } from '../common/db';

export interface BatchAlloc { batchId: number; qty: number; cost: number }

export async function consumeBatches(c: any, o: {
  storeId: number; productId: number; saleItemId: number; orderId: number;
  allocs: BatchAlloc[]; employeeId: number;
}): Promise<void> {
  const { storeId, productId, saleItemId, orderId, allocs, employeeId } = o;
  for (const a of allocs) {
    await cx(c, `INSERT INTO sale_item_batches (sale_item_id, batch_id, qty, unit_cost) VALUES ($1,$2,$3,$4)`,
      [saleItemId, a.batchId, a.qty, a.cost]);
    await cx(c,
      `UPDATE batches SET remain_qty = remain_qty - $2,
          status = CASE WHEN remain_qty - $2 <= 0 THEN '售罄' ELSE status END
        WHERE id=$1`, [a.batchId, a.qty]);
    await cx(c,
      `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
       VALUES ($1,$2,$3,'出库',$4,$5,'sale',$6,$7,$8)`,
      [storeId, productId, a.batchId, a.qty, a.cost, orderId, saleItemId, employeeId]);
  }
}
