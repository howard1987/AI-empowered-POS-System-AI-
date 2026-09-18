/**
 * 智能决策中心（9.8 五步闭环）HTTP 层：
 *   - 路由：学习资产看板 / 建议闭环（执行·否决·效果回收） / 9 项应用手动运行 / 自然语言问答 / 知识库
 *   - 定时：进程内 setInterval 每分钟检查，到达 ai.restock.time(06:00) 且当日未跑则全量刷新 8 项；
 *           ai.daily_report.time(23:59) 后自动生成当日 AI 日报（幂等：已存在则跳过）
 *   - 执行补货建议 = 生成采购单（source='补货建议'，建议 #ID 留痕 suggest_meta）；营销推送仅标记（发送权在人）
 *   - 权限：生成/执行/知识库管理 = ai.decision；问答/看板/建议列表 = 登录可见
 */
import { Controller, Get, Injectable, Module, OnModuleInit, Param, Post, Body, Delete, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q, q1, r2, tx, cx, audit } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { AibrainEngine } from './aibrain.engine';
import { getWeather } from './weather.service';

@Injectable()
export class AibrainService implements OnModuleInit {
  private timer: NodeJS.Timeout | null = null;

  onModuleInit() {
    this.timer = setInterval(() => { this.maybeRun().catch(e => console.error('[决策中心] 定时执行失败:', e.message)); }, 60_000);
    this.maybeRun().catch(e => console.error('[决策中心] 启动执行失败:', e.message));
  }

  async setting(key: string, fb: any = null): Promise<any> {
    const r = await q1<{ value: any }>(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
    return r ? r.value : fb;
  }

  private fmtD(v: any): string {
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    return String(v).slice(0, 10);
  }

  private async maybeRun() {
    if (!Boolean(await this.setting('ai.decision.enabled', true))) return;
    const now = new Date();
    const reach = async (key: string, fb: string): Promise<boolean> => {
      const t = String(await this.setting(key, fb) ?? fb);
      const [hh, mm] = t.split(':').map(Number);
      return now.getHours() * 60 + now.getMinutes() >= (hh || 0) * 60 + (mm || 0);
    };
    // 06:00 全量刷新：8 项应用一次闭环（当日去重，ai.last_refresh 为标记）
    if (await reach('ai.restock.time', '06:00')) {
      const last = await this.setting('ai.last_refresh', null);
      if (last !== this.fmtD(now)) await AibrainEngine.refresh(1);
    }
    // 23:59 AI 日报（引擎内已按标题幂等）
    if (await reach('ai.daily_report.time', '23:59')) {
      await AibrainEngine.dailyReport(1);
    }
  }
}

@Controller('brain')
export class AibrainController {
  constructor(private readonly svc: AibrainService) {}

  /** 学习资产看板：MAE / 未来 7 天预测 / 建议闭环统计 / 采纳率 / 知识库 / 识别纠正率 */
  @Get('overview')
  async overview(@CurrentUser() u: AuthUser) {
    return AibrainEngine.overview(u.storeId);
  }

  /** 建议列表（分页 + 域/状态筛选） */
  @Get('suggestions')
  async suggestions(@Query() qp: { domain?: string; status?: string; page?: string; size?: string }) {
    const pn = Math.max(1, Number(qp.page) || 1);
    const sz = Math.min(100, Math.max(1, Number(qp.size) || 20));
    const where = `WHERE s.store_id=${curStore()}
        AND ($1::text IS NULL OR s.domain=$1::suggestion_domain_t)
        AND ($2::text IS NULL OR s.status=$2::suggestion_status_t)`;
    const rows = await q(
      `SELECT s.id, s.domain, s.payload, s.reason, s.confidence, s.biz_ref_type, s.biz_ref_id,
              s.status, s.reject_reason, s.effect, s.created_at, s.decided_at, e.name AS decided_by_name,
              s.auto_executed AS "autoExecuted",
              (s.rollback_json IS NOT NULL AND s.rolled_back_at IS NULL) AS "canRollback",
              s.rolled_back_at AS "rolledBackAt"
         FROM ai_suggestions s LEFT JOIN employees e ON e.id=s.decided_by ${where}
        ORDER BY s.id DESC LIMIT $4 OFFSET $3`,
      [qp.domain || null, qp.status || null, (pn - 1) * sz, sz]);
    const cnt = await q1<{ n: string }>(`SELECT count(*) AS n FROM ai_suggestions s ${where}`,
      [qp.domain || null, qp.status || null]);
    return { items: rows, total: Number(cnt?.n ?? 0), page: pn, size: sz };
  }

