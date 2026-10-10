import { get, must, money, esc, dt, unwrap } from '../api.js';
import { paginate, bindPager, serverPagerBar, fitFillPanes } from '../common-ui.js';
import { segHtml, bindSeg } from '../ui-polish.js';   // V4.26.4 统一分段控件

/** 报表中心（P1-1）：商品销售明细 / 会员消费报表 / 员工业绩报表 三 Tab + CSV 导出
 *  V5.0.7：六个 Tab 全部「表格容器铺满窗口不溢出」——Tab 根 = .fill-pane（JS 定高），
 *  卡片 = .fill-card，表格宿主 = .tbl-host（内部滚动 + 表头吸顶 + 分页条吸容器底）；
 *  优惠券明细两卡用 .split-rows 均分窗口高。展示内容不变。 */
export async function render(view) {
  view.innerHTML = `
    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <!-- V4.26.4：四个报表主切换改用统一 .seg 分段控件（选中态由组件重绘管理） -->
      <span id="rpSeg"></span>
      <span class="muted" style="margin-left:auto;font-size:11.5px">口径：已完成订单 · 支持区间/关键词/分类筛选 · 一键导出 CSV（Excel 可直接打开）</span>
    </div>

    <div id="tab-sale" class="fill-pane">
      <div class="card fill-card" style="padding-bottom:14px">
        <h3>商品销售明细 </h3>
        <div class="bar">
          <input type="date" id="sdFrom"> <span class="muted">至</span> <input type="date" id="sdTo">
          <input id="sdKw" placeholder="商品名称/条码" style="width:160px">
          <select id="sdCat" style="width:150px"><option value="">全部分类</option></select>
          <button class="btn pri" id="sdGo">查询</button>
          <button class="btn" id="sdCsv">导出</button>
        </div>
        <div id="sdBody" class="tbl-host"></div>
      </div>
    </div>

    <div id="tab-member" class="fill-pane" style="display:none">
      <div class="card fill-card">
        <h3>会员消费报表 </h3>
        <div class="bar">
          <input type="date" id="mbFrom"> <span class="muted">至</span> <input type="date" id="mbTo">
          <button class="btn pri" id="mbGo">查询</button>
          <button class="btn" id="mbCsv">导出</button>
        </div>
        <div id="mbSum"></div>
        <div id="mbBody" class="tbl-host"></div>
      </div>
    </div>

    <div id="tab-employee" class="fill-pane" style="display:none">
      <div class="card fill-card">
        <h3>员工业绩报表 </h3>
        <div class="bar">
          <input type="date" id="emFrom"> <span class="muted">至</span> <input type="date" id="emTo">
          <select id="emCashier" style="width:150px"><option value="">全部收银员</option></select>
          <button class="btn pri" id="emGo">查询</button>
          <button class="btn" id="emCsv">导出</button>
        </div>
        <div id="emBody" class="tbl-host"></div>
      </div>
    </div>

    <div id="tab-inventory" class="fill-pane" style="display:none">
      <div class="card fill-card">
        <h3>进销存报表 </h3>
        <div class="bar">
          <input type="date" id="ivFrom"> <span class="muted">至</span> <input type="date" id="ivTo">
          <input id="ivKw" placeholder="商品名称/条码" style="width:160px">
          <select id="ivCat" style="width:150px"><option value="">全部分类</option></select>
          <button class="btn pri" id="ivGo">查询</button>
          <button class="btn" id="ivCsv">导出</button>
          <span class="muted">期初=区间起始日前累计净入；期末=期初+入库−出库（stock_flows 全量流水）</span>
        </div>
        <div id="ivBody" class="tbl-host"></div>
      </div>
    </div>

    <div id="tab-gift" class="fill-pane" style="display:none">
      <div class="card fill-card">
        <h3>🎁 赠送记录 <span class="muted" style="font-size:11.5px">含手工赠品与促销自动赠品（均为 0 元真实出库，扣批次库存）</span></h3>
        <div class="bar">
          <input type="date" id="gfFrom"> <span class="muted">至</span> <input type="date" id="gfTo">
          <button class="btn pri" id="gfGo">查询</button>
          <button class="btn" id="gfCsv">导出</button>
        </div>
        <div id="gfSum"></div>
        <div id="gfBody" class="tbl-host"></div>
      </div>
    </div>
    <div id="tab-coupon" class="fill-pane split-rows" style="display:none">
      <div class="card fill-card">
        <h3>🎟 优惠券库存看板 <span class="muted" style="font-size:11.5px">生成入库→发放→核销出库（一次性商品，不退券）</span></h3>
        <div class="bar">
          <input id="cpKw" placeholder="大类码/名称" style="width:160px">
          <button class="btn pri" id="cpGo">查询</button>
          <button class="btn" id="cpCsv">导出</button>
        </div>
        <div id="cpSum"></div>
        <div id="cpBody" class="tbl-host"></div>
      </div>
      <div class="card fill-card">
        <h3>优惠券出入库流水 <span class="muted" style="font-size:11.5px">谁领取/使用·何时·关联单据，全链路可追溯</span></h3>
        <div class="bar">
          <input id="clKw" placeholder="大类码/名称/id" style="width:150px">
          <select id="clType"><option value="">全部动作</option><option>入库</option><option>发放出库</option><option>核销出库</option><option>过期出库</option><option>退库</option></select>
          <input id="clMember" placeholder="会员ID" style="width:90px">
          <input id="clDoc" placeholder="单据号" style="width:120px">
          <input type="date" id="clFrom"> <span class="muted">至</span> <input type="date" id="clTo">
          <button class="btn pri" id="clGo">查询</button>
          <button class="btn" id="clCsv">导出</button>
        </div>
        <div id="clBody" class="tbl-host"></div>
      </div>
    </div>`;

  /* ── Tab 切换（V4.26.4：改用 .seg 分段控件） ── */
  const tabs = { sale: 'tab-sale', member: 'tab-member', employee: 'tab-employee', inventory: 'tab-inventory', gift: 'tab-gift', coupon: 'tab-coupon' };
  const RP_TABS = [
    { k: 'sale', t: '🛒 商品销售明细' }, { k: 'member', t: '👥 会员消费报表' },
    { k: 'employee', t: '🧑‍💼 员工业绩报表' }, { k: 'inventory', t: '📦 进销存报表' },
    { k: 'gift', t: '🎁 赠送记录' }, { k: 'coupon', t: '🎟 优惠券明细' },
  ];
  function drawTabs(cur) {
    const host = view.querySelector('#rpSeg'); if (!host) return;
    host.innerHTML = segHtml(RP_TABS, cur);
    bindSeg(host, k => { drawTabs(k); switchTab(k); });
  }
  function switchTab(k) {
    Object.entries(tabs).forEach(([key, id]) => view.querySelector('#' + id).style.display = key === k ? '' : 'none');
    fitFillPanes(view);   // V5.0.7：隐藏 Tab 刚显示，重算铺满高度（此前 display:none 量不到）
  }
  /* ═══ 优惠券明细（V5.0：库存闭环 + 全链路流水） ═══ */
  let cpRows = [];
  async function drawCouponStock() {
    const kw = view.querySelector('#cpKw').value.trim();
    cpRows = await must(get('/reports/coupons-stock?keyword=' + encodeURIComponent(kw))).catch(() => []);
    const sum = cpRows.reduce((s, r) => ({
      inStock: (s.inStock || 0) + (r.stock_controlled ? Number(r.in_stock) || 0 : 0),
      used: (s.used || 0) + Number(r.used_count || 0),
      benefit: (s.benefit || 0) + Number(r.benefit_amount || 0),
    }), {});
    view.querySelector('#cpSum').innerHTML = `<div class="muted">共 ${cpRows.length} 种券 · 在库合计 ${money(sum.inStock || 0)} 张 · 已核销 ${sum.used || 0} 张 · 让利合计 ${money(sum.benefit || 0)}</div>`;
    view.querySelector('#cpBody').innerHTML = cpRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>大类码</th><th>名称</th><th>类型</th><th class="num">入库总量</th><th class="num">在库</th>
        <th class="num">未使用</th><th class="num">已核销</th><th class="num">已过期</th><th class="num">作废</th>
        <th class="num">核销率</th><th class="num">让利金额</th><th>状态</th></tr></thead>
      <tbody>${cpRows.map((r, i) => `<tr>
        <td class="num seq">${i + 1}</td><td><code>${esc(r.code || '')}</code></td><td>${esc(r.name)}</td><td>${esc(r.type)}</td>
        <td class="num">${r.stock_controlled ? Number(r.total_qty) : '不限'}</td>
        <td class="num">${r.stock_controlled ? Number(r.in_stock) : '—'}</td>
        <td class="num">${Number(r.unused_count || 0)}</td><td class="num">${Number(r.used_count || 0)}</td>
        <td class="num">${Number(r.expired_count || 0)}</td><td class="num">${Number(r.voided_count || 0)}</td>
        <td class="num">${Number(r.redeem_rate || 0)}%</td><td class="num">${money(r.benefit_amount || 0)}</td>
        <td>${r.status === 1 ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">无数据</div>';
  }
  view.querySelector('#cpGo').onclick = drawCouponStock;
  view.querySelector('#cpCsv').onclick = () => {
    const headers = ['大类码', '名称', '类型', '入库总量', '在库', '未使用', '已核销', '已过期', '作废', '核销率', '让利金额', '状态'];
    const rows = cpRows.map(r => [r.code, r.name, r.type, r.stock_controlled ? r.total_qty : '不限', r.stock_controlled ? r.in_stock : '',
      r.unused_count, r.used_count, r.expired_count, r.voided_count, (r.redeem_rate || 0) + '%', r.benefit_amount || 0, r.status === 1 ? '启用' : '停用']);
    csvDownload('优惠券库存看板.csv', headers, rows);
  };

  let clRows = [];
  const clTypeColor = { '入库': 'g', '发放出库': '', '核销出库': 'r', '过期出库': 'warn', '退库': 'b' };
  async function drawCouponLog(page = 1) {
    const p = new URLSearchParams();
    const kw = view.querySelector('#clKw').value.trim(); if (kw) p.set('coupon', kw);
    const mt = view.querySelector('#clType').value; if (mt) p.set('moveType', mt);
    const mid = view.querySelector('#clMember').value.trim(); if (mid) p.set('memberId', mid);
    const doc = view.querySelector('#clDoc').value.trim(); if (doc) p.set('docNo', doc);
    const f = view.querySelector('#clFrom').value; if (f) p.set('from', f);
    const t = view.querySelector('#clTo').value; if (t) p.set('to', t);
    p.set('page', String(page)); p.set('size', '50');
    const d = await must(get('/reports/coupon-stock-log?' + p.toString())).catch(() => ({ rows: [], total: 0 }));
    clRows = d.rows || [];
    view.querySelector('#clBody').innerHTML = clRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>时间</th><th>动作</th><th>大类码</th><th>券名称</th><th>会员</th><th>经手人</th>
        <th class="num">变动</th><th class="num">可用库存</th><th>单据号</th><th>备注</th></tr></thead>
      <tbody>${clRows.map((r, i) => `<tr>
        <td class="num seq">${i + 1}</td><td>${dt(r.created_at)}</td>
        <td><span class="tag ${clTypeColor[r.move_type] || ''}">${esc(r.move_type)}</span></td>
        <td><code>${esc(r.coupon_code || '')}</code></td><td>${esc(r.coupon_name || '')}</td>
        <td>${esc(r.member_name || '')}</td><td>${esc(r.operator_name || '系统')}</td>
        <td class="num">${r.qty > 0 ? '+' : ''}${r.qty}</td><td class="num">${r.stock_after}</td>
        <td>${esc(r.related_doc_no || '')}</td><td>${esc(r.remark || '')}</td>
      </tr>`).join('')}</tbody></table>
      ${serverPagerBar({ page, total: d.total || 0, size: 50 })}`
      : '<div class="empty">无流水</div>';
    bindPager(view.querySelector('#clBody'), p => drawCouponLog(p));
  }
  view.querySelector('#clGo').onclick = () => drawCouponLog(1);
  view.querySelector('#clCsv').onclick = async () => {
    const p = new URLSearchParams();
    const kw = view.querySelector('#clKw').value.trim(); if (kw) p.set('coupon', kw);
    const mt = view.querySelector('#clType').value; if (mt) p.set('moveType', mt);
    const mid = view.querySelector('#clMember').value.trim(); if (mid) p.set('memberId', mid);
    const doc = view.querySelector('#clDoc').value.trim(); if (doc) p.set('docNo', doc);
    const f = view.querySelector('#clFrom').value; if (f) p.set('from', f);
    const t = view.querySelector('#clTo').value; if (t) p.set('to', t);
    p.set('size', '5000');
    const d = await must(get('/reports/coupon-stock-log?' + p.toString())).catch(() => ({ rows: [] }));
    const headers = ['时间', '动作', '大类码', '券名称', '会员', '经手人', '变动', '可用库存', '单据号', '备注'];
    const rows = (d.rows || []).map(r => [r.created_at, r.move_type, r.coupon_code, r.coupon_name, r.member_name, r.operator_name, r.qty, r.stock_after, r.related_doc_no, r.remark]);
    csvDownload('优惠券出入库流水.csv', headers, rows);
  };

  drawTabs('sale');

  /* ── 导出（统一弹窗选 Excel / CSV 格式；BOM 头保证 Excel 中文不乱码）── */
  function csvDownload(name, headers, rows) {
    const columns = headers.map((h, i) => ({ k: 'c' + i, t: h }));
    const data = rows.map(arr => {
      const o = {};
      headers.forEach((_, i) => { o['c' + i] = arr[i]; });
      return o;
    });
    openExportPicker({ filename: name.replace(/\.csv$/, ''), columns, rows: data });
  }

  /* ── 筛选数据源：分类 / 收银员 ── */
  (async () => {
    try {
      const c = unwrap(await get('/products/categories'));
      const items = Array.isArray(c) ? c : (c?.items || []);
      const opts = '<option value="">全部分类</option>' +
        items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
      view.querySelector('#sdCat').innerHTML = opts;
      view.querySelector('#ivCat').innerHTML = opts;
    } catch { /* 无分类不阻塞 */ }
    try {
      const e = unwrap(await get('/auth/employees?size=100'));
      const items = Array.isArray(e) ? e : (e?.items || []);
      view.querySelector('#emCashier').innerHTML = '<option value="">全部收银员</option>' +
        items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    } catch { /* 无员工不阻塞 */ }
  })();

  /* ═══ 商品销售明细 ═══ */
  let sdRows = [];
  let sdTotal = {};
  let sdPage = 1;
  let sdCount = 0;
  function drawSale() {   // V5.0.18g：服务端分页（翻页重新请求，count 为总行数）
    const pg = { page: sdPage, slice: sdRows, pages: Math.max(Math.ceil(sdCount / 10), 1) };
    const t = sdTotal;
    const max = Math.max(...sdRows.map(r => Number(r.revenue)), 0);
    view.querySelector('#sdBody').innerHTML = sdRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>商品</th><th>分类</th><th class="num">销量</th><th class="num">单数</th>
        <th class="num">销售额</th><th class="num">成本</th><th class="num">毛利</th><th class="num">毛利率</th><th class="num">占比</th></tr></thead>
      <tbody>${pg.slice.map((r, i) => `<tr>
        <td class="num muted seq">${(pg.page - 1) * 10 + i + 1}</td>
        <td>${esc(r.name)}</td><td>${esc(r.category_name)}</td>
        <td class="num">${Number(r.qty)}</td><td class="num">${r.orderCount}</td>
        <td class="num"><b>${money(r.revenue)}</b></td>
        <td class="num">${money(r.cost)}</td>
        <td class="num" style="color:${Number(r.profit) < 0 ? 'var(--warn)' : 'inherit'}">${money(r.profit)}</td>
        <td class="num">${Number(r.revenue) ? (Number(r.profit) / Number(r.revenue) * 100).toFixed(1) + '%' : '—'}</td>
        <td class="num">${Number(t.revenue) ? (Number(r.revenue) / Number(t.revenue) * 100).toFixed(1) + '%' : '—'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4" class="num">合计 ${sdCount || sdRows.length} 项</td>
        <td class="num">${t.orderCount}</td><td class="num">${money(t.revenue)}</td><td class="num">${money(t.cost)}</td>
        <td class="num">${money(t.profit)}</td><td colspan="2"></td></tr></tfoot></table>
      <div class="bar muted" style="margin-top:6px">Top1 销售额 ${money(max)}（柱状占比示意）</div>
      ${pg.bar}`
      : '<div class="empty">无数据：请调整日期区间或筛选条件</div>';
    bindPager(view.querySelector('#sdBody'), p => { sdPage = p; loadSale(sdPage); });
  }
  async function loadSale(page = 1) {
    const p = new URLSearchParams({ page: String(page), size: '10' });
    const from = view.querySelector('#sdFrom').value, to = view.querySelector('#sdTo').value;
    const kw = view.querySelector('#sdKw').value.trim(), cat = view.querySelector('#sdCat').value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (kw) p.set('keyword', kw);
    if (cat) p.set('categoryId', cat);
    const d = await must(get('/reports/sale-detail?' + p));
    sdRows = d.items || [];
    sdTotal = d.total || {};
    sdCount = Number(d.count || 0);
    sdPage = Number(d.page || page);
    drawSale();
  }
  view.querySelector('#sdGo').onclick = () => loadSale(1);
  view.querySelector('#sdKw').addEventListener('keydown', e => { if (e.key === 'Enter') loadSale(); });
  view.querySelector('#sdCsv').onclick = () => csvDownload('商品销售明细.csv',
    ['商品', '分类', '销量', '单数', '销售额', '成本', '毛利'],
    sdRows.map(r => [r.name, r.category_name, Number(r.qty), r.orderCount, Number(r.revenue), Number(r.cost), Number(r.profit)]));

  /* ═══ 会员消费报表 ═══ */
  let mbRows = [];
  let mbPage = 1;
  function drawMember() {
    const pg = paginate(mbRows, mbPage, 10);
    mbPage = pg.page;
    view.querySelector('#mbBody').innerHTML = mbRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>会员</th><th>等级</th><th class="num">消费次数</th><th class="num">消费额</th>
        <th class="num">毛利</th><th class="num">储值余额</th><th class="num">分红余额</th><th class="num">积分</th><th>最近消费</th></tr></thead>
      <tbody>${pg.slice.map((r, i) => `<tr>
        <td class="num seq">${(mbPage - 1) * 10 + i + 1}</td><td>${esc(r.name || r.card_no)}<div class="muted" style="font-size:11px">${esc(r.phone || '')} · ${esc(r.card_no)}</div></td>
        <td>${esc(r.level_name)}</td>
        <td class="num">${r.orderCount}</td><td class="num"><b>${money(r.salesTotal)}</b></td>
        <td class="num">${money(r.profitTotal)}</td>
        <td class="num">${money(r.balance)}</td><td class="num">${money(r.dividendBalance)}</td>
        <td class="num">${r.points}</td><td>${dt(r.last_active_date)}</td></tr>`).join('')}</tbody></table>
      ${pg.bar}`
      : '<div class="empty">无数据：该区间内无会员消费</div>';
    bindPager(view.querySelector('#mbBody'), p => { mbPage = p; drawMember(); });
  }
  async function loadMember() {
    const p = new URLSearchParams({ size: '5000' });   // V5.0.18g：不再被默认 100 截断（聚合维度，本地分页）
    const from = view.querySelector('#mbFrom').value, to = view.querySelector('#mbTo').value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const d = await must(get('/reports/member?' + p));
    mbRows = d.items || [];
    mbPage = 1;
    const s = d.summary || {};
    view.querySelector('#mbSum').innerHTML = `
      <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
        <div class="kpi"><div class="t">新增会员</div><div class="v">${s.newMembers ?? 0}</div></div>
        <div class="kpi"><div class="t">活跃会员</div><div class="v">${s.activeMembers ?? 0}</div></div>
        <div class="kpi"><div class="t">会员消费占比</div><div class="v">${Number(s.memberRatio ?? 0).toFixed(1)}%</div></div>
        <div class="kpi"><div class="t">会员销售额</div><div class="v">${money(s.memberSales)}</div></div>
      </div>`;
    drawMember();
  }
  view.querySelector('#mbGo').onclick = loadMember;
  view.querySelector('#mbCsv').onclick = () => csvDownload('会员消费报表.csv',
    ['会员', '卡号', '手机', '等级', '消费次数', '消费额', '毛利', '储值余额', '分红余额', '积分'],
    mbRows.map(r => [r.name || r.card_no, r.card_no, r.phone, r.level_name, r.orderCount,
      Number(r.salesTotal), Number(r.profitTotal), Number(r.balance), Number(r.dividendBalance), r.points]));

  /* ═══ 员工业绩报表 ═══ */
  let emRows = [];
  let emPage = 1;
  function drawEmployee() {
    const pg = paginate(emRows, emPage, 10);
    emPage = pg.page;
    view.querySelector('#emBody').innerHTML = emRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>收银员</th><th class="num">单数</th><th class="num">应急单</th><th class="num">货值</th>
        <th class="num">促销</th><th class="num">销售额</th><th class="num">毛利</th><th class="num">客单价</th>
        <th class="num">退款单</th><th class="num">退款额</th></tr></thead>
      <tbody>${pg.slice.map((r, i) => `<tr>
        <td class="num seq">${(emPage - 1) * 10 + i + 1}</td><td>${esc(r.name)}<div class="muted" style="font-size:11px">${esc(r.emp_no)}</div></td>
        <td class="num">${r.orderCount}</td><td class="num">${r.emergencyCount}</td>
        <td class="num">${money(r.goodsTotal)}</td><td class="num">${money(r.promoTotal)}</td>
        <td class="num"><b>${money(r.salesTotal)}</b></td><td class="num">${money(r.profitTotal)}</td>
        <td class="num">${money(r.avgTicket)}</td>
        <td class="num" style="color:${Number(r.refundCount) ? 'var(--warn)' : 'inherit'}">${r.refundCount}</td>
        <td class="num" style="color:${Number(r.refundTotal) ? 'var(--warn)' : 'inherit'}">${money(r.refundTotal)}</td></tr>`).join('')}</tbody></table>
      ${pg.bar}`
      : '<div class="empty">无数据：该区间内无收银记录</div>';
    bindPager(view.querySelector('#emBody'), p => { emPage = p; drawEmployee(); });
  }
  async function loadEmployee() {
    const p = new URLSearchParams({ size: '5000' });   // V5.0.18g：不再被默认 100 截断
    const from = view.querySelector('#emFrom').value, to = view.querySelector('#emTo').value;
    const csh = view.querySelector('#emCashier').value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (csh) p.set('cashierId', csh);
    const d = await must(get('/reports/employee?' + p));
    emRows = d.items || [];
    emPage = 1;
    drawEmployee();
  }
  view.querySelector('#emGo').onclick = loadEmployee;
  view.querySelector('#emCsv').onclick = () => csvDownload('员工业绩报表.csv',
    ['工号', '姓名', '单数', '应急单', '货值', '促销', '销售额', '毛利', '客单价', '退款单', '退款额'],
    emRows.map(r => [r.emp_no, r.name, r.orderCount, r.emergencyCount, Number(r.goodsTotal),
      Number(r.promoTotal), Number(r.salesTotal), Number(r.profitTotal), Number(r.avgTicket),
      r.refundCount, Number(r.refundTotal)]));

  /* ═══ 进销存报表 ═══ */
  let ivRows = [];
  let ivTotal = {};
  let ivPage = 1;
  function drawInventory() {
    const pg = paginate(ivRows, ivPage, 10);
    ivPage = pg.page;
    const t = ivTotal;
    view.querySelector('#ivBody').innerHTML = ivRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>商品</th><th>分类</th>
        <th class="num">期初</th><th class="num">入库</th><th class="num">出库</th><th class="num">期末</th>
        <th class="num">销售单数</th><th class="num">销售额</th><th class="num">销售成本</th><th class="num">毛利</th><th class="num">毛利率</th></tr></thead>
      <tbody>${pg.slice.map((r, i) => {
        const endQty = Number(r.open_qty) + Number(r.in_qty) - Number(r.out_qty);
        return `<tr>
        <td class="num muted seq">${(pg.page - 1) * 10 + i + 1}</td>
        <td>${esc(r.name)}<div class="muted" style="font-size:11px">${esc(r.base_unit || '')}</div></td>
        <td>${esc(r.category_name)}</td>
        <td class="num">${Number(r.open_qty)}</td>
        <td class="num" style="color:var(--ok)">+${Number(r.in_qty)}</td>
        <td class="num" style="color:var(--warn)">-${Number(r.out_qty)}</td>
        <td class="num"><b>${endQty}</b></td>
        <td class="num">${r.sale_orders}</td>
        <td class="num"><b>${money(r.sale_amount)}</b></td>
        <td class="num">${money(r.sale_cost)}</td>
        <td class="num" style="color:${Number(r.sale_profit) < 0 ? 'var(--warn)' : 'inherit'}">${money(r.sale_profit)}</td>
        <td class="num">${Number(r.sale_amount) ? (Number(r.sale_profit) / Number(r.sale_amount) * 100).toFixed(1) + '%' : '—'}</td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td colspan="4" class="num">合计 ${ivRows.length} 项</td>
        <td class="num">${t.inQty}</td><td class="num">${t.outQty}</td>
        <td class="num">${Number(t.openQty) + Number(t.inQty) - Number(t.outQty)}</td>
        <td class="num">${t.saleOrders}</td><td class="num">${money(t.saleAmount)}</td>
        <td class="num">${money(t.saleCost)}</td><td class="num">${money(t.saleProfit)}</td><td></td></tr></tfoot></table>
      ${pg.bar}`
      : '<div class="empty">无数据：该区间内无销售且无库存流水（或调整日期/筛选条件）</div>';
    bindPager(view.querySelector('#ivBody'), p => { ivPage = p; drawInventory(); });
  }
  async function loadInventory() {
    const p = new URLSearchParams({ size: '5000' });   // V5.0.18g：不再被默认 500 截断（SKU 增多也不会漏）
    const from = view.querySelector('#ivFrom').value, to = view.querySelector('#ivTo').value;
    const kw = view.querySelector('#ivKw').value.trim(), cat = view.querySelector('#ivCat').value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (kw) p.set('keyword', kw);
    if (cat) p.set('categoryId', cat);
    const d = await must(get('/reports/inventory?' + p));
    ivRows = d.items || [];
    ivTotal = d.total || {};
    ivPage = 1;
    drawInventory();
  }
  view.querySelector('#ivGo').onclick = loadInventory;
  view.querySelector('#ivKw').addEventListener('keydown', e => { if (e.key === 'Enter') loadInventory(); });
  view.querySelector('#ivCsv').onclick = () => csvDownload('进销存报表.csv',
    ['商品', '分类', '期初', '入库', '出库', '期末', '销售单数', '销售额', '销售成本', '毛利', '毛利率'],
    ivRows.map(r => [r.name, r.category_name, Number(r.open_qty), Number(r.in_qty), Number(r.out_qty),
      Number(r.open_qty) + Number(r.in_qty) - Number(r.out_qty), r.sale_orders,
      Number(r.sale_amount), Number(r.sale_cost), Number(r.sale_profit),
      Number(r.sale_amount) ? (Number(r.sale_profit) / Number(r.sale_amount) * 100).toFixed(1) + '%' : '']));

  /* ── V4.28.9 🎁 赠送记录（手工赠品 + 促销自动赠品，均为 0 元真实出库） ── */
  let gfRows = [];
  async function loadGifts() {
    const from = view.querySelector('#gfFrom').value || '';
    const to = view.querySelector('#gfTo').value || '';
    const qs = new URLSearchParams({ size: '5000' });   // V5.0.18g：不再被默认 300 截断
    if (from) qs.set('from', from); if (to) qs.set('to', to);
    const d = await must(get('/reports/gifts?' + qs.toString()));
    gfRows = d.rows || [];
    const s = d.summary || {};
    view.querySelector('#gfSum').innerHTML = `<div class="bar" style="flex-wrap:wrap">
      <span class="pill" style="background:#fff6e5;color:#c07f00">赠送 ${Number(s.times || 0)} 行次</span>
      <span class="pill" style="background:#e8f5ec;color:#2f7d4f">合计 ${Number(s.qtyTotal || 0)} 件</span>
      <span class="pill" style="background:#fdeeee;color:#c0392b">成本合计 ¥${money(s.costTotal)}</span>
      <span class="pill gray">涉及 ${Number(s.kinds || 0)} 种商品</span></div>`;
    const pg = paginate(gfRows, 1, 15);
    view.querySelector('#gfBody').innerHTML = gfRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>时间</th><th>单号</th><th>商品</th><th class="num">数量</th>
        <th class="num">成本</th><th>来源</th><th>活动</th><th>收银员</th><th>备注</th></tr></thead>
      <tbody>${pg.slice.map((r, i) => `<tr>
        <td class="num seq">${i + 1}</td><td>${dt(r.created_at)}</td>
        <td class="mono">${esc(r.order_no)}</td>
        <td>${esc(r.productName || '—')}</td>
        <td class="num">${Number(r.qty)}</td>
        <td class="num">${money(r.cost)}</td>
        <td><span class="tag ${String(r.source) === '促销自动' ? 'o' : 'b'}">${esc(r.source)}</span></td>
        <td>${esc(r.promoName || '—')}</td>
        <td>${esc(r.cashier || '—')}</td>
        <td class="l muted" style="font-size:12px">${esc(r.remark || '')}</td>
      </tr>`).join('')}</tbody></table>${pg.bar}` : '<div class="empty">所选区间暂无赠送记录</div>';
    bindPager(view.querySelector('#gfBody'), p => {
      const pg2 = paginate(gfRows, p, 15);
      // 简单重绘：复用上面结构（数据量小直接整页渲染）
      view.querySelector('#gfBody').innerHTML = gfRows.length ? (() => {
        const rows2 = pg2.slice.map((r, i) => `<tr>
          <td class="num seq">${(p - 1) * 15 + i + 1}</td><td>${dt(r.created_at)}</td><td class="mono">${esc(r.order_no)}</td>
          <td>${esc(r.productName || '—')}</td><td class="num">${Number(r.qty)}</td>
          <td class="num">${money(r.cost)}</td>
          <td><span class="tag ${String(r.source) === '促销自动' ? 'o' : 'b'}">${esc(r.source)}</span></td>
          <td>${esc(r.promoName || '—')}</td><td>${esc(r.cashier || '—')}</td>
          <td class="l muted" style="font-size:12px">${esc(r.remark || '')}</td></tr>`).join('');
        return `<table><thead><tr><th class="seq">序号</th><th>时间</th><th>单号</th><th>商品</th><th class="num">数量</th>
          <th class="num">成本</th><th>来源</th><th>活动</th><th>收银员</th><th>备注</th></tr></thead><tbody>${rows2}</tbody></table>${pg2.bar}`;
      })() : '';
    });
  }
  view.querySelector('#gfGo').onclick = loadGifts;
  view.querySelector('#gfCsv').onclick = () => csvDownload('赠送记录.csv',
    ['时间', '单号', '商品', '条码', '数量', '成本', '来源', '活动', '收银员', '备注'],
    gfRows.map(r => [dt(r.created_at), r.order_no, r.productName, r.barcode, Number(r.qty), Number(r.cost),
      r.source, r.promoName, r.cashier, r.remark]));

  await Promise.all([loadSale(), loadMember(), loadEmployee(), loadInventory(), loadGifts()]);
}
