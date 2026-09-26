/**
 * V5.0.0 连锁改造 · 批次2「门店管理与权限隔离」（方案 §2 · §3.1 · §6.2，M2-1~M2-5）
 *
 * 职责：
 *   ① 总部门店管理（增删改查/启停/闭店）—— 仅总部角色可见可写（hq.store.*）
 *   ② 新建门店时**自动初始化门店内置角色**（店长/收银员/库管/财务，从总部模板克隆，剔除 hq.* 权限点）
 *   ③ 门店首个店长账号一键创建（老板开新店的实际操作闭环）
 *   ④ 门店列表按 data_scope 过滤（门店账号只能看本店；总部看全部）
 *
 * ⚠️ 单店零回归：
 *   · 单店部署没有 org_type='hq' 行 → chainEnabled()=false，但本模块的「门店列表/编辑」照常可用
 *     （本节点门店即可见的唯一一行，语义与改造前「基本资料」一致）。
 *   · 新建门店不会影响任何现有数据（新 store 行 + 新角色行，均为新增）。
 *   · 角色模板来源：总部门店（无总部行时回落 store_id=1）—— 老板调总部角色，新店自动继承。
 */
import { Module, Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { q, q1, tx, cx, audit, seqLock } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { storeFilter, assertStoreAllowed, chainEnabled, resetChainCache, hqStoreId } from '../common/scope';
import { curStore } from '../common/context';
import { checkPasswordPolicy } from '../common/password-policy';
import { enqueueSync } from '../common/outbox';   // V4.28.2 P0-5 门店台账上行

/** 门店内置角色模板（不含超级管理员 —— 超管只属于总部） */
const TEMPLATE_ROLE_NAMES = ['店长', '收银员', '库管', '财务'];

/** 门店编码：S + 3 位序号（按现有最大序号顺延；冲突时重试） */
async function nextStoreNo(c: any): Promise<string> {
  const r = await c.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(store_no, '\\D', '', 'g'), '')::int), 0) AS n
       FROM stores WHERE store_no ~ '^S[0-9]+$'`);
  const n = Number(r.rows?.[0]?.n || 0);
  return 'S' + String(n + 1).padStart(3, '0');
}

/** 生成同步节点码与节点密钥（批次4 同步鉴权用；此处先落库，身份稳定不随后改） */
function genNodeCode(storeNo: string): string {
  return `${storeNo}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}
function genNodeSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * 从「模板门店」克隆内置角色到新门店（幂等：已存在同名角色则只补权限点）。
 * 关键约束：**剔除 hq.* 权限点** —— 门店角色永远不持有总部权限（R5/R8/R10）。
 */
