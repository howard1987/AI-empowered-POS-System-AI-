# -*- coding: utf-8 -*-
# 修复：collectRecharge 先刷新队列（清空消息）再设置消息，避免消息被立即清掉
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frontend-desktop', 'renderer', 'index.html')
s = io.open(P, encoding='utf-8').read()

OLD = """async function collectRecharge(id, channel) {
  const r = await call('POST', `/pos/recharge-orders/${id}/collect`,
    { payChannel: channel, shiftId: SHIFT ? SHIFT.id : undefined });
  if (r.code === 0) {
    log(`[充值] ${r.data.orderNo} 入账 +${money(r.data.principal + r.data.gift)}（${channel}·会员余额 ${money(r.data.balanceAfter)}）`);
    $('#rechargeMsg').textContent = `${r.data.orderNo} 已入账：+${money(r.data.principal + r.data.gift)}`;
  } else {
    log(`[充值] 失败：${r.msg || r.code}`);
    $('#rechargeMsg').textContent = '失败：' + (r.msg || r.code);
  }
  await refreshRechargeQueue();
}"""

NEW = """async function collectRecharge(id, channel) {
  const r = await call('POST', `/pos/recharge-orders/${id}/collect`,
    { payChannel: channel, shiftId: SHIFT ? SHIFT.id : undefined });
  await refreshRechargeQueue();   // 先刷新（内部会清空消息区），再写结果消息
  if (r.code === 0) {
    log(`[充值] ${r.data.orderNo} 入账 +${money(r.data.principal + r.data.gift)}（${channel}·会员余额 ${money(r.data.balanceAfter)}）`);
    $('#rechargeMsg').textContent = `${r.data.orderNo} 已入账：+${money(r.data.principal + r.data.gift)}`;
  } else {
    log(`[充值] 失败：${r.msg || r.code}`);
    $('#rechargeMsg').textContent = '失败：' + (r.msg || r.code);
  }
}"""

assert s.count(OLD) == 1, f'锚点不唯一: {s.count(OLD)}'
s = s.replace(OLD, NEW)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('POS MSG FIX DONE')
