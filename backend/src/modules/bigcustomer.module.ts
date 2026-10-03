import { Module, Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, r2, r3, r4, audit, seqLock } from '../common/db';
import { consumeBatches } from './sales.fifo';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { saveBase64Image } from './sign';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价
import { enqueueSync } from '../common/outbox';       // V5.0.0 P3-1 团购单上行总部

// ─── Controller（大客户与团购销售，方案 5.10 / M9） ───
//   档案 big_customers + 专属价目 big_customer_prices + 团购下单（channel='大客户团购'）
//   应收口径：团购单应付合计 − 现结实收 − 回款登记；账龄按赊账单逐单冲抵
//   V5.0.0 P3-1：连锁模式专属价定价权归总部（门店设价 → 走「价申请」审批）；提货仍在门店；
//                计价兜底顺序 专价 → 批发价(products.wholesale_price) → 零售价；团购单随单上行总部对账
@Controller('big-customers')
class BigCustomerController {

  /** 客户档案列表（含应收聚合；keyword：名称/联系人/电话） */
  @Get()
  async list(
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
  ) {
    const kw = (keyword || '').trim();
    return q(
      `SELECT bc.*,
              (SELECT MAX(so.created_at) FROM sales_orders so WHERE so.big_customer_id = bc.id) AS last_order_at,
              (SELECT count(*) FROM sales_orders so
                WHERE so.big_customer_id = bc.id AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款'))::int AS order_count,
              ROUND(COALESCE((
                SELECT SUM(so.payable_amount) FROM sales_orders so
                 WHERE so.big_customer_id = bc.id AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')),0),2) AS total_receivable,
              ROUND(COALESCE((
                SELECT SUM(sp.amount) FROM sale_payments sp
                 JOIN sales_orders so ON so.id = sp.order_id
                WHERE so.big_customer_id = bc.id AND so.channel='大客户团购' AND sp.channel <> '赊账'),0),2) AS paid_cash,
              ROUND(COALESCE((
                SELECT SUM(bp.amount) FROM big_customer_payments bp WHERE bp.customer_id = bc.id),0),2) AS paid_collect
         FROM big_customers bc
        WHERE ($1 = '' OR bc.name ILIKE '%'||$1||'%' OR bc.contact ILIKE '%'||$1||'%' OR bc.phone = $1)
          AND ($2::smallint IS NULL OR bc.status = $2::smallint)
        ORDER BY bc.status DESC, bc.id DESC
        LIMIT 200`, [kw, status ? Number(status) : null],
    );
  }

