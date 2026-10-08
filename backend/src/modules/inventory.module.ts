import { Module, Controller, Get, Post, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, r2, r3, r4, audit, seqLock } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { autoAttachSignature } from './sign';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价
import { PRODUCT_VISIBLE } from '../common/sql';       // V5.0.0 商品可售可见性
import { visibleStores, isHqStore, assertStoreAllowed } from '../common/scope'; // V5.0.0 批次6：调拨状态机/范围
import { enqueueSync } from '../common/outbox';   // V4.28.2 P0-5 连锁上行（同事务发件箱）

// ─── Controller（库存中心：即时库存 / 批次溯源 / 临期预警 + P0-3 盘点/报损/调拨，方案 5.4） ───
@Controller('inventory')
class InventoryController {
  private settings = new SettingsService();

  /** 必签校验（5.6.8⑤ 触发场景矩阵可配 auth.sign_required_scenes）：配置含该场景且单据未签字 → 拒绝过审 */
  private async assertSigned(c: any, scene: string, table: string, bizId: number, docNo: string) {
    const scenes = await this.settings.getJson('auth.sign_required_scenes', []);
    if (!Array.isArray(scenes) || !scenes.includes(scene)) return;
    const rows = await cx(c, `SELECT sign_record_id FROM ${table} WHERE id=$1`, [bizId]);
    if (rows.length && !rows[0].sign_record_id) {
      throw new BizException(50018, `${docNo} 尚未电子签字，按"必签才能过审"配置请先在单据列表补签后再审核`);
    }
  }

  /** 即时库存列表（keyword：名称/拼音码/条码/货号/供应商；V4.9.3 增加规格/保质期/最近到期日/供应商列） */
  @Get('summary')
  async summary(
    @Query('keyword') keyword?: string,
    @Query('onlyShort') onlyShort?: string,
    @Query('supplierId') supplierId?: string,
  ) {
    const kw = (keyword || '').trim();
    const rows = await q(
      `SELECT p.id, p.goods_no, p.barcode, p.name, p.spec, p.base_unit, p.min_stock, p.sell_price, p.keep_days,
              COALESCE(ic.qty_total,0) AS qty_total, COALESCE(ic.qty_on_order,0) AS qty_on_order,
              ROUND(COALESCE(ic.qty_total,0) * p.sell_price, 2) AS stock_value,
              (SELECT MIN(b.expiry_date) FROM batches b
                WHERE b.product_id = p.id AND b.status='在库' AND b.remain_qty > 0) AS nearest_expiry,
              (SELECT b.inbound_cost FROM batches b
                WHERE b.product_id = p.id AND b.remain_qty > 0
                ORDER BY b.inbound_date DESC, b.id DESC LIMIT 1) AS last_cost,
              sup.name AS supplier_name,
              CASE WHEN COALESCE(ic.qty_total,0) <= p.min_stock THEN true ELSE false END AS is_low
         FROM products p
         LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = ${curStore()}
         LEFT JOIN suppliers sup ON sup.id = p.supplier_default_id
        WHERE p.deleted_at IS NULL AND p.track_inventory AND ${PRODUCT_VISIBLE(String(curStore()))}
          AND ($1 = '' OR p.name ILIKE '%'||$1||'%' OR p.pinyin_code ILIKE '%'||$1||'%' OR p.barcode=$1
               OR p.goods_no=$1 OR EXISTS (SELECT 1 FROM suppliers s2 WHERE s2.id = p.supplier_default_id AND s2.name ILIKE '%'||$1||'%'))
          AND ($2::boolean IS NULL OR COALESCE(ic.qty_total,0) <= p.min_stock)
          AND ($3::bigint IS NULL OR p.supplier_default_id = $3::bigint)
        ORDER BY is_low DESC, p.id
        LIMIT 500`,
      [kw, onlyShort === '1' ? true : null, supplierId ? Number(supplierId) : null],
    );
    // V4.26.5 按门店隔离价格：库存金额按「本门店售价」估，否则多店口径不一致
    await storePrice.overlay(curStore(), rows);
    for (const r of rows as any[]) {
      r.stock_value = Math.round(Number(r.qty_total) * Number(r.sell_price) * 100) / 100;
    }
    return rows;
  }

  /** V5.0.1 门店报表钻取：低库存/负库存商品明细（mode=low|negative；storeId 仅总部节点可代查，供一键进货/调拨） */
  @Get('abnormal')
  async abnormal(@Query('storeId') storeIdQ?: string, @Query('mode') mode = 'low') {
    const want = Number(storeIdQ) || 0;
    const sid = want && (await isHqStore(curStore())) ? want : curStore();
    const m = mode === 'negative' ? 'negative' : 'low';
    const rows = await q(
      `SELECT p.id AS product_id, p.name, p.barcode, p.spec, p.base_unit, p.min_stock, p.sell_price,
              COALESCE(ic.qty_total,0)::float8 AS qty_total, COALESCE(ic.qty_on_order,0)::float8 AS qty_on_order,
              sup.name AS supplier_name, p.supplier_default_id
         FROM products p
         LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = $1
         LEFT JOIN suppliers sup ON sup.id = p.supplier_default_id
        WHERE p.deleted_at IS NULL AND p.track_inventory
          AND ( ($2 = 'negative' AND COALESCE(ic.qty_total,0) < 0)
             OR ($2 = 'low' AND COALESCE(ic.qty_total,0) >= 0 AND COALESCE(ic.qty_total,0) <= p.min_stock) )
        ORDER BY COALESCE(ic.qty_total,0) ASC, p.id
        LIMIT 200`, [sid, m]);
    return { storeId: Number(sid), mode: m, items: rows.map((r: any) => ({
      ...r,
      product_id: Number(r.product_id), qty_total: Number(r.qty_total), qty_on_order: Number(r.qty_on_order),
      min_stock: Number(r.min_stock), sell_price: Number(r.sell_price) })) };
  }

  /** V5.0.1 一键调拨辅助：商品在各门店（含总部仓）的可用库存（stock.transfer 权限），供自动选源店生成调拨单 */
  @Get('cross-store')
  @RequirePerms('stock.transfer')
  async crossStore(@Query('productId') productId?: string) {
    const pid = Number(productId);
    if (!pid) throw new BizException(40003, 'productId 必填');
    const rows = await q(
      `SELECT s.id AS store_id, s.name AS store_name,
              COALESCE((SELECT SUM(b.remain_qty) FROM batches b
                         WHERE b.store_id = s.id AND b.product_id = $1
                           AND b.status = '在库' AND b.remain_qty > 0), 0)::float8 AS qty
         FROM stores s ORDER BY s.id`, [pid]);
    return rows.map((r: any) => ({ ...r, store_id: Number(r.store_id), qty: Number(r.qty) }));
  }

  /**
   * 批次查询（FIFO 溯源：批次=供应商×入库单×批次号 V4.3.5）
   * V4.9.3：支持 供应商 / 单据号（入库单号等）/ 商品ID / 商品名称 / 商品条码 多条件；
   * 命中入库单号时同时返回该入库单概要（点击结果可看入库商品情况）
   */
  @Get('batches')
  async batches(
    @Query('productId') productId?: string,
    @Query('supplierId') supplierId?: string,
    @Query('expiringInDays') expiringInDays?: string,
    @Query('docNo') docNo?: string,
    @Query('keyword') keyword?: string,
  ) {
    const rows = await q(
      `SELECT b.*, p.name AS product_name, p.barcode AS product_barcode, p.base_unit, s.name AS supplier_name,
              io.inbound_no AS inbound_no, io.created_at AS doc_inbound_date
         FROM batches b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN suppliers s ON s.id = b.supplier_id
         LEFT JOIN inbound_orders io ON io.id = b.inbound_order_id
        WHERE b.status = '在库' AND b.remain_qty > 0
          AND ($1::bigint IS NULL OR b.product_id = $1::bigint)
          AND ($2::bigint IS NULL OR b.supplier_id = $2::bigint)
          AND ($3::int IS NULL OR b.expiry_date <= CURRENT_DATE + $3::int)
          AND ($4::text IS NULL OR io.inbound_no = $4::text OR b.batch_no = $4::text)
          AND ($5::text IS NULL OR p.name ILIKE '%'||$5||'%' OR p.barcode = $5::text OR p.id::text = $5::text
               OR s.name ILIKE '%'||$5||'%')
        ORDER BY b.expiry_date, b.inbound_date
        LIMIT 200`,
      [productId ? Number(productId) : null, supplierId ? Number(supplierId) : null,
       expiringInDays ? Number(expiringInDays) : null,
       (docNo || '').trim() || null, (keyword || '').trim() || null],
    );
    // 单据号查询：附带该入库单概要（前端点击结果可展开入库商品情况）
    let doc: any = null;
    const no = (docNo || '').trim();
    if (no && rows.length && rows[0].inbound_order_id) {
      doc = await q1(
        `SELECT io.id, io.inbound_no, io.status, io.total_amount, s.name AS supplier_name, io.created_at
           FROM inbound_orders io LEFT JOIN suppliers s ON s.id = io.supplier_id
          WHERE io.id = $1`, [rows[0].inbound_order_id]);
    }
    return { items: rows, doc };
  }

  /** 临期预警（7天黄/3天橙档位来自设置 stock.expiry_warn_days）；V4.9.3 带处置状态/时限/超时处罚 */
  @Get('expiry-alerts')
  async expiryAlerts() {
    const warn = await this.settings.getVal('stock.expiry_warn_days');
    const days = Array.isArray(warn) ? Number(warn[0]) || 7 : 7;
    const dh = await this.settings.getNum('stock.expiry_disposal_hours', 48);
    const hours = Number(dh) > 0 ? Math.floor(Number(dh)) : 48;
    // 超时未处置 → 记处罚标记（已退换不罚）
    await q(
      `UPDATE expiry_disposals SET penalized = TRUE, updated_at = now()
        WHERE status <> '已退换' AND deadline_at IS NOT NULL AND deadline_at < now() AND penalized = FALSE`);
    return q(
      `SELECT b.id AS batch_id, b.batch_no, b.product_id, p.name AS product_name, p.barcode, p.base_unit,
              b.remain_qty, b.expiry_date,
              (b.expiry_date - CURRENT_DATE) AS days_left,
              CASE WHEN (b.expiry_date - CURRENT_DATE) <= 3 THEN '橙' ELSE '黄' END AS warn_level,
              s.name AS supplier_name,
              COALESCE(d.status, '未处理') AS disposal_status,
              COALESCE(d.deadline_at, now() + make_interval(hours => $2::int)) AS deadline_at,
              d.started_at, d.handled_at, d.handler_name, d.return_doc_no, d.penalized
         FROM batches b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN suppliers s ON s.id = p.supplier_default_id
         LEFT JOIN expiry_disposals d ON d.batch_id = b.id
        WHERE b.status='在库' AND b.remain_qty > 0
          AND b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
        ORDER BY b.expiry_date`, [days, hours],
    );
  }

