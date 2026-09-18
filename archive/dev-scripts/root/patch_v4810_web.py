# -*- coding: utf-8 -*-
# V4.8.10 Web 后台：会员屏加「充值档位管理」卡片
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frontend-web', 'screens', 'members.js')
s = io.open(P, encoding='utf-8').read()

pairs = [
(
"""    <div id="mDetail"></div>`;
""",
"""    <div class="card">
      <h3>充值档位 <span class="api">GET /members/recharge/plans/all · POST /members/recharge-plans</span></h3>
      <div class="bar">
        <input id="pName" placeholder="档位名称*" style="width:120px">
        <input id="pPrincipal" type="number" step="0.01" placeholder="充(元)*" style="width:100px">
        <input id="pGift" type="number" step="0.01" placeholder="送(元)" style="width:100px">
        <button class="btn pri" id="pSave">新增档位</button>
      </div>
      <div id="pList" class="muted"></div>
      <div class="muted" style="margin-top:6px">档位供会员 H5 端选择发起充值单，收银台代收现金/扫码后入账（赠送不计分红权重）</div>
    </div>
    <div id="mDetail"></div>`;
""",
'html'),
(
"""  view.querySelector('#mGo').onclick = list;""",
"""  async function plans() {
    const d = await get('/members/recharge/plans/all').catch(() => null);
    const items = d?.data || d || [];
    const box = view.querySelector('#pList');
    box.innerHTML = Array.isArray(items) && items.length ? `
      <table><thead><tr><th>名称</th><th class="num">充</th><th class="num">送</th><th>状态</th><th></th></tr></thead>
      <tbody>${items.map(p => `<tr>
        <td>${esc(p.name)}</td><td class="num">${money(p.principal)}</td><td class="num">${money(p.gift)}</td>
        <td>${p.status === '启用' ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
        <td><button class="btn sm" data-pid="${p.id}" data-to="${p.status === '启用' ? '停用' : '启用'}">${p.status === '启用' ? '停用' : '启用'}</button></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无档位</div>';
    box.querySelectorAll('[data-pid]').forEach(b => b.onclick = async () => {
      await must(post(`/members/recharge-plans/${b.dataset.pid}/status`, { status: b.dataset.to }), '已更新');
      await plans();
    });
  }
  view.querySelector('#pSave').onclick = async () => {
    const name = view.querySelector('#pName').value.trim();
    const principal = Number(view.querySelector('#pPrincipal').value);
    const gift = Number(view.querySelector('#pGift').value) || 0;
    if (!name || !(principal > 0)) return toast('名称与充值金额必填', false);
    await must(post('/members/recharge-plans', { name, principal, gift }), '档位已创建');
    view.querySelector('#pName').value = ''; view.querySelector('#pPrincipal').value = ''; view.querySelector('#pGift').value = '';
    await plans();
  };
  await plans();

  view.querySelector('#mGo').onclick = list;""",
'js'),
]
for old, new, tag in pairs:
    assert s.count(old) == 1, f'锚点不唯一({s.count(old)}): {tag}'
    s = s.replace(old, new)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('WEB PATCH DONE')
