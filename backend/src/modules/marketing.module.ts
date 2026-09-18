/**
 * 智能营销引擎（P2-1，方案 P2-8）：3 条规则 = 生日触达 / 临期折扣 / 分红到期提醒
 *   - 定时：进程内 setInterval 每分钟检查，到达 marketing.run_time 且当日未跑则执行（零依赖，不引 node-cron）；
 *     进程在时段后启动也会补跑当天
 *   - 触达留痕 marketing_touches；同规则同对象当天去重
 *   - 手动：POST /marketing/run 立即执行（ruleKey 可选单跑一条），管理端按钮直达
 *   - 权限：改规则/执行 = marketing.manage；查看触达 = report.view.all
 */
import { Controller, Get, Injectable, Module, OnModuleInit, Param, Post, Put, Query, Body } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q, q1, r2, tx, cx, audit } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价

@Injectable()
export class MarketingService implements OnModuleInit {
  private timer: NodeJS.Timeout | null = null;

  /** pg 8.x 将 DATE 列返回为 Date 对象（上海时区午夜），统一格式化为 YYYY-MM-DD */
  private fmtD(v: any): string {
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    return String(v).slice(0, 10);
  }

  onModuleInit() {
    // 每分钟检查一次（单条 SELECT，开销可忽略）；当日已跑则跳过
    this.timer = setInterval(() => { this.maybeRun().catch(e => console.error('[营销引擎] 定时执行失败:', e.message)); }, 60_000);
    this.maybeRun().catch(e => console.error('[营销引擎] 启动执行失败:', e.message));
  }