async function initStoreRoles(c: any, storeId: number, templateStoreId: number): Promise<{ roles: number; perms: number }> {
  let roleCount = 0, permCount = 0;
  const tpl = await c.query(
    `SELECT id, name, remark, COALESCE(is_system,false) AS is_system
       FROM roles
      WHERE store_id = $1 AND name = ANY($2::text[])
      ORDER BY id`, [templateStoreId, TEMPLATE_ROLE_NAMES]);
  for (const t of tpl.rows) {
    // ① 建/取目标店的同名角色（$1/$2 显式定型：同参多处使用避免 PG 类型推断冲突）
    const ins = await c.query(
      `INSERT INTO roles (store_id, name, is_system, remark, scope_type, data_scope)
       SELECT $1::bigint, $2::varchar, true, $3::varchar, 'store', 'self'
        WHERE NOT EXISTS (SELECT 1 FROM roles WHERE store_id=$1::bigint AND name=$2::varchar)
       RETURNING id`, [storeId, t.name, t.remark || '']);
    let rid = ins.rows?.[0]?.id;
    if (!rid) {
      const got = await c.query(`SELECT id FROM roles WHERE store_id=$1::bigint AND name=$2::varchar`, [storeId, t.name]);
      rid = got.rows?.[0]?.id;
    }
    if (!rid) continue;
    roleCount++;
    // 门店角色恒为 store/self（防御：若模板被误设为 hq/all，这里强制收敛）
    await c.query(`UPDATE roles SET scope_type='store', data_scope='self', region=NULL
                    WHERE id=$1 AND (scope_type <> 'store' OR data_scope <> 'self')`, [rid]);
    // ② 克隆权限点（剔除 hq.* 总部专属）
    const p = await c.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, rp.permission_id
         FROM role_permissions rp JOIN permission_points pp ON pp.id = rp.permission_id
        WHERE rp.role_id = $2
          AND pp.code NOT LIKE 'hq.%'
          AND NOT EXISTS (SELECT 1 FROM role_permissions x
                           WHERE x.role_id = $1 AND x.permission_id = rp.permission_id)`,
      [rid, t.id]);
    permCount += p.rowCount || 0;
  }
  return { roles: roleCount, perms: permCount };
}

@Controller('hq/stores')
class ChainStoreController {
  // ─────────────────────────────────────────────────────────────
  // 列表（M2-3：按 data_scope 过滤）
  // ─────────────────────────────────────────────────────────────
  @RequirePerms('hq.store.view', 'hq.store.manage')
  @Get()
  async list(
    @Query('keyword') keyword = '',
    @Query('status') status = '',
    @Query('orgType') orgType = '',
    @Query('region') region = '',
    @Query('page') page = '1',
    @Query('size') size = '20',
  ) {
    const kw = String(keyword || '').trim();
    const params: any[] = [];
    const where: string[] = ['1=1'];
    let idx = 1;
    if (kw) {
      where.push(`(s.name ILIKE '%'||$${idx}||'%' OR COALESCE(s.store_no,'') ILIKE '%'||$${idx}||'%'
                   OR COALESCE(s.address,'') ILIKE '%'||$${idx}||'%' OR COALESCE(s.region,'') ILIKE '%'||$${idx}||'%')`);
      params.push(kw); idx++;
    }
    const st = String(status ?? '').trim();
    if (st !== '') { where.push(`s.status = $${idx}`); params.push(Number(st)); idx++; }
    const ot = String(orgType || '').trim();
    if (ot) { where.push(`s.org_type = $${idx}`); params.push(ot); idx++; }
    const rg = String(region || '').trim();
    if (rg) { where.push(`s.region = $${idx}`); params.push(rg); idx++; }
    // 数据范围：门店账号只看本店（总部 view-all 不受限）
    const f = storeFilter('s.id', idx);
    if (f.sql) { where.push('1=1' + f.sql); params.push(...f.params); idx = f.next; }

    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 20));

    const cnt = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM stores s WHERE ${where.join(' AND ')}`, params);
    const rows = await q(
      `SELECT s.id, s.name, s.store_no, s.org_type, s.parent_id, s.region, s.franchise,
              s.address, s.phone, s.contact_person AS "contactPerson",
              s.business_hours AS "businessHours", s.status,
              s.open_date, s.close_date, s.remark, s.node_code, s.sync_enabled, s.last_sync_at,
              mgr.name AS "mgrName",
              (SELECT count(*)::int FROM employees e WHERE e.store_id = s.id AND e.status = '在职') AS "empCount",
              (SELECT count(*)::int FROM product_store_prices p WHERE p.store_id = s.id) AS "storePriceCount"
         FROM stores s
         LEFT JOIN employees mgr ON mgr.id = s.mgr_employee_id
        WHERE ${where.join(' AND ')}
        ORDER BY (s.org_type = 'hq') DESC, s.id
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, sz, (pn - 1) * sz]);

    // 汇总（不受分页影响）
    const sum = await q1<any>(
      `SELECT
         count(*) FILTER (WHERE s.org_type = 'store' AND s.status = 1)::int AS "openStores",
         count(*) FILTER (WHERE s.org_type = 'store' AND s.status <> 1)::int AS "closedStores",
         count(*) FILTER (WHERE s.org_type = 'hq')::int AS "hqCount"
       FROM stores s WHERE ${where.join(' AND ')}`, params);

    return { total: Number(cnt?.n || 0), page: pn, size: sz, items: rows, summary: sum || {} };
  }

  /** 区域列表（供筛选下拉；注意：必须声明在 :id 之前，否则被 :id 捕获） */
  @RequirePerms('hq.store.view', 'hq.store.manage')
  @Get('meta/regions')
  async regions() {
    const rows = await q(`SELECT DISTINCT region FROM stores WHERE region IS NOT NULL AND region <> '' ORDER BY region`);
    return { items: rows.map(r => r.region) };
  }

  /** 门店详情 */
  @RequirePerms('hq.store.view', 'hq.store.manage')
  @Get(':id')
  async detail(@Param('id') id: string) {
    const sid = Number(id);
    assertStoreAllowed(sid, '该门店');
    const s = await q1<any>(`SELECT * FROM stores WHERE id=$1`, [sid]);
    if (!s) throw new BizException(40404, '门店不存在', 404);
    const roles = await q(
      `SELECT r.id, r.name, r.is_system, (SELECT count(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS "permCount"
         FROM roles r WHERE r.store_id=$1 ORDER BY r.id`, [sid]);
    return { ...s, roles };
  }

  /** 门店员工（含角色）—— 总部查看某店人员 */
  @RequirePerms('hq.store.view', 'hq.store.manage')
  @Get(':id/employees')
  async employees(@Param('id') id: string) {
    const sid = Number(id);
    assertStoreAllowed(sid, '该门店的员工');
    return q(
      `SELECT e.id, e.emp_no AS "empNo", e.name, e.phone, e.status, e.last_login_at AS "lastLoginAt",
              COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name))
                       FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM employees e
         LEFT JOIN employee_roles er ON er.employee_id = e.id
         LEFT JOIN roles r ON r.id = er.role_id
        WHERE e.store_id = $1 GROUP BY e.id ORDER BY e.id`, [sid]);
  }

  // ─────────────────────────────────────────────────────────────
  // 新建门店（M2-1）：门店行 + 内置角色初始化
  // ─────────────────────────────────────────────────────────────
  @RequirePerms('hq.store.manage')
  @Post()
  async create(@Body() b: any, @CurrentUser() user: AuthUser) {
    const name = String(b?.name || '').trim();
    if (!name) throw new BizException(40003, '门店名称必填');
    const orgType = b?.orgType === 'hq' ? 'hq' : 'store';
    const tplStoreId = await hqStoreId();     // 模板门店（单店 = 本店；连锁 = 总部）

    const out = await tx(async c => {
      let storeNo = String(b?.storeNo || '').trim();
      if (!storeNo) storeNo = await nextStoreNo(c);
      const dup = await c.query(`SELECT 1 FROM stores WHERE store_no=$1`, [storeNo]);
      if (dup.rows?.length) throw new BizException(40003, `门店编码 ${storeNo} 已存在`);

      const ins = await c.query(
        `INSERT INTO stores (name, address, phone, contact_person, business_hours, status, store_no, org_type,
                             parent_id, region, franchise, open_date, remark, node_code, node_secret, sync_enabled)
         VALUES ($1,$2,$3,$4,COALESCE($5,'07:30-22:00'),COALESCE($6,1),$7,$8,$9,$10,COALESCE($11,'直营'),
                 COALESCE($12::date, CURRENT_DATE),$13,$14,$15,COALESCE($16,true))
         RETURNING id`,
        [name, b?.address || null, b?.phone || null, b?.contactPerson || null, b?.businessHours || null,
          b?.status === undefined || b?.status === null ? 1 : Number(b.status),
          storeNo, orgType, b?.parentId || null, b?.region || null, b?.franchise || null,
          b?.openDate || null, b?.remark || null, genNodeCode(storeNo), genNodeSecret(),
          b?.syncEnabled === undefined ? null : !!b.syncEnabled]);
      const sid = Number(ins.rows[0].id);
      // 门店内置角色初始化（克隆总部模板；超管不克隆）
      const r = await initStoreRoles(c, sid, tplStoreId);
      await audit(sid, user.sub, '总部', 'store.create', 'store', sid,
        { name, storeNo, orgType, roles: r.roles, perms: r.perms });
      return { id: sid, storeNo, roles: r.roles, perms: r.perms };
    });
    resetChainCache();   // 若刚建的是总部行，立即生效（免等 60s）
    return out;
  }

  /** 编辑门店 */
  @RequirePerms('hq.store.manage')
  @Put(':id')
  async update(@Param('id') id: string, @Body() b: any, @CurrentUser() user: AuthUser) {
    const sid = Number(id);
    assertStoreAllowed(sid, '该门店');
    const cur = await q1<any>(`SELECT * FROM stores WHERE id=$1`, [sid]);
    if (!cur) throw new BizException(40404, '门店不存在', 404);

    const patch: Record<string, any> = {
      name: b?.name, address: b?.address, phone: b?.phone, contact_person: b?.contactPerson,
      business_hours: b?.businessHours,
      region: b?.region, franchise: b?.franchise, remark: b?.remark,
      open_date: b?.openDate, close_date: b?.closeDate,
      mgr_employee_id: b?.mgrEmployeeId, sync_enabled: b?.syncEnabled,
      node_api_base: b?.nodeApiBase, parent_id: b?.parentId,
    };
    const cols: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      cols.push(`${k} = $${i++}`);
      params.push(v === '' ? null : v);
    }
    if (!cols.length) return { id: sid, changed: 0 };
    cols.push('updated_at = now()');
    params.push(sid);
    await q(`UPDATE stores SET ${cols.join(', ')} WHERE id=$${i}`, params);
    await audit(sid, user.sub, '总部', 'store.update', 'store', sid, { before: cur, patch: b });
    return { id: sid, changed: cols.length - 1 };
  }

  /** 启停 / 闭店（status: 1 营业 / 0 停业 / 2 闭店） */
  @RequirePerms('hq.store.manage')
  @Post(':id/status')
  async setStatus(@Param('id') id: string, @Body() b: any, @CurrentUser() user: AuthUser) {
    const sid = Number(id);
    assertStoreAllowed(sid, '该门店');
    const st = Number(b?.status);
    if (![0, 1, 2].includes(st)) throw new BizException(40003, 'status 只能为 0 停业 / 1 营业 / 2 闭店');
    const cur = await q1<any>(`SELECT name, status, org_type FROM stores WHERE id=$1`, [sid]);
    if (!cur) throw new BizException(40404, '门店不存在', 404);
    if (cur.org_type === 'hq' && st === 2) throw new BizException(40003, '总部组织不可闭店');
    if (sid === curStore() && st === 2) throw new BizException(40003, '不能闭店当前登录所在的门店节点');

    await tx(async c => {
      await cx(c, `UPDATE stores SET status=$2, updated_at=now(),
                     close_date = CASE WHEN $2=2 THEN COALESCE(close_date, CURRENT_DATE) ELSE close_date END
                    WHERE id=$1`, [sid, st]);
      // 闭店：该店账号全部停用（防闭店后仍能登录产生数据）
      if (st === 2) {
        await cx(c, `UPDATE employees SET status='离职' WHERE store_id=$1 AND status='在职'`, [sid]);
      }
      await audit(sid, user.sub, '总部', 'store.status', 'store', sid, { from: cur.status, to: st, name: cur.name });
    });
    resetChainCache();
    return { id: sid, status: st };
  }

  /** 重建门店内置角色（幂等修复：模板调整后补到已有门店） */
  @RequirePerms('hq.store.manage')
  @Post(':id/roles/reset')
  async resetRoles(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const sid = Number(id);
    assertStoreAllowed(sid, '该门店');
    const tplStoreId = await hqStoreId();
    if (sid === tplStoreId) throw new BizException(40003, '模板门店自身无需初始化');
    const r = await tx(async c => {
      const n = await initStoreRoles(c, sid, tplStoreId);
      await audit(sid, user.sub, '总部', 'store.roles.reset', 'store', sid, n);
      return n;
    });
    return { id: sid, ...r };
  }

  /**
   * 一键创建/重置门店店长账号（老板开新店的实际操作闭环）
   * 幂等：同工号已存在 → 只重置密码与角色绑定，不重复建号。
   */
  @RequirePerms('hq.store.manage')
  @Post(':id/manager')
  async setManager(
    @Param('id') id: string,
    @Body() b: { empNo?: string; name?: string; password?: string; phone?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const sid = Number(id);
    assertStoreAllowed(sid, '该门店的店长账号');
    const empNo = String(b?.empNo || '').trim();
    let nm = String(b?.name || '').trim();
    const pw = String(b?.password ?? '').trim();
    // VQA（需求4）：密码留空——已存在工号=不改密码；新工号=自动生成初始密码（响应回显给管理员）
    if (!empNo) throw new BizException(40003, '工号必填');
    const exPre = await q1<any>(`SELECT id, store_id, name FROM employees WHERE emp_no=$1`, [empNo]);
    if (!exPre && !nm) throw new BizException(40003, '新员工姓名为必填');
    if (exPre) nm = nm || String(exPre.name || '');
    let genPw: string | null = null;
    let hash: string | null = null;
    if (pw) {
      await checkPasswordPolicy(pw);
      hash = bcrypt.hashSync(pw, 10);
    } else if (!exPre) {
      const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
      const digit = '23456789';
      const pick = (n: number, src: string) => Array.from<number>(require('crypto').randomBytes(n)).map(x => src[x % src.length]).join('');
      genPw = pick(5, alpha) + pick(4, digit) + pick(1, alpha);
      hash = bcrypt.hashSync(genPw, 10);
    }

    const out = await tx(async c => {
      // ① 管理员角色（该店的「店长」）
      const role = await c.query(
        `SELECT id FROM roles WHERE store_id=$1 AND name='店长' ORDER BY id LIMIT 1`, [sid]);
      let roleId = role.rows?.[0]?.id;
      if (!roleId) {
        // 尚未初始化角色 → 现建
        await initStoreRoles(c, sid, await hqStoreId());
        const again = await c.query(`SELECT id FROM roles WHERE store_id=$1 AND name='店长' ORDER BY id LIMIT 1`, [sid]);
        roleId = again.rows?.[0]?.id;
      }
      if (!roleId) throw new BizException(50000, '门店店长角色初始化失败，请先在门店详情点「重建内置角色」');

      // ② 员工（工号全局唯一：已存在则重置，不重复建）
      const ex = await c.query(`SELECT id, store_id FROM employees WHERE emp_no=$1`, [empNo]);
      let empId: number, created = false;
      if (ex.rows?.length) {
        const row = ex.rows[0];
        if (Number(row.store_id) !== sid) {
          throw new BizException(40003, `工号 ${empNo} 已被其他门店/总部占用`);
        }
        empId = Number(row.id);
        if (hash) {
          await c.query(
            `UPDATE employees SET name=$2, phone=COALESCE($3, phone), password_hash=$4, status='在职',
                                token_version = COALESCE(token_version,0) + 1, updated_at=now()
            WHERE id=$1`, [empId, nm, b?.phone || null, hash]);
        } else {
          await c.query(
            `UPDATE employees SET name=$2, phone=COALESCE($3, phone), status='在职', updated_at=now()
            WHERE id=$1`, [empId, nm, b?.phone || null]);
        }
      } else {
        const ins = await c.query(
          `INSERT INTO employees (store_id, emp_no, name, phone, password_hash, status, token_version)
           VALUES ($1,$2,$3,$4,$5,'在职',0) RETURNING id`, [sid, empNo, nm, b?.phone || null, hash]);
        empId = Number(ins.rows[0].id);
        created = true;
      }
      // ③ 绑定店长角色
      await c.query(
        `INSERT INTO employee_roles (employee_id, role_id)
         SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM employee_roles WHERE employee_id=$1 AND role_id=$2)`,
        [empId, roleId]);
      // ④ 记为门店店长（若未设置）
      await c.query(`UPDATE stores SET mgr_employee_id = COALESCE(mgr_employee_id, $2), updated_at=now() WHERE id=$1`,
        [sid, empId]);
      await audit(sid, user.sub, '总部', created ? 'store.manager.create' : 'store.manager.reset',
        'employee', empId, { empNo, name: nm, storeId: sid });
      return { empId, empNo, created, storeId: sid, genPw };
    });
    return out;
  }
}

// ═══════════════════════════════════════════════════════════════
// 批次3：商品总部化与下发（方案 §3.3，M3-0~M3-6）
//   · 可售（PRODUCT_VISIBLE）已接入收银价目表等 8+ 读路径（common/sql.ts）
//   · 本控制器负责「下发 / 回收 / 强制停售 / 一致性核查 / 申请上架审批」
// ═══════════════════════════════════════════════════════════════

/** 下行变更登记（批次4 同步层的最小前置：只入队，不落地；单店无 hq 行时永不触发） */
export async function enqueueDown(c: any, entity: string, entityId: number, op: string,
                                  payload: any, target: 'all' | 'store' | 'stores', targetIds: number[] | null) {
  await c.query(
    `INSERT INTO sync_changes (entity, entity_id, op, payload, target, target_ids)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [entity, entityId, op, JSON.stringify(payload), target, targetIds && targetIds.length ? targetIds : null]);
}

/** 解析目标门店：'all' → 全部营业门店（不含总部行）；数组 → 逐个越权校验 */
async function resolveTargetStores(c: any, storeIds: number[] | 'all' | undefined,
                                   user: AuthUser): Promise<number[]> {
  if (storeIds === 'all' || storeIds === undefined || (Array.isArray(storeIds) && !storeIds.length)) {
    const r = await c.query(`SELECT id FROM stores WHERE org_type='store' AND status=1 ORDER BY id`);
    return r.rows.map((x: any) => Number(x.id));
  }
  const ids = (Array.isArray(storeIds) ? storeIds : [storeIds]).map(Number).filter(n => Number.isInteger(n) && n > 0);
  for (const id of ids) assertStoreAllowed(id, '该门店的商品下发');
  return ids;
}

