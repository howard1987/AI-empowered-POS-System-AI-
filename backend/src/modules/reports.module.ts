import { RequirePerms, AuthUser, CurrentUser } from '../common/auth';
import { Module, Controller, Get, Post, Query } from '@nestjs/common';
import { q, q1, r2 } from '../common/db';
import { SettingsService } from './settings.module';
import { resolveReportStores, visibleStores } from '../common/scope'; // V5.0.0 批次6：报表门店维度

/** Q-04 B1：金额元 → 整数分（与 sales.module toCents 同义；合计行分整数累加，消除浮点逐行累加误差） */
const toCents = (yuan: any): number => Math.round(Number(yuan) * 100);

/**
 * 报表中心（任务卡 T13 / 方案 4.7、5.9、14.6.3）：
 *   overview  后台首页看板：今日销售/会员/分红/库存预警/临期（口径与首页看板一致）
 *   daily     日销售汇总（按天聚合 + 支付方式构成）
 *   abc       商品 ABC 分析（销售额累计占比 80/15/5 分层）
 *   dividend  分红期间汇总（池/实发/人数）
 * 均为只读聚合接口，登录即可访问；口径统一以「已完成」订单为准
 *
 * V5.0.0 批次6（M6-1 / V2 数据隔离）：
 *   全部销售/库存端点加可选 storeId 参数 + resolveReportStores() 范围强制——
 *   门店账号（data_scope='self'）强制本店；区域账号限本区域；总部可切单店/全部。
 *   单店零回归：单店下过滤 store_id=本店，数据全集不变。
 */
@Controller('reports')
class ReportsController {
  private settings = new SettingsService();

  /** 门店范围过滤片段：rs=null（总部不限）→ 空串；否则按 id 数组过滤（参数追加到尾部） */
  private sf(rs: number[] | null, params: any[], col: string): string {
    if (rs === null) return '';
    params.push(rs);
    return ` AND ${col} = ANY($${params.length}::bigint[])`;
  }

  /** 后台首页看板（14.6.3）；批次6：销售/库存部分按门店范围过滤 */
  @RequirePerms('report.view.all')
  @Get('overview')
  async overview(@Query('storeId') storeId?: string) {
    const rs = resolveReportStores(storeId);
    // 库存预警/临期两个子查询各自独立编号：rs 非空时都作为 $1 传入（同一数组值）
    const sParams: any[] = [];
    const sFilter = this.sf(rs, sParams, 'store_id');
    const iFilter = rs ? ` AND ic.store_id = ANY($1::bigint[])` : '';
    const bFilter = rs ? ` AND store_id = ANY($1::bigint[])` : '';
    const stockParams = rs ? [rs] : [];
    const [today, members, assets, dividend, stock] = await Promise.all([
      q1(`SELECT count(*)::int AS "orderCount",
                 COALESCE(SUM(payable_amount),0) AS "salesTotal",
                 COALESCE(SUM(cost_amount),0) AS "costTotal",
                 COALESCE(SUM(profit_amount),0) AS "profitTotal",
                 count(*) FILTER (WHERE is_emergency)::int AS "emergencyOrders"
            FROM sales_orders
           WHERE status='已完成' AND COALESCE(pay_paid_at, created_at)::date = CURRENT_DATE${sFilter}`, sParams),
      q1(`SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS "newToday"
            FROM members WHERE deleted_at IS NULL`),
      q1(`SELECT COALESCE(SUM(a.balance),0) AS "balanceTotal",
                 COALESCE(SUM(a.principal_balance),0) AS "principalTotal",
                 COALESCE(SUM(a.dividend_balance),0) AS "dividendTotal",
                 COALESCE(SUM(a.points),0)::bigint AS "pointsTotal"
            FROM member_accounts a JOIN members m ON m.id = a.member_id
           WHERE m.deleted_at IS NULL`),
      q1(`SELECT COALESCE(SUM(pool_amount),0) AS "poolTotal",
                 COALESCE(SUM(net_profit),0) AS "netProfitTotal",
                 (SELECT COALESCE(SUM(amount),0) FROM dividend_records WHERE record_type='计提') AS "givenTotal",
                 count(*)::int AS "periodCount"
            FROM dividend_periods`),
      q1(`SELECT (SELECT count(*)::int FROM inventory_current ic
                    JOIN products p ON p.id = ic.product_id AND p.deleted_at IS NULL
                   WHERE ic.qty_total <= COALESCE(p.min_stock, 0)${iFilter}) AS "lowStock",
                 (SELECT count(*)::int FROM batches
                   WHERE status='在库' AND remain_qty > 0
                     AND expiry_date IS NOT NULL
                     AND expiry_date <= CURRENT_DATE + 30${bFilter}) AS "expiringSoon"`,
          stockParams),
    ]);
    return { today, members, assets, dividend, stock };
  }

  /** 日销售汇总（4.7 日报）：按天聚合 + 区间支付构成；批次6：storeId 维度 */
  @RequirePerms('report.view.all')
  @Get('daily')
  async daily(@Query('from') from?: string, @Query('to') to?: string,
              @Query('storeId') storeId?: string) {
    const rs = resolveReportStores(storeId);
    const p1: any[] = [from || null, to || null];
    const p2: any[] = [from || null, to || null];
    const days = await q(
      `SELECT created_at::date AS "bizDate",
              count(*)::int AS "orderCount",
              COALESCE(SUM(goods_amount),0) AS "goodsTotal",
              COALESCE(SUM(payable_amount),0) AS "salesTotal",
              COALESCE(SUM(cost_amount),0) AS "costTotal",
              COALESCE(SUM(profit_amount),0) AS "profitTotal",
              count(DISTINCT member_id)::int AS "memberOrders"
         FROM sales_orders
        WHERE status='已完成'
          AND ($1::date IS NULL OR created_at::date >= $1::date)
          AND ($2::date IS NULL OR created_at::date <= $2::date)${this.sf(rs, p1, 'store_id')}
        GROUP BY created_at::date ORDER BY created_at::date DESC LIMIT 92`,
      p1);
    const channels = await q(
      `SELECT sp.channel, count(*)::int AS cnt, COALESCE(SUM(sp.amount),0) AS amount
         FROM sale_payments sp
         JOIN sales_orders o ON o.id = sp.order_id AND o.status='已完成'
        WHERE ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
          AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${this.sf(rs, p2, 'o.store_id')}
        GROUP BY sp.channel ORDER BY amount DESC`,
      p2);
    // 日报目标达成率（14.6.3 口径一致；report.daily_target=0 视为未设目标）
    const target = await this.settings.getNum('report.daily_target', 0);
    const days2 = target > 0
      ? days.map((d: any) => ({ ...d, achievement: r2(Number(d.salesTotal) / target * 100) }))
      : days;
    return { target: target > 0 ? target : null, days: days2, channels };
  }

  /** V4.28.9 赠送记录（报表中心）：识别口径 = 赠品行 line_remark 前缀「赠品」——
   *  ① 手工赠品（收银台"设为赠品"，0 元 + 店长授权 + 审计留痕）；
   *  ② 消费后奖励自动赠品（促销规则配 giftProductId，结账事务内自动出库）。
   *  二者均为真实出库（FIFO 扣批 + 库存流水 + 成本入账）。 */
  @RequirePerms('report.view.all')
  @Get('gifts')
  async gifts(@Query('from') from?: string, @Query('to') to?: string,
              @Query('storeId') storeId?: string, @Query('size') size?: string) {
    const rs = resolveReportStores(storeId);
    const p1: any[] = [from || null, to || null];
    const rows = await q(
      `SELECT si.id, o.order_no, o.created_at, o.store_id, st.name AS "storeName",
              p.name AS "productName", p.barcode,
              si.qty, si.line_cost AS "cost",
              si.line_remark AS "remark",
              CASE WHEN si.line_remark LIKE '赠品(消费后奖励)%' THEN '促销自动'
                   ELSE '手工赠品' END AS "source",
              e.name AS "cashier",
              COALESCE(pr.name, '') AS "promoName"
         FROM sale_items si
         JOIN sales_orders o ON o.id = si.order_id AND o.status = '已完成'
         LEFT JOIN products p ON p.id = si.product_id
         LEFT JOIN stores st ON st.id = o.store_id
         LEFT JOIN employees e ON e.id = o.cashier_id
         LEFT JOIN promotions pr ON pr.id = si.promo_id
        WHERE si.line_remark LIKE '赠品%'
          AND ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
          AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${this.sf(rs, p1, 'o.store_id')}
        ORDER BY o.created_at DESC LIMIT $${p1.length + 1}`,   // V5.0.18g：size 可调（默认 300，上限 5000）
      [...p1, Math.min(Math.max(Number(size) || 300, 1), 5000)]);
    const sum = await q(
      `SELECT count(*)::int AS "times", COALESCE(SUM(si.qty),0) AS "qtyTotal",
              COALESCE(SUM(si.line_cost),0) AS "costTotal",
              count(DISTINCT si.product_id)::int AS "kinds"
         FROM sale_items si
         JOIN sales_orders o ON o.id = si.order_id AND o.status = '已完成'
        WHERE si.line_remark LIKE '赠品%'
          AND ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
          AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${this.sf(rs, p1, 'o.store_id')}`, p1);
    return { rows, summary: sum[0] || { times: 0, qtyTotal: 0, costTotal: 0, kinds: 0 } };
  }

