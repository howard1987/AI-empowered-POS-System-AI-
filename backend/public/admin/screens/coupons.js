import { get, post, must, money, esc, dt, toast } from '../api.js';

/** 优惠券：POST/GET /coupons、POST /coupons/:id/issue、POST /coupons/expire-scan、POST /coupons/:id/status */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>创建券模板 </h3>
      <div class="bar">
        <input id="cName" placeholder="券名称*" style="width:130px">
        <select id="cType">${['满减券', '折扣券', '兑换券', '次卡'].map(t => `<option>${t}</option>`).join('')}</select>
        <input id="cThr" type="number" step="0.01" placeholder="门槛(满减)" style="width:100px">
        <input id="cDis" type="number" step="0.01" placeholder="面额/折扣率*" style="width:110px">
        <input id="cDays" type="number" placeholder="有效天数" style="width:90px" value="30">
        <input id="cPer" type="number" placeholder="每人限领(张)" style="width:104px" value="1" title="每个会员最多领几张，防止一人囤券">
        <input id="cQty" type="number" placeholder="总量池(张,选填)" style="width:120px" title="全店最多发出去多少张，不填=不限量；控制成本用">
        <label style="display:flex;align-items:center;gap:4px;font-weight:400;font-size:13px" title="勾选=本券可与其他可叠加券同单累加；取消=互斥券，一单只能用它一张">
          <input type="checkbox" id="cStack" checked> 可叠加使用</label>
        <button class="btn pri" id="cSave">创建</button>
      </div>
      <div class="doc-tip" style="margin:8px 18px 0">💡 <b>每人限领</b>：单个会员最多能领几张（默认 1 张）。<b>总量池</b>：这批券全店最多发出去多少张，留空=不限量（如发 200 张预算可控）。<b>有效天数</b>：从领券当天起算 N 天内有效。</div>
    </div>
    <div class="card">
      <h3>券列表（含核销统计） 
        <button class="btn" id="cScan" style="margin-left:12px">执行过期扫描</button></h3>
      <div id="clist"></div>
    </div>`;

  view.querySelector('#cSave').onclick = async () => {
    const name = view.querySelector('#cName').value.trim();
    const type = view.querySelector('#cType').value;
    const dis = view.querySelector('#cDis').value;
    if (!name || dis === '') return toast('名称与面额/折扣率必填', false);
    await must(post('/coupons', {
      name, type,
      threshold: Number(view.querySelector('#cThr').value) || undefined,
      discount: Number(dis),
      validDays: Number(view.querySelector('#cDays').value) || 30,
      perMember: Number(view.querySelector('#cPer').value) || 1,
      totalQty: view.querySelector('#cQty').value ? Number(view.querySelector('#cQty').value) : undefined,
      stackable: view.querySelector('#cStack').checked,
    }), '券模板已创建');
    view.querySelector('#cName').value = '';
    await list();
  };
  view.querySelector('#cScan').onclick = async () => {
    const d = await must(post('/coupons/expire-scan'), '扫描完成');
    toast(`过期 ${d.expired} 张`);
    await list();
  };

  async function list() {
    const rows = await must(get('/coupons')).catch(() => []);
    view.querySelector('#clist').innerHTML = rows.length ? `
      <table><thead><tr><th>ID</th><th>名称</th><th>类型</th><th class="num">门槛</th><th class="num">面额/折扣</th>
        <th class="num">未使用</th><th class="num">已核销</th><th class="num">已过期</th><th>叠加</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows.map(c => `<tr>
        <td>${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.type)}</td>
        <td class="num">${c.threshold ? money(c.threshold) : '—'}</td>
        <td class="num">${c.type === '折扣券' ? Number(c.discount) + ' 折率' : c.discount ? money(c.discount) : '—'}</td>
        <td class="num">${c.unused_count}</td><td class="num">${c.used_count}</td><td class="num">${c.expired_count}</td>
        <td>${c.stackable === false ? '<span class="tag r">互斥</span>' : '<span class="tag g">可叠加</span>'}</td>
        <td>${c.status === 1 ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
        <td>
          <button class="btn sm" data-id="${c.id}" data-issue>发券</button>
          ${c.status === 1 ? `<button class="btn sm warn" data-id="${c.id}" data-stop>停用</button>` : `<button class="btn sm pri" data-id="${c.id}" data-start>启用</button>`}
        </td></tr>`).join('')}</tbody></table>` : '<div class="empty">无券模板</div>';

    view.querySelectorAll('[data-issue]').forEach(b => b.onclick = () => issue(b.dataset.id));
    view.querySelectorAll('[data-stop]').forEach(b => b.onclick = async () => {
      await must(post(`/coupons/${b.dataset.id}/status`, { status: 0 }), '已停用'); await list();
    });
    view.querySelectorAll('[data-start]').forEach(b => b.onclick = async () => {
      await must(post(`/coupons/${b.dataset.id}/status`, { status: 1 }), '已启用'); await list();
    });
  }

  /** 发券：输入会员 ID（逗号分隔多人） */
  function issue(id) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="width:420px"><h3>发券 #${id}</h3>
      <label class="muted">会员 ID（逗号分隔，如 1,2,3）</label>
      <input id="iMids" style="width:100%; margin-top:6px">
      <div class="bar" style="margin-top:12px">
        <button class="btn pri" id="iGo">发放</button>
      </div><div class="muted" id="iTip" style="margin-top:8px"></div></div>`;
    document.body.appendChild(mask);
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    mask.querySelector('#iGo').onclick = async () => {
      const mids = mask.querySelector('#iMids').value.split(',').map(s => Number(s.trim())).filter(n => n > 0);
      if (!mids.length) return;
      try {
        const d = await must(post(`/coupons/${id}/issue`, { memberIds: mids }));
        mask.querySelector('#iTip').textContent = `✅ 已发 ${d.issued} 张，跳过 ${d.skipped ?? 0} 张（限领/重复）`;
        setTimeout(() => { mask.remove(); list(); }, 1000);
      } catch { /* toast 已提示 */ }
    };
  }

  await list();
}
