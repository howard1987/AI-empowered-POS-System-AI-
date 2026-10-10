import { get, must, money, esc, dt, toast, imgUrl } from '../api.js';
import { openDetailModal } from '../common-ui.js';

/** 经营看板：GET /reports/dashboard?period=day|week|month|quarter */
export async function render(view) {
  let period = 'day';
  view.innerHTML = `
    <div class="bar">
      ${['day', 'week', 'month', 'quarter'].map(p =>
        `<button class="btn ${p === 'day' ? 'pri' : ''}" data-p="${p}">${({ day: '今日', week: '本周', month: '本月', quarter: '本季' })[p]}</button>`).join('')}
      
    </div>
    <div id="dashBody"></div>`;
  const body = view.querySelector('#dashBody');
  const btns = view.querySelectorAll('[data-p]');
  btns.forEach(b => b.onclick = () => {
    period = b.dataset.p;
    btns.forEach(x => x.classList.toggle('pri', x === b));
    load();
  });

  async function load() {
    const [d, abc, fraud] = await Promise.all([
      must(get(`/reports/dashboard?period=${period}`)),
      must(get('/reports/abc')),
      must(get('/reports/fraud')),
    ]);
    const c = d.current;
    // ABC 分析（P1-3 原型 #10：累计销售额占比 A≤80% / B≤95% / C 其余）
    const abcRows = (abc.items || []).slice(0, 15);
    const abcHtml = abcRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>商品</th><th>分层</th><th class="num">销量</th><th class="num">销售额</th><th class="num">累计占比</th><th class="num">毛利</th></tr></thead>
      <tbody>${abcRows.map((r, i) => `<tr>
        <td class="num seq">${i + 1}</td><td>${esc(r.name)}</td>
        <td><span class="tag ${r.className === 'A' ? 'r' : r.className === 'B' ? 'y' : 'b'}">${r.className}</span></td>
        <td class="num">${Number(r.qty)}</td><td class="num">${money(r.revenue)}</td>
        <td class="num">${Number(r.cum_pct).toFixed(1)}%</td><td class="num">${money(r.profit)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">暂无销售数据</div>';
    // 大客户应收账龄（M9：未收合计/超90天/高危客户，接口缺失不阻塞看板）
    let rcvHtml = '';
    try {
      const r = await get('/big-customers/receivables-overview');
      const rcv = r.code === 0 ? r.data : null;
      if (rcv && Number(rcv.totalUnpaid) > 0) {
        const over90 = Number(rcv.unpaid90) > 0 ? `<div class="kpi"><div class="t">超 90 天</div><div class="v" style="color:var(--err)">${money(rcv.unpaid90)}</div></div>` : '';
        // V5.0.18g：账期客户（账期>0）超「挂账日+账期」未收 = 已逾期（按账期滚动结算）
        const overdueKpi = `<div class="kpi"><div class="t">已逾期（超账期）</div><div class="v" style="color:var(--err)">${money(rcv.totalOverdue ?? 0)}</div></div>`;
        rcvHtml = `
          <div class="grid kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px">
            <div class="kpi"><div class="t">未收合计</div><div class="v" style="color:var(--warn)">${money(rcv.totalUnpaid)}</div></div>
            <div class="kpi"><div class="t">欠款客户</div><div class="v">${rcv.unpaidCustomers}</div></div>
            ${overdueKpi}
          </div>
          ${(rcv.top || []).length ? `<table><thead><tr><th class="seq">序号</th><th>大客户</th><th class="num">账期</th><th class="num">未收</th><th class="num">已逾期</th><th class="num">超90天</th></tr></thead>
          <tbody>${rcv.top.map((r, i) => `<tr>
            <td class="num seq">${i + 1}</td>
            <td><span data-bc="${esc(r.name)}" style="cursor:pointer;color:var(--pri);font-weight:600" title="点击查看客户详情">${esc(r.name)}</span></td>
            <td class="num">${Number(r.termMonths ?? 0) > 0 ? Number(r.termMonths) + ' 个月' : '现结'}</td>
            <td class="num" style="color:var(--warn)">${money(r.unpaid)}</td>
            <td class="num" style="color:${Number(r.overdue) > 0 ? 'var(--err)' : 'inherit'}">${money(r.overdue ?? 0)}</td>
            <td class="num" style="color:${Number(r.over90) > 0 ? 'var(--err)' : 'inherit'}">${money(r.over90)}</td></tr>`).join('')}</tbody></table>
          <div class="muted" style="font-size:11px;padding:4px 2px 0">口径：已逾期 = 账期客户（账期 &gt; 0）挂账日 + 账期 仍为未收的金额（按账期滚动结算）；未设账期客户沿用 90 天账龄。</div>` : ''}`;
      } else {
        rcvHtml = '<div class="empty">暂无大客户未收账款</div>';
      }
    } catch { rcvHtml = '<div class="empty">大客户模块未启用</div>'; }
    // 防损监控（P1-3：取消率/退款率/负毛利单阈值标红）
    const f = fraud.summary || {};
    const red = v => Number(v) > 0 ? 'var(--err)' : 'inherit';
    const fraudHtml = `
      <div class="grid kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px">
        <div class="kpi"><div class="t">取消率</div><div class="v" style="font-size:18px;color:${Number(f.cancelRate) > 5 ? 'var(--err)' : 'inherit'}">${Number(f.cancelRate).toFixed(1)}%</div></div>
        <div class="kpi"><div class="t">退款率</div><div class="v" style="font-size:18px;color:${Number(f.refundRate) > 5 ? 'var(--err)' : 'inherit'}">${Number(f.refundRate).toFixed(1)}%</div></div>
        <div class="kpi"><div class="t">负毛利单率</div><div class="v" style="font-size:18px;color:${Number(f.negProfitRate) > 3 ? 'var(--err)' : 'inherit'}">${Number(f.negProfitRate).toFixed(1)}%</div></div>
      </div>
      ${(fraud.byCashier || []).length ? `<table><thead><tr><th class="seq">序号</th><th>收银员</th><th class="num">单数</th><th class="num">取消</th><th class="num">退款</th><th class="num">退款额</th><th class="num">负毛利单</th></tr></thead>
      <tbody>${fraud.byCashier.map((r, i) => `<tr>
        <td class="num seq">${i + 1}</td><td>${esc(r.name)}</td><td class="num">${r.orderCount}</td>
        <td class="num" style="color:${red(r.cancelCount)}">${r.cancelCount}</td>
        <td class="num" style="color:${red(r.refundCount)}">${r.refundCount}</td>
        <td class="num" style="color:${red(r.refundAmount)}">${money(r.refundAmount)}</td>
        <td class="num" style="color:${red(r.negProfitCount)}">${r.negProfitCount}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">无收银记录</div>'}`;
    // 近 7 日经营趋势：增列（毛利/客单价/销售额环比）+ 底部迷你走势图
    const tr = d.trend || [];
    const maxSales = Math.max(1, ...tr.map(t => Number(t.salesTotal)));
    const sparkPts = tr.map((t, i) => {
      const x = tr.length > 1 ? (i / (tr.length - 1)) * 232 + 4 : 120;
      const y = 50 - (Number(t.salesTotal) / maxSales) * 42;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const trendHtml = tr.length ? `
      <table><thead><tr>
        <th class="seq">序号</th><th>日期</th><th class="num">订单数</th><th class="num">销售额</th>
        <th class="num">毛利</th><th class="num">客单价</th><th class="num">销售额环比</th>
      </tr></thead>      <tbody>${tr.map((t, i) => {
        const st = Number(t.salesTotal), od = Number(t.orderCount), pf = Number(t.profitTotal);
        const avg = od > 0 ? st / od : 0;
        let chg = '—', col = 'var(--ink-3)';
        if (i > 0) {
          const prev = Number(tr[i - 1].salesTotal);
          if (prev > 0) {
            const pct = (st - prev) / prev * 100;
            chg = (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(1) + '%';
            col = pct > 0 ? '#c0392b' : (pct < 0 ? '#1e8e4e' : 'var(--ink-3)'); // 红涨绿跌
          }
        }
        return `<tr data-day="${t.bizDate?.slice(0, 10)}" style="cursor:pointer" title="点击查看当日订单明细">
          <td class="num seq">${i + 1}</td><td>${t.bizDate?.slice(0, 10)}</td>
          <td class="num">${od}</td><td class="num">${money(st)}</td>
          <td class="num">${money(pf)}</td><td class="num">${money(avg)}</td>
          <td class="num" style="color:${col}">${chg}</td>
        </tr>`;
      }).join('')}</tbody></table>
      <div class="trend-spark">
        <svg viewBox="0 0 240 54" preserveAspectRatio="none" width="100%" height="54" role="img" aria-label="近7日销售额走势">
          <polyline points="${sparkPts}" fill="none" stroke="var(--pri)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        <div class="muted">近 7 日销售额走势（按当日销售额连线）</div>
      </div>`
      : '<div class="empty">暂无趋势数据</div>';
    body.innerHTML = `
      <div class="grid kpis">
        <div class="kpi"><div class="t">销售额</div><div class="v">${money(c.salesTotal)}</div></div>
        <div class="kpi"><div class="t">毛利</div><div class="v">${money(c.profitTotal)}</div></div>
        <div class="kpi"><div class="t">订单数</div><div class="v">${c.orderCount}</div></div>
        <div class="kpi"><div class="t">客单价</div><div class="v">${money(c.avgTicket)}</div></div>
        <div class="kpi"><div class="t">新增会员</div><div class="v">${c.newMembers}</div></div>
        <div class="kpi"><div class="t">分红计提</div><div class="v" style="color:var(--warn)">${money(c.dividendGiven)}</div></div>
        <div class="kpi"><div class="t">分红抵扣</div><div class="v" style="color:var(--ok)">${money(c.dividendUsed)}</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>近 7 日经营趋势</h3>${trendHtml}</div>
      <div class="card" style="margin-top:14px"><h3>大客户应收账龄</h3>${rcvHtml}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card"><h3>周期对比（近 4 个 ${({ day: '日', week: '周', month: '月', quarter: '季' })[period]}）</h3>
          <table><thead><tr><th class="seq">序号</th><th>周期</th><th class="num">单数</th><th class="num">销售额</th><th class="num">毛利</th></tr></thead>
          <tbody>${d.periods.map((p, i) => `<tr><td class="num seq">${i + 1}</td><td>${String(p.bucket).slice(0, 10)}</td>
            <td class="num">${p.orderCount}</td><td class="num">${money(p.salesTotal)}</td><td class="num">${money(p.profitTotal)}</td></tr>`).join('')}</tbody></table></div>
        <div class="card"><h3>分类销售额占比（近 30 日 Top12）</h3>
          ${d.categoryShare.length ? `<table><thead><tr><th class="seq">序号</th><th>分类</th><th class="num">销售额</th></tr></thead>
            <tbody>${d.categoryShare.map((s, i) => {
              /* V5.0.11h：与 docTable 同一个 bug —— `<tr${...}>` 少空格会拼出
               * `<trdata-cat="7" ...>`，被 tbody 丢弃 → 隐式 tr → 属性全丢，
               * 导致「点击分类行看销售明细」失效。条件非空时必须先补空格。 */
              const a = s.id ? ` data-cat="${s.id}" style="cursor:pointer" title="点击查看该分类商品销售明细"` : '';
              return `<tr${a}><td class="num seq">${i + 1}</td><td>${esc(s.name)}</td><td class="num">${money(s.revenue)}</td></tr>`;
            }).join('')}</tbody></table>`
          : '<div class="empty">暂无数据</div>'}</div>
      </div>`;

    /* ── V5.0.2：卡片/表格点击 → 对应明细弹窗 ── */
    const range = () => {
      const days = { day: 1, week: 7, month: 30, quarter: 90 }[period] || 30;
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      return { from, to };
    };
    const openOrders = async (from, to, title) => {
      const d2 = await must(get(`/sales?from=${from}&to=${to}&size=15&page=1`)).catch(() => null);
      const rows = d2?.items || [];
      openDetailModal(title, rows.length ? `
        <table><thead><tr><th class="seq">序号</th><th>单号</th><th>会员</th><th class="num">应收</th><th class="num">毛利</th><th>时间</th></tr></thead>
        <tbody>${rows.map((o, i) => `<tr><td class="num seq">${i + 1}</td>
          <td><span data-oid="${o.id}" data-ono="${esc(o.order_no)}" style="cursor:pointer;color:var(--pri);font-family:var(--mono);font-weight:600;text-decoration:underline;text-underline-offset:3px" title="点击查看该单商品/支付明细">${esc(o.order_no)}</span></td>
          <td>${esc(o.member_name || '—')}</td>
          <td class="num"><b>${money(o.payable_amount)}</b></td><td class="num">${money(o.profit_amount)}</td><td class="muted">${dt(o.created_at)}</td></tr>`).join('')}</tbody></table>
        ${d2?.sums ? `<div class="bar" style="margin-top:10px"><b>合计：</b>销售额 ${money(d2.sums.payable)} · 毛利 ${money(d2.sums.profit)}（共 ${d2.total} 单，弹窗展示最近 15 单）</div>` : ''}`
        : '<div class="empty">该时段无订单</div>', { width: 760 });
      // V5.0.18g：订单号可点击 → 单据完整明细（商品行/批次溯源/支付方式，只读）
      document.querySelectorAll('[data-oid]').forEach(a => {
        a.onclick = () => openOrderFull(Number(a.dataset.oid), a.dataset.ono);
      });
    };
    /* V5.0.18g：销售单完整明细弹窗（GET /sales/:id；只读版，退款操作仍在报表中心/销售单据页） */
    const openOrderFull = async (id, orderNo) => {
      const d = await must(get(`/sales/${id}`)).catch(() => null);
      if (!d) return;
      const o = d.order;
      openDetailModal(`销售单详情 · ${orderNo || o.order_no || '#' + id}`, `
        <div class="bar muted">渠道 ${esc(o.channel)} · 状态 ${esc(o.status)} · 班次 ${o.shift_id ? '#' + o.shift_id : '—'} · 创建 ${dt(o.created_at)}${o.member_name ? ` · 会员 ${esc(o.member_name)}` : ''}</div>
        <table style="margin-top:8px"><thead><tr><th class="seq">序号</th><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th><th class="num">成本</th><th>批次溯源</th></tr></thead>
        <tbody>${(d.items || []).map((i, idx) => `<tr>
          <td class="num seq">${idx + 1}</td><td>${esc(i.product_name)}</td><td class="num">${Number(i.qty)}</td><td class="num">${money(i.unit_price)}</td>
          <td class="num">${money(i.line_amount)}</td><td class="num">${money(i.line_cost)}</td>
          <td class="muted">${(i.batch_trace || []).map(b => `${b.batch}×${Number(b.qty)}@${Number(b.cost)}`).join('<br>')}</td></tr>`).join('')}</tbody></table>
        <table style="margin-top:10px"><thead><tr><th>支付方式</th><th class="num">金额</th></tr></thead>
        <tbody>
          ${(d.payments || []).map(p => `<tr><td>${esc(p.channel)}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}
          <tr><td>货值</td><td class="num">${money(o.goods_amount)}</td></tr>
          <tr><td>促销优惠</td><td class="num">-${money(o.promo_amount)}</td></tr>
          ${Number(o.coupon_amount) ? `<tr><td>券抵扣</td><td class="num">-${money(o.coupon_amount)}</td></tr>` : ''}
          ${Number(o.member_discount) ? `<tr><td>等级折扣</td><td class="num">-${money(o.member_discount)}</td></tr>` : ''}
          ${Number(o.round_amount) ? `<tr><td>抹零</td><td class="num">-${money(o.round_amount)}</td></tr>` : ''}
          <tr><td><b>应收</b></td><td class="num"><b>${money(o.payable_amount)}</b></td></tr>
          <tr><td>混合成本 / 毛利</td><td class="num">${money(o.cost_amount)} / ${money(o.profit_amount)}</td></tr>
        </tbody></table>`, { width: 900 });
    };
    /* V5.0.18g：大客户详情弹窗（账龄表点击客户名；只读版——建档/额度/应收/签字等） */
    const openBcDetail = async name => {
      const r = await must(get('/big-customers?keyword=' + encodeURIComponent(name))).catch(() => null);
      const list = Array.isArray(r) ? r : (r?.items || r?.data || []);
      const c = list.find(x => String(x.name) === String(name));
      if (!c) return toast('未找到该客户档案（可能已删除）', false);
      const unpaid = Math.max(0, Number(c.total_receivable) - Number(c.paid_cash) - Number(c.paid_collect));
      openDetailModal('🤝 客户详情', `
        <div class="bar muted" style="margin-bottom:8px">👤 客户名称：<b>${esc(c.name)}</b>（编号 #${c.id}）</div>
        <div class="grid kpis" style="grid-template-columns:repeat(4,1fr)">
          <div class="kpi"><div class="t">信用额度（赊账上限）</div><div class="v">${Number(c.credit_limit) > 0 ? money(c.credit_limit) : '不限'}</div></div>
          <div class="kpi"><div class="t">额度余额（还可赊）</div><div class="v">${Number(c.credit_limit) > 0 ? money(Math.max(0, Number(c.credit_limit) - unpaid)) : '不限'}</div></div>
          <div class="kpi"><div class="t">预存余额（先存后用）</div><div class="v" style="color:var(--pri)">${money(c.balance ?? 0)}</div></div>
          <div class="kpi"><div class="t">未收应收</div><div class="v" style="color:${unpaid > 0 ? '#c0392b' : 'var(--ok,#2e9e5b)'}">${money(unpaid)}</div></div>
        </div>
        <table style="margin-top:10px">
          <tr><td style="width:110px;color:var(--muted,#8a8577)">联系人</td><td>${esc(c.contact || '—')}</td>
              <td style="width:110px;color:var(--muted,#8a8577)">联系电话</td><td>${esc(c.phone || '—')}</td></tr>
          <tr><td style="color:var(--muted,#8a8577)">建档时间</td><td>${c.created_at ? dt(c.created_at) : '—'}</td>
              <td style="color:var(--muted,#8a8577)">最近业务</td><td>${c.last_order_at ? dt(c.last_order_at) : '—'}</td></tr>
          <tr><td style="color:var(--muted,#8a8577)">整单折扣</td><td>${(Number(c.default_discount) * 100).toFixed(0)}%</td>
              <td style="color:var(--muted,#8a8577)">订单数</td><td>${c.order_count ?? 0}</td></tr>
          <tr><td style="color:var(--muted,#8a8577)">应收合计</td><td>${money(c.total_receivable)}</td>
              <td style="color:var(--muted,#8a8577)">已收</td><td>${money((Number(c.paid_cash) || 0) + (Number(c.paid_collect) || 0))}</td></tr>
          <tr><td style="color:var(--muted,#8a8577)">账期</td><td>${Number(c.payment_term_months ?? 0) > 0 ? `<b>${Number(c.payment_term_months)} 个月</b>（挂账日起 ${Number(c.payment_term_months)} 个月内滚动结清）` : '现结'}</td>
              <td style="color:var(--muted,#8a8577)">结算方式</td><td>${Number(c.payment_term_months ?? 0) > 0 ? '按账期滚动结算' : '现结（下单即收）'}</td></tr>
          <tr><td style="color:var(--muted,#8a8577)">状态</td><td>${Number(c.status) === 1 ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
              <td style="color:var(--muted,#8a8577)">电子签字</td>
              <td>${c.signature_path
                ? `<img src="${imgUrl(c.signature_path)}" style="max-height:44px;border:1px dashed var(--line);border-radius:6px;vertical-align:middle;background:#fff" title="客户电子签字">`
                : '<span class="tag y">未采集</span>'}</td></tr>
        </table>
        <div class="doc-tip">💡 完整操作（收款 / 预充值 / 专价 / 台账）请到「大客户」模块双击该客户打开。</div>`, { width: 720 });
    };
    body.querySelectorAll('[data-bc]').forEach(t => {
      t.onclick = () => openBcDetail(t.dataset.bc);
    });
    const KPI_KEYS = ['sales', 'profit', 'orders', 'avg', 'members', 'divGiven', 'divUsed'];
    body.querySelectorAll('.kpis .kpi').forEach((el, i) => {
      const k = KPI_KEYS[i];
      if (!k) return;
      el.style.cursor = 'pointer';
      el.title = '点击查看明细';
      el.onclick = async () => {
        const { from, to } = range();
        if (['sales', 'profit', 'orders', 'avg'].includes(k)) {
          return openOrders(from, to, `订单明细（${from} ~ ${to}）`);
        }
        if (k === 'members') {
          const m = await must(get('/members?size=15&page=1')).catch(() => null);
          const items = m?.items || [];
          return openDetailModal('新增会员明细（最近注册）', items.length ? `
            <table><thead><tr><th class="seq">序号</th><th>ID</th><th>姓名</th><th>手机</th><th>注册时间</th></tr></thead>
            <tbody>${items.map((x, i) => `<tr><td class="num seq">${i + 1}</td><td>${x.id}</td><td><b>${esc(x.name || '—')}</b></td><td class="muted">${esc(x.phone || '')}</td><td class="muted">${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>`
            : '<div class="empty">暂无会员</div>', { width: 640 });
        }
        const dvr = await must(get('/dividend/records')).catch(() => null);
        const items = Array.isArray(dvr) ? dvr : (dvr?.items || []);
        return openDetailModal(k === 'divGiven' ? '分红计提明细' : '分红抵扣明细', items.length ? `
          <table><thead><tr><th class="seq">序号</th><th>会员</th><th class="num">金额</th><th>类型</th><th>时间</th></tr></thead>
          <tbody>${items.slice(0, 20).map((x, i) => `<tr><td class="num seq">${i + 1}</td><td>${esc(x.member_name || x.name || '—')}</td><td class="num">${money(x.amount)}</td>
            <td>${esc(x.record_type || '')}</td><td class="muted">${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">暂无记录</div>', { width: 680 });
      };
    });
    body.querySelectorAll('tr[data-day]').forEach(tr => {
      tr.onclick = () => openOrders(tr.dataset.day, tr.dataset.day, `订单明细 · ${tr.dataset.day}`);
    });
    body.querySelectorAll('tr[data-cat]').forEach(tr => {
      tr.onclick = async () => {
        const { from, to } = range();
        const d2 = await must(get(`/sales/items?categoryId=${tr.dataset.cat}&from=${from}&to=${to}&size=20&page=1`)).catch(() => null);
        const rows = d2?.items || [];
        openDetailModal(`分类商品销售明细 · ${tr.children[0].textContent}（${from} ~ ${to}）`, rows.length ? `
          <table><thead><tr><th class="seq">序号</th><th>时间</th><th>单号</th><th>商品</th><th class="num">数量</th><th class="num">小计</th></tr></thead>
          <tbody>${rows.map((x, i) => `<tr><td class="num seq">${i + 1}</td><td class="muted">${dt(x.created_at)}</td><td style="font-family:var(--mono)">${esc(x.order_no)}</td>
            <td>${esc(x.productName)}</td><td class="num">${Number(x.qty)}</td><td class="num"><b>${money(x.lineAmount)}</b></td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">该时段无此分类销售明细</div>', { width: 760 });
      };
    });
  }
  await load();
}
