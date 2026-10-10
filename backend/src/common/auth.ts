import {
  CanActivate, ExecutionContext, Injectable, SetMetadata,
  UnauthorizedException, ForbiddenException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { setCtx } from './context';

/**
 * JWT 密钥（V4.14.4 安全加固）：优先 env JWT_SECRET；
 * 未配置时首启生成 48 字节随机密钥持久化到 backend/.runtime/jwt-secret（0600 权限），
 * 杜绝硬编码默认值——拿到源码不等于拿到密钥。密钥文件随店迁移或改用 env 即可固定会话。
 */
/**
 * JWT 密钥（V4.14.4 安全加固；整改 P0-F3：拒绝弱密钥）：
 * env JWT_SECRET 需长度 ≥32 且不在已知示例弱值内，否则忽略 env、改用首启随机持久化密钥——
 * 杜绝照抄 .env.example 部署导致离线伪造 ADMIN token。
 */
const WEAK_JWT = new Set(['local-dev-secret-change-me', 'change-me', 'secret', '123456', 'cashier-dev-secret']);
function resolveJwtSecret(): string {
  const env = process.env.JWT_SECRET;
  if (env && env.length >= 32 && !WEAK_JWT.has(env)) return env;
  if (env) console.warn('[安全] JWT_SECRET 过弱或长度不足 32，已忽略并改用随机生成密钥（P0-F3 整改）');
  const file = path.join(__dirname, '..', '..', '.runtime', 'jwt-secret');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const s = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
    console.warn(`[安全] 未配置 JWT_SECRET，已生成随机密钥持久化：${file}（换机迁移请一并带走，或改配 env）`);
    return s;
  } catch {
    console.warn('[安全] JWT 密钥文件读写失败，本次运行使用进程内随机密钥（重启后需重新登录）');
    return crypto.randomBytes(48).toString('hex');
  }
}
export const JWT_SECRET = resolveJwtSecret();

/** JWT 载荷（权限点集合在登录时一次性打入，避免每请求查库；角色变更后重新登录生效） */
export interface AuthUser {
  sub: number;        // employee id
  storeId: number;
  empNo: string;
  name: string;
  perms: string[];    // 权限点 code 集合（5.11 颗粒化）
  /** P0-F3：初始/默认密码未修改的会话标记——仅允许改密与自查类端点 */
  pwd?: 'default';
  /** P1-H5：签发时的 token_version；DB 版本前进（改密/停用）后旧 token 失效 */
  tv?: number;
  /**
   * V5.0.0 连锁（方案 §2.6.1）：数据范围 self 仅本店 / region 本区域 / all 全部门店（总部）。
   * 登录时按角色解析一次打入 JWT（与 perms 同策略），守卫写入请求上下文 → 请求内零查库。
   * 缺省（老 token / 未设角色的账号）视为 'all' —— 与改造前行为一致（不加限制）。
   */
  ds?: 'self' | 'region' | 'all';
  /** V5.0.0：可见门店 id 集合（ds='self'/'region' 时）；ds='all' 时为 null/缺省 */
  ss?: number[] | null;
  /** V5.0.0：scope_type='hq' 角色判定（总部角色标记，用于前端菜单分组与审计标注） */
  hq?: boolean;
}

declare module 'express-serve-static-core' {
  interface Request { user?: AuthUser; }
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** P1-H5：员工在职状态 + token_version 的 60s 进程内缓存（吊销判定的低成本来源） */
import { q1 } from './db';
const stateCache = new Map<number, { status: string; tv: number; exp: number }>();
async function empState(sub: number) {
  const now = Date.now();
  const hit = stateCache.get(sub);
  if (hit && hit.exp > now) return hit;
  const r = await q1<any>(`SELECT status, COALESCE(token_version,0) AS token_version FROM employees WHERE id=$1`, [sub]);
  // S-01：吊销判定缓存 TTL 由 60s 收紧到 10s。配合「停用/注销一律 token_version+1」，
  // 即便多实例（PM2 cluster）无共享缓存，旧会话也最坏 10s 内被守卫拒绝（tv 校验天然跨进程）。
  const v = { status: r?.status ?? '离职', tv: Number(r?.token_version ?? 0), exp: now + 10_000 };
  stateCache.set(sub, v);
  return v;
}
/** 改密/重置/停用后立即清缓存，使吊销即时生效（本进程内 0 延迟） */
export function clearAuthStateCache(sub: number) { stateCache.delete(sub); }

export const PERMS_KEY = 'requirePerms';
/** 接口所需权限点（满足其一即可），如 @RequirePerms('stock.inbound.audit') */
export const RequirePerms = (...codes: string[]) => SetMetadata(PERMS_KEY, codes);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
    if (!m) throw new UnauthorizedException('未登录');
    let user: AuthUser & { kind?: string };
    try {
      user = jwt.verify(m[1], JWT_SECRET) as unknown as AuthUser & { kind?: string };
      if (user.kind === 'member') throw new Error('member token 不可用于员工端点');
      req.user = user;
      // P3-1 + V5.0.0：写入权威归属门店与数据范围（读路径可见范围）到请求上下文
      setCtx(req.user!.storeId, req.user!.sub, req.user!.ds ?? 'all', req.user!.ss ?? null);
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('登录已过期，请重新登录');
    }

    // P1-H5 吊销：员工停用/删除或 token_version 前进（改密/重置/强制下线）→ 60s 内全端点失效
    const st = await empState(user.sub);
    if (st.status !== '在职') throw new UnauthorizedException('账号已停用，如有疑问请联系店长');
    if ((user.tv ?? 0) < st.tv) throw new UnauthorizedException('登录状态已刷新，请重新登录');

    // P0-F3 默认口令门禁：仍在使用初始密码的会话只能改密/查看自己，其余端点一律 403
    if (req.user!.pwd === 'default') {
      const pathOnly = String(req.path || req.url || '').split('?')[0];
      const allow = ['/auth/change-password', '/auth/me', '/auth/sec-questions'];
      if (!allow.some(p => pathOnly === p || pathOnly.endsWith(p))) {
        throw new ForbiddenException('安全限制：初始密码尚未修改，请先通过「修改密码」完成改密（P0-F3）');
      }
    }

    const need = this.reflector.getAllAndOverride<string[]>(PERMS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (need && need.length) {
      // 超管豁免仅认 '*' 通配权限（P0-F3 整改：移除按工号 ADMIN 的硬编码豁免，避免用户名级绕过）
      const has = req.user!.perms.includes('*') || need.some(p => req.user!.perms.includes(p));
      if (!has) {
        throw new ForbiddenException(
          `无操作权限（需要权限点：${need.join(' / ')}）。请联系超级管理员（ADMIN）在「后台 → 员工与角色」中为该角色勾选对应权限。`,
        );
      }
    }
    return true;
  }
}

/** 取当前登录员工（控制器参数装饰器） */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
