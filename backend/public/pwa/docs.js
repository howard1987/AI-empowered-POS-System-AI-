'use strict';
/* 员工移动端 PWA · 单据 / 消息（docs.js）V4.9.10
 * 单据：入库/退货/盘点/报损列表（全店/我的范围切换），点行进明细页
 * 明细：调 GET …/:id 渲染明细表格；有权限者在待审状态可直接 通过 / 驳回（与后台同口径、同留痕）
 * 消息：待办统计（待审核入库、待审核退货、进行中盘点、待审核报损、临期预警）→ 点击跳单据 */

const DOC_TYPES = ['all', 'in', 'ret', 'count', 'loss'];
const DOC_NAMES = { all: '全部', in: '入库', ret: '退货', count: '盘点', loss: '报损' };
const DOC_ICONS = { in: '📦', ret: '↩️', count: '🧮', loss: '📷' };

/* 单据类型元数据（详情接口 / 通过 / 驳回 / 所需权限点），与 boss 端同口径 */
const DOC_META = {
  in: { icon: '📦', name: '采购入库', perm: 'stock.inbound.audit', biz: 'inbound',
        detail: id => `/purchase/inbounds/${id}`,
        pass: id => ['POST', `/purchase/inbounds/${id}/audit`, undefined], reject: id => `/purchase/inbounds/${id}/reject`,
        amount: o => o.total_amount, no: o => o.inbound_no },
  ret: { icon: '↩️', name: '采购退货', perm: 'stock.return.audit', biz: 'return',
        detail: id => `/purchase/returns/${id}`,
        pass: id => ['POST', `/purchase/returns/${id}/audit`, undefined], reject: id => `/purchase/returns/${id}/reject`,
        amount: o => o.total_amount ?? o.amount, no: o => o.return_no },
  count: { icon: '🧮', name: '盘点单', perm: 'stock.count.audit', biz: 'count',
        detail: id => `/inventory/counts/${id}`,
        pass: id => ['POST', `/inventory/counts/${id}/audit`, undefined], reject: id => `/inventory/counts/${id}/reject`,
        amount: () => null, no: o => o.count_no },
  loss: { icon: '📷', name: '报损单', perm: 'stock.loss.create', biz: 'loss',
        detail: id => `/inventory/losses/${id}`,
        pass: id => ['POST', `/inventory/losses/${id}/audit`, undefined], reject: id => `/inventory/losses/${id}/reject`,
        amount: o => o.total_cost, no: o => o.loss_no },
};
const DOC_ACTIONABLE = ['未审核', '待审核', '草稿', '进行中', '待差异处理'];

function statusPill(st) {
  const s = String(st || '');
  // V4.13.9 B7：未审核/待审红色，已审核/已完成绿色（优先判定）
  if (/未审核|待审核|待差异/.test(s)) return `<span class="pill red">${esc(s)}</span>`;
  if (/已审核|已完成|已预审/.test(s)) return `<span class="pill green">${esc(s)}</span>`;
  const cls = s.includes('审核') || s.includes('预审') || s === '进行中' ? 'orange'
    : s.includes('取消') || s.includes('作废') ? 'red' : 'blue';
  return `<span class="pill ${cls}">${esc(s)}</span>`;
}

