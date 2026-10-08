import { Module, Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { createHash } from 'crypto';
import { q, q1, tx, cx, r2, r3, r4, audit, pool, seqLock } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { SettingsService } from './settings.module';
import { autoAttachSignature, attachSignature, attachOperatorSignature, confirmSignature, saveBase64Image, nameMatches, normalizeName, collectIntoTemplates, personCatOf, mergeSamples, PERSON_CATS } from './sign';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价
import { chainEnabled, hqStoreId } from '../common/scope';  // V5.0.0 批次4B：对账计价引擎只在连锁模式触发
import { COST_REF } from '../common/sql';                   // V5.0.0 批次4B：结算价 = L1（R17）

// ─── V5.0.16 采购单智能匹配（移动收货：按收货商品相似度推荐关联近似采购单）──
// 归一化：全角→半角、转小写、去空白与常见标点/括号，便于「宜简 饮用-纯净水(500ml)」与「宜简饮用纯净水500ml」对齐
function normMatchName(s: any): string {
  return String(s ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s·・.,，、_\-—/\\()（）【】\[\]]/g, '');
}
// 条码归一化：全角→半角、去空白/前缀；条码是商品唯一标识，匹配时以此为最准确依据
function normBc(s: any): string {
  return String(s ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '');
}
// Dice 系数（字符 bigram 多重集相似度），0~1；完全相同=1
function nameDiceSim(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // 包含关系（较短一方是较长一方的子串，且较短≥2字）→ 视为高度相似：
  //   解决 Dice 对「简称/短名 vs 全名」惩罚过大的问题（如「可乐」vs「可口可乐」、「金龙鱼」vs「金龙鱼调和油」）。
  //   较短一方需≥2字，避免「水」这类单字被「矿泉水」包含而误判为同一商品。
  if (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))) return 0.9;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const ga = grams(a), gb = grams(b);
  let inter = 0;
  for (const [g, c] of ga) inter += Math.min(c, gb.get(g) || 0);
  return (2 * inter) / ((a.length - 1) + (b.length - 1));
}
const PO_MATCH_COVER = 0.7;    // 覆盖率阈值：已录入商品被采购单覆盖比例 ≥70% → 判定为「近似采购单」
const PO_MATCH_ITEM_SIM = 0.6; // 单商品识别为「已录入」的名称相似度下限

// ─── Controller（采购与供应商：供应商 / 入库审核→批次 / 退货自动归属 T7 / 对账结算 T8，方案 5.2 / 5.5 / 5.6） ───
@Controller('purchase')
class PurchaseController {
  private settings = new SettingsService();

  /** 必签校验（5.6.8⑤ 触发场景矩阵可配 auth.sign_required_scenes）：配置含该场景且单据未签字 → 拒绝过审 */
  private async assertSigned(c: any, scene: string, table: string, bizId: number, docNo: string) {
    const scenes = await this.settings.getJson('auth.sign_required_scenes', []);
    if (!Array.isArray(scenes) || !scenes.includes(scene)) return;
    const rows = await cx(c, `SELECT sign_record_id FROM ${table} WHERE id=$1`, [bizId]);
    if (rows.length && !rows[0].sign_record_id) {
      throw new BizException(50018, `${docNo} 尚未电子签字，按"必签才能过审"配置请先在单据列表补签后再审核`);
    }
  }

  /** 供应商列表（拼音码检索） */
  // ═══════════ 费用类型字典 / 费用协议 / 费用单（V4.8.11，5.6） ═══════════

  /** 费用类型字典（db/011 种子；direction 收=供应商给店 / 付=补给供应商） */
  @Get('fee-types')
  async feeTypes() {
    return q(`SELECT * FROM supplier_fee_types ORDER BY id`);
  }

  /** V4.13.9 新增自定义费用类型（费用单/费用协议手输自动建档，后期可用）；同名直接复用 */
  @RequirePerms('recon.confirm', 'purchase.po.approve')
  @Post('fee-types')
  async createFeeType(@Body() b: { name?: string; direction?: string }, @CurrentUser() user: AuthUser) {
    const name = String(b.name || '').trim();
    if (!name) throw new BizException(40003, '费用项名称必填');
    if (name.length > 32) throw new BizException(40003, '费用项名称过长（≤32 字）');
    const dir = b.direction === '付' ? '付' : '收';
    const dup = await q1(`SELECT * FROM supplier_fee_types WHERE name=$1`, [name]);
    if (dup) return dup;
    const code = 'custom_' + createHash('md5').update(name).digest('hex').slice(0, 10);
    const r = await q1(`INSERT INTO supplier_fee_types (code, name, direction) VALUES ($1,$2,$3) RETURNING *`, [code, name, dir]);
    await audit(curStore(), user.sub, '财务', 'fee_type.create', 'fee_type', Number(r.id), { name, direction: dir });
    return r;
  }

  /** 费用协议列表（可按供应商过滤，含类型名；方向行级优先） */
  @Get('fee-agreements')
  async feeAgreements(@Query('supplierId') supplierId?: string) {
    const sid = Number(supplierId);
    return { items: await q(
      `SELECT a.*, COALESCE(a.direction, t.direction) AS direction, t.name AS fee_type_name, t.code AS fee_type_code, s.name AS supplier_name
         FROM supplier_fee_agreements a
         JOIN supplier_fee_types t ON t.id = a.fee_type_id
         JOIN suppliers s ON s.id = a.supplier_id
        WHERE ($1 = 0 OR a.supplier_id = $1)
        ORDER BY a.id DESC LIMIT 100`, [sid]) };
  }

  /** 新建费用协议（周期性月周期固定额/销售额比例，或一次性费用；auto_generate=true 时对账自动补齐漏记期次） */
  @RequirePerms('recon.confirm', 'purchase.po.approve')
  @Post('fee-agreements')
  async createFeeAgreement(
    @Body() b: { supplierId: number; feeTypeId: number; cycle?: string; amountMode?: string;
                 amount?: number; ratio?: number; autoGenerate?: boolean; startDate: string; endDate?: string; direction?: string;
                 feeNature?: string; totalPeriods?: number },
    @CurrentUser() user: AuthUser,
  ) {
    const sid = Number(b.supplierId), tid = Number(b.feeTypeId);
    if (!(sid > 0) || !(tid > 0)) throw new BizException(40003, 'supplierId 与 feeTypeId 必填');
    if (!b.startDate) throw new BizException(40003, 'startDate 必填');
    const mode = b.amountMode === '按销售额比例' ? '按销售额比例' : '固定额';
    if (mode === '固定额' && !(Number(b.amount) > 0)) throw new BizException(40003, '固定额协议金额必须大于 0');
    if (mode === '按销售额比例' && !(Number(b.ratio) > 0 && Number(b.ratio) <= 1))
      throw new BizException(40003, '比例协议 ratio 必须在 (0,1] 区间');
    // V4.14.0 A：协议性质——一次性（只补 1 期）/ 周期性（期数留空=不限，填了=到 N 期后自动停）
    const feeNature = b.feeNature === '一次性' ? '一次性' : '周期性';
    let totalPeriods: number | null = Number(b.totalPeriods) > 0 ? Math.floor(Number(b.totalPeriods)) : null;
    if (feeNature === '一次性') totalPeriods = 1;
    if (totalPeriods !== null && totalPeriods > 120) throw new BizException(40003, '期数上限 120 期');
    const sup = await q1(`SELECT id FROM suppliers WHERE id=$1`, [sid]);
    if (!sup) throw new BizException(40404, '供应商不存在', 404);
    const t = await q1(`SELECT id FROM supplier_fee_types WHERE id=$1`, [tid]);
    if (!t) throw new BizException(40404, '费用类型不存在', 404);
    const rows = await q(
      `INSERT INTO supplier_fee_agreements (store_id, supplier_id, fee_type_id, cycle, amount_mode, amount, ratio,
                                            auto_generate, start_date, end_date, status, direction, fee_nature, total_periods)
       VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12) RETURNING *`,
      [sid, tid, b.cycle === '月' ? '月' : '月', mode,
       mode === '固定额' ? Number(b.amount) : null, mode === '按销售额比例' ? Number(b.ratio) : null,
       b.autoGenerate !== false, b.startDate, b.endDate ?? null,
       b.direction === '付' ? '付' : b.direction === '收' ? '收' : null,
       feeNature, totalPeriods]);
    await audit(curStore(), user.sub, '财务', 'fee.agreement.create', 'fee_agreement', Number(rows[0].id),
      { supplierId: sid, feeTypeId: tid, mode, amount: b.amount ?? null, ratio: b.ratio ?? null, direction: b.direction ?? null,
        feeNature, totalPeriods });
    return rows[0];
  }

  // ═══════════ V4.14.1 供应商变更单（参照供货资格变更单：调进价/售价/主次供应商，落单留痕+立即生效） ═══════════

  /** 变更单列表（留痕可追溯） */
  @Get('supplier-changes')
  async supplierChanges(@Query('supplierId') supplierId?: string) {
    const sid = Number(supplierId) || 0;   // V4.14.2：无参数时归 0（Number(undefined)=NaN 会令 PG int 参数报 invalid input syntax）
    return { items: await q(
      `SELECT sc.*, s1.name AS old_supplier_name, s2.name AS new_supplier_name, e.name AS creator_name
         FROM supplier_changes sc
         LEFT JOIN suppliers s1 ON s1.id = sc.old_supplier_id
         LEFT JOIN suppliers s2 ON s2.id = sc.new_supplier_id
         LEFT JOIN employees e ON e.id = sc.created_by
        WHERE ($1 = 0 OR sc.old_supplier_id = $1 OR sc.new_supplier_id = $1)
        ORDER BY sc.id DESC LIMIT 100`, [sid]) };
  }

  /** 变更单明细 */
  @Get('supplier-changes/:id')
  async supplierChangeDetail(@Param('id', ParseIntPipe) id: number) {
    const h = await q1<any>(
      `SELECT sc.*, s1.name AS old_supplier_name, s2.name AS new_supplier_name, e.name AS creator_name
         FROM supplier_changes sc
         LEFT JOIN suppliers s1 ON s1.id = sc.old_supplier_id
         LEFT JOIN suppliers s2 ON s2.id = sc.new_supplier_id
         LEFT JOIN employees e ON e.id = sc.created_by
        WHERE sc.id=$1`, [id]);
    if (!h) throw new BizException(40404, '变更单不存在', 404);
    return { change: h, items: h.items || [] };
  }

