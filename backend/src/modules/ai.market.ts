/**
 * M4c · 个性化营销（画像驱动的定向促销方案 + 触达执行 + 效果回测）
 *   POST /ai/marketing/generate —— 按会员画像生成定向方案（沉睡唤醒/高价值回馈/偏好品类满减）
 *   POST /ai/marketing/execute  —— 执行方案 → 批量写入 marketing_touches（站内信，会员端可见）
 *   GET  /ai/marketing/effects  —— 效果回测：触达前后目标人群消费对比 + 处理率
 *   规则引擎（零依赖）：方案为"建议"，执行权在人（ai.decision 权限）
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q, audit } from '../common/db';
import { curStore, curEmp } from '../common/context';

const tagOf = (tags: any[], k: string): string => {
  const t = (tags || []).find((x: any) => x.k === k);
  return t ? String(t.v) : '';
};

@Controller('ai/marketing')
export class AiMarketController {
  /** 生成定向促销方案（按画像人群分组，固定模板 + 数据参数） */
  @Post('generate')
  @RequirePerms('ai.decision')
  async generate(@CurrentUser() u: AuthUser) {
    const prof = await q(`SELECT member_id, tags, profile FROM member_profiles WHERE store_id=$1`, [u.storeId]);
    const members = (prof as any[]).map(p => ({
      id: Number(p.member_id), tags: p.tags, profile: p.profile,
      lifecycle: tagOf(p.tags, 'lifecycle'), tier: tagOf(p.tags, 'tier'),
      fav1: tagOf(p.tags, 'fav1'), fav2: tagOf(p.tags, 'fav2'), fav3: tagOf(p.tags, 'fav3'),
      total: Number(p.profile?.totalAmount ?? 0), orders: Number(p.profile?.orderCount ?? 0),
    }));

    const plans: any[] = [];
    // 方案1：沉睡/流失唤醒（满减券）
    const sleepers = members.filter(m => m.lifecycle === '沉睡' || m.lifecycle === '流失');
    if (sleepers.length) {
      const avgAmt = sleepers.reduce((s, m) => s + m.total, 0) / sleepers.length;
      plans.push({
        type: 'wake', title: '沉睡会员唤醒券（满 50 减 8）',
        targetTag: '生命周期=沉睡/流失', targetCount: sleepers.length,
        content: '您有段时间没来啦，专属满 50 减 8 优惠券已到账，期待光临！',
        estimateCost: Math.round(sleepers.length * 0.2 * 8 * 100) / 100,
        expectedIncrement: Math.round(sleepers.length * 0.2 * Math.max(avgAmt, 50) * 100) / 100,
        basis: `目标 ${sleepers.length} 人，近90天无消费，按 20% 核销估算`,
      });
    }
    // 方案2：高贡献回馈（9 折券 满100可用）
    const vip = members.filter(m => m.tier === '高贡献');
    if (vip.length) {
      plans.push({
        type: 'vip', title: '高贡献会员回馈（9 折券，满 100 可用）',
        targetTag: '贡献度=高贡献', targetCount: vip.length,
        content: '感谢长期支持，为您发放 9 折专属券（满 100 可用）！',
        estimateCost: Math.round(vip.length * 0.3 * 10 * 100) / 100,
        expectedIncrement: Math.round(vip.length * 0.3 * 150 * 100) / 100,
        basis: `高贡献 ${vip.length} 人（贡献度前 1/3），按 30% 核销、人均增量 ¥150 估算`,
      });
    }
    // 方案3：偏好品类满减（TOP1 品类人群 满 30 减 5）
    const favGroups = new Map<string, any[]>();
    for (const m of members) if (m.fav1) {
      const g = favGroups.get(m.fav1) || [];
      g.push(m); favGroups.set(m.fav1, g);
    }
    const topFav = [...favGroups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (topFav && topFav[1].length >= 5) {
      plans.push({
        type: 'fav', title: `${topFav[0]} 品类满减（满 30 减 5）`,
        targetTag: `偏好=${topFav[0]}`, targetCount: topFav[1].length,
        content: `您常购的「${topFav[0]}」满 30 减 5，快去看看吧！`,
        estimateCost: Math.round(topFav[1].length * 0.25 * 5 * 100) / 100,
        expectedIncrement: Math.round(topFav[1].length * 0.25 * 40 * 100) / 100,
        basis: `偏好「${topFav[0]}」会员 ${topFav[1].length} 人，按 25% 核销估算`,
      });
    }
    if (!plans.length) plans.push({ type: 'none', title: '暂无可用画像人群', targetCount: 0,
      content: '先到「会员画像」重算画像，再生成营销方案', estimateCost: 0, expectedIncrement: 0 });
    return { count: plans.length, plans };
  }

  /** 执行方案：批量写 marketing_touches（站内信；每会员一条，上限 200） */
  @Post('execute')
  @RequirePerms('ai.decision')
  async execute(@Body() b: { plan: any }, @CurrentUser() u: AuthUser) {
    const plan = b?.plan;
    // P2：内容限长（标题 ≤60 / 正文 ≤500 / 跳转 ≤2KB），防超长注入拖垮会员端渲染
    if (plan) {
      if (typeof plan.title === 'string') plan.title = plan.title.slice(0, 60);
      if (typeof plan.content === 'string') plan.content = plan.content.slice(0, 500);
      if (typeof plan.payload === 'string') plan.payload = plan.payload.slice(0, 2048);
    }
    if (!plan || !plan.type || plan.type === 'none') throw new BizException(40003, '请选择有效方案');
    const tagK = plan.type === 'vip' ? 'tier' : plan.type === 'fav' ? 'fav1' : 'lifecycle';
    const tagV = plan.type === 'vip' ? '高贡献' : plan.type === 'fav' ? plan.targetTag?.replace('偏好=', '') : null;
    const members = await q(
      `SELECT member_id FROM member_profiles WHERE store_id=$1
         AND tags @> $2::jsonb ORDER BY (profile->>'totalAmount')::numeric DESC LIMIT 200`,
      [u.storeId, JSON.stringify(tagV ? [{ k: tagK, v: tagV }] : [{ k: tagK, v: '沉睡' }, { k: tagK, v: '流失' }])]);
    if (!members.length) throw new BizException(40004, '该方案暂无匹配人群');
    const rule = await q(`SELECT id FROM marketing_rules WHERE store_id=$1 AND rule_key='wake' LIMIT 1`, [u.storeId]);
    const ruleId = rule.length ? rule[0].id : null;
    let n = 0;
    for (const m of members) {
      await q(
        `INSERT INTO marketing_touches (store_id, rule_id, member_id, touch_type, title, content, payload, status, channel)
         VALUES (${curStore()},$1,$2,$3,$4,$5,$6,'待处理','站内信')`,
        [ruleId, Number(m.member_id), plan.type, plan.title, plan.content, JSON.stringify(plan)]);
      n++;
    }
    await audit(u.storeId, u.sub, 'AI', 'ai.marketing.execute', 'marketing_touch', undefined,
      { type: plan.type, count: n });
    return { ok: true, touchType: plan.type, count: n, note: `已生成 ${n} 条站内信触达（会员端「消息」可见）` };
  }

  /** 效果回测：触达前后 7 天目标人群消费对比 + 处理率 */
  @Get('effects')
  async effects() {
    const latest = await q(
      `SELECT DISTINCT ON (touch_type) touch_type, member_id, created_at AS t
         FROM marketing_touches
        WHERE store_id=${curStore()} AND member_id IS NOT NULL
        ORDER BY touch_type, created_at DESC`);
    if (!latest.length) return { items: [] as any[], note: '暂无触达记录（先在营销屏执行方案）' };
    const items: any[] = [];
    for (const l of latest as any[]) {
      const memberIds = latest.filter((x: any) => x.touch_type === l.touch_type).map((x: any) => Number(x.member_id));
      const before = await q(
        `SELECT COALESCE(SUM(payable_amount),0) AS a, COUNT(DISTINCT member_id)::int AS m
           FROM sales_orders WHERE store_id=${curStore()} AND status='已完成'
            AND member_id = ANY($1::bigint[]) AND created_at BETWEEN $2::timestamptz - interval '7 days' AND $2::timestamptz`,
        [memberIds, l.t]);
      const after = await q(
        `SELECT COALESCE(SUM(payable_amount),0) AS a, COUNT(DISTINCT member_id)::int AS m
           FROM sales_orders WHERE store_id=${curStore()} AND status='已完成'
            AND member_id = ANY($1::bigint[]) AND created_at > $2::timestamptz`,
        [memberIds, l.t]);
      const done = await q(
        `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status='已处理')::int AS d
           FROM marketing_touches WHERE store_id=${curStore()} AND touch_type=$1`, [l.touch_type]);
      items.push({
        type: l.touch_type, touchedAt: l.t,
        members: memberIds.length,
        before7d: Number(before[0]?.a ?? 0), beforeBuyers: Number(before[0]?.m ?? 0),
        afterAmt: Number(after[0]?.a ?? 0), afterBuyers: Number(after[0]?.m ?? 0),
        delta: Number(after[0]?.a ?? 0) - Number(before[0]?.a ?? 0),
        touches: Number(done[0]?.n ?? 0), handled: Number(done[0]?.d ?? 0),
      });
    }
    return { items };
  }
}
