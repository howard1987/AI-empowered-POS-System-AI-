/**
 * V5.0.0 连锁 批次5 · 会员连锁（方案 §5.2 / §3.5，M5-1~M5-6，R3/R4）
 *
 * 【权威账本唯一】会员余额/分红/积分账本 = 总部库（方案拍板④③）。
 *   门店节点的 members/member_accounts 只是【镜像】：收银查询秒回（离线可查档），
 *   资产变动一律在线调总部端点，镜像由总部 `member_mirror` 下行覆盖（sync-store 应用）。
 *
 * 总部端点（节点鉴权 NodeGuard，门店节点调用）：
 *   POST /hq/member/register  连锁建档（卡号总部生成，杜绝门店自增撞号）
 *   POST /hq/member/debit     资产扣款（余额/分红/积分；行锁+幂等；返回 ticket 凭证）
 *   POST /hq/member/credit    资产回补（退货原路退；余额按原流水本金/赠送比例拆回）
 *   POST /hq/member/points    积分调整（正加负减，总部运营/营销用）
 *   GET  /hq/member/lookup    实时查档（收银台余额展示校准）
 * 后台端点（JWT，hq.member.crossview）：
 *   GET  /hq/member/flows     跨店资产流水（§5.2.4：涉商业敏感，默认不给门店）
 *
 * 【门店侧助手】isChainStoreNode / hqMemberPost / hqMemberGet：
 *   门店业务模块（sales/refund/members/member-app）用它把资产操作转发总部；
 *   总部不可达 → 明确报错不阻断收银（可改其他支付方式，方案 §5.2.2 失败处理）。
 *
 * 【单店零回归】isChainStoreNode() 只在「门店节点且已配置总部地址」为 true；
 *   总部/单店节点全部走原有本地路径，行为与改造前 100% 一致。
 */
import {
  Module, Controller, Get, Post, Body, Query, Req, UseGuards,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { q, q1, tx, cx, audit, r2 } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms, Public } from '../common/auth';
import { nodeIdentity, publish } from '../common/outbox';
import { NodeGuard } from '../common/node-guard';
import { HQ_HTTP_TIMEOUT_MS } from '../common/timeouts';   // V5.0.19i（Q-07）

/* ═══════════════════════ 门店侧助手（被 sales/refund/members 引用） ═══════════════════════ */

/** 本节点是否为「已配置总部的连锁门店节点」（余额/积分/分红/建档须走总部） */
export async function isChainStoreNode(): Promise<boolean> {
  const id = await nodeIdentity();
  return !!id && id.role === 'store' && id.enabled && !!id.hqBase && !!id.selfToken;
}

/** 节点鉴权请求头（与 sync-store.service 同口径） */
function nodeHeaders(): Record<string, string> {
  // 调用前须确保 isChainStoreNode()，这里兜底再取一次
  return {} as Record<string, string>;
}

/** P2-2：一次性 nonce（NodeGuard 去重用；未带则以 ts 兜底） */
function nodeNonce(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
}

