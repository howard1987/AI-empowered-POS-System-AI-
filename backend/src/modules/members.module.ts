import { Module, Controller, Get, Post, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, r2, audit } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { isChainStoreNode, hqMemberPost } from './member-chain.module'; // V5.0.0 批次5：连锁建档卡号由总部生成
import * as bcrypt from 'bcryptjs';

/**
 * 会员等级同步（方案 5.1.12，余额实时升降）：
 *   升级：余额 ≥ 档位门槛 → 立即生效（可跨级）
 *   降级：低于阈值先记 level_below_since，连续 grace_days 天仍低于才降（防等级反复跳动）
 *   变更写 member_level_log 留痕，会员端可查历史
 */
export async function syncMemberLevel(
  c: any, memberId: number,
  opts?: { graceDays?: number; operatorId?: number },
): Promise<{ changed: boolean; from?: string | null; to?: string; reason?: string; graceStarted?: boolean; graceDaysLeft?: number } | null> {
  const grace = opts?.graceDays ?? await new SettingsService().getNum('member.level_grace_days', 7);
  const rows = await cx(c,
    `SELECT m.level_id, m.level_below_since, a.principal_balance
       FROM members m JOIN member_accounts a ON a.member_id = m.id
      WHERE m.id=$1 FOR UPDATE OF m`, [memberId]);
  if (!rows.length) return null;
  // 会员升级口径【老板 2026-09-18 最终拍板】：只按「本金余额」判级，赠送余额不参与
  //   （防 gift 抬级套折扣/积分倍率）；批次5 上行的 total_consume（跨店累计消费）仅作报表，
  //   不参与判级 —— R4「连锁累计消费升级」作废，以本条为准。
  const balance = Number(rows[0].principal_balance);
  const levels = await cx(c, `SELECT id, name, sort_no, upgrade_score FROM member_levels ORDER BY sort_no`);
  if (!levels.length) return null;
  // 目标档：本金余额能满足的最高档（upgrade_score = 储值本金余额门槛）
  let target: any = null;
  for (const l of levels) if (balance >= Number(l.upgrade_score)) target = l;
  const cur: any = rows[0].level_id ? levels.find(l => l.id === rows[0].level_id) : null;

  // ── 升级（或首次初始化）：立即生效 ──
  if (!cur || (target && target.sort_no > cur.sort_no)) {
    await cx(c,
      `UPDATE members SET level_id=$2, level_below_since=NULL, level_synced_at=now(), updated_at=now() WHERE id=$1`,
      [memberId, target.id]);
    await cx(c,
      `INSERT INTO member_level_log (member_id, from_level_id, to_level_id, reason, operator_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [memberId, cur?.id ?? null, target.id, cur ? '升级' : '初始化', opts?.operatorId ?? null]);
    return { changed: true, from: cur?.name ?? null, to: target.name, reason: cur ? '升级' : '初始化' };
  }

  // ── 降级：宽限期机制 ──
  if (!target || target.sort_no < cur.sort_no) {
    if (!rows[0].level_below_since) {
      await cx(c,
        `UPDATE members SET level_below_since=$2, level_synced_at=now(), updated_at=now() WHERE id=$1`,
        [memberId, new Date().toISOString().slice(0, 10)]);
      return { changed: false, graceStarted: true };
    }
    const bs: any = rows[0].level_below_since;
    const bsStr = bs instanceof Date
      ? `${bs.getFullYear()}-${String(bs.getMonth() + 1).padStart(2, '0')}-${String(bs.getDate()).padStart(2, '0')}`
      : String(bs).slice(0, 10);
    const sinceMs = new Date(bsStr + 'T00:00:00Z').getTime();
    const days = Math.floor((Date.now() - sinceMs) / 86400000);
    if (days >= grace) {
      await cx(c,
        `UPDATE members SET level_id=$2, level_below_since=NULL, level_synced_at=now(), updated_at=now() WHERE id=$1`,
        [memberId, target.id]);
      const reason = `降级(宽限${grace}天)`;
      await cx(c,
        `INSERT INTO member_level_log (member_id, from_level_id, to_level_id, reason, operator_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [memberId, cur.id, target.id, reason, opts?.operatorId ?? null]);
      return { changed: true, from: cur.name, to: target.name, reason };
    }
    return { changed: false, graceDaysLeft: grace - days };
  }

  // ── 等级不变：若此前挂了宽限标记（余额回升），清除 ──
  if (rows[0].level_below_since) {
    await cx(c, `UPDATE members SET level_below_since=NULL, level_synced_at=now(), updated_at=now() WHERE id=$1`, [memberId]);
  }
  return { changed: false };
}

