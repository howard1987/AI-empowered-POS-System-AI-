import { get, must, money, esc, dt, unwrap } from '../api.js';
import { exportRows } from '../common-ui.js';

/** 销售明细（V4.22.0）：销售商品行级流水（行=单据×商品）。
 *  查询行：关键字（商品名/条码）/ 收银员 / 渠道 / 时间段；服务端分页每页 15 条；合计（件数/金额/毛利）常驻；导出 CSV / Excel。
 */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>📋 销售明细 </h3>
      <div class="doc-tip" style="margin:0 18px 10px">💡 每行 = 一张销售单里的一种商品（含价格/成本/毛利）。查"某个商品卖了多少钱/多少件"用本页；查单据（整单金额/退款）用「销售单据」。</div>
      <div class="bar">
        <input id="iKw" placeholder="商品名称/条码" style="width:160px">
        <select id="iCh" style="width:120px">
          <option value="">全部渠道</option>
          <option value="门店">门店</option><option value="扫码购">扫码购</option>
          <option value="小程序">小程序</option><option value="H5">H5</option>
          <option value="外卖">外卖</option><option value="大客户团购">大客户团购</option>
        </select>
        <select id="iCashier" style="width:130px"><option value="">全部收银员</option></select>
        <input type="date" id="iFrom"> <span class="muted">至</span> <input type="date" id="iTo">
        <button class="btn pri" id="iGo">查询</button>
        <button class="btn" id="iCsv">⬇ CSV</button>
        <button class="btn" id="iXls">⬇ Excel</button>
      </div>
      <div id="iSum" class="bar" style="margin-top:8px;font-weight:600"></div>
      <div id="iList" class="tbl-min" style="height:auto;max-height:calc(15 * 40px + 46px);overflow:auto;margin-top:6px"></div>
    </div>`;

  /* 服务端分页条（同 sales.js 统一样式） */
  function serverBar(page, total, go) {
    const pages = Math.max(Math.ceil(total / 15), 1);
    const cur = Math.min(Math.max(page, 1), pages);
    return `<div class="bar pg-bar-sticky" style="justify-content:flex-end;margin:8px 0 0;position:sticky;bottom:0;background:var(--bg,#faf9f5);padding:6px 8px;border-top:1px solid var(--line,#e8e4d8);z-index:2">
      <span class="muted" style="font-size:12px">共 ${total} 行</span>
      <button class="btn sm pg-prev" ${cur <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px">第
        <input type="number" class="pg-jump" min="1" max="${pages}" value="${cur}" style="width:52px;text-align:center;padding:2px 4px"> / ${pages} 页</span>
      <button class="btn sm pg-next" ${cur >= pages ? 'disabled' : ''}>下一页 ›</button></div>`;
  }
  function bindServerBar(box, cur, go) {
    box.querySelector('.pg-prev')?.addEventListener('click', () => go(cur - 1));
    box.querySelector('.pg-next')?.addEventListener('click', () => go(cur + 1));
    const inp = box.querySelector('.pg-jump');
    if (inp) {
      const jump = () => {
        const pages = Number(inp.max) || 1;
        go(Math.min(Math.max(1, Number(inp.value) || 1), pages));
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); jump(); } });
      inp.addEventListener('change', jump);
    }
  }

  async function loadFilters() {
    const csh = view.querySelector('#iCashier');
    try {
      const ed = unwrap(await get('/auth/employees?size=100'));
      const items = Array.isArray(ed) ? ed : (ed?.items || []);
      csh.innerHTML = '<option value="">全部收银员</option>' +
        items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    } catch { csh.style.display = 'none'; }
  }

  function qs() {
    const from = view.querySelector('#iFrom').value, to = view.querySelector('#iTo').value;
    const csh = view.querySelector('#iCashier').value;
    const kw = encodeURIComponent(view.querySelector('#iKw').value.trim());
    const ch = view.querySelector('#iCh').value;
    return `from=${from}&to=${to}` + (csh ? `&cashierId=${csh}` : '') + (kw ? `&keyword=${kw}` : '') +
      (ch ? `&channel=${encodeURIComponent(ch)}` : '');
  }

  let page = 1;
  async function list() {
    const box = view.querySelector('#iList');
    const d = await must(get(`/sales/items?${qs()}&size=15&page=${page}`));
    const rows = d.items || [];
    view.querySelector('#iSum').innerHTML =
      `<span>合计：<b>${d.total ?? 0}</b> 行</span>
       <span>数量 <b>${Number(d.sumQty ?? 0)}</b></span>
       <span>金额 <b style="color:var(--pri,#8a5a2b)">¥${money(d.sumAmount)}</b></span>
       <span>毛利 <b style="color:var(--ok,#2e9e5b)">¥${money(d.sumProfit)}</b></span>`;
    box.innerHTML = rows.length ? `
      <table><thead><tr><th>时间</th><th>单号</th><th>渠道</th><th>商品</th><th>条码</th><th>分类</th>
        <th class="num">数量</th><th class="num">单价</th><th class="num">小计</th><th class="num">成本</th><th class="num">毛利</th>
        <th>收银员</th><th>会员</th></tr></thead>
      <tbody>${rows.map(r => `<tr data-o="${r.orderId}" style="cursor:pointer" title="双击跳转该单详情（销售单据）">
        <td class="muted">${dt(r.created_at)}</td>
        <td style="font-family:var(--mono)">${esc(r.order_no)}</td><td>${esc(r.channel || '—')}</td>
        <td><b>${esc(r.productName)}</b></td><td class="muted">${esc(r.barcode || '—')}</td><td class="muted">${esc(r.categoryName || '—')}</td>
        <td class="num">${Number(r.qty)}</td><td class="num">${money(r.unitPrice)}</td>
        <td class="num"><b>${money(r.lineAmount)}</b></td><td class="num">${money(r.lineCost)}</td>
        <td class="num">${money(r.lineProfit)}</td>
        <td>${esc(r.cashierName || '—')}</td><td>${esc(r.memberName || '—')}</td></tr>`).join('')}</tbody></table>
      ${serverBar(page, d.total ?? rows.length)}`
      : '<div class="empty">无明细（换个时间段或清空关键字试试）</div>';
    box.querySelectorAll('tr[data-o]').forEach(tr => tr.ondblclick = () => {
      location.hash = '#/sales/orders';
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('sales:open-detail', { detail: String(tr.dataset.o) }));
      }, 350);
    });
    bindServerBar(box, page, p => { page = Math.max(1, p); list(); });
  }

  /* ── 导出（CSV / Excel，最多 2 万行） ── */
  const COLS = [
    { k: 'created_at', t: '时间' }, { k: 'order_no', t: '单号' }, { k: 'channel', t: '渠道' },
    { k: 'productName', t: '商品' }, { k: 'barcode', t: '条码' }, { k: 'categoryName', t: '分类' },
    { k: 'qty', t: '数量' }, { k: 'unitPrice', t: '单价' }, { k: 'lineAmount', t: '小计' },
    { k: 'lineCost', t: '成本' }, { k: 'lineProfit', t: '毛利' }, { k: 'cashierName', t: '收银员' }, { k: 'memberName', t: '会员' },
  ];
  async function fetchAll() {
    const rows = [];
    for (let p = 1; p <= 100; p++) {
      const d = await must(get(`/sales/items?${qs()}&size=200&page=${p}`));
      const items = d.items || [];
      rows.push(...items);
      if (items.length < 200) break;
    }
    return rows.map(r => ({
      ...r, qty: Number(r.qty), unitPrice: Number(r.unitPrice), lineAmount: Number(r.lineAmount),
      lineCost: Number(r.lineCost), lineProfit: Number(r.lineProfit), created_at: String(r.created_at).slice(0, 19),
    }));
  }
  view.querySelector('#iCsv').onclick = async () => exportRows({ filename: '销售明细', columns: COLS, rows: await fetchAll(), format: 'csv' });
  view.querySelector('#iXls').onclick = async () => exportRows({ filename: '销售明细', columns: COLS, rows: await fetchAll(), format: 'xls' });

  view.querySelector('#iGo').onclick = () => { page = 1; list(); };
  view.querySelector('#iKw').addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; list(); } });
  await loadFilters();
  await list();
}
