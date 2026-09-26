import { get, post, must, esc, toast, dt, money } from '../api.js';

/** 组合拆分（V4.8.17）：组合档案（BOM）+ 组装 ZZ-/拆分 CF- 开单（录入即生效）+ 单据浏览 */
export async function render(view) {
  const today = new Date().toISOString().slice(0, 10);
  let prods = [];
  let bundles = [];
  let lines = [];   // BOM 明细行 { productId, name, qty }
  let ops = [];
  let opType = 'assemble';

  view.innerHTML = `
    <div class="card">
      <h3>组合档案（BOM） </h3>
      <div class="bar">
        <button class="btn pri" id="bdNew">➕ 新建组合</button>
        <button class="btn" id="bdRefresh">刷新</button>
        <span class="muted">组合商品先在商品档案建档；一份组合 = Σ 子商品×数量；组装后可直接销售</span>
      </div>
      <div id="bdList"></div>
    </div>
    <div class="card">
      <h3>组装 / 拆分开单 </h3>
      <div class="doc-tools">
        <button class="btn pri" id="opSave">💾 保存单据</button>
        <span class="muted" id="opTip">单号 ZZ- 自动生成 · 组装按 FIFO 消费子商品 → 生成组合批次</span>
      </div>
      <div class="doc-head">
        <div class="fld"><label>单据类型</label>
          <select id="opType">
            <option value="assemble">🧩 组装（子商品 → 组合商品）</option>
            <option value="split">✂️ 拆分（组合商品 → 子商品）</option>
          </select>
        </div>
        <div class="fld"><label>组合商品</label><select id="opBundle"></select></div>
        <div class="fld"><label>份数</label><input id="opQty" type="number" step="0.001" min="0.001" value="1"></div>
        <div class="fld fld-wide"><label>备注</label><input id="opRemark" placeholder="备注（如：节前礼盒组装）"></div>
      </div>
      <div class="doc-grid">
        <div id="opPreview" class="muted">选择组合商品后预览 BOM 明细与库存</div>
        <div class="doc-foot" id="opFoot">成本按 FIFO 守恒：组装 Σ子批次成本=组合批次成本；拆分 u=U/ΣBOM数量</div>
      </div>
    </div>
    <div class="card">
      <h3>单据浏览 </h3>
      <div class="bar">
        <select id="opFilter">
          <option value="">全部类型</option>
          <option value="assemble">🧩 组装</option>
          <option value="split">✂️ 拆分</option>
        </select>
        <input id="opFrom" type="date" value="${today}" title="起始日期">
        <input id="opTo" type="date" title="截止日期">
        <button class="btn pri" id="opSearch">🔍 查询</button>
      </div>
      <div id="opList"></div>
    </div>`;

  const $ = s => view.querySelector(s);

  // ── 组合档案 ──
  async function loadBundles() {
    const d = await must(get('/bundles'));
    bundles = d.items || [];
    $('#bdList').innerHTML = bundles.length ? `
      <table><thead><tr><th>组合商品</th><th>BOM 明细</th><th>状态</th><th>建档</th><th></th></tr></thead>
      <tbody>${bundles.map(b => `<tr>
        <td><b>${esc(b.name)}</b> <span class="muted">#${b.bundle_product_id}</span></td>
        <td>${(b.items || []).map(i => `${esc(i.product_name)}×${Number(i.qty)}（库存 ${Number(i.stock_qty)}）`).join(' ＋ ')}</td>
        <td><span class="tag ${Number(b.status) === 1 ? 'g' : 'r'}">${Number(b.status) === 1 ? '启用' : '停用'}</span></td>
        <td class="muted">${dt(b.created_at).slice(0, 10)}</td>
        <td><button class="btn mini" data-use="${b.bundle_product_id}">开单</button></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无组合商品——点「新建组合」</div>';
  }
  $('#bdList').addEventListener('click', e => {
    const b = e.target.closest('[data-use]');
    if (b) {
      $('#opBundle').value = b.dataset.use;
      $('#opBundle').dispatchEvent(new Event('change'));
      view.querySelector('.card:nth-child(2)').scrollIntoView({ behavior: 'smooth' });
    }
  });

  $('#bdNew').addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `
      <div class="modal">
        <h3>新建组合商品</h3>
        <div class="fld"><label>组合商品（先在商品档案建档）</label>
          <select id="nbBundle"><option value="">— 选择商品 —</option>${prods.map(p => `<option value="${p.id}">${esc(p.name)}｜${esc(p.barcode || '无条码')}</option>`).join('')}</select></div>
        <div class="bar"><select id="nbProd"></select><input id="nbQty" type="number" step="0.001" min="0.001" placeholder="数量" style="width:80px"><button class="btn pri" id="nbAdd">➕</button></div>
        <table><tbody id="nbLines"></tbody></table>
        <div class="bar" style="justify-content:flex-end">
          <button class="btn" id="nbCancel">取消</button>
          <button class="btn pri" id="nbSave">保存组合</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const m = s => modal.querySelector(s);
    let mlines = [];
    m('#nbProd').innerHTML = '<option value="">— 子商品 —</option>' + prods.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const drawM = () => {
      m('#nbLines').innerHTML = mlines.map((l, i) => `<tr><td>${esc(l.name)}</td><td class="num">×${Number(l.qty)}</td>
        <td><button class="btn mini" data-md="${i}">✕</button></td></tr>`).join('');
    };
    m('#nbLines').addEventListener('click', e => { const b = e.target.closest('[data-md]'); if (b) { mlines.splice(Number(b.dataset.md), 1); drawM(); } });
    m('#nbAdd').addEventListener('click', () => {
      const id = Number(m('#nbProd').value); const q = Number(m('#nbQty').value);
      if (!id) return toast('请选择子商品');
      if (!(q > 0)) return toast('数量必须大于 0');
      const bid = Number(m('#nbBundle').value);
      if (id === bid) return toast('子商品不能是组合商品本身');
      if (mlines.some(l => l.productId === id)) return toast('子商品已添加');
      mlines.push({ productId: id, name: (prods.find(x => Number(x.id) === id) || {}).name || id, qty: q });
      drawM(); m('#nbQty').value = '';
    });
    m('#nbCancel').addEventListener('click', () => modal.remove());
    m('#nbSave').addEventListener('click', async () => {
      const bid = Number(m('#nbBundle').value);
      if (!bid) return toast('请选择组合商品');
      if (!mlines.length) return toast('请添加 BOM 明细');
      try {
        await must(post('/bundles', { bundleProductId: bid, items: mlines }));
        toast('组合档案已保存');
        modal.remove();
        await Promise.all([loadBundles(), loadOps(), fillBundleSel()]);
      } catch (e) { /* must 已提示 */ }
    });
  });

  // ── 开单 ──
  function fillBundleSel() {
    $('#opBundle').innerHTML = '<option value="">— 选择组合商品 —</option>' +
      bundles.map(b => `<option value="${b.bundle_product_id}">${esc(b.name)}｜${(b.items || []).map(i => `${esc(i.product_name)}×${Number(i.qty)}`).join('+')}</option>`).join('');
  }
  async function drawPreview() {
    const bid = Number($('#opBundle').value);
    const b = bundles.find(x => Number(x.bundle_product_id) === bid);
    if (!b) { $('#opPreview').innerHTML = '<span class="muted">选择组合商品后预览 BOM 明细与库存</span>'; return; }
    const n = Number($('#opQty').value) || 0;
    $('#opPreview').innerHTML = `
      <table><thead><tr><th>子商品</th><th class="num">BOM 数量</th><th class="num">本单${opType === 'assemble' ? '消耗' : '产出'}</th><th class="num">现有库存</th></tr></thead>
      <tbody>${(b.items || []).map(i => `<tr>
        <td>${esc(i.product_name)}</td><td class="num">${Number(i.qty)}</td>
        <td class="num"><b>${Number(i.qty) * n}</b></td>
        <td class="num ${Number(i.stock_qty) < Number(i.qty) * n ? 'err' : ''}">${Number(i.stock_qty)}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  $('#opBundle').addEventListener('change', drawPreview);
  $('#opQty').addEventListener('input', drawPreview);
  $('#opType').addEventListener('change', () => {
    opType = $('#opType').value;
    $('#opTip').textContent = opType === 'assemble'
      ? '单号 ZZ- 自动生成 · 组装按 FIFO 消费子商品 → 生成组合批次'
      : '单号 CF- 自动生成 · 拆分按 FIFO 消费组合批次 → 子商品成本均摊（u=U/ΣBOM数量，守恒）';
    drawPreview();
  });

  $('#opSave').addEventListener('click', async () => {
    const bid = Number($('#opBundle').value);
    const n = Number($('#opQty').value);
    if (!bid) return toast('请选择组合商品');
    if (!(n > 0)) return toast('份数必须大于 0');
    try {
      const r = await must(post(`/bundles/${opType}`, { bundleProductId: bid, qty: n, remark: $('#opRemark').value.trim() || undefined }));
      toast(`${opType === 'assemble' ? '组装' : '拆分'}单 ${r.opNo} 已生效（成本 ${money(r.totalCost)}）`);
      $('#opRemark').value = '';
      await Promise.all([loadBundles(), loadOps(), loadProds()]);
    } catch (e) { /* must 已提示 */ }
  });

  // ── 浏览 ──
  async function loadOps() {
    const qs = `from=${$('#opFrom').value || ''}&to=${$('#opTo').value || ''}&type=${$('#opFilter').value || ''}`;
    ops = await must(get('/bundles/ops?' + qs));
    ops = ops.items || ops || [];
    $('#opList').innerHTML = ops.length ? `
      <table><thead><tr><th>单号</th><th>类型</th><th>组合商品</th><th class="num">份数</th><th class="num">单位成本</th><th class="num">总成本</th><th>备注</th><th>制单</th><th>时间</th></tr></thead>
      <tbody>${ops.map(o => `<tr>
        <td class="num">${esc(o.op_no)}</td>
        <td><span class="tag ${o.op_type === 'assemble' ? '' : 'b'}">${o.op_type === 'assemble' ? '🧩 组装' : '✂️ 拆分'}</span></td>
        <td>${esc(o.bundle_name || '—')}</td>
        <td class="num">${Number(o.qty)}</td>
        <td class="num">${money(o.unit_cost)}</td>
        <td class="num"><b>${money(o.total_cost)}</b></td>
        <td class="muted">${esc(o.remark || '—')}</td>
        <td>${esc(o.creator_name || '—')}</td>
        <td class="muted">${dt(o.created_at)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无组装/拆分单</div>';
  }
  $('#opSearch').addEventListener('click', loadOps);
  $('#opFilter').addEventListener('change', loadOps);
  $('#bdRefresh').addEventListener('click', () => Promise.all([loadBundles(), loadOps()]));

  // ── 商品下拉 ──
  async function loadProds() {
    const d = await must(get('/products?size=500'));
    prods = d.items || d || [];
  }

  await Promise.all([loadProds(), loadBundles(), loadOps()]);
  fillBundleSel();
}