  /** 临期处置：开始处置（未处理 → 处理中；处置时限内须完成退/换货） */
  @RequirePerms('stock.loss.create', 'stock.count.audit')
  @Post('expiry-disposals/:batchId/start')
  async disposalStart(@Param('batchId', ParseIntPipe) batchId: number, @CurrentUser() user: AuthUser) {
    const dh = await this.settings.getNum('stock.expiry_disposal_hours', 48);
    const hours = Number(dh) > 0 ? Math.floor(Number(dh)) : 48;
    return q1(
      `INSERT INTO expiry_disposals (store_id, batch_id, product_id, status, deadline_at, started_at, handler_id, handler_name)
       SELECT b.store_id, b.id, b.product_id, '处理中', now() + make_interval(hours => $2::int), now(), $3, $4
         FROM batches b WHERE b.id = $1
       ON CONFLICT (batch_id) DO UPDATE SET
         status = CASE WHEN expiry_disposals.status = '已退换' THEN expiry_disposals.status ELSE '处理中' END,
         started_at = COALESCE(expiry_disposals.started_at, now()),
         handler_id = $3, handler_name = $4, updated_at = now()
       RETURNING *`,
      [batchId, hours, user.sub, user.name || ''],
    );
  }

  /**
   * 临期处置：处置到位（→ 已退换）。退/换货流程完成即到位：
   * 退货已审核 / 换货已入库；可填关联单号留痕。填了单号即视为流程已完成。
   */
  @RequirePerms('stock.loss.create', 'stock.count.audit')
  @Post('expiry-disposals/:batchId/done')
  async disposalDone(@Param('batchId', ParseIntPipe) batchId: number,
                     @Body() b: { returnDocNo?: string; remark?: string },
                     @CurrentUser() user: AuthUser) {
    const r = await q1(
      `INSERT INTO expiry_disposals (store_id, batch_id, product_id, status, deadline_at, handled_at, handler_id, handler_name, return_doc_no)
       SELECT b.store_id, b.id, b.product_id, '已退换', now(), now(), $2, $3, $4
         FROM batches b WHERE b.id = $1
       ON CONFLICT (batch_id) DO UPDATE SET
         status = '已退换', handled_at = now(), handler_id = $2, handler_name = $3,
         return_doc_no = COALESCE($4, expiry_disposals.return_doc_no), updated_at = now()
       RETURNING *`,
      [batchId, user.sub, user.name || '', (b.returnDocNo || '').trim() || null],
    );
    // V4.28.2 P0-5：处置完成后该商品库存快照上行（无事务场景，enqueue 自开连接；总部/单店 no-op）
    if (r?.product_id) {
      const inv = await q1(
        `SELECT qty_total FROM inventory_current WHERE store_id=$1 AND product_id=$2`,
        [Number(r.store_id), Number(r.product_id)]);
      if (inv) {
        await enqueueSync(null, 'inventory', null,
          { items: [{ productId: Number(r.product_id), qtyTotal: Number(inv.qty_total) }] });
      }
    }
    return r;
  }

  /* ═══════════ P0-3 盘点（账实分离：录入即生效、审核后置 V4.3.5；盘亏按 FIFO 扣批、盘盈调整即时库存） ═══════════ */

  /** 盘点单列表（状态 / 日期筛选，含差异行数） */
  @Get('counts')
  async countsList(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return q(
      `SELECT c.*, e.name AS employee_name,
              (SELECT count(*) FROM inventory_count_items i WHERE i.count_id = c.id)::int AS item_count,
              COALESCE((SELECT sum(i.diff_qty) FROM inventory_count_items i WHERE i.count_id = c.id), 0) AS diff_sum,
              COALESCE((SELECT sum(GREATEST(i.actual_qty, i.book_qty, 0)) FROM inventory_count_items i WHERE i.count_id = c.id), 0) AS total_qty
         FROM inventory_counts c LEFT JOIN employees e ON e.id = c.employee_id
        WHERE ($1::text IS NULL OR c.status::text = $1)
          AND ($2::date IS NULL OR c.created_at::date >= $2::date)
          AND ($3::date IS NULL OR c.created_at::date <= $3::date)
        ORDER BY c.id DESC LIMIT 100`,
      [status || null, from || null, to || null],
    );
  }

  /** 创建盘点单：items 仅需 productId + actualQty（实盘）；book_qty 自动快照当前库存 */
  @RequirePerms('stock.count.audit', 'stock.count.task')
  @Post('counts')
  async createCount(
    @Body() b: { scope?: string; remark?: string; items: { productId: number; actualQty: number; remark?: string }[] },
    @CurrentUser() user: AuthUser,
  ) {
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '盘点明细不能为空');
    const items = b.items.map(it => ({ productId: Number(it.productId), actualQty: Number(it.actualQty) }));
    if (items.some(it => !(it.productId > 0))) throw new BizException(40003, 'productId 必填');
    if (items.some(it => !(it.actualQty >= 0))) throw new BizException(40003, '实盘数量不能为负数');

    return tx(async c => {
      await seqLock(c, 'inventory_counts', 'count_no', `PD-${today()}-%`);
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM inventory_counts WHERE count_no LIKE $1`, [`PD-${today()}-%`]);
      const no = `PD-${today()}-${String(seq[0].n).padStart(3, '0')}`;
      const rows = await cx(c,
        `INSERT INTO inventory_counts (store_id, count_no, scope, status, employee_id, remark)
         VALUES (${curStore()},$1,$2,'进行中',$3,$4) RETURNING id`,
        [no, b.scope === '按分类' || b.scope === '按供应商' ? b.scope : '全仓', user.sub, b.remark ?? null]);
      const id = Number(rows[0].id);
      const lines: any[] = [];
      for (const it of items) {
        const cur = await cx(c,
          `SELECT COALESCE(qty_total,0) AS qty FROM inventory_current WHERE store_id=${curStore()} AND product_id=$1`, [it.productId]);
        const item = await cx(c,
          `INSERT INTO inventory_count_items (count_id, product_id, book_qty, actual_qty, remark)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, book_qty, actual_qty, diff_qty`,
          [id, it.productId, r3(Number(cur[0]?.qty ?? 0)), r3(it.actualQty), null]);
        lines.push({ itemId: Number(item[0].id), productId: it.productId,
                     bookQty: Number(item[0].book_qty), actualQty: Number(item[0].actual_qty),
                     diffQty: Number(item[0].diff_qty) });
      }
      await audit(curStore(), user.sub, '进销存', 'count.create', 'inventory_count', id,
        { no, lines: lines.map(l => ({ ...l, itemId: undefined })) });
      return { id, countNo: no, status: '进行中', lines };
    });
  }

  /** 盘点单详情（含明细：商品名/单位/账面/实盘/差异） */
  @Get('counts/:id')
  async countDetail(@Param('id', ParseIntPipe) id: number) {
    const c = await q1(
      `SELECT c.*, e.name AS employee_name, a.name AS auditor_name
         FROM inventory_counts c
         LEFT JOIN employees e ON e.id = c.employee_id
         LEFT JOIN employees a ON a.id = c.audited_by
        WHERE c.id=$1`, [id]);
    if (!c) throw new BizException(40404, '盘点单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit
         FROM inventory_count_items i JOIN products p ON p.id = i.product_id
        WHERE i.count_id=$1 ORDER BY i.id`, [id]);
    return { ...c, id: Number(c.id), items };
  }

