import { get, post, must, money, esc, dt, toast, unwrap } from '../api.js';
import { openDetailModal, exportRows, paginate, bindDblClick } from '../common-ui.js';

/** 销售单据（原「销售流水」，V4.14.0 S / V4.22.0 更名）：
 *  1) 顶部「扫码购流水」：仅展示渠道=扫码购的单据（每页 10 条，双击行弹详情）；核销抽检在收银台前台进行，后台不再校验；
 *     开关=系统设置 sales.scanpay_enabled（开=会员端可自助扫码购）。
 *  2) 「销售单据」：双击行弹窗详情（泛化 openDetailModal）；每页 10 条翻页；导出 CSV / Excel（泛化 exportRows）。
 */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>🛒 扫码购流水 
        <span style="margin-left:12px;font-weight:400" id="spSwitch"></span></h3>
      <div class="doc-tip" style="margin:0 18px 10px">💡 核销码校验在收银台前台：店员点「扫码购核销」输入 6 位码即可抽检/放行（&gt;100 元必检，其余 10% 抽检）。此处只做流水展示与追溯。</div>
      <div id="spList" class="tbl-min" style="min-height:80px"></div>
    </div>
    <div class="card">
      <h3>销售单据 </h3>
      <div class="bar">
        <select id="fCh" style="width:120px">
          <option value="">全部渠道</option>
          <option value="门店">门店</option><option value="扫码购">扫码购</option>
          <option value="小程序">小程序</option><option value="H5">H5</option>
          <option value="外卖">外卖</option><option value="大客户团购">大客户团购</option>
        </select>
        <select id="fSup" style="width:170px"><option value="">全部供应商</option></select>
        <select id="fCashier" style="width:130px"><option value="">全部收银员</option></select>
        <input id="fKw" placeholder="商品名称/条码" style="width:140px">
        <input type="date" id="fFrom"> <span class="muted">至</span> <input type="date" id="fTo">
        <button class="btn pri" id="fGo">查询</button>
        <button class="btn" id="fCsv">⬇ CSV</button>
        <button class="btn" id="fXls">⬇ Excel</button>
        <span class="muted">双击任意单据行弹出订单详情</span>
      </div>
      <div id="fList" class="tbl-min" style="height:auto;max-height:calc(10 * 42px + 46px);overflow:auto"></div>
    </div>`;

  view.querySelector('#fGo').onclick = list;
  view.querySelector('#fKw').addEventListener('keydown', e => { if (e.key === 'Enter') list(); });
  await loadFilters();
  await drawScanpaySwitch();

  /* ── 扫码购开关（读系统设置，具备 sys.settings 权限时可切） ── */
  async function drawScanpaySwitch() {
    const el = view.querySelector('#spSwitch');
    try {
      const d = unwrap(await get('/settings/key/sales.scanpay_enabled'));
      const v = typeof d.value === 'string' ? d.value.replace(/^"|"$/g, '') : (d.value || '关');
      el.innerHTML = `开关：<b style="color:${v === '开' ? 'var(--ok,#2e9e5b)' : 'var(--muted,#8a8577)'}">${esc(v)}</b>
        <span class="muted" style="font-size:11.5px">（在「系统设置 → 通用设置」中开启/关闭扫码购功能）</span>`;
    } catch { el.innerHTML = ''; }
  }

  /* ── 服务端分页条（固定在容器底部；V4.14.9 统一样式：右对齐 + 手输页码跳页）── */
  function serverBar(page, total, go) {
    const pages = Math.max(Math.ceil(total / 10), 1);
    const cur = Math.min(Math.max(page, 1), pages);
    return `<div class="bar pg-bar-sticky" style="justify-content:flex-end;margin:8px 0 0;position:sticky;bottom:0;background:var(--bg,#faf9f5);padding:6px 8px;border-top:1px solid var(--line,#e8e4d8);z-index:2">
      <span class="muted" style="font-size:12px">共 ${total} 条</span>
      <button class="btn sm pg-prev" ${cur <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px">第
        <input type="number" class="pg-jump" min="1" max="${pages}" value="${cur}" style="width:52px;text-align:center;padding:2px 4px"> / ${pages} 页</span>
      <button class="btn sm pg-next" ${cur >= pages ? 'disabled' : ''}>下一页 ›</button></div>`;
  }
  /** V4.14.9 统一绑定分页条：prev/next/手输跳页（go 接收目标页码） */
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

  /* ── 扫码购流水（渠道=扫码购） ── */
  let spPage = 1;
  async function listScanpay() {
    const box = view.querySelector('#spList');
    const d = await must(get(`/sales?channel=${encodeURIComponent('扫码购')}&size=10&page=${spPage}`).catch(() => ({ items: [] })));
    const rows = d.items || [];
    box.innerHTML = rows.length ? `
      <table><thead><tr><th>单号</th><th>会员</th><th class="num">应收</th><th class="num">毛利</th><th>核销</th><th>时间</th></tr></thead>
      <tbody>${rows.map(o => `<tr data-sp="${o.id}" style="cursor:pointer" title="双击查看详情">
        <td style="font-family:var(--mono)">${esc(o.order_no)}</td>
        <td>${esc(o.member_name || '—')}</td>
        <td class="num"><b>${money(o.payable_amount)}</b></td>
        <td class="num">${money(o.profit_amount)}</td>
        <td>${o.code_verified_at ? '<span class="tag g">已核销</span>' : '<span class="tag y">未核销</span>'}</td>
        <td class="muted">${dt(o.created_at)}</td></tr>`).join('')}</tbody></table>
      ${serverBar(spPage, d.total ?? rows.length)}`
      : '<div class="empty">暂无扫码购流水（开启扫码购后，会员端自助结算的单据在此展示）</div>';
    bindDblClick(box, '[data-sp]', tr => detail(tr.dataset.sp));
    bindServerBar(box, spPage, p => { spPage = Math.max(1, p); listScanpay(); });
  }

  /* ── 筛选项数据源 ── */
  async function loadFilters() {
    const sup = view.querySelector('#fSup'), csh = view.querySelector('#fCashier');
    try {
      const sd = unwrap(await get('/purchase/suppliers?size=100'));
      const items = Array.isArray(sd) ? sd : (sd?.items || []);
      sup.innerHTML = '<option value="">全部供应商</option>' +
        items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    } catch { sup.style.display = 'none'; }
    try {
      const ed = unwrap(await get('/auth/employees?size=100'));
      const items = Array.isArray(ed) ? ed : (ed?.items || []);
      csh.innerHTML = '<option value="">全部收银员</option>' +
        items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    } catch { csh.style.display = 'none'; }
  }

  function qs() {
    const from = view.querySelector('#fFrom').value, to = view.querySelector('#fTo').value;
    const sup = view.querySelector('#fSup').value, csh = view.querySelector('#fCashier').value;
    const kw = encodeURIComponent(view.querySelector('#fKw').value.trim());
    const ch = view.querySelector('#fCh').value;
    return `from=${from}&to=${to}` +
      (sup ? `&supplierId=${sup}` : '') + (csh ? `&cashierId=${csh}` : '') + (kw ? `&keyword=${kw}` : '') +
      (ch ? `&channel=${encodeURIComponent(ch)}` : '');
  }

  /* ── 销售单据（每页 10 条，双击行弹详情；分页条固定在容器底部） ── */
  let fPage = 1;
  async function list() {
    const box = view.querySelector('#fList');
    const d = await must(get(`/sales?${qs()}&size=10&page=${fPage}`));
    const rows = d.items || [];
    box.innerHTML = rows.length ? `
      <table><thead><tr><th>单号</th><th>渠道</th><th>会员</th><th>收银员</th>
        <th class="num">货值</th><th class="num">促销</th><th class="num">券</th><th class="num">抹零</th><th class="num">应收</th><th class="num">毛利</th><th>时间</th><th></th></tr></thead>
      <tbody>${rows.map(o => `<tr data-id="${o.id}" style="cursor:pointer" title="双击查看详情">
        <td style="font-family:var(--mono)">${esc(o.order_no)}</td><td>${esc(o.channel)}</td><td>${esc(o.member_name || '—')}</td><td>${esc(o.cashier_name || '—')}</td>
        <td class="num">${money(o.goods_amount)}</td><td class="num">${money(o.promo_amount)}</td>
        <td class="num">${money(o.coupon_amount)}</td><td class="num">${Number(o.round_amount) ? money(o.round_amount) : '—'}</td>
        <td class="num"><b>${money(o.payable_amount)}</b></td><td class="num">${money(o.profit_amount)}</td>
        <td class="muted">${dt(o.created_at)}</td>
        <td><button class="btn sm" data-id="${o.id}">详情</button></td></tr>`).join('')}</tbody></table>
      ${serverBar(fPage, d.total ?? rows.length)}`
      : '<div class="empty">无订单</div>';
    bindDblClick(box, 'tr[data-id]', tr => detail(tr.dataset.id));
    box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => detail(b.dataset.id));
    bindServerBar(box, fPage, p => { fPage = Math.max(1, p); list(); });
  }

  /* ── 导出（CSV / Excel，泛化 exportRows） ── */
  const COLS = [
    { k: 'order_no', t: '单号' }, { k: 'channel', t: '渠道' }, { k: 'member_name', t: '会员' }, { k: 'cashier_name', t: '收银员' },
    { k: 'goods_amount', t: '货值' }, { k: 'promo_amount', t: '促销' }, { k: 'coupon_amount', t: '券' }, { k: 'round_amount', t: '抹零' },
    { k: 'payable_amount', t: '应收' }, { k: 'profit_amount', t: '毛利' }, { k: 'created_at', t: '时间' },
  ];
  async function fetchAll() {
    const rows = [];
    for (let p = 1; p <= 50; p++) {
      const d = await must(get(`/sales?${qs()}&size=100&page=${p}`));
      const items = d.items || [];
      rows.push(...items);
      if (items.length < 100) break;
    }
    return rows.map(o => ({ ...o,
      goods_amount: Number(o.goods_amount), promo_amount: Number(o.promo_amount),
      coupon_amount: Number(o.coupon_amount), round_amount: Number(o.round_amount || 0),
      payable_amount: Number(o.payable_amount), profit_amount: Number(o.profit_amount),
      created_at: String(o.created_at).slice(0, 19) }));
  }
  view.querySelector('#fCsv').onclick = async () => {
    exportRows({ filename: '销售单据', columns: COLS, rows: await fetchAll(), format: 'csv' });
  };
  view.querySelector('#fXls').onclick = async () => {
    exportRows({ filename: '销售单据', columns: COLS, rows: await fetchAll(), format: 'xls' });
  };

  /* ── 订单详情（弹窗版，泛化 openDetailModal；含退款操作） ── */
  async function detail(id) {
    const d = await must(get(`/sales/${id}`));
    const o = d.order;
    const html = `
      <div class="bar muted">渠道 ${esc(o.channel)} · ${o.is_emergency ? '<span class="tag r">应急</span>' : ''} 状态 ${esc(o.status)} ·
        班次 ${o.shift_id ? '#' + o.shift_id : '—'} · 创建 ${dt(o.created_at)}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div>
          <table><thead><tr><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th><th class="num">成本</th><th>批次溯源</th><th>退货</th></tr></thead>
          <tbody>${d.items.map(i => `<tr>
            <td>${esc(i.product_name)}</td><td class="num">${Number(i.qty)}</td><td class="num">${money(i.unit_price)}</td>
            <td class="num">${money(i.line_amount)}</td><td class="num">${money(i.line_cost)}</td>
            <td class="muted">${(i.batch_trace || []).map(b => `${b.batch}×${Number(b.qty)}@${Number(b.cost)}`).join('<br>')}</td>
            <td><input type="number" class="rfQty" data-siid="${i.id}" min="0" max="${Number(i.qty)}" step="0.001"
                       value="0" style="width:72px" title="退货数量（0=不退），上限=可退量"></td>
          </tr>`).join('')}</tbody></table>
          <div class="bar" style="margin-top:8px">
            <input type="text" id="rfReason" placeholder="退货原因（留痕必填）" style="width:200px">
            <label class="muted"><input type="checkbox" id="rfRestock" checked> 退回库存</label>
            <button class="btn" id="rfGo">执行退款</button>
            <button class="btn sm" id="rfAll">按行全填</button>
            <span class="muted">免审限额内直退，超出转「待审核」</span>
          </div>
          <div id="rfResult"></div>
        </div>
        <div>
          <table><thead><tr><th>支付方式</th><th class="num">金额</th></tr></thead>
          <tbody>${d.payments.map(p => `<tr><td>${esc(p.channel)}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table>
          <table style="margin-top:8px">
            <tr><td>货值</td><td class="num">${money(o.goods_amount)}</td></tr>
            <tr><td>促销优惠</td><td class="num">-${money(o.promo_amount)}</td></tr>
            ${Number(o.coupon_amount) ? `<tr><td>券抵扣</td><td class="num">-${money(o.coupon_amount)}</td></tr>` : ''}
            ${Number(o.member_discount) ? `<tr><td>等级折扣</td><td class="num">-${money(o.member_discount)}</td></tr>` : ''}
            ${Number(o.round_amount) ? `<tr><td>抹零</td><td class="num">-${money(o.round_amount)}</td></tr>` : ''}
            <tr><td><b>应收</b></td><td class="num"><b>${money(o.payable_amount)}</b></td></tr>
            <tr><td>混合成本 / 毛利</td><td class="num">${money(o.cost_amount)} / ${money(o.profit_amount)}</td></tr>
          </table>
        </div>
      </div>`;
    const { mask, close } = openDetailModal(`订单详情 ${esc(o.order_no)} `, html, {
      width: 1020,
      onClose: () => { list(); listScanpay(); },
    });
    // ── 退款（5.2.6 售后：按行原路退 + 审核流）──
    mask.querySelector('#rfAll').onclick = () => {
      mask.querySelectorAll('.rfQty').forEach(inp => { inp.value = inp.max; });
    };
    mask.querySelector('#rfGo').onclick = async () => {
      const items = [...mask.querySelectorAll('.rfQty')]
        .map(inp => ({ saleItemId: Number(inp.dataset.siid), qty: Number(inp.value) }))
        .filter(x => x.qty > 0);
      const reason = mask.querySelector('#rfReason').value.trim();
      const restock = mask.querySelector('#rfRestock').checked;
      const box = mask.querySelector('#rfResult');
      if (!items.length) { box.innerHTML = '<span class="tag r">请填写退货数量</span>'; return; }
      if (!reason) { box.innerHTML = '<span class="tag r">退货原因必填（留痕）</span>'; return; }
      const r = await post('/refunds', { orderId: Number(id), items, reason, restock });
      if (r.code === 0) {
        const d0 = r.data || {};
        box.innerHTML = `<span class="tag ${d0.status === '待审核' ? 'y' : 'g'}">${esc(d0.status || '已退款')}</span>
          退款金额 <b>${money(d0.amount)}</b>（免审限额内原路退；超出部分需审核执行）`;
        setTimeout(() => { close(); detail(id); }, 1800);
      } else {
        box.innerHTML = `<span class="tag r">失败</span> ${esc(r.msg || '')}`;
      }
    };
  }

  await list();
  await listScanpay();

  /* ── V4.22.0 供「销售明细」双击行跳转直达单据详情（跨屏事件；防重复绑定） ── */
  if (!window.__salesDetailLsn) {
    window.__salesDetailLsn = true;
    window.addEventListener('sales:open-detail', ev => { try { detail(String(ev.detail)); } catch { /* 屏未就绪忽略 */ } });
  }
}