async function nodeReq(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = HQ_HTTP_TIMEOUT_MS): Promise<any> {
  const id = await nodeIdentity();
  if (!id || id.role !== 'store' || !id.hqBase || !id.selfToken) {
    throw new BizException(50070, '本节点未配置为连锁门店节点（缺节点编码/密钥/总部地址）');
  }
  let res: Response;
  try {
    res = await fetch(`${id.hqBase.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'authorization': `Node ${id.nodeCode}:${id.selfToken}`,
        'x-sync-ts': String(Date.now()),
        'x-sync-nonce': nodeNonce(),
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new BizException(50071, '总部不可达，会员资产操作需联网（可改用其他支付方式继续结账）');
  }
  const j: any = await res.json().catch((): any => null);
  if (!res.ok) {
    throw new BizException(Number(j?.code) || 50072, String(j?.msg ?? `总部返回 HTTP ${res.status}`));
  }
  return j?.data ?? j;
}

/** 门店 → 总部 POST（member 资产端点） */
export function hqMemberPost(path: string, body: unknown, timeoutMs = HQ_HTTP_TIMEOUT_MS): Promise<any> {
  return nodeReq('POST', `/hq/member/${path}`, body, timeoutMs);
}

/** 门店 → 总部 GET（实时查档） */
export function hqMemberGet(query: string, timeoutMs = HQ_HTTP_TIMEOUT_MS): Promise<any> {
  return nodeReq('GET', `/hq/member/lookup?${query}`, undefined, timeoutMs);
}

/* ═══════════════════════ 镜像快照（总部 → 门店 member_mirror 下行） ═══════════════════════ */

/** 总部侧取会员+账户快照（snake_case 直落门店表列） */
export async function memberMirrorSnapshot(memberId: number): Promise<Record<string, unknown> | null> {
  const m = await q1<any>(
    `SELECT m.card_no, m.phone, m.name, m.pinyin_code, m.gender, m.birthday, m.level_id, m.points,
            m.status, m.last_active_date, m.invalid_at, m.register_channel, m.total_consume,
            m.source_store_id, m.source_node, m.deleted_at,
            a.balance, a.principal_total, a.principal_balance, a.gift_balance,
            a.dividend_balance, a.dividend_cumulative, a.dividend_capped, a.dividend_weight, a.points AS acc_points
       FROM members m JOIN member_accounts a ON a.member_id = m.id
      WHERE m.id = $1`, [memberId]);
  return m ?? null;
}

/** 总部侧：会员资产变动后发布镜像下行（全部门店） */
export async function publishMemberMirror(memberId: number): Promise<void> {
  const snap = await memberMirrorSnapshot(memberId);
  if (snap && snap.card_no) await publish('member_mirror', memberId, snap, 'all');
}

/* ═══════════════════════ 总部节点端点 ═══════════════════════ */

@Controller('hq/member')
@Public()
@UseGuards(NodeGuard)
export class HqMemberNodeController {

  /** 连锁建档（M5-3 前置：卡号总部生成，门店镜像同 card_no 落地） */
  @Post('register')
  async register(@Req() req: any, @Body() b: any) {
    const { storeId, nodeCode } = req.syncNode;
    if (!b?.phone && !b?.name) throw new BizException(40003, '手机号与姓名至少填一项');
    if (b.phone) {
      const dup = await q1(`SELECT id FROM members WHERE phone=$1 AND deleted_at IS NULL`, [String(b.phone)]);
      if (dup) throw new BizException(50050, '该手机号已注册');
    }
    const hqStore = Number((await q1<{ v: string }>(
      `SELECT COALESCE((SELECT value::text::int FROM system_settings WHERE setting_key='member.hq_store_id'),1) AS v`))?.v ?? 1);
    const m = await tx(async c => {
      const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM members`);
      const cardNo = `M${String(seq[0].n).padStart(6, '0')}`;
      const rows = await cx(c,
        `INSERT INTO members (store_id, card_no, phone, name, pinyin_code, gender, birthday,
                              password_hash, password_set_at, security_questions,
                              register_channel, privacy_agreed, source_store_id, source_node)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [hqStore, cardNo, b.phone ?? null, b.name ?? null, b.pinyinCode ?? null, b.gender ?? null,
         b.birthday ?? null, b.passwordHash ?? null, b.passwordHash ? new Date() : null,
         b.securityQuestions ? JSON.stringify(b.securityQuestions) : null,
         String(b.registerChannel ?? '连锁').slice(0, 16), !!b.privacyAgreed, storeId, String(nodeCode)]);
      await cx(c, `INSERT INTO member_accounts (member_id) VALUES ($1)`, [rows[0].id]);
      return rows[0];
    });
    await publishMemberMirror(Number(m.id));
    await audit(null, null, '会员', 'member.chain.register', 'member', Number(m.id),
      { cardNo: m.card_no, storeId, nodeCode });
    const { password_hash, security_questions, ...safe } = m;
    void password_hash; void security_questions;
    return { cardNo: m.card_no, member: safe };
  }

  /**
   * 资产扣款（M5-1/M5-2：余额 / 分红 / 积分）。
   * body: { cardNo, orderNo, asset:'balance'|'dividend'|'points', amount?, points?, refund? }
   * 幂等：idem_key = 节点:资产:方向:单号 → 重放直接返回原 ticket（绝不重复扣）。
   * 返回 { ticket, balanceAfter, principalPart, giftPart, pointsUsed }——ticket 随 sale_payments.external_no 留凭证。
   */
  @Post('debit')
  async debit(@Req() req: any, @Body() b: any) {
    const { storeId, nodeCode } = req.syncNode;
    const cardNo = String(b?.cardNo ?? '').trim();
    const orderNo = String(b?.orderNo ?? '').trim();
    const asset = String(b?.asset ?? '').trim();
    const refund = !!b?.refund;
    if (!cardNo || !orderNo) throw new BizException(40003, 'cardNo / orderNo 必填');
    if (!['balance', 'dividend', 'points'].includes(asset)) throw new BizException(40003, 'asset 必须是 balance/dividend/points');
    const amountCents = Math.round(Number(b?.amount ?? 0) * 100);
    const points = Math.round(Number(b?.points ?? 0));
    if (asset === 'points' ? !(points > 0) : !(amountCents > 0)) {
      throw new BizException(40003, asset === 'points' ? 'points 必须大于 0' : 'amount 必须大于 0');
    }
    const idemKey = `${nodeCode}:${asset}:${refund ? 'c' : 'd'}:${orderNo}`;
    const done = await q1<any>(`SELECT * FROM member_cross_store_flows WHERE idem_key=$1`, [idemKey]);
    if (done) {
      // 幂等重放：返回原凭证（ticket 恒定，门店重试不会重复扣款）
      return { ticket: done.txn_no, balanceAfter: Number(done.balance_after ?? 0),
               principalPart: Number(done.principal_part ?? 0), giftPart: Number(done.gift_part ?? 0),
               pointsUsed: Math.abs(Number(done.points ?? 0)), replay: true };
    }

    const out = await tx(async c => {
      const rows = await cx(c,
        `SELECT m.id AS member_id, m.points AS member_points, a.*
           FROM members m JOIN member_accounts a ON a.member_id = m.id
          WHERE m.card_no=$1 AND m.deleted_at IS NULL FOR UPDATE OF a`, [cardNo]);
      const acc = rows[0];
      if (!acc) throw new BizException(50072, `会员卡号 ${cardNo} 不存在（请先建档或核对卡号）`);
      const memberId = Number(acc.member_id);

      // ── V4.28.0 安全修复（审计 F-02）：防"凭空造币" ──
      //  ① 退款增发（refund=true）必须对得上本会员的原「连锁消费」出向流水，且金额/积分 ≤ 原消费；
      //  ② 单节点单日"入"向（退款/回补）总额受限（hq.member.cross_daily_limit，默认 20000 元）。
      if (refund) {
        const orig = await cx(c,
          `SELECT amount, points FROM member_cross_store_flows
            WHERE member_id=$1 AND ref_no=$2 AND asset=$3 AND direction='出' AND biz_type='连锁消费'
            ORDER BY id DESC LIMIT 1`, [memberId, orderNo, asset]);
        if (!orig.length) throw new BizException(40301, '无对应原「连锁消费」流水，禁止退款增发（须凭真实连锁消费单号）');
        const origC = Math.round(Number(orig[0].amount) * 100);
        if (asset !== 'points' && amountCents > origC) {
          throw new BizException(40301, `退款金额 ${amountCents / 100} 超过原消费金额 ${orig[0].amount}，已拦截`);
        }
        if (asset === 'points' && points > Number(orig[0].points || 0)) {
          throw new BizException(40301, `回补积分 ${points} 超过原消费积分 ${orig[0].points}，已拦截`);
        }
        const limRow = await cx(c,
          `SELECT COALESCE((SELECT value#>>'{}' FROM system_settings WHERE setting_key='hq.member.cross_daily_limit'),'20000') AS v`);
        const limC = Math.round(Number(limRow[0]?.v || 20000) * 100);
        const todaySum = await cx(c,
          `SELECT COALESCE(SUM(amount),0) AS s FROM member_cross_store_flows
            WHERE node_code=$1 AND direction='入' AND created_at::date=CURRENT_DATE`, [String(nodeCode)]);
        if (asset !== 'points' && Math.round(Number(todaySum[0].s) * 100) + amountCents > limC) {
          throw new BizException(40301, `本节点当日退款/回补累计 ${todaySum[0].s} 元已超上限（${limC / 100} 元），请联系总部核查`);
        }
      }

      let principalPart = 0, giftPart = 0, balanceAfter = 0, dir: string, bizType: string;

      if (asset === 'balance') {
        // 口径B 本金/赠送按比例拆分（与本地结账同式，按分）
        const totalBalC = Math.round(Number(acc.balance) * 100);
        const principalBalC = Math.round(Number(acc.principal_balance ?? acc.balance) * 100);
        if (totalBalC < amountCents) throw new BizException(50030, `会员余额不足（余额 ${acc.balance}）`);
        let principalCents = totalBalC > 0 ? Math.round(amountCents * principalBalC / totalBalC) : 0;
        if (principalCents > amountCents) principalCents = amountCents;
        if (principalCents > principalBalC) principalCents = principalBalC;
        const giftCents = amountCents - principalCents;
        const afterCents = refund ? totalBalC + amountCents : totalBalC - amountCents;
        principalPart = principalCents / 100; giftPart = giftCents / 100; balanceAfter = afterCents / 100;
        dir = refund ? '入' : '出'; bizType = refund ? '连锁退款' : '连锁消费';
        await cx(c,
          `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                      biz_type, ref_type, ref_no, balance_after)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'cross_flow',$8,$9)`,
          [storeId, memberId, dir, amountCents / 100, principalPart, giftPart, bizType, orderNo, balanceAfter]);
        await cx(c,
          `UPDATE member_accounts SET balance=$2, principal_balance = principal_balance ${refund ? '+' : '-'} $3,
                  gift_balance = gift_balance ${refund ? '+' : '-'} $4, updated_at=now() WHERE member_id=$1`,
          [memberId, balanceAfter, principalPart, giftPart]);
      } else if (asset === 'dividend') {
        const divBalC = Math.round(Number(acc.dividend_balance) * 100);
        if (!refund && divBalC < amountCents) throw new BizException(50033, `分红余额不足（余额 ${acc.dividend_balance}）`);
        const afterCents = refund ? divBalC + amountCents : divBalC - amountCents;
        balanceAfter = afterCents / 100;
        dir = refund ? '入' : '出'; bizType = refund ? '连锁退款' : '连锁消费';
        await cx(c,
          `INSERT INTO dividend_records (store_id, member_id, record_type, amount, ref_type, ref_no, balance_after)
           VALUES ($1,$2,$3,$4,'cross_flow',$5,$6)`,
          [storeId, memberId, refund ? '冲回' : '抵扣', amountCents / 100, orderNo, balanceAfter]);
        await cx(c,
          `UPDATE member_accounts SET dividend_balance=$2, updated_at=now() WHERE member_id=$1`,
          [memberId, balanceAfter]);
      } else {
        // points：refund=false 扣 / true 回补
        const cur = Number(acc.member_points ?? 0);
        if (!refund && cur < points) throw new BizException(50034, `积分不足（需 ${points} 分，可用 ${cur} 分）`);
        const after = refund ? cur + points : cur - points;
        balanceAfter = after; dir = refund ? '入' : '出'; bizType = refund ? '连锁退款' : '连锁消费';
        await cx(c, `UPDATE members SET points=$2, updated_at=now() WHERE id=$1`, [memberId, after]);
        await cx(c, `UPDATE member_accounts SET points=$2, updated_at=now() WHERE member_id=$1`, [memberId, after]);
        await cx(c,
          `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
           VALUES ($1,$2,$3,$4,'cross_flow',NULL,$5)`,
          [memberId, refund ? '加' : '减', points, refund ? '退款' : '兑换', after]);
      }

      const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM member_cross_store_flows`);
      const d = new Date();
      const txnNo = `MCF${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(seq[0].n).padStart(4, '0')}`;
      await cx(c,
        `INSERT INTO member_cross_store_flows (txn_no, store_id, node_code, member_id, asset, direction,
                    amount, points, principal_part, gift_part, balance_after, ref_no, biz_type, status, idem_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'done',$14)`,
        [txnNo, storeId, String(nodeCode), memberId, asset, dir,
         amountCents / 100, asset === 'points' ? points : 0, principalPart, giftPart, balanceAfter,
         orderNo, bizType, idemKey]);
      return { ticket: txnNo, balanceAfter, principalPart, giftPart, pointsUsed: asset === 'points' ? points : 0, memberId };
    });
    await publishMemberMirror(out.memberId);
    return { ticket: out.ticket, balanceAfter: out.balanceAfter, principalPart: out.principalPart,
             giftPart: out.giftPart, pointsUsed: out.pointsUsed };
  }

  /**
   * 资产回补（退货原路退，M5-4 配套）。
   * body: { cardNo, orderNo, refundNo, asset, amount?, points? }
   * 余额回补：按总部原「连锁消费」流水的本金/赠送比例拆回（与本地退货同式）。
   */
  @Post('credit')
  async credit(@Req() req: any, @Body() b: any) {
    const { storeId, nodeCode } = req.syncNode;
    const cardNo = String(b?.cardNo ?? '').trim();
    const refundNo = String(b?.refundNo ?? '').trim();
    const orderNo = String(b?.orderNo ?? '').trim();
    const asset = String(b?.asset ?? '').trim();
    if (!cardNo || !refundNo) throw new BizException(40003, 'cardNo / refundNo 必填');
    if (!['balance', 'dividend', 'points'].includes(asset)) throw new BizException(40003, 'asset 必须是 balance/dividend/points');
    const amountCents = Math.round(Number(b?.amount ?? 0) * 100);
    const points = Math.round(Number(b?.points ?? 0));
    const ratioGiven = b?.ratio != null && Number(b.ratio) > 0;
    if (asset === 'points' ? (!points && !ratioGiven) : !(amountCents > 0)) {
      throw new BizException(40003, asset === 'points' ? 'points 不能为 0（或缺退货比例 ratio）' : 'amount 必须大于 0');
    }
    const idemKey = `${nodeCode}:credit:${refundNo}:${asset}:${asset === 'points' ? (points || `r${Number(b.ratio)}`) : amountCents}`;
    const done = await q1(`SELECT 1 FROM member_cross_store_flows WHERE idem_key=$1`, [idemKey]);
    if (done) return { replay: true };

    const out = await tx(async c => {
      const rows = await cx(c,
        `SELECT m.id AS member_id, m.points AS member_points, a.*
           FROM members m JOIN member_accounts a ON a.member_id = m.id
          WHERE m.card_no=$1 AND m.deleted_at IS NULL FOR UPDATE OF a`, [cardNo]);
      const acc = rows[0];
      if (!acc) throw new BizException(50072, `会员卡号 ${cardNo} 不存在`);
      const memberId = Number(acc.member_id);
      let balanceAfter = 0;
      let pointsOut = 0;   // 积分实际回补/冲减数量（含按原流水推算）

      if (asset === 'balance') {
        const fl = await cx(c,
          `SELECT amount, principal_part, gift_part FROM balance_flows
            WHERE member_id=$1 AND ref_no=$2 AND direction='出' AND biz_type='连锁消费'
            ORDER BY id LIMIT 1`, [memberId, orderNo]);
        // V4.28.0 安全修复（F-02）：必须存在原「连锁消费」流水且回补金额 ≤ 原消费额
        if (!fl.length) throw new BizException(40301, '无对应原「连锁消费」流水，禁止余额回补');
        const amtC = Math.round(Number(fl[0].amount) * 100);
        if (amountCents > amtC) throw new BizException(40301, `回补金额 ${amountCents / 100} 超过原消费金额 ${fl[0].amount}，已拦截`);
        const principalCents = amtC > 0 ? Math.round(amountCents * Math.round(Number(fl[0].principal_part) * 100) / amtC) : 0;
        const giftCents = amountCents - principalCents;
        const totalBalC = Math.round(Number(acc.balance) * 100) + amountCents;
        balanceAfter = totalBalC / 100;
        await cx(c,
          `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                      biz_type, ref_type, ref_no, balance_after)
           VALUES ($1,$2,'入',$3,$4,$5,'连锁退款','cross_flow',$6,$7)`,
          [storeId, memberId, amountCents / 100, principalCents / 100, giftCents / 100, refundNo, balanceAfter]);
        await cx(c,
          `UPDATE member_accounts SET balance = balance + $2,
                  principal_balance = principal_balance + $3, gift_balance = gift_balance + $4, updated_at=now()
            WHERE member_id=$1`, [memberId, amountCents / 100, principalCents / 100, giftCents / 100]);
      } else if (asset === 'dividend') {
        // V4.28.0：分红回补同样必须有原「连锁消费」出向流水，且 ≤ 原抵扣额
        const origD = await cx(c,
          `SELECT amount FROM member_cross_store_flows
            WHERE member_id=$1 AND ref_no=$2 AND asset='dividend' AND direction='出' AND biz_type='连锁消费'
            ORDER BY id DESC LIMIT 1`, [memberId, orderNo]);
        if (!origD.length) throw new BizException(40301, '无对应原「连锁消费」分红流水，禁止回补');
        if (amountCents > Math.round(Number(origD[0].amount) * 100)) {
          throw new BizException(40301, `回补金额 ${amountCents / 100} 超过原抵扣金额 ${origD[0].amount}，已拦截`);
        }
        const afterCents = Math.round(Number(acc.dividend_balance) * 100) + amountCents;
        balanceAfter = afterCents / 100;
        await cx(c,
          `INSERT INTO dividend_records (store_id, member_id, record_type, amount, ref_type, ref_no, balance_after)
           VALUES ($1,$2,'冲回',$3,'cross_flow',$4,$5)`,
          [storeId, memberId, amountCents / 100, refundNo, balanceAfter]);
        await cx(c, `UPDATE member_accounts SET dividend_balance=$2, updated_at=now() WHERE member_id=$1`,
          [memberId, balanceAfter]);
      } else {
        // points 正=回补(加) / 负=冲减(减)；未给 points 时按原「连锁消费」流水 × ratio 推算（退货场景）
        let pts = points;
        if (!pts) {
          if (b?.ratio == null || !orderNo) return { skipped: true };   // 推不出 → 跳过（不落流水不阻断）
          const fl = await cx(c,
            `SELECT points FROM member_cross_store_flows
              WHERE member_id=$1 AND ref_no=$2 AND asset='points' AND direction='出' AND biz_type='连锁消费'
              ORDER BY id LIMIT 1`, [memberId, orderNo]);
          pts = fl[0] ? Math.floor(Number(fl[0].points) * Number(b.ratio)) : 0;
          if (!pts) return { skipped: true };
        }
        const add = pts > 0;
        const qty = Math.abs(pts);
        pointsOut = qty;
        const after = Number(acc.member_points ?? 0) + pts;
        balanceAfter = after;
        await cx(c, `UPDATE members SET points=$2, updated_at=now() WHERE id=$1`, [memberId, after]);
        await cx(c, `UPDATE member_accounts SET points=$2, updated_at=now() WHERE member_id=$1`, [memberId, after]);
        await cx(c,
          `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
           VALUES ($1,$2,$3,'退款','cross_flow',NULL,$4)`, [memberId, add ? '加' : '减', qty, after]);
      }

      const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM member_cross_store_flows`);
      const d = new Date();
      const txnNo = `MCF${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(seq[0].n).padStart(4, '0')}`;
      await cx(c,
        `INSERT INTO member_cross_store_flows (txn_no, store_id, node_code, member_id, asset, direction,
                    amount, points, balance_after, ref_no, biz_type, status, idem_key)
         VALUES ($1,$2,$3,$4,$5,'入',$6,$7,$8,$9,'连锁退款','done',$10)`,
        [txnNo, storeId, String(nodeCode), memberId, asset,
         asset === 'points' ? 0 : amountCents / 100, asset === 'points' ? pointsOut : 0,
         balanceAfter, refundNo, idemKey]);
      return { ticket: txnNo, balanceAfter, pointsOut, memberId };
    });
    await publishMemberMirror(out.memberId);
    return { ticket: out.ticket, balanceAfter: out.balanceAfter };
  }

  /** 积分调整（M5-2：总部运营/营销正加负减；refNo 作幂等键） */
  @Post('points')
  async pointsAdjust(@Req() req: any, @Body() b: any) {
    const { storeId, nodeCode } = req.syncNode;
    const cardNo = String(b?.cardNo ?? '').trim();
    const pts = Math.round(Number(b?.points ?? 0));
    const refNo = String(b?.refNo ?? '').trim();
    const reason = String(b?.reason ?? '总部调整').slice(0, 16);
    if (!cardNo || !pts || !refNo) throw new BizException(40003, 'cardNo / points(非0) / refNo 必填');
    const idemKey = `${nodeCode}:pointsadj:${refNo}`;
    const done = await q1(`SELECT 1 FROM member_cross_store_flows WHERE idem_key=$1`, [idemKey]);
    if (done) return { replay: true };
    const out = await tx(async c => {
      const rows = await cx(c,
        `SELECT m.id AS member_id, m.points AS member_points, a.balance
           FROM members m JOIN member_accounts a ON a.member_id = m.id
          WHERE m.card_no=$1 AND m.deleted_at IS NULL FOR UPDATE OF a`, [cardNo]);
      const acc = rows[0];
      if (!acc) throw new BizException(50072, `会员卡号 ${cardNo} 不存在`);
      const memberId = Number(acc.member_id);
      const cur = Number(acc.member_points ?? 0);
      if (pts < 0 && cur < -pts) throw new BizException(50034, `积分不足（需减 ${-pts}，可用 ${cur}）`);
      const after = cur + pts;
      await cx(c, `UPDATE members SET points=$2, updated_at=now() WHERE id=$1`, [memberId, after]);
      await cx(c, `UPDATE member_accounts SET points=$2, updated_at=now() WHERE member_id=$1`, [memberId, after]);
      await cx(c,
        `INSERT INTO points_flows (member_id, direction, points, biz_type, ref_type, ref_id, balance_after)
         VALUES ($1,$2,$3,'调整','cross_flow',NULL,$4)`, [memberId, pts > 0 ? '加' : '减', Math.abs(pts), after]);
      const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM member_cross_store_flows`);
      const d = new Date();
      const txnNo = `MCF${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(seq[0].n).padStart(4, '0')}`;
      await cx(c,
        `INSERT INTO member_cross_store_flows (txn_no, store_id, node_code, member_id, asset, direction,
                    amount, points, balance_after, ref_no, biz_type, status, idem_key)
         VALUES ($1,$2,$3,$4,'points',$5,0,$6,$7,$8,'调整','done',$9)`,
        [txnNo, storeId, String(nodeCode), memberId, pts > 0 ? '入' : '出', Math.abs(pts), after, refNo, idemKey]);
      return { ticket: txnNo, pointsAfter: after, memberId };
    });
    await publishMemberMirror(out.memberId);
    return { ticket: out.ticket, pointsAfter: out.pointsAfter };
  }

  /** 实时查档（收银台余额展示校准；key = 卡号或手机号精确匹配）。
   *  V4.28.0 安全修复（F-02）：手机号脱敏下发（支持按尾号核对，不再回传完整 PII） */
  @Get('lookup')
  async lookup(@Query('key') key: string) {
    const k = String(key ?? '').trim();
    if (!k) throw new BizException(40003, '缺少查询关键字');
    const m = await q1<any>(
      `SELECT m.id, m.card_no,
              CASE WHEN m.phone IS NULL OR m.phone='' THEN '' ELSE LEFT(m.phone,3)||'****'||RIGHT(m.phone,4) END AS phone,
              m.name, m.level_id, m.points, m.status,
              m.last_active_date, m.total_consume,
              a.balance, a.principal_balance, a.gift_balance, a.dividend_balance,
              COALESCE(l.name, '普通会员') AS level_name
         FROM members m JOIN member_accounts a ON a.member_id = m.id
         LEFT JOIN member_levels l ON l.id = m.level_id
        WHERE (m.card_no=$1 OR m.phone=$1) AND m.deleted_at IS NULL LIMIT 1`, [k]);
    if (!m) throw new BizException(50072, '会员不存在');
    return m;
  }
}

/* ═══════════════════════ 后台（JWT · hq.member.crossview） ═══════════════════════ */

@Controller('hq/member')
export class HqMemberAdminController {

  /** 跨店资产流水（§5.2.4：涉商业敏感，默认不给门店；红涨绿跌在前端处理） */
  @RequirePerms('hq.member.crossview')
  @Get('flows')
  async flows(@Query('from') from: string, @Query('to') to: string,
              @Query('storeId') storeId: string, @Query('keyword') keyword: string,
              @Query('asset') asset: string) {
    const where: string[] = [];
    const params: any[] = [];
    const date = (v: string, def: number) => {
      const ms = v ? new Date(v).getTime() : Date.now() - def;
      return new Date(ms).toISOString().slice(0, 10);
    };
    params.push(date(from, 30 * 86400_000)); where.push(`f.biz_ts::date >= $${params.length}`);
    params.push(date(to, 0));               where.push(`f.biz_ts::date <= $${params.length}`);
    if (storeId) { params.push(Number(storeId)); where.push(`f.store_id = $${params.length}`); }
    if (asset && ['balance', 'dividend', 'points'].includes(String(asset))) {
      params.push(String(asset)); where.push(`f.asset = $${params.length}`);
    }
    if (keyword?.trim()) {
      params.push(`%${keyword.trim()}%`);
      where.push(`(m.card_no ILIKE $${params.length} OR m.phone ILIKE $${params.length} OR m.name ILIKE $${params.length})`);
    }
    const rows = await q<any>(
      `SELECT f.id, f.txn_no, f.store_id, s.name AS store_name, f.node_code, f.asset, f.direction,
              f.amount, f.points, f.principal_part, f.gift_part, f.balance_after, f.ref_no, f.biz_type,
              f.status, f.biz_ts,
              m.card_no, m.phone, m.name AS member_name
         FROM member_cross_store_flows f
         JOIN members m ON m.id = f.member_id
         LEFT JOIN stores s ON s.id = f.store_id
        WHERE ${where.join(' AND ')}
        ORDER BY f.id DESC LIMIT 500`, params);
    const sum = await q1<any>(
      `SELECT COALESCE(SUM(CASE WHEN f.asset='balance' AND f.direction='出' THEN f.amount ELSE 0 END),0) AS balance_out,
              COALESCE(SUM(CASE WHEN f.asset='balance' AND f.direction='入' THEN f.amount ELSE 0 END),0) AS balance_in,
              COUNT(*) FILTER (WHERE f.status <> 'done') AS pending
         FROM member_cross_store_flows f JOIN members m ON m.id = f.member_id
        WHERE ${where.join(' AND ')}`, params);
    return { items: rows, sum: { balanceOut: Number(sum?.balance_out ?? 0), balanceIn: Number(sum?.balance_in ?? 0), pending: Number(sum?.pending ?? 0) } };
  }
}

/* ═══════════════════════ P2-1：断网余额挂账（方案 §3.5.4，设置键 member.offline.*） ═══════════════════════ */

/** 总部不可达错误码（nodeReq 网络失败专用）——调用方据此区分「网络挂账」与「业务拒绝」 */
export const HQ_UNREACHABLE_CODE = 50071;

async function offlineSettingNum(key: string, def: number): Promise<number> {
  const r = await q1<any>(
    `SELECT COALESCE((SELECT (value)::text::numeric FROM system_settings WHERE setting_key=$1), $2) AS v`,
    [key, def]);
  return Number(r?.v ?? def);
}

async function offlineEnabled(): Promise<boolean> {
  const r = await q1<any>(
    `SELECT (value)::text AS v FROM system_settings WHERE setting_key='member.offline.enabled'`);
  return String(r?.v ?? 'false') === 'true';
}

/**
 * 离线余额挂账放行（sales 余额通道在总部不可达时调用）：
 *   开关 member.offline.enabled（默认关）+ 单笔限额 max_single + 日累计限额 max_daily；
 *   记 member_offline_credits（status=pending），返回 OFF 凭证随 sale_payments.external_no 留痕；
 *   恢复联网后 settleOfflineCredits() 逐笔调总部幂等 debit 清算；余额不足 → rejected（留人工）。
 * 超限/开关关 → 抛 50071 原错误（收银员改用其他支付方式，与 P1 行为一致）。
 */
export async function offlineBalanceCredit(
  c: any,
  args: { storeId: number; memberId: number; cardNo: string; orderNo: string; amountCents: number; nodeCode?: string },
): Promise<{ ticket: string }> {
  const enabled = await offlineEnabled();
  if (!enabled) throw new BizException(HQ_UNREACHABLE_CODE, '总部不可达且未开启断网余额挂账（可改用其他支付方式继续结账）');
  const amount = args.amountCents / 100;
  const maxSingle = await offlineSettingNum('member.offline.max_single', 100);
  if (amount > maxSingle) {
    throw new BizException(50073, `总部不可达：本笔 ${amount} 元超出断网挂账单笔限额 ${maxSingle} 元，请改用其他支付方式`);
  }
  const maxDaily = await offlineSettingNum('member.offline.max_daily', 500);
  const daySum = await cx(c,
    `SELECT COALESCE(SUM(amount),0) AS s FROM member_offline_credits
      WHERE store_id=$1 AND status IN ('pending','settled') AND created_at::date = CURRENT_DATE`,
    [args.storeId]);
  if (Number(daySum[0]?.s ?? 0) + amount > maxDaily) {
    throw new BizException(50073, `总部不可达：当日挂账累计已超出限额 ${maxDaily} 元，请改用其他支付方式`);
  }
  const rows = await cx(c,
    `INSERT INTO member_offline_credits (store_id, member_id, card_no, ref_no, amount, node_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
    [args.storeId, args.memberId, args.cardNo, args.orderNo, amount, args.nodeCode ?? null]);
  return { ticket: `OFF-${rows[0].id}` };
}

/**
 * 挂账清算（门店侧；sync-store tick 网络恢复后调用，fire-and-forget）：
 *   pending 挂账逐笔调总部 /hq/member/debit（幂等 orderNo=ref_no，重试绝不重复扣）；
 *   成功 → settled（记总部 MCF 凭证）；余额不足等业务拒绝 → rejected（留人工处理）；
 *   总部仍不可达/本节点未配置 → 中断本轮，下轮再试。
 * @param hqCall 可注入的总部调用器（冒烟测试用）；生产默认 hqMemberPost
 */
export async function settleOfflineCredits(
  hqCall: (path: string, body: unknown) => Promise<any> = hqMemberPost,
): Promise<{ settled: number; rejected: number }> {
  const rows = await q<any>(
    `SELECT id, member_id, card_no, ref_no, amount FROM member_offline_credits
      WHERE status='pending' ORDER BY id LIMIT 50`);
  if (!rows.length) return { settled: 0, rejected: 0 };
  let settled = 0, rejected = 0;
  for (const r of rows) {
    try {
      const d = await hqCall('debit', {
        cardNo: r.card_no, orderNo: r.ref_no, asset: 'balance', amount: Number(r.amount),
      });
      await q(
        `UPDATE member_offline_credits SET status='settled', settled_at=now(), settled_txn=$2,
                balance_after=$3 WHERE id=$1 AND status='pending'`,
        [r.id, String(d.ticket ?? ''), Number(d.balanceAfter ?? 0)]);
      settled++;
    } catch (e: any) {
      const code = Number(e?.bizCode);
      if (code === HQ_UNREACHABLE_CODE || code === 50070) break;   // 总部不可达/未配置 → 本轮终止，下轮再试
      await q(
        `UPDATE member_offline_credits SET status='rejected', settled_at=now(), remark=$2
          WHERE id=$1 AND status='pending'`,
        [r.id, String(e?.message ?? e).slice(0, 200)]);
      rejected++;
    }
  }
  return { settled, rejected };
}

/* ═══════════════════════ P2-2：拒付挂账补付（门店侧，老板 2026-09-18 拍板口径） ═══════════════════════ */

/**
 * 口径定版：挂账清算被总部拒付（会员余额不足）→ 门店向会员收取 现金/微信/支付宝 结清该笔，
 * 总部【不再】扣会员余额（支付通道由「余额」改为现场收款）；rejected → settled，留 OFFPAY-{id} 凭证。
 * 仅 rejected 可补付 —— pending 等待自动清算，settled 已结清，均拒绝（防双重结清/双收钱）。
 */
@Controller('member-offline-credits')   // ⚠️ 不能用 members/ 前缀：MembersController 的 GET :id(ParseIntPipe) 会抢占
export class OfflineCreditAdminController {

  /** 挂账台账（门店本地表；含待清算/已结清/已拒付，供收银主管处理拒付补付） */
  @RequirePerms('member.balance.recharge')
  @Get()
  async list(@Query('status') status: string, @Query('days') days: string) {
    const d = Math.min(Math.max(1, Number(days ?? 30)), 366);
    const where: string[] = [`o.created_at >= now() - ($1 || ' days')::interval`];   // ⚠️ JOIN members 后 created_at 必须表别名限定
    const params: any[] = [String(d)];
    if (status && ['pending', 'settled', 'rejected'].includes(String(status))) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    const rows = await q<any>(
      `SELECT o.id, o.card_no, o.ref_no, o.amount, o.status, o.settle_channel, o.settled_txn,
              o.balance_after, o.remark, o.created_at, o.settled_at,
              m.name AS member_name, m.phone
         FROM member_offline_credits o
         LEFT JOIN members m ON m.id = o.member_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.id DESC LIMIT 200`, params);
    const sum = await q1<any>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status='pending'),0)  AS pending_amt,
              COUNT(*) FILTER (WHERE status='pending')                AS pending_cnt,
              COALESCE(SUM(amount) FILTER (WHERE status='rejected'),0) AS rejected_amt,
              COUNT(*) FILTER (WHERE status='rejected')               AS rejected_cnt
         FROM member_offline_credits WHERE created_at >= now() - ($1 || ' days')::interval`, [String(d)]);
    return {
      items: rows,
      sum: { pendingAmt: Number(sum?.pending_amt ?? 0), pendingCnt: Number(sum?.pending_cnt ?? 0),
             rejectedAmt: Number(sum?.rejected_amt ?? 0), rejectedCnt: Number(sum?.rejected_cnt ?? 0) },
    };
  }

  /** 拒付补付结清：channel = 现金/微信/支付宝（幂等：非 rejected 一律拒绝） */
  @RequirePerms('member.balance.recharge')
  @Post('pay')
  async pay(@CurrentUser() user: AuthUser, @Body() b: any) {
    const id = Number(b?.id ?? 0);
    const channel = String(b?.channel ?? '').trim();
    if (!id || !['现金', '微信', '支付宝'].includes(channel)) {
      throw new BizException(40003, 'id 与补付通道（现金/微信/支付宝）必填');
    }
    const upd = await q<any>(
      `UPDATE member_offline_credits
          SET status='settled', settle_channel=$2, settled_at=now(), settled_txn='OFFPAY-'||$1::text,
              remark = COALESCE(remark,'') || $3
        WHERE id=$1 AND status='rejected'
        RETURNING id, card_no, ref_no, amount`, [id, channel,
          `；拒付补付（${channel}）操作人:${user?.name ?? user?.sub ?? ''}`.slice(0, 60)]);
    if (!upd[0]) {
      const cur = await q1<any>(`SELECT status FROM member_offline_credits WHERE id=$1`, [id]);
      throw new BizException(40903, cur ? `该挂账状态为「${cur.status}」，仅拒付（rejected）挂账可补付结清` : '挂账记录不存在');
    }
    await audit(user?.storeId ?? null, user?.sub, '会员', 'member.offline.pay', 'member_offline_credit', id,
      { channel, refNo: upd[0].ref_no, amount: Number(upd[0].amount) });
    return { ok: true, ticket: `OFFPAY-${id}`, channel, refNo: upd[0].ref_no, amount: Number(upd[0].amount) };
  }
}

@Module({
  controllers: [HqMemberNodeController, HqMemberAdminController, OfflineCreditAdminController],
})
export class MemberChainModule {}