  /** V5.0.2 删除大客户（客户详情弹窗内，条件显示）：
   *  ① 未产生业务（无团购单，含结算金额为 0）可直接删；
   *  ② 已停用且最近业务超过 90 天（3 个月）的可删。
   *  历史业务单据/资金流水审计保留在 sales_orders/sale_payments（不随删），
   *  仅客户档案、专属价、价目申请、预充值/回款流水随之清除（价目与资金流水为级联）。 */
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const bc = await q1(`SELECT * FROM big_customers WHERE id=$1`, [id]);
    if (!bc) throw new BizException(40404, '客户不存在', 404);
    const st = await q1<{ n: string; last_at: string }>(
      `SELECT count(*)::int AS n, MAX(created_at) AS last_at FROM sales_orders WHERE big_customer_id=$1`, [id]);
    const n = Number(st?.n || 0);
    const lastAt = st?.last_at ? new Date(st.last_at) : null;
    const idle90 = !lastAt || (Date.now() - lastAt.getTime()) > 90 * 86400000;
    if (n > 0 && !(Number(bc.status) === 0 && idle90)) {
      throw new BizException(40003, '删除条件：未产生任何业务；或已停用且最近业务超过 90 天');
    }
    await audit(user.storeId, user.sub, '大客户', 'bigcustomer.delete', 'big_customer', id,
      { name: bc.name, orderCount: n });
    return tx(async c => {
      await cx(c, `DELETE FROM bc_price_requests WHERE customer_id=$1`, [id]);
      await cx(c, `DELETE FROM big_customers WHERE id=$1`, [id]);
      return { ok: true };
    });
  }

  /** 建档（name 必填；defaultDiscount 0.5~1；creditLimit 赊账额度） */
  @Post()
  @RequirePerms('bigcustomer.manage')
  async create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    const name = String(dto.name || '').trim();
    if (!name) throw new BizException(40003, '客户名称必填');
    const discount = dto.defaultDiscount === undefined ? 1 : Number(dto.defaultDiscount);
    if (!(discount > 0 && discount <= 1)) throw new BizException(40003, '整单折扣需在 0.01~1 之间');
    // VQA-GAP04：可见范围——'store'（默认，仅建档店）| 'all'（全门店可见可挂）| [门店id]（部分可见）；额度与编辑权仍归建档店
    let scopeJson = '"store"';
    if (dto.shareScope === 'all') scopeJson = '"all"';
    else if (Array.isArray(dto.shareScope) && dto.shareScope.length) {
      const ids = dto.shareScope.map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
      if (!ids.length) throw new BizException(40003, 'shareScope 门店 id 非法');
      scopeJson = JSON.stringify(ids);
    }
    else if (dto.shareScope !== undefined && dto.shareScope !== 'store')
      throw new BizException(40003, 'shareScope 须为 store / all / 门店id数组');
    const r = await q1(
      `INSERT INTO big_customers (store_id, name, contact, phone, credit_limit, default_discount, status, share_scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
      [user.storeId, name, dto.contact ?? null, dto.phone ?? null,
       dto.creditLimit === undefined ? 0 : Number(dto.creditLimit), discount, dto.status === 0 ? 0 : 1, scopeJson]);
    await audit(user.storeId, user.sub, 'bigcustomer', 'create', 'big_customer', r.id, { name });
    return { id: r.id, name };
  }

  /** 改档案（含启停） */
  @Put(':id')
  @RequirePerms('bigcustomer.manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    const cur = await q1(`SELECT * FROM big_customers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '客户不存在');
    const name = dto.name !== undefined ? String(dto.name).trim() : cur.name;
    if (!name) throw new BizException(40003, '客户名称不能为空');
    const discount = dto.defaultDiscount !== undefined ? Number(dto.defaultDiscount) : Number(cur.default_discount);
    if (!(discount > 0 && discount <= 1)) throw new BizException(40003, '整单折扣需在 0.01~1 之间');
    let scopeUpd = '';
    const scopeArgs: string[] = [];
    if (dto.shareScope !== undefined) {
      if (dto.shareScope === 'all') { scopeUpd = `, share_scope=$9`; scopeArgs.push('"all"'); }
      else if (dto.shareScope === 'store') { scopeUpd = `, share_scope=$9`; scopeArgs.push('"store"'); }
      else if (Array.isArray(dto.shareScope) && dto.shareScope.length) {
        const ids = dto.shareScope.map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
        if (!ids.length) throw new BizException(40003, 'shareScope 门店 id 非法');
        scopeUpd = `, share_scope=$9`; scopeArgs.push(JSON.stringify(ids));
      }
      else throw new BizException(40003, 'shareScope 须为 store / all / 门店id数组');
    }
    const r = await q1(
      `UPDATE big_customers SET name=$3, contact=$4, phone=$5, credit_limit=$6, default_discount=$7,
              status=$8${scopeUpd} WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId, name,
       dto.contact !== undefined ? dto.contact : cur.contact,
       dto.phone !== undefined ? dto.phone : cur.phone,
       dto.creditLimit !== undefined ? Number(dto.creditLimit) : Number(cur.credit_limit),
       discount, dto.status !== undefined ? Number(dto.status) : Number(cur.status), ...scopeArgs]);
    await audit(user.storeId, user.sub, 'bigcustomer', 'update', 'big_customer', id, { name });
    return { id: r.id };
  }

  /** 专属价目（当前生效：valid_from ≤ 今天 ≤ valid_to，同商品取最新 valid_from） */
  @Get(':id/prices')
  async prices(@Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT id FROM big_customers WHERE id=$1`, [id]);
    if (!cur) throw new BizException(40400, '客户不存在');
    const rows = await q(
      `SELECT bp.id, bp.product_id, p.name, p.barcode, p.goods_no, p.base_unit,
              p.sell_price, bp.price, bp.valid_from, bp.valid_to
         FROM big_customer_prices bp
         JOIN products p ON p.id = bp.product_id
        WHERE bp.customer_id = $1 AND bp.valid_from <= CURRENT_DATE
          AND (bp.valid_to IS NULL OR bp.valid_to >= CURRENT_DATE)
          AND p.deleted_at IS NULL
        ORDER BY bp.valid_from DESC, p.id`, [id]);
    return { count: rows.length, items: rows };
  }

  /** 批量设价（按 productId upsert 当前生效期；price<=0 或 validTo<今天 视为移除）
   *  P3-1：连锁模式下门店禁止直设（定价权归总部）→ 走 POST /bc-price-requests 申请 */
  @Put(':id/prices')
  @RequirePerms('bigcustomer.manage')
  async savePrices(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { items: { productId: number; price: number; validTo?: string }[] },
  ) {
    const { chainEnabled, isHqStore } = await import('../common/scope');
    if (await chainEnabled() && !(await isHqStore(user.storeId))) {
      throw new BizException(40300, '连锁模式下专属价由总部统一管理，请改走「价申请」提交总部审批', 403);
    }
    const cur = await q1(`SELECT id FROM big_customers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '客户不存在');
    const items = Array.isArray(dto.items) ? dto.items : [];
    if (!items.length) throw new BizException(40003, '至少一条设价记录');
    let upserted = 0, removed = 0;
    for (const it of items) {
      const pid = Number(it.productId);
      const price = Number(it.price);
      if (!pid || !(price > 0)) throw new BizException(40003, `商品 ${pid || ''} 价格必须大于 0`);
      // 校验商品存在
      const p = await q1(`SELECT id, sell_price FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
      if (!p) throw new BizException(40400, `商品 ${pid} 不存在`);
      if (price > Number(p.sell_price) * 1.2) {
        throw new BizException(40003, `专价 ${price} 高于零售价 ${p.sell_price} 的 1.2 倍，请核对`);
      }
      // 同商品同日生效期 upsert；已有未来生效期则顺延至次日避免唯一键冲突
      const exist = await q1(
        `SELECT id, valid_from FROM big_customer_prices
          WHERE customer_id=$1 AND product_id=$2 AND valid_from <= CURRENT_DATE
            AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) ORDER BY valid_from DESC LIMIT 1`, [id, pid]);
      let vf: any = exist?.valid_from ?? null;
      if (!vf) {
        const nx = await q1(
          `SELECT MAX(valid_from) + 1 AS vf FROM big_customer_prices WHERE customer_id=$1 AND product_id=$2`, [id, pid]);
        vf = nx?.vf ?? new Date();
      }
      const r = await q1(
        `INSERT INTO big_customer_prices (customer_id, product_id, price, valid_from, valid_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (customer_id, product_id, valid_from) DO UPDATE SET price=EXCLUDED.price, valid_to=EXCLUDED.valid_to
         RETURNING id`,
        [id, pid, price, vf, it.validTo || null, user.sub]);
      if (r) upserted++;
      // 移除旧生效行（同一商品，日期早于新行的非当前行由 valid_to 自然失效，无需物理删除）
    }
    await audit(user.storeId, user.sub, 'bigcustomer', 'prices', 'big_customer', id, { upserted, removed });
    return { upserted, removed };
  }

  /** 应收总览（老板看板提醒）：全店大客户未收合计 + 超90天 + 高危客户 TOP */
  @Get('receivables-overview')
  async receivablesOverview() {
    const rows = await q(
      `SELECT bc.id, bc.name, bc.credit_limit,
              COALESCE((SELECT SUM(so.payable_amount) FROM sales_orders so
                         WHERE so.big_customer_id=bc.id AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')),0) AS receivable,
              COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp
                         JOIN sales_orders so ON so.id=sp.order_id
                        WHERE so.big_customer_id=bc.id AND so.channel='大客户团购' AND sp.channel<>'赊账'),0) AS paid_cash,
              COALESCE((SELECT SUM(bp.amount) FROM big_customer_payments bp WHERE bp.customer_id=bc.id),0) AS paid_collect
         FROM big_customers bc WHERE bc.status=1`);
    let totalUnpaid = 0, unpaid90 = 0;
    const perCust = [];
    // 决策③(A2a)：应收汇总与 90 天账龄一律整数分累加
    let totalUnpaidC = 0, unpaid90C = 0;
    for (const r of rows) {
      const unpaidC = Math.max(0, Math.round(Number(r.receivable) * 100) - Math.round(Number(r.paid_cash) * 100) - Math.round(Number(r.paid_collect) * 100));
      if (unpaidC <= 0) continue;
      totalUnpaidC += unpaidC;
      const unpaid = unpaidC / 100;
      // 超 90 天金额：与台账同口径（赊账单逐单冲抵后按 created_at 分段）
      const creditOrders = await q(
        `SELECT so.created_at, so.payable_amount,
                COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp
                           WHERE sp.order_id=so.id AND sp.channel <> '赊账'),0) AS paid_now
           FROM sales_orders so
          WHERE so.big_customer_id=$1 AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')
            AND EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.order_id=so.id AND sp.channel='赊账')
          ORDER BY so.created_at`, [r.id]);
      let remainC = unpaidC, o90C = 0;
      const cutoff = Date.now() - 90 * 86400000;
      for (const o of creditOrders) {
        const orderUnpaidC = Math.round(Number(o.payable_amount) * 100) - Math.round(Number(o.paid_now) * 100);
        if (orderUnpaidC <= 0) continue;
        const matchedC = Math.min(orderUnpaidC, remainC);
        if (new Date(o.created_at).getTime() < cutoff) o90C += matchedC;
        remainC -= matchedC;
      }
      unpaid90C += o90C;
      totalUnpaid = totalUnpaidC / 100; unpaid90 = unpaid90C / 100; // 返回口径不变（元，两位小数）
      perCust.push({ id: r.id, name: r.name, unpaid, over90: o90C / 100 });
    }
    return {
      totalUnpaid, unpaid90, unpaidCustomers: perCust.length,
      top: perCust.sort((a, b) => b.unpaid - a.unpaid).slice(0, 5),
    };
  }

  /** 应收台账：汇总 + 账龄 + 未清赊账单 + 回款记录 */
  @Get(':id/receivables')
  async receivables(@Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT bc.* FROM big_customers bc WHERE bc.id=$1`, [id]);
    if (!cur) throw new BizException(40400, '客户不存在');

    // 团购单（应付合计 / 现结实收）
    const agg = await q1(
      `SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(so.payable_amount),0) AS total_receivable,
              COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp
                         JOIN sales_orders so2 ON so2.id = sp.order_id
                        WHERE so2.big_customer_id=$1 AND so2.channel='大客户团购' AND sp.channel <> '赊账'),0) AS paid_cash
         FROM sales_orders so
        WHERE so.big_customer_id=$1 AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')`, [id]);
    const paidCollect = await q1(
      `SELECT COALESCE(SUM(amount),0) AS s FROM big_customer_payments WHERE customer_id=$1`, [id]);
    const totalReceivable = r2(Number(agg?.total_receivable ?? 0));
    const paidNow = r2(Number(agg?.paid_cash ?? 0));
    const received = r2(paidNow + Number(paidCollect?.s ?? 0));
    const unpaid = Math.max(0, r2(totalReceivable - received));

    // 未清赊账单（created_at 升序；回款按先进先出逐单冲抵 → 账龄分段）
    const creditOrders = await q(
      `SELECT so.id, so.order_no, so.created_at, so.payable_amount,
              COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp
                         WHERE sp.order_id=so.id AND sp.channel <> '赊账'),0) AS paid_now
         FROM sales_orders so
        WHERE so.big_customer_id=$1 AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')
          AND EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.order_id=so.id AND sp.channel='赊账')
        ORDER BY so.created_at`, [id]);
    const aging = [
      { bucket: '≤30天', amount: 0 }, { bucket: '31~60天', amount: 0 },
      { bucket: '61~90天', amount: 0 }, { bucket: '>90天', amount: 0 },
    ];
    const unpaidOrders = [];
    // 决策③(A2b)：账龄桶整数分冲抵累加（Σ桶 == 被冲抵应收，不再逐笔 r2 漂移）
    const agingC = [0, 0, 0, 0];
    let remainCollect = Math.round(unpaid * 100); // 尚未被回款/现结冲抵的金额（分）
    const today = new Date();
    for (const o of creditOrders) {
      const orderUnpaid = Math.round(Number(o.payable_amount) * 100) - Math.round(Number(o.paid_now) * 100);
      if (orderUnpaid <= 0) continue;
      const matched = Math.min(orderUnpaid, remainCollect); // 本次冲抵金额（分；含现结与回款累计口径）
      const days = Math.floor((today.getTime() - new Date(o.created_at).getTime()) / 86400000);
      const idx = days > 90 ? 3 : days > 60 ? 2 : days > 30 ? 1 : 0;
      agingC[idx] += matched;
      unpaidOrders.push({ orderNo: o.order_no, date: o.created_at, amount: matched / 100 });
      remainCollect -= matched;
    }

    aging.forEach((a: any, i: number) => { a.amount = agingC[i] / 100; }); // 决策③(A2b)：分桶整数分回填
    const payments = await q(
      `SELECT bp.*, e.name AS operator_name FROM big_customer_payments bp
        LEFT JOIN employees e ON e.id = bp.operator_id
       WHERE bp.customer_id=$1 ORDER BY bp.created_at DESC LIMIT 50`, [id]);

    const creditLimit = Number(cur.credit_limit);
    return {
      summary: {
        orderCount: agg?.order_count ?? 0,
        totalReceivable, paidCash: paidNow, paidCollect: r2(Number(paidCollect?.s ?? 0)),
        received, unpaid, creditLimit,
        limitUsed: creditLimit > 0 ? Math.min(100, Math.round(unpaid / creditLimit * 100)) : 0,
      },
      aging: aging.filter(a => a.amount > 0).length ? aging : [{ bucket: '≤30天', amount: 0 }],
      unpaidOrders: unpaidOrders.slice(0, 100),
      payments,
    };
  }

  /** 回款登记（赊账到账；amount 计入已收） */
  @Post(':id/collect')
  @RequirePerms('bigcustomer.manage')
  async collect(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { amount: number; method?: string; remark?: string },
  ) {
    const cur = await q1(`SELECT id FROM big_customers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '客户不存在');
    const amount = Number(dto.amount);
    if (!(amount > 0)) throw new BizException(40003, '回款金额必须大于 0');
    const r = await q1(
      `INSERT INTO big_customer_payments (customer_id, amount, method, remark, operator_id, kind)
       VALUES ($1,$2,$3,$4,$5,'collect') RETURNING id`,
      [id, amount, dto.method || '现金', dto.remark ?? null, user.sub]);
    await audit(user.storeId, user.sub, 'bigcustomer', 'collect', 'big_customer', id, { amount });
    return { id: r.id, amount };
  }

  /** 预充值（V4.14.0 C2：先存后用；记入 big_customer_payments，同时累加客户余额） */
  @Post(':id/recharge')
  @RequirePerms('bigcustomer.manage')
  async recharge(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { amount: number; method?: string; remark?: string },
  ) {
    const cur = await q1(`SELECT id FROM big_customers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '客户不存在');
    const amount = Number(dto.amount);
    if (!(amount > 0)) throw new BizException(40003, '充值金额必须大于 0');
    return tx(async c => {
      await cx(c, `SELECT id FROM big_customers WHERE id=$1 FOR UPDATE`, [id]);
      await cx(c,
        `INSERT INTO big_customer_payments (customer_id, amount, method, remark, operator_id, kind)
         VALUES ($1,$2,$3,$4,$5,'recharge')`, [id, amount, dto.method || '现金', dto.remark || '预充值', user.sub]);
      const r = await cx(c,
        `UPDATE big_customers SET balance = COALESCE(balance,0) + $2 WHERE id=$1 RETURNING balance`, [id, amount]);
      await audit(user.storeId, user.sub, 'bigcustomer', 'recharge', 'big_customer', id, { amount, method: dto.method || '现金' });
      return { balance: Number(r[0].balance), amount };
    });
  }

  /** V5.0.2 预充值明细（「充值明细」页签）：kind='recharge' 的资金流水，keyword 匹配方式/备注 */
  @Get(':id/recharges')
  async recharges(
    @Param('id', ParseIntPipe) id: number,
    @Query('keyword') keyword?: string,
  ) {
    const kw = (keyword || '').trim();
    return q(
      `SELECT bp.id, bp.amount, bp.method, bp.remark, bp.created_at, e.name AS operator_name
         FROM big_customer_payments bp LEFT JOIN employees e ON e.id = bp.operator_id
        WHERE bp.customer_id = $1 AND bp.kind = 'recharge'
          AND ($2 = '' OR bp.method ILIKE '%'||$2||'%' OR bp.remark ILIKE '%'||$2||'%')
        ORDER BY bp.id DESC LIMIT 200`, [id, kw]);
  }

  /** 业务电子签字（V4.14.0 C1：大客户业务/联系人，同供应商预采方式；base64 PNG 存档，业务单据留痕引用） */
  @Post(':id/signature')
  @RequirePerms('bigcustomer.manage')
  async saveSignature(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { signature?: string },
  ) {
    if (!b.signature) throw new BizException(40003, '需采集大客户业务/联系人电子签字');
    const cust = await q1(`SELECT id, name FROM big_customers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cust) throw new BizException(40400, '客户不存在');
    const path = saveBase64Image(b.signature);
    await q(`UPDATE big_customers SET signature_path=$2 WHERE id=$1`, [id, path]);
    await audit(user.storeId, user.sub, 'bigcustomer', 'signature', 'big_customer', id, { path });
    return { signaturePath: path };
  }

  /** 团购下单：专属价（无则零售价）→ 行合计 → 整单折扣 → FIFO 扣库存 → 赊账/现结/预存余额 */
  @Post(':id/order')
  @RequirePerms('bigcustomer.manage')
  async placeOrder(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { items: { productId: number; qty: number }[]; payChannel?: string; remark?: string },
  ) {
    const cust = await q1(`SELECT * FROM big_customers WHERE id=$1 AND (store_id=$2
          OR share_scope #>> '{}' = 'all' OR (jsonb_typeof(share_scope)='array' AND share_scope ? $2::text))`, [id, user.storeId]);
    if (!cust) throw new BizException(40400, '客户不存在');
    if (Number(cust.status) !== 1) throw new BizException(40003, '客户已停用，无法下单');
    const items = Array.isArray(dto.items) ? dto.items : [];
    if (!items.length) throw new BizException(40003, '至少一件商品');
    const payChannel = dto.payChannel || '赊账';
    const allowedPay = ['赊账', '现金', '微信', '支付宝', '转账', '预存余额'];
    if (!allowedPay.includes(payChannel)) throw new BizException(40003, `支付方式须为：${allowedPay.join('/')}`);
    const discount = Number(cust.default_discount) || 1;

    return tx(async c => {
      // VQA-P0（M5-11）：赊账/预存先锁客户行——同客户并发下单的额度校验必须串行，否则双双读到旧应收突破 credit_limit💰
      if (payChannel === '赊账' || payChannel === '预存余额')
        await cx(c, `SELECT 1 FROM big_customers WHERE id=$1 FOR UPDATE`, [id]);
      // VQA-P0（M5-06 / GAP-03）：操作人=受益人核验——挂账客户的联系电话/联系人与登录员工一致时拦截（留痕，需他人代办）
      if (payChannel === '赊账') {
        const emp = await cx(c, `SELECT phone, name FROM employees WHERE id=$1`, [user.sub]);
        const e = emp[0];
        if (e && ((e.phone && cust.phone && String(e.phone) === String(cust.phone))
          || (e.name && cust.contact && String(e.name) === String(cust.contact)))) {
          await audit(user.storeId, user.sub, 'bigcustomer', '挂账受益人拦截', 'big_customer', id, { operator: e.name, custPhone: cust.phone, custContact: cust.contact });
          throw new BizException(40308, '挂账操作人与客户联系电话/联系人名一致（操作人=受益人），须由他人代办', 403);
        }
      }
      // 客户应收上限（赊账时校验赊账额度）
      const agg = await cx(c,
        `SELECT COALESCE(SUM(so.payable_amount),0) AS total_receivable,
                COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp
                           JOIN sales_orders so2 ON so2.id=sp.order_id
                          WHERE so2.big_customer_id=$1 AND so2.channel='大客户团购' AND sp.channel<>'赊账'),0) AS paid_cash
           FROM sales_orders so
          WHERE so.big_customer_id=$1 AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')`, [id]);
      const paidCollect = await cx(c,
        `SELECT COALESCE(SUM(amount),0) AS s FROM big_customer_payments WHERE customer_id=$1`, [id]);
      const unpaidBefore = r2(Number(agg[0]?.total_receivable ?? 0) - Number(agg[0]?.paid_cash ?? 0) - Number(paidCollect[0]?.s ?? 0));

      // 逐行：专价/零售价 + FIFO 批次分配（行锁防超卖）
      const lines = [];
      let goodsAmount = 0, costTotal = 0, discountTotal = 0;
      for (const it of items) {
        const pid = Number(it.productId);
        const qty = r3(Number(it.qty));
        if (!pid || !(qty > 0)) throw new BizException(40003, `商品 ${pid || ''} 数量无效`);
        const p = await cx(c, `SELECT * FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
        if (!p.length) throw new BizException(40400, `商品 ${pid} 不存在`);
        const prod = p[0];
        await storePrice.overlayOne(user.storeId, prod);   // V4.26.5 大客户结算原价按门店
        // P3-1 计价兜底：专属价 → 批发价（总部统一维护，>0 且低于零售才生效）→ 零售价
        const sp = await cx(c,
          `SELECT price FROM big_customer_prices
            WHERE customer_id=$1 AND product_id=$2 AND valid_from <= CURRENT_DATE
              AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
            ORDER BY valid_from DESC LIMIT 1`, [id, pid]);
        const hasSpecial = sp.length > 0;
        const wp = Number((prod as any).wholesale_price ?? 0);
        const unitPrice = r2(hasSpecial ? Number(sp[0].price)
          : (wp > 0 && wp < Number(prod.sell_price) ? wp : Number(prod.sell_price)));
        const originPrice = r2(Number(prod.sell_price));
        const lineAmount = r2(qty * unitPrice);
        // 防双重折扣：已有专属价/批发价的行不再叠加整单折扣，整单折扣只作用于按零售价的行
        const linePayable = r2((hasSpecial || unitPrice < originPrice) ? lineAmount : lineAmount * discount);
        const allocs = [];
        let lineCost = 0;
        if (prod.track_inventory) {
          const batches = await cx(c,
            `SELECT id, batch_no, remain_qty, inbound_cost FROM batches
              WHERE store_id=$1 AND product_id=$2 AND status='在库' AND remain_qty > 0
              ORDER BY expiry_date, inbound_date FOR UPDATE`, [user.storeId, pid]);
          let totalAvail = 0;
          for (const b of batches) totalAvail += Number(b.remain_qty);
          if (totalAvail < qty) throw new BizException(50001, `${prod.name} 库存不足（现有 ${totalAvail}，需 ${qty}）`);
          let need = qty;
          for (const b of batches) {
            if (need <= 0) break;
            const take = Math.min(Number(b.remain_qty), need);
            allocs.push({ batchId: b.id, batchNo: b.batch_no, qty: r3(take), cost: Number(b.inbound_cost) });
            lineCost += take * Number(b.inbound_cost);
            need = r3(need - take);
          }
        } else {
          const last = await cx(c,
            `SELECT unit_cost FROM inbound_order_items WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [pid]);
          lineCost = qty * (last.length ? Number(last[0].unit_cost) : 0);
        }
        lineCost = r2(lineCost);
        goodsAmount = r2(goodsAmount + lineAmount);
        costTotal = r2(costTotal + lineCost);
        discountTotal = r2(discountTotal + (lineAmount - linePayable));
        lines.push({ prod, qty, unitPrice, originPrice, lineAmount, lineCost, allocs });
      }

      const payable = r2(goodsAmount - discountTotal);
      if (payChannel === '赊账' && Number(cust.credit_limit) > 0 && unpaidBefore + payable > Number(cust.credit_limit)) {
        throw new BizException(50035, `赊账超额度：未收 ${unpaidBefore} + 本次 ${payable} > 额度 ${cust.credit_limit}`);
      }
      // V4.14.0 C2：预存余额支付——先锁行校验余额、后扣减（防并发双花）
      if (payChannel === '预存余额') {
        const cur = await cx(c, `SELECT balance FROM big_customers WHERE id=$1 FOR UPDATE`, [id]);
        if (Number(cur[0]?.balance ?? 0) < payable)
          throw new BizException(50035, `预存余额不足：余额 ${cur[0]?.balance ?? 0} < 应付 ${payable}（可先「预充值」）`);
      }
      const profit = r2(payable - costTotal);

      // 单号 + 主单
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      await seqLock(c, 'sales_orders', 'order_no', `TD-${ymd}-%`);
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM sales_orders WHERE order_no LIKE $1`, [`TD-${ymd}-%`]);
      const orderNo = `TD-${ymd}-${String(seq[0].n).padStart(4, '0')}`;
      const order = await cx(c,
        `INSERT INTO sales_orders (store_id, order_no, channel, member_id, big_customer_id, cashier_id, status,
                                   goods_amount, promo_amount, coupon_amount, payable_amount, cost_amount,
                                   profit_amount, member_discount, round_amount, remark, customer_name)
         VALUES ($1,$2,'大客户团购',NULL,$3,$4,'已完成',$5,$6,0,$7,$8,$9,0,0,$10,$11) RETURNING id`,
        [user.storeId, orderNo, id, user.sub, goodsAmount, discountTotal, payable, costTotal, profit,
         dto.remark ?? null, cust.name]);
      const orderId = order[0].id;

      // 明细 + 批次消耗 + 库存流水
      for (const ln of lines) {
        const item = await cx(c,
          `INSERT INTO sale_items (order_id, product_id, unit_name, qty, unit_price, origin_price,
                                   line_amount, line_cost, line_profit, price_changed, line_remark,
                                   supplier_id, biz_mode)
           VALUES ($1,$2,'基本',$3,$4,$5,$6,$7,$8,true,$9,$10,$11) RETURNING id`,
          [orderId, ln.prod.id, ln.qty, ln.unitPrice, ln.originPrice,
           ln.lineAmount, ln.lineCost, r2(ln.lineAmount - ln.lineCost),
           ln.unitPrice < ln.originPrice ? '团购专价' : '团购', ln.prod.supplier_default_id ?? null, ln.prod.biz_mode ?? '购销']);
        await consumeBatches(c, {
          storeId: user.storeId, productId: ln.prod.id, saleItemId: item[0].id,
          orderId, allocs: ln.allocs, employeeId: user.sub,
        });
        if (ln.prod.track_inventory) {
          await cx(c,
            `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now()
              WHERE store_id=$1 AND product_id=$3`, [user.storeId, ln.qty, ln.prod.id]);
        }
      }

      // 支付：赊账记应收；现结全额实收；预存余额扣减客户余额
      await cx(c,
        `INSERT INTO sale_payments (order_id, channel, amount) VALUES ($1,$2,$3)`,
        [orderId, payChannel, payable]);
      if (payChannel === '预存余额') {
        await cx(c,
          `UPDATE big_customers SET balance = COALESCE(balance,0) - $2 WHERE id=$1`, [id, payable]);
      }

      await audit(user.storeId, user.sub, 'bigcustomer', 'order', 'sales_order', orderId,
        { customerId: id, orderNo, payable, payChannel, items: items.length,
          customerSignature: cust.signature_path ?? null });
      // ── V5.0.0 P3-1：团购单随单上行总部（对账核销数据源；总部/单店节点 no-op 零回归）──
      try {
        await enqueueSync(c as any, 'sale_order', orderId, {
          orderNo, channel: '大客户团购',
          goodsAmount, payable, costAmount: costTotal, profit, roundAmount: 0,
          remark: `大客户团购:${cust.name}`.slice(0, 128),
          createdAt: new Date().toISOString(),
          items: lines.map(ln => ({
            goodsNo: String((ln.prod as any).goods_no ?? ''), barcode: String((ln.prod as any).barcode ?? ''),
            name: (ln.prod as any).name, unitName: '基本', qty: ln.qty,
            unitPrice: ln.unitPrice, originPrice: ln.originPrice,
            lineAmount: ln.lineAmount, lineCost: ln.lineCost,
            batches: ln.allocs.map(a => ({ batchNo: a.batchNo, qty: a.qty, unitCost: a.cost })),
          })),
          payments: [{ channel: payChannel, amount: payable }],
        });
      } catch (e: any) { console.error('[大客户] 上行入队失败（不阻断下单）:', e?.message); }
      const effDiscount = goodsAmount > 0 ? r4(payable / goodsAmount) : 1;
      return { orderId, orderNo, goodsAmount, discount: effDiscount, payable, payChannel,
               customerSignaturePath: cust.signature_path ?? null };
    });
  }
}

@Module({ controllers: [BigCustomerController] })
export class BigCustomerModule { }
