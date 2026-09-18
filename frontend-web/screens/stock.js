import { get, post, put, must, money, esc, dt, toast, unwrap } from '../api.js';
import { openDetailModal } from '../common-ui.js';
import { showProductDetail } from './product-detail.js';

/** 库存批次（V4.9.3）：
 *  · 库存总览：名称/条码/规格/库存/在途/库存金额/下限/保质期/最近到期日/供应商/状态，12 行分页
 *  · 临期预警：处置状态（未处理/处理中/已退换）+ 处置时限 + 超时处罚；已退换商品出库后自动取消
 *  · 批次查询：供应商/单据号/商品ID/名称/条码多条件，点行看详情；命中入库单号可看入库商品情况
 *  · 三块上下排列（不再并排） */
const PAGE = 12;

export async function render(view) {
  const today = new Date().toISOString().slice(0, 10);
  let rows = [], curPage = 1;
  let suppliers = [];

  view.innerHTML = `
    <div class="card">
      <h3>📦 库存总览 <span class="api">GET /inventory/summary</span></h3>
      <div class="bar" style="padding:12px 18px 10px;flex-wrap:wrap">
        <input id="sKw" placeholder="🔍 名称 / 条码 / 货号 / 拼音 / 供应商" style="min-width:220px">
        <input id="sSup" list="sSupDl7" placeholder="供应商（输入匹配，留空=全部）" style="min-width:170px"><datalist id="sSupDl7"></datalist>
        <label class="muted" style="font-size:12.5px"><input type="checkbox" id="sShort"> 仅缺货</label>
        <button class="btn pri" id="sGo">查询</button>
        <button class="btn pri" id="sMakePo" style="display:none">🛒 勾选生成订货单 (<b id="sPoN">0</b>)</button>
        <span class="muted" id="sCount" style="margin-left:auto;font-size:12px"></span>
      </div>
      <div id="sList" style="padding:0 6px;min-height:432px"></div>
      <div class="doc-foot" style="padding:8px 18px">
        <span class="muted">点批次查询区可溯源；库存金额 = 库存 × 售价</span>
        <span style="flex:1"></span>
        <button class="btn sm" id="sPrev" disabled>‹ 上一页</button>
        <span class="muted" style="display:flex;align-items:center;gap:4px;font-size:12px">第
          <input type="number" id="sJump" min="1" value="1" style="width:52px;text-align:center;padding:2px 4px"> /
          <span id="sPages">1</span> 页</span>
        <button class="btn sm" id="sNext" disabled>下一页 ›</button>
      </div>
    </div>

    <div class="card">
      <h3>⏰ 临期预警 <span class="api">GET /inventory/expiry-alerts · 退/换货流程完成 = 处置到位</span>
        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-weight:400;font-size:12px">
          处置时限 <input id="dHours" type="number" min="1" step="1" style="width:64px"> 天
          <button class="btn sm" id="dHoursSave">💾 保存</button>
          <button class="btn sm pri" id="expReturn">↩ 一键转退货</button>
        </span></h3>
      <div id="sExp" style="padding:0 6px"></div>
    </div>

    <div class="card">
      <h3>🔍 批次查询（FIFO 溯源） <span class="api">GET /inventory/batches</span></h3>
      <div class="bar" style="padding:12px 18px 10px;flex-wrap:wrap">
        <input id="bSup" list="sSupDl7" placeholder="供应商（输入匹配，留空=全部）" style="min-width:170px">
        <input id="bDoc" placeholder="单据号（入库单号 RK-… / 批次号）" style="width:210px">
        <input id="bPid" type="number" placeholder="商品ID" style="width:90px">
        <input id="bKw" placeholder="商品名称 / 条码 / 供应商" style="min-width:180px">
        <button class="btn pri" id="bGo">查询</button>
        <span class="muted" style="font-size:12px">支持：供应商 · 订单/单据号 · 商品ID · 名称 · 条码；点行看批次详情</span>
      </div>
      <div id="bDocBox" style="padding:0 18px"></div>
      <div id="sBatch" style="padding:6px 6px 4px;min-height:120px"><div class="empty">输入条件后查询（支持 供应商 / 单据号 / 商品ID / 名称 / 条码）</div></div>
    </div>

    <div class="modal-mask" id="bModal" style="display:none">
      <div class="modal" style="width:min(760px,94vw);max-height:86dvh;overflow:auto">
        <h3 id="bmTitle">详情</h3>
        <div id="bmMeta" style="font-size:12.5px;line-height:1.9;color:var(--ink-2);margin:6px 0 10px;padding:0 4px"></div>
        <div id="bmBody"></div>
        <div class="doc-foot"></div>
      </div>
    </div>

    <div class="modal-mask" id="dModal" style="display:none">
      <div class="modal" style="max-width:420px">
        <h3>✅ 临期处置到位</h3>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">退/换货流程完成即为处置到位（退货已审核 / 换货已入库）。可填关联单号留痕；已退换商品在剩余天数归零、批次出库后自动取消预警。</div>
        <div class="fld"><label>关联退/换货单号（选填）</label><input id="dDocNo" placeholder="如 TH-20260907-001"></div>
        <div class="doc-foot">
          <button class="btn" id="dCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="dGo">确认处置到位</button>
        </div>
      </div>
    </div>`;

  const $ = s => view.querySelector(s);

  /* ── 供应商输入匹配（两处共用 datalist；V4.9.7 取代下拉） ── */
  try {
    const d = unwrap(await get('/purchase/suppliers'));
    suppliers = (Array.isArray(d) ? d : (d.items || [])) || [];
  } catch { suppliers = []; }
  $('#sSupDl7').innerHTML = suppliers.map(s => `<option value="${esc(s.name)}">`).join('');
  const supIdOf = () => {
    const name = $('#sSup').value.trim() || $('#bSup').value.trim();
    if (!name) return '';
    const hit = suppliers.find(s => s.name === name)
      || suppliers.find(s => (s.name || '').includes(name) || name.includes(s.name || ''));
    return hit ? String(hit.id) : '';
  };

  /* ═══════════ 库存总览（12 行分页；V4.14.9 勾选一键生成订货单） ═══════════ */
  const poSel = new Set();   // 勾选待订货的商品 id
  function drawPage() {
    const tp = Math.max(1, Math.ceil(rows.length / PAGE));
    curPage = Math.min(curPage, tp);
    const items = rows.slice((curPage - 1) * PAGE, curPage * PAGE);
    $('#sPages').textContent = String(tp);
    const jump = $('#sJump');
    jump.max = String(tp); jump.value = String(curPage);
    $('#sPrev').disabled = curPage <= 1;
    $('#sNext').disabled = curPage >= tp;
    $('#sCount').textContent = `共 ${rows.length} 个商品 · 每页 ${PAGE} 行`;
    // V4.26.2：全选框必须回显勾选状态（onchange 会 drawPage() 重绘本页，
    // 无回显则重绘后变回未勾选，表现为「只能全选、无法取消全选」）
    const sAllChecked = items.length > 0 && items.every(p => poSel.has(Number(p.id)));
    $('#sList').innerHTML = items.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="sChkAll" title="全选/取消全选本页" ${sAllChecked ? 'checked' : ''}></th><th>名称</th><th>条码</th><th>规格</th><th class="num">库存</th><th class="num">在途</th>
        <th class="num">库存金额</th><th class="num">下限</th><th class="num">保质期</th><th>最近到期日</th><th>供应商</th><th>状态</th></tr></thead>
      <tbody>${items.map(p => `<tr data-prow="${p.id}" style="cursor:pointer" title="双击查看商品明细">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-spo="${p.id}" data-qty="${Number(p.qty_total)}" data-min="${Number(p.min_stock)}" data-max="${Number(p.max_stock)}" ${poSel.has(Number(p.id)) ? 'checked' : ''}></td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${esc(p.name)}</b></td>
        <td style="font-family:var(--mono)">${esc(p.barcode || '—')}</td>
        <td class="muted">${esc(p.spec || '—')}</td>
        <td class="num" style="font-weight:700;${Number(p.qty_total) <= Number(p.min_stock) ? 'color:var(--warn)' : ''}">${Number(p.qty_total)}</td>
        <td class="num">${Number(p.qty_on_order)}</td>
        <td class="num">${money(p.stock_value)}</td>
        <td class="num">${Number(p.min_stock)}</td>
        <td class="num">${p.keep_days ? p.keep_days + ' 天' : '<span class="tag y">未填</span>'}</td>
        <td>${p.nearest_expiry ? `<span class="${daysCls(p.nearest_expiry)}">${String(p.nearest_expiry).slice(0, 10)}</span>` : '—'}</td>
        <td class="muted" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.supplier_name || '—')}</td>
        <td>${Number(p.qty_total) <= 0 ? '<span class="tag r">补货</span>'
              : p.is_low ? '<span class="tag y">低于下限</span>' : '<span class="tag g">正常</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">无记录</div>';
    // V4.9.7 双击商品行 → 商品明细弹窗（同商品档案详情）
    $('#sList').querySelectorAll('[data-prow]').forEach(tr => tr.ondblclick = () => showProductDetail(Number(tr.dataset.prow)));
    // 勾选 →「生成订货单」按钮
    $('#sList').querySelectorAll('[data-spo]').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.spo);
      if (cb.checked) poSel.add(id); else poSel.delete(id);
      syncPoBtn();
    });
    const chkAll = $('#sChkAll');
    if (chkAll) chkAll.onchange = () => {
      items.forEach(p => { if (chkAll.checked) poSel.add(Number(p.id)); else poSel.delete(Number(p.id)); });
      drawPage();
    };
    syncPoBtn();
  }
  function syncPoBtn() {
    $('#sMakePo').style.display = poSel.size ? '' : 'none';
    $('#sPoN').textContent = String(poSel.size);
  }
  // V4.15.1 勾选生成订货单：先弹「订货单编辑」弹窗（采购订单样式）——自动填充建议数量与最近进价，可改可删行，确认后才生成
  $('#sMakePo').onclick = async () => {
    const picked = [...poSel].map(id => rows.find(r => Number(r.id) === id)).filter(Boolean);
    if (!picked.length) return;
    const draft = picked.map(p => ({
      productId: Number(p.id),
      name: p.name, spec: p.spec || '', baseUnit: p.base_unit || '',
      supplier: p.supplier_name || '—',
      qty: Math.max(Math.ceil(((Number(p.min_stock) || 0) * 2) - Number(p.qty_total || 0)), 1),   // 建议订货量：补到下限 2 倍
      price: Number(p.last_cost) || null,                                                          // 最近进价自动填充
      stock: Number(p.qty_total || 0), min: Number(p.min_stock || 0),
    }));
    const { mask, close } = openDetailModal(`🛒 生成订货单（${draft.length} 项商品）`, `
      <div class="muted" style="font-size:12.5px;padding:2px 0 8px">建议数量 = 库存下限 × 2 − 现有库存；进价已自动填充<b>最近一批进价</b>，均可修改；不想订的行取消勾选即可。确认后按供应商自动拆单（草稿），到「采购订单」处理。</div>
      <table><thead><tr>
        <th style="width:34px"><input type="checkbox" id="spoAll" checked title="全选/取消全选"></th>
        <th>商品</th><th>规格</th><th>供应商</th><th class="num">现有库存</th><th class="num">下限</th>
        <th class="num" style="width:110px">订货数量</th><th class="num" style="width:120px">进价（元）</th><th class="num">小计</th></tr></thead>
      <tbody id="spoBody">${draft.map((d, ix) => `<tr data-ix="${ix}">
        <td><input type="checkbox" class="spo-chk" data-ix="${ix}" checked></td>
        <td><b>${esc(d.name)}</b></td><td class="muted">${esc(d.spec)}</td><td class="muted">${esc(d.supplier)}</td>
        <td class="num">${d.stock}</td><td class="num">${d.min}</td>
        <td class="num"><input type="number" class="spo-qty" data-ix="${ix}" min="1" step="1" value="${d.qty}" style="width:88px;text-align:right;padding:3px 6px"></td>
        <td class="num"><input type="number" class="spo-price" data-ix="${ix}" min="0" step="0.01" value="${d.price ?? ''}" placeholder="无进价记录" style="width:100px;text-align:right;padding:3px 6px"></td>
        <td class="num spo-sub">—</td></tr>`).join('')}</tbody></table>
      <div class="bar" style="justify-content:flex-end;margin-top:10px;gap:10px">
        <span class="muted" id="spoSum"></span>
        <button class="btn" id="spoCancel">取消</button>
        <button class="btn pri" id="spoGo">✔ 确认生成订货单</button>
      </div>`, { width: 940 });
    const recalc = () => {
      let total = 0, n = 0;
      mask.querySelectorAll('tbody tr[data-ix]').forEach(tr => {
        const d = draft[Number(tr.dataset.ix)];
        const q = Number(tr.querySelector('.spo-qty').value) || 0;
        const pr = tr.querySelector('.spo-price').value === '' ? null : Number(tr.querySelector('.spo-price').value);
        tr.querySelector('.spo-sub').textContent = (q && pr != null) ? '¥' + (q * pr).toFixed(2) : '—';
        if (tr.querySelector('.spo-chk').checked && q > 0) { n++; if (pr != null) total += q * pr; }
      });
      mask.querySelector('#spoSum').textContent = `已选 ${n} 项 · 预估金额 ¥${total.toFixed(2)}（无进价行不计）`;
      return n;
    };
    mask.addEventListener('input', recalc);
    mask.addEventListener('change', e => {
      if (e.target.id === 'spoAll') mask.querySelectorAll('.spo-chk').forEach(cb => cb.checked = e.target.checked);
      recalc();
    });
    recalc();
    mask.querySelector('#spoCancel').onclick = close;
    mask.querySelector('#spoGo').onclick = async () => {
      const items = [];
      mask.querySelectorAll('tbody tr[data-ix]').forEach(tr => {
        if (!tr.querySelector('.spo-chk').checked) return;
        const d = draft[Number(tr.dataset.ix)];
        const q = Number(tr.querySelector('.spo-qty').value) || 0;
        const pr = tr.querySelector('.spo-price').value === '' ? null : Number(tr.querySelector('.spo-price').value);
        if (q > 0) items.push({ productId: d.productId, orderQty: Math.round(q), ...(pr != null ? { price: pr } : {}) });
      });
      if (!items.length) return toast('请至少保留一行有效订货（数量 > 0）', false);
      try {
        const d = await must(post('/purchase/orders', { items, source: '库存缺货' }));
        if (d?.multi) toast(`已按供应商自动拆分为 ${d.docCount} 张订货单（草稿），请到「采购订单」处理`);
        else toast(`订货单 ${d?.poNo || ''} 已生成（草稿），请到「采购订单」处理`);
        poSel.clear(); syncPoBtn(); close();
      } catch { /* must 已 toast */ }
    };
  };
  const daysCls = d => {
    const n = Math.ceil((new Date(d) - new Date(today)) / 86400000);
    return n <= 3 ? 'color:var(--warn);font-weight:700' : n <= 7 ? 'color:#b34f18;font-weight:700' : '';
  };
  async function list() {
    const p = new URLSearchParams();
    const kw = $('#sKw').value.trim(); if (kw) p.set('keyword', kw);
    if ($('#sShort').checked) p.set('onlyShort', '1');
    const sid = supIdOf(); if (sid) p.set('supplierId', sid);
    const d = await must(get('/inventory/summary?' + p));
    rows = Array.isArray(d) ? d : (d.items || []);
    curPage = 1;
    drawPage();
  }
  $('#sGo').onclick = list;
  $('#sShort').onchange = list;
  $('#sKw').addEventListener('keydown', e => { if (e.key === 'Enter') list(); });
  $('#sPrev').onclick = () => { curPage--; drawPage(); };
  $('#sNext').onclick = () => { curPage++; drawPage(); };
  // V4.14.9 手输页码跳页
  const jumpPage = () => {
    const inp = $('#sJump');
    const tp = Math.max(1, Math.ceil(rows.length / PAGE));
    const p = Math.min(Math.max(1, Number(inp.value) || 1), tp);
    curPage = p; drawPage();
  };
  $('#sJump').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); jumpPage(); } });
  $('#sJump').addEventListener('change', jumpPage);

  /* ═══════════ 临期预警（处置闭环） ═══════════ */
  // 处置时限设置读取/保存（V4.9.7 单位改「天」，内部仍存小时）
  (async () => {
    try {
      const st = await must(get('/settings'));
      const arr = Array.isArray(st) ? st : (st.items || []);
      const hit = arr.find(x => x.setting_key === 'stock.expiry_disposal_hours');
      const hrs = hit ? (Array.isArray(hit.value) ? hit.value[0] : hit.value) : 48;
      $('#dHours').value = Math.max(1, Math.round(Number(hrs) / 24));
    } catch { $('#dHours').value = 2; }
  })();
  $('#dHoursSave').onclick = async () => {
    const days = Number($('#dHours').value);
    if (!(days > 0)) return toast('时限必须大于 0 天', false);
    await must(put('/settings/stock.expiry_disposal_hours', { value: days * 24, reason: '临期处置时限调整（天）' }), `处置时限已保存（${days} 天）`);
    loadExp();
  };

  let disposeBatch = 0;
  async function loadExp() {
    const rows2 = await must(get('/inventory/expiry-alerts')).catch(() => []);
    const arr = Array.isArray(rows2) ? rows2 : (rows2.items || []);
    $('#sExp').innerHTML = arr.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="expAll" title="全选可退批次"></th><th>名称</th><th>条码</th><th class="num">数量</th><th>到期日期</th><th class="num">剩余天数</th>
        <th>供应商</th><th>处置状态</th><th>处置时限</th><th style="width:190px">操作</th></tr></thead>
      <tbody>${arr.map(b => {
        const stTag = b.disposal_status === '已退换' ? '<span class="tag g">已退/换货</span>'
          : b.disposal_status === '处理中' ? '<span class="tag b">处理中</span>'
          : '<span class="tag r">未处理</span>';
        const dl = b.deadline_at ? dt(b.deadline_at) : '—';
        const overdue = b.penalized && b.disposal_status !== '已退换';
        const inDoc = b.return_doc_no ? `<div class="muted" style="font-size:11px">关联单：${esc(b.return_doc_no)}${b.handler_name ? ' · ' + esc(b.handler_name) : ''}</div>` : '';
        const canPick = b.disposal_status !== '已退换';
        return `<tr>
        <td>${canPick ? `<input type="checkbox" class="expPick" data-bid="${b.batch_id}">` : ''}</td>
        <td style="max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${esc(b.product_name)}</b></td>
        <td style="font-family:var(--mono)">${esc(b.barcode || '—')}</td>
        <td class="num">${Number(b.remain_qty)}</td>
        <td>${String(b.expiry_date).slice(0, 10)}</td>
        <td class="num"><span class="${b.days_left <= 3 ? 'tag r' : 'tag y'}" style="font-size:11px">${b.days_left} 天</span></td>
        <td class="muted">${esc(b.supplier_name || '—')}</td>
        <td>${stTag}${overdue ? ' <span class="tag r" title="超过处置时限未处置到位，已记处罚">⚠ 超时处罚</span>' : ''}${inDoc}</td>
        <td class="muted" style="font-size:12px">${dl}</td>
        <td style="white-space:nowrap">
          ${b.disposal_status === '未处理' ? `<button class="btn sm" data-dstart="${b.batch_id}">▶ 开始处置</button>` : ''}
          ${b.disposal_status !== '已退换' ? `<button class="btn sm pri" data-ddone="${b.batch_id}">✅ 完成退/换货</button>` : '<span class="muted" style="font-size:11.5px">已到位</span>'}
        </td>
      </tr>`; }).join('')}</tbody></table>
      <div class="muted" style="padding:8px 12px 10px;font-size:11.5px">处置流程：店长/店员在移动端「工作台 ▸ 临期预警」或此页处置；<b>退/换货流程完成（退货已审核 / 换货已入库）= 处置到位</b>；超过处置时限未到位记处罚标记。已退/换货的商品在剩余天数归零、批次出库后自动取消预警；退货单审核通过时自动联动标记到位。勾选批次后点「一键转退货」= 整批全退生成供应商退货单（待审核，凭证补传后审核、审核通过自动扣库存并标记到位）。</div>`
      : '<div class="empty">无临期批次</div>';
    const all = $('#expAll');
    if (all) all.onchange = () => view.querySelectorAll('.expPick').forEach(c => { c.checked = all.checked; });
    $('#expReturn').onclick = async () => {
      const bids = [...view.querySelectorAll('.expPick:checked')].map(c => Number(c.dataset.bid));
      if (!bids.length) { toast('请先勾选要转退货的批次'); return; }
      if (!confirm(`将选中的 ${bids.length} 个批次整批转退货？\n生成供应商退货单（待审核），凭证补传并审核通过后自动扣库存。`)) return;
      const r = await must(post('/purchase/returns/from-expiry', { batchIds: bids }), null);
      const nos = (r?.returnNos || []).join('、');
      toast(`已生成 ${r?.docCount ?? 0} 张退货单：${nos}（待审核）`);
      loadExp();
    };
    view.querySelectorAll('[data-dstart]').forEach(b => b.onclick = async () => {
      await must(post(`/inventory/expiry-disposals/${b.dataset.dstart}/start`, {}), '已开始处置（转「处理中」）');
      loadExp();
    });
    view.querySelectorAll('[data-ddone]').forEach(b => b.onclick = () => {
      disposeBatch = Number(b.dataset.ddone);
      $('#dDocNo').value = '';
      $('#dModal').style.display = 'flex';
    });
  }
  $('#dCancel').onclick = () => { $('#dModal').style.display = 'none'; };
  $('#dGo').onclick = async () => {
    await must(post(`/inventory/expiry-disposals/${disposeBatch}/done`, { returnDocNo: $('#dDocNo').value.trim() || undefined }), '处置到位（已退/换货）');
    $('#dModal').style.display = 'none';
    loadExp();
  };

  /* ═══════════ 批次查询（多条件 + 详情） ═══════════ */
  $('#bGo').onclick = async () => {
    const p = new URLSearchParams();
    const bSid = supIdOf(); if (bSid) p.set('supplierId', bSid);
    const doc = $('#bDoc').value.trim(); if (doc) p.set('docNo', doc);
    const pid = $('#bPid').value.trim(); if (pid) p.set('productId', pid);
    const kw = $('#bKw').value.trim(); if (kw) p.set('keyword', kw);
    const d = await must(get('/inventory/batches?' + p));
    const items = Array.isArray(d) ? d : (d.items || []);
    // 命中单据号 → 入库单概要条
    const doc0 = (!Array.isArray(d) && d.doc) ? d.doc : null;
    $('#bDocBox').innerHTML = doc0 ? `
      <div style="margin:6px 0 2px;padding:10px 14px;background:var(--info-soft,#eef4fb);border:1px solid var(--line);border-radius:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <b>📄 命中入库单 ${esc(doc0.inbound_no)}</b>
        <span class="muted">供应商：${esc(doc0.supplier_name || '—')}</span>
        <span class="muted">金额：${money(doc0.total_amount)}</span>
        <span class="muted">状态：${esc(doc0.status)}</span>
        <button class="btn sm pri" id="bDocOpen">查看入库商品情况</button>
      </div>` : '';
    if (doc0) $('#bDocOpen').onclick = () => openInbound(doc0.id);
    $('#sBatch').innerHTML = items.length ? `
      <table><thead><tr><th>批次号</th><th>商品</th><th>供应商</th><th>入库单号</th><th>入库日</th><th>到期日</th>
        <th class="num">剩余</th><th class="num">进价</th><th>状态</th></tr></thead>
      <tbody>${items.map(b => `<tr data-batch="${b.id}" style="cursor:pointer" title="点击查看批次详情">
        <td style="font-family:var(--mono)">${esc(b.batch_no)}</td>
        <td>${esc(b.product_name)}${b.product_barcode ? ` <span class="muted mono" style="font-size:11px">${esc(b.product_barcode)}</span>` : ''}</td>
        <td class="muted">${esc(b.supplier_name || '—')}</td>
        <td class="muted mono">${esc(b.inbound_no || '—')}</td>
        <td>${String(b.inbound_date).slice(0, 10)}</td>
        <td>${b.expiry_date ? `<span class="${daysCls(b.expiry_date)}">${String(b.expiry_date).slice(0, 10)}</span>` : '—'}</td>
        <td class="num" style="font-weight:700">${Number(b.remain_qty)}</td>
        <td class="num">${money(b.inbound_cost)}</td>
        <td>${esc(b.status)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">无批次记录（可按 供应商 / 单据号 / 商品ID / 名称 / 条码 查询）</div>';
    view.querySelectorAll('[data-batch]').forEach(tr => tr.onclick = () => openBatchDetail(items.find(x => Number(x.id) === Number(tr.dataset.batch))));
  };

  function modal(title, meta, bodyHtml) {
    $('#bmTitle').textContent = title;
    $('#bmMeta').innerHTML = meta;
    $('#bmBody').innerHTML = bodyHtml;
    $('#bModal').style.display = 'flex';
  }
  // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）

  function openBatchDetail(b) {
    if (!b) return;
    modal(`批次 ${b.batch_no}`,
      `商品：<b>${esc(b.product_name)}</b>（ID ${b.product_id}）　供应商：${esc(b.supplier_name || '—')}　
       入库单：${esc(b.inbound_no || '—')}　入库日：${String(b.inbound_date).slice(0, 10)}　
       生产日期：${b.production_date ? String(b.production_date).slice(0, 10) : '—'}　到期：${b.expiry_date ? String(b.expiry_date).slice(0, 10) : '—'}`,
      `<table><thead><tr><th class="num">入库量</th><th class="num">剩余</th><th class="num">批次进价</th><th class="num">批次金额</th><th>状态</th></tr></thead>
       <tbody><tr>
         <td class="num">${Number(b.inbound_qty)}</td><td class="num"><b>${Number(b.remain_qty)}</b></td>
         <td class="num">${money(b.inbound_cost)}</td><td class="num">${money(Number(b.inbound_qty) * Number(b.inbound_cost))}</td>
         <td>${esc(b.status)}</td></tr></tbody></table>`);
  }

  /** 入库单详情（点「命中入库单」展开入库商品情况） */
  async function openInbound(id) {
    try {
      const d = await must(get('/purchase/inbounds/' + id));
      const o = d.order || {};
      modal(`入库单 ${o.inbound_no || id}`,
        `供应商：<b>${esc(o.supplier_name || '—')}</b>　状态：${esc(o.status)}　
         制单人：${esc(o.maker_name || '—')}　日期：${String(o.inbound_date || o.created_at || '').slice(0, 10)}　
         金额：<b>${money(o.total_amount)}</b>`,
        (d.items || []).length ? `
        <table><thead><tr><th>序号</th><th>商品</th><th>单位</th><th>批次号</th><th class="num">数量</th><th class="num">进价</th><th class="num">金额</th></tr></thead>
        <tbody>${d.items.map((it, i) => `<tr><td class="num">${i + 1}</td><td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '—')}</td>
          <td class="mono">${esc(it.batch_no || '—')}</td><td class="num">${Number(it.qty)}</td>
          <td class="num">${money(it.unit_cost ?? it.price)}</td><td class="num">${money((Number(it.qty) || 0) * Number(it.unit_cost ?? it.price ?? 0))}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">无明细</div>');
    } catch (e) { /* must 已 toast */ }
  }

  $('#sExp').innerHTML = '<div class="empty">加载中…</div>';
  await Promise.all([list(), loadExp()]);
}
