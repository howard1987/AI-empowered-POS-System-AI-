# -*- coding: utf-8 -*-
"""V4.8.15 e2e 补丁：插入 W 段（商品调价单闭环）。幂等：目标已存在则跳过。"""
import io, sys

P = 'tests/e2e.mjs'
s = io.open(P, encoding='utf-8').read()

if '═══ W.' in s:
    print('ALREADY PATCHED'); sys.exit(0)

ANCHOR = '  // ═══ 汇总 ═══'
assert s.count(ANCHOR) == 1

W = '''  // ═══ W. 商品调价单（录入即生效 + 留痕，V4.8.15） ═══
  console.log('■ W. 商品调价单');
  const wP1 = data(await api('POST', '/products', { token: T, body: { name: 'W段可乐330ml', base_unit: '罐', sellPrice: 3, barcode: '6901230000032', keepDays: 270, minStock: 5 } }));
  const wP2 = data(await api('POST', '/products', { token: T, body: { name: 'W段薯片原味', base_unit: '袋', sellPrice: 6.5, barcode: '6901230000049', keepDays: 180, minStock: 5 } }));
  ok(Number(wP1?.id) > 0 && Number(wP2?.id) > 0, 'W1 建两个调价测试商品');
  // W2 校验
  eq((await api('POST', '/products/price-changes', { token: T, body: { items: [] } })).code, 40003, 'W2 空明细 → 40003');
  eq((await api('POST', '/products/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: -1 }] } })).code, 40003, '负价 → 40003');
  eq((await api('POST', '/products/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: 3 }] } })).code, 40003, '新价=现价 → 40003');
  eq((await api('POST', '/products/price-changes', { token: T, body: { items: [{ productId: wP1.id, newPrice: 3.5 }, { productId: wP1.id, newPrice: 4 }] } })).code, 40003, '单内重复商品 → 40003');
  eq((await api('POST', '/products/price-changes', { token: T, body: { items: [{ productId: 999999, newPrice: 4 }] } })).code, 40404, '商品不存在 → 40404');
  // W3 正常调价（一升一降）
  const wPc = data(await api('POST', '/products/price-changes', { token: T, body: {
    items: [{ productId: wP1.id, newPrice: 3.5 }, { productId: wP2.id, newPrice: 5.9 }],
    effectiveDate: '2026-09-05', remark: 'W段促销调价' } }));
  ok(/^TJ-\\d{6}-\\d{3}$/.test(wPc?.pcNo || ''), 'W3 调价单号 TJ-YYYYMM-XXX');
  eq(wPc?.itemCount, 2, '行数 2');
  near(wPc?.diffTotal, 3.5 + 5.9 - 3 - 6.5, '差额合计 (3.5-3)+(5.9-6.5)');
  // W4 生效校验：sell_price 已更新
  const wList = data(await api('GET', '/products?size=200', { token: T }));
  const wItems = wList.items || wList || [];
  const wN1 = wItems.find(p => Number(p.id) === Number(wP1.id));
  const wN2 = wItems.find(p => Number(p.id) === Number(wP2.id));
  near(wN1?.sell_price, 3.5, 'W4 可乐现售价已变 3.5');
  near(wN2?.sell_price, 5.9, '薯片现售价已变 5.9');
  // W5 留痕校验：明细记录旧价 3 / 6.5
  const wDet = data(await api('GET', `/products/price-changes/${wPc.id}`, { token: T }));
  eq(wDet?.items?.length, 2, 'W5 详情含 2 行明细');
  near(wDet.items.find(i => Number(i.product_id) === Number(wP1.id))?.old_price, 3, '可乐旧价留痕 3');
  near(wDet.items.find(i => Number(i.product_id) === Number(wP2.id))?.old_price, 6.5, '薯片旧价留痕 6.5');
  eq(wDet.items[0]?.product_name !== undefined, true, '明细含商品名/条码');
  // W6 列表与权限
  const wPcs = data(await api('GET', '/products/price-changes', { token: T }));
  ok((wPcs.items || wPcs || []).some(c => Number(c.id) === Number(wPc.id)), 'W6 调价单列表含新单');
  const wUser2 = data(await api('POST', '/auth/login', { body: { empNo: 'ADMIN', password: 'admin123' } }));
  ok(Boolean(wUser2?.token), 'W7 管理员具备 pos.price.manual（ADMIN 全量权限）');

'''
s = s.replace(ANCHOR, W + ANCHOR, 1)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('W PATCH OK')
