# -*- coding: utf-8 -*-
# V4.8.10 H5 会员端：充值页（档位 + 自定义金额 + 充值单列表 + 取消）
import io, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frontend-h5')
ROOT = os.path.abspath(ROOT)

def patch(name, pairs):
    p = os.path.join(ROOT, name)
    s = io.open(p, encoding='utf-8').read()
    for old, new, tag in pairs:
        assert s.count(old) == 1, f'{name} 锚点不唯一({s.count(old)}): {tag}'
        s = s.replace(old, new)
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
    print('OK', name)

patch('index.html', [
(
"""        <button class="nav-b" data-v="sales" data-page-node-id="K7rlexfXDm9XDqsWiwymMg">🧾 消费</button>""",
"""        <button class="nav-b" data-v="recharge">💳 充值</button>
        <button class="nav-b" data-v="sales" data-page-node-id="K7rlexfXDm9XDqsWiwymMg">🧾 消费</button>""",
'nav btn'
),
(
"""      <section id="vSales" class="view" hidden data-page-node-id="mcwUrfXv3KIzyhuZgXPVMq">""",
"""      <section id="vRecharge" class="view" hidden>
        <div class="card">
          <h3>发起充值</h3>
          <p class="hint">选择档位到店付款（收银台现金/扫码代收），收款确认后余额即时到账；赠送部分不计分红权重</p>
          <div id="rechargePlans" class="plan-grid"></div>
          <form id="fRecharge">
            <input name="amount" type="number" step="0.01" min="0.01" placeholder="自定义金额（元，无赠送）" style="flex:1">
            <button class="primary" type="submit">发起充值</button>
          </form>
        </div>
        <div class="card">
          <h3>我的充值单</h3>
          <div id="rechargeList" class="list"></div>
        </div>
      </section>

      <section id="vSales" class="view" hidden data-page-node-id="mcwUrfXv3KIzyhuZgXPVMq">""",
'recharge view'
),
])

patch('app.js', [
(
"""$$('.nav-b').forEach(b => b.onclick = () => {
  $$('.nav-b').forEach(x => x.classList.toggle('on', x === b));
  $('#vFlows').hidden = b.dataset.v !== 'flows';
  $('#vSales').hidden = b.dataset.v !== 'sales';
  $('#vMe').hidden = b.dataset.v !== 'me';
});""",
"""$$('.nav-b').forEach(b => b.onclick = () => {
  $$('.nav-b').forEach(x => x.classList.toggle('on', x === b));
  $('#vFlows').hidden = b.dataset.v !== 'flows';
  $('#vRecharge').hidden = b.dataset.v !== 'recharge';
  $('#vSales').hidden = b.dataset.v !== 'sales';
  $('#vMe').hidden = b.dataset.v !== 'me';
  if (b.dataset.v === 'recharge') loadRecharge();
});

// ── 充值（H5 发起 → 收银台代收） ──
let SEL_PLAN = null;

async function loadRecharge() {
  const [rp, ro] = await Promise.all([
    call('GET', '/m/recharge/plans'),
    call('GET', '/m/recharge-orders'),
  ]);
  if (rp.code === 40100 || rp.code === 401 || ro.code === 40100 || ro.code === 401) return logout();
  // 档位卡片
  const plans = rp.data?.plans || [];
  const g = $('#rechargePlans');
  if (!plans.length) g.innerHTML = '<div class="empty">门店暂未配置充值档位，可直接输入自定义金额</div>';
  else g.innerHTML = plans.map(p => `
    <button type="button" class="plan${SEL_PLAN === Number(p.id) ? ' on' : ''}" data-id="${p.id}">
      <b>充 ${money(p.principal)}</b><span>${Number(p.gift) > 0 ? '送 ' + money(p.gift) : '无赠送'}</span>
    </button>`).join('');
  g.querySelectorAll('.plan').forEach(b => b.onclick = () => {
    const id = Number(b.dataset.id);
    SEL_PLAN = SEL_PLAN === id ? null : id;
    g.querySelectorAll('.plan').forEach(x => x.classList.toggle('on', Number(x.dataset.id) === SEL_PLAN));
  });
  // 充值单列表
  const items = ro.data?.items || [];
  const box = $('#rechargeList');
  if (!items.length) { box.innerHTML = '<div class="empty">暂无充值单</div>'; return; }
  box.innerHTML = items.map(o => `<div class="row">
    <div class="l"><b>${esc(o.order_no)}</b>
      <span class="muted">${fmtTime(o.created_at)} · 充 ${money(o.principal)}${Number(o.gift) ? ' 送 ' + money(o.gift) : ''}${o.pay_channel ? ' · ' + esc(o.pay_channel) : ''}</span></div>
    <div class="amt ${o.status === '已入账' ? 'in' : o.status === '待支付' ? '' : 'out'}">
      ${esc(o.status)}${o.status === '待支付' ? ` <button type="button" class="mini-cancel" data-id="${o.id}">取消</button>` : ''}
    </div></div>`).join('');
  box.querySelectorAll('.mini-cancel').forEach(b => b.onclick = async () => {
    const r = await call('POST', `/m/recharge-orders/${b.dataset.id}/cancel`);
    if (r.code === 0) { toast('已取消，可重新发起'); loadRecharge(); }
    else toast(r.msg || '取消失败');
  });
}

$('#fRecharge').onsubmit = async e => {
  e.preventDefault();
  const amount = Number(new FormData(e.target).get('amount'));
  let body;
  if (SEL_PLAN) body = { planId: SEL_PLAN };
  else {
    if (!(amount > 0)) return toast('请选择档位或输入充值金额');
    body = { principal: amount };
  }
  const r = await call('POST', '/m/recharge-orders', body);
  if (r.code === 0) {
    toast(`充值单 ${r.data.order_no} 已发起，请到收银台付款（充 ${money(r.data.principal)}${Number(r.data.gift) ? ' 送 ' + money(r.data.gift) : ''}）`);
    e.target.reset(); SEL_PLAN = null;
    loadRecharge();
  } else toast(r.msg || '发起失败');
};""",
'js recharge'
),
])

print('H5 PATCHES DONE')
