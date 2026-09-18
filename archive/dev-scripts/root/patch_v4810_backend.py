# -*- coding: utf-8 -*-
# V4.8.10 后端改动：member-app（H5 发起充值）+ pos（收银台代收）+ members（档位管理）
import io, sys, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend', 'src', 'modules')
ROOT = os.path.abspath(ROOT)

def patch(path, pairs):
    p = os.path.join(ROOT, path)
    s = io.open(p, encoding='utf-8').read()
    for old, new, tag in pairs:
        assert s.count(old) == 1, f'{path} 锚点不唯一({s.count(old)}): {tag}'
        s = s.replace(old, new)
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
    print('OK', path)

# ───────── member-app.module.ts ─────────
patch('member-app.module.ts', [
(
"import { Module, Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';",
"import { Module, Controller, Post, Get, Body, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';",
'import nest'
),
(
"import { MemberGuard, MemberPublic, CurrentMember, MemberUser } from '../common/member-auth';",
"import { MemberGuard, MemberPublic, CurrentMember, MemberUser } from '../common/member-auth';\nimport { SettingsService } from './settings.module';",
'import settings'
),
(
"""    await q(`UPDATE members SET password_hash=$2, password_set_at=now() WHERE id=$1`, [u.sub, bcrypt.hashSync(b.new, 10)]);
    return { ok: true };
  }
}""",
"""    await q(`UPDATE members SET password_hash=$2, password_set_at=now() WHERE id=$1`, [u.sub, bcrypt.hashSync(b.new, 10)]);
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
    await audit(1, null, '会员', 'member.h5.recharge.create', 'recharge_order', Number(r.id),
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
    await audit(1, null, '会员', 'member.h5.recharge.cancel', 'recharge_order', id);
    return { ok: true };
  }
}""",
'class tail'
),
])

# ───────── pos.module.ts ─────────
patch('pos.module.ts', [
(
"import { q, q1, r2 } from '../common/db';",
"import { q, q1, tx, cx, r2, audit } from '../common/db';",
'import db'
),
(
"import { SalesService } from './sales.module';",
"import { SalesService } from './sales.module';\nimport { syncMemberLevel } from './members.module';",
'import level'
),
(
"""  @RequirePerms('pos.sell')
  @Delete('held/:id')""",
"""  // ═══════════ 会员充值代收（H5 发起 → 收银台收款确认，db/010） ═══════════

  /** 代收队列：按状态查充值单（默认待支付；手机号脱敏） */
  @RequirePerms('member.balance.recharge')
  @Get('recharge-orders')
  async rechargeQueue(@Query('status') status = '待支付') {
    const st = ['待支付', '已入账', '已取消', '已过期'].includes(status) ? status : '待支付';
    const items = await q(
      `SELECT r.id, r.order_no, r.principal, r.gift, r.status, r.pay_channel, r.created_at, r.collected_at,
              m.id AS member_id, m.card_no, m.name, l.name AS level_name,
              CASE WHEN m.phone IS NULL THEN NULL ELSE LEFT(m.phone,3)||'****'||RIGHT(m.phone,4) END AS phone
         FROM recharge_orders r
         JOIN members m ON m.id = r.member_id
         LEFT JOIN member_levels l ON l.id = m.level_id
        WHERE r.status=$1 ORDER BY r.id DESC LIMIT 50`, [st]);
    return { items };
  }

  /** 收款入账：现金/扫码通道收取 → 口径B 双余额入账 + 等级同步（FOR UPDATE 锁单防并发重复入账 50074） */
  @RequirePerms('member.balance.recharge')
  @Post('recharge-orders/:id/collect')
  async collectRecharge(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { payChannel: string; shiftId?: number; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!['现金', '扫码'].includes(body.payChannel)) throw new BizException(40003, 'payChannel 仅支持 现金/扫码');
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM recharge_orders WHERE id=$1 FOR UPDATE`, [id]);
      const ro = rows[0];
      if (!ro) throw new BizException(40404, '充值单不存在', 404);
      if (ro.status !== '待支付') throw new BizException(50074, `充值单状态已变更（${ro.status}），请刷新后重试`);
      const hours = await this.settings.getNum('member.recharge.orders_expire_hours', 24);
      if (new Date(ro.created_at).getTime() + hours * 3600000 < Date.now()) {
        await cx(c, `UPDATE recharge_orders SET status='已过期', updated_at=now() WHERE id=$1`, [id]);
        throw new BizException(50075, '充值单已过期，请会员重新发起');
      }
      const principal = Number(ro.principal), gift = Number(ro.gift);
      const memberId = Number(ro.member_id);
      const accs = await cx(c, `SELECT * FROM member_accounts WHERE member_id=$1 FOR UPDATE`, [memberId]);
      if (!accs[0]) throw new BizException(40404, '会员资产账户不存在', 404);
      const after = r2(Number(accs[0].balance) + principal + gift);
      await cx(c,
        `UPDATE member_accounts SET balance=$2, principal_total = principal_total + $3,
                principal_balance = principal_balance + $3, gift_balance = gift_balance + $4, updated_at=now()
          WHERE member_id=$1`, [memberId, after, principal, gift]);
      const flow = await cx(c,
        `INSERT INTO balance_flows (store_id, member_id, direction, amount, principal_part, gift_part,
                                    biz_type, balance_after, employee_id, remark)
         VALUES ($1,$2,'入',$3,$4,$5,'充值',$6,$7,$8) RETURNING id`,
        [Number(ro.store_id), memberId, r2(principal + gift), principal, gift, after, user.sub,
         `充值单 ${ro.order_no}（收银台代收·${body.payChannel}）`]);
      await cx(c,
        `UPDATE recharge_orders SET status='已入账', pay_channel=$2, balance_flow_id=$3,
                collected_by=$4, collected_at=now(), shift_id=$5,
                remark=COALESCE(NULLIF($6,''), remark), updated_at=now()
          WHERE id=$1 AND status='待支付'`, [id, body.payChannel, flow[0].id, user.sub, body.shiftId ?? null, body.remark ?? '']);
      const level = await syncMemberLevel(c, memberId, { operatorId: user.sub });
      await audit(1, user.sub, '会员', 'member.recharge.collect', 'recharge_order', id,
        { orderNo: ro.order_no, principal, gift, channel: body.payChannel, balanceAfter: after, level });
      return { orderId: id, orderNo: ro.order_no, memberId, principal, gift,
               payChannel: body.payChannel, balanceAfter: after, level };
    });
  }

  @RequirePerms('pos.sell')
  @Delete('held/:id')""",
'pos recharge'
),
])

# ───────── members.module.ts（档位管理） ─────────
patch('members.module.ts', [
(
"""  /** 等级档位配置（5.1.12：折扣/积分倍率/分红系数/余额门槛，后台展示） */
  @Get('levels/list')""",
"""  // ═══════════ 充值档位管理（db/010） ═══════════

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
      await audit(1, user.sub, '会员', 'member.recharge.plan.create', 'recharge_plan', Number(rows[0].id), b);
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
    await audit(1, user.sub, '会员', 'member.recharge.plan.status', 'recharge_plan', id, { status: b.status });
    return r;
  }

  /** 等级档位配置（5.1.12：折扣/积分倍率/分红系数/余额门槛，后台展示） */
  @Get('levels/list')""",
'plans manage'
),
])

print('ALL PATCHES DONE')
