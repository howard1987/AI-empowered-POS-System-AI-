import { Module, Controller, Post, Get, Body, Param } from '@nestjs/common';
import { q, q1, cx, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { WechatPayAdapter, AlipayAdapter, type MicropayInput, type RefundInput, type GatewayResult } from './pay.adapters';

/**
 * V4.13.2 支付通道适配层（成熟收银闭环：扫顾客付款码 → 通道扣款 → 成功信号落单，免人工核对到账）
 *   - detectChannel：付款码前缀自动识别渠道（微信 10~15 开头 / 支付宝 25~30 开头，16~32 位数字）
 *   - PayAdapter 适配器接口：micropay（付款码扣款 B-scan-C）/ refund（原路退款）；
 *     本期 MockPayAdapter（除「付款码尾号 0000」模拟失败外即时成功），商户资质下来后按 mode 分发真适配器
 *   - pay_gateway_txns 网关流水：out_trade_no 唯一幂等；结账时校验「通道 SUCCESS 且金额逐分一致」
 *     才允许挂扫码支付（店员谎报/截图造假的通道级防线），成功后回填 order_id 关联销售单
 *   - refundInTx：退款单执行时按 external_no 匹配网关成功单 → CAS 原路退（防超额/并发重复退）；
 *     匹配不到（记账式手记流水）→ 返回 null 交由退款模块留痕
 *   - 配置 pay.gateway.mode：mock=模拟通道（默认）/ off=记账式收款（PWA 回退 V4.13.1 二次确认）
 * 错误码：40900 通道未启用 · 40901 通道退款冲突/超额 · 40902 通道流水校验失败 · 40903 付款码格式无法识别
 */

const cents = (yuan: number | string): number => Math.round(Number(yuan) * 100);

/** 付款码 → 渠道识别（微信付款码 10~15 开头；支付宝 25~30 开头；总长 16~32 位数字） */
export function detectChannel(authCode: string): '微信' | '支付宝' | null {
  const code = String(authCode ?? '').trim();
  if (!/^\d{16,32}$/.test(code)) return null;
  if (/^1[0-5]/.test(code)) return '微信';
  if (/^(2[5-9]|30)/.test(code)) return '支付宝';
  return null;
}

interface PayResult { success: boolean; transactionId?: string; failCode?: string; failMsg?: string; }
interface RefundResult { success: boolean; refundId?: string; failMsg?: string; }

/** 适配器统一接口（mock/微信/支付宝共用，V4.13.3 起；V4.13.4 微信补 query 查单） */
interface PayAdapter {
  micropay(input: MicropayInput): Promise<GatewayResult>;
  refund(input: RefundInput): Promise<GatewayResult>;
  /** 查单（可选）：USERPAYING 轮询与 PENDING 流水补查；仅微信 V3 实现 */
  query?(outTradeNo: string): Promise<{ tradeState: string; transactionId?: string }>;
}

/** MockPayAdapter：模拟通道 —— 联调用；接口签名与真通道一致，切换适配器不动业务层 */
class MockPayAdapter implements PayAdapter {
  async micropay(input: MicropayInput): Promise<PayResult> {
    if (!(input.amountCents > 0)) return { success: false, failCode: 'PARAM_ERROR', failMsg: '扣款金额必须大于 0' };
    if (input.authCode.slice(-4) === '0000') {
      return { success: false, failCode: 'AUTH_CODE_INVALID', failMsg: '模拟失败：付款码无效（尾号 0000）' };
    }
    return { success: true, transactionId: `MOCK${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}` };
  }
  async refund(input: RefundInput): Promise<RefundResult> {
    if (!(input.refundCents > 0)) return { success: false, failMsg: '退款金额必须大于 0' };
    return { success: true, refundId: `MR${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}` };
  }
}

export class PayGatewayService {
  private settings = new SettingsService();
  private mock = new MockPayAdapter();
  private wechat = new WechatPayAdapter();
  private alipay = new AlipayAdapter();

  /**
   * 按配置分发适配器（V4.13.3 三态）。
   * 收款口径：off=记账式 40900（PWA 回退二次确认）；mock=模拟通道；real=真通道按渠道分派（未启用渠道 40905）。
   * 退款口径：real 且渠道启用 → 真通道原路退；渠道未启用 → 回落 mock（历史/未配置流水兜底，不阻断内部退款）。
   */
  private async adapterFor(channel?: string | null, opts: { forRefund?: boolean } = {}): Promise<PayAdapter> {
    const mode = await this.settings.getVal('pay.gateway.mode');
    // ── V4.28.1 安全修复（P0-2 模拟通道门禁）：pay.gateway.allow_mock=0 时拒绝 mock 假扣款，
    //    防"上线忘切通道"造成假收款。记账式 off 不受影响——那是"不发起通道请求"的真实记账，
    //    不是假成功。退款走 forRefund 分支不拦（原路退需匹配已有 mock 流水）。 ──
    if (mode === 'mock' && !opts.forRefund) {
      const allowMock = (await this.settings.getNum('pay.gateway.allow_mock', 1)) === 1;
      if (!allowMock) {
        throw new BizException(40900,
          '模拟支付通道已被关闭（pay.gateway.allow_mock=0）：请配置真实支付通道，或在后台改回记账式收款');
      }
    }
    if (mode === 'off' && !opts.forRefund) {
      throw new BizException(40900, '支付通道未启用（当前为记账式收款）');
    }
    if (mode === 'real' && (channel === '微信' || channel === '支付宝')) {
      const key = channel === '微信' ? 'pay.wechat.enabled' : 'pay.alipay.enabled';
      if ((await this.settings.getNum(key, 0)) === 1) {
        return channel === '微信' ? this.wechat : this.alipay;
      }
      if (!opts.forRefund) {
        throw new BizException(40905, `${channel}真通道未启用（支付设置中先启用并填齐 API 配置）`);
      }
    }
    return this.mock;
  }

  /** 付款码扣款（被扫 B-scan-C）：out_trade_no 幂等，成功流水落 pay_gateway_txns */
  async micropay(user: AuthUser, dto: { authCode: string; amount: number; outTradeNo?: string }) {
    const channel = detectChannel(dto.authCode);
    if (!channel) {
      throw new BizException(40903, '付款码格式无法识别（微信 10~15 / 支付宝 25~30 开头，16~32 位数字）');
    }
    const amountCents = cents(dto.amount);
    if (!(amountCents > 0)) throw new BizException(40003, '扣款金额必须大于 0');
    const adapter = await this.adapterFor(channel); // off 40900 / real 配置缺失 40904、渠道未启用 40905
    const code = String(dto.authCode).trim();
    const outTradeNo = String(dto.outTradeNo || '').trim() ||
      `PG${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // 并发互斥（修复 L-03 双扣竞态）：先以 PENDING 占位，抢不到行说明同 out_trade_no 已在处理/已存在
    // → 转查单/幂等，绝不重复触通道；原实现「先查后扣」在并发窗口会向通道发起两笔真实扣款。
    const ins = await q(
      `INSERT INTO pay_gateway_txns (store_id, out_trade_no, channel, auth_code_last4, amount_cents, status)
       VALUES ($1,$2,$3,$4,$5,'PENDING') ON CONFLICT (out_trade_no) DO NOTHING RETURNING id`,
      [user.storeId, outTradeNo, channel, code.slice(-4), amountCents]);
    if (!ins.length) {
      // 已被本请求并发/历史占用 → 查现状，不再触通道
      const row = await q1<any>(`SELECT * FROM pay_gateway_txns WHERE out_trade_no=$1`, [outTradeNo]);
      if (row) {
        if (Number(row.store_id) !== Number(user.storeId))
          throw new BizException(40903, '商户单号已被其他门店占用，请勿复用流水号', 400);
        if (row.status === 'SUCCESS')
          return { success: true, idempotent: true, channel: row.channel, outTradeNo,
                   transactionId: row.transaction_id, paidAmount: Number(row.amount_cents) / 100 };
        if (row.status === 'FAIL')
          return { success: false, channel: row.channel, outTradeNo, failCode: row.fail_code, failMsg: row.fail_msg };
        // PENDING：顾客支付确认中 → 走查单兜底（若有 query 能力）
        if (adapter.query) {
          const polled = await this.pollUserpaying(adapter, outTradeNo);
          if (polled.state === 'SUCCESS') {
            const srow = await this.markSuccess(outTradeNo, polled.transactionId!, user.storeId, channel, code.slice(-4), amountCents);
            return { success: true, channel, outTradeNo, transactionId: srow.transaction_id,
                     paidAmount: Number(srow.amount_cents) / 100, userpayingResolved: true };
          }
          if (polled.state === 'FAIL') {
            await this.markFail(outTradeNo, polled.failCode ?? 'PAYERROR', polled.failMsg ?? '顾客未完成支付');
            return { success: false, channel, outTradeNo, failCode: polled.failCode ?? 'PAYERROR', failMsg: polled.failMsg ?? '顾客未完成支付' };
          }
        }
        return { success: false, pending: true, channel, outTradeNo, failCode: 'USERPAYING',
                 failMsg: '顾客支付确认中…请勿重复扫码；稍后可点「查单」确认结果' };
      }
    }

    const r = await adapter.micropay({ outTradeNo, authCode: code, amountCents, description: '门店扫码收款' });
    // ── V4.13.4 USERPAYING：顾客输入密码中 → 先落 PENDING 流水，再按设置轮询查单至终态 ──
    if (!r.success && r.failCode === 'USERPAYING' && adapter.query) {
      await q(
        `INSERT INTO pay_gateway_txns (store_id, out_trade_no, channel, auth_code_last4, amount_cents, status)
         VALUES ($1,$2,$3,$4,$5,'PENDING') ON CONFLICT (out_trade_no) DO NOTHING`,
        [user.storeId, outTradeNo, channel, code.slice(-4), amountCents]);
      const polled = await this.pollUserpaying(adapter, outTradeNo);
      if (polled.state === 'SUCCESS') {
        const row = await this.markSuccess(outTradeNo, polled.transactionId!, user.storeId, channel, code.slice(-4), amountCents);
        return { success: true, channel, outTradeNo, transactionId: row.transaction_id,
                 paidAmount: Number(row.amount_cents) / 100, userpayingResolved: true };
      }
      if (polled.state === 'FAIL') {
        await this.markFail(outTradeNo, polled.failCode ?? 'PAYERROR', polled.failMsg ?? '顾客未完成支付');
        return { success: false, channel, outTradeNo, failCode: polled.failCode ?? 'PAYERROR', failMsg: polled.failMsg ?? '顾客未完成支付' };
      }
      // 轮询用尽仍是 USERPAYING：保留 PENDING 流水，PWA 侧提示后可走查单兜底
      return { success: false, pending: true, channel, outTradeNo, failCode: 'USERPAYING',
               failMsg: '顾客支付确认中…请勿重复扫码；稍后可点「查单」确认结果' };
    }
    if (r.success) {
      const row = await this.markSuccess(outTradeNo, r.transactionId!, user.storeId, channel, code.slice(-4), amountCents);
      return { success: true, channel, outTradeNo, transactionId: row.transaction_id,
               paidAmount: Number(row.amount_cents) / 100 };
    }
    await this.markFail(outTradeNo, r.failCode ?? 'UNKNOWN', r.failMsg ?? '扣款失败',
      user.storeId, channel, code.slice(-4), amountCents);
    return { success: false, channel, outTradeNo, failCode: r.failCode, failMsg: r.failMsg };
  }

  /** USERPAYING 查单轮询：成功/终态失败即返回；用尽次数返回 PENDING */
  private async pollUserpaying(adapter: PayAdapter, outTradeNo: string): Promise<
    { state: 'SUCCESS'; transactionId: string } | { state: 'FAIL'; failCode?: string; failMsg?: string } | { state: 'PENDING' }> {
    const polls = Math.min(Math.max(await this.settings.getNum('pay.gateway.userpaying_polls', 8), 1), 60);
    const intervalSec = Math.min(Math.max(await this.settings.getNum('pay.gateway.userpaying_interval_sec', 4), 1), 60);
    const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
    for (let i = 0; i < polls; i++) {
      await sleep(intervalSec * 1000);
      try {
        const qr = await adapter.query!(outTradeNo);
        if (qr.tradeState === 'SUCCESS' && qr.transactionId) return { state: 'SUCCESS', transactionId: qr.transactionId };
        if (['CLOSED', 'REVOKED', 'PAYERROR', 'NOT_PAY'].includes(qr.tradeState)) {
          return { state: 'FAIL', failCode: qr.tradeState, failMsg: `顾客未完成支付（${qr.tradeState}）` };
        }
      } catch { /* 单次查单失败不计终态，继续轮询 */ }
    }
    return { state: 'PENDING' };
  }

  /** 成功流水落库（幂等 ON CONFLICT）+ 回读 */
  private async markSuccess(outTradeNo: string, transactionId: string,
    storeId: number, channel: string, last4: string, amountCents: number) {
    await q(
      `INSERT INTO pay_gateway_txns (store_id, out_trade_no, channel, auth_code_last4, amount_cents,
                                     status, transaction_id, paid_at)
       VALUES ($1,$2,$3,$4,$5,'SUCCESS',$6,now())
       ON CONFLICT (out_trade_no) DO UPDATE SET status='SUCCESS', transaction_id=$6, paid_at=now(),
         fail_code=NULL, fail_msg=NULL`,
      [storeId, outTradeNo, channel, last4, amountCents, transactionId]);
    return q1<any>(`SELECT * FROM pay_gateway_txns WHERE out_trade_no=$1`, [outTradeNo]);
  }

  /** 失败流水落库（幂等；PENDING 行降级为 FAIL） */
  private async markFail(outTradeNo: string, failCode: string, failMsg: string,
    storeId?: number, channel?: string, last4?: string, amountCents?: number) {
    await q(
      `INSERT INTO pay_gateway_txns (store_id, out_trade_no, channel, auth_code_last4, amount_cents,
                                     status, fail_code, fail_msg)
       VALUES ($1,$2,$3,$4,$5,'FAIL',$6,$7)
       ON CONFLICT (out_trade_no) DO UPDATE SET status='FAIL', fail_code=$6, fail_msg=$7`,
      [storeId ?? 0, outTradeNo, channel ?? '未知', last4 ?? '', amountCents ?? 0, failCode, failMsg]);
  }

  /** 查单（对账 / 补查）：按我方单号查本店网关流水；PENDING 行先向通道补查一次（V4.13.4 查单兜底） */
  async query(user: AuthUser, outTradeNo: string) {
    let row = await q1<any>(
      `SELECT * FROM pay_gateway_txns WHERE out_trade_no=$1 AND store_id=$2`, [outTradeNo, user.storeId]);
    if (!row) throw new BizException(40404, '网关流水不存在', 404);
    if (row.status === 'PENDING') {
      const adapter = await this.adapterFor(row.channel, { forRefund: true }).catch((): any => null);
      if (adapter?.query) {
        try {
          const qr = await adapter.query(outTradeNo);
          if (qr.tradeState === 'SUCCESS' && qr.transactionId) {
            row = await this.markSuccess(outTradeNo, qr.transactionId, Number(row.store_id),
              row.channel, row.auth_code_last4 ?? '', Number(row.amount_cents));
          } else if (['CLOSED', 'REVOKED', 'PAYERROR', 'NOT_PAY'].includes(qr.tradeState)) {
            await this.markFail(outTradeNo, qr.tradeState, `顾客未完成支付（${qr.tradeState}）`);
            row = await q1<any>(`SELECT * FROM pay_gateway_txns WHERE out_trade_no=$1`, [outTradeNo]);
          }
        } catch { /* 通道查单失败 → 返回本地 PENDING 现状 */ }
      }
    }
    return { ...row, id: Number(row.id), amount_cents: Number(row.amount_cents),
             refund_cents: Number(row.refund_cents), order_id: row.order_id ? Number(row.order_id) : null };
  }

  /** V4.18.5 P15批4 半支付恢复：本店近 24h PENDING 网关流水（收银台启动自动查漏，页面重开不丢卡单） */
  async pendingList(user: AuthUser) {
    const rows = await q<any>(
      `SELECT out_trade_no, channel, auth_code_last4, amount_cents, created_at
         FROM pay_gateway_txns
        WHERE store_id=$1 AND status='PENDING' AND created_at > now() - interval '24 hours'
        ORDER BY id DESC LIMIT 50`, [user.storeId]);
    return rows.map(r => ({ outTradeNo: r.out_trade_no, channel: r.channel, last4: r.auth_code_last4,
                            amount: Number(r.amount_cents) / 100, createdAt: r.created_at }));
  }

  /** V4.18.5 P15批4：查单确认未付后人工释放（PENDING → FAIL/ABANDONED，留痕防误释放已扣款单） */
  async abandon(user: AuthUser, outTradeNo: string) {
    // VQA-P0（M4-05/DEF-12）：释放前强制查单——通道侧已扣款则拒绝释放并补记 SUCCESS，防「货走款未到」
    const fresh = await this.query(user, outTradeNo);
    if (fresh.status === 'SUCCESS')
      throw new BizException(40906, '通道查单确认已扣款，禁止释放：流水已补记为已收款，请走挂起单查单恢复或退款', 409);
    const row = fresh && fresh.status === 'PENDING'
      ? await q1<any>(`SELECT * FROM pay_gateway_txns WHERE out_trade_no=$1 AND store_id=$2`, [outTradeNo, user.storeId])
      : null;
    if (!row) throw new BizException(40906, `流水状态(${fresh.status})不可释放：仅待支付流水可人工释放`, 409);
    await q(
      `UPDATE pay_gateway_txns SET status='FAIL', fail_code='ABANDONED', fail_msg='收银台确认未支付，人工释放挂起（已查单未见扣款）'
        WHERE id=$1`, [row.id]);
    await audit(user.storeId, user.sub, '收银', 'pay.pending.abandon', 'pay_gateway_txn', Number(row.id),
      { outTradeNo, amount: Number(row.amount_cents) / 100, channel: row.channel });
    return { ok: true, outTradeNo };
  }

  /**
   * 通道原路退（refund.module 事务内调用）：external_no（通道流水号/我方单号）匹配 SUCCESS 单才退；
   * CAS 扣减额度防超额/并发重复退；真通道异步应答落库，本期 mock 即时应答。
   * 返回 null = 无匹配通道单（记账式手记流水）→ 调用方留痕。
   */
  async refundInTx(c: any, opts: { channel: string; externalNo: string | null; refundCents: number; refundNo: string }) {
    if (!opts.externalNo) return null;
    const txns = await cx(c,
      `SELECT * FROM pay_gateway_txns
        WHERE (transaction_id=$1 OR out_trade_no=$1) AND status IN ('SUCCESS','PART_REFUNDED')
        LIMIT 1 FOR UPDATE`, [opts.externalNo]);
    const txn = txns[0];
    if (!txn) return null;
    if (Number(txn.refund_cents) + opts.refundCents > Number(txn.amount_cents)) {
      throw new BizException(40901,
        `通道退款超额（原扣款 ${Number(txn.amount_cents) / 100}，已退 ${Number(txn.refund_cents) / 100}，本次 ${opts.refundCents / 100}）`);
    }
    const upd = await cx(c,
      `UPDATE pay_gateway_txns
          SET refund_cents = refund_cents + $2, refund_no=$3, refunded_at=now(),
              status = CASE WHEN refund_cents + $2 >= amount_cents THEN 'REFUNDED' ELSE 'PART_REFUNDED' END
        WHERE id=$1 AND refund_cents + $2 <= amount_cents RETURNING id`,
      [txn.id, opts.refundCents, opts.refundNo]);
    if (!upd.length) throw new BizException(40901, '通道退款状态冲突（并发退款），请重试');
    // V4.13.3：real 模式且渠道启用 → 真通道原路退；否则 mock 即时应答（历史流水兼容）
    const adapter = await this.adapterFor(txn.channel, { forRefund: true });
    const rr = await adapter.refund({
      outTradeNo: txn.out_trade_no, outRefundNo: opts.refundNo,
      totalCents: Number(txn.amount_cents), refundCents: opts.refundCents,
    });
    if (!rr.success) throw new BizException(40901, `通道退款失败：${rr.failMsg ?? '未知错误'}`);
    return { refunded: true, outTradeNo: txn.out_trade_no, transactionId: txn.transaction_id,
             refundCents: opts.refundCents, refundId: rr.refundId };
  }
}

// ─── Controller ───
@Controller('pay')
class PayGatewayController {
  private svc = new PayGatewayService();

  /** 付款码扣款（被扫）：PWA 扫码枪直扫顾客码，免手选渠道免人工核对 */
  @RequirePerms('pos.sell')
  @Post('micropay')
  micropay(@Body() dto: { authCode: string; amount: number; outTradeNo?: string },
           @CurrentUser() user: AuthUser) {
    return this.svc.micropay(user, dto);
  }

  /** 查单：按我方单号查网关流水（对账/补查） */
  @RequirePerms('pos.sell')
  @Get('txn/:outTradeNo')
  query(@Param('outTradeNo') outTradeNo: string, @CurrentUser() user: AuthUser) {
    return this.svc.query(user, outTradeNo);
  }

  /** V4.18.5 P15批4 半支付恢复：本店近 24h 待支付流水清单（收银台启动查漏） */
  @RequirePerms('pos.sell')
  @Get('pending')
  pending(@CurrentUser() user: AuthUser) {
    return this.svc.pendingList(user);
  }

  /** V4.18.5 P15批4：查单确认未付后人工释放（PENDING → FAIL，留痕） */
  @RequirePerms('settle.pay.close')
  @Post('txn/:outTradeNo/abandon')
  abandon(@Param('outTradeNo') outTradeNo: string, @CurrentUser() user: AuthUser) {
    return this.svc.abandon(user, outTradeNo);
  }
}

@Module({ controllers: [PayGatewayController] })
export class PayGatewayModule {}
