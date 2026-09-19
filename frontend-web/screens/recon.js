import { API, get, post, put, must, money, esc, dt, toast } from '../api.js';
import { confirmBox } from '../ui.js';
import { paginate, bindPager } from '../common-ui.js';
import { renderConsign } from './consign.js';
import { anchorNav } from '../ui-polish.js';   // V4.26.3 长页面锚点导航

/** 对账与结算（合并联营对账 · 图一高保真版式）：
 *  页头选供应商自动判别 购销/联营 → 加载对应视图；
 *  购销：勾选单据（未审核灰显·去审核）→ 生成对账单 → 现场确认（签字板）→ A5 结算单实时预览；
 *  联营：renderConsign 子视图（看板 / 预览 / LC 对账单 / 签字模板）。 */
export async function render(view) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const todayMMDD = today.slice(5).replace('-', '-');
  view.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--ink-3);margin-bottom:10px">
      <b style="color:var(--ink)">对账与结算</b>
      <span style="opacity:.55">/</span><span>先审核 · 再对账 · 点单号跳单据详情 · 现场确认签字 + A5 结算单</span>
    </div>

    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <span style="font-weight:700;font-size:14.5px">📑 对账与结算</span>
      <span class="muted">输入供应商名称自动判别 <b>购销 / 联营</b>，加载对应对账流程</span>
      <span style="margin-left:auto;display:flex;gap:8px;align-items:center;position:relative">
        <input id="cSup" placeholder="输入供应商名称快速匹配" style="min-width:230px" autocomplete="off">
        <span class="pill g" id="modePill">📑 购销模式</span>
      </span>
    </div>

    <div id="modeBuy">
      <div id="modeBuyOnly">
      <!-- 图一：主操作区（勾选对账 + 现场确认 + A5） -->
      <div class="card" style="margin-bottom:14px;padding-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:14px 18px 0">
          <h3 style="flex:1;margin:0" id="rcTitle">对账单 — · — · —</h3>
          <span class="pill n" id="rcStatus">未生成</span>
        </div>
        <div class="bar" style="margin:12px 18px 2px">
          <input id="rcKw" placeholder="🔍 对账单列表搜索：对账单号 / 供应商 / 期次（即输即查）" style="flex:1;min-width:230px;font-weight:400;color:var(--ink-3)">
          <input id="cFrom" type="date" style="width:138px"><span style="color:var(--ink-3)">~</span><input id="cTo" type="date" style="width:138px">
          <button class="btn pri" id="cPrev">🔍 加载待对账单据</button>
          <span class="pill g" style="cursor:pointer" data-p="cur">本期</span>
          <span class="pill" style="cursor:pointer" data-p="prev">上期</span>
          <span class="pill" style="cursor:pointer" data-p="custom">自定义区间</span>
          <span class="pill o" style="cursor:pointer" data-f="待供应商确认">待确认</span>
          <span class="pill g" style="cursor:pointer" data-f="已确认">已确认</span>
          <span class="pill" style="cursor:pointer" data-f="已结算">已结算</span>
        </div>
        <div class="doc-tip">⭐ <b style="color:var(--warn)">对账前置：纳入对账的入库/退货/费用单必须先完成审核</b>——未审核单据灰显不可勾选；<b style="color:var(--info)">点原始单号弹窗查看明细</b>（未审核单据可在弹窗中编辑并直接审核）；勾选单据后点「已现场确认」会<b>自动生成对账单并弹出签字确认</b>，一步完成</div>
        <!-- V4.26.4 .pg-host：待对账单据多时容器内滚，分页条固定底部，操作栏始终可见 -->
        <div class="tbl-min pg-host" style="padding:0 18px" id="cPrevBox"><div class="empty">选择供应商与区间后加载（未审核单据灰显 · 不参与应付）</div></div>
        <div class="doc-foot">
          <button class="btn pri" id="rcSign">✍️ 已现场确认（调用签字）</button>
          <button class="btn" id="rcHold">挂起争议单</button>
          <span class="sum" style="margin-left:auto">本期应付 <b style="font-size:17px;color:var(--pri)" id="rcPay">¥0.00</b></span>
        </div>
      </div>

      <!-- 图一 · 版式 3：对账单列表 -->
      <div class="card" style="margin-bottom:14px;padding-bottom:16px">
        <div class="doc-tools">
          <span style="font-weight:700;font-size:14.5px">📑 对账单</span>
          <button class="btn sm" id="rcRefresh">刷新</button>
          <button class="btn sm warn" id="rcVoidBatch">批量删除（作废）</button>
          <span class="muted" style="font-size:11.5px">仅「生成/待供应商确认」可删；删除会回删往来账并释放单据</span>
        </div>
        <div class="tbl-min pg-host" style="padding:10px 18px" id="cList"></div>
      </div>
      </div><!-- /modeBuyOnly -->
    </div><!-- /modeBuy -->

    <!-- V4.14.2：购销/联营共用区（联营模式下同样加载） -->
    <div id="modeCommon">
      <!-- 供应商费用单 -->
      <div class="card" style="margin-bottom:14px;padding-bottom:16px">
        <div class="doc-tools">
          <span style="font-weight:700;font-size:14.5px">🧾 供应商费用单（支持收/付双向）</span>
          <span class="pill o" id="feeStat">录入中</span>
          <span class="muted" style="font-size:11.5px">「供应商应付」=供应商付给店（返利/罚款），对账总金额中扣除（-）；「供应商应收」=店补给供应商，对账总金额中增加（+） · 费用项可直接输入新名称自动建档 · 0 元应付可直结算</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn" id="feeAdd">➕ 添加行</button>
            <button class="btn" id="feeReset">删单重录</button>
            <button class="btn pri" id="feeGo">💾 保存费用单</button>
          </span>
        </div>
        <div class="doc-grid" style="padding:6px 18px 4px">
          <table>
            <thead><tr><th style="width:44px">序号</th><th style="min-width:200px">费用项</th><th>方向</th>
              <th style="width:130px">金额(元)</th><th>行备注</th><th style="width:50px">操作</th></tr></thead>
            <tbody id="feeLines"><tr><td colspan="6" class="empty">点「➕ 添加行」录入费用</td></tr></tbody>
            <tfoot><tr><td colspan="3">合计</td><td class="num" id="feeSumAmt">0.00</td><td colspan="2"></td></tr></tfoot>
          </table>
          <datalist id="feeTypeDl"></datalist>
        </div>
        <div class="tbl-min pg-host" style="padding:0 18px" id="feeList"></div>
      </div>

      <!-- 费用协议 -->
      <div class="card" style="margin-bottom:14px;padding-bottom:16px">
        <h3>费用协议 <span class="api">GET/POST /purchase/fee-agreements · GET /purchase/fee-types</span></h3>
        <div class="bar" style="margin:14px 18px 4px">
          <select id="agType"></select>
          <select id="agNature" title="周期性=按月逐期生成；一次性=只计一期（如开业陈列费、年节进场费）">
            <option value="周期性">周期性（按月逐期）</option>
            <option value="一次性">一次性（只计一期）</option>
          </select>
          <select id="agDir" title="方向：供应商应付=扣减（-） / 供应商应收=增加（+)">
            <option value="">方向·沿用费用项</option>
            <option value="收">供应商应付（-）</option>
            <option value="付">供应商应收（+）</option>
          </select>
          <input id="agAmount" type="number" step="0.01" placeholder="每期金额(元)*" style="width:120px">
          <input id="agPeriods" type="number" min="1" max="120" placeholder="期数(留空=不限)" style="width:120px" title="周期性可限总期数，如签 6 个月则填 6；一次性固定 1 期">
          <input id="agStart" type="date" title="协议起始日*">
          <input id="agEnd" type="date" title="协议结束日(选填)">
          <button class="btn pri" id="agGo">新增协议（对账自动补齐漏记期次）</button>
        </div>
        <div class="tbl-min pg-host" style="padding:8px 18px" id="agList"></div>
      </div>

      <!-- 结算单（购销/联营同名切换，含打印 A5） -->
      <div class="card" style="margin-bottom:14px;padding-bottom:8px">
        <div class="doc-tools">
          <span style="font-weight:700;font-size:14.5px" id="settleTitle">💵 购销结算单</span>
          <button class="btn pri sm" id="qGo">🔍 查询</button>
          <button class="btn sm" id="qRefresh">刷新</button>
          <button class="btn sm" id="rcPrintA5">🖨 打印结算单 A5</button>
        </div>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
          <div class="fld"><label>单据日期</label><input id="qFrom" type="date" value="${monthStart}"><span style="color:var(--ink-3)">~</span><input id="qTo" type="date" value="${today}"></div>
          <div class="fld"><label>审核状态</label><span id="qStat" style="display:flex;gap:2px">
            <button class="btn sm segbtn" data-v="待审核">待审核</button>
            <button class="btn sm segbtn" data-v="已审核">已审核</button>
            <button class="btn sm segbtn on" data-v="">全部</button></span></div>
        </div>
        <div class="tbl-min pg-host" style="padding:10px 18px" id="sList"></div>
        <div class="doc-foot"><span class="muted" id="qCount"></span>
          <span class="sum">结算金额合计：<b id="qSum">0.00</b> 元</span></div>
      </div>

      <!-- 图一 · 版式 2：打印列配置 + A5 实时预览（末位） -->
      <div style="display:grid;grid-template-columns:minmax(240px,340px) 1fr;gap:14px;margin-bottom:14px;align-items:start">
        <div class="card">
          <div style="display:flex;align-items:center;gap:8px;padding:14px 18px 0">
            <h3 style="flex:1;margin:0">打印列配置（用户可勾选）</h3>
            <span class="pill n" id="colCount">默认 8 列</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px 14px;padding:12px 18px 16px" id="colCfg"></div>
        </div>
        <div class="card">
          <div style="display:flex;align-items:center;gap:8px;padding:14px 18px 0">
            <h3 style="flex:1;margin:0">结算单打印预览（A5）</h3>
            <span class="pill n">一式两份</span>
          </div>
          <div style="padding:14px 18px 16px" id="a5Box"><div class="empty">勾选单据后实时预览 A5 结算单</div></div>
        </div>
      </div>

      <!-- 供应商往来账（V4.14.0 A2：移至 A5 结算单预览下方） -->
      <div class="card" style="margin-bottom:14px;padding-bottom:16px">
        <h3>供应商往来账 <span class="api">GET /purchase/ledger?supplierId=</span></h3>
        <div class="tbl-min pg-host" style="padding:8px 18px" id="lList"></div>
      </div>
    </div><!-- /modeCommon -->

    <div id="modeConsign" style="display:none"></div>

    <div class="modal-mask" id="cfmModal" style="display:none">
      <div class="modal">
        <h3>✅ 对账确认 <span class="api" style="float:right">POST /purchase/recon/:id/confirm</span></h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label class="req">确认方式</label>
            <select id="cfmType"><option>现场确认</option><option>单据签字</option><option>口头确认</option></select></div>
          <div class="fld"><label>确认人（供应商业务员）</label><input id="cfmName" placeholder="业务员姓名"></div>
        </div>
        <div class="doc-tip">💡 现场确认建议业务员在下方签字板签字留底（电子签字随单存档，作为对账凭证链）</div>
        <canvas id="cfmPad" width="560" height="170" style="border:1px dashed var(--line);border-radius:8px;touch-action:none;cursor:crosshair;margin:14px 18px 0;width:calc(100% - 36px)"></canvas>
        <div class="bar" style="margin-top:8px">
          <button class="btn sm" id="cfmClear">🧽 清除重签</button>
        </div>
        <div class="doc-foot">
          <button class="btn" id="cfmCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="cfmGo">✔ 确认对账单</button>
        </div>
      </div>
    </div>`;

  let suppliers = [], feeTypes = [], curSup = 0, curRecon = null, reconAll = [];
  let rcPage = 1, stPage = 1, agPage = 1, fePage = 1, lgPage = 1, pvPage = 1;
  const fmt = n => (Number(n) || 0).toFixed(2);
  const d0 = new Date(); d0.setDate(1);
  view.querySelector('#cFrom').value = d0.toISOString().slice(0, 10);
  view.querySelector('#cTo').value = today;
  view.querySelector('#agStart').value = d0.toISOString().slice(0, 10);

  /* ── 打印列配置（图一：默认 8 列，勾选联动 A5 预览） ── */
  const COLS = [
    { k: 'seq', t: '序号' }, { k: 'no', t: '原始单号' }, { k: 'amt', t: '单据金额' },
    { k: 'unpaid', t: '未付单据金额' }, { k: 'round', t: '抹零金额' }, { k: 'rcNo', t: '对账单号' },
    { k: 'date', t: '对账日期' }, { k: 'remark', t: '备注' }, { k: 'detail', t: '商品明细' }, { k: 'op', t: '经办人' },
  ];
  let colOn = new Set();
  try { colOn = new Set(JSON.parse(localStorage.getItem('rc_cols') || 'null') || COLS.slice(0, 8).map(c => c.k)); } catch (e) { /* 默认 8 列 */ }
  function drawColCfg() {
    const box = view.querySelector('#colCfg');
    box.innerHTML = COLS.map(c => `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12.5px;cursor:pointer">
      <input type="checkbox" data-col="${c.k}" ${colOn.has(c.k) ? 'checked' : ''}> ${c.t}</label>`).join('');
    view.querySelector('#colCount').textContent = colOn.size === 8 ? '默认 8 列' : `已选 ${colOn.size} 列`;
    box.querySelectorAll('[data-col]').forEach(chk => chk.onchange = () => {
      chk.checked ? colOn.add(chk.dataset.col) : colOn.delete(chk.dataset.col);
      localStorage.setItem('rc_cols', JSON.stringify([...colOn]));
      drawColCfg(); drawA5();
    });
  }

  /* ── 签字板 ── */
  let cfmReconId = 0, padDirty = false;
  function bindPad() {
    const pad = view.querySelector('#cfmPad');
    const ctx = pad.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    let drawing = false, last = null;
    const pos = e => { const r = pad.getBoundingClientRect();
      return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
    pad.onpointerdown = e => { drawing = true; padDirty = true; last = pos(e); pad.setPointerCapture(e.pointerId); };
    pad.onpointermove = e => { if (!drawing) return; const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; };
    pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
  }
  function clearPad() {
    const pad = view.querySelector('#cfmPad');
    pad.getContext('2d').clearRect(0, 0, pad.width, pad.height);
    padDirty = false;
  }

  /* ── 往来账 ── */
  async function drawLedger(sid) {
    if (!sid) { view.querySelector('#lList').innerHTML = '<div class="empty">页头先选供应商</div>'; return; }
    const rows = await must(get(`/purchase/ledger?supplierId=${sid}`));
    const arr = rows.items || rows || [];
    const pg = paginate(arr, lgPage, 10);
    view.querySelector('#lList').innerHTML = arr.length ? `
      <table><thead><tr><th>日期</th><th>方向</th><th>单据</th><th>业务</th><th class="num">借方</th><th class="num">贷方</th><th class="num">余额</th></tr></thead>
      <tbody>${pg.slice.map(r => `<tr>
        <td>${dt(r.doc_date || r.created_at)}</td>
        <td><span class="tag ${Number(r.debit) > 0 ? 'y' : 'g'}">${Number(r.debit) > 0 ? '借' : '贷'}</span></td>
        <td style="font-family:var(--mono)">${esc(r.biz_no || '')}</td>
        <td class="muted">${esc(({ inbound: '采购入库', return: '采购退货', fee: '供应商费用', settlement: '结算付款', inbound_void: '入库作废' })[r.biz_type] || r.biz_type || '')}</td>
        <td class="num">${Number(r.debit) > 0 ? money(r.debit) : '—'}</td>
        <td class="num">${Number(r.credit) > 0 ? money(r.credit) : '—'}</td>
        <td class="num"><b>${money(r.balance_after)}</b></td>
      </tr>`).join('')}</tbody></table>${pg.bar}` : '<div class="empty">该供应商暂无往来记录</div>';
    bindPager(view.querySelector('#lList'), p => { lgPage = p; drawLedger(sid); });
  }

  /* ── 勾选式对账预览（图一：未审核灰显不可勾选） ── */
  const picked = { inbounds: new Set(), returns: new Set(), fees: new Set() };
  let pv = null;
  const audited = x => (x.status ?? '已审核') === '已审核';
  function pvSum(all = false) {
    if (!pv) return { g: 0, fi: 0, fp: 0, pay: 0 };
    const inb = pv.inbounds.filter(x => audited(x) && (all || picked.inbounds.has(x.id)));
    const ret = pv.returns.filter(x => audited(x) && (all || picked.returns.has(x.id)));
    const fee = pv.fees.filter(x => all || picked.fees.has(x.id));
    const g = inb.reduce((s, x) => s + Number(x.amount), 0) - ret.reduce((s, x) => s + Number(x.amount), 0);
    const fi = fee.filter(x => x.direction === '收').reduce((s, x) => s + Number(x.amount), 0);
    const fp = fee.filter(x => x.direction !== '收').reduce((s, x) => s + Number(x.amount), 0);
    return { g, fi, fp, pay: g + fp - fi };
  }
  const supNameOf = () => (suppliers.find(s => Number(s.id) === curSup) || {}).name || '—';
  function drawPv() {
    const box = view.querySelector('#cPrevBox');
    if (!pv) return;
    const kw = (view.querySelector('#rcKw').value || '').trim().toLowerCase();
    const hit = x => !kw || String(x.doc_no || x.docNo || '').toLowerCase().includes(kw)
      || String(x.fee_type || '').toLowerCase().includes(kw) || String(x.direction || '').toLowerCase().includes(kw);
    const mk = (type, key, x) => {
      const aud = audited(x);
      const amtN = Number(x.amount) || 0;
      const amtTxt = !aud ? '—' : (key === 'inbounds' ? money(amtN) : '−' + money(amtN));
      const amtCls = key === 'inbounds' ? '' : 'style="color:var(--red)"';
      const docId = x.id != null ? x.id : (x.doc_id ?? '');
      const isFee = key === 'fees';
      const dtype = key === 'inbounds' ? 'inbound' : key === 'returns' ? 'return' : 'fee';
      return `<tr style="${aud ? '' : 'opacity:.55'}">
        <td><input type="checkbox" ${aud ? `data-pv="${key}" data-id="${x.id}" ${picked[key].has(x.id) ? 'checked' : ''}` : 'disabled'}></td>
        <td><a style="cursor:pointer;color:var(--info);font-family:var(--mono)" data-doc="${dtype}" data-docid="${docId}" data-no="${esc(x.doc_no || x.docNo || '')}">${esc(x.doc_no || x.docNo || '')}</a></td>
        <td>${type}</td>
        <td class="num" ${amtCls}>${amtTxt}</td>
        <td>${aud
          ? `<span class="pill g">已审核</span>` + (isFee ? `<span class="pill b">${x.direction === '收' ? '周期自动' : '费用'}</span>` : '')
          : `<span class="pill r">未审核 · 不可纳入</span> <button class="btn sm" data-doc="${dtype}" data-docid="${docId}" data-no="${esc(x.doc_no || x.docNo || '')}" data-auditgo="1">去审核</button>`}</td>
      </tr>`;
    };
    const allRows = [
      ...pv.inbounds.filter(hit).map(x => mk('入库', 'inbounds', x)),
      ...pv.returns.filter(hit).map(x => mk('退货', 'returns', x)),
      ...pv.fees.filter(hit).map(x => mk('应收费用', 'fees', x)),
    ];
    const pg = paginate(allRows, pvPage, 10);
    const s = pvSum();
    const allPicked = pv.inbounds.every(x => !audited(x) || picked.inbounds.has(x.id))
      && pv.returns.every(x => !audited(x) || picked.returns.has(x.id))
      && pv.fees.every(x => picked.fees.has(x.id))
      && (pv.inbounds.some(x => audited(x)) || pv.returns.some(x => audited(x)) || pv.fees.length > 0);
    box.innerHTML = allRows.length ? `
      <table style="margin-top:10px"><thead><tr><th style="width:34px"><input type="checkbox" id="pvChkAll" ${allPicked ? 'checked' : ''} title="全选/取消全选（已审核单据）"></th><th>原始单号</th><th>类型</th><th class="num">金额</th><th>状态</th></tr></thead>
      <tbody>${pg.slice.join('')}</tbody></table>${pg.bar}` : '<div class="empty" style="padding:18px">该区间无匹配单据（或单据已被对账单吸收）</div>';
    view.querySelector('#rcPay').textContent = money(pvSum(true).pay); // 本期应付=全部已审核单据合计
    // V4.9.7 修复复选框：勾选只更新汇总与 A5 预览，不整表重绘（勾选状态不再丢失）
    box.querySelectorAll('[data-pv]').forEach(c => c.onchange = () => {
      c.checked ? picked[c.dataset.pv].add(Number(c.dataset.id)) : picked[c.dataset.pv].delete(Number(c.dataset.id));
      const all = box.querySelector('#pvChkAll');
      const boxes = [...box.querySelectorAll('[data-pv]')];
      if (all) all.checked = boxes.length > 0 && boxes.every(x => x.checked);
      view.querySelector('#rcPay').textContent = money(pvSum(true).pay);
      drawA5();
    });
    // 表头全选/取消全选（仅已审核可纳入单据）
    const chkAll = box.querySelector('#pvChkAll');
    if (chkAll) chkAll.onchange = () => {
      box.querySelectorAll('[data-pv]').forEach(c => {
        c.checked = chkAll.checked;
        c.checked ? picked[c.dataset.pv].add(Number(c.dataset.id)) : picked[c.dataset.pv].delete(Number(c.dataset.id));
      });
      view.querySelector('#rcPay').textContent = money(pvSum(true).pay);
      drawA5();
    };
    // V4.9.7 点原始单号 → 弹窗加载明细（不跳页面）；未审核单据可编辑并可在弹窗内审核
    box.querySelectorAll('[data-doc]').forEach(a => a.onclick = () => {
      openDocModal(a.dataset.doc, Number(a.dataset.docid), a.dataset.no, a.dataset.auditgo === '1');
    });
    bindPager(box, p => { pvPage = p; drawPv(); });
    drawA5();
  }

  /** V4.9.7 单据明细弹窗：入库/退货可编辑（未审核）+ 弹窗内审核；点击不再跳转页面 */
  async function openDocModal(dtype, id, no, auditgo) {
    if (dtype === 'fee') {
      const mask = document.createElement('div');
      mask.className = 'modal-mask'; mask.style.zIndex = 80;
      mask.innerHTML = `<div class="modal" style="width:min(520px,92vw)"><h3>🧾 费用单 ${esc(no || '')}</h3>
        <div class="empty" style="padding:18px">费用单在下方「供应商费用单」区维护；对账时按金额吸收</div>
        <div class="doc-foot"></div></div>`;
      mask.onclick = e => { if (e.target === mask) mask.remove(); };
      document.body.appendChild(mask);
      return;
    }
    let d;
    try { d = await must(get(`/purchase/${dtype === 'inbound' ? 'inbounds' : 'returns'}/` + id)); } catch { return; }
    const o = d.order || {}, its = d.items || [];
    const editable = dtype === 'inbound' ? o.status === '未审核' : o.status === '待审核';
    const auditTxt = dtype === 'inbound' ? '✓ 审核入库' : '✓ 审核退货';
    const mask = document.createElement('div');
    mask.className = 'modal-mask'; mask.style.zIndex = 80;
    mask.innerHTML = `
      <div class="modal" style="width:min(900px,94vw);max-height:88dvh;overflow:auto">
        <h3>${dtype === 'inbound' ? '🚚 入库单' : '↩️ 退货单'} ${esc(o.inbound_no || o.return_no || no || '')}</h3>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">
          供应商：<b>${esc(o.supplier_name || '—')}</b>　状态：<span class="tag ${o.status === '已审核' ? 'g' : 'y'}">${esc(o.status || '')}</span>　
          金额：<b>${money(o.total_amount ?? o.total ?? 0)}</b>　${editable ? '<span class="pill o">未审核 · 明细可编辑</span>' : '<span class="muted">已审核 · 只读</span>'}</div>
        <div style="max-height:52vh;overflow:auto">
          <table><thead><tr><th>条码</th><th>商品</th><th>单位</th>
            <th class="num">${dtype === 'inbound' ? '数量' : '退货数量'}</th><th class="num">${dtype === 'inbound' ? '含税进价' : '原批次价'}</th><th class="num">金额</th>
            ${dtype === 'inbound' ? '<th>生产日期</th>' : '<th>批次</th>'}</tr></thead>
          <tbody>${its.map(it => `<tr>
            <td class="mono">${esc(it.barcode || '—')}</td>
            <td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '—')}</td>
            <td class="num">${editable ? `<input data-eit="qty" data-iid="${it.id}" type="number" step="1" min="1" value="${Number(it.qty)}" style="width:80px">` : Number(it.qty)}</td>
            <td class="num">${editable ? `<input data-eit="cost" data-iid="${it.id}" type="number" step="0.01" min="0" value="${Number(it.unit_cost ?? it.price ?? 0)}" style="width:90px">` : money(it.unit_cost ?? it.price)}</td>
            <td class="num">${(Number(it.qty) * Number(it.unit_cost ?? it.price ?? 0)).toFixed(2)}</td>
            <td>${dtype === 'inbound' ? String(it.production_date || '').slice(0, 10) : esc(String(it.batch_no || '—').replace(/-\d{2}$/, ''))}</td>
          </tr>`).join('')}</tbody></table>
        </div>
        <div id="docSigs" class="muted" style="font-size:12.5px;padding:8px 0 2px;border-top:1px dashed var(--line);margin-top:8px">✍️ 电子签名：加载中…</div>
        <div class="doc-foot">
          <span style="flex:1"></span>
          ${editable ? '<button class="btn" data-saveedit>💾 保存修改</button>' : ''}
          ${editable ? `<button class="btn pri" data-audit>${auditTxt}</button>` : ''}
        </div>
      </div>`;
    const close = () => mask.remove();
    mask.onclick = e => { if (e.target === mask) close(); };
    mask.querySelector('[data-saveedit]')?.addEventListener('click', async () => {
      const items = its.map(it => ({
        productId: it.product_id,
        qty: Number(mask.querySelector(`[data-eit="qty"][data-iid="${it.id}"]`).value),
        unitCost: Number(mask.querySelector(`[data-eit="cost"][data-iid="${it.id}"]`).value),
        productionDate: it.production_date ? String(it.production_date).slice(0, 10) : undefined,
        lineRemark: it.line_remark || undefined,
      }));
      await must(put(`/purchase/${dtype === 'inbound' ? 'inbounds' : 'returns'}/${id}/items`, { items }), '明细已保存');
      close(); await loadPv();
    });
    mask.querySelector('[data-audit]')?.addEventListener('click', async () => {
      // 先保存改动再审核
      if (mask.querySelector('[data-saveedit]')) {
        const items = its.map(it => ({
          productId: it.product_id,
          qty: Number(mask.querySelector(`[data-eit="qty"][data-iid="${it.id}"]`).value),
          unitCost: Number(mask.querySelector(`[data-eit="cost"][data-iid="${it.id}"]`).value),
          productionDate: it.production_date ? String(it.production_date).slice(0, 10) : undefined,
          lineRemark: it.line_remark || undefined,
        }));
        await must(put(`/purchase/${dtype === 'inbound' ? 'inbounds' : 'returns'}/${id}/items`, { items }), '明细已保存');
      }
      await must(post(`/purchase/${dtype === 'inbound' ? 'inbounds' : 'returns'}/${id}/audit`), '审核完成');
      close(); await loadPv(); await lists();
    });
    document.body.appendChild(mask);
    // V4.14.1 电子签名展示：关联该单据的签名调用记录（图片可点击放大）
    (async () => {
      try {
        const sr = await must(get(`/purchase/signature-records?bizType=${dtype}&bizId=${id}`));
        const arr = sr.items || [];
        const box = mask.querySelector('#docSigs');
        if (!box) return;
        if (!arr.length) { box.innerHTML = '✍️ 电子签名：<span class="muted">无（可在移动端单据页采集，或对账现场补签）</span>'; return; }
        // V4.15.0：操作员/业务员 角色标签（后端 role_label 优先，兜底按 签名人==操作员 判断）
        const roleOf = s => s.role_label
          || ((s.scene === '操作员签名' || String(s.person_name || '') === String(s.operator_name || '')) ? '操作员' : '业务员');
        box.innerHTML = `✍️ 电子签名（${arr.length}）：` + arr.map(s => `
          <span style="display:inline-flex;align-items:center;gap:6px;margin:0 14px 4px 0">
            <span class="tag ${roleOf(s) === '操作员' ? 'b' : 'g'}">${roleOf(s) === '操作员' ? '操作员' : '业务员'}</span>
            <img data-sigimg="${esc(imgUrl(s.image_path))}" src="${esc(imgUrl(s.image_path))}"
              style="height:36px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:zoom-in;padding:1px" onerror="this.style.display='none'">
            <span><b>${esc(s.person_name || '—')}</b>${s.scene ? `<span class="muted"> · ${esc(s.scene)}</span>` : ''}
            <span class="muted" style="font-size:11px">${dt(s.used_at || s.created_at)}</span></span>
          </span>`).join('');
        box.querySelectorAll('[data-sigimg]').forEach(img => img.onclick = () => {
          const lb = document.createElement('div');
          lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out';
          lb.innerHTML = `<img src="${esc(img.dataset.sigimg)}" style="max-width:80vw;max-height:80vh;background:#fff;border-radius:10px;padding:10px">`;
          lb.onclick = () => lb.remove();
          document.body.appendChild(lb);
        });
      } catch { const box2 = mask.querySelector('#docSigs'); if (box2) box2.innerHTML = '✍️ 电子签名：<span class="muted">加载失败</span>'; }
    })();
  }
  view.querySelector('#rcKw').addEventListener('input', () => { pvPage = 1; drawPv(); });
  async function loadPv() {
    if (!curSup) return toast('页头先选供应商', false);
    pv = await must(get(`/purchase/recon/preview?supplierId=${curSup}&from=${view.querySelector('#cFrom').value}&to=${view.querySelector('#cTo').value}`));
    picked.inbounds.clear(); picked.returns.clear(); picked.fees.clear();
    pvPage = 1;
    drawPv();
  }
  view.querySelector('#cPrev').onclick = loadPv;

  /* ── 期次 pill（本期/上期/自定义） ── */
  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  view.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    const d = new Date();
    if (b.dataset.p === 'cur') {
      view.querySelector('#cFrom').value = fmtDate(new Date(d.getFullYear(), d.getMonth(), 1));
      view.querySelector('#cTo').value = today;
      loadPv();
    } else if (b.dataset.p === 'prev') {
      view.querySelector('#cFrom').value = fmtDate(new Date(d.getFullYear(), d.getMonth() - 1, 1));
      view.querySelector('#cTo').value = fmtDate(new Date(d.getFullYear(), d.getMonth(), 0));
      loadPv();
    } else {
      toast('已切自定义区间：手动修改日期后点「加载待对账单据」');
    }
  });

  /* ── A5 结算单实时预览（图一：列随打印列配置联动） ── */
  function drawA5() {
    const box = view.querySelector('#a5Box');
    if (!pv) { box.innerHTML = '<div class="empty">勾选左侧已审核单据后实时生成结算单预览</div>'; return; }
    const s = pvSum();
    const col = k => colOn.has(k);
    const th = k => col(k) ? `<th>${(COLS.find(c => c.k === k) || {}).t}</th>` : '';
    const td = (k, v) => col(k) ? `<td class="num">${v}</td>` : '';
    const pickedRows = [
      ...pv.inbounds.filter(x => audited(x) && picked.inbounds.has(x.id)).map(x => ({ x, key: 'inbounds', type: '入库' })),
      ...pv.returns.filter(x => audited(x) && picked.returns.has(x.id)).map(x => ({ x, key: 'returns', type: '退货' })),
      ...pv.fees.filter(x => picked.fees.has(x.id)).map(x => ({ x, key: 'fees', type: '费用' })),
    ];
    const rows = pickedRows.map((r, i) => {
      const amt = Number(r.x.amount) || 0;
      const amtTxt = (r.key === 'inbounds' ? '' : '−') + amt.toFixed(2);
      const remark = r.key === 'returns' ? '退货' : r.key === 'fees' ? (r.x.direction === '收' ? '周期自动' : '费用') : '—';
      return `<tr>
        ${td('seq', i + 1)}
        ${td('no', esc(r.x.doc_no || r.x.docNo || ''))}
        ${td('amt', amtTxt)}
        ${td('unpaid', amtTxt)}
        ${td('round', '.00')}
        ${td('rcNo', curRecon?.recon_no || '—')}
        ${td('date', todayMMDD)}
        ${td('remark', remark)}
        ${td('detail', '—')}
        ${td('op', '—')}
      </tr>`;
    }).join('');
    const who = API.user?.name || '制单';
    box.innerHTML = `
      <div style="background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)">
        <h4 style="text-align:center;font-size:17px;letter-spacing:.35em;margin:0 0 8px">结 算 单</h4>
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--ink-2);margin-bottom:8px">
          <span>供应商：<b>${esc(supNameOf())}</b></span>
          <span>对账单号：<b>${esc(curRecon?.recon_no || '—')}</b></span>
        </div>
        <table><thead><tr>${COLS.filter(c => col(c.k)).map(c => `<th>${c.t}</th>`).join('')}</tr></thead>
        <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:var(--ink-3);padding:14px">尚未勾选已审核单据</td></tr>'}</tbody></table>
        <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:700;margin-top:10px;padding-top:8px;border-top:1px dashed var(--line)">
          <span>本期应付：${money(s.pay)}</span><span>本次结算：${money(s.pay)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--ink-3);margin-top:8px">
          <span>付款方式：银行转账</span><span>制单：${esc(who)}</span><span>供应商签字：__________</span>
        </div>
      </div>
      <div style="text-align:center;font-size:11px;color:var(--ink-3);margin-top:10px">抬头字段（供应商/付款方式/制单/审核人）同样可启停 · 大额结算建议纸质签字并行</div>`;
  }

  /* ── 主操作区：当前对账单 + 现场确认 / 打印 A5 / 挂起争议单 ── */
  function refreshHead(rcArr) {
    const list = (rcArr || []).filter(r => !curSup || Number(r.supplier_id) === curSup)
      .sort((a, b) => Number(b.id) - Number(a.id));
    curRecon = list[0] || null;
    view.querySelector('#rcTitle').textContent =
      `对账单 ${curRecon?.recon_no || '—'} · ${supNameOf()} · ${view.querySelector('#cFrom').value.slice(5).replace('-', '-')} ~ ${view.querySelector('#cTo').value.slice(5).replace('-', '-')}`;
    const st = view.querySelector('#rcStatus');
    if (!curRecon) { st.textContent = '未生成'; st.className = 'pill n'; return; }
    st.textContent = curRecon.status;
    st.className = 'pill ' + (['已确认', '已结算'].includes(curRecon.status) ? 'g' : curRecon.status === '已作废' ? 'r' : 'o');
    drawA5();
  }
  view.querySelector('#rcSign').onclick = async () => {
    // V4.15.0：定位「当前区间」的对账单（而非该供应商最近一张，避免误确认往期）
    const from = view.querySelector('#cFrom').value, to = view.querySelector('#cTo').value;
    let cur = (reconAll || []).find(r => Number(r.supplier_id) === curSup
      && String(r.period_start || '').slice(0, 10) === String(from)
      && String(r.period_end || '').slice(0, 10) === String(to));
    if (!cur) {
      // 当前区间还没有对账单 → 勾选的单据自动生成对账单，然后直接进入现场确认（一步到位）
      if (!curSup) return toast('页头先选供应商', false);
      const docIds = { inbounds: [...picked.inbounds], returns: [...picked.returns], fees: [...picked.fees] };
      if (!docIds.inbounds.length && !docIds.returns.length && !docIds.fees.length)
        return toast('先勾选要纳入对账的已审核单据（点「加载待对账单据」后勾选），系统会自动生成对账单', false);
      const gen = await must(post('/purchase/recon', { supplierId: curSup, from, to, docIds }));
      toast(`已自动生成对账单 ${gen.reconNo}，请现场确认签字`);
      await lists();
      cur = (reconAll || []).find(r => Number(r.id) === Number(gen.id)) || null;
    }
    if (!cur) return toast('对账单状态获取失败，请刷新重试', false);
    if (!['生成', '待供应商确认'].includes(cur.status)) return toast(`当前对账单状态（${cur.status}）不可再确认`, false);
    openConfirm(cur.id);
  };
  view.querySelector('#rcPrintA5').onclick = async () => {
    if (!curRecon) return toast('尚无对账单可打印', false);
    if (curRecon.status === '生成' || curRecon.status === '待供应商确认') return toast('当前对账单尚未确认，先「已现场确认」后打印结算单 A5', false);
    printSettlement(curRecon.id, true);
  };
  view.querySelector('#rcHold').onclick = () => {
    if (!pv) return toast('先加载待对账单据', false);
    // V4.15.0 挂起语义明确化：只作用于「已勾选的已审核单据」（未审核单据本就不参与对账）——
    // 挂起 = 移出本期对账（金额不计入本期应付），单据状态不变，之后可重新勾选纳入
    let n = 0;
    pv.inbounds.forEach(x => { if (audited(x) && picked.inbounds.has(x.id) && Number(x.amount) > 0) { picked.inbounds.delete(x.id); n++; } });
    pv.returns.forEach(x => { if (audited(x) && picked.returns.has(x.id) && Number(x.amount) > 0) { picked.returns.delete(x.id); n++; } });
    if (!n) return toast('请先勾选要挂起的单据（已审核且金额 > 0），再点「挂起争议单」', false);
    drawPv();
    toast(`已挂起 ${n} 张争议单：移出本期对账（金额不再计入本期应付），单据本身状态不变，之后可重新勾选纳入`);
  };

  /* ── 确认弹窗 ── */
  function openConfirm(id) {
    cfmReconId = Number(id);
    view.querySelector('#cfmName').value = '';
    clearPad();
    view.querySelector('#cfmModal').style.display = 'flex';
  }
  view.querySelector('#cfmCancel').onclick = () => { view.querySelector('#cfmModal').style.display = 'none'; };
  view.querySelector('#cfmClear').onclick = clearPad;
  view.querySelector('#cfmGo').onclick = async () => {
    const type = view.querySelector('#cfmType').value;
    const name = view.querySelector('#cfmName').value.trim() || undefined;
    const photo = padDirty ? view.querySelector('#cfmPad').toDataURL('image/png') : undefined;
    await must(post(`/purchase/recon/${cfmReconId}/confirm`,
      { confirmType: type, confirmName: name, confirmPhotos: photo ? [photo] : undefined }), '对账单已确认');
    view.querySelector('#cfmModal').style.display = 'none';
    await lists();
  };

  /* ── 对账单列表 ── */
  let rcFilter = '';
  view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    rcFilter = b.dataset.f;
    view.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('n', x !== b));
    lists();
  });
  async function lists() {
    const rc = await must(get('/purchase/recons'));
    reconAll = rc.items || rc || [];
    const rcArr = reconAll.filter(r => (!curSup || Number(r.supplier_id) === curSup) && (!rcFilter || r.status === rcFilter));
    const pg = paginate(rcArr, rcPage, 10);
    refreshHead(reconAll);
    view.querySelector('#cList').innerHTML = rcArr.length ? `
      <table><thead><tr><th style="width:34px"></th><th>对账单号</th><th>供应商</th><th>区间</th>
        <th class="num">货款</th><th class="num">费用收</th><th class="num">费用付</th><th class="num">应付</th><th>状态</th><th></th></tr></thead>
      <tbody>${pg.slice.map(r => {
        const pay = Number(r.payable_total ?? r.payable ?? 0);
        const voidable = r.status === '生成' || r.status === '待供应商确认';
        return `<tr>
        <td>${voidable ? `<input type="checkbox" data-rchk="${r.id}">` : ''}</td>
        <td style="font-family:var(--mono);font-weight:600">${esc(r.recon_no || r.reconNo || r.id)}</td>
        <td>${esc(r.supplier_name || r.supplierName || '')}</td>
        <td class="muted">${String(r.period_from || r.periodFrom || '').slice(0, 10)} ~ ${String(r.period_to || r.periodTo || '').slice(0, 10)}</td>
        <td class="num">${money(r.goods_total ?? 0)}</td>
        <td class="num" style="color:var(--pri)">−${money(r.fee_income_total ?? 0)}</td>
        <td class="num" style="color:var(--warn)">+${money(r.fee_pay_total ?? 0)}</td>
        <td class="num"><b>${money(pay)}</b></td>
        <td><span class="tag ${['已确认', '已结算'].includes(r.status) ? 'g' : r.status === '已作废' ? 'r' : 'y'}">${esc(r.status)}</span></td>
        <td style="white-space:nowrap">
          ${r.status === '生成' || r.status === '待供应商确认' ? `<button class="btn sm pri" data-c="${r.id}">确认</button>` : ''}
          ${pay === 0 && r.status !== '已结算' && r.status !== '已作废' ? `<button class="btn sm g" data-z="${r.id}">0元直结算</button>` : ''}
          ${r.status === '已确认' ? `<button class="btn sm" data-st="${r.id}">生成结算单</button>` : ''}
          ${r.status !== '已作废' ? `<button class="btn sm" data-print="${r.id}">🖨 对账单</button>` : ''}
        </td>
      </tr>`; }).join('')}</tbody></table>${pg.bar}` : '<div class="empty">暂无对账单</div>';
    bindPager(view.querySelector('#cList'), p => { rcPage = p; lists(); });
    view.querySelectorAll('[data-c]').forEach(b => b.onclick = () => openConfirm(b.dataset.c));
    view.querySelectorAll('[data-z]').forEach(b => b.onclick = async () => {
      await must(post('/purchase/settlements', { reconId: Number(b.dataset.z) }), '0 元应付已直结算（免确认免审核）');
      await lists();
    });
    view.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => {
      await must(post('/purchase/settlements', { reconId: Number(b.dataset.st) }), '结算单已生成（待审核）');
      await lists();
    });
    view.querySelectorAll('[data-print]').forEach(b => b.onclick = () => printRecon(b.dataset.print));
    await loadSettlements();
  }

  view.querySelector('#rcRefresh').onclick = lists;
  view.querySelector('#rcVoidBatch').onclick = async () => {
    const ids = [...view.querySelectorAll('[data-rchk]:checked')].map(c => c.dataset.rchk);
    if (!ids.length) return toast('请勾选「生成/待供应商确认」状态的对账单', false);
    // V4.9.7 样式化删除确认
    if (!await confirmBox({
      title: '🗑 批量删除（作废）对账单',
      html: `确认作废 ${ids.length} 张对账单？\n将回删往来账并释放单据，操作不可恢复。`,
      okText: '确认作废',
    })) return;
    for (const id of ids) await post(`/purchase/recons/${id}/void`, { reason: '批量删除' });
    toast(`已作废 ${ids.length} 张对账单`);
    await lists(); await feeCards();
  };

  /* ── 对账单 / 结算单 A5 打印 ── */
  async function printRecon(id) {
    const d = await must(get(`/purchase/recons/${id}`));
    const o = d.recon || {}, its = d.items || [];
    const rows = its.map((x, i) => `<tr>
      <td class="num">${i + 1}</td><td style="font-family:monospace">${esc(x.doc_no || '')}</td>
      <td>${String(x.doc_date || '').slice(0, 10)}</td><td>${esc(x.line_remark || x.unpaid_amount || '')}</td>
      <td class="num">${Number(x.amount).toFixed(2)}</td></tr>`).join('');
    printDoc(o.recon_no || '对账单', `
      <h2>供应商对账单（A5）</h2><div class="sub">社区超市收银系统</div>
      <div class="meta">单号：<b>${esc(o.recon_no || '')}</b>　供应商：${esc(o.supplier_name || '')}　业务员：${esc(o.salesman || '—')}<br>
        期间：${String(o.period_from || '').slice(0, 10)} ~ ${String(o.period_to || '').slice(0, 10)}　
        状态：${esc(o.status || '')}　确认方式：${esc(o.confirm_type || '未确认')}</div>
      <table><thead><tr><th>序号</th><th>单据号</th><th>日期</th><th>说明</th><th class="num">金额</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4">应付合计（货款 ${Number(o.goods_total || 0).toFixed(2)} − 费用收 ${Number(o.fee_income_total || 0).toFixed(2)} + 费用付 ${Number(o.fee_pay_total || 0).toFixed(2)}）</td>
        <td class="num"><b>${Number(o.payable_total || 0).toFixed(2)}</b></td></tr></tfoot></table>
      <div class="ft"><span>店方：__________</span><span>业务员签字：__________</span><span>日期：__________</span></div>`);
  }
  async function printSettlement(id, byRecon = false) {
    const st = await must(get('/purchase/settlements'));
    const r = (st.items || st || []).find(x => byRecon ? String(x.recon_id) === String(id) : String(x.id) === String(id));
    if (!r) return toast('结算单不存在', false);
    printDoc(r.settle_no || '结算单', `
      <h2>购销结算单（A5）</h2><div class="sub">社区超市收银系统</div>
      <div class="meta">结算单号：<b>${esc(r.settle_no || '')}</b>　对账单号：${esc(r.recon_no || '')}　供应商：${esc(r.supplier_name || '')}<br>
        日期：${(r.created_at || '').slice(0, 10)}　付款方式：${esc(r.pay_mode || '')}　状态：${esc(r.status || '')}</div>
      <div style="margin-top:18px;font-size:15px">本次结算金额：<b style="font-size:20px">￥${Number(r.amount || 0).toFixed(2)}</b>（大写：人民币${r.amount ? '见金额' : '零元整'}）</div>
      <div class="ft"><span>付款方：__________</span><span>收款方：__________</span><span>审核：__________</span></div>`);
  }

  /* ── 结算单列表 ── */
  let qStatus = '';
  view.querySelectorAll('#qStat .segbtn').forEach(b => b.onclick = () => {
    view.querySelectorAll('#qStat .segbtn').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); qStatus = b.dataset.v; loadSettlements();
  });
  view.querySelector('#qGo').onclick = loadSettlements;
  view.querySelector('#qRefresh').onclick = loadSettlements;

  async function loadSettlements() {
    const st = await must(get('/purchase/settlements'));
    const all = st.items || st || [];
    const from = view.querySelector('#qFrom').value, to = view.querySelector('#qTo').value;
    const rows = all.filter(r => {
      if (qStatus && r.status !== qStatus) return false;
      if (curSup && Number(r.supplier_id) !== curSup) return false;
      const day = (r.created_at || r.createdAt || '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
    const sum = rows.reduce((s, r) => s + (Number(r.amount ?? r.settle_amount) || 0), 0);
    const pg = paginate(rows, stPage, 10);
    view.querySelector('#qSum').textContent = fmt(sum);
    view.querySelector('#qCount').textContent = `共 ${rows.length} 张结算单`;
    view.querySelector('#sList').innerHTML = rows.length ? `
      <table><thead><tr><th>结算单号</th><th>供应商</th><th>对账单</th><th class="num">结算金额</th><th>付款方式</th><th>状态</th><th>创建</th><th></th></tr></thead>
      <tbody>${pg.slice.map(r => `<tr>
        <td style="font-family:var(--mono);font-weight:600">${esc(r.settle_no || r.settleNo || r.id)}</td>
        <td>${esc(r.supplier_name || r.supplierName || '')}</td>
        <td class="muted" style="font-family:var(--mono)">${esc(r.recon_no || '')}</td>
        <td class="num">${money(r.amount ?? r.settle_amount ?? 0)}</td>
        <td class="muted">${esc(r.pay_mode || '—')}</td>
        <td><span class="tag ${r.status === '已审核' || r.status === '已付款' ? 'g' : r.status === '付款中' ? 'b' : 'y'}">${esc(r.status)}</span></td>
        <td>${dt(r.created_at || r.createdAt)}</td>
        <td style="white-space:nowrap">
          ${r.status === '待审核' ? `<button class="btn sm pri" data-s="${r.id}">✓ 审核</button>` : ''}
          ${r.status === '付款中' ? `<button class="btn sm pri" data-sp="${r.id}">💰 确认已付款</button>` : ''}
          <button class="btn sm" data-sprint="${r.id}">🖨 打印</button>
        </td>
      </tr>`).join('')}</tbody></table>${pg.bar}` : '<div class="empty">暂无结算单（对账确认后生成；0元应付可直结算）</div>';
    bindPager(view.querySelector('#sList'), p => { stPage = p; loadSettlements(); });
    view.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
      await must(post(`/purchase/settlements/${b.dataset.s}/audit`), '结算单审核完成');
      await loadSettlements(); await lists();
    });
    // VQA-D3：recon.settle_pay_flow 开启后审核→待付款，付款动作在此完成终结
    view.querySelectorAll('[data-sp]').forEach(b => b.onclick = async () => {
      await must(post(`/purchase/settlements/${b.dataset.sp}/pay`), '已确认付款：结算终结（往来账/对账核销已落）');
      await loadSettlements(); await lists();
    });
    view.querySelectorAll('[data-sprint]').forEach(b => b.onclick = () => printSettlement(b.dataset.sprint));
  }

  /* ── 费用单（表格行内直录；V4.13.9 费用项手输自动建档 + 行级方向 应付- / 应收+） ──
   * 方向值沿用后端口径：'收'=供应商应付（对账扣减 -）、'付'=供应商应收（对账增加 +） */
  const dirLabel = d => d === '付' ? '供应商应收（+）' : '供应商应付（-）';
  const feeLines = [];
  function feeSums() {
    const a = feeLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    view.querySelector('#feeSumAmt').textContent = fmt(a);
    view.querySelector('#feeStat').textContent = feeLines.length ? `录入中 · ${feeLines.length} 行` : '录入中';
  }
  function drawFeeLines() {
    const tb = view.querySelector('#feeLines');
    if (!feeLines.length) {
      tb.innerHTML = '<tr><td colspan="6" class="empty">点「➕ 添加行」录入费用</td></tr>';
    } else {
      tb.innerHTML = feeLines.map((l, i) => {
        const t = feeTypes.find(x => String(x.id) === String(l.feeTypeId)) || {};
        const dir = l.direction || t.direction || '收';
        return `<tr>
          <td class="num">${i + 1}</td>
          <td><input data-f="tname" data-i="${i}" list="feeTypeDl" value="${esc(l.feeName || t.name || '')}"
               placeholder="输入/选择费用项，新名称自动建档" style="width:100%"></td>
          <td><select data-f="dir" data-i="${i}" style="width:100%">
            <option value="收" ${dir === '收' ? 'selected' : ''}>供应商应付（-）</option>
            <option value="付" ${dir === '付' ? 'selected' : ''}>供应商应收（+）</option>
          </select></td>
          <td><input data-f="amt" data-i="${i}" type="number" step="0.01" value="${l.amount ?? ''}" style="width:100%"></td>
          <td><input data-f="rm" data-i="${i}" value="${esc(l.remark || '')}" placeholder="行备注" style="width:100%"></td>
          <td><button class="btn sm warn" data-fi="${i}">删</button></td>
        </tr>`;
      }).join('');
      tb.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
        const i = Number(inp.dataset.i), f = inp.dataset.f;
        const cur = feeLines[i];
        if (f === 'tname') {
          const name = inp.value.trim();
          const hit = feeTypes.find(x => x.name === name);
          cur.feeName = name;
          cur.feeTypeId = hit ? hit.id : '';
          if (hit && !cur.direction) cur.direction = hit.direction;   // 选中预设默认带出方向
        } else if (f === 'dir') cur.direction = inp.value;
        else if (f === 'amt') cur.amount = inp.value;
        else if (f === 'rm') cur.remark = inp.value;
        drawFeeLines();
      });
      tb.querySelectorAll('[data-fi]').forEach(b => b.onclick = () => { feeLines.splice(Number(b.dataset.fi), 1); drawFeeLines(); });
    }
    feeSums();
  }
  // V4.9.7 ➕添加行（费用单空表一键加行）
  view.querySelector('#feeAdd').onclick = () => { feeLines.push({ feeName: '', feeTypeId: '', direction: '', amount: '', remark: '' }); drawFeeLines(); };
  view.querySelector('#feeGo').onclick = async () => {
    const rows = feeLines.filter(l => (l.feeTypeId || (l.feeName || '').trim()) && Number(l.amount) > 0);
    if (!rows.length) return toast('无有效费用行（需费用项+金额>0）', false);
    if (!curSup) return toast('页头先选供应商', false);
    let made = 0;
    for (const l of rows) {
      const name = (l.feeName || '').trim();
      // 手输新费用项（预设没有）→ 先建档（后期可用），再录费用单
      if (!l.feeTypeId && name) {
        const t = await must(post('/purchase/fee-types', { name, direction: l.direction || '收' }));
        if (t?.id) { l.feeTypeId = t.id; if (!feeTypes.some(x => Number(x.id) === Number(t.id))) feeTypes.push(t); }
      }
      if (!l.feeTypeId) continue;
      await must(post('/purchase/fees', { supplierId: curSup, feeTypeId: Number(l.feeTypeId),
        direction: l.direction || undefined, amount: Number(l.amount), remark: l.remark || undefined }));
      made++;
    }
    toast(`费用单已保存 ${made} 行（对账时按 应付- / 应收+ 吸收）`);
    feeLines.length = 0;
    drawFeeLines();
    await feeCards();
  };

  /* ── 费用协议 / 费用单列表 ── */
  async function feeCards() {
    const sid = curSup;
    const ag = await must(get(`/purchase/fee-agreements?supplierId=${sid}`));
    const agArr = ag.items || [];
    const pgA = paginate(agArr, agPage, 10);
    view.querySelector('#agList').innerHTML = agArr.length ? `
      <table><thead><tr><th>供应商</th><th>类型</th><th>方向</th><th>性质</th><th>模式</th><th class="num">每期</th><th class="num">期数</th>
        <th>自动补齐</th><th>协议期</th><th>状态</th></tr></thead>
      <tbody>${pgA.slice.map(a => `<tr>
        <td>${esc(a.supplier_name)}</td><td>${esc(a.fee_type_name)}</td>
        <td><span class="tag ${a.direction === '收' ? 'g' : 'y'}">${esc(dirLabel(a.direction))}</span></td>
        <td>${a.fee_nature === '一次性' ? '<span class="tag y">一次性</span>' : '<span class="tag b">周期性</span>'}</td>
        <td>${esc(a.amount_mode)}</td>
        <td class="num">${a.amount != null ? money(a.amount) : (a.ratio != null ? (Number(a.ratio) * 100).toFixed(2) + '%' : '—')}</td>
        <td class="num">${a.total_periods ? `${a.total_periods} 期` : a.fee_nature === '一次性' ? '1 期' : '不限'}</td>
        <td>${a.auto_generate ? '<span class="tag g">补齐漏记</span>' : '<span class="tag">手动</span>'}</td>
        <td class="muted">${String(a.start_date).slice(0, 10)} ~ ${a.end_date ? String(a.end_date).slice(0, 10) : '长期'}</td>
        <td>${a.status === 1 ? '<span class="tag g">生效</span>' : '<span class="tag r">停用</span>'}</td>
      </tr>`).join('')}</tbody></table>${pgA.bar}` : '<div class="empty">该供应商暂无费用协议</div>';
    bindPager(view.querySelector('#agList'), p => { agPage = p; feeCards(); });
    const fe = await must(get(`/purchase/fees?supplierId=${sid}`));
    const feArr = fe.items || [];
    const pgF = paginate(feArr, fePage, 10);
    view.querySelector('#feeList').innerHTML =
      (feArr.length ? `
      <table><thead><tr><th>费用单号</th><th>类型</th><th>方向</th><th>期间</th><th class="num">金额</th><th>状态</th><th>备注</th></tr></thead>
      <tbody>${pgF.slice.map(f => `<tr>
        <td style="font-family:var(--mono)">${esc(f.fee_no)}</td><td>${esc(f.fee_type_name)}</td>
        <td><span class="tag ${f.direction === '收' ? 'g' : 'y'}">${esc(dirLabel(f.direction))}</span></td>
        <td class="muted">${f.period_start ? String(f.period_start).slice(0, 10) + ' ~ ' + String(f.period_end || '').slice(0, 10) : '一次性'}</td>
        <td class="num">${money(f.amount)}</td>
        <td>${f.status === '已审核' ? '<span class="tag g">已审核</span>' : `<span class="tag y">${esc(f.status)}</span>`}</td>
        <td class="muted">${esc(f.remark || '')}</td>
      </tr>`).join('')}</tbody></table>${pgF.bar}` : '<div class="empty">该供应商暂无费用单</div>');
    bindPager(view.querySelector('#feeList'), p => { fePage = p; feeCards(); });
  }

  view.querySelector('#agGo').onclick = async () => {
    const amount = Number(view.querySelector('#agAmount').value);
    const start = view.querySelector('#agStart').value;
    if (!(amount > 0) || !start) return toast('金额与协议起始日必填', false);
    if (!curSup) return toast('页头先选供应商', false);
    const periodsRaw = view.querySelector('#agPeriods').value.trim();
    await must(post('/purchase/fee-agreements', { supplierId: curSup,
      feeTypeId: Number(view.querySelector('#agType').value), cycle: '月', amountMode: '固定额',
      direction: view.querySelector('#agDir').value || undefined,
      feeNature: view.querySelector('#agNature').value || undefined,
      totalPeriods: periodsRaw ? Number(periodsRaw) : undefined,
      amount, autoGenerate: true, startDate: start,
      endDate: view.querySelector('#agEnd').value || undefined }), '协议已创建');
    view.querySelector('#agAmount').value = ''; view.querySelector('#agPeriods').value = '';
    await feeCards();
  };

  /* ── 初始化 ── */
  const [d, types] = await Promise.all([
    must(get('/purchase/suppliers')).catch(() => ({})),
    must(get('/purchase/fee-types')).catch(() => ({})),
  ]);
  suppliers = d.items || d || [];
  feeTypes = types.items || types || [];
  // V4.15.0 供应商改自绘下拉：聚焦弹全量列表（不再用原生 datalist——一旦输入全名，原生列表只剩匹配项，无法换选其他供应商）
  const supBox = view.querySelector('#cSup').parentElement;
  const supDl = document.createElement('div');
  supDl.style.cssText = 'display:none;position:absolute;top:100%;right:110px;z-index:60;min-width:260px;max-height:280px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:4px';
  supBox.appendChild(supDl);
  const drawSupDl = () => {
    const kw = (view.querySelector('#cSup').value || '').trim().toLowerCase();
    const arr = suppliers.filter(s => !kw || String(s.name || '').toLowerCase().includes(kw));
    supDl.innerHTML = (arr.length ? arr : suppliers).map(s => `
      <div data-sup="${Number(s.id)}" style="padding:7px 10px;cursor:pointer;border-radius:7px;font-size:13px;display:flex;justify-content:space-between;gap:10px">
        <span>${esc(s.name)}</span><span class="muted" style="font-size:11.5px">${esc(s.biz_mode || s.bizMode || '')}</span></div>`).join('')
      || '<div class="empty" style="padding:8px">无匹配供应商</div>';
    supDl.style.display = 'block';
    supDl.querySelectorAll('[data-sup]').forEach(o => o.onmousedown = e => {
      e.preventDefault();
      const hit = suppliers.find(s => Number(s.id) === Number(o.dataset.sup));
      view.querySelector('#cSup').value = hit ? hit.name : '';
      supDl.style.display = 'none';
      view.querySelector('#cSup').dispatchEvent(new Event('change'));
    });
  };
  view.querySelector('#cSup').addEventListener('focus', drawSupDl);
  view.querySelector('#cSup').addEventListener('input', drawSupDl);
  view.querySelector('#cSup').addEventListener('blur', () => setTimeout(() => { supDl.style.display = 'none'; }, 150));
  view.querySelector('#agType').innerHTML =
    feeTypes.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  view.querySelector('#feeTypeDl').innerHTML =
    feeTypes.map(t => `<option value="${esc(t.name)}">`).join('');
  /* V4.26.3 锚点导航：本页五节（对账操作 / 对账单 / 费用协议 / 结算单 / 往来账）。
     标题取值：<h3> 首子节点（跳过 <span class="api"> 的接口说明）；无 h3 的取 .doc-tools 首 span；
     #rcTitle 是含日期供应商的动态标题，统一显示「对账操作」。购销↔联营切换会整块换内容 → 抽成函数便于重建。
     定义在模式切换监听之前，回调里引用不会落进 TDZ。 */
  const mountAnchors = () => anchorNav(view, {
    item: '#modeBuyOnly > .card, #modeCommon > .card',
    label: el => {
      const h = el.querySelector('h3');
      if (h && h.id !== 'rcTitle') return (h.firstChild?.textContent || '').trim();
      const t = el.querySelector('.doc-tools > span');
      if (t) return t.textContent.trim();
      return '对账操作';
    },
    refresh: true,
  });
  view.querySelector('#cSup').addEventListener('change', async () => {
    const name = view.querySelector('#cSup').value.trim();
    const hit = suppliers.find(s => s.name === name)
      || suppliers.find(s => (s.name || '').includes(name) || name.includes(s.name || ''));
    curSup = hit ? Number(hit.id) : 0;
    pv = null; curRecon = null;
    const isC = hit && (hit.biz_mode || hit.bizMode) === '联营';
    const pill = view.querySelector('#modePill');
    pill.textContent = isC ? '🤝 联营模式' : '📑 购销模式';
    pill.className = 'pill ' + (isC ? 'b' : 'g');
    view.querySelector('#modeBuy').style.display = isC ? 'none' : '';
    view.querySelector('#modeConsign').style.display = isC ? '' : 'none';
    view.querySelector('#settleTitle').textContent = isC ? '💵 联营结算单' : '💵 购销结算单';
    if (isC) {
      await renderConsign(view.querySelector('#modeConsign'), { supplierId: curSup, suppliers });
      // V4.14.2：联营模式下同样加载 费用单/往来账（费用协议列表与供应商无关可复用）
      await Promise.all([feeCards(), drawLedger(curSup)]);
    } else {
      view.querySelector('#cPrevBox').innerHTML = '<div class="empty">输入供应商与区间后加载（未审核单据灰显 · 不参与应付）</div>';
      drawA5();
      await Promise.all([lists(), feeCards(), drawLedger(curSup), loadPv().catch(() => {})]);
    }
    mountAnchors();   // V4.26.3：切换后可见小节增减（联营隐藏「对账操作/对账单」），重建胶囊条
  });
  bindPad();
  drawColCfg();

  await lists();
  await feeCards();
  mountAnchors();
}
