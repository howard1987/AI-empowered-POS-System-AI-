/**
 * V5.0.0 连锁改造 · 批次4B · 总部「退货与往来」（M4-13/14/17/19/20）
 *
 * 三个子页（.seg 切换）：
 *   ① 跨店退货 —— R6/R9：总部审核（待审核置顶）→ 通过后下行受理店收货；现金代付自动记往来
 *   ② 门店往来 —— 店间资金/货值台账（return_cash / supplier_return），总部人工结清确认
 *   ③ 进价差异单 —— R17：对账按 L1 结算产生的差异，两个出口（补差 pickup / 冲差 writeoff）
 *
 * 权限：服务端 hq.return.audit / hq.ledger.* / hq.variance.manage；菜单 hqOnly。
 */
import { get, post, must, esc, toast, dt, money } from '../api.js';
import { openDetailModal, paginate, bindPager } from '../common-ui.js';
import { segHtml, bindSeg, noResult } from '../ui-polish.js';

const SIZE = 15;
const CRT_STATUS_COLOR = { '待审核': '#c47f00', '已退款': '#1e8e4e', '已驳回': '#c0392b' };
const VS_STATUS = {
  open:        ['待处理', '#c47f00'],
  negotiating: ['交涉中', '#3a7bd5'],
  picked_up:   ['已补差·待结转', '#7a4fd0'],
  carried:     ['已结清（补差）', '#1e8e4e'],
  written_off: ['已冲差', '#1e8e4e'],
  disputed:    ['争议挂起', '#c0392b'],
};