// ─── Controller（会员中心：快速查询 / 建档 / 储值 / 解锁，方案 5.7 + V4.5.2 会员中心） ───
@Controller('members')
class MembersController {

  /** 快速查询：手机号 / 卡号 / 姓名 / 拼音码 即输即查（V4.5.2） */
  @Get()
  async list(@Query('keyword') keyword?: string, @Query('page') page = '1', @Query('size') size = '20') {
    const kw = (keyword || '').trim();
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    const where = `m.deleted_at IS NULL AND ($1 = '' OR m.phone=$1 OR m.card_no=$1
      OR m.name ILIKE '%'||$1||'%' OR m.pinyin_code ILIKE '%'||$1||'%')`;
    const items = await q(
      `SELECT m.id, m.card_no, m.phone, m.name, m.pinyin_code, m.level_id, m.points, m.status,
              m.last_active_date, m.invalid_at, m.created_at,
              a.balance, a.dividend_balance, a.dividend_capped, a.principal_total,
              a.dividend_cumulative, a.dividend_weight,
              COALESCE(l.name, '普通会员') AS level_name, COALESCE(l.point_rate, 1) AS level_rate
         FROM members m JOIN member_accounts a ON a.member_id = m.id
         LEFT JOIN member_levels l ON l.id = m.level_id
        WHERE ${where} ORDER BY m.id LIMIT $2 OFFSET $3`, [kw, sz, (pn - 1) * sz]);
    const cnt = await q1<{ n: string }>(`SELECT count(*) AS n FROM members m WHERE ${where}`, [kw]);
    return { total: Number(cnt!.n), page: pn, size: sz, items };
  }