  /** 全量刷新：8 项应用一次闭环（补货/推送/预测/定价/损耗/关联/防损/效果回收） */
  @Post('refresh')
  @RequirePerms('ai.decision')
  async refresh(@CurrentUser() u: AuthUser) {
    const out = await AibrainEngine.refresh(u.storeId);
    await audit(u.storeId, u.sub, 'AI', 'brain.refresh', null, null, out);
    return out;
  }

  /** 单应用运行：restock / memberTouch / forecast / pricing / expiryLoss / assocRules / fraudBaseline / effectRecovery / dailyReport */
  @Post('run/:app')
  @RequirePerms('ai.decision')
  async runApp(@Param('app') app: string, @CurrentUser() u: AuthUser) {
    const map: Record<string, () => Promise<any>> = {
      restock: () => AibrainEngine.restock(u.storeId),
      memberTouch: () => AibrainEngine.memberTouch(u.storeId),
      forecast: () => AibrainEngine.forecast(u.storeId),
      pricing: () => AibrainEngine.pricing(u.storeId),
      expiryLoss: () => AibrainEngine.expiryLoss(u.storeId),
      assocRules: () => AibrainEngine.assocRules(u.storeId),
      fraudBaseline: () => AibrainEngine.fraudBaseline(u.storeId),
      effectRecovery: () => AibrainEngine.effectRecovery(u.storeId),
      assortment: () => AibrainEngine.assortment(u.storeId),
      holidayStock: () => AibrainEngine.holidayStock(u.storeId),
      weatherStock: () => AibrainEngine.weatherStock(u.storeId),
      memberPortraits: () => AibrainEngine.memberPortraits(u.storeId),
      weatherSediment: () => AibrainEngine.weatherSediment(u.storeId),
      weatherCalibrate: () => AibrainEngine.weatherCalibrate(u.storeId),
      memberMarketing: () => AibrainEngine.memberMarketing(u.storeId),
      dailyReport: () => AibrainEngine.dailyReport(u.storeId),
    };
    const fn = map[app];
    if (!fn) throw new BizException(40003, '未知应用: ' + app);
    const out = await fn();
    await audit(u.storeId, u.sub, 'AI', 'brain.run', null, null, { app, ...out });
    return out;
  }

  /** 生成 AI 日报（默认今天；已存在则幂等返回） */
  @Post('daily-report')
  @RequirePerms('ai.decision')
  async dailyReport(@Body() b: { date?: string }, @CurrentUser() u: AuthUser) {
    const out = await AibrainEngine.dailyReport(u.storeId, b?.date || undefined);
    await audit(u.storeId, u.sub, 'AI', 'brain.daily_report', null, null, out);
    return out;
  }

  /** 自然语言经营问答（关键词路由 → SQL → 文本；Ollama 可选增强，失败自动降级） */
  @Post('qa')
  async qa(@Body() b: { question: string }, @CurrentUser() u: AuthUser) {
    return AibrainEngine.qa(u.storeId, b?.question || '');
  }

  /** P9 智能对账体检：支付渠道对账差异 + 进销存账实差异（批次 vs 现存量）→ 人话解读 */
  @Post('recon-insight')
  async reconInsight(@CurrentUser() u: AuthUser) {
    return AibrainEngine.reconInsight(u.storeId);
  }

  /** V4.16.1 天气因素：本地天气预报 + 经营提示（天气卡展示用；失败降级缓存，不抛错） */
  @Get('weather')
  async weather() {
    return getWeather(1);
  }

  /** V4.16.3 会员 AI 画像：读取单人缓存（无则返回 null，前端提示先生成） */
  @Get('member-portraits/:memberId')
  @RequirePerms('ai.decision')
  async memberPortraitOne(@Param('memberId') memberId: string, @CurrentUser() u: AuthUser) {
    return AibrainEngine.memberPortraitOne(u.storeId, Number(memberId));
  }

