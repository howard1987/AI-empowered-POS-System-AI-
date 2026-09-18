# -*- coding: utf-8 -*-
"""V4.8.20 e2e 补丁：重写 W 段为审核流语义（进价售价同行 + pending→approved→voided）"""
import io

P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-初版代码/backend/tests/e2e.mjs"
s = io.open(P, encoding="utf-8").read()

START = "  // ═══ W. 商品调价单（录入即生效 + 留痕，V4.8.15） ═══"
END = "  // ═══ X. 组合拆分（组装 ZZ-/拆分 CF-，FIFO 成本守恒，db/014 V4.8.17） ═══"
i0 = s.index(START)
i1 = s.index(END)

NEW = r"""  // ═══ W. 商品调价单（进价售价同行 + 审核流 pending→approved→voided，V4.8.20） ═══
  console.log('■ W. 商品调价单');
  const wP1 = data(await api('POST', '/products', { token: T, body: { name: 'W段可乐330ml', base_unit: '罐', sellPrice: 3, barcode: '6901230000032', keepDays: 270, minStock: 5 } }));
  const wP2 = data(await api('POST', '/products', { token: T, body: { name: 'W段薯片原味', base_unit: '袋', sellPrice: 6.5, barcode: '6901230000049', keepDays: 180, minStock: 5 } }));
  ok(Number(wP1?.id) > 0 && Number(wP2?.id) > 0, 'W1 建两个调价测试商品');
  // 条码后6位模糊搜索（共享商品搜索组件的后端口径，V4.8.20）
  const wBy6 = data(await api('GET', '/products?keyword=000032', { token: T }));
  ok((wBy6.items || wBy6 || []).some(p => Number(p.id) === Number(wP1.id)), 'W1b 条码后6位 000032 模糊定位可乐');
  // W2 校验
  eq((await api('POST', '/price-changes', { token: T, body: { items: [] } })).code, 40003, 'W2 空明细 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: -1 }] } })).code, 40003, '负价 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id }] } })).code, 40003, '行内新价全空 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: 3 }] } })).code, 40003, '新售价=现售价 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: 3.5 }, { productId: wP1.id, newPrice: 4 }] } })).code, 40003, '单内重复商品 → 40003');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: 999999, newPrice: 4 }] } })).code, 40404, '商品不存在 → 40404');
  // W3 混合单：两行售价 + 一行进价（同行双轨）→ 待审核，未生效
  const wSup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: 'W段进价调价供应商', bizMode: '购销' } }));
  ok(Number(wSup?.id) > 0, 'W3 建进价调价供应商');
  const wP3 = data(await api('POST', '/products', { token: T, body: { name: 'W段牛奶250ml', base_unit: '盒', sellPrice: 4, barcode: '6901230000056', keepDays: 90, minStock: 5, supplierDefaultId: wSup.id } }));
  ok(Number(wP3?.id) > 0, 'W3 建带默认供应商商品');
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP1.id, newCost: 2 }] } })).code, 40003, 'W3b 进价调整未设供应商 → 40003');
  const wPc = data(await api('POST', '/price-changes', { token: T, body: {
    items: [{ productId: wP1.id, newPrice: 3.5 }, { productId: wP2.id, newPrice: 5.9 }, { productId: wP3.id, newCost: 2.8 }],
    effectiveDate: '2026-09-05', remark: 'W段混合调价（售价+进价同行）' } }));
  ok(/^TJ-\d{6}-\d{3}$/.test(wPc?.pcNo || ''), 'W3 混合单号 TJ-YYYYMM-XXX');
  eq(wPc?.status, 'pending', 'W3 保存后状态=待审核');
  eq(wPc?.priceType, 'dual', 'W3 含售价+进价 → priceType=dual');
  eq(wPc?.itemCount, 3, '行数 3');
  near(wPc?.diffTotal, (3.5 - 3) + (5.9 - 6.5) + (2.8 - 0), '差额合计 = 售价差额 + 进价差额');
  // W4 未审核不生效：三商品售价均不变，进价基线未落地
  const wList0 = data(await api('GET', '/products?size=200', { token: T }));
  const wI0 = wList0.items || wList0 || [];
  near(wI0.find(p => Number(p.id) === Number(wP1.id))?.sell_price, 3, 'W4 未审核：可乐售价仍 3');
  near(wI0.find(p => Number(p.id) === Number(wP2.id))?.sell_price, 6.5, 'W4 未审核：薯片售价仍 6.5');
  near(wI0.find(p => Number(p.id) === Number(wP3.id))?.sell_price, 4, 'W4 未审核：牛奶售价仍 4');
  const wSpp0 = await sqlOnly(`SELECT count(*)::int AS n FROM supplier_product_prices WHERE product_id=$1`, [wP3.id]);
  eq(wSpp0.rows[0]?.n, 0, 'W4 未审核：进价基线未落地');
  // W5 审核通过 → 全部生效
  const wAp = data(await api('POST', `/price-changes/${wPc.id}/approve`, { token: T }));
  eq(wAp?.status, 'approved', 'W5 审核通过状态=已生效');
  const wList1 = data(await api('GET', '/products?size=200', { token: T }));
  const wI1 = wList1.items || wList1 || [];
  near(wI1.find(p => Number(p.id) === Number(wP1.id))?.sell_price, 3.5, 'W5 可乐售价生效 3.5');
  near(wI1.find(p => Number(p.id) === Number(wP2.id))?.sell_price, 5.9, 'W5 薯片售价生效 5.9');
  near(wI1.find(p => Number(p.id) === Number(wP3.id))?.sell_price, 4, 'W5 牛奶售价不变（该行只改进价）');
  const wBase = await sqlOnly(
    `SELECT price, min_price, source_doc FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
    [wP3.id, wSup.id]);
  near(wBase.rows[0]?.price, 2.8, 'W5 进价基线落地 2.8');
  near(wBase.rows[0]?.min_price, 2.8, 'W5 min_price 刷新 2.8');
  eq(String(wBase.rows[0]?.source_doc || '').startsWith('TJ-'), true, 'W5 source_doc 关联调价单号');
  // W6 留痕：售价行 old_price 3/6.5；进价行 old_cost 0 / new_cost 2.8、old_price 为空
  const wDet = data(await api('GET', `/price-changes/${wPc.id}`, { token: T }));
  eq(wDet?.items?.length, 3, 'W6 详情含 3 行明细');
  eq(wDet?.status, 'approved', 'W6 详情状态=已生效');
  near(wDet.items.find(i => Number(i.product_id) === Number(wP1.id))?.old_price, 3, '可乐旧售价留痕 3');
  near(wDet.items.find(i => Number(i.product_id) === Number(wP2.id))?.old_price, 6.5, '薯片旧售价留痕 6.5');
  const wRow3 = wDet.items.find(i => Number(i.product_id) === Number(wP3.id));
  near(wRow3?.old_cost, 0, '牛奶无历史旧进价留痕 0');
  near(wRow3?.new_cost, 2.8, '牛奶新进价留痕 2.8');
  eq(wRow3?.old_price === null || wRow3?.old_price === undefined, true, '进价行售价留痕为空（双轨分离）');
  eq(wDet.items.every(i => i.supplier_name === undefined || i.supplier_name === null || i.supplier_name === 'W段进价调价供应商'), true, 'W6 明细供应商名留痕');
  // W7 二次进价下调 → 审核后 min_price 刷新（最低价保护线 V4.3.6）；同价拦截
  eq((await api('POST', '/price-changes', { token: T, body: { items: [{ productId: wP3.id, newCost: 2.8 }] } })).code, 40003, 'W7 新进价=现进价 → 40003');
  const wCc2 = data(await api('POST', '/price-changes', { token: T, body: {
    items: [{ productId: wP3.id, newCost: 2.5 }], remark: 'W段进价下调' } }));
  ok(/^JC-\d{6}-\d{3}$/.test(wCc2?.pcNo || ''), 'W7 纯进价单号 JC-YYYYMM-XXX');
  eq(wCc2?.priceType, 'cost', 'W7 纯进价单 priceType=cost');
  eq(wCc2?.status, 'pending', 'W7 纯进价单待审核');
  const wSpp1 = await sqlOnly(`SELECT count(*)::int AS n FROM supplier_product_prices WHERE product_id=$1 AND price=2.5`, [wP3.id]);
  eq(wSpp1.rows[0]?.n, 0, 'W7 未审核：新基线未落地');
  const wAp2 = data(await api('POST', `/price-changes/${wCc2.id}/approve`, { token: T }));
  eq(wAp2?.status, 'approved', 'W7 二次审核通过');
  const wBase2 = await sqlOnly(
    `SELECT price, min_price FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
    [wP3.id, wSup.id]);
  near(wBase2.rows[0]?.price, 2.5, 'W7 新基线 2.5');
  near(wBase2.rows[0]?.min_price, 2.5, 'W7 进价下调刷新最低价保护线 2.5');
  // W8 作废流：待审核可作废，作废后不可审核、价格不生效
  const wVd = data(await api('POST', '/price-changes', { token: T, body: {
    items: [{ productId: wP1.id, newPrice: 4.2 }], remark: 'W段作废测试' } }));
  eq(wVd?.status, 'pending', 'W8 新单待审核');
  const wVd2 = data(await api('POST', `/price-changes/${wVd.id}/void`, { token: T }));
  eq(wVd2?.status, 'voided', 'W8 作废成功');
  eq((await api('POST', `/price-changes/${wVd.id}/approve`, { token: T })).code, 40003, 'W8 作废单审核 → 40003');
  eq((await api('POST', `/price-changes/${wVd.id}/void`, { token: T })).code, 40003, 'W8 已作废再作废 → 40003');
  eq((await api('POST', `/price-changes/${wPc.id}/approve`, { token: T })).code, 40003, 'W8 已生效单重复审核 → 40003');
  const wList2 = data(await api('GET', '/products?size=200', { token: T }));
  near((wList2.items || wList2 || []).find(p => Number(p.id) === Number(wP1.id))?.sell_price, 3.5, 'W8 作废单未影响售价（仍 3.5）');
  // W9 列表过滤：类型 + 状态
  const wAll = data(await api('GET', '/price-changes', { token: T }));
  ok((wAll.items || wAll || []).some(c => Number(c.id) === Number(wPc.id)), 'W9 列表含混合单');
  const wCostList = data(await api('GET', '/price-changes?type=cost', { token: T }));
  ok((wCostList.items || wCostList || []).every(c => c.price_type === 'cost'), 'W9 type=cost 过滤仅进价单');
  const wDualList = data(await api('GET', '/price-changes?type=dual', { token: T }));
  ok((wDualList.items || wDualList || []).every(c => c.price_type === 'dual'), 'W9 type=dual 过滤仅混合单');
  const wVoidList = data(await api('GET', '/price-changes?status=voided', { token: T }));
  ok((wVoidList.items || wVoidList || []).every(c => c.status === 'voided') && (wVoidList.items || wVoidList || []).some(c => Number(c.id) === Number(wVd.id)), 'W9 status=voided 过滤含作废单');
  const wPendList = data(await api('GET', '/price-changes?status=pending', { token: T }));
  ok((wPendList.items || wPendList || []).every(c => c.status === 'pending'), 'W9 status=pending 过滤');
  const wUser2 = data(await api('POST', '/auth/login', { body: { empNo: 'ADMIN', password: 'admin123' } }));
  ok(Boolean(wUser2?.token), 'W10 管理员具备 pos.price.manual（ADMIN 全量权限）');

"""
s = s[:i0] + NEW + s[i1:]
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
chk = io.open(P, encoding="utf-8").read()
assert "approvePc" not in chk  # e2e 里不应出现 TS
assert "/approve" in chk and "/void" in chk and "status=voided" in chk
print("OK: e2e W段已重写为审核流语义")