@Controller('hq/products')
class ChainProductController {
  /**
   * 商品下发（M3-2）：总部建档品 → 写入门店台账 `store_products`
   * 语义：下发即可售（is_listed=true）；门店仍可自行沽清（is_listed=false），但不可覆盖 is_forced_off
   * ⚠️ 单店零回归：单店下若调用（本店即总部），只是把本店建档品写进本店台账，等价无操作。
   */
  @RequirePerms('hq.product.publish')
  @Post('publish')
  async publish(
    @Body() b: { productIds?: number[]; storeIds?: number[] | 'all'; listed?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    const pids = (b?.productIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!pids.length) throw new BizException(40003, '请选择要下发的商品');
    const hq = await hqStoreId();
    return tx(async c => {
      const sids = await resolveTargetStores(c, b?.storeIds, user);
      if (!sids.length) throw new BizException(40003, '没有可下发的目标门店（无营业中的门店）');
      // 只允许下发「总部建档」的商品（门店自建品需先收编为总部品，避免污染全连锁）
      const own = await c.query(
        `SELECT id FROM products WHERE id = ANY($1::bigint[]) AND store_id = $2 AND deleted_at IS NULL`,
        [pids, hq]);
      const okIds = own.rows.map((r: any) => Number(r.id));
      if (!okIds.length) throw new BizException(40003, '所选商品中没有可下发的总部建档商品（门店自建品请先收编）');
      const listed = b?.listed !== false;
      let rows = 0;
      for (const sid of sids) {
        const r = await c.query(
          `INSERT INTO store_products (store_id, product_id, is_listed, is_forced_off, source, version, published_at, updated_by)
           SELECT $1, p.id, $3, false, 'hq',
                  COALESCE((SELECT MAX(x.version) FROM store_products x WHERE x.product_id = p.id), 0) + 1,
                  now(), $4
             FROM products p
            WHERE p.id = ANY($2::bigint[]) AND p.store_id = $5 AND p.deleted_at IS NULL
           ON CONFLICT (store_id, product_id)
           DO UPDATE SET is_listed = EXCLUDED.is_listed, is_forced_off = false,
                         source = 'hq', version = store_products.version + 1,
                         published_at = now(), updated_by = EXCLUDED.updated_by`,
          [sid, okIds, listed, user.sub, hq]);
        rows += r.rowCount || 0;
        await enqueueDown(c, 'store_products', sid, 'upsert',
          { store_id: sid, product_ids: okIds, is_listed: listed, source: 'hq' }, 'store', [sid]);
      }
      await audit(hq, user.sub, '总部', 'product.publish', 'product', undefined,
        { productCount: okIds.length, stores: sids, listed, skipped: pids.length - okIds.length });
      return { published: okIds.length, stores: sids.length, rows, skipped: pids.length - okIds.length };
    });
  }

  /**
   * 强制停售 / 恢复（M3-4，`hq.product.recall`）
   * forced=true → is_forced_off=true（门店不可覆盖，价目表直接过滤）
   */
  @RequirePerms('hq.product.recall')
  @Post('recall')
  async recall(
    @Body() b: { productIds?: number[]; storeIds?: number[] | 'all'; forced?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    const pids = (b?.productIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!pids.length) throw new BizException(40003, '请选择要停售/恢复的商品');
    const forced = b?.forced !== false;
    const hq = await hqStoreId();
    return tx(async c => {
      const sids = await resolveTargetStores(c, b?.storeIds, user);
      const r = await c.query(
        `UPDATE store_products SET is_forced_off=$3, version = version + 1, updated_by=$4, updated_at=now()
          WHERE product_id = ANY($1::bigint[]) AND store_id = ANY($2::bigint[])`,
        [pids, sids, forced, user.sub]);
      for (const sid of sids) {
        await enqueueDown(c, 'store_products', sid, 'upsert',
          { store_id: sid, product_ids: pids, is_forced_off: forced }, 'store', [sid]);
      }
      await audit(hq, user.sub, '总部', forced ? 'product.force_off' : 'product.force_on',
        'product', undefined, { productCount: pids.length, stores: sids });
      return { changed: r.rowCount || 0, forced };
    });
  }

  /** 撤下（回收下发）：删除门店台账行 → 该店立刻不可售（历史单据/库存不受影响） */
  @RequirePerms('hq.product.recall')
  @Post('unpublish')
  async unpublish(
    @Body() b: { productIds?: number[]; storeIds?: number[] | 'all' },
    @CurrentUser() user: AuthUser,
  ) {
    const pids = (b?.productIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!pids.length) throw new BizException(40003, '请选择要撤下的商品');
    return tx(async c => {
      const sids = await resolveTargetStores(c, b?.storeIds, user);
      const r = await c.query(
        `DELETE FROM store_products
          WHERE product_id = ANY($1::bigint[]) AND store_id = ANY($2::bigint[]) AND source = 'hq'`,
        [pids, sids]);
      for (const sid of sids) {
        await enqueueDown(c, 'store_products', sid, 'delete',
          { store_id: sid, product_ids: pids }, 'store', [sid]);
      }
      await audit(await hqStoreId(), user.sub, '总部', 'product.unpublish', 'product', undefined,
        { productCount: pids.length, stores: sids, removed: r.rowCount || 0 });
      return { removed: r.rowCount || 0 };
    });
  }

  /** 某商品的各店下发情况（商品详情抽屉用：哪几家店有、有几家沽清） */
  @RequirePerms('hq.product.publish', 'hq.store.view')
  @Get(':id/stores')
  async storesOf(@Param('id') id: string) {
    const pid = Number(id);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, '商品 id 无效');
    return { items: await q(
      `SELECT s.id AS store_id, s.name AS store_name, s.store_no, s.org_type,
              sp.is_listed, sp.is_forced_off, sp.source, sp.version, sp.published_at,
              COALESCE(pp.sell_price, p.sell_price) AS sell_price
         FROM stores s
         LEFT JOIN store_products sp ON sp.store_id = s.id AND sp.product_id = $1
         LEFT JOIN products p ON p.id = $1
         LEFT JOIN product_store_prices pp ON pp.store_id = s.id AND pp.product_id = $1
        WHERE s.status = 1 AND s.org_type = 'store'
        ORDER BY s.id`, [pid]) };
  }

  /** 一致性核查（M3-5）：总部已改但门店未收到（门店节点未同步或同步失败） */
  @RequirePerms('hq.sync.manage', 'hq.product.publish')
  @Get('consistency')
  async consistency() {
    const hq = await hqStoreId();
    return { items: await q(
      `SELECT p.id, p.name, p.updated_at AS hq_updated, s.name AS store_name, s.id AS store_id,
              sp.version, sp.published_at
         FROM products p
         JOIN store_products sp ON sp.product_id = p.id
         JOIN stores s ON s.id = sp.store_id
        WHERE p.store_id = $1 AND p.deleted_at IS NULL
          AND p.updated_at > COALESCE(sp.published_at, TIMESTAMPTZ '1970-01-01')
          AND s.sync_enabled
        ORDER BY p.updated_at DESC
        LIMIT 500`, [hq]) };
  }

  // ── 门店申请上架 / 店建品收编 审批（M3-8，R2） ──
  @RequirePerms('hq.product.publish')
  @Get('requests')
  async requests(@Query('status') status = 'pending', @Query('storeId') storeId = '') {
    const params: any[] = [];
    const where: string[] = ['1=1'];
    let i = 1;
    if (status) { where.push(`r.status = $${i}`); params.push(status); i++; }
    if (storeId) { where.push(`r.store_id = $${i}`); params.push(Number(storeId)); i++; }
    return { items: await q(
      `SELECT r.*, p.name AS product_name, p.barcode, p.goods_no, p.store_id AS owner_store_id,
              s.name AS store_name, e.name AS creator_name
         FROM store_product_requests r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN stores s ON s.id = r.store_id
         LEFT JOIN employees e ON e.id = r.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC LIMIT 300`, params) };
  }

  /**
   * 审批门店申请（approve → 写 store_products；local_adopt → 收编为总部品并全量下发）
   * ⚠️ 收编必须复核 L1（R8）：默认**不**继承门店实际进价作为全连锁 L1，除非显式 confirmL1=true
   */
  @RequirePerms('hq.product.publish')
  @Post('requests/:id/audit')
  async auditRequest(
    @Param('id') id: string,
    @Body() b: { approve?: boolean; remark?: string; confirmL1?: boolean; publishTo?: number[] | 'all' | 'none' },
    @CurrentUser() user: AuthUser,
  ) {
    const rid = Number(id);
    const approve = b?.approve !== false;
    const hq = await hqStoreId();
    return tx(async c => {
      const rq = await c.query(`SELECT * FROM store_product_requests WHERE id=$1 FOR UPDATE`, [rid]);
      const row = rq.rows?.[0];
      if (!row) throw new BizException(40404, '申请不存在', 404);
      if (row.status !== 'pending') throw new BizException(40003, `该申请已处理（${row.status}）`);
      const sid = Number(row.store_id), pid = Number(row.product_id);

      if (!approve) {
        await c.query(`UPDATE store_product_requests SET status='rejected', audit_remark=$2,
                              audited_by=$3, audited_at=now() WHERE id=$1`,
          [rid, String(b?.remark || '').slice(0, 128) || null, user.sub]);
        await enqueueDown(c, 'store_product_requests', rid, 'upsert',
          { id: rid, status: 'rejected', store_id: sid, product_id: pid }, 'store', [sid]);
        await audit(hq, user.sub, '总部', 'product.request.reject', 'product', pid, { storeId: sid, remark: b?.remark });
        return { id: rid, status: 'rejected' };
      }

      if (row.kind === 'local_adopt') {
        // 收编：改归属到总部 + 下发（只改归属，历史销售/库存引用不变，方案 §3.3.4 关键点 3）
        const own = await c.query(`SELECT store_id FROM products WHERE id=$1`, [pid]);
        if (Number(own.rows?.[0]?.store_id) !== hq) {
          await c.query(`UPDATE products SET store_id=$2, updated_at=now() WHERE id=$1`, [pid, hq]);
        }
      }
      // 写门店台账（本店可售）。收编后商品归属已改为总部 → source 恒为 'hq'
      await c.query(
        `INSERT INTO store_products (store_id, product_id, is_listed, is_forced_off, source, version, published_at, updated_by)
         VALUES ($1,$2,true,false,'hq',
                 COALESCE((SELECT MAX(x.version) FROM store_products x WHERE x.product_id=$2),0)+1, now(), $3)
         ON CONFLICT (store_id, product_id)
         DO UPDATE SET is_listed=true, is_forced_off=false, version = store_products.version + 1,
                       published_at=now(), updated_by=$3`,
        [sid, pid, user.sub]);
      await c.query(`UPDATE store_product_requests SET status='approved', audit_remark=$2,
                            audited_by=$3, audited_at=now() WHERE id=$1`,
        [rid, String(b?.remark || '').slice(0, 128) || null, user.sub]);
      await enqueueDown(c, 'store_products', sid, 'upsert',
        { store_id: sid, product_ids: [pid], is_listed: true }, 'store', [sid]);
      await enqueueDown(c, 'store_product_requests', rid, 'upsert',
        { id: rid, status: 'approved', store_id: sid, product_id: pid }, 'store', [sid]);
      await audit(hq, user.sub, '总部', 'product.request.approve', 'product', pid,
        { storeId: sid, kind: row.kind, confirmL1: !!b?.confirmL1 });
      return { id: rid, status: 'approved', kind: row.kind, storeId: sid, productId: pid };
    });
  }

  /**
   * V5.0.0 R2：**批量收编门店自建品**（总部商品页「门店自建品」tab 直接收编）
   * 语义 = 把 `products.store_id` 由门店改为总部 → 该商品成为全连锁档案，可下发到各店。
   * ⚠️ 关键点（方案 §3.3.4）：
   *   ① 只改**归属**，历史销售/库存/批次引用不变（id 不变 → 单据全部照常可追溯）；
   *   ② **L1 处理**：默认把该商品当前 L1（可能为空）原样带过去，**不自动采用门店实际进价** ——
   *      否则「一家店拿到的价」会变成全连锁红线兜底（R8 硬约束 3）。要采纳须显式 `adoptL1` 传具体值。
   *   ③ 收编后自动下发到**原门店**（保证收编商品当场可继续卖）＋可选 `publishTo` 追加门店。
   */
  @RequirePerms('hq.product.publish')
  @Post('adopt')
  async adopt(
    @Body() b: { productIds?: number[]; publishTo?: number[] | 'all' | 'none'; adoptL1?: number },
    @CurrentUser() user: AuthUser,
  ) {
    const hq = await hqStoreId();
    const ids = (b?.productIds || []).map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
    if (!ids.length) throw new BizException(40003, '请先勾选要收编的门店自建品');
    const adoptL1 = (b?.adoptL1 !== undefined && b?.adoptL1 !== null && Number(b.adoptL1) > 0) ? Number(b.adoptL1) : null;
    return tx(async c => {
      const rows = (await c.query(
        `SELECT id, name, store_id, standard_cost FROM products
          WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL FOR UPDATE`, [ids])).rows || [];
      if (!rows.length) throw new BizException(40404, '未找到可收编的商品', 404);
      let adopted = 0, skipped = 0;
      const fromStores = new Set<number>();
      const okIds: number[] = [];
      for (const r of rows) {
        const own = Number(r.store_id);
        if (own === hq) { skipped++; continue; }   // 已是总部品
        fromStores.add(own);
        await c.query(
          `UPDATE products SET store_id=$2, standard_cost=COALESCE($3, standard_cost), updated_at=now() WHERE id=$1`,
          [Number(r.id), hq, adoptL1]);
        // 原建档门店保留可售（否则收编瞬间本店就断货了）
        for (const sid of [own]) {
          await c.query(
            `INSERT INTO store_products (store_id, product_id, is_listed, is_forced_off, source, version, published_at, updated_by)
             VALUES ($1,$2,true,false,'hq',
                     COALESCE((SELECT MAX(x.version) FROM store_products x WHERE x.product_id=$2),0)+1, now(), $3)
             ON CONFLICT (store_id, product_id)
             DO UPDATE SET is_listed=true, version = store_products.version + 1, published_at=now(), updated_by=$3`,
            [sid, Number(r.id), user.sub]);
          await enqueueDown(c, 'store_products', sid, 'upsert',
            { store_id: sid, product_ids: [Number(r.id)], is_listed: true }, 'store', [sid]);
        }
        okIds.push(Number(r.id));
        adopted++;
      }
      // 商品归属变更 → 通知原建档门店刷新档案（循环结束后统一入队，保证 fromStores 已收敛）
      for (const pid of okIds) {
        await enqueueDown(c, 'products', pid, 'upsert',
          { id: pid, product_id: pid, entity: 'products' }, 'store', [...fromStores]);
      }
      // 追加下发到其他门店（可选）
      let published = 0;
      const pubTo = b?.publishTo;
      if (okIds.length && pubTo && pubTo !== 'none') {
        let targets: number[] = [];
        if (pubTo === 'all') {
          targets = (await c.query(`SELECT id FROM stores WHERE status=1 AND org_type='store'`)).rows.map((x: any) => Number(x.id));
        } else if (Array.isArray(pubTo)) {
          targets = pubTo.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0);
          for (const t of targets) assertStoreAllowed(t, '商品下发目标门店');
        }
        for (const sid of targets) {
          for (const pid of okIds) {
            await c.query(
              `INSERT INTO store_products (store_id, product_id, is_listed, is_forced_off, source, version, published_at, updated_by)
               VALUES ($1,$2,true,false,'hq',
                       COALESCE((SELECT MAX(x.version) FROM store_products x WHERE x.product_id=$2),0)+1, now(), $3)
               ON CONFLICT (store_id, product_id)
               DO UPDATE SET is_listed=true, version = store_products.version + 1, published_at=now(), updated_by=$3`,
              [sid, pid, user.sub]);
            published++;
          }
          await enqueueDown(c, 'store_products', sid, 'upsert',
            { store_id: sid, product_ids: okIds, is_listed: true }, 'store', [sid]);
        }
      }
      // 对应申请单标记为已处理（若存在）
      if (okIds.length) {
        await c.query(
          `UPDATE store_product_requests SET status='approved', audited_by=$2, audited_at=now()
            WHERE product_id = ANY($1::bigint[]) AND kind='local_adopt' AND status='pending'`,
          [okIds, user.sub]);
      }
      await audit(hq, user.sub, '总部', 'product.adopt', 'product', undefined,
        { adopted, skipped, publishTo: pubTo === 'all' ? 'all' : (Array.isArray(pubTo) ? pubTo.length : 'none'), adoptL1, fromStores: [...fromStores] });
      return { adopted, skipped, published, stores: [...fromStores].length, ids: okIds };
    });
  }
}

