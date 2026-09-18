# -*- coding: utf-8 -*-
"""V4.8.16 后端补丁：PriceChangeController 支持进价调价（price_type=cost）"""
import io, sys

P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-初版代码/backend/src/modules/products.module.ts"
src = io.open(P, encoding="utf-8").read()

assert "cost-base" not in src, "补丁已应用，勿重复执行"

OLD = """@Controller('price-changes')
class PriceChangeController {
  /** 调价单列表（V4.8.15） */
  @Get()
  async listPc(@Query('from') from = '', @Query('to') to = '') {
    return q(
      `SELECT pc.*, u.name AS creator_name
         FROM price_changes pc LEFT JOIN employees u ON u.id = pc.created_by
        WHERE ($1 = '' OR pc.created_at >= $1::date)
          AND ($2 = '' OR pc.created_at < $2::date + 1)
        ORDER BY pc.id DESC LIMIT 200`, [from, to],
    );
  }

  /** 调价单详情（含明细与涨跌幅） */
  @Get(':id')
  async pcDetail(@Param('id') id: string) {
    const head = await q1<any>(`SELECT pc.*, u.name AS creator_name FROM price_changes pc LEFT JOIN employees u ON u.id = pc.created_by WHERE pc.id = $1`, [id]);
    if (!head) throw new BizException(40404, '调价单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.barcode, p.base_unit
         FROM price_change_items i JOIN products p ON p.id = i.product_id
        WHERE i.change_id = $1 ORDER BY i.id`, [id],
    );
    return { ...head, items };
  }

  /** 新建调价单：录入即生效（UPDATE sell_price）+ 留痕，权限 pos.price.manual */
  @Post()
  @RequirePerms('pos.price.manual')
  async createPc(@Body() b: { items: { productId: number; newPrice: number }[]; effectiveDate?: string; remark?: string }, @CurrentUser() user: AuthUser) {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '调价明细不能为空');
    if (items.length > 200) throw new BizException(40003, '单笔调价明细最多 200 行');
    const seen = new Set<number>();
    for (const it of items) {
      if (!it.productId || !(Number(it.newPrice) >= 0)) throw new BizException(40003, '明细须含 productId 与非负 newPrice');
      if (seen.has(Number(it.productId))) throw new BizException(40003, '同一商品在单内重复');
      seen.add(Number(it.productId));
    }
    const eff = b.effectiveDate || null;
    const out = await tx(async c => {
      // 锁定商品行，读取旧价
      const ids = items.map(i => Number(i.productId));
      const rows = (await c.query(
        `SELECT id, name, sell_price FROM products WHERE id = ANY($1) FOR UPDATE`, [ids],
      )).rows;
      const byId = new Map(rows.map(r => [Number(r.id), r]));
      for (const it of items) {
        const p = byId.get(Number(it.productId));
        if (!p) throw new BizException(40404, `商品 ${it.productId} 不存在`, 404);
        if (Number(it.newPrice) === Number(p.sell_price)) throw new BizException(40003, `商品「${p.name}」新价与现价相同`);
      }
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const seq = await c.query(`SELECT count(*)+1 AS n FROM price_changes WHERE pc_no LIKE $1`, [`TJ-${ym}-%`]);
      const no = `TJ-${ym}-${String(seq.rows[0].n).padStart(3, '0')}`;
      let diffTotal = 0;
      for (const it of items) diffTotal += Number(it.newPrice) - Number(byId.get(Number(it.productId))!.sell_price);
      const head = await c.query(
        `INSERT INTO price_changes (pc_no, effective_date, remark, item_count, diff_total, created_by)
         VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6) RETURNING id, pc_no`,
        [no, eff, b.remark || '', items.length, diffTotal.toFixed(2), user?.sub ?? null],
      );
      const cid = head.rows[0].id;
      for (const it of items) {
        const p = byId.get(Number(it.productId))!;
        await c.query(
          `INSERT INTO price_change_items (change_id, product_id, old_price, new_price) VALUES ($1,$2,$3,$4)`,
          [cid, it.productId, p.sell_price, it.newPrice],
        );
        await c.query(`UPDATE products SET sell_price = $2 WHERE id = $1`, [it.productId, it.newPrice]);
      }
      return { id: cid, pcNo: head.rows[0].pc_no, itemCount: items.length, diffTotal: Number(diffTotal.toFixed(2)) };
    });
    return out;
  }
}"""

