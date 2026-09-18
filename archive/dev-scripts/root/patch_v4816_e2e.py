# -*- coding: utf-8 -*-
"""V4.8.16 e2e 补丁：W 段追加进价调价断言（在汇总段之前插入 W8+）"""
import io

P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-初版代码/backend/tests/e2e.mjs"
src = io.open(P, encoding="utf-8").read()

assert "W8" not in src, "补丁已应用，勿重复执行"

ANCHOR = """  const wUser2 = data(await api('POST', '/auth/login', { body: { empNo: 'ADMIN', password: 'admin123' } }));
  ok(Boolean(wUser2?.token), 'W7 管理员具备 pos.price.manual（ADMIN 全量权限）');
"""

NEW = ANCHOR + """
  // ── W8+ 进价调价（V4.8.16：priceType=cost，落地供应商进价基线=调价通知） ──
  const wSup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'W段进价调价供应商', bizMode: '购销' } }));
  ok(Number(wSup?.id) > 0, 'W8 建进价调价供应商');
  const wP3 = data(await api('POST', '/products', { token: T, body: { name: 'W段牛奶250ml', base_unit: '盒', sellPrice: 4, barcode: '6901230000056', keepDays: 90, minStock: 5, supplierDefaultId: wSup.id } }));
  ok(Number(wP3?.id) > 0, 'W8 建带默认供应商商品');
  // 无 supplierId 且商品未设默认供应商 → 40003
  eq((await api('POST', '/price-changes', { token: T, body: { priceType: 'cost', items: [{ productId: wP1.id, newPrice: 2 }] } })).code, 40003, 'W9 进价调价未设默认供应商 → 40003');
  // 正常进价调价（无历史基线，旧价记 0）
  const wCc = data(await api('POST', '/price-changes', { token: T, body: {
    priceType: 'cost', items: [{ productId: wP3.id, newPrice: 2.8 }, { productId: wP1.id, newPrice: 1.9, supplierId: wSup.id }],
    effectiveDate: '2026-09-05', remark: 'W段供应商调价通知' } }));
  ok(/^JC-\\d{6}-\\d{3}$/.test(wCc?.pcNo || ''), 'W10 进价调价单号 JC-YYYYMM-XXX');
  eq(wCc?.priceType, 'cost', 'W10 返回 priceType=cost');
  near(wCc?.diffTotal, 2.8 + 1.9, 'W10 差额 = 新价合计（无基线旧价记 0）');
  // 售价不受进价调价影响 + 基线已落地 supplier_product_prices
  const wList2 = data(await api('GET', '/products?size=200', { token: T }));
  const wN3 = (wList2.items || wList2 || []).find(p => Number(p.id) === Number(wP3.id));
  near(wN3?.sell_price, 4, 'W11 进价调价不改售价（牛奶仍 4）');
  const wBase = await sqlOnly(
    `SELECT price, min_price, source_doc FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
    [wP3.id, wSup.id]);
  near(wBase.rows[0]?.price, 2.8, 'W11 进价基线已落地 2.8');
  near(wBase.rows[0]?.min_price, 2.8, 'W11 min_price 刷新 2.8');
  eq(String(wBase.rows[0]?.source_doc || '').startsWith('JC-'), true, 'W11 source_doc 关联 JC 单号');
  // 二次进价下调 → min_price 同步刷新（最低价保护线 V4.3.6）
  const wCc2 = data(await api('POST', '/price-changes', { token: T, body: {
    priceType: 'cost', items: [{ productId: wP3.id, newPrice: 2.5 }], remark: 'W段进价下调' } }));
  ok(/^JC-/.test(wCc2?.pcNo || ''), 'W12 二次进价调价 JC- 单号');
  const wBase2 = await sqlOnly(
    `SELECT price, min_price FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
    [wP3.id, wSup.id]);
  near(wBase2.rows[0]?.price, 2.5, 'W12 新基线 2.5');
  near(wBase2.rows[0]?.min_price, 2.5, 'W12 进价下调刷新最低价保护线 2.5');
  // 相同进价 → 40003
  eq((await api('POST', '/price-changes', { token: T, body: { priceType: 'cost', items: [{ productId: wP3.id, newPrice: 2.5 }] } })).code, 40003, 'W13 新进价=现进价 → 40003');
  // 详情：price_type + 供应商名 + 留痕
  const wCDet = data(await api('GET', `/price-changes/${wCc.id}`, { token: T }));
  eq(wCDet?.price_type, 'cost', 'W14 详情 price_type=cost');
  near(wCDet.items.find(i => Number(i.product_id) === Number(wP3.id))?.old_price, 0, 'W14 无历史旧进价留痕 0');
  eq(wCDet.items.every(i => i.supplier_name === 'W段进价调价供应商'), true, 'W14 明细含供应商名');
  // 列表：类型过滤
  const wCostList = data(await api('GET', '/price-changes?type=cost', { token: T }));
  ok((wCostList.items || wCostList || []).every(c => c.price_type === 'cost'), 'W15 type=cost 过滤仅进价单');
  ok((wCostList.items || wCostList || []).some(c => Number(c.id) === Number(wCc.id)), 'W15 列表含新进价调价单');
  const wSaleList = data(await api('GET', '/price-changes?type=sale', { token: T }));
  ok((wSaleList.items || wSaleList || []).some(c => Number(c.id) === Number(wPc.id)), 'W15 type=sale 含 W3 售价单');
"""

assert ANCHOR in src, "锚点未命中：W7 段原文不匹配"
src = src.replace(ANCHOR, NEW, 1)
io.open(P, "w", encoding="utf-8", newline="\n").write(src)

chk = io.open(P, encoding="utf-8").read()
for token in ["W15 列表含新进价调价单", "priceType: 'cost'", "min_price", "cost-base" if False else "supplier_name"]:
    assert token in chk, f"校验失败：{token} 未写入磁盘"
print("OK: e2e 补丁已写入并校验通过")
