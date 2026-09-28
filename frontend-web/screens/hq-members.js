/**
 * V5.0.0 连锁改造 · 批次5 · 「会员跨店」页（M5-1~M5-3 配套 UI，方案 §5.2）
 *
 * 总部视角：会员跨店资产流水（余额/分红/积分 扣款与回补）+ 汇总 KPI。
 *   · 凭证号（MCF ticket）= 门店 sale_payments.external_no，可对账追溯
 *   · status ≠ done（pending_order）= 「有扣款无订单」待处理，黄色告警
 * 权限：hq.member.crossview（涉商业敏感，默认只授超管，§5.2.4）。
 *
 * 颜色口径（红涨绿跌）：会员资产「入」= 红（涨），「出」= 绿（跌）。
 */
import { get, must, esc, toast, dt } from '../api.js';
import { segHtml, bindSeg, noResult } from '../ui-polish.js';

export async function render(view) {
  const $ = s => view.querySelector(s);
  let asset = '';            // '' | balance | dividend | points
  let keyword = '';
  let data = null;

  view.innerHTML = `
    <style>
      #hmHost table td,#hmHost table th{text-align:center}
      .hm-l{text-align:left !important}
      .hm-in{color:#c0392b;font-weight:600}    /* 入=涨=红 */
      .hm-out{color:#1e8e4e;font-weight:600}   /* 出=跌=绿 */
      .hm-pend{color:#c47f00;font-weight:600}
      .hm-kpi{display:flex;gap:10px;flex-wrap:wrap;padding:10px 18px 0}
      .hm-kpi .kpi{flex:1;min-width:150px;border:1px solid var(--line,#e5e0d3);border-radius:10px;padding:10px 14px;background:var(--paper,#fff)}
      .hm-kpi .kpi b{font-size:20px;display:block}
      .hm-kpi .kpi span{color:#8a8577;font-size:12px}
    </style>

    <div class="card" style="display:flex;flex-direction:column;height:calc(100dvh - 214px);min-height:520px">
      <div class="hm-kpi" id="hmKpi"></div>
      <div style="display:flex;align-items:center;gap:12px;padding:8px 18px 0;flex-wrap:wrap">
        <span id="hmSeg"></span>
        <input id="hmKw" class="input" placeholder="卡号 / 手机号 / 姓名" style="width:180px" />
        <button class="btn" id="hmSearch">查询</button>
        <span style="flex:1"></span>
        <button class="btn" id="hmRefresh">刷新</button>
      </div>
      <div class="doc-tip">余额扣款由门店在线发起、总部唯一账本记账；<b>凭证号</b>与门店收款单 external_no 一致，可逐单对账。
        「待处理」= 有扣款但总部未收到对应销售单（门店落单失败），需人工核实。</div>
      <div style="padding:6px 18px 10px;flex:1;min-height:0;overflow:auto" id="hmHost" class="tbl-min pg-host"></div>
      <div class="doc-foot"><span class="muted" id="hmCount"></span></div>
    </div>`;

  const ASSET_NAMES = { balance: '余额', dividend: '分红', points: '积分' };

  async function load() {
    try {
      const p = new URLSearchParams();
      if (asset) p.set('asset', asset);
      if (keyword.trim()) p.set('keyword', keyword.trim());
      data = await must(get('/hq/member/flows?' + p.toString()));
    } catch (e) { data = null; toast('加载失败：' + (e?.message ?? e), 'err'); }
    draw();
  }

  function drawKpi() {
    const s = data?.sum ?? {};
    $('#hmKpi').innerHTML = `
      <div class="kpi"><b class="hm-in">${money(Number(s.balanceIn ?? 0))}</b><span>余额回补（入）</span></div>
      <div class="kpi"><b class="hm-out">${money(Number(s.balanceOut ?? 0))}</b><span>余额跨店消费（出）</span></div>
      <div class="kpi"><b>${money(Number(s.balanceIn ?? 0) - Number(s.balanceOut ?? 0))}</b><span>净流出</span></div>
      <div class="kpi"><b class="${Number(s.pending ?? 0) > 0 ? 'hm-pend' : ''}">${Number(s.pending ?? 0)}</b><span>待处理（有扣款无订单）</span></div>`;
  }

  function amountCell(r) {
    if (r.asset === 'points') {
      const cls = r.direction === '入' ? 'hm-in' : 'hm-out';
      return `<td class="${cls}">${r.direction === '入' ? '+' : '−'}${Math.abs(Number(r.points ?? 0))} 分</td>`;
    }
    const cls = r.direction === '入' ? 'hm-in' : 'hm-out';
    return `<td class="${cls}">${r.direction === '入' ? '+' : '−'}${money(Math.abs(r.amount ?? 0))}</td>`;
  }

  function draw() {
    drawKpi();
    const items = data?.items ?? [];
    if (!items.length) {
      $('#hmHost').innerHTML = noResult('近 30 天没有跨店资产流水');
      $('#hmCount').textContent = '';
      return;
    }
    $('#hmHost').innerHTML = `
      <table class="table">
        <thead><tr>
          <th class="seq">序号</th>
          <th>时间</th><th>凭证号</th><th>门店</th><th class="hm-l">会员</th><th>资产</th><th>方向</th><th>变动</th>
          <th>本金/赠送</th><th>动作后</th><th class="hm-l">关联单号</th><th>业务</th><th>状态</th>
        </tr></thead>
        <tbody>
          ${items.map((r, i) => {
            const snap = r.asset === 'points' ? `${Number(r.balance_after ?? 0)} 分`
              : `¥${Number(r.balance_after ?? 0).toFixed(2)}`;
            const split = r.asset === 'balance' && Number(r.amount ?? 0) > 0
              ? `${Number(r.principal_part ?? 0).toFixed(2)} / ${Number(r.gift_part ?? 0).toFixed(2)}` : '—';
            const st = r.status === 'done' ? '<span class="sy-ok" style="color:#1e8e4e">已完成</span>'
              : `<span class="hm-pend">${esc(r.status === 'pending_order' ? '待处理' : r.status)}</span>`;
            return `<tr>
              <td class="seq">${i + 1}</td>
              <td>${dt(r.biz_ts)}</td>
              <td><code>${esc(r.txn_no)}</code></td>
              <td>${esc(r.store_name ?? r.store_id)}</td>
              <td class="hm-l">${esc(r.member_name ?? '')}<br><span class="muted" style="font-size:11px">${esc(r.card_no ?? '')}</span></td>
              <td>${ASSET_NAMES[r.asset] ?? esc(r.asset)}</td>
              <td>${r.direction === '入' ? '回补' : '扣款'}</td>
              ${amountCell(r)}
              <td>${split}</td>
              <td>${snap}</td>
              <td class="hm-l">${esc(r.ref_no ?? '—')}</td>
              <td>${esc(r.biz_type ?? '')}</td>
              <td>${st}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    $('#hmCount').textContent = `共 ${items.length} 条（最多展示最近 500 条）`;
  }

  $('#hmSeg').innerHTML = segHtml([
    { k: '', t: '全部' }, { k: 'balance', t: '余额' }, { k: 'dividend', t: '分红' }, { k: 'points', t: '积分' },
  ], asset);
  bindSeg($('#hmSeg'), k => { asset = k; load(); });
  $('#hmSearch').onclick = () => { keyword = $('#hmKw').value; load(); };
  $('#hmKw').onkeydown = e => { if (e.key === 'Enter') { keyword = $('#hmKw').value; load(); } };
  $('#hmRefresh').onclick = () => load();

  await load();
}