  /** V4.16.3 会员 AI 画像：批量生成（近 180 天消费 TOP N；Ollama 开启则人话建模） */
  @Post('member-portraits')
  @RequirePerms('ai.decision')
  async memberPortraits(@CurrentUser() u: AuthUser) {
    const out = await AibrainEngine.memberPortraits(u.storeId);
    await audit(u.storeId, u.sub, 'AI', 'brain.member_portraits', null, null, { count: out.count, engine: out.engine });
    return out;
  }

  /** V4.16.5 会员画像营销引擎消费：画像分群 → 可执行营销清单（流失唤醒/高价值维护/价格敏感推送） */
  @Post('member-marketing')
  @RequirePerms('ai.decision')
  async memberMarketing(@CurrentUser() u: AuthUser) {
    const out = await AibrainEngine.memberMarketing(u.storeId);
    await audit(u.storeId, u.sub, 'AI', 'brain.member_marketing', null, null, { count: out.count });
    return out;
  }

  /** V4.16.5 节日表一键联网更新（公历+农历法定节日，当年+次年；失败返回 note 不抛错） */
  @Post('holidays/sync')
  @RequirePerms('ai.decision')
  async holidaysSync(@CurrentUser() u: AuthUser) {
    const out = await AibrainEngine.holidaySyncNet(u.storeId);
    await audit(u.storeId, u.sub, 'AI', 'brain.holidays_sync', null, null, { fetched: out.fetched, merged: out.merged });
    return out;
  }

  /** V4.16.5 天气-销量回归：手动沉淀+校准（每日刷新自动做；此端点供设置页「立即校准」） */
  @Post('weather-calibrate')
  @RequirePerms('ai.decision')
  async weatherCalibrate(@CurrentUser() u: AuthUser) {
    const sed = await AibrainEngine.weatherSediment(u.storeId);
    const out = await AibrainEngine.weatherCalibrate(u.storeId);
    return { ...out, sedimentDays: sed.days };
  }

  /** 预置问题清单（V4.13 ④：老板端一键问，直接命中 qa 关键词路由；一天工作量，体验立竿见影） */
  @Get('qa/presets')
  async qaPresets() {
    return { items: [
      { icon: '💰', q: '今天毛利多少？' },
      { icon: '📈', q: '今天销售额多少？' },
      { icon: '🌦', q: '今天天气怎么样？' },
      { icon: '🔥', q: '近7天热销排行？' },
      { icon: '📦', q: '哪些商品缺货？' },
      { icon: '⏰', q: '15天内临期批次有哪些？' },
      { icon: '↩️', q: '今天退款情况？' },
      { icon: '👥', q: '会员新增情况？' },
      { icon: '🛒', q: '待处理补货建议？' },
      { icon: '📰', q: '今天的日报摘要' },
    ] };
  }

  /** 执行建议（P7：逻辑收敛到引擎 executeSuggestion——人工与全自动共用，含回滚快照）：
   *  补货 → 生成采购单（source=补货建议）；定价 → 按确认价真改售价。
   *  V4.15.1：body 可带 payload 覆盖（用户在明细弹窗改过数量/实际价/删过行）与 learning 摘要（写入知识库学习）。 */
  @Post('suggestions/:id/execute')
  @RequirePerms('ai.decision')
  async execute(
    @Param('id') id: string,
    @Body() b: { payload?: any; learning?: { title?: string; content?: string } },
    @CurrentUser() u: AuthUser,
  ) {
    const out = await AibrainEngine.executeSuggestion(u.storeId, Number(id), u.sub, b?.payload, b?.learning);
    await audit(u.storeId, u.sub, 'AI', 'brain.suggest.execute', 'ai_suggestion', Number(id),
      { note: out.note, bizRefId: out.bizRefId });
    return out;
  }

  /** P7 决策自动化：执行后一键回滚（定价→还原原价；补货→取消未到货采购单） */
  @Post('suggestions/:id/rollback')
  @RequirePerms('ai.decision')
  async rollback(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return AibrainEngine.rollbackSuggestion(u.storeId, Number(id), u.sub);
  }

