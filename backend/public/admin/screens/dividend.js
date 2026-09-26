import { get, post, must, money, esc, dt, toast } from '../api.js';
import { paginate, bindPager } from '../common-ui.js';

/** 分红引擎：GET /dividend/preview、POST /dividend/periods/run、GET /dividend/periods、GET /dividend/records */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>每日利润与自动分红 </h3>
      <div class="bar">
        <input id="dPbDate" type="date" style="width:150px" title="口径日（默认昨天）">
        <button class="btn" id="dPbGo">查询利润</button>
        <button class="btn pri" id="dAutoRun">⚡ 立即自动计提（幂等）</button>
        <span class="muted" style="font-size:11.5px">自动分红每日 02:35 执行（系统设置「分红与会员 → 自动每日分红」可关）</span>
      </div>
      <div id="dPbOut" class="muted">毛利 − 门店硬消耗日摊（房租/水电/折旧/其他，设置页「门店硬消耗」组）= 净利 → 净利 × 分红比例 = 分红池</div>
    </div>
    <div class="card">
      <h3>分红试算 </h3>
      <div class="bar">
        <input id="dNp" type="number" step="0.01" placeholder="昨日净利润" style="width:140px">
        <button class="btn" id="dPre">试算</button>
        <button class="btn pri" id="dRun">执行计提（幂等）</button>
        <input id="dDate" type="date" style="width:150px">
      </div>
      <div id="dPreOut" class="muted">输入净利润后试算（池 = 净利 × 比例，余额加权，仅活跃会员）</div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="card"><h3>计提期次 </h3><div id="dPeriods" class="tbl-min"></div></div>
      <div class="card"><h3>分红明细 
        <input id="dMid" type="number" placeholder="按会员ID过滤" style="margin-left:8px; width:120px">
        <button class="btn" id="dRGo">查询</button></h3><div id="dRecords" class="tbl-min"></div></div>
    </div>
    <div class="card">
      <h3>分红人工调整（补发 / 冲减） </h3>
      <div class="bar">
        <input id="dAdjMid" type="number" placeholder="会员ID" style="width:110px">
        <input id="dAdjAmt" type="number" step="0.01" placeholder="金额（负=冲减）" style="width:150px">
        <input id="dAdjReason" placeholder="原因（必填，留痕）" style="width:240px">
        <button class="btn pri" id="dAdjGo">执行调整</button>
      </div>
      <div class="muted" style="font-size:11.5px">冲减不得使余额为负（分红是纯收益不产生负债）。退款单执行时已按占比<b>自动回冲</b>该订单计提的分红（记录类型「冲减」，退款单 dividend_reversed 字段可查），本入口仅用于差错修正、投诉补偿等人工场景。需「member.dividend.adjust」权限。</div>
    </div>`;

  const np = () => Number(view.querySelector('#dNp').value);

  /* ── P3-2：每日利润明细 + 自动计提 ── */
  const kpi = (t, v, sub = '', color = '') => `<div style="flex:1;min-width:120px;padding:10px 14px;border:1px solid var(--line);border-radius:10px">
    <div class="muted" style="font-size:12px">${t}</div>
    <div style="font-size:18px;font-weight:800;margin-top:2px;${color ? `color:${color}` : ''}">${v}</div>
    <div class="muted" style="font-size:11px">${sub}</div></div>`;
  async function loadBreakdown() {
    const date = view.querySelector('#dPbDate').value || undefined;
    const d = await must(get('/dividend/profit-breakdown' + (date ? `?date=${date}` : '')));
    const ratio = await get('/settings?group=' + encodeURIComponent('分红与会员')).then(r => {
      const rows = (r && r.data) || r || [];
      const row = Array.isArray(rows) ? rows.find(x => x.setting_key === 'dividend.ratio') : null;
      return row ? Number(row.value) : 5;
    }).catch(() => 5);
    view.querySelector('#dPbOut').innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">
      ${kpi('毛利（口径日）', money(d.gross), `来源：${d.source === 'daily_settlement' ? '日结快照' : d.source === 'hq_sales_live' ? '总部实时' : '实时汇总'}`)}
      ${kpi('门店硬消耗日摊', '−' + money(d.hardCost), `月值 ÷ ${d.days} 天`)}
      ${kpi('净利（分红基数）', money(d.net), `× ${ratio}% ≈ 分红池 ${money(Math.round(Number(d.net) * 100) * Math.round(ratio * 100) / 10000 / 100)}`, Number(d.net) > 0 ? 'var(--ok,#2e9e5b)' : '#c0392b')}
      ${kpi('自动分红', d.autoEnabled ? '开启' : '关闭', d.lastPeriod ? `上次：${String(d.lastPeriod.bizDate).slice(0, 10)} 池 ${money(d.lastPeriod.pool)}` : '尚未计提', d.autoEnabled ? '' : '#c0392b')}
    </div>`;
  }
  view.querySelector('#dPbGo').onclick = loadBreakdown;
  view.querySelector('#dAutoRun').onclick = async () => {
    const date = view.querySelector('#dPbDate').value || undefined;
    const d = await must(post('/dividend/auto/run', date ? { date } : {}));
    if (d.skipped) toast(`未计提：${d.skipped}`);
    else toast(`已计提：净利 ${money(d.gross ?? 0)} 池 ${money(d.pool)} → ${d.memberCount} 名会员`);
    await loadPeriods(); await loadRecords(); await loadBreakdown();
  };

  view.querySelector('#dPre').onclick = async () => {
    if (!(np() >= 0)) return toast('请输入非负净利润', false);
    const d = await must(get(`/dividend/preview?netProfit=${np()}`));
    view.querySelector('#dPreOut').innerHTML =
      `分红池 <b>${money(d.pool)}</b> · 参与会员 ${d.memberCount ?? d.members?.length ?? 0} 人` +
      (d.redAlert ? ' · <span class="tag r">年化红色预警</span>' : d.orangeAlert ? ' · <span class="tag y">橙色预警</span>' : '');
  };
  view.querySelector('#dRun').onclick = async () => {
    if (!(np() >= 0)) return toast('请输入非负净利润', false);
    const date = view.querySelector('#dDate').value || undefined;
    const d = await must(post('/dividend/periods/run', { netProfit: np(), date }), '计提完成');
    toast(`计提 ${money(d.given)} → ${d.memberCount} 名会员`);
    await loadPeriods(); await loadRecords();
  };

  let perPage = 1, recPage = 1;
  async function loadPeriods() {
    const rows = await must(get('/dividend/periods')).catch(() => []);
    const pg = paginate(rows, perPage, 10);
    view.querySelector('#dPeriods').innerHTML = rows.length ? `
      <table><thead><tr><th>业务日期</th><th class="num">净利润</th><th class="num">分红池</th><th class="num">实发</th><th>状态</th></tr></thead>
      <tbody>${pg.slice.map(p => `<tr><td>${String(p.biz_date).slice(0, 10)}</td>
        <td class="num">${money(p.net_profit)}</td><td class="num">${money(p.pool_amount)}</td>
        <td class="num">${money(p.given_amount)}</td><td>${esc(p.status || '—')}</td></tr>`).join('')}</tbody></table>${pg.bar}`
      : '<div class="empty">暂无计提记录</div>';
    bindPager(view.querySelector('#dPeriods'), p => { perPage = p; loadPeriods(); });
  }
  async function loadRecords() {
    const mid = view.querySelector('#dMid').value;
    const rows = await must(get('/dividend/records' + (mid ? `?memberId=${mid}` : ''))).catch(() => []);
    const pg = paginate(rows, recPage, 10);
    view.querySelector('#dRecords').innerHTML = rows.length ? `
      <table><thead><tr><th>会员</th><th>类型</th><th class="num">金额</th><th>时间</th></tr></thead>
      <tbody>${pg.slice.map(r => `<tr><td>${esc(r.member_name || r.member_id)}</td>
        <td><span class="tag ${r.record_type === '计提' ? 'g' : r.record_type === '抵扣' ? 'b' : 'y'}">${esc(r.record_type)}</span></td>
        <td class="num">${money(r.amount)}</td><td>${dt(r.created_at)}</td></tr>`).join('')}</tbody></table>${pg.bar}`
      : '<div class="empty">暂无明细</div>';
    bindPager(view.querySelector('#dRecords'), p => { recPage = p; loadRecords(); });
  }
  view.querySelector('#dRGo').onclick = () => { recPage = 1; loadRecords(); };

  /* ── V4.28.4 P1-12：分红人工调整（补发/冲减）── */
  view.querySelector('#dAdjGo').onclick = async () => {
    const mid = Number(view.querySelector('#dAdjMid').value);
    const amt = Number(view.querySelector('#dAdjAmt').value);
    const reason = view.querySelector('#dAdjReason').value.trim();
    if (!mid) return toast('请填写会员ID', false);
    if (!Number.isFinite(amt) || amt === 0) return toast('金额须为非零（负=冲减 / 正=补发）', false);
    if (!reason) return toast('必须填写原因（留痕）', false);
    if (!confirm(`确认对会员 #${mid} ${amt < 0 ? '冲减' : '补发'} ¥${money(Math.abs(amt))}？\n原因：${reason}`)) return;
    try {
      const r = await must(post('/dividend/adjust', { memberId: mid, amount: amt, reason }), '调整完成');
      toast(`✅ 已调整，会员当前分红余额 ¥${money(r.balance)}`);
      view.querySelector('#dAdjAmt').value = ''; view.querySelector('#dAdjReason').value = '';
      await loadRecords();
    } catch (e) { toast(e.message || '调整失败', false); }
  };

  await loadPeriods();
  await loadRecords();
  await loadBreakdown();
}
