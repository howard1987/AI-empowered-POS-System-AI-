# -*- coding: utf-8 -*-
# V4.8.10 e2e：插入 U 段（会员充值闭环）于汇总之前
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend', 'tests', 'e2e.mjs')
s = io.open(P, encoding='utf-8').read()

OLD = """  // ═══ 汇总 ═══
  console.log('\\n══════════════════════════════');"""

NEW = """  // ═══ U. 会员充值闭环（H5 发起 → 收银台代收 → 入账，db/010） ═══
  console.log('■ U. 会员充值闭环');
  // U1 档位管理
  eq((await api('POST', '/members/recharge-plans', { token: T, body: { name: '', principal: 100 } })).code, 40003,
     'U1 档位名缺失 → 40003');
  const uPlan = data(await api('POST', '/members/recharge-plans', { token: T, body: { name: '充100送10', principal: 100, gift: 10 } }));
  eq(uPlan?.status, '启用', 'U1 创建档位 充100送10');
  ok(data(await api('GET', '/members/recharge/plans/all', { token: T }))?.some(p => Number(p.id) === Number(uPlan.id)),
     '后台档位全量列表可见');
  // U2 会员注册 + H5 档位
  const uReg = await api('POST', '/m/register', { body: { phone: '13900000555', password: 'abc123', name: '充值测试', privacyAgreed: true } });
  eq(uReg.code, 0, 'U2 充值测试会员注册');
  const uTk = data(uReg).token;
  const uPlans = data(await api('GET', '/m/recharge/plans', { token: uTk }));
  ok(uPlans?.plans?.some(p => Number(p.gift) === 10), 'H5 启用档位列表含赠送 10 档');
  ok(Number(uPlans?.maxSingle) > 0, '返回单笔充值上限');
  // U3 发起充值单（服务端按档计算赠送，客户端不可传）
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { planId: 999999 } })).code, 42016, 'U3 不存在档位 → 42016');
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 99999 } })).code, 42017, '超出单笔上限 → 42017');
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 0 } })).code, 40003, '金额 0 → 40003');
  const uRO = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { planId: uPlan.id } }));
  eq(uRO?.status, '待支付', 'U3 按档位发起充值单（待支付）');
  near(uRO?.principal, 100, '本金 100（服务端按档计算）');
  near(uRO?.gift, 10, '赠送 10（客户端不可传 gift，防篡改）');
  ok(String(uRO?.order_no || '').startsWith('RC-'), '充值单号 RC- 前缀');
  // U4 收银台代收队列（手机号脱敏）
  const uQueue = data(await api('GET', '/pos/recharge-orders', { token: T }));
  ok(uQueue?.items?.some(o => Number(o.id) === Number(uRO.id)), 'U4 代收队列含该充值单');
  const uQRow = uQueue.items.find(o => Number(o.id) === Number(uRO.id));
  ok(!uQRow.phone || String(uQRow.phone).includes('****'), '队列手机号脱敏');
  // U5 状态机：非法通道/取消/重复入账/越权
  const uRO2 = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 50 } }));
  eq((await api('POST', `/pos/recharge-orders/${uRO2.id}/collect`, { token: T, body: { payChannel: '刷卡' } })).code, 40003,
     'U5 非法支付通道 → 40003');
  eq((await api('POST', `/m/recharge-orders/${uRO2.id}/cancel`, { token: uTk })).code, 0, '会员取消本人待支付单');
  eq((await api('POST', `/pos/recharge-orders/${uRO2.id}/collect`, { token: T, body: { payChannel: '现金' } })).code, 50074,
     '已取消单入账 → 50074');
  eq((await api('POST', `/m/recharge-orders/${uRO2.id}/cancel`, { token: uTk })).code, 42019, '重复取消 → 42019');
  eq((await api('POST', `/m/recharge-orders/${uRO.id}/cancel`, { token: mTk })).code, 40404, '取消他人充值单 → 40404');
  // U6 收银台现金代收入账（口径B：本金+赠送拆分）
  const uCol = data(await api('POST', `/pos/recharge-orders/${uRO.id}/collect`, { token: T, body: { payChannel: '现金' } }));
  ok(!!uCol?.orderNo, 'U6 收银台现金代收入账');
  near(uCol?.balanceAfter, 110, '入账后余额 110（100+10）');
  const uMe = data(await api('GET', '/m/me', { token: uTk }));
  near(uMe?.assets?.balance, 110, 'H5 余额 110');
  near(uMe?.assets?.principalTotal, 100, '累计本金 100（赠送不计本金）');
  near(uMe?.assets?.giftBalance, 10, '赠送余额 10');
  eq((await api('POST', `/pos/recharge-orders/${uRO.id}/collect`, { token: T, body: { payChannel: '现金' } })).code, 50074,
     '重复入账 → 50074');
  const uFlows = data(await api('GET', '/m/flows?tab=balance', { token: uTk }));
  ok(uFlows?.items?.some(f => f.biz_type === '充值' && Number(f.amount) === 110 && Number(f.principal_part) === 100),
     '余额流水：充值 110（本金部分 100）');
  // U7 过期拦截（25h > 24h 设置）
  const uRO3 = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 20 } }));
  await sqlOnly(`UPDATE recharge_orders SET created_at = now() - interval '25 hours' WHERE id=$1`, [uRO3.id]);
  eq((await api('POST', `/pos/recharge-orders/${uRO3.id}/collect`, { token: T, body: { payChannel: '扫码' } })).code, 50075,
     'U7 过期充值单入账 → 50075');
  ok(data(await api('GET', '/pos/recharge-orders?status=' + encodeURIComponent('已过期'), { token: T }))
     ?.items?.some(o => Number(o.id) === Number(uRO3.id)), '过期单进入已过期队列');
  const uMe2 = data(await api('GET', '/m/me', { token: uTk }));
  near(uMe2?.assets?.balance, 110, '过期单未入账，余额仍 110');
  // U8 扫码通道代收
  const uRO4 = data(await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 30 } }));
  const uCol4 = data(await api('POST', `/pos/recharge-orders/${uRO4.id}/collect`, { token: T, body: { payChannel: '扫码' } }));
  near(uCol4?.balanceAfter, 140, 'U8 扫码代收 30 → 余额 140');
  eq(uCol4?.payChannel, '扫码', '通道扫码留痕');
  // U9 待支付单上限 3 张
  await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } });
  await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } });
  const uRO5 = await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } });
  eq(uRO5.code, 0, 'U9 第三张待支付单可发起');
  eq((await api('POST', '/m/recharge-orders', { token: uTk, body: { principal: 1 } })).code, 42018, '第四张 → 42018（上限 3）');
  // U10 H5 充值单列表状态齐全
  const uList = data(await api('GET', '/m/recharge-orders', { token: uTk }));
  ok(uList?.items?.some(o => o.status === '已入账' && o.pay_channel === '扫码'), 'U10 H5 列表含已入账·扫码');
  ok(uList?.items?.some(o => o.status === '已过期'), 'H5 列表含已过期');
  ok(uList?.items?.some(o => o.status === '已取消'), 'H5 列表含已取消');

  // ═══ 汇总 ═══
  console.log('\\n══════════════════════════════');"""

assert s.count(OLD) == 1, f'锚点不唯一: {s.count(OLD)}'
s = s.replace(OLD, NEW)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('E2E PATCH DONE')
