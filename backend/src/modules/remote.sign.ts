/**
 * V4.15.3 远程电子签名（手机充当手写板）
 *   场景：电脑端未配备手写板时，采集业务员/客户/店员电子签名——
 *   电脑端弹窗发起签名请求（POST /sign-remote）→ 手机端 PWA「我的-电子签名」看到请求
 *   → 签字人手机屏幕手写（复用 SignPad）→ 提交回传（POST /sign-remote/:id/submit）
 *   → 电脑端弹窗轮询取回签字图，走既有的 /purchase/signatures/attach（补签）或
 *     /purchase/signatures（预采集）落证据链，流程与本地手写完全一致。
 *   取件码：6 位数字，手机端与电脑端人工核对同一次请求；30 分钟未签字自动置已过期。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Controller, Get, Param, ParseIntPipe, Post, Body, Query } from '@nestjs/common';
import { q, q1, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser } from '../common/auth';
import { saveBase64Image } from './sign';

const PENDING_TTL_MIN = 30;    // 待签字有效期（分钟），超时置已过期
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

function expireStale() {
  // 过期不阻塞主流程：UPDATE 失败忽略
  return q(`UPDATE remote_sign_requests SET status='已过期'
             WHERE status='待签字' AND created_at < now() - interval '${PENDING_TTL_MIN} minutes'`).catch((): any => undefined);
}

@Controller('sign-remote')
export class RemoteSignController {
  /** 电脑端发起签名请求 */
  @Post()
  async create(
    @Body() b: { title?: string; personHint?: string; bizRef?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const title = String(b.title || '').trim();
    if (!title || title.length > 128) throw new BizException(40003, '签名用途标题必填且 ≤128 字');
    for (let i = 0; i < 5; i++) {
      const reqNo = String(Math.floor(100000 + Math.random() * 900000));   // 6 位取件码
      try {
        const row = await q1(
          `INSERT INTO remote_sign_requests (store_id, req_no, title, person_hint, biz_ref, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, req_no`,
          [user.storeId || 1, reqNo, title,
           String(b.personHint || '').trim() || null,
           String(b.bizRef || '').trim() || null,
           user.sub, user.name || '']);
        await audit(user.storeId || 1, user.sub, '财务', 'sign.remote.create', 'remote_sign_request', Number(row.id),
          { title, bizRef: b.bizRef || null });
        return row;
      } catch { /* req_no 唯一冲突 → 换码重试 */ }
    }
    throw new BizException(50000, '取件码生成失败，请重试');
  }

  /** 手机端：待签字列表（「我的-电子签名」拉取；超时自动过期） */
  @Get('pending')
  async pending(@CurrentUser() user: AuthUser) {
    await expireStale();
    return { items: await q(
      `SELECT id, req_no, title, person_hint, biz_ref, status, created_at
         FROM remote_sign_requests
        WHERE store_id=$1 AND status='待签字'
        ORDER BY id DESC LIMIT 20`, [user.storeId || 1]) };
  }

  /** 电脑端轮询签字结果；待签收/已签字返回 dataURL 样本图组（与现场补签同源） */
  @Get()
  async detail(@Query('id') id: string, @CurrentUser() user: AuthUser) {
    const rid = Number(id);
    if (!(rid > 0)) throw new BizException(40003, 'id 必填');
    await expireStale();
    const row = await q1(`SELECT * FROM remote_sign_requests WHERE id=$1`, [rid]);
    if (!row) throw new BizException(40404, '签名请求不存在', 404);
    if (Number(row.store_id) !== Number(user.storeId) && !user.perms.includes('*')) throw new BizException(40404, '签名请求不存在', 404); // P2-M5 跨店收敛
    let images: string[] = [];
    const rels: string[] = Array.isArray(row.result_images) ? row.result_images
      : (row.result_image_path ? [row.result_image_path] : []);
    if (['待签收', '已签字'].includes(String(row.status))) {
      images = rels.map(p => readImageAsDataUrl(String(p))).filter(Boolean) as string[];
    }
    return { id: Number(row.id), reqNo: row.req_no, title: row.title, status: row.status,
             personName: row.result_person || null, signedAt: row.signed_at,
             attempts: Number(row.attempts || 0), returnNote: row.return_note || null,
             image: images[0] || null, images };
  }

  /** 手机端提交签字（V4.16.5：images 可传 1~3 张样本；提交后进入「待签收」，后台预览合格点签收才置已签字，不合格可退回重签） */
  @Post(':id/submit')
  async submit(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { personName?: string; image?: string; images?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    const name = String(b.personName || '').trim();
    if (!name || name.length > 32) throw new BizException(40003, '签字人姓名必填且 ≤32 字');
    const shots = (Array.isArray(b.images) ? b.images : []).filter(x => /^data:image\/(png|jpeg|jpg);base64,.+$/.test(String(x || '')));
    if (!shots.length && /^data:image\/(png|jpeg|jpg);base64,.+$/.test(String(b.image || ''))) shots.push(String(b.image));
    if (!shots.length) throw new BizException(40003, '签字图片必须为 base64 dataURL');
    if (shots.length > 3) throw new BizException(40003, '一次最多 3 张签字样本');
    const row = await q1(`SELECT * FROM remote_sign_requests WHERE id=$1`, [id]);
    if (!row) throw new BizException(40404, '签名请求不存在', 404);
    if (row.status !== '待签字') throw new BizException(50080, `该签名请求已处理（${row.status}），请电脑端重新发起`);
    const paths = shots.map(s => saveBase64Image(s));
    const upd = await q1(
      `UPDATE remote_sign_requests
          SET status='待签收', result_image_path=$2, result_images=$3::jsonb, result_person=$4, signed_at=now()
        WHERE id=$1 AND status='待签字' RETURNING id`,
      [id, paths[0], JSON.stringify(paths), name]);
    if (!upd) throw new BizException(50080, '该签名请求已被处理，请电脑端重新发起');
    await audit(user.storeId || 1, user.sub, '财务', 'sign.remote.submit', 'remote_sign_request', id,
      { personName: name, samples: paths.length });
    return { ok: true, samples: paths.length };
  }

  /** 电脑端「签收」：预览合格 → 置已签字（前端随后走 attach/预采集入口落证据链） */
  @Post(':id/accept')
  async accept(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const upd = await q1(
      `UPDATE remote_sign_requests SET status='已签字' WHERE id=$1 AND status='待签收' RETURNING id`, [id]);
    if (!upd) throw new BizException(40404, '请求不存在或状态不允许签收', 404);
    await audit(user.storeId || 1, user.sub, '财务', 'sign.remote.accept', 'remote_sign_request', id, {});
    return { ok: true };
  }

  /** 电脑端「退回重签」：预览不合格 → 置回待签字，手机端收到退回提示后重新采集 */
  @Post(':id/return')
  async returnBack(@Param('id', ParseIntPipe) id: number, @Body() b: { note?: string }, @CurrentUser() user: AuthUser) {
    const note = String(b.note || '').trim().slice(0, 200);
    const upd = await q1(
      `UPDATE remote_sign_requests
          SET status='待签字', result_image_path=NULL, result_images=NULL, signed_at=NULL,
              attempts=COALESCE(attempts,0)+1, return_note=$2
        WHERE id=$1 AND status='待签收' RETURNING id`, [id, note || null]);
    if (!upd) throw new BizException(40404, '请求不存在或状态不允许退回', 404);
    await audit(user.storeId || 1, user.sub, '财务', 'sign.remote.return', 'remote_sign_request', id, { note });
    return { ok: true };
  }

  /** 电脑端取消请求 */
  @Post(':id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const upd = await q1(
      `UPDATE remote_sign_requests SET status='已取消' WHERE id=$1 AND status='待签字' RETURNING id`, [id]);
    if (!upd) throw new BizException(40404, '请求不存在或已处理', 404);
    await audit(user.storeId || 1, user.sub, '财务', 'sign.remote.cancel', 'remote_sign_request', id, {});
    return { ok: true };
  }
}

/** 签字图回读为 dataURL（已签字轮询返回；文件缺失返回 undefined 不阻断轮询完成态） */
function readImageAsDataUrl(imagePath: string): string | undefined {
  try {
    const rel = imagePath.replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.includes('\\')) return undefined; // P1-H3：拒绝穿越
    const root = path.resolve(__dirname, '..', '..', 'public');
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) return undefined;
    const ext = (rel.split('.').pop() || 'png').toLowerCase();
    return `data:${IMAGE_MIME[ext] || 'image/png'};base64,${fs.readFileSync(full).toString('base64')}`;
  } catch { return undefined; }
}