/**
 * 门店侧商品运营（M3-3 / M3-6）：上下架（沽清）、补货参数、申请上架
 * ⚠️ 门店**无权**改：名称/条码/单位/保质期/分类/进价（改了会造成对账灾难，方案 §3.3.4）
 */
@Controller('store/products')
class StoreProductController {
  /** 本店台账（门店商品页「本店在售」tab 的数据源；含总部强制停售标记） */
  @Get('listing')
  async listing(
    @Query('keyword') keyword = '', @Query('page') page = '1', @Query('size') size = '20',
  ) {
    const sid = curStore();
    const kw = String(keyword || '').trim();
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 20));
    const rows = await q(
      `SELECT sp.product_id, sp.is_listed, sp.is_forced_off, sp.source, sp.min_stock, sp.max_stock,
              sp.version, sp.published_at, p.name, p.barcode, p.goods_no, p.base_unit, p.spec,
              COALESCE(pp.sell_price, p.sell_price) AS sell_price, p.status, c.name AS category_name
         FROM store_products sp
         JOIN products p ON p.id = sp.product_id AND p.deleted_at IS NULL
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN product_store_prices pp ON pp.product_id = sp.product_id AND pp.store_id = sp.store_id
        WHERE sp.store_id = $1
          AND ($2 = '' OR p.name ILIKE '%'||$2||'%' OR p.barcode ILIKE '%'||$2||'%' OR p.goods_no = $2)
        ORDER BY sp.updated_at DESC
        LIMIT $3 OFFSET $4`, [sid, kw, sz, (pn - 1) * sz]);
    const cnt = await q1<{ n: string }>(
      `SELECT count(*)::text AS n FROM store_products sp JOIN products p ON p.id = sp.product_id
        WHERE sp.store_id=$1 AND ($2='' OR p.name ILIKE '%'||$2||'%' OR p.barcode ILIKE '%'||$2||'%' OR p.goods_no=$2)`,
      [sid, kw]);
    return { total: Number(cnt?.n || 0), page: pn, size: sz, items: rows };
  }

  /** 上架 / 沽清（`pos.product.unlist`）；总部强制停售时不可上架 */
  @RequirePerms('pos.product.unlist', 'product.manage')
  @Post(':id/listing')
  async setListing(@Param('id') id: string, @Body() b: { listed?: boolean }, @CurrentUser() user: AuthUser) {
    const pid = Number(id);
    const sid = curStore();
    const listed = b?.listed !== false;
    const cur = await q1<any>(`SELECT * FROM store_products WHERE store_id=$1 AND product_id=$2`, [sid, pid]);
    if (!cur) throw new BizException(40404, '本店没有该商品（总部可能尚未下发）', 404);
    if (listed && cur.is_forced_off) throw new BizException(40003, '该商品已被总部强制停售，门店不可上架');
    await q(`UPDATE store_products SET is_listed=$3, version = version + 1, updated_by=$4, updated_at=now()
              WHERE store_id=$1 AND product_id=$2`, [sid, pid, listed, user.sub]);
    // V4.28.2 P0-5：本店上下架台账上行（总部 store_products 镜像；总部/单店节点 no-op）
    await enqueueSync(null, 'store_product', pid,
      { productId: pid, isListed: listed, minStock: Number(cur.min_stock ?? 0) });
    await audit(sid, user.sub, '商品', listed ? 'product.list' : 'product.unlist', 'product', pid, { listed });
    return { productId: pid, isListed: listed };
  }

  /** 门店级补货参数（不影响总部主档） */
  @RequirePerms('stock.manage', 'product.manage')
  @Post(':id/stock-params')
  async stockParams(@Param('id') id: string, @Body() b: any, @CurrentUser() user: AuthUser) {
    const pid = Number(id);
    const sid = curStore();
    const cur = await q1<any>(`SELECT is_listed FROM store_products WHERE store_id=$1 AND product_id=$2`, [sid, pid]);
    if (!cur) throw new BizException(40404, '本店没有该商品', 404);
    await q(`UPDATE store_products SET min_stock=$3, max_stock=$4, updated_by=$5, updated_at=now()
              WHERE store_id=$1 AND product_id=$2`,
      [sid, pid, b?.minStock === undefined || b?.minStock === '' ? null : Number(b.minStock),
        b?.maxStock === undefined || b?.maxStock === '' ? null : Number(b.maxStock), user.sub]);
    // V4.28.2 P0-5：补货参数上行（总部台账镜像 min_stock；上下架状态保持本店现值）
    await enqueueSync(null, 'store_product', pid,
      { productId: pid, isListed: cur.is_listed !== false,
        minStock: b?.minStock === undefined || b?.minStock === '' ? 0 : Number(b.minStock) });
    return { productId: pid, minStock: b?.minStock ?? null, maxStock: b?.maxStock ?? null };
  }

  /**
   * 申请上架（M3-8，R2）：对「总部档案里但本店未下发」的商品发起申请
   * 设置 `chain.product.self_apply=true` 时免批（直接写台账），总控权始终在总部。
   */
  @RequirePerms('pos.product.unlist', 'product.manage')
  @Post('apply')
  async apply(@Body() b: { productId?: number; reason?: string; kind?: string }, @CurrentUser() user: AuthUser) {
    const pid = Number(b?.productId);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, '请选择要申请的商品');
    const sid = curStore();
    const kind = b?.kind === 'local_adopt' ? 'local_adopt' : 'apply';
    const p = await q1<any>(`SELECT id, name, store_id FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
    if (!p) throw new BizException(40404, '商品不存在', 404);
    const hq = await hqStoreId();

    if (kind === 'apply' && Number(p.store_id) === sid) {
      throw new BizException(40003, '该商品已是本店商品，无需申请');
    }
    const has = await q1<any>(`SELECT 1 FROM store_products WHERE store_id=$1 AND product_id=$2`, [sid, pid]);
    if (has) throw new BizException(40003, '本店已有该商品，无需申请');

    const selfApply = await q1<any>(`SELECT value FROM system_settings WHERE setting_key='chain.product.self_apply'`);
    const auto = String(selfApply?.value) === 'true' || selfApply?.value === true;

    const req = await q<any>(
      `INSERT INTO store_product_requests (store_id, product_id, kind, status, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (store_id, product_id, kind, status) DO NOTHING
       RETURNING id`,
      [sid, pid, kind, auto ? 'approved' : 'pending',
        String(b?.reason || '').slice(0, 128) || null, user.sub]);
    if (!req.length) throw new BizException(40003, '该商品已有待审申请，请勿重复提交');

    if (auto) {
      await q(`INSERT INTO store_products (store_id, product_id, is_listed, source, version, published_at, updated_by)
               VALUES ($1,$2,true,'hq',1,now(),$3)
               ON CONFLICT (store_id, product_id) DO UPDATE SET is_listed=true, version=store_products.version+1`,
        [sid, pid, user.sub]);
    }
    await audit(sid, user.sub, '商品', 'product.apply', 'product', pid,
      { kind, auto, toHq: Number(p.store_id) === hq });
    return { id: Number(req[0].id), status: auto ? 'approved' : 'pending', autoApproved: auto };
  }

  /** 本店待审申请（门店端看进度） */
  @Get('requests')
  async myRequests(@Query('status') status = '') {
    const sid = curStore();
    const params: any[] = [sid];
    let w = 'r.store_id=$1';
    if (status) { params.push(status); w += ` AND r.status=$2`; }
    return { items: await q(
      `SELECT r.*, p.name AS product_name, p.barcode FROM store_product_requests r
         JOIN products p ON p.id = r.product_id
        WHERE ${w} ORDER BY r.created_at DESC LIMIT 200`, params) };
  }
}

/**
 * V5.0.0 连锁 · 总部进价管理（M3-10 / M3-11，R8 乙模型）
 *
 * 一句话职责：**标准进价 L1 的唯一维护入口**。
 *
 * 为什么必须是"唯一入口"：
 *   改价红线 = max(min_price 或 售价×0.6, 进价)。门店若能录进价，就能
 *   「先做一笔高进价入库 → 红线被抬高 → 再低价卖」而不触发违规 —— 这就是改造前的漏洞。
 *   所以 L1 只由两个主体写入：**总部采购入库（自动）** 与 **本模块（人工）**。
 *
 * ⚠️ 每次写 L1 都必须**同事务**写 `product_standard_cost_logs`：
 *   半年后拿历史低价去谈判，必须能证明它从哪来 —— 没有台账的价是废筹码。
 */
@Controller('hq/costs')
class HqCostController {
  /** 标准进价清单（含各渠道报价对比 → 直接就是谈判原料） */
  @RequirePerms('hq.cost.manage', 'product.view')
  @Get()
  async list(
    @Query('keyword') keyword = '', @Query('onlyEmpty') onlyEmpty = '',
    @Query('page') page = '1', @Query('size') size = '20',
  ) {
    const kw = String(keyword || '').trim();
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 20));
    const emptyOnly = onlyEmpty === '1';
    const hq = await hqStoreId();
    const rows = await q(
      `SELECT p.id, p.goods_no, p.barcode, p.name, p.base_unit, p.spec, p.sell_price, p.min_price,
              p.standard_cost,
              sup.name AS supplier_name, p.supplier_default_id,
              /* 各渠道最低报价（供应商比价 → 谈判原料） */
              (SELECT MIN(sqc.price) FROM supplier_quote_channels sqc WHERE sqc.product_id = p.id) AS channel_min,
              (SELECT MAX(sqc.price) FROM supplier_quote_channels sqc WHERE sqc.product_id = p.id) AS channel_max,
              (SELECT COUNT(DISTINCT sqc.supplier_id) FROM supplier_quote_channels sqc
                WHERE sqc.product_id = p.id AND sqc.supplier_id IS NOT NULL) AS channel_suppliers,
              (SELECT MIN(sqc.created_at) FROM supplier_quote_channels sqc
                WHERE sqc.product_id = p.id AND sqc.price = p.standard_cost) AS l1_since,
              /* 旧口径（供应商报价最新一条）→ 便于与 L1 对比，判断"该不该维护" */
              COALESCE((SELECT spp.price FROM supplier_product_prices spp
                         WHERE spp.product_id = p.id ORDER BY spp.id DESC LIMIT 1), 0) AS legacy_cost,
              (SELECT COUNT(*) FROM cost_diff_requests dr WHERE dr.product_id = p.id AND dr.status='pending') AS pending_diffs
         FROM products p
         LEFT JOIN suppliers sup ON sup.id = p.supplier_default_id
        WHERE p.deleted_at IS NULL AND p.store_id = $1 AND p.track_inventory
          AND ($2 = '' OR p.name ILIKE '%'||$2||'%' OR p.barcode = $2 OR p.goods_no = $2)
          AND ($3::bool = false OR p.standard_cost IS NULL)
        ORDER BY (p.standard_cost IS NULL) DESC, p.id DESC
        LIMIT $4 OFFSET $5`,
      [hq, kw, emptyOnly, sz, (pn - 1) * sz]);
    const cnt = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM products p
        WHERE p.deleted_at IS NULL AND p.store_id = $1 AND p.track_inventory
          AND ($2 = '' OR p.name ILIKE '%'||$2||'%' OR p.barcode = $2 OR p.goods_no = $2)
          AND ($3::bool = false OR p.standard_cost IS NULL)`,
      [hq, kw, emptyOnly]);
    return { total: Number(cnt?.n || 0), page: pn, size: sz, items: rows };
  }

  /** 设定 / 调整标准进价 L1（单条；批量见 `batch`） */
  @RequirePerms('hq.cost.manage')
  @Post()
  async setOne(
    @Body() b: { productId?: number; cost?: number | null; reason?: string; publish?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    const pid = Number(b?.productId);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, 'productId 非法');
    // 放宽为 any：前端可能传字符串（表单值），'' 需被视为「未填」而非 0
    const raw: any = b?.cost;
    const blank = raw === null || raw === undefined || String(raw).trim() === '';
    const cost = (blank || Number(raw) < 0) ? null : Number(raw);
    if (!blank && cost === null) {
      throw new BizException(40003, '进价必须 ≥ 0（清空请显式传 null）');
    }
    const hq = await hqStoreId();
    return tx(async c => {
      const prow = (await c.query(
        `SELECT id, name, standard_cost FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [pid])).rows[0];
      if (!prow) throw new BizException(40404, '商品不存在', 404);
      const old = prow.standard_cost === null || prow.standard_cost === undefined ? null : Number(prow.standard_cost);
      if (old === cost) throw new BizException(40003, '新进价与当前标准进价相同，无需修改');
      await c.query(`UPDATE products SET standard_cost=$2, updated_at=now() WHERE id=$1`, [pid, cost]);
      await c.query(
        `INSERT INTO product_standard_cost_logs
           (product_id, old_cost, new_cost, delta, source, reason, operator_id)
         VALUES ($1,$2,$3,$4,'hq_manual',$5,$6)`,
        [pid, old, cost, cost === null ? null : Number((cost - (old ?? 0)).toFixed(4)),
          String(b?.reason || '').slice(0, 200) || null, user.sub]);
      await enqueueDown(c, 'products', pid, 'upsert',
        { id: pid, product_id: pid, entity: 'products', standard_cost: cost }, 'all', null);
      await audit(hq, user.sub, '总部', 'cost.hq_manual', 'product', pid,
        { name: prow.name, old, new: cost, reason: b?.reason || null });
      return { productId: pid, oldCost: old, newCost: cost };
    });
  }

  /** 批量设定标准进价（按商品 id 列表统一赋值；用于总部批量维护） */
  @RequirePerms('hq.cost.manage')
  @Post('batch')
  async setBatch(
    @Body() b: { productIds?: number[]; cost?: number; mode?: 'set' | 'percent'; percent?: number; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const ids = (b?.productIds || []).map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
    if (!ids.length) throw new BizException(40003, '请先勾选商品');
    const mode = b?.mode === 'percent' ? 'percent' : 'set';
    const pct = Number(b?.percent);
    if (mode === 'percent' && (!Number.isFinite(pct) || pct <= -100)) throw new BizException(40003, '调整比例非法');
    const cost = Number(b?.cost);
    if (mode === 'set' && (!Number.isFinite(cost) || cost < 0)) throw new BizException(40003, '进价必须 ≥ 0');
    const hq = await hqStoreId();
    return tx(async c => {
      const rows = (await c.query(
        `SELECT id, name, standard_cost FROM products WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL FOR UPDATE`,
        [ids])).rows || [];
      let changed = 0;
      for (const r of rows) {
        const old = r.standard_cost === null || r.standard_cost === undefined ? null : Number(r.standard_cost);
        const nv = mode === 'set' ? cost : Number(((old ?? 0) * (1 + pct / 100)).toFixed(4));
        if (old === nv) continue;
        await c.query(`UPDATE products SET standard_cost=$2, updated_at=now() WHERE id=$1`, [Number(r.id), nv]);
        await c.query(
          `INSERT INTO product_standard_cost_logs (product_id, old_cost, new_cost, delta, source, reason, operator_id)
           VALUES ($1,$2,$3,$4,'hq_manual',$5,$6)`,
          [Number(r.id), old, nv, Number((nv - (old ?? 0)).toFixed(4)),
            String(b?.reason || '').slice(0, 200) || (mode === 'percent' ? `批量调整 ${pct}%` : '批量设定'), user.sub]);
        await enqueueDown(c, 'products', Number(r.id), 'upsert',
          { id: Number(r.id), product_id: Number(r.id), entity: 'products', standard_cost: nv }, 'all', null);
        changed++;
      }
      await audit(hq, user.sub, '总部', 'cost.hq_batch', 'product', undefined,
        { requested: ids.length, changed, mode, cost: mode === 'set' ? cost : undefined, percent: mode === 'percent' ? pct : undefined });
      return { changed, total: ids.length };
    });
  }

  /** 进价渠道榜（M3-11：谁、哪家店、何时、多少 —— 直接拿去跟供应商谈） */
  @RequirePerms('hq.cost.manage')
  @Get('channels')
  async channels(
    @Query('productId') productId = '', @Query('limit') limit = '120',
  ) {
    const pid = Number(productId);
    const lim = Math.min(500, Math.max(1, Number(limit) || 120));
    if (!Number.isInteger(pid) || pid <= 0) {
      // 无商品参数 → 返回「各商品最低渠道价 vs L1」的总览（供总部巡检价格空间）
      return { items: await q(
        `SELECT p.id AS product_id, p.name, p.base_unit, p.standard_cost,
                MIN(sqc.price) AS channel_min, MAX(sqc.price) AS channel_max,
                COUNT(DISTINCT sqc.supplier_id) AS suppliers,
                (p.standard_cost - MIN(sqc.price)) AS gap
           FROM products p
           JOIN supplier_quote_channels sqc ON sqc.product_id = p.id
          WHERE p.deleted_at IS NULL AND p.standard_cost IS NOT NULL
          GROUP BY p.id, p.name, p.base_unit, p.standard_cost
         HAVING MIN(sqc.price) < p.standard_cost
          ORDER BY (p.standard_cost - MIN(sqc.price)) DESC
          LIMIT $1`, [lim]) };
    }
    return { items: await q(
      `SELECT sqc.*, s.name AS supplier_name, st.name AS store_name, e.name AS operator_name
         FROM supplier_quote_channels sqc
         LEFT JOIN suppliers s ON s.id = sqc.supplier_id
         LEFT JOIN stores st ON st.id = sqc.store_id
         LEFT JOIN employees e ON e.id = sqc.created_by
        WHERE sqc.product_id = $1
        ORDER BY sqc.price ASC, sqc.created_at DESC
        LIMIT $2`, [pid, lim]) };
  }

  /** L1 变更台账（证据链：何时 / 依据哪张单 / 从多少改到多少） */
  @RequirePerms('hq.cost.manage')
  @Get('logs')
  async logs(
    @Query('productId') productId = '', @Query('source') source = '',
    @Query('page') page = '1', @Query('size') size = '30',
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 30));
    const pid = Number(productId) || 0;
    return { items: await q(
      `SELECT l.*, p.name AS product_name, p.barcode, s.name AS supplier_name, st.name AS store_name,
              e.name AS operator_name
         FROM product_standard_cost_logs l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN suppliers s ON s.id = l.supplier_id
         LEFT JOIN stores st ON st.id = l.store_id
         LEFT JOIN employees e ON e.id = l.operator_id
        WHERE ($1::bigint = 0 OR l.product_id = $1::bigint)
          AND ($2 = '' OR l.source = $2)
        ORDER BY l.created_at DESC
        LIMIT $3 OFFSET $4`, [pid, String(source || ''), sz, (pn - 1) * sz]) };
  }
}

/**
 * V5.0.0 连锁 · 进价异常处置（R15 / R16，方案 §5.1.6-⑧⑨）
 *
 * 双向同一张表：
 *   · `low`  实价 < L1 → 总部审核通过才降 L1（防不可复现低价长期压全连锁红线）
 *   · `high` 实价 > L1 → L1 不动，总部四选一裁决
 *
 * 🔴 两条铁律（最易做错）：
 *   ① `adjust_to_l1` **只调记账成本（批次 L2）且只调未销售余量**；
 *      **`gap_amount`（对账口径）恒取实价** —— 对账金额改了就跟供应商对不上账（风险 R-20）。
 *   ② 已入账的**不能"拒入库"**：`reject_inbound` 只对未产生库存的单据可用。
 */
@Controller('cost-diffs')
class CostDiffController {
  /** 待办列表（门店看本店；总部看全部） */
  @RequirePerms('stock.manage', 'hq.cost.manage')
  @Get()
  async list(
    @Query('status') status = 'pending', @Query('anomaly') anomaly = '',
    @Query('storeId') storeId = '', @Query('page') page = '1', @Query('size') size = '30',
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 30));
    const f = storeFilter('d.store_id', 5);
    return { items: await q(
      `SELECT d.*, p.name AS product_name, p.barcode, p.base_unit, s.name AS supplier_name,
              st.name AS store_name, e.name AS auditor_name
         FROM cost_diff_requests d
         LEFT JOIN products p ON p.id = d.product_id
         LEFT JOIN suppliers s ON s.id = d.supplier_id
         LEFT JOIN stores st ON st.id = d.store_id
         LEFT JOIN employees e ON e.id = d.audited_by
        WHERE ($1 = '' OR d.status = $1)
          AND ($2 = '' OR d.anomaly = $2)
          ${f.sql}
        ORDER BY (d.anomaly = 'high') DESC, d.created_at DESC
        LIMIT $3 OFFSET $4`, [String(status || ''), String(anomaly || ''), sz, (pn - 1) * sz, ...f.params]) };
  }

  /** 门店提交进价差异申请（门店只有「申请」一个动作，没有直接改 L1 的入口） */
  @RequirePerms('stock.manage')
  @Post()
  async create(
    @Body() b: {
      productId?: number; supplierId?: number; actualCost?: number; qty?: number;
      inboundId?: number; docNo?: string; anomaly?: string; remark?: string;
    },
    @CurrentUser() user: AuthUser,
  ) {
    const pid = Number(b?.productId);
    const actual = Number(b?.actualCost);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, '商品未选择');
    if (!Number.isFinite(actual) || actual <= 0) throw new BizException(40003, '实际进价必须 > 0');
    const sid = curStore();
    return tx(async c => {
      const prow = (await c.query(`SELECT id, name, standard_cost, supplier_default_id FROM products WHERE id=$1`, [pid])).rows[0];
      if (!prow) throw new BizException(40404, '商品不存在', 404);
      // 硬约束 1：只有**已审核入库单**的价才有资格进采纳流程（否则门店随手报个低价就能拉低全连锁红线）
      let inboundId: number | null = null;
      if (b?.inboundId) {
        const irow = (await c.query(`SELECT id, status, inbound_no FROM inbound_orders WHERE id=$1`, [Number(b.inboundId)])).rows[0];
        if (!irow) throw new BizException(40404, '入库单不存在', 404);
        if (String(irow.status) !== '已审核') throw new BizException(40003, '仅「已审核」的入库单可提交进价差异申请');
        inboundId = Number(irow.id);
      }
      const l1 = prow.standard_cost === null || prow.standard_cost === undefined ? null : Number(prow.standard_cost);
      const anomaly = l1 === null || actual < l1 ? 'low' : (actual > l1 ? 'high' : null);
      if (!anomaly) throw new BizException(40003, '实际进价与总部标准进价相同，无需申请');
      // 同店同商品同向未结单去重（窗口可配：chain.cost.merge_days，默认 7 天，防刷屏）
      const md = (await c.query(
        `SELECT COALESCE((value)::text::int, 7) AS n FROM system_settings WHERE setting_key='chain.cost.merge_days'`)).rows[0];
      const mergeDays = Math.max(1, Math.min(365, Number(md?.n) || 7));
      const dup = (await c.query(
        `SELECT id FROM cost_diff_requests
          WHERE store_id=$1 AND product_id=$2 AND anomaly=$3 AND status='pending'
            AND created_at > now() - ($4 || ' days')::interval LIMIT 1`,
        [sid, pid, anomaly, String(mergeDays)])).rows[0];
      if (dup) throw new BizException(40003, '该商品已有待处理的进价差异申请（7 天内同向合并），请勿重复提交');
      const ins = (await c.query(
        `INSERT INTO cost_diff_requests
           (anomaly, store_id, product_id, supplier_id, inbound_id, doc_no, qty,
            l1_at_request, actual_cost, gap_amount, remark, due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 now() + (COALESCE((SELECT (value)::text::int FROM system_settings WHERE setting_key='chain.cost.adjust_window_h'), 24) || ' hours')::interval,
                 $12)
         RETURNING id, status, anomaly`,
        [anomaly, sid, pid, b?.supplierId ? Number(b.supplierId) : (prow.supplier_default_id || null),
          inboundId, String(b?.docNo || '').slice(0, 48) || null,
          b?.qty === undefined || b?.qty === null || String(b?.qty).trim() === '' ? null : Number(b.qty),
          l1, actual,
          l1 === null ? null : Number(((actual - l1) * Number(b?.qty || 1)).toFixed(2)),
          String(b?.remark || '').slice(0, 200) || null, user.sub])).rows[0];
      await audit(sid, user.sub, '进销存', anomaly === 'low' ? 'cost.request.lower' : 'cost.request.higher',
        'product', pid, { actualCost: actual, l1, inboundId, docNo: b?.docNo || null });
      return { id: Number(ins.id), anomaly, status: ins.status, l1, actualCost: actual };
    });
  }

  /** 总部裁决（low：采纳/驳回；high：accept / adjust_to_l1 / reject_inbound / return_supplier） */
  @RequirePerms('hq.cost.manage')
  @Post(':id/audit')
  async auditOne(
    @Param('id') id: string,
    @Body() b: { approve?: boolean; verdict?: string; remark?: string; raiseL1?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    const rid = Number(id);
    if (!Number.isInteger(rid) || rid <= 0) throw new BizException(40003, 'id 非法');
    const hq = await hqStoreId();
    return tx(async c => {
      const row = (await c.query(`SELECT * FROM cost_diff_requests WHERE id=$1 FOR UPDATE`, [rid])).rows[0];
      if (!row) throw new BizException(40404, '处置单不存在', 404);
      if (row.status !== 'pending') throw new BizException(40003, `该单已处理（${row.status}）`);
      const pid = Number(row.product_id);
      const actual = Number(row.actual_cost);
      const anomaly = String(row.anomaly);

      // ── low：采纳（降 L1）/ 驳回 ────────────────────────────────────────
      if (anomaly === 'low') {
        const ok = b?.approve !== false;
        if (!ok) {
          await c.query(`UPDATE cost_diff_requests SET status='rejected', audit_remark=$2, audited_by=$3, audited_at=now() WHERE id=$1`,
            [rid, String(b?.remark || '').slice(0, 200) || null, user.sub]);
          await audit(hq, user.sub, '总部', 'cost.request.reject', 'product', pid,
            { storeId: Number(row.store_id), actualCost: actual, l1: row.l1_at_request });
          return { id: rid, status: 'rejected', anomaly };
        }
        const l1res = (await c.query(`SELECT standard_cost FROM products WHERE id=$1 FOR UPDATE`, [pid])).rows[0];
        const old = l1res?.standard_cost === null || l1res?.standard_cost === undefined ? null : Number(l1res.standard_cost);
        // 采纳 = 把 L1 降下来（若已被其他单降得更低则不动）
        if (old === null || actual < old) {
          await c.query(`UPDATE products SET standard_cost=$2, updated_at=now() WHERE id=$1`, [pid, actual]);
          await c.query(
            `INSERT INTO product_standard_cost_logs
               (product_id, old_cost, new_cost, delta, source, ref_id, store_id, supplier_id, reason, operator_id)
             VALUES ($1,$2,$3,$4,'inbound_adopt_lower',$5,$6,$7,$8,$9)`,
            [pid, old, actual, old === null ? null : Number((actual - old).toFixed(4)), rid,
              Number(row.store_id), row.supplier_id || null, `采纳门店进价差异申请 #${rid}`, user.sub]);
          await enqueueDown(c, 'products', pid, 'upsert',
            { id: pid, product_id: pid, entity: 'products', standard_cost: actual }, 'all', null);
        }
        await c.query(
          `UPDATE cost_diff_requests SET status='adopted', adopted_l1=$2, audit_remark=$3, audited_by=$4, audited_at=now() WHERE id=$1`,
          [rid, actual, String(b?.remark || '').slice(0, 200) || null, user.sub]);
        await audit(hq, user.sub, '总部', 'cost.request.adopt', 'product', pid,
          { storeId: Number(row.store_id), actualCost: actual, oldL1: old, newL1: actual });
        return { id: rid, status: 'adopted', anomaly, oldL1: old, newL1: actual };
      }

      // ── high：四选一裁决 ────────────────────────────────────────────────
      const verdict = String(b?.verdict || 'accept');
      const ALLOWED = ['accept', 'adjust_to_l1', 'reject_inbound', 'return_supplier'];
      if (!ALLOWED.includes(verdict)) throw new BizException(40003, `不支持的处置方式：${verdict}`);
      let adjustAmount: number | null = null;
      let note = String(b?.remark || '').slice(0, 200) || null;

      if (verdict === 'adjust_to_l1') {
        // 🔴 只调**未销售余量**的批次记账成本；已销售不追溯（真实毛利留在账上）
        const l1 = row.l1_at_request === null || row.l1_at_request === undefined ? null : Number(row.l1_at_request);
        if (l1 === null) throw new BizException(40003, '该商品无标准进价，不能「调账到标准价」——请先维护进价或改选其他处置');
        const bres = (await c.query(
          `SELECT id, remain_qty, inbound_cost FROM batches
            WHERE product_id=$1 AND store_id=$2 AND remain_qty > 0
              AND inbound_cost IS NOT NULL AND ABS(inbound_cost - $3) > 0.0001
            ORDER BY id FOR UPDATE`,
          [pid, Number(row.store_id), actual])).rows || [];
        let qty = 0, amt = 0;
        for (const bt of bres) {
          const q = Number(bt.remain_qty || 0);
          const diff = Number((Number(bt.inbound_cost) - l1).toFixed(4));
          await c.query(`UPDATE batches SET inbound_cost=$2 WHERE id=$1`, [Number(bt.id), l1]);
          qty += q; amt += q * diff;
        }
        adjustAmount = Number(amt.toFixed(2));
        note = `${note ? note + ' · ' : ''}调账 ${qty} 件未销售余量，差额 ¥${adjustAmount}`;
      }
      await c.query(
        `UPDATE cost_diff_requests SET status=$2, verdict=$3, adjust_amount=$4, audit_remark=$5,
                audited_by=$6, audited_at=now() WHERE id=$1`,
        [rid, verdict === 'accept' ? 'accepted' : (verdict === 'adjust_to_l1' ? 'adjusted' : 'returned'),
          verdict, adjustAmount, note, user.sub]);
      await audit(hq, user.sub, '总部', 'cost.request.' + verdict, 'product', pid,
        { storeId: Number(row.store_id), actualCost: actual, l1: row.l1_at_request, adjustAmount, verdict });
      return { id: rid, anomaly, verdict, adjustAmount };
    });
  }

  /** 高进价处置单逾期扫描（`chain.cost.adjust_window_h` 超时 → 自动认可 + 告警） */
  @RequirePerms('hq.cost.manage')
  @Post('sweep-overdue')
  async sweep(@CurrentUser() user: AuthUser) {
    const hq = await hqStoreId();
    return tx(async c => {
      const rows = (await c.query(
        `UPDATE cost_diff_requests
            SET status='accepted', verdict='accept', audited_at=now(),
                audit_remark=COALESCE(audit_remark,'') || ' [超时自动认可]'
          WHERE status='pending' AND due_at IS NOT NULL AND due_at < now()
          RETURNING id, product_id, store_id`)).rows || [];
      if (rows.length) {
        await audit(hq, user.sub, '总部', 'cost.request.auto_accept', 'product', undefined,
          { count: rows.length, ids: rows.map((x: any) => Number(x.id)) });
      }
      return { swept: rows.length };
    });
  }
}

