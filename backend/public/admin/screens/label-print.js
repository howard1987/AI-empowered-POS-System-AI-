import { get, post, must, money, esc, toast } from '../api.js';
import { docTable, fitFillPanes } from '../common-ui.js';
import { fireTags } from './products.js';

/* V5.0.7 「价签打印 · 现场专用」—— 已并入「打印中心」独立标签（原顶级菜单移除）。
 * 流程：扫码/搜索商品，或点「分类多选」按商品分类挑选（可整类加入或勾选部分）
 *      → 加入待打清单 → 一键打印（自动走「价签」默认机，免选机）。
 * 清单表格统一 docTable 构建、铺满窗口不溢出；
 * 列：商品名称 / 条码 / 单位 / 规格 / 销售价 / 会员价 / 特价 / 保质期。 */
export async function render(view) {
  const queue = new Map();   // id -> true（只存勾选；展示数据统一在 meta）
  const meta = new Map();    // id -> {id,name,barcode,unit,spec,price,memberPrice,promoPrice,keepDays}
  let defPrinter = null;

  view.innerHTML = `
    <div class="fill-pane">
      <div class="card fill-card">
        <h3>🏷️ 价签打印 · 现场专用
          <span class="muted" style="font-weight:400;font-size:11.5px">扫描条码或输入商品名 / 拼音码 / 货号，或「分类多选」按分类挑商品；加入下方清单后一键打印。</span>
          <span id="lpDef" style="margin-left:auto;font-size:12px;color:var(--ink-3)"></span></h3>
        <div class="bar">
          <input id="lpKw" placeholder="扫描条码或输入关键字…" style="width:280px" autofocus>
          <button class="btn pri" id="lpSearch">搜索</button>
          <button class="btn" id="lpPick">☑ 分类多选</button>
          <button class="btn" id="lpClear">清空清单</button>
          <span style="margin-left:auto"></span>
          <span class="muted">份数</span>
          <input id="lpCopies" type="number" min="1" max="50" value="1" style="width:64px">
          <button class="btn pri" id="lpGo">🖨 打印 <span id="lpN">0</span> 品</button>
        </div>
        <div id="lpResults" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 18px 10px;min-height:8px"></div>
        <div id="lpHost" class="tbl-host" style="margin:0 18px 14px"></div>
      </div>
    </div>`;

  const kw = view.querySelector('#lpKw');
  const results = view.querySelector('#lpResults');

  /* ── 待打清单渲染（统一 docTable；数据来自 meta，缺的靠 refreshMeta 补全） ── */
  function renderQueue() {
    view.querySelector('#lpN').textContent = queue.size;
    const rows = [...queue.keys()].map(id => {
      const q = meta.get(id) || { name: `商品 #${id}` };
      return { attrs: '', cells: [
        `<b>${esc(q.name || '')}</b>`,
        `<span class="mono">${esc(q.barcode || '—')}</span>`,
        esc(q.unit || '—'),
        esc(q.spec || '—'),
        { h: money(q.price ?? 0), cls: 'num' },
        { h: q.memberPrice != null ? money(q.memberPrice) : '—', cls: 'num' },
        { h: q.promoPrice != null ? `<span style="color:var(--warn)">${money(q.promoPrice)}</span>` : '—', cls: 'num' },
        { h: q.keepDays != null ? `${q.keepDays} 天` : '—', cls: 'num' },
        `<td><button class="btn sm r" data-rm="${id}">移除</button></td>`,
      ] };
    });
    view.querySelector('#lpHost').innerHTML = docTable({
      cols: [{ h: '商品名称' }, { h: '条码' }, { h: '单位' }, { h: '规格' },
        { h: '销售价', cls: 'num' }, { h: '会员价', cls: 'num' }, { h: '特价', cls: 'num' }, { h: '保质期', cls: 'num' },
        { h: '', w: 90 }],
      rows,
      empty: '清单为空：扫码 / 搜索 / 「分类多选」加入商品',
    });
    view.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const id = Number(b.dataset.rm);
      queue.delete(id); meta.delete(id); renderQueue();
    });
  }

  /** 用 /printers/price-tags 批量刷新清单展示数据（特价 / 会员价 / 规格 / 保质期以权威口径为准）。
   *  单次 ≤200 个（后端上限），超出分批；失败的批保留已有旧数据不阻断。 */
  async function refreshMeta() {
    const ids = [...queue.keys()];
    if (!ids.length) { meta.clear(); renderQueue(); return; }
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      try {
        const d = await must(post('/printers/price-tags', { ids: chunk }));
        (d.items || []).forEach(it => meta.set(Number(it.id), it));
      } catch { /* 刷新失败：保留加入时的基本信息 */ }
    }
    renderQueue();
  }

  /** 加入清单：先落基本信息立即显示，再异步补权威数据 */
  function addToQueue(it) {
    const id = Number(it.id);
    if (!id) return;
    if (queue.has(id)) return toast('已在清单中');
    queue.set(id, true);
    meta.set(id, {
      id, name: it.name || '', barcode: it.barcode || '',
      unit: it.base_unit || it.unit || '', spec: it.spec || '',
      price: Number(it.sell_price ?? it.price ?? 0),
      memberPrice: it.member_price != null ? Number(it.member_price) : (it.memberPrice != null ? Number(it.memberPrice) : null),
      promoPrice: it.promoPrice != null ? Number(it.promoPrice) : null,
      keepDays: it.keep_days != null ? Number(it.keep_days) : (it.keepDays != null ? Number(it.keepDays) : null),
    });
    renderQueue();
    refreshMeta();
  }

  /* ── 扫码 / 关键字搜索（结果为快捷加入按钮） ── */
  async function doSearch() {
    const k = kw.value.trim();
    if (!k) return;
    const d = await must(get(`/products?keyword=${encodeURIComponent(k)}&size=30&scope=all`)).catch(() => ({ items: [] }));
    const items = d.items || [];
    if (!items.length) { results.innerHTML = `<span class="muted">无匹配商品</span>`; return; }
    results.innerHTML = items.map(it =>
      `<button class="btn sm" data-add="${it.id}">＋ ${esc(it.name)} <span class="muted">${money(it.sell_price)}</span></button>`).join('');
    results.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      addToQueue(items.find(x => Number(x.id) === Number(b.dataset.add)) || { id: b.dataset.add });
      kw.value = ''; kw.focus();
    });
  }

  /* ── 分类多选弹窗：左分类 / 右商品勾选，支持「全选本类」或勾选部分 ── */
  async function openPicker() {
    const cats = await must(get('/products/categories')).catch(() => []);
    const list = Array.isArray(cats) ? cats : (cats?.items || []);
    if (!list.length) return toast('暂无商品分类，请先到「商品档案」建分类', false);
    const m = document.createElement('div');
    m.className = 'modal-mask';
    m.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9999';
    m.innerHTML = `<div class="modal" style="width:min(880px,94vw);height:min(640px,88vh);display:flex;flex-direction:column;overflow:hidden">
      <h3>按分类选择商品 <span class="muted" style="font-size:12px;font-weight:400">点左侧分类载入商品；可「全选本类」整类加入，或勾选部分商品</span></h3>
      <div style="display:flex;gap:12px;flex:1;min-height:0">
        <div id="lpCatList" style="width:220px;flex:none;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:6px;background:var(--paper-2)"></div>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0">
          <div class="bar" style="margin-bottom:8px">
            <button class="btn sm" id="lpAllCat">全选本类</button>
            <button class="btn sm" id="lpNoneCat">取消全选</button>
            <span class="muted" id="lpSelCnt" style="margin-left:auto">已勾选 0 项</span>
            <button class="btn pri sm" id="lpAddSel">加入清单</button>
          </div>
          <div id="lpProdList" class="tbl-host" style="flex:1;min-height:0;border:1px solid var(--line);border-radius:10px"></div>
        </div>
      </div>
      <div style="text-align:right;margin-top:10px"><button class="btn" id="lpPickClose">关闭</button></div>
    </div>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelector('#lpPickClose').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };

    const catBox = m.querySelector('#lpCatList');
    const prodBox = m.querySelector('#lpProdList');
    const cntEl = m.querySelector('#lpSelCnt');
    let curCat = null, curItems = [];
    const sel = new Set();   // 本弹窗内的勾选（商品 id）

    catBox.innerHTML = list.map(c =>
      `<div data-cat="${c.id}" style="padding:8px 12px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</div>`).join('');
    catBox.querySelectorAll('[data-cat]').forEach(dv => dv.onclick = () => {
      catBox.querySelectorAll('[data-cat]').forEach(x => { x.style.background = ''; x.style.fontWeight = ''; });
      dv.style.background = 'var(--green-soft)'; dv.style.fontWeight = '700'; dv.style.color = 'var(--pri)';
      loadProds(list.find(c => Number(c.id) === Number(dv.dataset.cat)));
    });

    function drawCnt() { cntEl.textContent = `已勾选 ${sel.size} 项`; }
    function drawProds() {
      prodBox.innerHTML = curItems.length ? `
        <table><thead><tr><th style="width:40px"></th><th>商品名称</th><th>条码</th><th>单位</th><th class="num">销售价</th><th class="num">会员价</th></tr></thead>
        <tbody>${curItems.map(it => `<tr>
          <td><input type="checkbox" data-pid="${it.id}" ${sel.has(Number(it.id)) ? 'checked' : ''}></td>
          <td>${esc(it.name)}</td><td class="mono">${esc(it.barcode || '—')}</td><td>${esc(it.base_unit || '—')}</td>
          <td class="num">${money(it.sell_price)}</td>
          <td class="num">${it.member_price != null ? money(it.member_price) : '—'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">该分类下暂无商品</div>';
      prodBox.querySelectorAll('[data-pid]').forEach(cb => cb.onchange = () => {
        const id = Number(cb.dataset.pid);
        if (cb.checked) sel.add(id); else sel.delete(id);
        drawCnt();
      });
    }
    async function loadProds(c) {
      curCat = c; sel.clear(); drawCnt();
      prodBox.innerHTML = '<div class="empty">加载中…</div>';
      const d = await must(get(`/products?categoryId=${c.id}&size=500&scope=all`)).catch(() => ({ items: [] }));
      curItems = d.items || [];
      drawProds();
    }
    m.querySelector('#lpAllCat').onclick = () => { curItems.forEach(it => sel.add(Number(it.id))); drawProds(); drawCnt(); };
    m.querySelector('#lpNoneCat').onclick = () => { sel.clear(); drawProds(); drawCnt(); };
    m.querySelector('#lpAddSel').onclick = () => {
      if (!sel.size) return toast('请先勾选商品', false);
      let added = 0;
      curItems.filter(it => sel.has(Number(it.id))).forEach(it => {
        const id = Number(it.id);
        if (!queue.has(id)) { added++; }
        addToQueue(it);
      });
      toast(added ? `已加入 ${added} 个商品（重复自动跳过）` : '所选商品均已在清单中');
      sel.clear(); drawProds(); drawCnt();
    };
    drawCnt();
  }

  /* ── 默认价签机 ── */
  async function loadDef() {
    const ps = await must(get('/printers')).catch(() => []);
    const labels = (Array.isArray(ps) ? ps : []).filter(p => (p.printer_type || '小票') === '标签');
    defPrinter = labels.find(p => p.is_default && p.default_for === 'pricetag') || null;
    view.querySelector('#lpDef').innerHTML = defPrinter
      ? `默认价签机：<b>${esc(defPrinter.name)}</b>（${esc(defPrinter.label_size || '40x30')}）`
      : `<b style="color:var(--warn)">未设「价签」默认机 — 请在「打印机」标签设置</b>`;
  }

  kw.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  view.querySelector('#lpSearch').onclick = doSearch;
  view.querySelector('#lpPick').onclick = openPicker;
  view.querySelector('#lpClear').onclick = () => { queue.clear(); meta.clear(); renderQueue(); };
  view.querySelector('#lpGo').onclick = async () => {
    if (!queue.size) return toast('清单为空', false);
    if (!defPrinter) return toast('请先在「打印机」标签把某台标签机设为「价签」默认用途', false);
    const items = [...queue.keys()].map(id => meta.get(id)).filter(Boolean);
    if (!items.length) return toast('未取到可打印数据', false);
    const copies = Math.min(Math.max(Number(view.querySelector('#lpCopies').value) || 1, 1), 50);
    try {
      await fireTags(defPrinter.id, items, copies);
      queue.clear(); meta.clear(); renderQueue();
    } catch (e) { toast('打印失败：' + (e.message || e), false); }
  };

  loadDef();
  renderQueue();
  fitFillPanes(view);   // V5.0.7：作为打印中心标签渲染时，此处立即按视口定高
}
