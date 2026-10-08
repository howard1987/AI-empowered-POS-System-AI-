import { Module, Controller, Get, Post, Body, Param, Query, ParseIntPipe, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { q, q1, tx, cx, r2, audit } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { isChainStoreNode, hqMemberPost } from './member-chain.module'; // V5.0.0 批次5：连锁建档卡号由总部生成
import * as bcrypt from 'bcryptjs';
import { memberGrowth } from './member-growth.service';   // V5.0.17：等级判定改成长值口径
import { notifyStaff } from '../common/notices';   // V5.0.18：资产对账异常通知

/**
 * 会员等级同步（V5.0.17 重设计：成长值口径）
 *   成长值 = 累计实付充值本金×充值倍率 + 直接买单实付消费金额×消费倍率
 *     （余额消费 / 券抵扣 / 赠送补贴 / 管理员排除商品不计，详见 member-growth.service.ts）
 *   升级：累计成长值 ≥ 档位门槛 → 立即生效（可跨级）
 *   保级：滚动考核周期（默认近 6 个月）成长值 ≥ 保级门槛（略低于升级门槛）
 *   降级：不达保级线先进入保护缓冲期（默认 30 天，期间保留全部权益），
 *        期内补足成长即退出缓冲；到期仍不达标才正式下调
 *   变更写 member_level_log 留痕，会员端可查历史
 */
export async function syncMemberLevel(
  c: any, memberId: number,
  opts?: { graceDays?: number; operatorId?: number },
): Promise<{ changed: boolean; from?: string | null; to?: string; reason?: string; graceStarted?: boolean; graceDaysLeft?: number } | null> {
  // V5.0.17：判定口径已由「储值本金余额」改为「成长值」（累计充值+实付消费，余额/券/赠送/排除商品不计），
  //   实现见 member-growth.service.ts；保留原签名以兼容既有调用点（结账 / 代收充值 / 会员储值）。
  const r = await memberGrowth.syncLevel(c, memberId, opts?.operatorId ?? null);
  if (!r) return null;
  return {
    changed: !!r.changed,
    from: r.from ?? null,
    to: r.to ?? r.levelName ?? null,
    reason: r.reason,
    graceStarted: r.graceStarted,
    graceDaysLeft: r.graceDaysLeft,
  };
}

// ─── Controller（会员中心：快速查询 / 建档 / 储值 / 解锁，方案 5.7 + V4.5.2 会员中心） ───
@Controller('members')
class MembersController {

  /** 快速查询：手机号 / 卡号 / 姓名 / 拼音码 即输即查（V4.5.2）。
   *  V4.28.0 安全修复（F-06）：按本店收敛 + 手机号脱敏（持 member.balance.adjust 可见完整号） */
  @Get()
  async list(@Query('keyword') keyword?: string, @Query('page') page = '1', @Query('size') size = '20',
             @CurrentUser() user?: AuthUser) {
    const kw = (keyword || '').trim();
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    const canSeePhone = !!user && (user.perms.includes('*') || user.perms.includes('member.balance.adjust'));
    // V5.0.3：会员号/电话改模糊匹配（此前仅整号精确命中，发券弹窗按段搜索查不到）
    const where = `m.deleted_at IS NULL AND m.store_id = ${Number(user.storeId)}
      AND ($1 = '' OR m.phone ILIKE '%'||$1||'%' OR m.card_no ILIKE '%'||$1||'%'
      OR m.name ILIKE '%'||$1||'%' OR m.pinyin_code ILIKE '%'||$1||'%')`;
    const phoneSel = canSeePhone ? 'm.phone' :
      `CASE WHEN m.phone IS NULL OR m.phone='' THEN '' ELSE LEFT(m.phone,3)||'****'||RIGHT(m.phone,4) END AS phone`;
    const items = await q(
      `SELECT m.id, m.card_no, ${phoneSel}, m.name, m.pinyin_code, m.level_id, m.points, m.status,
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
    // V5.0.15 极限测试：建档传 points 会被静默忽略（积分必须走流水入账），
    // 用户以为设了初始积分。这里显式说明改用积分调整，避免「静默失败」。
    if (Number(b.points || 0) > 0) {
      throw new BizException(40003, '建档不支持直接设置初始积分（积分须走「积分调整」入账并留流水），请建档后单独调整');
    }
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

  /** T5 散客聚合：按手机号（线上 receiver_phone / 线下 guest_phone）聚合未挂会员的消费，
   *  返回近 days 天内次数≥minVisits 的散客，及是否已成为会员，供后台「散客转化」列表 */
  @Get('guest-aggregate')
  async guestAggregate(
    @CurrentUser() user: AuthUser,
    @Query('days') daysQ?: string,
    @Query('minVisits') mvQ?: string,
  ) {
    const days = Math.max(1, Number(daysQ) || 90);
    const minVisits = Math.max(1, Number(mvQ) || 3);
    const rows = await q<any>(
      `SELECT COALESCE(so.receiver_phone, so.guest_phone) AS phone,
              count(*)::int AS visits,
              ROUND(COALESCE(SUM(so.payable_amount), 0), 2) AS total_amount,
              max(so.created_at) AS last_order_at,
              min(so.created_at) AS first_order_at
         FROM sales_orders so
        WHERE so.store_id=$1 AND so.member_id IS NULL
          AND (so.receiver_phone IS NOT NULL AND so.receiver_phone <> ''
               OR so.guest_phone IS NOT NULL AND so.guest_phone <> '')
          AND so.created_at >= now() - ($2::int || ' days')::interval
        GROUP BY COALESCE(so.receiver_phone, so.guest_phone)
       HAVING count(*) >= $3
        ORDER BY visits DESC, last_order_at DESC`,
      [user.storeId, days, minVisits]);
    const phones = rows.map((r: any) => r.phone);
    const existing = phones.length
      ? await q<any>(`SELECT phone FROM members WHERE phone = ANY($1) AND deleted_at IS NULL`, [phones])
      : [];
    const have = new Set(existing.map((m: any) => m.phone));
    return {
      days, minVisits,
      items: rows.map((r: any) => ({
        phone: r.phone,
        visits: Number(r.visits),
        totalAmount: Number(r.total_amount),
        firstOrderAt: r.first_order_at,
        lastOrderAt: r.last_order_at,
        alreadyMember: have.has(r.phone),
      })),
    };
  }

  /** T5 散客转化：把某手机号的散客消费归集为会员（已存在则直接归集，不存在则按「散客转化」渠道建档） */
  @RequirePerms('member.register')
  @Post('convert-guest')
  async convertGuest(@Body() b: { phone?: string }, @CurrentUser() user: AuthUser) {
    const phone = String(b.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) throw new BizException(40003, '手机号格式不正确');
    let m: any = await q1(`SELECT id, card_no FROM members WHERE phone=$1 AND deleted_at IS NULL`, [phone]);
    if (!m) {
      const reg: any = await this.register({ phone, registerChannel: '散客转化', privacyAgreed: false }, user);
      m = { id: reg.id };
    }
    const linked = await q<any>(
      `UPDATE sales_orders SET member_id=$2, updated_at=now()
        WHERE store_id=$3 AND member_id IS NULL AND (receiver_phone=$1 OR guest_phone=$1)
       RETURNING id`,
      [phone, m.id, user.storeId]);
    return { memberId: m.id, linkedOrders: linked.length };
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
      q(`SELECT mc.id, mc.code, mc.status, mc.received_at, mc.expire_at, mc.used_at, mc.times_used,
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
      await memberGrowth.earnRecharge(c, {   // V5.0.17：充值本金计成长值（赠送不计）
        memberId: Number(id), principal, refType: 'recharge', refId: Number(id), remark: '会员储值充值' });
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

  /** V5.0.18 会员资产对账：账户余额 vs 流水合计逐会员核对（储值/积分/分红三条线）。
   *  此前三者之间既无数据库一致性约束、也无自动对账——余额被绕过流水篡改/漏记时无从发现。
   *  口径：balance = Σ(入−出) balance_flows；points = Σ(加−减) points_flows；
   *        dividend_balance = Σ dividend_records.amount（计提正/抵扣·冲减·失效回冲负，正负已带符号）。 */
  @RequirePerms('member.balance.adjust')
  // 路径用两段（recon/assets）：单段会被上方 @Get(':id') + ParseIntPipe 抢占而 400
  @Get('recon/assets')
  async assetRecon() {
    return runAssetRecon();
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

/** V5.0.18 会员资产对账核心：账户余额 vs 流水合计，返回不一致明细（截取前 50 条）。
 *  供 GET /members/asset-recon（人工）与每日任务（自动，异常即通知）共用。 */
export async function runAssetRecon(): Promise<{ checked: number; mismatchCount: number; mismatches: any[] }> {
  const rows = await q(`
    SELECT a.member_id, m.name AS member_name,
           a.balance AS acct_balance, COALESCE(bf.s,0) AS flow_balance,
           a.points AS acct_points, COALESCE(pf.s,0) AS flow_points,
           a.dividend_balance AS acct_div, COALESCE(df.s,0) AS flow_div
      FROM member_accounts a
      JOIN members m ON m.id = a.member_id AND m.deleted_at IS NULL
      LEFT JOIN (SELECT member_id, SUM(CASE WHEN direction='入' THEN amount ELSE -amount END) AS s
                   FROM balance_flows GROUP BY member_id) bf ON bf.member_id = a.member_id
      LEFT JOIN (SELECT member_id, SUM(CASE WHEN direction='加' THEN points ELSE -points END) AS s
                   FROM points_flows GROUP BY member_id) pf ON pf.member_id = a.member_id
      LEFT JOIN (SELECT member_id, SUM(amount) AS s
                   FROM dividend_records GROUP BY member_id) df ON df.member_id = a.member_id`);
  const cents = (x: any) => Math.round(Number(x || 0) * 100);
  const mism = rows.filter((r: any) =>
    cents(r.acct_balance) !== cents(r.flow_balance) ||
    Number(r.acct_points || 0) !== Number(r.flow_points || 0) ||
    cents(r.acct_div) !== cents(r.flow_div))
    .map((r: any) => ({ memberId: Number(r.member_id), name: r.member_name,
      balance: { acct: Number(r.acct_balance), flow: Number(r.flow_balance) },
      points: { acct: Number(r.acct_points), flow: Number(r.flow_points) },
      dividend: { acct: Number(r.acct_div), flow: Number(r.flow_div) } }));
  return { checked: rows.length, mismatchCount: mism.length, mismatches: mism.slice(0, 50) };
}

/** V5.0.17 会员等级周期考核定时任务（每日 03:10）
 *  必需：保级缓冲期到期后若会员仍未消费，必须有任务把等级降下来；
 *  仅靠「结账/充值时顺带判定」无法覆盖「长期不消费」场景（越久越高级，会员等级永久化）。
 *  逐会员独立事务，单个会员异常不影响整体。 */
@Injectable()
export class MemberLevelJob implements OnModuleInit, OnModuleDestroy {
  private timer: any;
  private lastDay = '';
  onModuleInit() {
    this.timer = setInterval(() => this.maybeRun().catch(() => { }), 60_000);
  }
  onModuleDestroy() { clearInterval(this.timer); }
  private async maybeRun() {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== 3 || now.getMinutes() < 10 || this.lastDay === day) return;
    this.lastDay = day;
    try {
      const ms = await q(`SELECT id FROM members WHERE deleted_at IS NULL`);
      let changed = 0;
      for (const m of ms) {
        try {
          const r = await tx((c: any) => memberGrowth.syncLevel(c, Number(m.id), null));
          if (r?.changed) changed++;
        } catch { /* 单会员失败跳过 */ }
      }
      console.log(`[会员等级job] 周期考核完成：检查 ${ms.length} 人，等级变更 ${changed} 人`);
      // V5.0.18：会员资产对账（每日，考核之后）——账实不符即审计 + 通知管理员
      try {
        const rc = await runAssetRecon();
        if (rc.mismatchCount > 0) {
          console.error(`[会员等级job] ⚠ 资产对账：${rc.mismatchCount}/${rc.checked} 个会员账实不符`);
          await audit(curStore(), 0, '会员', 'member.asset.recon', 'member', null,
            { checked: rc.checked, mismatchCount: rc.mismatchCount, sample: rc.mismatches.slice(0, 10) }).catch(() => { });
          try { notifyStaff(1, 'job_error', `会员资产对账异常：${rc.mismatchCount}/${rc.checked} 个会员账实不符，请到「会员管理 → 资产对账」核查`, {}, 'sys.settings', 'member:recon').catch(() => { }); } catch { }
        }
      } catch (e: any) { console.error('[会员等级job] 资产对账失败:', e?.message); }
    } catch (e: any) {
      console.error('[会员等级job] 执行失败:', e?.message);
    }
  }
}

@Module({ controllers: [MembersController], providers: [MemberLevelJob] })
export class MembersModule {}
