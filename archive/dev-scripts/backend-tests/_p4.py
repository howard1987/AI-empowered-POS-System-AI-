# -*- coding: utf-8 -*-
import io
p = 'tests/e2e.mjs'
s = io.open(p, encoding='utf-8').read()

old = """  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id, couponId: MC1,
    payments: [{ channel: '现金', amount: 2 }] } })).code, 50041, '重复用券 → 50041');"""
new = """  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], memberId: m1.id, couponId: MC1,
    payments: [{ channel: '现金', amount: 5.98 }] } })).code, 50041, '重复用券 → 50041');"""
assert old in s, 'reuse anchor'
s = s.replace(old, new)

old = """  const o4 = data(await api('POST', '/coupons', { token: T, body: {
    name: '矿泉水兑换券', type: '兑换券', validDays: 30,
    scope: { productIds: [Number(pb.id)] } } }));
  await api('POST', `/coupons/${o4.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  const o4c = await sqlOnly(`SELECT id FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [o4.id, m1.id]);
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id, couponId: Number(o4c.rows[0].id),
    payments: [{ channel: '现金', amount: 2 }] } })).code, 50043, '不含适用商品 → 50043');
  const o4dr = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }, { productId: pb.id, qty: 1 }], memberId: m1.id,
    couponId: Number(o4c.rows[0].id), payments: [{ channel: '现金', amount: 5.98 }] } });
  eq(o4dr.code, 0, '兑换券下单（矿泉水+苹果）');
  const o4d = data(o4dr);
  near(o4d?.couponAmount, 2, '免费一件取最低价（矿泉水 2 元）');
  near(o4d?.payable, 5.98, '应收 5.98');"""
new = """  const oGum = data(await api('POST', '/products', { token: T, body: {
    name: '薄荷口香糖', base_unit: '瓶', sellPrice: 3, barcode: '6901111000099', trackInventory: false } }));
  ok(oGum?.id > 0, '创建不记库存商品（兑换场景隔离）');
  const o4 = data(await api('POST', '/coupons', { token: T, body: {
    name: '苹果兑换券', type: '兑换券', validDays: 30,
    scope: { productIds: [Number(pb.id)] } } }));
  await api('POST', `/coupons/${o4.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  const o4c = await sqlOnly(`SELECT id FROM member_coupons WHERE coupon_id=$1 AND member_id=$2`, [o4.id, m1.id]);
  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: oGum.id, qty: 1 }], memberId: m1.id, couponId: Number(o4c.rows[0].id),
    payments: [{ channel: '现金', amount: 3 }] } })).code, 50043, '不含适用商品 → 50043');
  const o4dr = await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: oGum.id, qty: 1 }, { productId: pb.id, qty: 1 }], memberId: m1.id,
    couponId: Number(o4c.rows[0].id), payments: [{ channel: '现金', amount: 5.98 }] } });
  eq(o4dr.code, 0, '兑换券下单（口香糖+苹果）');
  const o4d = data(o4dr);
  near(o4d?.couponAmount, 3, '免费一件取最低价（口香糖 3 元）');
  near(o4d?.payable, 5.98, '应收 = 3 + 5.98 - 3 = 5.98');"""
assert old in s, 'exchange anchor'
s = s.replace(old, new)

old = """  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id, couponId: Number(o5c.rows[0].id),
    payments: [{ channel: '现金', amount: 2 }] } })).code, 50041, '过期兜底拦截（扫描未跑也能拦）');"""
new = """  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], memberId: m1.id, couponId: Number(o5c.rows[0].id),
    payments: [{ channel: '现金', amount: 5.98 }] } })).code, 50041, '过期兜底拦截（扫描未跑也能拦）');"""
assert old in s, 'expire1 anchor'
s = s.replace(old, new)
old = """  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pa.id, qty: 1 }], memberId: m1.id, couponId: Number(o5c.rows[0].id),
    payments: [{ channel: '现金', amount: 2 }] } })).code, 50041, '扫描后 → 50041 已过期');"""
new = """  eq((await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: pb.id, qty: 1 }], memberId: m1.id, couponId: Number(o5c.rows[0].id),
    payments: [{ channel: '现金', amount: 5.98 }] } })).code, 50041, '扫描后 → 50041 已过期');"""
assert old in s, 'expire2 anchor'
s = s.replace(old, new)

old = """  eq((await api('POST', `/coupons/${o1.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } })).skipped, 1,
     '超过每人限领 → skipped（不重复发）');"""
new = """  const o1x = await api('POST', `/coupons/${o1.id}/issue`, { token: T, body: { memberIds: [Number(m1.id)] } });
  if (o1x.code !== 0) console.log('  [debug o1x]', JSON.stringify(o1x));
  eq(o1x.data?.skipped, 1, '超过每人限领 → skipped（不重复发）');"""
assert old in s, 'limit anchor'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('O fixes applied')
