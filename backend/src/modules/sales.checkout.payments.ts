/**
 * 结账支付域（Q-01 第二切片：checkout 按聚合拆服务 · 行为不变）
 *
 * 从 sales.module checkout 原样搬移「多支付组合处理」段：
 *   扫码购 auto 付清（6.4.2）/ 通道成功应答校验（V4.13.2）/ 余额本赠拆分（口径B 5.1.2）/
 *   分红抵扣 / 积分抵现（比例+单笔上限 V4.18.3 P15）/ 赊账停用（P2-3 老板口径）/
 *   连锁节点总部在线扣款 + 挂账补偿（批次5 M5-4/R3/R4 + P2-1 + L-04）/ sale_payments 落账 /
 *   Σ支付=应收 50031 强校验（RV-01 全程整数分）。
 *
 * 依赖以 ctx 注入；金额口径、错误码、审计与搬移前逐字一致。
 * 安全网：backend/tests/unit 41 单测 + tools/e2e-p03-checkout.mjs 28 项真实结账断言。
 * 注：creditCents 自「赊账通道停用」（P2-3）起恒为 0，4.95 挂账块随之成为死路径 —— 原样保留（行为不变）。
 */
import { BizException } from '../common/http';
import { audit, cx } from '../common/db';
import { nodeIdentity } from '../common/outbox';
import type { AuthUser } from '../common/auth';
import type { SettingsService } from './settings.module';
import { isChainStoreNode, hqMemberPost, offlineBalanceCredit, HQ_UNREACHABLE_CODE } from './member-chain.module';
import type { HqDebitRec } from './sales.module';

/** 元→整数分（与 sales.module toCents 同义；本地定义避免与宿主模块成环） */
const toCents = (yuan: number | string): number => Math.round(Number(yuan) * 100);

export interface PaymentsCtx {
  /** 结账事务客户端 */
  c: any;
  user: AuthUser;
  dto: any;
  settings: SettingsService;
  orderId: number;
  orderNo: string;
  /** 应收（分，已过促销/券/折扣/抹零） */
  payableCents: number;
  /** 收银员 id（扫码购自助=null） */
  operatorId: number | null;
  /** L-04：总部已扣款补偿登记表（结账外层持有，本地回滚时 reverseHqDebits 消费） */
  hqDebits: HqDebitRec[];
}

export interface PaymentsResult {
  paidCents: number;
  /** 有效消费（分）：储值本金 + 现金/扫码；分红/积分/赠送不计（5.1.16） */
  validSpendCents: number;
  /** 挂账合计（分）：显式 creditAmount（需 pos.credit.enabled+会员）；赊账通道已停用，其余路径恒 0 */
  creditCents: number;
  payLog: { channel: string; amount: number; externalNo: string | null }[];
}

