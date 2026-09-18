# -*- coding: utf-8 -*-
"""V4.8.20 后端补丁：调价单审核流 + 条码模糊搜索"""
import io

B = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-初版代码/backend"

# ── 1. products.module.ts：重写 PriceChangeController（审核流）──
P = B + "/src/modules/products.module.ts"
s = io.open(P, encoding="utf-8").read()
start_marker = "@Controller('price-changes')"
end_marker = "// ─── 组合拆分（V4.8.17）"
i0 = s.index(start_marker)
i1 = s.index(end_marker)

NEW = r"""@Controller('price-changes')
class PriceChangeController {
  /** 调价单列表（V4.8.20 加状态过滤：pending/approved/voided） */
  @Get()
  async listPc(@Query('from') from = '', @Query('to') to = '', @Query('type') type = '', @Query('status') status = '') {
    return q(
      `SELECT pc.*, u.name AS creator_name
         FROM price_changes pc LEFT JOIN employees u ON u.id = pc.created_by
        WHERE ($1 = '' OR pc.created_at >= $1::date)
          AND ($2 = '' OR pc.created_at < $2::date + 1)
          AND ($3 = '' OR pc.price_type = $3)
          AND ($4 = '' OR pc.status = $4)
        ORDER BY pc.id DESC LIMIT 200`, [from, to, type, status],
    );
  }

  /**
   * 现进价基线查询（开单带出现进价）：
   * 逐商品取默认供应商；旧进价 = 该供应商最近一次进价（无历史则 0）
   */
  @Get('cost-base')
  async costBase(@Query('productIds') productIds = '') {
    const ids = productIds.split(',').map(s => Number(s)).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
    if (!ids.length) return { items: [] };
    const rows = await q(
      `SELECT p.id AS product_id, p.name AS product_name, p.barcode, p.base_unit,
              p.supplier_default_id,
              COALESCE((SELECT spp.price FROM supplier_product_prices spp
                         WHERE spp.product_id = p.id
                           AND spp.supplier_id = p.supplier_default_id
                         ORDER BY spp.id DESC LIMIT 1), 0) AS old_cost
         FROM products p
        WHERE p.deleted_at IS NULL AND p.id = ANY($1)`, [ids],
    );
    return { items: rows };
  }

  /** 调价单详情（含明细与双轨价留痕） */
  @Get(':id')
  async pcDetail(@Param('id') id: string) {
    const head = await q1<any>(`SELECT pc.*, u.name AS creator_name FROM price_changes pc LEFT JOIN employees u ON u.id = pc.created_by WHERE pc.id = $1`, [id]);
    if (!head) throw new BizException(40404, '调价单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.barcode, p.base_unit, s.name AS supplier_name
         FROM price_change_items i JOIN products p ON p.id = i.product_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.change_id = $1 ORDER BY i.id`, [id],
    );
    return { ...head, items };
  }

  /**
   * 新建调价单（V4.8.20 重构）：售价/进价可同行（同单）调整，保存=待审核，审核通过才生效
   *  - 行内 newPrice 调售价、newCost 调进价（至少其一）；price_type=sale/cost/dual 按单内容自动推导
   *  - 进价调整须可解析供应商（行 supplierId 或商品默认供应商）
   */
  @Post()
  @RequirePerms('pos.price.manual')
  async createPc(
    @Body() b: { items: { productId: number; newPrice?: number; newCost?: number; supplierId?: number }[]; effectiveDate?: string; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '调价明细不能为空');
    if (items.length > 200) throw new BizException(40003, '单笔调价明细最多 200 行');
    const norm = items.map(it => ({
      productId: Number(it.productId),
      newPrice: it.newPrice === undefined || it.newPrice === null || (it.newPrice as any) === '' ? null : Number(it.newPrice),
      newCost: it.newCost === undefined || it.newCost === null || (it.newCost as any) === '' ? null : Number(it.newCost),
      supplierId: it.supplierId ? Number(it.supplierId) : null,
    }));
    for (const it of norm) {
      if (!it.productId) throw new BizException(40003, '明细须含 productId');
      if (it.newPrice !== null && !(it.newPrice >= 0)) throw new BizException(40003, '新售价须为非负数');
      if (it.newCost !== null && !(it.newCost >= 0)) throw new BizException(40003, '新进价须为非负数');
      if (it.newPrice === null && it.newCost === null) throw new BizException(40003, '明细行须至少填写新售价或新进价其一');
    }
    const seen = new Set<number>();
    for (const it of norm) {
      if (seen.has(it.productId)) throw new BizException(40003, '同一商品在单内重复');
      seen.add(it.productId);
    }
    const hasSale = norm.some(i => i.newPrice !== null);
    const hasCost = norm.some(i => i.newCost !== null);
    const priceType = hasSale && hasCost ? 'dual' : hasCost ? 'cost' : 'sale';
    const eff = b.effectiveDate || null;
    const prefix = hasCost ? 'JC' : 'TJ';
    const out = await tx(async c => {
      const ids = norm.map(i => i.productId);
      const rows = (await c.query(
        `SELECT id, name, sell_price, supplier_default_id FROM products WHERE id = ANY($1) FOR UPDATE`, [ids],
      )).rows;
      const byId = new Map(rows.map(r => [Number(r.id), r]));
      const oldCosts = new Map<number, number>();
      let diffTotal = 0;
      for (const it of norm) {
        const p = byId.get(it.productId);
        if (!p) throw new BizException(40404, `商品 ${it.productId} 不存在`, 404);
        if (it.newCost !== null) {
          const sid = it.supplierId ?? Number(p.supplier_default_id ?? 0);
          if (!sid) throw new BizException(40003, `商品「${p.name}」未设供应商，进价调整须指定 supplierId 或默认供应商`);
          it.supplierId = sid;
          const base = (await c.query(
            `SELECT price FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
            [it.productId, sid],
          )).rows[0];
          const oldCost = base ? Number(base.price) : 0;
          oldCosts.set(it.productId, oldCost);
          if (oldCost > 0 && it.newCost === oldCost) throw new BizException(40003, `商品「${p.name}」新进价与现进价相同`);
          diffTotal += it.newCost - oldCost;
        }
        if (it.newPrice !== null) {
          const oldSale = Number(p.sell_price);
          if (it.newPrice === oldSale) throw new BizException(40003, `商品「${p.name}」新售价与现售价相同`);
          diffTotal += it.newPrice - oldSale;
        }
      }
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const seq = await c.query(`SELECT count(*)+1 AS n FROM price_changes WHERE pc_no LIKE $1`, [`${prefix}-${ym}-%`]);
      const no = `${prefix}-${ym}-${String(seq.rows[0].n).padStart(3, '0')}`;
      const head = await c.query(
        `INSERT INTO price_changes (pc_no, effective_date, remark, item_count, diff_total, created_by, price_type, status)
         VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, 'pending') RETURNING id, pc_no`,
        [no, eff, b.remark || '', norm.length, diffTotal.toFixed(2), user?.sub ?? null, priceType],
      );
      const cid = head.rows[0].id;
      for (const it of norm) {
        const p = byId.get(it.productId)!;
        await c.query(
          `INSERT INTO price_change_items (change_id, product_id, supplier_id, old_price, new_price, old_cost, new_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cid, it.productId,
           it.newCost !== null ? it.supplierId : null,
           it.newPrice !== null ? Number(p.sell_price) : null,
           it.newPrice,
           it.newCost !== null ? (oldCosts.get(it.productId) ?? 0) : null,
           it.newCost],
        );
      }
      return { id: cid, pcNo: head.rows[0].pc_no, priceType, itemCount: norm.length, status: 'pending', diffTotal: Number(diffTotal.toFixed(2)) };
    });
    return out;
  }

  /**
   * 审核调价单（V4.8.20）：待审核 → 生效。
   * 售价更新 products.sell_price；进价落地供应商基线（调价通知：min_price=LEAST 刷新最低价保护线 V4.3.6）
   */
  @Post(':id/approve')
  @RequirePerms('pos.price.manual')
  async approvePc(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const head = (await c.query(`SELECT * FROM price_changes WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!head) throw new BizException(40404, '调价单不存在', 404);
      if (head.status !== 'pending') throw new BizException(40003, `仅待审核单可审核（当前 ${head.status}）`);
      const items = (await c.query(
        `SELECT i.*, p.name AS product_name, p.supplier_default_id
           FROM price_change_items i JOIN products p ON p.id = i.product_id
          WHERE i.change_id = $1 FOR UPDATE`, [id])).rows;
      for (const it of items) {
        if (it.new_cost !== null && it.new_cost !== undefined) {
          const sid = Number(it.supplier_id ?? it.supplier_default_id ?? 0);
          if (!sid) throw new BizException(40003, `商品「${it.product_name}」未设供应商，无法落地进价`);
          await c.query(
            `INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
             VALUES ($1,$2,$3, LEAST($3, COALESCE((SELECT MIN(min_price) FROM supplier_product_prices
                                                  WHERE product_id=$1 AND supplier_id=$2), $3)), $4)`,
            [it.product_id, sid, it.new_cost, head.pc_no],
          );
        }
        if (it.new_price !== null && it.new_price !== undefined) {
          await c.query(`UPDATE products SET sell_price = $2 WHERE id = $1`, [it.product_id, it.new_price]);
        }
      }
      const upd = await c.query(
        `UPDATE price_changes SET status='approved', audited_by=$2, audited_at=now() WHERE id=$1 RETURNING status, audited_at`,
        [id, user?.sub ?? null],
      );
      return { id: Number(id), status: upd.rows[0].status, itemCount: items.length, auditedAt: upd.rows[0].audited_at };
    });
  }

  /** 作废调价单（V4.8.20）：仅待审核可作废；已生效单价格已落地，不可作废 */
  @Post(':id/void')
  @RequirePerms('pos.price.manual')
  async voidPc(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const r = await q1<any>(
      `UPDATE price_changes SET status='voided', voided_by=$2, voided_at=now()
        WHERE id=$1 AND status='pending' RETURNING id, status`, [id, user?.sub ?? null]);
    if (!r) {
      const ex = await q1<any>(`SELECT status FROM price_changes WHERE id=$1`, [id]);
      if (!ex) throw new BizException(40404, '调价单不存在', 404);
      throw new BizException(40003, `仅待审核单可作废（当前 ${ex.status}）`);
    }
    return r;
  }
}

"""
s = s[:i0] + NEW + s[i1:]
assert s.count("@Controller('price-changes')") == 1

