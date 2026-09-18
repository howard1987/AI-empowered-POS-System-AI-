# -*- coding: utf-8 -*-
# V4.8.11 e2e：V 段（对账结算全链路：费用协议 API 化 + 人工费用 + 结算闭环）
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend', 'tests', 'e2e.mjs')
s = io.open(P, encoding='utf-8').read()

OLD = """  // ═══ 汇总 ═══
  console.log('\\n══════════════════════════════');"""

NEW = """  // ═══ V. 对账结算全链路（费用协议 API 化 + 人工费用 + 结算闭环，V4.8.11） ═══
  console.log('■ V. 对账结算全链路（费用协议 API）');
  const vTypes = data(await api('GET', '/purchase/fee-types', { token: T }));
  ok(Array.isArray(vTypes) && vTypes.length >= 6 && vTypes.some(t => t.code === 'rebate' && t.direction === '收'),
     'V1 费用类型字典 ≥6 类（db/011 种子）');
  const vSup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'V段联调供应商', bizMode: '购销' } }));
  ok(Number(vSup?.id) > 0, 'V2 新建联调供应商');
  // V3 协议校验与创建
  eq((await api('POST', '/purchase/fee-agreements', { token: T, body: { supplierId: vSup.id, feeTypeId: 1 } })).code, 40003,
     'V3 协议缺 startDate → 40003');
  eq((await api('POST', '/purchase/fee-agreements', { token: T, body: { supplierId: vSup.id, feeTypeId: 1, startDate: '2026-08-01' } })).code, 40003,
     '固定额协议缺金额 → 40003');
  eq((await api('POST', '/purchase/fee-agreements', { token: T, body: { supplierId: vSup.id, feeTypeId: 999999, amount: 10, startDate: '2026-08-01' } })).code, 40404,
     '费用类型不存在 → 40404');
  const vAg = data(await api('POST', '/purchase/fee-agreements', { token: T, body: {
    supplierId: vSup.id, feeTypeId: vTypes.find(t => t.code === 'rebate').id,
    cycle: '月', amountMode: '固定额', amount: 10, autoGenerate: true, startDate: '2026-08-01' } }));
  eq(vAg?.status, 1, 'V3 创建返利协议（月·固定额10·自动补齐）');
  const vAgList = data(await api('GET', `/purchase/fee-agreements?supplierId=${vSup.id}`, { token: T }));
  ok(vAgList?.items?.some(a => a.fee_type_name === '销售返利' && a.auto_generate), 'V4 协议列表含类型名与自动补齐标记');
  // V5 人工费用
  eq((await api('POST', '/purchase/fees', { token: T, body: {
    supplierId: vSup.id, feeTypeId: vTypes.find(t => t.code === 'diff').id, amount: 0 } })).code, 40003,
     'V5 人工费用金额 0 → 40003');
  const vFee = data(await api('POST', '/purchase/fees', { token: T, body: {
    supplierId: vSup.id, feeTypeId: vTypes.find(t => t.code === 'diff').id, amount: 5, remark: 'V段人工补差' } }));
  ok(String(vFee?.fee_no || '').startsWith('FY-M') && vFee?.status === '已审核', '人工费用录入即生效（FY-M 单号）');
  // V6 入库 30（10×3）
  const vInb = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: vSup.id, items: [
    { productId: pb.id, qty: 10, unitCost: 3, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${vInb.id}/audit`, { token: T });
  // V7 预览（协议补齐发生在生成对账时，预览不含）
  const vPv = data(await api('GET', `/purchase/recon/preview?supplierId=${vSup.id}&from=2026-08-01&to=2026-09-05`, { token: T }));
  near(vPv?.payableTotal, 35, 'V7 预览应付 35 = 入库30 + 补差5（未含补齐）');
  eq(vPv?.fees?.length, 1, '预览仅人工费用 1 笔');
  // V8 生成对账单（自动补齐 2 期）
  const vRec = data(await api('POST', '/purchase/recon', { token: T, body: { supplierId: vSup.id, from: '2026-08-01', to: '2026-09-05' } }));
  eq(vRec?.autoFees?.length, 2, 'V8 漏记期次自动补齐 2 笔（8月整月+9月partial）');
  near(vRec?.payableTotal, 15, '对账应付 15 = 30 + 5 − 返利20');
  // V9 未确认先结算
  eq((await api('POST', '/purchase/settlements', { token: T, body: { reconId: vRec.id } })).code, 50019, 'V9 未确认结算 → 50019');
  eq(data(await api('POST', `/purchase/recon/${vRec.id}/confirm`, { token: T, body: { confirmType: '现场确认', confirmName: 'V业务' } }))?.status,
     '已确认', 'V10 现场确认');
  const vSt = data(await api('POST', '/purchase/settlements', { token: T, body: { reconId: vRec.id, payMode: '转账' } }));
  near(vSt?.amount, 15, 'V11 结算单金额 15');
  eq(data(await api('POST', `/purchase/settlements/${vSt.id}/audit`, { token: T }))?.status, '已审核', 'V12 结算审核');
  const vLed = await sqlOnly(`SELECT balance_after FROM supplier_ledger WHERE supplier_id=$1 ORDER BY id`, [vSup.id]);
  near(vLed.rows[vLed.rows.length - 1].balance_after, 0, 'V13 往来账闭环：结算后余额归零');
  eq((await api('POST', '/purchase/settlements', { token: T, body: { reconId: vRec.id } })).code, 50019, 'V14 重复结算 → 50019');

  // ═══ 汇总 ═══
  console.log('\\n══════════════════════════════');"""

assert s.count(OLD) == 1, f'锚点不唯一: {s.count(OLD)}'
s = s.replace(OLD, NEW)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('E2E V PATCH DONE')
