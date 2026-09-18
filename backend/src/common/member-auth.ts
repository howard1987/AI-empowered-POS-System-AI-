import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator, SetMetadata } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { JWT_SECRET } from './auth';
import { setCtx } from './context';

/** 会员端 JWT 载荷（与员工端 kind 区分，互不通用） */
export interface MemberUser {
  sub: number;        // member id
  kind: 'member';
  storeId: number;
  phone: string;
  name: string | null;
}

declare module 'express-serve-static-core' {
  interface Request { muser?: MemberUser; }
}

export const MEMBER_PUBLIC = 'memberPublic';
/** 会员端免登录端点（登录/注册/首次设密） */
export const MemberPublic = () => SetMetadata(MEMBER_PUBLIC, true);

@Injectable()
export class MemberGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const isPublic = Reflect.getMetadata(MEMBER_PUBLIC, ctx.getHandler());
    if (isPublic) return true;
    const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
    if (!m) throw new UnauthorizedException('未登录');
    try {
      const p = jwt.verify(m[1], JWT_SECRET) as unknown as MemberUser;
      if (p.kind !== 'member') throw new Error('not member token');
      req.muser = p;
      setCtx(p.storeId, null); // P3-1：会员端店铺上下文
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    return true;
  }
}

/** 取当前登录会员（控制器参数装饰器） */
export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MemberUser => ctx.switchToHttp().getRequest().muser,
);