/**
 * V5.0.0 P2-5 连锁促销投放（方案 §5.4 连锁扩展）：
 *   总部建促销 → 一键投放指定门店（或全部营业店）→ 门店经 /sync/pull 下行落地。
 *   幂等键 = promotions.hq_promo_id（迁移 114，部分唯一索引）——不落总部 id 本身，
 *   避免与门店自建促销的主键 id 撞车；门店行 store_id 在落地端重写为本店。
 * ⚠️ 单店零回归：单店无 org_type='store' 营业门店 → resolveTargetStores 返回空 → 40003 拒绝，无副作用。
 */
@Controller('hq/promotions')
class HqPromotionController {
  /** 投放（可重复投放 = 更新门店侧促销内容；已结束/已停用拒投） */
  @RequirePerms('hq.product.publish', 'promo.manage')
  @Post(':id/publish')
  async publish(
    @Param('id') id: string,
    @Body() b: { storeIds?: number[] | 'all' },
    @CurrentUser() user: AuthUser,
  ) {
    const pid = Number(id);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, '促销 ID 非法');
    const hq = await hqStoreId();
    return tx(async c => {
      const promo = (await c.query(`SELECT * FROM promotions WHERE id=$1 AND store_id=$2`, [pid, hq])).rows?.[0];
      if (!promo) throw new BizException(40404, '促销不存在或不属于总部（门店促销请在本店管理）', 404);
      if (promo.status === '已结束' || promo.status === '已停用') {
        throw new BizException(50016, `促销状态(${promo.status})不允许投放`);
      }
      const sids = await resolveTargetStores(c, b?.storeIds, user);
      if (!sids.length) throw new BizException(40003, '没有可投放的目标门店（无营业中的门店）');
      // 落地 payload：不带 id / store_id（门店端重写本店），hq_promo_id 为幂等键
      const payload = {
        hq_promo_id: pid, name: promo.name, kind: promo.kind, rules: promo.rules,
        scope: promo.scope, start_at: promo.start_at, end_at: promo.end_at, status: promo.status,
      };
      for (const sid of sids) await enqueueDown(c, 'promotions', pid, 'upsert', payload, 'store', [sid]);
      await audit(hq, user.sub, '总部', 'promotion.publish', 'promotion', pid,
        { name: promo.name, stores: sids });
      return { published: sids.length, storeIds: sids, note: '已进入门店下行队列：门店在线拉取后自动生效（促销状态/起止时间以本单为准）' };
    });
  }

  /** 撤销投放（下发「已停用」——门店侧促销置停，留痕不删行） */
  @RequirePerms('hq.product.publish', 'promo.manage')
  @Post(':id/unpublish')
  async unpublish(
    @Param('id') id: string,
    @Body() b: { storeIds?: number[] | 'all' },
    @CurrentUser() user: AuthUser,
  ) {
    const pid = Number(id);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, '促销 ID 非法');
    const hq = await hqStoreId();
    return tx(async c => {
      const promo = (await c.query(`SELECT * FROM promotions WHERE id=$1 AND store_id=$2`, [pid, hq])).rows?.[0];
      if (!promo) throw new BizException(40404, '促销不存在或不属于总部', 404);
      const sids = await resolveTargetStores(c, b?.storeIds, user);
      if (!sids.length) throw new BizException(40003, '没有目标门店');
      const payload = {
        hq_promo_id: pid, name: promo.name, kind: promo.kind, rules: promo.rules,
        scope: promo.scope, start_at: promo.start_at, end_at: promo.end_at, status: '已停用',
      };
      for (const sid of sids) await enqueueDown(c, 'promotions', pid, 'upsert', payload, 'store', [sid]);
      await audit(hq, user.sub, '总部', 'promotion.unpublish', 'promotion', pid, { name: promo.name, stores: sids });
      return { unpublished: sids.length, storeIds: sids };
    });
  }

  /** 投放状态：该促销最近一次投放覆盖的门店 */
  @RequirePerms('hq.product.publish', 'promo.manage', 'hq.report.allstore')
  @Get(':id/stores')
  async publishedStores(@Param('id') id: string) {
    const pid = Number(id);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, '促销 ID 非法');
    const rows = await q(
      `SELECT target, target_ids, created_at
         FROM sync_changes
        WHERE entity='promotions' AND entity_id=$1
        ORDER BY version DESC LIMIT 1`, [pid]);
    const r = rows[0];
    return {
      target: r?.target ?? null,
      storeIds: r?.target_ids ?? null,
      publishedAt: r?.created_at ?? null,
    };
  }
}

