import { get, post, must, esc, toast, dt, money, API } from '../api.js';
import { findProduct, fuzzyProducts, showSuggest, hideSug } from './docentry.js';
import { paginate, bindPager } from '../common-ui.js';
import { transmitScaleItems } from '../scale-protocols/transmit.js';

/** 商品调价单：进价/售价同行修改 + 待审核→审核生效→作废 审核流 */
export async function render(view) {
  const today = new Date().toISOString().slice(0, 10);
  /** 行结构：与采购单据（docentry）对齐，_q = 行内条码格输入缓存 */
  const blankLine = () => ({ productId: null, name: '', barcode: '', unit: '', oldSale: '', newSale: null, oldCost: null, newCost: null, supplierId: null, _q: '' });
  let lines = [];
  let pcs = [];
  let products = [];   // 全量商品（行内条码定位用，进入新增页时懒加载）
  async function ensureProducts() {
    if (products.length) return;
    try { const d = await must(get('/products?size=500')); products = d.items || d || []; }
    catch { /* must 已 toast 失败原因 */ }
  }

  view.innerHTML = `
    <div class="card" id="tab-new" style="display:none">
      <h3>调价管理（新增） </h3>
      <div class="doc-tools">
        <button class="btn" id="pcBackList">← 返回列表</button>
        <button class="btn pri" id="pcSave">💾 保存调价单（待审核）</button>
        <button class="btn" id="pcClear">清空明细</button>
        <span class="muted">单号 TJ-/JC- 自动生成 · 审核通过后价格生效</span>
      </div>
      <div class="doc-head">
        <div class="fld"><label>生效日期</label><input id="pcDate" type="date" value="${today}"></div>
        <div class="fld"><label>调价范围</label>
          <select id="pcScope">
            <option value="all">🌐 整体调价（所有门店生效）</option>
            <option value="local">🏪 本地门店调价（仅所调门店）</option>
          </select>
        </div>
        <div class="fld" id="pcStoreWrap" style="display:none"><label>目标门店</label><select id="pcStore"></select></div>
        <div class="fld fld-wide"><label>备注</label><input id="pcRemark" placeholder="调价原因（如：临期清仓/供应商调价通知）"></div>
      </div>
      <div class="doc-grid" style="padding:6px 18px 4px">
        <style>#pcTable th, #pcTable td { padding: 7px 12px; } #pcTable td, #pcTable th { vertical-align: middle; } #pcTable input[type="number"] { text-align: right; }</style>
        <table data-colresize="price-change-lines" id="pcTable" style="table-layout:fixed">
          <thead><tr>
          <th style="width:7%">＋/−</th><th style="width:5%">序号</th><th style="width:16%">条码</th><th style="width:22%">商品</th><th style="width:7%;text-align:right">单位</th>
          <th class="num" style="width:11%">现进价</th><th class="num" style="width:11%">新进价</th>
          <th class="num" style="width:11%">现售价</th><th class="num" style="width:10%">新售价</th>
        </tr></thead>
        <tbody id="pcLines"></tbody></table>
        <div class="doc-foot" id="pcFoot">共 0 行 · 售价差额 ¥0.00 · 进价差额 ¥0.00</div>
      </div>
      <div class="doc-tip">💡 在行内「条码」列扫码 / 输入名称拼音定位商品（回车确认、自动加行连续录入）；同一行可同时修改售价与进价，也可只改其一；保存后进入「⏳待审核」，审核通过才实际生效；进价在审核后落地供应商进价基线（调价通知 V4.3.6，下调同步刷新最低价保护线）。</div>
    </div>
    <div class="card" id="tab-list">
      <h3>调价管理 </h3>
      <div class="bar">
        <button class="btn pri" id="pcNewDoc">＋ 新增调价单</button>
        <select id="pcTypeFilter">
          <option value="">全部类型</option>
          <option value="sale">💰 售价调价</option>
          <option value="cost">📥 进价调价</option>
          <option value="dual">💰📥 混合调价</option>
        </select>
        <select id="pcStatusFilter">
          <option value="">全部状态</option>
          <option value="pending">⏳ 待审核</option>
          <option value="approved">✅ 已生效</option>
          <option value="voided">🚫 已作废</option>
        </select>
        <input id="pcFrom" type="date" title="起始日期">
        <input id="pcTo" type="date" title="截止日期">
        <button class="btn pri" id="pcSearchBtn">🔍 查询</button>
        <button class="btn" id="pcRefresh">刷新</button>
        <button class="btn" id="pcStorePrices" title="查看/清理各门店的门店特价（本地门店调价结果）">🏪 门店特价</button>
      </div>
      <div id="pcList" class="tbl-min"></div>
    </div>`;

  const $ = s => view.querySelector(s);

  // ── 连锁调价：范围选择 + 门店下拉 ──
  let stores = [];
  async function loadStores() {
    try { stores = await must(get('/basic/stores')); } catch { stores = []; }
    const cur = Number(API.user?.storeId || 1);
    $('#pcStore').innerHTML = stores.map(s => `<option value="${s.id}"${Number(s.id) === cur ? ' selected' : ''}>${esc(s.name)}${Number(s.id) === cur ? '（本店）' : ''}</option>`).join('');
  }
  // 范围/门店切换 → 现价与差额口径都变了：清缓存现价并重刷
  function onScopeChange() {
    const local = $('#pcScope').value === 'local';
    $('#pcStoreWrap').style.display = local ? '' : 'none';
    for (const l of lines) l.oldSale = '';
    refreshCostBase();
  }
  $('#pcScope').addEventListener('change', onScopeChange);
  $('#pcStore').addEventListener('change', onScopeChange);

  // ── 行内条码定位（docentry 同款：扫码 / 手输 / 名称拼音模糊 → 建议下拉） ──
  function pick(i, p) {
    hideSug();
    const dup = lines.findIndex((x, xi) => xi !== i && x.productId === Number(p.id));
    if (dup >= 0) { toast(`「${p.name}」已在第 ${dup + 1} 行，同一商品只保留一行`); return; }
    const l = lines[i];
    l.productId = Number(p.id); l.name = p.name || ''; l.barcode = p.barcode || '';
    l.unit = p.base_unit || ''; l.oldSale = Number(p.sell_price ?? 0);
    l._q = p.barcode || '';
    drawLines();
    refreshCostBase();
    // 焦点跳到本行第一个可编辑价格格（不写死 pc-sale：列顺序调整后仍正确，V4.26.2）
    const first = $('#pcLines').querySelector(`[data-nav][data-i="${i}"]`);
    first && first.focus();
  }

  async function refreshCostBase() {
    // V4.26.5：现进价/现售价都要按「本次调价范围」取口径 ——
    //   整体调价看基线价；本地门店调价看该门店有效价（后端按门店覆盖价返回）
    const ids = lines.filter(l => l.productId).map(l => l.productId).join(',');
    if (!ids) return;
    const sid = $('#pcScope').value === 'local' ? Number($('#pcStore').value || API.user?.storeId || 1) : 0;
    try {
      const cb = await must(get('/price-changes/cost-base?productIds=' + ids + (sid ? '&storeId=' + sid : '')));
      for (const r of (cb.items || [])) {
        const l = lines.find(x => x.productId === Number(r.product_id));
        if (l) {
          l.oldCost = Number(r.old_cost);
          l.supplierId = r.supplier_default_id ? Number(r.supplier_default_id) : null;
          if (r.sell_price !== undefined && r.sell_price !== null) l.oldSale = Number(r.sell_price);
        }
      }
      drawLines();
    } catch (e) { /* 静默：基线拉取失败不阻塞开单 */ }
  }

  function updateFoot() {
    const ok = v => v !== null && v !== undefined && v !== '';
    const ds = lines.reduce((a, l) => a + (ok(l.newSale) ? Number(l.newSale) - Number(l.oldSale || 0) : 0), 0);
    const dc = lines.reduce((a, l) => a + (ok(l.newCost) ? Number(l.newCost) - Number(l.oldCost ?? 0) : 0), 0);
    $('#pcFoot').textContent = `共 ${lines.length} 行 · 售价差额 ${ds >= 0 ? '+' : '−'}${money(Math.abs(ds))} · 进价差额 ${dc >= 0 ? '+' : '−'}${money(Math.abs(dc))}`;
  }

  function drawLines() {
    const tb = $('#pcLines');
    if (!lines.length) {
      tb.innerHTML = '<tr><td colspan="9" class="empty">空单：在首行「条码」列扫码 / 输入条码 / 名称拼音定位商品</td></tr>';
      updateFoot();
      return;
    }
    tb.innerHTML = lines.map((l, i) => `
      <tr data-li="${i}">
        <td style="white-space:nowrap;width:64px">
          <button class="btn sm" data-plus="${i}" title="在下方插入一行" style="padding:2px 7px">＋</button>
          <button class="btn sm warn" data-minus="${i}" title="${i === 0 ? '首行不可删除（可清空本行数据）' : '删除本行'}" style="padding:2px 7px" ${i === 0 ? 'disabled' : ''}>−</button>
        </td>
        <td style="width:36px">${i + 1}</td>
        <td><input data-bc="${i}" value="${esc(l._q || '')}" placeholder="扫码/条码/名称"
             style="width:92%;font-family:var(--mono,monospace)"></td>
        <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.name || '')}">${l.name ? `<b>${esc(l.name)}</b>` : '<span class="muted">—</span>'}</td>
        <td style="text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.unit || '—')}</td>
        <td class="num">${l.oldCost === null ? '<span class="muted">读取中…</span>' : (l.productId ? money(l.oldCost) : '—')}</td>
        <td class="num"><input class="pc-in pc-cost" data-i="${i}" data-nav="1" type="number" step="0.01" min="0" value="${l.newCost ?? ''}" placeholder="不改留空" style="width:92%"></td>
        <td class="num">${l.productId ? money(l.oldSale) : '—'}</td>
        <td class="num"><input class="pc-in pc-sale" data-i="${i}" data-nav="1" type="number" step="0.01" min="0" value="${l.newSale ?? ''}" placeholder="不改留空" style="width:92%"></td>
      </tr>`).join('');
    updateFoot();
  }

  $('#pcLines').addEventListener('input', e => {
    // 行内条码格：输入即模糊建议（docentry 同款）
    const bc = e.target.closest('input[data-bc]');
    if (bc) {
      const i = Number(bc.dataset.bc);
      if (!lines[i]) return;
      lines[i]._q = bc.value;
      showSuggest(bc, products, p => pick(i, p));
      return;
    }
    const inp = e.target.closest('.pc-in');
    if (!inp) return;
    const l = lines[Number(inp.dataset.i)];
    if (!l) return;
    const v = inp.value === '' ? null : Number(inp.value);
    if (inp.classList.contains('pc-sale')) l.newSale = v; else l.newCost = v;
    updateFoot();
  });
  // V4.26.2：条码格回车定位商品；价格格回车换列，行末自动加行；↑/↓ 同列切行（对齐采购单据）
  $('#pcLines').addEventListener('keydown', e => {
    const bc = e.target.closest('input[data-bc]');
    if (bc && e.key === 'Enter') {
      e.preventDefault();
      const i = Number(bc.dataset.bc);
      const exact = findProduct(products, bc.value);
      if (exact) return pick(i, exact);
      const hits = fuzzyProducts(products, bc.value, 2);
      if (hits.length === 1) return pick(i, hits[0]);
      if (!showSuggest(bc, products, p => pick(i, p))) toast(`未找到商品：${bc.value || '（空）'}`, false);
      return;
    }
    const el = e.target.closest('[data-nav]');
    if (!el) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const rows = [...$('#pcLines').querySelectorAll('[data-nav]')];
      const next = rows[rows.indexOf(el) + 1];
      if (next) next.focus();
      else {   // 最后一行行末：自动加行，条码格接续扫码
        lines.push(blankLine());
        drawLines();
        setTimeout(() => {
          const nbc = $('#pcLines').querySelector(`input[data-bc="${lines.length - 1}"]`);
          nbc && nbc.focus();
        }, 0);
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const col = el.classList.contains('pc-sale') ? '.pc-sale' : '.pc-cost';
      const row = Number(el.dataset.i) + (e.key === 'ArrowDown' ? 1 : -1);
      const tgt = $('#pcLines').querySelector(`${col}[data-i="${row}"]`);
      tgt && tgt.focus();
    }
  });
  $('#pcLines').addEventListener('click', e => {
    const plus = e.target.closest('[data-plus]');
    if (plus) { lines.splice(Number(plus.dataset.plus) + 1, 0, blankLine()); drawLines(); return; }
    const minus = e.target.closest('[data-minus]');
    if (minus) {
      const mi = Number(minus.dataset.minus);
      if (mi === 0) return;                                // V4.26.2 首行不可删除
      lines.splice(mi, 1);
      drawLines();
    }
  });

  $('#pcSave').addEventListener('click', async () => {
    if (!lines.length) return toast('调价明细为空');
    const has = v => v !== null && v !== undefined && v !== '';
    const valid = lines.filter(l => l.productId && (has(l.newSale) || has(l.newCost)));
    if (!valid.length) return toast('请至少为一个商品填写新售价或新进价');
    // 进价调整但缺供应商 → 弹窗让用户选供应商
    const needSup = valid.filter(l => has(l.newCost) && !l.supplierId);
    if (needSup.length) {
      const okPick = await pickSuppliers(needSup);
      if (!okPick) return;   // 用户取消
    }
    const items = valid.map(l => ({
      productId: l.productId,
      supplierId: l.supplierId || undefined,
      newPrice: has(l.newSale) ? Number(l.newSale) : undefined,
      newCost: has(l.newCost) ? Number(l.newCost) : undefined,
    }));
    const scope = $('#pcScope').value === 'local' ? 'local' : 'all';
    const body = {
      items,
      effectiveDate: $('#pcDate').value || undefined,
      remark: $('#pcRemark').value.trim() || undefined,
      applyScope: scope,
    };
    if (scope === 'local') body.targetStoreId = Number($('#pcStore').value || API.user?.storeId || 1);
    try {
      const r = await must(post('/price-changes', body));
      toast(`调价单 ${r.pcNo} 已保存（⏳ 待审核），审核通过后生效`);
      lines = [blankLine()];
      $('#pcRemark').value = '';
      drawLines();
      await loadPcs();
    } catch (e) { /* must 已 toast 失败原因 */ }
  });
  $('#pcClear').addEventListener('click', () => { lines = [blankLine()]; drawLines(); });

  // 调价商品缺供应商 → 弹窗逐行选择：进价落地供应商基线必须有 supplierId
  async function pickSuppliers(rows) {
    let suppliers = [];
    try { suppliers = await must(get('/purchase/suppliers')); } catch { suppliers = []; }
    if (!suppliers.length) { toast('暂无可用供应商，请先到「采购 → 供应商」建档', false); return false; }
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99;display:flex;align-items:center;justify-content:center';
    const opts = suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    mask.innerHTML = `
      <div class="modal" style="width:min(560px,94vw);max-height:86dvh;overflow:auto;padding:20px 22px">
        <h3>🏷️ 选择供应商</h3>
        <p class="muted" style="margin:6px 0 14px">以下商品需做进价调整但缺少供应商，请逐行指定（影响进价基线落地）：</p>
        <div id="supList">${rows.map(l => `
          <div style="display:flex;gap:10px;align-items:center;margin:8px 0">
            <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.name || ('商品#' + l.productId))}</div>
            <select data-sup="${l.productId}" style="min-width:160px">${opts}</select>
          </div>`).join('')}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
          <button class="btn" id="supCancel">取消</button>
          <button class="btn pri" id="supOk">确认并继续保存</button>
        </div>
      </div>`;
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
    return await new Promise(resolve => {
      mask.querySelector('#supCancel').onclick = () => { mask.remove(); resolve(false); };
      mask.querySelector('#supOk').onclick = () => {
        rows.forEach(l => { const sel = mask.querySelector(`[data-sup="${l.productId}"]`); if (sel) l.supplierId = Number(sel.value); });
        drawLines();
        mask.remove();
        resolve(true);
      };
    });
  }

  // ── V4.26.5 门店特价管理：查看各门店实际价 + 一键恢复默认价（闭环「本地门店调价」） ──
  async function openStorePrices() {
    if (!stores.length) await loadStores();   // 直接进列表页时门店下拉尚未加载
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:90;display:flex;align-items:center;justify-content:center';
    mask.innerHTML = `
      <div class="modal" style="width:min(900px,94vw);max-height:86dvh;overflow:auto;padding:20px 22px">
        <h3>🏪 门店特价（按门店隔离价格）</h3>
        <div class="bar" style="margin:8px 0 12px">
          <select id="spStoreFilter"><option value="">全部门店</option>${stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
          <input id="spKw" placeholder="商品名称 / 条码" style="min-width:190px">
          <button class="btn pri" id="spSearch">🔍 查询</button>
          <button class="btn" id="spClose">关闭</button>
        </div>
        <div id="spList"><div class="empty">加载中…</div></div>
        <div class="doc-tip">门店特价来自「本地门店调价」单审核通过；未设特价的门店仍按商品默认价结算。点「恢复默认价」后该门店立即回到默认价。</div>
      </div>`;
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
    const q1 = s => mask.querySelector(s);
    q1('#spClose').onclick = () => mask.remove();

    async function draw() {
      const sid = q1('#spStoreFilter').value || '';
      const kw = q1('#spKw').value.trim();
      q1('#spList').innerHTML = '<div class="empty">加载中…</div>';
      try {
        const rows = await must(get(`/price-changes/store-prices?storeId=${sid}&keyword=${encodeURIComponent(kw)}`));
        const list = Array.isArray(rows) ? rows : (rows.items || []);
        q1('#spList').innerHTML = list.length ? `
          <table><thead><tr><th>门店</th><th>商品</th><th>条码</th><th class="num">门店价</th><th class="num">默认价</th>
            <th class="num">差额</th><th>来源单号</th><th class="muted">更新时间</th><th>操作</th></tr></thead>
          <tbody>${list.map(r => {
            const d = Number(r.sell_price) - Number(r.base_price);
            return `<tr>
              <td>🏪 ${esc(r.store_name || ('#' + r.store_id))}</td>
              <td>${esc(r.product_name || '')}</td>
              <td class="mono muted">${esc(r.barcode || '—')}</td>
              <td class="num" style="color:var(--pri);font-weight:700">${money(r.sell_price)}</td>
              <td class="num muted">${money(r.base_price)}</td>
              <td class="num" style="color:${d > 0 ? '#c0392b' : d < 0 ? '#1e8e4e' : 'var(--ink-3)'}">${d > 0 ? '+' : d < 0 ? '−' : ''}${money(Math.abs(d))}</td>
              <td class="mono muted">${esc(r.source_pc_no || '—')}</td>
              <td class="muted">${dt(r.updated_at)}</td>
              <td><button class="btn mini" data-spclear="${r.product_id}" data-spstore="${r.store_id}">恢复默认价</button></td>
            </tr>`; }).join('')}</tbody></table>` : '<div class="empty">暂无门店特价（所有门店均按默认价结算）</div>';
      } catch (e) {
        q1('#spList').innerHTML = '<div class="empty">加载失败</div>';
      }
    }
    q1('#spSearch').onclick = draw;
    q1('#spKw').addEventListener('keydown', e => { if (e.key === 'Enter') draw(); });
    q1('#spList').addEventListener('click', async e => {
      const b = e.target.closest('[data-spclear]');
      if (!b) return;
      try {
        const r = await must(post('/price-changes/store-prices/clear', {
          productId: Number(b.dataset.spclear), storeId: Number(b.dataset.spstore),
        }));
        toast(r?.removed ? '已恢复默认价' : '该门店本就无特价');
        draw();
      } catch (e2) { /* must 已提示 */ }
    });
    draw();
  }
  $('#pcStorePrices').addEventListener('click', () => openStorePrices());

  // ── 浏览 ──
  const statusTag = st => st === 'pending' ? '<span class="tag y">⏳ 待审核</span>'
    : st === 'approved' ? '<span class="tag g">✅ 已生效</span>'
    : '<span class="tag">🚫 已作废</span>';
  const typeName = t => t === 'cost' ? '📥 进价' : t === 'dual' ? '💰📥 混合' : '💰 售价';
  const scopeName = c => c.apply_scope === 'local' ? ('🏪 本地·' + (c.target_store_name || '门店')) : '🌐 整体';

  let pcPage = 1;   // 调价单主列表当前页（10 条/页）
  function drawPcs() {   // 用缓存 pcs 重画（翻页不重新请求）
    const pg = paginate(pcs, pcPage, 10);
    pcPage = pg.page;
    // V4.9.7 调价管理：主表格数据靠左 · 状态列移到操作列前 · 取消「明细」按钮（双击行弹窗看明细）
    $('#pcList').innerHTML = pcs.length ? `
      <table><thead><tr><th>单号</th><th>类型</th><th>范围</th><th>生效日期</th><th>行数</th><th>差额</th><th>备注</th><th>制单</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${pg.slice.map(c => {
        const neg = Number(c.diff_total) < 0;
        const pending = c.status === 'pending';
        return `<tr data-pcrow="${c.id}" style="cursor:pointer" title="双击查看调价明细">
        <td class="mono" style="font-weight:600">${esc(c.pc_no)}</td>
        <td>${typeName(c.price_type)}</td>
        <td>${scopeName(c)}</td>
        <td>${dt(c.effective_date).slice(0, 10)}</td>
        <td>${c.item_count}</td>
        <td>${neg ? '−' : '+'}${money(Math.abs(Number(c.diff_total)))}</td>
        <td class="muted">${esc(c.remark || '—')}</td>
        <td>${esc(c.creator_name || '—')}</td>
        <td class="muted">${dt(c.created_at)}</td>
        <td>${statusTag(c.status)}</td>
        <td>${pending ? `<button class="btn mini pri" data-appr="${c.id}">✅ 审核</button>
                         <button class="btn mini" data-void="${c.id}">🚫 作废</button>` : ''}</td>
      </tr>`; }).join('')}</tbody></table>
      ${pg.bar}` : '<div class="empty">暂无调价单</div>';
    // 双击行弹窗看明细
    $('#pcList').querySelectorAll('[data-pcrow]').forEach(tr => tr.ondblclick = () => openPcDetail(Number(tr.dataset.pcrow)));
    bindPager($('#pcList'), p => { pcPage = p; drawPcs(); });
  }

  async function loadPcs() {
    const from = $('#pcFrom').value || '';
    const to = $('#pcTo').value || '';
    const ty = $('#pcTypeFilter').value || '';
    const st = $('#pcStatusFilter').value || '';
    pcs = await must(get(`/price-changes?from=${from}&to=${to}&type=${ty}&status=${st}`));
    pcs = pcs.items || pcs || [];
    pcPage = 1;
    drawPcs();
  }

  /** V4.9.7 调价明细弹窗（双击行打开，替代原「明细」按钮 toast） */
  async function openPcDetail(id) {
    const d = await must(get('/price-changes/' + id));
    const o = d.pc || d.order || d || {};
    const its = d.items || [];
    // V4.26.5 连锁调价：明细弹窗显示生效范围与已落地的门店价（本地门店调价可核对到底改到哪家店）
    const ovs = d.storeOverrides || [];
    const tgtName = d.target_store_name
      || (stores.find(s => Number(s.id) === Number(o.target_store_id)) || {}).name
      || ('门店#' + (o.target_store_id || '?'));
    const scopeTxt = o.apply_scope === 'local'
      ? `🏪 本地门店调价 · 仅「${esc(tgtName)}」生效`
      : '🌐 整体调价 · 所有门店生效';
    const ovTxt = ovs.length
      ? ` · 已落地门店价 ${ovs.length} 条（${[...new Set(ovs.map(x => x.store_name || ('#' + x.store_id)))].map(esc).join('、')}）`
      : '';
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.zIndex = 80;
    mask.innerHTML = `
      <div class="modal" style="width:min(860px,94vw);max-height:86dvh;overflow:auto">
        <h3>💱 调价明细 ${esc(o.pc_no || '')}</h3>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">
          类型：${typeName(o.price_type)} · 状态：${statusTag(o.status)} · ${scopeTxt} · 生效日期：${o.effective_date ? dt(o.effective_date).slice(0, 10) : '—'} · 备注：${esc(o.remark || '—')}${ovTxt}</div>
        ${its.length ? `
        <table><thead><tr><th>条码</th><th>商品</th><th>单位</th><th class="num">现售价</th><th class="num">新售价</th>
          <th class="num">现进价</th><th class="num">新进价</th></tr></thead>
        <tbody>${its.map(i => `<tr>
          <td class="mono">${esc(i.barcode || '—')}</td>
          <td>${esc(i.product_name)}</td><td>${esc(i.base_unit || i.unit || '—')}</td>
          <td class="num">${i.old_price != null ? money(i.old_price) : '—'}</td>
          <td class="num" style="color:var(--pri)">${i.new_price != null ? money(i.new_price) : '—'}</td>
          <td class="num">${i.old_cost != null ? money(i.old_cost) : '—'}</td>
          <td class="num" style="color:var(--warn)">${i.new_cost != null ? money(i.new_cost) : '—'}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">无明细</div>'}
        <div class="doc-foot"></div>
      </div>`;
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
  }

  $('#pcList').addEventListener('click', async e => {
    const ap = e.target.closest('[data-appr]');
    if (ap) {
      try {
        const r = await must(post(`/price-changes/${ap.dataset.appr}/approve`, {}));
        // V4.26.5 生效范围明示：本地门店调价只影响一家店，提示必须说清楚，避免误以为全门店已改
        const scopeMsg = r?.applyScope === 'local'
          ? `仅「${(stores.find(s => Number(s.id) === Number(r.targetStoreId)) || {}).name || ('门店#' + (r.targetStoreId || '?'))}」生效（门店价 ${r.storeOverrideCount ?? 0} 条）`
          : '已对所有门店生效';
        toast(`✅ 审核通过，调价${scopeMsg}`);
        await loadPcs();
        afterApprove(Number(ap.dataset.appr));
      } catch (err) {}
      return;
    }
    // 作废：两段式确认（第一次点击变「确认作废」，避免弹窗阻塞）
    const vd = e.target.closest('[data-void]');
    if (vd) {
      if (vd.dataset.arm !== '1') {
        vd.dataset.arm = '1';
        vd.textContent = '确认作废？';
        setTimeout(() => { if (vd.isConnected) { vd.dataset.arm = ''; vd.textContent = '🚫 作废'; } }, 3000);
        return;
      }
      try {
        await must(post(`/price-changes/${vd.dataset.void}/void`, {}));
        toast('🚫 调价单已作废');
        await loadPcs();
      } catch (err) {}
      return;
    }
  });
  $('#pcSearchBtn').addEventListener('click', loadPcs);
  $('#pcRefresh').addEventListener('click', loadPcs);

  // V4.25.8 / V4.26.5：调价单审核通过后可选「打印价签」「生鲜一键传秤」
  async function afterApprove(pcId) {
    const d = await must(get('/price-changes/' + pcId));
    const items = (d.items || []).filter(i => i.new_price != null || i.new_cost != null);
    if (!items.length) return;
    // 生鲜（称重）商品：is_weighted 或 单位为 kg/克/斤/g → 可一键传秤
    const fresh = items.filter(i => Number(i.is_weighted) === 1 || ['kg', '克', '斤', 'g'].includes(String(i.base_unit || '').toLowerCase()));
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99;display:flex;align-items:center;justify-content:center';
    mask.innerHTML = `
      <div class="modal" style="width:min(420px,92vw);padding:22px 24px">
        <h3>✅ 调价单已生效</h3>
        <p class="muted" style="margin:8px 0 18px">后续动作（可随时关闭，稍后到打印中心补打）</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
          <button class="btn pri" id="pcApPrint">🏷️ 打印价签</button>
          <button class="btn" id="pcApScale"${fresh.length ? '' : ' disabled style="opacity:.5;cursor:not-allowed"'} title="${fresh.length ? '生鲜商品一键传秤' : '本次无生鲜商品'}">⚖️ 生鲜传秤${fresh.length ? '' : '（无生鲜）'}</button>
          <button class="btn" id="pcApClose">关闭</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:10px;text-align:center">${fresh.length ? `检测到 ${fresh.length} 个生鲜商品可传秤` : '本次调价无生鲜（称重）商品，无需传秤'}</div>
      </div>`;
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
    mask.querySelector('#pcApClose').onclick = () => mask.remove();
    mask.querySelector('#pcApPrint').onclick = async () => { mask.remove(); await printPriceTags(items); };
    mask.querySelector('#pcApScale').onclick = async () => {
      if (!fresh.length) return;
      mask.remove();
      await doScaleTransmit(fresh);
    };
  }

  /** 生鲜商品一键实际传秤：复用共享 transmitScaleItems，替换原 CSV 导出 */
  async function doScaleTransmit(fresh) {
    let cfg = {};
    try { cfg = await must(get('/scale-transmission/config')); }
    catch { cfg = { protocol: 'dahua', portType: 'serial', port: 'COM3', baud: 9600, tcpHost: '192.168.1.100', tcpPort: 9100, department: '01', barcodePrefix: '22', useMemberPrice: false, charset: 'gbk' }; }
    const makePlu = code => String(code || '').replace(/\D/g, '').slice(-5).padStart(4, '0');
    const scaleItems = fresh.map(i => ({
      id: i.product_id,
      name: i.product_name || i.name || '',
      short_name: i.short_name || (i.product_name || i.name || '').slice(0, 6),
      sell_price: i.new_price != null ? i.new_price : i.old_price,
      member_price: i.member_price || 0,
      goods_no: i.goods_no || '',
      barcode: i.barcode || '',
      base_unit: i.base_unit || '',
      is_weighted: Number(i.is_weighted) === 1,
      scale_plu_code: i.scale_plu_code || makePlu(i.barcode || i.goods_no || i.product_id),
      scale_department: i.scale_department || cfg.department || '01',
    }));
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99;display:flex;align-items:center;justify-content:center';
    mask.innerHTML = `
      <div class="modal" style="width:min(520px,92vw);padding:22px 24px">
        <h3>⚖️ 生鲜一键传秤</h3>
        <div id="scProgBar" style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin:14px 0">
          <div id="scProgFill" style="height:100%;width:0%;background:var(--pri);transition:width .2s"></div>
        </div>
        <div id="scProgText" class="muted" style="font-size:13px;max-height:220px;overflow:auto"></div>
        <div style="text-align:right;margin-top:16px"><button class="btn" id="scClose">关闭</button></div>
      </div>`;
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
    const fill = mask.querySelector('#scProgFill');
    const txt = mask.querySelector('#scProgText');
    mask.querySelector('#scClose').onclick = () => mask.remove();
    await transmitScaleItems(scaleItems, cfg, {
      onProgress: (m, e) => {
        const div = document.createElement('div');
        div.style.cssText = 'padding:3px 0;border-bottom:1px solid #f0f0f0;' + (e ? 'color:#c0392b' : '');
        div.textContent = m;
        txt.appendChild(div);
        txt.scrollTop = txt.scrollHeight;
      },
      onFinish: (ok, fail) => { toast(`传秤完成：成功 ${ok}，失败 ${fail}`); },
    });
    fill.style.width = '100%';
  }

  async function printPriceTags(items) {
    try {
      const ps = await must(get('/printers'));
      const labels = (ps || []).filter(p => String(p.printer_type || '小票') === '标签');
      if (!labels.length) return toast('未配置标签机，请先到「打印中心 → 打印机」新增标签机', false);
      const ids = items.map(i => Number(i.product_id)).filter(Boolean);
      if (!ids.length) return toast('没有可打印价签的商品', false);
      const tags = await must(post('/printers/price-tags', { ids }));
      const tagItems = (tags.items || []).map(t => ({ ...t, copies: 1 }));
      if (!tagItems.length) return toast('未获取到价签数据', false);
      // 单台标签机直接打，多台时弹选择
      let printerId = labels[0].id;
      if (labels.length > 1) {
        const opts = labels.map((p, i) => `${i + 1}. ${p.name}(${p.label_size || '40x30'})`).join('\n');
        const n = prompt('请选择标签机（输入序号）：\n' + opts, '1');
        const idx = Number(n) - 1;
        if (idx < 0 || idx >= labels.length) return;
        printerId = labels[idx].id;
      }
      await must(post(`/printers/${printerId}/labels`, { items: tagItems, jobType: '价签打印' }));
      toast('价签打印已发送');
    } catch (e) { /* must 已 toast */ }
  }

  /* ── 分页式：列表页 ⇄ 新增页 ── */
  const showPage = async (mode) => {
    $('#tab-new').style.display = mode === 'new' ? '' : 'none';
    $('#tab-list').style.display = mode === 'list' ? '' : 'none';
    if (mode === 'new') {
      await ensureProducts();
      await loadStores();
      if (!lines.length) lines.push(blankLine());
      drawLines();
    } else loadPcs();
  };
  $('#pcNewDoc').addEventListener('click', () => showPage('new'));
  $('#pcBackList').addEventListener('click', () => showPage('list'));

  drawLines();
  showPage('list');
}
