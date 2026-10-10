/**
 * V4.13 · 漏扫检测 MVP（能力全景 1.2 缺口：自助收银可信化的前提，数据与组件全现成）
 *   校验一（件数一致性）：AI 识别逐件 count vs 结算清单件数 —— 缺件即差异（宽松模式仅缺 ≥2 拦截）
 *   校验二（重量一致性）：称重商品理论重量（结算 qty，kg）vs 实秤重量 —— 超 antileak.weight.tolerance 即差异
 *   POST /antileak/verify            —— 通用校验（PWA 收银端 AI 加购后提示用；决策权在人，不拦单）
 *   GET  /antileak/alerts            —— 自助收银差异告警列表
 *   POST /antileak/alerts/:id/handle —— 复核处置（已放行/已拦截，留痕）
 *   自助收银挂接：member-app self-checkout 内联校验（enabled 时），差异即 41001 暂停待店员复核；
 *                 force=true 可强推但必落 antileak_alerts 待复核（老板端可见）
 */
import { Controller, Get, Post, Param, Body, Module, Injectable, Query } from '@nestjs/common';
import { q, q1, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { sizeOf, pageOf } from '../common/paging';   // V5.0.19i（Q-07）

export interface VerifyItem { productId: number; qty: number; }
export interface VerifyInput {
  items: VerifyItem[];
  aiItems?: { productId: number; count: number }[];
  weightKg?: Record<string, number>;
}
export interface VerifyResult { ok: boolean; diffs: { kind: '件数差异' | '重量差异'; productId: number; name: string; expected: number; actual: number; delta: number; note: string }[]; }

@Injectable()
export class AntileakService {
  private async setting(key: string, fb: any): Promise<any> {
    const r = await q1(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
    return r ? r.value : fb;
  }

  async verify(storeId: number, input: VerifyInput): Promise<VerifyResult> {
    const strict = Boolean(await this.setting('antileak.count.strict', true));
    const tol = Number(await this.setting('antileak.weight.tolerance', 0.05) ?? 0.05);
    const diffs: VerifyResult['diffs'] = [];
    const items = (input.items || []).filter(i => Number(i.productId) > 0 && Number(i.qty) > 0);
    const byPid = new Map<number, number>();
    for (const it of items) byPid.set(Number(it.productId), (byPid.get(Number(it.productId)) ?? 0) + Number(it.qty));

    // ── 校验一：AI 识别件数 vs 结算件数（只对非称重件） ──
    if (Array.isArray(input.aiItems) && input.aiItems.length) {
      const ids = [...new Set([...input.aiItems.map(a => Number(a.productId)), ...byPid.keys()])];
      const prods = await q<any>(`SELECT id, name, is_weighted FROM products WHERE id = ANY($1::bigint[])`, [ids]);
      const pmap = new Map(prods.map(p => [Number(p.id), p]));
      for (const ai of input.aiItems) {
        const pid = Number(ai.productId);
        const p = pmap.get(pid);
        if (!p || p.is_weighted) continue;                 // 称重件走重量校验
        const expected = Math.round(Number(ai.count));
        const actual = Math.round(byPid.get(pid) ?? 0);
        const delta = expected - actual;                    // >0 = 结算比识别少（疑似漏扫）
        const bad = strict ? delta > 0 : delta >= 2;
        if (bad) diffs.push({ kind: '件数差异', productId: pid, name: p.name, expected, actual,
          delta, note: `AI 识别 ${expected} 件，结算 ${actual} 件${delta > 0 ? '，有漏扫嫌疑' : '（宽松模式不拦）'}` });
      }
    }

    // ── 校验二：称重商品理论重量 vs 实秤重量 ──
    if (input.weightKg && Object.keys(input.weightKg).length) {
      const wIds = [...byPid.keys()].filter(pid => input.weightKg![String(pid)] != null);
      if (wIds.length) {
        const prods = await q<any>(`SELECT id, name, is_weighted FROM products WHERE id = ANY($1::bigint[])`, [wIds]);
        for (const p of prods) {
          if (!p.is_weighted) continue;
          const pid = Number(p.id);
          const expected = byPid.get(pid) ?? 0;
          const actual = Number(input.weightKg[String(pid)]);
          const delta = Math.abs(expected - actual);
          if (delta > tol) diffs.push({ kind: '重量差异', productId: pid, name: p.name,
            expected: Math.round(expected * 1000) / 1000, actual: Math.round(actual * 1000) / 1000,
            delta: Math.round(delta * 1000) / 1000, note: `理论重 ${expected.toFixed(3)}kg，实秤 ${actual.toFixed(3)}kg，超容差 ${tol}kg` });
        }
      }
    }
    return { ok: diffs.length === 0, diffs };
  }

  /** 自助收银告警落库 */
  async alert(storeId: number, memberId: number | null, result: VerifyResult, autoStatus: '待复核' | '已拦截'): Promise<number> {
    const ins = await q(
      `INSERT INTO antileak_alerts (store_id, member_id, kind, detail, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [storeId, memberId, result.diffs[0]?.kind ?? '件数差异', JSON.stringify(result), autoStatus]);
    return Number(ins[0].id);
  }
}

@Controller('antileak')
export class AntileakController {
  constructor(private readonly svc: AntileakService) {}

  /** 通用校验（店员端 informational：差异仅提示，不拦单） */
  @Post('verify')
  async verify(@Body() b: VerifyInput, @CurrentUser() u: AuthUser) {
    return this.svc.verify(u.storeId, { items: b.items || [], aiItems: b.aiItems, weightKg: b.weightKg });
  }

  /** 告警列表（待复核优先） */
  @Get('alerts')
  @RequirePerms('sys.settings')
  async alerts(@CurrentUser() u: AuthUser, @Query('page') page?: string, @Query('size') size?: string) {
    const pageSize = sizeOf(size, 50, 200);   // V5.0.19i（Q-07）
    const pg = pageOf(page);
    const tot = await q1(`SELECT count(*)::int AS n FROM antileak_alerts WHERE store_id=$1`, [u.storeId]);
    const rows = await q(
      `SELECT a.*, m.name AS member_name, m.phone AS member_phone
         FROM antileak_alerts a LEFT JOIN members m ON m.id=a.member_id
        WHERE a.store_id=$1 ORDER BY (a.status='待复核') DESC, a.id DESC LIMIT $2 OFFSET $3`,
      [u.storeId, pageSize, (pg - 1) * pageSize]);
    return { items: rows.map(r => ({ ...r, id: Number(r.id), detail: r.detail })),
             total: Number(tot?.n || 0), page: pg, size: pageSize };
  }

  /** 复核处置 */
  @Post('alerts/:id/handle')
  @RequirePerms('sys.settings')
  async handle(@Param('id') id: string, @Body() b: { status?: string; note?: string }, @CurrentUser() u: AuthUser) {
    const status = ['已放行', '已拦截'].includes(b?.status || '') ? b!.status! : '';
    if (!status) throw new BizException(40003, 'status 必须为 已放行 或 已拦截');
    const r = await q(`UPDATE antileak_alerts SET status=$2, handled_by=$3, handled_at=now() WHERE id=$1 AND store_id=$4 RETURNING id`, [id, status, u.sub, u.storeId]);
    if (!r.length) throw new BizException(40404, '告警不存在', 404);
    await audit(u.storeId, u.sub, '防损', 'antileak.alert.handle', 'antileak_alert', Number(id), { status, note: b?.note ?? null });
    return { ok: true };
  }
}

@Module({ controllers: [AntileakController], providers: [AntileakService] })
export class AiAntileakModule {}