# ── 2. 条码模糊搜索：barcode ILIKE（覆盖条码后6位） ──
old_w1 = "AND ($1 = '' OR p.name ILIKE '%'||$1||'%' OR p.pinyin_code ILIKE '%'||$1||'%'\n               OR p.barcode = $1 OR p.goods_no = $1)"
new_w1 = "AND ($1 = '' OR p.name ILIKE '%'||$1||'%' OR p.pinyin_code ILIKE '%'||$1||'%'\n               OR p.barcode = $1 OR p.barcode ILIKE '%'||$1||'%' OR p.goods_no = $1)"
assert old_w1 in s
s = s.replace(old_w1, new_w1, 1)
old_w2 = "AND ($1 = '' OR p.name ILIKE '%'||$1||'%' OR p.pinyin_code ILIKE '%'||$1||'%' OR p.barcode=$1 OR p.goods_no=$1)"
new_w2 = "AND ($1 = '' OR p.name ILIKE '%'||$1||'%' OR p.pinyin_code ILIKE '%'||$1||'%' OR p.barcode=$1 OR p.barcode ILIKE '%'||$1||'%' OR p.goods_no=$1)"
assert old_w2 in s
s = s.replace(old_w2, new_w2, 1)

io.open(P, "w", encoding="utf-8", newline="\n").write(s)
chk = io.open(P, encoding="utf-8").read()
for k in ("approvePc", "voidPc", "price_type = 'dual'".replace("'dual'", "'dual'"), "barcode ILIKE"):
    assert k in chk, k
print("OK: products.module.ts 审核流控制器 + 条码模糊搜索已写入")
