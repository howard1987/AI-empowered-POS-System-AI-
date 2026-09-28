import { API, get, post, must, money, esc, dt, toast } from '../api.js';

/** 联营对账（设计方案 5.7 / P2-3a）：已合并进「对账与结算」屏（recon.js 供应商判别联营后调用）
 *  看板（销售/环比/达标进度/TOP 商品/未结） → 预览（销售汇总+扣点保底+联营费用，可下钻小票） →
 *  生成 LC 对账单 → 确认（现场确认 + 电子签字） → 结算
 *  电子签字（5.6.8 / P2-3b）：预采集模板 + 现场手写补签 base64 落证据链 */
export async function renderConsign(host, opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  host.innerHTML = `
    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <span style="font-weight:700;font-size:14.5px">🤝 联营对账 <span class="pill b">P2-3a</span></span>
      <span class="muted">按联营商聚合销售 → 扣点/保底 → 联营费用 → 对账/确认/结算（5.7）</span>
      <span style="margin-left:auto" class="pill b" id="ccSupTag">—</span>
    </div>

    <div class="card">
      <div class="doc-tools">
        <span style="font-weight:700;font-size:14.5px">📈 联营商看板 </span>
        <input id="ccFrom" type="date" value="${monthStart}"><span class="muted">~</span><input id="ccTo" type="date" value="${today}">
        <button class="btn sm pri" id="ccOv">🔍 加载看板</button>
      </div>
      <div style="padding:10px 18px 16px" id="ccOvBox"><div class="empty">选择联营商后加载看板（销售额/环比/达标进度/扣点收益/TOP 商品）</div></div>
    </div>

    <div class="card">
      <h3>第一步 · 联营对账预览 </h3>
      <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
        <div class="fld"><label class="req">对账区间</label><input id="ccPFrom" type="date" style="width:130px" value="${monthStart}"><span style="color:var(--ink-3)">~</span><input id="ccPTo" type="date" style="width:130px" value="${today}"></div>
        <div class="fld"><label></label><button class="btn pri" id="ccPrev">🔍 加载待对账销售</button></div>
      </div>
      <div style="padding:0 18px 16px" id="ccPrevBox"><div class="empty">选择联营商与区间后加载（销售小票可下钻）</div></div>
    </div>

    <div class="card">
      <div class="doc-tools">
        <span style="font-weight:700;font-size:14.5px">📑 联营对账单（LC-）</span>
        <button class="btn sm" id="ccRefresh">刷新</button>
        <span class="muted" style="font-size:11.5px">同供应商同区间仅一张；作废释放小票可重建；确认支持电子签字</span>
      </div>
      <div style="padding:10px 18px 16px" id="ccList"></div>
    </div>

    <div class="card">
      <h3>✍️ 签字样本 / 调用记录 <span class="api">V4.14.2 迁至「系统 → 授权管理」</span></h3>
      <div style="padding:0 18px 16px" class="doc-tip">签字样本预采集与调用记录证据链已迁移到「系统 → 授权管理」标签页（此处确认弹窗仍可用预采样本免签）。</div>
    </div>

    <div class="modal-mask" id="ccFirmModal" style="display:none">
      <div class="modal">
        <h3>✅ 联营对账确认 </h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label class="req">确认方式</label>
            <select id="ccFirmType"><option>现场确认</option><option>单据签字</option><option>口头确认</option></select></div>
          <div class="fld"><label>确认人（供应商业务员）</label><input id="ccFirmName" placeholder="业务员姓名"></div>
          <div class="fld"><label>预采签字样本（选人自动带出）</label><select id="ccFirmTpl"><option value="">— 现场手写 —</option></select></div>
        </div>
        <div class="doc-tip">💡 现场确认建议业务员在下方签字板签字留底（预采样本选中即免签，手写则直存证据链）</div>
        <canvas id="ccFirmPad" width="560" height="170" style="border:1px dashed var(--line);border-radius:8px;touch-action:none;cursor:crosshair"></canvas>
        <div class="bar" style="margin-top:8px">
          <button class="btn sm" id="ccFirmClear">🧽 清除重签</button>
        </div>
        <div class="doc-foot">
          <button class="btn" id="ccFirmCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="ccFirmGo">✔ 确认对账单</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="ccDetModal" style="display:none">
      <div class="modal">
        <h3 id="ccDetTitle">联营对账单明细</h3>
        <div style="max-height:60vh;overflow:auto" id="ccDetBox"></div>
        <div class="doc-foot"></div>
      </div>
    </div>`;

  const fmt = n => (Number(n) || 0).toFixed(2);
  let curSup = Number(opts.supplierId) || 0;
  const supNow = (opts.suppliers || []).find(s => Number(s.id) === curSup);
  const tag = host.querySelector('#ccSupTag');
  if (tag) tag.textContent = '当前联营商：' + (supNow
    ? `${supNow.name}（扣点 ${supNow.deduction_rate ?? 0} · 保底 ${supNow.guarantee_min ?? '—'}）`
    : '—');

  /* ── 签字板通用 ── */
  function bindPad(pad) {
    const ctx = pad.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    let drawing = false, last = null;
    const pos = e => { const r = pad.getBoundingClientRect();
      return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
    pad.onpointerdown = e => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); };
    pad.onpointermove = e => { if (!drawing) return; const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; };
    pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
  }
  function padDirty(pad) {
    const d = pad.getContext('2d').getImageData(0, 0, pad.width, pad.height).data;
    return d.some(v => v !== 0);
  }
  function clearPad(pad) { pad.getContext('2d').clearRect(0, 0, pad.width, pad.height); }
  bindPad(host.querySelector('#ccFirmPad'));
  host.querySelector('#ccFirmClear').onclick = () => clearPad(host.querySelector('#ccFirmPad'));

  /* ── 供应商联动（仅联营，供应商由对账与结算页头传入） ─── */

  /* ── 看板 ── */
  async function drawOv() {
    const box = host.querySelector('#ccOvBox');
    if (!curSup) { box.innerHTML = '<div class="empty">先选联营商</div>'; return; }
    const d = await must(get(`/purchase/consign/overview?supplierId=${curSup}&from=${host.querySelector('#ccFrom').value}&to=${host.querySelector('#ccTo').value}`));
    const growthCls = d.growth > 0 ? 'g' : d.growth < 0 ? 'r' : 'muted';
    const kpi = (label, val, sub = '') => `<div style="flex:1;min-width:150px;padding:12px 16px;border:1px solid var(--line);border-radius:12px">
      <div class="muted" style="font-size:12px">${label}</div>
      <div style="font-size:20px;font-weight:800;margin-top:2px">${val}</div>
      <div style="font-size:11.5px" class="${growthCls}">${sub}</div></div>`;
    box.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px">
      ${kpi('本期销售额', money(d.salesTotal), `环比 ${d.prevSales ? ((d.growth * 100).toFixed(1) + '%') : '无上期'}`)}
      ${kpi('净销售额', money(d.netSales), `退货 ${money(d.returnTotal)}`)}
      ${kpi('超市扣点收益', money(d.deductionAmount), `扣点率 ${(Number(d.rate) * 100).toFixed(1)}%`)}
      ${kpi('保底', d.guaranteeSales ? `${d.guaranteeProgress}% 达标` : '未设保底',
             d.guaranteeSales ? `缺口 ${money(d.guaranteeGap)} · 补差 ${money(d.guaranteeAmount)}` : '')}
      ${kpi('联营费用', money(d.feeTotal), '水电/促销/POP 等收项')}
      ${kpi('应结金额', money(d.payable), `未结对账 ${d.unpaidCount} 张 / ${money(d.unpaidAmount)}`)}
    </div>
    ${d.topProducts.length ? `<div style="margin-top:10px"><b>TOP 商品</b>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${d.topProducts.map(t =>
        `<span class="pill">${esc(t.productName)} · ${Number(t.qty)}${'件'} · ${money(t.amount)}</span>`).join('')}</div></div>` : ''}`;
  }

  /* ── 预览 ── */
  async function drawPrev() {
    const box = host.querySelector('#ccPrevBox');
    if (!curSup) { box.innerHTML = '<div class="empty">先选联营商</div>'; return; }
    const d = await must(get(`/purchase/consign/preview?supplierId=${curSup}&from=${host.querySelector('#ccPFrom').value}&to=${host.querySelector('#ccPTo').value}`));
    const rows = d.orders || [];
    box.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px">
        <span class="pill b">销售额 ${money(d.salesTotal)}</span>
        <span class="pill y">退货 ${money(d.returnTotal)}</span>
        <span class="pill g">净销售额 ${money(d.netSales)}</span>
        <span class="pill">扣点率 ${(Number(d.rate) * 100).toFixed(1)}%</span>
        <span class="pill">扣点收益 ${money(d.deductionAmount)}${d.guaranteeAmount > 0 ? `（含保底补差 ${money(d.guaranteeAmount)}）` : ''}</span>
        <span class="pill">联营费用 ${money(d.feeTotal)}</span>
      </div>
      ${rows.length ? `<div style="margin-top:10px"><b>销售小票（${rows.length} 单，可下钻）</b>
        <table><thead><tr><th class="seq">序号</th><th>单号</th><th>渠道</th><th>日期</th><th class="num">数量</th><th class="num">金额</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td class="seq">${i + 1}</td><td style="font-family:var(--mono)">${esc(r.order_no)}</td><td class="muted">${esc(r.channel)}</td>
          <td>${String(r.order_date).slice(0, 10)}</td><td class="num">${Number(r.qty)}</td><td class="num">${money(r.amount)}</td></tr>`).join('')}</tbody></table>
      </div>` : '<div class="empty" style="margin-top:8px">该区间无联营销售（或已被对账单吸收）</div>'}
      ${d.fees.length ? `<div style="margin-top:10px"><b>联营费用（收方向 · 未入购销对账）</b>
        <table><thead><tr><th class="seq">序号</th><th>费用单号</th><th>类型</th><th>日期</th><th class="num">金额</th></tr></thead>
        <tbody>${d.fees.map((f, i) => `<tr><td class="seq">${i + 1}</td><td style="font-family:var(--mono)">${esc(f.feeNo)}</td><td>${esc(f.feeType)}</td>
          <td>${String(f.feeDate).slice(0, 10)}</td><td class="num">${money(f.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="doc-foot" style="margin-top:12px">
        <span class="muted">应结 = 净销售额 − 扣点 − 保底补差 − 联营费用</span>
        <span class="sum">应结金额：<b style="color:var(--pri)">${money(d.payable)}</b> 元
          <button class="btn pri" id="ccGo" ${!rows.length ? 'disabled style="opacity:.5"' : ''}>生成联营对账单</button></span>
      </div>`;
    box.querySelector('#ccGo')?.addEventListener('click', async () => {
      await must(post('/purchase/consign-recon', { supplierId: curSup,
        from: host.querySelector('#ccPFrom').value, to: host.querySelector('#ccPTo').value }), '联营对账单已生成（LC-）');
      await drawPrev(); await lists();
    });
  }

  /* ── 对账单列表 ── */
  async function lists() {
    const d = await must(get('/purchase/consign-recons'));
    const rows = (d.items || []).filter(r => !curSup || Number(r.supplier_id) === curSup);
    host.querySelector('#ccList').innerHTML = rows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>对账单号</th><th>供应商</th><th>区间</th>
        <th class="num">销售额</th><th class="num">净额</th><th class="num">扣点</th><th class="num">保底补差</th><th class="num">费用</th><th class="num">应结</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr>
          <td class="seq">${i + 1}</td>
          <td style="font-family:var(--mono);font-weight:600">${esc(r.recon_no)}</td>
          <td>${esc(r.supplier_name || '')}</td>
          <td class="muted">${String(r.period_start).slice(0, 10)} ~ ${String(r.period_end).slice(0, 10)}</td>
          <td class="num">${money(r.sales_total)}</td>
          <td class="num">${money(r.net_sales)}</td>
          <td class="num">${money(r.deduction_amount)}</td>
          <td class="num">${money(r.guarantee_amount)}</td>
          <td class="num">${money(r.fee_total)}</td>
          <td class="num"><b>${money(r.payable_amount)}</b></td>
          <td><span class="tag ${['已确认', '已结算'].includes(r.status) ? 'g' : r.status === '已作废' ? 'r' : 'y'}">${esc(r.status)}</span></td>
          <td style="white-space:nowrap">
            <button class="btn sm" data-det="${r.id}">明细</button>
            ${(r.status === '生成' || r.status === '待供应商确认') ? `<button class="btn sm pri" data-firm="${r.id}">确认</button>` : ''}
            ${r.status === '已确认' ? `<button class="btn sm" data-set="${r.id}">结算</button>` : ''}
            ${(r.status === '生成' || r.status === '待供应商确认') ? `<button class="btn sm warn" data-void="${r.id}">作废</button>` : ''}
          </td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无联营对账单</div>';
    host.querySelectorAll('[data-det]').forEach(b => b.onclick = () => openDetail(b.dataset.det));
    host.querySelectorAll('[data-firm]').forEach(b => b.onclick = () => openFirm(b.dataset.firm));
    host.querySelectorAll('[data-set]').forEach(b => b.onclick = async () => {
      await must(post(`/purchase/consign-recons/${b.dataset.set}/settle`, { payMode: '转账' }), '已结算');
      await lists(); await drawOv();
    });
    host.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
      await must(post(`/purchase/consign-recons/${b.dataset.void}/void`, { reason: '人工作废' }), '已作废');
      await lists(); await drawPrev();
    });
  }

  /* ── 明细下钻 ── */
  async function openDetail(id) {
    const d = await must(get(`/purchase/consign-recons/${id}`));
    const r = d.recon;
    host.querySelector('#ccDetTitle').textContent = `联营对账单 ${r.recon_no}`;
    host.querySelector('#ccDetBox').innerHTML = `
      <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <div class="fld"><label>供应商</label><b>${esc(r.supplier_name)}</b></div>
        <div class="fld"><label>区间</label><b>${String(r.period_start).slice(0, 10)} ~ ${String(r.period_end).slice(0, 10)}</b></div>
        <div class="fld"><label>扣点率</label><b>${(Number(r.deduction_rate) * 100).toFixed(1)}%</b></div>
        <div class="fld"><label>保底销售额</label><b>${r.guarantee_sales ? money(r.guarantee_sales) : '未设'}</b></div>
      </div>
      <table style="margin-top:10px"><thead><tr><th class="seq">序号</th><th>单号</th><th>日期</th><th class="num">数量</th><th class="num">金额</th></tr></thead>
      <tbody>${d.items.map((i, idx) => `<tr><td class="seq">${idx + 1}</td><td style="font-family:var(--mono)">${esc(i.order_no)}</td>
        <td>${String(i.order_date).slice(0, 10)}</td><td class="num">${Number(i.qty)}</td><td class="num">${money(i.amount)}</td></tr>`).join('')}</tbody></table>
      <div class="doc-foot">
        <span class="muted">销售额 ${money(r.sales_total)} − 退货 ${money(r.return_total)} = 净 ${money(r.net_sales)}</span>
        <span class="sum">应结 <b style="color:var(--pri)">${money(r.payable_amount)}</b> 元
          ${r.confirmed_at ? `· 已确认：${esc(r.confirm_type || '')}${r.confirm_name ? ' / ' + esc(r.confirm_name) : ''}（${dt(r.confirmed_at)}）` : ''}</span>
      </div>`;
    host.querySelector('#ccDetModal').style.display = 'flex';
  }
  // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）

  /* ── 确认弹窗（电子签字） ── */
  let firmId = 0, firmTpls = [];
  async function loadTpls() {
    const d = await must(get('/purchase/signatures'));
    firmTpls = d.items.filter(t => Number(t.status) === 1);
    host.querySelector('#ccFirmTpl').innerHTML = '<option value="">— 现场手写 —</option>' +
      firmTpls.map(t => `<option value="${t.id}">${esc(t.person_name)}（${esc(t.role_title || '')}）</option>`).join('');
  }
  function openFirm(id) {
    firmId = Number(id);
    host.querySelector('#ccFirmName').value = '';
    clearPad(host.querySelector('#ccFirmPad'));
    host.querySelector('#ccFirmModal').style.display = 'flex';
  }
  host.querySelector('#ccFirmCancel').onclick = () => { host.querySelector('#ccFirmModal').style.display = 'none'; };
  host.querySelector('#ccFirmGo').onclick = async () => {
    const type = host.querySelector('#ccFirmType').value;
    const name = host.querySelector('#ccFirmName').value.trim() || undefined;
    const tplId = Number(host.querySelector('#ccFirmTpl').value) || undefined;
    const dirty = padDirty(host.querySelector('#ccFirmPad'));
    const body = { confirmType: type, confirmName: name, templateId: tplId };
    if (tplId) {
      const tpl = firmTpls.find(t => Number(t.id) === tplId);
      body.confirmName = name || tpl?.person_name;
      if (tpl) body.signRecordId = await attachTemplate(tpl.id, firmId); // 预采调用落证据链
    } else if (dirty) {
      body.signImage = host.querySelector('#ccFirmPad').toDataURL('image/png');
    }
    await must(post(`/purchase/consign-recons/${firmId}/confirm`, body), '联营对账单已确认');
    host.querySelector('#ccFirmModal').style.display = 'none';
    await lists(); await drawOv();
  };
  async function attachTemplate() { return undefined; } // 预采调用实际由 confirm 后端按 templateId 落库

  /* ── 签字样本管理：V4.14.2 迁至 screens/signatures.js（系统 → 授权管理），此处仅保留确认弹窗的预采样本下拉 ── */

  /* ── 事件绑定 ── */
  host.querySelector('#ccOv').onclick = drawOv;
  host.querySelector('#ccPrev').onclick = drawPrev;
  host.querySelector('#ccRefresh').onclick = () => { lists(); };
  host.querySelector('#ccFrom').value = monthStart;
  host.querySelector('#ccTo').value = today;

  await lists();
  if (curSup) { await drawOv(); await drawPrev(); }
}