  private async maybeRun() {
    const r = await q1<any>(`SELECT value FROM system_settings WHERE setting_key='marketing.run_time'`);
    const t = String(r?.value ?? '08:30');
    const [hh, mm] = t.split(':').map(Number);
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < (hh || 8) * 60 + (mm || 30)) return;
    const done = await q1<any>(`SELECT 1 FROM marketing_rules WHERE last_run_at::date = CURRENT_DATE LIMIT 1`);
    if (done) return;
    await this.runRules();
  }

  /** 执行规则引擎：默认全部启用规则；keys 传入则只跑指定规则（手动触发单条） */
  async runRules(keys?: string[]) {
    const rules = await q<any>(`SELECT * FROM marketing_rules WHERE store_id=${curStore()} AND enabled ORDER BY id`);
    const targets = keys?.length ? rules.filter(r => keys.includes(r.rule_key)) : rules;
    const byRule: Record<string, number> = {};
    for (const r of targets) {
      try {
        byRule[r.rule_key] = await this.runRule(r);
        await q(`UPDATE marketing_rules SET last_run_at=now() WHERE id=$1`, [r.id]);
      } catch (e: any) {
        console.error(`[营销引擎] 规则 ${r.rule_key} 执行失败:`, e.message);
        byRule[r.rule_key] = -1;
      }
    }
    return { ran: targets.map(r => r.rule_key), byRule };
  }

  private async runRule(rule: any): Promise<number> {
    const cfg = { ...(rule.config || {}) };
    switch (rule.rule_key) {
      case 'birthday':      return this.birthday(rule, Number(cfg.lead_days ?? 3));
      case 'expiry':        return this.expiry(rule, Number(cfg.lead_days ?? 15), Number(cfg.discount ?? 0.8));
      case 'dividend':      return this.dividend(rule, Number(cfg.lead_days ?? 3));
      case 'dormant':       return this.dormant(rule, Number(cfg.silent_days ?? 30));
      case 'low_balance':   return this.lowBalance(rule, Number(cfg.threshold ?? 20));
      case 'guest_convert': return this.guestConvert(rule, Number(cfg.min_visits ?? 3), Number(cfg.days ?? 90));
      case 'receivable':    return this.receivable(rule, Number(cfg.aging_days ?? 30));
      default: return 0;
    }
  }

  /** 规则 1：生日触达——未来 lead 天内过生日的会员（跨年/2月29 由 JS 日期自动归一化） */
  private async birthday(rule: any, lead: number): Promise<number> {
    const mmdd: string[] = [];
    const now = new Date();
    for (let i = 0; i <= lead; i++) {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      mmdd.push(`${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
    }
    const rows = await q<any>(
      `SELECT m.id, m.name, m.phone, m.birthday FROM members m
        WHERE m.store_id=$1 AND m.status='正常' AND m.deleted_at IS NULL AND m.birthday IS NOT NULL
          AND to_char(m.birthday,'MM-DD') = ANY($2)
          AND NOT EXISTS (SELECT 1 FROM marketing_touches t
                           WHERE t.touch_type='birthday' AND t.member_id=m.id AND t.created_at::date=CURRENT_DATE)`,
      [rule.store_id, mmdd]);
    for (const m of rows) {
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, member_id, touch_type, title, content, payload, status, channel)
         VALUES ($1,$2,$3,'birthday',$4,$5,$6,'待处理','站内信')`,
        [rule.store_id, rule.id, m.id, '🎂 生日专属提醒',
         `尊敬的${m.name}，您的生日（${this.fmtD(m.birthday).slice(5)}）即将到来，凭会员卡到店消费享专属优惠！`,
         JSON.stringify({ birthday: this.fmtD(m.birthday), phone: m.phone })]);
    }
    return rows.length;
  }

  /** 规则 2：临期折扣——在库批次距过期 ≤ lead 天且有余量，建议按折扣价促销去化 */
  private async expiry(rule: any, lead: number, discount: number): Promise<number> {
    const rows = await q<any>(
      `SELECT b.id, b.product_id, b.batch_no, b.expiry_date, b.remain_qty, b.inbound_cost,
              p.name AS product_name, p.sell_price, p.base_unit
         FROM batches b JOIN products p ON p.id=b.product_id
        WHERE b.store_id=$1 AND b.status='在库' AND b.remain_qty>0
          AND b.expiry_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + $2::int)
          AND NOT EXISTS (SELECT 1 FROM marketing_touches t
                           WHERE t.touch_type='expiry' AND t.batch_id=b.id AND t.created_at::date=CURRENT_DATE)`,
      [rule.store_id, lead]);
    // V4.26.5 按门店隔离价格：临期折扣建议价按该门店售价推算（注意本行 id 是批次 id，须用 product_id 映射）
    await storePrice.overlay(rule.store_id, rows);
    for (const b of rows) {
      const rate = Math.round(discount * 10) / 10;
      const suggest = r2(Number(b.sell_price) * discount);
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, product_id, batch_id, touch_type, title, content, payload, status, channel)
         VALUES ($1,$2,$3,$4,'expiry',$5,$6,$7,'待处理','站内信')`,
        [rule.store_id, rule.id, b.product_id, b.id, '⏳ 临期预警',
         `${b.product_name}（批次 ${b.batch_no}）：${this.fmtD(b.expiry_date)} 到期，余 ${b.remain_qty}${b.base_unit}；建议 ${rate} 折（¥${suggest}）促销去化`,
         JSON.stringify({ batchNo: b.batch_no, expiryDate: this.fmtD(b.expiry_date), remainQty: Number(b.remain_qty),
                          discount: rate, suggestPrice: suggest, cost: Number(b.inbound_cost) })]);
    }
    return rows.length;
  }

  /** 规则 3：分红到期提醒——计提分红有效期 ≤ lead 天且账户仍有余额 */
  private async dividend(rule: any, lead: number): Promise<number> {
    const rows = await q<any>(
      `SELECT d.id AS record_id, d.member_id, d.period_id, d.amount, d.expire_at, m.name, m.phone
         FROM dividend_records d
         JOIN members m ON m.id=d.member_id
        WHERE d.store_id=$1 AND d.record_type='计提' AND d.amount>0
          AND d.expire_at BETWEEN CURRENT_DATE AND (CURRENT_DATE + $2::int)
          AND NOT EXISTS (SELECT 1 FROM marketing_touches t
                           WHERE t.touch_type='dividend' AND t.member_id=d.member_id
                             AND t.payload->>'recordId'=d.id::text AND t.created_at::date=CURRENT_DATE)`,
      [rule.store_id, lead]);
    for (const d of rows) {
      const amt = r2(Number(d.amount));
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, member_id, touch_type, title, content, payload, status, channel)
         VALUES ($1,$2,$3,'dividend',$4,$5,$6,'待处理','站内信')`,
        [rule.store_id, rule.id, d.member_id, '💰 分红到期提醒',
         `尊敬的${d.name}，您有 ¥${amt} 分红将于 ${this.fmtD(d.expire_at)} 到期，请尽快到店消费抵扣！`,
         JSON.stringify({ recordId: Number(d.record_id), periodId: Number(d.period_id),
                          amount: amt, expireAt: this.fmtD(d.expire_at), phone: d.phone })]);
    }
    return rows.length;
  }

  /** 规则 4：沉默唤醒——超过 silent 天未到店消费的正常会员（last_active_date 距今超过 N 天） */
  private async dormant(rule: any, silent: number): Promise<number> {
    const rows = await q<any>(
      `SELECT m.id, m.name, m.phone, m.last_active_date FROM members m
        WHERE m.store_id=$1 AND m.status='正常' AND m.deleted_at IS NULL
          AND m.last_active_date < CURRENT_DATE - $2::int
          AND NOT EXISTS (SELECT 1 FROM marketing_touches t
                           WHERE t.touch_type='dormant' AND t.member_id=m.id AND t.created_at::date=CURRENT_DATE)`,
      [rule.store_id, silent]);
    for (const m of rows) {
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, member_id, touch_type, title, content, payload, status, channel)
         VALUES ($1,$2,$3,'dormant',$4,$5,$6,'待处理','站内信')`,
        [rule.store_id, rule.id, m.id, '💤 好久不见，欢迎回店',
         `尊敬的${m.name}，您已 ${silent} 天未到店消费，近期到店可享会员专属优惠，期待您的光临！`,
         JSON.stringify({ lastActiveDate: this.fmtD(m.last_active_date), silentDays: silent, phone: m.phone })]);
    }
    return rows.length;
  }

  /** 规则 5：低余额提醒——余额低于 threshold 且近期消费过的会员，建议充值 */
  private async lowBalance(rule: any, threshold: number): Promise<number> {
    const rows = await q<any>(
      `SELECT m.id, m.name, m.phone, ma.balance, ma.principal_balance, ma.gift_balance
         FROM members m JOIN member_accounts ma ON ma.member_id=m.id
        WHERE m.store_id=$1 AND m.status='正常' AND m.deleted_at IS NULL
          AND ma.balance < $2::numeric AND m.last_active_date IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM marketing_touches t
                           WHERE t.touch_type='low_balance' AND t.member_id=m.id AND t.created_at::date=CURRENT_DATE)`,
      [rule.store_id, threshold]);
    for (const m of rows) {
      const bal = r2(Number(m.balance));
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, member_id, touch_type, title, content, payload, status, channel)
         VALUES ($1,$2,$3,'low_balance',$4,$5,$6,'待处理','站内信')`,
        [rule.store_id, rule.id, m.id, '🪙 余额不足提醒',
         `尊敬的${m.name}，您当前余额仅 ¥${bal}（本金 ¥${r2(Number(m.principal_balance))} + 赠送 ¥${r2(Number(m.gift_balance))}），建议及时充值以免影响消费与分红权益。`,
         JSON.stringify({ balance: bal, threshold, phone: m.phone })]);
    }
    return rows.length;
  }

  /** 规则 6：散客转会员——近 days 天内散客单（未挂会员）达 min_visits 次且留有电话，提醒引导办卡 */
  private async guestConvert(rule: any, minVisits: number, days: number): Promise<number> {
    const rows = await q<any>(
      `SELECT so.receiver_phone AS phone, count(*)::int AS visits,
              max(so.created_at) AS last_order_at
         FROM sales_orders so
        WHERE so.store_id=$1 AND so.member_id IS NULL AND so.receiver_phone IS NOT NULL
          AND so.receiver_phone <> '' AND so.created_at >= now() - ($2::int || ' days')::interval
        GROUP BY so.receiver_phone HAVING count(*) >= $3
          AND NOT EXISTS (SELECT 1 FROM marketing_touches t
                           WHERE t.touch_type='guest_convert' AND t.payload->>'phone'=so.receiver_phone
                             AND t.created_at::date=CURRENT_DATE)`,
      [rule.store_id, days, minVisits]);
    for (const g of rows) {
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, touch_type, title, content, payload, status, channel)
         VALUES ($1,$2,'guest_convert',$3,$4,$5,'待处理','站内信')`,
        [rule.store_id, rule.id, '🛍️ 散客转会员建议',
         `顾客 ${g.phone} 近 ${days} 天到店散客消费 ${g.visits} 次（末次 ${this.fmtD(g.last_order_at)}），建议引导办理会员卡沉淀为会员。`,
         JSON.stringify({ phone: g.phone, visits: Number(g.visits), lastOrderAt: this.fmtD(g.last_order_at) })]);
    }
    return rows.length;
  }

  /** 规则 7：大客户催收——应收未结（赊账单超 aging 天）的客户，提醒催收对账 */
  private async receivable(rule: any, aging: number): Promise<number> {
    const rows = await q<any>(
      `SELECT bc.id AS customer_id, bc.name, bc.contact, bc.phone,
              ROUND(COALESCE((SELECT SUM(so.payable_amount) FROM sales_orders so
                WHERE so.big_customer_id=bc.id AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')),0),2) AS receivable,
              (SELECT MIN(so.created_at) FROM sales_orders so
                WHERE so.big_customer_id=bc.id AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款')) AS oldest_at,
              ROUND(COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp
                JOIN sales_orders so ON so.id=sp.order_id
                WHERE so.big_customer_id=bc.id AND so.channel='大客户团购' AND sp.channel <> '赊账'),0),2) AS paid_cash,
              ROUND(COALESCE((SELECT SUM(bp.amount) FROM big_customer_payments bp WHERE bp.customer_id=bc.id),0),2) AS paid_collect
         FROM big_customers bc
        WHERE bc.store_id=$1 AND bc.status=1 AND bc.credit_limit > 0
          AND (SELECT MIN(so.created_at) FROM sales_orders so
                WHERE so.big_customer_id=bc.id AND so.channel='大客户团购' AND so.status IN ('已完成','部分退款'))
              < now() - ($2::int || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM marketing_touches t
                           WHERE t.touch_type='receivable' AND t.payload->>'customerId'=bc.id::text
                             AND t.created_at::date=CURRENT_DATE)`,
      [rule.store_id, aging]);
    for (const c of rows) {
      const due = r2(Number(c.receivable) - Number(c.paid_cash) - Number(c.paid_collect));
      if (due <= 0) continue;
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, touch_type, title, content, payload, status, channel)
         VALUES ($1,$2,'receivable',$3,$4,$5,'待处理','站内信')`,
        [rule.store_id, rule.id, '🧾 大客户催收提醒',
         `大客户「${c.name}」（${c.contact || c.phone || ''}）应收 ¥${due} 已超 ${aging} 天未结（最早 ${this.fmtD(c.oldest_at)}），请及时催收对账。`,
         JSON.stringify({ customerId: Number(c.customer_id), customerName: c.name, receivable: due,
                          agingDays: aging, oldestAt: this.fmtD(c.oldest_at), contact: c.contact, phone: c.phone })]);
    }
    return rows.length;
  }
}

