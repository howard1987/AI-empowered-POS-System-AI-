# -*- coding: utf-8 -*-
# V4.8.10 收银台：充值代收面板（H5 发起 → 收银台现金/扫码收款）
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frontend-desktop', 'renderer', 'index.html')
s = io.open(P, encoding='utf-8').read()

pairs = [
(
"""    <div class="card">
      <h3>交接班 <span class="hint">5.2.5 /shifts</span></h3>""",
"""    <div class="card">
      <h3>充值代收 <span class="hint">H5 发起 → 收银台收款</span></h3>
      <div class="row">
        <button class="b ghost" onclick="openRecharge()">代收充值单</button>
      </div>
    </div>
    <div class="card">
      <h3>交接班 <span class="hint">5.2.5 /shifts</span></h3>""",
'card'),
(
"""<!-- 交班对话框 -->""",
"""<!-- 充值代收对话框 -->
<dialog id="dlgRecharge">
  <h3 style="margin-bottom:10px">会员充值代收 <span class="hint">会员 H5 发起，收款确认后余额即时到账</span></h3>
  <div id="rechargeQueue" style="max-height:300px;overflow:auto"></div>
  <div class="row" style="margin-top:10px">
    <button class="b ghost" onclick="dlgRecharge.close()">关闭</button>
    <button class="b ghost" onclick="refreshRechargeQueue()">刷新</button>
  </div>
  <div class="hint" id="rechargeMsg" style="min-height:16px;color:#2a7"></div>
</dialog>

<!-- 交班对话框 -->""",
'dialog'),
(
"""// ═══════════ 外设（Electron 生效） ═══════════""",
"""// ═══════════ 充值代收（H5 发起 → 收银台现金/扫码收款，db/010） ═══════════
async function openRecharge() { dlgRecharge.showModal(); await refreshRechargeQueue(); }

async function refreshRechargeQueue() {
  $('#rechargeMsg').textContent = '';
  const r = await call('GET', '/pos/recharge-orders?status=' + encodeURIComponent('待支付'));
  const items = r.data?.items || [];
  $('#rechargeQueue').innerHTML = items.length ? items.map(o => `
    <div style="display:flex;justify-content:space-between;align-items:center;border:1px solid #eee;border-radius:8px;padding:8px;margin-bottom:6px">
      <span style="font-size:12px"><b>${o.order_no}</b> · ${o.name || o.card_no || ''} ${o.phone || ''}<br>
        充 ${money(o.principal)}${Number(o.gift) ? ' 送 ' + money(o.gift) : ''} · 合计应收 ${money(Number(o.principal) + Number(o.gift))}</span>
      <span>
        <button class="b ghost" onclick="collectRecharge(${o.id},'现金')">现金收款</button>
        <button class="b ghost" onclick="collectRecharge(${o.id},'扫码')">扫码收款</button>
      </span>
    </div>`).join('') : '<div class="hint">暂无待支付充值单</div>';
}

async function collectRecharge(id, channel) {
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
}

// ═══════════ 外设（Electron 生效） ═══════════""",
'js'),
]
for old, new, tag in pairs:
    assert s.count(old) == 1, f'锚点不唯一({s.count(old)}): {tag}'
    s = s.replace(old, new)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('POS PATCH DONE')
