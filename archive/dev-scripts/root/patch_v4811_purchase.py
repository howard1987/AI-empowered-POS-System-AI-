# -*- coding: utf-8 -*-
# V4.8.11 后端：费用类型/协议/费用单端点（purchase.module.ts）
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend', 'src', 'modules', 'purchase.module.ts')
s = io.open(P, encoding='utf-8').read()

# 锚点：GET suppliers 之前插入新端点组（放在 Controller 内、suppliers 之前）
OLD = """  @Get('suppliers')"""
NEW = """  // ═══════════ 费用类型字典 / 费用协议 / 费用单（V4.8.11，5.6） ═══════════

  /** 费用类型字典（db/011 种子；direction 收=供应商给店 / 付=补给供应商） */
  @Get('fee-types')
  async feeTypes() {
    return q(`SELECT * FROM supplier_fee_types ORDER BY id`);
  }

  /** 费用协议列表（可按供应商过滤，含类型名） */
  @Get('fee-agreements')
  async feeAgreements(@Query('supplierId') supplierId?: string) {
    const sid = Number(supplierId);
    return { items: await q(
      `SELECT a.*, t.name AS fee_type_name, t.direction, t.code AS fee_type_code, s.name AS supplier_name
         FROM supplier_fee_agreements a
         JOIN supplier_fee_types t ON t.id = a.fee_type_id
         JOIN suppliers s ON s.id = a.supplier_id
        WHERE ($1 = 0 OR a.supplier_id = $1)
        ORDER BY a.id DESC LIMIT 100`, [sid]) };
  }

  /** 新建费用协议（月周期固定额/销售额比例；auto_generate=true 时对账自动补齐漏记期次） */
  @Post('fee-agreements')
  async createFeeAgreement(
    @Body() b: { supplierId: number; feeTypeId: number; cycle?: string; amountMode?: string;
                 amount?: number; ratio?: number; autoGenerate?: boolean; startDate: string; endDate?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const sid = Number(b.supplierId), tid = Number(b.feeTypeId);
    if (!(sid > 0) || !(tid > 0)) throw new BizException(40003, 'supplierId 与 feeTypeId 必填');
    if (!b.startDate) throw new BizException(40003, 'startDate 必填');
    const mode = b.amountMode === '按销售额比例' ? '按销售额比例' : '固定额';
    if (mode === '固定额' && !(Number(b.amount) > 0)) throw new BizException(40003, '固定额协议金额必须大于 0');
    if (mode === '按销售额比例' && !(Number(b.ratio) > 0 && Number(b.ratio) <= 1))
      throw new BizException(40003, '比例协议 ratio 必须在 (0,1] 区间');
    const sup = await q1(`SELECT id FROM suppliers WHERE id=$1`, [sid]);
    if (!sup) throw new BizException(40404, '供应商不存在', 404);
    const t = await q1(`SELECT id FROM supplier_fee_types WHERE id=$1`, [tid]);
    if (!t) throw new BizException(40404, '费用类型不存在', 404);
    const rows = await q(
      `INSERT INTO supplier_fee_agreements (store_id, supplier_id, fee_type_id, cycle, amount_mode, amount, ratio,
                                            auto_generate, start_date, end_date, status)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING *`,
      [sid, tid, b.cycle === '月' ? '月' : '月', mode,
       mode === '固定额' ? Number(b.amount) : null, mode === '按销售额比例' ? Number(b.ratio) : null,
       b.autoGenerate !== false, b.startDate, b.endDate ?? null]);
    await audit(1, user.sub, '财务', 'fee.agreement.create', 'fee_agreement', Number(rows[0].id),
      { supplierId: sid, feeTypeId: tid, mode, amount: b.amount ?? null, ratio: b.ratio ?? null });
    return rows[0];
  }

  /** 费用单列表（协议自动生成 + 人工录入；可按供应商过滤） */
  @Get('fees')
  async feeList(@Query('supplierId') supplierId?: string) {
    const sid = Number(supplierId);
    return { items: await q(
      `SELECT f.*, t.name AS fee_type_name, t.direction, s.name AS supplier_name
         FROM supplier_fees f
         JOIN supplier_fee_types t ON t.id = f.fee_type_id
         JOIN suppliers s ON s.id = f.supplier_id
        WHERE ($1 = 0 OR f.supplier_id = $1)
        ORDER BY f.id DESC LIMIT 100`, [sid]) };
  }

  /** 人工临时费用录入（陈列费/补差等一次性费用；录入即生效留痕，对账时吸收） */
  @Post('fees')
  async createFee(
    @Body() b: { supplierId: number; feeTypeId: number; amount: number;
                 periodStart?: string; periodEnd?: string; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const sid = Number(b.supplierId), tid = Number(b.feeTypeId);
    if (!(sid > 0) || !(tid > 0)) throw new BizException(40003, 'supplierId 与 feeTypeId 必填');
    if (!(Number(b.amount) > 0)) throw new BizException(40003, '费用金额必须大于 0');
    const sup = await q1(`SELECT id FROM suppliers WHERE id=$1`, [sid]);
    if (!sup) throw new BizException(40404, '供应商不存在', 404);
    const t = await q1(`SELECT direction FROM supplier_fee_types WHERE id=$1`, [tid]);
    if (!t) throw new BizException(40404, '费用类型不存在', 404);
    return tx(async c => {
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const seq = await cx(c, `SELECT count(*)+1 AS n FROM supplier_fees WHERE fee_no LIKE $1`, [`FY-M${ymd}-%`]);
      const feeNo = `FY-M${ymd}-${String(seq[0].n).padStart(3, '0')}`;
      const rows = await cx(c,
        `INSERT INTO supplier_fees (store_id, fee_no, supplier_id, fee_type_id, period_start, period_end,
                                    amount, to_dividend_pool, status, employee_id, remark)
         VALUES (1,$1,$2,$3,$4,$5,$6,false,'已审核',$7,$8) RETURNING *`,
        [feeNo, sid, tid, b.periodStart ?? null, b.periodEnd ?? null, Number(b.amount), user.sub,
         b.remark ? `人工录入：${b.remark}` : '人工录入']);
      await audit(1, user.sub, '财务', 'fee.create', 'supplier_fee', Number(rows[0].id),
        { feeNo, supplierId: sid, feeTypeId: tid, amount: Number(b.amount) });
      return rows[0];
    });
  }

  @Get('suppliers')"""
assert s.count(OLD) == 1, f'锚点不唯一: {s.count(OLD)}'
s = s.replace(OLD, NEW)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('PURCHASE PATCH DONE')
