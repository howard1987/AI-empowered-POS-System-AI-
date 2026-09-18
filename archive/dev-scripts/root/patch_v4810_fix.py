# -*- coding: utf-8 -*-
# 修复：过期置状态不能在事务内（throw 50075 会回滚 UPDATE）→ 预检移到事务外独立提交
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend', 'src', 'modules', 'pos.module.ts')
s = io.open(P, encoding='utf-8').read()

OLD = """    if (!['现金', '扫码'].includes(body.payChannel)) throw new BizException(40003, 'payChannel 仅支持 现金/扫码');
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM recharge_orders WHERE id=$1 FOR UPDATE`, [id]);
      const ro = rows[0];
      if (!ro) throw new BizException(40404, '充值单不存在', 404);
      if (ro.status !== '待支付') throw new BizException(50074, `充值单状态已变更（${ro.status}），请刷新后重试`);
      const hours = await this.settings.getNum('member.recharge.orders_expire_hours', 24);
      if (new Date(ro.created_at).getTime() + hours * 3600000 < Date.now()) {
        await cx(c, `UPDATE recharge_orders SET status='已过期', updated_at=now() WHERE id=$1`, [id]);
        throw new BizException(50075, '充值单已过期，请会员重新发起');
      }
      const principal = Number(ro.principal), gift = Number(ro.gift);"""

NEW = """    if (!['现金', '扫码'].includes(body.payChannel)) throw new BizException(40003, 'payChannel 仅支持 现金/扫码');
    // 过期预检在事务外：置「已过期」必须独立提交（事务内 throw 会把 UPDATE 一并回滚）
    const pre = await q1<{ status: string; created_at: any }>(`SELECT status, created_at FROM recharge_orders WHERE id=$1`, [id]);
    if (pre && pre.status === '待支付') {
      const hours = await this.settings.getNum('member.recharge.orders_expire_hours', 24);
      if (new Date(pre.created_at).getTime() + hours * 3600000 < Date.now()) {
        await q(`UPDATE recharge_orders SET status='已过期', updated_at=now() WHERE id=$1`, [id]);
        throw new BizException(50075, '充值单已过期，请会员重新发起');
      }
    }
    return tx(async c => {
      const rows = await cx(c, `SELECT * FROM recharge_orders WHERE id=$1 FOR UPDATE`, [id]);
      const ro = rows[0];
      if (!ro) throw new BizException(40404, '充值单不存在', 404);
      if (ro.status !== '待支付') throw new BizException(50074, `充值单状态已变更（${ro.status}），请刷新后重试`);
      const principal = Number(ro.principal), gift = Number(ro.gift);"""

assert s.count(OLD) == 1, f'锚点不唯一: {s.count(OLD)}'
s = s.replace(OLD, NEW)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('FIX DONE')
