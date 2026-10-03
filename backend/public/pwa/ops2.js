'use strict';
/* 员工移动端 PWA · 作业二期（ops2.js）：订货申请 / 配货拣货 / 配送码核销 / 库存调拨
 * 对端：/purchase/orders（source=订货申请）、/sales/picking*、/sales/delivery/verify、
 *       /inventory/transfers*、/upload（签收照片） */

/* ═══════════ 订货申请（8.5：提交补货申请 → 店长审批） ═══════════ */
View.order = function (v) {
  const lines = [];   // {product, qty, price}
  const addLine = (p, qty = 1) => {
    const hit = lines.find(l => l.product.id === p.id);
    if (hit) { hit.qty += qty; renderLines(); return; }
    lines.push({ product: p, qty, price: p.sellPrice || 0 });
    renderLines();
  };
  v.innerHTML = `
    <div class="sec">供应商（可选，留空则按商品供应商自动分桶）</div>
    <div class="field"><select id="odSup"></select></div>
    <div class="sec">扫码 / 搜索添加商品（可多供应商混订）</div>
    <input id="odScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
    <div class="ai-right" style="display:flex;justify-content:flex-end;margin-top:6px"><button class="mini-btn" id="odAi">🤖 AI智拍（识别订货）</button></div>
    <div class="sec">订货明细（提交时按商品供应商自动分桶，每供应商一张采购单）</div>
    <div id="odLines"></div>
    <div class="hint" id="odSum"></div>
    <button class="btn ok" id="odGo">提交订货申请</button>`;
  fillSuppliers($('#odSup'));
  $('#odAi').onclick = () => aiAddLines('order', 'AI 多商品识别订货', (p, n) => addLine(p, n));
  Scanner.attach($('#odScan'), async key => {
    await scanResolve(key, p => { addLine(p); $('#odScan').value = ''; },
      async (kw, aiItems) => {
        if (aiItems) return addAiFallback(aiItems, p => addLine(p));
        if (!kw) return;
        const p2 = await lookupProduct(kw);
        if (p2) { addLine(p2); $('#odScan').value = ''; } else toast('仍未找到商品：' + kw);
      });
  });
  const linesBox = $('#odLines');
  function renderLines() {
    if (!lines.length) linesBox.innerHTML = '<div class="empty">暂无明细，扫一扫添加</div>';
    else {
      linesBox.innerHTML = lines.map((l, i) => `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(l.product.name)} <span class="pill gray">${esc(l.product.barcode || '—')}</span></div>
            <div class="s">进价 ¥<input style="width:70px;text-align:center;border:1px solid var(--line);border-radius:6px;padding:3px" data-price="${i}" value="${money(l.price)}"></div>
          </div>
          <div class="qty"><button data-m="${i}">−</button>${qtyInputHtml(i, l.qty)}<button data-p="${i}">＋</button></div>
          <button class="mini-btn danger" data-d="${i}">删</button>
        </div>`).join('');
      linesBox.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const i = +b.dataset.m; lines[i].qty = Math.max(0, lines[i].qty - 1); renderLines(); });   // V4.14.1：数量 0 提交时过滤
      linesBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { lines[+b.dataset.p].qty++; renderLines(); });
      bindQtyInput(linesBox, lines, 'qty', renderLines);
      linesBox.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { lines.splice(+b.dataset.d, 1); renderLines(); });
      linesBox.querySelectorAll('[data-price]').forEach(inp => inp.onchange = () => { lines[+inp.dataset.price].price = Number(inp.value) || 0; });
    }
    $('#odSum').textContent = `共 ${lines.length} 种 / ${lines.reduce((s, l) => s + l.qty, 0)} 件 · 预估 ¥${money(lines.reduce((s, l) => s + l.qty * l.price, 0))}`;
  }
  renderLines();
  $('#odGo').onclick = async () => {
    if (!lines.length) { toast('请先添加订货商品'); return; }
    // V4.13.9 B5：不强制选供应商；选了则全单归该供应商，否则按商品供应商自动分桶
    const supId = Number($('#odSup').value) || 0;
    try {
      const d = await call('POST', '/purchase/orders', {
        ...(supId ? { supplierId: supId } : {}),
        items: lines.map(l => ({ productId: l.product.id, orderQty: l.qty, price: l.price || undefined })),
        source: '订货申请', remark: '移动端订货申请',
      });
      toast(d.multi ? `已按供应商拆为 ${d.docCount} 张采购单` : `订货申请已提交：${d.poNo}`);
      lines.length = 0; renderLines(); $('#odSup').value = '';
    } catch (e) { toast(e.message); }
  };
};