/**
 * P2-6 门店设置下发（方案 §3.7 补全）：总部统一把门店级键值推送到指定门店。
 * 复用既有 store_settings 覆盖表（P1 已建）：下发即写总部库覆盖行 + 入队下行；门店在线后 pull 落地。
 * 总部级（scope='hq'）键不走此处 —— PUT /settings/:key 保存时自动全连锁下发（hq_setting）。
 */
@Controller('hq/settings')
class HqSettingsController {
  /** 可下发键清单：仅 scope='store'（门店可自治，总部可统一下发） */
  @RequirePerms('sys.settings')
  @Get('keys')
  async keys() {
    const rows = await q(
      `SELECT setting_key, display_name, value, value_type, enum_options, unit, remark
         FROM system_settings WHERE scope = 'store' ORDER BY id`);
    return { items: rows };
  }

  /** 批量下发：items=[{key,value}]；storeIds 数组或 'all'（全部营业门店） */
  @RequirePerms('sys.settings')
  @Post('push')
  async push(
    @Body() b: { items?: { key: string; value: any }[]; storeIds?: number[] | 'all' },
    @CurrentUser() user: AuthUser,
  ) {
    const items = (b?.items || []).filter((i: any) => i && typeof i.key === 'string' && i.key.trim());
    if (!items.length) throw new BizException(40003, '请选择要下发的设置项');
    return tx(async c => {
      const sids = await resolveTargetStores(c, b?.storeIds, user);
      if (!sids.length) throw new BizException(40003, '没有可下发的目标门店（无营业中的门店）');
      const keyList = items.map(i => i.key);
      const rows = (await c.query(
        `SELECT setting_key, scope FROM system_settings WHERE setting_key = ANY($1::text[])`, [keyList])).rows;
      const scopeMap = new Map(rows.map((r: any) => [String(r.setting_key), String(r.scope || 'store')]));
      const missing = keyList.filter(k => !scopeMap.has(k));
      if (missing.length) throw new BizException(40404, `设置项不存在：${missing.join('、')}`, 404);
      const hqKeys = keyList.filter(k => scopeMap.get(k) !== 'store');
      if (hqKeys.length) throw new BizException(40003, `以下为总部级设置（保存后自动全连锁生效），无需按店下发：${hqKeys.join('、')}`);
      let pushed = 0;
      for (const sid of sids) {
        for (const it of items) {
          await c.query(
            `INSERT INTO store_settings (store_id, setting_key, value, updated_by, updated_at)
             VALUES ($1,$2,$3::jsonb,$4,now())
             ON CONFLICT (store_id, setting_key)
             DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
            [sid, it.key, JSON.stringify(it.value ?? null), user.sub]);
          await enqueueDown(c, 'store_settings', sid, 'upsert', { key: it.key, value: it.value ?? null }, 'store', [sid]);
          pushed++;
        }
      }
      await audit(user.storeId, user.sub, '设置', 'settings.push', 'setting', undefined,
        { keys: keyList, storeIds: sids, pushed });
      return { stores: sids.length, pushed };
    });
  }

  /** 清除门店覆盖（门店回落总部默认值）：keys + storeIds */
  @RequirePerms('sys.settings')
  @Post('push/clear')
  async clear(
    @Body() b: { keys?: string[]; storeIds?: number[] | 'all' },
    @CurrentUser() user: AuthUser,
  ) {
    const keyList = (b?.keys || []).map(String).filter(Boolean);
    if (!keyList.length) throw new BizException(40003, '请选择要清除覆盖的设置键');
    return tx(async c => {
      const sids = await resolveTargetStores(c, b?.storeIds, user);
      if (!sids.length) throw new BizException(40003, '没有目标门店');
      let removed = 0;
      for (const sid of sids) {
        const r = await c.query(
          `DELETE FROM store_settings WHERE store_id=$1 AND setting_key = ANY($2::text[])`, [sid, keyList]);
        removed += r.rowCount || 0;
        for (const k of keyList) {
          await enqueueDown(c, 'store_settings', sid, 'delete', { key: k }, 'store', [sid]);
        }
      }
      await audit(user.storeId, user.sub, '设置', 'settings.push.clear', 'setting', undefined,
        { keys: keyList, storeIds: sids, removed });
      return { stores: sids.length, removed };
    });
  }

  /** 覆盖总览：各店当前被下发的键值（storeId 可选过滤单店） */
  @RequirePerms('sys.settings')
  @Get('overrides')
  async overrides(@Query('storeId') storeId?: string) {
    const sid = Number(storeId) || 0;
    const rows = await q(
      `SELECT ss.store_id, s.name AS store_name, ss.setting_key, ss.value, ss.updated_at
         FROM store_settings ss JOIN stores s ON s.id = ss.store_id
        WHERE ($1::bigint IS NULL OR ss.store_id = $1::bigint)
        ORDER BY ss.store_id, ss.setting_key`, [sid || null]);
    return { items: rows };
  }
}

/**
 * V5.0.0 P3-1 大客户专属价「申请-审批」（老板定版：批发价走总部，门店提交申请、总部审批，提货在门店）：
 *   门店为本店客户提交专价申请 → 总部审批通过后价目当场生效（big_customer_prices upsert）
 *   → 门店团购下单即按专价计（提货=门店 FIFO 扣本店库存，原有逻辑不变）。
 *   申请表沿用 cost_diff_requests「申请/审批同库」模式（P1 批次4 同款架构决策）。
 * 单店零回归：单店（chainEnabled=false）无门店隔离诉求，申请/直设两条路都通（总部视角=本店）。
 */
@Controller('bc-price-requests')
class BcPriceRequestController {

  /** 申请列表（门店看本店；总部看全部；status=all 查全部） */
  @RequirePerms('bigcustomer.manage')
  @Get()
  async list(
    @Query('status') status = 'pending', @Query('storeId') storeId = '',
    @Query('page') page = '1', @Query('size') size = '30',
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(200, Math.max(1, Number(size) || 30));
    const f = storeFilter('r.store_id', 5);
    return { items: await q(
      `SELECT r.*, p.name AS product_name, p.barcode, p.sell_price AS cur_sell_price,
              bc.name AS customer_name, st.name AS store_name,
              e1.name AS creator_name, e2.name AS auditor_name
         FROM bc_price_requests r
         LEFT JOIN products p ON p.id = r.product_id
         LEFT JOIN big_customers bc ON bc.id = r.customer_id
         LEFT JOIN stores st ON st.id = r.store_id
         LEFT JOIN employees e1 ON e1.id = r.created_by
         LEFT JOIN employees e2 ON e2.id = r.audited_by
        WHERE ($1 = '' OR r.status = $1)
          AND ($2::bigint IS NULL OR r.store_id = $2::bigint)
          ${f.sql}
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC
        LIMIT $3 OFFSET $4`,
      [String(status || ''), storeId ? Number(storeId) : null, sz, (pn - 1) * sz, ...f.params]) };
  }

  /** 门店提交专价申请（客户须归属本店；同客户同商品 pending 去重；专价 ≤ 零售价 1.2 倍） */
  @RequirePerms('bigcustomer.manage')
  @Post()
  async create(
    @Body() b: { customerId?: number; productId?: number; reqPrice?: number; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const cid = Number(b?.customerId), pid = Number(b?.productId);
    const price = Number(b?.reqPrice);
    if (!Number.isInteger(cid) || cid <= 0) throw new BizException(40003, '客户未选择');
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, '商品未选择');
    if (!Number.isFinite(price) || price <= 0) throw new BizException(40003, '申请价必须大于 0');
    const sid = curStore();
    return tx(async c => {
      const cust = (await c.query(`SELECT id, name, store_id FROM big_customers WHERE id=$1`, [cid])).rows[0];
      if (!cust) throw new BizException(40404, '客户不存在', 404);
      const { chainEnabled, isHqStore } = await import('../common/scope');
      if ((await chainEnabled()) && !(await isHqStore(user.storeId)) && Number(cust.store_id) !== Number(user.storeId)) {
        throw new BizException(40300, '只能为本店客户提交价申请', 403);
      }
      const p = (await c.query(
        `SELECT id, name, sell_price, wholesale_price FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid])).rows[0];
      if (!p) throw new BizException(40404, '商品不存在', 404);
      if (price > Number(p.sell_price) * 1.2) {
        throw new BizException(40003, `申请价 ${price} 高于零售价 ${p.sell_price} 的 1.2 倍，请核对`);
      }
      const dup = (await c.query(
        `SELECT id FROM bc_price_requests WHERE customer_id=$1 AND product_id=$2 AND status='pending' LIMIT 1`,
        [cid, pid])).rows[0];
      if (dup) throw new BizException(40003, '该客户此商品已有待审批的价申请，请勿重复提交');
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      await seqLock(c, 'bc_price_requests', 'req_no', `SQ-${ymd}-%`);
      const seq = (await c.query(`SELECT count(*)+1 AS n FROM bc_price_requests WHERE req_no LIKE $1`, [`SQ-${ymd}-%`])).rows[0];
      const reqNo = `SQ-${ymd}-${String(seq.n).padStart(4, '0')}`;
      const ins = (await c.query(
        `INSERT INTO bc_price_requests
           (req_no, store_id, customer_id, product_id, req_price, base_price, wholesale_price, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status`,
        [reqNo, sid, cid, pid, price, Number(p.sell_price),
         p.wholesale_price === null || p.wholesale_price === undefined ? null : Number(p.wholesale_price),
         String(b?.reason || '').slice(0, 200) || null, user.sub])).rows[0];
      await audit(sid, user.sub, 'bigcustomer', 'bc.request.create', 'big_customer', cid,
        { reqNo, productId: pid, reqPrice: price, basePrice: Number(p.sell_price) });
      return { id: Number(ins.id), reqNo, status: ins.status };
    });
  }

