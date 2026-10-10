import { Module, Controller, Get, Post, Body, Query, ParseIntPipe, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { q, q1, tx, cx, r2, r4, audit, pool as dbPool } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { notifyStaff } from '../common/notices';
import { nodeIdentity } from '../common/outbox';

/**
 * 分红引擎（方案 5.1，参数全部来自 system_settings，管理员可调）：
 *   池   = 昨日净利 × dividend.ratio(5%)          ← P3-2：净利 = 毛利 − 门店硬消耗日摊（store.cost.*）
 *   资格 = 有效消费窗口达标（单笔≥min_single 已入账 + 窗口累计≥min_window，V4.3.2）
 *   权重 = 有效本金余额 × 等级系数 c（口径B：赠送不参与加权；5.1.2/5.1.7/5.1.12）
 *   封顶 = 累计分红 ≤ 净充值 × R(30%)（口径B连续），达顶降级仅积分（V4.3.1）
 *   预警 = 年化 = 池×365/参与余额合计，25% 橙 / 35% 红
 *   失效 = 计提后 expire_days(30) 天未消费 → 失效回冲平账（5.1.8.1，夜间任务 M2 实现）
 */

/** 门店硬消耗设置键（月度值；store_settings 门店覆盖 → 总部可经 P2-6 下发） */
export const HARD_COST_KEYS = ['store.cost.rent', 'store.cost.utility', 'store.cost.depreciation', 'store.cost.other'] as const;

/**
 * P3-2：门店硬消耗月度合计（本库所有营业店；单店=本店，总部库=全部含总部自身）。
 * 每键取值：store_settings 覆盖 → system_settings 默认 → 0；JSONB 数字/字符串双兼容。
 */
export async function sumHardCostMonthly(): Promise<number> {
  const keys = HARD_COST_KEYS.map(k => `'${k}'`).join(',');
  const rows = await q<any>(
    `SELECT COALESCE(SUM(COALESCE(
        (SELECT (CASE WHEN jsonb_typeof(v.value)='number' THEN (v.value)::text
                      WHEN jsonb_typeof(v.value)='string' THEN trim(both '"' from (v.value)::text) END)::numeric
           FROM store_settings v WHERE v.store_id=s.id AND v.setting_key=k.key),
        (SELECT COALESCE((CASE WHEN jsonb_typeof(s2.value)='number' THEN (s2.value)::text
                               WHEN jsonb_typeof(s2.value)='string' THEN trim(both '"' from (s2.value)::text) END)::numeric, 0)
           FROM system_settings s2 WHERE s2.setting_key=k.key))), 0) AS monthly
       FROM stores s
       CROSS JOIN (VALUES ${HARD_COST_KEYS.map(k => `('${k}')`).join(',')}) AS k(key)
      WHERE COALESCE(s.status,1) <> 2`, []);
  return Number(rows[0]?.monthly ?? 0);
}

/** 某月天数（settleDate: YYYY-MM-DD） */
function daysInMonth(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00');
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

export interface DailyProfit {
  date: string;        // 口径日（settle_date）
  gross: number;       // 毛利
  hardCost: number;    // 硬消耗日摊
  net: number;         // 净利 = 毛利 − 硬消耗
  days: number;        // 当月天数（日摊分母）
  source: string;      // daily_settlement / sales_live / hq_sales_live（VQA-D3 含 +fee 后缀）
  feeIncome?: number;  // VQA-D3 recon.fee_to_dividend：当日计入分红池的收取方向费用收入
}

/**
 * P3-2：每日利润解析（毛利/硬消耗/净利）。
 *  · 单店：优先 daily_settlement 快照（00:05 固化，防事后补单）；无快照实时算；
 *  · 连锁：总部库 sales_orders 已含全部门店上行单 → 实时汇总全店毛利 − 全部店硬消耗日摊。
 */
export async function resolveDailyProfit(settleDate: string): Promise<DailyProfit> {
  const { chainEnabled } = await import('../common/scope');
  const chain = await chainEnabled();
  // VQA-D3：recon.fee_to_dividend——开启时当日「收取方向」费用单（已审核+入池标记）并入分红净利口径
  const fp = await q1<{ value: any }>(`SELECT value FROM system_settings WHERE setting_key='recon.fee_to_dividend'`);
  const feeOn = (() => { const s = String(fp?.value ?? '').replace(/"/g, ''); return s === 'true' || s === '开' || s === '1'; })();
  const fee = feeOn
    ? Number((await q1<{ v: any }>(`SELECT COALESCE(SUM(f.amount),0) AS v FROM supplier_fees f
         LEFT JOIN supplier_fee_types t ON t.id=f.fee_type_id
        WHERE f.to_dividend_pool AND COALESCE(f.direction,t.direction)='收'
          AND f.status='已审核' AND f.created_at::date=$1::date`, [settleDate]))?.v ?? 0)
    : 0;
  if (!chain) {
    const st = await q1<any>(
      `SELECT profit_total, hard_cost_daily FROM daily_settlement WHERE settle_date=$1::date ORDER BY store_id LIMIT 1`,
      [settleDate]);
    if (st) {
      const hard = Number(st.hard_cost_daily ?? 0);
      return { date: settleDate, gross: Number(st.profit_total), hardCost: r2(hard),
               net: r2(Number(st.profit_total) - hard + fee), days: daysInMonth(settleDate),
               feeIncome: fee, source: fee ? 'daily_settlement+fee' : 'daily_settlement' };
    }
  }
  const g = await q1<any>(
    `SELECT COALESCE(SUM(profit_amount),0) AS gross FROM sales_orders
      WHERE status='已完成' AND COALESCE(pay_paid_at, created_at)::date=$1::date`, [settleDate]);
  const gross = Number(g?.gross ?? 0);
  const monthly = await sumHardCostMonthly();
  const days = daysInMonth(settleDate);
  const hard = r2(monthly / days);
  return { date: settleDate, gross: r2(gross), hardCost: hard, net: r2(gross - hard + fee), days,
           feeIncome: fee, source: (chain ? 'hq_sales_live' : 'sales_live') + (fee ? '+fee' : '') };
}
class DividendEngine {
  private settings = new SettingsService();

  private async params() {
    return {
      ratio: await this.settings.getNum('dividend.ratio', 5),
      capRate: await this.settings.getNum('dividend.cap_rate', 30),
      minSingle: await this.settings.getNum('dividend.min_single', 5),
      minWindow: await this.settings.getNum('dividend.min_window', 50),
      windowDays: await this.settings.getNum('dividend.window_days', 30),
      expireDays: await this.settings.getNum('dividend.expire_days', 30),
      orange: await this.settings.getNum('dividend.orange_alert', 25),
      red: await this.settings.getNum('dividend.red_alert', 35),
    };
  }

  /** P3-2：供控制器读开关（复用引擎的 settings 实例） */
  async svcBool(key: string, fallback: boolean): Promise<boolean> {
    return this.settings.getBool(key, fallback);
  }

  /** 核心：按权重试算（preview 不写库；run 在事务内写库） */
  private async allocate(netProfit: number, q?: any) {
    const run = async (exec: (sql: string, p: any[]) => Promise<any[]>) => {
      const p = await this.params();
      // 决策③(A1)：分红池一律整数分——(元分 × ratio×100) / 10000，BigInt 整除无浮点
      const poolCents = Number((BigInt(Math.round(Number(netProfit) * 100)) * BigInt(Math.round(p.ratio * 100))) / 10000n);
      const pool = poolCents / 100;
      // 参与会员：正常状态 + 余额>0 + 存在仍处有效期内的达标消费窗口
      // V5.0.18 修复「60 天放大」：窗口创建时 window_end = window_start + windowDays(30)，
      // 旧筛选再容 `-30 天` → 实际存活期被放大到约 60 天，与「最近 30 天活跃」不符。
      // 正确语义：窗口在自身 window_end 前有效（持续消费会把 window_end 顶延到最近消费日，即滚动活跃）。
      const members = await exec(
        `SELECT m.id, m.card_no, m.name, a.balance, a.principal_balance, a.principal_total,
                a.dividend_cumulative, a.dividend_capped, COALESCE(l.dividend_coeff, 1.0) AS coeff
           FROM members m
           JOIN member_accounts a ON a.member_id = m.id
           LEFT JOIN member_levels l ON l.id = m.level_id
          WHERE m.status='正常' AND m.deleted_at IS NULL AND a.balance > 0
            AND EXISTS (SELECT 1 FROM member_activity_windows w
                         WHERE w.member_id = m.id AND w.qualified = true
                           AND w.window_end >= CURRENT_DATE)`, []);
      // 权重 = 有效本金余额 × 等级系数 c（口径B：赠送部分不参与加权，5.1.2/5.1.7）
      let weightTotal = 0;
      const rows = members.map((m: any) => {
        const balance = Number(m.balance);
        const principal = Number(m.principal_balance ?? balance);
        const coeff = Number(m.coeff ?? 1);
        const weight = r4(principal * coeff);
        const limit = Number(m.principal_total) * p.capRate / 100; // 净充值 × R
        const capped = m.dividend_capped || Number(m.dividend_cumulative) >= limit - 0.0001;
        const row: any = {
          memberId: m.id, cardNo: m.card_no, name: m.name,
          balance, principalBalance: principal, coeff,
          weight: capped ? 0 : weight,
          capped, reason: capped ? `已达封顶（累计 ${Number(m.dividend_cumulative)} ≥ 净充值×${p.capRate}%=${r2(limit)}），降级仅积分` : null,
          amount: 0, forceCapNow: false,
        };
        if (!capped) weightTotal += weight;
        return row;
      });
      // 决策③(A1)：逐人按整数分向下取整（BigInt 精确比例，无浮点误差）→ 封顶钳制（分）→
      // 尾差按权重降序逐分补发：无封顶干扰时 Σ==池（守恒）；被封顶成员不再补（池差合法留存）
      if (weightTotal > 0) {
        const wSumI = rows.reduce((s: number, r: any) => s + (r.capped ? 0 : Math.round(r.weight * 10000)), 0);
        if (wSumI > 0) {
          for (const row of rows) {
            if (row.capped) { row._cents = 0; continue; }
            row._cents = Number((BigInt(poolCents) * BigInt(Math.round(row.weight * 10000))) / BigInt(wSumI));
          }
          for (const row of rows) {
            if (row.capped || !row._cents) continue;
            const src = members.find((x: any) => String(x.id) === String(row.memberId))!;
            const limitCents = Number((BigInt(Math.round(Number(src.principal_total) * 100)) * BigInt(Math.round(p.capRate * 100))) / 10000n);
            const cumCents = Math.round(Number(src.dividend_cumulative) * 100);
            if (cumCents + row._cents > limitCents) { row._cents = Math.max(0, limitCents - cumCents); row.forceCapNow = true; }
          }
          let leftover = poolCents - rows.reduce((s: number, r: any) => s + (r._cents || 0), 0);
          if (leftover > 0) {
            const order = rows.filter((r: any) => !r.capped && !r.forceCapNow && r.weight > 0)
              .sort((a: any, b: any) => b.weight - a.weight);
            for (let i = 0; leftover > 0 && i < order.length; i++, leftover--) order[i]._cents += 1;
          }
        }
        for (const row of rows) { row.amount = (row._cents || 0) / 100; delete row._cents; }
      }
      // 年化预警（Q-04 B2：展示层阈值分母——评审明确豁免保留元域，不落账本）
      const totalBalance = rows.reduce((s: number, x: any) => s + x.balance, 0);
      const annualized = totalBalance > 0 ? pool * 365 / totalBalance * 100 : 0;
      return {
        pool,
        weightTotal: r4(weightTotal),
        memberCount: rows.filter((x: any) => x.amount > 0).length,
        orangeAlert: annualized >= p.orange,
        redAlert: annualized >= p.red,
        annualized: Math.round(annualized * 100) / 100,
        items: rows,
      };
    };
    if (q) return run((sql, p) => q(sql, p));                 // 事务内
    return run((sql, p) => dbPool.query(sql, p).then(r => r.rows)); // 事务外
  }

  async preview(netProfit: number) {
    return this.allocate(netProfit);
  }

  /** 每日计提（幂等：biz_date 唯一约束）。P3-2：gross/hard 随期落库供公示 */
  async runPeriod(bizDate: string, netProfit: number, operatorId: number, storeId = 1,
                  grossProfit = 0, hardCost = 0) {
    const exist = await q1(`SELECT id FROM dividend_periods WHERE biz_date=$1`, [bizDate]);
    if (exist) throw new BizException(50060, `该日期(${bizDate})分红已计提，幂等拦截`);

    return tx(async c => {
      const calc = await this.allocate(netProfit, (sql: string, p: any[]) => cx(c, sql, p));
      const p = await this.params();
      // V5.0.1：状态如实——没有任何会员分到钱（30 天内无达标消费窗口/全员已封顶）时不得标「已发放」，
      // 否则期间列表显示已发放、分红明细却查不到数据（口径矛盾，老板误以为发放丢失）。
      const givenCount = (calc.items as any[]).filter(it => it.amount > 0).length;
      const status = givenCount > 0 ? '已发放' : '零发放';
      const period = await cx(c,
        `INSERT INTO dividend_periods (store_id, biz_date, net_profit, ratio, pool_amount,
                                       member_count, weight_total, orange_alert, red_alert, status,
                                       gross_profit, hard_cost)
         VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,'${status}',$9,$10) RETURNING id`,
        [bizDate, netProfit, p.ratio / 100, calc.pool, calc.memberCount, calc.weightTotal,
         calc.orangeAlert, calc.redAlert, r2(grossProfit), r2(hardCost)]);
      const expireAt = addDaysStr(bizDate, p.expireDays);
      let givenCents = 0; // 决策③(A1)：发放累计同样整数分
      for (const it of calc.items) {
        if (!(it.amount > 0)) continue;
        await cx(c,
          `INSERT INTO dividend_records (store_id, member_id, period_id, record_type, amount,
                                         weight_snapshot, expire_at, operator_id, remark)
           VALUES (${curStore()},$1,$2,'计提',$3,$4,$5,$6,$7)`,
          [it.memberId, period[0].id, it.amount, it.weight, expireAt, operatorId,
           it.forceCapNow ? '本次后达封顶，后续降级仅积分' : null]);
        await cx(c,
          `UPDATE member_accounts SET dividend_balance = dividend_balance + $2,
             dividend_cumulative = dividend_cumulative + $2,
             dividend_capped = (dividend_capped OR $3),
             dividend_weight = $4, updated_at = now()
           WHERE member_id=$1`,
          [it.memberId, it.amount, it.forceCapNow, it.weight]);
        givenCents += Math.round(it.amount * 100);
      }
      const given = givenCents / 100;
      /* V5.0.14 新规则：零发放（当日无任何成功发放）→ 该笔计提次日自动失效，不再进入分红池。
       * 计提明细落一条「失效」记录（整期级，member_id 为空，迁移 156 已放开）并注明失效原因，
       * 老板在发放明细里能看到这笔钱的去向与失效原因。 */
      if (status === '零发放') {
        await cx(c,
          `INSERT INTO dividend_records (store_id, member_id, period_id, record_type, amount,
                                         expire_at, operator_id, remark)
           VALUES (${curStore()},NULL,$1,'失效',$2,$3,$4,$5)`,
          [period[0].id, calc.pool, addDaysStr(bizDate, 1), operatorId,
           '当日无符合发放条件的会员（30 天内无达标消费窗口或全员已达封顶），按规则次日失效：不计入分红池、不分发']);
      }
      await audit(storeId, operatorId, '分红', 'dividend.period.run', 'dividend_period', period[0].id,
        { bizDate, netProfit, pool: calc.pool, given });
      return { periodId: period[0].id, pool: calc.pool, given, memberCount: calc.memberCount,
               orangeAlert: calc.orangeAlert, redAlert: calc.redAlert,
               note: status === '零发放'
                 ? '本期无符合条件的会员（30 天内无达标消费窗口或全员已达封顶），计提金额按新规则次日失效（发放明细已记「失效」及原因），不分发'
                 : '' };
    });
  }
/**
   * V5.0.16 分红「到期失效」闭环（expire_days 默认 30 天未消费 → 失效回冲）：
   *   缺陷：此前 expire_at 只被营销提醒读取，没有任何扫描/扣减 → 会员永久保留已过期分红余额（负债虚高），
   *   且「零发放」期的 status 永远停在「零发放」，失效未在期间台账上闭环。
   *   本方法：扫描「计提」明细中 expire_at < 今天且尚未回冲的，按笔扣减 member_accounts.dividend_balance
   *   （封顶到当前余额，绝不产生负负债），并写一条「失效回冲」负额台账（ref_type='expire'，ref_id=原计提id）保证幂等可追溯；
   *   同时把已到期的「零发放」期状态更新为「已失效」。
   */
  async expireScan(trigger = 'auto') {
    return tx(async c => {
      const rows = await cx(c,
        `SELECT d.id, d.member_id, d.period_id, d.amount, d.expire_at
           FROM dividend_records d
          WHERE d.store_id=${curStore()} AND d.record_type='计提' AND d.amount > 0
            AND d.expire_at IS NOT NULL AND d.expire_at < CURRENT_DATE
            AND NOT EXISTS (SELECT 1 FROM dividend_records x
                             WHERE x.ref_type='expire' AND x.ref_id = d.id)`);
      let total = 0, cnt = 0;
      const op = curEmp() || 0;
      for (const d of rows) {
        const acc = await cx(c,
          `SELECT dividend_balance FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [d.member_id]);
        const bal = Number(acc[0]?.dividend_balance || 0);
        const back = Math.min(bal, Number(d.amount));      // 封顶：余额不足则只冲到 0，不产生负债
        if (back > 0) {
          await cx(c,
            `UPDATE member_accounts SET dividend_balance = dividend_balance - $2, updated_at=now() WHERE member_id=$1`,
            [d.member_id, back]);
        }
        await cx(c,
          `INSERT INTO dividend_records (store_id, member_id, period_id, record_type, amount,
                                         ref_type, ref_id, operator_id, remark)
           VALUES (${curStore()},$1,$2,'失效回冲',$3,'expire',$4,$5,$6)`,
          [d.member_id, d.period_id, -r2(back), d.id, op,
           `${String(d.expire_at).slice(0, 10)} 到期未消费，失效回冲（${trigger}）`]);
        total += back; cnt++;
      }
      // 零发放期到期 → 状态闭环为「已失效」
      const z = await cx(c,
        `UPDATE dividend_periods SET status='已失效'
          WHERE store_id=${curStore()} AND status='零发放'
            AND biz_date + (SELECT COALESCE((value::int),30) FROM system_settings
                             WHERE setting_key='dividend.expire_days' LIMIT 1) + 1 < CURRENT_DATE
        RETURNING id`);
      if (cnt) {
        await audit(curStore(), op, '分红', 'dividend.expire', 'dividend_record', null,
          { count: cnt, total: r2(total), zeroClosed: z.length, trigger });
      }
      return { count: cnt, total: r2(total), zeroPeriodClosed: z.length };
    });
  }
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── P3-2：自动每日分红（02:35 job 与手动补跑共用） ───
const autoEngine = new DividendEngine();

/**
 * 自动计提一次（幂等，绝不重复发钱）：
 *   · 门店节点跳过（分红只在总部，M5-6 铁律）
 *   · dividend.auto.enabled=false 跳过
 *   · 昨日净利 ≤ 0（亏损日）跳过
 *   · biz_date 已计提 → skipped（幂等拦截）
 */
export async function autoDividendRun(date?: string): Promise<any> {
  const id = await nodeIdentity();
  if (id && id.role === 'store') return { skipped: '门店节点不自动计提（分红只在总部）' };
  const autoEnabled = await autoEngine.svcBool('dividend.auto.enabled', true);
  if (!autoEnabled) return { skipped: 'dividend.auto.enabled=false（自动分红已关闭）' };
  const bizDate = (date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)).slice(0, 10);
  const settle = addDaysStr(bizDate, -1);
  const exist = await q1(`SELECT id FROM dividend_periods WHERE biz_date=$1`, [bizDate]);
  if (exist) return { skipped: `该日期(${bizDate})分红已计提（幂等拦截）`, date: bizDate };
  const prof = await resolveDailyProfit(settle);
  if (prof.net <= 0) {
    return { skipped: `昨日(${settle})净利 ${prof.net} ≤ 0，不计提`, date: bizDate,
             gross: prof.gross, hardCost: prof.hardCost };
  }
  const { hqStoreId } = await import('../common/scope');
  const r = await autoEngine.runPeriod(bizDate, prof.net, 1, await hqStoreId(), prof.gross, prof.hardCost);
  console.log(`[分红job] 自动计提完成 ${settle} 净利 ${prof.net} 池 ${r.pool} 发放 ${r.given}`);
  return { ...r, date: bizDate, settle, gross: prof.gross, hardCost: prof.hardCost, source: prof.source };
}

/** V5.0.18：自动计提触发时刻（dividend.auto.time，"HH:MM"，默认 02:35；非法值回退默认） */
async function autoTriggerMinute(): Promise<number> {
  try {
    const r = await q1(`SELECT value #>> '{}' AS v FROM system_settings WHERE setting_key='dividend.auto.time'`);
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(r?.v || '').trim());
    if (m) return Math.min(23, Math.max(0, Number(m[1]))) * 60 + Math.min(59, Number(m[2]));
  } catch { /* 回退默认 */ }
  return 2 * 60 + 35;
}

/** P3-2：自动分红定时任务（零依赖 setInterval，模式同 SyncReconJob；每日 dividend.auto.time，默认 02:35，到点后补跑） */
@Injectable()
export class DividendAutoJob implements OnModuleInit, OnModuleDestroy {
  private timer: any;
  private lastRunDay = '';
  private lastExpireDay = '';
  onModuleInit() {
    this.timer = setInterval(() => this.maybeRun().catch(e => { console.error('[分红job] 执行失败:', e?.message); try { notifyStaff(1, 'job_error', `[分红job] 执行失败：${String(e?.message).slice(0, 140)}`, {}, 'sys.settings', 'job:div').catch(() => { }); } catch { } }), 60_000);
    console.log('[分红job] 自动每日分红定时器已启动（每日 02:35 计提昨日净利 + 到期失效回冲）');
  }
  onModuleDestroy() { clearInterval(this.timer); }
  private async maybeRun() {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    // V5.0.18：触发时刻可配置（dividend.auto.time，默认 02:35），并改为「到点后首次巡检即补跑」——
    //   旧逻辑要求严格命中 hour===2 && minutes>=35 的一分钟窗口，服务器 02:35 未开机（开机时
    //   getHours() 已 > 2）当天永不触发 → 漏计提。新语义：当天到达设定时刻后的第一次 tick 执行
    //   （lastDay 幂等，进程当天重启也会补跑一次）。
    const due = await autoTriggerMinute();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= due && this.lastExpireDay !== day) {
      this.lastExpireDay = day;
      try { await new DividendEngine().expireScan('auto'); }
      catch (e) { console.error('[分红job] 失效回冲扫描失败:', e?.message); }
    }
    if (nowMin < due || this.lastRunDay === day) return;
    this.lastRunDay = day;
    await autoDividendRun();
  }
}

// ─── Controller ───
@Controller('dividend')
class DividendController {
  private engine = new DividendEngine();

  /** 试算（不落库，供后台首页/设置页预演） */
  @Get('preview')
  preview(@Query('netProfit') netProfit: string) {
    const np = Number(netProfit);
    if (!Number.isFinite(np) || np < 0) throw new BizException(40003, 'netProfit 必须为非负数字');
    return this.engine.preview(np);
  }

  /** 执行每日计提（定时任务 02:35 自动 / 管理员手动触发；幂等）
   *  P1-H1：净利默认取服务端日结快照（P3-2 起为 daily_settlement.net_profit = 毛利 − 硬消耗日摊），
   *  手工传值仅在快照缺失或与口径不一致时作为「差异覆盖」，且需第二权限点 dividend.manual.override */
  @RequirePerms('member.dividend.adjust')
  @Post('periods/run')
  async run(@Body() b: { date?: string; netProfit?: number }, @CurrentUser() user: AuthUser) {
    // ── V5.0.0 批次5（M5-6，方案 §5.2.3 铁律）：分红计算权只在总部。
    //    连锁模式下门店节点禁止计提 —— 否则同一会员被 N 家店重复计提同一份额（商业模式直接崩）。
    //    单店部署 chainEnabled()=false → 不受影响（零回归）。
    const { chainEnabled, isHqStore, hqStoreId } = await import('../common/scope');
    if (await chainEnabled() && !(await isHqStore(user.storeId))) {
      throw new BizException(40302, '分红计提只在总部执行（门店节点禁止，防止同一会员重复计提）', 403);
    }
    const date = b.date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const settleDate = addDaysStr(date, -1);
    const prof = await resolveDailyProfit(settleDate);
    let np: number;
    let source = prof.source;
    if (b.netProfit === undefined || b.netProfit === null) {
      if (prof.net < 0) throw new BizException(40003,
        `昨日净亏（毛利 ${prof.gross} − 硬消耗 ${prof.hardCost} = ${prof.net}），不计提分红`);
      np = prof.net;
    } else {
      np = Number(b.netProfit);
      if (!Number.isFinite(np) || np < 0) throw new BizException(40003, 'netProfit 必须为非负数字');
      if (Math.abs(np - prof.net) > 0.005) {
        if (!(user.perms.includes('*') || user.perms.includes('dividend.manual.override'))) {
          throw new BizException(40302, `手工净利 ${np} 与系统口径 ${prof.net}（${prof.source}）不一致，覆盖计提需复核权限点 dividend.manual.override（P1-H1）`, 403);
        }
        source = 'manual-overridden';
      }
    }
    await audit(user.storeId, user.sub, '分红', 'dividend.run.netprofit.source', 'dividend_period', undefined,
      { bizDate: date, netProfit: np, gross: prof.gross, hardCost: prof.hardCost, source });
    return this.engine.runPeriod(date, np, user.sub, await hqStoreId(), prof.gross, prof.hardCost);
  }

  /** P3-2：每日利润明细（毛利/硬消耗日摊/净利/分红开关），供分红页与对账展示 */
  @Get('profit-breakdown')
  async breakdown(@Query('date') date?: string) {
    const d = (date || addDaysStr(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), -1)).slice(0, 10);
    const prof = await resolveDailyProfit(d);
    const autoEnabled = await this.engine.svcBool('dividend.auto.enabled', true);
    const last = await q1<any>(`SELECT * FROM dividend_periods ORDER BY biz_date DESC LIMIT 1`);
    return { ...prof, autoEnabled,
      lastPeriod: last ? { bizDate: last.biz_date, netProfit: Number(last.net_profit),
        pool: Number(last.pool_amount), memberCount: last.member_count } : null };
  }

  /** P3-2：手动立即补跑自动分红（与 02:35 job 同一逻辑；幂等） */
  @RequirePerms('member.dividend.adjust')
  @Post('auto/run')
  async autoRun(@Body() b: { date?: string }, @CurrentUser() user: AuthUser) {
    const r = await autoDividendRun(b?.date);
    await audit(user.storeId, user.sub, '分红', 'dividend.auto.run', 'dividend_period', r.periodId,
      { date: r.date, skipped: r.skipped ?? null, pool: r.pool ?? null });
    return r;
  }

  /** V5.0.16 手动触发「到期失效回冲」扫描（与 02:35 job 同一逻辑，幂等；便于补跑与验证） */
  @RequirePerms('member.dividend.adjust')
  @Post('expire-scan')
  async expireScanNow(@CurrentUser() user: AuthUser) {
    const r = await this.engine.expireScan('manual');
    await audit(user.storeId, user.sub, '分红', 'dividend.expire.scan', 'dividend_record', null, r as any);
    return r;
  }

  @Get('periods')
  periods() {
    return q(`SELECT * FROM dividend_periods ORDER BY biz_date DESC LIMIT 60`);
  }

  @Get('records')
  records(@Query('memberId') memberId?: string) {
    /* V5.0.14：LEFT JOIN——「失效」记录是整期级（member_id 为空），内联会把它们吞掉；
     * 指定 memberId 过滤时自然排除空会员行（失效记录不属于任何会员）。 */
    return q(
      `SELECT d.*, m.name AS member_name, m.card_no
         FROM dividend_records d LEFT JOIN members m ON m.id = d.member_id
        WHERE ($1::bigint IS NULL OR d.member_id = $1::bigint)
        ORDER BY d.id DESC LIMIT 100`, [memberId ? Number(memberId) : null]);
  }

  /** V4.28.4 P1-12 分红人工调整（正=补发 / 负=冲减）：独立端点 + 原因必填 + 全额审计留痕。
   *  场景：差错修正、投诉补偿、系统外兑现核销等。冲减不得使余额为负（分红是纯收益，不产生负债）；
   *  连锁模式仅总部可调（M5-6 铁律同计提）。退款自动回冲见 refund.module（P1-11），本端点用于人工场景。 */
  @RequirePerms('member.dividend.adjust')
  @Post('adjust')
  async adjust(@Body() b: { memberId: number; amount: number; reason?: string }, @CurrentUser() user: AuthUser) {
    const memberId = Number(b.memberId);
    const amt = Math.round(Number(b.amount) * 100) / 100;
    const reason = String(b.reason || '').trim();
    if (!memberId) throw new BizException(40003, 'memberId 必填');
    if (!Number.isFinite(amt) || amt === 0) throw new BizException(40003, 'amount 必须为非零金额（负=冲减 / 正=补发）');
    if (Math.abs(amt) > 100000) throw new BizException(40003, '单笔调整不得超过 ±100000 元（如需更大金额请分笔并说明）');
    if (!reason) throw new BizException(40003, '必须填写调整原因（留痕要求）');
    const { chainEnabled, isHqStore } = await import('../common/scope');
    if (await chainEnabled() && !(await isHqStore(user.storeId))) {
      throw new BizException(40302, '分红调整只在总部执行（M5-6：防止门店侧篡改会员资产）', 403);
    }
    return tx(async c => {
      const acc = await cx(c, `SELECT dividend_balance FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [memberId]);
      if (!acc.length) throw new BizException(40404, '会员账户不存在', 404);
      const balance = Number(acc[0].dividend_balance);
      if (amt < 0 && balance + amt < -0.005) {
        throw new BizException(40003, `冲减后余额为负（当前余额 ${balance}，本次冲减 ${-amt}）：会员分红不产生负债，请核对金额`);
      }
      await cx(c,
        `UPDATE member_accounts SET dividend_balance = dividend_balance + $2,
            dividend_cumulative = dividend_cumulative + $2, updated_at = now()
          WHERE member_id=$1`, [memberId, amt]);
      await cx(c,
        `INSERT INTO dividend_records (store_id, member_id, record_type, amount, ref_type, operator_id, remark)
         VALUES (${curStore()},$1,'调整',$2,'manual',$3,$4)`,
        [memberId, amt, user.sub, `人工调整：${reason}`]);
      await audit(user.storeId, user.sub, '分红', 'dividend.adjust', 'member', memberId,
        { amount: amt, reason, balanceAfter: Math.round((balance + amt) * 100) / 100 });
      return { ok: true, memberId, amount: amt, balance: Math.round((balance + amt) * 100) / 100 };
    });
  }
}

@Module({ controllers: [DividendController], providers: [DividendAutoJob] })
export class DividendModule {}
