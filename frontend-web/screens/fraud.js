import { get, must, esc, dt, money, toast } from '../api.js';
import { openDetailModal, paginate, bindPager } from '../common-ui.js';

/** M4a 智能防损看板（V4.14.0 L 改版）：
 *  - 总览 KPI（异常折扣行/异常让利/退款单）与明细表行均可点击 → 弹窗下钻单据列表 → 点单号查订单详情；
 *  - 采购退货/收银差异同样下钻；
 *  - 近7日趋势：每日一组，组内三根柱子「左=异常折扣 中=退款 右=差异班次」横向并排。
 */
export async function render(view) {
  const load = async () => {
    const d = await must(get('/ai/fraud/dashboard'));
    const s = d.summary || {};
    const kpi = (key, v, t, hint) => `<div class="kpi ${key ? 'lk' : ''}" ${key ? `data-kpi="${key}" title="${hint}"` : ''} style="${key ? 'cursor:pointer;' : ''}padding:10px 12px">
      <div class="v" style="font-size:18px">${v}</div><div class="t">${t}${key ? ' 🔍' : ''}</div></div>`;
    const html = `
      <div class="card">
        <h3>🛡️ 防损总览 <span class="api">GET /ai/fraud/dashboard（阈值：折扣率 ${(d.thresholds?.discountFloor ?? 0.3) * 100}% · 退货率 ${(d.thresholds?.returnFloor ?? 0.1) * 100}% · 差异 ¥${d.thresholds?.cashGap ?? 10}）</span></h3>
        <div class="grid kpis" style="align-items:stretch;grid-template-columns:repeat(5,1fr);gap:10px">
          ${kpi('disc', s.discLines ?? 0, '异常折扣行', '点击查看异常折扣单据')}
          ${kpi('discAmt', '¥' + Number(s.discAmt ?? 0).toFixed(2), '让利金额', '点击查看异常折扣单据')}
          ${kpi('refund', s.refundBills ?? 0, '退款单', '点击查看退款单列表')}
          ${kpi('', ((s.refundRate ?? 0) * 100).toFixed(1) + '%', '退货率' + ((s.refundRate ?? 0) > (d.thresholds?.returnFloor ?? 0.1) ? ' ⚠' : ''), '')}
          ${kpi('cash', s.cashGapCount ?? 0, '差异班次', '点击查看差异班次详情')}
        </div>
        <style>.kpi.lk:hover{outline:2px solid var(--pri,#20663f);border-radius:10px}</style>
        <div id="fAlerts" class="mt8 tbl-min"></div>
      </div>
      <div class="card">
        <h3>🚨 异常折扣 · 按收银员（近7天，手工改价或折扣率超阈值；点击行查看单据）</h3>
        ${d.byCashier?.length ? `
        <table><thead><tr><th>收银员</th><th class="num">折扣行</th><th class="num">单数</th><th class="num">让利金额</th></tr></thead>
        <tbody>${d.byCashier.map(r => `<tr data-kpi="disc" style="cursor:pointer" title="双击/点击查看该类单据（可再按收银员筛选）">
          <td>${esc(r.name)}</td><td class="num">${r.lines}</td><td class="num">${r.bills}</td>
          <td class="num">¥${Number(r.amt).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">近7天无异常折扣</div>'}
      </div>
      <div class="card">
        <h3>📦 采购退货 · 按供应商 TOP（近30天；点击行查看退货单）</h3>
        ${d.bySupplier?.length ? `
        <table><thead><tr><th>供应商</th><th class="num">退货单</th><th class="num">退货金额</th></tr></thead>
        <tbody>${d.bySupplier.map(r => `<tr data-sup="${esc(r.supplier)}" style="cursor:pointer" title="点击查看该供应商退货单">
          <td>${esc(r.supplier)}</td><td class="num">${r.bills}</td><td class="num">¥${Number(r.amt).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">近30天无采购退货</div>'}
      </div>
      <div class="card">
        <h3>💰 收银差异（近30天已交班，|差异| 超 ¥${d.thresholds?.cashGap ?? 10}；点击行查看班次时段）</h3>
        ${d.cashGaps?.length ? `
        <table><thead><tr><th>收银员</th><th>台号</th><th>交班时间</th><th class="num">现金应收</th><th class="num">差异</th></tr></thead>
        <tbody>${d.cashGaps.map((c, i) => `<tr data-gap="${i}" style="cursor:pointer" title="点击查看差异说明">
          <td>${esc(c.name)}</td><td>${esc(c.posNo)}</td><td>${dt(c.closedAt)}</td>
          <td class="num">¥${Number(c.cashTotal ?? 0).toFixed(2)}</td>
          <td class="num" style="color:${Number(c.diff) >= 0 ? '#c0392b' : '#2e9e5b'}">${Number(c.diff).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">近30天无超阈值收银差异</div>'}
      </div>
      <div class="card">
        <h3>📈 近7日趋势（异常折扣行 / 退款单 / 差异班次）——每日一组，左中右三根柱</h3>
        <div id="fTrend"></div>
      </div>`;
    view.innerHTML = html;

    // 告警列表
    const alerts = d.alerts || [];
    view.querySelector('#fAlerts').innerHTML = alerts.length ? alerts.map(a => `
      <div class="bar" style="margin:6px 0;padding:8px 10px;border:1px solid ${a.level === 'high' ? '#c0392b' : '#e67e22'};border-radius:8px">
        <span class="tag ${a.level === 'high' ? 'r' : 'y'}">${a.level === 'high' ? '高危' : '关注'}</span>
        <b style="margin:0 8px">${esc(a.title)}</b>
        <span class="muted">${esc(a.detail)}</span>
      </div>`).join('') : '<div class="empty">✅ 无异常告警</div>';

    // 趋势图：每日一组横排（左=折扣 中=退款 右=差异），组高 120px
    const trend = d.trend || [];
    const max = Math.max(1, ...trend.flatMap(t => [t.discLines, t.refundBills, t.cashGaps]));
    const bar = (v, color, tip) => `<div title="${tip}" style="width:16px;height:${Math.max(2, (v / max) * 100)}%;background:${color};border-radius:3px 3px 0 0"></div>`;
    view.querySelector('#fTrend').innerHTML = trend.length ? `
      <div style="overflow-x:auto">
        <div style="display:flex;gap:18px;align-items:flex-end;height:150px;padding-top:12px;min-width:520px">
          ${trend.map(t => `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;height:100%">
            <div style="flex:1;display:flex;align-items:flex-end;gap:4px;height:100%">
              ${bar(t.discLines, '#c0392b', `${t.date} 异常折扣行 ${t.discLines}`)}
              ${bar(t.refundBills, '#e67e22', `${t.date} 退款单 ${t.refundBills}`)}
              ${bar(t.cashGaps, '#8e44ad', `${t.date} 差异班次 ${t.cashGaps}`)}
            </div>
            <div class="muted" style="text-align:center;font-size:11px;margin-top:4px;white-space:nowrap">${String(t.date).slice(5)}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="muted mt8" style="display:flex;gap:14px;justify-content:center">
        <span><i style="display:inline-block;width:10px;height:10px;background:#c0392b;border-radius:2px;margin-right:4px"></i>异常折扣行（左）</span>
        <span><i style="display:inline-block;width:10px;height:10px;background:#e67e22;border-radius:2px;margin-right:4px"></i>退款单（中）</span>
        <span><i style="display:inline-block;width:10px;height:10px;background:#8e44ad;border-radius:2px;margin-right:4px"></i>差异班次（右）</span>
      </div>` : '<div class="empty">暂无趋势数据</div>';

    // ── 下钻 ──
    view.querySelectorAll('[data-kpi]').forEach(el => el.onclick = () => {
      const k = el.dataset.kpi;
      if (k === 'disc' || k === 'discAmt') drillDisc();
      else if (k === 'refund') drillRefunds();
      else if (k === 'cash') drillCashGaps(d.cashGaps || []);
    });
    view.querySelectorAll('[data-sup]').forEach(el => el.onclick = () => drillReturns(el.dataset.sup));
    view.querySelectorAll('[data-gap]').forEach(el => el.onclick = () => {
      const c = (d.cashGaps || [])[Number(el.dataset.gap)];
      if (!c) return;
      openDetailModal(`💰 差异班次 · ${esc(c.name)}（${esc(c.posNo)}）`, `
        <div class="grid kpis" style="grid-template-columns:repeat(3,1fr)">
          <div class="kpi"><div class="t">交班时间</div><div class="v" style="font-size:14px">${dt(c.closedAt)}</div></div>
          <div class="kpi"><div class="t">现金应收</div><div class="v">¥${Number(c.cashTotal ?? 0).toFixed(2)}</div></div>
          <div class="kpi"><div class="t">差异（长+/短−）</div><div class="v" style="color:${Number(c.diff) >= 0 ? '#c0392b' : '#2e9e5b'}">${Number(c.diff).toFixed(2)}</div></div>
        </div>
        <div class="doc-tip">💡 现金应收 = 备用金 + 本班现金收入；差异 = 现金实盘 − 现金应收。长短款已随交班留痕，可在「交接班」页回溯该班次，并在「销售单据」按此时间段+收银员过滤核对。</div>`);
    });

    /** 异常折扣单列表 → 点单号查订单详情（弹窗内分页） */
    async function drillDisc() {
      const r = await must(get('/ai/fraud/disc-orders?days=7'));
      const items = r.items || [];
      const { mask, close } = openDetailModal('🚨 近7天异常折扣单（点击单号查订单详情）', '<div id="fDrillBody"></div>');
      let page = 1;
      const draw = () => {
        const pg = paginate(items, page, 10);
        mask.querySelector('#fDrillBody').innerHTML = items.length ? `
          <table><thead><tr><th>单号</th><th>收银员</th><th class="num">异常行</th><th class="num">让利金额</th><th class="num">应收</th><th>时间</th></tr></thead>
          <tbody>${pg.slice.map(o => `<tr>
            <td><a href="javascript:void 0" data-oid="${o.id}" style="font-family:var(--mono);color:var(--pri);text-decoration:underline">${esc(o.order_no)}</a></td>
            <td>${esc(o.cashier_name || '—')}</td><td class="num">${o.disc_lines}</td>
            <td class="num" style="color:#c0392b">¥${Number(o.disc_amt).toFixed(2)}</td>
            <td class="num">¥${Number(o.payable_amount).toFixed(2)}</td><td class="muted">${dt(o.created_at)}</td></tr>`).join('')}</tbody></table>${pg.bar}`
          : '<div class="empty">近7天无异常折扣单</div>';
        bindPager(mask.querySelector('#fDrillBody'), p => { page = p; draw(); });
        bindOrderLinks(mask);
      };
      draw();
    }

    /** 退款单列表 → 点单号查订单详情（弹窗内分页） */
    async function drillRefunds() {
      const r = await must(get('/ai/fraud/refund-orders?days=30'));
      const items = r.items || [];
      const { mask } = openDetailModal('📦 近30天退款单（点击单号查订单详情）', '<div id="fDrillBody"></div>');
      let page = 1;
      const draw = () => {
        const pg = paginate(items, page, 10);
        mask.querySelector('#fDrillBody').innerHTML = items.length ? `
          <table><thead><tr><th>订单号</th><th class="num">退款金额</th><th>退款状态</th><th>原因</th><th>收银员</th><th>时间</th></tr></thead>
          <tbody>${pg.slice.map(x => `<tr>
            <td><a href="javascript:void 0" data-oid="${x.order_id}" style="font-family:var(--mono);color:var(--pri);text-decoration:underline">${esc(x.order_no)}</a></td>
            <td class="num" style="color:#c0392b">¥${Number(x.amount).toFixed(2)}</td>
            <td>${esc(x.status || '—')}</td><td class="muted">${esc(x.reason || '—')}</td>
            <td>${esc(x.cashier_name || '—')}</td><td class="muted">${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>${pg.bar}`
          : '<div class="empty">近30天无退款单</div>';
        bindPager(mask.querySelector('#fDrillBody'), p => { page = p; draw(); });
        bindOrderLinks(mask);
      };
      draw();
    }

    /** 采购退货单列表 → 点单号查退货单详情（弹窗内分页） */
    async function drillReturns(supplier = '') {
      const r = await must(get(`/ai/fraud/return-orders?days=30&supplier=${encodeURIComponent(supplier)}`));
      const items = r.items || [];
      const { mask } = openDetailModal(`📦 采购退货单${supplier ? ` · ${esc(supplier)}` : ''}（近30天，点击单号查退货单详情）`, '<div id="fDrillBody"></div>');
      let page = 1;
      const draw = () => {
        const pg = paginate(items, page, 10);
        mask.querySelector('#fDrillBody').innerHTML = items.length ? `
          <table><thead><tr><th>退货单号</th><th>供应商</th><th class="num">项数</th><th class="num">金额</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>${pg.slice.map(x => `<tr>
            <td><a href="javascript:void 0" data-rid="${x.id}" style="font-family:var(--mono);color:var(--pri);text-decoration:underline">${esc(x.return_no)}</a></td>
            <td>${esc(x.supplier_name)}</td><td class="num">${x.item_count}</td>
            <td class="num">¥${Number(x.total_amount).toFixed(2)}</td>
            <td>${esc(x.status)}</td><td class="muted">${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>${pg.bar}`
          : '<div class="empty">近30天无采购退货单</div>';
        bindPager(mask.querySelector('#fDrillBody'), p => { page = p; draw(); });
        bindReturnLinks(mask);
      };
      draw();
    }

    /** 订单详情（简版弹窗：明细+支付+金额）；scope 传弹窗根元素，只绑该弹窗内的链接 */
    function bindOrderLinks(scope = document) {
      scope.querySelectorAll('[data-oid]').forEach(a => a.onclick = async () => {
        const dd = await must(get(`/sales/${a.dataset.oid}`));
        const o = dd.order;
        openDetailModal(`订单详情 ${esc(o.order_no)} <span class="api">GET /sales/${a.dataset.oid}</span>`, `
          <div class="bar muted">渠道 ${esc(o.channel)} · 状态 ${esc(o.status)} · ${esc(o.member_name || '散客')} · 收银员 ${esc(o.cashier_name || '—')} · ${dt(o.created_at)}</div>
          <table style="margin-top:8px"><thead><tr><th>商品</th><th class="num">数量</th><th class="num">原价</th><th class="num">售价</th><th class="num">小计</th><th>批次溯源</th></tr></thead>
          <tbody>${dd.items.map(i => `<tr><td>${esc(i.product_name)}</td><td class="num">${Number(i.qty)}</td>
            <td class="num">${money(i.origin_price)}</td><td class="num">${money(i.unit_price)}</td>
            <td class="num">${money(i.line_amount)}</td>
            <td class="muted">${(i.batch_trace || []).map(b => `${b.batch}×${Number(b.qty)}`).join('，')}</td></tr>`).join('')}</tbody></table>
          <table style="margin-top:8px">
            <tr><td>货值</td><td class="num">${money(o.goods_amount)}</td></tr>
            <tr><td>促销+券+折扣</td><td class="num">-${money(Number(o.promo_amount) + Number(o.coupon_amount) + Number(o.member_discount))}</td></tr>
            <tr><td><b>应收</b></td><td class="num"><b>${money(o.payable_amount)}</b></td></tr>
            <tr><td>毛利</td><td class="num">${money(o.profit_amount)}</td></tr>
          </table>
          <div class="doc-tip">💡 完整操作（含退款）请到「销售单据」查该单。</div>`, { width: 780 });
      });
    }

    /** 退货单号链接 → 退货单详情（scope 限定在所属弹窗内） */
    function bindReturnLinks(scope = document) {
      scope.querySelectorAll('[data-rid]').forEach(a => a.onclick = async () => {
        const dd = await must(get(`/purchase/returns/${a.dataset.rid}`));
        const ret = dd.return || dd.order || dd;
        openDetailModal(`采购退货单 ${esc(ret.return_no || '')}`, `
          <div class="bar muted">供应商 ${esc(ret.supplier_name || '')} · 状态 ${esc(ret.status)} · 金额 ¥${Number(ret.total_amount ?? 0).toFixed(2)} · ${dt(ret.created_at)}</div>
          <table style="margin-top:8px"><thead><tr><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
          <tbody>${(dd.items || []).map(i => `<tr><td>${esc(i.product_name || i.name || '')}</td>
            <td class="num">${Number(i.qty)}</td><td class="num">${money(i.unit_price ?? i.price ?? 0)}</td>
            <td class="num">${money(i.line_amount ?? Number(i.qty) * Number(i.unit_price ?? i.price ?? 0))}</td></tr>`).join('')}</tbody></table>`, { width: 640 });
      });
    }
  };
  await load();
  const refresh = view.querySelector('#fRefresh');
  if (refresh) refresh.onclick = load;
}
