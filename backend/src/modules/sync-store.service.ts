/**
 * V5.0.0 连锁 · 门店侧同步引擎（方案 §4.3.2 / §4.4 / §4.7 / §4.8，M4-2~M4-8）
 *
 * 职责（仅当本节点是门店节点 node_role='store' 且已配置 hq_base 时工作；否则完全休眠）：
 *   pushOnce  —— 取 sync_outbox(pending/failed 未到退避点) ≤500 条 → POST /sync/push
 *   pullOnce  —— GET /sync/pull?since=in_version → applyChange 逐条幂等应用 → ack
 *   定时器    —— 60s 一轮 + 结算后事件触发（由业务侧调用 kick()）
 *   退避死信  —— 指数退避 5s→6h，8 次失败转 dead（方案 §4.8）
 *   熔断      —— 连续 3 批失败暂停 30 分钟（防打爆总部）
 *
 * 幂等设计（两条腿）：
 *   上行幂等 —— outbox.idem_key 唯一 + 总部 sync_inbox 二次去重
 *   下行幂等 —— sync_inbox.idem_key('HQ:<version>') 唯一，已应用直接跳过
 *
 * 单店零回归：nodeIdentity() 为 null 或 role='hq' 时，本服务定时器不启动、不做任何 IO。
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { q, q1, tx, cx, audit } from '../common/db';
import { nodeIdentity, resetNodeCache } from '../common/outbox';
import { hlcReceive } from '../common/hlc';
import { settleOfflineCredits } from './member-chain.module';   // P2-1：断网挂账清算（网络恢复后）

/** 指数退避（秒）：5s → 15s → 1m → 5m → 15m → 1h → 6h（方案 §4.8） */
const BACKOFF_SEC = [5, 15, 60, 300, 900, 3600, 21600];
const MAX_RETRY = 8;
const PUSH_LIMIT = 500;
const INTERVAL_MS = 60_000;

/** 下行实体 → 本地表映射（conflict = 幂等键列；strip = 永不落本库的敏感列） */
const DOWN: Record<string, { table: string; conflict: string[]; strip?: string[] }> = {
  stores:               { table: 'stores', conflict: ['id'], strip: ['node_secret', 'node_code', 'sync_enabled'] },
  categories:           { table: 'categories', conflict: ['id'] },
  products:             { table: 'products', conflict: ['id'] },
  suppliers:            { table: 'suppliers', conflict: ['id'] },
  member_levels:        { table: 'member_levels', conflict: ['id'] },
  coupons:              { table: 'coupons', conflict: ['id'] },
  roles:                { table: 'roles', conflict: ['id'] },
  employees:            { table: 'employees', conflict: ['id'] },
  store_products:       { table: 'store_products', conflict: ['store_id', 'product_id'] },
  product_store_prices: { table: 'product_store_prices', conflict: ['store_id', 'product_id'] },
  // store_settings（P2-6）不走通用分支：store_id 须重写为本店（总部库门店 id 与本库不保证一致），见 applyChange 特判
  cross_returns:        { table: 'cross_return_tasks', conflict: ['refund_no'] },   // 批次4B：跨店退货任务（下行落受理店）
};

