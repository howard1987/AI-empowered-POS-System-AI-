import { Module, Controller, Get, Post, Delete, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { createHash } from 'crypto';
import { q, q1, tx, cx, r2, r3, audit, pool } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { SalesService } from './sales.module';
import { syncMemberLevel } from './members.module';
import { applyPromotions } from './promotions.module';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价：价目表/查价按当前门店
import { PRODUCT_VISIBLE, MIN_PRICE_EXPR, COST_REF } from '../common/sql';       // V5.0.0 商品可售可见性（总部下发 + 门店自建）+ 价格红线（L1 优先）

/**
 * POS 端服务：
 *   T14 应急包（方案 8.5.1 / V4.6.3）：
 *     pricebook           全量价目表下发（收银三要素：条码→名称/规格/售价/会员价/多单位/启停），
 *                         版本 = 全量内容 MD5；每次下发写快照留痕（新鲜度硬闸数据源）
 *     pricebook/freshness 新鲜度：超 pos.pricebook_fresh_hours（默认 72h）→ fresh=false
 *                         → 收银端禁止进入应急模式；服务端应急结账同口径硬闸（50036）
 *   挂单/取单（5.2.3 收银流程，held_orders 表 db/007）：
 *     held                挂单：购物车快照入 held_orders（不扣库存、不产生业务流水）
 *     held/:id/checkout   取单结账一体：按快照重新服务端计价（FIFO 以结账时刻为准），成功后置已取单
 *     held/:id/cancel     取消挂单（留痕，不删除）
 * 缓存正确性三原则（V4.6.9）：全量常备不做按需拉取；刻意不缓存库存与会员资产等易变数据；
 *                       版本哈希比对增量更新——断电断网均可扫码/手输计价
 */
@Controller('pos')
class PosController {
  private settings = new SettingsService();
  private sales = new SalesService();

  // ═══════════ 价目表（T14 应急包） ═══════════

  @Get('pricebook')
  async pricebook(@CurrentUser() user: AuthUser) {
    const items = await q(
      `SELECT p.id,
              p.goods_no AS "goodsNo",
              p.barcode,
              p.name,
              p.spec,
              p.base_unit AS "baseUnit",
              p.is_weighted AS "isWeighted",
              p.sell_price::float8 AS "sellPrice",
              p.member_price::float8 AS "memberPrice",
              /* VQA（DEF-15 配套）：会员价门控值——后端仅 member_discount>0 才启用会员价，前端同口径 */
              p.member_discount::float8 AS "memberDiscount",
              /* V4.18.0 P14 + V4.25.4 + V5.0.0：下发服务端算好的改价/折扣红线价
                 = max(最低卖价线, 标准进价 L1)；最低卖价线 = min_price，未设时按售价 6 成。
                 进价是最终兜底（不得低于进价销售），此处只下发合成后的红线，不单独暴露进价。
                 V5.0.0（R8）：进价口径改为 **L1（products.standard_cost）优先**，
                   为空时回落旧口径（供应商最新报价）→ 存量商品零回归、L1 一旦维护即成为唯一依据。*/
              ${MIN_PRICE_EXPR('p')}::float8 AS "minPrice",
              /* V4.26.5 门店价重算红线的中间量（对外删除，不暴露进价）：minPriceSet=商品级绝对下限，costRef=标准进价 L1 */
              p.min_price::float8 AS "minPriceSet",
              ${COST_REF('p')}::float8 AS "costRef",
              /* V4.25.3：最低折扣率随价目表下发（单品/整单折扣红线，离线可用） */
              p.min_discount_rate::float8 AS "minDiscountRate",
              /* V4.18.0 P14：拼音码随价目表下发（收银台搜索联想 ysx→饮用水，离线可用） */
              p.pinyin_code AS "pinyin",
              p.status,
              p.track_inventory AS "trackInventory",
              p.category_id AS "categoryId",
              /* V4.9.8：价目表补齐「一品多码」全量条码（主码 + 辅助码/称重码 + 包装单位码）。
                 收银端/PWA 离线扫码按全码索引命中，避免仅主码导致辅助码/二维码扫不出。 */
              COALESCE((SELECT json_agg(DISTINCT b.code) FROM (
                          SELECT p.barcode AS code
                           WHERE COALESCE(p.barcode, '') <> ''
                          UNION
                          SELECT pb.barcode FROM product_barcodes pb
                           WHERE pb.product_id = p.id AND COALESCE(pb.barcode, '') <> ''
                          UNION
                          SELECT pu.barcode FROM product_units pu
                           WHERE pu.product_id = p.id AND COALESCE(pu.barcode, '') <> ''
                        ) b), '[]'::json) AS barcodes,
              COALESCE((SELECT json_agg(json_build_object('unitName', u.unit_name, 'rate', u.rate))
                          FROM product_units u WHERE u.product_id = p.id), '[]'::json) AS units
         FROM products p
        WHERE ${PRODUCT_VISIBLE('$1')} AND p.deleted_at IS NULL
          /* V4.18.1 P15：开放键占位商品（barcode='OPENKEY'）不进价目表——临时行在收银台即时手输 */
          AND p.barcode IS DISTINCT FROM 'OPENKEY'
        ORDER BY p.id`, [user.storeId]);
    // V4.26.5 按门店隔离价格：门店有覆盖价则用覆盖价，并据门店价重算红线价（红线下发口径见上）；
    //   未设门店价的商品零改动。中间量 minPriceSet / costRef 用后即删，避免向前端暴露进价。
    const spMap = await storePrice.loadMap(user.storeId);
    if (spMap.size) {
      for (const it of items as any[]) {
        const ov = spMap.get(Number(it.id));
        if (ov) {
          if (!Number.isNaN(ov.sell_price)) it.sellPrice = ov.sell_price;
          if (ov.member_price !== null) it.memberPrice = ov.member_price;
          const minSet = Number(it.minPriceSet) || 0;
          it.minPrice = Math.max(minSet > 0 ? minSet : r2(Number(it.sellPrice) * 0.6), Number(it.costRef) || 0);
        }
        delete it.minPriceSet;
        delete it.costRef;
      }
    } else {
      for (const it of items as any[]) { delete it.minPriceSet; delete it.costRef; }
    }
    const version = createHash('md5').update(JSON.stringify(items)).digest('hex');
    const snap = await q(
      `INSERT INTO pricebook_snapshots (store_id, version, item_count, generated_by)
       VALUES ($1,$2,$3,$4) RETURNING generated_at`,
      [user.storeId, version, items.length, user.sub]);
    // VQA-P0（M8-02）：随价目表下发秤码解析元数据，断网时收银端本地解析生鲜秤码
    let scaleTpl = String(await this.settings.getVal('ai.scale.barcode_format') || '');
    if (scaleTpl === '自定义') scaleTpl = String(await this.settings.getVal('ai.scale.custom_format') || '');
    const scaleVerify = String(await this.settings.getVal('ai.scale.check_verify') || 'on');
    const scaleValidDays = await this.settings.getNum('ai.scale.label_valid_days', 1);
    return { version, generatedAt: snap[0].generated_at, count: items.length, items,
      scale: { tpl: scaleTpl, checkVerify: scaleVerify, validDays: scaleValidDays } };
  }

  @Get('pricebook/freshness')
  async freshness(@CurrentUser() user: AuthUser) {
    const limitHours = await this.settings.getNum('pos.pricebook_fresh_hours', 72);
    const snap = await q1(
      `SELECT version, generated_at FROM pricebook_snapshots
        WHERE store_id=$1 ORDER BY id DESC LIMIT 1`, [user.storeId]);
    if (!snap) {
      return { fresh: false, ageHours: null, limitHours, version: null, generatedAt: null };
    }
    const ageHours = r2((Date.now() - new Date(snap.generated_at).getTime()) / 3600000);
    return { fresh: ageHours <= limitHours, ageHours, limitHours,
             version: snap.version, generatedAt: snap.generated_at };
  }

  // ═══════════ V4.18.0 P14 收银台 ═══════════

  /** 库存实时查询（收银台负库存容错用）：刻意走实时接口而非价目表缓存（缓存正确性三原则：不缓存易变库存）
   *  V5.0.1：口径对齐结账权威——改按 batches(status='在库') 实时余量合计（与销售 FIFO 扣减同源）。
   *  此前读 inventory_current 汇总表，两表不同步时前台显示「仅剩 2」、结账却报「现有 0」。 */
  @RequirePerms('pos.sell')
  @Get('stock')
  async stock(@Query('ids') ids: string, @CurrentUser() user: AuthUser) {
    const idList = String(ids || '').split(',').map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0).slice(0, 500);
    if (!idList.length) return { items: [] };
    const rows = await q(
      `SELECT product_id AS "productId", COALESCE(SUM(remain_qty), 0)::float8 AS "stockQty"
         FROM batches WHERE store_id=$1 AND status='在库' AND product_id = ANY($2::bigint[])
        GROUP BY product_id`,
      [user.storeId, idList]);
    return { items: rows };
  }

  /** V4.18.1 P15 重复上一单：本收银员最近一笔已完成订单的行快照（一键重上车） */
  @RequirePerms('pos.sell')
  @Get('last-order')
  async lastOrder(@CurrentUser() user: AuthUser) {
    const o = await q1(
      `SELECT id, order_no, member_id, created_at, channel, payable_amount::float8 AS "payable"
         FROM sales_orders
        WHERE store_id=$1 AND cashier_id=$2 AND status='已完成'
        ORDER BY id DESC LIMIT 1`, [user.storeId, user.sub]);
    if (!o) return { order: null };
    const items = await q(
      `SELECT si.product_id AS "productId",
              COALESCE(si.custom_name, p.name) AS "name",
              si.qty::float8 AS "qty",
              si.unit_price::float8 AS "unitPrice",
              si.line_remark AS "lineRemark",
              p.barcode AS "barcode"
         FROM sale_items si JOIN products p ON p.id = si.product_id
        WHERE si.order_id=$1 AND p.barcode IS DISTINCT FROM 'OPENKEY'
        ORDER BY si.id`, [o.id]);
    return { order: { id: Number(o.id), orderNo: o.order_no,
                      memberId: o.member_id ? Number(o.member_id) : null,
                      createdAt: o.created_at, channel: o.channel,
                      payable: Number(o.payable) || 0, items } };
  }

  /** V4.18.1 P15 扫码查库存：商品 + 实时库存 + 在库批次（到期/余量），弹窗可带加车 */
  @RequirePerms('pos.sell')
  @Get('product-detail')
  async productDetail(@Query('productId') pid: string, @CurrentUser() user: AuthUser) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) throw new BizException(40003, 'productId 非法');
    const ps = await q(
      `SELECT p.id, p.barcode, p.name, p.spec, p.base_unit AS "baseUnit",
              p.sell_price::float8 AS "sellPrice", p.member_price::float8 AS "memberPrice",
              p.is_weighted AS "isWeighted"
         FROM products p WHERE p.id=$1 AND p.store_id=$2 AND p.deleted_at IS NULL`, [id, user.storeId]);
    if (!ps.length) throw new BizException(40404, '商品不存在', 404);
    // V4.26.5 扫码查库存同样按门店取价
    await storePrice.overlayOne(user.storeId, ps[0]);
    const stock = await q1(
      `SELECT COALESCE(qty_total, 0)::float8 AS "stockQty" FROM inventory_current
        WHERE store_id=$1 AND product_id=$2`, [user.storeId, id]);
    const batches = await q(
      `SELECT id, remain_qty::float8 AS "remainQty",
              to_char(expiry_date, 'YYYY-MM-DD') AS "expiryDate",
              to_char(inbound_date, 'YYYY-MM-DD') AS "inboundDate"
         FROM batches
        WHERE store_id=$1 AND product_id=$2 AND status='在库' AND remain_qty > 0
        ORDER BY expiry_date NULLS LAST, inbound_date
        LIMIT 20`, [user.storeId, id]);
    return { product: ps[0], stockQty: stock ? Number(stock.stockQty) : null, batches };
  }

  /**
   * 促销预览（收银台合计分层展示用，只读不计账）：
   * 复用结账同一促销引擎 applyPromotions（行级特价/第二件半价/满减/满件折扣等），另回「再买多少可用」的下一档满减。
   * 明细以结账服务端计价为准——本接口仅用于合计区展示预估。
   */
  @RequirePerms('pos.sell')
  @Post('promo-preview')
  async promoPreview(
    @Body() body: { items?: { productId: number; qty: number }[]; memberId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    if (!items.length) return { promoAmount: 0, nextPromo: null, goodsAmount: 0 };
    let goods = 0;
    const lines: any[] = [];
    for (const it of items) {
      const ps = await q(`SELECT * FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(it.productId)]);
      const p = ps[0];
      if (!p || p.status !== 1) continue;
      // V4.26.5 门店价：促销预览与结账同口径
      await storePrice.overlayOne(user.storeId, p);
      // 会员价预览（与结账同口径：会员价优先于零售价；等级折扣为结账时服务端权威计算，预览不重复实现）
      let unitPrice = Number(p.sell_price) || 0;
      if (body.memberId && Number(p.member_price) > 0) unitPrice = Number(p.member_price);
      const baseQty = r3(Number(it.qty) || 0);
      if (!(baseQty > 0)) continue;
      lines.push({ p, unitPrice, baseQty, lineAmount: r2(unitPrice * baseQty) });
      goods += r2(unitPrice * baseQty);
    }
    const promo = await applyPromotions(pool, user.storeId, lines, body.memberId)   // V4.28.9e：会员专享活动按会员过滤
      .catch(() => ({ promoAmount: 0, orderPromoId: null } as { promoAmount: number; orderPromoId: number | null }));
    // 下一档满减（未达标提示「再买 ¥X 可用」）
    let nextPromo: { name: string; threshold: number } | null = null;
    if (goods > 0) {
      const fj = await q(
        `SELECT name, rules FROM promotions
          WHERE store_id=$1 AND status='进行中' AND start_at <= now() AND end_at >= now() AND kind='满减'`,
        [user.storeId]);
      let best: { name: string; threshold: number } | null = null;
      for (const p2 of fj) {
        const th = Number(p2.rules?.threshold);
        if (!(th > 0) || goods >= th) continue;
        if (!best || th < best.threshold) best = { name: String(p2.name), threshold: th };
      }
      nextPromo = best;
    }
    const out: { promoAmount: number; nextPromo: { name: string; threshold: number } | null; goodsAmount: number } =
      { promoAmount: r2(Number(promo.promoAmount) || 0), nextPromo, goodsAmount: r2(goods) };
    return out;
  }

  // ═══════════ 挂单 / 取单（5.2.3） ═══════════

  /** 挂单：整单暂存（含会员/行明细/手改价/行备注快照；结账时服务端重新计价） */
  @RequirePerms('pos.sell')
  @Post('held')
  async hold(
    @Body() body: { items?: { productId: number; qty: number; unitName?: string; unitPrice?: number; lineRemark?: string }[];
                     memberId?: number; posNo?: string; shiftId?: number; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new BizException(40003, '挂单明细不能为空');
    if (items.length > 200) throw new BizException(40003, '挂单明细过多（上限 200 行）');
    for (const it of items) {
      const p = await q1(`SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(it.productId)]);
      if (!p) throw new BizException(40404, `商品#${it.productId} 不存在`, 404);
    }
    const r = await q1<any>(
      `INSERT INTO held_orders (store_id, pos_no, shift_id, member_id, items, remark, held_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
      [user.storeId, body.posNo || 'POS-01', body.shiftId ?? null, body.memberId ?? null,
       JSON.stringify(items), body.remark ?? null, user.sub]);
    // V4.15.4：快照补价（手输价优先，否则取商品当前售价）→ 行小计/整单金额可展示；并生成单据号 GD+日期-序号
    const pids = [...new Set(items.map(i => Number(i.productId)))];
    const prows = await q<any>(`SELECT id, name, base_unit, sell_price::float8 AS sell FROM products WHERE id = ANY($1::bigint[])`, [pids]);
    await storePrice.overlay(user.storeId, prows);   // V4.26.5 挂单快照补价按门店
    const pm = new Map(prows.map((p: any) => [Number(p.id), p]));
    const snap = items.map(it => {
      const p: any = pm.get(Number(it.productId));
      const unitPrice = it.unitPrice != null ? Number(it.unitPrice) : Number(p?.sell ?? 0);
      const lineTotal = Math.round(unitPrice * (Number(it.qty) || 0) * 100) / 100;
      return { ...it, productName: p?.name, unitName: it.unitName || p?.base_unit || undefined, unitPrice, lineTotal };
    });
    const d = new Date(r.created_at);
    const orderNo = `GD${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(r.id).padStart(4, '0')}`;
    return q1<any>(`UPDATE held_orders SET items=$2::jsonb, order_no=$3 WHERE id=$1 RETURNING *`,
      [r.id, JSON.stringify(snap), orderNo]);
  }

  /** V4.19.0 分单校验（P15.5 #1，B1 先分单后算优惠）：拆出行合法性校验（防 0 行/超量/商品不存在），
   *  返回归一化行（含当前售价快照）；前端校验通过后调 POST /pos/held 生成新挂起单 */
  @RequirePerms('pos.sell')
  @Post('held/split-validate')
  async splitValidate(
    @Body() body: { items?: { productId: number; qty: number; unitPrice?: number }[]; fromHeldId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new BizException(40003, '拆出行不能为空（至少保留一行在原购物车）');
    if (items.length > 200) throw new BizException(40003, '拆出行数过多（上限 200 行）');
    const seen = new Set<number>();
    const norm: { productId: number; qty: number; unitPrice?: number }[] = [];
    for (const it of items) {
      const pid = Number(it.productId);
      const qty = Number(it.qty);
      if (!pid) throw new BizException(40003, '拆出行缺少商品');
      if (!(qty > 0)) throw new BizException(40003, '拆出数量必须大于 0');
      if (seen.has(pid)) throw new BizException(40003, '同一商品拆出多行，请合并为一行');
      seen.add(pid);
      const p = await q1(`SELECT id, sell_price::float8 AS sell FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
      if (!p) throw new BizException(40404, `商品#${pid} 不存在或已下架`, 404);
      await storePrice.overlayOne(user.storeId, p);   // V4.26.5 分单校验按门店取价
      const unitPrice = it.unitPrice != null ? Number(it.unitPrice) : Number(p.sell ?? 0);
      norm.push({ productId: pid, qty, unitPrice });
    }
    // 挂单间拆分：校验拆出数量不超过原挂单行数量（购物车拆分由前端按本地行数校验）
    if (body.fromHeldId) {
      const h = await q1<any>(`SELECT items FROM held_orders WHERE id=$1 AND store_id=$2`, [Number(body.fromHeldId), user.storeId]);
      if (!h) throw new BizException(40404, '原挂单不存在', 404);
      const orig = new Map<number, number>();
      for (const o of (h.items || [])) orig.set(Number(o.productId), (orig.get(Number(o.productId)) || 0) + Number(o.qty || 0));
      for (const it of norm) {
        const have = orig.get(it.productId) || 0;
        if (it.qty > have) throw new BizException(40003, `商品#${it.productId} 拆出 ${it.qty} 超过原挂单数量 ${have}`);
      }
    }
    const est = norm.reduce((s, it) => s + it.unitPrice * it.qty, 0);
    return { items: norm, estAmount: Math.round(est * 100) / 100 };
  }

  /** 挂单列表（默认挂单中；status=全部 可查历史；V4.15.4 关键字/时间筛选）
   *  V4.25.0：scope 缺省时取后台开关 pos.held.default_scope（mine=本人 / all=全店）。
   *    mine  只看本人挂的；shift 看本人或本班（同一进行中班次）；all 全店所有挂单。 */
  @RequirePerms('pos.sell')
  @Get('held')
  async heldList(
    @Query('status') status = '挂单中',
    @Query('keyword') keyword = '',
    @Query('from') from = '',
    @Query('to') to = '',
    @Query('scope') scopeRaw = '',
    @CurrentUser() user: AuthUser,
  ) {
    const conds: string[] = ['h.store_id=$1'];
    const params: any[] = [user.storeId];
    if (status !== '全部') { params.push(status); conds.push(`h.status=$${params.length}`); }
    // V4.25.0：缺省 scope → 后台开关 pos.held.default_scope（默认本人）
    let scope = String(scopeRaw || '').trim();
    if (!scope) {
      try {
        const ds = await q1<any>(`SELECT value FROM system_settings WHERE setting_key='pos.held.default_scope'`);
        scope = ds ? String(ds.value).replace(/^"|"$/g, '').trim() : 'mine';
      } catch { scope = 'mine'; }
    }
    if (scope === 'mine') {
      params.push(user.sub); conds.push(`h.held_by=$${params.length}`);
    } else if (scope === 'shift') {
      const cur = await q1<any>(
        `SELECT id FROM shifts WHERE cashier_id=$1 AND status='进行中' ORDER BY id DESC LIMIT 1`, [user.sub]);
      params.push(user.sub); const iMe = params.length;
      if (cur) {
        params.push(Number(cur.id));
        conds.push(`(h.held_by=$${iMe} OR h.shift_id=$${params.length})`);
      } else {
        conds.push(`h.held_by=$${iMe}`);
      }
    }
    // scope === 'all' 或未知 → 全店（不附加 held_by 过滤）
    const kw = String(keyword || '').trim();
    if (kw) {
      params.push(`%${kw}%`);
      const i = params.length;
      conds.push(`(h.order_no ILIKE $${i} OR h.remark ILIKE $${i} OR m.name ILIKE $${i} OR e.name ILIKE $${i} OR h.items::text ILIKE $${i})`);
    }
    if (from) { params.push(from); conds.push(`h.created_at >= $${params.length}::date`); }
    if (to) { params.push(to); conds.push(`h.created_at < ($${params.length}::date + interval '1 day')`); }
    return q(
      `SELECT h.*, m.name AS member_name, e.name AS held_by_name
         FROM held_orders h
         LEFT JOIN members m ON m.id = h.member_id
         LEFT JOIN employees e ON e.id = h.held_by
        WHERE ${conds.join(' AND ')} ORDER BY h.id DESC`, params);
  }

  /** 挂单详情（V4.15.4：商品名/条码/单位/售价回填，前端直接渲染明细表） */
  @RequirePerms('pos.sell')
  @Get('held/:id')
  async heldDetail(@Param('id', ParseIntPipe) id: number) {
    const h = await q1<any>(
      `SELECT h.*, m.name AS member_name, e.name AS held_by_name
         FROM held_orders h
         LEFT JOIN members m ON m.id = h.member_id
         LEFT JOIN employees e ON e.id = h.held_by
        WHERE h.id=$1 AND h.store_id=$2`, [id, curStore()]);
    if (!h) throw new BizException(50063, '挂单不存在', 404);
    const items = Array.isArray(h.items) ? h.items : [];
    const pids = [...new Set(items.map((i: any) => Number(i?.productId)).filter(Boolean))];
    if (pids.length) {
      const prows = await q<any>(`SELECT id, name, barcode, base_unit, spec, sell_price::float8 AS sell FROM products WHERE id = ANY($1::bigint[])`, [pids]);
      await storePrice.overlay(curStore(), prows);   // V4.26.5 取单补价按门店
      const pm = new Map(prows.map((p: any) => [Number(p.id), p]));
      h.items = items.map((i: any) => {
        const p: any = pm.get(Number(i?.productId));
        return {
          ...i,
          productName: i?.productName || p?.name || `#${i?.productId}`,
          barcode: p?.barcode || undefined,
          unitName: i?.unitName || p?.base_unit || undefined,
          unitPrice: i?.unitPrice != null ? Number(i.unitPrice) : Number(p?.sell ?? 0),
          lineTotal: i?.lineTotal != null ? Number(i.lineTotal)
            : Math.round((i?.unitPrice != null ? Number(i.unitPrice) : Number(p?.sell ?? 0)) * (Number(i?.qty) || 0) * 100) / 100,
        };
      });
    }
    return h;
  }

  /** 取单结账一体：按挂单快照重新计价结账（FIFO/促销/券以结账时刻为准），成功置已取单 */
  @RequirePerms('pos.sell')
  @Post('held/:id/checkout')
  async checkoutHeld(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { payments: { channel: string; amount: number; externalNo?: string }[]; couponId?: number; shiftId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    // P2-M4：先 CAS 认领（挂单中→结账中），并发双击/双端取单时后到者立即失败，结账异常则回置
    const claim = await q1(`UPDATE held_orders SET status='结账中' WHERE id=$1 AND store_id=$2 AND status='挂单中' RETURNING id`, [id, user.storeId]);
    if (!claim) {
      const h0 = await q1<any>(`SELECT status FROM held_orders WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
      if (!h0) throw new BizException(50063, '挂单不存在', 404);
      throw new BizException(50064, `挂单状态为「${h0.status}」，不可结账（并发取单保护 P2-M4）`);
    }
    const h = await q1<any>(`SELECT * FROM held_orders WHERE id=$1`, [id]);

    const snapshot = (h.items ?? []) as { productId: number; qty: number; unitName?: string; unitPrice?: number; lineRemark?: string }[];
    let result;
    try { result = await this.sales.checkout(user, {
      items: snapshot.map(it => ({
        productId: Number(it.productId),
        qty: Number(it.qty),
        unitName: it.unitName,
        unitPrice: it.unitPrice === undefined || it.unitPrice === null ? undefined : Number(it.unitPrice),
        lineRemark: it.lineRemark,
      })),
      memberId: h.member_id ? Number(h.member_id) : undefined,
      payments: body.payments,
      couponId: body.couponId,
      shiftId: body.shiftId,
      remark: `挂单#${id}取单结账`,
    }); } catch (e) {
      await q(`UPDATE held_orders SET status='挂单中' WHERE id=$1 AND status='结账中'`, [id]); // 失败回置可重取
      throw e;
    }
    // P2-M4：结账成功 → 结账中 置为 已取单
    const up = await q1<any>(
      `UPDATE held_orders SET status='已取单', picked_at=now(), picked_order_id=$2
        WHERE id=$1 AND status='结账中' RETURNING id`, [id, result.orderId]);
    return { heldId: Number(up?.id ?? id), ...result };
  }

  /** V4.13.9 B1：单独销单（取出后进购物车编辑再结账的流程，结账成功后由前端调用；幂等：已取单直接返回成功） */
  @RequirePerms('pos.sell')
  @Post('held/:id/pick')
  async pickHeld(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const h = await q1<any>(`SELECT id, status FROM held_orders WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!h) throw new BizException(50063, '挂单不存在', 404);
    if (h.status === '已取单') return { heldId: id, alreadyPicked: true };
    const up = await q1<any>(
      `UPDATE held_orders SET status='已取单', picked_at=now()
        WHERE id=$1 AND status='挂单中' RETURNING id`, [id]);
    if (!up) throw new BizException(50064, `挂单状态为「${h.status}」，不可销单`);
    return { heldId: id };
  }

  /** 取消挂单（留痕不删除） */

  // ═══════════ 会员挂账查询 / 销账（V4.18.3 P15 批2 §13.2 B2/B3） ═══════════

  /** 会员在途欠款列表（未结/部分结清，最旧优先 + 超期标记 + 合计） */
  @RequirePerms('pos.sell')
  @Get('credits')
  async creditsList(@Query('memberId') memberId = '', @CurrentUser() user: AuthUser) {
    const mid = Number(memberId);
    if (!(mid > 0)) throw new BizException(40003, '必须指定会员');
    const items = await q(
      `SELECT id, order_id, amount::float8 AS amount, paid_amount::float8 AS "paidAmount",
              (amount - paid_amount)::float8 AS due_amount,
              status, due_date, reason, created_at,
              (due_date IS NOT NULL AND due_date < CURRENT_DATE) AS overdue
         FROM member_credits
        WHERE store_id=$1 AND member_id=$2 AND status IN ('未结','部分结清')
        ORDER BY created_at ASC`, [user.storeId, mid]);
    const rows = items as any[];
    return {
      items: rows.map(r => ({ ...r, id: Number(r.id), orderId: r.order_id ? Number(r.order_id) : null })),
      total: rows.reduce((s, r) => s + Number(r.due_amount), 0),
      overdueCount: rows.filter(r => r.overdue).length,
    };
  }

  /** 销账收款：默认最旧优先自动分摊（可传 allocations 自选）；部分销账记 partial；逐笔留痕 credit_pays */
  @RequirePerms('pos.sell')
  @Post('credits/settle')
  async creditsSettle(
    @Body() body: { memberId?: number; amount?: number; channel?: string; remark?: string;
                     allocations?: { creditId: number; amount: number }[] },
    @CurrentUser() user: AuthUser,
  ) {
    const mid = Number(body.memberId);
    const amtC = Math.round(Number(body.amount) * 100);
    const channel = body.channel || '现金';
    if (!(mid > 0) || !(amtC > 0)) throw new BizException(40003, '会员与销账金额必填');
    if (!['现金', '微信', '支付宝', '余额'].includes(channel)) throw new BizException(40003, '销账通道仅支持 现金/微信/支付宝/余额');
    return tx(async c => {
      const rows = await cx(c,
        `SELECT id, amount, paid_amount FROM member_credits
          WHERE store_id=$1 AND member_id=$2 AND status IN ('未结','部分结清')
          ORDER BY created_at ASC FOR UPDATE`, [user.storeId, mid]);
      if (!rows.length) throw new BizException(40404, '该会员无在途欠款', 404);
      // 分摊：默认最旧优先；显式 allocations 时按其分摊（合计必须=金额）
      let allocs = new Map<number, number>();
      if (Array.isArray(body.allocations) && body.allocations.length) {
        let sum = 0;
        for (const a of body.allocations) {
          const v = Math.round(Number(a.amount) * 100);
          if (!(v > 0)) continue;
          allocs.set(Number(a.creditId), (allocs.get(Number(a.creditId)) || 0) + v);
          sum += v;
        }
        if (sum !== amtC) throw new BizException(40003, `自选分摊合计(${sum / 100})与销账金额(${amtC / 100})不一致`);
      } else {
        let rest = amtC;
        for (const r of rows) {
          if (rest <= 0) break;
          const dueC = Math.round(Number(r.amount) * 100) - Math.round(Number(r.paid_amount) * 100);
          const use = Math.min(dueC, rest);
          allocs.set(Number(r.id), use);
          rest -= use;
        }
        if (rest > 0) throw new BizException(40003, `销账金额超过在途欠款合计（最多 ${(amtC - rest) / 100} 元）`);
      }
      const settled: number[] = [];
      for (const [cid, v] of allocs) {
        const cr = rows.find(r => Number(r.id) === cid);
        if (!cr) throw new BizException(40404, `欠款#${cid} 不存在或已结清`, 404);
        const paidC = Math.round(Number(cr.paid_amount) * 100);
        const totalC = Math.round(Number(cr.amount) * 100);
        if (paidC + v > totalC) throw new BizException(40003, `欠款#${cid} 分摊超过未结余额`);
        const after = paidC + v;
        const full = after >= totalC;
        await cx(c,
          `UPDATE member_credits SET paid_amount=$2, status=$3, closed_at=$4, updated_at=now() WHERE id=$1`,
          [cid, after / 100, full ? '已结清' : '部分结清', full ? new Date() : null]);
        await cx(c,
          `INSERT INTO credit_pays (store_id, credit_id, amount, channel, mode, emp_id, remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [user.storeId, cid, v / 100, channel, full ? 'full' : 'partial', user.sub, body.remark ?? null]);
        if (full) settled.push(cid);
      }
      await audit(user.storeId, user.sub, '收银', '挂账销账', 'member', mid,
        { amount: amtC / 100, channel, allocations: [...allocs.entries()].map(([k, v]) => ({ creditId: k, amount: v / 100 })), remark: body.remark ?? null });
      return { settledCount: allocs.size, fullySettled: settled, amount: amtC / 100, channel };
    });
  }

  /** 关闭/核销未结挂账（§13.2 B3：限店长权限 + 留痕，不做自动催收） */
  @RequirePerms('pos.credit.close')
  @Post('credits/:id/close')
  async creditsClose(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { action?: string; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const action = body.action === '核销' ? '核销' : '关闭';
    const reason = String(body.reason || '').trim();
    if (!reason) throw new BizException(40003, `${action}必须填写原因（留痕要求）`);
    const r = await tx(async c => {
      const rows = await cx(c, `SELECT id, status, amount, paid_amount FROM member_credits WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id, user.storeId]);
      const cr = rows[0];
      if (!cr) throw new BizException(40404, '欠款不存在', 404);
      if (!['未结', '部分结清'].includes(cr.status)) throw new BizException(40003, `欠款状态为「${cr.status}」，无需${action}`);
      const restC = Math.round(Number(cr.amount) * 100) - Math.round(Number(cr.paid_amount) * 100);
      await cx(c, `UPDATE member_credits SET status=$2, closed_at=now(), updated_at=now() WHERE id=$1`,
        [id, action === '核销' ? '已核销' : '已关闭']);
      // 核销视同坏账处理：剩余部分补一笔 0 元核销流水留痕（通道仍记现金、金额为 0 不影响资金）
      if (restC > 0) {
        await cx(c,
          `INSERT INTO credit_pays (store_id, credit_id, amount, channel, mode, emp_id, remark)
           VALUES ($1,$2,0,'现金',$3,$4,$5)`,
          [user.storeId, id, action, user.sub, `${action}：${reason}（剩余 ${restC / 100} 元未收）`]);
      }
      await audit(user.storeId, user.sub, '收银', `挂账${action}`, 'member_credit', id,
        { reason, restAmount: restC / 100 });
      return { id, action };
    });
    return r;
  }

  // ═══════════ 日结（P15 批3：独立于交接班的「日汇总」，结店不结人） ═══════════

  /** 当日全店汇总：分渠道流水（按支付完成时间 pay_paid_at 归属 B4）+ 退货/抹零/折扣/负库存提示，可打印日报 */
  @RequirePerms('pos.sell')
  @Get('daily')
  async daily(@Query('date') date: string, @CurrentUser() user: AuthUser) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const chans = await q<any>(
      `SELECT p.channel, COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(p.amount),0)::float8 AS amount
         FROM sale_payments p JOIN sales_orders o ON o.id = p.order_id
        WHERE o.store_id=$1 AND o.status='已完成' AND o.pay_paid_at::date = $2::date
        GROUP BY p.channel ORDER BY amount DESC`, [user.storeId, d]);
    const totals = await q1<any>(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(goods_amount),0)::float8 AS goods,
              COALESCE(SUM(promo_amount),0)::float8 AS promo,
              COALESCE(SUM(coupon_amount),0)::float8 AS coupon,
              COALESCE(SUM(order_discount),0)::float8 AS discount,
              COALESCE(SUM(round_amount),0)::float8 AS round,
              COALESCE(SUM(payable_amount),0)::float8 AS payable,
              COALESCE(SUM(cost_amount),0)::float8 AS cost,
              COALESCE(SUM(profit_amount),0)::float8 AS profit
         FROM sales_orders WHERE store_id=$1 AND status='已完成' AND pay_paid_at::date=$2::date`,
      [user.storeId, d]);
    const refunds = await q1<any>(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(r.amount),0)::float8 AS amount
         FROM sale_refunds r JOIN sales_orders o ON o.id = r.order_id
        WHERE o.store_id=$1 AND r.status='已退款' AND r.created_at::date=$2::date`,
      [user.storeId, d]);
    const neg = await q1<any>(
      `SELECT COUNT(*)::int AS cnt FROM audit_logs
        WHERE store_id=$1 AND module='收银' AND action='负库存售卖' AND created_at::date=$2::date`,
      [user.storeId, d]);
    const shifts = await q<any>(
      `SELECT sh.id, sh.status, sh.opened_at, sh.closed_at, e.name AS cashier_name,
              sh.opening_float::float8 AS "openingFloat", sh.cash_total::float8 AS "cashTotal",
              sh.cash_counted::float8 AS "cashCounted", sh.diff_amount::float8 AS diff
         FROM shifts sh JOIN employees e ON e.id = sh.cashier_id
        WHERE sh.store_id=$1 AND sh.opened_at::date=$2::date ORDER BY sh.id`,
      [user.storeId, d]);
    return {
      date: d,
      channels: chans.map((c: any) => ({ channel: c.channel, orders: c.orders, amount: r2(c.amount) })),
      totals: {
        orders: totals?.orders ?? 0,
        goods: r2(totals?.goods ?? 0),
        promo: r2(totals?.promo ?? 0),
        coupon: r2(totals?.coupon ?? 0),
        discount: r2(totals?.discount ?? 0),
        round: r2(totals?.round ?? 0),
        payable: r2(totals?.payable ?? 0),
        cost: r2(totals?.cost ?? 0),
        profit: r2(totals?.profit ?? 0),
      },
      refunds: { count: refunds?.cnt ?? 0, amount: r2(refunds?.amount ?? 0) },
      negativeCount: neg?.cnt ?? 0,
      shifts,
    };
  }

  /**
   * V4.18.5 P15批4 内置退货查单：按小票号/单号带原单（行级可退数量 = 原行 − 已退累计，
   * 口径与 refund.create 一致：已退款/待审核/创建中 均占用额度）。挂账/赊账单拒退（P2-M8 冲减口径）。
   */
  @Get('refund-lookup')
  async refundLookup(@Query('no') no: string, @Query('date') date: string, @CurrentUser() user: AuthUser) {
    const key = String(no ?? '').trim();
    if (!key) {
      // 空输入 → 按日期浏览本店「已完成」销售单据（默认今天），供收银台逐单选单退货
      const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
        ? String(date)
        : new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const list = await q<any>(
        `SELECT id, order_no, payable_amount, created_at FROM sales_orders
          WHERE store_id=$1 AND status='已完成' AND created_at::date = $2::date
          ORDER BY id DESC LIMIT 200`, [user.storeId, d]);
      return { by: 'by_date', date: d, orders: list.map((o: any) => ({ id: Number(o.id), orderNo: o.order_no, amount: Number(o.payable_amount), createdAt: o.created_at })) };
    }
    // VQA-GAP02：无小票退货——①11 位手机号：该会员近 30 天本店已完成订单候选；②≥4 位单号后缀：模糊候选
    if (/^1[3-9]\d{9}$/.test(key)) {
      const list = await q<any>(
        `SELECT o.id, o.order_no, o.payable_amount, o.created_at
           FROM sales_orders o JOIN members m ON m.id=o.member_id
          WHERE o.store_id=$1 AND m.phone=$2 AND o.status='已完成' AND o.created_at > now() - interval '30 days'
          ORDER BY o.id DESC LIMIT 10`, [user.storeId, key]);
      if (!list.length) throw new BizException(50070, '该手机号近 30 天无本店已完成订单', 404);
      return { by: 'member_phone', orders: list.map((o: any) => ({ id: Number(o.id), orderNo: o.order_no, amount: Number(o.payable_amount), createdAt: o.created_at })) };
    }
    const o = await q1<any>(
      `SELECT o.id, o.order_no, o.payable_amount, o.created_at, m.name AS member_name, m.phone AS member_phone
         FROM sales_orders o LEFT JOIN members m ON m.id = o.member_id
        WHERE o.store_id=$1 AND o.order_no=$2 AND o.status='已完成' LIMIT 1`, [user.storeId, key]);
    if (!o) {
      if (key.length >= 4) {
        const suf = await q<any>(
          `SELECT id, order_no, payable_amount, created_at FROM sales_orders
            WHERE store_id=$1 AND status='已完成' AND order_no LIKE '%'||$2 ORDER BY id DESC LIMIT 10`, [user.storeId, key]);
        if (suf.length)
          return { by: 'order_no_suffix', orders: suf.map((x: any) => ({ id: Number(x.id), orderNo: x.order_no, amount: Number(x.payable_amount), createdAt: x.created_at })) };
      }
      throw new BizException(50070, '未找到该小票号对应的已完成订单（可扫小票条码、手输 XS 单号/后缀，或输会员手机号反查）', 404);
    }
    const credit = await q1<any>(
      `SELECT COALESCE(SUM(amount),0) AS n FROM sale_payments WHERE order_id=$1 AND channel::text IN ('赊账','挂账')`, [o.id]);
    if (Number(credit.n) > 0) throw new BizException(50076, '挂账/赊账订单请通过「大客户对账」冲减，不支持收银台直接退货');
    const lines = await q<any>(
      `SELECT si.id AS sale_item_id, COALESCE(si.custom_name, p.name) AS name,
              si.qty::float8 AS qty, si.unit_price::float8 AS unit_price, si.line_amount::float8 AS line_amount,
              COALESCE((SELECT SUM(ri.qty) FROM sale_refund_items ri
                  JOIN sale_refunds r ON r.id = ri.refund_id
                 WHERE ri.sale_item_id = si.id AND r.status IN ('已退款','待审核','创建中')), 0)::float8 AS refunded
         FROM sale_items si JOIN products p ON p.id = si.product_id
        WHERE si.order_id=$1 ORDER BY si.id`, [o.id]);
    const limit = await this.settings.getNum('sales.refund.limit', 200);
    // V4.19.0 C2 离线退货：返回主支付渠道（金额最大一行）——现金单断网可暂存补传，电子通道强制在线
    const mainPay = await q1<any>(
      `SELECT channel::text AS channel FROM sale_payments WHERE order_id=$1 ORDER BY amount DESC LIMIT 1`, [o.id]);
    return {
      order: { id: Number(o.id), orderNo: o.order_no, payable: Number(o.payable_amount),
               createdAt: o.created_at, memberName: o.member_name ?? null, memberPhone: o.member_phone ?? null,
               payChannel: mainPay?.channel ? String(mainPay.channel) : '现金' },
      lines: lines.map(l => ({ saleItemId: Number(l.sale_item_id), name: l.name,
                               qty: Number(l.qty), unitPrice: Number(l.unit_price),
                               lineAmount: Number(l.line_amount), refunded: Number(l.refunded),
                               refundable: r3(Number(l.qty) - Number(l.refunded)) })),
      refundLimit: limit,   // 免审限额（sales.refund.limit）：超出转店长审核
    };
  }

  // ═══════════ 会员充值代收（H5 发起 → 收银台收款确认，db/010） ═══════════

  /** 代收队列：按状态查充值单（默认待支付；手机号脱敏） */
  @RequirePerms('member.balance.recharge')
  @Get('recharge-orders')
  async rechargeQueue(@Query('status') status = '待支付') {
    const st = ['待支付', '已入账', '已取消', '已过期'].includes(status) ? status : '待支付';
    const items = await q(
      `SELECT r.id, r.order_no, r.principal, r.gift, r.status, r.pay_channel, r.created_at, r.collected_at,
              m.id AS member_id, m.card_no, m.name, l.name AS level_name,
              CASE WHEN m.phone IS NULL THEN NULL ELSE LEFT(m.phone,3)||'****'||RIGHT(m.phone,4) END AS phone
         FROM recharge_orders r
         JOIN members m ON m.id = r.member_id
         LEFT JOIN member_levels l ON l.id = m.level_id
        WHERE r.status=$1 ORDER BY r.id DESC LIMIT 50`, [st]);
    return { items };
  }

  /** 收款入账：现金/扫码通道收取 → 口径B 双余额入账 + 等级同步（FOR UPDATE 锁单防并发重复入账 50074） */
  @RequirePerms('member.balance.recharge')
  @Post('recharge-orders/:id/collect')
  async collectRecharge(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { payChannel: string; shiftId?: number; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!['现金', '扫码'].includes(body.payChannel)) throw new BizException(40003, 'payChannel 仅支持 现金/扫码');
    // 过期预检在事务外：置「已过期」必须独立提交（事务内 throw 会把 UPDATE 一并回滚）
    const pre = await q1<{ status: string; created_at: any }>(`SELECT status, created_at FROM recharge_orders WHERE id=$1`, [id]);
    if (pre && pre.status === '待支付') {
      const hours = await this.settings.getNum('member.recharge.orders_expire_hours', 24);
      if (new Date(pre.created_at).getTime() + hours * 3600000 < Date.now()) {
        await q(`UPDATE recharge_orders SET status='已过期', updated_at=now() WHERE id=$1`, [id]);
        throw new BizException(50075, '充值单已过期，请会员重新发起');
      }
    }
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM recharge_orders WHERE id=$1 FOR UPDATE`, [id]);
      const ro = rows[0];
      if (!ro) throw new BizException(40404, '充值单不存在', 404);
      if (ro.status !== '待支付') throw new BizException(50074, `充值单状态已变更（${ro.status}），请刷新后重试`);
      const principal = Number(ro.principal), gift = Number(ro.gift);
      const memberId = Number(ro.member_id);
      const accs = await cx(c, `SELECT * FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [memberId]);
      if (!accs[0]) throw new BizException(40404, '会员资产账户不存在', 404);
      const after = r2(Number(accs[0].balance) + principal + gift);
      await cx(c,
        `UPDATE member_accounts SET balance=$2, principal_total = principal_total + $3,
                principal_balance = principal_balance + $3, gift_balance = gift_balance + $4, updated_at=now()
          WHERE member_id=$1`, [memberId, after, principal, gift]);
      const flow = await cx(c,
        `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                    biz_type, balance_after, employee_id, remark)
         VALUES ($1,$2,'入',$3,$4,$5,'充值',$6,$7,$8) RETURNING id`,
        [Number(ro.store_id), memberId, r2(principal + gift), principal, gift, after, user.sub,
         `充值单 ${ro.order_no}（收银台代收·${body.payChannel}）`]);
      await cx(c,
        `UPDATE recharge_orders SET status='已入账', pay_channel=$2, balance_flow_id=$3,
                collected_by=$4, collected_at=now(), shift_id=$5,
                remark=COALESCE(NULLIF($6,''), remark), updated_at=now()
          WHERE id=$1 AND status='待支付'`, [id, body.payChannel, flow[0].id, user.sub, body.shiftId ?? null, body.remark ?? '']);
      const level = await syncMemberLevel(c, memberId, { operatorId: user.sub });
      await audit(curStore(), user.sub, '会员', 'member.recharge.collect', 'recharge_order', id,
        { orderNo: ro.order_no, principal, gift, channel: body.payChannel, balanceAfter: after, level });
      return { orderId: id, orderNo: ro.order_no, memberId, principal, gift,
               payChannel: body.payChannel, balanceAfter: after, level };
    });
  }

  @RequirePerms('pos.sell')
  @Delete('held/:id')
  async cancelHeld(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const up = await q1<any>(
      `UPDATE held_orders SET status='已取消', picked_at=now()
        WHERE id=$1 AND store_id=$2 AND status='挂单中' RETURNING id`,
      [id, user.storeId]);
    if (!up) {
      const h = await q1(`SELECT status FROM held_orders WHERE id=$1`, [id]);
      if (!h) throw new BizException(50063, '挂单不存在', 404);
      throw new BizException(50064, `挂单状态为「${h.status}」，不可取消`);
    }
    return { id, status: '已取消' };
  }
}

@Module({ controllers: [PosController] })
export class PosModule {}