  /** 优惠券明细·库存看板（V5.0）：每种券 入库/在库/已发/已核销/已过期/作废 + 核销率 + 让利金额 */
  @RequirePerms('report.view.all')
  @Get('coupons-stock')
  async couponsStock(@Query('storeId') storeId?: string, @Query('keyword') keyword?: string) {
    const rs = resolveReportStores(storeId);
    const p: any[] = [];
    const kw = (keyword || '').trim();
    const filter = this.sf(rs, p, 'cp.store_id') +
      (kw ? ` AND (cp.name ILIKE '%'||$${p.length + 1}||'%' OR cp.code ILIKE '%'||$${p.length + 1}||'%')` : '');
    if (kw) p.push(kw);
    const rows = await q(
      `SELECT cp.id, cp.code, cp.name, cp.type, cp.threshold, cp.discount,
              cp.total_qty, cp.issued_qty, cp.per_member, cp.status,
              cp.total_qty - cp.issued_qty AS in_stock,
              count(mc.id) FILTER (WHERE mc.status='未使用')::int AS unused_count,
              count(mc.id) FILTER (WHERE mc.status='已使用')::int AS used_count,
              count(mc.id) FILTER (WHERE mc.status='已过期')::int AS expired_count,
              count(mc.id) FILTER (WHERE mc.status='已作废')::int AS voided_count
         FROM coupons cp LEFT JOIN member_coupons mc ON mc.coupon_id = cp.id
        WHERE 1=1 ${filter}
        GROUP BY cp.id ORDER BY cp.id DESC`, p);
    const out = rows.map((r: any) => {
      const used = Number(r.used_count || 0);
      const issued = Number(r.issued_qty || 0);
      const face = Number(r.discount || 0);
      const thr = Number(r.threshold || 0);
      let benefit = 0;
      if (r.type === '满减券') benefit = used * face;
      else if (r.type === '折扣券') benefit = used * thr * (1 - face);
      // 兑换券/次卡价值在消费中体现，报表占位 0
      return {
        ...r,
        redeem_rate: issued > 0 ? Math.round((used / issued) * 1000) / 10 : 0,
        benefit_amount: r2(benefit),
      };
    });
    return out;
  }

