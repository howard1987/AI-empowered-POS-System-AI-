import { get, post, must, money, esc, dt, toast } from '../api.js';

/** 优惠券：POST/GET /coupons、POST /coupons/:id/issue、POST /coupons/expire-scan、POST /coupons/:id/status */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>创建券模板 </h3>
      <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));border:1px dashed var(--line);border-radius:10px;margin:0 18px;padding:12px 14px">
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">券名称</label>
          <input id="cName" style="width:100%" placeholder="如：满50减5"><div class="muted" style="font-size:10.5px">展示给顾客的券名</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">券类型</label>
          <select id="cType" style="width:100%">${['满减券', '折扣券', '兑换券', '次卡'].map(t => `<option>${t}</option>`).join('')}</select>
          <div class="muted" style="font-size:10.5px">决定面额的换算口径</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">使用门槛（满减）</label>
          <input id="cThr" type="number" step="0.01" style="width:100%" placeholder="如 50">
          <div class="muted" style="font-size:10.5px">满 X 元可用，其他类型可留空</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">面额 / 折扣率</label>
          <input id="cDis" type="number" step="0.01" style="width:100%" placeholder="满减=元 / 折扣=0.8">
          <div class="muted" style="font-size:10.5px">满减填减扣元数；折扣 0.8=8 折</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">有效天数</label>
          <input id="cDays" type="number" style="width:100%" value="30">
          <div class="muted" style="font-size:10.5px">自领取日起 N 天内有效</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">每人限领（张）</label>
          <input id="cPer" type="number" style="width:100%" value="1">
          <div class="muted" style="font-size:10.5px">防一人囤券，默认 1 张</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">总量池（张，选填）</label>
          <input id="cQty" type="number" style="width:100%" placeholder="留空=不限量">
          <div class="muted" style="font-size:10.5px">全店发放上限，控制成本</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px"><label style="min-width:0;text-align:left">大类码（选填）</label>
          <input id="cCode" style="width:100%" placeholder="留空自动生成">
          <div class="muted" style="font-size:10.5px">营销精确匹配键；留空按类型生成（MJ/ZK/DH/CK-日期-序号）</div></div>
        <div class="fld" style="flex-direction:column;align-items:flex-start;gap:2px;justify-content:flex-end">
          <button class="btn pri" id="cSave" style="width:100%">创建</button></div>
      </div>
      <div class="doc-tip" style="margin:10px 18px 0">💡 <b>每人限领</b>：单个会员最多能领几张（默认 1 张）。<b>总量池</b>：这批券全店最多发出去多少张，留空=不限量（如发 200 张预算可控）。<b>有效天数</b>：从领券当天起算 N 天内有效。</div>
    </div>
    <div class="card">
      <h3>券列表（含核销统计）
        <input id="cKw" placeholder="搜索名称/大类码" style="margin-left:12px;width:180px">
        <button class="btn" id="cScan" style="margin-left:8px">执行过期扫描</button></h3>
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
      code: view.querySelector('#cCode').value.trim() || undefined,
    }), '券模板已创建');
    view.querySelector('#cCode').value = '';
    view.querySelector('#cName').value = '';
    await list();
  };
  view.querySelector('#cScan').onclick = async () => {
    const d = await must(post('/coupons/expire-scan'), '扫描完成');
    toast(`过期 ${d.expired} 张`);
    await list();
  };

  async function list() {
    const all = await must(get('/coupons')).catch(() => []);
    // V5.0.2：列表搜索（名称/大类码）；后端已按创建时间新→旧排序
    const kw = (view.querySelector('#cKw')?.value || '').trim().toLowerCase();
    const rows = kw ? all.filter(c => String(c.name || '').toLowerCase().includes(kw) || String(c.code || '').toLowerCase().includes(kw)) : all;
    view.querySelector('#cKw').oninput = () => { clearTimeout(list._t); list._t = setTimeout(list, 250); };
    view.querySelector('#clist').innerHTML = rows.length ? `
      <table><thead><tr><th>ID</th><th>大类码</th><th>名称</th><th>类型</th><th class="num">门槛</th><th class="num">面额/折扣</th>
        <th class="num">在库</th><th class="num">未使用</th><th class="num">已核销</th><th class="num">已过期</th><th class="num">作废</th><th>创建时间</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows.map(c => `<tr>
        <td>${c.id}</td><td><code>${esc(c.code || '')}</code></td><td>${esc(c.name)}</td><td>${esc(c.type)}</td>
        <td class="num">${c.threshold ? money(c.threshold) : '—'}</td>
        <td class="num">${c.type === '折扣券' ? Number(c.discount) + ' 折率' : c.discount ? money(c.discount) : '—'}</td>
        <td class="num">${c.stock_controlled ? (Number(c.in_stock) ?? '—') : '不限'}</td>
        <td class="num">${c.unused_count}</td><td class="num">${c.used_count}</td><td class="num">${c.expired_count}</td><td class="num">${c.voided_count}</td>
        <td class="muted">${c.created_at ? dt(c.created_at) : '—'}</td>
        <td>${c.status === 1 ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
        <td>
          <button class="btn sm" data-id="${c.id}" data-inst>券包/退券</button>
          <button class="btn sm" data-id="${c.id}" data-issue>发券</button>
          ${c.status === 1 ? `<button class="btn sm warn" data-id="${c.id}" data-stop>停用</button>` : `<button class="btn sm pri" data-id="${c.id}" data-start>启用</button>`}
        </td></tr>`).join('')}</tbody></table>` : '<div class="empty">无券模板</div>';

    view.querySelectorAll('[data-inst]').forEach(b => {
      const c = rows.find(r => r.id == b.dataset.id);
      b.onclick = () => instances(b.dataset.id, c?.code, c?.name);
    });
    view.querySelectorAll('[data-issue]').forEach(b => {
      const c = rows.find(r => r.id == b.dataset.id);
      b.onclick = () => issue(b.dataset.id, c?.per_member);
    });
    view.querySelectorAll('[data-stop]').forEach(b => b.onclick = async () => {
      await must(post(`/coupons/${b.dataset.id}/status`, { status: 0 }), '已停用'); await list();
    });
    view.querySelectorAll('[data-start]').forEach(b => b.onclick = async () => {
      await must(post(`/coupons/${b.dataset.id}/status`, { status: 1 }), '已启用'); await list();
    });
  }

  /** 发券：会员关键字查询 + 结果多选框选；勾选跨查询保留，直到「发放」成功后释放
   *  V5.0.3：支持每人多张（≤限领；限领 1 张时数量框无效） */
  function issue(id, perMember) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const picked = new Map();   // memberId -> {id,name,phone,card_no}
    mask.innerHTML = `<div class="modal" style="width:600px;height:min(82vh,700px);display:flex;flex-direction:column">
      <h3 style="flex:none">发券 <span class="muted" style="font-size:12px;font-weight:400">勾选会员发放；输入即查，勾选保留至发放</span></h3>
      <div class="bar" style="flex-wrap:nowrap;flex:none">
        <input id="iKw" placeholder="会员号/手机号/姓名/拼音码，回车查询" style="flex:1">
        <button class="btn" id="iSearch">查询</button>
      </div>
      <div class="bar" style="flex-wrap:nowrap;margin-top:6px;flex:none">
        <input id="iMids" placeholder="或直接输入会员ID（逗号分隔，如 1,2,3）" style="flex:1">
      </div>
      <div class="bar" style="font-size:11.5px;margin:8px 0 4px;flex:none;align-items:center">
        <span>勾选会员（可多次查询累加，勾选保留至发放）· 已选 <b id="iCnt">0</b> 人</span>
        <button class="btn sm ghost" id="iClear" style="margin-left:auto">清空已选</button>
      </div>
      <div id="iRes" style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:2px 6px"></div>
      <div class="bar" style="margin-top:10px;flex:none;justify-content:flex-end;align-items:center">
        <span class="muted" style="font-size:11.5px;margin-right:4px">每人</span>
        <input id="iQty" type="number" min="1" step="1" value="1" style="width:64px"
          ${Number(perMember) > 1 ? `max="${Number(perMember)}" title="该券每人限领 ${Number(perMember)} 张，可发多张"` : 'disabled title="该券每人限领 1 张，数量无效"'}>
        <span class="muted" style="font-size:11.5px;margin-right:10px">张</span>
        <button class="btn pri" id="iGo">发放</button>
      </div><div class="muted" id="iTip" style="margin-top:6px;flex:none"></div></div>`;
    document.body.appendChild(mask);
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    const $ = s => mask.querySelector(s);
    const paintPicked = () => {
      $('#iCnt').textContent = String(picked.size);
      $('#iPickedBox')?.remove();
      if (!picked.size) return;
      const box = document.createElement('div');
      box.id = 'iPickedBox';
      box.style.cssText = 'flex:none;display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;max-height:72px;overflow:auto';
      box.innerHTML = [...picked.values()].map(m =>
        `<span class="tag b" style="cursor:pointer" data-unpick="${m.id}" title="点击移除">${esc(m.name || ('#' + m.id))}${m.phone ? ' ' + esc(m.phone) : ''} ✕</span>`).join('');
      $('#iTip').before(box);
      box.querySelectorAll('[data-unpick]').forEach(t => t.onclick = () => { picked.delete(Number(t.dataset.unpick)); paintPicked(); syncChecks(); });
    };
    const syncChecks = () => $('#iRes').querySelectorAll('[data-mid]').forEach(cb => { cb.checked = picked.has(Number(cb.dataset.mid)); });
    const search = async () => {
      const kw = encodeURIComponent($('#iKw').value.trim());
      const d = await must(get('/members?keyword=' + kw + '&size=50&page=1')).catch(() => null);
      const items = d?.items || [];
      $('#iRes').innerHTML = items.length ? `<table><tbody>${items.map(m => `
        <tr><td style="width:26px"><input type="checkbox" data-mid="${m.id}" ${picked.has(Number(m.id)) ? 'checked' : ''}></td>
        <td>${m.id}</td><td><b>${esc(m.name || '—')}</b></td><td class="muted">${esc(m.phone || '')}</td><td class="muted">${esc(m.card_no || '')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">无匹配会员</div>';
      $('#iRes').querySelectorAll('[data-mid]').forEach(cb => cb.onchange = () => {
        const mid = Number(cb.dataset.mid);
        if (cb.checked) { const m = items.find(x => Number(x.id) === mid); if (m) picked.set(mid, m); }
        else picked.delete(mid);
        paintPicked();
      });
    };
    $('#iSearch').onclick = search;
    $('#iKw').onkeydown = e => { if (e.key === 'Enter') search(); };
    // V5.0.2：两个输入框输入即自动模糊查询（300ms 防抖），查询按钮兜底；打开时默认列出全部会员
    $('#iKw').oninput = () => { clearTimeout(issue._t); issue._t = setTimeout(search, 300); };
    $('#iMids').oninput = () => { clearTimeout(issue._t2); issue._t2 = setTimeout(search, 300); };
    $('#iClear').onclick = () => { picked.clear(); paintPicked(); syncChecks(); };
    $('#iGo').onclick = async () => {
      // 合并：勾选会员 + 手工输入ID（去重）
      const mids = new Set(picked.keys());
      $('#iMids').value.split(',').map(s => Number(s.trim())).filter(n => n > 0).forEach(n => mids.add(n));
      if (!mids.size) { toast('请先勾选或输入会员', false); return; }
      try {
        const d = await must(post(`/coupons/${id}/issue`, { memberIds: [...mids], qty: Number($('#iQty')?.value) || 1 }));
        $('#iTip').textContent = `✅ 已发 ${d.issued} 张，跳过 ${d.skipped ?? 0} 张（限领/重复）`;
        picked.clear(); paintPicked(); $('#iMids').value = '';   // 发放成功后释放勾选
        setTimeout(() => { mask.remove(); list(); }, 1000);
      } catch { /* toast 已提示 */ }
    };
    setTimeout(() => { search(); $('#iKw').focus(); }, 60);
  }

  /** 券实例（会员小码）列表：溯源 + 退券（仅未使用，一次性商品不退已用券） */
  async function instances(id, code, name) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    // V5.0.1：历史数据状态/来源可能存英文枚举——展示层统一映射中文
    const ST = s => ({ unused: '未使用', used: '已使用', expired: '已过期', voided: '已作废', pending_order: '待处理' }[s] || s);
    const SRC = s => ({ issue: '发放', batch: '批量发放', admin: '后台', promo: '促销活动', order: '消费赠券' }[s] || s);
    mask.innerHTML = `<div class="modal" style="width:860px;height:min(82vh,760px);display:flex;flex-direction:column">
      <h3 style="flex:none;line-height:1.3">${esc(name || '券实例')}${code ? `<div class="muted" style="font-size:11px;font-weight:400;margin-top:2px">大类码 <code>${esc(code)}</code> · 发放流水</div>` : ''}
      <span style="display:inline-flex;gap:8px;align-items:center;margin-left:14px">
        <select id="iStatus"><option value="">全部状态</option><option>未使用</option><option>已使用</option><option>已过期</option><option>已作废</option></select>
        <input id="iMkw" placeholder="搜会员名/电话/小码" style="width:170px">
        <span class="muted">一次性商品：已使用/已过期不退券</span>
      </span></h3>
      <div id="iList" class="pg-host" style="flex:1;max-height:none"></div></div>`;
    document.body.appendChild(mask);
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    let cache = [];
    const load = async () => {
      const st = mask.querySelector('#iStatus').value;
      cache = await must(get(`/coupons/${id}/instances?status=${encodeURIComponent(st)}`)).catch(() => []);
      paint();
    };
    const paint = () => {
      // V5.0.2：会员搜索框快速定位（名称/电话/小码），便于找到目标会员退券
      const kw = (mask.querySelector('#iMkw')?.value || '').trim().toLowerCase();
      const rows = kw ? cache.filter(r =>
        String(r.member_name || '').toLowerCase().includes(kw) ||
        String(r.member_phone || '').includes(kw) ||
        String(r.code || '').toLowerCase().includes(kw)) : cache;
      mask.querySelector('#iList').innerHTML = rows.length ? `
        <table><thead><tr><th>小码</th><th>会员</th><th>状态</th><th>来源</th><th>领取时间</th><th>使用时间</th><th>关联单据</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td><code>${esc(r.code || '')}</code></td>
          <td>${esc(r.member_name || '')}${r.member_phone ? `<span class="muted"> ${esc(r.member_phone)}</span>` : ''}</td>
          <td>${esc(ST(r.status))}</td><td>${esc(SRC(r.issue_source || ''))}</td>
          <td>${r.received_at ? dt(r.received_at) : '—'}</td>
          <td>${r.used_at ? dt(r.used_at) : '—'}</td>
          <td>${r.used_order_id ? '#' + r.used_order_id : '—'}</td>
          <td>${['未使用', 'unused'].includes(r.status) ? `<button class="btn sm warn" data-void="${r.id}">退券</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">无券实例</div>';
      mask.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
        if (!confirm('确认退券（商家召回，仅未使用券可退；一次性商品不退已用券）？')) return;
        try { await must(post(`/coupons/${id}/void`, { memberCouponId: Number(b.dataset.void) }), '已退券'); await load(); await list(); }
        catch { /* toast 已提示 */ }
      });
    };
    mask.querySelector('#iStatus').onchange = load;
    mask.querySelector('#iMkw').oninput = () => { clearTimeout(instances._t); instances._t = setTimeout(paint, 200); };
    await load();
  }

  await list();
}