@Controller('marketing')
export class MarketingController {
  constructor(private readonly svc: MarketingService) {}

  /** 规则列表（配置/启停/上次执行） */
  @Get('rules')
  async rules() {
    return q(`SELECT id, rule_key, name, description, enabled, config, last_run_at, created_at
                FROM marketing_rules WHERE store_id=${curStore()} ORDER BY id`);
  }

  /** 更新规则：启用/停用 + 配置（lead_days/discount 合并覆盖） */
  @Put('rules/:id')
  @RequirePerms('marketing.manage')
  async updateRule(@Param('id') id: string, @Body() b: { enabled?: boolean; config?: any },
                   @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const r = await cx(c, `SELECT enabled, config FROM marketing_rules WHERE id=$1`, [id]);
      if (!r.length) throw new BizException(40404, '规则不存在', 404);
      const cfg = { ...(r[0].config || {}), ...(b.config ?? {}) };
      await cx(c, `UPDATE marketing_rules SET enabled=$2, config=$3, updated_at=now() WHERE id=$1`,
        [id, b.enabled ?? r[0].enabled, JSON.stringify(cfg)]);
      await audit(user.storeId, user.sub, '营销', 'marketing.rule.update', 'marketing_rule', Number(id),
        { enabled: b.enabled ?? r[0].enabled, config: cfg });
      return { ok: true };
    });
  }

  /** 手动执行（ruleKey 空 = 全部启用规则；返回各规则触达数） */
  @Post('run')
  @RequirePerms('marketing.manage')
  async run(@Body() b: { ruleKey?: string }, @CurrentUser() user: AuthUser) {
    const out = await this.svc.runRules(b?.ruleKey ? [b.ruleKey] : undefined);
    await audit(user.storeId, user.sub, '营销', 'marketing.run', null, null, out);
    return out;
  }

  /** 触达记录（分页 + 类型/状态/关键字筛选） */
  @Get('touches')
  async touches(@Query() qp: { type?: string; status?: string; keyword?: string; page?: string; size?: string }) {
    const pn = Math.max(1, Number(qp.page) || 1);
    const sz = Math.min(100, Math.max(1, Number(qp.size) || 20));
    const kw = (qp.keyword || '').trim();
    const where = `WHERE t.store_id=${curStore()}
        AND ($1::text IS NULL OR t.touch_type=$1)
        AND ($2::text IS NULL OR t.status=$2)
        AND ($3='' OR m.name ILIKE '%'||$3||'%' OR m.phone LIKE '%'||$3||'%'
             OR p.name ILIKE '%'||$3||'%' OR t.content ILIKE '%'||$3||'%')`;
    const rows = await q(
      `SELECT t.id, t.touch_type, t.title, t.content, t.payload, t.status, t.channel, t.sent_at, t.created_at,
              m.name AS member_name, m.phone, p.name AS product_name
         FROM marketing_touches t
         LEFT JOIN members m ON m.id=t.member_id
         LEFT JOIN products p ON p.id=t.product_id
         ${where}
        ORDER BY t.id DESC LIMIT $5 OFFSET $4`,
      [qp.type || null, qp.status || null, kw, (pn - 1) * sz, sz]);
    const cnt = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM marketing_touches t
        LEFT JOIN members m ON m.id=t.member_id
        LEFT JOIN products p ON p.id=t.product_id ${where}`, [qp.type || null, qp.status || null, kw]);
    return { items: rows, total: Number(cnt?.n ?? 0), page: pn, size: sz };
  }

  /** 标记触达状态：已处理 / 已忽略 */
  @Post('touches/:id/status')
  async touchStatus(@Param('id') id: string, @Body() b: { status: string }) {
    if (!['已处理', '已忽略'].includes(b?.status || '')) throw new BizException(40003, '状态须为 已处理/已忽略');
    const r = await q(`UPDATE marketing_touches SET status=$2, sent_at=now() WHERE id=$1 RETURNING id`, [id, b.status]);
    if (!r.length) throw new BizException(40404, '触达记录不存在', 404);
    return { ok: true };
  }
}

@Module({ controllers: [MarketingController], providers: [MarketingService] })
export class MarketingModule {}