/** 多支付组合处理（行为与拆分前完全一致） */
export async function processCheckoutPayments(ctx: PaymentsCtx): Promise<PaymentsResult> {
  const { c, user, dto, settings, orderId, orderNo, payableCents, operatorId } = ctx;
  const hqDebits = ctx.hqDebits;
  // RV-01 按分计算：支付/拆分全程整数分，通道逐分比对、余额本赠拆分、合计比对零浮点误差
  let paidCents = 0;
  let validSpendCents = 0; // 有效消费（分）：储值本金 + 现金/扫码；分红/积分/赠送部分不计
  // V4.18.3 P15 批2：积分抵现单笔上限（pos.points.max_pct %，0/缺省=不启用上限）
  const ptsMaxPct = await settings.getNum('pos.points.max_pct', 20);
  const ptsCapCents = ptsMaxPct > 0 ? Math.floor(payableCents * ptsMaxPct / 100) : payableCents;
  let ptsUsedCents = 0;
  // ── 挂账落欠款修复（2026-10-09）：赊账通道停用（P2-3）后 creditCents 恒 0、4.95 块成死路径 ──
  // 现改为**显式挂账**：收银端传 dto.creditAmount（元）→ 须开启 pos.credit.enabled（默认关，总部级）
  // + 指定会员；Σ(支付+挂账)=应收（下方 50031 同步放宽）；挂账部分不进 sale_payments，
  // 由 4.95 落 member_credits 账期欠款（due_days）并置 pay_paid_at=NULL（V5.0.18c 回款日归属）。
  let creditCents = 0;
  if (dto.creditAmount !== undefined && dto.creditAmount !== null && Number(dto.creditAmount) > 0) {
    if (!(await settings.getBool('pos.credit.enabled', false)))
      throw new BizException(40003, '挂账未开启（pos.credit.enabled），请用组合支付当场结清');
    if (!dto.memberId) throw new BizException(40003, '挂账必须指定会员（挂账落 member_credits 账期欠款）');
    creditCents = toCents(dto.creditAmount);
    if (creditCents > payableCents)
      throw new BizException(40003, `挂账金额不能超过应收（应收 ${payableCents / 100} 元）`);
  }
  const payLog: { channel: string; amount: number; externalNo: string | null }[] = []; // V5.0.0：上行快照
  // V5.0.0 批次5（M5-4）：连锁门店节点会员卡号缓存（一次结账只查一次）
  let chainCardNo: string | null = null;
  for (const pay of (dto.payments ?? [])) {
    let amountCents = toCents(pay.amount);
    // 扫码购自助结算（6.4.2）：auto 通道自动按应收付清（余额/微信/支付宝直付 VQA-D3 泛化）
    if (pay.auto) {
      amountCents = payableCents - paidCents;
      if (!(amountCents > 0)) continue;
    }
    if (amountCents < 0) throw new BizException(40003, '支付金额不能为负数');
    // V5.0.15 QA 发现：抹零后应收可能为 0（如抹元规则下 0.99 元商品被抹到 0），
    // 此时收银台会提交 amount=0 的现金单，沿用「必须大于 0」会直接 40003 卡住收银。
    // 应收为 0 时允许 0 元支付；应收 >0 时仍要求每笔为正，
    // 「Σ支付 = 应收」的强校验在下方 50031 兜底，不会因此放过金额不符。
    if (amountCents === 0 && payableCents > 0) throw new BizException(40003, '支付金额必须大于 0');
    // ── V4.13.2 通道成功应答校验：带 gatewayOutTradeNo 的支付必须对上网关 SUCCESS 且金额逐分一致的单，
    //    防止店员谎报到账/截图造假（成熟做法的等价保障：只有真通道应答才能落单）──
    let gatewayTxnId: string | null = null;
    if (pay.gatewayOutTradeNo) {
      const txns = await cx(c,
        `SELECT * FROM pay_gateway_txns WHERE out_trade_no=$1 AND status='SUCCESS' AND store_id=$2 FOR UPDATE`,
        [String(pay.gatewayOutTradeNo).trim(), user.storeId]);
      const txn = txns[0];
      if (!txn) throw new BizException(40902, '支付通道流水不存在或未成功，禁止结账（请先完成通道扣款）');
      if (Number(txn.amount_cents) !== amountCents)
        throw new BizException(40902, `通道扣款金额(${Number(txn.amount_cents) / 100})与支付金额(${amountCents / 100})不一致`);
      if (Number(txn.order_id)) throw new BizException(40902, '该通道流水已关联其他订单');
      gatewayTxnId = txn.transaction_id;
    }
    let balanceFlowId: number | null = null;
    let dividendFlowId: number | null = null;
    let pointsFlowId: number | null = null;
    let hqTicket: string | null = null;   // V5.0.0 批次5：总部资产扣款凭证（MCF 单号，随 external_no 留痕）
    if (pay.channel === '余额') {
      if (!dto.memberId) throw new BizException(50030, '余额支付必须指定会员');
      if (await isChainStoreNode()) {
        // ── 批次5（M5-4，R3）：连锁门店节点 —— 余额权威账本在总部，在线扣款拿 ticket 作支付凭证；
        //    总部不可达 → 明确报错（事务回滚，收银员可改其他支付方式继续结账，不阻断收银）；
        //    本地不重复记账（镜像由总部 member_mirror 下行覆盖）；本金/赠送拆分以总部返回为准。
        if (!chainCardNo) {
          const mcs = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
          chainCardNo = mcs[0]?.card_no ?? null;
        }
        if (!chainCardNo) throw new BizException(50030, '会员卡号缺失，无法余额支付');
        let d: any;
        try {
          d = await hqMemberPost('debit', { cardNo: chainCardNo, orderNo, asset: 'balance', amount: amountCents / 100 });
        } catch (e: any) {
          // ── P2-1（§3.5.4）：总部「网络不可达」（50071）且门店开启挂账 + 限额内 → 先记账后清算；
          //    业务拒绝（余额不足等）与限额超限照旧阻断，收银员改用其他支付方式。
          if (Number(e?.bizCode) !== HQ_UNREACHABLE_CODE) throw e;
          const off = await offlineBalanceCredit(c, {
            storeId: user.storeId, memberId: dto.memberId, cardNo: chainCardNo,
            orderNo, amountCents, nodeCode: (await nodeIdentity())?.nodeCode,
          });
          hqTicket = off.ticket;
          validSpendCents += amountCents;   // 挂账全额暂按本金计有效消费（清算后总部拆分为准，报表口径近似）
        }
        if (d) {
          hqTicket = String(d.ticket);
          validSpendCents += Math.round(Number(d.principalPart ?? 0) * 100);   // 本金部分进有效消费（5.1.16）
          // L-04：记录已成功的总部扣款，供本地回滚时补偿撤销
          hqDebits.push({ asset: 'balance', cardNo: chainCardNo!, orderNo, storeId: user.storeId, operatorId: operatorId ?? user.sub, amount: amountCents / 100 });
        }
      } else {
      const accs = await cx(c, `SELECT * FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [dto.memberId]);
      const acc = accs[0];
      if (!acc || Math.round(Number(acc.balance) * 100) < amountCents)
        throw new BizException(50030, `会员余额不足（余额 ${acc ? acc.balance : 0}）`);
      // 口径B 本金/赠送按比例拆分（5.1.2）：principal_part 进有效消费，赠送部分不计（RV-01 按分）
      const totalBalC = Math.round(Number(acc.balance) * 100);
      const principalBalC = Math.round(Number(acc.principal_balance ?? acc.balance) * 100);
      let principalCents = totalBalC > 0 ? Math.round(amountCents * principalBalC / totalBalC) : 0;
      if (principalCents > amountCents) principalCents = amountCents;
      if (principalCents > principalBalC) principalCents = principalBalC;
      const giftCents = amountCents - principalCents;
      const afterCents = totalBalC - amountCents;
      const fl = await cx(c,
        `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                    biz_type, ref_type, ref_id, balance_after, employee_id)
         VALUES ($1,$2,'出',$3,$4,$5,'消费','sale',$6,$7,$8) RETURNING id`,
        [user.storeId, dto.memberId, amountCents / 100, principalCents / 100, giftCents / 100, orderId, afterCents / 100, operatorId]);
      balanceFlowId = fl[0].id;
      await cx(c,
        `UPDATE member_accounts SET balance=$2, principal_balance = principal_balance - $3,
                gift_balance = gift_balance - $4, updated_at=now()
          WHERE member_id=$1`, [dto.memberId, afterCents / 100, principalCents / 100, giftCents / 100]);
      validSpendCents += principalCents;
      }
    } else if (pay.channel === '分红抵扣') {
      if (!dto.memberId) throw new BizException(50033, '分红抵扣必须指定会员');
      if (await isChainStoreNode()) {
        // ── 批次5：分红账本在总部（分红引擎只在总部跑），扣减在线执行，防跨店双花
        if (!chainCardNo) {
          const mcs = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
          chainCardNo = mcs[0]?.card_no ?? null;
        }
        if (!chainCardNo) throw new BizException(50033, '会员卡号缺失，无法分红抵扣');
        const d = await hqMemberPost('debit', { cardNo: chainCardNo, orderNo, asset: 'dividend', amount: amountCents / 100 });
        hqTicket = String(d.ticket);
        // L-04：记录已成功的总部扣款，供本地回滚时补偿撤销
        hqDebits.push({ asset: 'dividend', cardNo: chainCardNo!, orderNo, storeId: user.storeId, operatorId: operatorId ?? user.sub, amount: amountCents / 100 });
      } else {
      const accs = await cx(c, `SELECT * FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [dto.memberId]);
      const acc = accs[0];
      if (!acc || Math.round(Number(acc.dividend_balance) * 100) < amountCents) {
        throw new BizException(50033, `分红余额不足（余额 ${acc ? acc.dividend_balance : 0}，仅限消费抵扣 5.7）`);
      }
      await cx(c, `UPDATE member_accounts SET dividend_balance = dividend_balance - $2, updated_at=now() WHERE member_id=$1`,
        [dto.memberId, amountCents / 100]);
      const df = await cx(c,
        `INSERT INTO dividend_records (store_id, member_id, record_type, amount, ref_type, ref_id, operator_id)
         VALUES ($1,$2,'抵扣',$3,'sale',$4,$5) RETURNING id`,
        [user.storeId, dto.memberId, amountCents / 100, orderId, user.sub]);
      dividendFlowId = df[0].id;
      // 分红支付不计有效消费（5.1.16：堵「只花分红、本金永不动」漏洞）
      }
    } else if (pay.channel === '积分抵扣') {
      if (!dto.memberId) throw new BizException(50034, '积分抵扣必须指定会员');
      // V4.18.3 P15 批2：比例优先用收银台键 pos.points.rate（每 1 元所需积分），缺省回落 points.redeem_rate；
      //          单笔上限 pos.points.max_pct（%应收），超出直接拒绝（§13 定稿：比例可设+单笔上限）
      if (ptsUsedCents + amountCents > ptsCapCents) {
        throw new BizException(50034, `积分抵现超出单笔上限（≤应收的 ${ptsMaxPct}%），本单最多可抵 ${ptsCapCents / 100} 元`);
      }
      const rate = await settings.getNum('pos.points.rate', 0);
      const effRate = rate > 0 ? rate : await settings.getNum('points.redeem_rate', 100); // 多少积分 = 1 元
      const need = Math.ceil((amountCents / 100) * effRate);
      if (await isChainStoreNode()) {
        // ── 批次5：积分账本在总部（R4），兑换在线扣减，防跨店双花；本地只落支付凭证
        if (!chainCardNo) {
          const mcs = await cx(c, `SELECT card_no FROM members WHERE id=$1`, [dto.memberId]);
          chainCardNo = mcs[0]?.card_no ?? null;
        }
        if (!chainCardNo) throw new BizException(50034, '会员卡号缺失，无法积分抵扣');
        const d = await hqMemberPost('debit', { cardNo: chainCardNo, orderNo, asset: 'points', points: need });
        hqTicket = String(d.ticket);
        // L-04：记录已成功的总部扣款，供本地回滚时补偿撤销
        hqDebits.push({ asset: 'points', cardNo: chainCardNo!, orderNo, storeId: user.storeId, operatorId: operatorId ?? user.sub, points: need });
      } else {
      const ms = await cx(c, `SELECT points FROM members WHERE id=$1 FOR UPDATE`, [dto.memberId]);
      const cur = ms.length ? Number(ms[0].points) : 0;
      if (cur < need) throw new BizException(50034, `积分不足（需 ${need} 分，可用 ${cur} 分）`);
      await cx(c, `UPDATE members SET points = points - $2, updated_at=now() WHERE id=$1`, [dto.memberId, need]);
      await cx(c, `UPDATE member_accounts SET points = points - $2, updated_at=now() WHERE member_id=$1`, [dto.memberId, need]);
      const pf = await cx(c,
        `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
         VALUES ($1,'减',$2,'兑换','sale',$3,$4) RETURNING id`,
        [dto.memberId, need, orderId, cur - need]);
      pointsFlowId = pf[0].id;
      }
      ptsUsedCents += amountCents;
      // 积分抵扣部分不计有效消费
    } else if (pay.channel === '赊账') {
      // ── P2-3（2026-09-18 老板口径定版）：会员结账余额不足 → 组合支付（余额抵扣 + 现金/微信/支付宝
      //    当场结清），不得赊账。会员「赊账」支付通道停用；历史欠款（member_credits）销账/关闭
      //    端点保留（/pos/credits/*）；大客户团购应收（bigcustomer 赊账）是 B2B 业务，不在本口径内。
      throw new BizException(40003,
        '会员赊账已停用：余额不足请用组合支付（余额抵扣一部分 + 现金/微信/支付宝当场结清），不产生欠款');
    } else {
      validSpendCents += amountCents; // 现金/扫码等真实货币支付
    }
    await cx(c,
      `INSERT INTO sale_payments (order_id, channel, amount, balance_flow_id, dividend_flow_id, points_flow_id, external_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orderId, pay.channel, amountCents / 100, balanceFlowId, dividendFlowId, pointsFlowId, pay.externalNo ?? gatewayTxnId]);
    // V4.13.2：通道流水回填关联销售单（对账/追溯链路）
    if (pay.gatewayOutTradeNo) {
      await cx(c, `UPDATE pay_gateway_txns SET order_id=$1 WHERE out_trade_no=$2 AND order_id IS NULL AND store_id=$3`,
        [orderId, String(pay.gatewayOutTradeNo).trim(), user.storeId]);
    }
    payLog.push({ channel: String(pay.channel), amount: amountCents / 100, externalNo: hqTicket ?? gatewayTxnId ?? pay.externalNo ?? null });
    paidCents += amountCents;
  }
  // ── 4.9 支付+挂账合计 == 应收（RV-01：全程整数分累计，逐分比对零浮点误差）──
  //   挂账未传（默认 0）时语义与原实现完全一致；传挂账时差额部分由 4.95 落 member_credits。
  if (paidCents + creditCents !== payableCents)
    throw new BizException(50031, creditCents > 0
      ? `支付合计(${paidCents / 100})+挂账(${creditCents / 100})与应收(${payableCents / 100})不一致`
      : `支付合计(${paidCents / 100})与应收(${payableCents / 100})不一致`);

  // ── 4.95 会员挂账落欠款（V4.18.3 P15 批2 §13.2 B2）：一笔挂账=一笔独立欠款，账期/原因留痕 ──
  if (creditCents > 0 && dto.memberId) {
    // V5.0.18 挂账单按实际回款日归属：含挂账金额的单 pay_paid_at 置空（日结等 COALESCE 回退创建日），
    //   待销账全额结清时由 creditsSettle 回写 pay_paid_at=回款时刻 → 业务日跳到实际回款日。
    await cx(c, `UPDATE sales_orders SET pay_paid_at=NULL WHERE id=$1`, [orderId]);
    const dueDays = await settings.getNum('pos.credit.due_days', 30);
    await cx(c,
      `INSERT INTO member_credits (store_id, member_id, order_id, amount, due_date, reason, creator_id)
       VALUES ($1,$2,$3,$4,(CURRENT_DATE + ($5::int)), $6, $7)`,
      [user.storeId, dto.memberId, orderId, creditCents / 100, dueDays, dto.remark ?? null, operatorId]);
    await audit(user.storeId, operatorId ?? user.sub, '收银', '会员挂账', 'sales_order', orderId,
      { amount: creditCents / 100, dueDays });
  }
  return { paidCents, validSpendCents, creditCents, payLog };
}