  /** 优惠券明细·出入库流水（V5.0）：按券/会员/经手人/动作/单据号/时间筛选，全链路可追溯 */
  @RequirePerms('report.view.all')
  @Get('coupon-stock-log')
  async couponStockLog(@Query('storeId') storeId?: string,
                       @Query('coupon') coupon?: string, @Query('memberId') memberId?: string,
                       @Query('operatorId') operatorId?: string, @Query('moveType') moveType?: string,
                       @Query('docNo') docNo?: string, @Query('from') from?: string, @Query('to') to?: string,
                       @Query('page') page = '1', @Query('size') size = '50') {
    const rs = resolveReportStores(storeId);
    const p: any[] = [];
    const f = this.sf(rs, p, 'l.store_id');
    const and: string[] = [];
    if (coupon) { and.push(`(cp.code ILIKE '%'||$${p.length + 1}||'%' OR cp.name ILIKE '%'||$${p.length + 1}||'%' OR cp.id::text=$${p.length + 1})`); p.push(coupon); }
    if (memberId) { and.push(`l.member_id=$${p.length + 1}`); p.push(Number(memberId)); }
    if (operatorId) { and.push(`l.operator_id=$${p.length + 1}`); p.push(Number(operatorId)); }
    if (moveType) { and.push(`l.move_type=$${p.length + 1}`); p.push(moveType); }
    if (docNo) { and.push(`l.related_doc_no ILIKE '%'||$${p.length + 1}||'%'`); p.push(docNo); }
    if (from) { and.push(`l.created_at::date >= $${p.length + 1}`); p.push(from); }
    if (to) { and.push(`l.created_at::date <= $${p.length + 1}`); p.push(to); }
    const where = (and.length ? ' AND ' + and.join(' AND ') : '') + (f || '');
    const pg = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 50));
    const rows = await q(
      `SELECT l.id, l.created_at, l.move_type, l.qty, l.stock_after, l.related_doc_no, l.remark,
              cp.code AS coupon_code, cp.name AS coupon_name, cp.type AS coupon_type,
              m.name AS member_name, m.phone AS member_phone, e.name AS operator_name
         FROM coupon_stock_log l
         JOIN coupons cp ON cp.id = l.coupon_id
         LEFT JOIN members m ON m.id = l.member_id
         LEFT JOIN employees e ON e.id = l.operator_id
        WHERE 1=1 ${where}
        ORDER BY l.id DESC LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, sz, (pg - 1) * sz]);
    const tot = await q1(`SELECT count(*)::int AS n FROM coupon_stock_log l WHERE 1=1 ${where}`, p);
    return { rows, total: tot?.n || 0, page: pg, size: sz };
  }

  /** 经营看板（14.6.3）：日/周/月/季切换；批次6：storeId 维度 */
  @RequirePerms('report.view.all')
  @Get('dashboard')
  async dashboard(@Query('period') period = 'day', @Query('storeId') storeId?: string) {
    const unit = ({ day: 'day', week: 'week', month: 'month', quarter: 'quarter' } as any)[period] || 'day';
    const rs = resolveReportStores(storeId);
    // PG 不支持 interval '1 quarter'，回退量按周期映射（unit 已白名单）
    const back = ({ day: "3 * '1 day'::interval", week: "3 * '7 days'::interval",
                    month: "3 * '1 month'::interval", quarter: "3 * '3 months'::interval" } as any)[unit];
    const pc: any[] = [unit];
    const curFilter = this.sf(rs, pc, 'store_id');
    const pc2: any[] = [unit];
    const periodFilter = this.sf(rs, pc2, 'store_id');
    // trend 查询按 CURRENT_DATE-6 固定近 7 天，SQL 内不含 date_trunc($1)，
    // 故 tc 不能像 pc/pc2 那样预置 [unit]，否则全门店(sf 不追加占位符)时参数数 > 占位符数
    const tc: any[] = [];
    // trend 查询按 CURRENT_DATE-6 固定近 7 天；store_id 过滤用无表限定片段，供下方两个子查询复用同一 $1 占位符
    const trendFilter = this.sf(rs, tc, 'store_id');
    const cc: any[] = [];
    const catFilter = this.sf(rs, cc, 'o.store_id');
    const cur = await q1(
      `SELECT count(*)::int AS "orderCount",
              COALESCE(SUM(payable_amount),0) AS "salesTotal",
              COALESCE(SUM(profit_amount),0) AS "profitTotal",
              CASE WHEN count(*) > 0
                   THEN COALESCE(SUM(payable_amount),0) / count(*)
                   ELSE 0 END AS "avgTicket",
              (SELECT count(*)::int FROM members
                WHERE deleted_at IS NULL AND created_at >= date_trunc($1, CURRENT_TIMESTAMP)) AS "newMembers",
              (SELECT COALESCE(SUM(amount),0) FROM dividend_records
                WHERE record_type='计提' AND created_at >= date_trunc($1, CURRENT_TIMESTAMP)) AS "dividendGiven",
              (SELECT COALESCE(SUM(amount),0) FROM dividend_records
                WHERE record_type='抵扣' AND created_at >= date_trunc($1, CURRENT_TIMESTAMP)) AS "dividendUsed"
         FROM sales_orders
        WHERE status='已完成' AND created_at >= date_trunc($1, CURRENT_TIMESTAMP)${curFilter}`, pc);
    const periods = await q(
      `SELECT date_trunc($1, created_at) AS "bucket",
              count(*)::int AS "orderCount",
              COALESCE(SUM(payable_amount),0) AS "salesTotal",
              COALESCE(SUM(profit_amount),0) AS "profitTotal"
         FROM sales_orders
        WHERE status='已完成'
          AND created_at >= date_trunc($1, CURRENT_TIMESTAMP) - ${back}${periodFilter}
        GROUP BY 1 ORDER BY 1 DESC LIMIT 4`, pc2);
    // P-02：原写法 generate_series LEFT JOIN sales_orders ON 列上表达式 = d::date 无范围谓词 → 每次刷新全表扫。
    //   改为：历史 6 天（不含今日）直接读日结物化表 daily_settlement（settle_date+store_id 索引命中，零全扫）；
    //   今日实时仅一天，status+created_at 范围谓词走 idx_so_status_created（非全表扫）。
    const trend = await q(
      `SELECT d::date AS "bizDate",
              COALESCE(SUM(agg."orderCount"),0)::int AS "orderCount",
              COALESCE(SUM(agg."salesTotal"),0) AS "salesTotal",
              COALESCE(SUM(agg."profitTotal"),0) AS "profitTotal"
         FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') d
         LEFT JOIN (
           SELECT settle_date AS dd, order_count AS "orderCount", sales_total AS "salesTotal", profit_total AS "profitTotal"
             FROM daily_settlement
            WHERE settle_date BETWEEN CURRENT_DATE - 6 AND CURRENT_DATE - 1${trendFilter}
           UNION ALL
           SELECT CURRENT_DATE AS dd,
                  count(*)::int AS "orderCount",
                  COALESCE(SUM(payable_amount),0) AS "salesTotal",
                  COALESCE(SUM(profit_amount),0) AS "profitTotal"
             FROM sales_orders
            WHERE status='已完成' AND created_at >= CURRENT_DATE${trendFilter}
         ) agg ON agg.dd = d::date
        GROUP BY d ORDER BY d`, tc);
    const categoryShare = await q(
      `SELECT COALESCE(c.name, '未分类') AS name, COALESCE(SUM(i.line_amount),0) AS revenue
         FROM sale_items i
         JOIN sales_orders o ON o.id = i.order_id AND o.status='已完成'
         JOIN products p ON p.id = i.product_id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE COALESCE(o.pay_paid_at, o.created_at)::date >= CURRENT_DATE - 29${catFilter}
        GROUP BY 1 ORDER BY revenue DESC LIMIT 12`, cc);
    return { period: unit, current: cur, periods, trend, categoryShare };
  }

  /** 商品 ABC 分析（5.9：按销售额累计占比 A≤80% / B≤95% / C 其余） */
  @RequirePerms('report.view.all')
  @Get('abc')
  async abc(@Query('from') from?: string, @Query('to') to?: string,
            @Query('storeId') storeId?: string, @Query('size') size?: string) {
    const rs = resolveReportStores(storeId);
    const p: any[] = [from || null, to || null];
    const rows = await q(
      `WITH agg AS (
         SELECT p.id AS product_id, p.name, p.base_unit,
                COALESCE(SUM(i.qty),0) AS qty,
                COALESCE(SUM(i.line_amount),0) AS revenue,
                COALESCE(SUM(i.line_cost),0) AS cost
           FROM sale_items i
           JOIN sales_orders o ON o.id = i.order_id AND o.status='已完成'
           JOIN products p ON p.id = i.product_id
          WHERE ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
            AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${this.sf(rs, p, 'o.store_id')}
          GROUP BY p.id, p.name, p.base_unit
          HAVING COALESCE(SUM(i.line_amount),0) > 0
       ), ranked AS (
         SELECT a.*,
                SUM(revenue) OVER (ORDER BY revenue DESC, product_id) AS cum_revenue,
                SUM(revenue) OVER () AS total_revenue
           FROM agg a
       )
       SELECT product_id, name, base_unit, qty, revenue, cost, revenue - cost AS profit,
              ROUND(cum_revenue / NULLIF(total_revenue,0) * 100, 2) AS cum_pct,
              CASE WHEN cum_revenue / NULLIF(total_revenue,0) * 100 <= 80 THEN 'A'
                   WHEN cum_revenue / NULLIF(total_revenue,0) * 100 <= 95 THEN 'B'
                   ELSE 'C' END AS "className"
         FROM ranked
        ORDER BY revenue DESC, product_id
        LIMIT $${p.length + 1}`,   // V5.0.18g：size 可调（默认 500，上限 5000）
      [...p, Math.min(Math.max(Number(size) || 500, 1), 5000)]);
    return { items: rows };
  }

  /** 分红期间汇总（5.1.14 明细可查） */
  @RequirePerms('report.view.all')
  @Get('dividend')
  async dividend(@Query('limit') limit?: string) {
    const periods = await q(
      `SELECT p.*,
              COALESCE((SELECT SUM(amount) FROM dividend_records d
                         WHERE d.period_id = p.id AND d.record_type='计提'),0) AS given_amount
         FROM dividend_periods p
        ORDER BY p.biz_date DESC LIMIT ${Math.min(Number(limit) || 60, 180)}`);
    const total = await q1(
      `SELECT COALESCE(SUM(pool_amount),0) AS "poolTotal",
              COALESCE((SELECT SUM(amount) FROM dividend_records WHERE record_type='计提'),0) AS "givenTotal",
              COALESCE((SELECT SUM(amount) FROM dividend_records WHERE record_type='抵扣'),0) as used_total
         FROM dividend_periods`);
    return { periods, total };
  }

  /** 商品销售明细（P1-1 / 原型#17）：按商品聚合 + 日期/关键词/分类筛选；总额合计随行返回 */
  @RequirePerms('report.view.all')
  /** 商品销售明细报表（V5.0.18g：服务端分页 page/size；count=总行数，total=区间汇总（全量聚合，不受分页影响）） */
  @Get('sale-detail')
  async saleDetail(@Query('from') from?: string, @Query('to') to?: string,
                   @Query('keyword') keyword?: string, @Query('categoryId') categoryId?: string,
                   @Query('storeId') storeId?: string,
                   @Query('page') page?: string, @Query('size') size?: string) {
    const rs = resolveReportStores(storeId);
    const p: any[] = [from || null, to || null, (keyword || '').trim(), categoryId ? Number(categoryId) : null];
    const scope = this.sf(rs, p, 'o.store_id');
    const agg = `WITH g AS (
        SELECT p.id AS product_id, p.name, p.base_unit, COALESCE(c.name,'未分类') AS category_name,
               count(DISTINCT i.order_id)::int AS "orderCount",
               COALESCE(SUM(i.qty),0) AS qty,
               COALESCE(SUM(i.line_amount),0) AS revenue,
               COALESCE(SUM(i.line_cost),0) AS cost,
               COALESCE(SUM(i.line_profit),0) AS profit
          FROM sale_items i
          JOIN sales_orders o ON o.id = i.order_id AND o.status='已完成'
          JOIN products p ON p.id = i.product_id
          LEFT JOIN categories c ON c.id = p.category_id
         WHERE ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
           AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)
           AND ($3 = '' OR p.name ILIKE '%'||$3||'%' OR p.barcode = $3)
           AND ($4::bigint IS NULL OR p.category_id = $4::bigint)${scope}
         GROUP BY p.id, p.name, p.base_unit, c.name
        HAVING COALESCE(SUM(i.line_amount),0) > 0)`;
    const cnt = await q1<any>(
      `${agg} SELECT count(*)::int AS n, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(revenue),0) AS revenue,
              COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(profit),0) AS profit,
              COALESCE(SUM("orderCount"),0) AS "orderCount" FROM g`, p);
    const pageSize = Math.min(Math.max(Number(size) || 10, 1), 2000);
    const pg = Math.max(Number(page) || 1, 1);
    const rows = await q(
      `${agg} SELECT * FROM g ORDER BY revenue DESC, product_id LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
      [...p, pageSize, (pg - 1) * pageSize]);
    const total = {
      orderCount: Number(cnt?.orderCount ?? 0), qty: Number(cnt?.qty ?? 0),
      revenue: Number(cnt?.revenue ?? 0), cost: Number(cnt?.cost ?? 0), profit: Number(cnt?.profit ?? 0),
    };
    return { items: rows, total, count: Number(cnt?.n ?? 0), page: pg, size: pageSize };
  }

  /** 会员消费报表（P1-1 / 原型#17）：区间内消费排行 + 资产 + 新增/活跃/消费占比汇总 */
  @RequirePerms('report.view.all')
  @Get('member')
  async memberReport(@Query('from') from?: string, @Query('to') to?: string,
                     @Query('limit') limit?: string, @Query('storeId') storeId?: string,
                     @Query('size') size?: string) {
    const rs = resolveReportStores(storeId);
    const p: any[] = [from || null, to || null];
    const storeCond = rs ? ` AND o.store_id = ANY($3::bigint[])` : '';
    if (rs) p.push(rs);
    const rows = await q(
      `SELECT m.id, m.card_no, m.name, m.phone, COALESCE(l.name,'—') AS level_name,
              count(o.id)::int AS "orderCount",
              COALESCE(SUM(o.payable_amount),0) AS "salesTotal",
              COALESCE(SUM(o.profit_amount),0) AS "profitTotal",
              COALESCE(a.balance,0) AS balance,
              COALESCE(a.dividend_balance,0) AS "dividendBalance",
              COALESCE(a.points,0) AS points,
              m.last_active_date
         FROM members m
         LEFT JOIN member_levels l ON l.id = m.level_id
         LEFT JOIN member_accounts a ON a.member_id = m.id
         LEFT JOIN sales_orders o ON o.member_id = m.id AND o.status='已完成'
              AND ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
              AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${storeCond}
        WHERE m.deleted_at IS NULL
        GROUP BY m.id, m.card_no, m.name, m.phone, l.name,
                 a.balance, a.dividend_balance, a.points, m.last_active_date
       HAVING count(o.id) > 0
        ORDER BY "salesTotal" DESC, m.id
        LIMIT $${p.length + 1}`,   // V5.0.18g：size 可调（默认 100，上限 5000），不再写死窗口
      [...p, Math.min(Math.max(Number(limit) || Number(size) || 100, 1), 5000)]);
    const summary = await q1(
      `SELECT (SELECT count(*)::int FROM members WHERE deleted_at IS NULL
                AND ($1::date IS NULL OR created_at::date >= $1::date)
                AND ($2::date IS NULL OR created_at::date <= $2::date)) AS "newMembers",
              (SELECT count(DISTINCT member_id)::int FROM sales_orders
                WHERE status='已完成' AND member_id IS NOT NULL
                  AND ($1::date IS NULL OR created_at::date >= $1::date)
                  AND ($2::date IS NULL OR created_at::date <= $2::date)${storeCond}) AS "activeMembers",
              (SELECT COALESCE(SUM(payable_amount),0) FROM sales_orders WHERE status='已完成'
                AND ($1::date IS NULL OR created_at::date >= $1::date)
                AND ($2::date IS NULL OR created_at::date <= $2::date)${storeCond}) AS "allSales",
              (SELECT COALESCE(SUM(payable_amount),0) FROM sales_orders
                WHERE status='已完成' AND member_id IS NOT NULL
                  AND ($1::date IS NULL OR created_at::date >= $1::date)
                  AND ($2::date IS NULL OR created_at::date <= $2::date)${storeCond}) AS "memberSales"`,
      p);
    const memberRatio = Number(summary.allSales) > 0
      ? r2(Number(summary.memberSales) / Number(summary.allSales) * 100) : 0;
    return { items: rows, summary: { ...summary, memberRatio } };
  }

  /** 员工（收银员）业绩报表（P1-1 / 原型#17）：单数/应急/销售额/毛利/客单/退款率 */
  @RequirePerms('report.view.all')
  @Get('employee')
  async employeeReport(@Query('from') from?: string, @Query('to') to?: string,
                       @Query('cashierId') cashierId?: string, @Query('storeId') storeId?: string,
                       @Query('size') size?: string) {
    const cid = Number(cashierId) || 0;
    const rs = resolveReportStores(storeId);
    const p: any[] = [from || null, to || null, cid];
    const rows = await q(
      `SELECT e.id, e.emp_no, e.name,
              count(o.id)::int AS "orderCount",
              count(o.id) FILTER (WHERE o.is_emergency)::int AS "emergencyCount",
              COALESCE(SUM(o.goods_amount),0) AS "goodsTotal",
              COALESCE(SUM(o.promo_amount),0) AS "promoTotal",
              COALESCE(SUM(o.payable_amount),0) AS "salesTotal",
              COALESCE(SUM(o.profit_amount),0) AS "profitTotal",
              CASE WHEN count(o.id) > 0 THEN COALESCE(SUM(o.payable_amount),0)/count(o.id) ELSE 0 END AS "avgTicket",
              count(r.id)::int AS "refundCount",
              COALESCE(SUM(r.amount),0) AS "refundTotal"
         FROM employees e
         LEFT JOIN sales_orders o ON o.cashier_id = e.id AND o.status='已完成'
              AND ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
              AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${this.sf(rs, p, 'o.store_id')}
         LEFT JOIN sale_refunds r ON r.order_id = o.id
        WHERE ($3 = 0 OR e.id = $3)
        GROUP BY e.id, e.emp_no, e.name
        ORDER BY "salesTotal" DESC, e.id
        LIMIT $${p.length + 1}`,   // V5.0.18g：size 可调（默认 100，上限 5000）
      [...p, Math.min(Math.max(Number(size) || 100, 1), 5000)]);
    return { items: rows };
  }

  /** 防损监控（P1-3 / 原型#10）：取消率/退款率/负毛利单 汇总 + 按收银员明细（前端阈值标红） */
  @RequirePerms('report.view.all')
  @Get('fraud')
  async fraud(@Query('from') from?: string, @Query('to') to?: string,
              @Query('storeId') storeId?: string, @Query('size') size?: string) {
    const rs = resolveReportStores(storeId);
    const p1: any[] = [from || null, to || null];
    const p2: any[] = [from || null, to || null];
    const p3: any[] = [from || null, to || null];
    const summary = await q1(
      `SELECT count(*)::int AS "orderCount",
              count(*) FILTER (WHERE status='已取消')::int AS "cancelCount",
              count(*) FILTER (WHERE status='已完成' AND profit_amount < 0)::int AS "negProfitCount",
              COALESCE(SUM(payable_amount) FILTER (WHERE status='已取消'),0) AS "cancelAmount"
         FROM sales_orders
        WHERE ($1::date IS NULL OR created_at::date >= $1::date)
          AND ($2::date IS NULL OR created_at::date <= $2::date)${this.sf(rs, p1, 'store_id')}`,
      p1);
    const refunds = await q1(
      `SELECT count(*)::int AS "refundCount", COALESCE(SUM(amount),0) AS "refundAmount"
         FROM sale_refunds
        WHERE ($1::date IS NULL OR created_at::date >= $1::date)
          AND ($2::date IS NULL OR created_at::date <= $2::date)${this.sf(rs, p2, 'store_id')}`,
      p2);
    const byCashier = await q(
      `SELECT e.id, e.name,
              count(o.id)::int AS "orderCount",
              count(o.id) FILTER (WHERE o.status='已取消')::int AS "cancelCount",
              count(o.id) FILTER (WHERE o.status='已完成' AND o.profit_amount < 0)::int AS "negProfitCount",
              COALESCE(SUM(o.profit_amount) FILTER (WHERE o.status='已完成' AND o.profit_amount < 0),0) AS "negProfitAmount",
              count(r.id)::int AS "refundCount",
              COALESCE(SUM(r.amount),0) AS "refundAmount"
         FROM employees e
         LEFT JOIN sales_orders o ON o.cashier_id = e.id
              AND ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
              AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${this.sf(rs, p3, 'o.store_id')}
         LEFT JOIN sale_refunds r ON r.order_id = o.id
        GROUP BY e.id, e.name
       HAVING count(o.id) > 0
        ORDER BY "orderCount" DESC, e.id
        LIMIT $${p3.length + 1}`,   // V5.0.18g：size 可调（默认 50，上限 5000）
      [...p3, Math.min(Math.max(Number(size) || 50, 1), 5000)]);
    const oc = Number(summary.orderCount) || 0;
    const rc = Number(refunds.refundCount) || 0;
    return {
      summary: {
        ...summary, ...refunds,
        cancelRate: oc ? r2(Number(summary.cancelCount) / oc * 100) : 0,
        refundRate: oc ? r2(rc / oc * 100) : 0,
        negProfitRate: oc ? r2(Number(summary.negProfitCount) / oc * 100) : 0,
      },
      byCashier,
    };
  }

  /** 进销存报表（方向1 / 原型#17）：按商品聚合 期初/入库/出库/期末数量 + 区间销售金额/成本/毛利 */
  @RequirePerms('report.view.all')
  @Get('inventory')
  async inventoryReport(@Query('from') from?: string, @Query('to') to?: string,
                        @Query('keyword') keyword?: string, @Query('categoryId') categoryId?: string,
                        @Query('storeId') storeId?: string, @Query('size') size?: string) {
    const rs = resolveReportStores(storeId);
    const p: any[] = [from || null, to || null, (keyword || '').trim(), categoryId ? Number(categoryId) : null];
    // 流水/销售共用同一门店范围参数（追加在尾部，子查询内多处引用同一占位符）
    const fCond = rs ? ` AND f.store_id = ANY($${p.length + 1}::bigint[])` : '';
    const oCond = rs ? ` AND o.store_id = ANY($${p.length + 1}::bigint[])` : '';
    if (rs) p.push(rs);
    // P-04 修复：原对每个商品跑 5 个相关子查询（期初/入库/出库/出库成本/HAVING EXISTS），
    // 2 万 SKU ≈ 10 万次 stock_flows 扫描（created_at::date 还废索引）→ 分钟级。
    // 改为对 stock_flows 一次扫描 GROUP BY product_id（CASE 聚合四项 + bool_or 替代 EXISTS），
    // 再 LEFT JOIN 回商品。语义等价：open 严格 < $1；in/out BETWEEN（NULL 即不计）；has_flow <= $2 与原 EXISTS 同口径。
    const rows = await q(
      `SELECT p.id, p.name, p.base_unit, COALESCE(c.name,'未分类') AS category_name,
              ROUND(COALESCE(fa.open_qty,0),3) AS open_qty,
              ROUND(COALESCE(fa.in_qty,0),3) AS in_qty,
              ROUND(COALESCE(fa.out_qty,0),3) AS out_qty,
              ROUND(COALESCE(fa.out_cost,0),2) AS out_cost,
              COALESCE(SUM(si.line_amount),0) AS sale_amount,
              COALESCE(SUM(si.line_cost),0) AS sale_cost,
              COALESCE(SUM(si.line_profit),0) AS sale_profit,
              count(DISTINCT si.order_id)::int AS sale_orders
         FROM products p
         LEFT JOIN (
           SELECT f.product_id,
                  SUM(CASE WHEN f.created_at::date < $1::date
                           THEN CASE WHEN f.direction='入库' THEN f.qty ELSE -f.qty END ELSE 0 END) AS open_qty,
                  SUM(CASE WHEN f.direction='入库' AND f.created_at::date BETWEEN $1::date AND $2::date THEN f.qty ELSE 0 END) AS in_qty,
                  SUM(CASE WHEN f.direction='出库' AND f.created_at::date BETWEEN $1::date AND $2::date THEN f.qty ELSE 0 END) AS out_qty,
                  SUM(CASE WHEN f.direction='出库' AND f.created_at::date BETWEEN $1::date AND $2::date THEN f.qty*f.unit_cost ELSE 0 END) AS out_cost,
                  bool_or(f.created_at::date <= $2::date) AS has_flow
             FROM stock_flows f
            WHERE true${fCond}
            GROUP BY f.product_id
         ) fa ON fa.product_id = p.id
         LEFT JOIN sale_items si ON si.product_id=p.id AND si.order_id IN (
           SELECT o.id FROM sales_orders o WHERE o.status='已完成'
             AND ($1::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date >= $1::date)
             AND ($2::date IS NULL OR COALESCE(o.pay_paid_at, o.created_at)::date <= $2::date)${oCond})
         LEFT JOIN categories c ON c.id=p.category_id
        WHERE ($3 = '' OR p.name ILIKE '%'||$3||'%' OR p.barcode = $3)
          AND ($4::bigint IS NULL OR p.category_id = $4::bigint)
        GROUP BY p.id, p.name, p.base_unit, c.name,
                 fa.open_qty, fa.in_qty, fa.out_qty, fa.out_cost, fa.has_flow
       HAVING COALESCE(SUM(si.line_amount),0) <> 0 OR COALESCE(fa.has_flow,false)
        ORDER BY sale_amount DESC, p.id
        LIMIT $${p.length + 1}`,   // V5.0.18g：size 可调（默认 500，上限 5000）
      [...p, Math.min(Math.max(Number(size) || 500, 1), 5000)]);
    // Q-04 B1：金额字段分整数累加（数量/计数保持原口径）
    const total = rows.reduce((s: any, r: any) => ({
      openQty: s.openQty + Number(r.open_qty), inQty: s.inQty + Number(r.in_qty), outQty: s.outQty + Number(r.out_qty),
      saleOrders: s.saleOrders + Number(r.sale_orders),
      saleAmountC: s.saleAmountC + toCents(r.sale_amount), saleCostC: s.saleCostC + toCents(r.sale_cost),
      saleProfitC: s.saleProfitC + toCents(r.sale_profit),
    }), { openQty: 0, inQty: 0, outQty: 0, saleOrders: 0, saleAmountC: 0, saleCostC: 0, saleProfitC: 0 });
    return { items: rows, total: { openQty: total.openQty, inQty: total.inQty, outQty: total.outQty, saleOrders: total.saleOrders,
      saleAmount: total.saleAmountC / 100, saleCost: total.saleCostC / 100, saleProfit: total.saleProfitC / 100 } };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * V5.0.0 批次6（M6-2 / M6-7）：总部专有报表（§5.3.2）
 *   权限 hq.report.allstore；单店部署下门店只有一家，行为=全店报表（零回归）
 *   性能（§5.3.4）：日期区间必填上限（默认近 30 天、最多 366 天），防全表扫描
 * ═══════════════════════════════════════════════════════════════════════════ */
@Controller('hq/reports')
class HqReportsController {

  /** 解析日期区间（默认近 30 天；上限 366 天） */
  private range(from?: string, to?: string): { from: string; to: string } {
    const now = new Date();
    const f = from ? new Date(from) : new Date(now.getTime() - 29 * 86400_000);
    const t = to ? new Date(to) : now;
    let fs = f.toISOString().slice(0, 10), ts = t.toISOString().slice(0, 10);
    if (new Date(ts).getTime() - new Date(fs).getTime() > 366 * 86400_000) {
      fs = new Date(new Date(ts).getTime() - 366 * 86400_000).toISOString().slice(0, 10);
    }
    return { from: fs, to: ts };
  }

  /**
   * P2-2：跨店聚合优先读物化视图 mv_hq_sales_daily（push 后去抖刷新，近实时）；
   * 物化视图未建（老库迁移未跑）→ 回退实时扫 sales_orders，行为与批次6 一致。
   */
  private async mvOr<T>(mvSql: string, liveSql: string, params: any[]): Promise<T[]> {
    try {
      return await q<T>(mvSql, params);
    } catch (e: any) {
      if (String(e?.code) === '42P01') return q<T>(liveSql, params);   // undefined_table
      throw e;
    }
  }

  /** P2-2：手动刷新日报物化视图（自动机制：push 后 10s 去抖 + 每日对账 job 收尾各刷一次） */
  @RequirePerms('hq.report.allstore')
  @Post('refresh-daily')
  async refreshDaily() {
    await q(`SELECT refresh_hq_sales_daily()`);
    return { ok: true };
  }

  /** 门店销售日报：各店 单量/销售额/毛利/毛利率/客单价 + 合计行（P2-2：读物化视图） */
  @RequirePerms('hq.report.allstore')
  @Get('store-daily')
  async storeDaily(@Query('from') from?: string, @Query('to') to?: string) {
    const r = this.range(from, to);
    const rows = await this.mvOr<any>(
      `SELECT s.id AS store_id, s.name AS store_name,
              COALESCE(SUM(m.order_count),0)::int AS "orderCount",
              COALESCE(SUM(m.sales_total),0) AS "salesTotal",
              COALESCE(SUM(m.cost_total),0) AS "costTotal",
              COALESCE(SUM(m.profit_total),0) AS "profitTotal",
              CASE WHEN COALESCE(SUM(m.order_count),0) > 0
                   THEN COALESCE(SUM(m.sales_total),0)/SUM(m.order_count) ELSE 0 END AS "avgTicket"
         FROM stores s
         LEFT JOIN mv_hq_sales_daily m ON m.store_id = s.id AND m.sale_day BETWEEN $1::date AND $2::date
        WHERE s.status = 1
        GROUP BY s.id, s.name
       HAVING COALESCE(SUM(m.order_count),0) > 0 OR s.org_type = 'hq'
        ORDER BY "salesTotal" DESC`,
      `SELECT s.id AS store_id, s.name AS store_name,
              count(o.id)::int AS "orderCount",
              COALESCE(SUM(o.payable_amount),0) AS "salesTotal",
              COALESCE(SUM(o.cost_amount),0) AS "costTotal",
              COALESCE(SUM(o.profit_amount),0) AS "profitTotal",
              CASE WHEN count(o.id) > 0 THEN COALESCE(SUM(o.payable_amount),0)/count(o.id) ELSE 0 END AS "avgTicket"
         FROM stores s
         LEFT JOIN sales_orders o ON o.store_id = s.id AND o.status='已完成'
               AND COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date
        WHERE s.status = 1
        GROUP BY s.id, s.name
       HAVING count(o.id) > 0 OR s.org_type = 'hq'
        ORDER BY "salesTotal" DESC`, [r.from, r.to]);
    const items = rows.map((x: any) => ({
      ...x,
      margin: Number(x.salesTotal) > 0 ? r2(Number(x.profitTotal) / Number(x.salesTotal) * 100) : 0,
    }));
    // Q-04 B1：金额分整数累加（计数保持原口径）
    const total = items.reduce((a: any, x: any) => ({
      orderCount: a.orderCount + Number(x.orderCount), salesTotalC: a.salesTotalC + toCents(x.salesTotal),
      costTotalC: a.costTotalC + toCents(x.costTotal), profitTotalC: a.profitTotalC + toCents(x.profitTotal),
    }), { orderCount: 0, salesTotalC: 0, costTotalC: 0, profitTotalC: 0 });
    const salesTotal = total.salesTotalC / 100, costTotal = total.costTotalC / 100, profitTotal = total.profitTotalC / 100;
    return { from: r.from, to: r.to, items, total: { orderCount: total.orderCount, salesTotal, costTotal, profitTotal,
      margin: salesTotal > 0 ? r2(profitTotal / salesTotal * 100) : 0 } };
  }

  /** 门店排行：本区间 vs 上一区间销售额对比（增长%，红涨绿跌前端渲染）（P2-2：读物化视图） */
  @RequirePerms('hq.report.allstore')
  @Get('store-rank')
  async storeRank(@Query('from') from?: string, @Query('to') to?: string) {
    const r = this.range(from, to);
    const days = Math.max(1, Math.round((new Date(r.to).getTime() - new Date(r.from).getTime()) / 86400_000) + 1);
    const prevTo = new Date(new Date(r.from).getTime() - 86400_000).toISOString().slice(0, 10);
    const prevFrom = new Date(new Date(prevTo).getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10);
    const rows = await this.mvOr<any>(
      `SELECT s.id AS store_id, s.name AS store_name,
              COALESCE(SUM(m.sales_total) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0) AS cur_sales,
              COALESCE(SUM(m.order_count) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0)::int AS cur_orders,
              COALESCE(SUM(m.sales_total) FILTER (WHERE m.sale_day BETWEEN $3::date AND $4::date),0) AS prev_sales
         FROM stores s
         LEFT JOIN mv_hq_sales_daily m ON m.store_id = s.id
        WHERE s.status = 1
        GROUP BY s.id, s.name
       HAVING COALESCE(SUM(m.sales_total),0) > 0 OR s.org_type = 'hq'
        ORDER BY cur_sales DESC`,
      `SELECT s.id AS store_id, s.name AS store_name,
              COALESCE(SUM(o.payable_amount) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date),0) AS cur_sales,
              count(o.id) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date)::int AS cur_orders,
              COALESCE(SUM(o.payable_amount) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $3::date AND $4::date),0) AS prev_sales
         FROM stores s
         LEFT JOIN sales_orders o ON o.store_id = s.id AND o.status='已完成'
        WHERE s.status = 1
        GROUP BY s.id, s.name
       HAVING COALESCE(SUM(o.payable_amount),0) > 0 OR s.org_type = 'hq'
        ORDER BY cur_sales DESC`,
      [r.from, r.to, prevFrom, prevTo]);
    const items = rows.map((x: any) => ({
      ...x,
      growth: Number(x.prev_sales) > 0 ? r2((Number(x.cur_sales) - Number(x.prev_sales)) / Number(x.prev_sales) * 100)
            : (Number(x.cur_sales) > 0 ? 100 : 0),
    }));
    return { from: r.from, to: r.to, prevFrom, prevTo, items };
  }

  /** 门店对比：环比（上一等长区间）与同比（去年同期）（P2-2：读物化视图） */
  @RequirePerms('hq.report.allstore')
  @Get('store-compare')
  async storeCompare(@Query('from') from?: string, @Query('to') to?: string) {
    const r = this.range(from, to);
    const days = Math.max(1, Math.round((new Date(r.to).getTime() - new Date(r.from).getTime()) / 86400_000) + 1);
    const prevTo = new Date(new Date(r.from).getTime() - 86400_000).toISOString().slice(0, 10);
    const prevFrom = new Date(new Date(prevTo).getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10);
    const yToFrom = new Date(new Date(r.from).getTime() - 365 * 86400_000).toISOString().slice(0, 10);
    const yToTo = new Date(new Date(r.to).getTime() - 365 * 86400_000).toISOString().slice(0, 10);
    const rows = await this.mvOr<any>(
      `SELECT s.id AS store_id, s.name AS store_name,
              COALESCE(SUM(m.sales_total) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0) AS cur_sales,
              COALESCE(SUM(m.profit_total) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0) AS cur_profit,
              COALESCE(SUM(m.sales_total) FILTER (WHERE m.sale_day BETWEEN $3::date AND $4::date),0) AS prev_sales,
              COALESCE(SUM(m.sales_total) FILTER (WHERE m.sale_day BETWEEN $5::date AND $6::date),0) AS yoy_sales
         FROM stores s
         LEFT JOIN mv_hq_sales_daily m ON m.store_id = s.id
        WHERE s.status = 1
        GROUP BY s.id, s.name
       HAVING COALESCE(SUM(m.sales_total),0) > 0 OR s.org_type = 'hq'
        ORDER BY cur_sales DESC`,
      `SELECT s.id AS store_id, s.name AS store_name,
              COALESCE(SUM(o.payable_amount) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date),0) AS cur_sales,
              COALESCE(SUM(o.profit_amount) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date),0) AS cur_profit,
              COALESCE(SUM(o.payable_amount) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $3::date AND $4::date),0) AS prev_sales,
              COALESCE(SUM(o.payable_amount) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $5::date AND $6::date),0) AS yoy_sales
         FROM stores s
         LEFT JOIN sales_orders o ON o.store_id = s.id AND o.status='已完成'
        WHERE s.status = 1
        GROUP BY s.id, s.name
       HAVING COALESCE(SUM(o.payable_amount),0) > 0 OR s.org_type = 'hq'
        ORDER BY cur_sales DESC`,
      [r.from, r.to, prevFrom, prevTo, yToFrom, yToTo]);
    const pct = (cur: number, base: number) =>
      base > 0 ? r2((cur - base) / base * 100) : (cur > 0 ? 100 : 0);
    const items = rows.map((x: any) => ({
      ...x,
      mom: pct(Number(x.cur_sales), Number(x.prev_sales)),   // 环比
      yoy: pct(Number(x.cur_sales), Number(x.yoy_sales)),    // 同比
    }));
    return { from: r.from, to: r.to, prevFrom, prevTo, yoyFrom: yToFrom, yoyTo: yToTo, items };
  }

  /**
   * 区域汇总（V5.0.0 P2-7）：按门店 region 分组（region 空 → 「未分区」）。
   * 店数 / 单量 / 销售额 / 毛利 / 毛利率 + 环比（对上一等长区间）。读物化视图，缺失回退 live。
   */
  @RequirePerms('hq.report.allstore')
  @Get('region-summary')
  async regionSummary(@Query('from') from?: string, @Query('to') to?: string) {
    const r = this.range(from, to);
    const days = Math.max(1, Math.round((new Date(r.to).getTime() - new Date(r.from).getTime()) / 86400_000) + 1);
    const prevTo = new Date(new Date(r.from).getTime() - 86400_000).toISOString().slice(0, 10);
    const prevFrom = new Date(new Date(prevTo).getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10);
    const rows = await this.mvOr<any>(
      `SELECT COALESCE(NULLIF(s.region,''),'未分区') AS region,
              COUNT(DISTINCT s.id)::int AS store_count,
              COALESCE(SUM(m.order_count) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0)::int AS order_count,
              COALESCE(SUM(m.sales_total) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0) AS sales_total,
              COALESCE(SUM(m.cost_total) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0) AS cost_total,
              COALESCE(SUM(m.profit_total) FILTER (WHERE m.sale_day BETWEEN $1::date AND $2::date),0) AS profit_total,
              COALESCE(SUM(m.sales_total) FILTER (WHERE m.sale_day BETWEEN $3::date AND $4::date),0) AS prev_sales
         FROM stores s
         LEFT JOIN mv_hq_sales_daily m ON m.store_id = s.id
        WHERE s.status = 1 AND s.org_type = 'store'
        GROUP BY 1
        ORDER BY sales_total DESC`,
      `SELECT COALESCE(NULLIF(s.region,''),'未分区') AS region,
              COUNT(DISTINCT s.id)::int AS store_count,
              count(o.id)::int AS order_count,
              COALESCE(SUM(o.payable_amount),0) AS sales_total,
              COALESCE(SUM(o.cost_amount),0) AS cost_total,
              COALESCE(SUM(o.profit_amount),0) AS profit_total,
              COALESCE(SUM(o.payable_amount) FILTER (WHERE COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $3::date AND $4::date),0) AS prev_sales
         FROM stores s
         LEFT JOIN sales_orders o ON o.store_id = s.id AND o.status='已完成'
               AND COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date
        WHERE s.status = 1 AND s.org_type = 'store'
        GROUP BY 1
        ORDER BY sales_total DESC`, [r.from, r.to, prevFrom, prevTo]);
    const items = rows.map((x: any) => ({
      ...x,
      margin: Number(x.sales_total) > 0 ? r2(Number(x.profit_total) / Number(x.sales_total) * 100) : 0,
      growth: Number(x.prev_sales) > 0 ? r2((Number(x.sales_total) - Number(x.prev_sales)) / Number(x.prev_sales) * 100)
            : (Number(x.sales_total) > 0 ? 100 : 0),
    }));
    // Q-04 B1：金额分整数累加（计数保持原口径）
    const total = items.reduce((a: any, x: any) => ({
      store_count: a.store_count + Number(x.store_count),
      order_count: a.order_count + Number(x.order_count),
      sales_totalC: a.sales_totalC + toCents(x.sales_total),
      profit_totalC: a.profit_totalC + toCents(x.profit_total),
    }), { store_count: 0, order_count: 0, sales_totalC: 0, profit_totalC: 0 });
    const sales_total = total.sales_totalC / 100, profit_total = total.profit_totalC / 100;
    return { from: r.from, to: r.to, prevFrom, prevTo, items,
      total: { store_count: total.store_count, order_count: total.order_count, sales_total, profit_total,
        margin: sales_total > 0 ? r2(profit_total / sales_total * 100) : 0 } };
  }

  /** 库存汇总：各店 SKU 数 / 库存金额（在库批次成本）/ 临期数 / 低库存数（复用批次账本） */
  @RequirePerms('hq.report.allstore')
  @Get('stock-summary')
  async stockSummary() {
    const rows = await q(
      `SELECT s.id AS store_id, s.name AS store_name,
              count(DISTINCT ic.product_id)::int AS sku_count,
              COALESCE((SELECT SUM(b.remain_qty * b.inbound_cost) FROM batches b
                         WHERE b.store_id = s.id AND b.status='在库' AND b.remain_qty > 0),0) AS stock_value,
              COALESCE((SELECT count(*) FROM batches b
                         WHERE b.store_id = s.id AND b.status='在库' AND b.remain_qty > 0
                           AND b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE + 30),0)::int AS expiring_count,
              COALESCE((SELECT count(*) FROM inventory_current ic2
                         JOIN products p ON p.id = ic2.product_id AND p.deleted_at IS NULL
                        WHERE ic2.store_id = s.id AND ic2.qty_total <= COALESCE(p.min_stock, 0)),0)::int AS low_count,
              COALESCE((SELECT SUM(ic2.qty_total) FROM inventory_current ic2 WHERE ic2.store_id = s.id
                         AND ic2.qty_total < 0),0) AS negative_qty
         FROM stores s
         LEFT JOIN inventory_current ic ON ic.store_id = s.id
        WHERE s.status = 1
        GROUP BY s.id, s.name
        ORDER BY stock_value DESC`);
    return { items: rows };
  }

  /** 调拨在途：在途单/金额/超期未收（>2 天标红，前端渲染） */
  @RequirePerms('hq.report.allstore')
  @Get('transfer-intransit')
  async transferIntransit(@Query('size') size?: string) {
    const rows = await q(
      `SELECT t.id, t.transfer_no, t.biz_scope, t.total_cost, t.shipped_at,
              t.shipped_at::date AS ship_date,
              (CURRENT_DATE - t.shipped_at::date) AS transit_days,
              fs.name AS from_store_name, ts.name AS to_store_name,
              COALESCE((SELECT SUM(i.qty) FROM stock_transfer_items i WHERE i.transfer_id = t.id),0) AS total_qty,
              COALESCE((SELECT SUM(COALESCE(i.recv_qty,0)) FROM stock_transfer_items i WHERE i.transfer_id = t.id),0) AS recv_qty
         FROM stock_transfers t
         LEFT JOIN stores fs ON fs.id = t.from_store_id
         LEFT JOIN stores ts ON ts.id = t.to_store_id
        WHERE t.status = '在途'
        ORDER BY t.shipped_at ASC NULLS LAST LIMIT $1`, [Math.min(Math.max(Number(size) || 200, 1), 5000)]);   // V5.0.18g：size 可调
    return { items: rows };
  }

  /** 同步健康度（V11 运维视角）：各店待传/失败/死信/最后同步时间 */
  @RequirePerms('hq.report.allstore')
  @Get('sync-health')
  async syncHealth() {
    const rows = await q(
      `SELECT s.id AS store_id, s.name AS store_name, n.node_code, n.status AS node_status,
              n.last_report, n.paused_until,
              COALESCE(ob.pending,0)::int AS pending_count,
              COALESCE(ob.failed,0)::int AS failed_count,
              COALESCE(ob.dead,0)::int AS dead_count,
              ob.last_push
         FROM stores s
         LEFT JOIN sync_nodes n ON n.store_id = s.id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE o.status IN ('pending','failed')) AS pending,
                  count(*) FILTER (WHERE o.status = 'failed') AS failed,
                  count(*) FILTER (WHERE o.status = 'dead') AS dead,
                  max(o.created_at) AS last_push
             FROM sync_outbox o WHERE o.node_code = n.node_code) ob ON true
        WHERE s.status = 1
        ORDER BY pending_count DESC, s.id`);
    return { items: rows };
  }

  /** 退货双维度（M6-7 / R9，V16 必测）：①受理店口径 ②原销店口径 ③跨店流向矩阵 */
  @RequirePerms('hq.report.allstore')
  @Get('return-dual')
  async returnDual(@Query('from') from?: string, @Query('to') to?: string) {
    const r = this.range(from, to);
    const byAccept = await q(
      `SELECT s.id AS store_id, s.name AS store_name,
              count(r.id)::int AS refund_count,
              COALESCE(SUM(r.amount),0) AS refund_amount,
              count(r.id) FILTER (WHERE r.is_cross_store)::int AS cross_count,
              COALESCE(SUM(r.amount) FILTER (WHERE r.is_cross_store),0) AS cross_amount
         FROM stores s
         LEFT JOIN sale_refunds r ON r.store_id = s.id
               AND r.created_at::date BETWEEN $1::date AND $2::date
        WHERE s.status = 1
        GROUP BY s.id, s.name HAVING count(r.id) > 0
        ORDER BY refund_amount DESC`, [r.from, r.to]);
    const byOrigin = await q(
      `SELECT s.id AS store_id, s.name AS store_name,
              count(r.id)::int AS refund_count,
              COALESCE(SUM(r.amount),0) AS refund_amount,
              COALESCE(SUM(o.payable_amount),0) AS sales_amount
         FROM stores s
         LEFT JOIN sale_refunds r ON COALESCE(r.origin_store_id, r.store_id) = s.id
               AND r.created_at::date BETWEEN $1::date AND $2::date
         LEFT JOIN sales_orders o ON o.store_id = s.id AND o.status='已完成'
               AND COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date
        WHERE s.status = 1
        GROUP BY s.id, s.name
        ORDER BY refund_amount DESC`, [r.from, r.to]);
    const matrix = await q(
      `SELECT ostore.name AS from_store, astore.name AS to_store,
              count(*)::int AS cnt, COALESCE(SUM(r.amount),0) AS amount
         FROM sale_refunds r
         JOIN stores ostore ON ostore.id = COALESCE(r.origin_store_id, r.store_id)
         JOIN stores astore ON astore.id = r.store_id
        WHERE r.created_at::date BETWEEN $1::date AND $2::date AND r.is_cross_store
        GROUP BY ostore.name, astore.name
        ORDER BY amount DESC`, [r.from, r.to]);
    const refundRate = (x: any) =>
      Number(x.sales_amount) > 0 ? r2(Number(x.refund_amount) / Number(x.sales_amount) * 100) : 0;
    return {
      from: r.from, to: r.to, byAccept,
      byOrigin: byOrigin.map((x: any) => ({ ...x, refund_rate: refundRate(x) })),
      matrix,
    };
  }

  /** 门店往来（跨店资金对账）：各店应付/应收未结清汇总 + 明细 */
  @RequirePerms('hq.report.allstore')
  @Get('intercompany')
  async intercompany(@Query('size') size?: string) {
    const lim = Math.min(Math.max(Number(size) || 300, 1), 5000);   // V5.0.18g：size 可调
    const rows = await q(
      `SELECT l.id, l.biz_type, l.biz_ref, l.amount, l.qty, l.status, l.created_at,
              fstore.name AS from_store_name, tstore.name AS to_store_name
         FROM store_intercompany_ledger l
         LEFT JOIN stores fstore ON fstore.id = l.from_store_id
         LEFT JOIN stores tstore ON tstore.id = l.to_store_id
        ORDER BY l.status, l.created_at DESC LIMIT $1`, [lim]);
    const summary = await q1(
      `SELECT count(*) FILTER (WHERE status='pending')::int AS pending_count,
              COALESCE(SUM(amount) FILTER (WHERE status='pending'),0) AS pending_amount
         FROM store_intercompany_ledger`);
    return { summary, items: rows };
  }

  /** 进价偏离与异常（R8/R16 防舞弊信号）：待审进价单 + L1 变更留痕排行 */
  @RequirePerms('hq.report.allstore')
  @Get('cost-deviation')
  async costDeviation(@Query('from') from?: string, @Query('to') to?: string, @Query('size') size?: string) {
    const lim = Math.min(Math.max(Number(size) || 100, 1), 5000);   // V5.0.18g：size 可调
    const r = this.range(from, to);
    const pending = await q(
      `SELECT d.id, d.anomaly, d.status, d.created_at, s.name AS store_name,
              p.name AS product_name, d.qty, d.doc_no,
              d.l1_at_request, d.actual_cost, d.gap_amount, d.due_at,
              CASE WHEN COALESCE(d.l1_at_request,0) > 0
                   THEN ROUND((d.actual_cost - d.l1_at_request) / d.l1_at_request * 100, 2) ELSE NULL END AS gap_pct
         FROM cost_diff_requests d
         LEFT JOIN stores s ON s.id = d.store_id
         LEFT JOIN products p ON p.id = d.product_id
        WHERE d.status = 'pending'
        ORDER BY COALESCE(d.gap_amount, 0) DESC, d.created_at DESC LIMIT $1`, [lim]);
    const logs = await q(
      `SELECT s.name AS store_name, l.source, count(*)::int AS change_count,
              COALESCE(SUM(l.delta),0) AS total_delta
         FROM product_standard_cost_logs l
         LEFT JOIN stores s ON s.id = l.store_id
        WHERE l.created_at::date BETWEEN $1::date AND $2::date
        GROUP BY s.name, l.source ORDER BY total_delta ASC LIMIT 50`, [r.from, r.to]);
    return { from: r.from, to: r.to, pending, logs };
  }

  /** 会员跨店分析：活跃店数 / 跨店消费分布（R4 连锁会员口径） */
  @RequirePerms('hq.member.crossview')
  @Get('member-cross')
  async memberCross(@Query('from') from?: string, @Query('to') to?: string, @Query('size') size?: string) {
    const r = this.range(from, to);
    const rows = await q(
      `SELECT m.id, m.card_no, m.name,
              count(DISTINCT o.store_id)::int AS active_stores,
              COALESCE(SUM(o.payable_amount),0) AS total_spend,
              count(DISTINCT f.id)::int AS cross_flows,
              COALESCE(SUM(CASE WHEN f.direction='出' THEN f.amount ELSE 0 END),0) AS cross_debit
         FROM members m
         LEFT JOIN sales_orders o ON o.member_id = m.id AND o.status='已完成'
               AND COALESCE(o.pay_paid_at, o.created_at)::date BETWEEN $1::date AND $2::date
         LEFT JOIN member_cross_store_flows f ON f.member_id = m.id
               AND f.biz_ts::date BETWEEN $1::date AND $2::date
        WHERE m.deleted_at IS NULL
          AND (o.id IS NOT NULL OR f.id IS NOT NULL)
        GROUP BY m.id, m.card_no, m.name
       HAVING count(DISTINCT o.store_id) > 1 OR count(DISTINCT f.id) > 0
        ORDER BY total_spend DESC LIMIT $3`, [r.from, r.to, Math.min(Math.max(Number(size) || 100, 1), 5000)]);   // V5.0.18g：size 可调
    return { from: r.from, to: r.to, items: rows };
  }
}

@Module({ controllers: [ReportsController, HqReportsController] })
export class ReportsModule {}