  /** 盘点差异审核（权限 stock.count.audit）：盘亏 FIFO 扣批次+流水+即时库存；盘盈调增即时库存+流水 */
  @RequirePerms('stock.count.audit')
  @Post('counts/:id/audit')
  async auditCount(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM inventory_counts WHERE id=$1 FOR UPDATE`, [id]);
      const cnt = rs[0];
      if (!cnt) throw new BizException(40404, '盘点单不存在', 404);
      if (cnt.status !== '进行中') throw new BizException(50016, `盘点单状态(${cnt.status})不允许审核`);
      await this.assertSigned(c, 'count', 'inventory_counts', id, String(cnt.count_no));

      const items = await cx(c, `SELECT * FROM inventory_count_items WHERE count_id=$1 FOR UPDATE`, [id]);
      if (!items.length) throw new BizException(50016, '盘点单无明细，不能审核');
      const diffTotal = await this.applyCountDiffs(c, id, user.sub);
      await cx(c,
        `UPDATE inventory_counts SET status='已审核', audited_by=$2, audited_at=now() WHERE id=$1`,
        [id, user.sub]);
      // V4.28.2 P0-5：盘点单上行（count_no 幂等）+ 库存快照
      await enqueueSync(c, 'stock_count', id, {
        countNo: String(cnt.count_no), scope: cnt.scope,
        items: items.map((it: any) => ({ productId: Number(it.product_id), bookQty: Number(it.book_qty), actualQty: Number(it.actual_qty) })),
      });
      await this.snapInventory(c, items.map((it: any) => Number(it.product_id)));
      await audit(curStore(), user.sub, '进销存', 'count.audit', 'inventory_count', id, { no: cnt.count_no, diffTotal: r3(diffTotal) });
      return { id, status: '已审核', diffTotal: r3(diffTotal) };
    });
  }

  /** 盘点差异生效（auditCount 与盘点任务审核共用）：盘亏 FIFO 扣批、盘盈建批次入库
   *  V5.0.16 修复：盘盈原先只改 inventory_current + 写 batch_id=NULL/unit_cost=0 的流水，
   *  而 FIFO 出库只扫 batches 表 → 盘盈数量永远无法被销售消耗，造成「账面有货但卖不出」的长期漂移。
   *  现盘盈同样生成批次（成本取最近一次入库价/供应商进价），使其可被 FIFO/FEFO 正常消耗。 */
  private async applyCountDiffs(c: any, countId: number, employeeId: number) {
    const items = await cx(c, `SELECT * FROM inventory_count_items WHERE count_id=$1 FOR UPDATE`, [countId]);
    let diffTotal = 0;
    for (const it of items) {
      const diff = r3(Number(it.actual_qty) - Number(it.book_qty));
      diffTotal += diff;
      if (diff === 0) continue;
      if (diff < 0) {
        const allocs = await this.fifoAlloc(c, it.product_id, -diff, false);
        const cost = await this.applyOutStock(c, allocs, 'count', countId, it.id, '售罄', employeeId);
        await cx(c, `UPDATE inventory_count_items SET diff_cost=$2 WHERE id=$1`, [it.id, r2(cost)]);
      } else {
        const batchId = await this.createGainBatch(c, it.product_id, diff, `PY-${countId}-${it.id}`);
        await cx(c,
          `UPDATE inventory_current SET qty_total = qty_total + $2, updated_at=now()
            WHERE store_id=${curStore()} AND product_id=$1`, [it.product_id, diff]);
        await cx(c,
          `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
           VALUES (${curStore()},$1,$2,'入库',$3,$4,'count',$5,$6,$7)`,
          [it.product_id, batchId, diff, await this.gainUnitCost(c, it.product_id), countId, it.id, employeeId]);
      }
    }
    return diffTotal;
  }

  /** 盘盈/调整入库的成本口径：最近批次成本 → 供应商进价 → 标准成本 → 0（V5.0.16） */
  private async gainUnitCost(c: any, productId: number): Promise<number> {
    const b = await cx(c,
      `SELECT inbound_cost FROM batches WHERE store_id=${curStore()} AND product_id=$1
        ORDER BY inbound_date DESC, id DESC LIMIT 1`, [productId]);
    if (b[0] && Number(b[0].inbound_cost) > 0) return r4(Number(b[0].inbound_cost));
    const s = await cx(c,
      `SELECT price FROM supplier_product_prices WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [productId]);
    if (s[0] && Number(s[0].price) > 0) return r4(Number(s[0].price));
    const std = await cx(c, `SELECT standard_cost FROM products WHERE id=$1`, [productId]);
    return std[0] && Number(std[0].standard_cost) > 0 ? r4(Number(std[0].standard_cost)) : 0;
  }

  /** 生成一个盘盈/调整入库批次（生产日期按当天、到期日按商品保质期推算），返回 batch_id
   *  supplier_id 取商品主供应商（无则 0，与组合品建批次口径一致）。 */
  private async createGainBatch(c: any, productId: number, qty: number, batchNo: string): Promise<number> {
    const meta = await cx(c,
      `SELECT p.keep_days, p.supplier_default_id FROM products p WHERE p.id=$1`, [productId]);
    const keepDays = Number(meta[0]?.keep_days || 0) || 365;
    const supplierId = Number(meta[0]?.supplier_default_id || 0) || 0;
    const cost = await this.gainUnitCost(c, productId);
    const bt = await cx(c,
      `INSERT INTO batches (store_id, product_id, supplier_id, inbound_order_id, batch_no, inbound_date,
                            production_date, expiry_date, inbound_cost, inbound_qty, remain_qty, status)
       VALUES (${curStore()},$1,$2,NULL,$3,CURRENT_DATE,CURRENT_DATE,
               CURRENT_DATE + ($4 || ' days')::interval, $5,$6,$6,'在库') RETURNING id`,
      [productId, supplierId, batchNo, String(keepDays), cost, qty]);
    return Number(bt[0].id);
  }

  /** V4.28.2 P0-5：受影响商品库存快照上行（'inventory' 实体 → 总部 upsert inventory_current；
   *  总部/单店节点 no-op）。productIds 传本店商品 id（连锁主档同 id；门店自建品未收编时总部侧按存在性跳过）。 */
  private async snapInventory(c: any, productIds: number[]) {
    const pids = [...new Set(productIds.map(Number).filter(Boolean))];
    if (!pids.length) return;
    const rows = await cx(c,
      `SELECT product_id, qty_total FROM inventory_current
        WHERE store_id=${curStore()} AND product_id = ANY($1::bigint[])`, [pids]);
    await enqueueSync(c, 'inventory', null,
      { items: rows.map((r: any) => ({ productId: Number(r.product_id), qtyTotal: Number(r.qty_total) })) });
  }

  /* ═══════════ 盘点任务（V4.8.25：后台建任务→指派店员→手机端实盘→审核生成盘点单） ═══════════ */

  /** 盘点任务列表 */
  @Get('count-tasks')
  async countTasksList(
    @Query('status') status?: string,
    @Query('assigneeId') assigneeId?: string,
  ) {
    return q(
      `SELECT t.*, e.name AS creator_name
         FROM stocktake_tasks t LEFT JOIN employees e ON e.id = t.created_by
        WHERE ($1::text IS NULL OR t.status = $1)
          AND ($2::bigint IS NULL OR t.assignee_id = $2::bigint OR t.assignee_id IS NULL)
        ORDER BY t.id DESC LIMIT 100`,
      [status || null, assigneeId ? Number(assigneeId) : null]);
  }

  /** 创建盘点任务（全仓/按分类/按供应商），快照建任务时的账面数量 */
  @RequirePerms('stock.count.task')
  @Post('count-tasks')
  async createCountTask(
    @Body() b: { name?: string; scopeType?: string; categoryIds?: number[]; supplierId?: number;
                 assigneeId?: number; assigneeName?: string; dueDate?: string; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const scopeType = ['全仓', '按分类', '按供应商'].includes(b.scopeType || '') ? b.scopeType! : '全仓';
    const name = (b.name || '').trim() || `盘点任务-${today()}`;
    if (scopeType === '按分类' && (!Array.isArray(b.categoryIds) || !b.categoryIds.length))
      throw new BizException(40003, '按分类盘点请至少选择一个品类');
    if (scopeType === '按供应商' && !(Number(b.supplierId) > 0))
      throw new BizException(40003, '按供应商盘点请选择供应商');

    return tx(async c => {
      await seqLock(c, 'stocktake_tasks', 'task_no', `ST-${today()}-%`);
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM stocktake_tasks WHERE task_no LIKE $1`, [`ST-${today()}-%`]);
      const no = `ST-${today()}-${String(seq[0].n).padStart(3, '0')}`;
      let catNames = '';
      if (scopeType === '按分类') {
        const ids = b.categoryIds!.map(Number).filter(x => x > 0);
        const cats = await cx(c, `SELECT name FROM categories WHERE id = ANY($1::bigint[])`, [ids]);
        if (!cats.length) throw new BizException(40404, '所选品类不存在', 404);
        catNames = cats.map((x: any) => x.name).join('/');
      }
      const rows = await cx(c,
        `INSERT INTO stocktake_tasks (store_id, task_no, name, scope_type, category_ids, category_names,
            supplier_id, status, assignee_id, assignee_name, due_date, remark, created_by)
         VALUES (${curStore()},$1,$2,$3,$4::jsonb,$5,$6,'待执行',$7,$8,$9,$10,$11) RETURNING id`,
        [no, name, scopeType, JSON.stringify((b.categoryIds || []).map(Number)), catNames || null,
         scopeType === '按供应商' ? Number(b.supplierId) : null,
         Number(b.assigneeId) || null, b.assigneeName || null, b.dueDate || null, b.remark || null, user.sub]);
      const id = Number(rows[0].id);
      // 快照明细：品类子树（含本级）× 在售可盘商品 × 当前账面库存
      const items = await cx(c,
        `SELECT p.id AS product_id, p.category_id, COALESCE(ic.qty_total,0) AS book_qty
           FROM products p
           LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = ${curStore()}
          WHERE p.deleted_at IS NULL AND p.track_inventory AND ${PRODUCT_VISIBLE(String(curStore()))}
            AND ($1 = '全仓'
                 OR ($1 = '按分类' AND p.category_id IN (
                      SELECT c2.id FROM categories c1 JOIN categories c2
                        ON (c2.id = c1.id OR c2.path LIKE c1.path || '%')
                       WHERE c1.id = ANY($2::bigint[])))
                 OR ($1 = '按供应商' AND p.supplier_default_id = $3::bigint))`,
        [scopeType, (b.categoryIds || []).map(Number), Number(b.supplierId) || 0]);
      for (const it of items) {
        await cx(c,
          `INSERT INTO stocktake_task_items (task_id, product_id, category_id, book_qty)
           VALUES ($1,$2,$3,$4) ON CONFLICT (task_id, product_id) DO NOTHING`,
          [id, it.product_id, it.category_id, r3(Number(it.book_qty))]);
      }
      if (!items.length) throw new BizException(40003, '任务范围内无可盘商品，请调整范围');
      await cx(c, `UPDATE stocktake_tasks SET total_sku=$2 WHERE id=$1`, [id, items.length]);
      await audit(curStore(), user.sub, '进销存', 'count.task.create', 'stocktake_task', id,
        { no, scopeType, categoryName: catNames, totalSku: items.length });
      return { id, taskNo: no, status: '待执行', totalSku: items.length, categoryName: catNames };
    });
  }

  /** 盘点任务详情（含明细：商品/分类/账面/实盘/差异） */
  @Get('count-tasks/:id')
  async countTaskDetail(@Param('id', ParseIntPipe) id: number) {
    const t = await q1(
      `SELECT t.*, e.name AS creator_name, a.name AS auditor_name
         FROM stocktake_tasks t
         LEFT JOIN employees e ON e.id = t.created_by
         LEFT JOIN employees a ON a.id = t.assignee_id
        WHERE t.id=$1`, [id]);
    if (!t) throw new BizException(40404, '盘点任务不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit, p.barcode, c.name AS category_name
         FROM stocktake_task_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE i.task_id=$1 ORDER BY c.sort_no, p.id`, [id]);
    return { ...t, id: Number(t.id), items };
  }

  /** 店员开始执行（待执行→执行中） */
  @Post('count-tasks/:id/start')
  async startCountTask(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const rs = await q1(`UPDATE stocktake_tasks SET status='执行中', updated_at=now()
                          WHERE id=$1 AND status='待执行' RETURNING id`, [id]);
    if (!rs) throw new BizException(50016, '任务不存在或状态不允许开始');
    await audit(curStore(), user.sub, '进销存', 'count.task.start', 'stocktake_task', id, {});
    return { id, status: '执行中' };
  }

  /** 店员手机端提交实盘数量（执行中/待审核均可补录；全部录完→待审核） */
  @Post('count-tasks/:id/submit')
  async submitCountTask(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { items: { itemId: number; actualQty: number; remark?: string }[] },
    @CurrentUser() user: AuthUser,
  ) {
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '提交明细不能为空');
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM stocktake_tasks WHERE id=$1 FOR UPDATE`, [id]);
      const t = rs[0];
      if (!t) throw new BizException(40404, '盘点任务不存在', 404);
      if (!['执行中', '待审核'].includes(t.status)) throw new BizException(50016, `任务状态(${t.status})不允许提交实盘`);
      for (const it of b.items) {
        const qty = Number(it.actualQty);
        if (!(qty >= 0)) throw new BizException(40003, '实盘数量不能为负数');
        const row = await cx(c,
          `UPDATE stocktake_task_items SET actual_qty=$2, diff_qty=$2-book_qty,
              counted_at=now(), counted_by=$3, remark=COALESCE($4, remark)
            WHERE id=$1 AND task_id=$5 RETURNING id`,
          [Number(it.itemId), r3(qty), user.sub, it.remark || null, id]);
        if (!row.length) throw new BizException(40404, `明细#${it.itemId} 不属于该任务`, 404);
      }
      const cnt = await cx(c,
        `SELECT count(*) FILTER (WHERE actual_qty IS NOT NULL)::int AS counted, count(*)::int AS total
           FROM stocktake_task_items WHERE task_id=$1`, [id]);
      const allDone = cnt[0].counted >= cnt[0].total;
      await cx(c,
        `UPDATE stocktake_tasks SET counted_sku=$2, status=$3, updated_at=now() WHERE id=$1`,
        [id, cnt[0].counted, allDone ? '待审核' : t.status]);
      await audit(curStore(), user.sub, '进销存', 'count.task.submit', 'stocktake_task', id,
        { submitted: b.items.length, counted: cnt[0].counted, total: cnt[0].total });
      return { id, countedSku: cnt[0].counted, totalSku: cnt[0].total, status: allDone ? '待审核' : t.status };
    });
  }

  /** 任务审核：全部实盘后生成盘点单（账实分离→复用盘点审核 FIFO 差异生效）并完成审核 */
  @RequirePerms('stock.count.audit')
  @Post('count-tasks/:id/audit')
  async auditCountTask(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM stocktake_tasks WHERE id=$1 FOR UPDATE`, [id]);
      const t = rs[0];
      if (!t) throw new BizException(40404, '盘点任务不存在', 404);
      if (t.status !== '待审核') throw new BizException(50016, `任务状态(${t.status})不允许审核，请先完成全部实盘`);
      const items = await cx(c, `SELECT * FROM stocktake_task_items WHERE task_id=$1 ORDER BY id`, [id]);
      if (items.some((it: any) => it.actual_qty == null)) throw new BizException(50016, '仍有商品未实盘，不能审核');
      if (t.count_id) throw new BizException(50016, '该任务已生成盘点单');

      // 生成盘点单（账实分离：先建单再差异生效）
      await seqLock(c, 'inventory_counts', 'count_no', `PD-${today()}-%`);
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM inventory_counts WHERE count_no LIKE $1`, [`PD-${today()}-%`]);
      const no = `PD-${today()}-${String(seq[0].n).padStart(3, '0')}`;
      const scope = t.scope_type === '全仓' ? '全仓' : `任务盘点·${t.category_names || t.scope_type}`;
      const cnt = await cx(c,
        `INSERT INTO inventory_counts (store_id, count_no, scope, status, employee_id, remark)
         VALUES (${curStore()},$1,$2,'进行中',$3,$4) RETURNING id`,
        [no, scope, t.assignee_id || user.sub, `来源盘点任务 ${t.task_no}${t.remark ? '：' + t.remark : ''}`]);
      const countId = Number(cnt[0].id);
      for (const it of items) {
        await cx(c,
          `INSERT INTO inventory_count_items (count_id, product_id, book_qty, actual_qty, remark)
           VALUES ($1,$2,$3,$4,$5)`, [countId, it.product_id, it.book_qty, it.actual_qty, it.remark]);
      }
      const diffTotal = await this.applyCountDiffs(c, countId, user.sub);
      await cx(c,
        `UPDATE inventory_counts SET status='已审核', audited_by=$2, audited_at=now() WHERE id=$1`,
        [countId, user.sub]);
      await cx(c,
        `UPDATE stocktake_tasks SET status='已完成', count_id=$2, updated_at=now() WHERE id=$1`,
        [id, countId]);
      // V4.28.2 P0-5：任务生成的盘点单上行 + 库存快照
      await enqueueSync(c, 'stock_count', countId, {
        countNo: no, scope,
        items: items.map((it: any) => ({ productId: Number(it.product_id), bookQty: Number(it.book_qty), actualQty: Number(it.actual_qty) })),
      });
      await this.snapInventory(c, items.map((it: any) => Number(it.product_id)));
      await audit(curStore(), user.sub, '进销存', 'count.task.audit', 'stocktake_task', id,
        { taskNo: t.task_no, countNo: no, diffTotal: r3(diffTotal) });
      return { id, countId, countNo: no, status: '已完成', diffTotal: r3(diffTotal) };
    });
  }

  /* ═══════════ 报损（拍照报损 V4.4.0：整单拍照 ≥1 张应用层强制；批次优先临期） ═══════════ */

  /* ── V5.0.3 手机拍摄指令：PC 发起 → 同账号 PWA 消息页拍摄上传 → PC 轮询取回路径 ── */

  /** 发起照片拍摄指令（返回 token 供 PC 轮询）。
   *  默认 bizType='loss' 用于报损；采购退货等业务传 bizType='return' 即可复用同一套移动端回传机制。 */
  @Post('losses/photo-request')
  async createLossPhotoRequest(
    @Body() b: { bizType?: string; label?: string },
    @CurrentUser() user: AuthUser) {
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 40);
    const bizType = b?.bizType || 'loss';
    const label = b?.label || `报损照片 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const auditOp = bizType === 'return' ? 'return.photo.request' : 'loss.photo.request';
    const auditCat = bizType === 'return' ? '采购' : '库存';
    await tx(async c =>
      cx(c, `INSERT INTO mobile_photo_requests (token, store_id, biz_type, label, status, employee_id)
             VALUES ($1,$2,$3,$4,'待拍摄',$5)`,
        [token, user.storeId || 1, bizType, label, user.sub]));
    await audit(curStore(), user.sub, auditCat, auditOp, 'mobile_photo_request', 0, { token, bizType });
    return { token };
  }

  /** 店员端：同账号待拍摄清单（PWA 消息页轮询） */
  @Get('losses/photo-requests/pending')
  async pendingLossPhotos(@CurrentUser() user: AuthUser) {
    return { items: await q(
      `SELECT id, token, label, created_at FROM mobile_photo_requests
        WHERE store_id=$1 AND employee_id=$2 AND status='待拍摄'
        ORDER BY id DESC LIMIT 20`, [user.storeId || 1, user.sub]) };
  }

  /** PC 端轮询：拍摄状态 */
  @Get('losses/photo-requests/:token')
  async lossPhotoStatus(@Param('token') token: string) {
    const rows = await q1(
      `SELECT status, file_path AS "filePath" FROM mobile_photo_requests WHERE token=$1`, [token]);
    if (!rows) throw new BizException(40404, '拍摄指令不存在', 404);
    return rows;
  }

  /** 店员端回传：token + 已上传文件路径（/upload 得到的 path） */
  @Post('losses/photo-requests/:token/submit')
  async submitLossPhoto(@Param('token') token: string,
                        @Body() b: { filePath: string },
                        @CurrentUser() user: AuthUser) {
    if (!b?.filePath) throw new BizException(40003, '缺少照片路径');
    const r = await tx(async c =>
      cx(c, `UPDATE mobile_photo_requests SET status='已上传', file_path=$2, done_at=now()
              WHERE token=$1 AND employee_id=$3 AND status='待拍摄' RETURNING id`,
        [token, String(b.filePath).slice(0, 250), user.sub]));
    if (!r.length) throw new BizException(50010, '拍摄指令不存在或已回传');
    return { ok: true };
  }

  /** 报损单列表（状态 / 日期筛选） */
  @Get('losses')
  async lossesList(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return q(
      `SELECT l.*, e.name AS employee_name,
              (SELECT count(*) FROM loss_items i WHERE i.loss_id = l.id)::int AS item_count,
              COALESCE((SELECT sum(i.qty) FROM loss_items i WHERE i.loss_id = l.id), 0) AS total_qty
         FROM loss_records l LEFT JOIN employees e ON e.id = l.employee_id
        WHERE ($1::text IS NULL OR l.status::text = $1)
          AND ($2::date IS NULL OR l.created_at::date >= $2::date)
          AND ($3::date IS NULL OR l.created_at::date <= $3::date)
        ORDER BY l.id DESC LIMIT 100`,
      [status || null, from || null, to || null],
    );
  }

  /** 创建报损单：拍照必填；明细批次自动归属（优先临期 ORDER BY expiry_date, inbound_date） */
  @RequirePerms('stock.loss.create')
  @Post('losses')
  async createLoss(
    @Body() b: { reasonType?: string; photoPath: string; remark?: string; items: { productId: number; qty: number; remark?: string }[] },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.photoPath) throw new BizException(40003, '报损照片必传（整单拍照 ≥1 张）');
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '报损明细不能为空');
    const reason = ['损耗', '过期', '破损', '质量问题'].includes(b.reasonType || '') ? b.reasonType! : '损耗';

    return tx(async c => {
      await seqLock(c, 'loss_records', 'loss_no', `BS-${today()}-%`);
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM loss_records WHERE loss_no LIKE $1`, [`BS-${today()}-%`]);
      const no = `BS-${today()}-${String(seq[0].n).padStart(3, '0')}`;
      const rows = await cx(c,
        `INSERT INTO loss_records (store_id, loss_no, reason_type, photo_path, status, employee_id)
         VALUES (${curStore()},$1,$2,$3,'待审核',$4) RETURNING id`,
        [no, reason, b.photoPath, user.sub]);
      const id = Number(rows[0].id);
      // V5.0.3 商品与报损：stock.loss_allow_zero 开启时，零/负库存商品允许报损——
      // 在库批次不足（含零批次）→ 按「无批次」行记账（batch_id 空，成本取该商品最近一次进价，无则 0）
      const allowZero = await this.settings.getBool('stock.loss_allow_zero', false);
      let total = 0;
      const lines: any[] = [];
      for (const it of b.items) {
        const qty = r3(Number(it.qty));
        if (!(qty > 0)) throw new BizException(40003, '报损数量必须大于 0');
        let batchId: number | null = null;
        let cost = 0;
        try {
          const allocs = await this.fifoAlloc(c, it.productId, qty, true);
          if (allocs.length !== 1) throw new BizException(50016, '报损需整批归属（请核对批次）');
          batchId = allocs[0].batchId;
          cost = allocs[0].cost;
        } catch (e: any) {
          if (!(allowZero && e && e.code === 50014)) throw e;   // 仅「批次不足」走无批次兜底；其余原样抛出
          const lc = await cx(c,
            `SELECT inbound_cost FROM batches WHERE product_id=$1 ORDER BY inbound_date DESC, id DESC LIMIT 1`,
            [it.productId]);
          cost = Number(lc[0]?.inbound_cost) || 0;
        }
        const item = await cx(c,
          `INSERT INTO loss_items (loss_id, product_id, batch_id, qty, unit_cost, remark)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [id, it.productId, batchId, qty, cost, it.remark ?? null]);
        total += qty * cost;
        lines.push({ itemId: Number(item[0].id), productId: it.productId, batchId,
                     qty, unitCost: cost });
      }
      await cx(c, `UPDATE loss_records SET total_cost=$2 WHERE id=$1`, [id, r2(total)]);
      await audit(curStore(), user.sub, '进销存', 'loss.create', 'loss_record', id, { no, reason, total: r2(total) });
      // M3b：操作员自动关联（employee_id 已写）；报损无供应商业务员 → 前端手机屏幕现场签名（loss_records.sign_record_id 027）
      const sign = await autoAttachSignature(c, {
        storeId: 1, bizType: 'loss', bizId: id,
        summary: `${no}|${reason}|${b.items.length}项`, usedBy: user.sub, amount: r2(total),
      });
      if (sign && 'recordId' in sign) await cx(c, `UPDATE loss_records SET sign_record_id=$2 WHERE id=$1`, [id, sign.recordId]);
      return { id, lossNo: no, status: '待审核', totalCost: r2(total), lines, signInfo: sign };
    });
  }

  /** 报损单详情（含明细：商品/批次/数量/成本） */
  @Get('losses/:id')
  async lossDetail(@Param('id', ParseIntPipe) id: number) {
    const l = await q1(
      `SELECT l.*, e.name AS employee_name, a.name AS auditor_name
         FROM loss_records l
         LEFT JOIN employees e ON e.id = l.employee_id
         LEFT JOIN employees a ON a.id = l.audited_by
        WHERE l.id=$1`, [id]);
    if (!l) throw new BizException(40404, '报损单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit, b.batch_no,
              CASE WHEN i.batch_id IS NULL THEN '无批次（零库存报损）' ELSE b.batch_no END AS batch_no_disp
         FROM loss_items i JOIN products p ON p.id = i.product_id
         LEFT JOIN batches b ON b.id = i.batch_id
        WHERE i.loss_id=$1 ORDER BY i.id`, [id]);
    return { ...l, id: Number(l.id), items };
  }

  /** 报损审核：扣指定批次（remain 归零置 '报损'）+ 库存流水 + 即时库存
   *  V4.28.3 P1-10：审核与创建分离——创建 stock.loss.create（店员登记），审核 stock.loss.audit（库管/店长复核） */
  @RequirePerms('stock.loss.audit')
  @Post('losses/:id/audit')
  async auditLoss(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM loss_records WHERE id=$1 FOR UPDATE`, [id]);
      const loss = rs[0];
      if (!loss) throw new BizException(40404, '报损单不存在', 404);
      if (loss.status !== '待审核') throw new BizException(50016, `报损单状态(${loss.status})不允许审核`);
      await this.assertSigned(c, 'loss', 'loss_records', id, String(loss.loss_no));

      const items = await cx(c, `SELECT * FROM loss_items WHERE loss_id=$1 ORDER BY id`, [id]);
      if (!items.length) throw new BizException(50016, '报损单无明细，不能审核');
      const byProduct = new Map<number, number>();
      for (const it of items) {
        if (it.batch_id != null) {
          const bt = await cx(c,
            `SELECT id, remain_qty FROM batches WHERE id=$1 AND status='在库' FOR UPDATE`, [it.batch_id]);
          if (!bt.length) throw new BizException(50016, `批次#${it.batch_id} 已不在库，无法报损`);
          if (Number(bt[0].remain_qty) < Number(it.qty)) {
            throw new BizException(50014, `批次剩余 ${bt[0].remain_qty}，不足报损 ${it.qty}`);
          }
          await cx(c,
            `UPDATE batches SET remain_qty = remain_qty - $2,
                status = CASE WHEN remain_qty - $2 <= 0 THEN '报损' ELSE status END
              WHERE id=$1`, [it.batch_id, it.qty]);
        }
        // V5.0.3：batch_id 为空的「无批次」行（零/负库存报损）跳过批次扣减，仅记流水——允许扣成负库存
        await cx(c,
          `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
           VALUES (${curStore()},$1,$2,'出库',$3,$4,'loss',$5,$6,$7)`,
          [it.product_id, it.batch_id, it.qty, it.unit_cost, id, it.id, user.sub]);
        byProduct.set(Number(it.product_id), (byProduct.get(Number(it.product_id)) || 0) + Number(it.qty));
      }
      for (const [pid, qty] of byProduct) {
        await cx(c,
          `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now()
            WHERE store_id=${curStore()} AND product_id=$1`, [pid, r3(qty)]);
      }
      await cx(c,
        `UPDATE loss_records SET status='已审核', audited_by=$2 WHERE id=$1`,
        [id, user.sub]);
      // V4.28.2 P0-5：报损单上行（总部台账，loss_no 幂等；明细批次为门店本地不可复刻 → 总部只落单头）
      await enqueueSync(c, 'loss', id, {
        lossNo: String(loss.loss_no), reasonType: loss.reason_type, totalCost: Number(loss.total_cost ?? 0),
        items: items.map((it: any) => ({ productId: Number(it.product_id), qty: Number(it.qty), unitCost: Number(it.unit_cost) })),
      });
      await this.snapInventory(c, [...byProduct.keys()]);
      await audit(curStore(), user.sub, '进销存', 'loss.audit', 'loss_record', id, { no: loss.loss_no });
      return { id, status: '已审核', totalCost: Number(loss.total_cost) };
    });
  }

  /**
   * V4.9.8 报损单驳回（手机端审批）：待审核 → 已驳回，原因必填并留痕；不扣库存不扣批次。
   * 典型场景：照片不清、数量存疑、责任未定——驳回后由门店重拍/核实再提。
   */
  @RequirePerms('stock.loss.audit')   // V4.28.3 P1-10：驳回同审核权（不能自己建自己驳）
  @Post('losses/:id/reject')
  async rejectLoss(@Param('id', ParseIntPipe) id: number,
                   @Body() b: { reason?: string },
                   @CurrentUser() user: AuthUser) {
    const reason = String(b.reason || '').trim();
    if (!reason) throw new BizException(40003, '驳回必须填写原因（便于门店整改与留痕）');
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM loss_records WHERE id=$1 FOR UPDATE`, [id]);
      const loss = rs[0];
      if (!loss) throw new BizException(40404, '报损单不存在', 404);
      if (loss.status !== '待审核') throw new BizException(50016, `报损单状态(${loss.status})不允许驳回`);
      await cx(c,
        `UPDATE loss_records SET status='已驳回', reject_reason=$2, rejected_by=$3, rejected_at=now() WHERE id=$1`,
        [id, reason, user.sub]);
      await audit(curStore(), user.sub, '进销存', 'loss.reject', 'loss_record', id, { no: loss.loss_no, reason });
      return { id, status: '已驳回', rejectReason: reason };
    });
  }

  /** V4.9.8 盘点单驳回（手机端审批）：进行中/待差异处理 → 已驳回，原因必填并留痕；不调整库存。 */
  @RequirePerms('stock.count.audit')
  @Post('counts/:id/reject')
  async rejectCount(@Param('id', ParseIntPipe) id: number,
                    @Body() b: { reason?: string },
                    @CurrentUser() user: AuthUser) {
    const reason = String(b.reason || '').trim();
    if (!reason) throw new BizException(40003, '驳回必须填写原因（便于门店整改与留痕）');
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM inventory_counts WHERE id=$1 FOR UPDATE`, [id]);
      const cnt = rs[0];
      if (!cnt) throw new BizException(40404, '盘点单不存在', 404);
      if (!['进行中', '待差异处理'].includes(cnt.status)) {
        throw new BizException(50016, `盘点单状态(${cnt.status})不允许驳回`);
      }
      await cx(c,
        `UPDATE inventory_counts SET status='已驳回', reject_reason=$2, rejected_by=$3, rejected_at=now() WHERE id=$1`,
        [id, reason, user.sub]);
      await audit(curStore(), user.sub, '进销存', 'count.reject', 'inventory_count', id, { no: cnt.count_no, reason });
      return { id, status: '已驳回', rejectReason: reason };
    });
  }

  /**
   * V5.0.16 库存快速调整通道（少量商品即时纠偏）：
   *   盘点单适合大批量实盘，但「少量商品临时纠偏」（破损试吃、样品补录、录入误差）要走建单+审核，过于繁琐。
   *   本接口一次提交若干商品的正负调整、立即生效并全量留痕（审计含原因与逐项结果）。
   *   正数=盘盈入库（**生成批次**，可被 FIFO/FEFO 正常消耗）；负数=盘亏出库（FIFO 扣批，批次不足直接拒绝，不允许负库存）。
   *   必须填写调整原因以满足可追溯；权限复用「盘点差异审核」stock.count.audit。
   */
  @RequirePerms('stock.count.audit')
  @Post('adjust')
  async quickAdjust(@Body() b: { items?: { productId: number; qty: number }[]; reason?: string },
                    @CurrentUser() user: AuthUser) {
    const reason = String(b.reason || '').trim();
    if (!reason) throw new BizException(40003, '库存调整必须填写原因（留痕可追溯）');
    const items = (Array.isArray(b.items) ? b.items : [])
      .filter((x: any) => Number(x?.productId) > 0 && Number(x?.qty) !== 0);
    if (!items.length) throw new BizException(40003, '请至少填写一个调整商品与数量（数量 0 视为无效）');
    return tx(async c => {
      const seqs = await seqLock(c, 'batches', 'batch_no', `ADJ-${today()}-%`);
      const detail: any[] = [];
      for (const it of items) {
        const pid = Number(it.productId);
        const dq = r3(Number(it.qty));
        const prows = await cx(c, `SELECT id, name FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
        if (!prows[0]) throw new BizException(40404, `商品#${pid} 不存在`, 404);
        if (dq > 0) {
          const batchNo = `ADJ-${today()}-${String(seqs[0].n++).padStart(3, '0')}`;
          const bid = await this.createGainBatch(c, pid, dq, batchNo);
          const cost = await this.gainUnitCost(c, pid);
          await cx(c, `UPDATE inventory_current SET qty_total = qty_total + $2, updated_at=now()
            WHERE store_id=${curStore()} AND product_id=$1`, [pid, dq]);
          await cx(c, `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
            VALUES (${curStore()},$1,$2,'入库',$3,$4,'adjust',0,0,$5)`, [pid, bid, dq, cost, user.sub]);
          detail.push({ productId: pid, name: prows[0].name, qty: dq, dir: '盘盈', batchNo, unitCost: cost });
        } else {
          const allocs = await this.fifoAlloc(c, pid, -dq, false);
          const cost = await this.applyOutStock(c, allocs, 'adjust', 0, 0, '售罄', user.sub);
          detail.push({ productId: pid, name: prows[0].name, qty: dq, dir: '盘亏', cost: r2(cost) });
        }
      }
      await audit(curStore(), user.sub, '进销存', 'inventory.adjust', 'product', null, { reason, items: detail });
      await this.snapInventory(c, items.map((x: any) => Number(x.productId)));
      return { ok: true, reason, items: detail };
    });
  }

  /* ═══════════ 调拨（批次整体转移成本不变 5.4；单店一期仅店内调拨：出库→转入新批次，同店即时库存不变） ═══════════ */

  /** 调拨单列表（状态 / 日期筛选；批次6：按数据范围过滤——门店只见本店相关的单） */
  @Get('transfers')
  async transfersList(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const vis = visibleStores();                      // null=总部不限；否则限本店（含区域多店）
    const params: any[] = [status || null, from || null, to || null];
    let scopeSql = '';
    if (vis !== null) {
      params.push(vis);
      scopeSql = ` AND (t.from_store_id = ANY($${params.length}::bigint[]) OR t.to_store_id = ANY($${params.length}::bigint[]))`;
    }
    return q(
      `SELECT t.*, e.name AS employee_name,
              fs.name AS from_store_name, ts.name AS to_store_name, t.biz_scope,
              (SELECT count(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id)::int AS item_count,
              COALESCE((SELECT sum(i.qty) FROM stock_transfer_items i WHERE i.transfer_id = t.id), 0) AS total_qty
         FROM stock_transfers t
         LEFT JOIN employees e ON e.id = t.employee_id
         LEFT JOIN stores fs ON fs.id = t.from_store_id
         LEFT JOIN stores ts ON ts.id = t.to_store_id
        WHERE ($1::text IS NULL OR t.status::text = $1)
          AND ($2::date IS NULL OR t.created_at::date >= $2::date)
          AND ($3::date IS NULL OR t.created_at::date <= $3::date)${scopeSql}
        ORDER BY t.id DESC LIMIT 100`,
      params,
    );
  }

  /**
   * 创建调拨单（批次6 状态机 §5.5）：
   *   同店库位调拨（toStore=fromStore）→ '待确认'，confirm 即时双边过账（**原路径零回归**）
   *   总部 → 门店配送（fromStore=总部仓）→ biz_scope='hq2store'，'待发货'（总部已决策无需审核）
   *   门店间调拨（store2store）→ '待审核'，**总部唯一审核**（R5，hq.stock.transfer.audit）
   * 明细自动 FIFO 归属批次；支持拆批（一个商品可占多个批次，V20）
   */
  @RequirePerms('stock.transfer')
  @Post('transfers')
  async createTransfer(
    @Body() b: { toStoreId?: number; fromStoreId?: number; reason?: string; items: { productId: number; qty: number }[] },
    @CurrentUser() user: AuthUser,
  ) {
    // 调出/调入门店均可下拉选择：单店部署默认本店↔本店（店内库位调拨，零回归）
    const fromStore = Number(b.fromStoreId || 0) || 1;
    const toStore = Number(b.toStoreId || 0) || fromStore;
    if (fromStore !== toStore) {
      const n = await q1(`SELECT count(*)::int AS n FROM stores WHERE id IN ($1,$2)`, [fromStore, toStore]);
      if (Number(n?.n || 0) < 2) throw new BizException(40003, '调出/调入门店不存在');
    }
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '调拨明细不能为空');

    // ── 批次6：按调拨方向决定初始状态与 biz_scope ──
    const crossStoreMove = fromStore !== toStore;
    const fromIsHq = crossStoreMove ? await isHqStore(fromStore) : false;
    const initStatus = !crossStoreMove ? '待确认' : (fromIsHq ? '待发货' : '待审核');
    const bizScope = !crossStoreMove ? 'store2store' : (fromIsHq ? 'hq2store' : 'store2store');

    return tx(async c => {
      await seqLock(c, 'stock_transfers', 'transfer_no', `DB-${today()}-%`);
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM stock_transfers WHERE transfer_no LIKE $1`, [`DB-${today()}-%`]);
      const no = `DB-${today()}-${String(seq[0].n).padStart(3, '0')}`;
      const rows = await cx(c,
        `INSERT INTO stock_transfers (transfer_no, from_store_id, to_store_id, status, reason, employee_id, biz_scope)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [no, fromStore, toStore, initStatus, b.reason ?? null, user.sub, bizScope]);
      const id = Number(rows[0].id);
      let total = 0;
      const lines: any[] = [];
      for (const it of b.items) {
        const qty = r3(Number(it.qty));
        if (!(qty > 0)) throw new BizException(40003, '调拨数量必须大于 0');
        // V20 拆批：FIFO 可能命中多个批次 → 每个批次一行明细（批次血缘承袭 origin_batch_no）
        // V21 C 方案：总部仓允许「超账面调拨」——建单不因库存不足被拒，明细挂靠库存最多的在库批次，
        //             发货时按实有扣减，缺口自动转「调拨缺口」采购需求（inventory_current 转负）
        let allocs;
        try {
          allocs = await this.fifoAlloc(c, it.productId, qty, false, fromStore);
        } catch (e) {
          if (!fromIsHq) throw e;
          const anchor = await cx(c,
            `SELECT id, inbound_cost FROM batches
              WHERE store_id=$1 AND product_id=$2 AND status='在库' AND remain_qty > 0
              ORDER BY remain_qty DESC LIMIT 1`, [fromStore, it.productId]);
          if (!anchor.length) throw new BizException(50014, `商品在库批次不足且无可挂靠批次，无法调拨`);
          allocs = [{ batchId: Number(anchor[0].id), qty, cost: Number(anchor[0].inbound_cost) }];
        }
        for (const a of allocs) {
          const src = await cx(c, `SELECT origin_batch_no FROM batches WHERE id=$1`, [a.batchId]);
          const item = await cx(c,
            `INSERT INTO stock_transfer_items (transfer_id, product_id, batch_id, qty, unit_cost, origin_batch_no)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [id, it.productId, a.batchId, a.qty, a.cost, src[0]?.origin_batch_no ?? null]);
          total += a.qty * a.cost;
          lines.push({ itemId: Number(item[0].id), productId: it.productId, batchId: a.batchId,
                       qty: a.qty, unitCost: a.cost });
        }
      }
      await cx(c, `UPDATE stock_transfers SET total_cost=$2 WHERE id=$1`, [id, r2(total)]);
      await audit(curStore(), user.sub, '进销存', 'transfer.create', 'stock_transfer', id, { no, total: r2(total), scope: bizScope });
      // 电子签字：仅同店即时调拨沿用（跨店走发货/收货双签留痕，P2 接入）
      if (!crossStoreMove) {
        const sign = await autoAttachSignature(c, {
          storeId: 1, bizType: 'transfer', bizId: id,
          summary: `${no}|${b.items.length}项`, usedBy: user.sub, amount: r2(total),
        });
        if (sign && 'recordId' in sign) await cx(c, `UPDATE stock_transfers SET sign_record_id=$2 WHERE id=$1`, [id, sign.recordId]);
      }
      return { id, transferNo: no, status: initStatus, bizScope, totalCost: r2(total), lines, signInfo: crossStoreMove ? null as any : undefined };
    });
  }

  /** 调拨单详情（含明细：商品/批次/数量/成本） */
  @Get('transfers/:id')
  async transferDetail(@Param('id', ParseIntPipe) id: number) {
    const t = await q1(
      `SELECT t.*, e.name AS employee_name, a.name AS auditor_name,
              fs.name AS from_store_name, ts.name AS to_store_name
         FROM stock_transfers t
         LEFT JOIN employees e ON e.id = t.employee_id
         LEFT JOIN employees a ON a.id = t.audited_by
         LEFT JOIN stores fs ON fs.id = t.from_store_id
         LEFT JOIN stores ts ON ts.id = t.to_store_id
        WHERE t.id=$1`, [id]);
    if (!t) throw new BizException(40404, '调拨单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit, b.batch_no, b.expiry_date
         FROM stock_transfer_items i JOIN products p ON p.id = i.product_id
         JOIN batches b ON b.id = i.batch_id
        WHERE i.transfer_id=$1 ORDER BY i.id`, [id]);
    return { ...t, id: Number(t.id), items };
  }

  /** 调拨确认（权限 stock.transfer）：扣源批次（置 '调出'）→ 生成转入批次（成本不变）→ 双边库存流水；同店即时库存不变 */
  @RequirePerms('stock.transfer.audit')   // V4.28.3 P1-10：确认是管理动作，与发货/收货执行分离
  @Post('transfers/:id/confirm')
  async confirmTransfer(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [id]);
      const tr = rs[0];
      if (!tr) throw new BizException(40404, '调拨单不存在', 404);
      if (tr.status !== '待确认') throw new BizException(50016, `调拨单状态(${tr.status})不允许确认`);

      const items = await cx(c, `SELECT * FROM stock_transfer_items WHERE transfer_id=$1 ORDER BY id`, [id]);
      if (!items.length) throw new BizException(50016, '调拨单无明细，不能确认');
      const fromStore = Number(tr.from_store_id || 1);
      const toStore = Number(tr.to_store_id || fromStore);
      for (const it of items) {
        const src = await cx(c,
          `SELECT * FROM batches WHERE id=$1 AND store_id=$2 AND status='在库' FOR UPDATE`, [it.batch_id, fromStore]);
        if (!src.length) throw new BizException(50016, `批次#${it.batch_id} 已不在库，无法调出`);
        if (Number(src[0].remain_qty) < Number(it.qty)) {
          throw new BizException(50014, `批次剩余 ${src[0].remain_qty}，不足调出 ${it.qty}`);
        }
        // 出库：扣源批次
        await cx(c,
          `UPDATE batches SET remain_qty = remain_qty - $2,
              status = CASE WHEN remain_qty - $2 <= 0 THEN '调出' ELSE status END
            WHERE id=$1`, [it.batch_id, it.qty]);
        await cx(c,
          `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
           VALUES ($1,$2,$3,'出库',$4,$5,'transfer_out',$6,$7,$8)`,
          [fromStore, it.product_id, it.batch_id, it.qty, it.unit_cost, id, it.id, user.sub]);
        // 入库：生成转入批次（成本不变；批次号 DB<单号>-<序号>）
        const nb = await cx(c,
          `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date,
                                expiry_date, inbound_cost, inbound_qty, remain_qty, status)
           VALUES ($9,$1,$2,$3,$4,$5,$6,$7,$8,$8,'在库')
           RETURNING id`,
          [it.product_id, src[0].supplier_id, `DB${tr.transfer_no}-${it.id}`,
           src[0].inbound_date, src[0].production_date, src[0].expiry_date, it.unit_cost, it.qty, toStore]);
        await cx(c,
          `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
           VALUES ($8,$1,$2,'入库',$3,$4,'transfer_in',$5,$6,$7)`,
          [it.product_id, nb[0].id, it.qty, it.unit_cost, id, it.id, user.sub, toStore]);
        // 即时库存：调出方减、调入门店加（同店则一减一加净额为 0）
        await cx(c,
          `UPDATE inventory_current SET qty_total = qty_total - $3, updated_at=now()
            WHERE store_id=$1 AND product_id=$2`, [fromStore, it.product_id, it.qty]);
        await cx(c,
          `INSERT INTO inventory_current (store_id, product_id, qty_total, qty_on_order)
           VALUES ($1,$2,$3,0)
           ON CONFLICT (store_id, product_id)
           DO UPDATE SET qty_total = inventory_current.qty_total + $3, updated_at=now()`,
          [toStore, it.product_id, it.qty]);
      }
      await cx(c,
        `UPDATE stock_transfers SET status='已入库', audited_by=$2, updated_at=now() WHERE id=$1`,
        [id, user.sub]);
      await audit(curStore(), user.sub, '进销存', 'transfer.confirm', 'stock_transfer', id, { no: tr.transfer_no });
      return { id, status: '已入库', totalCost: Number(tr.total_cost) };
    });
  }

  /* ═══════════ 批次6：跨店调拨状态机（§5.5 / R5）═══════════
   *  待审核 --audit(pass)--> 待发货 --ship--> 在途 --receive--> 已入库
   *     │                       │                          
   *     └─audit(reject)→ 驳回    └─cancel→ 已取消（未动库存）
   *  同店调拨仍走原「待确认→confirm」路径，零回归。 */

  /** 总部审核（R5 唯一审核方；门店角色模板无 hq.stock.transfer.audit → 403，V18） */
  @RequirePerms('hq.stock.transfer.audit')
  @Post('transfers/:id/audit')
  async auditTransfer(@Param('id', ParseIntPipe) id: number,
                      @Body() b: { pass: boolean; remark?: string },
                      @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [id]);
      const tr = rs[0];
      if (!tr) throw new BizException(40404, '调拨单不存在', 404);
      if (tr.status !== '待审核') throw new BizException(50016, `调拨单状态(${tr.status})不在待审核`);
      const next = b.pass ? '待发货' : '驳回';
      await cx(c,
        `UPDATE stock_transfers SET status=$2, hq_audit_by=$3, hq_audited_at=now(), audit_remark=$4, updated_at=now()
          WHERE id=$1`, [id, next, user.sub, (b.remark || '').slice(0, 255) || null]);
      await audit(curStore(), user.sub, '进销存', b.pass ? 'transfer.audit.pass' : 'transfer.audit.reject', 'stock_transfer', id, { no: tr.transfer_no });
      return { id, status: next };
    });
  }

  /**
   * 发货（调出方；待发货 → 在途）：扣源批次 + 调出方即时库存。
   * V21 C 方案：门店调出库存不足 → 拒绝；**总部仓不足 → 放行**（inventory_current 可转负），
   * 缺口自动生成「调拨缺口」采购需求单（po_scope='hq'，status='草稿'），到货入库后人工/流程关闭。
   */
  @RequirePerms('stock.transfer')
  @Post('transfers/:id/ship')
  async shipTransfer(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [id]);
      const tr = rs[0];
      if (!tr) throw new BizException(40404, '调拨单不存在', 404);
      if (tr.status !== '待发货') throw new BizException(50016, `调拨单状态(${tr.status})不允许发货`);
      const fromStore = Number(tr.from_store_id);
      const fromIsHq = await isHqStore(fromStore);
      assertStoreAllowed(fromStore, '该调拨单的调出方');   // 门店只能发本店出的货（总部不限）
      const items = await cx(c,
        `SELECT i.*, b.remain_qty, b.supplier_id, b.origin_batch_no
           FROM stock_transfer_items i JOIN batches b ON b.id = i.batch_id
          WHERE i.transfer_id=$1 ORDER BY i.id FOR UPDATE OF i`, [id]);
      if (!items.length) throw new BizException(50016, '调拨单无明细，不能发货');
      const shortfalls: { productId: number; qty: number; supplierId: number | null; cost: number }[] = [];
      for (const it of items) {
        const need = Number(it.qty);
        // 源批次剩余（批次行也要锁，防并发消耗）
        const bs = await cx(c, `SELECT remain_qty FROM batches WHERE id=$1 FOR UPDATE`, [it.batch_id]);
        const avail = Number(bs[0]?.remain_qty ?? 0);
        const shipQty = Math.min(need, avail);
        if (shipQty < need && !fromIsHq) {
          throw new BizException(50014, `批次剩余 ${avail}，不足调出 ${need}（门店调拨必须足量，总部仓可缺）`);
        }
        if (shipQty > 0) {
          await cx(c,
            `UPDATE batches SET remain_qty = remain_qty - $2,
                status = CASE WHEN remain_qty - $2 <= 0 THEN '调出' ELSE status END
              WHERE id=$1`, [it.batch_id, shipQty]);
          await cx(c,
            `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
             VALUES ($1,$2,$3,'出库',$4,$5,'transfer_out',$6,$7,$8)`,
            [fromStore, it.product_id, it.batch_id, shipQty, it.unit_cost, id, it.id, user.sub]);
        }
        const short = r3(need - shipQty);
        if (short > 0) {
          // V21：总部仓缺口（inventory_current 全额扣减后转负），生成采购需求
          shortfalls.push({ productId: Number(it.product_id), qty: short, supplierId: it.supplier_id ? Number(it.supplier_id) : null, cost: Number(it.unit_cost) });
          await cx(c, `UPDATE stock_transfer_items SET diff_qty=$2 WHERE id=$1`, [it.id, short]);
        }
        // 调出方即时库存：全额扣减（总部仓可转负 = C 方案「账面欠货」）
        await cx(c, `UPDATE inventory_current SET qty_total = qty_total - $3, updated_at=now()
                      WHERE store_id=$1 AND product_id=$2`, [fromStore, it.product_id, need]);
      }
      // V21-②：缺口自动生成采购需求（集采口径，草稿态由总部采购确认下单）
      let demandPoId: number | null = null;
      if (shortfalls.length) {
        await seqLock(c, 'purchase_orders', 'po_no', `XQ-${today()}-%`);
        const seq = await cx(c, `SELECT count(*)+1 AS n FROM purchase_orders WHERE po_no LIKE $1`, [`XQ-${today()}-%`]);
        const poNo = `XQ-${today()}-${String(seq[0].n).padStart(3, '0')}`;
        // 供应商：取源批次供应商；缺失则取该商品最近一次入库供应商；再缺省取任一在合作供应商
        let supplierId = shortfalls.find(s => s.supplierId)?.supplierId ?? 0;
        if (!supplierId) {
          const sup = await cx(c,
            `SELECT supplier_id FROM batches WHERE product_id=$1 AND supplier_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
            [shortfalls[0].productId]);
          supplierId = Number(sup[0]?.supplier_id ?? 0);
        }
        if (!supplierId) {
          const sup = await cx(c, `SELECT id FROM suppliers ORDER BY id LIMIT 1`);
          supplierId = Number(sup[0]?.id ?? 0);
        }
        if (!supplierId) throw new BizException(40003, '无法确定供应商，请先维护供应商档案');
        const po = await cx(c,
          `INSERT INTO purchase_orders (store_id, po_no, supplier_id, status, source, po_scope, remark, applicant_id)
           VALUES ($1,$2,$3,'草稿','调拨缺口','hq',$4,$5) RETURNING id`,
          [fromStore, poNo, supplierId, `调拨单 ${tr.transfer_no} 自动生成`, user.sub]);
        demandPoId = Number(po[0].id);
        let amt = 0;
        for (const s of shortfalls) {
          const l1 = await cx(c, `SELECT standard_cost FROM products WHERE id=$1`, [s.productId]);
          const price = Number(l1[0]?.standard_cost ?? s.cost);
          await cx(c,
            `INSERT INTO purchase_order_items (po_id, product_id, order_qty, price, line_remark)
             VALUES ($1,$2,$3,$4,$5)`, [demandPoId, s.productId, s.qty, price, '调拨缺口补采']);
          amt += s.qty * price;
        }
        await cx(c, `UPDATE purchase_orders SET total_amount=$2, total_qty=$3 WHERE id=$1`,
          [demandPoId, r2(amt), r3(shortfalls.reduce((s, x) => s + x.qty, 0))]);
      }
      await cx(c, `UPDATE stock_transfers SET status='在途', shipped_at=now(), updated_at=now() WHERE id=$1`, [id]);
      // V4.28.2 P0-5：调拨发货上行（transfer_no 幂等；明细批次为门店本地批次不可复刻 → 总部只落单头）
      await enqueueSync(c, 'stock_transfer', id, {
        transferNo: String(tr.transfer_no), fromStoreId: fromStore, toStoreId: Number(tr.to_store_id) || null,
        status: '在途', reason: tr.reason,
        totalCost: r2(items.reduce((s: number, it: any) => s + Number(it.qty) * Number(it.unit_cost), 0)),
        items: items.map((it: any) => ({ productId: Number(it.product_id), qty: Number(it.qty), unitCost: Number(it.unit_cost) })),
      });
      await this.snapInventory(c, items.map((it: any) => Number(it.product_id)));
      await audit(curStore(), user.sub, '进销存', 'transfer.ship', 'stock_transfer', id,
        { no: tr.transfer_no, shortfall: shortfalls.reduce((s, x) => s + x.qty, 0), demandPoId });
      return { id, status: '在途', shortfallTotal: r3(shortfalls.reduce((s, x) => s + x.qty, 0)), demandPoId };
    });
  }

  /**
   * 收货确认（调入方；在途 → 已入库）：按 §5.5 批次重建规则——
   * 新批次 inbound_date=收货日、保质期沿用源批次、成本不变、血缘承袭 origin_batch_no。
   * 支持部分收货：body.diffs[{itemId, recvQty}] → 差额记 items.diff_qty（差异报损走报损模块，P2 自动化）。
   */
  @RequirePerms('stock.transfer')
  @Post('transfers/:id/receive')
  async receiveTransfer(@Param('id', ParseIntPipe) id: number,
                        @Body() b: { diffs?: { itemId: number; recvQty: number }[] },
                        @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [id]);
      const tr = rs[0];
      if (!tr) throw new BizException(40404, '调拨单不存在', 404);
      if (tr.status !== '在途') throw new BizException(50016, `调拨单状态(${tr.status})不在途，无法收货`);
      const toStore = Number(tr.to_store_id);
      assertStoreAllowed(toStore, '该调拨单的收货方');
      const diffMap = new Map<number, number>((b?.diffs ?? []).map(d => [Number(d.itemId), Number(d.recvQty)]));
      const items = await cx(c,
        `SELECT i.*, p.base_unit, b.production_date, b.expiry_date, b.origin_batch_no, b.supplier_id
           FROM stock_transfer_items i
           JOIN batches b ON b.id = i.batch_id
           JOIN products p ON p.id = i.product_id
          WHERE i.transfer_id=$1 ORDER BY i.id`, [id]);
      if (!items.length) throw new BizException(50016, '调拨单无明细');
      let recvTotal = 0, diffTotal = 0;
      for (const it of items) {
        const want = Number(it.qty);
        const recv = diffMap.has(Number(it.id)) ? r3(Math.max(0, Math.min(want, diffMap.get(Number(it.id))!))) : want;
        const diff = r3(want - recv);
        if (recv > 0) {
          // 批次重建（成本不变；批次号 DB<单号>-<明细id>；收货日入账）
          const nb = await cx(c,
            `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date,
                                  expiry_date, inbound_cost, inbound_qty, remain_qty, status, origin_batch_no)
             VALUES ($9,$1,$2,$3,$4,$5,$6,$7,$8,$8,'在库',$10)
             RETURNING id`,
            [it.product_id, it.supplier_id, `DB${tr.transfer_no}-${it.id}`,
             today(), it.production_date, it.expiry_date, it.unit_cost, recv, toStore, it.origin_batch_no]);
          await cx(c, `UPDATE stock_transfer_items SET recv_qty=$2, diff_qty=$3, recv_batch_id=$4 WHERE id=$1`,
            [it.id, recv, diff, nb[0].id]);
          await cx(c,
            `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
             VALUES ($8,$1,$2,'入库',$3,$4,'transfer_in',$5,$6,$7)`,
            [it.product_id, nb[0].id, recv, it.unit_cost, id, it.id, user.sub, toStore]);
          await cx(c,
            `INSERT INTO inventory_current (store_id, product_id, qty_total, qty_on_order)
             VALUES ($1,$2,$3,0)
             ON CONFLICT (store_id, product_id)
             DO UPDATE SET qty_total = inventory_current.qty_total + $3, updated_at=now()`,
            [toStore, it.product_id, recv]);
          recvTotal += recv;
        } else {
          await cx(c, `UPDATE stock_transfer_items SET recv_qty=0, diff_qty=$2 WHERE id=$1`, [it.id, want]);
        }
        diffTotal += diff;
      }
      await cx(c, `UPDATE stock_transfers SET status='已入库', received_at=now(), audited_by=$2, updated_at=now() WHERE id=$1`,
        [id, user.sub]);
      // V4.28.2 P0-5：收货后库存快照上行（调入方 → 总部 inventory_current）
      await this.snapInventory(c, items.map((it: any) => Number(it.product_id)));
      await audit(curStore(), user.sub, '进销存', 'transfer.receive', 'stock_transfer', id,
        { no: tr.transfer_no, recv: recvTotal, diff: diffTotal });
      return { id, status: '已入库', recvTotal: r3(recvTotal), diffTotal: r3(diffTotal) };
    });
  }

  /** 取消（仅未动库存的状态：待审核 / 待发货 / 驳回） */
  @RequirePerms('stock.transfer.audit')   // V4.28.3 P1-10：取消作废单据，同确认管理权
  @Post('transfers/:id/cancel')
  async cancelTransfer(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE`, [id]);
      const tr = rs[0];
      if (!tr) throw new BizException(40404, '调拨单不存在', 404);
      if (!['待审核', '待发货', '驳回', '待确认'].includes(String(tr.status))) {
        throw new BizException(50016, `调拨单状态(${tr.status})不允许取消`);
      }
      await cx(c, `UPDATE stock_transfers SET status='已取消', updated_at=now() WHERE id=$1`, [id]);
      await audit(curStore(), user.sub, '进销存', 'transfer.cancel', 'stock_transfer', id, { no: tr.transfer_no });
      return { id, status: '已取消' };
    });
  }

  /* ── 私有：FIFO 批次扣减归属 / 出库应用 ── */

  /**
   * FIFO 批次归属：锁定在库批次，按序扣减分配。
   * lossFirst=true 按临期优先（报损）；否则按入库先后（FIFO）。返回 [{batchId, qty, cost}]
   */
  private async fifoAlloc(c: any, productId: number, qty: number, lossFirst: boolean, storeId = 1) {
    const need = r3(qty);
    if (!(need > 0)) throw new BizException(40003, '数量必须大于 0');
    const order = lossFirst ? 'expiry_date, inbound_date' : 'inbound_date, id';
    const batches = await cx(c,
      `SELECT id, remain_qty, inbound_cost FROM batches
        WHERE store_id=$2 AND product_id=$1 AND status='在库' AND remain_qty > 0
        ORDER BY ${order} FOR UPDATE`, [productId, storeId]);
    let avail = 0;
    for (const b of batches) avail += Number(b.remain_qty);
    if (avail < need) throw new BizException(50014, `商品#${productId} 在库批次不足（现有 ${avail}，需 ${need}）`);
    let left = need;
    const allocs: { batchId: number; qty: number; cost: number }[] = [];
    for (const b of batches) {
      if (left <= 0) break;
      const take = r3(Math.min(Number(b.remain_qty), left));
      allocs.push({ batchId: Number(b.id), qty: take, cost: Number(b.inbound_cost) });
      left = r3(left - take);
    }
    return allocs;
  }

  /** 出库应用：扣批次（耗尽置 status）+ 库存流水 + 汇总扣即时库存；返回成本合计 */
  private async applyOutStock(c: any, allocs: { batchId: number; qty: number; cost: number }[],
    refType: string, refId: number, refItemId: number, exhaustedStatus: string, employeeId: number,
    storeId = 1) {
    let total = 0;
    const byProduct = new Map<number, number>();
    for (const a of allocs) {
      total += a.qty * a.cost;
      const pid = await cx(c, `SELECT product_id FROM batches WHERE id=$1`, [a.batchId]);
      const productId = Number(pid[0]?.product_id ?? 0);
      await cx(c,
        `UPDATE batches SET remain_qty = remain_qty - $2,
            status = CASE WHEN remain_qty - $2 <= 0 THEN $3 ELSE status END
          WHERE id=$1`, [a.batchId, a.qty, exhaustedStatus]);
      await cx(c,
        `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
         VALUES ($9,$1,$2,'出库',$3,$4,$5,$6,$7,$8)`,
        [productId, a.batchId, a.qty, a.cost, refType, refId, refItemId, employeeId, storeId]);
      byProduct.set(productId, (byProduct.get(productId) || 0) + a.qty);
    }
    for (const [pid, qty] of byProduct) {
      await cx(c,
        `UPDATE inventory_current SET qty_total = qty_total - $3, updated_at=now()
          WHERE store_id=$1 AND product_id=$2`, [storeId, pid, r3(qty)]);
    }
    return total;
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

@Module({ controllers: [InventoryController] })
export class InventoryModule {}