  /** 会员建档（卡号自动生成，创建资产账户） */
  @RequirePerms('member.register')
  @Post()
  async register(@Body() b: any, @CurrentUser() user: AuthUser) {
    // 决策②：会员主档统一归总部（member.hq_store_id，默认 1）；消费/流水按交易门店动态记账，会员查询本就跨店共享
    const hqStore = await new SettingsService().getNum('member.hq_store_id', 1);
    if (!b.phone && !b.name) throw new BizException(40003, '手机号与姓名至少填一项');
    if (b.phone) {
      const dup = await q1(`SELECT id FROM members WHERE phone=$1 AND deleted_at IS NULL`, [b.phone]);
      if (dup) throw new BizException(50050, '该手机号已注册');
    }
    // ── V5.0.0 批次5（M5-3 前置，R3）：连锁门店节点 → 卡号由总部生成（防门店自增撞号），
    //    总部落权威档案 + 发布镜像下行；本地落同卡号镜像行（收银查询即时可用，资产以总部为准）。
    //    总部不可达 → 明确报错（建档为低频操作，收银员稍后重试；P2 支持离线挂起补传）。
    if (await isChainStoreNode()) {
      const created = await hqMemberPost('register', {
        phone: b.phone ?? null, name: b.name ?? null, pinyinCode: b.pinyinCode ?? null,
        gender: b.gender ?? null, birthday: b.birthday ?? null,
        registerChannel: b.registerChannel ?? '收银台', privacyAgreed: !!b.privacyAgreed,
      });
      await tx(async c => {
        const dup2 = await cx(c, `SELECT id FROM members WHERE card_no=$1`, [created.cardNo]);
        if (!dup2[0]) {
          const m = await cx(c,
            `INSERT INTO members (store_id, card_no, phone, name, pinyin_code, gender, birthday,
                                  register_channel, privacy_agreed, source_store_id, source_node)
             VALUES (${hqStore},$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [created.cardNo, b.phone ?? null, b.name ?? null, b.pinyinCode ?? null, b.gender ?? null,
             b.birthday ?? null, created.member?.register_channel ?? '连锁', !!b.privacyAgreed,
             created.member?.source_store_id ?? null, created.member?.source_node ?? null]);
          await cx(c, `INSERT INTO member_accounts (member_id) VALUES ($1)`, [m[0].id]);
        }
      });
      await audit(curStore(), user.sub, '会员', 'member.register', 'member', created.member?.id, { cardNo: created.cardNo, chain: true });
      return { id: created.member?.id, card_no: created.cardNo, cardNo: created.cardNo,
               phone: created.member?.phone ?? b.phone ?? null, name: created.member?.name ?? b.name ?? null,
               chain: true };
    }
    return tx(async c => {
      const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM members`);
      const cardNo = `M${String(seq[0].n).padStart(6, '0')}`;
      const m = await cx(c,
        `INSERT INTO members (store_id, card_no, phone, name, pinyin_code, gender, birthday,
                              register_channel, privacy_agreed)
         VALUES (${hqStore},$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [cardNo, b.phone ?? null, b.name ?? null, b.pinyinCode ?? null, b.gender ?? null,
         b.birthday ?? null, b.registerChannel ?? '到店', !!b.privacyAgreed]);
      await cx(c, `INSERT INTO member_accounts (member_id) VALUES ($1)`, [m[0].id]);
      await audit(curStore(), user.sub, '会员', 'member.register', 'member', m[0].id, { cardNo });
      return m[0];
    });
  }

  /** 管理员重置会员密码（V4.14.0 M2：生成随机临时密码返回一次，首次登录后会员可自行改） */
  @RequirePerms('member.manage')
  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const m = await q1(`SELECT id, card_no FROM members WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!m) throw new BizException(40404, '会员不存在', 404);
    const temp = 'Mb' + Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 10);
    await q(`UPDATE members SET password_hash=$2, password_set_at=now(), login_fail_count=0, locked_until=NULL WHERE id=$1`,
      [id, bcrypt.hashSync(temp, 10)]);
    await audit(curStore(), user.sub, '会员', 'member.password.reset', 'member', id, { cardNo: m.card_no });
    return { tempPassword: temp };
  }

  /** 会员详情：档案 + 资产（口径B 本金/赠送余额）+ 等级日志 + 近期流水 */
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const m = await q1(
      `SELECT m.*, a.balance, a.principal_total, a.principal_balance, a.gift_balance,
              a.dividend_balance, a.dividend_cumulative,
              a.dividend_capped, a.dividend_weight, COALESCE(l.name, '普通会员') AS level_name
         FROM members m
         JOIN member_accounts a ON a.member_id = m.id
         LEFT JOIN member_levels l ON l.id = m.level_id
        WHERE m.id=$1 AND m.deleted_at IS NULL`, [id]);
    if (!m) throw new BizException(40404, '会员不存在', 404);
    const [balanceFlows, dividendFlows, pointsFlows, levelLogs, orders, coupons, pref, logs] = await Promise.all([
      q(`SELECT * FROM balance_flows WHERE member_id=$1 ORDER BY id DESC LIMIT 20`, [id]),
      q(`SELECT * FROM dividend_records WHERE member_id=$1 ORDER BY id DESC LIMIT 20`, [id]),
      q(`SELECT * FROM points_flows WHERE member_id=$1 ORDER BY id DESC LIMIT 20`, [id]),
      q(`SELECT g.*, fl.name AS from_name, tl.name AS to_name
           FROM member_level_log g
           LEFT JOIN member_levels fl ON fl.id = g.from_level_id
           LEFT JOIN member_levels tl ON tl.id = g.to_level_id
          WHERE g.member_id=$1 ORDER BY g.id DESC LIMIT 10`, [id]),
      q(`SELECT o.id, o.order_no, o.channel, o.payable_amount, o.profit_amount, o.points_earned, o.created_at,
                (SELECT count(*)::int FROM sale_items si WHERE si.order_id = o.id) AS item_count
           FROM sales_orders o
          WHERE o.member_id=$1 AND o.status='已完成'
          ORDER BY o.id DESC LIMIT 20`, [id]),
      q(`SELECT mc.id, mc.status, mc.received_at, mc.expire_at, mc.used_at, mc.times_used,
                c.name, c.type, c.threshold, c.discount, c.valid_days
           FROM member_coupons mc
           JOIN coupons c ON c.id = mc.coupon_id
          WHERE mc.member_id=$1
          ORDER BY mc.id DESC LIMIT 20`, [id]),
      q(`SELECT COALESCE(c.name,'未分类') AS category_name,
                COALESCE(SUM(i.line_amount),0) AS spend,
                count(DISTINCT o.id)::int AS order_count
           FROM sale_items i
           JOIN sales_orders o ON o.id = i.order_id AND o.status='已完成' AND o.member_id=$1
           JOIN products p ON p.id = i.product_id
           LEFT JOIN categories c ON c.id = p.category_id
          GROUP BY c.name
          ORDER BY spend DESC LIMIT 5`, [id]),
      q(`SELECT al.id, al.module, al.action, al.employee_id,
                COALESCE(e.name, '系统') AS operator_name, al.detail, al.created_at
           FROM audit_logs al
           LEFT JOIN employees e ON e.id = al.employee_id
          WHERE al.target_type='member' AND al.target_id=$1
          ORDER BY al.id DESC LIMIT 20`, [id]),
    ]);
    return { member: m, balanceFlows, dividendFlows, pointsFlows, levelLogs, orders, coupons, pref, logs };
  }

  /**
   * 储值收款（权限点 member.balance.recharge）：
   * 本金/赠送双余额拆分记账（口径B V4.3.1/V4.8.2），余额快照 balance_after，储值后同步等级
   */
  @RequirePerms('member.balance.recharge')
  @Post(':id/recharges')
  async recharge(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { principal?: number; gift?: number; planId?: number; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    let principal = Number(b.principal || 0);
    let gift = Number(b.gift || 0);
    // V4.8.19：支持按充值档位（服务端按档入账，与 H5 同口径防篡改）
    if (b.planId) {
      const p = await q1(`SELECT * FROM recharge_plans WHERE id=$1 AND status='启用'`, [b.planId]);
      if (!p) throw new BizException(42016, '充值档位不存在或已停用');
      principal = Number(p.principal);
      gift = Number(p.gift);
    }
    if (!(principal > 0) || gift < 0) throw new BizException(40003, 'principal 必须为正数');
    // P2-M7：赠送额只能来自启用档位，或持储值人工调整权限（防任意 gift 刷总余额→等级/积分）
    if (gift > 0 && !b.planId && !(user.perms.includes('*') || user.perms.includes('member.balance.adjust')))
      throw new BizException(40003, '赠送金额须走充值档位(planId)或由持「储值人工调整」权限的账号操作（P2-M7）');
    return tx(async c => {
      const accs = await cx(c, `SELECT * FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [id]);
      const acc = accs[0];
      if (!acc) throw new BizException(40404, '会员资产账户不存在', 404);
      const after = r2(Number(acc.balance) + principal + gift);
      await cx(c,
        `UPDATE member_accounts SET balance=$2, principal_total = principal_total + $3,
                principal_balance = principal_balance + $3, gift_balance = gift_balance + $4, updated_at=now()
          WHERE member_id=$1`, [id, after, principal, gift]);
      const flow = await cx(c,
        `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                    biz_type, balance_after, employee_id, remark)
         VALUES ($8,$1,'入',$2,$3,$4,'充值',$5,$6,$7) RETURNING id`,
        [id, r2(principal + gift), principal, gift, after, user.sub, b.remark ?? null, user.storeId || 1]);
      const level = await syncMemberLevel(c, id, { operatorId: user.sub });
      await audit(user.storeId || 1, user.sub, '会员', 'member.recharge', 'member', id,
        { principal, gift, balanceAfter: after, level });
      return { flowId: flow[0].id, balanceAfter: after, level };
    });
  }

  // ═══════════ 充值档位管理（db/010） ═══════════

  /** 档位全量（含停用，后台管理屏） */
  @Get('recharge/plans/all')
  @RequirePerms('member.balance.recharge')
  async planList() {
    return q(`SELECT * FROM recharge_plans ORDER BY sort_no, principal`);
  }

  /** 新建档位（充 principal 送 gift） */
  @Post('recharge-plans')
  @RequirePerms('member.balance.recharge')
  async createPlan(
    @Body() b: { name?: string; principal?: number; gift?: number; sortNo?: number },
    @CurrentUser() user: AuthUser,
  ) {
    const principal = Number(b.principal), gift = Number(b.gift || 0);
    if (!b.name || !b.name.trim() || !(principal > 0) || gift < 0)
      throw new BizException(40003, '名称、principal>0、gift≥0 必填');
    return tx(async c => {
      const rows = await cx(c,
        `INSERT INTO recharge_plans (store_id, name, principal, gift, sort_no)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [user.storeId, b.name!.trim(), principal, gift, Number(b.sortNo ?? 0)]);
      await audit(curStore(), user.sub, '会员', 'member.recharge.plan.create', 'recharge_plan', Number(rows[0].id), b);
      return rows[0];
    });
  }

  /** 停用/启用档位 */
  @Post('recharge-plans/:id/status')
  @RequirePerms('member.balance.recharge')
  async planStatus(@Param('id', ParseIntPipe) id: number, @Body() b: { status: string }, @CurrentUser() user: AuthUser) {
    if (!['启用', '停用'].includes(b.status)) throw new BizException(40003, 'status 仅支持 启用/停用');
    const r = await q1(`UPDATE recharge_plans SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, b.status]);
    if (!r) throw new BizException(40404, '档位不存在', 404);
    await audit(curStore(), user.sub, '会员', 'member.recharge.plan.status', 'recharge_plan', id, { status: b.status });
    return r;
  }

  /** 等级档位配置（5.1.12：折扣/积分倍率/分红系数/余额门槛，后台展示） */
  @Get('levels/list')
  async levels() {
    return q(`SELECT id, name, sort_no, upgrade_score, discount, point_rate, dividend_coeff, perks
                FROM member_levels ORDER BY sort_no`);
  }

  /** 全量等级同步（降级宽限到期后由夜间跑批/管理员手动触发） */
  @RequirePerms('sys.user.manage')
  @Post('levels/sync')
  async syncLevels(@CurrentUser() user: AuthUser) {
    const members = await q(`SELECT m.id FROM members m WHERE m.deleted_at IS NULL AND m.status='正常'`);
    let changed = 0;
    for (const m of members) {
      await tx(async c => {
        const r = await syncMemberLevel(c, m.id, { operatorId: user.sub });
        if (r?.changed) changed++;
      });
    }
    await audit(curStore(), user.sub, '会员', 'member.levels.sync', 'member', undefined, { checked: members.length, changed });
    return { checked: members.length, changed };
  }

  /** 解锁会员登录（连错 5 次锁 30 分；后台仅解锁不代设密码 V4.6.6） */
  @RequirePerms('sys.user.manage')
  @Post(':id/unlock')
  async unlock(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    await q(`UPDATE members SET login_fail_count=0, locked_until=NULL WHERE id=$1`, [id]);
    await audit(curStore(), user.sub, '会员', 'member.unlock', 'member', id);
    return { unlocked: true };
  }
}

@Module({ controllers: [MembersController] })
export class MembersModule {}