NEW = """@Controller('price-changes')
class PriceChangeController {
  /** 调价单列表（V4.8.16 含类型） */
  @Get()
  async listPc(@Query('from') from = '', @Query('to') to = '', @Query('type') type = '') {
    return q(
      `SELECT pc.*, u.name AS creator_name
         FROM price_changes pc LEFT JOIN employees u ON u.id = pc.created_by
        WHERE ($1 = '' OR pc.created_at >= $1::date)
          AND ($2 = '' OR pc.created_at < $2::date + 1)
          AND ($3 = '' OR pc.price_type = $3)
        ORDER BY pc.id DESC LIMIT 200`, [from, to, type],
    );
  }

  /**
   * 现进价基线查询（V4.8.16 进价调价开单用）：
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

  /** 调价单详情（含明细与涨跌幅） */
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
   * 新建调价单（V4.8.16 双类型）：录入即生效 + 留痕，权限 pos.price.manual
   *  - priceType=sale（默认）：更新 products.sell_price，单号 TJ-
   *  - priceType=cost：落地供应商进价基线（写 supplier_product_prices，
   *    min_price=LEAST(新价, 历史最低)——进价下调即刷新最低价保护线 V4.3.6），单号 JC-
   */
  @Post()
  @RequirePerms('pos.price.manual')
  async createPc(
    @Body() b: { priceType?: string; items: { productId: number; newPrice: number; supplierId?: number }[]; effectiveDate?: string; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const priceType = b.priceType === 'cost' ? 'cost' : 'sale';
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '调价明细不能为空');
    if (items.length > 200) throw new BizException(40003, '单笔调价明细最多 200 行');
    for (const it of items) {
      if (!it.productId || !(Number(it.newPrice) >= 0)) throw new BizException(40003, '明细须含 productId 与非负 newPrice');
    }
    const seen = new Set<string>();
    for (const it of items) {
      const key = priceType === 'cost' ? `${Number(it.productId)}@${Number(it.supplierId ?? 0)}` : `${Number(it.productId)}`;
      if (seen.has(key)) throw new BizException(40003, '同一商品在单内重复');
      seen.add(key);
    }
    const eff = b.effectiveDate || null;
    const prefix = priceType === 'cost' ? 'JC' : 'TJ';
    const out = await tx(async c => {
      // 锁定商品行，读取现价（售价/默认供应商）
      const ids = items.map(i => Number(i.productId));
      const rows = (await c.query(
        `SELECT id, name, sell_price, supplier_default_id FROM products WHERE id = ANY($1) FOR UPDATE`, [ids],
      )).rows;
      const byId = new Map(rows.map(r => [Number(r.id), r]));
      // 进价调价：解析供应商并取旧进价基线
      const costBase = new Map<number, { supplierId: number; oldCost: number }>();
      if (priceType === 'cost') {
        for (const it of items) {
          const p = byId.get(Number(it.productId));
          if (!p) throw new BizException(40404, `商品 ${it.productId} 不存在`, 404);
          const sid = Number(it.supplierId ?? p.supplier_default_id ?? 0);
          if (!sid) throw new BizException(40003, `商品「${p.name}」未设默认供应商，须在明细指定 supplierId`);
          const base = (await c.query(
            `SELECT price FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
            [it.productId, sid],
          )).rows[0];
          costBase.set(Number(it.productId), { supplierId: sid, oldCost: base ? Number(base.price) : 0 });
        }
      }
      for (const it of items) {
        const p = byId.get(Number(it.productId));
        if (!p) throw new BizException(40404, `商品 ${it.productId} 不存在`, 404);
        const cur = priceType === 'cost' ? costBase.get(Number(it.productId))!.oldCost : Number(p.sell_price);
        if (priceType === 'sale' && Number(it.newPrice) === cur) throw new BizException(40003, `商品「${p.name}」新价与现价相同`);
        if (priceType === 'cost' && cur > 0 && Number(it.newPrice) === cur) throw new BizException(40003, `商品「${p.name}」新进价与现进价相同`);
      }
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      const seq = await c.query(`SELECT count(*)+1 AS n FROM price_changes WHERE pc_no LIKE $1`, [`${prefix}-${ym}-%`]);
      const no = `${prefix}-${ym}-${String(seq.rows[0].n).padStart(3, '0')}`;
      let diffTotal = 0;
      for (const it of items) {
        const cur = priceType === 'cost' ? costBase.get(Number(it.productId))!.oldCost : Number(byId.get(Number(it.productId))!.sell_price);
        diffTotal += Number(it.newPrice) - cur;
      }
      const head = await c.query(
        `INSERT INTO price_changes (pc_no, effective_date, remark, item_count, diff_total, created_by, price_type)
         VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7) RETURNING id, pc_no`,
        [no, eff, b.remark || '', items.length, diffTotal.toFixed(2), user?.sub ?? null, priceType],
      );
      const cid = head.rows[0].id;
      for (const it of items) {
        const p = byId.get(Number(it.productId))!;
        const oldPrice = priceType === 'cost' ? costBase.get(Number(it.productId))!.oldCost : Number(p.sell_price);
        const sid = priceType === 'cost' ? costBase.get(Number(it.productId))!.supplierId : null;
        await c.query(
          `INSERT INTO price_change_items (change_id, product_id, supplier_id, old_price, new_price) VALUES ($1,$2,$3,$4,$5)`,
          [cid, it.productId, sid, oldPrice, it.newPrice],
        );
        if (priceType === 'cost') {
          // 进价基线落地 = 调价通知：min_price 同步刷新（进价下调即刷新最低价保护线 V4.3.6）
          await c.query(
            `INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
             VALUES ($1,$2,$3, LEAST($3, COALESCE((SELECT MIN(min_price) FROM supplier_product_prices
                                                    WHERE product_id=$1 AND supplier_id=$2), $3)), $4)`,
            [it.productId, sid, it.newPrice, no],
          );
        } else {
          await c.query(`UPDATE products SET sell_price = $2 WHERE id = $1`, [it.productId, it.newPrice]);
        }
      }
      return { id: cid, pcNo: head.rows[0].pc_no, priceType, itemCount: items.length, diffTotal: Number(diffTotal.toFixed(2)) };
    });
    return out;
  }
}"""

assert OLD in src, "锚点未命中：PriceChangeController 原文不匹配"
src = src.replace(OLD, NEW, 1)

io.open(P, "w", encoding="utf-8", newline="\n").write(src)

# 落地校验
chk = io.open(P, encoding="utf-8").read()
for token in ["cost-base", "price_type", "JC", "supplier_name", "supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)"]:
    assert token in chk, f"校验失败：{token} 未写入磁盘"
assert chk.count("@Controller('price-changes')") == 1
print("OK: 后端补丁已写入并校验通过")