export async function render(view) {
  let tab = 'return';            // return | ledger | variance
  // ── 跨店退货 ──
  let crtRows = [], crtPage = 1, crtTotal = 0;
  // ── 门店往来 ──
  let ledRows = [], ledPage = 1, ledTotal = 0, ledPending = 0, ledOnlyPending = false;
  // ── 差异单 ──
  let vsRows = [], vsPage = 1, vsTotal = 0, vsDash = null;
  let dlg = null;                // { mode:'audit'|'action'|'detail', ... }

  view.innerHTML = `
    <style>
      #htTabs table td,#htTabs table th{text-align:center}
      .ht-l{text-align:left !important}
      .ht-pos{color:#c0392b;font-weight:700}   /* 差异为正 = 买贵（红涨） */
      .ht-neg{color:#1e8e4e;font-weight:700}   /* 差异为负 = 买便宜（绿跌） */
      .ht-dash{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
      .ht-kpi{flex:1;min-width:130px;border:1px solid var(--line,#e5e1d8);border-radius:10px;padding:10px 12px;background:#fff}
      .ht-kpi b{display:block;font-size:20px;margin-top:2px}
      .ht-warn b{color:#c0392b}
    </style>
    <div class="card" style="display:flex;flex-direction:column;height:calc(100dvh - 214px);min-height:520px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px 0">
        ${segHtml('htSeg', [
          { v: 'return',   label: '跨店退货' },
          { v: 'ledger',   label: '门店往来' },
          { v: 'variance', label: '进价差异单' },
        ], tab)}
        <div id="htExtra"></div>
      </div>
      <div id="htBody" style="flex:1;overflow:auto;padding:12px 16px 16px"></div>
      <div id="htPager"></div>
    </div>`;

  const $body = view.querySelector('#htBody');
  const $pager = view.querySelector('#htPager');
  const $extra = view.querySelector('#htExtra');

  /** V4.28.6：响应形状兜底——后端个别列表返回裸数组（历史口径），统一归一为 {items} 防 "items.map is not a function" */
  const normItems = d => (Array.isArray(d) ? { items: d } : (d ?? { items: [] }));

  async function load() {
    if (tab === 'return') {
      const d = normItems(await must(get('/hq/return/tasks')).catch(e => { toast(e.message, 'err'); return { items: [] }; }));
      crtRows = Array.isArray(d.items) ? d.items : []; crtTotal = crtRows.length; crtPage = 1;
    } else if (tab === 'ledger') {
      const d = normItems(await must(get('/hq/ledger' + (ledOnlyPending ? '?status=pending' : ''))).catch(e => { toast(e.message, 'err'); return { items: [] }; }));
      ledRows = Array.isArray(d.items) ? d.items : []; ledPending = d.pendingAmount ?? 0; ledTotal = ledRows.length; ledPage = 1;
    } else {
      const d = normItems(await must(get('/hq/variances')).catch(e => { toast(e.message, 'err'); return { items: [], dashboard: null }; }));
      vsRows = Array.isArray(d.items) ? d.items : []; vsDash = d.dashboard ?? null; vsTotal = vsRows.length; vsPage = 1;
    }
    paint();
  }

  function paint() {
    if (tab === 'return') paintReturn();
    else if (tab === 'ledger') paintLedger();
    else paintVariance();
  }

  /* ═══════════ ① 跨店退货 ═══════════ */
  function paintReturn() {
    $extra.innerHTML = '';
    // V4.28.7：paginate 返回对象 {slice,bar,...}（此前误当数组 .map → 渲染崩溃）
    const pg = paginate(crtRows, crtPage, SIZE);
    const rows = pg.slice;
    $body.innerHTML = `
      <div class="sec-t">跨店退货单（总部生成 · 总部审核；受理店收货后自动回执）</div>
      ${rows.length ? `<table><thead><tr>
        <th>退货单号</th><th>原单号</th><th>受理门店</th><th>原销门店</th><th>金额</th>
        <th>退款渠道</th><th>状态</th><th>收货回执</th><th>申请时间</th><th>操作</th>
      </tr></thead><tbody>${rows.map(r => `
        <tr>
          <td>${esc(r.refund_no)}</td>
          <td class="ht-l">${esc(r.order_no ?? '')}</td>
          <td>${esc(r.accept_store ?? '')}</td>
          <td>${esc(r.origin_store ?? '')}</td>
          <td><b>${money(r.amount)}</b></td>
          <td>${esc(r.refund_channel ?? '')}</td>
          <td><span style="color:${CRT_STATUS_COLOR[r.status] ?? '#555'};font-weight:600">${esc(r.status)}</span></td>
          <td>${esc(r.recv_status ?? (r.is_cross ? '—' : '—'))}</td>
          <td>${dt(r.created_at)}</td>
          <td>${r.status === '待审核' ? `
            <button class="btn sm" data-audit="${r.id}" data-ok="1">通过</button>
            <button class="btn sm ghost" data-audit="${r.id}" data-ok="0">驳回</button>` : '—'}</td>
        </tr>`).join('')}</tbody></table>` : noResult('暂无跨店退货单')}
    `;
    $body.querySelectorAll('[data-audit]').forEach(b => {
      b.onclick = async () => {
        const ok = b.dataset.ok === '1';
        if (!confirm(ok ? '确认通过该跨店退货？通过后下行受理店收货。' : '确认驳回该跨店退货？')) return;
        try {
          await must(post(`/hq/return/${b.dataset.audit}/audit`, { approve: ok }));
          toast(ok ? '已通过并下发受理店' : '已驳回', 'ok');
          load();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    $pager.innerHTML = pg.bar;
    bindPager($pager, p => { crtPage = p; paint(); });
  }

  /* ═══════════ ② 门店往来 ═══════════ */
  function paintLedger() {
    $extra.innerHTML = `<span style="color:#c47f00;font-weight:600">待结清合计 ${money(ledPending)}</span>
      <button class="btn sm ghost" id="htLedFilter" style="margin-left:8px">${ledOnlyPending ? '看全部' : '只看待结清'}</button>`;
    view.querySelector('#htLedFilter').onclick = () => { ledOnlyPending = !ledOnlyPending; load(); };
    const pg = paginate(ledRows, ledPage, SIZE);
    const rows = pg.slice;
    const BIZ = { return_cash: '退货代付', supplier_return: '退厂货值', transfer: '调拨货款' };
    $body.innerHTML = `
      <div class="sec-t">门店往来台账（店间资金/货值；线下两店两讫后由总部确认结清）</div>
      ${rows.length ? `<table><thead><tr>
        <th>类型</th><th>关联单号</th><th>付出方</th><th>受益方</th><th>金额</th>
        <th>状态</th><th>发生时间</th><th>备注</th><th>操作</th>
      </tr></thead><tbody>${rows.map(r => `
        <tr>
          <td>${esc(BIZ[r.biz_type] ?? r.biz_type)}</td>
          <td>${esc(r.biz_ref)}</td>
          <td>${esc(r.from_store ?? '')}</td>
          <td>${esc(r.to_store ?? '')}</td>
          <td><b>${money(r.amount)}</b></td>
          <td>${r.status === 'pending' ? '<span style="color:#c47f00;font-weight:600">待结清</span>' : '<span style="color:#1e8e4e">已结清</span>'}</td>
          <td>${dt(r.created_at)}</td>
          <td class="ht-l">${esc(r.remark ?? '')}</td>
          <td>${r.status === 'pending' ? `<button class="btn sm" data-settle="${r.id}">结清确认</button>` : '—'}</td>
        </tr>`).join('')}</tbody></table>` : noResult('暂无往来记录')}
    `;
    $body.querySelectorAll('[data-settle]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('确认两家店已线下结清该笔往来？')) return;
        try {
          await must(post(`/hq/ledger/${b.dataset.settle}/settle`, {}));
          toast('已结清', 'ok'); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
    $pager.innerHTML = pg.bar;
    bindPager($pager, p => { ledPage = p; paint(); });
  }

  /* ═══════════ ③ 进价差异单 ═══════════ */
  function paintVariance() {
    $extra.innerHTML = '';
    const pg = paginate(vsRows, vsPage, SIZE);
    const rows = pg.slice;
    const dash = vsDash ? `
      <div class="ht-dash">
        <div class="ht-kpi">本月新增差异<b>${money(vsDash.monthNew)}</b></div>
        <div class="ht-kpi">已补差<b style="color:#7a4fd0">${money(vsDash.pickedUp)}</b></div>
        <div class="ht-kpi">已冲差（议价成果）<b style="color:#1e8e4e">${money(vsDash.writtenOff)}</b></div>
        <div class="ht-kpi ${vsDash.exposure > 0 ? 'ht-warn' : ''}">敞口余额<b>${money(vsDash.exposure)}</b></div>
        <div class="ht-kpi">平均结案天数<b>${vsDash.avgCloseDays}</b></div>
        <div class="ht-kpi ${vsDash.overdueCnt > 0 ? 'ht-warn' : ''}">超60天未结<b>${vsDash.overdueCnt} 单</b></div>
      </div>` : '';
    $body.innerHTML = `
      ${dash}
      <div class="sec-t">进价差异单（对账按 L1 结算 · 差异不进应付 · 两个出口）</div>
      ${rows.length ? `<table><thead><tr>
        <th>差异单号</th><th>账期</th><th>差异金额</th><th>行数</th><th>状态</th>
        <th>出口动作</th><th>审核时间</th><th>操作</th>
      </tr></thead><tbody>${rows.map(r => {
        const st = VS_STATUS[r.status] ?? [r.status, '#555'];
        return `
        <tr>
          <td>${esc(r.cvd_no)}</td>
          <td>${esc(String(r.period_start).slice(0, 10))} ~ ${esc(String(r.period_end).slice(0, 10))}</td>
          <td class="${Number(r.variance_amount) >= 0 ? 'ht-pos' : 'ht-neg'}"><b>${money(r.variance_amount)}</b></td>
          <td>${r.item_count}</td>
          <td><span style="color:${st[1]};font-weight:600">${st[0]}</span></td>
          <td>${r.action === 'pickup' ? '补差' : r.action === 'writeoff' ? '冲差' : '—'}</td>
          <td>${r.audited_at ? dt(r.audited_at) : '—'}</td>
          <td>
            <button class="btn sm ghost" data-detail="${r.id}">明细</button>
            ${['open', 'negotiating', 'disputed'].includes(r.status) ? `
              <button class="btn sm" data-act="${r.id}" data-a="pickup">补差</button>
              <button class="btn sm" data-act="${r.id}" data-a="writeoff">冲差</button>` : ''}
            ${r.status === 'open' ? `<button class="btn sm ghost" data-neg="${r.id}">转交涉</button>` : ''}
          </td>
        </tr>`; }).join('')}</tbody></table>` : noResult('暂无差异单（对账生成时自动产生）')}
    `;
    $body.querySelectorAll('[data-detail]').forEach(b => { b.onclick = () => openDetail(Number(b.dataset.detail)); });
    $body.querySelectorAll('[data-neg]').forEach(b => {
      b.onclick = async () => {
        try { await must(post(`/hq/variances/${b.dataset.neg}/negotiate`, {})); toast('已转交涉', 'ok'); load(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
    $body.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => openAction(Number(b.dataset.act), b.dataset.a); });
    $pager.innerHTML = pg.bar;
    bindPager($pager, p => { vsPage = p; paint(); });
  }

  /** 差异单明细弹窗（老板要的表格：商品/条码/总部进价/供应商进价/差异值/差异金额…） */
  async function openDetail(id) {
    const d = await must(get(`/hq/variances/${id}`)).catch(e => { toast(e.message, 'err'); return null; });
    if (!d) return;
    openDetailModal(`进价差异单 ${esc(d.cvd_no)}`, `
      <div class="band" style="margin-bottom:10px">
        供应商：<b>${esc(d.supplier_name ?? '')}</b> ｜
        开票口径 <b>${money(d.invoice_amount)}</b> ｜
        按总部价结算 <b>${money(d.settle_amount)}</b> ｜
        差异 <b class="${Number(d.variance_amount) >= 0 ? 'ht-pos' : 'ht-neg'}">${money(d.variance_amount)}</b>
        （${d.item_count} 行）｜ 状态：${(VS_STATUS[d.status] ?? [d.status])[0]}
      </div>
      <table><thead><tr>
        <th>门店</th><th>业务日期</th><th>商品名称</th><th>条码</th><th>数量</th>
        <th>总部进价</th><th>供应商进价</th><th>差异值</th><th>差异金额</th><th>入库单号</th>
      </tr></thead><tbody>
        ${(Array.isArray(d.items) ? d.items : []).map(x => `
          <tr>
            <td>${esc(x.store_name ?? '')}</td>
            <td>${esc(String(x.biz_date ?? '').slice(0, 10))}</td>
            <td class="ht-l">${esc(x.product_name)}</td>
            <td>${esc(x.barcode ?? '')}</td>
            <td>${x.qty}</td>
            <td>${money(x.settlePrice)}</td>
            <td>${money(x.actualPrice)}</td>
            <td class="${Number(x.gap) >= 0 ? 'ht-pos' : 'ht-neg'}">${x.gap >= 0 ? '+' : ''}${x.gap}</td>
            <td class="${Number(x.gapAmount) >= 0 ? 'ht-pos' : 'ht-neg'}"><b>${money(x.gapAmount)}</b></td>
            <td>${esc(x.doc_no ?? '')}</td>
          </tr>`).join('')}
      </tbody></table>
    `);
  }

  /** 两出口弹窗（补差 / 冲差；都必须审核留痕） */
  function openAction(id, act) {
    const isPickup = act === 'pickup';
    dlg = { mode: 'action', id, act };
    openDetailModal(isPickup ? '补差（计入下次对账）' : '冲差（不再参与对账）', `
      <p style="margin:0 0 10px">${isPickup
        ? '总部<b style="color:#7a4fd0">认这笔价</b>：差异额计入下次对账（应付增加项），结算后转终态。默认同步上调 L1（chain.variance.pickup_raise_l1），避免同一差异反复生成。'
        : '总部<b style="color:#1e8e4e">不认这笔价</b>：审核落库「进货价差」，永不再参与对账，供应商收不到这笔差额。<b style="color:#c0392b">审核理由必填</b>。'}</p>
      <div class="fgroup"><label>审核备注${isPickup ? '（选填）' : '（必填）'}</label>
        <textarea id="htActRemark" rows="2" style="width:100%"></textarea></div>
      ${isPickup ? '' : `
      <div class="fgroup"><label>责任方（可选，仅考核用）</label>
        <select id="htActResp" style="width:100%">
          <option value="">不指定</option><option value="store">门店</option>
          <option value="hq">总部</option><option value="supplier">供应商</option>
        </select></div>`}
      <div style="text-align:right;margin-top:10px">
        <button class="btn" id="htActOk">确认${isPickup ? '补差' : '冲差'}</button>
      </div>
    `);
    view.querySelector('#htActOk').onclick = async () => {
      const remark = view.querySelector('#htActRemark').value.trim();
      const responsibility = view.querySelector('#htActResp')?.value ?? '';
      if (!isPickup && !remark) { toast('冲差必须填写审核理由', 'err'); return; }
      try {
        await must(post(`/hq/variances/${id}/action`, { action: act, auditRemark: remark, responsibility }));
        toast(isPickup ? '已补差，待下期对账单结转' : '已冲差落库', 'ok');
        load();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  bindSeg(view.querySelector('#htSeg'), v => { tab = v; load(); });
  await load();
}
