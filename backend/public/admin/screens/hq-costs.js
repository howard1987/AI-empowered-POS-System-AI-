/**
 * V5.0.0 连锁改造 · 批次3 · 总部「进价管理」（M3-11 / R8 乙模型 / R15·R16）
 *
 * 四个子页（.seg 切换，沿用后台统一表格规范）：
 *   ① 标准进价 L1 —— 总部维护「价格红线的唯一依据」；带渠道比价与待处置提示
 *   ② 进价渠道榜   —— 谁（供应商）能给到什么价、哪家店、何时 → **谈判原料**
 *   ③ 变更台账     —— L1 每次变更的**证据链**（何时/依据哪张单/从多少改到多少）
 *   ④ 进价异常处置 —— 双向：low 低价待采纳（审核通过才降 L1）/ high 高进价待裁决
 *
 * 🔴 三条铁律（开发/运维必读）：
 *   · L1 只可能被「拉低」——门店永远抬不动它（抬升唯一通道 = 总部采购入库或本页人工设定）
 *   · 只有**已审核入库单**的价才有资格进采纳流程
 *   · `adjust_to_l1` 调的是**记账成本**，绝不改对账金额（对账口径见方案 §5.8）
 *
 * 权限：服务端 hq.cost.manage；菜单 hqOnly（门店账号不可见）。
 */
import { get, post, must, esc, toast, dt, money } from '../api.js';
import { openDetailModal, paginate, bindPager, pagerBar } from '../common-ui.js';
import { segHtml, bindSeg, noResult } from '../ui-polish.js';

const SIZE = 15;
const SRC_TXT = {
  hq_manual: ['总部人工维护', '#7a4fd0'],
  inbound_adopt: ['新品首入自动采纳', '#1e8e4e'],
  inbound_adopt_lower: ['门店低进价采纳', '#1e8e4e'],
  price_change: ['调价单落地', '#3a7bd5'],
  variance_pickup: ['补差联动上调', '#c47f00'],
};
const VERDICT_TXT = {
  accept: '认可实价（L1 不变，差异进对账）',
  adjust_to_l1: '调整记账成本到 L1（只调未销售余量）',
  reject_inbound: '拒绝入库（仅未产生库存的单据可用）',
  return_supplier: '退回供应商',
};

