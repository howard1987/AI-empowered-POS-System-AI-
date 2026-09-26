/**
 * V5.0.0 连锁改造 · 批次6 · 「门店报表」页（M6-3，方案 §6.4）
 *
 * 总部专有报表聚合视图（§5.3.2）：门店日报 / 排行(迷你条形+涨跌色) / 对比(环比同比)
 *   / 库存汇总 / 调拨在途 / 退货双维度(R9 两口径+流向矩阵) / 门店往来 / 进价偏离 / 会员跨店 / 同步健康
 * 权限：hq.report.allstore（服务端校验）；红涨绿跌（老板约定）。
 */
import { get, post, must, esc, dt, money, toast } from '../api.js';
import { segHtml, bindSeg, noResult } from '../ui-polish.js';

export async function render(view) {
  const $ = s => view.querySelector(s);
  let tab = 'daily';
  let from = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
  let to = new Date().toISOString().slice(0, 10);
  let cache = {};

  view.innerHTML = `
    <style>
      #hrHost table td,#hrHost table th{text-align:center}
      .hr-l{text-align:left !important}
      .up{color:#c0392b;font-weight:600}      /* 红涨 */
      .down{color:#1e8e4e;font-weight:600}    /* 绿跌 */
      .hr-bar{display:inline-block;height:8px;border-radius:4px;background:linear-gradient(90deg,#d9552e,#e8a13c);vertical-align:middle}
      .hr-matrix td{font-size:12px}
    </style>
    <div class="card" style="display:flex;flex-direction:column;height:calc(100dvh - 214px);min-height:520px">
      <div style="display:flex;align-items:center;gap:12px;padding:10px 18px 0;flex-wrap:wrap">
        <span id="hrSeg"></span>
        <span style="flex:1"></span>
        <input type="date" id="hrFrom" value="${from}" class="inp" style="width:140px">
        <span class="muted">至</span>
        <input type="date" id="hrTo" value="${to}" class="inp" style="width:140px">
        <button class="btn pri" id="hrGo">查询</button>
      </div>
      <div class="doc-tip" id="hrTip"></div>
      <div style="padding:6px 18px 10px;flex:1;min-height:0;overflow:auto" id="hrHost" class="tbl-min pg-host"></div>
      <div class="doc-foot"><span class="muted" id="hrCount"></span></div>
    </div>`;

  const TABS = [
    { k: 'daily',    t: '门店日报',   ep: 'store-daily',      dated: true },
    { k: 'rank',     t: '门店排行',   ep: 'store-rank',       dated: true },
    { k: 'compare',  t: '门店对比',   ep: 'store-compare',    dated: true },
    { k: 'region',   t: '区域汇总',   ep: 'region-summary',   dated: true },
    { k: 'recon',    t: '对账核销',   ep: 'recon-summary',    dated: true },
    { k: 'stock',    t: '库存汇总',   ep: 'stock-summary',    dated: false },
    { k: 'transit',  t: '调拨在途',   ep: 'transfer-intransit', dated: false },
    { k: 'return',   t: '退货双维度', ep: 'return-dual',      dated: true },
    { k: 'ico',      t: '门店往来',   ep: 'intercompany',     dated: false },
    { k: 'cost',     t: '进价偏离',   ep: 'cost-deviation',   dated: true },
    { k: 'member',   t: '会员跨店',   ep: 'member-cross',     dated: true },
    { k: 'sync',     t: '同步健康',   ep: 'sync-health',      dated: false },
  ];
  const TIPS = {
    daily: '各店单量 / 销售额 / 毛利 / 毛利率 / 客单价，首行为全连锁合计。',
    rank: '按本区间销售额排序；条形 = 占第一名的比例；涨跌 = 对上一等长区间。',
    compare: '环比 = 上一等长区间；同比 = 去年同期。红涨绿跌。',
    region: '按门店所属区域汇总（门店档案里维护区域）；未填区域的店归「未分区」。环比红涨绿跌。',
    recon: '会员消费 / 大客户消费按店按期汇总，总部一键核销记账（默认核销毛利，可改金额）；大客户赊账未回款仅作参考不计入核销。',
    stock: '库存金额按在库批次成本计；负数库存（总部仓欠货）标红。',
    transit: '在途 = 已发货未收货；超过 2 天未收标红，请催收货店确认。',
    return: 'R9 双口径：受理店 = 谁退的钱货；原销店 = 冲减谁的销售业绩。两个口径各自自洽。',
    ico: '跨店退货/退厂的店间资金往来台账。pending = 未结清。',
    cost: '待审进价处置单按差异金额降序；L1 变更留痕按来源门店汇总（负 = 下调红线）。',
    member: '跨店消费 / 跨店扣款的会员分布（R4 连锁会员口径）。',
    sync: '各店同步节点健康度：待传笔数、失败、死信、末次推送。',
  };

  function drawSeg() {
    $('#hrSeg').innerHTML = segHtml(TABS.map(t => ({ k: t.k, t: t.t })), tab);
    bindSeg($('#hrSeg'), k => { tab = k; draw(); });
    const t = TABS.find(x => x.k === tab);
    $('#hrFrom').style.display = t?.dated ? '' : 'none';
    $('#hrTo').style.display = t?.dated ? '' : 'none';
    $('#hrTip').innerHTML = TIPS[tab] || '';
  }

  async function load() {
    const t = TABS.find(x => x.k === tab);
    const qs = t?.dated ? `?from=${from}&to=${to}` : '';
    try {
      // P3-2：对账核销走专属端点 /hq/recon/*
      cache[tab] = tab === 'recon'
        ? await must(get(`/hq/recon/summary?from=${from}&to=${to}`))
        : await must(get(`/hq/reports/${t.ep}${qs}`));
    } catch (e) {
      cache[tab] = { error: e?.message || String(e) };
    }
  }

  const gm = v => `¥${Number(v || 0).toFixed(2)}`;
  const pctCls = v => Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : '';
  const bar = (v, max) => max > 0 ? `<span class="hr-bar" style="width:${Math.max(4, Math.round(Number(v) / max * 120))}px"></span>` : '';

  function draw() {
    drawSeg();
    ({ daily: drawDaily, rank: drawRank, compare: drawCompare, region: drawRegion, recon: drawRecon, stock: drawStock, transit: drawTransit,
       return: drawReturn, ico: drawIco, cost: drawCost, member: drawMember, sync: drawSync }[tab] || drawDaily)();
  }

  /* ── P3-2 门店对账核销 ── */
  function drawRecon() {
    const d = cache.recon || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    host.innerHTML = `
      <table><thead><tr>
        <th>门店</th><th>单量</th><th>销售额</th><th>成本</th><th>毛利</th>
        <th>会员消费</th><th>大客户消费</th><th>大客户赊账未回款</th><th>已核销</th><th>操作</th></tr></thead><tbody>
      ${items.map(x => {
        const unsettled = Number(x.profit_total) - Number(x.settled_amount);
        return `<tr>
        <td class="hr-l"><b>${esc(x.store_name || x.store_id)}</b></td><td>${x.order_count}</td>
        <td>${gm(x.sales_total)}</td><td>${gm(x.cost_total)}</td><td>${gm(x.profit_total)}</td>
        <td>${gm(x.member_amount)}</td><td>${gm(x.bc_amount)}</td>
        <td class="${Number(x.bc_credit_unpaid) > 0 ? 'up' : ''}">${gm(x.bc_credit_unpaid)}</td>
        <td>${gm(x.settled_amount)}${unsettled !== 0 ? ` <span class="muted" style="font-size:11px">（未核销 ${gm(unsettled)}）</span>` : ''}</td>
        <td><button class="btn sm pri" data-recon="${x.store_id}" data-profit="${x.profit_total}">✔ 核销</button></td></tr>`;
      }).join('') || '<tr><td colspan="10" class="muted">区间内无消费数据</td></tr>'}
      </tbody></table>
      <div class="sec" style="font-weight:600;padding:12px 0 4px">核销历史（近 100 条）</div>
      <div id="hrReconHis"></div>`;
    host.querySelectorAll('[data-recon]').forEach(b => b.onclick = () => openReconSettle(Number(b.dataset.recon), Number(b.dataset.profit)));
    get(`/hq/recon/settlements`).then(r => {
      const his = (r && r.data ? r.data : r)?.items || [];
      const el = host.querySelector('#hrReconHis');
      if (el) el.innerHTML = his.length ? `<table><thead><tr>
        <th>核销单号</th><th>门店</th><th>区间</th><th>销售额</th><th>毛利</th><th>会员消费</th><th>大客户消费</th><th>核销金额</th><th>经办</th><th>时间</th></tr></thead><tbody>
        ${his.map(h => `<tr>
          <td style="font-family:var(--mono)">${esc(h.settle_no)}</td><td class="hr-l">${esc(h.store_name || '—')}</td>
          <td>${String(h.period_from).slice(0, 10)} ~ ${String(h.period_to).slice(0, 10)}</td>
          <td>${gm(h.sales_total)}</td><td>${gm(h.profit_total)}</td>
          <td>${gm(h.member_amount)}</td><td>${gm(h.bc_amount)}</td>
          <td><b style="color:var(--pri)">${gm(h.settled_amount)}</b></td>
          <td class="muted">${esc(h.settler_name || '—')}</td><td class="muted">${dt(h.settled_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="muted" style="padding:4px 0">暂无核销记录</div>';
    }).catch(() => {});
  }

  function openReconSettle(storeId, profit) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.display = 'flex';
    mask.innerHTML = `<div class="modal" style="width:460px"><h3>✔ 门店对账核销</h3>
      <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
        <div class="fld"><label>核销区间</label><input id="hrcFrom" type="date" value="${from}" style="width:140px"> <span class="muted">至</span> <input id="hrcTo" type="date" value="${to}" style="width:140px"></div>
        <div class="fld"><label class="req">核销金额（默认=期内毛利 ${money(profit)}）</label><input id="hrcAmt" type="number" min="0.01" step="0.01" value="${Number(profit).toFixed(2)}"></div>
        <div class="fld" style="grid-column:1/-1"><label>备注</label><input id="hrcNote" placeholder="如：9 月上半月对账核销"></div>
      </div>
      <div class="doc-tip">💡 核销即记账（可追溯、不可撤销）：生成核销单号，会员/大客户消费与总部的往来按此金额结清。</div>
      <div class="doc-foot"><button class="btn" id="hrcNo">取消</button><span style="flex:1"></span>
        <button class="btn pri" id="hrcGo">✔ 确认核销</button></div></div>`;
    document.body.appendChild(mask);
    mask.querySelector('#hrcNo').onclick = () => mask.remove();
    mask.querySelector('#hrcGo').onclick = async () => {
      const amount = Number(mask.querySelector('#hrcAmt').value);
      if (!(amount > 0)) return toast('核销金额必须大于 0', false);
      await must(post('/hq/recon/settle', {
        storeId, from: mask.querySelector('#hrcFrom').value, to: mask.querySelector('#hrcTo').value,
        amount, note: mask.querySelector('#hrcNote').value.trim() || undefined,
      }), '核销完成');
      mask.remove();
      await load(); draw();
    };
  }

  function drawDaily() {
    const d = cache.daily || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    host.innerHTML = `<table><thead><tr>
      <th>门店</th><th>单量</th><th>销售额</th><th>成本</th><th>毛利</th><th>毛利率</th><th>客单价</th></tr></thead><tbody>
      <tr style="font-weight:600;background:var(--paper2,#faf7ef)">
        <td class="hr-l">合计</td><td>${d.total?.orderCount ?? 0}</td><td>${gm(d.total?.salesTotal)}</td>
        <td>${gm(d.total?.costTotal)}</td><td>${gm(d.total?.profitTotal)}</td>
        <td>${d.total?.margin ?? 0}%</td><td>${d.total?.orderCount > 0 ? gm(d.total.salesTotal / d.total.orderCount) : '—'}</td></tr>
      ${items.map(x => `<tr>
        <td class="hr-l">${esc(x.store_name)}</td><td>${x.orderCount}</td>
        <td>${gm(x.salesTotal)}</td><td>${gm(x.costTotal)}</td><td>${gm(x.profitTotal)}</td>
        <td>${x.margin}%</td><td>${gm(x.avgTicket)}</td></tr>`).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `${from} ~ ${to} · ${items.length} 店`;
  }

  function drawRank() {
    const d = cache.rank || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    const max = Math.max(...items.map(x => Number(x.cur_sales)), 1);
    host.innerHTML = `<table><thead><tr>
      <th>排名</th><th>门店</th><th>销售额</th><th style="width:150px">占比条形</th><th>单量</th><th>环比涨跌</th></tr></thead><tbody>
      ${items.map((x, i) => `<tr>
        <td>${i + 1}</td><td class="hr-l">${esc(x.store_name)}</td>
        <td>${gm(x.cur_sales)}</td><td>${bar(x.cur_sales, max)}</td>
        <td>${x.cur_orders}</td>
        <td class="${pctCls(x.growth)}">${Number(x.growth) > 0 ? '▲' : Number(x.growth) < 0 ? '▼' : '—'} ${Math.abs(Number(x.growth))}%</td></tr>`).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `${from} ~ ${to}`;
  }

  function drawCompare() {
    const d = cache.compare || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    host.innerHTML = `<table><thead><tr>
      <th>门店</th><th>本区间</th><th>环比上一区间</th><th>环比</th><th>去年同期</th><th>同比</th></tr></thead><tbody>
      ${items.map(x => `<tr>
        <td class="hr-l">${esc(x.store_name)}</td><td>${gm(x.cur_sales)}</td>
        <td>${gm(x.prev_sales)}</td><td class="${pctCls(x.mom)}">${Number(x.mom) > 0 ? '▲' : Number(x.mom) < 0 ? '▼' : '—'} ${Math.abs(Number(x.mom))}%</td>
        <td>${gm(x.yoy_sales)}</td><td class="${pctCls(x.yoy)}">${Number(x.yoy) > 0 ? '▲' : Number(x.yoy) < 0 ? '▼' : '—'} ${Math.abs(Number(x.yoy))}%</td></tr>`).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `${from} ~ ${to} · 环比 ${d.prevFrom}~${d.prevTo} · 同比 ${d.yoyFrom}~${d.yoyTo}`;
  }

  function drawRegion() {
    const d = cache.region || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    const max = Math.max(...items.map(x => Number(x.sales_total)), 1);
    host.innerHTML = `<table><thead><tr>
      <th>区域</th><th>门店数</th><th>单量</th><th>销售额</th><th style="width:150px">占比条形</th><th>毛利</th><th>毛利率</th><th>环比涨跌</th></tr></thead><tbody>
      <tr style="font-weight:600;background:var(--paper2,#faf7ef)">
        <td class="hr-l">合计</td><td>${d.total?.store_count ?? 0}</td><td>${d.total?.order_count ?? 0}</td>
        <td>${gm(d.total?.sales_total)}</td><td></td><td>${gm(d.total?.profit_total)}</td>
        <td>${d.total?.margin ?? 0}%</td><td></td></tr>
      ${items.map(x => `<tr>
        <td class="hr-l"><b>${esc(x.region)}</b></td><td>${x.store_count}</td><td>${x.order_count}</td>
        <td>${gm(x.sales_total)}</td><td>${bar(x.sales_total, max)}</td><td>${gm(x.profit_total)}</td>
        <td>${x.margin}%</td>
        <td class="${pctCls(x.growth)}">${Number(x.growth) > 0 ? '▲' : Number(x.growth) < 0 ? '▼' : '—'} ${Math.abs(Number(x.growth))}%</td></tr>`).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `${from} ~ ${to} · ${items.length} 个区域（环比 ${d.prevFrom}~${d.prevTo}）`;
  }

  function drawStock() {
    const d = cache.stock || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    host.innerHTML = `<table><thead><tr>
      <th>门店</th><th>SKU 数</th><th>库存金额</th><th>临期(30天)</th><th>低库存</th><th>负库存</th></tr></thead><tbody>
      ${items.map(x => `<tr>
        <td class="hr-l">${esc(x.store_name)}</td><td>${x.sku_count}</td><td>${gm(x.stock_value)}</td>
        <td class="${Number(x.expiring_count) > 0 ? 'up' : ''}">${x.expiring_count}</td>
        <td class="${Number(x.low_count) > 0 ? 'up' : ''}">${x.low_count}</td>
        <td class="${Number(x.negative_qty) < 0 ? 'up' : ''}">${Number(x.negative_qty) || '—'}</td></tr>`).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `${items.length} 店`;
  }

  function drawTransit() {
    const d = cache.transit || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    if (!items.length) { host.innerHTML = noResult('没有在途调拨单'); $('#hrCount').textContent = ''; return; }
    host.innerHTML = `<table><thead><tr>
      <th>调拨单号</th><th>方向</th><th>类型</th><th>数量</th><th>已收</th><th>货值</th><th>发货时间</th><th>在途天数</th></tr></thead><tbody>
      ${items.map(x => {
        const days = Number(x.transit_days || 0);
        return `<tr>
        <td>${esc(x.transfer_no)}</td>
        <td class="hr-l">${esc(x.from_store_name)} → ${esc(x.to_store_name)}</td>
        <td>${x.biz_scope === 'store2store' ? '店间' : x.biz_scope === 'direct' ? '直送' : '总部配送'}</td>
        <td>${Number(x.total_qty)}</td><td>${Number(x.recv_qty)}</td><td>${gm(x.total_cost)}</td>
        <td>${x.shipped_at ? dt(x.shipped_at) : '—'}</td>
        <td class="${days > 2 ? 'up' : ''}">${days} 天</td></tr>`;
      }).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `在途 ${items.length} 单`;
  }

  function drawReturn() {
    const d = cache.return || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const acc = d.byAccept || [], org = d.byOrigin || [], mx = d.matrix || [];
    host.innerHTML = `
      <div class="sec" style="font-weight:600;padding:4px 0">① 按受理门店（谁受理：钱从这里出、货退到这里）</div>
      <table><thead><tr><th>门店</th><th>退货笔数</th><th>退货金额</th><th>跨店代受理</th><th>跨店金额</th></tr></thead><tbody>
      ${acc.map(x => `<tr><td class="hr-l">${esc(x.store_name)}</td><td>${x.refund_count}</td>
        <td>${gm(x.refund_amount)}</td><td>${x.cross_count}</td><td>${gm(x.cross_amount)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">无数据</td></tr>'}
      </tbody></table>
      <div class="sec" style="font-weight:600;padding:10px 0 4px">② 按原销售门店（谁卖出：业绩冲减归谁 + 退货率）</div>
      <table><thead><tr><th>门店</th><th>冲减笔数</th><th>冲减金额</th><th>本店销售额</th><th>退货率</th></tr></thead><tbody>
      ${org.map(x => `<tr><td class="hr-l">${esc(x.store_name)}</td><td>${x.refund_count}</td>
        <td>${gm(x.refund_amount)}</td><td>${gm(x.sales_amount)}</td>
        <td class="${Number(x.refund_rate) > 10 ? 'up' : ''}">${x.refund_rate}%</td></tr>`).join('') || '<tr><td colspan="5" class="muted">无数据</td></tr>'}
      </tbody></table>
      <div class="sec" style="font-weight:600;padding:10px 0 4px">③ 跨店退货流向矩阵（原销店 → 受理店）</div>
      <table class="hr-matrix"><thead><tr><th>原销店 → 受理店</th><th>笔数</th><th>金额</th></tr></thead><tbody>
      ${mx.map(x => `<tr><td class="hr-l">${esc(x.from_store)} → ${esc(x.to_store)}</td><td>${x.cnt}</td><td>${gm(x.amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">暂无跨店退货</td></tr>'}
      </tbody></table>`;
    $('#hrCount').textContent = `${from} ~ ${to}`;
  }

  function drawIco() {
    const d = cache.ico || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    host.innerHTML = `
      <div style="padding:4px 0 8px">未结清：<b class="${Number(d.summary?.pending_count) > 0 ? 'up' : ''}">${d.summary?.pending_count ?? 0}</b> 笔 / ${gm(d.summary?.pending_amount)}</div>
      <table><thead><tr><th>类型</th><th>单号</th><th>付出方</th><th>受益方</th><th>金额</th><th>状态</th><th>时间</th></tr></thead><tbody>
      ${items.map(x => `<tr>
        <td>${x.biz_type === 'return_cash' ? '退货代付' : x.biz_type === 'supplier_return' ? '退厂货值' : '调拨货款'}</td>
        <td>${esc(x.biz_ref)}</td><td class="hr-l">${esc(x.from_store_name)}</td><td class="hr-l">${esc(x.to_store_name)}</td>
        <td>${gm(x.amount)}</td>
        <td class="${x.status === 'pending' ? 'up' : 'down'}">${x.status === 'pending' ? '未结清' : '已结清'}</td>
        <td>${dt(x.created_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">无往来记录</td></tr>'}
      </tbody></table>`;
    $('#hrCount').textContent = `${items.length} 条`;
  }

  function drawCost() {
    const d = cache.cost || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const pend = d.pending || [], logs = d.logs || [];
    host.innerHTML = `
      <div class="sec" style="font-weight:600;padding:4px 0">待审进价处置单（按差异金额降序）</div>
      <table><thead><tr><th>方向</th><th>门店</th><th>商品</th><th>数量</th><th>提交时L1</th><th>实价</th><th>偏离</th><th>差异金额</th><th>时限</th></tr></thead><tbody>
      ${pend.map(x => `<tr>
        <td class="${x.anomaly === 'high' ? 'up' : 'down'}">${x.anomaly === 'high' ? '买贵' : '买低'}</td>
        <td class="hr-l">${esc(x.store_name || '')}</td><td class="hr-l">${esc(x.product_name || '')}</td>
        <td>${x.qty ?? '—'}</td><td>${gm(x.l1_at_request)}</td><td>${gm(x.actual_cost)}</td>
        <td class="${pctCls(x.gap_pct)}">${x.gap_pct ?? '—'}%</td><td>${gm(x.gap_amount)}</td>
        <td class="${x.due_at && new Date(x.due_at) < new Date() ? 'up' : ''}">${x.due_at ? dt(x.due_at) : '—'}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">没有待审单</td></tr>'}
      </tbody></table>
      <div class="sec" style="font-weight:600;padding:10px 0 4px">L1 变更留痕（按来源门店/来源汇总；负 = 下调红线）</div>
      <table><thead><tr><th>门店</th><th>来源</th><th>次数</th><th>L1 累计变化</th></tr></thead><tbody>
      ${logs.map(x => `<tr><td class="hr-l">${esc(x.store_name || '总部')}</td><td>${esc(x.source)}</td>
        <td>${x.change_count}</td><td class="${Number(x.total_delta) > 0 ? 'up' : 'down'}">${gm(x.total_delta)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">区间内无 L1 变更</td></tr>'}
      </tbody></table>`;
    $('#hrCount').textContent = `${from} ~ ${to}`;
  }

  function drawMember() {
    const d = cache.member || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    if (!items.length) { host.innerHTML = noResult('区间内没有跨店消费会员'); $('#hrCount').textContent = ''; return; }
    host.innerHTML = `<table><thead><tr>
      <th>会员</th><th>卡号</th><th>活跃店数</th><th>累计消费</th><th>跨店扣款笔数</th><th>跨店扣款额</th></tr></thead><tbody>
      ${items.map(x => `<tr>
        <td class="hr-l">${esc(x.name || '—')}</td><td>${esc(x.card_no)}</td>
        <td class="${Number(x.active_stores) > 1 ? 'up' : ''}">${x.active_stores}</td>
        <td>${gm(x.total_spend)}</td><td>${x.cross_flows}</td><td>${gm(x.cross_debit)}</td></tr>`).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `${items.length} 位跨店会员`;
  }

  function drawSync() {
    const d = cache.sync || {};
    const host = $('#hrHost');
    if (d.error) { host.innerHTML = noResult('加载失败', esc(d.error)); return; }
    const items = d.items || [];
    host.innerHTML = `<table><thead><tr>
      <th>门店</th><th>节点</th><th>节点状态</th><th>待传</th><th>失败</th><th>死信</th><th>末次推送</th><th>末次上报</th></tr></thead><tbody>
      ${items.map(x => `<tr>
        <td class="hr-l">${esc(x.store_name)}</td><td>${esc(x.node_code || '—')}</td>
        <td class="${x.node_status === '启用' ? 'down' : 'up'}">${esc(x.node_status || '未注册')}</td>
        <td class="${Number(x.pending_count) > 50 ? 'up' : ''}">${x.pending_count}</td>
        <td class="${Number(x.failed_count) > 0 ? 'up' : ''}">${x.failed_count}</td>
        <td class="${Number(x.dead_count) > 0 ? 'up' : ''}">${x.dead_count}</td>
        <td>${x.last_push ? dt(x.last_push) : '—'}</td><td>${x.last_report ? dt(x.last_report) : '—'}</td></tr>`).join('')}
      </tbody></table>`;
    $('#hrCount').textContent = `${items.length} 店`;
  }

  $('#hrGo').onclick = async () => {
    from = $('#hrFrom').value || from;
    to = $('#hrTo').value || to;
    await load();
    draw();
  };

  await load();
  draw();
}
