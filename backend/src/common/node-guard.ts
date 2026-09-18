/**
 * V5.0.0 连锁 · 节点鉴权守卫（方案 §4.9 简化版，P1 落地）
 *   Authorization: Node <node_code>:<token>  +  X-Sync-Ts（±300s 防重放）
 *   token 与 stores.node_secret 明文比对（timingSafeEqual）；P2 可升级 bcrypt/轮换。
 *
 * 批次5 从 sync.module.ts 抽出为公共文件：会员资产端点（member-chain.module）
 * 同样走节点鉴权，避免循环 import（sync.module 会引用 member-chain 的镜像快照助手）。
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { q, q1 } from './db';

export const REPLAY_WINDOW_MS = 300_000;   // ±300s（方案 §4.9）

/**
 * P2-2：nonce 去重（防重放第二道闸）。
 *   时间戳窗口只保证「请求时间新鲜」，窗口内的重放仍可原样打进来；
 *   本守卫再记 (node_code, nonce) 一次性凭据：门店请求带 x-sync-nonce（UUID），
 *   老客户端未带时以 ts 值兜底（同毫秒两请求视为重放，现实请求间隔远大于 1ms）。
 *   清理：1/20 概率顺手删 10 分钟前的旧行（nonce 表天然有界）。
 */
async function consumeNonce(nodeCode: string, nonce: string): Promise<void> {
  const ins = await q1<{ x?: number }>(
    `INSERT INTO sync_nonces (node_code, nonce) VALUES ($1,$2)
      ON CONFLICT (node_code, nonce) DO NOTHING RETURNING 1 AS x`, [nodeCode, nonce]);
  if (!ins) throw new UnauthorizedException('请求已处理过（nonce 重放拦截）');
  if (Math.random() < 0.05) {
    q(`DELETE FROM sync_nonces WHERE seen_at < now() - interval '10 minutes'`).catch(() => {});
  }
}

@Injectable()
export class NodeGuard implements CanActivate {

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // 保留了 @Public 语义（bootstrap meta 等无需鉴权时可用）；默认必须节点鉴权
    const req = ctx.switchToHttp().getRequest();
    const auth = String(req.headers['authorization'] ?? '');
    const m = auth.match(/^Node\s+(\S+):(\S+)$/i);
    const ts = Number(req.headers['x-sync-ts'] ?? 0);
    if (!m || !ts || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      throw new UnauthorizedException('节点鉴权失败（缺少 Node 凭据或时间戳超窗）');
    }
    const [, nodeCode, token] = m;
    const node = await q1<any>(
      `SELECT n.node_code, n.store_id, n.status, n.is_self, s.node_secret, s.sync_enabled, s.status AS store_status
         FROM sync_nodes n LEFT JOIN stores s ON s.id = n.store_id
        WHERE n.node_code = $1 AND n.is_self = false`, [nodeCode]);
    if (!node || node.status !== '启用' || node.store_status !== 1 || !node.sync_enabled) {
      throw new UnauthorizedException('节点未注册或已停用');
    }
    if (!node.node_secret || !safeEqual(String(token), String(node.node_secret))) {
      throw new UnauthorizedException('节点令牌无效');
    }
    await consumeNonce(nodeCode, String(req.headers['x-sync-nonce'] ?? ts).slice(0, 80));
    (req as any).syncNode = { nodeCode, storeId: Number(node.store_id) };
    return true;
  }
}

/** 恒定时间比较（防时序侧信道） */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