/* 简易明细表格（pwa 无 boss 端 tbl helper，此处内联实现） */
function docTbl(head, rows, foot) {
  return `<div class="card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>${head.map(h => `<th style="text-align:left;padding:8px 10px;color:var(--ink-3);font-weight:600;border-bottom:1px solid var(--line);white-space:nowrap">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td style="padding:8px 10px;border-bottom:1px solid var(--line);${i === 0 ? '' : 'white-space:nowrap;text-align:right'}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
    ${foot ? `<tfoot><tr>${foot.map((c, i) => `<td style="padding:8px 10px;font-weight:700;${i === 0 ? '' : 'white-space:nowrap;text-align:right'}">${c}</td>`).join('')}</tr></tfoot>` : ''}
  </table></div>`;
}

// ── 单据 Tab（arg = 类型筛选，来自消息页跳转）──
View.docs = async function (v, arg) {
  const filter = DOC_TYPES.includes(arg) ? arg : 'all';
  // 范围：有审核权限者默认全店（可切"我的"）；普通员工默认我的（单据列表本身即全店返回）
  const canAuditAny = DOC_META && Object.values(DOC_META).some(m => hasPerm(m.perm));
  const scopeKey = 'pwa_doc_scope';
  const scope = localStorage.getItem(scopeKey) || (canAuditAny ? 'store' : 'mine');
  v.innerHTML = `
    <div class="chips" id="docChips">
      ${DOC_TYPES.map(t => `<button class="chip ${t === filter ? 'on' : ''}" data-f="${t}">${DOC_NAMES[t]}</button>`).join('')}
    </div>
    <div class="chips" id="docScope" style="margin-top:6px">
      <button class="chip ${scope === 'store' ? 'on' : ''}" data-s="store">🏬 全店单据</button>
      <button class="chip ${scope === 'mine' ? 'on' : ''}" data-s="mine">👤 我经手的</button>
    </div>
    <div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap" id="docSearch">
      <input id="docSup" class="search" placeholder="供应商关键字" style="flex:2;min-width:120px;padding:8px 10px;font-size:13px" autocomplete="off">
      <input id="docFrom" type="date" class="search" style="flex:1;min-width:110px;padding:8px 6px;font-size:13px" autocomplete="off">
      <input id="docTo" type="date" class="search" style="flex:1;min-width:110px;padding:8px 6px;font-size:13px" autocomplete="off">
      ${canAuditAny ? `<input id="docOp" class="search" placeholder="操作人" style="flex:1;min-width:90px;padding:8px 10px;font-size:13px" autocomplete="off">` : ''}
    </div>
    <div id="docList"><div class="empty">加载中…</div></div>`;
  v.querySelectorAll('#docChips .chip').forEach(c => c.onclick = () => openTab('docs', c.dataset.f));
  v.querySelectorAll('#docScope .chip').forEach(c => c.onclick = () => {
    localStorage.setItem(scopeKey, c.dataset.s);
    View.docs(v, filter);
  });
  const box = $('#docList');
  const rows = [];
  try {
    const [inbs, rets, cnts, loss] = await Promise.all([
      call('GET', '/purchase/inbounds'),
      call('GET', '/purchase/returns'),
      call('GET', '/inventory/counts'),
      call('GET', '/inventory/losses'),
    ]);
    const mine = r => scope === 'store' || Number(r.employee_id) === ME.staffId;
    unwrap(inbs).forEach(r => mine(r) && rows.push({
      type: 'in', id: Number(r.id), no: r.inbound_no, name: r.supplier_name,
      status: r.status, time: r.created_at, extra: `${r.item_count ?? 0} 项`, operator: r.maker_name || '',
    }));
    unwrap(rets).forEach(r => mine(r) && rows.push({
      type: 'ret', id: Number(r.id), no: r.return_no, name: r.supplier_name,
      status: r.status, time: r.created_at, extra: `${r.item_count ?? 0} 项` + (r.evidence_path ? ' · 📷已传' : ' · ⚠️未传凭证'), operator: r.maker_name || '',
    }));
    unwrap(cnts).forEach(r => mine(r) && rows.push({
      type: 'count', id: Number(r.id), no: r.count_no, name: r.scope || '全仓',
      status: r.status, time: r.created_at, extra: `${r.item_count ?? 0} 项` + (r.diff_sum ? ` · 差异 ${r.diff_sum}` : ''), operator: r.employee_name || '',
    }));
    unwrap(loss).forEach(r => mine(r) && rows.push({
      type: 'loss', id: Number(r.id), no: r.loss_no, name: r.reason_type || '',
      status: r.status, time: r.created_at, extra: `${r.item_count ?? 0} 项`, operator: r.employee_name || '',
    }));
  } catch (e) {
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    return;
  }
  // V4.13.9 B7：未审核单据排前（同组内按时间倒序）；已审核单据在后
  const pendingFirst = r => /未审核|待审核|草稿|进行中|待差异/.test(String(r.status || '')) ? 0 : 1;
  rows.sort((a, b) => (pendingFirst(a) - pendingFirst(b)) || (new Date(b.time) - new Date(a.time)));
  const shown = filter === 'all' ? rows : rows.filter(r => r.type === filter);
  // V4.13.9 B7：供应商 / 日期范围 / 操作人（仅管理员店长可见）过滤
  const supKw = ($('#docSup')?.value || '').trim().toLowerCase();
  const fromD = $('#docFrom')?.value || '';
  const toD = $('#docTo')?.value || '';
  const opKw = ($('#docOp')?.value || '').trim().toLowerCase();
  const shownFiltered = shown.filter(r =>
    (!supKw || String(r.name || '').toLowerCase().includes(supKw)) &&
    (!fromD || String(r.time).slice(0, 10) >= fromD) &&
    (!toD || String(r.time).slice(0, 10) <= toD) &&
    (!opKw || String(r.operator || '').toLowerCase().includes(opKw)));
  ['docSup', 'docOp'].forEach(id => { const el = $('#' + id); if (el) el.oninput = () => View.docs(v, filter); });
  ['docFrom', 'docTo'].forEach(id => { const el = $('#' + id); if (el) el.onchange = () => View.docs(v, filter); });
  if (!shownFiltered.length) {
    box.innerHTML = `<div class="empty">暂无${DOC_NAMES[filter]}单据${supKw || fromD || toD || opKw ? '（可调整搜索条件）' : scope === 'mine' ? '<br>（仅显示我经手的，可切「全店」）' : ''}</div>`;
    return;
  }
  box.innerHTML = shownFiltered.map((r, i) => `
    <div class="row" data-di="${i}">
      <div style="font-size:20px">${DOC_ICONS[r.type]}</div>
      <div class="grow">
        <div class="t">${esc(r.no)} ${statusPill(r.status)}</div>
        <div class="s">${DOC_NAMES[r.type]} · ${esc(r.name || '')} · ${esc(r.extra)}${r.operator ? ' · 操作人 ' + esc(r.operator) : ''}<br>${dt(r.time)}</div>
      </div>
      <span class="pill gray">明细 ›</span>
    </div>`).join('');
  box.querySelectorAll('[data-di]').forEach(el => el.onclick = () => {
    const r = shownFiltered[Number(el.dataset.di)];
    push(DOC_META[r.type].name + '明细', View.docDetail, { type: r.type, id: r.id, from: filter });
  });
};

// ── 单据明细 + 通过 / 驳回（与 boss 端同口径：同接口、同留痕）──
View.docDetail = async function (v, arg) {
  const meta = DOC_META[arg.type];
  v.innerHTML = '<div class="empty">加载中…</div>';
  let d;
  try { d = await call('GET', meta.detail(arg.id)); }
  catch (e) { v.innerHTML = `<div class="empty">明细加载失败：${esc(e.message)}</div>`; return; }
  const o = d.order || d;
  const items = d.items || [];
  const canAct = DOC_ACTIONABLE.includes(o.status) && hasPerm(meta.perm);
  const dt2 = s => s ? String(s).slice(0, 16).replace('T', ' ') : '—';
  const rows = items.map(it => {
    const qty = Number(it.qty ?? it.arrived_qty ?? 0);
    const price = Number(it.unit_cost ?? it.price ?? it.unit_price ?? 0);
    if (arg.type === 'count') {
      const diff = Number(it.actual_qty ?? 0) - Number(it.book_qty ?? it.system_qty ?? 0);
      return [esc(it.product_name), `${money(it.book_qty ?? it.system_qty ?? 0)} → ${money(it.actual_qty ?? 0)}`,
        `<span style="color:${diff ? 'var(--warn, #e6a23c)' : 'inherit'}">${money(diff)}</span>`, '', ''];
    }
    return [esc(it.product_name), money(qty), esc(it.batch_no || '—'), money(price), money(qty * price)];
  });
  const head = arg.type === 'count'
    ? ['商品', '账面→实盘', '差异', '', '']
    : ['商品', '数量', '批次', '单价', '金额'];
  v.innerHTML = `
    <div class="card">
      <div class="kv"><span class="k">单号</span><span class="v">${esc(meta.no(o))}</span></div>
      <div class="kv"><span class="k">类型</span><span class="v">${meta.icon} ${meta.name}</span></div>
      ${o.supplier_name ? `<div class="kv"><span class="k">供应商</span><span class="v">${esc(o.supplier_name)}</span></div>` : ''}
      <div class="kv"><span class="k">状态</span><span class="v"><span class="pill ${DOC_ACTIONABLE.includes(o.status) ? 'orange' : 'green'}">${esc(o.status)}</span></span></div>
      ${meta.amount(o) != null ? `<div class="kv"><span class="k">金额</span><span class="v num">¥${money(meta.amount(o))}</span></div>` : ''}
      ${o.employee_name || o.maker_name ? `<div class="kv"><span class="k">制单人</span><span class="v">${esc(o.employee_name || o.maker_name)}</span></div>` : ''}
      <div class="kv"><span class="k">创建时间</span><span class="v">${esc(dt2(o.created_at))}</span></div>
      ${o.remark ? `<div class="kv"><span class="k">备注</span><span class="v">${esc(o.remark)}</span></div>` : ''}
      ${o.reject_reason ? `<div class="kv"><span class="k">驳回原因</span><span class="v" style="color:var(--bad)">${esc(o.reject_reason)}</span></div>` : ''}
    </div>
    <div class="sec">明细（${items.length} 项）</div>
    ${items.length ? docTbl(head, rows, ['合计', '', '', '', '¥' + money(meta.amount(o) ?? 0)])
      : '<div class="empty">该单据暂无明细数据</div>'}
    ${o.evidence_path ? `<div class="sec">退货凭证</div><div class="card"><img src="${esc(o.evidence_path)}" style="width:100%;border-radius:10px"></div>` : ''}
    ${o.photo_path ? `<div class="sec">报损照片</div><div class="card"><img src="${esc(o.photo_path)}" style="width:100%;border-radius:10px"></div>` : ''}
    <div class="sec">✍️ 电子签名</div>
    <div id="ddSignBox"><div class="empty">签名加载中…</div></div>
    ${DOC_ACTIONABLE.includes(o.status)
      ? (canAct ? `<div class="acts">
          <button class="btn bad" id="ddReject">✖ 驳回</button>
          <button class="btn" id="ddPass">✔ 通过</button>
        </div><div class="hint">通过后单据按后台同口径生效并留痕${o.status === '草稿' ? '（草稿单请先核对明细与生产日期）' : ''}；驳回必须填原因，门店可整改重提。若按配置需电子签字，将弹出签名板补签后自动续审。</div>`
        : `<div class="hint">该单据待处理。您没有 ${meta.perm} 权限，请联系管理员审核。</div>`)
      : '<div class="hint">该单据已处理，无需再操作。</div>'}`;

  // V4.14.1：电子签名预览（调用记录证据链，含预采模板与现场补签）
  (async () => {
    const box = $('#ddSignBox');
    if (!box) return;
    try {
      const r = await call('GET', `/purchase/signature-records?bizType=${meta.biz}&bizId=${arg.id}`);
      const recs = (r.items || []).filter(s => s.image_path);
      if (!recs.length) { box.innerHTML = '<div class="empty">该单据暂无电子签名</div>'; return; }
      // V4.15.0：操作员/业务员 角色标签（与后台一致）
      const roleOf = s => s.role_label
        || ((s.scene === '操作员签名' || String(s.person_name || '') === String(s.operator_name || '')) ? '操作员' : '业务员');
      box.innerHTML = recs.map(s => `
        <div class="row">
          <div class="grow"><div class="t">✍️ ${esc(s.person_name || '—')} <span class="pill ${roleOf(s) === '操作员' ? 'blue' : 'green'}">${roleOf(s) === '操作员' ? '操作员（登录账号）' : '业务员'}</span></div>
            <div class="s">${esc(s.scene || '')} · ${esc(dt2(s.used_at || s.created_at))}</div></div>
          <img src="${esc(s.image_path)}" style="height:52px;border-radius:6px;background:#fff;border:1px solid var(--line)" onclick="this.style.height=this.style.height==='52px'?'140px':'52px'">
        </div>`).join('');
    } catch { box.innerHTML = '<div class="empty">签名加载失败</div>'; }
  })();

  const busy = b => { const p = $('#ddPass'), r = $('#ddReject'); if (p) p.disabled = b; if (r) r.disabled = b; };
  /* 通过审核；按"必签才能过审"配置（50018）自动弹签名板补签，签完自动续审（与后台同口径） */
  const doPass = async () => {
    busy(true);
    try {
      const [m, p, body] = meta.pass(arg.id);
      const r = await call(m, p, body);
      toast('✅ 已通过：' + (r.status || ''));
      stack.length = 0; openTab('docs', arg.type);
    } catch (e) {
      if (String(e.message).includes('尚未电子签字') && window.SignPad) {
        busy(false);
        toast('该单据未签字，请现场补签（签完自动继续审核）');
        window.SignPad.open({
          title: '补签 · ' + meta.no(o),
          defaultName: ME.name,
          roleTitle: '审核人',
          hint: '该单据按「必签才能过审」配置需电子签字；补签后自动继续审核',
          onSave: async sd => {
            try {
              await call('POST', '/purchase/signatures/attach', {
                bizType: meta.biz, bizId: arg.id, personName: sd.personName, roleTitle: sd.roleTitle, image: sd.image,
              });
              toast('签名已留痕，继续审核…');
              await doPass();
            } catch (e2) { toast(e2.message); }
          },
        });
        return;
      }
      toast(e.message);
      busy(false);
    }
  };
  $('#ddPass') && ($('#ddPass').onclick = async () => {
    // V4.14.2：原生 confirm → 样式化底部弹窗（与 PWA 整体风格一致）
    const yes = await pwaConfirm('确认通过', `确认通过 <b>${esc(meta.no(o))}</b>？通过后单据生效且不可撤销。`, { okText: '✔ 通过' });
    if (!yes) return;
    await doPass();
  });
  $('#ddReject') && ($('#ddReject').onclick = async () => {
    const reason = await pwaPrompt('驳回原因', '必填，将留痕并可被门店查看', { okText: '✖ 驳回', danger: true, hint: '驳回后门店可整改重提。' });
    if (!reason || !reason.trim()) { toast('驳回必须填写原因'); return; }
    busy(true);
    try {
      await call('POST', meta.reject(arg.id), { reason: reason.trim() });
      toast('已驳回');
      stack.length = 0; openTab('docs', arg.type);
    } catch (e) { toast(e.message); busy(false); }
  });
};

// ── 消息 Tab：待办审批 + 临期预警 ──
View.msg = async function (v) {
  v.innerHTML = `<div class="sec">待办</div><div id="msgTodo"><div class="empty">加载中…</div></div>
    <div class="sec">退货凭证补拍（店长/店员）</div><div id="msgEvi"><div class="empty">加载中…</div></div>
    <div class="sec">临期预警（批次）</div><div id="msgExp"><div class="empty">加载中…</div></div>`;
  const todo = $('#msgTodo');
  const items = [];
  const addTodo = (label, n, type, sub) => n > 0 && items.push({ label, n, type, sub });
  try {
    const [inb, ret, cnt, loss, exp] = await Promise.all([
      call('GET', '/purchase/inbounds?status=' + encodeURIComponent('未审核')),
      call('GET', '/purchase/returns'),
      call('GET', '/inventory/counts?status=' + encodeURIComponent('进行中')),
      call('GET', '/inventory/losses?status=' + encodeURIComponent('待审核')),
      call('GET', '/inventory/expiry-alerts'),
    ]);
    addTodo('待审核入库单', unwrap(inb).length, 'in');
    addTodo('待审核退货单', unwrap(ret).filter(r => r.status === '待审核').length, 'ret');
    addTodo('进行中盘点单', unwrap(cnt).length, 'count');
    addTodo('待审核报损单', unwrap(loss).length, 'loss');
    if (!items.length) todo.innerHTML = '<div class="empty">暂无待办</div>';
    else todo.innerHTML = items.map(it => `
      <div class="row" data-t="${it.type}">
        <div class="grow"><div class="t">${esc(it.label)}</div></div>
        <span class="pill ${it.n > 0 ? 'red' : 'gray'}">${it.n}</span>
      </div>`).join('');
    todo.querySelectorAll('[data-t]').forEach(el => el.onclick = () => openTab('docs', el.dataset.t));
    const eb = $('#msgExp');
    const exps = unwrap(exp);
    if (!exps.length) eb.innerHTML = '<div class="empty">近期无临期批次</div>';
    else eb.innerHTML = exps.map(e => {
      const dl = e.deadline_at ? dt(e.deadline_at) : '';
      const overdue = e.penalized && e.disposal_status !== '已退换';
      const st = e.disposal_status === '已退换' ? '<span class="pill green">已退/换货</span>'
        : e.disposal_status === '处理中' ? '<span class="pill blue">处理中</span>'
        : '<span class="pill red">未处理</span>';
      return `
      <div class="row">
        <div class="grow">
          <div class="t">${esc(e.product_name)} <span class="pill ${e.warn_level === '橙' ? 'red' : 'yellow'}">${e.warn_level}·剩${e.days_left}天</span> ${st}${overdue ? '<span class="pill red">⚠超时</span>' : ''}</div>
          <div class="s">批次 ${esc(e.batch_no)} · ${e.remain_qty}${esc(e.base_unit || '')} · 到期 ${e.expiry_date ? String(e.expiry_date).slice(0, 10) : ''}<br>处置时限：${dl}${e.return_doc_no ? ' · 关联单 ' + esc(e.return_doc_no) : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex:none">
          ${e.disposal_status === '未处理' ? `<button class="btn ghost" style="width:auto;padding:8px 12px;font-size:13px" data-dstart="${e.batch_id}">开始处置</button>` : ''}
          ${e.disposal_status !== '已退换' ? `<button class="btn" style="width:auto;padding:8px 12px;font-size:13px" data-ddone="${e.batch_id}">完成退/换货</button>` : ''}
        </div>
      </div>`;
    }).join('');
    // 临期处置：开始 / 到位（退/换货流程完成即到位；退货审核通过后台自动联动）
    eb.querySelectorAll('[data-dstart]').forEach(b => b.onclick = async () => {
      const r = await call('POST', '/inventory/expiry-disposals/' + b.dataset.dstart + '/start', {});
      toast('已开始处置，请在时限内完成退/换货');
      View.msg(v);
    });
    eb.querySelectorAll('[data-ddone]').forEach(b => b.onclick = async () => {
      const no = prompt('关联退/换货单号（选填，如 TH-20260907-001）：') || '';
      await call('POST', '/inventory/expiry-disposals/' + b.dataset.ddone + '/done', { returnDocNo: no.trim() || undefined });
      toast('处置到位（已退/换货）');
      View.msg(v);
    });
    // V4.9.5 退货凭证补拍：PC 端派单（或全部待审核无凭证单）→ 手机摄像头拍摄上传回传
    const eviBox = $('#msgEvi');
    try {
      const evi = unwrap(await call('GET', '/purchase/returns/pending-evidence'));
      if (!evi.length) eviBox.innerHTML = '<div class="empty">暂无待补拍凭证</div>';
      else eviBox.innerHTML = evi.map(r => `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(r.return_no)} <span class="pill yellow">待补凭证</span></div>
            <div class="s">${esc(r.supplier_name || '')} · ${r.item_count} 项 · ${dt(r.created_at)}</div>
          </div>
          <button class="btn" style="width:auto;padding:8px 12px;font-size:13px" data-evi="${r.id}">📷 拍摄回传</button>
        </div>`).join('');
      eviBox.querySelectorAll('[data-evi]').forEach(b => b.onclick = () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
        inp.onchange = async () => {
          const f = inp.files[0];
          if (!f) return;
          if (f.size > 8 * 1024 * 1024) { toast('凭证图片不能超过 8MB'); return; }
          try {
            const dataUrl = await new Promise((res, rej) => {
              const rd = new FileReader();
              rd.onload = () => res(rd.result); rd.onerror = () => rej(new Error('读取失败'));
              rd.readAsDataURL(f);
            });
            const up = await call('POST', '/upload', { image: dataUrl });
            await call('POST', '/purchase/returns/' + b.dataset.evi + '/evidence', { evidencePath: up.data?.path || up.path });
            toast('✅ 凭证已回传（PC 端可见）');
            View.msg(v);
          } catch (e) { toast(e.message || '回传失败'); }
        };
        inp.click();
      });
    } catch { eviBox.innerHTML = '<div class="empty">补拍清单加载失败</div>'; }
  } catch (e) {
    todo.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    $('#msgExp').innerHTML = '';
  }
};