  /** 总部审批（approve=true 生效价目；approvedPrice 可改判；驳回留因。仅总部/单店可审） */
  @RequirePerms('bigcustomer.manage')
  @Post(':id/audit')
  async auditOne(
    @Param('id') id: string,
    @Body() b: { approve?: boolean; approvedPrice?: number; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const rid = Number(id);
    if (!Number.isInteger(rid) || rid <= 0) throw new BizException(40003, 'id 非法');
    const { assertHqScope } = await import('../common/scope');
    await assertHqScope();   // 门店账号（dataScope='self'）403；单店放行
    const hq = await hqStoreId();
    return tx(async c => {
      const row = (await c.query(`SELECT * FROM bc_price_requests WHERE id=$1 FOR UPDATE`, [rid])).rows[0];
      if (!row) throw new BizException(40404, '申请单不存在', 404);
      if (row.status !== 'pending') throw new BizException(40003, `该申请已处理（${row.status}）`);
      if (b?.approve === false) {
        await c.query(
          `UPDATE bc_price_requests SET status='rejected', audit_remark=$2, audited_by=$3, audited_at=now() WHERE id=$1`,
          [rid, String(b?.remark || '').slice(0, 200) || '不符合定价政策', user.sub]);
        await audit(hq, user.sub, '总部', 'bc.request.reject', 'big_customer', row.customer_id,
          { reqNo: row.req_no, reqPrice: Number(row.req_price), storeId: Number(row.store_id) });
        return { id: rid, status: 'rejected' };
      }
      const approvedPrice = b?.approvedPrice === undefined || b?.approvedPrice === null
        ? Number(row.req_price) : Number(b.approvedPrice);
      if (!(approvedPrice > 0)) throw new BizException(40003, '批准价必须大于 0');
      const p = (await c.query(`SELECT sell_price FROM products WHERE id=$1`, [row.product_id])).rows[0];
      if (p && approvedPrice > Number(p.sell_price) * 1.2) {
        throw new BizException(40003, `批准价 ${approvedPrice} 高于零售价 ${p.sell_price} 的 1.2 倍，请核对`);
      }
      // 价目生效：同客户同商品当前生效期 upsert（与 savePrices 同口径，防止唯一键冲突顺延）
      const exist = (await c.query(
        `SELECT id, valid_from FROM big_customer_prices
          WHERE customer_id=$1 AND product_id=$2 AND valid_from <= CURRENT_DATE
            AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) ORDER BY valid_from DESC LIMIT 1`,
        [row.customer_id, row.product_id])).rows[0];
      let vf: any = exist?.valid_from ?? null;
      if (!vf) {
        const nx = (await c.query(
          `SELECT MAX(valid_from) + 1 AS vf FROM big_customer_prices WHERE customer_id=$1 AND product_id=$2`,
          [row.customer_id, row.product_id])).rows[0];
        vf = nx?.vf ?? new Date();
      }
      await c.query(
        `INSERT INTO big_customer_prices (customer_id, product_id, price, valid_from, valid_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (customer_id, product_id, valid_from)
         DO UPDATE SET price=EXCLUDED.price, valid_to=EXCLUDED.valid_to`,
        [row.customer_id, row.product_id, approvedPrice, vf, null, user.sub]);
      await c.query(
        `UPDATE bc_price_requests SET status='approved', approved_price=$2, audit_remark=$3, audited_by=$4, audited_at=now()
          WHERE id=$1`, [rid, approvedPrice, String(b?.remark || '').slice(0, 200) || null, user.sub]);
      await audit(hq, user.sub, '总部', 'bc.request.approve', 'big_customer', row.customer_id,
        { reqNo: row.req_no, reqPrice: Number(row.req_price), approvedPrice, storeId: Number(row.store_id) });
      return { id: rid, status: 'approved', approvedPrice };
    });
  }
}

/**
 * V5.0.0 P3-2 门店对账核销（老板定版：会员消费、大客户消费后期通过门店与总部对账核销）：
 *   总部按店按期汇总消费（销售额/成本/毛利/会员消费/大客户消费/大客户赊账未回款）
 *   → 一键核销记账（hq_recon_settlements，默认核销毛利，可改金额）→ 核销历史可溯。
 * 权限：hq.finance.view（104 预留「对账中心/门店往来」权限点，此处正式接线）。
 */
async function reconAggregate(from: string, to: string, storeId?: number): Promise<any[]> {
  return q(
    `SELECT o.store_id, st.name AS store_name,
            COUNT(*)::int AS order_count,
            ROUND(COALESCE(SUM(o.payable_amount),0),2) AS sales_total,
            ROUND(COALESCE(SUM(o.cost_amount),0),2) AS cost_total,
            ROUND(COALESCE(SUM(o.profit_amount),0),2) AS profit_total,
            ROUND(COALESCE(SUM(o.payable_amount) FILTER (WHERE o.member_id IS NOT NULL),0),2) AS member_amount,
            ROUND(COALESCE(SUM(o.payable_amount) FILTER (WHERE o.channel='大客户团购'),0),2) AS bc_amount,
            ROUND(COALESCE(SUM(GREATEST(pm.credit - pm.paid, 0)) FILTER (WHERE o.channel='大客户团购'),0),2) AS bc_credit_unpaid,
            ROUND(COALESCE((SELECT SUM(h.settled_amount) FROM hq_recon_settlements h
                             WHERE h.store_id = o.store_id AND h.period_from >= $1::date AND h.period_to <= $2::date),0),2) AS settled_amount
       FROM sales_orders o
       LEFT JOIN stores st ON st.id = o.store_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(amount) FILTER (WHERE channel='赊账'),0) AS credit,
                COALESCE(SUM(amount) FILTER (WHERE channel <> '赊账'),0) AS paid
           FROM sale_payments sp WHERE sp.order_id = o.id
       ) pm ON true
      WHERE o.status IN ('已完成','部分退款')
        AND o.created_at::date >= $1::date AND o.created_at::date <= $2::date
        AND ($3::bigint IS NULL OR o.store_id = $3::bigint)
      GROUP BY o.store_id, st.name
      ORDER BY o.store_id`, [from, to, storeId ?? null]);
}

@Controller('hq/recon')
class HqReconController {