/** 表列缓存（information_schema 取实际列 → 只落交集列，天然免疫列增删） */
const colCache = new Map<string, Set<string>>();
async function tableCols(c: any, table: string): Promise<Set<string>> {
  let s = colCache.get(table);
  if (s) return s;
  const r = await cx(c, `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table]);
  s = new Set(r.map((x: any) => x.column_name));
  colCache.set(table, s);
  return s;
}

/** 通用幂等 upsert：列取 payload ∩ 实表列（table/conflict 均来自代码白名单，值参数化） */
async function upsertRow(c: any, table: string, conflict: string[], row: any, strip: string[] = []): Promise<void> {
  const cols = await tableCols(c, table);
  if (!cols.size) throw new Error(`表 ${table} 在本库不存在（迁移未跑或版本过旧）`);
  const finalKs = Object.keys(row ?? {}).filter(k => cols.has(k) && !strip.includes(k));
  if (!finalKs.length) throw new Error(`${table} payload 无可落列`);
  const ph = finalKs.map((_, i) => `$${i + 1}`);
  const sets = finalKs.filter(k => !conflict.includes(k)).map(k => `${k}=EXCLUDED.${k}`);
  const sql = `INSERT INTO ${table} (${finalKs.join(',')}) VALUES (${ph.join(',')})
               ON CONFLICT (${conflict.join(',')}) DO ${sets.length ? `UPDATE SET ${sets.join(',')}` : 'NOTHING'}`;
  await c.query(sql, finalKs.map(k => row[k]));
}

@Injectable()
export class SyncStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('sync-store');
  private timer: NodeJS.Timeout | null = null;
  private running = false;                 // 单飞锁：上一轮未完不叠加
  private failStreak = 0;                  // 连续失败计数（熔断用）
  private pausedUntil = 0;                 // 熔断截止时刻
  private kicked = false;                  // 事件触发标记

  /** 全局引用：业务模块（手动 new 风格，不走 DI）经 syncKick() 触发立即上行 */
  private static inst: SyncStoreService | null = null;
  onModuleInit() {
    SyncStoreService.inst = this;
    // 启动 15s 后开始第一轮（等 DB / 迁移就绪），此后每 60s
    setTimeout(() => this.tick(), 15_000);
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); SyncStoreService.inst = null; }

  /** 事件触发（结算/退货/交班后调用）：下一轮 tick 立即执行，不等 60s */
  kick(): void { this.kicked = true; }

  /**
   * 业务模块触发立即同步（fire-and-forget，绝不抛错/不阻塞业务）。
   * 用法：import { syncKick } from './sync-store.service';  结算事务提交后调用 syncKick();
   */
  static kick(): void { try { SyncStoreService.inst?.kick(); } catch { /* 忽略 */ } }

  private async tick(): Promise<void> {
    if (this.running) return;
    try {
      const id = await nodeIdentity();
      // 非门店节点（hq / 未注册 / 未启用 / 未配置总部地址）→ 同步层休眠，零开销
      if (!id || id.role !== 'store' || !id.enabled || !id.hqBase || !id.selfToken) return;
      const now = Date.now();
      if (this.pausedUntil > now && !this.kicked) return;   // 熔断中（事件触发可插队一次）
      this.running = true;
      this.kicked = false;
      await this.pullOnce(id);
      await this.pushOnce(id);
      this.failStreak = 0;
      // P2-1：网络已恢复（pull/push 均成功）→ 清算断网期间的余额挂账（fire-and-forget，有 pending 才发请求）
      settleOfflineCredits().then(r => {
        if (r.settled || r.rejected) this.logger.log(`离线挂账清算：成功 ${r.settled} 笔，拒付 ${r.rejected} 笔`);
      }).catch(() => { /* 清算失败不打断同步轮 */ });
    } catch (e: any) {
      this.failStreak++;
      if (this.failStreak >= 3) {
        this.pausedUntil = Date.now() + 30 * 60_000;        // 熔断 30 分钟（方案 §4.8）
        this.failStreak = 0;
        this.logger.warn(`连续失败已熔断 30 分钟: ${e?.message ?? e}`);
      }
    } finally {
      this.running = false;
    }
  }

  /** 节点鉴权请求头（方案 §4.9：Node token + ts 防重放；P2-2 加一次性 nonce） */
  private headers(id: { nodeCode: string; selfToken: string }): Record<string, string> {
    return {
      'content-type': 'application/json',
      'authorization': `Node ${id.nodeCode}:${id.selfToken}`,
      'x-sync-ts': String(Date.now()),
      'x-sync-nonce': crypto.randomUUID(),
    };
  }

  /** 上行一批（≤500）。失败按退避表推迟；8 次转 dead */
  private async pushOnce(id: NonNullable<Awaited<ReturnType<typeof nodeIdentity>>>): Promise<void> {
    const t0 = Date.now();
    let batch: any[] = [];
    try {
      batch = await q(
        `SELECT id, entity, entity_id, op, payload, biz_ts, seq, hlc_counter, idem_key, retry
           FROM sync_outbox
          WHERE status IN ('pending','failed')
            AND (next_retry_at IS NULL OR next_retry_at <= now())
            AND retry < $1
          ORDER BY seq LIMIT $2`, [MAX_RETRY, PUSH_LIMIT]);
      if (!batch.length) return;

      const body = {
        nodeCode: id.nodeCode,
        batch: batch.map(b => ({
          entity: b.entity, entityId: b.entity_id ? Number(b.entity_id) : null, op: b.op,
          payload: typeof b.payload === 'string' ? JSON.parse(b.payload) : b.payload,
          bizTs: Number(b.biz_ts) || new Date(b.biz_ts).getTime(),
          seq: Number(b.seq), hlcCounter: Number(b.hlc_counter), idemKey: b.idem_key,
        })),
      };
      const res = await fetch(`${id.hqBase!.replace(/\/$/, '')}/sync/push`, {
        method: 'POST', headers: this.headers(id), body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const j: any = await res.json().catch((): any => null);
      const d = j?.data ?? j;
      if (!res.ok || !d) throw new Error(`HTTP ${res.status}`);

      const accepted: string[] = d.accepted ?? [];
      const rejected: { idemKey: string; reason: string }[] = d.rejected ?? [];
      for (const key of accepted) {
        await q(`UPDATE sync_outbox SET status='sent', sent_at=now(), last_error=NULL
                  WHERE idem_key=$1 AND status IN ('pending','failed')`, [key]);
      }
      for (const rj of rejected) {
        await q(`UPDATE sync_outbox SET last_error=$2,
                   retry = retry + 1,
                   next_retry_at = now() + (CASE WHEN retry + 1 >= $3 THEN NULL
                     ELSE make_interval(secs => $4) END),
                   status = CASE WHEN retry + 1 >= $3 THEN 'dead' ELSE 'failed' END
                 WHERE idem_key=$1`, [rj.idemKey, String(rj.reason ?? 'rejected').slice(0, 500), MAX_RETRY,
                   BACKOFF_SEC[Math.min(rejected.length ? 0 : 0, BACKOFF_SEC.length - 1)]]);
      }
      // 网络级失败（HTTP ok 但部分条目没回音）也统一走退避
      const answered = new Set([...accepted, ...rejected.map(r => r.idemKey)]);
      for (const b of batch) {
        if (!answered.has(b.idem_key)) {
          await q(`UPDATE sync_outbox SET last_error='总部未应答',
                     retry = retry + 1,
                     next_retry_at = now() + make_interval(secs => $2),
                     status = CASE WHEN retry + 1 >= $3 THEN 'dead' ELSE 'failed' END
                   WHERE id=$1`, [b.id, BACKOFF_SEC[Math.min(Number(b.retry), BACKOFF_SEC.length - 1)], MAX_RETRY]);
        }
      }
      await q(`INSERT INTO sync_runs (node_code, direction, ended_at, sent, recv, failed, duration_ms, msg)
               VALUES ($1,'push',now(),$2,0,$3,$4,$5)`,
        [id.nodeCode, accepted.length, rejected.length, Date.now() - t0, `共 ${batch.length} 条`]);
    } catch (e: any) {
      // 整批网络失败：全部推迟
      for (const b of batch) {
        await q(`UPDATE sync_outbox SET last_error=$2,
                   retry = retry + 1,
                   next_retry_at = now() + make_interval(secs => $3),
                   status = CASE WHEN retry + 1 >= $4 THEN 'dead' ELSE 'failed' END
                 WHERE id=$1`, [b.id, String(e?.message ?? e).slice(0, 500),
                 BACKOFF_SEC[Math.min(Number(b.retry), BACKOFF_SEC.length - 1)], MAX_RETRY]).catch(() => {});
      }
      await q(`INSERT INTO sync_runs (node_code, direction, ended_at, sent, recv, failed, duration_ms, msg)
               VALUES ($1,'push',now(),0,0,$2,$3,$4)`,
        [id.nodeCode, batch.length, Date.now() - t0, String(e?.message ?? e).slice(0, 300)]).catch(() => {});
      throw e;
    }
  }

  /** 下行拉取与应用（单飞串行；500 条截断则下一轮继续追） */
  private async pullOnce(id: NonNullable<Awaited<ReturnType<typeof nodeIdentity>>>): Promise<void> {
    const t0 = Date.now();
    const node = await q1<any>(`SELECT in_version FROM sync_nodes WHERE node_code=$1 AND is_self`, [id.nodeCode]);
    const since = Number(node?.in_version ?? 0);
    const res = await fetch(`${id.hqBase!.replace(/\/$/, '')}/sync/pull?since=${since}&limit=${PUSH_LIMIT}`, {
      headers: this.headers(id), signal: AbortSignal.timeout(30_000),
    });
    const j: any = await res.json().catch((): any => null);
    const d = j?.data ?? j;
    if (!res.ok || !d) throw new Error(`pull HTTP ${res.status}`);
    const changes: any[] = d.changes ?? [];
    // L-08 修复：水位只推进到「连续成功前缀」——绝不因后续高版本成功而跳过中间失败版本
    // （否则失败版本被永久跳过、主数据静默漂移）。失败版本已落入 sync_inbox(status='failed') 等待重放。
    changes.sort((a: any, b: any) => Number(a.version) - Number(b.version)); // 保证升序，连续前缀才有意义
    let applied = 0, failed = 0;
    let contigVer = since;   // 连续成功前缀水位（一旦出现缺口即停止推进）
    let gap = false;
    for (const ch of changes) {
      const v = Number(ch.version);
      try {
        await this.applyChange(ch);
        applied++;
        if (!gap) contigVer = v;   // 仅未出现缺口时推进；缺口之后的成功不再抬高水位
      } catch (e: any) {
        failed++;
        gap = true;
        await q(`INSERT INTO sync_inbox (from_node, entity, entity_id, op, payload, version, idem_key, status, last_error)
                 VALUES ('HQ',$1,$2,$3,$4::jsonb,$5,$6,'failed',$7)
                 ON CONFLICT (idem_key) DO UPDATE SET last_error=EXCLUDED.last_error, status='failed'`,
          [ch.entity, ch.entityId ?? null, ch.op ?? 'upsert', JSON.stringify(ch.payload ?? {}),
           ch.version, ch.idemKey ?? `HQ:${ch.version}`, String(e?.message ?? e).slice(0, 500)]).catch(() => {});
      }
    }
    if (contigVer > since) {
      await q(`UPDATE sync_nodes SET in_version=$2, last_ok_at=now(), last_seen_at=now()
                WHERE node_code=$1 AND is_self`, [id.nodeCode, contigVer]);
    }
    if (gap && failed > 0) {
      console.warn(`[sync] 下行存在失败版本（${failed} 条）已落入重放队列，水位停在 ${contigVer}（未跳过任何失败版本）；请排查 sync_inbox status='failed'`);
    }
    if (changes.length) {
      await fetch(`${id.hqBase!.replace(/\/$/, '')}/sync/pull/ack`, {
        method: 'POST', headers: this.headers(id),
        body: JSON.stringify({ nodeCode: id.nodeCode, version: contigVer }),  // ack 用连续前缀，HQ 才会重发缺口版本
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {});
      await q(`INSERT INTO sync_runs (node_code, direction, ended_at, sent, recv, failed, duration_ms, msg)
               VALUES ($1,'pull',now(),0,$2,$3,$4,$5)`,
        [id.nodeCode, applied, failed, Date.now() - t0, `since=${since} → ${contigVer}${gap ? ' (缺口:' + failed + ')' : ''}`]).catch(() => {});
    }
  }

  /** 下行应用（幂等：sync_inbox.idem_key 唯一；事务内 hlcReceive 推进时钟） */
  async applyChange(ch: { version: number; entity: string; entityId?: number; op?: string; payload?: any; idemKey?: string; bizPhysical?: number; bizCounter?: number }): Promise<void> {
    const idemKey = ch.idemKey ?? `HQ:${ch.version}`;
    const dup = await q1(`SELECT 1 FROM sync_inbox WHERE idem_key=$1 AND status='applied'`, [idemKey]);
    if (dup) return;
    await tx(async (c: any) => {
      if (ch.entity === 'hq_setting') {
        // 总部级设置下发：仅允许覆盖 scope='hq' 的键（门店级键门店自治）
        const p = ch.payload ?? {};
        const sc = await cx(c, `SELECT scope FROM system_settings WHERE setting_key=$1`, [String(p.key ?? '')]);
        if (sc[0]?.scope !== 'hq') throw new Error(`设置键 ${p.key} 非总部级，拒绝下发覆盖`);
        await c.query(
          `UPDATE system_settings SET value=$2::jsonb, updated_at=now() WHERE setting_key=$1 AND scope='hq'`,
          [String(p.key), JSON.stringify(p.value ?? null)]);
      } else if (ch.entity === 'hq_setting_scope') {
        // ── V4.27.8 设置作用域下发：总部把键重新分类（通用⇄门店级），门店同步分类 ──
        //    store→hq 时同样清本店覆盖值（与总部侧行为一致，防旧覆盖继续生效）
        const p = ch.payload ?? {};
        if (!p.key || !['hq', 'store'].includes(String(p.scope))) throw new Error('hq_setting_scope 下行参数非法');
        await c.query(`UPDATE system_settings SET scope=$2 WHERE setting_key=$1`, [String(p.key), String(p.scope)]);
        if (p.scope === 'hq') {
          const self = await cx(c, `SELECT store_id FROM sync_nodes WHERE is_self LIMIT 1`);
          const sid = Number(self[0]?.store_id ?? 0);
          if (sid) await c.query(`DELETE FROM store_settings WHERE store_id=$1 AND setting_key=$2`, [sid, String(p.key)]);
        }
      } else if (ch.entity === 'store_settings') {
        // ── V5.0.0 P2-6 门店设置下发：payload {key, value}；store_id 重写为本店 ──
        //    delete = 总部清除覆盖（门店回落 system_settings 默认值）；其余值 upsert 本店覆盖行
        const p = ch.payload ?? {};
        if (!p.key) throw new Error('store_settings 下行缺 key');
        const self = await cx(c, `SELECT store_id FROM sync_nodes WHERE is_self LIMIT 1`);
        const sid = Number(self[0]?.store_id ?? 0);
        if (!sid) throw new Error('无法确定本店 store_id（sync_nodes.is_self 无 store_id）');
        if (ch.op === 'delete') {
          await c.query(`DELETE FROM store_settings WHERE store_id=$1 AND setting_key=$2`, [sid, String(p.key)]);
        } else {
          await c.query(
            `INSERT INTO store_settings (store_id, setting_key, value, updated_by, updated_at)
             VALUES ($1,$2,$3::jsonb,0,now())
             ON CONFLICT (store_id, setting_key)
             DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
            [sid, String(p.key), JSON.stringify(p.value ?? null)]);
        }
      } else if (ch.entity === 'promotions') {
        // ── V5.0.0 P2-5 连锁促销投放：总部促销下行落地（幂等键 hq_promo_id，迁移 114）──
        // 不走通用分支的原因：① conflict=['id'] 会用总部 id 覆盖门店自建促销行；② store_id 须重写为本店。
        const p = ch.payload ?? {};
        const hqPid = Number(p.hq_promo_id || 0);
        if (!hqPid) throw new Error('promotions 下行缺 hq_promo_id（总部/门店迁移版本不一致？）');
        const cols = await tableCols(c, 'promotions');
        if (!cols.has('hq_promo_id')) throw new Error('promotions 缺 hq_promo_id 列（迁移 114 未执行）');
        const self = await cx(c, `SELECT store_id FROM sync_nodes WHERE is_self LIMIT 1`);
        const sid = Number(self[0]?.store_id ?? 0);
        if (!sid) throw new Error('无法确定本店 store_id（sync_nodes.is_self 无 store_id）');
        const row: any = { ...p, hq_promo_id: hqPid, store_id: sid };
        delete row.id;
        await upsertRow(c, 'promotions', ['hq_promo_id'], row, []);
      } else if (ch.entity === 'member_mirror') {
        // ── 批次5（M5-3）：会员镜像下行。权威账本在总部，本库 members/member_accounts 按 card_no 覆盖；
        //    不存在则落镜像行（注册代理已同步落过，此处兜底补齐）。资产数值一律以总部为准。
        const p = ch.payload ?? {};
        if (!p.card_no) throw new Error('member_mirror 缺 card_no');
        const d10 = (v: any) => (v ? String(v).slice(0, 10) : null);
        const ex = await cx(c, `SELECT id FROM members WHERE card_no=$1`, [String(p.card_no)]);
        let mid: number;
        if (ex[0]) {
          mid = Number(ex[0].id);
          await c.query(
            `UPDATE members SET phone=$2, name=$3, pinyin_code=$4, gender=$5, birthday=$6,
                    level_id=$7, points=$8, status=$9, last_active_date=$10, invalid_at=$11,
                    total_consume=$12, deleted_at=$13, updated_at=now()
              WHERE id=$1`,
            [mid, p.phone ?? null, p.name ?? null, p.pinyin_code ?? null, p.gender ?? null,
             d10(p.birthday), p.level_id != null ? Number(p.level_id) : null, Number(p.points ?? 0),
             String(p.status ?? '正常'), d10(p.last_active_date), d10(p.invalid_at),
             Number(p.total_consume ?? 0), p.deleted_at ?? null]);
        } else {
          const ins = await c.query(
            `INSERT INTO members (store_id, card_no, phone, name, pinyin_code, gender, birthday,
                                  level_id, points, status, register_channel, privacy_agreed,
                                  last_active_date, invalid_at, total_consume, deleted_at,
                                  source_store_id, source_node)
             VALUES ((SELECT COALESCE(MAX(id),1) FROM stores), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,
                     $11,$12,$13,$14,$15,$16) RETURNING id`,
            [String(p.card_no), p.phone ?? null, p.name ?? null, p.pinyin_code ?? null, p.gender ?? null,
             d10(p.birthday), p.level_id != null ? Number(p.level_id) : null, Number(p.points ?? 0),
             String(p.status ?? '正常'), String(p.register_channel ?? '连锁').slice(0, 16),
             d10(p.last_active_date), d10(p.invalid_at), Number(p.total_consume ?? 0), p.deleted_at ?? null,
             p.source_store_id != null ? Number(p.source_store_id) : null, p.source_node ?? null]);
          mid = Number(ins.rows[0].id);
        }
        await c.query(
          `INSERT INTO member_accounts (member_id, balance, principal_total, principal_balance, gift_balance,
                                        dividend_balance, dividend_cumulative, dividend_capped, dividend_weight, points)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (member_id) DO UPDATE SET
                balance=EXCLUDED.balance, principal_total=EXCLUDED.principal_total,
                principal_balance=EXCLUDED.principal_balance, gift_balance=EXCLUDED.gift_balance,
                dividend_balance=EXCLUDED.dividend_balance, dividend_cumulative=EXCLUDED.dividend_cumulative,
                dividend_capped=EXCLUDED.dividend_capped, dividend_weight=EXCLUDED.dividend_weight,
                points=EXCLUDED.points, updated_at=now()`,
          [mid, Number(p.balance ?? 0), Number(p.principal_total ?? 0), Number(p.principal_balance ?? 0),
           Number(p.gift_balance ?? 0), Number(p.dividend_balance ?? 0), Number(p.dividend_cumulative ?? 0),
           Number(p.dividend_capped ?? 0), Number(p.dividend_weight ?? 0), Number(p.acc_points ?? 0)]);
      } else {
        const def = DOWN[ch.entity];
        if (!def) throw new Error(`未知的下行实体 ${ch.entity}`);
        if (ch.op === 'delete') {
          if (def.conflict.length === 1 && def.conflict[0] === 'id' && ch.entityId) {
            await c.query(`DELETE FROM ${def.table} WHERE id=$1`, [ch.entityId]);
          } else throw new Error(`${ch.entity} 不支持 delete`);
        } else {
          await upsertRow(c, def.table, def.conflict, ch.payload, def.strip ?? []);
        }
      }
      await c.query(
        `INSERT INTO sync_inbox (from_node, entity, entity_id, op, payload, version, idem_key, status, applied_at)
         VALUES ('HQ',$1,$2,$3,$4::jsonb,$5,$6,'applied',now())
         ON CONFLICT (idem_key) DO NOTHING`,
        [ch.entity, ch.entityId ?? null, ch.op ?? 'upsert', JSON.stringify(ch.payload ?? {}), ch.version, idemKey]);
      // 收到远端事件 → HLC 推进（保证后续本地事件的 causality）
      await hlcReceive(c, Number(ch.bizPhysical ?? Date.now()), Number(ch.bizCounter ?? 0));
    });
    resetNodeCache();   // stores/设置 可能变更了本节点身份 → 让缓存失效（幂等开销小）
    await audit(null, null, '同步', '下行应用', ch.entity, ch.entityId ?? undefined, { version: ch.version }).catch(() => {});
  }
}