/* ═══════════ 配货拣货（6.11：线上订单 → 扫码校验 → 缺货登记 → 完成） ═══════════ */
View.pick = function (v) {
  const filter = '待拣货';
  v.innerHTML = `
    <div class="seg">
      <button class="on" data-f="待拣货">待拣货</button>
      <button data-f="拣货中">拣货中</button>
      <button data-f="已拣货">已拣货</button>
      <button data-f="缺货">缺货</button>
    </div>
    <div id="pkList"><div class="empty">加载中…</div></div>`;
  const box = $('#pkList');
  async function load(f) {
    try {
      const rows = unwrap(await call('GET', '/sales/picking?status=' + encodeURIComponent(f)));
      if (!rows.length) { box.innerHTML = '<div class="empty">暂无拣货单</div>'; return; }
      box.innerHTML = rows.map(r => `
        <div class="row" data-id="${r.id}">
          <div class="grow">
            <div class="t">${esc(r.order_no)} <span class="pill ${r.channel === '大客户团购' ? 'purple' : 'blue'}">${esc(r.channel)}</span></div>
            <div class="s">${r.item_count} 项 · ¥${money(r.payable_amount)} · ${esc(r.member_name || '散客')} · ${dt(r.created_at)}</div>
          </div>
          <span class="pill ${r.picking_status === '缺货' ? 'red' : r.picking_status === '已拣货' ? 'green' : r.picking_status === '拣货中' ? 'orange' : 'gray'}">${esc(r.picking_status)}</span>
        </div>`).join('');
      box.querySelectorAll('[data-id]').forEach(el => el.onclick = () => push('拣货单 ' + el.dataset.id, View.pickDetail, { id: Number(el.dataset.id) }));
    } catch (e) { box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
  v.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    v.querySelectorAll('.seg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    load(b.dataset.f);
  });
  load(filter);
};

View.pickDetail = async function (v, arg) {
  v.innerHTML = '<div class="empty">加载中…</div>';
  let d;
  try {
    d = await call('GET', '/sales/picking/' + arg.id);
  } catch (e) { v.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  const o = d.order;
  const checked = new Set();          // 已扫码校验的 productId
  const shortages = [];               // {productId, qty, reason}
  let started = o.picking_status === '拣货中';
  v.innerHTML = `
    <div class="card" style="margin-bottom:10px">
      <div class="kv"><span class="k">单号</span><span class="v">${esc(o.order_no)}</span></div>
      <div class="kv"><span class="k">渠道</span><span class="v">${esc(o.channel)} · ${esc(o.pickup_mode)}</span></div>
      <div class="kv"><span class="k">金额</span><span class="v">¥${money(o.payable_amount)}</span></div>
      <div class="kv"><span class="k">状态</span><span class="v" id="pkStatus">${esc(o.picking_status)}</span></div>
    </div>
    <div class="sec">扫码校验商品</div>
    <input id="pkScan" class="search" placeholder="扫描条码核对商品" autocomplete="off">
    <div class="sec">拣货明细（扫码打勾）</div>
    <div id="pkItems"></div>
    <div class="sec">缺货登记</div>
    <div id="pkShort"><div class="empty">无缺货登记</div></div>
    <button class="btn ok" id="pkGo">${started ? '完成拣货' : '开始拣货'}</button>`;
  const itemsBox = $('#pkItems');
  const shortBox = $('#pkShort');
  function renderItems() {
    itemsBox.innerHTML = d.items.map((it, i) => {
      const hit = checked.has(Number(it.product_id));
      return `
      <div class="row" style="${hit ? 'background:#f0fdf4' : ''}">
        <div class="grow">
          <div class="t">${hit ? '✅ ' : ''}${esc(it.product_name)}</div>
          <div class="s">条码 ${esc(it.barcode || '—')} · 需 ${it.qty} ${esc(it.unit_name || it.base_unit || '')}</div>
        </div>
        <span class="pill ${hit ? 'green' : 'gray'}">${hit ? '已核对' : '待核对'}</span>
        <button class="mini-btn danger" data-s="${i}">缺货</button>
      </div>`;
    }).join('');
    itemsBox.querySelectorAll('[data-s]').forEach(b => b.onclick = () => shortageModal(+b.dataset.s));
  }
  function renderShort() {
    if (!shortages.length) { shortBox.innerHTML = '<div class="empty">无缺货登记</div>'; return; }
    shortBox.innerHTML = shortages.map((s, i) => {
      const it = d.items.find(x => Number(x.product_id) === s.productId);
      return `<div class="row">
        <div class="grow"><div class="t">${esc(it ? it.product_name : '#' + s.productId)}</div>
          <div class="s">缺 ${s.qty} 件${s.reason ? ' · ' + esc(s.reason) : ''}</div></div>
        <button class="mini-btn danger" data-rs="${i}">撤销</button></div>`;
    }).join('');
    shortBox.querySelectorAll('[data-rs]').forEach(b => b.onclick = () => { shortages.splice(+b.dataset.rs, 1); renderShort(); });
  }
  function shortageModal(idx) {
    const it = d.items[idx];
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>缺货登记 · ${esc(it.product_name)}</h3>
      <div class="field"><label>缺货数量</label><input id="shQty" type="number" value="1" min="1" max="${it.qty}"></div>
      <div class="field"><label>原因（选填）</label><input id="shReason" placeholder="如：供应商断货"></div>
      <button class="btn ok" id="shGo">确定</button>
      <button class="btn ghost" id="shCancel" style="width:100%;margin-top:8px">取消</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#shCancel').onclick = () => m.remove();
    m.querySelector('#shGo').onclick = () => {
      const qty = Number(m.querySelector('#shQty').value);
      if (!(qty > 0)) { toast('数量必须大于 0'); return; }
      const old = shortages.findIndex(s => s.productId === Number(it.product_id));
      if (old >= 0) shortages.splice(old, 1);
      shortages.push({ productId: Number(it.product_id), qty, reason: m.querySelector('#shReason').value.trim() || undefined });
      m.remove(); renderShort(); renderItems();
    };
  }
  renderItems(); renderShort();
  Scanner.attach($('#pkScan'), async key => {
    await scanResolve(key, p => {
      const it = d.items.find(x => Number(x.product_id) === p.id);
      if (!it) { toast('该商品不在本拣货单'); return; }
      checked.add(Number(p.id));
      $('#pkScan').value = '';
      renderLines();
      toast(`已校验 ${p.name}`);
    }, async kw => {
      if (!kw) return;
      const p2 = await lookupProduct(kw);
      if (p2) {
        const it = d.items.find(x => Number(x.product_id) === p2.id);
        if (!it) { toast('该商品不在本拣货单'); return; }
        checked.add(Number(p2.id)); $('#pkScan').value = ''; renderLines();
      } else toast('仍未找到商品：' + kw);
    });
  });
  $('#pkGo').onclick = async () => {
    try {
      if (!started) {
        await call('POST', '/sales/picking/' + arg.id + '/start');
        started = true;
        $('#pkStatus').textContent = '拣货中';
        $('#pkGo').textContent = '完成拣货';
        toast('已开始拣货');
        return;
      }
      const r = await call('POST', '/sales/picking/' + arg.id + '/complete', { shortages });
      toast(`拣货完成（${r.status}）`);
      $('#pkStatus').textContent = r.status;
      $('#pkGo').disabled = true;
      $('#pkGo').style.opacity = .5;
    } catch (e) { toast(e.message); }
  };
};

/* ═══════════ 配送码核销（V4.2：扫顾客出示的 8 位码 + 签收照片） ═══════════ */
View.deliver = function (v) {
  let photoPath = '';
  v.innerHTML = `
    <div class="sec">核销码（扫顾客出示的 8 位码）</div>
    <input id="dvCode" class="search" placeholder="扫描或输入配送核销码" autocomplete="off">
    <div class="sec">签收照片（可选）</div>
    ${photoPickButtons('dv')}
    <img id="dvPrev" class="hidden" style="width:100%;border-radius:12px;margin-top:8px">
    <button class="btn ok" id="dvGo" style="margin-top:14px">核 销</button>
    <div id="dvResult"></div>`;
  bindPhotoPick(v, 'dv', async f => {
    if (!f) return;
    try {
      const dataUrl = await watermarkImage(f, '配送核销 ' + new Date().toLocaleString());
      $('#dvPrev').src = dataUrl;
      $('#dvPrev').classList.remove('hidden');
      const u = await call('POST', '/upload', { image: dataUrl });
      photoPath = u.path;
    } catch (e) { toast(e.message); }
  });
  const run = async () => {
    const code = $('#dvCode').value.trim();
    if (!code) { toast('请输入核销码'); return; }
    try {
      const d = await call('POST', '/sales/delivery/verify', { code, photo: photoPath || undefined });
      $('#dvResult').innerHTML = `
        <div class="ok-bar">✅ 核销成功<br>单号 <b>${esc(d.orderNo)}</b> · ¥${money(d.amount)}<br>会员：${esc(d.memberName || '散客')} · ${dt(d.verifiedAt)}</div>`;
      $('#dvCode').value = '';
    } catch (e) { toast(e.message); }
  };
  $('#dvGo').onclick = run;
  $('#dvCode').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
};

/* ═══════════ 库存调拨（5.4：批次整体转移成本不变；单店仅店内调拨） ═══════════ */
View.transfer = function (v, arg) {
  if (arg && arg.id) return transferDetail(v, arg);
  v.innerHTML = `
    <div class="toolbar">
      <button class="mini-btn" id="tfNew">＋ 新建调拨</button>
    </div>
    <div id="tfList"><div class="empty">加载中…</div></div>`;
  const box = $('#tfList');
  async function load() {
    try {
      const rows = unwrap(await call('GET', '/inventory/transfers'));
      if (!rows.length) { box.innerHTML = '<div class="empty">暂无调拨单</div>'; return; }
      box.innerHTML = rows.map(r => `
        <div class="row" data-id="${r.id}">
          <div class="grow">
            <div class="t">${esc(r.transfer_no)} <span class="pill ${r.status === '已入库' ? 'green' : r.status === '已取消' ? 'gray' : r.status === '在途' ? 'blue' : 'orange'}">${esc(r.status)}</span></div>
            <div class="s">${r.item_count} 项 · ¥${money(r.total_cost)} · ${esc(r.employee_name || '')} · ${dt(r.created_at)}</div>
          </div>
          ${r.status === '待确认' ? `<button class="mini-btn ok" data-cf="${r.id}" style="color:#fff;background:var(--ok)">确认</button>` : ''}
        </div>`).join('');
      box.querySelectorAll('[data-id]').forEach(el => el.onclick = () => {
        if (el.querySelector('[data-cf]') && el.dataset.id === el.querySelector('[data-cf]').dataset.cf) return;
        push('调拨单 ' + el.dataset.id, View.transfer, { id: Number(el.dataset.id) });
      });
      box.querySelectorAll('[data-cf]').forEach(b => b.onclick = async () => {
        try {
          await call('POST', '/inventory/transfers/' + b.dataset.cf + '/confirm');
          toast('调拨已确认入库');
          load();
        } catch (e) { toast(e.message); }
      });
    } catch (e) { box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
  $('#tfNew').onclick = () => push('新建调拨', View.transferNew);
  load();
};

function transferDetail(v, arg) {
  v.innerHTML = '<div class="empty">加载中…</div>';
  call('GET', '/inventory/transfers/' + arg.id).then(d => {
    const t = d.transfer_no ? d : d;   // {transfer_no, status, ...items}
    v.innerHTML = `
      <div class="card" style="margin-bottom:10px">
        <div class="kv"><span class="k">单号</span><span class="v">${esc(t.transfer_no)}</span></div>
        <div class="kv"><span class="k">状态</span><span class="v">${esc(t.status)}</span></div>
        <div class="kv"><span class="k">原因</span><span class="v">${esc(t.reason || '—')}</span></div>
        <div class="kv"><span class="k">总成本</span><span class="v">¥${money(t.total_cost)}</span></div>
      </div>
      <div class="sec">明细（批次整体转移）</div>
      <div id="tfItems"></div>`;
    const items = Array.isArray(d.items) ? d.items : (d.data && Array.isArray(d.data.items) ? d.data.items : []);
    $('#tfItems').innerHTML = items.map(it => `
      <div class="row">
        <div class="grow">
          <div class="t">${esc(it.product_name)} <span class="pill gray">${esc(it.batch_no || '')}</span></div>
          <div class="s">${it.qty} × ¥${money(it.unit_cost)}</div>
        </div>
        <b style="color:var(--pri)">¥${money(it.qty * it.unit_cost)}</b>
      </div>`).join('') || '<div class="empty">无明细</div>';
  }).catch(e => v.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`);
}

View.transferNew = function (v) {
  const lines = [];   // {product, qty}
  const addLine = (p, qty = 1) => {
    const hit = lines.find(l => l.product.id === p.id);
    if (hit) { hit.qty += qty; renderLines(); return; }
    lines.push({ product: p, qty });
    renderLines();
  };
  v.innerHTML = `
    <div style="display:flex;gap:8px">
      <div class="field" style="flex:1"><label>调出门店</label><select id="tfFrom"></select></div>
      <div class="field" style="flex:1"><label>调入选择调拨门店</label><select id="tfTo"></select></div>
    </div>
    <div class="field"><label>调拨原因</label><input id="tfReason" placeholder="如：门店备货（店内调拨）"></div>
    <div class="sec">扫码 / 搜索添加商品（须有在库批次）</div>
    <input id="tfScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
    <div class="ai-right" style="display:flex;justify-content:flex-end;margin-top:6px"><button class="mini-btn" id="tfAi">🤖 AI智拍（识别调拨）</button></div>
    <div class="sec">调拨明细</div>
    <div id="tfLines"></div>
    <div class="hint" id="tfSum"></div>
    <button class="btn ok" id="tfGo">提交调拨单</button>`;
  // V4.13.9 B6：调出/调入门店下拉（默认本店；多门店部署可选跨店调拨）
  (async () => {
    try {
      const stores = unwrap(await call('GET', '/basic/stores'));
      const opts = stores.map(s => `<option value="${s.id}">${esc(s.name)}${Number(s.id) === Number(ME.storeId) ? '（本店）' : ''}</option>`).join('');
      $('#tfFrom').innerHTML = opts || '<option value="">本店</option>';
      $('#tfTo').innerHTML = opts || '<option value="">本店</option>';
      const cur = stores.find(s => Number(s.id) === Number(ME.storeId));
      if (cur) { $('#tfFrom').value = String(cur.id); $('#tfTo').value = String(cur.id); }
    } catch { /* 门店列表失败不阻塞：后端默认本店 */ }
  })();
  $('#tfAi').onclick = () => aiAddLines('transfer', 'AI 多商品识别调拨', (p, n) => addLine(p, n));
  Scanner.attach($('#tfScan'), async key => {
    await scanResolve(key, p => { addLine(p); $('#tfScan').value = ''; },
      async (kw, aiItems) => {
        if (aiItems) return addAiFallback(aiItems, p => addLine(p));
        if (!kw) return;
        const p2 = await lookupProduct(kw);
        if (p2) { addLine(p2); $('#tfScan').value = ''; } else toast('仍未找到商品：' + kw);
      });
  });
  const linesBox = $('#tfLines');
  function renderLines() {
    if (!lines.length) linesBox.innerHTML = '<div class="empty">暂无明细，扫一扫添加</div>';
    else {
      linesBox.innerHTML = lines.map((l, i) => `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(l.product.name)} <span class="pill gray">${esc(l.product.barcode || '—')}</span></div>
            <div class="s">需在库批次可整批转移</div>
          </div>
          <div class="qty"><button data-m="${i}">−</button>${qtyInputHtml(i, l.qty)}<button data-p="${i}">＋</button></div>
          <button class="mini-btn danger" data-d="${i}">删</button>
        </div>`).join('');
      linesBox.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const i = +b.dataset.m; lines[i].qty = Math.max(0, lines[i].qty - 1); renderLines(); });   // V4.14.1：数量 0 提交时过滤
      linesBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { lines[+b.dataset.p].qty++; renderLines(); });
      bindQtyInput(linesBox, lines, 'qty', renderLines);
      linesBox.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { lines.splice(+b.dataset.d, 1); renderLines(); });
    }
    $('#tfSum').textContent = `共 ${lines.length} 种 / ${lines.reduce((s, l) => s + l.qty, 0)} 件`;
  }
  renderLines();
  $('#tfGo').onclick = async () => {
    if (!lines.length) { toast('请先添加调拨商品'); return; }
    try {
      const d = await call('POST', '/inventory/transfers', {
        fromStoreId: Number($('#tfFrom').value) || undefined,
        toStoreId: Number($('#tfTo').value) || undefined,
        reason: $('#tfReason').value.trim() || '店内调拨',
        items: lines.map(l => ({ productId: l.product.id, qty: l.qty })),
      });
      toast(`调拨单已提交：${d.transferNo}（待确认）`);
      stack.pop(); renderStack();
    } catch (e) { toast(e.message); }
  };
};

/* ═══════════ AI 训练采集（9 章：采集任务 → 扫码选品 → 拍照样本 → 提交待审核） ═══════════ */
View.aiCollect = function (v) {
  v.innerHTML = `
    <button class="btn ok" id="aiBatch" style="width:100%;margin-bottom:8px">📸 多商品同拍采集（一次最多 10 个 · 识别即采）</button>
    <div class="hint" style="margin-bottom:12px">把几个商品平铺进画面拍一张：逐件核对（绿=自动命中 / 黄=点候选确认 / 红=扫码搜索指定）后入样本库。<b>采集无需店长放权</b>，提交后由店长/管理员后台审核。多换摆放组合多拍，样本越多样识别越准。</div>
    <button class="btn ghost" id="aiFree" style="width:100%;margin-bottom:12px">📸 随手拍采集（单商品 · 6 角度精拍）</button>
    <div class="sec">AI 训练采集任务（随手拍样本 → 店长审核 → 训练）</div>
    <div id="aiList"><div class="empty">加载中…</div></div>`;
  $('#aiBatch').onclick = () => {
    if (window.AiBatchCollect) AiBatchCollect.open();
    else toast('多品同拍组件未加载，请刷新页面');
  };
  $('#aiFree').onclick = () => push('随手拍采集', View.aiFree);
  const box = $('#aiList');
  async function load() {
    try {
      const rows = unwrap(await call('GET', '/ai/tasks'));
      if (!rows.length) { box.innerHTML = '<div class="empty">暂无采集任务（由训练台下发）</div>'; return; }
      box.innerHTML = rows.map(t => `
        <div class="row" data-id="${t.id}">
          <div class="grow">
            <div class="t">${esc(t.task_type)}任务
              <span class="pill ${t.status === '已完成' ? 'green' : t.status === '进行中' ? 'orange' : t.status === '待执行' ? 'gray' : 'red'}">${esc(t.status)}</span></div>
            <div class="s">${esc(t.remark || '—')} · 样本 ${Number(t.done_count || 0)}/${Number(t.target_count || '不限')}</div>
            <div style="background:var(--line);border-radius:6px;height:6px;overflow:hidden;margin-top:6px">
              <i style="display:block;height:100%;width:${Math.max(2, Math.min(100, Number(t.progress || 0)))}%;background:var(--ok)"></i></div>
          </div>
          <b style="font-size:20px;color:var(--ink-3)">›</b>
        </div>`).join('');
      box.querySelectorAll('[data-id]').forEach(el => el.onclick = () => push('AI 任务', View.aiTask, { id: Number(el.dataset.id) }));
    } catch (e) { box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
  load();
};

// ── V4.13.9 B4 随手拍（免任务）：先选商品再拍照，6 角度齐全直接提交 /ai/samples/free 进样本库待审核 ──
View.aiFree = function (v) {
  const ANGLES = ['顶面', '正面', '背面', '左侧面', '右侧面', '俯斜面'];
  let cur = null;   // {product, shots:{角度: imagePath}}
  v.innerHTML = `
    <div class="warn-bar" style="margin-bottom:10px">随手拍：不需要采集任务，先选商品再拍照；6 角度齐全后提交，样本直接进样本库待店长审核。</div>
    <div class="sec">1️⃣ 扫码 / 搜索选商品</div>
    <input id="aiFreeScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
    <div id="aiFreeCur"></div>
    <div class="sec">2️⃣ 拍照上传样本（自动水印 · 6 角度缺一不可）</div>
    <div class="hint" style="margin-bottom:8px">同一商品需拍满 6 张：顶面、正面、背面、左侧面、右侧面、俯斜面，全部上传后才能提交</div>
    ${ANGLES.map(a => `
      <div class="row" style="padding:8px 0">
        <div class="grow"><div class="t">📸 ${a}</div></div>
        <span class="pill gray" id="aiFreeSt_${a}">待拍</span>
        <button class="mini-btn" id="aiFreeTake_${a}">📷 拍照</button>
      </div>`).join('')}
    <button class="btn ok" id="aiFreeGo" style="width:100%;margin-top:12px" disabled>提交样本（需 6 角度照片齐全）</button>`;
  const renderCur = () => {
    const box = $('#aiFreeCur');
    if (!cur) { box.innerHTML = '<div class="empty">未选商品（扫条码或输商品名）</div>'; return; }
    const doneN = ANGLES.filter(a => cur.shots[a]).length;
    box.innerHTML = `<div class="row">
      <div class="grow">
        <div class="t">${esc(cur.product.name)} <span class="pill gray">${esc(cur.product.barcode || '—')}</span></div>
        <div class="s">照片 ${doneN}/6${doneN === 6 ? ' · ✅ 可提交' : ' · 待补拍'}</div>
      </div>
      <button class="mini-btn danger" id="aiFreeClear">清空</button></div>`;
    $('#aiFreeClear').onclick = () => { cur = null; renderCur(); renderShots(); renderGo(); };
  };
  const renderShots = () => {
    if (!cur) return;
    ANGLES.forEach(a => {
      const st = $('#aiFreeSt_' + a);
      if (st) { st.textContent = cur.shots[a] ? '✅ 已传' : '待拍'; st.style.color = cur.shots[a] ? 'var(--ok)' : 'var(--ink-3)'; }
    });
  };
  const renderGo = () => {
    const go = $('#aiFreeGo');
    if (!go) return;
    const ready = cur && cur.product && ANGLES.every(a => cur.shots[a]);
    go.disabled = !ready;
    go.style.opacity = go.disabled ? .45 : 1;
    go.textContent = ready ? `提交样本（${cur.product.name} · 6 张）` : '提交样本（需 6 角度照片齐全）';
  };
  Scanner.attach($('#aiFreeScan'), async key => {
    await scanResolve(key, p => {
      cur = { product: p, shots: {} };
      $('#aiFreeScan').value = '';
      renderCur(); renderShots(); renderGo();
      toast(`已选：${p.name}，请拍满 6 个角度`);
    }, async kw => {
      if (!kw) return;
      const p2 = await lookupProduct(kw);
      if (p2) {
        cur = { product: p2, shots: {} };
        $('#aiFreeScan').value = ''; renderCur(); renderShots(); renderGo();
      } else toast('仍未找到商品，无法采集样本：' + kw);
    });
  });
  ANGLES.forEach(angle => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment'; inp.style.display = 'none';
    document.body.appendChild(inp);
    $('#aiFreeTake_' + angle).onclick = () => inp.click();
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        if (!cur) { toast('请先扫码选中商品'); inp.value = ''; return; }
        const btn = $('#aiFreeTake_' + angle);
        btn.disabled = true; btn.textContent = '上传中…';
        const dataUrl = await watermarkImage(f, `随手拍·${angle} ${today()} ${ME.name}`);
        const u = await call('POST', '/upload', { image: dataUrl });
        cur.shots[angle] = u.path;
        btn.disabled = false; btn.textContent = '📷 重拍';
        renderCur(); renderShots(); renderGo();
        toast(`${angle}照片已上传`);
      } catch (e) {
        $('#aiFreeTake_' + angle).disabled = false;
        $('#aiFreeTake_' + angle).textContent = '📷 拍照';
        toast(e.message);
      } finally { inp.value = ''; }
    };
  });
  renderCur(); renderGo();
  $('#aiFreeGo').onclick = async () => {
    const ready = cur && cur.product && ANGLES.every(a => cur.shots[a]);
    if (!ready) { toast('请先选商品并拍满 6 张角度照片（顶面/正面/背面/左侧面/右侧面/俯斜面）'); return; }
    const go = $('#aiFreeGo');
    go.disabled = true; go.textContent = '提交中…';
    try {
      const name = cur.product.name;
      await call('POST', '/ai/samples/free', {
        productId: cur.product.id,
        images: ANGLES.map(a => ({ angle: a, path: cur.shots[a] })),
        annotation: { name: cur.product.name, barcode: cur.product.barcode },
      });
      toast(`✅ 随手拍样本已提交：${name}（6 张）已进样本库，等待店长审核`);
      v.insertAdjacentHTML('afterbegin', `<div class="ok-bar">✅ 随手拍样本已提交：<b>${esc(name)}</b>（6 张）已进样本库，等待店长审核</div>`);
      cur = null; renderCur(); renderShots(); renderGo();
    } catch (e) {
      go.disabled = false; renderGo();
      toast(e.message);
    }
  };
};

View.aiTask = async function (v, arg) {
  v.innerHTML = '<div class="empty">加载中…</div>';
  let t;
  try {
    const rows = unwrap(await call('GET', '/ai/tasks'));
    t = rows.find(x => Number(x.id) === arg.id);
  } catch (e) { v.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  if (!t) { v.innerHTML = '<div class="empty">任务不存在</div>'; return; }
  const ANGLES = ['顶面', '正面', '背面', '左侧面', '右侧面', '俯斜面'];
  let cur = null;   // {product, shots:{角度: imagePath}}
  const progEl = () => `<div style="background:var(--line);border-radius:6px;height:6px;overflow:hidden;margin-top:6px">
    <i style="display:block;height:100%;width:${Math.max(2, Math.min(100, Number(t.progress || 0)))}%;background:var(--ok)"></i></div>`;
  const renderCur = () => {
    const box = $('#aiCur');
    if (!cur) { box.innerHTML = '<div class="empty">未选商品（扫条码或输商品名）</div>'; return; }
    const doneN = ANGLES.filter(a => cur.shots[a]).length;
    box.innerHTML = `<div class="row">
      <div class="grow">
        <div class="t">${esc(cur.product.name)} <span class="pill gray">${esc(cur.product.barcode || '—')}</span></div>
        <div class="s">照片 ${doneN}/6${doneN === 6 ? ' · ✅ 可提交' : ' · 待补拍'}</div>
      </div>
      <button class="mini-btn danger" id="aiClear">清空</button></div>`;
    $('#aiClear').onclick = () => { cur = null; renderCur(); renderShots(); renderGo(); };
  };
  const renderShots = () => {
    if (!cur) return;
    ANGLES.forEach(a => {
      const st = $('#aiSt_' + a);
      if (st) { st.textContent = cur.shots[a] ? '✅ 已传' : '待拍'; st.style.color = cur.shots[a] ? 'var(--ok)' : 'var(--ink-3)'; }
    });
  };
  const renderGo = () => {
    const go = $('#aiGo');
    if (!go) return;
    const ready = cur && cur.product && ANGLES.every(a => cur.shots[a]);
    go.disabled = !ready;
    go.style.opacity = go.disabled ? .45 : 1;
    go.textContent = ready ? '提交样本（6 张）' : '提交样本（需 6 角度照片齐全）';
  };
  v.innerHTML = `
    <div class="card" style="margin-bottom:10px">
      <div class="kv"><span class="k">工单号</span><span class="v" style="font-family:var(--mono);font-weight:700">${esc(t.task_no || '#' + t.id)}</span></div>
      <div class="kv"><span class="k">类型</span><span class="v">${esc(t.task_type)}任务</span></div>
      <div class="kv"><span class="k">状态</span><span class="v" id="aiStatus">${esc(t.status)}${t.review_result === '回退' ? ' · 已回退（重新拍照提交）' : t.review_result === '合格' ? ' · 预检合格待终审' : ''}</span></div>
      <div class="kv"><span class="k">进度</span><span class="v" id="aiProg">${Number(t.done_count || 0)} / ${Number(t.target_count || '不限')}</span></div>
      <div class="kv"><span class="k">备注</span><span class="v">${esc(t.remark || '—')}</span></div>
      <div id="aiBar">${progEl()}</div>
    </div>
    ${t.status === '待执行' ? `<button class="btn ok" id="aiStart" style="width:100%">开始任务</button>` : ''}
    <div id="aiWork" class="hidden">
      <div class="sec">1️⃣ 扫码选商品（当前样本）</div>
      <input id="aiScan" class="search" placeholder="扫描条码或输入商品名" autocomplete="off">
      <div id="aiCur"></div>
      <div class="sec">2️⃣ 拍照上传样本（自动水印 · 6 角度缺一不可）</div>
      <div class="hint" style="margin-bottom:8px">同一商品需拍满 6 张：顶面、正面、背面、左侧面、右侧面、俯斜面，全部上传后才能提交</div>
      ${ANGLES.map(a => `
        <div class="row" style="padding:8px 0">
          <div class="grow"><div class="t">📸 ${a}</div></div>
          <span class="pill gray" id="aiSt_${a}">待拍</span>
          <button class="mini-btn" id="aiTake_${a}">📷 拍照</button>
        </div>`).join('')}
      <button class="btn ok" id="aiGo" style="width:100%;margin-top:12px" disabled>提交样本（需 6 角度照片齐全）</button>
    </div>
    <div class="sec">3️⃣ 已采集样本（点击看大图）</div>
    <div id="aiSamples" class="hidden"></div>`;
  if (t.status === '进行中') $('#aiWork').classList.remove('hidden');
  $('#aiStart') && ($('#aiStart').onclick = async () => {
    try {
      await call('POST', '/ai/tasks/' + arg.id + '/start');
      t.status = '进行中';
      $('#aiStatus').textContent = '进行中';
      $('#aiStart').remove();
      $('#aiWork').classList.remove('hidden');
      toast('任务已开始，可以采集了');
    } catch (e) { toast(e.message); }
  });
  Scanner.attach($('#aiScan'), async key => {
    await scanResolve(key, p => {
      cur = { product: p, shots: {} };
      $('#aiScan').value = '';
      renderCur(); renderShots(); renderGo();
      toast(`已选：${p.name}，请拍满 6 个角度`);
    }, async kw => {
      if (!kw) return;
      const p2 = await lookupProduct(kw);
      if (p2) {
        cur = { product: p2, shots: {} };
        $('#aiScan').value = ''; renderCur(); renderShots(); renderGo();
      } else toast('仍未找到商品，无法采集样本：' + kw);
    });
  });
  // 6 角度逐张拍照上传（capture=environment 直接调起后置摄像头）
  ANGLES.forEach(angle => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment'; inp.style.display = 'none';
    document.body.appendChild(inp);
    $('#aiTake_' + angle).onclick = () => inp.click();
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        if (!cur) { toast('请先扫码选中商品'); inp.value = ''; return; }
        const btn = $('#aiTake_' + angle);
        btn.disabled = true; btn.textContent = '上传中…';
        const dataUrl = await watermarkImage(f, `AI样本·${angle} ${today()} ${ME.name}`);
        const u = await call('POST', '/upload', { image: dataUrl });
        cur.shots[angle] = u.path;
        btn.disabled = false; btn.textContent = '📷 重拍';
        renderCur(); renderShots(); renderGo();
        toast(`${angle}照片已上传`);
      } catch (e) {
        $('#aiTake_' + angle).disabled = false;
        $('#aiTake_' + angle).textContent = '📷 拍照';
        toast(e.message);
      } finally { inp.value = ''; }
    };
  });
  renderCur(); renderGo();
  // 本任务已采集样本预览（annotation.taskId 关联；点击全屏看大图）
  async function loadTaskSamples() {
    const box = $('#aiSamples');
    if (!box) return;
    try {
      const rows = unwrap(await call('GET', '/ai/samples'));
      // 本工单样本：新数据按 task_id 关联；旧数据（无 task_id）回退 annotation.taskId
      const mine = (rows || []).filter(s => s.image_path && (s.task_id ? Number(s.task_id) === arg.id : (s.annotation && Number(s.annotation.taskId) === arg.id)));
      if (!mine.length) { box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      box.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px">` + mine.map(s => `
        <div data-img="${esc(s.image_path)}" style="cursor:zoom-in;text-align:center;width:70px">
          <img src="${esc(s.image_path)}" loading="lazy" style="width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid var(--line)">
          <div class="s" style="font-size:10.5px;color:var(--ink-3)">${esc(s.angle || '样本')}</div>
        </div>`).join('') + `</div>`;
      box.querySelectorAll('[data-img]').forEach(el => el.onclick = () => {
        const lb = document.createElement('div');
        lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:999;display:grid;place-items:center;padding:24px';
        lb.innerHTML = `<img src="${el.dataset.img}" style="max-width:92vw;max-height:88vh;border-radius:12px">`;
        lb.onclick = () => lb.remove();
        document.body.appendChild(lb);
      });
    } catch { /* 静默 */ }
  }
  loadTaskSamples();
  $('#aiGo').onclick = async () => {
    const ready = cur && cur.product && ANGLES.every(a => cur.shots[a]);
    if (!ready) { toast('请先选商品并拍满 6 张角度照片（顶面/正面/背面/左侧面/右侧面/俯斜面）'); return; }
    try {
      const r = await call('POST', '/ai/tasks/' + arg.id + '/submit-sample', {
        productId: cur.product.id,
        images: ANGLES.map(a => ({ angle: a, path: cur.shots[a] })),
        annotation: { taskId: arg.id, name: cur.product.name, barcode: cur.product.barcode },
      });
      t.done_count = r.doneCount; t.progress = r.progress;
      $('#aiProg').textContent = `${r.doneCount} / ${Number(t.target_count || '不限')}`;
      $('#aiBar').innerHTML = progEl();
      cur = null;
      ANGLES.forEach(a => { const b = $('#aiTake_' + a); if (b) { b.textContent = '📷 拍照'; b.disabled = false; } });
      renderCur(); renderShots(); renderGo();
      loadTaskSamples();
      toast(`✅ 样本已提交（${r.sampleCount} 张照片入库，累计 ${r.doneCount} 张，等待店长审核）`);
    } catch (e) { toast(e.message); }
  };
};

/* ═══════════ 次卡核销（5.3：报手机号查会员 → 选次卡 → 核销一次） ═══════════ */
View.timesCard = function (v) {
  v.innerHTML = `
    <div class="sec">会员手机号 / 卡号</div>
    <div style="display:flex;gap:8px">
      <input id="tcPhone" class="search" style="flex:1" placeholder="输入手机号查询" autocomplete="off">
      <button class="mini-btn" id="tcFind" style="flex:0 0 auto;padding:10px 14px">查询</button>
    </div>
    <div id="tcMember"></div>
    <div class="sec">次卡列表（点击「核销一次」）</div>
    <div id="tcList"><div class="empty">先查询会员</div></div>`;
  const find = async () => {
    const kw = $('#tcPhone').value.trim();
    if (!kw) { toast('请输入手机号'); return; }
    try {
      const d = await call('GET', '/members?keyword=' + encodeURIComponent(kw));
      const arr = unwrap(d);
      if (!arr.length) { $('#tcMember').innerHTML = '<div class="empty">未找到会员</div>'; loadCards(null); return; }
      const m = arr[0];
      $('#tcMember').innerHTML = `<div class="ok-bar">会员：${esc(m.name || '—')} · ${esc(m.phone || m.card_no || '')} · ${esc(m.level_name || '普通会员')}</div>`;
      loadCards(Number(m.id));
    } catch (e) { toast(e.message); }
  };
  async function loadCards(mid) {
    const box = $('#tcList');
    if (!mid) { box.innerHTML = '<div class="empty">先查询会员</div>'; return; }
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const all = unwrap(await call('GET', '/coupons/member/' + mid));
      const cards = all.filter(x => x.type === '次卡');
      if (!cards.length) { box.innerHTML = '<div class="empty">该会员暂无次卡</div>'; return; }
      box.innerHTML = cards.map(c => {
        const total = Number(c.discount || 0);
        const used = Number(c.times_used ?? 0);
        const remain = total - used;
        const usable = c.status === '未使用' && remain > 0;
        const stale = c.status === '已过期';
        return `
        <div class="row">
          <div class="grow">
            <div class="t">${esc(c.name)}
              <span class="pill ${stale ? 'red' : remain > 0 ? 'green' : 'gray'}">${stale ? '已过期' : remain > 0 ? '可用' : '已用完'}</span></div>
            <div class="s">已用 ${used}/${total} 次 · 剩余 <b>${Math.max(0, remain)}</b> 次 · ${String(c.expire_at || '').slice(0, 10)} 到期</div>
          </div>
          ${usable ? `<button class="mini-btn ok" data-v="${c.id}" style="color:#fff;background:var(--ok)">核销一次</button>` : ''}
        </div>`;
      }).join('');
      box.querySelectorAll('[data-v]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await call('POST', '/coupons/verify-times', { memberCouponId: Number(b.dataset.v) });
          toast(`✅ 已核销 1 次：${r.name}（剩余 ${r.remain} 次）`);
          loadCards(mid);
        } catch (e) { b.disabled = false; toast(e.message); }
      });
    } catch (e) { box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
  $('#tcFind').onclick = find;
  $('#tcPhone').addEventListener('keydown', e => { if (e.key === 'Enter') find(); });
};
