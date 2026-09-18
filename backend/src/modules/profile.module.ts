/**
 * M4b · 会员智能画像（生命周期 / 偏好品类 / 贡献度 / 消费频次）
 *   POST /members/profile/refresh —— 全量重算（member_profiles 025；集合 SQL + upsert）
 *   GET  /members/profile/list    —— 画像列表（姓名/电话/标签筛选）
 *   GET  /members/profile/:id     —— 单会员画像详情（含近期订单）
 *   标签：lifecycle(新客/活跃/沉睡/流失/未消费) · tier(高/中/低贡献) · freq(高频/中频/低频)
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { q, audit } from '../common/db';

function lifecycleOf(lastAt: any, firstAt: any): string {
  if (!lastAt) return '未消费';
  const last = new Date(lastAt), first = new Date(firstAt);
  const days = (Date.now() - last.getTime()) / 86400000;
  if (days <= 30) return (Date.now() - first.getTime()) / 86400000 <= 30 ? '新客' : '活跃';
  if (days <= 90) return '沉睡';
  return '流失';
}

@Controller('members/profile')
export class MemberProfileController {
  /** 全量重算画像（建议每日夜间；数据量增长后可改增量） */
  @Post('refresh')
  @RequirePerms('ai.decision')
  async refresh(@CurrentUser() u: AuthUser) {
    // 1) 会员消费聚合 + 贡献度三分位
    const agg = await q(
      `WITH agg AS (
         SELECT so.member_id, COUNT(*)::int AS orders, COALESCE(SUM(so.payable_amount),0) AS amt,
                MIN(so.created_at) AS first_at, MAX(so.created_at) AS last_at
           FROM sales_orders so
          WHERE so.member_id IS NOT NULL AND so.status='已完成' AND so.store_id=$1
          GROUP BY so.member_id
       )
       SELECT member_id, orders, amt, first_at, last_at,
              CASE WHEN amt >= COALESCE((SELECT percentile_cont(0.67) WITHIN GROUP (ORDER BY amt) FROM agg), 0) THEN 1
                   WHEN amt >= COALESCE((SELECT percentile_cont(0.33) WITHIN GROUP (ORDER BY amt) FROM agg), 0) THEN 2
                   ELSE 3 END AS tier
         FROM agg`, [u.storeId]);

    // 2) 偏好品类 TOP3（近180天，按分类消费金额）
    const fav = await q(
      `SELECT so.member_id, p.category_id, c.name AS cat, SUM(si.line_amount) AS amt,
              ROW_NUMBER() OVER (PARTITION BY so.member_id ORDER BY SUM(si.line_amount) DESC) AS rn
         FROM sale_items si
         JOIN sales_orders so ON so.id = si.order_id AND so.status='已完成' AND so.store_id=$1
           AND so.created_at >= CURRENT_DATE - 180
         JOIN products p ON p.id = si.product_id
         JOIN categories c ON c.id = p.category_id
        WHERE so.member_id IS NOT NULL AND p.category_id IS NOT NULL
        GROUP BY so.member_id, p.category_id, c.name`, [u.storeId]);

    const favByMember = new Map<number, any[]>();
    for (const f of fav as any[]) {
      if (Number(f.rn) > 3) continue;
      const list = favByMember.get(Number(f.member_id)) || [];
      list.push({ categoryId: Number(f.category_id), name: String(f.cat), amt: Number(f.amt) });
      favByMember.set(Number(f.member_id), list);
    }

    // 3) 落库（全量重算：清空 → 写入）
    await q(`DELETE FROM member_profiles WHERE store_id=$1`, [u.storeId]);
    const t0 = Date.now();
    let n = 0;
    for (const r of agg as any[]) {
      const memberId = Number(r.member_id);
      const lifecycle = lifecycleOf(r.last_at, r.first_at);
      const months = Math.max(1, Math.ceil((Date.now() - new Date(r.first_at).getTime()) / (30 * 86400000)));
      const freq = Number(r.orders) / months;
      const f = favByMember.get(memberId) || [];
      const tags = [
        { k: 'lifecycle', v: lifecycle },
        { k: 'tier', v: Number(r.tier) === 1 ? '高贡献' : Number(r.tier) === 2 ? '中贡献' : '低贡献' },
        { k: 'freq', v: freq >= 4 ? '高频' : freq >= 2 ? '中频' : '低频' },
        ...f.slice(0, 3).map((x, i) => ({ k: `fav${i + 1}`, v: x.name })),
      ];
      const profile = {
        totalAmount: Number(r.amt), orderCount: Number(r.orders),
        avgOrder: Number(r.orders) ? Number(r.amt) / Number(r.orders) : 0,
        firstBuyAt: r.first_at, lastBuyAt: r.last_at, months, monthlyFreq: freq,
        favCategories: f,
      };
      await q(
        `INSERT INTO member_profiles (member_id, store_id, tags, profile, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (member_id) DO UPDATE SET tags=$3, profile=$4, updated_at=now()`,
        [memberId, u.storeId, JSON.stringify(tags), JSON.stringify(profile)]);
      n++;
    }
    await audit(u.storeId, u.sub, 'AI', 'member.profile.refresh', 'member_profile', undefined,
      { count: n, ms: Date.now() - t0 });
    return { ok: true, count: n, ms: Date.now() - t0 };
  }

  /** 画像列表（keyword 姓名/电话 · tag 标签值筛选） */
  @RequirePerms('member.info.view')
  @Get('list')
  async list(@Query() qp: { keyword?: string; tag?: string; page?: string; size?: string }, @CurrentUser() user: AuthUser) {
    const kw = (qp.keyword || '').trim();
    const tag = (qp.tag || '').trim();
    const size = Math.min(100, Number(qp.size || 50));
    const off = (Math.max(1, Number(qp.page || 1)) - 1) * size;
    const rows = await q(
      `SELECT mp.member_id, mp.tags, mp.profile, mp.updated_at,
              m.name, m.phone, ml.name AS level_name
         FROM member_profiles mp
         JOIN members m ON m.id = mp.member_id AND m.deleted_at IS NULL
         LEFT JOIN member_levels ml ON ml.id = m.level_id
        WHERE mp.store_id=$1
          AND ($2 = '' OR m.name ILIKE '%'||$2||'%' OR m.phone ILIKE '%'||$2||'%')
          AND ($3 = '' OR mp.tags @> $3::jsonb)
        ORDER BY (mp.profile->>'totalAmount')::numeric DESC
        LIMIT $4 OFFSET $5`,
      [user.storeId, kw, tag ? JSON.stringify([{ k: 'lifecycle', v: tag }]) : '', size, off]);
    const total = await q(
      `SELECT COUNT(*)::int AS n FROM member_profiles mp
        WHERE mp.store_id=$1 AND ($2='' OR mp.tags @> $2::jsonb)`, [user.storeId, tag ? JSON.stringify([{ k: 'lifecycle', v: tag }]) : '']);
    return { total: total[0]?.n ?? 0, page: Number(qp.page || 1), items: rows };
  }

  /** 单会员画像（含近10笔订单） */
  @RequirePerms('member.info.view')
  @Get(':id')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const memberId = Number(id);
    const mp = await q(
      `SELECT mp.member_id, mp.tags, mp.profile, mp.updated_at, m.name, m.phone, m.created_at
         FROM member_profiles mp JOIN members m ON m.id = mp.member_id
        WHERE mp.member_id=$1 AND mp.store_id=$2`, [memberId, user.storeId]);
    if (!mp.length) return { memberId, profile: null as any, orders: [] as any[] };
    const orders = await q(
      `SELECT order_no, payable_amount, created_at, channel FROM sales_orders
        WHERE member_id=$1 AND status='已完成' ORDER BY created_at DESC LIMIT 10`, [memberId]);
    return { memberId, name: mp[0].name, phone: mp[0].phone, joinedAt: mp[0].created_at,
             tags: mp[0].tags, profile: mp[0].profile, updatedAt: mp[0].updated_at, orders };
  }
}
