# -*- coding: utf-8 -*-
"""V4.8.15 后端补丁：products.module.ts 加调价单端点（幂等：目标已存在则跳过）"""
import io, sys

P = 'src/modules/products.module.ts'
s = io.open(P, encoding='utf-8').read()

if 'price-changes' in s:
    print('ALREADY PATCHED'); sys.exit(0)

# 1. import 补 AuthUser/CurrentUser/RequirePerms
OLD_IMP = "import { Module, Controller, Get, Post, Put, Body, Param, Query, ParseIntPipe } from '@nestjs/common';\nimport { q, q1, tx, cx } from '../common/db';\nimport { BizException } from '../common/http';"
NEW_IMP = OLD_IMP + "\nimport { AuthUser, CurrentUser, RequirePerms } from '../common/auth';"
assert s.count(OLD_IMP) == 1
s = s.replace(OLD_IMP, NEW_IMP)

# 2. 在类末尾（文件最后一个大括号前的类结束处）插入端点：以 list 方法后能找到的稳定锚点不好定，直接插在 Controller 类结束前。
#    该文件结构：ProductsController 类 ... 然后 Module 定义。取 "});\n\n@Module" 附近不可靠；用最后一个 "}" 前插入不稳。
#    稳妥锚点：'@Module({' 首次出现之前，定位其前面最近的类结束 "}" —— 直接在 '@Module({' 前插入一个独立 Controller 片段不行（需在类内）。
#    改用：找 '  /** 商品列表' 前面插入？也不稳。最稳：插入到文件级 —— 新增独立 PriceChangeController(@Controller('products')) 放在 @Module 之前，路由同样挂 products 前缀（Nest 支持多个控制器同前缀）。
ANCHOR = '@Module({'
assert s.count(ANCHOR) >= 1
PC = '''@Controller('products')
class PriceChangeController {
  /** 调价单列表（V4.8.15） */
  @Get('price-changes')
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
  @Get('price-changes/:id')
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
  @Post('price-changes')
  @RequirePerms('pos.price.manual')
  async createPc(@Body() b: { items: { productId: number; newPrice: number }[]; effectiveDate?: string; remark?: string }, @CurrentUser() user: AuthUser) {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '调价明细不能为空');
    if (items.length > 200) throw new BizException(40003, '单笔调价明细最多 200 行');
    const seen = new Set<number>();
    for (const it of items) {
      if (!it.productId || !(Number(it.newPrice) >= 0)) throw new BizException(40003, '明细须含 productId 与非负 newPrice');
      if (seen.has(it.productId)) throw new BizException(40003, '同一商品在单内重复');
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
}

@Module({'''
s = s.replace(ANCHOR, PC, 1)

# 3. @Module controllers 数组注册 PriceChangeController
import re
m = re.search(r'controllers:\s*\[([^\]]*)\]', s)
assert m, 'controllers array not found'
inner = m.group(1)
if 'PriceChangeController' not in inner:
    s = s[:m.start(1)] + inner.rstrip() + ', PriceChangeController,' + s[m.end(1):]

io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('PC PATCH OK')
