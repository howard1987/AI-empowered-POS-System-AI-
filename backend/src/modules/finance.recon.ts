/**
 * V4.13 · 支付账单导入对账（能力全景 4.2 缺口：财务安全闭环，纯规则解析无需 AI）
 *   POST /finance/recon/bill/import  —— 微信/支付宝账单 CSV（文本）导入 → 解析入库 → 自动对齐 → 出对账单
 *   GET  /finance/recon/runs         —— 对账批次列表
 *   GET  /finance/recon/runs/:id     —— 批次详情（差异清单：账单有本地无 / 本地有平台无（反方向 V4.13.1）/ 疑似重复）
 *   POST /finance/recon/bills/:id/ignore —— 单行账单标记忽略（误导入/测试行）
 *   对齐规则：①平台交易单号精确命中 sale_payments.external_no ②金额相等 + 本地订单时间落在平台入账时间 ±window 秒
 *   开关：finance.billrecon.enabled；窗口：finance.billrecon.window_seconds（默认 ±300s，平台入账有延迟）
 *   权限：导入/运行/忽略 = sys.settings；批次查看 = 登录可见
 */
import { Controller, Get, Post, Param, Body, Module, Injectable } from '@nestjs/common';
import { q, q1, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { notifyStaff } from '../common/notices';

/* ── 账单 CSV 解析（微信支付账单 / 支付宝交易明细 通用宽松解析） ── */
interface BillRow { externalNo: string; amount: number; payTime: Date | null; billStatus: string; direction: string; raw: Record<string, string>; }

function parseMoney(s: string): number {
  const n = Number(String(s ?? '').replace(/[¥￥,，\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
/** 拆 CSV 行（兼容引号内逗号：微信/支付宝账单列值一般不含逗号，金额列可能带千分位） */
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
export function parseBillCsv(csvText: string, channel: string): { rows: BillRow[]; skipped: number; header: string[] | null } {
  const lines = String(csvText || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let header: string[] | null = null, hIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.some(c => /单号|交易号/.test(c)) && cols.some(c => /金额/.test(c))) { header = cols; hIdx = i; break; }
  }
  if (!header) return { rows: [], skipped: lines.length, header: null };
  const col = (re: RegExp): number => header!.findIndex(c => re.test(c));
  const iNo = col(/交易单号|^交易号$|订单号/), iAmt = col(/金额/), iTime = col(/交易时间|付款时间|交易创建时间|入账时间/),
        iDir = col(/收\/支|收支|^类型$/), iSt = col(/状态/);
  const rows: BillRow[] = []; let skipped = 0;
  for (let i = hIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 3) { skipped++; continue; }
    if (cells[0] === '#' || /共\s*\d+\s*笔|^-$/.test(cells[0])) { skipped++; continue; }   // 尾部统计行
    const extNo = iNo >= 0 ? (cells[iNo] || '').replace(/["']/g, '') : '';
    const amount = iAmt >= 0 ? parseMoney(cells[iAmt]) : NaN;
    const direction = iDir >= 0 ? (cells[iDir] || '') : '';
    const billStatus = iSt >= 0 ? (cells[iSt] || '') : '';
    // 只对收入行对账（微信：收入/支出/不计收支；支付宝：收入/支出/其他）
    if (iDir >= 0 && direction && !direction.includes('收入')) { skipped++; continue; }
    // 退款/关闭/失败行不对账（退款在本地走退款单口径）
    if (billStatus && /退款|关闭|失败|等待/.test(billStatus)) { skipped++; continue; }
    if (!extNo || !Number.isFinite(amount) || amount <= 0) { skipped++; continue; }
    const payTime = iTime >= 0 && cells[iTime] ? new Date(cells[iTime].replace(/\//g, '-')) : null;
    const raw: Record<string, string> = {};
    header!.forEach((h, j) => { raw[h] = cells[j] ?? ''; });
    rows.push({ externalNo: extNo, amount, payTime: payTime && !isNaN(payTime.getTime()) ? payTime : null, billStatus, direction, raw });
  }
  void channel;
  return { rows, skipped, header };
}

@Injectable()
export class BillReconService {
  /** 读取开关/参数（controller 亦需读 finance.billrecon.enabled 判功能开关，故非 private） */
  async setting(key: string, fb: any): Promise<any> {
    const r = await q1(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
    return r ? r.value : fb;
  }

  /** 自动对齐：单号精确 → 金额+时间窗口；返回匹配统计 */
  async matchBatch(storeId: number, batchNo: string, channel: string): Promise<{ matched: number; dupSuspect: number; amountMismatch: number }> {
    const win = Number(await this.setting('finance.billrecon.window_seconds', 300) ?? 300);
    const bills = await q<any>(
      `SELECT id, external_no, amount, pay_time FROM payment_bills
        WHERE store_id=$1 AND batch_no=$2 AND channel=$3 AND match_status='未匹配'
        ORDER BY pay_time NULLS LAST, id`, [storeId, batchNo, channel]);
    const used = new Set<number>();
    let matched = 0, dupSuspect = 0, amountMismatch = 0;
    for (const b of bills) {
      // ① 平台单号精确命中（H5 直付/线下码回写 external_no 的场景）
      let hit: any = null;
      if (b.external_no) {
        const ext = await q1<any>(
          `SELECT sp.id, sp.order_id FROM sale_payments sp
             JOIN sales_orders so ON so.id=sp.order_id
            WHERE so.store_id=$1 AND sp.channel=$2::pay_channel_t AND sp.external_no=$3
            LIMIT 1`, [storeId, channel, b.external_no]);
        if (ext) hit = ext;
      }
      // ② 金额相等 + 订单时间 ±window 秒（现金扫码场景本地无单号回写）
      if (!hit) {
        const cand = await q1<any>(
          `SELECT sp.id, sp.order_id FROM sale_payments sp
             JOIN sales_orders so ON so.id=sp.order_id
            WHERE so.store_id=$1 AND sp.channel=$2::pay_channel_t
              AND ABS(sp.amount - $3::numeric) < 0.005
              AND so.status <> '挂单' AND so.created_at IS NOT NULL
              AND ($4::timestamptz IS NULL OR so.created_at BETWEEN $4 - ($5 || ' seconds')::interval
                                                       AND $4 + ($5 || ' seconds')::interval)
              AND NOT (sp.id = ANY($6::int[]))
            ORDER BY ABS(extract(epoch FROM (so.created_at - COALESCE($4, so.created_at)))) ASC
            LIMIT 1`,
          [storeId, channel, b.amount, b.payTime, String(win), used.size ? [...used] : [0]]);
        if (cand) hit = cand;
      }
      if (hit && used.has(Number(hit.id))) {
        await q(`UPDATE payment_bills SET match_status='疑似重复', match_note='同笔本地收款已被另一账单行匹配（平台重复行/退款拆行）' WHERE id=$1`, [b.id]);
        dupSuspect++;
        continue;
      }
      if (hit) {
        used.add(Number(hit.id));
        await q(`UPDATE payment_bills SET match_status='已匹配', matched_order_id=$2, matched_payment_id=$3, match_note='自动对齐' WHERE id=$1`,
          [b.id, Number(hit.order_id), Number(hit.id)]);
        matched++;
      } else {
        await q(`UPDATE payment_bills SET match_status='金额差异', match_note='未找到金额相等且时间在 ±${win}s 内的本地收款' WHERE id=$1`, [b.id]);
        amountMismatch++;
      }
    }
    return { matched, dupSuspect, amountMismatch };
  }

  /** 汇总批次 → 写对账单 */
  async summarize(storeId: number, batchNo: string, channel: string, userId: number): Promise<any> {
    const agg = await q1<any>(
      `SELECT COUNT(*)::int AS bill_rows, COALESCE(SUM(amount),0) AS bill_total,
              COUNT(*) FILTER (WHERE match_status='已匹配')::int AS matched_rows,
              COALESCE(SUM(amount) FILTER (WHERE match_status='已匹配'),0) AS matched_total,
              COUNT(*) FILTER (WHERE match_status IN ('金额差异','疑似重复'))::int AS diff_rows,
              MIN(pay_time)::date AS bill_date
         FROM payment_bills WHERE store_id=$1 AND batch_no=$2 AND channel=$3`, [storeId, batchNo, channel]);
    const span = await q1<any>(
      `SELECT MIN(pay_time) AS t0, MAX(pay_time) AS t1 FROM payment_bills
        WHERE store_id=$1 AND batch_no=$2 AND channel=$3`, [storeId, batchNo, channel]);
    let localTotal = 0;
    if (span?.t0 && span?.t1) {
      const r = await q1<any>(
        `SELECT COALESCE(SUM(sp.amount),0) AS t FROM sale_payments sp
           JOIN sales_orders so ON so.id=sp.order_id
          WHERE so.store_id=$1 AND sp.channel=$2::pay_channel_t AND so.status <> '挂单'
            AND so.created_at BETWEEN $3::timestamptz - interval '10 minutes' AND $4::timestamptz + interval '10 minutes'`,
        [storeId, channel, span.t0, span.t1]);
      localTotal = Number(r?.t ?? 0);
    }

    // ── V4.13.1 反方向差异（对比报告 P1-4.8）：本地已收、平台账单无对应行 ──
    // 判定：时间窗内本渠道本地收款，排除本批次已匹配的收款（matched_payment_id）；
    // 疑似原因：顾客私码收款未进对公账户 / 现金伪装扫码 / 平台账单漏行 / 时间窗偏移超界
    let reverseDiffs: any[] = [];
    let reverseRows = 0, reverseTotal = 0;
    if (span?.t0 && span?.t1) {
      reverseDiffs = await q(
        `SELECT so.order_no, sp.id AS payment_id, sp.channel, sp.amount, sp.external_no, so.created_at
           FROM sale_payments sp
           JOIN sales_orders so ON so.id = sp.order_id
          WHERE so.store_id=$1 AND sp.channel=$2::pay_channel_t AND so.status <> '挂单'
            AND so.created_at BETWEEN $3::timestamptz - interval '10 minutes' AND $4::timestamptz + interval '10 minutes'
            AND NOT (sp.id = ANY($5::int[]))
          ORDER BY so.created_at LIMIT 200`,
        [storeId, channel, span.t0, span.t1,
         /* 已匹配收款 id 集 */ ((await q(`SELECT matched_payment_id FROM payment_bills
              WHERE store_id=$1 AND batch_no=$2 AND channel=$3 AND matched_payment_id IS NOT NULL`,
            [storeId, batchNo, channel])).map((x: any) => Number(x.matched_payment_id))).concat([0])]);
      reverseRows = reverseDiffs.length;
      reverseTotal = reverseDiffs.reduce((s, d) => s + Math.round(Number(d.amount) * 100), 0) / 100; // 决策③(A3)：分单位求和，Σ与明细行和分毫不差
    }

    const diffs = await q(
      `SELECT id, external_no, amount, pay_time, bill_status, match_status, match_note
         FROM payment_bills WHERE store_id=$1 AND batch_no=$2 AND channel=$3 AND match_status IN ('金额差异','疑似重复')
        ORDER BY pay_time NULLS LAST, id LIMIT 200`, [storeId, batchNo, channel]);
    const ins = await q(
      `INSERT INTO bill_recon_runs (store_id, batch_no, channel, bill_date, bill_rows, bill_total, matched_rows, matched_total, local_total, diff_rows, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [storeId, batchNo, channel, agg?.bill_date ?? null, Number(agg?.bill_rows ?? 0), Number(agg?.bill_total ?? 0),
       Number(agg?.matched_rows ?? 0), Number(agg?.matched_total ?? 0), localTotal, Number(agg?.diff_rows ?? 0),
       JSON.stringify({ windowSeconds: Number(await this.setting('finance.billrecon.window_seconds', 300) ?? 300),
                        diffs: diffs.map(d => ({ billId: Number(d.id), externalNo: d.external_no, amount: Number(d.amount),
                                                 payTime: d.pay_time, status: d.match_status, note: d.match_note })),
                        reverseDiffs: reverseDiffs.map(d => ({ orderNo: d.order_no, paymentId: Number(d.payment_id),
                                                               amount: Number(d.amount), externalNo: d.external_no,
                                                               createdAt: d.created_at })) }),
       userId]);
    return { runId: Number(ins[0].id), ...agg, localTotal, billTotal: Number(agg?.bill_total ?? 0),
             reverseRows, reverseTotal };
  }
}

@Controller('finance/recon')
export class FinanceReconController {
  constructor(private readonly svc: BillReconService) {}

  /** 导入账单 CSV（文本）→ 自动对齐 → 出对账单 */
  @Post('bill/import')
  @RequirePerms('sys.settings')
  async import(@Body() b: { channel?: string; csv?: string; billDate?: string }, @CurrentUser() u: AuthUser) {
    if (!Boolean(await this.svc.setting('finance.billrecon.enabled', true))) throw new BizException(40003, '账单对账功能未开启（设置-智能能力）');
    const channel = ['微信', '支付宝'].includes(b?.channel || '') ? b!.channel! : '';
    if (!channel) throw new BizException(40003, 'channel 必须为 微信 或 支付宝');
    if (!b.csv || String(b.csv).length < 10) throw new BizException(40003, '请粘贴或上传账单 CSV 文本');
    const parsed = parseBillCsv(String(b.csv), channel);
    if (!parsed.header) throw new BizException(40003, '未识别到账单表头：文件需包含「单号」与「金额」列（微信/支付宝导出原件即可）');
    if (!parsed.rows.length) throw new BizException(40003, `账单中未解析出可对账的收入行（跳过 ${parsed.skipped} 行：非收入/退款/空行）`);
    const dup = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM payment_bills WHERE store_id=$1 AND channel=$2 AND external_no = ANY($3::text[])`,
      [u.storeId, channel, parsed.rows.map(r => r.externalNo)]);
    if (Number(dup?.n ?? 0) > 0) throw new BizException(40003, `该渠道已有 ${dup!.n} 行相同交易单号的账单（疑似重复导入）`);
    const day = b.billDate || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const batchNo = `ZD-${channel === '微信' ? 'WX' : 'ZFB'}-${day}-${String(Date.now()).slice(-4)}`;
    let n = 0;
    for (const r of parsed.rows) {
      await q(
        `INSERT INTO payment_bills (store_id, batch_no, channel, external_no, amount, pay_time, bill_status, direction, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [u.storeId, batchNo, channel, r.externalNo,
         r.amount, r.payTime, r.billStatus || null, r.direction || null, JSON.stringify(r.raw)]);
      n++;
    }
    const match = await this.svc.matchBatch(u.storeId, batchNo, channel);
    const run = await this.svc.summarize(u.storeId, batchNo, channel, u.sub);
    // ── RV-07 触达：对账出差异 → 站内提醒（按批次幂等，重复导入同批次不重复提醒）──
    const diffRows = Number(run.diff_rows ?? 0);
    const revRows = Number((run as any).reverseRows ?? 0);
    if (diffRows > 0 || revRows > 0) {
      await notifyStaff(u.storeId, 'recon_diff',
        `对账差异：${channel} ${batchNo}（平台差异 ${diffRows} 行${revRows ? ` / 本地多收 ${revRows} 行` : ''}），请到「财务对账」复核`,
        { batchNo, channel, diffRows, revRows, runId: run.runId }, 'sys.settings', `${batchNo}:${channel}`);
    }
    await audit(u.storeId, u.sub, '财务', 'finance.recon.import', 'bill_recon_run', run.runId,
      { batchNo, channel, rows: n, skipped: parsed.skipped, matched: match.matched, diffs: Number(run.diff_rows ?? 0) });
    return { batchNo, channel, importedRows: n, skipped: parsed.skipped, ...match, ...run };
  }

  /** 对账批次列表 */
  @Get('runs')
  async runs(@CurrentUser() u: AuthUser) {
    const rows = await q(
      `SELECT id, batch_no, channel, bill_date, bill_rows, bill_total, matched_rows, matched_total, local_total, diff_rows, created_at
         FROM bill_recon_runs WHERE store_id=$1 ORDER BY id DESC LIMIT 50`, [u.storeId]);
    return { items: rows };
  }

  /** 批次详情（含差异清单） */
  @Get('runs/:id')
  async runDetail(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const run = await q1<any>(`SELECT * FROM bill_recon_runs WHERE id=$1 AND store_id=$2`, [id, u.storeId]);
    if (!run) throw new BizException(40404, '对账批次不存在', 404);
    const bills = await q(
      `SELECT id, external_no, amount, pay_time, bill_status, match_status, matched_order_id, match_note
         FROM payment_bills WHERE store_id=$1 AND batch_no=$2 AND channel=$3
        ORDER BY match_status='已匹配', pay_time NULLS LAST, id LIMIT 500`, [u.storeId, run.batch_no, run.channel]);
    return { run, bills, reverseDiffs: run.summary?.reverseDiffs ?? [] };
  }

  /** 单行忽略（误导入/测试行；从差异清单消化） */
  @Post('bills/:id/ignore')
  @RequirePerms('sys.settings')
  async ignore(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const r = await q(`UPDATE payment_bills SET match_status='已忽略', match_note='人工忽略' WHERE id=$1 AND store_id=$2 RETURNING id`, [id, u.storeId]);
    if (!r.length) throw new BizException(40404, '账单行不存在', 404);
    await audit(u.storeId, u.sub, '财务', 'finance.recon.ignore', 'payment_bill', Number(id), {});
    return { ok: true };
  }
}

/**
 * V4.14.6 RV-07：站内提醒（对账差异触达；铃铛红点用）
 *   GET  /finance/notices            —— 当前员工可见的提醒（按 perms 匹配收件权限点，最新 50 条）
 *   GET  /finance/notices/unread     —— 未读数（红点）
 *   POST /finance/notices/:id/read   —— 标记已读（各自独立，read_by 数组）
 */
@Controller('finance/notices')
export class FinanceNoticesController {
  private visibleFilter(u: AuthUser) {
    return { storeId: u.storeId, perms: u.perms?.length ? u.perms : ['__none__'] };
  }

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const { storeId, perms } = this.visibleFilter(u);
    const rows = await q<any>(
      `SELECT id, kind, title, detail, batch_key, created_at, read_by
         FROM notices WHERE store_id=$1 AND (perm = ANY($2::text[]) OR '*' = ANY($2::text[]))
        ORDER BY created_at DESC LIMIT 50`, [storeId, perms]);
    return { items: rows.map(r => ({
      id: Number(r.id), kind: r.kind, title: r.title, detail: r.detail, batchKey: r.batch_key,
      createdAt: r.created_at, read: Array.isArray(r.read_by) && r.read_by.includes(Number(u.sub)),
    })) };
  }

  @Get('unread')
  async unread(@CurrentUser() u: AuthUser) {
    const { storeId, perms } = this.visibleFilter(u);
    const r = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM notices
        WHERE store_id=$1 AND (perm = ANY($2::text[]) OR '*' = ANY($2::text[]))
          AND NOT (read_by @> to_jsonb($3::int))`, [storeId, perms, Number(u.sub)]);
    return { count: Number(r?.n ?? 0) };
  }

  @Post(':id/read')
  async markRead(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    await q(
      `UPDATE notices SET read_by = read_by || to_jsonb($2::int)
        WHERE id=$1 AND store_id=$3 AND NOT (read_by @> to_jsonb($2::int))`,
      [Number(id), Number(u.sub), u.storeId]);
    return { ok: true };
  }
}

@Module({ controllers: [FinanceReconController, FinanceNoticesController], providers: [BillReconService] })
export class FinanceReconModule {}