export async function render(view) {
  let tab = 'cost';              // cost | channel | logs | anomaly
  let rows = [], total = 0, page = 1;
  let onlyEmpty = false, kw = '';
  let chanRows = [];             // 渠道榜（有压价空间）
  let logRows = [];
  let diffs = [];
  const sel = new Set();         // L1 页勾选（批量设定）
  let dlgMode = '';              // 弹窗用途：set 单条 / batch 批量 / audit 裁决
  let boxApprove = true;         // 裁决方向（low：true 采纳 / false 驳回）

  view.innerHTML = `
    <style>
      #hcList table td,#hcChan table td,#hcLogs table td,#hcDiff table td{text-align:center}
      #hcList table th,#hcChan table th,#hcLogs table th,#hcDiff table th{text-align:center}
      .hc-l{text-align:left !important}
      .hc-gap{color:#c47f00;font-weight:600}
      .hc-none{color:#8a8577}
      .hc-low{color:#1e8e4e;font-weight:600}
      .hc-high{color:#c0392b;font-weight:600}
      .hc-l1{font-weight:700;color:#7a4fd0}
    </style>

    <div class="card" style="display:flex;flex-direction:column;height:calc(100dvh - 214px);min-height:520px">
      <div class="doc-head" style="grid-template-columns:1.4fr auto;align-items:end">
        <div class="fld"><label>商品</label><input id="hcKw" placeholder="名称 / 条码 / 货号"></div>
        <div class="fld"><label>&nbsp;</label><span style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn pri" id="hcSearch">🔍 查询</button>
          <button class="btn" id="hcRefresh">刷新</button>
        </span></div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:6px 18px 0;flex-wrap:wrap">
        <span id="hcSeg"></span>
        <span id="hcTools" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"></span>
      </div>
      <div class="doc-tip" id="hcTip"></div>
      <div style="padding:4px 18px 4px;flex:1;min-height:0;overflow:auto" id="hcList" class="tbl-min pg-host"></div>
      <div style="padding:4px 18px 4px;flex:1;min-height:0;overflow:auto;display:none" id="hcChan" class="tbl-min pg-host"></div>
      <div style="padding:4px 18px 4px;flex:1;min-height:0;overflow:auto;display:none" id="hcLogs" class="tbl-min pg-host"></div>
      <div style="padding:4px 18px 4px;flex:1;min-height:0;overflow:auto;display:none" id="hcDiff" class="tbl-min pg-host"></div>
      <div class="doc-foot">
        <span class="muted" id="hcCount"></span>
        <span style="display:flex;gap:6px;align-items:center" id="hcPager"></span>
        <span class="sum" id="hcSum"></span>
      </div>
    </div>

    <div class="modal-mask" id="hcModal" style="display:none">
      <div class="modal" style="width:min(560px,94vw)">
        <h3 id="hcMTitle">设定标准进价</h3>
        <div id="hcMBody"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button class="btn" id="hcMCancel">取消</button>
          <button class="btn pri" id="hcMOk">确认</button>
        </div>
      </div>
    </div>`;

  const $ = s => view.querySelector(s);

  const TIPS = {
    cost: '标准进价（L1）是<b>改价红线的唯一进价依据</b>：红线 = max(最低卖价 或 售价×0.6，L1)。'
      + '门店侧改动不了它 —— 门店只能「报实价」，实价更低需总部审核采纳，实价更高只标记不改价。',
    channel: '各渠道报价对比。<b>差值为正的行</b>就是「有供应商能比当前标准进价更低」→ 直接拿去谈价。'
      + '标识 <b>✔采纳</b> 的那笔才是当时定下 L1 的来源。',
    logs: 'L1 每次变更都留痕（append-only）：半年后拿着历史低价去谈判，必须能说清它<b>从哪来、依据哪张单</b>。',
    anomaly: '双向处置：<b class="hc-low">低价</b>（实价 &lt; L1）需总部审核，通过才降 L1；'
      + '<b class="hc-high">高价</b>（实价 &gt; L1）L1 不动，总部四选一裁决。<b>不阻断收货</b> —— 货到门口拒不了物流。',
  };

  function drawSeg() {
    $('#hcSeg').innerHTML = segHtml([
      { k: 'cost', t: '标准进价 L1' },
      { k: 'channel', t: '进价渠道榜' },
      { k: 'logs', t: '变更台账' },
      { k: 'anomaly', t: '进价异常处置' },
    ], tab);
    bindSeg($('#hcSeg'), k => { tab = k; showTab(); });
  }

  function showTab() {
    drawSeg();
    $('#hcList').style.display = tab === 'cost' ? '' : 'none';
    $('#hcChan').style.display = tab === 'channel' ? '' : 'none';
    $('#hcLogs').style.display = tab === 'logs' ? '' : 'none';
    $('#hcDiff').style.display = tab === 'anomaly' ? '' : 'none';
    $('#hcKw').parentElement.style.display = tab === 'cost' ? '' : 'none';
    $('#hcTip').innerHTML = TIPS[tab] || '';
    $('#hcTools').innerHTML = tab === 'cost'
      ? `<label class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px">
           <input type="checkbox" id="hcOnlyEmpty" ${onlyEmpty ? 'checked' : ''}> 仅看未维护</label>
         <button class="btn" id="hcBatch" disabled>⚙️ 批量设定 (<b id="hcSelN">0</b>)</button>`
      : tab === 'anomaly'
        ? `<button class="btn" id="hcDiffPending">仅看待处理</button>`
        : '';
    if (tab === 'cost') {
      $('#hcOnlyEmpty').onchange = e => { onlyEmpty = e.target.checked; page = 1; loadCost(); };
      $('#hcBatch').onclick = () => openBatch();
    }
    if (tab === 'anomaly') $('#hcDiffPending').onclick = () => loadDiff();
    if (tab === 'channel' && !chanRows.length) loadChan();
    if (tab === 'logs' && !logRows.length) loadLogs();
    if (tab === 'anomaly' && !diffs.length) loadDiff();
  }

  // ── ① 标准进价 L1 ──────────────────────────────────────────────
  async function loadCost() {
    const p = new URLSearchParams({ page: String(page), size: String(SIZE) });
    if (kw) p.set('keyword', kw);
    if (onlyEmpty) p.set('onlyEmpty', '1');
    try {
      const r = await must(get('/hq/costs?' + p.toString()));
      rows = r.items || []; total = Number(r.total || 0);
    } catch { rows = []; total = 0; }
    sel.clear();
    drawCost();
  }

  function drawCost() {
    const host = $('#hcList');
    if (!rows.length) {
      host.innerHTML = noResult('没有符合条件的商品', onlyEmpty ? '当前库内商品都已有标准进价' : '');
      $('#hcPager').innerHTML = ''; $('#hcCount').textContent = ''; $('#hcSum').innerHTML = '';
      return;
    }
    const pendingAll = rows.reduce((n, r) => n + Number(r.pending_diffs || 0), 0);
    const missing = rows.filter(r => r.standard_cost === null || r.standard_cost === undefined).length;
    host.innerHTML = `<table><thead><tr>
      <th style="width:36px"><input type="checkbox" id="hcAll"></th>
      <th style="width:88px">条码</th><th>商品名称</th><th style="width:52px">单位</th>
      <th style="width:72px">售价</th><th style="width:78px">最低卖价</th>
      <th style="width:86px">标准进价 L1</th><th style="width:80px">渠道最低</th>
      <th style="width:74px">报价数</th><th style="width:66px">待处置</th>
      <th style="width:150px">操作</th></tr></thead>
    <tbody>${paginate(rows, 1, SIZE).slice.map(r => {
      const l1 = r.standard_cost === null || r.standard_cost === undefined ? null : Number(r.standard_cost);
      const cmin = r.channel_min === null || r.channel_min === undefined ? null : Number(r.channel_min);
      const gap = l1 !== null && cmin !== null ? l1 - cmin : null;
      return `<tr data-id="${r.id}">
      <td><input type="checkbox" class="hc-ck" data-id="${r.id}"></td>
      <td class="mono">${esc(r.barcode || '—')}</td>
      <td class="hc-l" style="font-weight:600">${esc(r.name || '')}
        ${r.spec ? `<span class="muted" style="font-size:11px">${esc(r.spec)}</span>` : ''}</td>
      <td class="muted">${esc(r.base_unit || '')}</td>
      <td class="num">${money(r.sell_price)}</td>
      <td class="num muted">${r.min_price ? money(r.min_price) : '<span class="hc-none">按6折</span>'}</td>
      <td class="num">${l1 === null ? '<span class="hc-none">未维护</span>' : `<span class="hc-l1">${money(l1)}</span>`}</td>
      <td class="num ${gap !== null && gap > 0 ? 'hc-gap' : 'muted'}">${cmin === null ? '—' : money(cmin)}</td>
      <td class="num muted">${Number(r.channel_suppliers || 0)} 家</td>
      <td class="num">${Number(r.pending_diffs || 0) > 0 ? `<span class="hc-high">${Number(r.pending_diffs)}</span>` : '0'}</td>
      <td style="white-space:nowrap">
        <button class="btn sm pri" data-set="${r.id}">${l1 === null ? '设定' : '调整'}</button>
        <button class="btn sm" data-chan="${r.id}">渠道</button>
        <button class="btn sm" data-log="${r.id}">台账</button>
      </td></tr>`;
    }).join('')}</tbody></table>`;

    $('#hcCount').textContent = `共 ${total} 个商品`;
    $('#hcSum').innerHTML = `本页未维护 <b>${missing}</b> · 待处置 <b>${pendingAll}</b>`;
    $('#hcPager').innerHTML = pagerBar({ page, pages: Math.max(1, Math.ceil(total / SIZE)), total, size: SIZE, unit: '个' });
    bindPager($('#hcPager'), p => { page = p; loadCost(); });

    const syncSel = () => {
      const n = sel.size;
      $('#hcSelN').textContent = String(n);
      $('#hcBatch').disabled = !n;
    };
    const all = $('#hcAll');
    if (all) all.onchange = e => {
      host.querySelectorAll('.hc-ck').forEach(ck => {
        ck.checked = e.target.checked;
        if (e.target.checked) sel.add(Number(ck.dataset.id)); else sel.delete(Number(ck.dataset.id));
      });
      syncSel();
    };
    host.querySelectorAll('.hc-ck').forEach(ck => ck.onchange = () => {
      const id = Number(ck.dataset.id);
      if (ck.checked) sel.add(id); else sel.delete(id);
      syncSel();
    });
    syncSel();

    host.querySelectorAll('[data-set]').forEach(b => b.onclick = () => openSet(Number(b.dataset.set)));
    host.querySelectorAll('[data-chan]').forEach(b => b.onclick = async () => {
      tab = 'channel'; showTab(); await loadChan(Number(b.dataset.chan));
    });
    host.querySelectorAll('[data-log]').forEach(b => b.onclick = async () => {
      tab = 'logs'; showTab(); await loadLogs(Number(b.dataset.log));
    });
  }

  // 单条设定 / 调整
  function openSet(pid) {
    const r = rows.find(x => Number(x.id) === pid);
    if (!r) return;
    const l1 = r.standard_cost === null || r.standard_cost === undefined ? null : Number(r.standard_cost);
    $('#hcMTitle').textContent = `💰 标准进价 · ${r.name}`;
    $('#hcMBody').innerHTML = `
      <div class="muted" style="font-size:12.5px;line-height:1.9;margin-bottom:8px">
        售价 ${money(r.sell_price)} · 最低卖价 ${r.min_price ? money(r.min_price) : '（按售价6折）'} ·
        当前 L1 ${l1 === null ? '<b class="hc-none">未维护</b>' : `<b class="hc-l1">${money(l1)}</b>`}
      </div>
      <div class="fld"><label>新标准进价（元）<span style="color:#c0392b">*</span></label>
        <input id="hcCost" type="number" step="0.0001" min="0" value="${l1 === null ? '' : l1}" placeholder="留空并确认 = 清除 L1"></div>
      <div class="fld" style="margin-top:8px"><label>变更原因</label>
        <input id="hcReason" maxlength="120" placeholder="如：供应商调价通知 / 季度框架价重签"></div>
      <div class="doc-tip" style="margin-top:12px">
        <b>⚠️ 影响</b>：L1 是<b>全连锁改价红线的进价兜底</b>。下调会让门店可以卖得更便宜（可能亏本卖），
        上调会收紧门店的调价空间。每次变更都会写入台账（可追溯）。
      </div>`;
    $('#hcModal').style.display = '';
    $('#hcModal').dataset.pid = String(pid);
    $('#hcMOk').textContent = '确认';
    dlgMode = 'set';
  }

  // 批量设定
  function openBatch() {
    const ids = [...sel];
    if (!ids.length) return toast('请先勾选商品');
    $('#hcMTitle').textContent = `⚙️ 批量设定标准进价（已选 ${ids.length} 个）`;
    $('#hcMBody').innerHTML = `
      <div class="fld"><label>设定方式</label><select id="hcMode">
        <option value="set">统一赋值为指定进价</option>
        <option value="percent">按现有 L1 比例调整（%）</option></select></div>
      <div class="fld" style="margin-top:8px"><label>数值</label>
        <input id="hcVal" type="number" step="0.01" placeholder="方式一：进价金额；方式二：百分比（如 -5 表示降 5%）"></div>
      <div class="fld" style="margin-top:8px"><label>变更原因</label>
        <input id="hcReason" maxlength="120" placeholder="如：2026 年度框架价整体下调"></div>
      <div class="doc-tip" style="margin-top:12px">
        ⚠️ 批量操作会影响 <b>${ids.length}</b> 个商品的改价红线，且全部写入台账。若部分商品无需改动，请减少勾选。
      </div>`;
    $('#hcModal').style.display = '';
    $('#hcModal').dataset.pid = '';
    $('#hcMOk').textContent = '确认';
    dlgMode = 'batch';
  }

  $('#hcMCancel').onclick = () => { $('#hcModal').style.display = 'none'; dlgMode = ''; };

  /** 弹窗唯一确认入口：按 dlgMode 分派（设定 / 批量 / 裁决） */
  $('#hcMOk').onclick = async () => {
    const box = $('#hcModal');
    const reason = $('#hcReason')?.value.trim() || $('#hcAuditRemark')?.value.trim() || undefined;
    try {
      if (dlgMode === 'set') {
        const pid = Number(box.dataset.pid || 0);
        const raw = $('#hcCost').value.trim();
        const r = await must(post('/hq/costs', { productId: pid, cost: raw === '' ? null : Number(raw), reason }));
        toast(`✅ 标准进价已更新：${r.oldCost === null ? '未维护' : money(r.oldCost)} → ${r.newCost === null ? '已清除' : money(r.newCost)}`);
        box.style.display = 'none';
        await loadCost();
        return;
      }
      if (dlgMode === 'batch') {
        const mode = $('#hcMode').value;
        const v = Number($('#hcVal').value);
        if (!Number.isFinite(v)) { toast('请填写数值', false); return; }
        const body = { productIds: [...sel], mode, reason };
        if (mode === 'set') body.cost = v; else body.percent = v;
        const r = await must(post('/hq/costs/batch', body));
        toast(`✅ 批量完成：影响 ${r.changed} / ${r.total} 个商品`);
        box.style.display = 'none';
        sel.clear();
        await loadCost();
        return;
      }
      if (dlgMode === 'audit') {
        const id = Number(box.dataset.id || 0);
        const kind = box.dataset.auditKind || 'low';
        if (kind === 'low') {
          // 「采纳」/「驳回」两个入口 → 方向由 openAudit 的 approve 参数决定
          const approve = boxApprove;
          await must(post(`/cost-diffs/${id}/audit`, { approve, remark: reason }));
          toast(approve ? '✅ 已采纳：标准进价已下调' : '已驳回该采纳申请');
        } else {
          const verdict = $('#hcVerdict').value;
          await must(post(`/cost-diffs/${id}/audit`, { verdict, remark: reason }));
          toast(`✅ 裁决已提交：${VERDICT_TXT[verdict] || verdict}`);
        }
        box.style.display = 'none';
        diffs = [];
        await loadDiff();
        return;
      }
    } catch { /* must 已提示 */ } finally {
      dlgMode = '';
    }
  };

  // ── ② 进价渠道榜 ──────────────────────────────────────────────
  async function loadChan(productId) {
    const qs = productId ? `?productId=${productId}&limit=200` : '';
    try {
      const r = await must(get('/hq/costs/channels' + qs));
      chanRows = r.items || [];
    } catch { chanRows = []; }
    drawChan(!!productId);
  }

  function drawChan(single) {
    const host = $('#hcChan');
    if (!chanRows.length) {
      host.innerHTML = noResult('暂无渠道报价记录',
        '渠道报价来自入库单与总部维护；门店入库后这里就能看到「谁给的什么价」。');
      $('#hcCount').textContent = ''; $('#hcSum').innerHTML = ''; $('#hcPager').innerHTML = '';
      return;
    }
    if (single) {
      // 单个商品的各渠道明细
      const nm = chanRows[0];
      host.innerHTML = `<table><thead><tr>
        <th style="width:150px">供应商</th><th style="width:120px">门店</th><th style="width:96px">报价</th>
        <th style="width:84px">来源</th><th style="width:118px">单据号</th>
        <th style="width:74px">采纳</th><th style="width:120px">时间</th></tr></thead>
      <tbody>${chanRows.map(c => `<tr>
        <td>${esc(c.supplier_name || '—')}</td>
        <td>${esc(c.store_name || '总部')}</td>
        <td class="num hc-l1">${money(c.price)}</td>
        <td class="muted">${esc(c.source_type || '')}</td>
        <td class="mono muted">${esc(c.doc_no || '—')}</td>
        <td>${c.adopted_l1 ? '<span class="hc-low">✔ 采纳</span>' : '<span class="hc-none">参考</span>'}</td>
        <td class="muted">${c.created_at ? dt(c.created_at).slice(5, 16) : '—'}</td></tr>`).join('')}</tbody></table>`;
      const min = Math.min(...chanRows.map(c => Number(c.price)));
      $('#hcCount').textContent = `本商品 ${chanRows.length} 条报价`;
      $('#hcSum').innerHTML = `最低渠道价 <b class="hc-low">${money(min)}</b>`;
      $('#hcPager').innerHTML = '';
      return;
    }
    // 总览：有压价空间的商品
    host.innerHTML = `<table><thead><tr>
      <th style="width:88px">条码</th><th>商品名称</th><th style="width:52px">单位</th>
      <th style="width:92px">当前 L1</th><th style="width:92px">渠道最低</th>
      <th style="width:92px">渠道最高</th><th style="width:74px">供应商</th>
      <th style="width:96px">可谈空间</th><th style="width:96px">操作</th></tr></thead>
    <tbody>${chanRows.map(c => `<tr>
      <td class="mono">—</td>
      <td class="hc-l" style="font-weight:600">${esc(c.name || '')}</td>
      <td class="muted">${esc(c.base_unit || '')}</td>
      <td class="num hc-l1">${money(c.standard_cost)}</td>
      <td class="num hc-low">${money(c.channel_min)}</td>
      <td class="num muted">${money(c.channel_max)}</td>
      <td class="num muted">${Number(c.suppliers || 0)} 家</td>
      <td class="num hc-gap">${money(c.gap)}</td>
      <td><button class="btn sm" data-pid="${c.product_id}">看明细</button></td></tr>`).join('')}</tbody></table>`;
    $('#hcCount').textContent = `共 ${chanRows.length} 个商品存在压价空间`;
    const sumGap = chanRows.reduce((n, c) => n + Number(c.gap || 0), 0);
    $('#hcSum').innerHTML = `合计可谈空间 <b class="hc-gap">${money(sumGap)}</b>`;
    $('#hcPager').innerHTML = '';
    host.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => loadChan(Number(b.dataset.pid)));
  }

  // ── ③ 变更台账 ──────────────────────────────────────────────
  async function loadLogs(productId) {
    const p = new URLSearchParams({ size: '50' });
    if (productId) p.set('productId', String(productId));
    try {
      const r = await must(get('/hq/costs/logs?' + p.toString()));
      logRows = r.items || [];
    } catch { logRows = []; }
    const host = $('#hcLogs');
    if (!logRows.length) {
      host.innerHTML = noResult('暂无进价变更记录', 'L1 每次变更（总部设定 / 入库采纳 / 补差联动）都会在这里留痕。');
      $('#hcCount').textContent = ''; $('#hcSum').innerHTML = ''; $('#hcPager').innerHTML = '';
      return;
    }
    host.innerHTML = `<table><thead><tr>
      <th style="width:120px">时间</th><th>商品</th>
      <th style="width:88px">原 L1</th><th style="width:88px">新 L1</th><th style="width:82px">变化</th>
      <th style="width:130px">来源</th><th style="width:130px">依据单据</th>
      <th style="width:100px">门店</th><th style="width:90px">操作人</th></tr></thead>
    <tbody>${logRows.map(l => {
      const d = l.delta === null || l.delta === undefined ? null : Number(l.delta);
      const [txt, color] = SRC_TXT[l.source] || [l.source || '—', '#8a8577'];
      return `<tr>
      <td class="muted">${l.created_at ? dt(l.created_at).slice(5, 16) : '—'}</td>
      <td class="hc-l">${esc(l.product_name || '')}</td>
      <td class="num muted">${l.old_cost === null ? '<span class="hc-none">未维护</span>' : money(l.old_cost)}</td>
      <td class="num hc-l1">${money(l.new_cost)}</td>
      <td class="num ${d === null ? 'muted' : d > 0 ? 'hc-high' : 'hc-low'}">${d === null ? '—' : (d > 0 ? '+' : '') + money(d)}</td>
      <td style="color:${color}">${esc(txt)}</td>
      <td class="mono muted">${esc(l.ref_doc_no || '—')}</td>
      <td>${esc(l.store_name || '总部')}</td>
      <td class="muted">${esc(l.operator_name || '—')}</td></tr>`;
    }).join('')}</tbody></table>`;
    $('#hcCount').textContent = `最近 ${logRows.length} 条变更`;
    $('#hcSum').innerHTML = '';
    $('#hcPager').innerHTML = '';
  }

  // ── ④ 进价异常处置 ──────────────────────────────────────────────
  async function loadDiff() {
    try {
      const r = await must(get('/cost-diffs?status=pending&size=100'));
      diffs = r.items || [];
    } catch { diffs = []; }
    const host = $('#hcDiff');
    if (!diffs.length) {
      host.innerHTML = noResult('没有待处理的进价异常', '门店入库实价与总部标准进价差异超过阈值时才会出现在这里。');
      $('#hcCount').textContent = ''; $('#hcSum').innerHTML = ''; $('#hcPager').innerHTML = '';
      return;
    }
    host.innerHTML = `<table><thead><tr>
      <th style="width:64px">类型</th><th style="width:110px">门店</th><th>商品</th>
      <th style="width:64px">数量</th><th style="width:88px">L1</th><th style="width:88px">实价</th>
      <th style="width:92px">差异/件</th><th style="width:96px">差异金额</th>
      <th style="width:118px">单据号</th><th style="width:120px">提交时间</th>
      <th style="width:190px">裁决</th></tr></thead>
    <tbody>${diffs.map(d => {
      const l1 = d.l1_at_request === null || d.l1_at_request === undefined ? null : Number(d.l1_at_request);
      const act = Number(d.actual_cost || 0);
      const per = l1 === null ? null : Number((act - l1).toFixed(4));
      const low = d.anomaly === 'low';
      return `<tr data-id="${d.id}">
      <td><span class="${low ? 'hc-low' : 'hc-high'}">${low ? '低价' : '高价'}</span></td>
      <td>${esc(d.store_name || '—')}</td>
      <td class="hc-l">${esc(d.product_name || '')}
        <span class="muted" style="font-size:11px">${esc(d.barcode || '')}</span></td>
      <td class="num">${d.qty === null || d.qty === undefined ? '—' : Number(d.qty)}</td>
      <td class="num muted">${l1 === null ? '<span class="hc-none">未维护</span>' : money(l1)}</td>
      <td class="num hc-l1">${money(act)}</td>
      <td class="num ${per !== null && per > 0 ? 'hc-high' : 'hc-low'}">${per === null ? '新品' : (per > 0 ? '+' : '') + money(per)}</td>
      <td class="num ${Number(d.gap_amount || 0) > 0 ? 'hc-high' : 'hc-low'}">${d.gap_amount === null ? '—' : money(d.gap_amount)}</td>
      <td class="mono muted">${esc(d.doc_no || '—')}</td>
      <td class="muted">${d.created_at ? dt(d.created_at).slice(5, 16) : '—'}</td>
      <td style="white-space:nowrap">
        ${low
          ? `<button class="btn sm pri" data-adopt="${d.id}">采纳（降 L1）</button>
             <button class="btn sm" data-reject="${d.id}">驳回</button>`
          : `<button class="btn sm" data-verdict="${d.id}">裁决…</button>`}
      </td></tr>`;
    }).join('')}</tbody></table>`;

    const lows = diffs.filter(d => d.anomaly === 'low').length;
    $('#hcCount').textContent = `待处理 ${diffs.length} 条`;
    $('#hcSum').innerHTML = `低价待采纳 <b class="hc-low">${lows}</b> · 高进价待裁决 <b class="hc-high">${diffs.length - lows}</b>`;
    $('#hcPager').innerHTML = '';

    host.querySelectorAll('[data-adopt]').forEach(b => b.onclick = () => openAudit(Number(b.dataset.adopt), 'low', true));
    host.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => openAudit(Number(b.dataset.reject), 'low', false));
    host.querySelectorAll('[data-verdict]').forEach(b => b.onclick = () => openAudit(Number(b.dataset.verdict), 'high', true));
  }

  function openAudit(id, kind, approve = true) {
    const d = diffs.find(x => Number(x.id) === id);
    if (!d) return;
    const l1 = d.l1_at_request === null || d.l1_at_request === undefined ? null : Number(d.l1_at_request);
    const act = Number(d.actual_cost || 0);
    const isLow = kind === 'low';
    $('#hcMTitle').textContent = `⚖️ ${isLow ? (approve ? '低进价采纳' : '驳回低进价申请') : '高进价裁决'} · ${d.product_name || ''}`;
    $('#hcMBody').innerHTML = `
      <div class="muted" style="font-size:12.5px;line-height:1.9;margin-bottom:10px">
        门店 <b>${esc(d.store_name || '')}</b> · 供应商 ${esc(d.supplier_name || '—')} ·
        单据 <span class="mono">${esc(d.doc_no || '—')}</span><br>
        L1 <b class="hc-l1">${l1 === null ? '未维护' : money(l1)}</b> ·
        实价 <b>${money(act)}</b> · 差异 <b class="${isLow ? 'hc-low' : 'hc-high'}">${l1 === null ? '新品首进' : money(Number((act - l1).toFixed(4)))}/件</b>
      </div>
      ${isLow ? `
        <div class="doc-tip">
          ${approve
            ? `<b>采纳</b> = 把 L1 下调到本次实价（全连锁改价红线随之放宽）。<br>
               ⚠️ 请确认这个价<b>可复现</b>（不是一次性清仓价、不是单店特权价），否则红线会被长期压低。`
            : `<b>驳回</b> = L1 保持不变。门店该批次成本仍按实价记账（毛利真实），
               只是「进价兜底红线」继续按总部标准价执行。`}
        </div>`
      : `
        <div class="fld"><label>裁决方式</label><select id="hcVerdict">
          ${['accept', 'adjust_to_l1', 'reject_inbound', 'return_supplier']
            .map(v => `<option value="${v}">${VERDICT_TXT[v]}</option>`).join('')}
        </select></div>
        <div class="doc-tip" style="margin-top:10px">
          <b>不阻断收货</b>：货已到店，裁决只决定「账怎么记」。<br>
          · <b>认可实价</b>：L1 不变，差异进对账差异单（按 L1 结算，差额另计）；<br>
          · <b>调到 L1</b>：只调<b>未销售余量</b>的记账成本，已销售不追溯；<br>
          · <b>拒绝入库 / 退供</b>：仅对**未产生库存**的单据可用（已入账的货不能凭空消失）。
        </div>`}
      <div class="fld" style="margin-top:10px"><label>裁决说明${isLow ? '（驳回时建议填写）' : ''}</label>
        <input id="hcAuditRemark" maxlength="120" placeholder="如：一次性清仓价，不可复现"></div>`;
    $('#hcModal').style.display = '';
    $('#hcModal').dataset.id = String(id);
    $('#hcModal').dataset.auditKind = kind;
    boxApprove = approve;                 // 「采纳」/「驳回」入口不同，裁决方向由按钮决定
    $('#hcMOk').textContent = isLow ? (approve ? '确认采纳（降 L1）' : '确认驳回') : '提交裁决';
    dlgMode = 'audit';
  }

  // ── 搜索 / 刷新 ──────────────────────────────────────────────
  $('#hcSearch').onclick = () => {
    if (tab === 'cost') { kw = $('#hcKw').value.trim(); page = 1; loadCost(); }
    else if (tab === 'logs') loadLogs();
    else if (tab === 'channel') loadChan();
    else loadDiff();
  };
  $('#hcKw').onkeydown = e => { if (e.key === 'Enter') $('#hcSearch').onclick(); };
  $('#hcRefresh').onclick = () => {
    chanRows = []; logRows = []; diffs = [];
    if (tab === 'cost') loadCost();
    else if (tab === 'channel') loadChan();
    else if (tab === 'logs') loadLogs();
    else loadDiff();
  };

  drawSeg();
  showTab();
  await loadCost();
}