  /** 对账汇总（按店）：from/to 必填（YYYY-MM-DD） */
  @RequirePerms('hq.finance.view')
  @Get('summary')
  async summary(@Query('from') from?: string, @Query('to') to?: string) {
    const f = String(from || '').slice(0, 10), t = String(to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      throw new BizException(40003, 'from/to 必填（YYYY-MM-DD）');
    }
    return { items: await reconAggregate(f, t) };
  }

  /** 核销记账：默认核销期内毛利（可改金额）；settle_no 幂等防重 */
  @RequirePerms('hq.finance.view')
  @Post('settle')
  async settle(
    @Body() b: { storeId?: number; from?: string; to?: string; amount?: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const sid = Number(b?.storeId);
    const f = String(b?.from || '').slice(0, 10), t = String(b?.to || '').slice(0, 10);
    if (!Number.isInteger(sid) || sid <= 0) throw new BizException(40003, '门店未选择');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      throw new BizException(40003, 'from/to 必填（YYYY-MM-DD）');
    }
    const rows = await reconAggregate(f, t, sid);
    const agg = rows[0];
    if (!agg) throw new BizException(40404, '该门店区间内没有消费数据，无需核销', 404);
    const amount = b?.amount === undefined || b?.amount === null
      ? Number(agg.profit_total) : Number(b.amount);
    if (!(amount > 0)) throw new BizException(40003, '核销金额必须大于 0（默认口径 = 期内毛利）');
    const hq = await hqStoreId();
    return tx(async c => {
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      await seqLock(c, 'hq_recon_settlements', 'settle_no', `HX-${ymd}-%`);
      const seq = (await c.query(`SELECT count(*)+1 AS n FROM hq_recon_settlements WHERE settle_no LIKE $1`, [`HX-${ymd}-%`])).rows[0];
      const settleNo = `HX-${ymd}-${String(seq.n).padStart(4, '0')}`;
      const ins = (await c.query(
        `INSERT INTO hq_recon_settlements
           (settle_no, store_id, period_from, period_to, sales_total, cost_total, profit_total,
            member_amount, bc_amount, bc_credit_unpaid, settled_amount, status, note, settled_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'settled',$12,$13) RETURNING id`,
        [settleNo, sid, f, t, agg.sales_total, agg.cost_total, agg.profit_total,
         agg.member_amount, agg.bc_amount, agg.bc_credit_unpaid, amount,
         String(b?.note || '').slice(0, 200) || null, user.sub])).rows[0];
      await audit(hq, user.sub, '财务', 'recon.settle', 'hq_recon_settlement', Number(ins.id),
        { settleNo, storeId: sid, period: `${f}~${t}`, settled: amount, profit: agg.profit_total });
      return { id: Number(ins.id), settleNo, settledAmount: amount, summary: agg };
    });
  }

  /** 核销历史（近 100 条） */
  @RequirePerms('hq.finance.view')
  @Get('settlements')
  async settlements(@Query('storeId') storeId?: string) {
    const sid = Number(storeId) || 0;
    return { items: await q(
      `SELECT h.*, s.name AS store_name, e.name AS settler_name
         FROM hq_recon_settlements h
         LEFT JOIN stores s ON s.id = h.store_id
         LEFT JOIN employees e ON e.id = h.settled_by
        WHERE ($1::bigint IS NULL OR h.store_id = $1::bigint)
        ORDER BY h.id DESC LIMIT 100`, [sid || null]) };
  }
}

@Module({ controllers: [ChainStoreController, ChainProductController, StoreProductController, HqCostController, CostDiffController, HqPromotionController, HqSettingsController, BcPriceRequestController, HqReconController] })
export class ChainModule {}