  /** 新建供应商变更单（即时生效）：逐行调整 新进价/新售价/主供应商切换（主供应商=新供应商）/独立供应（清除其他供应商关联），全程留痕可回溯 */
  @RequirePerms('stock.inbound.audit')
  @Post('supplier-changes')
  async createSupplierChange(
    @Body() b: { oldSupplierId?: number; newSupplierId: number; reason?: string;
                 items: { productId: number; newCost?: number; newPrice?: number; isPrimary?: boolean; independent?: boolean }[] },
    @CurrentUser() user: AuthUser,
  ) {
    const newSid = Number(b.newSupplierId);
    if (!(newSid > 0)) throw new BizException(40003, 'newSupplierId 必填（变更为哪个供应商）');
    const sup = await q1(`SELECT id, name FROM suppliers WHERE id=$1`, [newSid]);
    if (!sup) throw new BizException(40404, '供应商不存在', 404);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '变更明细为空');
    if (items.length > 200) throw new BizException(40003, '变更明细过多（上限 200 行）');
    return tx(async c => {
      const cxq = (sql: string, p: any[] = []) => c.query(sql, p).then((x: any) => x.rows);
      const seq = await seqLock(c, 'supplier_changes', 'change_no', `GYSBG-${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, '')}-%`);
      const changeNo = `GYSBG-${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq[0].n).padStart(3, '0')}`;
      const enriched: any[] = [];
      for (const it of items) {
        const pid = Number(it.productId);
        const ps = await cxq(`SELECT id, name, barcode, base_unit, spec, sell_price, supplier_default_id FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
        if (!ps.length) throw new BizException(40404, `商品#${pid} 不存在`, 404);
        const p = ps[0];
        const oldCostRows = await cxq(
          `SELECT price FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
          [pid, newSid]);
        const oldCost = oldCostRows.length ? Number(oldCostRows[0].price) : null;
        const oldPrice = Number(p.sell_price);
        const newCost = it.newCost !== undefined && it.newCost !== null && Number(it.newCost) > 0 ? Number(it.newCost) : null;
        const newPrice = it.newPrice !== undefined && it.newPrice !== null && Number(it.newPrice) > 0 ? Number(it.newPrice) : null;
        const isPrimary = !!it.isPrimary;
        const independent = !!it.independent;   // V4.14.2：独立供应——清除该商品与其他供应商的进价关联，商品档案供应商只剩新供应商
        // ① 新进价：新供应商进价记录落一条（min_price 联动维护）
        if (newCost !== null) {
          await cxq(
            `INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
             VALUES ($1,$2,$3,$4,$5)`,
            [pid, newSid, newCost, Math.min(newCost, oldCost ?? newCost), changeNo]);
        }
        // ①.5 V4.14.2 独立供应：删除其他供应商的进价关联（旧记录已逐条快照进留痕明细）
        let removedSuppliers: { supplierId: number; supplierName: string; lastPrice: number | null }[] = [];
        if (independent) {
          const olds = await cxq(
            `SELECT pp.supplier_id, s.name AS supplier_name, pp.price
               FROM supplier_product_prices pp LEFT JOIN suppliers s ON s.id = pp.supplier_id
              WHERE pp.product_id = $1 AND pp.supplier_id <> $2`, [pid, newSid]);
          removedSuppliers = olds.map((r2: any) => ({
            supplierId: Number(r2.supplier_id), supplierName: r2.supplier_name || `#${r2.supplier_id}`,
            lastPrice: r2.price != null ? Number(r2.price) : null,
          }));
          await cxq(`DELETE FROM supplier_product_prices WHERE product_id = $1 AND supplier_id <> $2`, [pid, newSid]);
        }
        // ② 新售价：商品档案售价同步（V4.26.5：改基线价 → 同步清空门店覆盖行）
        if (newPrice !== null && newPrice !== oldPrice) {
          await cxq(`UPDATE products SET sell_price=$2, updated_at=now() WHERE id=$1`, [pid, newPrice]);
          await storePrice.clearProduct(c, pid).catch(() => 0);
        }
        // ③ 主供应商切换：products.supplier_default_id = 新供应商（独立供应隐含切换）
        if ((isPrimary || independent) && Number(p.supplier_default_id) !== newSid) {
          await cxq(`UPDATE products SET supplier_default_id=$2, updated_at=now() WHERE id=$1`, [pid, newSid]);
        }
        enriched.push({
          productId: pid, productName: p.name, barcode: p.barcode || '', unit: p.base_unit || '', spec: p.spec || '',
          oldCost, newCost, oldPrice, newPrice, isPrimary, independent, removedSuppliers,
          oldPrimarySupplierId: p.supplier_default_id ? Number(p.supplier_default_id) : null,
        });
      }
      const ins = await cxq(
        `INSERT INTO supplier_changes (store_id, change_no, old_supplier_id, new_supplier_id, items, reason, status, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,'已完成',$7) RETURNING *`,
        [user.storeId, changeNo, Number(b.oldSupplierId) || null, newSid, JSON.stringify(enriched), b.reason ?? null, user.sub]);
      await audit(user.storeId, user.sub, '商品', 'supplier.change', 'supplier_change', Number(ins[0].id),
        { changeNo, newSupplierId: newSid, lines: enriched.length,
          costLines: enriched.filter(x => x.newCost != null).length,
          priceLines: enriched.filter(x => x.newPrice != null).length,
          primaryLines: enriched.filter(x => x.isPrimary).length });
      return ins[0];
    });
  }

  /** 费用单列表（协议自动生成 + 人工录入；可按供应商过滤；方向：行级优先，缺省沿用类型字典） */
  @Get('fees')  async feeList(@Query('supplierId') supplierId?: string) {
    const sid = Number(supplierId) || 0;   // V4.14.2：同上，防 NaN
    return { items: await q(
      `SELECT f.*, COALESCE(f.direction, t.direction) AS direction, t.name AS fee_type_name, s.name AS supplier_name
         FROM supplier_fees f
         JOIN supplier_fee_types t ON t.id = f.fee_type_id
         JOIN suppliers s ON s.id = f.supplier_id
        WHERE ($1 = 0 OR f.supplier_id = $1)
        ORDER BY f.id DESC LIMIT 100`, [sid]) };
  }

  /** 人工临时费用录入（陈列费/补差等一次性费用；录入即生效留痕，对账时吸收） */
  @RequirePerms('recon.confirm', 'purchase.po.approve')
  @Post('fees')
  async createFee(
    @Body() b: { supplierId: number; feeTypeId?: number; feeName?: string; direction?: string; amount: number;
                 periodStart?: string; periodEnd?: string; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const sid = Number(b.supplierId), tid = Number(b.feeTypeId);
    if (!(sid > 0)) throw new BizException(40003, 'supplierId 必填');
    if (!(Number(b.amount) > 0)) throw new BizException(40003, '费用金额必须大于 0');
    const sup = await q1(`SELECT id FROM suppliers WHERE id=$1`, [sid]);
    if (!sup) throw new BizException(40404, '供应商不存在', 404);
    // V4.13.9 行级方向：供应商应付（收，对账扣减-）/ 供应商应收（付，对账增加+）；缺省沿用类型字典
    let typeId = tid;
    let typeDir = '';
    if (typeId > 0) {
      const t = await q1(`SELECT direction FROM supplier_fee_types WHERE id=$1`, [typeId]);
      if (!t) throw new BizException(40404, '费用类型不存在', 404);
      typeDir = String(t.direction);
    } else if (b.feeName) {
      // 费用项手输自动建档：预设里没有就新建（后期可用）
      const name = String(b.feeName).trim().slice(0, 32);
      const exist = await q1(`SELECT * FROM supplier_fee_types WHERE name=$1`, [name]);
      const dir0 = b.direction === '付' ? '付' : '收';
      const t = exist ?? await q1(
        `INSERT INTO supplier_fee_types (code, name, direction) VALUES ($1,$2,$3) RETURNING *`,
        ['custom_' + createHash('md5').update(name).digest('hex').slice(0, 10), name, dir0]);
      typeId = Number(t.id); typeDir = String(t.direction);
    } else {
      throw new BizException(40003, 'feeTypeId 或 feeName 必填');
    }
    const direction = b.direction === '付' ? '付' : b.direction === '收' ? '收' : typeDir;
    // VQA-D3：recon.fee_to_dividend——收取方向费用落库即打计入分红池标记（to_dividend_pool 列自 001 设计起闲置，现接通）
    const fee2pool = direction === '收' && await this.settings.getBool('recon.fee_to_dividend', false);
    return tx(async c => {
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const seq = await seqLock(c, 'supplier_fees', 'fee_no', `FY-M${ymd}-%`);
      const feeNo = `FY-M${ymd}-${String(seq[0].n).padStart(3, '0')}`;
      const rows = await cx(c,
        `INSERT INTO supplier_fees (store_id, fee_no, supplier_id, fee_type_id, period_start, period_end,
                                    amount, direction, to_dividend_pool, status, employee_id, remark)
         VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,'已审核',$9,$10) RETURNING *`,
        [feeNo, sid, typeId, b.periodStart ?? null, b.periodEnd ?? null, Number(b.amount), direction, fee2pool, user.sub,
         b.remark ? `人工录入：${b.remark}` : '人工录入']);
      await audit(curStore(), user.sub, '财务', 'fee.create', 'supplier_fee', Number(rows[0].id),
        { feeNo, supplierId: sid, feeTypeId: typeId, amount: Number(b.amount), direction, toPool: fee2pool });
      return rows[0];
    });
  }

  @Get('suppliers')
  async suppliers(@Query('keyword') keyword?: string, @Query('includeDisabled') includeDisabled?: string) {
    const kw = (keyword || '').trim();
    // V5.0.6：默认仅返回启用（status=1）供应商（采购订单等下拉用）；
    // 管理页传 includeDisabled=1 时返回 启用+停用（status IN (1,2)），停用满 90 天方可删除
    const inc = includeDisabled === '1';
    return q(
      `SELECT s.*,
              EXISTS (SELECT 1 FROM purchase_orders o WHERE o.supplier_id = s.id
                      AND o.status NOT IN ('草稿', '待审批', '已取消'))
              OR EXISTS (SELECT 1 FROM inbound_orders i WHERE i.supplier_id = s.id AND i.status <> '已作废')
              OR EXISTS (SELECT 1 FROM purchase_returns r WHERE r.supplier_id = s.id AND r.status NOT IN ('待审核', '已取消', '已作废'))
              AS has_business
         FROM suppliers s
        WHERE s.status ${inc ? '<> 0' : '= 1'}
          AND ($1 = '' OR s.name ILIKE '%'||$1||'%' OR s.pinyin_code ILIKE '%'||$1||'%')
        ORDER BY s.id`, [kw],
    );
  }

  /** V5.0.6 停用/启用供应商：status 1=启用 2=停用；停用置 disabled_at，启用清空 */
  @RequirePerms('purchase.po.approve')
  @Post('suppliers/:id/toggle-status')
  async toggleSupplierStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { status: number },
    @CurrentUser() user: AuthUser,
  ) {
    const row = await q1(`SELECT id, name, status FROM suppliers WHERE id=$1`, [id]);
    if (!row) throw new BizException(40404, '供应商不存在', 404);
    const target = Number(b.status);
    if (target !== 1 && target !== 2) throw new BizException(40003, 'status 仅支持 1（启用）或 2（停用）');
    if (Number(row.status) === target) return { id, status: target, unchanged: true };
    if (target === 2) {
      await q1(`UPDATE suppliers SET status=2, disabled_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      await audit(curStore(), user.sub, '基础档案', 'supplier.disable', 'supplier', id, { name: row.name });
      return { id, status: 2 };
    }
    await q1(`UPDATE suppliers SET status=1, disabled_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    await audit(curStore(), user.sub, '基础档案', 'supplier.enable', 'supplier', id, { name: row.name });
    return { id, status: 1 };
  }

  /** V5.0.6 供应商删除：须先停用，且停用满 90 天方可删除（软删 status=0，保留业务单据外键引用） */
  @RequirePerms('purchase.po.approve')
  @Delete('suppliers/:id')
  async deleteSupplier(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM suppliers WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new BizException(40404, '供应商不存在', 404);
      const st = Number(rows[0].status);
      // V5.0.6：删除前置条件——已启用（status=1）须先停用；已停用（status=2）须满 90 天
      if (st === 1) throw new BizException(50010, '该供应商仍在启用中，请先「停用」再删除');
      if (st === 2) {
        const da = rows[0].disabled_at ? new Date(rows[0].disabled_at) : null;
        if (!da) throw new BizException(50010, '停用时间缺失，无法判定是否满足 90 天删除条件');
        const days = (Date.now() - da.getTime()) / 86400000;
        if (days < 90) {
          const left = Math.max(0, Math.ceil(90 - days));
          throw new BizException(50010, `供应商停用未满 90 天，暂不可删除（还需约 ${left} 天）`);
        }
      }
      await cx(c, `DELETE FROM supplier_product_prices WHERE supplier_id=$1`, [id]);
      await cx(c, `UPDATE products SET supplier_default_id = NULL WHERE supplier_default_id=$1`, [id]);
      // 软删除：置 status=0（列表 status<>0 过滤），历史单据外键引用保留
      await cx(c, `UPDATE suppliers SET status = 0 WHERE id=$1`, [id]);
      await audit(curStore(), user.sub, '基础档案', 'supplier.delete', 'supplier', id, { name: rows[0].name, soft: true });
      return { id, deleted: true, soft: true };
    });
  }

  @RequirePerms('purchase.po.approve')
  @Post('suppliers')
  async createSupplier(@Body() b: any) {
    if (!b.name) throw new BizException(40003, '供应商名称必填');
    if (!b.contactPerson) throw new BizException(40003, '业务员（联系人）必填');
    if (!b.contactPhone) throw new BizException(40003, '电话必填');
    if (!b.bizMode) throw new BizException(40003, '经营方式必填');
    return q1(
      `INSERT INTO suppliers (store_id, name, pinyin_code, contact_person, contact_phone, address, biz_mode,
                              deduction_rate, guarantee_min, settle_period, remark)
       VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.name, b.pinyinCode ?? null, b.contactPerson, b.contactPhone, b.address ?? null,
       b.bizMode === '联营' ? '联营' : '购销',
       b.bizMode === '联营' ? (b.deductionRate ?? null) : null, b.guaranteeMin ?? null,
       b.settlePeriod ?? '月结', b.remark ?? null],
    );
  }

  /** 编辑供应商（V4.8.21 双击行内编辑；contact_person 即常驻业务员；V4.9.4 地址 + 购销时扣点置空） */
  @RequirePerms('purchase.po.approve')
  @Put('suppliers/:id')
  async updateSupplier(@Param('id', ParseIntPipe) id: number, @Body() b: any) {
    const row = await q1(`SELECT id FROM suppliers WHERE id=$1`, [id]);
    if (!row) throw new BizException(40404, '供应商不存在', 404);
    return q1(
      `UPDATE suppliers SET
         name           = COALESCE($2, name),
         pinyin_code    = COALESCE($3, pinyin_code),
         contact_person = COALESCE($4, contact_person),
         contact_phone  = COALESCE($5, contact_phone),
         address        = COALESCE($6, address),
         biz_mode       = COALESCE($7, biz_mode),
         deduction_rate = CASE WHEN COALESCE($7, biz_mode) = '购销' THEN NULL ELSE COALESCE($8, deduction_rate) END,
         guarantee_min  = COALESCE($9, guarantee_min),
         settle_period  = COALESCE($10, settle_period),
         remark         = COALESCE($11, remark)
       WHERE id=$1 RETURNING *`,
      [id, b.name ?? null, b.pinyinCode ?? null, b.contactPerson ?? null, b.contactPhone ?? null,
       b.address ?? null, b.bizMode ? (b.bizMode === '联营' ? '联营' : '购销') : null,
       b.deductionRate ?? null, b.guaranteeMin ?? null, b.settlePeriod ?? null, b.remark ?? null]);
  }

  /** ═══════════ 采购订单（PO：建单→提交→审批→到货转入库，方案 5.2 / 5.2.8） ═══════════ */

  /** 采购订单列表（日期 / 供应商 / 状态 / 关键字筛选） */
  @Get('orders')
  async poList(
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('keyword') keyword?: string,
  ) {
    const kw = (keyword || '').trim();
    return q(
      `SELECT o.id, o.store_id, o.po_no, o.supplier_id, o.status, o.source,
              to_char(o.expect_arrival,'YYYY-MM-DD') AS expect_arrival,
              o.total_amount, o.total_qty, o.remark, o.void_reason,
              o.approver_id, to_char(o.approved_at,'YYYY-MM-DD HH24:MI') AS approved_at,
              o.approver_sign_path, o.created_at, o.updated_at,
              s.name AS supplier_name,
              em.name AS maker_name,
              /* V4.14.9 来源列：智能补货 / 某某某（移动端店员）/ 库存管理（缺货转订货）/ 自建（制单人） */
              CASE o.source
                WHEN '补货建议' THEN '智能补货'
                WHEN '订货申请' THEN COALESCE(em.name, '店员') || '（移动端店员）'
                WHEN '库存缺货' THEN '库存管理（缺货转订货）'
                WHEN '智能生成' THEN '智能生成'
                WHEN '调拨缺口' THEN '调拨（自动生成）'
                ELSE '自建（' || COALESCE(em.name, '管理员') || '）'
              END AS source_label,
              (SELECT count(*) FROM purchase_order_items i WHERE i.po_id = o.id) AS item_count
         FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN employees em ON em.id = o.applicant_id
        WHERE ($1::bigint IS NULL OR o.supplier_id = $1::bigint)
          AND ($2::text IS NULL OR o.status::text = $2)
          AND ($3::date IS NULL OR o.created_at::date >= $3::date)
          AND ($4::date IS NULL OR o.created_at::date <= $4::date)
          AND ($5 = '' OR o.po_no ILIKE '%'||$5||'%' OR s.name ILIKE '%'||$5||'%')
        ORDER BY o.id DESC LIMIT 100`,
      [supplierId ? Number(supplierId) : null, status || null, from || null, to || null, kw],
    );
  }

  /** V4.9.5 商品-供应商绑定校验：单据商品必须属于该供应商（建档绑定 ∪ 有进价记录） */
  private async assertProductsBound(c: any, supplierId: number, productIds: number[]) {
    const ids = [...new Set(productIds.map(Number).filter(Boolean))];
    if (!ids.length) return;
    const rows = await cx(c,
      `SELECT p.id, p.name FROM products p
        WHERE p.id = ANY($2::bigint[]) AND p.deleted_at IS NULL
          AND p.supplier_default_id IS DISTINCT FROM $1
          AND NOT EXISTS (SELECT 1 FROM supplier_product_prices s
                           WHERE s.product_id = p.id AND s.supplier_id = $1)`, [supplierId, ids]);
    if (rows.length) {
      throw new BizException(40003,
        `商品与供应商不匹配：${rows[0].name} 不属于当前供应商供应（商品-供应商已绑定，A 供应商单据只能录入 A 供应商供应的商品）`);
    }
  }

  /** 创建采购订单（手动；items 需 productId / orderQty）。
   *  V4.13.9 订货申请（source=订货申请）免选供应商：按商品默认供应商自动分桶，
   *  多供应商 → 每供应商一张采购单；无供应商属性商品拒绝并提示补档案。 */
  @RequirePerms('purchase.po.approve')
  @Post('orders')
  async createPo(@Body() b: { supplierId?: number; items: any[]; expectArrival?: string; remark?: string; source?: string;
                             poScope?: string; targetStoreId?: number },
                 @CurrentUser() user: AuthUser) {
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '采购明细不能为空');
    const source = ['手动', '智能生成', '补货建议', '订货申请', '库存缺货'].includes(String(b.source)) ? String(b.source) : '手动';
    // V5.0.0 批次6（M6-6）：poScope='hq' 总部集采（应付记总部）；targetStoreId 指定直送门店
    const poScope = String(b.poScope) === 'hq' ? 'hq' : 'store';
    const targetStoreId = poScope === 'hq' && Number(b.targetStoreId) > 0 ? Number(b.targetStoreId) : null;

    return tx(async c => {
      // 分桶：显式传 supplierId → 全部归入；否则按商品默认供应商
      const buckets = new Map<number, any[]>();
      const noSup: string[] = [];
      for (const it of b.items) {
        if (!it.productId || !(Number(it.orderQty) > 0)) throw new BizException(40003, '明细需包含 productId / orderQty');
        const p = await cx(c,
          `SELECT id, name, supplier_default_id FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(it.productId)]);
        if (!p.length) throw new BizException(40404, `商品#${it.productId} 不存在`, 404);
        const sup = Number(b.supplierId || 0) || Number(p[0].supplier_default_id || 0);
        if (!sup) { noSup.push(String(p[0].name)); continue; }
        if (!buckets.has(sup)) buckets.set(sup, []);
        buckets.get(sup)!.push(it);
      }
      if (noSup.length) {
        throw new BizException(40003,
          `以下商品没有供应商属性，无法生成订货申请：${noSup.join('、')}。请联系管理员/店长在商品档案中补全供应商`);
      }
      const docs = [];
      for (const [supId, items] of buckets) {
        docs.push(await this.createPoDoc(c, supId, items, { ...b, poScope, targetStoreId }, source, user));
      }
      return docs.length === 1
        ? { ...docs[0], multi: false }
        : { multi: true, docCount: docs.length, docs, ...docs[0] };
    });
  }

  /** 单供应商采购单落库（V4.13.9 从 createPo 拆出，供自动分桶复用；批次6：支持集采 po_scope/直送门店） */
  private async createPoDoc(c: any, supplierId: number, items: any[],
                            b: { expectArrival?: string; remark?: string; poScope?: string; targetStoreId?: number | null },
                            source: string, user: AuthUser) {
    await this.assertProductsBound(c, supplierId, items.map(it => Number(it.productId)));
    const seq = await seqLock(c, 'purchase_orders', 'po_no', `CG-${today()}-%`);
    const no = `CG-${today()}-${String(seq[0].n).padStart(3, '0')}`;
    let totalAmount = 0, totalQty = 0;
    for (const it of items) {
      totalQty += Number(it.orderQty);
      totalAmount += Number(it.orderQty) * (Number(it.price) || 0);
    }
    const ord = await cx(c,
      `INSERT INTO purchase_orders (store_id, po_no, supplier_id, status, source, expect_arrival,
                                    total_amount, total_qty, applicant_id, remark, po_scope, target_store_id)
       VALUES (${curStore()},$1,$2,'草稿',$3,$4,$5,$6,$7,$8,COALESCE($9,'store'),$10) RETURNING id`,
      [no, supplierId, source, b.expectArrival ?? null, r2(totalAmount), r3(totalQty), user.sub,
       b.remark ?? null, b.poScope ?? null, b.targetStoreId ?? null]);
    for (const it of items) {
      await cx(c,
        `INSERT INTO purchase_order_items (po_id, product_id, order_qty, price, line_remark)
         VALUES ($1,$2,$3,$4,$5)`,
        [ord[0].id, it.productId, it.orderQty, it.price !== undefined ? Number(it.price) : null,
         it.lineRemark ?? null]);
    }
    await audit(curStore(), user.sub, '进销存', 'po.create', 'purchase_order', Number(ord[0].id),
      { poNo: no, supplierId, items: items.length, totalAmount, source });
    // V4.15.0 签字3：订货单只签登录账号员工（操作员）签名，不涉及供应商业务员
    await attachOperatorSignature(c, {
      storeId: 1, bizType: 'order', bizId: Number(ord[0].id),
      summary: `${no}|${supplierId}|${items.length}项`, usedBy: user.sub,
    });
    return { id: ord[0].id, poNo: no, supplierId, status: '草稿', totalAmount: r2(totalAmount) };
  }

  /** 采购订单详情（含明细，JOIN 商品名/单位/供应商） */
  @Get('orders/:id')
  async poDetail(@Param('id', ParseIntPipe) id: number) {
    const ord = await q1(
      `SELECT o.id, o.store_id, o.po_no, o.supplier_id, o.status, o.source,
              to_char(o.expect_arrival,'YYYY-MM-DD') AS expect_arrival,
              o.total_amount, o.total_qty, o.remark, o.void_reason,
              o.approver_id, to_char(o.approved_at,'YYYY-MM-DD HH24:MI') AS approved_at,
              o.approver_sign_path, o.applicant_id, o.created_at, o.updated_at,
              s.name AS supplier_name, e.name AS approver_name
         FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN employees e ON e.id = o.approver_id
        WHERE o.id=$1`, [id]);
    if (!ord) throw new BizException(40404, '采购订单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit
         FROM purchase_order_items i JOIN products p ON p.id = i.product_id
        WHERE i.po_id = $1 ORDER BY i.id`, [id],
    );
    return { ...ord, id: Number(ord.id), items };
  }

  /** 提交审批（草稿→待审批） */
  @RequirePerms('purchase.po.approve')
  @Post('orders/:id/submit')
  async submitPo(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new BizException(40404, '采购订单不存在', 404);
      if (rows[0].status !== '草稿') throw new BizException(50010, `状态(${rows[0].status})不可提交审批`);
      await cx(c, `UPDATE purchase_orders SET status='待审批', applicant_id=$2, updated_at=now() WHERE id=$1`, [id, user.sub]);
      await audit(curStore(), user.sub, '进销存', 'po.submit', 'purchase_order', id, { poNo: rows[0].po_no });
      return { id, status: '待审批' };
    });
  }

  /** 草稿单据修改（V4.9.4：明细弹窗内增减行/改数量进价备注，仅草稿可改） */
  @RequirePerms('purchase.po.approve')
  @Put('orders/:id')
  async updatePo(@Param('id', ParseIntPipe) id: number,
                 @Body() b: { supplierId?: number; expectArrival?: string; remark?: string; items?: any[] },
                 @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new BizException(40404, '采购订单不存在', 404);
      if (rows[0].status !== '草稿') throw new BizException(50010, `状态(${rows[0].status})不可修改，仅草稿可改`);
      if (b.supplierId) await cx(c, `UPDATE purchase_orders SET supplier_id=$2 WHERE id=$1`, [id, Number(b.supplierId)]);
      if (b.expectArrival !== undefined) await cx(c, `UPDATE purchase_orders SET expect_arrival=$2 WHERE id=$1`, [id, b.expectArrival || null]);
      if (b.remark !== undefined) await cx(c, `UPDATE purchase_orders SET remark=$2 WHERE id=$1`, [id, b.remark || null]);
      if (Array.isArray(b.items)) {
        if (!b.items.length) throw new BizException(40003, '采购明细不能为空');
        let totalAmount = 0, totalQty = 0;
        for (const it of b.items) {
          if (!it.productId || !(Number(it.orderQty) > 0)) throw new BizException(40003, '明细需包含 productId / orderQty');
          totalQty += Number(it.orderQty);
          totalAmount += Number(it.orderQty) * (Number(it.price) || 0);
        }
        await cx(c, `DELETE FROM purchase_order_items WHERE po_id=$1`, [id]);
        for (const it of b.items) {
          await cx(c,
            `INSERT INTO purchase_order_items (po_id, product_id, order_qty, price, line_remark)
             VALUES ($1,$2,$3,$4,$5)`,
            [id, it.productId, it.orderQty, it.price !== undefined ? Number(it.price) : null, it.lineRemark ?? null]);
        }
        await cx(c, `UPDATE purchase_orders SET total_amount=$2, total_qty=$3, updated_at=now() WHERE id=$1`,
          [id, r2(totalAmount), r3(totalQty)]);
      }
      await audit(curStore(), user.sub, '进销存', 'po.update', 'purchase_order', id, { poNo: rows[0].po_no });
      return { id, status: '草稿' };
    });
  }

  /** 未产生业务订单删除（V4.9.5：草稿/待审批/已取消 且从未到货可删，硬删留审计） */
  @RequirePerms('purchase.po.approve')
  @Delete('orders/:id')
  async deletePo(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new BizException(40404, '采购订单不存在', 404);
      if (!['草稿', '待审批', '已取消'].includes(rows[0].status)) {
        throw new BizException(50010, `已产生业务的订单不可删除（当前 ${rows[0].status}，可走作废流程）`);
      }
      const arrived = await cx(c,
        `SELECT count(*)::int AS n FROM purchase_order_items WHERE po_id=$1 AND arrived_qty > 0`, [id]);
      if (arrived[0].n > 0) throw new BizException(50010, '该订单已有到货记录（已产生业务），不可删除');
      await cx(c, `DELETE FROM purchase_order_items WHERE po_id=$1`, [id]);
      await cx(c, `DELETE FROM purchase_orders WHERE id=$1`, [id]);
      await audit(curStore(), user.sub, '进销存', 'po.delete', 'purchase_order', id, { poNo: rows[0].po_no });
      return { id, deleted: true };
    });
  }

  /** 采购单审批（权限点 purchase.po.approve；待审批→已下单；V4.9.4 需审批人电子签名） */
  @RequirePerms('purchase.po.approve')
  @Post('orders/:id/approve')
  async approvePo(@Param('id', ParseIntPipe) id: number,
                  @Body() b: { signature?: string },
                  @CurrentUser() user: AuthUser) {
    if (!b.signature) throw new BizException(40003, '审批需采集审批人电子签名');
    const emp = await q1(`SELECT name FROM employees WHERE id=$1`, [user.sub]);
    const signPath = saveBase64Image(b.signature);
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new BizException(40404, '采购订单不存在', 404);
      if (rows[0].status !== '待审批') throw new BizException(50010, `状态(${rows[0].status})不可审批`);
      await cx(c,
        `UPDATE purchase_orders SET status='已下单', approver_id=$2, approved_at=now(), approver_sign_path=$3, updated_at=now() WHERE id=$1`,
        [id, user.sub, signPath]);
      await audit(curStore(), user.sub, '进销存', 'po.approve', 'purchase_order', id, { poNo: rows[0].po_no, signPath });
      return { id, status: '已下单', approver: emp?.name || '', approverSignPath: signPath };
    });
  }

  /** 作废采购订单（V4.9.6：除已取消外均可作废；订单不持有库存，已完成作废不影响库存） */
  @RequirePerms('purchase.po.approve')
  @Post('orders/:id/void')
  async voidPo(@Param('id', ParseIntPipe) id: number,
               @Body() b: { reason?: string },
               @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new BizException(40404, '采购订单不存在', 404);
      if (rows[0].status === '已取消') throw new BizException(50010, `状态(${rows[0].status})不可作废`);
      await cx(c, `UPDATE purchase_orders SET status='已取消', void_reason=$2, updated_at=now() WHERE id=$1`,
        [id, b.reason ?? null]);
      await audit(curStore(), user.sub, '进销存', 'po.void', 'purchase_order', id, { poNo: rows[0].po_no });
      return { id, status: '已取消' };
    });
  }

  /** 入库单列表（筛选三件套 V4.6.1：日期区间 / 供应商 / 关键字） */
  @Get('inbounds')
  async inbounds(
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('keyword') keyword?: string,
  ) {
    const kw = (keyword || '').trim();
    return q(
      `SELECT io.*, s.name AS supplier_name, em.name AS maker_name,
              (SELECT count(*) FROM inbound_order_items i WHERE i.inbound_id = io.id) AS item_count,
              (SELECT COALESCE(SUM(i.qty), 0) FROM inbound_order_items i WHERE i.inbound_id = io.id) AS total_qty
         FROM inbound_orders io JOIN suppliers s ON s.id = io.supplier_id
         LEFT JOIN employees em ON em.id = io.employee_id
        WHERE ($1::bigint IS NULL OR io.supplier_id = $1::bigint)
          AND ($2::text IS NULL OR io.status::text = $2)
          AND ($3::date IS NULL OR io.created_at::date >= $3::date)
          AND ($4::date IS NULL OR io.created_at::date <= $4::date)
          AND ($5 = '' OR io.inbound_no ILIKE '%'||$5||'%' OR s.name ILIKE '%'||$5||'%')
        ORDER BY io.id DESC LIMIT 100`,
      [supplierId ? Number(supplierId) : null, status || null, from || null, to || null, kw],
    );
  }

  /**
   * V5.0.16 移动收货智能推荐采购单：按已录入收货商品与该供应商未完成采购单的相似度，
   * 返回最佳匹配（覆盖率≥70% 视为「近似采购单」）。前端据此提示用户是否关联。
   * 覆盖判定：已录入商品按 productId 精确命中，或名称 Dice 相似度≥0.6 命中采购单中任一商品。
   * 返回明细的 covered 标记：该采购单商品是否已被用户录入（false = 关联时需补录并标红）。
   */
  @Post('inbounds/po-suggest')
  async suggestPo(@Body() b: { supplierId?: number; items?: { productId?: number; barcode?: string; name?: string }[] }) {
    const inputs = (Array.isArray(b.items) ? b.items : [])
      .map((x: any) => ({ pid: Number(x?.productId) || 0, bc: normBc(x?.barcode), name: normMatchName(x?.name) }))
      .filter((x: any) => x.bc || x.pid > 0 || x.name);
    if (!inputs.length) return { matched: false, score: 0, threshold: PO_MATCH_COVER, po: null, items: [] };
    const sid = Number(b.supplierId) || 0;
    // 候选采购单：该供应商（或全部）未收完的 已下单/到货中
    const pos = await q(
      `SELECT o.id, o.po_no, o.supplier_id, s.name AS supplier_name
         FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
        WHERE o.status IN ('已下单','到货中')
          AND ($1::bigint IS NULL OR o.supplier_id = $1::bigint)
        ORDER BY o.id DESC LIMIT 30`, [sid || null]);
    if (!pos.length) return { matched: false, score: 0, threshold: PO_MATCH_COVER, po: null, items: [] };
    // 一次取回所有候选明细（含条码），按 po_id 分组
    const allItems = await q(
      `SELECT i.po_id, i.product_id, i.order_qty, i.arrived_qty, i.price,
              p.name AS product_name, p.base_unit, p.barcode
         FROM purchase_order_items i JOIN products p ON p.id = i.product_id
        WHERE i.po_id = ANY($1::bigint[]) AND i.arrived_qty < i.order_qty
        ORDER BY i.id`, [pos.map((o: any) => o.id)]);
    const byPo = new Map<number, any[]>();
    for (const it of allItems) {
      const arr = byPo.get(Number(it.po_id)) || [];
      arr.push({ productId: Number(it.product_id), barcode: normBc(it.barcode), name: it.product_name,
                 baseUnit: it.base_unit, orderQty: Number(it.order_qty), arrivedQty: Number(it.arrived_qty || 0),
                 price: Number(it.price || 0), _n: normMatchName(it.product_name) });
      byPo.set(Number(it.po_id), arr);
    }
    // 统一判定（唯一口径）：条码 → 档案ID → 名称相似度。条码一码一品最准确，名称仅兜底
    const hit = (inp: any, items: any[]) => items.some((x: any) =>
      (inp.bc && x.barcode && x.barcode === inp.bc)
      || (inp.pid > 0 && x.productId === inp.pid)
      || (inp.name && x._n && nameDiceSim(x._n, inp.name) >= PO_MATCH_ITEM_SIM));
    // 逐候选算覆盖率，取最佳
    let best: any = null;
    for (const o of pos) {
      const items = byPo.get(Number(o.id)) || [];
      if (!items.length) continue;
      const covered = inputs.filter((inp: any) => hit(inp, items)).length;
      const score = covered / inputs.length;
      if (!best || score > best.score) best = { o, items, score, covered };
    }
    if (!best || best.score < PO_MATCH_COVER) {
      return { matched: false, score: best ? Math.round(best.score * 100) : 0,
               threshold: PO_MATCH_COVER, po: null, items: [] };
    }
    // 标记每个采购单商品是否已被用户录入（covered=false → 关联时补录并标红）
    const marked = best.items.map((x: any) => ({
      productId: x.productId, barcode: x.barcode, name: x.name, baseUnit: x.baseUnit,
      orderQty: x.orderQty, arrivedQty: x.arrivedQty, price: x.price,
      covered: inputs.some((inp: any) => hit(inp, [x])),
    }));
    return { matched: true, score: Math.round(best.score * 100), threshold: PO_MATCH_COVER,
             po: { id: Number(best.o.id), poNo: best.o.po_no, supplierId: Number(best.o.supplier_id),
                   supplierName: best.o.supplier_name }, items: marked };
  }

  /** 创建入库单（录入即生效、审核后置 V4.3.5；生产日期必填 V4.3.6；poId 关联采购订单并回写到货量） */
  @RequirePerms('stock.inbound.audit')
  @Post('inbounds')
  async createInbound(@Body() b: { supplierId: number; items: any[]; poId?: number; remark?: string;
                                   sourceType?: 'self' | 'hq_po' | 'direct' }, @CurrentUser() user: AuthUser) {
    if (!b.supplierId) throw new BizException(40003, 'supplierId 必填');
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '入库明细不能为空');
    // V5.0.0 批次6（M6-6）：self 门店自采 / hq_po 总部集采 / direct 供应商直送门店（两步记账）
    const sourceType = ['hq_po', 'direct'].includes(String(b.sourceType)) ? String(b.sourceType) : 'self';

    return tx(async c => {
      const seq = await seqLock(c, 'inbound_orders', 'inbound_no', `RK-${today()}-%`);
      const no = `RK-${today()}-${String(seq[0].n).padStart(3, '0')}`;
      let total = 0;
      const ord = await cx(c,
        `INSERT INTO inbound_orders (store_id, inbound_no, supplier_id, po_id, status, employee_id, remark, source_type)
         VALUES (${curStore()},$1,$2,$3,'未审核',$4,$5,$6) RETURNING id`,
        [no, b.supplierId, b.poId ?? null, user.sub, b.remark ?? null, sourceType]);
      for (const it of b.items) {
        // V4.9.5 AI 建品：条码未识别 + aiCreate → 自动创建商品档案（AI 赋能；名称待完善，扫码枪即可继续收货）
        let productId = Number(it.productId) || 0;
        if (!productId && it.barcode && it.aiCreate) {
          const bc = String(it.barcode).trim();
          const dup = await cx(c, `SELECT id FROM products WHERE barcode=$1 AND deleted_at IS NULL LIMIT 1`, [bc]);
          if (dup[0]) {
            productId = Number(dup[0].id);
          } else {
            const seq2 = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM products`);
            const created = await cx(c,
              `INSERT INTO products (store_id, goods_no, barcode, name, pinyin_code, base_unit, sell_price,
                                     keep_days, track_inventory, status, remark)
               VALUES (${curStore()},$1,$2,$3,$4,'件',0,365,true,2,'AI建品：收货时条码未识别自动创建，请补全名称/分类/保质期') RETURNING id`,
              [`AI${String(seq2[0].n).padStart(6, '0')}`, bc, `AI建品-${bc}`, bc]);
            productId = Number(created[0].id);
          }
        }
        if (!productId || !it.qty || it.unitCost === undefined) {
          throw new BizException(40003, '明细需包含 productId / qty / unitCost');
        }
        if (!it.productionDate) throw new BizException(50011, '入库明细生产日期必填（V4.3.6）');
        // V4.9.5 记录入库前档案原售价（作废时回退 → "改价无效"可追溯）
        let prevSell: number | null = null;
        if (it.sellPrice !== undefined && it.sellPrice !== null) {
          const prow = await cx(c, `SELECT sell_price FROM products WHERE id=$1`, [productId]);
          prevSell = prow[0] ? (prow[0].sell_price != null ? Number(prow[0].sell_price) : null) : null;
        }
        await cx(c,
          `INSERT INTO inbound_order_items (inbound_id, product_id, production_date, qty, unit_cost, sell_price, prev_sell_price, gift, line_remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ord[0].id, productId, it.productionDate, it.qty, it.unitCost,
           it.sellPrice !== undefined && it.sellPrice !== null ? Number(it.sellPrice) : null,
           prevSell, !!it.gift, it.remark ?? null]);
        total = r2(total + Number(it.qty) * (Number(it.unitCost) || 0));
      }
      // V4.9.5 商品-供应商绑定校验（AI 建品行已完成绑定归属）
      const boundIds: number[] = [];
      for (const it of b.items) if (it.productId) boundIds.push(Number(it.productId));
      await this.assertProductsBound(c, Number(b.supplierId), boundIds);
      if (b.poId) {
        for (const it of b.items) {
          await cx(c,
            `UPDATE purchase_order_items SET arrived_qty = arrived_qty + $3 WHERE po_id=$1 AND product_id=$2`,
            [b.poId, it.productId, it.qty]);
        }
        const remain = await cx(c,
          `SELECT count(*)::int AS n FROM purchase_order_items WHERE po_id=$1 AND arrived_qty < order_qty`, [b.poId]);
        await cx(c, `UPDATE purchase_orders SET status=$2, updated_at=now() WHERE id=$1`,
          [b.poId, remain[0].n > 0 ? '到货中' : '已完成']);
      }
      // M3b：自动关联操作员（employee_id 已写）+ 提取该供应商业务员预采电子签名（大额判断 5.6.8③ 传 amount）
      const sign = await autoAttachSignature(c, {
        storeId: 1, bizType: 'inbound', bizId: ord[0].id, supplierId: b.supplierId,
        summary: `${no}|${b.supplierId}|${b.items.length}项`, usedBy: user.sub, amount: total,
      });
      if (sign && 'recordId' in sign) await cx(c, `UPDATE inbound_orders SET sign_record_id=$2 WHERE id=$1`, [ord[0].id, sign.recordId]);
      // V4.15.0 签字3：入库单补操作员本人签名记录（单据明细同时展示 操作员 + 业务员 两张签名）
      await attachOperatorSignature(c, {
        storeId: 1, bizType: 'inbound', bizId: ord[0].id,
        summary: `${no}|${b.supplierId}|${b.items.length}项`, usedBy: user.sub,
      });
      // V4.9.5 操作员电子签字库：无本人签字 → 前端弹签字板连续采集 ≥3 次入库
      const opSig = await cx(c,
        `SELECT count(*)::int AS n FROM signature_templates WHERE ref_employee_id=$1`, [user.sub]);
      return { id: ord[0].id, inboundNo: no, status: '未审核', signInfo: sign,
               operatorSignNeeded: Number(opSig[0].n) === 0 };
    });
  }

  /**
   * 入库审核（权限点 stock.inbound.audit）：
   * 1) 生产日期 + 保质期 → 自动到期日；2) 生成 FIFO 批次（批次号=RK单号-序号）；
   * 3) 库存流水 + 即时库存累加；4) 进价历史（最低价保护 V4.3.6）
   */
  @RequirePerms('stock.inbound.audit')
  @Post('inbounds/:id/audit')
  async auditInbound(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const keepDaysRequired = await this.settings.getBool('product.keep_days_required', true);

    return tx(async c => {
      const ords = await cx(c, `SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE`, [id]);
      const ord = ords[0];
      if (!ord) throw new BizException(40404, '入库单不存在', 404);
      if (ord.status !== '未审核' && ord.status !== '草稿') throw new BizException(50010, `单据状态(${ord.status})不允许审核`);
      await this.assertSigned(c, 'inbound', 'inbound_orders', id, String(ord.inbound_no));

      const items = await cx(c,
        `SELECT i.*, p.name AS product_name, p.keep_days, p.sell_price AS product_sell_price
           FROM inbound_order_items i JOIN products p ON p.id = i.product_id
          WHERE i.inbound_id = $1 ORDER BY i.id`, [id]);
      if (!items.length) throw new BizException(50010, '入库单无明细，不能审核');

      let total = 0;
      let idx = 0;
      for (const it of items) {
        idx += 1;
        if (!it.production_date) throw new BizException(50011, `${it.product_name} 未填生产日期`);
        if (keepDaysRequired && !it.keep_days) {
          throw new BizException(50012, `${it.product_name} 未建档保质期，按禁售规则拦截（V4.4.5）`);
        }
        const expiry = addDays(pgDateStr(it.production_date), it.keep_days ? Number(it.keep_days) : 365);
        const cost = it.gift ? 0 : Number(it.unit_cost);
        const batchNo = `${ord.inbound_no}-${String(idx).padStart(2, '0')}`;

        const bt = await cx(c,
          `INSERT INTO batches (store_id, product_id, supplier_id, inbound_order_id, batch_no, inbound_date,
                                production_date, expiry_date, inbound_cost, inbound_qty, remain_qty, status)
           VALUES (${curStore()},$1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$8,'在库') RETURNING id`,
          [it.product_id, ord.supplier_id, ord.id, batchNo, it.production_date, expiry, cost, it.qty]);
        await cx(c, `UPDATE inbound_order_items SET batch_id=$2 WHERE id=$1`, [it.id, bt[0].id]);

        await cx(c,
          `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
           VALUES (${curStore()},$1,$2,'入库',$3,$4,'inbound',$5,$6,$7)`,
          [it.product_id, bt[0].id, it.qty, cost, ord.id, it.id, user.sub]);

        await cx(c,
          `INSERT INTO inventory_current (store_id, product_id, qty_total) VALUES (${curStore()},$1,$2)
           ON CONFLICT (store_id, product_id) DO UPDATE SET qty_total = inventory_current.qty_total + $2, updated_at = now()`,
          [it.product_id, it.qty]);

        // 进价历史 + 历史最低价（无调价通知取低价 V4.3.6）
        // V5.0.0（R8/L3）：本表语义收窄为「供应商报价流水（append-only，比价与对账用）」，不再直接充当红线依据。
        if (!it.gift) {
          await cx(c,
            `INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
             VALUES ($1,$2,$3,
                     LEAST($3, COALESCE((SELECT MIN(min_price) FROM supplier_product_prices
                                          WHERE product_id=$1 AND supplier_id=$2), $3)),
                     $4)`,
            [it.product_id, ord.supplier_id, cost, ord.inbound_no]);
        }

        // ── V5.0.0（R8 乙模型）标准进价 L1 采纳判定 ──
        //   进价的现存漏洞：原先「谁入库，谁就用批次实价改写了全局进价」，门店可借此抬高
        //   红线兜底（红线 = max(最低卖价线, 进价)），从而低价卖而不触发违规。
        //   现在：L3 流水照写（比价/对账），但 **L1 只在下列条件下变化**：
        //     ① L1 为空（新品首进）+ 开关 chain.cost.auto_adopt_new=true → 自动采纳实价（新品立刻有红线保护）
        //     ② 实价 < L1 → **不自动采纳**，进「进价采纳审核」（批次4 接入 cost_diff_requests），此处先留痕
        //     ③ 实价 ≥ L1 → **L1 不动**（单向棘轮：门店无论如何抬不动红线）
        //   单店零回归：单店即总部，实际行为与改造前「入库价进进价基线」一致（区别仅是多落一列 L1）。
        if (!it.gift && cost > 0) {
          const std0 = await cx(c, `SELECT standard_cost FROM products WHERE id=$1 FOR UPDATE`, [it.product_id]);
          const l1 = std0[0]?.standard_cost === null || std0[0]?.standard_cost === undefined
            ? null : Number(std0[0].standard_cost);
          if (l1 === null) {
            const autoAdopt = await this.settings.getVal('chain.cost.auto_adopt_new');
            if (autoAdopt !== false) {
              await cx(c, `UPDATE products SET standard_cost=$2, updated_at=now() WHERE id=$1`,
                [it.product_id, cost]);
            }
          } else if (cost < l1) {
            // 待审：只留痕（L1 不动）。批次4 会在此处生成 cost_diff_requests(kind='lower') 走总部审核。
            await audit(curStore(), user.sub, '进销存', 'cost.adopt.pending', 'product', Number(it.product_id),
              { inboundNo: ord.inbound_no, actualCost: cost, l1, delta: Number((l1 - cost).toFixed(4)) });
          } else if (cost > l1) {
            // 高进价：L1 不动 + 留痕（批次4 接异常处置与通知，anchor §5.1.6-⑧/⑨）
            await audit(curStore(), user.sub, '进销存', 'cost.high_flagged', 'product', Number(it.product_id),
              { inboundNo: ord.inbound_no, actualCost: cost, l1, delta: Number((cost - l1).toFixed(4)) });
          }
        }
        total += Number(it.qty) * cost;

        // V4.9.5 售价联动：入库时调整了售价 → 审核后自动更新商品档案最新售价（历史单据价格不受影响）
        // V4.26.5：这是「改基线价」路径之一 → 同步清空该商品门店覆盖行，防止残旧门店特价压住新价
        if (it.sell_price != null && Number(it.sell_price) > 0
            && Number(it.sell_price) !== Number(it.product_sell_price ?? 0)) {
          await cx(c, `UPDATE products SET sell_price=$2, updated_at=now() WHERE id=$1`,
            [it.product_id, Number(it.sell_price)]);
          await storePrice.clearProduct(c, Number(it.product_id)).catch(() => 0);
        }
      }

      await cx(c, `UPDATE inbound_orders SET status='已审核', audited_by=$2, audited_at=now(), total_amount=$3 WHERE id=$1`,
        [id, user.sub, Math.round(total * 100) / 100]);
      // V5.0.3：审核是入库的确认点——关联采购订单在此重算到货进度，全部到齐即「已完成」
      if ((ord as any).po_id) {
        const remain = await cx(c,
          `SELECT count(*)::int AS n FROM purchase_order_items WHERE po_id=$1 AND arrived_qty < order_qty`,
          [(ord as any).po_id]);
        await cx(c, `UPDATE purchase_orders SET status=$2, updated_at=now() WHERE id=$1`,
          [(ord as any).po_id, remain[0].n > 0 ? '到货中' : '已完成']);
      }
      await audit(curStore(), user.sub, '进销存', 'inbound.audit', 'inbound', id, { no: ord.inbound_no, total });

      // ── V5.0.0 批次6（M6-6 / R14）：供应商直送门店 = 两步记账、一步物流 ──
      // 货：供应商 → 门店仓（上面已生成门店批次）；账：总部采购应付记总部 →
      // 此处自动补一张「已完成」的总部→门店调拨单（biz_scope='direct'），
      // 保证总部汇总库存看得见货的去向（不凭空消失），不动任何库存数字。
      if (String((ord as any).source_type ?? 'self') === 'direct') {
        const hqId = await hqStoreId();
        await seqLock(c, 'stock_transfers', 'transfer_no', `ZS-${today()}-%`);
        const zseq = await cx(c, `SELECT count(*)+1 AS n FROM stock_transfers WHERE transfer_no LIKE $1`, [`ZS-${today()}-%`]);
        const zno = `ZS-${today()}-${String(zseq[0].n).padStart(3, '0')}`;
        const trRows = await cx(c,
          `INSERT INTO stock_transfers (transfer_no, from_store_id, to_store_id, status, reason, employee_id, audited_by,
                                        biz_scope, total_cost, shipped_at, received_at)
           VALUES ($1,$2,$3,'已入库',$4,$5,$5,'direct',$6,now(),now()) RETURNING id`,
          [zno, hqId, Number(ord.store_id), `供应商直送（入库单 ${ord.inbound_no}）两步记账`, user.sub, r2(total)]);
        const trId = Number(trRows[0].id);
        const bi = await cx(c,
          `SELECT i.product_id, i.qty, i.unit_cost, b.id AS batch_id, b.origin_batch_no
             FROM inbound_order_items i JOIN batches b ON b.id = i.batch_id
            WHERE i.inbound_id=$1 ORDER BY i.id`, [id]);
        for (const row of bi) {
          await cx(c,
            `INSERT INTO stock_transfer_items (transfer_id, product_id, batch_id, qty, unit_cost, recv_qty, diff_qty, recv_batch_id, origin_batch_no)
             VALUES ($1,$2,$3,$4,$5,$4,0,$6,$7)`,
            [trId, row.product_id, row.batch_id, row.qty, row.unit_cost, row.batch_id, row.origin_batch_no ?? null]);
        }
        await audit(curStore(), user.sub, '进销存', 'transfer.direct.auto', 'stock_transfer', trId,
          { no: zno, inboundNo: ord.inbound_no, total: r2(total) });
      }

      return { id, status: '已审核', totalAmount: Math.round(total * 100) / 100 };
    });
  }

  /** 入库单详情（打印 A5 用：单头 + 明细含商品名/单位/批次）
   *  V5.0.18g 修复主体关联：sign_record_id 存的是供应商业务员预采签名（M3b autoAttach），
   *  此前详情把它当「操作员签字」返回 → 屏幕上供应商人员的签名冒充操作员。
   *  现另取 scene='操作员签名' 的记录（attachOperatorSignature，按登录人 ref_employee_id 取模板）：
   *  operator_sign_image_path/operator_sign_name 才是操作员本人签字。 */
  @Get('inbounds/:id')
  async inboundDetail(@Param('id', ParseIntPipe) id: number) {
    const ord = await q1(`SELECT io.*, s.name AS supplier_name, e.name AS maker_name,
                                 st.image_path AS sign_image_path, po.po_no,
                                 ops.image_path AS operator_sign_image_path, ops.person_name AS operator_sign_name
                            FROM inbound_orders io
                            JOIN suppliers s ON s.id = io.supplier_id
                            LEFT JOIN employees e ON e.id = io.employee_id
                            LEFT JOIN signature_records sr ON sr.id = io.sign_record_id
                            LEFT JOIN signature_templates st ON st.id = sr.template_id
                            LEFT JOIN purchase_orders po ON po.id = io.po_id
                            LEFT JOIN LATERAL (
                              SELECT sr2.image_path, sr2.person_name
                                FROM signature_records sr2
                               WHERE sr2.biz_type='inbound' AND sr2.biz_id=io.id
                                 AND sr2.scene='操作员签名' AND sr2.image_path IS NOT NULL
                               ORDER BY sr2.id DESC LIMIT 1) ops ON true
                           WHERE io.id=$1`, [id]);
    if (!ord) throw new BizException(40404, '入库单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit, b.batch_no
         FROM inbound_order_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN batches b ON b.id = i.batch_id
        WHERE i.inbound_id=$1 ORDER BY i.id`, [id]);
    return { order: ord, items };
  }

  /**
   * V4.9.8 入库单驳回（手机端审批）：未审核/草稿 → 已驳回，原因必填并留痕。
   * 与「作废」区分：驳回是审批结论（单据有问题需重开/修改），作废是单据取消。
   * 不涉库存（未审核单尚未生成批次），已审核单不允许驳回（应走退货/作废流程）。
   */
  @RequirePerms('stock.inbound.audit')
  @Post('inbounds/:id/reject')
  async rejectInbound(@Param('id', ParseIntPipe) id: number,
                      @Body() b: { reason?: string },
                      @CurrentUser() user: AuthUser) {
    const reason = String(b.reason || '').trim();
    if (!reason) throw new BizException(40003, '驳回必须填写原因（便于门店整改与留痕）');
    return tx(async c => {
      const ords = await cx(c, `SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE`, [id]);
      const ord = ords[0];
      if (!ord) throw new BizException(40404, '入库单不存在', 404);
      if (ord.status !== '未审核' && ord.status !== '草稿') {
        throw new BizException(50010, `单据状态(${ord.status})不允许驳回`);
      }
      await cx(c,
        `UPDATE inbound_orders SET status='已驳回', reject_reason=$2, rejected_by=$3, rejected_at=now() WHERE id=$1`,
        [id, reason, user.sub]);
      await audit(curStore(), user.sub, '进销存', 'inbound.reject', 'inbound_order', id, { no: ord.inbound_no, reason });
      return { id, status: '已驳回', rejectReason: reason };
    });
  }

  /**
   * 入库单作废（V4.8.21）：
   *   - 未审核/草稿：直接置「已作废」（不涉库存）；
   *   - 已审核：逐批校验 remain_qty == inbound_qty（未被动用）→ 批次置「入库作废」、
   *     库存流水反向（出库 ref_type=inbound_void）、即时库存扣回；已被对账吸收或批次已动用则拒绝。
   */
  @RequirePerms('stock.inbound.audit')
  @Post('inbounds/:id/void')
  async voidInbound(@Param('id', ParseIntPipe) id: number,
                    @Body() b: { reason?: string },
                    @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const ords = await cx(c, `SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE`, [id]);
      const ord = ords[0];
      if (!ord) throw new BizException(40404, '入库单不存在', 404);
      if (ord.status === '已作废') throw new BizException(50010, '该单已是作废状态');
      if (ord.status === '已对账') throw new BizException(50010, '该单已被对账吸收，不能作废（请先作废对账单）');

      if (ord.status === '已审核') {
        const batches = await cx(c,
          `SELECT id, batch_no, inbound_qty, remain_qty FROM batches
            WHERE inbound_order_id=$1 AND status <> '入库作废' FOR UPDATE`, [id]);
        if (!batches.length) throw new BizException(50010, '未找到该单生成的批次，数据异常');
        const consumed = batches.filter(x => Number(x.remain_qty) !== Number(x.inbound_qty));
        if (consumed.length) {
          throw new BizException(50010,
            `批次已被动用（如 ${consumed[0].batch_no} 剩余 ${consumed[0].remain_qty}/${consumed[0].inbound_qty}），不能作废；请改用采购退货流程`);
        }
        for (const bt of batches) {
          await cx(c,
            `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, employee_id)
             SELECT b.store_id, product_id, id, '出库', remain_qty, inbound_cost, 'inbound_void', $2, $3 FROM batches b WHERE b.id=$1`,
            [bt.id, id, user.sub]);
          await cx(c, `UPDATE batches SET remain_qty=0, status='入库作废' WHERE id=$1`, [bt.id]);
        }
        // 按批次合计扣回即时库存（作废前批次未动用，合计=inbound 合计）
        const sums = await cx(c,
          `SELECT product_id, SUM(inbound_qty) AS q FROM batches
            WHERE inbound_order_id=$1 AND status='入库作废' GROUP BY product_id`, [id]);
        for (const r of sums) {
          await cx(c, `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now()
                        WHERE store_id=${curStore()} AND product_id=$1`, [r.product_id, Number(r.q)]);
        }
      }

      await cx(c, `UPDATE inbound_orders SET status='已作废', voided_by=$2, voided_at=now(), void_reason=$3 WHERE id=$1`,
        [id, user.sub, b.reason ?? null]);
      // V4.9.5 已审核单作废 → "改价无效"：入库时调整的售价回退为档案原售价，本次写入的进价历史一并删除
      const reverted = await cx(c,
        `SELECT product_id, prev_sell_price FROM inbound_order_items
          WHERE inbound_id=$1 AND sell_price IS NOT NULL AND prev_sell_price IS NOT NULL
            AND sell_price <> prev_sell_price`, [id]);
      for (const rv of reverted) {
        await cx(c, `UPDATE products SET sell_price=$2, updated_at=now() WHERE id=$1`, [rv.product_id, rv.prev_sell_price]);
      }
      await cx(c, `DELETE FROM supplier_product_prices WHERE source_doc=$1`, [ord.inbound_no]);
      await audit(curStore(), user.sub, '进销存', 'inbound.void', 'inbound', id, { no: ord.inbound_no, reason: b.reason ?? null });
      return { id, status: '已作废' };
    });
  }

  /** V4.9.5 未产生业务入库单删除（仅未审核；审核过的单据即使作废也已产生批次/流水，不可删） */
  @RequirePerms('stock.inbound.audit')
  @Delete('inbounds/:id')
  async deleteInbound(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new BizException(40404, '入库单不存在', 404);
      // V4.9.7：未审核 / 已作废（未产生库存业务）均可删除；已作废单在作废时已回退库存
      if (!['未审核', '草稿', '已作废'].includes(rows[0].status)) {
        throw new BizException(50010, `已审核入库单不可删除，请走作废流程（当前 ${rows[0].status}）`);
      }
      const bt = await cx(c, `SELECT count(*)::int AS n FROM batches WHERE inbound_order_id=$1`, [id]);
      if (bt[0].n > 0 && rows[0].status !== '已作废') throw new BizException(50010, '该单已生成批次（已产生业务），不可删除');
      await cx(c, `DELETE FROM inbound_order_items WHERE inbound_id=$1`, [id]);
      await cx(c, `DELETE FROM inbound_orders WHERE id=$1`, [id]);
      await audit(curStore(), user.sub, '进销存', 'inbound.delete', 'inbound', id, { no: rows[0].inbound_no });
      return { id, deleted: true };
    });
  }

  /**
   * T7 批次自动归属（V4.3.4 拍板规则）：
   *   - 归属范围 = 该供应商「最早有剩余」的批次（ORDER BY inbound_date, id），可跨批拆分；
   *   - 账实脱钩：退货只清点数量，校验口径 = 商品总库存（stock.negative_return 默认关）；
   *   - 退货成本 = 批次原价（inbound_cost），明细行记加权均价，逐批明细写 return_batch_allocs；
   *   - 非该供应商的批次绝不被动用（多供应商同商品 V4.3.5）。
   */
  private async autoAllocBatches(c: any, productId: number, supplierId: number, qty: number) {
    const need = r3(Number(qty));
    if (!(need > 0)) throw new BizException(40003, '退货数量必须大于 0');

    const negAllowed = await this.settings.getBool('stock.negative_return', false);
    const stock = await cx(c,
      `SELECT COALESCE(qty_total,0) AS qty FROM inventory_current WHERE store_id=${curStore()} AND product_id=$1`, [productId]);
    const total = Number(stock[0]?.qty ?? 0);
    if (!negAllowed && total < need) {
      throw new BizException(50014, `退货数量超过商品总库存（商品#${productId} 现有 ${total}，需 ${need}）`);
    }

    const batches = await cx(c,
      `SELECT id, remain_qty, inbound_cost FROM batches
        WHERE store_id=${curStore()} AND product_id=$1 AND supplier_id=$2 AND status='在库' AND remain_qty > 0
        ORDER BY inbound_date, id FOR UPDATE`, [productId, supplierId]);
    let avail = 0;
    for (const b of batches) avail += Number(b.remain_qty);
    if (avail < need) {
      throw new BizException(50015, `该供应商在库批次不足（现有 ${avail}，需 ${need}）——差额属其他供应商批次，不可自动归属`);
    }

    let left = need;
    let costSum = 0;
    const allocs: { batchId: number; qty: number; cost: number }[] = [];
    for (const b of batches) {
      if (left <= 0) break;
      const take = r3(Math.min(Number(b.remain_qty), left));
      allocs.push({ batchId: b.id, qty: take, cost: Number(b.inbound_cost) });
      costSum += take * Number(b.inbound_cost);
      left = r3(left - take);
    }
    return { allocs, unitCost: r4(costSum / need) }; // 行单价=加权均价（原价明细在 allocs）
  }

  /**
   * 采购退货创建（T7 完整版）：凭证强制上传 + 数量校验 + 批次自动归属落 return_batch_allocs；
   * 录入即生效、审核后置（V4.3.5）——库存扣减在审核时发生
   */
  /** 退货单列表（含明细行数与凭证） */
  @Get('returns')
  listReturns(@CurrentUser() user: AuthUser) {
    return q(
      `SELECT r.*, s.name AS supplier_name, em.name AS maker_name,
              (SELECT count(*) FROM purchase_return_items i WHERE i.return_id = r.id)::int AS item_count,
              (SELECT COALESCE(SUM(i.qty), 0) FROM purchase_return_items i WHERE i.return_id = r.id) AS total_qty
         FROM purchase_returns r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN employees em ON em.id = r.employee_id
        WHERE r.store_id=$1 ORDER BY r.id DESC LIMIT 100`, [user.storeId]);
  }

  /** V4.9.5 待补凭证退货单（移动端「消息」页轮询，同账号店员调摄像头拍摄回传） */
  @Get('returns/pending-evidence')
  async pendingEvidenceReturns(@CurrentUser() user: AuthUser) {
    return { items: await q(
      `SELECT r.id, r.return_no, r.created_at, s.name AS supplier_name,
              (SELECT count(*) FROM purchase_return_items i WHERE i.return_id = r.id)::int AS item_count
         FROM purchase_returns r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
        WHERE r.store_id=$1 AND r.status='待审核' AND (r.evidence_path IS NULL OR r.evidence_path = '')
        ORDER BY r.evidence_requested_at DESC NULLS LAST, r.id DESC LIMIT 20`, [user.storeId]) };
  }

  /** V4.9.5 PC 端"发送到移动端拍摄"指令：置 requested_at，移动端补拍清单排序置顶 */
  @RequirePerms('stock.return.audit')
  @Post('returns/:id/evidence-request')
  async requestReturnEvidence(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const r = await q1(
      // V5.0.3：换凭证场景允许已有凭证的待审核单重新派单重拍（去掉"无凭证"限制）
      `UPDATE purchase_returns SET evidence_requested_at=now()
        WHERE id=$1 AND status='待审核' RETURNING id, return_no`,
      [id]);
    if (!r) throw new BizException(50016, '退货单不存在或状态不允许（仅待审核可重拍）');
    await audit(curStore(), user.sub, '进销存', 'return.evidence.request', 'purchase_return', id, {});
    return r;
  }

  /** 退货单详情（V4.9.4：双击单号查看；含逐行批次归属与原批次价；V4.9.5 增条码/到期日期） */
  @Get('returns/:id')
  async returnDetail(@Param('id', ParseIntPipe) id: number) {
    const ord = await q1(
      `SELECT r.*, s.name AS supplier_name, e.name AS maker_name, st.image_path AS sign_image_path,
              au.name AS auditor_name, to_char(r.audited_at, 'YYYY-MM-DD HH24:MI') AS audited_at_txt,
              ops.image_path AS operator_sign_image_path, ops.person_name AS operator_sign_name
         FROM purchase_returns r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN employees e ON e.id = r.employee_id
         LEFT JOIN employees au ON au.id = r.audited_by
         LEFT JOIN signature_records sr ON sr.id = r.sign_record_id
         LEFT JOIN signature_templates st ON st.id = sr.template_id
         LEFT JOIN LATERAL (
           SELECT sr2.image_path, sr2.person_name
             FROM signature_records sr2
            WHERE sr2.biz_type='return' AND sr2.biz_id=r.id
              AND sr2.scene='操作员签名' AND sr2.image_path IS NOT NULL
            ORDER BY sr2.id DESC LIMIT 1) ops ON true
        WHERE r.id=$1`, [id]);
    if (!ord) throw new BizException(40404, '退货单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.base_unit, p.barcode, b.batch_no, b.expiry_date
         FROM purchase_return_items i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN return_batch_allocs a ON a.return_item_id = i.id
         LEFT JOIN batches b ON b.id = a.batch_id
        WHERE i.return_id=$1 ORDER BY i.id`, [id]);
    return { order: ord, items };
  }

  /** V4.9.7 对账弹窗内编辑未审核退货单明细（整单替换，重算金额不变更批次归属） */
  @RequirePerms('stock.return.audit')
  @Put('returns/:id/items')
  async updateReturnItems(@Param('id', ParseIntPipe) id: number, @Body() b: { items: any[] }, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE`, [id]);
      if (!rs[0]) throw new BizException(40404, '退货单不存在', 404);
      if (rs[0].status !== '待审核') throw new BizException(50016, `仅「待审核」退货单可编辑明细（当前 ${rs[0].status}）`);
      if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '明细不能为空');
      await cx(c, `DELETE FROM return_batch_allocs WHERE return_item_id IN (SELECT id FROM purchase_return_items WHERE return_id=$1)`, [id]);
      await cx(c, `DELETE FROM purchase_return_items WHERE return_id=$1`, [id]);
      for (const it of b.items) {
        if (!it.productId || !(Number(it.qty) > 0)) throw new BizException(40003, '明细需包含 productId 与 qty>0');
        // unit_cost 非空约束：未传时取该商品最新进价兜底
        let uc = it.unitCost != null ? Number(it.unitCost) : null;
        if (uc == null) {
          const lp = await cx(c, `SELECT price FROM supplier_product_prices WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [it.productId]);
          uc = lp[0] ? Number(lp[0].price) : 0;
        }
        await cx(c,
          `INSERT INTO purchase_return_items (return_id, product_id, qty, unit_cost, line_remark)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, it.productId, Number(it.qty), uc, it.lineRemark ?? null]);
      }
      await audit(curStore(), user.sub, '进销存', 'return.items.update', 'purchase_return', id, { no: rs[0].return_no, n: b.items.length });
      return { id, updated: true };
    });
  }

  /** V4.9.7 对账弹窗内编辑未审核入库单明细（整单替换，重算合计；批次生成前可改） */
  @RequirePerms('stock.inbound.audit')
  @Put('inbounds/:id/items')
  async updateInboundItems(@Param('id', ParseIntPipe) id: number, @Body() b: { items: any[] }, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE`, [id]);
      if (!rs[0]) throw new BizException(40404, '入库单不存在', 404);
      if (rs[0].status !== '未审核') throw new BizException(50010, `仅「未审核」入库单可编辑明细（当前 ${rs[0].status}）`);
      const bt = await cx(c, `SELECT count(*)::int AS n FROM batches WHERE inbound_order_id=$1`, [id]);
      if (bt[0].n > 0) throw new BizException(50010, '该单已生成批次，不可编辑');
      if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '明细不能为空');
      await cx(c, `DELETE FROM inbound_order_items WHERE inbound_id=$1`, [id]);
      let total = 0;
      for (const it of b.items) {
        if (!it.productId || !(Number(it.qty) > 0)) throw new BizException(40003, '明细需包含 productId 与 qty>0');
        if (!it.productionDate) throw new BizException(50011, '入库明细生产日期必填（V4.3.6）');
        await cx(c,
          `INSERT INTO inbound_order_items (inbound_id, product_id, production_date, qty, unit_cost, sell_price, gift, line_remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, it.productId, it.productionDate, Number(it.qty), Number(it.unitCost) || 0,
           it.sellPrice != null ? Number(it.sellPrice) : null, !!it.gift, it.lineRemark ?? null]);
        total = r2(total + Number(it.qty) * (Number(it.unitCost) || 0));
      }
      await cx(c, `UPDATE inbound_orders SET total_amount=$2 WHERE id=$1`, [id, total]);
      await audit(curStore(), user.sub, '进销存', 'inbound.items.update', 'inbound', id, { no: rs[0].inbound_no, n: b.items.length, total });
      return { id, updated: true, totalAmount: total };
    });
  }

  /** 单供应商退货单落库（V4.13.9 从 createReturn 拆出，供自动分桶复用） */
  private async createReturnDoc(c: any, supplierId: number,
                                items: { productId: number; qty: number; lineRemark?: string }[],
                                opts: { evidencePath?: string; remark?: string }, user: AuthUser) {
    const seq = await seqLock(c, 'purchase_returns', 'return_no', `TH-${today()}-%`);
    const no = `TH-${today()}-${String(seq[0].n).padStart(3, '0')}`;
    const ret = await cx(c,
      `INSERT INTO purchase_returns (store_id, return_no, supplier_id, status, evidence_path, preaudit_at, employee_id, remark)
       VALUES (${curStore()},$1,$2,'待审核',$3,now(),$4,$5) RETURNING id`,
      [no, supplierId, opts.evidencePath ?? null, user.sub, opts.remark ?? null]);

    const lines: any[] = [];
    let total = 0;
    for (const it of items) {
      // V5.0.0 P2-4 临期一键转退货：item 带 batchId 时钉住该批次归属（不走 FIFO），
      // 使退货审核联动 expiry_disposals 时恰好命中临期批次
      let allocs: { batchId: number; qty: number; cost: number }[];
      let unitCost: number;
      const pinBatchId = Number((it as any).batchId || 0);
      if (pinBatchId) {
        const bb = await cx(c,
          `SELECT id, remain_qty, inbound_cost FROM batches
            WHERE id=$1 AND store_id=${curStore()} AND product_id=$2 AND supplier_id=$3
              AND status='在库' AND remain_qty > 0 FOR UPDATE`,
          [pinBatchId, it.productId, supplierId]);
        if (!bb.length) throw new BizException(40404, `批次#${pinBatchId} 不存在或不属于该商品/供应商（商品#${it.productId}）`, 404);
        if (Number(bb[0].remain_qty) < r3(it.qty)) {
          throw new BizException(50015, `批次#${pinBatchId} 在库余量 ${bb[0].remain_qty}，不足退 ${r3(it.qty)}`);
        }
        allocs = [{ batchId: pinBatchId, qty: r3(it.qty), cost: Number(bb[0].inbound_cost) }];
        unitCost = Number(bb[0].inbound_cost);
      } else {
        ({ allocs, unitCost } = await this.autoAllocBatches(c, it.productId, supplierId, it.qty));
      }
      total = r2(total + Number(it.qty) * (Number(unitCost) || 0));
      const item = await cx(c,
        `INSERT INTO purchase_return_items (return_id, product_id, qty, unit_cost, line_remark)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ret[0].id, it.productId, r3(it.qty), unitCost, it.lineRemark ?? null]);
      for (const a of allocs) {
        await cx(c,
          `INSERT INTO return_batch_allocs (return_item_id, batch_id, qty, unit_cost, alloc_rule)
           VALUES ($1,$2,$3,$4,'自动')`, [item[0].id, a.batchId, a.qty, a.cost]);
      }
      lines.push({ itemId: item[0].id, productId: it.productId, qty: r3(it.qty), unitCost });
    }

    await audit(curStore(), user.sub, '进销存', 'return.create', 'purchase_return', ret[0].id,
      { no, lines: lines.map(l => ({ ...l, unitCost: undefined })) });
    // M3b：自动关联操作员 + 提取该供应商业务员预采电子签名（大额判断 5.6.8③ 传 amount）
    const sign = await autoAttachSignature(c, {
      storeId: 1, bizType: 'return', bizId: ret[0].id, supplierId,
      summary: `${no}|${supplierId}|${items.length}项`, usedBy: user.sub, amount: total,
    });
    if (sign && 'recordId' in sign) await cx(c, `UPDATE purchase_returns SET sign_record_id=$2 WHERE id=$1`, [ret[0].id, sign.recordId]);
    // V4.15.0 签字3：退货单补操作员本人签名记录（明细页 操作员 + 业务员 双签名展示）
    await attachOperatorSignature(c, {
      storeId: 1, bizType: 'return', bizId: ret[0].id,
      summary: `${no}|${supplierId}|${items.length}项`, usedBy: user.sub,
    });
    return { id: ret[0].id, returnNo: no, supplierId, status: '待审核', items: lines, signInfo: sign,
             note: '批次已按「该供应商最早剩余批次」自动归属；凭证可后置补传，审核前必须上传' };
  }

  /** 采购退货（V4.13.9 免选供应商）：不传 supplierId 时按商品默认供应商自动分桶，
   *  多供应商混退 → 每供应商一张退货单；无供应商属性的商品拒绝并提示补档案。 */
  @RequirePerms('stock.inbound.audit', 'stock.return.audit')
  @Post('returns')
  async createReturn(
    @Body() b: { supplierId?: number; evidencePath?: string; remark?: string; items: { productId: number; qty: number; lineRemark?: string }[] },
    @CurrentUser() user: AuthUser,
  ) {
    if (!Array.isArray(b.items) || !b.items.length) throw new BizException(40003, '退货明细不能为空');

    return tx(async c => {
      const buckets = new Map<number, { productId: number; qty: number; lineRemark?: string }[]>();
      const noSup: string[] = [];
      for (const it of b.items) {
        const p = await cx(c,
          `SELECT id, name, supplier_default_id FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(it.productId)]);
        if (!p.length) throw new BizException(40404, `商品#${it.productId} 不存在`, 404);
        const sup = Number(b.supplierId || 0) || Number(p[0].supplier_default_id || 0);
        if (!sup) { noSup.push(String(p[0].name)); continue; }
        if (!buckets.has(sup)) buckets.set(sup, []);
        buckets.get(sup)!.push(it);
      }
      if (noSup.length) {
        throw new BizException(40003,
          `以下商品没有供应商属性，无法退货：${noSup.join('、')}。请联系管理员/店长在商品档案中补全供应商后再退`);
      }
      const docs = [];
      for (const [supId, items] of buckets) {
        docs.push(await this.createReturnDoc(c, supId, items, b, user));
      }
      return docs.length === 1
        ? { ...docs[0], multi: false }
        : { multi: true, docCount: docs.length, docs, ...docs[0] };
    });
  }

  /**
   * V5.0.0 P2-4 临期一键转退货：选中临期批次 → 整批全退 → 按商品默认供应商分桶各生成退货单（待审核）。
   * 钉批次归属（不走 FIFO），审核通过时：扣批/库存/成本回冲 + expiry_disposals 自动「已退换」闭环。
   * 权限：临期处置或退货任一即可（any-of）。
   */
  @RequirePerms('stock.loss.create', 'stock.return.audit')
  @Post('returns/from-expiry')
  async createReturnFromExpiry(
    @Body() b: { batchIds: number[]; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const ids = (Array.isArray(b?.batchIds) ? b.batchIds : []).map(Number).filter(x => Number.isInteger(x) && x > 0);
    if (!ids.length) throw new BizException(40003, '请先选择要转退货的临期批次');

    return tx(async c => {
      const rows = await cx(c,
        `SELECT b.id AS batch_id, b.batch_no, b.remain_qty, b.expiry_date,
                p.id AS product_id, p.name AS product_name, p.supplier_default_id
           FROM batches b JOIN products p ON p.id = b.product_id
          WHERE b.id = ANY($1::bigint[]) AND b.store_id=${curStore()}
            AND b.status='在库' AND b.remain_qty > 0 AND p.deleted_at IS NULL
          ORDER BY b.expiry_date, b.id FOR UPDATE OF b`, [ids]);
      if (!rows.length) throw new BizException(40404, '所选批次均不可退（不存在/已出库）', 404);
      const missing = ids.filter(id => !rows.some(r => Number(r.batch_id) === id));
      if (missing.length) throw new BizException(40003, `批次#${missing.join('、')} 已不在库或无余量，请刷新临期清单后重选`);

      // 按供应商分桶；无默认供应商 → 拒绝并列商品名（与普通退货口径一致）
      const buckets = new Map<number, { productId: number; qty: number; batchId: number }[]>();
      const noSup: string[] = [];
      for (const r of rows) {
        const sup = Number(r.supplier_default_id || 0);
        if (!sup) { noSup.push(String(r.product_name)); continue; }
        if (!buckets.has(sup)) buckets.set(sup, []);
        buckets.get(sup)!.push({ productId: Number(r.product_id), qty: r3(Number(r.remain_qty)), batchId: Number(r.batch_id) });
      }
      if (noSup.length) {
        throw new BizException(40003,
          `以下商品没有供应商属性，无法退货：${noSup.join('、')}。请先在商品档案补全默认供应商`);
      }

      const docs = [];
      for (const [supId, items] of buckets) {
        const d = await this.createReturnDoc(c, supId, items, { remark: (b.remark || '').trim() || '临期一键转退货' }, user);
        docs.push(d);
      }

      // 处置时钟：批次转「处理中」（已有处置行不覆盖已退换）；退货单审核通过时按 batch_id 自动闭环
      const batchIds = rows.map(r => r.batch_id);
      await cx(c,
        `INSERT INTO expiry_disposals (store_id, batch_id, product_id, status, deadline_at, started_at, handler_id, handler_name)
         SELECT ${curStore()}, b.id, b.product_id, '处理中', now() + make_interval(hours => $2::int), now(), $3, $4
           FROM batches b WHERE b.id = ANY($1::bigint[])
         ON CONFLICT (batch_id) DO UPDATE SET
           status = CASE WHEN expiry_disposals.status = '已退换' THEN expiry_disposals.status ELSE '处理中' END,
           started_at = COALESCE(expiry_disposals.started_at, now()), updated_at = now()`,
        [batchIds, await this.settings.getNum('stock.expiry_disposal_hours', 48), user.sub, user.name || '']);

      await audit(curStore(), user.sub, '进销存', 'return.from_expiry', 'purchase_return', docs[0]?.id ?? 0,
        { batchIds, docCount: docs.length, nos: docs.map(d => d.returnNo) });
      return {
        docCount: docs.length,
        returnNos: docs.map(d => d.returnNo),
        batchCount: batchIds.length,
        docs,
        note: '退货单已生成（待审核）：补传凭证后审核，审核通过自动扣库存并标记处置到位',
      };
    });
  }

  /**
   * 退货审核（权限点 stock.return.audit）：按归属明细扣批次（原价）+ 库存流水 + 即时库存；
   * 幂等：状态机拦截重复审核
   */
  @RequirePerms('stock.return.audit')
  @Post('returns/:id/audit')
  async auditReturn(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE`, [id]);
      const ret = rs[0];
      if (!ret) throw new BizException(40404, '退货单不存在', 404);
      if (ret.status !== '待审核') {
        throw new BizException(50016, `退货单状态(${ret.status})不允许审核`);
      }
      await this.assertSigned(c, 'return', 'purchase_returns', id, String(ret.return_no));
      if (!ret.evidence_path) {
        throw new BizException(50013, '退货凭证未上传（拍照/签收单），请先在单据列表补传凭证再审核');
      }

      const allocs = await cx(c,
        `SELECT a.*, i.product_id, i.qty AS item_qty
           FROM return_batch_allocs a
           JOIN purchase_return_items i ON i.id = a.return_item_id
          WHERE i.return_id=$1 ORDER BY a.id`, [id]);
      if (!allocs.length) throw new BizException(50016, '退货单无批次归属明细，不能审核');

      let total = 0;
      const byProduct = new Map<number, number>();
      for (const a of allocs) {
        const cost = Number(a.unit_cost);
        total += Number(a.qty) * cost;
        byProduct.set(Number(a.product_id), (byProduct.get(Number(a.product_id)) || 0) + Number(a.qty));

        await cx(c,
          `UPDATE batches SET remain_qty = remain_qty - $2,
              status = CASE WHEN remain_qty - $2 <= 0 THEN '售罄' ELSE status END
            WHERE id=$1`, [a.batch_id, a.qty]);
        await cx(c,
          `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, ref_item_id, employee_id)
           VALUES (${curStore()},$1,$2,'出库',$3,$4,'return',$5,$6,$7)`,
          [a.product_id, a.batch_id, a.qty, cost, id, a.return_item_id, user.sub]);
      }
      for (const [pid, qty] of byProduct) {
        await cx(c,
          `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now()
            WHERE store_id=${curStore()} AND product_id=$1`, [pid, r3(qty)]);
      }

      await cx(c,
        `UPDATE purchase_returns SET status='已审核', audited_by=$2, audited_at=now(), total_amount=$3 WHERE id=$1`,
        [id, user.sub, r2(total)]);
      // 临期处置联动（V4.9.3）：退货审核通过 = 临期处置到位（已退/换货）
      await cx(c,
        `UPDATE expiry_disposals SET status='已退换', handled_at=now(),
            return_doc_no = COALESCE(return_doc_no, $2), updated_at = now()
          WHERE batch_id = ANY($1::bigint[]) AND status <> '已退换'`,
        [allocs.map(a => a.batch_id), ret.return_no]);
      await audit(curStore(), user.sub, '进销存', 'return.audit', 'purchase_return', id, { no: ret.return_no, total: r2(total) });
      return { id, status: '已审核', totalAmount: r2(total) };
    });
  }

  /** 退货凭证补传（V4.8.21 凭证后置：创建后、审核前补上传，仅待预审/已预审可补） */
  @RequirePerms('stock.inbound.audit', 'stock.return.audit')
  @Post('returns/:id/evidence')
  async uploadReturnEvidence(@Param('id', ParseIntPipe) id: number,
                             @Body() b: { evidencePath: string },
                             @CurrentUser() user: AuthUser) {
    if (!b.evidencePath) throw new BizException(40003, 'evidencePath 必填（拍照/签收单路径）');
    const r = await q1(
      `UPDATE purchase_returns SET evidence_path=$2
        WHERE id=$1 AND status IN ('待审核') RETURNING id, return_no`,
      [id, b.evidencePath]);
    if (!r) throw new BizException(50016, '退货单不存在或当前状态不允许补传凭证');
    await audit(curStore(), user.sub, '进销存', 'return.evidence', 'purchase_return', id, { evidencePath: b.evidencePath });
    return r;
  }

  /** 退货单作废（V4.9.6：仅未扣库存前（待审核）可作废，置「已作废」） */
  /**
   * V4.9.8 退货单驳回（手机端审批）：待审核 → 已驳回，原因必填并留痕；不涉库存。
   * 典型场景：凭证不清、批次归属错误、数量与实物不符——驳回后由门店整改重提。
   */
  @RequirePerms('stock.return.audit')
  @Post('returns/:id/reject')
  async rejectReturn(@Param('id', ParseIntPipe) id: number,
                     @Body() b: { reason?: string },
                     @CurrentUser() user: AuthUser) {
    const reason = String(b.reason || '').trim();
    if (!reason) throw new BizException(40003, '驳回必须填写原因（便于门店整改与留痕）');
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE`, [id]);
      const ret = rs[0];
      if (!ret) throw new BizException(40404, '退货单不存在', 404);
      if (ret.status !== '待审核') throw new BizException(50016, `退货单状态(${ret.status})不允许驳回`);
      await cx(c,
        `UPDATE purchase_returns SET status='已驳回', reject_reason=$2, rejected_by=$3, rejected_at=now() WHERE id=$1`,
        [id, reason, user.sub]);
      await audit(curStore(), user.sub, '进销存', 'return.reject', 'purchase_return', id, { no: ret.return_no, reason });
      return { id, status: '已驳回', rejectReason: reason };
    });
  }

  @RequirePerms('stock.return.audit')
  @Post('returns/:id/void')
  async voidReturn(@Param('id', ParseIntPipe) id: number,
                   @Body() b: { reason?: string },
                   @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE`, [id]);
      const ret = rs[0];
      if (!ret) throw new BizException(40404, '退货单不存在', 404);
      if (ret.status !== '待审核') {
        throw new BizException(50016, `退货单状态(${ret.status})不允许作废（已审核请走入库流程回退）`);
      }
      await cx(c, `UPDATE purchase_returns SET status='已作废', remark = COALESCE(remark,'') || '；作废：' || $2 WHERE id=$1`,
        [id, b.reason ?? '人工作废']);
      await audit(curStore(), user.sub, '进销存', 'return.void', 'purchase_return', id, { no: ret.return_no });
      return { id, status: '已作废' };
    });
  }

  /** V4.9.5 未产生业务退货单删除（待预审/已取消，均未扣库存可硬删留审计） */
  @RequirePerms('stock.return.audit')
  @Delete('returns/:id')
  async deleteReturn(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE`, [id]);
      const ret = rs[0];
      if (!ret) throw new BizException(40404, '退货单不存在', 404);
      if (!['待审核', '已取消', '已作废'].includes(ret.status)) {
        throw new BizException(50016, `已产生业务的退货单不可删除（当前 ${ret.status}）`);
      }
      await cx(c, `DELETE FROM return_batch_allocs WHERE return_item_id IN (SELECT id FROM purchase_return_items WHERE return_id=$1)`, [id]);
      await cx(c, `DELETE FROM purchase_return_items WHERE return_id=$1`, [id]);
      await cx(c, `DELETE FROM purchase_returns WHERE id=$1`, [id]);
      await audit(curStore(), user.sub, '进销存', 'return.delete', 'purchase_return', id, { no: ret.return_no });
      return { id, deleted: true };
    });
  }

  // ═══ T8 对账与结算（方案 5.6 / V4.3.6 周期费用自动补齐 / V4.3.7 现场确认） ═══

  /**
   * 费用自动补齐漏记期次（V4.3.6）：对账前扫描 auto_generate 协议，
   * 覆盖区间内缺失期次自动生成费用单（固定额；比例类按销售额另行计算，此处仅固定额）
   */
  private async ensureAgreementFees(c: any, supplierId: number, from: string, to: string, userId: number) {
    const agreements = await cx(c,
      `SELECT a.*, t.direction FROM supplier_fee_agreements a
         JOIN supplier_fee_types t ON t.id = a.fee_type_id
        WHERE a.supplier_id=$1 AND a.auto_generate AND a.status=1
          AND a.amount_mode='固定额' AND a.amount IS NOT NULL
          AND a.start_date <= $3::date AND (a.end_date IS NULL OR a.end_date >= $2::date)`,
      [supplierId, from, to]);
    const created: any[] = [];
    for (const ag of agreements) {
      // 按月协议：遍历覆盖月份（旬/周协议后续扩展）
      if (ag.cycle !== '月') continue;
      // V4.14.0 A：期数上限——一次性只生成 1 期；周期性生成满 total_periods 后自动停补
      if (ag.fee_nature === '一次性' || ag.total_periods !== null) {
        const done = await cx(c,
          `SELECT count(*)::int AS n FROM supplier_fees WHERE agreement_id=$1`, [ag.id]);
        const cap = ag.fee_nature === '一次性' ? 1 : Number(ag.total_periods ?? 0);
        if (Number(done[0]?.n ?? 0) >= cap) continue;
      }
      const months = monthRange(from, to);
      for (const m of months) {
        const ps = `${m}-01`;
        const pe = lastDayOfMonth(m);
        const start = ps < ag.start_date ? ag.start_date : ps;
        const end = ag.end_date && pe > ag.end_date ? ag.end_date : pe;
        if (start > end) continue;
        const dup = await cx(c,
          `SELECT 1 FROM supplier_fees WHERE agreement_id=$1 AND period_start <= $3::date AND period_end >= $2::date LIMIT 1`,
          [ag.id, start, end]);
        if (dup.length) continue;
        const seq = await seqLock(c, 'supplier_fees', 'fee_no', `FY-${m.replace('-', '')}-%`);
        const feeNo = `FY-${m.replace('-', '')}-${String(seq[0].n).padStart(3, '0')}`;
        const t = await cx(c, `SELECT direction FROM supplier_fee_types WHERE id=$1`, [ag.fee_type_id]);
        const agDir = ag.direction ? String(ag.direction) : (t[0]?.direction ?? '收');   // V4.13.9 协议行级方向优先
        const ag2pool = agDir === '收' && await this.settings.getBool('recon.fee_to_dividend', false); // VQA-D3 费用入分红池
        const fee = await cx(c,
          `INSERT INTO supplier_fees (store_id, fee_no, supplier_id, fee_type_id, agreement_id, period_start, period_end,
                                      amount, direction, to_dividend_pool, status, employee_id, remark)
           VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,$9,'已审核',$10,$11) RETURNING id`,
          [feeNo, supplierId, ag.fee_type_id, ag.id, start, end, ag.amount, agDir, ag2pool, userId,
           `协议自动补齐（${ag.cycle}期 ${start}~${end}）`]);
        created.push({ feeId: fee[0].id, feeNo, amount: Number(ag.amount), direction: agDir });
      }
    }
    return created;
  }

  /** 对账预览：区间内未吸收单据汇总（不写库） */
  @Get('recon/preview')
  async reconPreview(@Query('supplierId') supplierId: string, @Query('from') from?: string, @Query('to') to?: string) {
    const sid = Number(supplierId);
    if (!sid) throw new BizException(40003, 'supplierId 必填');
    // V5.0.8b：日期默认为空时不按区间约束（取极宽范围，含未来日期避免漏单）
    const f = from || '1970-01-01';
    const t = to || '2999-12-31';
    return tx(async c => {
      const inbounds = await cx(c,
        `SELECT id, inbound_no AS doc_no, created_at::date AS doc_date, audited_at::date AS audit_date, total_amount AS amount, status, remark
           FROM inbound_orders
          WHERE supplier_id=$1 AND status IN ('未审核','已审核') AND recon_id IS NULL
            AND created_at::date BETWEEN $2::date AND $3::date ORDER BY id`, [sid, f, t]);
      const returns = await cx(c,
        `SELECT r.id, r.return_no AS doc_no, r.created_at::date AS doc_date, r.audited_at::date AS audit_date, r.total_amount AS amount, r.status, r.remark
           FROM purchase_returns r
          WHERE r.supplier_id=$1 AND r.status IN ('待审核','待审核','已审核')
            AND NOT EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.doc_type='return' AND ri.doc_id=r.id)
            AND r.created_at::date BETWEEN $2::date AND $3::date ORDER BY r.id`, [sid, f, t]);
      const fees = await cx(c,
        `SELECT f.id, f.fee_no AS doc_no, f.created_at::date AS doc_date, f.created_at::date AS audit_date, f.amount, f.remark,
                COALESCE(f.direction, t.direction) AS direction, t.name AS fee_type
           FROM supplier_fees f JOIN supplier_fee_types t ON t.id = f.fee_type_id
          WHERE f.supplier_id=$1 AND f.status='已审核'
            AND NOT EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.doc_type='fee' AND ri.doc_id=f.id)
            AND f.created_at::date BETWEEN $2::date AND $3::date ORDER BY f.id`, [sid, f, t]);
      const audited = (x: any[]) => x.filter(r => r.status === '已审核');   // 未审核单据仅展示，不计入应付
      const goods = audited(inbounds).reduce((s, x) => s + Number(x.amount), 0)
                  - audited(returns).reduce((s, x) => s + Number(x.amount), 0);
      const feeIncome = fees.filter(x => x.direction === '收').reduce((s, x) => s + Number(x.amount), 0);
      const feePay = fees.filter(x => x.direction === '付').reduce((s, x) => s + Number(x.amount), 0);
      return { from: f, to: t,
               inbounds, returns,
               fees: fees.map((x: any) => ({ id: x.id, docNo: x.doc_no, audit_date: x.audit_date, remark: x.remark || '', amount: Number(x.amount), direction: x.direction, feeType: x.fee_type })),
               goodsTotal: r2(goods), feeIncomeTotal: r2(feeIncome), feePayTotal: r2(feePay),
               payableTotal: r2(goods + feePay - feeIncome) };
    });
  }

  /**
   * 生成对账单（T8）：
   * 1) 自动补齐协议漏记期次费用；2) 吸收区间内入库/退货/费用单据；
   * 3) 写往来账（入库借/退货贷/收入费用贷/付出费用借）；4) 标记入库单已被吸收
   */
  @RequirePerms('recon.confirm')
  @Post('recon')
  async createRecon(
    @Body() b: { supplierId: number; from: string; to: string; remark?: string;
                 docIds?: { inbounds?: number[]; returns?: number[]; fees?: number[] } },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.supplierId || !b.from || !b.to) throw new BizException(40003, 'supplierId / from / to 必填');
    return tx(async c => {
      const autoFees = await this.ensureAgreementFees(c, b.supplierId, b.from, b.to, user.sub);

      // V4.8.21 勾选对账：传 docIds 时只吸收勾选单据（仍校验归属供应商 + 未被吸收），否则按区间全量
      const picked = b.docIds || null;
      const pickClause = (col: string, extra: string) =>
        ` AND ($4::bigint[] IS NULL OR ${col} = ANY($4::bigint[]))${extra}`;
      const inbounds = await cx(c,
        `SELECT id, store_id, inbound_no AS doc_no, created_at::date AS doc_date, total_amount AS amount
           FROM inbound_orders
          WHERE supplier_id=$1 AND status='已审核' AND recon_id IS NULL
            AND created_at::date BETWEEN $2::date AND $3::date${pickClause('id', '')}
          ORDER BY id FOR UPDATE`, [b.supplierId, b.from, b.to,
          picked ? (picked.inbounds || []).map(Number) : null]);
      const returns = await cx(c,
        `SELECT r.id, r.return_no AS doc_no, r.created_at::date AS doc_date, r.total_amount AS amount
           FROM purchase_returns r
          WHERE r.supplier_id=$1 AND r.status='已审核'
            AND NOT EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.doc_type='return' AND ri.doc_id=r.id)
            AND r.created_at::date BETWEEN $2::date AND $3::date${pickClause('r.id', '')}
          ORDER BY r.id FOR UPDATE`, [b.supplierId, b.from, b.to,
          picked ? (picked.returns || []).map(Number) : null]);
      const fees = await cx(c,
        `SELECT f.id, f.fee_no AS doc_no, f.created_at::date AS doc_date, f.amount,
                COALESCE(f.direction, t.direction) AS direction
           FROM supplier_fees f JOIN supplier_fee_types t ON t.id = f.fee_type_id
          WHERE f.supplier_id=$1 AND f.status='已审核'
            AND NOT EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.doc_type='fee' AND ri.doc_id=f.id)
            AND f.created_at::date BETWEEN $2::date AND $3::date${pickClause('f.id', '')}
          ORDER BY f.id FOR UPDATE`, [b.supplierId, b.from, b.to,
          picked ? (picked.fees || []).map(Number) : null]);
      if (!inbounds.length && !returns.length && !fees.length) {
        throw new BizException(50017, '该区间无可对账单据');
      }

      const ym = b.to.slice(0, 7).replace('-', '');
      const seq = await seqLock(c, 'reconciliations', 'recon_no', `DZ-${ym}-%`);
      const no = `DZ-${ym}-${String(seq[0].n).padStart(3, '0')}`;

      /* ── V5.0.0 批次4B（M4-20/R17 第四轮拍板）：对账计价引擎 ──
       * 逐行 settle_price = L1（对账时点有效值），invoice/settle/variance 三层同时落库，
       * 恒等式 invoice = settle + variance（服务端强保证）。
       * 应付（goods_total / supplier_ledger）只按 settle_amount 记 —— 差异不进应付，进差异单。
       * 单店部署（chainOn=false）：docAmounts 恒空 → 全部回落原口径，零回归。 */
      const chainOn = await chainEnabled();
      const hqId = chainOn ? await hqStoreId() : null;
      const docAmounts = new Map<number, { inv: number; stl: number; src: number; scope: string }>();
      const varianceLines: any[] = [];
      if (chainOn) {
        for (const d of inbounds) {
          const its = await cx(c,
            `SELECT ii.product_id, ii.qty, ii.unit_cost, ii.gift, p.name, p.barcode, p.base_unit,
                    ${COST_REF('p')} AS l1
               FROM inbound_order_items ii JOIN products p ON p.id = ii.product_id
              WHERE ii.inbound_id=$1`, [d.id]);
          let inv = 0, stl = 0;
          for (const it of its) {
            if (it.gift) continue;                       // 赠品成本 0，不参与差异
            const l1 = Number(it.l1 ?? 0), act = Number(it.unit_cost), qty = Number(it.qty);
            inv += act * qty;
            stl += l1 * qty;
            const gap = Math.round((act - l1) * 10000) / 10000;
            if (Math.abs(gap) > 1e-9 && qty > 0) {
              varianceLines.push({ storeId: Number(d.store_id), productId: Number(it.product_id),
                name: it.name, barcode: it.barcode, unit: it.base_unit, qty,
                settle: l1, actual: act, gap, gapAmount: r2(gap * qty),
                inboundId: Number(d.id), docNo: d.doc_no, bizDate: d.doc_date });
            }
          }
          docAmounts.set(Number(d.id), {
            inv: r2(inv), stl: r2(stl), src: Number(d.store_id),
            scope: Number(d.store_id) === Number(hqId) ? 'hq_purchase' : 'store_purchase',
          });
        }
      }

      /* ── V5.0.0 批次4B（M4-20/R17 第五轮拍板）：补差结转扫描 ──
       * 上期「补差」差异单（picked_up 且未挂账）在本期生成对账单时自动挂
       * doc_type='variance_pickup' 应付增加行；CAS 防重复计入。 */
      const carrySheets = chainOn
        ? await cx(c, `SELECT id, cvd_no, variance_amount FROM cost_variance_sheets
                        WHERE supplier_id=$1 AND action='pickup' AND status='picked_up'
                          AND carry_to_recon_id IS NULL AND settled_in_recon_id IS NULL
                        ORDER BY id FOR UPDATE`, [b.supplierId])
        : [];
      const carriedAmount = carrySheets.reduce((s: number, x: any) => s + Number(x.variance_amount), 0);

      const goods = inbounds.reduce((s, x) => {
        const da = docAmounts.get(Number(x.id));
        return s + (da ? da.stl : Number(x.amount));       // 连锁：应付按 L1 结算额；单店：原口径
      }, 0) - returns.reduce((s, x) => s + Number(x.amount), 0);
      const feeIncome = fees.filter(x => x.direction === '收').reduce((s, x) => s + Number(x.amount), 0);
      const feePay = fees.filter(x => x.direction === '付').reduce((s, x) => s + Number(x.amount), 0)
                  + carriedAmount;                       // 补差结转 = 应付增加项

      const recon = await cx(c,
        `INSERT INTO reconciliations (store_id, recon_no, supplier_id, period_start, period_end, status,
                                      goods_total, fee_income_total, fee_pay_total, employee_id, remark)
         VALUES (${curStore()},$1,$2,$3,$4,'生成',$5,$6,$7,$8,$9) RETURNING id`,
        [no, b.supplierId, b.from, b.to, r2(goods), r2(feeIncome), r2(feePay), user.sub, b.remark ?? null]);
      const rid = recon[0].id;

      const addItem = async (docType: string, doc: any, sign: number) => {
        // 批次4B：连锁模式补三层金额 + 单据发生门店；单店全部回落原口径（inv=stl=amount）
        const da = docAmounts.get(Number(doc.id));
        const inv = da ? da.inv : Number(doc.amount);
        const stl = da ? da.stl : Number(doc.amount);
        const varAmt = r2(inv - stl);
        await cx(c,
          `INSERT INTO reconciliation_items (recon_id, doc_type, doc_id, doc_no, doc_date, amount, unpaid_amount, line_remark,
                                             source_store_id, biz_scope, invoice_amount, settle_amount, variance_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12)`,
          [rid, docType, doc.id, doc.doc_no, doc.doc_date, doc.amount,
           docType === 'inbound' ? '入库' : docType === 'return' ? '退货（冲减）' : '费用',
           da ? da.src : null, da ? da.scope : null, inv, stl, varAmt]);
        // 应付账（supplier_ledger）连锁下按 settle_amount 记；差异不进应付
        const ledgerAmt = da ? da.stl : Number(doc.amount);
        if (sign > 0) await writeLedger(c, 1, b.supplierId, docType, doc.id, doc.doc_no, ledgerAmt, 0, doc.doc_date);
        else await writeLedger(c, 1, b.supplierId, docType, doc.id, doc.doc_no, 0, ledgerAmt, doc.doc_date);
      };
      for (const d of inbounds) await addItem('inbound', d, +1);
      for (const d of returns) await addItem('return', d, -1);
      for (const d of fees) await addItem('fee', d, d.direction === '收' ? -1 : +1);

      // ── 补差结转：CAS 挂账（防账单重开/并发重复计入，方案 §5.8.3-③） ──
      for (const cs of carrySheets) {
        const ok = await cx(c,
          `UPDATE cost_variance_sheets SET carry_to_recon_id=$2, carried_at=now()
            WHERE id=$1 AND carry_to_recon_id IS NULL AND settled_in_recon_id IS NULL RETURNING id`,
          [cs.id, rid]);
        if (ok.length) {
          await cx(c,
            `INSERT INTO reconciliation_items (recon_id, doc_type, doc_id, doc_no, doc_date, amount, unpaid_amount, line_remark, biz_scope)
             VALUES ($1,'variance_pickup',$2,$3,$4,$5,$5,$6,'hq_purchase')`,
            [rid, Number(cs.id), String(cs.cvd_no), b.to, Number(cs.variance_amount),
             `上期进价差异补差 ${cs.cvd_no}`]);
          const docDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
          await writeLedger(c, 1, b.supplierId, 'fee_variance', Number(cs.id), String(cs.cvd_no),
            Number(cs.variance_amount), 0, docDate);
        }
      }

      // ── 差异单生成（供应商 + 账期汇总；有差异行才生成，方案 §5.8.2） ──
      if (varianceLines.length) {
        const invTotal = r2(varianceLines.reduce((s: number, x: any) => s + x.actual * x.qty, 0));
        const stlTotal = r2(varianceLines.reduce((s: number, x: any) => s + x.settle * x.qty, 0));
        const varTotal = r2(invTotal - stlTotal);
        const qtyTotal = r3(varianceLines.reduce((s: number, x: any) => s + x.qty, 0));
        // 同供应商已有未结差异单 → 并单（重算合计）；否则新建 CVD-S{供应商}-{账期}
        const exist = await cx(c,
          `SELECT id, cvd_no FROM cost_variance_sheets
            WHERE supplier_id=$1 AND status IN ('open','negotiating','disputed')
            ORDER BY id DESC LIMIT 1 FOR UPDATE`, [b.supplierId]);
        let sheetId: number, cvdNo: string;
        if (exist.length) {
          sheetId = Number(exist[0].id); cvdNo = String(exist[0].cvd_no);
          await cx(c, `UPDATE cost_variance_sheets SET recon_id=COALESCE(recon_id,$2) WHERE id=$1`, [sheetId, rid]);
        } else {
          cvdNo = `CVD-S${b.supplierId}-${ym}`;
          const ins = await cx(c,
            `INSERT INTO cost_variance_sheets (cvd_no, supplier_id, period_start, period_end, recon_id,
                                               due_at, created_at)
             VALUES ($1,$2,$3,$4,$5, now() + interval '60 days', now())
             ON CONFLICT (cvd_no) DO NOTHING RETURNING id`,
            [cvdNo, b.supplierId, b.from, b.to, rid]);
          sheetId = ins.length ? Number(ins[0].id)
            : Number((await cx(c,
                `INSERT INTO cost_variance_sheets (cvd_no, supplier_id, period_start, period_end, recon_id, due_at, created_at)
                 VALUES ($1,$2,$3,$4,$5, now() + interval '60 days', now()) RETURNING id`,
                [`CVD-S${b.supplierId}-${ym}-${rid}`, b.supplierId, b.from, b.to, rid]))[0].id);
        }
        for (const v of varianceLines) {
          await cx(c,
            `INSERT INTO cost_variance_items (sheet_id, store_id, product_id, product_name, barcode, base_unit,
                                              qty, settle_price, actual_price, gap, gap_amount,
                                              inbound_id, doc_no, biz_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [sheetId, v.storeId, v.productId, String(v.name).slice(0, 120), v.barcode, v.unit,
             v.qty, v.settle, v.actual, v.gap, v.gapAmount, v.inboundId, v.docNo, v.bizDate]);
        }
        // 合计从明细重算（并单场景也正确）
        const agg = (await cx(c,
          `SELECT COUNT(*)::int AS n, COALESCE(SUM(qty),0) AS q,
                  COALESCE(SUM(actual_price*qty),0) AS inv, COALESCE(SUM(settle_price*qty),0) AS stl
             FROM cost_variance_items WHERE sheet_id=$1`, [sheetId]))[0];
        await cx(c,
          `UPDATE cost_variance_sheets SET item_count=$2, qty_total=$3, invoice_amount=$4, settle_amount=$5,
                  variance_amount=$6
            WHERE id=$1`,
          [sheetId, Number(agg.n), r3(Number(agg.q)), r2(Number(agg.inv)), r2(Number(agg.stl)),
           r2(Number(agg.inv) - Number(agg.stl))]);
        await audit(curStore(), user.sub, '财务', '差异单生成', 'cost_variance', sheetId,
          { cvdNo, variance: varTotal, lines: varianceLines.length, reconNo: no });
      }

      await cx(c, `UPDATE inbound_orders SET recon_id=$2 WHERE id = ANY($1::bigint[])`,
        [inbounds.map(d => d.id), rid]);

      await audit(curStore(), user.sub, '财务', 'recon.create', 'reconciliation', rid,
        { no, goods: r2(goods), feeIncome: r2(feeIncome), feePay: r2(feePay), autoFees });
      return { id: rid, reconNo: no, goodsTotal: r2(goods), feeIncomeTotal: r2(feeIncome),
               feePayTotal: r2(feePay), payableTotal: r2(goods + feePay - feeIncome), autoFees };
    });
  }

  /** 对账确认（现场确认 V4.3.7：业务员到店 + 电子签字/拍照留底；P2-3b 现场补签直存证据链） */
  @RequirePerms('recon.confirm')
  @Post('recon/:id/confirm')
  async confirmRecon(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { confirmType: string; confirmName?: string; signRecordId?: number; signImage?: string; templateId?: number; confirmPhotos?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.confirmType) throw new BizException(40003, 'confirmType 必填（现场确认/PDF打印签字/口头确认）');
    return tx(async c => {
      const scenes = await this.settings.getJson('auth.sign_required_scenes', []);
      if (Array.isArray(scenes) && scenes.includes('recon') && !b.signImage && !b.signRecordId) {
        throw new BizException(50018, '该对账单在"必签才能过审"配置中，请现场补签后再确认');
      }
      const rs = await cx(c, `SELECT * FROM reconciliations WHERE id=$1 FOR UPDATE`, [id]);
      const rec = rs[0];
      if (!rec) throw new BizException(40404, '对账单不存在', 404);
      if (rec.status !== '生成' && rec.status !== '待供应商确认') {
        throw new BizException(50018, `对账单状态(${rec.status})不允许确认`);
      }
      let signRecordId = b.signRecordId ?? null;
      if (b.signImage) {
        signRecordId = await this.saveSignature(c, user, {
          personName: b.confirmName || '对账业务员', image: b.signImage, templateId: b.templateId,
          bizType: '对账确认', bizId: id, scene: '现场补签',
        });
      }
      await cx(c,
        `UPDATE reconciliations SET status='已确认', confirm_type=$2, confirm_name=$3, sign_record_id=$4,
                confirm_photos=$5::jsonb, confirmed_at=now() WHERE id=$1`,
        [id, b.confirmType, b.confirmName ?? null, signRecordId,
         b.confirmPhotos ? JSON.stringify(b.confirmPhotos) : null]);
      await audit(curStore(), user.sub, '财务', 'recon.confirm', 'reconciliation', id, { confirmType: b.confirmType });
      return { id, status: '已确认', signRecordId };
    });
  }

  /**
   * 对账单作废（V4.8.21）：仅「生成/待供应商确认」可作废；
   * 删除明细 + 回删对应往来账并重算余额快照 + 释放入库单 recon_id。
   */
  @RequirePerms('recon.confirm')
  @Post('recons/:id/void')
  async voidRecon(@Param('id', ParseIntPipe) id: number,
                  @Body() b: { reason?: string },
                  @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM reconciliations WHERE id=$1 FOR UPDATE`, [id]);
      const rec = rs[0];
      if (!rec) throw new BizException(40404, '对账单不存在', 404);
      if (rec.status !== '生成' && rec.status !== '待供应商确认') {
        throw new BizException(50018, `对账单状态(${rec.status})不允许作废`);
      }
      const st = await cx(c, `SELECT 1 FROM settlements WHERE recon_id=$1 LIMIT 1`, [id]);
      if (st.length) throw new BizException(50019, '该对账单已存在结算单，不能作废');

      const items = await cx(c, `SELECT doc_type, doc_id FROM reconciliation_items WHERE recon_id=$1`, [id]);
      for (const it of items) {
        await cx(c, `DELETE FROM supplier_ledger WHERE supplier_id=$1 AND biz_type=$2 AND biz_id=$3`,
          [rec.supplier_id, it.doc_type, it.doc_id]);
      }
      await cx(c, `DELETE FROM reconciliation_items WHERE recon_id=$1`, [id]);
      await cx(c, `UPDATE inbound_orders SET recon_id=NULL WHERE recon_id=$1`, [id]);
      await cx(c, `UPDATE reconciliations SET status='已作废', remark = COALESCE(remark,'') || '；作废：' || $2 WHERE id=$1`,
        [id, b.reason ?? '人工作废']);
      // 重算该供应商往来账余额快照
      const rows = await cx(c,
        `SELECT id, debit, credit FROM supplier_ledger WHERE supplier_id=$1 ORDER BY id`, [rec.supplier_id]);
      let bal = 0;
      for (const r of rows) {
        bal = r2(bal + Number(r.debit) - Number(r.credit));
        await cx(c, `UPDATE supplier_ledger SET balance_after=$2 WHERE id=$1`, [r.id, bal]);
      }
      // V5.0.0 批次4B：账单作废 → 清空挂在本账单上的补差结转（重开对账单时会重新 CAS 挂账）
      await cx(c,
        `UPDATE cost_variance_sheets SET carry_to_recon_id=NULL, carried_at=NULL
          WHERE carry_to_recon_id=$1 AND settled_in_recon_id IS NULL`, [id]);
      await audit(curStore(), user.sub, '财务', 'recon.void', 'reconciliation', id, { no: rec.recon_no });
      return { id, status: '已作废', releasedDocs: items.length };
    });
  }

  /** 创建结算单（基于已确认对账单） */
  @RequirePerms('recon.settle.audit')
  @Post('settlements')
  async createSettlement(
    @Body() b: { reconId: number; payMode?: string; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.reconId) throw new BizException(40003, 'reconId 必填');
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM reconciliations WHERE id=$1 FOR UPDATE`, [b.reconId]);
      const rec = rs[0];
      if (!rec) throw new BizException(40404, '对账单不存在', 404);
      // V4.8.21 0元直结算：应付为 0（费用±冲抵后）免确认免审核，一步到位
      const zero = Number(rec.payable_total) === 0;
      if (!zero && rec.status !== '已确认') throw new BizException(50019, `对账单状态(${rec.status})必须先确认再结算`);
      const dup = await cx(c,
        `SELECT 1 FROM settlements WHERE recon_id=$1 AND status::text <> '已关闭' LIMIT 1`, [b.reconId]);
      if (dup.length) throw new BizException(50019, '该对账单已存在结算单');

      const ym = today().slice(0, 6);
      const seq = await seqLock(c, 'settlements', 'settle_no', `JS-${ym}-%`);
      const no = `JS-${ym}-${String(seq[0].n).padStart(3, '0')}`;
      const st = await cx(c,
        `INSERT INTO settlements (store_id, settle_no, supplier_id, recon_id, amount, status, pay_mode, employee_id, remark${zero ? ', audited_by, paid_at' : ''})
         VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8${zero ? ',$9,now()' : ''}) RETURNING id`,
        [no, rec.supplier_id, b.reconId, rec.payable_total, zero ? '已审核' : '待审核',
         b.payMode ?? '转账', user.sub, b.remark ?? null, ...(zero ? [user.sub] : [])]);
      if (zero) {
        const docDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        await writeLedger(c, 1, rec.supplier_id, 'settlement', st[0].id, no, 0, 0, docDate);
        await cx(c, `UPDATE reconciliations SET status='已结算' WHERE id=$1`, [b.reconId]);
      } else {
        await cx(c, `UPDATE reconciliations SET status='待供应商确认' WHERE id=$1 AND status='生成'`, [b.reconId]);
      }
      await audit(curStore(), user.sub, '财务', 'settlement.create', 'settlement', st[0].id,
        { no, amount: rec.payable_total, zeroDirect: zero });
      return { id: st[0].id, settleNo: no, amount: Number(rec.payable_total),
               status: zero ? '已审核' : '待审核', zeroDirect: zero };
    });
  }

  /**
   * 结算审核（T8 终点）：核销对账单 → 写往来账贷方（应付减少）→ 对账单置已结算；
   * A5 打印字段见打印模板（9.9.3）
   */
  @RequirePerms('recon.settle.audit')
  @Post('settlements/:id/audit')
  async auditSettlement(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const flowOn = await this.settings.getBool('recon.settle_pay_flow', false);
    return tx(async c => {
      const ss = await cx(c, `SELECT * FROM settlements WHERE id=$1 FOR UPDATE`, [id]);
      const st = ss[0];
      if (!st) throw new BizException(40404, '结算单不存在', 404);
      if (st.status !== '待审核') throw new BizException(50021, `结算单状态(${st.status})不允许审核`);
      // VQA-D3：recon.settle_pay_flow 开=审核→「付款中」（枚举 5.6.5 原生态），由 paySettlement 完成终结；关=旧口径审核即终结
      if (flowOn) {
        await cx(c, `UPDATE settlements SET status='付款中', audited_by=$2 WHERE id=$1`, [id, user.sub]);
        await audit(curStore(), user.sub, '财务', 'settlement.audit', 'settlement', id,
          { no: st.settle_no, amount: Number(st.amount), step: '付款中（已审核，待出纳付款）' });
        return { id, status: '付款中' };
      }

      const docDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      await writeLedger(c, 1, st.supplier_id, 'settlement', st.id, st.settle_no, 0, Number(st.amount), docDate);
      await cx(c, `UPDATE settlements SET status='已审核', audited_by=$2, paid_at=now() WHERE id=$1`, [id, user.sub]);
      await cx(c, `UPDATE reconciliations SET status='已结算' WHERE id=$1`, [st.recon_id]);
      // V5.0.0 批次4B（M4-20）：该期账单结算 → 补差差异单落终态 carried（CAS 防重复计入）
      await cx(c,
        `UPDATE cost_variance_sheets
            SET settled_in_recon_id=$2, status='carried', closed_at=now()
          WHERE action='pickup' AND carry_to_recon_id=$1 AND settled_in_recon_id IS NULL`,
        [st.recon_id, st.recon_id]);

      await audit(curStore(), user.sub, '财务', 'settlement.audit', 'settlement', id,
        { no: st.settle_no, amount: Number(st.amount) });
      return { id, status: '已审核', paidAt: new Date().toISOString() };
    });
  }

  /** VQA-D3 recon.settle_pay_flow=开 的第二步：确认已付款 → 完成原审核终结动作 */
  @RequirePerms('recon.settle.audit')
  @Post('settlements/:id/pay')
  async paySettlement(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const ss = await cx(c, `SELECT * FROM settlements WHERE id=$1 FOR UPDATE`, [id]);
      const st = ss[0];
      if (!st) throw new BizException(40404, '结算单不存在', 404);
      if (st.status !== '付款中') throw new BizException(50021, `结算单状态(${st.status})不允许确认付款（仅「付款中」可操作）`);
      const docDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      await writeLedger(c, 1, st.supplier_id, 'settlement', st.id, st.settle_no, 0, Number(st.amount), docDate);
      await cx(c, `UPDATE settlements SET status='已付款', paid_at=now() WHERE id=$1`, [id]);
      await cx(c, `UPDATE reconciliations SET status='已结算' WHERE id=$1`, [st.recon_id]);
      await cx(c,
        `UPDATE cost_variance_sheets
            SET settled_in_recon_id=$2, status='carried', closed_at=now()
          WHERE action='pickup' AND carry_to_recon_id=$1 AND settled_in_recon_id IS NULL`,
        [st.recon_id, st.recon_id]);
      await audit(curStore(), user.sub, '财务', 'settlement.pay', 'settlement', id, { no: st.settle_no, amount: Number(st.amount) });
      return { id, status: '已付款', paidAt: new Date().toISOString() };
    });
  }

  @Get('recons')
  recons(@Query('supplierId') supplierId?: string) {
    return q(
      `SELECT r.*, s.name AS supplier_name,
              (SELECT count(*) FROM reconciliation_items i WHERE i.recon_id = r.id) AS item_count
         FROM reconciliations r JOIN suppliers s ON s.id = r.supplier_id
        WHERE ($1::bigint IS NULL OR r.supplier_id = $1::bigint)
        ORDER BY r.id DESC LIMIT 100`, [supplierId ? Number(supplierId) : null]);
  }

  /** 对账单详情（结算单/对账单 A5 打印用：单头 + 吸收明细） */
  @Get('recons/:id')
  async reconDetail(@Param('id', ParseIntPipe) id: number) {
    const rec = await q1(
      `SELECT r.*, s.name AS supplier_name, s.contact_person AS salesman
         FROM reconciliations r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id=$1`, [id]);
    if (!rec) throw new BizException(40404, '对账单不存在', 404);
    const items = await q(
      `SELECT * FROM reconciliation_items WHERE recon_id=$1 ORDER BY id`, [id]);
    return { recon: rec, items };
  }

  @Get('settlements')
  settlements(@Query('supplierId') supplierId?: string) {
    return q(
      `SELECT st.*, s.name AS supplier_name, r.recon_no
         FROM settlements st JOIN suppliers s ON s.id = st.supplier_id
         JOIN reconciliations r ON r.id = st.recon_id
        WHERE ($1::bigint IS NULL OR st.supplier_id = $1::bigint)
        ORDER BY st.id DESC LIMIT 100`, [supplierId ? Number(supplierId) : null]);
  }

  /** 往来账流水（应付余额快照，逐笔可溯） */
  @Get('ledger')
  ledger(@Query('supplierId') supplierId?: string) {
    return q(
      `SELECT l.*, s.name AS supplier_name FROM supplier_ledger l JOIN suppliers s ON s.id = l.supplier_id
        WHERE ($1::bigint IS NULL OR l.supplier_id = $1::bigint)
        ORDER BY l.id DESC LIMIT 200`, [supplierId ? Number(supplierId) : null]);
  }

  // ═══ P2-3a 联营对账（5.7：销售汇总 → 扣点与保底 → 联营费用 → 对账 → 确认 → 结算） ═══

  /** 联营销售聚合（5.7.6 ①）：区间内联营商品销售按供应商汇总，可排除已入对账单的订单 */
  private async consignAgg(c: any, supplierId: number, from: string, to: string, excludeAbsorbed = true) {
    const sup = await cx(c, `SELECT * FROM suppliers WHERE id=$1`, [supplierId]);
    if (!sup.length) throw new BizException(40404, '供应商不存在', 404);
    const s = sup[0];
    const notAbsorbed = ` AND NOT EXISTS (SELECT 1 FROM consign_recon_items cri WHERE cri.order_id = o.id AND cri.recon_id <> 0)`;
    const orders = excludeAbsorbed ? await cx(c,
      `SELECT o.id, o.order_no, o.created_at::date AS order_date, o.channel,
              SUM(i.line_amount) AS amount, SUM(i.qty) AS qty
         FROM sale_items i JOIN sales_orders o ON o.id = i.order_id
        WHERE i.supplier_id = $1 AND i.biz_mode = '联营' AND o.status = '已完成'
          AND o.created_at::date BETWEEN $2::date AND $3::date${notAbsorbed}
        GROUP BY o.id, o.order_no, o.created_at, o.channel ORDER BY o.id`,
      [supplierId, from, to]) : await cx(c,
      `SELECT o.id, o.order_no, o.created_at::date AS order_date, o.channel,
              SUM(i.line_amount) AS amount, SUM(i.qty) AS qty
         FROM sale_items i JOIN sales_orders o ON o.id = i.order_id
        WHERE i.supplier_id = $1 AND i.biz_mode = '联营' AND o.status = '已完成'
          AND o.created_at::date BETWEEN $2::date AND $3::date
        GROUP BY o.id, o.order_no, o.created_at, o.channel ORDER BY o.id`,
      [supplierId, from, to]);
    const ret = excludeAbsorbed ? await cx(c,
      `SELECT COALESCE(SUM(r.amount),0)::float8 AS amount, count(*)::int AS cnt
         FROM sale_refunds r JOIN sale_refund_items ri ON ri.refund_id = r.id
         JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE si.supplier_id = $1 AND si.biz_mode = '联营' AND r.status = '已退款'
          AND r.created_at::date BETWEEN $2::date AND $3::date
          AND NOT EXISTS (SELECT 1 FROM consign_recon_items cri WHERE cri.order_id = r.order_id AND cri.recon_id <> 0)`,
      [supplierId, from, to]) : await cx(c,
      `SELECT COALESCE(SUM(r.amount),0)::float8 AS amount, count(*)::int AS cnt
         FROM sale_refunds r JOIN sale_refund_items ri ON ri.refund_id = r.id
         JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE si.supplier_id = $1 AND si.biz_mode = '联营' AND r.status = '已退款'
          AND r.created_at::date BETWEEN $2::date AND $3::date`, [supplierId, from, to]);
    const fees = await cx(c,
      `SELECT f.id, f.fee_no, f.created_at::date AS fee_date, f.amount, t.name AS fee_type
         FROM supplier_fees f JOIN supplier_fee_types t ON t.id = f.fee_type_id
        WHERE f.supplier_id = $1 AND f.status = '已审核' AND t.direction = '收'
          AND f.created_at::date BETWEEN $2::date AND $3::date
          AND NOT EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.doc_type='fee' AND ri.doc_id=f.id)
        ORDER BY f.id`, [supplierId, from, to]);
    const salesTotal = r2(orders.reduce((a: number, o: any) => a + Number(o.amount), 0));
    const returnTotal = r2(Number(ret[0]?.amount ?? 0));
    const netSales = r2(salesTotal - returnTotal);
    const rate = Number(s.deduction_rate ?? 0);
    const guaranteeSales = s.guarantee_min != null ? Number(s.guarantee_min) : null;
    const actualDeduction = r2(netSales * rate);
    let deductionAmount = actualDeduction, guaranteeAmount = 0;
    if (guaranteeSales != null && guaranteeSales > 0 && rate > 0) {
      const gDed = r2(guaranteeSales * rate);
      if (gDed > actualDeduction) { deductionAmount = gDed; guaranteeAmount = r2(gDed - actualDeduction); }
    }
    const feeTotal = r2(fees.reduce((a: number, f: any) => a + Number(f.amount), 0));
    return {
      supplierId, supplierName: s.name, from, to,
      rate, guaranteeSales,
      orders: orders.map((o: any) => ({ ...o, amount: Number(o.amount), qty: Number(o.qty) })),
      salesTotal, returnTotal, netSales, orderCount: orders.length,
      actualDeduction, deductionAmount, guaranteeAmount,
      fees: fees.map((f: any) => ({ id: f.id, feeNo: f.fee_no, feeDate: f.fee_date, amount: Number(f.amount), feeType: f.fee_type })),
      feeTotal,
      payable: r2(netSales - deductionAmount - feeTotal),
    };
  }

  /** 联营商看板（5.7.7）：本期/环比、达标进度、超市扣点收益、TOP 商品、未结余额 */
  @Get('consign/overview')
  async consignOverview(@Query('supplierId') supplierId: string, @Query('from') from?: string, @Query('to') to?: string) {
    const sid = Number(supplierId);
    if (!sid) throw new BizException(40003, 'supplierId 必填');
    const f = from || (today().slice(0, 4) + '-' + today().slice(4, 6) + '-01');
    const t = to || (today().slice(0, 4) + '-' + today().slice(4, 6) + '-' + today().slice(6, 8));
    return tx(async c => {
      const agg = await this.consignAgg(c, sid, f, t, false);
      const days = Math.round((new Date(t).getTime() - new Date(f).getTime()) / 86400000) + 1;
      const prevTo = addDays(f, -1), prevFrom = addDays(prevTo, -(days - 1));
      const prev = await this.consignAgg(c, sid, prevFrom, prevTo, false);
      const top = await cx(c,
        `SELECT p.name AS product_name, COALESCE(SUM(i.qty),0) AS qty, COALESCE(SUM(i.line_amount),0) AS amount
           FROM sale_items i JOIN products p ON p.id = i.product_id
           JOIN sales_orders o ON o.id = i.order_id
          WHERE i.supplier_id = $1 AND i.biz_mode = '联营' AND o.status = '已完成'
            AND o.created_at::date BETWEEN $2::date AND $3::date
          GROUP BY p.name ORDER BY amount DESC LIMIT 5`, [sid, f, t]);
      const unpaid = await cx(c,
        `SELECT COALESCE(SUM(payable_amount),0)::float8 AS amount, count(*)::int AS cnt
           FROM consign_recons WHERE supplier_id=$1 AND status NOT IN ('已结算','已作废')`, [sid]);
      return {
        ...agg, prevSales: prev.salesTotal, prevNet: prev.netSales,
        growth: prev.salesTotal > 0 ? Math.round((agg.salesTotal - prev.salesTotal) / prev.salesTotal * 100) / 100 : null,
        guaranteeProgress: agg.guaranteeSales && agg.guaranteeSales > 0
          ? Math.min(100, Math.round(agg.netSales / agg.guaranteeSales * 10000) / 100) : null,
        guaranteeGap: agg.guaranteeSales && agg.guaranteeSales > 0
          ? r2(Math.max(0, agg.guaranteeSales - agg.netSales)) : 0,
        topProducts: top.map((x: any) => ({ productName: x.product_name, qty: Number(x.qty), amount: Number(x.amount) })),
        unpaidAmount: Number(unpaid[0]?.amount ?? 0), unpaidCount: Number(unpaid[0]?.cnt ?? 0),
      };
    });
  }

  /** 联营对账预览（5.7.6 ①②③：销售汇总 + 扣点保底 + 费用，不写库；orders 可下钻小票） */
  @Get('consign/preview')
  async consignPreview(@Query('supplierId') supplierId: string, @Query('from') from?: string, @Query('to') to?: string) {
    const sid = Number(supplierId);
    if (!sid) throw new BizException(40003, 'supplierId 必填');
    const f = from || (today().slice(0, 4) + '-' + today().slice(4, 6) + '-01');
    const t = to || (today().slice(0, 4) + '-' + today().slice(4, 6) + '-' + today().slice(6, 8));
    return tx(async c => this.consignAgg(c, sid, f, t, true));
  }

  /** 生成联营对账单（5.7.6 ④）：吸收区间销售小票 + 快照扣点/保底/费用 */
  @RequirePerms('recon.confirm')
  @Post('consign-recon')
  async createConsignRecon(
    @Body() b: { supplierId: number; from: string; to: string; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.supplierId || !b.from || !b.to) throw new BizException(40003, 'supplierId / from / to 必填');
    return tx(async c => {
      const agg = await this.consignAgg(c, b.supplierId, b.from, b.to, true);
      if (!agg.orders.length) throw new BizException(50017, '该区间无可对账销售（或联营商品尚未产生销售）');
      const dup = await cx(c,
        `SELECT 1 FROM consign_recons
          WHERE supplier_id=$1 AND period_start=$2::date AND period_end=$3::date AND status <> '已作废' LIMIT 1`,
        [b.supplierId, b.from, b.to]);
      if (dup.length) throw new BizException(50018, '该供应商同区间已存在联营对账单（可作废后重建）');
      const ym = b.to.slice(0, 7).replace('-', '');
      const seq = await seqLock(c, 'consign_recons', 'recon_no', `LC-${ym}-%`);
      const no = `LC-${ym}-${String(seq[0].n).padStart(3, '0')}`;
      const ins = await cx(c,
        `INSERT INTO consign_recons (store_id, recon_no, supplier_id, period_start, period_end,
             sales_total, return_total, net_sales, deduction_rate, deduction_amount,
             guarantee_sales, guarantee_amount, fee_total, payable_amount, employee_id, remark)
         VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [no, b.supplierId, b.from, b.to, agg.salesTotal, agg.returnTotal, agg.netSales,
         agg.rate, agg.deductionAmount, agg.guaranteeSales, agg.guaranteeAmount, agg.feeTotal,
         agg.payable, user.sub, b.remark ?? null]);
      const rid = ins[0].id;
      for (const o of agg.orders) {
        await cx(c,
          `INSERT INTO consign_recon_items (recon_id, order_id, order_no, order_date, amount, qty)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [rid, o.id, o.order_no, o.order_date, o.amount, o.qty]);
      }
      await audit(curStore(), user.sub, '财务', 'consign.recon.create', 'consign_recon', rid,
        { no, sales: agg.salesTotal, net: agg.netSales, deduction: agg.deductionAmount, payable: agg.payable });
      return { id: rid, reconNo: no, salesTotal: agg.salesTotal, netSales: agg.netSales,
               deductionAmount: agg.deductionAmount, guaranteeAmount: agg.guaranteeAmount,
               feeTotal: agg.feeTotal, payable: agg.payable, orderCount: agg.orders.length };
    });
  }

  /** 联营对账单列表 */
  @Get('consign-recons')
  async consignRecons(@Query('supplierId') supplierId?: string) {
    return { items: await q(
      `SELECT r.*, s.name AS supplier_name,
              (SELECT count(*) FROM consign_recon_items i WHERE i.recon_id = r.id) AS item_count
         FROM consign_recons r JOIN suppliers s ON s.id = r.supplier_id
        WHERE ($1::bigint IS NULL OR r.supplier_id = $1::bigint)
        ORDER BY r.id DESC LIMIT 100`, [supplierId ? Number(supplierId) : null]) };
  }

  /** 联营对账单详情（可下钻到每一笔销售小票 5.7.6 ④） */
  @Get('consign-recons/:id')
  async consignReconDetail(@Param('id', ParseIntPipe) id: number) {
    const rec = await q1(
      `SELECT r.*, s.name AS supplier_name FROM consign_recons r JOIN suppliers s ON s.id = r.supplier_id
        WHERE r.id=$1`, [id]);
    if (!rec) throw new BizException(40404, '联营对账单不存在', 404);
    const items = await q(
      `SELECT cri.* FROM consign_recon_items cri WHERE cri.recon_id=$1 ORDER BY cri.id`, [id]);
    return { recon: rec, items };
  }

  /** 联营对账单确认（5.7.6 ⑤：现场确认/打印签字/口头确认 + 电子签字留痕） */
  @RequirePerms('recon.confirm')
  @Post('consign-recons/:id/confirm')
  async confirmConsignRecon(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { confirmType: string; confirmName?: string; signRecordId?: number; signImage?: string; templateId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.confirmType) throw new BizException(40003, 'confirmType 必填（现场确认/PDF打印签字/口头确认）');
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM consign_recons WHERE id=$1 FOR UPDATE`, [id]);
      const rec = rs[0];
      if (!rec) throw new BizException(40404, '联营对账单不存在', 404);
      if (rec.status !== '生成' && rec.status !== '待供应商确认') {
        throw new BizException(50018, `对账单状态(${rec.status})不允许确认`);
      }
      let signRecordId = b.signRecordId ?? null;
      if (b.signImage) {
        signRecordId = await this.saveSignature(c, user, {
          personName: b.confirmName || '对账业务员', image: b.signImage, templateId: b.templateId,
          bizType: '对账确认', bizId: id, scene: '现场补签',
        });
      } else if (b.templateId) {
        // 预采模板调用（5.6.8 ②）：选人即带出签字图，调用即落痕
        const tpl = await cx(c, `SELECT * FROM signature_templates WHERE id=$1 AND status=1`, [b.templateId]);
        if (!tpl.length) throw new BizException(40404, '签字模板不存在或已停用', 404);
        signRecordId = await this.saveSignature(c, user, {
          personName: tpl[0].person_name, image: tpl[0].image_path, templateId: Number(b.templateId),
          bizType: '对账确认', bizId: id, scene: '调用',
        });
      }
      await cx(c,
        `UPDATE consign_recons SET status='已确认', confirm_type=$2, confirm_name=$3, sign_record_id=$4, confirmed_at=now()
          WHERE id=$1`,
        [id, b.confirmType, b.confirmName ?? null, signRecordId]);
      await audit(curStore(), user.sub, '财务', 'consign.recon.confirm', 'consign_recon', id, { confirmType: b.confirmType });
      return { id, status: '已确认', signRecordId };
    });
  }

  /** 联营对账单作废（释放销售小票，可重建） */
  @RequirePerms('recon.confirm')
  @Post('consign-recons/:id/void')
  async voidConsignRecon(@Param('id', ParseIntPipe) id: number,
                         @Body() b: { reason?: string },
                         @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM consign_recons WHERE id=$1 FOR UPDATE`, [id]);
      const rec = rs[0];
      if (!rec) throw new BizException(40404, '联营对账单不存在', 404);
      if (rec.status !== '生成' && rec.status !== '待供应商确认') {
        throw new BizException(50018, `对账单状态(${rec.status})不允许作废`);
      }
      await cx(c, `DELETE FROM consign_recon_items WHERE recon_id=$1`, [id]);
      await cx(c, `UPDATE consign_recons SET status='已作废', remark = COALESCE(remark,'') || '；作废：' || $2 WHERE id=$1`,
        [id, b.reason ?? '人工作废']);
      await audit(curStore(), user.sub, '财务', 'consign.recon.void', 'consign_recon', id, { no: rec.recon_no });
      return { id, status: '已作废' };
    });
  }

  /** 联营对账结算（5.7.6 ⑥：标记已结算留痕；结算单打印走 A4 模板） */
  @RequirePerms('recon.settle.audit')
  @Post('consign-recons/:id/settle')
  async settleConsignRecon(@Param('id', ParseIntPipe) id: number,
                           @Body() b: { payMode?: string; remark?: string },
                           @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const rs = await cx(c, `SELECT * FROM consign_recons WHERE id=$1 FOR UPDATE`, [id]);
      const rec = rs[0];
      if (!rec) throw new BizException(40404, '联营对账单不存在', 404);
      if (rec.status !== '已确认') throw new BizException(50018, `对账单状态(${rec.status})必须先确认再结算`);
      await cx(c,
        `UPDATE consign_recons SET status='已结算', remark = COALESCE(remark,'') || '；结算：' || $2 WHERE id=$1`,
        [id, (b.payMode || '转账') + (b.remark ? ' ' + b.remark : '')]);
      await audit(curStore(), user.sub, '财务', 'consign.recon.settle', 'consign_recon', id,
        { no: rec.recon_no, amount: Number(rec.payable_amount), payMode: b.payMode || '转账' });
      return { id, status: '已结算' };
    });
  }

  // ═══ P2-3b 电子签字服务（5.6.8：预采集模板 + 调用记录证据链） ═══

  /** 签字模板列表（预采集样本：业务员到店免签；供应商业务员按供应商关联） */
  /** V4.9.5 操作员签字库：本人签字数量（入库保存后前端判断是否需要采集 ≥3 次） */
  @Get('signatures/operator')
  async operatorSignatures(@CurrentUser() user: AuthUser) {
    const r = await q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM signature_templates WHERE ref_employee_id=$1`, [user.sub]);
    return { count: Number(r!.n) };
  }

  @Get('signatures')
  async signatures(@Query('cat') cat?: string) {
    return { items: await q(
      `SELECT t.*, s.name AS supplier_name
         FROM signature_templates t
         LEFT JOIN suppliers s ON s.id = t.supplier_id
        WHERE ($1::text IS NULL OR t.person_cat = $1)
        ORDER BY t.id DESC LIMIT 100`, [cat || null]) };
  }

  /** 预采集签字模板（base64 存图，采集即授权 5.6.8 ①；supplierId 绑定供应商业务员 / refEmployeeId 绑定员工）
   *  V4.14.8 签字3：images 传 3 张（至少同时采集 3 次）→ 形成签字画像 profile；单张 image 旧调用兼容 */
  @Post('signatures')
  async createSignature(
    @Body() b: { personName?: string; roleTitle?: string; idCardTail?: string; image?: string; images?: string[]; supplierId?: number; refEmployeeId?: number; personCat?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const name = String(b.personName || '').trim();
    const images = (Array.isArray(b.images) ? b.images : []).filter(x => /^data:image\/(png|jpeg|jpg);base64,.+$/.test(String(x || '')));
    const image = String(b.image || '');
    if (!name || name.length > 32) throw new BizException(40003, '签字人姓名必填且 ≤32 字');
    if (images.length === 0 && !/^data:image\/(png|jpeg|jpg);base64,.+$/.test(image)) throw new BizException(40003, '签字图片必须为 base64 dataURL');
    if (images.length === 1) throw new BizException(40003, '签字画像需至少同时采集 3 次（请连续签名 3 遍）');
    const refEmp = Number(b.refEmployeeId) || null;
    if (refEmp) {
      const emp = await q1(`SELECT id, name FROM employees WHERE id=$1`, [refEmp]);
      if (!emp) throw new BizException(40404, '绑定的员工不存在', 404);
    }
    const shots = images.length ? images : [image];
    const paths = shots.map(s => saveBase64Image(s));
    // V4.17.0 P13：三源统一归并 —— 命中同一人（归一化姓名+分类+供应商）追加画像，不再无脑建重行；
    // 人员分类 personCatOf 收口（三不靠落「待确认」，界面可手动改）
    const tplId = await tx(async c => mergeSamples(c, {
      storeId: 1, personName: name, roleTitle: b.roleTitle ?? '业务员', imagePaths: paths,
      supplierId: b.supplierId ?? null, refEmployeeId: refEmp, collectedBy: user.sub,
      personCat: b.personCat || null,
    }));
    if (b.idCardTail != null && String(b.idCardTail) !== '') {
      await q1(`UPDATE signature_templates SET id_card_tail=$2 WHERE id=$1 AND COALESCE(id_card_tail,'')=''`, [tplId, String(b.idCardTail)]);
    }
    const row = await q1(`SELECT * FROM signature_templates WHERE id=$1`, [tplId]);
    await this.logSampleOp(user, row, '编辑·采集', `画像 ${paths.length} 遍${paths.length >= 3 ? '' : '（不足 3 遍）'}`, paths[0]);
    await audit(curStore(), user.sub, '财务', 'sign.template.create', 'signature_template', Number(tplId),
      { name, supplierId: b.supplierId ?? null, refEmployeeId: refEmp, samples: paths.length });
    return row;
  }

  /** 样本编辑操作留痕（V4.17.0：采集/重采/改分类/停用/启用/删除 → signature_records，biz_type='sample'）
   *  注意 template_id 置 NULL（删除样本后留痕不被 FK 拦），样本 id 存 biz_id；原因存 note */
  private async logSampleOp(user: AuthUser, tpl: any, scene: string, note: string, imagePath?: string | null) {
    if (!tpl) return;
    const hash = createHash('sha256')
      .update(`sample:${tpl.id}:${scene}:${note}:${Date.now()}`).digest('hex').slice(0, 64);
    await q(
      `INSERT INTO signature_records (store_id, template_id, biz_type, biz_id, doc_hash, scene, used_by, person_name, image_path, operator_name, note)
       VALUES (${curStore()},NULL,'sample',$1,$2,$3,$4,$5,$6,NULL,$7)`,
      [Number(tpl.id), hash, scene, user.sub, String(tpl.person_name || ''), imagePath ?? null, String(note || '').slice(0, 120)]);
  }

  /** V4.17.0 P13②：手动改人员分类（自动推断落「待确认」的纠错入口）；可一并改身份备注 */
  @Post('signatures/:id/cat')
  async setSignatureCat(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { personCat?: string; roleTitle?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const cat = String(b.personCat || '');
    if (!PERSON_CATS.includes(cat) || cat === '待确认') throw new BizException(40003, '人员分类须为 门店人员/供应商人员/大客户人员');
    const role = String(b.roleTitle ?? '').trim();
    const row = await q1(
      `UPDATE signature_templates SET person_cat=$2,
        role_title = CASE WHEN $3<>'' THEN $3 ELSE role_title END
       WHERE id=$1 RETURNING id, person_name, person_cat, role_title`, [id, cat, role]);
    if (!row) throw new BizException(40404, '签字样本不存在', 404);
    await this.logSampleOp(user, row, '编辑·改分类', `→ ${cat}${role ? ` · ${role}` : ''}`);
    await audit(curStore(), user.sub, '财务', 'sign.template.cat', 'signature_template', id, { personCat: cat, roleTitle: role });
    return row;
  }

  /** V4.17.0 P13④：重采 —— 三连采整体替换该人画像（清理占位/乱签样本的主通道） */
  @Post('signatures/:id/recapture')
  async recaptureSignature(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { images?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    const images = (Array.isArray(b.images) ? b.images : []).filter(x => /^data:image\/(png|jpeg|jpg);base64,.+$/.test(String(x || '')));
    if (images.length < 3) throw new BizException(40003, '重采须连续签名 3 遍（整体替换原画像）');
    const old = await q1(`SELECT * FROM signature_templates WHERE id=$1`, [id]);
    if (!old) throw new BizException(40404, '签字样本不存在', 404);
    const paths = images.map(s => saveBase64Image(s));
    await tx(async c => mergeSamples(c, {
      storeId: Number(old.store_id) || 1, personName: String(old.person_name),
      roleTitle: String(old.role_title || ''), imagePaths: paths,
      supplierId: old.supplier_id ?? null, refEmployeeId: old.ref_employee_id ?? null,
      collectedBy: user.sub, replace: true, personCat: String(old.person_cat || '') || null,
    }));
    await this.logSampleOp(user, old, '编辑·重采', `整体替换画像 ${paths.length} 遍`);
    await audit(curStore(), user.sub, '财务', 'sign.template.recapture', 'signature_template', id, { samples: paths.length });
    return { ok: true };
  }

  /** V4.14.8 签字4：删除签字样本（无用/离职人员；V4.17.0 支持原因留痕） */
  @Delete('signatures/:id')
  async deleteSignature(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const old = await q1(`SELECT id, person_name FROM signature_templates WHERE id=$1`, [id]);
    if (!old) throw new BizException(40404, '签字样本不存在', 404);
    await q1(`DELETE FROM signature_templates WHERE id=$1 RETURNING id`, [id]);
    await this.logSampleOp(user, old, '编辑·删除', String(b?.reason || '').trim() || '单条删除');
    return { ok: true };
  }

  /** V4.14.8 签字4：批量管理（复选框）——action: delete | disable | enable
   *  V4.17.0：删除/停用必须说明原因（离职/调岗等），写入操作留痕 */
  @Post('signatures/batch')
  async batchSignatures(
    @Body() b: { ids?: number[]; action?: string; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => n > 0);
    if (!ids.length) throw new BizException(40003, '请先勾选签字样本');
    const needReason = b.action === 'delete' || b.action === 'disable';
    const reason = String(b.reason || '').trim();
    if (needReason && !reason) throw new BizException(40003, `${b.action === 'delete' ? '删除' : '停用'}签字样本须说明原因（如：离职、调岗）`);
    if (needReason && reason.length > 64) throw new BizException(40003, '原因不超过 64 字');
    if (b.action === 'delete') {
      // V5.0.18g 修复：模板被调用记录（signature_records.template_id FK）引用时直接删除会外键违规
      //（40010「关联数据不存在或已被删除」）。调用记录是历史证据链（自带签名图/人名，不依赖模板），
      // 删除模板前把引用置空即可安全删除。
      return tx(async c => {
        const old = await cx(c, `SELECT id, person_name FROM signature_templates WHERE id = ANY($1::bigint[])`, [ids]);
        const cleared = await cx(c, `UPDATE signature_records SET template_id=NULL WHERE template_id = ANY($1::bigint[]) RETURNING id`, [ids]);
        const r = await cx(c, `DELETE FROM signature_templates WHERE id = ANY($1::bigint[]) RETURNING id`, [ids]);
        for (const t of old.filter(x => r.some(y => Number(y.id) === Number(x.id)))) {
          await this.logSampleOp(user, t, '编辑·删除', reason || '批量删除');
        }
        return { ok: true, affected: r.length, recordsCleared: cleared.length };
      });
    }
    if (b.action === 'disable' || b.action === 'enable') {
      const st = b.action === 'enable' ? 1 : 0;
      const old = await q(`SELECT id, person_name FROM signature_templates WHERE id = ANY($1::bigint[])`, [ids]);
      const r = await q(`UPDATE signature_templates SET status=$2 WHERE id = ANY($1::bigint[]) RETURNING id`, [ids, st]);
      for (const t of old.filter(x => r.some(y => Number(y.id) === Number(x.id)))) {
        await this.logSampleOp(user, t, st === 1 ? '编辑·启用' : '编辑·停用', st === 1 ? '' : reason);
      }
      return { ok: true, affected: r.length };
    }
    throw new BizException(40003, 'action 仅支持 delete/disable/enable');
  }

  /** 签字模板停用/启用（V4.17.0：停用必须说明原因，写入操作留痕） */
  @Post('signatures/:id/status')
  async setSignatureStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { status: number; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const st = Number(b.status) === 1 ? 1 : 0;
    const reason = String(b.reason || '').trim();
    if (st === 0 && !reason) throw new BizException(40003, '停用签字样本须说明原因（如：离职、调岗）');
    if (st === 0 && reason.length > 64) throw new BizException(40003, '原因不超过 64 字');
    const r = await q1(`UPDATE signature_templates SET status=$2 WHERE id=$1 RETURNING id, person_name`, [id, st]);
    if (!r) throw new BizException(40404, '签字模板不存在', 404);
    await this.logSampleOp(user, r, st === 1 ? '编辑·启用' : '编辑·停用', st === 1 ? '' : reason);
    return { ok: true };
  }

  /** 现场签名关联（M3b：无预采模板时手机屏幕手写 → 证据链直存 + 回填单据 sign_record_id；P3-2 支持盘点） */
  @Post('signatures/attach')
  async attachSign(
    @Body() b: { bizType: string; bizId: number; personName: string; roleTitle?: string; image: string },
    @CurrentUser() user: AuthUser,
  ) {
    const bizType = String(b.bizType || '');
    if (!['inbound', 'return', 'loss', 'count', 'transfer', 'stocktake'].includes(bizType)) {
      throw new BizException(40003, 'bizType 仅支持 inbound/return/loss/count/transfer/stocktake');
    }
    const name = String(b.personName || '').trim();
    if (!name || name.length > 32) throw new BizException(40003, '签字人姓名必填且 ≤32 字');
    if (!/^data:image\/(png|jpeg|jpg);base64,.+$/.test(String(b.image || ''))) throw new BizException(40003, '签字图片必须为 base64 dataURL');
    const bizId = Number(b.bizId);
    if (!(bizId > 0)) throw new BizException(40003, 'bizId 必填');
    return tx(async c => {
      // 单据存在性 + 状态校验（审核通过后不可补签）
      const table = bizType === 'inbound' ? 'inbound_orders' : bizType === 'return' ? 'purchase_returns'
        : bizType === 'loss' ? 'loss_records' : bizType === 'transfer' ? 'stock_transfers'
        : bizType === 'stocktake' ? 'stocktake_tasks' : 'inventory_counts';
      const rows = await cx(c, `SELECT * FROM ${table} WHERE id=$1`, [bizId]);
      if (!rows.length) throw new BizException(40404, '单据不存在', 404);
      const doc = rows[0];
      const okSt = bizType === 'inbound' ? ['未审核', '草稿'] : bizType === 'return' ? ['待审核', '未审核']
        : bizType === 'loss' ? ['待审核'] : bizType === 'transfer' ? ['待确认']
        : bizType === 'stocktake' ? ['待执行', '执行中', '待审核'] : ['进行中'];
      if (!okSt.includes(String(doc.status))) throw new BizException(50010, `单据状态(${doc.status})不允许补签`);

      // ── V4.14.8 签字2：完整性甄别（防假签/乱签/冒签）──
      // 期望姓名：入库/退货 = 供应商常驻业务员（suppliers.contact_person）；其余 = 操作店员本人
      const supplierId = Number(doc.supplier_id) || null;
      let expected = '';
      if (supplierId) {
        const sup = await cx(c, `SELECT name, contact_person FROM suppliers WHERE id=$1`, [supplierId]);
        expected = String(sup[0]?.contact_person || '');
      }
      if (!expected) {
        const op = await cx(c, `SELECT name FROM employees WHERE id=$1`, [user.sub]);
        expected = String(op[0]?.name || '');
      }
      if (!nameMatches(expected, name)) {
        throw new BizException(50071,
          `签字姓名「${name}」与单据署名「${expected}」不符，疑似冒签/乱签，已拒绝（请本人完整签署姓名）`);
      }

      const sign = await attachSignature(c, {
        storeId: 1, bizType, bizId,
        summary: String(doc.inbound_no || doc.return_no || doc.loss_no || doc.count_no || bizId),
        usedBy: user.sub, personName: name, roleTitle: b.roleTitle, image: b.image,
      });
      await cx(c, `UPDATE ${table} SET sign_record_id=$2 WHERE id=$1`, [bizId, sign.recordId]);

      // ── V4.14.8 签字1：自动采集进样本库（保证业务员/店员样本不缺）──
      // 供应商侧：关联该供应商建档/追加画像；非供应商侧：不绑供应商，按员工采集店员样本
      const imagePath = String((sign as any).imagePath || '');
      if (imagePath) {
        await collectIntoTemplates(c, {
          storeId: 1, personName: name,
          roleTitle: supplierId ? (b.roleTitle || '业务员') : (b.roleTitle || '店员'),
          imagePath,
          supplierId,                      // 非供应商侧为 null → 跳过供应商关联
          refEmployeeId: supplierId ? null : user.sub,
          collectedBy: user.sub,
        });
      }
      return sign;
    });
  }

  /** 大额·短信确认码校验（5.6.8③）：被签字人输入 6 位确认码 → sms_confirmed=true 留痕 */
  @Post('signatures/confirm')
  async confirmSign(
    @Body() b: { bizType: string; bizId: number; code: string },
    @CurrentUser() user: AuthUser,
  ) {
    const bizType = String(b.bizType || '');
    const bizId = Number(b.bizId);
    if (!(bizId > 0)) throw new BizException(40003, 'bizId 必填');
    const code = String(b.code || '').trim();
    if (!/^\d{6}$/.test(code)) throw new BizException(40003, '确认码为 6 位数字');
    // 错误次数（sms_try）须落库留痕，不能用事务包裹（抛错会回滚计数，3 次上限失效）
    const r = await confirmSignature(pool, { bizType, bizId, code });
    if (!r.ok) throw new BizException(50019, r.err || '确认失败');
    await audit(curStore(), user.sub, '财务', 'sign.confirm', 'signature_record', undefined,
      { bizType, bizId, code: '******' });
    return { ok: true };
  }

  /** 签字调用记录（证据链：模板/现场补签 + 单据哈希 + 调用人；V4.15.0 附角色标签 操作员/业务员 + 人员分类） */
  @Get('signature-records')
  async signatureRecords(@Query('bizType') bizType?: string, @Query('bizId') bizId?: string) {
    return { items: await q(
      `SELECT r.*, e.name AS used_by_name, t.person_cat,
              (CASE WHEN r.scene LIKE '编辑%' THEN '管理'
                    WHEN r.scene = '操作员签名'
                     OR regexp_replace(COALESCE(r.person_name,''), '\s', '', 'g') = regexp_replace(COALESCE(r.operator_name,''), '\s', '', 'g')
                    THEN '操作员' ELSE '业务员' END) AS role_label
         FROM signature_records r
         LEFT JOIN employees e ON e.id = r.used_by
         LEFT JOIN signature_templates t ON t.id = r.template_id
        WHERE ($1 = '' OR r.biz_type = $1) AND ($2::bigint IS NULL OR r.biz_id = $2)
        ORDER BY r.id DESC LIMIT 100`, [bizType || '', bizId ? Number(bizId) : null]) };
  }

  /** 现场签字落证据链（5.6.8：现场补签直存 + 内容哈希防篡改） */
  private async saveSignature(c: any, user: AuthUser, p: {
    personName: string; image: string; templateId?: number;
    bizType: string; bizId: number; scene?: string; operatorName?: string;
  }): Promise<number> {
    // 模板调用沿用已落盘图片路径；现场手写 base64 需先落盘
    const imagePath = p.image.startsWith('/') ? p.image : saveBase64Image(p.image);
    const hash = createHash('sha256')
      .update(`${p.bizType}:${p.bizId}:${p.personName}:${Date.now()}`).digest('hex').slice(0, 64);
    const row = await cx(c,
      `INSERT INTO signature_records (store_id, template_id, biz_type, biz_id, doc_hash, scene, used_by, person_name, image_path, operator_name)
       VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.templateId ?? null, p.bizType, p.bizId, hash, p.scene ?? '调用', user.sub,
       p.personName, imagePath, p.operatorName ?? null]);
    return Number(row[0].id);
  }
}

/** 往来账：借=应付增加 / 贷=应付减少；balance_after 顺序快照 */
async function writeLedger(c: any, storeId: number, supplierId: number, bizType: string,
                           bizId: number, bizNo: string, debit: number, credit: number, docDate: string) {
  const last = await cx(c,
    `SELECT balance_after FROM supplier_ledger WHERE supplier_id=$1 ORDER BY id DESC LIMIT 1`, [supplierId]);
  const base = last.length ? Number(last[0].balance_after) : 0;
  await cx(c,
    `INSERT INTO supplier_ledger (store_id, supplier_id, biz_type, biz_id, biz_no, debit, credit, balance_after, doc_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [storeId, supplierId, bizType, bizId, bizNo, r2(debit), r2(credit), r2(base + debit - credit), docDate]);
}

/** from~to 覆盖的月份列表（YYYY-MM） */
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** pg DATE 列返回 Date 对象（本地零点），统一转 YYYY-MM-DD 字符串 */
function pgDateStr(v: any): string {
  if (v instanceof Date) {
    // Date 为本地时区零点，必须按本地字段格式化（toISOString 会回退一天）
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  }
  return String(v).slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 签字 base64 图片落盘 → /signatures/ 静态路径（见 sign.ts saveBase64Image，5.6.8） */

@Module({ controllers: [PurchaseController] })
export class PurchaseModule {}
