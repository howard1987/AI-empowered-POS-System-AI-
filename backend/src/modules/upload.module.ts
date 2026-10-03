import { Module, Controller, Post, Body } from '@nestjs/common';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser } from '../common/auth';
import { audit } from '../common/db';
import { saveUploadImage, isRealImage } from '../common/uploads';

/** 移动端图片上传（8.5 员工 PWA：退货凭证/报损照片）：
 *  base64 dataURL → 落盘上传目录（V4.15.5：AI_UPLOADS_DIR 可外置+按月子目录）→ 返回静态路径，供
 *  POST /purchase/returns/:id/evidence、POST /inventory/losses 引用 */
@Controller('upload')
class UploadController {
  @Post()
  upload(@Body() b: { image?: string }, @CurrentUser() user: AuthUser) {
    const image = String(b.image || '');
    const m = image.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!m) throw new BizException(40003, '仅支持 PNG/JPEG/WebP 的 base64 图片');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 8 * 1024 * 1024) throw new BizException(40003, '图片为空或超过 8MB');
    if (!isRealImage(buf, ext)) throw new BizException(40003, '文件头不是合法的 PNG/JPEG/WebP 图片');   // P4：magic-byte 校验
    const name = `up_${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
    const path = saveUploadImage(buf, name);
    audit(user.storeId, user.sub, '系统', 'upload', 'upload', 0, { file: name });
    return { path };
  }
}

@Module({ controllers: [UploadController] })
export class UploadModule {}
