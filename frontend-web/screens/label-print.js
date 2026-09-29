import { get, post, must, money, esc, toast } from '../api.js';
import { openDetailModal } from '../common-ui.js';
import { fireTags } from './products.js';

/* V5.0.4 独立极简「价签打印」页（X 形态：PWA 内路由页，平板/浏览器零安装可用）
 * 流程：扫码/搜商品 → 加入待打清单 → 一键打印（自动走「价签」默认机，免选机）。 */
export async function render(view) {
  const queue = new Map();            // id -> {id,name,barcode,unit,price,promoPrice}
  let defPrinter = null;

  view.innerHTML = `
    <div class="card" style="max-width:1000px;margin:18px auto">
      <h3 style="margin:0 0 4px">🏷️ 价签打印 · 现场专用</h3>
      <div class="muted" style="font-size:12px;margin-bottom:12px">扫描条码或输入商品名 / 拼音码 / 货号，加入下方待打清单后一键打印（自动走「价签」默认机）。</div>
      <div style="display:flex;gap:10px;margin-bottom:12px">
        <input id="lpKw" class="inp" placeholder="扫描条码或输入关键字…" style="flex:1" autofocus>
        <button class="btn pri" id="lpSearch">搜索</button>
        <button class="btn" id="lpClear">清空清单</button>
      </div>
      <div id="lpResults" class="row" style="display:flex;flex-wrap:wrap;gap:8px;min-height:8px;margin-bottom:14px"></div>
      <table class="tbl"><thead><tr>
        <th>商品</th><th>条码</th><th>单位</th><th class="num">日常价</th><th class="num">促销</th><th></th>
      </tr></thead><tbody id="lpList"></tbody></table>
      <div class="bar" style="justify-content:flex-end;margin-top:12px;gap:12px">
        <span id="lpDef" class="muted"></span>
        份数 <input id="lpCopies" type="number" min="1" max="50" value="1" style="width:70px">
        <button class="btn pri" id="lpGo">🖨 打印 <span id="lpN">0</span> 品</button>
      </div>
    </div>`;

  const kw = view.querySelector('#lpKw');
  const results = view.querySelector('#lpResults');
  const list = view.querySelector('#lpList');
  const defEl = view.querySelector('#lpDef');
  const copiesEl = view.querySelector('#lpCopies');

  function renderQueue() {
    list.innerHTML = [...queue.values()].map((q, i) =>
      `<tr><td><b>${esc(q.name)}</b></td><td class="mono">${esc(q.barcode || '—')}</td>
       <td>${esc(q.unit || '—')}</td><td class="num">${money(q.price)}</td>
       <td class="num" style="color:${q.promoPrice != null ? 'var(--warn)' : 'inherit'}">${q.promoPrice != null ? money(q.promoPrice) : '—'}</td>
       <td><button class="btn sm r" data-rm="${q.id}">移除</button></td></tr>`).join('');
    view.querySelector('#lpN').textContent = queue.size;
    list.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { queue.delete(Number(b.dataset.rm)); renderQueue(); });
  }

  async function loadDef() {
    const ps = await must(get('/printers')).catch(() => []);
    const labels = (Array.isArray(ps) ? ps : []).filter(p => (p.printer_type || '小票') === '标签');
    defPrinter = labels.find(p => p.is_default && p.default_for === 'pricetag') || null;
    defEl.innerHTML = defPrinter
      ? `默认价签机：<b>${esc(defPrinter.name)}</b>（${esc(defPrinter.label_size || '40x30')}）`
      : `<b style="color:var(--warn)">未设「价签」默认机 — 请到「打印中心」设置</b>`;
  }

  async function doSearch() {
    const k = kw.value.trim();
    if (!k) return;
    const d = await must(get(`/products?keyword=${encodeURIComponent(k)}&size=30&scope=all`)).catch(() => ({ items: [] }));
    const items = d.items || [];
    if (!items.length) { results.innerHTML = `<span class="muted">无匹配商品</span>`; return; }
    results.innerHTML = items.map(it =>
      `<button class="btn sm" data-add="${it.id}" data-name="${esc(it.name)}" data-barcode="${esc(it.barcode || '')}" data-unit="${esc(it.base_unit || '')}" data-price="${it.sell_price}">
        + ${esc(it.name)} <span class="muted">${money(it.sell_price)}</span></button>`).join('');
    results.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      const id = Number(b.dataset.add);
      if (queue.has(id)) return toast('已在清单中');
      queue.set(id, { id, name: b.dataset.name, barcode: b.dataset.barcode, unit: b.dataset.unit, price: Number(b.dataset.price) });
      kw.value = ''; kw.focus(); renderQueue();
    });
  }

  kw.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  view.querySelector('#lpSearch').onclick = doSearch;
  view.querySelector('#lpClear').onclick = () => { queue.clear(); renderQueue(); };
  view.querySelector('#lpGo').onclick = async () => {
    if (!queue.size) return toast('清单为空', false);
    if (!defPrinter) return toast('请先到「打印中心」把某台标签机设为「价签」默认用途', false);
    const ids = [...queue.keys()];
    const d = await must(post('/printers/price-tags', { ids })).catch(() => ({ items: [] }));
    const items = d.items || [];
    if (!items.length) return toast('未取到可打印数据', false);
    const copies = Math.min(Math.max(Number(copiesEl.value) || 1, 1), 50);
    try {
      await fireTags(defPrinter.id, items, copies);
      queue.clear(); renderQueue();
    } catch (e) { toast('打印失败：' + (e.message || e), false); }
  };

  loadDef();
  renderQueue();
}