  /** P7 决策自动化：分域采纳率成熟度（解锁全自动的依据）+ 当前三档开关 */
  @Get('maturity')
  async maturity(@CurrentUser() u: AuthUser) {
    const modes = (await AibrainEngine.maturity(u.storeId)) as any;
    const modesCfg = await this.svc.setting('ai.decision.modes', { '定价': '手动确认', '补货': '手动确认' });
    return { ...modes, modes: modesCfg ?? {} };
  }

  /** 否决建议：原因留痕（训练信号，供再训练） */
  @Post('suggestions/:id/reject')
  @RequirePerms('ai.decision')
  async reject(@Param('id') id: string, @Body() b: { reason?: string }, @CurrentUser() u: AuthUser) {
    const reason = (b?.reason || '').trim().slice(0, 128);
    const r = await q(
      `UPDATE ai_suggestions SET status='已否决', decided_by=$2, decided_at=now(), reject_reason=$3
        WHERE id=$1 AND status='待处理' RETURNING id, domain`, [id, u.sub, reason || null]);
    if (!r.length) {
      const s = await q1(`SELECT status FROM ai_suggestions WHERE id=$1`, [id]);
      throw new BizException(s ? 40003 : 40404, s ? `建议已${s.status}` : '建议不存在', s ? 400 : 404);
    }
    await audit(u.storeId, u.sub, 'AI', 'brain.suggest.reject', 'ai_suggestion', Number(id),
      { domain: r[0].domain, reason });
    return { ok: true };
  }

  /** 知识库文档列表 */
  @Get('kb')
  async kb() {
    return q(`SELECT id, title, source_type, status, LEFT(content_text, 120) AS preview, created_at
               FROM ai_kb_documents WHERE store_id=${curStore()} ORDER BY id DESC LIMIT 100`);
  }

  /** 知识库入库（标题 + 文本，自动切块） */
  @Post('kb')
  @RequirePerms('ai.decision')
  async kbAdd(@Body() b: { title: string; content: string }, @CurrentUser() u: AuthUser) {
    const title = (b?.title || '').trim();
    const content = (b?.content || '').trim();
    if (!title || !content) throw new BizException(40003, '标题与内容不能为空');
    const r = await q(
      `INSERT INTO ai_kb_documents (store_id, title, source_type, content_text, status)
       VALUES ($1,$2,'上传',$3,'已收录') RETURNING id`, [u.storeId, title.slice(0, 128), content]);
    for (let i = 0, no = 1; i < content.length; i += 500, no++) {
      await q(`INSERT INTO ai_kb_chunks (document_id, chunk_no, content) VALUES ($1,$2,$3)
               ON CONFLICT (document_id, chunk_no) DO NOTHING`, [Number(r[0].id), no, content.slice(i, i + 500)]);
    }
    await audit(u.storeId, u.sub, 'AI', 'brain.kb.add', 'ai_kb_document', Number(r[0].id), { title });
    return { ok: true, id: Number(r[0].id) };
  }

  /** 删除知识库文档 */
  @Delete('kb/:id')
  @RequirePerms('ai.decision')
  async kbDel(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    const r = await q(`DELETE FROM ai_kb_documents WHERE id=$1 AND store_id=$2 RETURNING id`, [id, u.storeId]);
    if (!r.length) throw new BizException(40404, '文档不存在', 404);
    await audit(u.storeId, u.sub, 'AI', 'brain.kb.delete', 'ai_kb_document', Number(id), {});
    return { ok: true };
  }

  /** Ollama 连通性检查（设置页展示用） */
  @Get('llm/check')
  async llmCheck() {
    const enabled = Boolean(await this.svc.setting('ai.llm.enabled', false));
    if (!enabled) return { enabled: false, reachable: false, reason: '本地大模型(Ollama)开关未开启，可在 设置-系统设置 打开' };
    const base = String(await this.svc.setting('ai.llm.base', 'http://localhost:11434'));
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { enabled, reachable: false, reason: `Ollama 返回 HTTP ${res.status}` };
      const j: any = await res.json();
      return { enabled, reachable: true, models: (j?.models ?? []).map((m: any) => m.name) };
    } catch {
      return { enabled, reachable: false, reason: `Ollama 服务不可达（${base}）` };
    }
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

@Module({ controllers: [AibrainController], providers: [AibrainService] })
export class AibrainModule {}
