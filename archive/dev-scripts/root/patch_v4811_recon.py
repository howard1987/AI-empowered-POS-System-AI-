# -*- coding: utf-8 -*-
# V4.8.11 Web 对账结算屏：费用协议 + 费用单管理 + 生成结算按钮
import io, os

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frontend-web', 'screens', 'recon.js')
s = io.open(P, encoding='utf-8').read()

pairs = [
# 1) 结算单卡之前插入两张卡
(
"""    <div class="card">
      <h3>结算单 <span class="api">GET /purchase/settlements · POST /purchase/settlements · POST /purchase/settlements/:id/audit</span></h3>
      <div id="sList"></div>
    </div>
    <div class="card">
      <h3>供应商往来账 <span class="api">GET /purchase/ledger?supplierId=</span></h3>""",
"""      <div id="sList"></div>
    </div>
    <div class="card">
      <h3>费用协议 <span class="api">GET/POST /purchase/fee-agreements · GET /purchase/fee-types</span></h3>
      <div class="bar">
        <select id="agType"></select>
        <input id="agAmount" type="number" step="0.01" placeholder="每期金额(元)*" style="width:120px">
        <input id="agStart" type="date" title="协议起始日*">
        <input id="agEnd" type="date" title="协议结束日(选填)">
        <button class="btn pri" id="agGo">新增协议（对账自动补齐漏记期次）</button>
      </div>
      <div id="agList" class="mt8"></div>
    </div>
    <div class="card">
      <h3>费用单 <span class="api">GET/POST /purchase/fees（人工临时费用录入即生效）</span></h3>
      <div class="bar">
        <select id="feeType"></select>
        <input id="feeAmount" type="number" step="0.01" placeholder="金额(元)*" style="width:110px">
        <input id="feeRemark" placeholder="备注（陈列费/补差等）" style="width:170px">
        <button class="btn pri" id="feeGo">录入费用</button>
      </div>
      <div id="feeList" class="mt8"></div>
    </div>
    <div class="card">
      <h3>供应商往来账 <span class="api">GET /purchase/ledger?supplierId=</span></h3>""",
'cards'),
# 2) 对账单行：已确认 → 生成结算按钮
(
"""        <td>${r.status !== '已确认' && r.status !== '已结算' ? `<button class="btn sm pri" data-c="${r.id}">确认</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无对账单</div>';
    view.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
      await must(post(`/purchase/recons/${b.dataset.c}/confirm`), '对账单已确认');
      await lists();
    });""",
"""        <td>${r.status !== '已确认' && r.status !== '已结算' ? `<button class="btn sm pri" data-c="${r.id}">确认</button>`
             : r.status === '已确认' ? `<button class="btn sm" data-st="${r.id}">生成结算单</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无对账单</div>';
    view.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
      await must(post(`/purchase/recons/${b.dataset.c}/confirm`), '对账单已确认');
      await lists();
    });
    view.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => {
      await must(post('/purchase/settlements', { reconId: Number(b.dataset.st) }), '结算单已生成（待审核）');
      await lists();
    });""",
'settle btn'),
# 3) JS：协议/费用加载与表单 + 下拉初始化
(
"""  const d = await must(get('/purchase/suppliers'));
  suppliers = d.items || d || [];
  supSel.innerHTML = suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  await lists();
  if (suppliers.length) await drawLedger(suppliers[0].id);
  supSel.onchange = () => drawLedger(Number(supSel.value));""",
"""  const d = await must(get('/purchase/suppliers'));
  suppliers = d.items || d || [];
  supSel.innerHTML = suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');

  // ── 费用协议与费用单（V4.8.11） ──
  const types = (await must(get('/purchase/fee-types')));
  const tArr = types.items || types || [];
  const tOpts = tArr.map(t => `<option value="${t.id}">${esc(t.name)}（${t.direction === '收' ? '供应商给店' : '补给供应商'}）</option>`).join('');
  view.querySelector('#agType').innerHTML = tOpts;
  view.querySelector('#feeType').innerHTML = tOpts;
  const d0b = new Date(); d0b.setDate(1);
  view.querySelector('#agStart').value = d0b.toISOString().slice(0, 10);

  async function feeCards() {
    const sid = Number(supSel.value) || 0;
    const ag = await must(get(`/purchase/fee-agreements?supplierId=${sid}`));
    const agArr = ag.items || [];
    view.querySelector('#agList').innerHTML = agArr.length ? `
      <table><thead><tr><th>供应商</th><th>类型</th><th>方向</th><th>模式</th><th class="num">每期</th>
        <th>自动补齐</th><th>协议期</th><th>状态</th></tr></thead>
      <tbody>${agArr.map(a => `<tr>
        <td>${esc(a.supplier_name)}</td><td>${esc(a.fee_type_name)}</td>
        <td><span class="tag ${a.direction === '收' ? 'g' : 'y'}">${esc(a.direction)}</span></td>
        <td>${esc(a.amount_mode)}</td>
        <td class="num">${a.amount != null ? money(a.amount) : (a.ratio != null ? (Number(a.ratio) * 100).toFixed(2) + '%' : '—')}</td>
        <td>${a.auto_generate ? '<span class="tag g">补齐漏记</span>' : '<span class="tag">手动</span>'}</td>
        <td class="muted">${String(a.start_date).slice(0, 10)} ~ ${a.end_date ? String(a.end_date).slice(0, 10) : '长期'}</td>
        <td>${a.status === 1 ? '<span class="tag g">生效</span>' : '<span class="tag r">停用</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">该供应商暂无费用协议</div>';
    const fe = await must(get(`/purchase/fees?supplierId=${sid}`));
    const feArr = fe.items || [];
    view.querySelector('#feeList').innerHTML = feArr.length ? `
      <table><thead><tr><th>费用单</th><th>类型</th><th>方向</th><th>期间</th><th class="num">金额</th><th>状态</th><th>备注</th></tr></thead>
      <tbody>${feArr.map(f => `<tr>
        <td>${esc(f.fee_no)}</td><td>${esc(f.fee_type_name)}</td>
        <td><span class="tag ${f.direction === '收' ? 'g' : 'y'}">${esc(f.direction)}</span></td>
        <td class="muted">${f.period_start ? String(f.period_start).slice(0, 10) + ' ~ ' + String(f.period_end || '').slice(0, 10) : '一次性'}</td>
        <td class="num">${money(f.amount)}</td>
        <td>${f.status === '已审核' ? '<span class="tag g">已审核</span>' : `<span class="tag y">${esc(f.status)}</span>`}</td>
        <td class="muted">${esc(f.remark || '')}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">该供应商暂无费用单</div>';
  }

  view.querySelector('#agGo').onclick = async () => {
    const amount = Number(view.querySelector('#agAmount').value);
    const start = view.querySelector('#agStart').value;
    if (!(amount > 0) || !start) return toast('金额与协议起始日必填', false);
    await must(post('/purchase/fee-agreements', { supplierId: Number(supSel.value),
      feeTypeId: Number(view.querySelector('#agType').value), cycle: '月', amountMode: '固定额',
      amount, autoGenerate: true, startDate: start,
      endDate: view.querySelector('#agEnd').value || undefined }), '协议已创建');
    view.querySelector('#agAmount').value = '';
    await feeCards();
  };

  view.querySelector('#feeGo').onclick = async () => {
    const amount = Number(view.querySelector('#feeAmount').value);
    if (!(amount > 0)) return toast('费用金额必填', false);
    await must(post('/purchase/fees', { supplierId: Number(supSel.value),
      feeTypeId: Number(view.querySelector('#feeType').value), amount,
      remark: view.querySelector('#feeRemark').value.trim() || undefined }), '费用已录入（对账时吸收）');
    view.querySelector('#feeAmount').value = ''; view.querySelector('#feeRemark').value = '';
    await feeCards();
  };

  const oldChange = supSel.onchange;
  supSel.onchange = () => { if (oldChange) oldChange.call(supSel); feeCards(); };
  await lists();
  await feeCards();
  if (suppliers.length) await drawLedger(suppliers[0].id);
  supSel.onchange = () => { drawLedger(Number(supSel.value)); feeCards(); };""",
'js init'),
]
for old, new, tag in pairs:
    assert s.count(old) == 1, f'锚点不唯一({s.count(old)}): {tag}'
    s = s.replace(old, new)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('RECON UI PATCH DONE')
