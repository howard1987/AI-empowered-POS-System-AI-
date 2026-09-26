import { Module, Controller, Get, Put, Param, Body, Query } from '@nestjs/common';
import { q, q1, tx, cx, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { encryptSecret, decryptSecret, maskSecret } from '../common/secret';
import { assertSafeBaseUrl } from '../common/netguard';
import { curStore, curScope } from '../common/context';
import { chainEnabled } from '../common/scope';

/**
 * V5.0.0 连锁（方案 §3.7）：门店级设置覆盖值读取。
 * 仅在「连锁模式」（库中存在 org_type='hq' 总部行）时生效 —— 单店部署零额外查询、零回归。
 */
async function storeOverride(key: string): Promise<{ hit: boolean; value: any }> {
  if (!(await chainEnabled())) return { hit: false, value: undefined };
  try {
    const r = await q1<{ value: any }>(
      `SELECT value FROM store_settings WHERE store_id=$1 AND setting_key=$2`, [curStore(), key]);
    return r ? { hit: true, value: r.value } : { hit: false, value: undefined };
  } catch { return { hit: false, value: undefined }; }
}

// ─── Service：供其他模块读取设置项（settings 默认值见 db/001_init.sql 种子） ───
export class SettingsService {
  /** 取原始 JSONB 值（pg 自动解析为 JS 值）；门店级键优先 store_settings 覆盖，回落 system_settings.value */
  async getVal(key: string): Promise<any> {
    const r = await q1<{ value: any; scope?: string }>(
      `SELECT value, scope FROM system_settings WHERE setting_key=$1`, [key]);
    if (!r) return undefined;
    if (r.scope === 'store') {
      const ov = await storeOverride(key);
      if (ov.hit) return ov.value;
    }
    return r.value;
  }
  async getNum(key: string, fallback = 0): Promise<number> {
    const v = await this.getVal(key);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** VQA-C4：定时器热路径专用低频缓存读（默认 5 分钟 TTL）。业务写后需立即生效的路径必须继续用 getVal/getNum */
  static async cachedVal(key: string, ttlMs = 300_000): Promise<any> {
    const now = Date.now();
    const m: Map<string, { v: any; exp: number }> = (SettingsService as any)._cc || ((SettingsService as any)._cc = new Map());
    const e = m.get(key);
    if (e && e.exp > now) return e.v;
    const v = await new SettingsService().getVal(key);
    m.set(key, { v, exp: now + ttlMs });
    return v;
  }
  static async cachedNum(key: string, fb = 0, ttlMs = 300_000): Promise<number> {
    const n = Number(await SettingsService.cachedVal(key, ttlMs));
    return Number.isFinite(n) ? n : fb;
  }
  async getBool(key: string, fallback = false): Promise<boolean> {
    const v = await this.getVal(key);
    if (typeof v === 'boolean') return v;
    return v === 'true' ? true : fallback;
  }
  async getJson<T = any[]>(key: string, fallback: T): Promise<T> {
    const v = await this.getVal(key);
    return (Array.isArray(v) || (v !== null && typeof v === 'object')) ? v as T : fallback;
  }
}

// ─── Controller ───
@Controller('settings')
class SettingsController {
  private svc = new SettingsService();

  /**
   * 九大分组设置列表（可按 group 过滤）；secret 类型只返回脱敏值（••••尾号），明文/密文均不出服务端。
   * V5.0.0 连锁：附带 scope（hq/store）与门店级覆盖值解析 —— 单店部署结果与改造前完全一致。
   */
  @Get()
  async list(@Query('group') group?: string) {
    const rows = await q<any>(
      `SELECT id, group_name, setting_key, display_name, value, default_value, value_type, enum_options, unit, remark, updated_at, scope
         FROM system_settings WHERE ($1::text IS NULL OR group_name=$1) ORDER BY id`, [group || null],
    );
    const chain = await chainEnabled();
    let overrides = new Map<string, any>();
    if (chain) {
      try {
        const orows = await q<any>(`SELECT setting_key, value FROM store_settings WHERE store_id=$1`, [curStore()]);
        overrides = new Map(orows.map(r => [String(r.setting_key), r.value]));
      } catch { /* 未迁移 → 无覆盖 */ }
    }
    return rows.map(r => {
      const ov = chain && r.scope === 'store' && overrides.has(String(r.setting_key)) ? overrides.get(String(r.setting_key)) : undefined;
      const merged: any = {
        ...r,
        scope: r.scope || 'store',
        hqLocked: chain && r.scope === 'hq',      // 前端据此禁用编辑（总部账号不受限，见 PUT 守卫）
        ...(ov !== undefined ? { value: ov, overridden: true } : {}),
      };
      return merged.value_type === 'secret'
        ? { ...merged, value: maskSecret(String(merged.value ?? '')), default_value: '未配置' }
        : merged;
    });
  }

  /** 修改设置项：全量留痕（旧值→新值 + 审计）；secret 类型：加密落库、留痕/审计只记脱敏值、掩码回显视作不修改 */
  @RequirePerms('sys.settings')
  @Put(':key')
  async update(
    @Param('key') key: string,
    @Body() body: { value: any; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (body.value === undefined) throw new BizException(40002, '缺少 value');
    // P1-H1：分红核心参数（比例/封顶率）改动手工门槛——需 sys.settings + member.dividend.adjust 双权限点
    if ((key === 'dividend.ratio' || key === 'dividend.cap_rate') &&
        !(user.perms.includes('*') || user.perms.includes('member.dividend.adjust'))) {
      throw new BizException(40303, '分红比例/封顶率变更需「分红人工调整」复核权限（member.dividend.adjust），请双人复核后由持权账号操作', 403);
    }
    const row = await q1<any>(`SELECT value, value_type, scope FROM system_settings WHERE setting_key=$1`, [key]);
    if (!row) throw new BizException(40404, `设置项 ${key} 不存在`, 404);

    // V5.0.0 连锁作用域守卫（方案 §3.7）：总部级键门店不可改（只接收下发）。
    // ⚠️ 仅在「连锁模式」生效 → 单店部署（无总部行）行为与改造前 100% 一致。
    const chain = await chainEnabled();
    const sc = curScope();
    if (chain && row.scope === 'hq' && sc.dataScope !== 'all') {
      throw new BizException(40304, `「${key}」属总部级设置，由总部统一维护（门店只接收下发，如需调整请联系总部）`, 403);
    }
    // 门店级键：门店账号（非总部视角）改的是「本店覆盖值」，不动总部默认值
    const writeToStore = chain && row.scope === 'store' && sc.dataScope !== 'all';

    let storeVal: any = body.value;      // 落库值（secret 时为密文）
    let logVal: any = body.value;        // 留痕/审计值（secret 时为脱敏）
    if (row.value_type === 'secret') {
      const s = typeof body.value === 'string' ? body.value.trim() : '';
      // 空值 / 掩码回显（•• 开头）/ 占位文案「未配置」= 不修改，直接返回现状
      if (!s || s.startsWith('••') || s === '未配置') {
        return { key, value: maskSecret(String(row.value ?? '')), unchanged: true };
      }
      storeVal = encryptSecret(s);
      logVal = maskSecret(storeVal);
    }

    // P1-H2 SSRF 收口：URL/Host 类设置写入时校验（拒协议/内嵌凭据/云元数据等；预测服务仅允许本机）
    {
      const cand = String(typeof body.value === 'string' ? body.value : JSON.stringify(body.value ?? '')).replace(/^"|"$/g, '').trim();
      if (cand && /^https?:/i.test(cand) && (/\.(base|url)$/i.test(key) || /(^|\.)host(\.|$)/i.test(key))) {
        try { assertSafeBaseUrl(cand, { loopbackOnly: key === 'ai.forecast.lgbm.url' }); }
        catch (e: any) { throw new BizException(40003, `目标地址不被允许：${e?.message || '已拦截'}`); }
      }
    }

    const oldVal = row.value;
    let oldLog = row.value_type === 'secret' ? maskSecret(String(oldVal ?? '')) : oldVal;
    // 门店级键 + 门店视角 → 覆盖值取「本店原覆盖值（若有）」，否则取总部默认值（留痕口径才准确）
    if (writeToStore) {
      const ov = await q1<any>(`SELECT value FROM store_settings WHERE store_id=$1 AND setting_key=$2`, [curStore(), key]);
      if (ov) { oldLog = row.value_type === 'secret' ? maskSecret(String(ov.value ?? '')) : ov.value; }
    }
    await tx(async c => {
      if (writeToStore) {
        // 门店级覆盖（连锁模式）：只影响本店，总部默认值不动 → 前台读取优先命中此表
        await cx(c, `INSERT INTO store_settings (store_id, setting_key, value, updated_by, updated_at)
                     VALUES ($1,$2,$3::jsonb,$4,now())
                     ON CONFLICT (store_id, setting_key)
                     DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [curStore(), key, JSON.stringify(storeVal), user.sub]);
      } else {
        await cx(c, `UPDATE system_settings SET value=$2::jsonb, updated_by=$3, updated_at=now() WHERE setting_key=$1`,
          [key, JSON.stringify(storeVal), user.sub]);
        // P2-6：总部级键改动自动下发全部门店（补 P1 遗留：hq_setting 门店侧消费端早已备好但从未入队）。
        // 与设置更新同事务，原子；单店（无连锁）该行无人消费，无副作用。
        if (chain && row.scope === 'hq') {
          await cx(c, `INSERT INTO sync_changes (entity, entity_id, op, payload, target, target_ids)
                       VALUES ('hq_setting', 0, 'upsert', $1::jsonb, 'all', NULL)`,
            [JSON.stringify({ key, value: storeVal })]);
        }
      }
      await cx(c, `INSERT INTO setting_change_logs (setting_key, old_value, new_value, operator_id)
                   VALUES ($1,$2::jsonb,$3::jsonb,$4)`,
        [key, JSON.stringify(oldLog), JSON.stringify(logVal), user.sub]);
    });
    await audit(user.storeId, user.sub, '设置', 'settings.change', 'setting', undefined,
      { key, old: oldLog, new: logVal, reason: body.reason ?? null, secret: row.value_type === 'secret',
        ...(writeToStore ? { scope: 'store', storeId: curStore() } : {}) });
    return { key, value: logVal, ...(writeToStore ? { scope: 'store', storeId: curStore() } : {}) };
  }

  /** V4.27.8 作用域调整（仅总部视角）：把某个键在「通用（hq）⇄ 门店级（store）」之间切换。
   *  通用 = 连锁端直接读取统一值（门店不可改，改值自动下发）；门店级 = 各店可覆盖 + 总部可按店下发。
   *  hq→store：不动值；store→hq：清除各店覆盖值（统一值立即生效），防"看不见的旧覆盖"继续生效。 */
  @RequirePerms('sys.settings')
  @Put(':key/scope')
  async setScope(
    @Param('key') key: string,
    @Body() body: { scope: string },
    @CurrentUser() user: AuthUser,
  ) {
    const scope = String(body.scope || '');
    if (!['hq', 'store'].includes(scope)) throw new BizException(40003, 'scope 须为 hq（通用）或 store（门店级）');
    if (user.perms.includes('*') === false && !user.perms.includes('sys.settings')) {
      throw new BizException(40303, '需要系统设置权限', 403);
    }
    // 只有总部视角（dataScope=all）可调整作用域；门店账号无权决定一个键是通用还是门店级
    const sc = curScope();
    if (sc.dataScope !== 'all') throw new BizException(40304, '仅总部/老板视角可调整设置作用域', 403);
    const row = await q1<any>(`SELECT setting_key, scope FROM system_settings WHERE setting_key=$1`, [key]);
    if (!row) throw new BizException(40404, `设置项 ${key} 不存在`, 404);
    if (row.scope === scope) return { key, scope, unchanged: true };
    await tx(async c => {
      await cx(c, `UPDATE system_settings SET scope=$2, updated_at=now() WHERE setting_key=$1`, [key, scope]);
      // 门店级 → 通用：清掉各店覆盖值（否则统一值不生效、排查困难）
      let cleaned = 0;
      if (scope === 'hq') {
        const d = await cx(c, `DELETE FROM store_settings WHERE setting_key=$1 RETURNING store_id`, [key]);
        cleaned = d.length || 0;
      }
      // 连锁模式：作用域调整同步到全部门店（门店侧收到后更新本地分类）
      if (await chainEnabled()) {
        await cx(c, `INSERT INTO sync_changes (entity, entity_id, op, payload, target, target_ids)
                     VALUES ('hq_setting_scope', 0, 'upsert', $1::jsonb, 'all', NULL)`,
          [JSON.stringify({ key, scope })]);
      }
      await cx(c, `INSERT INTO setting_change_logs (setting_key, old_value, new_value, operator_id)
                   VALUES ($1,$2::jsonb,$3::jsonb,$4)`,
        [key, JSON.stringify({ scope: row.scope }), JSON.stringify({ scope, cleanedOverrides: cleaned }), user.sub]);
      await audit(user.storeId, user.sub, '设置', 'settings.scope.change', 'setting', undefined,
        { key, from: row.scope, to: scope, cleanedOverrides: cleaned });
      return { key, scope, cleanedOverrides: cleaned };
    });
    return { key, scope };
  }

  /** 单键读取（V4.13：PWA 语音查价等端侧开关；登录即可读布尔/数值开关；P0-F2：secret 项一律脱敏不回传密文） */
  @Get('key/:key')
  async getOne(@Param('key') key: string) {
    const r = await q1<any>(
      `SELECT setting_key, display_name, value, value_type FROM system_settings WHERE setting_key=$1`, [key]);
    if (!r) throw new BizException(40404, `设置项 ${key} 不存在`, 404);
    if (r.value_type === 'secret') {
      return { key: r.setting_key, name: r.display_name, value: maskSecret(String(r.value ?? '')), type: r.value_type };
    }
    return { key: r.setting_key, name: r.display_name, value: r.value, type: r.value_type };
  }

  /** 变更留痕查询（谁改的/何时/旧值→新值）；V4.13.4 起默认每页 10 条翻页，兼容旧 limit 参数 */
  @RequirePerms('sys.settings')
  @Get('changes')
  async changes(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('operator') operator?: string,
  ) {
    const size = Math.min(Math.max(Number(pageSize) || Number(limit) || 10, 1), 100);
    const p = Math.max(Number(page) || 1, 1);
    // V4.14.0 ST2：日期范围 + 操作人过滤（人话化：谁在什么时候改的什么）
    const where = `($1::date IS NULL OR l.created_at::date >= $1::date)
       AND ($2::date IS NULL OR l.created_at::date <= $2::date)
       AND ($3 = '' OR e.name ILIKE '%'||$3||'%')`;
    const fParams = [from || null, to || null, operator || ''] as any[];
    const total = Number((await q1<any>(
      `SELECT count(*)::int AS n FROM setting_change_logs l LEFT JOIN employees e ON e.id = l.operator_id WHERE ${where}`,
      fParams))?.n ?? 0);
    const rows = await q(
      `SELECT l.*, e.name AS operator_name
         FROM setting_change_logs l LEFT JOIN employees e ON e.id = l.operator_id
        WHERE ${where}
        ORDER BY l.created_at DESC LIMIT $4 OFFSET $5`, [...fParams, size, (p - 1) * size],
    );
    return { rows, total, page: p, pageSize: size, pages: Math.max(Math.ceil(total / size), 1) };
  }
}

@Module({ controllers: [SettingsController] })
export class SettingsModule {}
