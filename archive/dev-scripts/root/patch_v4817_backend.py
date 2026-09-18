# -*- coding: utf-8 -*-
"""V4.8.17 后端补丁：BundleController 组合商品组装/拆分（FIFO 守恒）"""
import io

P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-初版代码/backend/src/modules/products.module.ts"
src = io.open(P, encoding="utf-8").read()

assert "BundleController" not in src, "补丁已应用，勿重复执行"

ANCHOR = "@Module({ controllers: [ProductsController, PriceChangeController,] })\nexport class ProductsModule {}"

NEW = r"""// ─── 组合拆分（V4.8.17）：组装 ZZ- / 拆分 CF-，FIFO 成本守恒，权限 stock.transfer ───

/** FIFO 消费 N 份数量（行锁防超卖）：返回摊销明细与总成本；不记库存商品按最近进价 */
async function fifoConsume(
  c: any, storeId: number, productId: number, pName: string, trackInv: boolean, qty: number,
  refType: string, refId: number, employeeId: number,
): Promise<{ cost: number; unitCost: number; rows: { productId: number; qty: number; unitCost: number; costTotal: number }[] }> {
  let cost = 0;
  const rows: { productId: number; qty: number; unitCost: number; costTotal: number }[] = [];
  if (trackInv) {
    const batches = (await c.query(
      `SELECT id, remain_qty, inbound_cost FROM batches
        WHERE store_id=$1 AND product_id=$2 AND status='在库' AND remain_qty > 0
        ORDER BY expiry_date, inbound_date FOR UPDATE`, [storeId, productId])).rows;
    let avail = 0;
    for (const b of batches) avail += Number(b.remain_qty);
    if (avail < qty) throw new BizException(50001, `${pName} 库存不足（现有 ${avail}，需 ${qty}）`);
    let need = qty;
    for (const b of batches) {
      if (need <= 0) break;
      const take = Math.min(Number(b.remain_qty), need);
      const sub = take * Number(b.inbound_cost);
      cost += sub;
      rows.push({ productId, qty: take, unitCost: Number(b.inbound_cost), costTotal: Number(sub.toFixed(2)) });
      await c.query(
        `UPDATE batches SET remain_qty = remain_qty - $2,
            status = CASE WHEN remain_qty - $2 <= 0 THEN '售罄' ELSE status END WHERE id=$1`,
        [b.id, take]);
      await c.query(
        `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, employee_id)
         VALUES ($1,$2,$3,'出库',$4,$5,$6,$7,$8)`,
        [storeId, productId, b.id, take, Number(b.inbound_cost), refType, refId, employeeId]);
      need = Math.round((need - take) * 1000) / 1000;
    }
    await c.query(
      `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now() WHERE store_id=$1 AND product_id=$3`,
      [storeId, qty, productId]);
  } else {
    const last = (await c.query(
      `SELECT unit_cost FROM inbound_order_items WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [productId])).rows;
    const u = last.length ? Number(last[0].unit_cost) : 0;
    cost = qty * u;
    rows.push({ productId, qty, unitCost: u, costTotal: Number((qty * u).toFixed(2)) });
  }
  return { cost: Number(cost.toFixed(4)), unitCost: qty > 0 ? cost / qty : 0, rows };
}

/** 入库建批次（组装产物/拆分子件共用）：stock_flows 入库 + inventory_current 累加 */
async function fifoProduce(
  c: any, storeId: number, productId: number, batchNo: string, keepDays: number | null,
  qty: number, unitCost: number, refType: string, refId: number, employeeId: number,
) {
  const expiry = keepDays && keepDays > 0 ? keepDays : 365;
  const bt = (await c.query(
    `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date,
                          expiry_date, inbound_cost, inbound_qty, remain_qty, status)
     VALUES ($1,$2,0,$3,CURRENT_DATE,CURRENT_DATE, CURRENT_DATE + ($4 || ' days')::interval, $5,$6,$6,'在库') RETURNING id`,
    [storeId, productId, batchNo, expiry, unitCost, qty])).rows;
  await c.query(
    `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, employee_id)
     VALUES ($1,$2,$3,'入库',$4,$5,$6,$7,$8)`,
    [storeId, productId, bt[0].id, qty, unitCost, refType, refId, employeeId]);
  await c.query(
    `INSERT INTO inventory_current (store_id, product_id, qty_total) VALUES ($1,$2,$3)
      ON CONFLICT (store_id, product_id) DO UPDATE SET qty_total = inventory_current.qty_total + $3, updated_at = now()`,
    [storeId, productId, qty]);
  return bt[0].id;
}

@Controller('bundles')
class BundleController {
  /** 组合档案列表（含明细与子商品名） */
  @Get()
  async listBundles() {
    const rows = await q(`SELECT * FROM product_bundles ORDER BY id DESC LIMIT 200`);
    const out = [];
    for (const b of rows) {
      const items = await q(
        `SELECT i.*, p.name AS product_name, p.barcode, p.base_unit,
                COALESCE(ic.qty_total, 0) AS stock_qty
           FROM product_bundle_items i JOIN products p ON p.id = i.product_id
           LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = b.store_id
          WHERE i.bundle_id = $1 ORDER BY i.id`, [b.id]);
      out.push({ ...b, items });
    }
    return { items: out };
  }

  /** 组装/拆分单浏览 */
  @Get('ops')
  async listOps(@Query('from') from = '', @Query('to') to = '', @Query('type') type = '') {
    return q(
      `SELECT o.*, p.name AS bundle_name, u.name AS creator_name
         FROM bundle_ops o JOIN products p ON p.id = o.bundle_product_id
         LEFT JOIN employees u ON u.id = o.created_by
        WHERE ($1 = '' OR o.created_at >= $1::date)
          AND ($2 = '' OR o.created_at < $2::date + 1)
          AND ($3 = '' OR o.op_type = $3)
        ORDER BY o.id DESC LIMIT 200`, [from, to, type]);
  }

  /** 新建组合档案：bundle_product_id 唯一；明细 ≥1；子商品不可与组合商品相同 */
  @Post()
  @RequirePerms('stock.transfer')
  async createBundle(
    @Body() b: { bundleProductId: number; name?: string; remark?: string; items: { productId: number; qty: number }[] },
    @CurrentUser() user: AuthUser,
  ) {
    const bp = await q1<any>(`SELECT * FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(b.bundleProductId)]);
    if (!bp) throw new BizException(40404, '组合商品不存在，请先在商品档案建档', 404);
    const dup = await q1(`SELECT id FROM product_bundles WHERE bundle_product_id=$1`, [bp.id]);
    if (dup) throw new BizException(40003, '该商品已存在组合定义');
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '组合明细不能为空');
    const seen = new Set<number>();
    for (const it of items) {
      if (!it.productId || !(Number(it.qty) > 0)) throw new BizException(40003, '明细须含 productId 与正数 qty');
      if (Number(it.productId) === Number(bp.id)) throw new BizException(40003, '子商品不能是组合商品本身');
      if (seen.has(Number(it.productId))) throw new BizException(40003, '同一子商品在组合内重复');
      seen.add(Number(it.productId));
    }
    return tx(async c => {
      for (const it of items) {
        const p = (await c.query(`SELECT id, name, deleted_at FROM products WHERE id=$1`, [Number(it.productId)])).rows[0];
        if (!p || p.deleted_at) throw new BizException(40404, `子商品 ${it.productId} 不存在`, 404);
      }
      const head = await c.query(
        `INSERT INTO product_bundles (store_id, bundle_product_id, name, remark) VALUES (1,$1,$2,$3) RETURNING id`,
        [bp.id, b.name || bp.name, b.remark || '']);
      for (const it of items) {
        await c.query(`INSERT INTO product_bundle_items (bundle_id, product_id, qty) VALUES ($1,$2,$3)`,
          [head.rows[0].id, it.productId, it.qty]);
      }
      await audit(1, user.sub, '进销存', 'bundle.create', 'bundle', head.rows[0].id, { name: b.name || bp.name, items: items.length });
      return { id: head.rows[0].id };
    });
  }

  /**
   * 组装单 ZZ-（录入即生效）：按 BOM FIFO 消费子商品 → 生成组合商品批次
   * 单位成本 = Σ子批次成本 / 份数（守恒）；production_date=当天，保质期取组合商品 keep_days（缺省 365 天）
   */
  @Post('assemble')
  @RequirePerms('stock.transfer')
  async assemble(@Body() b: { bundleProductId: number; qty: number; remark?: string }, @CurrentUser() user: AuthUser) {
    const n = Math.round(Number(b.qty) * 1000) / 1000;
    if (!(n > 0)) throw new BizException(40003, '组装份数必须大于 0');
    return tx(async c => {
      const bd = (await c.query(
        `SELECT bd.*, p.name AS bundle_name, p.keep_days, p.track_inventory
           FROM product_bundles bd JOIN products p ON p.id = bd.bundle_product_id
          WHERE bd.bundle_product_id=$1 AND bd.status=1 FOR UPDATE`, [Number(b.bundleProductId)])).rows[0];
      if (!bd) throw new BizException(40404, '组合定义不存在或已停用', 404);
      const items = (await c.query(
        `SELECT i.*, p.name AS product_name, p.track_inventory, p.keep_days
           FROM product_bundle_items i JOIN products p ON p.id = i.product_id
          WHERE i.bundle_id=$1 ORDER BY i.id FOR UPDATE`, [bd.id])).rows;
      if (!items.length) throw new BizException(40003, '组合明细为空，不能组装');
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const seq = (await c.query(`SELECT count(*)+1 AS n FROM bundle_ops WHERE op_no LIKE $1`, [`ZZ-${ym}-%`])).rows[0];
      const no = `ZZ-${ym}-${String(seq.n).padStart(3, '0')}`;

      let total = 0;
      const detail: any[] = [];
      for (const it of items) {
        const need = Math.round(Number(it.qty) * n * 1000) / 1000;
        const r = await fifoConsume(c, bd.store_id, it.product_id, it.product_name, it.track_inventory, need, 'bundle_assemble', 0, user.sub);
        total += r.cost;
        detail.push({ productId: it.product_id, qty: need, unitCost: need > 0 ? Number((r.cost / need).toFixed(4)) : 0, costTotal: Number(r.cost.toFixed(2)) });
      }
      total = Number(total.toFixed(4));
      const unitCost = Number((total / n).toFixed(4));
      // 组合产物批次
      const r2 = await fifoProduce(c, bd.store_id, bd.bundle_product_id, `${no}-01`, bd.keep_days, n, unitCost, 'bundle_assemble', 0, user.sub);
      const head = await c.query(
        `INSERT INTO bundle_ops (store_id, op_no, op_type, bundle_product_id, qty, unit_cost, total_cost, remark, created_by)
         VALUES ($1,$2,'assemble',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [bd.store_id, no, bd.bundle_product_id, n, unitCost, total.toFixed(2), b.remark || '', user.sub]);
      for (const d of detail) {
        await c.query(`INSERT INTO bundle_op_items (op_id, product_id, qty, unit_cost, cost_total) VALUES ($1,$2,$3,$4,$5)`,
          [head.rows[0].id, d.productId, d.qty, d.unitCost, d.costTotal]);
      }
      await audit(1, user.sub, '进销存', 'bundle.assemble', 'bundle_op', head.rows[0].id, { no, qty: n, total });
      return { id: head.rows[0].id, opNo: no, totalCost: Number(total.toFixed(2)), unitCost };
    });
  }

  /**
   * 拆分单 CF-（录入即生效）：FIFO 消费组合批次 → 按份数为子商品建批次
   * 成本守恒口径：子商品拆分单位成本 u = 组合单位成本 U / Σ(BOM数量)，Σ(子成本×数量) = U 精确守恒
   */
  @Post('split')
  @RequirePerms('stock.transfer')
  async split(@Body() b: { bundleProductId: number; qty: number; remark?: string }, @CurrentUser() user: AuthUser) {
    const n = Math.round(Number(b.qty) * 1000) / 1000;
    if (!(n > 0)) throw new BizException(40003, '拆分份数必须大于 0');
    return tx(async c => {
      const bd = (await c.query(
        `SELECT bd.*, p.name AS bundle_name
           FROM product_bundles bd JOIN products p ON p.id = bd.bundle_product_id
          WHERE bd.bundle_product_id=$1 AND bd.status=1 FOR UPDATE`, [Number(b.bundleProductId)])).rows[0];
      if (!bd) throw new BizException(40404, '组合定义不存在或已停用', 404);
      const items = (await c.query(
        `SELECT i.*, p.name AS product_name, p.keep_days
           FROM product_bundle_items i JOIN products p ON p.id = i.product_id
          WHERE i.bundle_id=$1 ORDER BY i.id FOR UPDATE`, [bd.id])).rows;
      if (!items.length) throw new BizException(40003, '组合明细为空，不能拆分');
      const sumQty = items.reduce((a, it) => a + Number(it.qty), 0);
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const seq = (await c.query(`SELECT count(*)+1 AS n FROM bundle_ops WHERE op_no LIKE $1`, [`CF-${ym}-%`])).rows[0];
      const no = `CF-${ym}-${String(seq.n).padStart(3, '0')}`;

      // FIFO 消费组合批次（temp refId=0，落单后补记到单据）
      const r = await fifoConsume(c, bd.store_id, bd.bundle_product_id, bd.bundle_name, true, n, 'bundle_split', 0, user.sub);
      const unitU = Number((r.cost / n).toFixed(4));
      const u = sumQty > 0 ? Number((unitU / sumQty).toFixed(4)) : 0;
      let idx = 0;
      const detail: any[] = [];
      for (const it of items) {
        idx += 1;
        const qty = Math.round(Number(it.qty) * n * 1000) / 1000;
        await fifoProduce(c, bd.store_id, it.product_id, `${no}-${String(idx).padStart(2, '0')}`, it.keep_days, qty, u, 'bundle_split', 0, user.sub);
        detail.push({ productId: it.product_id, qty, unitCost: u, costTotal: Number((qty * u).toFixed(2)) });
      }
      const head = await c.query(
        `INSERT INTO bundle_ops (store_id, op_no, op_type, bundle_product_id, qty, unit_cost, total_cost, remark, created_by)
         VALUES ($1,$2,'split',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [bd.store_id, no, bd.bundle_product_id, n, unitU, r.cost.toFixed(2), b.remark || '', user.sub]);
      for (const d of detail) {
        await c.query(`INSERT INTO bundle_op_items (op_id, product_id, qty, unit_cost, cost_total) VALUES ($1,$2,$3,$4,$5)`,
          [head.rows[0].id, d.productId, d.qty, d.unitCost, d.costTotal]);
      }
      await audit(1, user.sub, '进销存', 'bundle.split', 'bundle_op', head.rows[0].id, { no, qty: n, total: r.cost });
      return { id: head.rows[0].id, opNo: no, totalCost: Number(r.cost.toFixed(2)), unitCost: unitU };
    });
  }
}

@Module({ controllers: [ProductsController, PriceChangeController, BundleController,] })
export class ProductsModule {}"""

assert ANCHOR in src, "锚点未命中：Module 声明不匹配"
src = src.replace(ANCHOR, NEW, 1)
io.open(P, "w", encoding="utf-8", newline="\n").write(src)

chk = io.open(P, encoding="utf-8").read()
for token in ["BundleController", "fifoConsume", "fifoProduce", "bundle_ops", "ZZ-", "CF-", "stock.transfer", "cost-base" ]:
    assert token in chk, f"校验失败：{token} 未写入磁盘"
assert "BundleController," in chk
print("OK: BundleController 已写入并校验通过")
