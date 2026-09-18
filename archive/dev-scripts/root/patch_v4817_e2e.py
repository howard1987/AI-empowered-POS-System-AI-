# -*- coding: utf-8 -*-
"""V4.8.17 e2e 补丁：X 段组合拆分断言（汇总前插入）"""
import io

P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-初版代码/backend/tests/e2e.mjs"
src = io.open(P, encoding="utf-8").read()

assert "X1" not in src or "组合" not in src.split("汇总")[0][-2000:], "可能已应用"

ANCHOR = """  // ═══ 汇总 ═══"""

NEW = """  // ═══ X. 组合拆分（组装 ZZ-/拆分 CF-，FIFO 成本守恒，db/014 V4.8.17） ═══
  console.log('■ X. 组合拆分');
  const xSid = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'X段组合供应商', bizMode: '购销' } }));
  const xa = data(await api('POST', '/products', { token: T, body: { name: 'X段纯牛奶250ml', base_unit: '盒', sellPrice: 4, barcode: '6901230000087', keepDays: 90, minStock: 0 } }));
  const xb = data(await api('POST', '/products', { token: T, body: { name: 'X段抽取式纸巾', base_unit: '包', sellPrice: 3, barcode: '6901230000094', keepDays: 730, minStock: 0 } }));
  const bp = data(await api('POST', '/products', { token: T, body: { name: 'X段家庭早餐组合', base_unit: '套', sellPrice: 8, barcode: '6901230000100', keepDays: 60, minStock: 0 } }));
  ok(Number(xa?.id) > 0 && Number(xb?.id) > 0 && Number(bp?.id) > 0, 'X1 建组合商品与子商品');
  // 子商品入库（纸巾两批不同价，验证 FIFO 混合）
  const xi1 = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: xSid.id, items: [
    { productId: xa.id, qty: 10, unitCost: 2.5, productionDate: '2026-09-01' },
    { productId: xb.id, qty: 20, unitCost: 1.5, productionDate: '2026-09-01' } ] } }));
  const xi2 = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: xSid.id, items: [
    { productId: xb.id, qty: 10, unitCost: 2, productionDate: '2026-09-02' } ] } }));
  await api('POST', `/purchase/inbounds/${xi1.id}/audit`, { token: T });
  await api('POST', `/purchase/inbounds/${xi2.id}/audit`, { token: T });
  // 组合档案与校验
  eq((await api('POST', '/bundles', { token: T, body: { bundleProductId: bp.id, items: [] } })).code, 40003, 'X2 空明细 → 40003');
  eq((await api('POST', '/bundles', { token: T, body: { bundleProductId: bp.id, items: [{ productId: bp.id, qty: 1 }] } })).code, 40003, 'X2 子商品=组合本身 → 40003');
  const xBd = data(await api('POST', '/bundles', { token: T, body: {
    bundleProductId: bp.id, items: [{ productId: xa.id, qty: 1 }, { productId: xb.id, qty: 2 }] } }));
  ok(Number(xBd?.id) > 0, 'X2 组合档案已建（1 牛奶 + 2 纸巾）');
  eq((await api('POST', '/bundles', { token: T, body: { bundleProductId: bp.id, items: [{ productId: xa.id, qty: 1 }] } })).code, 40003, 'X3 重复定义 → 40003');
  const xBl = data(await api('GET', '/bundles', { token: T }));
  const xBdRow = (xBl.items || []).find(b => Number(b.bundle_product_id) === Number(bp.id));
  eq(xBdRow?.items?.length, 2, 'X3 列表含 BOM 明细 2 行');
  // 组装 5 份：牛奶 5@2.5 + 纸巾 10@1.5（第一批）= 27.5 → 组合批次 5 件 @5.5
  eq((await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 0 } })).code, 40003, 'X4 组装份数 0 → 40003');
  eq((await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: 999999, qty: 1 } })).code, 40404, 'X4 组合未定义 → 40404');
  const xZa = data(await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 5, remark: 'X段节前组装' } }));
  ok(/^ZZ-\\d{6}-\\d{3}$/.test(xZa?.opNo || ''), 'X5 组装单号 ZZ-YYYYMM-XXX');
  near(xZa?.totalCost, 27.5, 'X5 组装成本 = 5×2.5 + 10×1.5 = 27.5');
  near(xZa?.unitCost, 5.5, 'X5 组合单位成本 5.5');
  const xInv1 = await sqlOnly(`SELECT product_id, qty_total FROM inventory_current WHERE product_id = ANY($1) ORDER BY product_id`, [[xa.id, xb.id, bp.id]]);
  const xInvMap = Object.fromEntries(xInv1.rows.map(r => [Number(r.product_id), Number(r.qty_total)]));
  eq(xInvMap[Number(xa.id)], 5, 'X6 牛奶库存 10-5=5');
  eq(xInvMap[Number(xb.id)], 20, 'X6 纸巾库存 30-10=20（FIFO 全扣第一批）');
  eq(xInvMap[Number(bp.id)], 5, 'X6 组合库存 +5');
  const xBb1 = await sqlOnly(`SELECT inbound_cost, remain_qty FROM batches WHERE product_id=$1 AND batch_no LIKE 'ZZ-%' ORDER BY id`, [bp.id]);
  near(xBb1.rows[0]?.inbound_cost, 5.5, 'X6 组合批次单位成本 5.5（守恒）');
  eq(Number(xBb1.rows[0]?.remain_qty), 5, 'X6 组合批次剩余 5');
  eq((await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 999 } })).code, 50001, 'X7 子商品库存不足 → 50001');
  // 卖组合：现有收银 FIFO 自动支持（组合批次可售）
  const xSale = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: bp.id, qty: 2 }], payments: [{ channel: '现金', amount: 16 }] } }));
  near(xSale?.payable, 16, 'X8 销售组合 2 份 × 8 = 16');
  near(xSale?.costTotal, 11, 'X8 组合销售成本 = 2×5.5（FIFO 扣组合批次）');
  const xBb1b = await sqlOnly(`SELECT remain_qty FROM batches WHERE product_id=$1 AND batch_no LIKE 'ZZ-%' ORDER BY id`, [bp.id]);
  eq(Number(xBb1b.rows[0]?.remain_qty), 3, 'X8 组合批次剩余 3');
  // 拆分 2 份：消耗组合批次 2@5.5=11 → 子批次 u = 5.5/(1+2)=1.8333（Σ成本守恒 11）
  const xCf = data(await api('POST', '/bundles/split', { token: T, body: { bundleProductId: bp.id, qty: 2, remark: 'X段拆分散卖' } }));
  ok(/^CF-\\d{6}-\\d{3}$/.test(xCf?.opNo || ''), 'X9 拆分单号 CF-YYYYMM-XXX');
  near(xCf?.totalCost, 11, 'X9 拆分总成本 = 2×5.5 = 11');
  const xInv2 = await sqlOnly(`SELECT product_id, qty_total FROM inventory_current WHERE product_id = ANY($1) ORDER BY product_id`, [[xa.id, xb.id, bp.id]]);
  const xInvMap2 = Object.fromEntries(xInv2.rows.map(r => [Number(r.product_id), Number(r.qty_total)]));
  eq(xInvMap2[Number(bp.id)], 1, 'X10 组合库存 3-2=1');
  eq(xInvMap2[Number(xa.id)], 7, 'X10 牛奶回加 5+2=7');
  eq(xInvMap2[Number(xb.id)], 24, 'X10 纸巾回加 20+4=24');
  const xSum = await sqlOnly(
    `SELECT SUM(cost_total) AS s FROM bundle_op_items WHERE op_id=$1`, [xCf.id]);
  near(Number(xSum.rows[0]?.s), 11, 'X10 拆分明细成本合计守恒 11');
  // 二次组装：纸巾 FIFO 继续扣第一批（剩 10@1.5）→ 2 份成本 = 2×2.5 + 4×1.5 = 11
  const xZa2 = data(await api('POST', '/bundles/assemble', { token: T, body: { bundleProductId: bp.id, qty: 2 } }));
  near(xZa2?.totalCost, 11, 'X11 二次组装跨批次 FIFO = 2×2.5 + 4×1.5 = 11');
  // 单据浏览与类型过滤
  const xOps = data(await api('GET', '/bundles/ops?type=assemble', { token: T }));
  ok((xOps.items || xOps || []).every(o => o.op_type === 'assemble') && (xOps.items || xOps || []).length >= 2, 'X12 组装单列表含 2 张 ZZ');
  const xOpsAll = data(await api('GET', '/bundles/ops', { token: T }));
  ok((xOpsAll.items || xOpsAll || []).some(o => o.op_no === xCf.opNo && o.bundle_name === 'X段家庭早餐组合'), 'X12 浏览列表含拆分单与组合名');

  // ═══ 汇总 ═══"""

assert ANCHOR in src, "锚点未命中：汇总段不存在"
src = src.replace(ANCHOR, NEW, 1)
io.open(P, "w", encoding="utf-8", newline="\n").write(src)

chk = io.open(P, encoding="utf-8").read()
for token in ["X12 浏览列表含拆分单与组合名", "bundles/assemble", "bundle_op_items"]:
    assert token in chk, f"校验失败：{token}"
print("OK: e2e X 段已写入")
