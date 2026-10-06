import { Module, Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, audit } from '../common/db';
import { recognizeDocument } from './ai.ocr';
import { curStore } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';

// ─── T3：供应商资质/合同/证照（连锁谈价依据 + 食安合规预警） ───
// 路由挂在 /purchase 命名空间下，与供应商主数据同源；写操作复用已有权限点 purchase.po.approve
@Controller('purchase/supplier-qualifications')
class SupplierQualificationController {

  /** 列表：按供应商查；expireSoon 参数返回 N 天内将过期的临期证照（食安预警） */
  @Get()
  async list(@Query('supplierId') supplierId?: string, @Query('expireSoon') expireSoon?: string) {
    if (expireSoon) {
      const days = Math.min(Math.max(1, Number(expireSoon) || 30), 365);
      return { items: await q(
        `SELECT q.*, s.name AS supplier_name
           FROM supplier_qualifications q
           JOIN suppliers s ON s.id = q.supplier_id
          WHERE q.expire_date IS NOT NULL
            AND q.expire_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
          ORDER BY q.expire_date ASC
          LIMIT 200`, [days]) };
    }
    const sid = Number(supplierId);
    if (!(sid > 0)) return { items: [] };
    return { items: await q(
      `SELECT q.*, s.name AS supplier_name
         FROM supplier_qualifications q
         JOIN suppliers s ON s.id = q.supplier_id
        WHERE q.supplier_id = $1
        ORDER BY q.id DESC`, [sid]) };
  }

  @RequirePerms('purchase.po.approve')
  @Post()
  async create(@Body() b: any, @CurrentUser() user: AuthUser) {
    const sid = Number(b?.supplierId);
    if (!(sid > 0)) throw new BizException(40003, 'supplierId 必填');
    const sup = await q1(`SELECT id FROM suppliers WHERE id=$1`, [sid]);
    if (!sup) throw new BizException(40404, '供应商不存在', 404);
    const r = await q1(
      `INSERT INTO supplier_qualifications
        (supplier_id, store_id, cert_type, cert_no, title, issuer, issue_date, expire_date, attachment_url, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [sid, curStore(),
       String(b.certType || '').trim(), b.certNo || null, b.title || null, b.issuer || null,
       b.issueDate || null, b.expireDate || null, b.attachmentUrl || null, b.remark || null]);
    await audit(curStore(), user.sub, '采购', 'supplier_qualification.create', 'supplier_qualification', Number(r.id),
      { supplierId: sid, certType: b.certType });
    return r;
  }

  @RequirePerms('purchase.po.approve')
  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() b: any, @CurrentUser() user: AuthUser) {
    const r = await q1(`SELECT id FROM supplier_qualifications WHERE id=$1`, [id]);
    if (!r) throw new BizException(40404, '资质记录不存在', 404);
    await q(
      `UPDATE supplier_qualifications SET
         cert_type=COALESCE($1,cert_type), cert_no=COALESCE($2,cert_no), title=COALESCE($3,title),
         issuer=COALESCE($4,issuer), issue_date=COALESCE($5,issue_date), expire_date=COALESCE($6,expire_date),
         attachment_url=COALESCE($7,attachment_url), remark=COALESCE($8,remark), updated_at=now()
       WHERE id=$9`,
      [b.certType || null, b.certNo || null, b.title || null, b.issuer || null,
       b.issueDate || null, b.expireDate || null, b.attachmentUrl || null, b.remark || null, id]);
    await audit(curStore(), user.sub, '采购', 'supplier_qualification.update', 'supplier_qualification', id, {});
    return q1(`SELECT * FROM supplier_qualifications WHERE id=$1`, [id]);
  }

  @RequirePerms('purchase.po.approve')
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const r = await q1(`SELECT id FROM supplier_qualifications WHERE id=$1`, [id]);
    if (!r) throw new BizException(40404, '资质记录不存在', 404);
    await q(`DELETE FROM supplier_qualifications WHERE id=$1`, [id]);
    await audit(curStore(), user.sub, '采购', 'supplier_qualification.delete', 'supplier_qualification', id, {});
    return { ok: true };
  }

  /** T3 增强：上传证照/合同图片 → AI 识别自动填充编号/发证机关/有效期（不入库，仅回填前端） */
  @Post('recognize')
  async recognize(@Body() b: { image?: string; type?: string }, @CurrentUser() user: AuthUser) {
    const image = String(b.image || '').replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');
    if (!image) throw new BizException(40003, '请先上传图片');
    return recognizeDocument(image, b.type || '证照/合同');
  }
}

@Module({ controllers: [SupplierQualificationController] })
export class SupplierQualificationModule {}
