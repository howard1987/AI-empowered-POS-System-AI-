import { get, must, money, esc, dt } from '../api.js';
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
        rcvHtml = `
          <div class="grid kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px">
            <div class="kpi"><div class="t">未收合计</div><div class="v" style="color:var(--warn)">${money(rcv.totalUnpaid)}</div></div>
            <div class="kpi"><div class="t">欠款客户</div><div class="v">${rcv.unpaidCustomers}</div></div>
            ${over90 || '<div class="kpi"><div class="t">超 90 天</div><div class="v">0.00</div></div>'}
          </div>
          ${(rcv.top || []).length ? `<table><thead><tr><th class="seq">序号</th><th>大客户</th><th class="num">未收</th><th class="num">超90天</th></tr></thead>
          <tbody>${rcv.top.map((r, i) => `<tr>
            <td class="num seq">${i + 1}</td><td>${esc(r.name)}</td><td class="num" style="color:var(--warn)">${money(r.unpaid)}</td>
            <td class="num" style="color:${Number(r.over90) > 0 ? 'var(--err)' : 'inherit'}">${money(r.over90)}</td></tr>`).join('')}</tbody></table>` : ''}`;
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
      <div class="card" style="margin-top:14px"><h3>大客户应收账龄（M9）</h3>${rcvHtml}</div>
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
        <tbody>${rows.map((o, i) => `<tr><td class="num seq">${i + 1}</td><td style="font-family:var(--mono)">${esc(o.order_no)}</td><td>${esc(o.member_name || '—')}</td>
          <td class="num"><b>${money(o.payable_amount)}</b></td><td class="num">${money(o.profit_amount)}</td><td class="muted">${dt(o.created_at)}</td></tr>`).join('')}</tbody></table>
        ${d2?.sums ? `<div class="bar" style="margin-top:10px"><b>合计：</b>销售额 ${money(d2.sums.payable)} · 毛利 ${money(d2.sums.profit)}（共 ${d2.total} 单，弹窗展示最近 15 单）</div>` : ''}`
        : '<div class="empty">该时段无订单</div>', { width: 760 });
    };
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
