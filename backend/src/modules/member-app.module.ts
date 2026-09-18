import { Module, Controller, Post, Get, Put, Delete, Body, Param, Query, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { q, q1, tx, cx, audit } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { allow, failAndLock, lockedFor, clearFailures, clientIp } from '../common/ratelimit';
import { BizException } from '../common/http';
import { Public, JWT_SECRET } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { MemberGuard, MemberPublic, CurrentMember, MemberUser } from '../common/member-auth';
import { checkPasswordPolicy, passwordPolicyLabel } from '../common/password-policy';
import { SettingsService } from './settings.module';
import { SalesService } from './sales.module';
import { RefundService } from './refund.module';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价：会员端/H5 看价按门店
import { PRODUCT_VISIBLE } from '../common/sql';       // V5.0.0 商品可售可见性
import { AntileakService } from './ai.antileak';
import { isChainStoreNode, hqMemberPost } from './member-chain.module'; // V5.0.0 批次5：连锁建档卡号由总部生成

/**
 * 会员 H5/小程序 自助端点（5.12 会员自助）：
 *   与员工端完全隔离：全部 @Public 绕过全局员工 AuthGuard，
 *   由 MemberGuard 校验 kind='member' 的独立 JWT。
 *   密码 bcryptjs（与员工一致）；连错 5 次锁 30 分（V4.6.6）；
 *   老会员（到店建档无密码）凭 手机号+身份证后6位 首次设密。
 */

const LOCK_MINUTES = 30;
const LOCK_FAILS = 5;

function memberToken(m: any): string {
  return jwt.sign(
    { sub: Number(m.id), kind: 'member' as const, storeId: Number(m.store_id), phone: m.phone ?? '', name: m.name ?? null },
    JWT_SECRET, { expiresIn: '12h' });
}

@Controller('m')
@Public()               // 绕过全局员工 AuthGuard（会员端独立鉴权）
@UseGuards(MemberGuard) // 会员端守卫：校验 kind='member' 的 JWT；@MemberPublic 端点免登录
export class MemberAppController {

  /** V4.14.6 R8：当前密码强度策略文案（公开，注册/设密/找回页动态提示用） */
  @MemberPublic()
  @Get('password-policy')
  async getPwdPolicy() {
    return { label: await passwordPolicyLabel() };
  }

  /** 注册（H5 渠道建档，自动生成卡号与账户） */
  @MemberPublic()
  @Post('register')
  async register(@Body() b: { phone?: string; password?: string; name?: string; privacyAgreed?: boolean;
                              birthday?: string; securityQuestions?: { question: string; answer: string }[] }) {
    if (!b.phone || !/^1\d{10}$/.test(b.phone)) throw new BizException(40003, '手机号格式错误');
    await checkPasswordPolicy(String(b.password || '')); // V4.14.6 R8：与员工端同策略
    if (!b.privacyAgreed) throw new BizException(40003, '需勾选隐私协议（个保法）');
    const dup = await q1(`SELECT id FROM members WHERE phone=$1 AND deleted_at IS NULL`, [b.phone]);
    if (dup) throw new BizException(42012, '该手机号已注册');
    const hash = bcrypt.hashSync(b.password, 10);
    // V4.14.0 M2：密保问题答案 bcrypt 哈希不落明文；至少 2 问 2 答
    const secQs = (b.securityQuestions || [])
      .filter(x => x?.question?.trim() && x?.answer?.trim())
      .map(x => ({ question: x.question.trim(), answerHash: bcrypt.hashSync(x.answer.trim(), 10) }));
    if (secQs.length === 1) throw new BizException(40003, '密保问题至少设置 2 问 2 答（用于忘记密码找回）');
    // ── V5.0.0 批次5（R3）：连锁门店节点 → 卡号由总部生成；密码哈希/密保随建档上行（H5 本地登录可用），
    //    本地落同卡号镜像（含密码哈希），token 用本地镜像 id 签发。
    if (await isChainStoreNode()) {
      const created = await hqMemberPost('register', {
        phone: b.phone, name: b.name ?? null, birthday: b.birthday ?? null,
        passwordHash: hash, securityQuestions: secQs.length ? secQs : null,
        registerChannel: 'H5', privacyAgreed: true,
      });
      const m = await tx(async c => {
        const dup2 = await cx(c, `SELECT id FROM members WHERE card_no=$1`, [created.cardNo]);
        if (dup2[0]) return dup2[0];
        const rows = await cx(c,
          `INSERT INTO members (store_id, card_no, phone, name, password_hash, password_set_at,
                                security_questions, register_channel, privacy_agreed, birthday,
                                source_store_id, source_node)
           VALUES ((SELECT COALESCE(MAX(id),1) FROM stores),$1,$2,$3,$4,now(),$5,'H5',true,$6,$7,$8)
           RETURNING *`,
          [created.cardNo, b.phone, b.name ?? null, hash,
           secQs.length ? JSON.stringify(secQs) : null, b.birthday ?? null,
           created.member?.source_store_id ?? null, created.member?.source_node ?? null]);
        await cx(c, `INSERT INTO member_accounts (member_id) VALUES ($1)`, [rows[0].id]);
        return rows[0];
      });
      await audit(curStore(), null, '会员', 'member.h5.register', 'member', Number(m.id), { cardNo: created.cardNo, channel: 'H5', chain: true });
      return { token: memberToken(m), member: { id: Number(m.id), cardNo: created.cardNo, name: b.name ?? null, phone: b.phone } };
    }
    const m = await tx(async c => {
      const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM members`);
      const cardNo = `M${String(seq[0].n).padStart(6, '0')}`;
      const rows = await cx(c,
        `INSERT INTO members (store_id, card_no, phone, name, password_hash, password_set_at,
                              register_channel, privacy_agreed, birthday, security_questions)
         VALUES (${await new SettingsService().getNum('member.hq_store_id', 1)},$1,$2,$3,$4,now(),'H5',true,$5,$6) RETURNING *`,
        [cardNo, b.phone, b.name ?? null, hash, b.birthday ?? null,
         secQs.length ? JSON.stringify(secQs) : null]);
      await cx(c, `INSERT INTO member_accounts (member_id) VALUES ($1)`, [rows[0].id]);
      return rows[0];
    });
    await audit(curStore(), null, '会员', 'member.h5.register', 'member', Number(m.id), { cardNo: m.card_no, channel: 'H5' });
    return { token: memberToken(m), member: { id: Number(m.id), cardNo: m.card_no, name: m.name, phone: m.phone } };
  }

  /** 登录（手机号+密码；连错 5 次锁 30 分） */
  @MemberPublic()
  @Post('login')
  async login(@Body() b: { phone?: string; password?: string }) {
    if (!b.phone || !b.password) throw new BizException(40003, '手机号与密码必填');
    const m = await q1<any>(
      `SELECT m.*, a.balance FROM members m JOIN member_accounts a ON a.member_id=m.id
        WHERE m.phone=$1 AND m.deleted_at IS NULL`, [b.phone]);
    if (!m) throw new BizException(42010, '手机号或密码错误');
    if (m.locked_until && new Date(m.locked_until) > new Date())
      throw new BizException(42011, `密码连续错误已锁定，请 ${LOCK_MINUTES} 分钟后再试`);
    if (!m.password_hash) throw new BizException(42013, '该会员尚未设置密码，请使用「首次设密」');
    if (m.status !== '正常') throw new BizException(42010, `账户状态异常：${m.status}`);
    if (!bcrypt.compareSync(b.password, m.password_hash)) {
      const fails = Number(m.login_fail_count) + 1;
      if (fails >= LOCK_FAILS) {
        await q(`UPDATE members SET login_fail_count=$2, locked_until=now()+interval '${LOCK_MINUTES} minutes' WHERE id=$1`, [m.id, fails]);
        throw new BizException(42011, `密码连续错误 ${LOCK_FAILS} 次，账户锁定 ${LOCK_MINUTES} 分钟`);
      }
      await q(`UPDATE members SET login_fail_count=$2 WHERE id=$1`, [m.id, fails]);
      throw new BizException(42010, '手机号或密码错误');
    }
    await q(`UPDATE members SET login_fail_count=0, locked_until=NULL, last_active_date=COALESCE(last_active_date, CURRENT_DATE) WHERE id=$1`, [m.id]);
    return { token: memberToken(m), member: { id: Number(m.id), cardNo: m.card_no, name: m.name, phone: m.phone } };
  }

  /** 老会员首次设密（到店建档无密码：手机号+身份证后6位核对）
   *  P1-H4 防爆破：身份证后6位仅 10⁶ 空间——手机号维度连错 5 次锁 30 分钟 + IP 频控 */
  @MemberPublic()
  @Post('password/init')
  async initPassword(@Body() b: { phone?: string; idCardTail?: string; password?: string }, @Req() req: any) {
    if (!b.phone || !b.idCardTail || !b.password) throw new BizException(40003, '手机号/身份证后6位/新密码必填');
    if (b.password.length < 6) throw new BizException(42014, '密码至少 6 位');
    const phone = String(b.phone).trim();
    if (lockedFor('m-init:' + phone) > 0) throw new BizException(42901, '身份证号后6位错误次数过多，请 30 分钟后重试或到店办理', 429);
    if (!allow('m-init-ip:' + clientIp(req), 15, 10 * 60_000)) throw new BizException(42902, '本设备操作过于频繁，请稍后再试', 429);
    const m = await q1<any>(`SELECT * FROM members WHERE phone=$1 AND deleted_at IS NULL`, [phone]);
    if (!m) throw new BizException(42010, '会员不存在');
    if (m.password_hash) throw new BizException(42013, '已设置过密码，请直接登录或到店找回');
    if (!m.id_card_tail || m.id_card_tail !== b.idCardTail.toUpperCase()) {
      failAndLock('m-init:' + phone, 5, 30 * 60_000);
      throw new BizException(42015, '身份证后6位不符');
    }
    clearFailures('m-init:' + phone);
    await q(`UPDATE members SET password_hash=$2, password_set_at=now(), login_fail_count=0, locked_until=NULL WHERE id=$1`,
      [m.id, bcrypt.hashSync(b.password, 10)]);
    await audit(Number(m.store_id), null, '会员', 'member.h5.password.init', 'member', Number(m.id));
    return { ok: true };
  }

  /** 资产总览：余额（本金/赠送拆分 口径B）+积分+分红账户+等级+有效消费状态 */
  @Get('me')
  async me(@CurrentMember() u: MemberUser) {
    const rows = await q(
      `SELECT m.id, m.card_no, m.phone, m.name, m.points, m.status, m.last_active_date, m.invalid_at,
              l.name AS level_name, l.discount,
              a.balance, a.principal_total, a.points AS account_points,
              a.dividend_balance, a.dividend_cumulative, a.dividend_capped, a.dividend_weight
         FROM members m
         LEFT JOIN member_levels l ON l.id = m.level_id
         JOIN member_accounts a ON a.member_id = m.id
        WHERE m.id=$1`, [u.sub]);
    const m = rows[0];
    if (!m) throw new BizException(42010, '会员不存在', 404);
    return {
      member: {
        id: Number(m.id), cardNo: m.card_no, name: m.name, phone: m.phone, status: m.status,
        level: m.level_name || '普通会员', discount: m.discount ? Number(m.discount) : null,
        lastActiveDate: m.last_active_date, invalidAt: m.invalid_at,
      },
      assets: {
        balance: Number(m.balance),
        principalTotal: Number(m.principal_total),          // 口径B：累计充值本金
        giftBalance: r2(Number(m.balance) - Number(m.principal_total) > 0 ? Number(m.balance) - Number(m.principal_total) : 0),
        points: Number(m.points),
        dividendBalance: Number(m.dividend_balance),
        dividendCumulative: Number(m.dividend_cumulative),
        dividendCapped: m.dividend_capped,
        dividendWeight: Number(m.dividend_weight),
      },
    };
  }

  /** 流水：tab = balance 余额 / points 积分 / dividend 分红 */
  @Get('flows')
  async flows(@CurrentMember() u: MemberUser, @Query('tab') tab = 'balance', @Query('limit') limit = '20') {
    const n = Math.min(Number(limit) || 20, 100);
    if (tab === 'points') {
      return { tab, items: (await q(
        `SELECT id, direction, points, biz_type, ref_type, ref_id, balance_after, created_at
           FROM points_flows WHERE member_id=$1 ORDER BY id DESC LIMIT ${n}`, [u.sub])) };
    }
    if (tab === 'dividend') {
      return { tab, items: (await q(
        `SELECT id, record_type, amount, expire_at, ref_type, ref_id, remark, created_at
           FROM dividend_records WHERE member_id=$1 ORDER BY id DESC LIMIT ${n}`, [u.sub])) };
    }
    return { tab: 'balance', items: (await q(
      `SELECT id, direction, amount, principal_part, gift_part, biz_type, ref_type, ref_id, balance_after, remark, created_at
         FROM balance_flows WHERE member_id=$1 ORDER BY id DESC LIMIT ${n}`, [u.sub])) };
  }

  /** 本人消费记录（脱敏：不含成本/毛利） */
  @Get('sales')
  async sales(@CurrentMember() u: MemberUser) {
    const rows = await q(
      `SELECT id, order_no, channel, goods_amount, promo_amount, coupon_amount, payable_amount,
              round_amount, status, created_at
         FROM sales_orders WHERE member_id=$1 ORDER BY id DESC LIMIT 20`, [u.sub]);
    return { items: rows.map(o => ({ ...o, id: Number(o.id) })) };
  }

  // ═══════════ 顾客扫码购（6.4.2 自助收银：扫条码加清单 → 余额自助结算 → 离场核销码） ═══════════

  /** 商品检索（条码精确优先，名称/条码模糊兜底；仅返回收银三要素，不含库存/成本） */
  @Get('pricebook')
  async pricebook(@CurrentMember() u: MemberUser, @Query('kw') kw?: string) {
    const k = (kw || '').trim();
    const items = await q(
      `SELECT p.id, p.barcode, p.name, p.spec, p.base_unit AS "baseUnit",
              p.sell_price::float8 AS "sellPrice",
              CASE WHEN COALESCE(p.member_discount,0) > 0 THEN p.member_price::float8 ELSE NULL END AS "memberPrice",
              p.is_weighted AS "isWeighted",
              p.status, p.track_inventory AS "trackInventory"
         FROM products p
        WHERE ${PRODUCT_VISIBLE('$1')} AND p.deleted_at IS NULL
          AND ($2='' OR p.barcode=$2 OR p.name ILIKE '%'||$2||'%' OR p.barcode ILIKE '%'||$2||'%')
        ORDER BY (p.barcode=$2) DESC, p.id LIMIT 30`, [u.storeId, k]);
    await storePrice.overlay(u.storeId, items);   // V4.26.5 会员端查价按门店
    return { items };
  }

  /** 自助结算：复用收银核心 checkout（余额自动付清、无收银员归属），成功后下发 6 位离场核销码
   *  V4.13 漏扫检测 MVP 挂接：aiItems（AI 识别逐件数）/ weightKg（实秤重量）可选传入；
   *  开关 antileak.selfcheckout.enabled 开启时，件数/重量差异即 41001 暂停待店员复核，
   *  force=true 可强推但必落 antileak_alerts「待复核」（老板端防损可见） */
  @Post('self-checkout')
  async selfCheckout(
    @CurrentMember() u: MemberUser,
    @Body() b: {
      items?: { productId: number; qty: number; unitName?: string }[];
      couponId?: number;
      aiItems?: { productId: number; count: number }[];
      weightKg?: Record<string, number>;
      force?: boolean;
    },
  ) {
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '购物清单不能为空');
    for (const it of b.items) {
      if (!Number(it.productId) || !(Number(it.qty) > 0)) throw new BizException(40003, '清单含非法商品或数量');
    }
    // ── 漏扫校验（在结算与库存校验之前；识别件数 vs 结算件数 + 理论重 vs 实秤重）──
    const antileakOn = await new SettingsService().getBool('antileak.selfcheckout.enabled', true);
    if (antileakOn && ((Array.isArray(b.aiItems) && b.aiItems.length > 0) || (b.weightKg && Object.keys(b.weightKg).length > 0))) {
      const vr = await new AntileakService().verify(Number(u.storeId), {
        items: b.items.map(i => ({ productId: Number(i.productId), qty: Number(i.qty) })),
        aiItems: b.aiItems, weightKg: b.weightKg,
      });
      if (!vr.ok) {
        await new AntileakService().alert(Number(u.storeId), Number(u.sub), vr, b.force ? '待复核' : '已拦截');
        if (!b.force) {
          const d = vr.diffs.map(x => `${x.name}：${x.kind}（应 ${x.expected} / 结 ${x.actual}）`).join('；');
          throw new BizException(41001, `检测到疑似漏扫，订单已暂停，请联系店员复核。差异：${d}`);
        }
      }
    }
    const svc = new SalesService();
    const memberUser: AuthUser = {
      sub: Number(u.sub), storeId: Number(u.storeId), empNo: '', name: u.name || '扫码购会员', perms: [],
    };
    const res = await svc.checkout(memberUser, {
      items: b.items.map(i => ({ productId: Number(i.productId), qty: Number(i.qty), unitName: i.unitName })),
      memberId: Number(u.sub),
      channel: '扫码购',
      selfCheckout: true,
      payments: [{ channel: '余额', auto: true, amount: 0 }],
      couponId: b.couponId ? Number(b.couponId) : undefined,
    });
    const leaveCode = await this.genLeaveCode(Number(u.storeId));
    await q(`UPDATE sales_orders SET delivery_code=$2, updated_at=now() WHERE id=$1`, [res.orderId, leaveCode]);
    return { ...res, leaveCode };
  }

  /** 生成店内唯一 6 位离场核销码 */
  private async genLeaveCode(storeId: number): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const dup = await q1(`SELECT 1 FROM sales_orders WHERE store_id=$1 AND delivery_code=$2`, [storeId, code]);
      if (!dup) return code;
    }
    return String(Date.now()).slice(-6);
  }

  /** 修改密码（需登录+原密码） */
  @Post('password')
  async changePassword(@CurrentMember() u: MemberUser, @Body() b: { old?: string; new?: string }) {
    if (!b.old || !b.new) throw new BizException(40003, '原密码与新密码必填');
    if (b.new.length < 6) throw new BizException(42014, '新密码至少 6 位');
    const m = await q1<any>(`SELECT password_hash FROM members WHERE id=$1`, [u.sub]);
    if (!m || !bcrypt.compareSync(b.old, m.password_hash)) throw new BizException(42010, '原密码错误');
    await q(`UPDATE members SET password_hash=$2, password_set_at=now() WHERE id=$1`, [u.sub, bcrypt.hashSync(b.new, 10)]);
    return { ok: true };
  }

  /** 忘记密码·取密保问题（只回问题不回答案；未设置提示到店找回） */
  @MemberPublic()
  @Get('password/forgot/questions')
  async forgotQuestions(@Query('phone') phone?: string) {
    if (!phone) throw new BizException(40003, '手机号必填');
    const m = await q1<any>(`SELECT security_questions FROM members WHERE phone=$1 AND deleted_at IS NULL`, [phone]);
    if (!m) throw new BizException(42010, '会员不存在');
    const qs = Array.isArray(m.security_questions) ? m.security_questions : [];
    return { questions: qs.map((x: any) => x.question) };
  }

  /** 忘记密码（V4.14.0 M2：手机号 + 密保答案逐题 bcrypt 比对 → 重置；答错计锁） */
  @MemberPublic()
  @Post('password/forgot')
  async forgotPassword(@Body() b: { phone?: string; answers?: { question: string; answer: string }[]; newPassword?: string }) {
    if (!b.phone || !b.newPassword) throw new BizException(40003, '手机号与新密码必填');
    await checkPasswordPolicy(String(b.newPassword || '')); // V4.14.6 R8
    const m = await q1<any>(`SELECT * FROM members WHERE phone=$1 AND deleted_at IS NULL`, [b.phone]);
    if (!m) throw new BizException(42010, '会员不存在');
    if (m.locked_until && new Date(m.locked_until) > new Date())
      throw new BizException(42011, `错误次数过多已锁定，请 ${LOCK_MINUTES} 分钟后再试`);
    const qs = Array.isArray(m.security_questions) ? m.security_questions : [];
    if (!qs.length) throw new BizException(42013, '该会员未设置密保问题，请到店由店员协助找回');
    const answers = Array.isArray(b.answers) ? b.answers : [];
    if (answers.length !== qs.length) throw new BizException(40003, '请回答全部密保问题');
    const allOk = qs.every((sq: any) => {
      const a = answers.find(x => x.question === sq.question);
      return a && bcrypt.compareSync(String(a.answer ?? ''), sq.answerHash);
    });
    if (!allOk) {
      const fails = Number(m.login_fail_count) + 1;
      if (fails >= LOCK_FAILS) {
        await q(`UPDATE members SET login_fail_count=$2, locked_until=now()+interval '${LOCK_MINUTES} minutes' WHERE id=$1`, [m.id, fails]);
        throw new BizException(42011, `密保答案连续错误 ${LOCK_FAILS} 次，锁定 ${LOCK_MINUTES} 分钟`);
      }
      await q(`UPDATE members SET login_fail_count=$2 WHERE id=$1`, [m.id, fails]);
      throw new BizException(42010, '密保答案有误，请重试');
    }
    await q(`UPDATE members SET password_hash=$2, password_set_at=now(), login_fail_count=0, locked_until=NULL WHERE id=$1`,
      [m.id, bcrypt.hashSync(b.newPassword, 10)]);
    await audit(Number(m.store_id), null, '会员', 'member.h5.password.forgot', 'member', Number(m.id));
    return { ok: true };
  }

  // ═══════════ 充值（H5 发起 → 收银台代收，5.7.2，db/010） ═══════════

  /** 启用充值档位 + 单笔上限（赠送金额一律由服务端按档计算，客户端不可传 gift 防篡改） */
  @Get('recharge/plans')
  async rechargePlans(@CurrentMember() u: MemberUser) {
    const plans = await q(
      `SELECT id, name, principal, gift, sort_no FROM recharge_plans
        WHERE status='启用' AND store_id=$1 ORDER BY sort_no, principal`, [u.storeId]);
    const max = await new SettingsService().getNum('member.recharge.max_single', 5000);
    return { plans, maxSingle: max };
  }

  /** 发起充值单：planId 按档位（含赠送）/ 自定义 principal（无赠送）；同会员待支付 ≤ 3 张 */
  @Post('recharge-orders')
  async createRecharge(@CurrentMember() u: MemberUser, @Body() b: { planId?: number; principal?: number; remark?: string }) {
    let principal = 0, gift = 0, planId: number | null = null;
    if (b.planId) {
      const p = await q1(`SELECT * FROM recharge_plans WHERE id=$1 AND status='启用'`, [b.planId]);
      if (!p) throw new BizException(42016, '充值档位不存在或已停用');
      planId = Number(p.id); principal = Number(p.principal); gift = Number(p.gift);
    } else {
      principal = Number(b.principal);
      if (!(principal > 0)) throw new BizException(40003, '充值金额必须大于 0');
    }
    const max = await new SettingsService().getNum('member.recharge.max_single', 5000);
    if (principal > max) throw new BizException(42017, `超出单笔充值上限 ${max} 元`);
    const pend = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM recharge_orders WHERE member_id=$1 AND status='待支付'`, [u.sub]);
    if (Number(pend!.n) >= 3) throw new BizException(42018, '待支付充值单过多，请先完成或取消');
    const m = await q1(`SELECT store_id FROM members WHERE id=$1`, [u.sub]);
    const r = await tx(async c => {
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM recharge_orders WHERE order_no LIKE $1`, [`RC-${ymd}-%`]);
      const orderNo = `RC-${ymd}-${String(seq[0].n).padStart(4, '0')}`;
      const rows = await cx(c,
        `INSERT INTO recharge_orders (order_no, store_id, member_id, plan_id, principal, gift, remark)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, order_no, principal, gift, status, created_at`,
        [orderNo, Number(m.store_id), u.sub, planId, principal, gift, b.remark ?? null]);
      return rows[0];
    });
    await audit(curStore(), null, '会员', 'member.h5.recharge.create', 'recharge_order', Number(r.id),
      { orderNo: r.order_no, principal, gift });
    return r;
  }

  /** 本人充值单列表 */
  @Get('recharge-orders')
  async myRecharges(@CurrentMember() u: MemberUser) {
    const items = await q(
      `SELECT id, order_no, plan_id, principal, gift, status, pay_channel, created_at,
              collected_at, remark
         FROM recharge_orders WHERE member_id=$1 ORDER BY id DESC LIMIT 30`, [u.sub]);
    return { items: items.map(o => ({ ...o, id: Number(o.id) })) };
  }

  /** 取消本人待支付充值单 */
  @Post('recharge-orders/:id/cancel')
  async cancelRecharge(@CurrentMember() u: MemberUser, @Param('id', ParseIntPipe) id: number) {
    const r = await q1(`SELECT * FROM recharge_orders WHERE id=$1 AND member_id=$2`, [id, u.sub]);
    if (!r) throw new BizException(40404, '充值单不存在', 404);
    if (r.status !== '待支付') throw new BizException(42019, '仅待支付充值单可取消');
    await q(`UPDATE recharge_orders SET status='已取消', updated_at=now() WHERE id=$1`, [id]);
    await audit(curStore(), null, '会员', 'member.h5.recharge.cancel', 'recharge_order', id);
    return { ok: true };
  }

  // ═══════════ 在线商城（方向4：分类/商品/地址簿/在线下单/订单跟踪/取消） ═══════════

  /** 商城分类（含可售商品数；称重/未上架不计） */
  @Get('mall/categories')
  async mallCategories(@CurrentMember() u: MemberUser) {
    const rows = await q(
      `SELECT c.id, c.name, c.parent_id, c.sort_no,
              (SELECT count(*) FROM products p WHERE p.category_id=c.id AND p.deleted_at IS NULL
                 AND p.status=1 AND p.online_visible AND p.is_weighted=false)::int AS prod_count
         FROM categories c WHERE c.store_id=$1 AND c.status=1 ORDER BY c.sort_no, c.id`, [u.storeId]);
    return { items: rows.map(r => ({ ...r, id: Number(r.id) })) };
  }

  /** 商城设置（免登录敏感项不暴露：配送费/免邮门槛/开通状态/围栏半径，供客户端预展示） */
  @Get('mall/settings')
  async mallSettings(@CurrentMember() u: MemberUser) {
    const svc = new SettingsService();
    // V4.16.5 商店信息（门头动态化）：store.info.* 留空回退门店档案名
    const st = await q1<any>(`SELECT name, address, phone FROM stores WHERE id=$1`, [u.storeId]);
    const gv = async (k: string) => {
      const r = await q1<any>(`SELECT value FROM system_settings WHERE setting_key=$1`, [k]);
      const v = r?.value;
      return v === null || v === undefined || v === '' ? '' : String(v);
    };
    return {
      serving: await svc.getNum('delivery.serving', 1),
      fee: await svc.getNum('delivery.fee', 3),
      freeAbove: await svc.getNum('delivery.free_above', 50),
      radiusKm: await svc.getNum('delivery.radius_km', 0),
      store: {
        name: (await gv('store.info.name')) || String(st?.name || ''),
        address: (await gv('store.info.address')) || String(st?.address || ''),
        contact: (await gv('store.info.contact')) || '',
        phone: (await gv('store.info.phone')) || String(st?.phone || ''),
      },
    };
  }

  /** 商城商品（分页；仅在线可见 + 在售 + 非称重） */
  @Get('mall/products')
  async mallProducts(
    @CurrentMember() u: MemberUser,
    @Query('cat') cat?: string, @Query('kw') kw?: string,
    @Query('page') page = '1', @Query('size') size = '20',
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(50, Math.max(1, Number(size) || 20));
    const k = (kw || '').trim();
    const where = `${PRODUCT_VISIBLE('$1')} AND p.deleted_at IS NULL AND p.status=1 AND p.online_visible AND p.is_weighted=false
        AND ($2::bigint IS NULL OR p.category_id=$2::bigint)
        AND ($3='' OR p.name ILIKE '%'||$3||'%' OR p.barcode ILIKE '%'||$3||'%')`;
    const items = await q(
      `SELECT p.id, p.name, p.spec, p.base_unit AS "baseUnit", p.sell_price::float8 AS "sellPrice",
              CASE WHEN COALESCE(p.member_discount,0) > 0 THEN p.member_price::float8 ELSE NULL END AS "memberPrice",
              COALESCE(NULLIF(p.mall_image,''), p.photo_path) AS "photoPath",
              p.track_inventory AS "trackInventory",
              COALESCE(ic.qty_total, 0)::float8 AS stock
         FROM products p
         LEFT JOIN inventory_current ic ON ic.product_id=p.id AND ic.store_id=$1
        WHERE ${where}
        ORDER BY p.id DESC LIMIT $4 OFFSET $5`,
      [u.storeId, cat || null, k, sz, (pn - 1) * sz]);
    await storePrice.overlay(u.storeId, items);   // V4.26.5 商城主页看价按门店
    const total = await q1<any>(`SELECT count(*)::int AS n FROM products p WHERE ${where}`, [u.storeId, cat || null, k]);
    return { page: pn, size: sz, total: Number(total?.n ?? 0), items };
  }

  /** 我的收货地址簿（启用 member_addresses 表） */
  @Get('addresses')
  async myAddresses(@CurrentMember() u: MemberUser) {
    const rows = await q(
      `SELECT * FROM member_addresses WHERE member_id=$1 ORDER BY is_default DESC, id DESC`, [u.sub]);
    return { items: rows.map(a => ({ ...a, id: Number(a.id) })) };
  }

  /** 新增地址（首个自动默认；设置默认时释放其余） */
  @Post('addresses')
  async addAddress(@CurrentMember() u: MemberUser,
    @Body() b: { contact?: string; phone?: string; address?: string; isDefault?: boolean }) {
    if (!b.contact || !b.phone || !b.address) throw new BizException(40003, '联系人/手机号/地址必填');
    if (!/^1\d{10}$/.test(b.phone)) throw new BizException(40003, '手机号格式错误');
    if (String(b.address).trim().length < 5) throw new BizException(40003, '地址过于简略');
    const cnt = await q1<{ n: string }>(`SELECT count(*) AS n FROM member_addresses WHERE member_id=$1`, [u.sub]);
    const isDefault = b.isDefault === true || Number(cnt?.n ?? 0) === 0;
    const r = await tx(async c => {
      if (isDefault) await cx(c, `UPDATE member_addresses SET is_default=false WHERE member_id=$1`, [u.sub]);
      const row = await cx(c,
        `INSERT INTO member_addresses (member_id, contact, phone, address, is_default)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [u.sub, b.contact, b.phone, String(b.address).trim(), isDefault]);
      return row[0];
    });
    return { ...r, id: Number(r.id) };
  }

  /** 修改地址 */
  @Put('addresses/:id')
  async updAddress(@CurrentMember() u: MemberUser, @Param('id', ParseIntPipe) id: number,
    @Body() b: { contact?: string; phone?: string; address?: string; isDefault?: boolean }) {
    const cur = await q1(`SELECT * FROM member_addresses WHERE id=$1 AND member_id=$2`, [id, u.sub]);
    if (!cur) throw new BizException(40404, '地址不存在', 404);
    const contact = b.contact ?? cur.contact, phone = b.phone ?? cur.phone, address = b.address ?? cur.address;
    const isDefault = b.isDefault !== undefined ? b.isDefault : cur.is_default;
    await tx(async c => {
      if (isDefault && !cur.is_default) await cx(c, `UPDATE member_addresses SET is_default=false WHERE member_id=$1`, [u.sub]);
      await cx(c, `UPDATE member_addresses SET contact=$2, phone=$3, address=$4, is_default=$5 WHERE id=$1`,
        [id, contact, phone, address, isDefault]);
    });
    return { ok: true };
  }

  /** 删除地址 */
  @Delete('addresses/:id')
  async delAddress(@CurrentMember() u: MemberUser, @Param('id', ParseIntPipe) id: number) {
    await q(`DELETE FROM member_addresses WHERE id=$1 AND member_id=$2`, [id, u.sub]);
    return { ok: true };
  }

  /** 我的在线订单（含派生状态文案） */
  @Get('orders')
  async myOrders(@CurrentMember() u: MemberUser) {
    const rows = await q(
      `SELECT o.id, o.order_no, o.channel, o.pickup_mode, o.payable_amount, o.delivery_fee, o.status,
              o.picking_status, o.delivery_code, o.code_verified_at, o.created_at, o.cancelled_at,
              (SELECT count(*) FROM sale_items i WHERE i.order_id=o.id)::int AS item_count
         FROM sales_orders o
        WHERE o.member_id=$1 AND o.channel IN ('小程序','H5','外卖')
        ORDER BY o.id DESC LIMIT 30`, [u.sub]);
    return { items: rows.map(o => ({ ...o, id: Number(o.id), payableAmount: Number(o.payable_amount),
      deliveryFee: Number(o.delivery_fee), statusText: this.onlineStatusText(o) })) };
  }

  /** 在线下单（余额自动付清；服务端定价配送费 + 围栏校验；自提单下发 6 位自提码） */
  @Post('orders')
  async createOrder(@CurrentMember() u: MemberUser, @Body() b: {
    items?: { productId: number; qty: number }[];
    pickupMode?: string;      // 自提 / 配送 / 外卖
    addressId?: number;
    remark?: string;
    couponId?: number;
    lat?: number; lng?: number; // 配送围栏校验（radius_km>0 时按门店坐标校验）
  }) {
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '购物清单不能为空');
    for (const it of b.items) {
      if (!Number(it.productId) || !(Number(it.qty) > 0)) throw new BizException(40003, '清单含非法商品或数量');
    }
    const mode = ['自提', '配送', '外卖'].includes(b.pickupMode || '') ? b.pickupMode! : '自提';
    const svc = new SettingsService();
    if (mode !== '自提' && await svc.getNum('delivery.serving', 1) !== 1) {
      throw new BizException(40003, '门店暂未开通在线配送，请选择到店自提');
    }
    let addr: any = null;
    if (mode !== '自提') {
      if (!b.addressId) throw new BizException(40003, '配送/外卖请选择收货地址');
      addr = await q1(`SELECT * FROM member_addresses WHERE id=$1 AND member_id=$2`, [b.addressId, u.sub]);
      if (!addr) throw new BizException(40404, '收货地址不存在', 404);
      // 配送围栏（radius_km>0 且顾客提供坐标时校验）
      const radius = await svc.getNum('delivery.radius_km', 0);
      if (radius > 0 && Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lng))) {
        const [slat, slng] = [await svc.getNum('store.lat', 0), await svc.getNum('store.lng', 0)];
        if (slat !== 0 || slng !== 0) {
          const d = this.distKm(Number(b.lat), Number(b.lng), slat, slng);
          if (d > radius) throw new BizException(40003, `超出配送范围（距店 ${d.toFixed(1)}km，限 ${radius}km）`);
        }
      }
    }
    // 服务端预估算价（会员价优先）→ 配送费
    let estGoods = 0;
    for (const it of b.items) {
      const p = await q1<any>(`SELECT id, name, status, online_visible, sell_price, member_price, member_discount
                                 FROM products WHERE id=$1 AND deleted_at IS NULL`, [it.productId]);
      if (!p) throw new BizException(40404, `商品#${it.productId} 不存在`, 404);
      if (p.status !== 1) throw new BizException(50020, `${p.name} 已停售`);
      if (!p.online_visible) throw new BizException(50020, `${p.name} 未上架商城`);
      await storePrice.overlayOne(u.storeId, p);   // V4.26.5 配送预估算价按门店
      const participates = p.member_discount != null && Number(p.member_discount) > 0; // 会员价门控：折扣=是 才参与
      const price = participates
        ? (p.member_price != null ? Number(p.member_price) : Math.round(Number(p.sell_price) * Number(p.member_discount) * 100) / 100)
        : Number(p.sell_price);
      estGoods += price * Number(it.qty);
    }
    let deliveryFee = 0;
    if (mode !== '自提') {
      const fee = await svc.getNum('delivery.fee', 3);
      const freeAbove = await svc.getNum('delivery.free_above', 50);
      deliveryFee = estGoods >= freeAbove ? 0 : fee;
    }
    // 复用收银核心结账（余额自动付清）
    const res = await new SalesService().checkout(this.agentUser(u), {
      items: b.items.map(i => ({ productId: Number(i.productId), qty: Number(i.qty) })),
      memberId: Number(u.sub),
      channel: mode === '外卖' ? '外卖' : '小程序',
      selfCheckout: true,
      payments: [{ channel: '余额', auto: true, amount: 0 }],
      couponId: b.couponId ? Number(b.couponId) : undefined,
      deliveryFee,
    });
    const code = await this.genLeaveCode(Number(u.storeId));
    await q(
      `UPDATE sales_orders SET pickup_mode=$2, delivery_fee=$3, delivery_code=$4,
              receiver=$5, receiver_phone=$6, receiver_address=$7, remark=COALESCE($8, remark), updated_at=now()
        WHERE id=$1`,
      [res.orderId, mode, deliveryFee, code, mode === '自提' ? null : addr.contact,
       mode === '自提' ? null : addr.phone, mode === '自提' ? null : addr.address, b.remark ?? null]);
    await audit(Number(u.storeId), null, '会员', 'member.h5.order.create', 'sales_order', Number(res.orderId),
      { orderNo: res.orderNo, mode, deliveryFee, payable: res.payable });
    return { ...res, orderId: Number(res.orderId), pickupMode: mode, deliveryFee,
             pickupCode: code, statusText: '待拣货' };
  }

  /** 在线订单详情（含明细） */
  @Get('orders/:id')
  async orderDetail(@CurrentMember() u: MemberUser, @Param('id', ParseIntPipe) id: number) {
    const o = await q1<any>(
      `SELECT o.*, m.name AS member_name FROM sales_orders o
        LEFT JOIN members m ON m.id=o.member_id
       WHERE o.id=$1 AND o.member_id=$2 AND o.channel IN ('小程序','H5','外卖')`, [id, u.sub]);
    if (!o) throw new BizException(40404, '订单不存在', 404);
    const items = await q(
      `SELECT i.id AS sale_item_id, i.qty, i.unit_price, i.line_amount, p.name, p.spec, p.base_unit
         FROM sale_items i JOIN products p ON p.id=i.product_id
        WHERE i.order_id=$1 ORDER BY i.id`, [id]);
    return { order: { ...o, id: Number(o.id), payableAmount: Number(o.payable_amount),
      deliveryFee: Number(o.delivery_fee), statusText: this.onlineStatusText(o) }, items };
  }

  /** 在线订单取消（仅未拣货；原路退款+回库存，复用退款服务闭环） */
  @Post('orders/:id/cancel')
  async cancelOrder(@CurrentMember() u: MemberUser, @Param('id', ParseIntPipe) id: number) {
    // 原子占位：先标记取消意向（防止与拣货并发），退款失败回滚占位
    const claim = await q(
      `UPDATE sales_orders SET cancelled_at=now(), cancel_reason='顾客自助取消', updated_at=now()
        WHERE id=$1 AND member_id=$2 AND status='已完成'
          AND picking_status='待拣货' AND cancelled_at IS NULL AND channel IN ('小程序','H5','外卖')
        RETURNING id`, [id, u.sub]);
    if (!claim.length) {
      const o = await q1(`SELECT status, picking_status, cancelled_at, channel FROM sales_orders WHERE id=$1 AND member_id=$2`, [id, u.sub]);
      if (!o) throw new BizException(40404, '订单不存在', 404);
      if (o.cancelled_at || o.status === '已取消') throw new BizException(50071, '订单已取消');
      if (o.status === '已完成') throw new BizException(50071, '订单已进入拣货/配送，请联系门店取消');
      throw new BizException(50071, `订单当前状态（${o.status}）不可取消`);
    }
    const refundSvc = new RefundService();
    const items = await q(`SELECT id AS sale_item_id, qty FROM sale_items WHERE order_id=$1 ORDER BY id`, [id]);
    try {
      let refund: any = await refundSvc.create(this.agentUser(u), {
        orderId: id,
        items: items.map(i => ({ saleItemId: Number(i.sale_item_id), qty: Number(i.qty) })),
        reason: '线上订单取消', restock: true,
      });
      if (refund.status === '待审核') refund = await refundSvc.auditRefund(this.agentUser(u), refund.refundId, true);
      await q(`UPDATE sales_orders SET status='已取消', updated_at=now() WHERE id=$1`, [id]);
      await audit(Number(u.storeId), null, '会员', 'member.h5.order.cancel', 'sales_order', id,
        { refundId: refund.refundId, amount: refund.amount });
      return { ok: true, refundId: refund.refundId, refundAmount: refund.amount, statusText: '已取消' };
    } catch (e) {
      await q(`UPDATE sales_orders SET cancelled_at=NULL, cancel_reason=NULL, updated_at=now() WHERE id=$1`, [id]);
      throw e;
    }
  }

  /** 员工侧视角构造 AuthUser（线上自助无员工权限集） */
  private agentUser(u: MemberUser): AuthUser {
    return { sub: Number(u.sub), storeId: Number(u.storeId), empNo: '', name: u.name || '线上会员', perms: [] };
  }

  /** 配送围栏：haversine 球面距离（km） */
  private distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** 在线订单派生状态文案（服务端统一口径） */
  private onlineStatusText(o: any): string {
    if (o.cancelled_at || o.status === '已取消') return '已取消';
    if (o.code_verified_at) return o.pickup_mode === '自提' ? '已自提' : '已送达';
    if (o.picking_status === '拣货中') return '拣货中';
    if (o.picking_status === '缺货') return '部分缺货';
    if (o.picking_status === '已拣货') return o.pickup_mode === '自提' ? '待自提' : '配送中';
    if (o.picking_status === '待拣货') return o.status === '已完成' ? '待拣货' : o.status;
    return o.status || '待拣货';
  }
}

function r2(n: number): number { return Math.round(n * 100) / 100; }

@Module({
  controllers: [MemberAppController],
})
export class MemberAppModule {}
