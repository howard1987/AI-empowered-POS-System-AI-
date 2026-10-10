import { get, post, put, del, must, money, esc, dt, toast, imgUrl } from '../api.js';
import { openDetailModal, paginate, bindPager } from '../common-ui.js';
import { attachProductSearch } from '../product-search.js';
import { zoomImg } from '../ui.js';

/** 大客户与团购销售（方案 5.10 / M9）：
 *  一屏三 Tab：客户档案（建档/启停/下单） → 专属价目（按客户批量设价） → 应收台账（账龄/未清赊账/回款登记）
 *  团购下单：专属价（无则零售价）→ 防双重折扣 → FIFO 扣库存 → 赊账/现结 */
export async function render(view) {
  view.innerHTML = `
    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <span style="font-weight:700;font-size:14.5px">🤝 大客户与团购销售 <span class="pill b">M9</span></span>
      <span class="muted">档案 → 专属价目 → 团购下单（赊账/现结）→ 应收台账/账龄/回款</span>
      <span style="display:flex;gap:2px;margin-left:auto">
        <button class="btn sm segbtn on" data-tab="cust">📋 客户档案</button>
        <button class="btn sm segbtn" data-tab="price">💱 专属价目</button>
        <button class="btn sm segbtn" data-tab="req">📨 价申请</button>
        <button class="btn sm segbtn" data-tab="rcv">📑 应收台账</button>
        <button class="btn sm segbtn" data-tab="rch">💳 充值明细</button>
      </span>
    </div>

    <div id="bcTabCust">
      <div class="card" style="padding-bottom:14px">
        <div class="bar">
          <button class="btn pri" id="bcNew">➕ 新建客户</button>
          <input id="bcKw" placeholder="名称/联系人/电话" style="width:200px">
          <select id="bcStatus" style="width:110px">
            <option value="">全部状态</option><option value="1">启用</option><option value="0">停用</option>
          </select>
          <button class="btn pri" id="bcGo">查询</button>
          <span class="muted" id="bcCount" style="margin-left:auto;font-size:11.5px"></span>
        </div>
        <div id="bcCustBody" class="tbl-min pg-host"></div>
      </div>
    </div>

    <div id="bcTabPrice" style="display:none">
      <div class="card" style="padding-bottom:16px">
        <h3>专属价目 
          <span class="muted" style="font-weight:400">专价不高于零售价 1.2 倍；有效期内按最新专价计</span></h3>
        <div class="bar">
          <select id="bcPriceCust" style="min-width:240px"></select>
          <button class="btn sm pri" id="bcPriceLoad">🔍 加载当前专价</button>
          <span class="muted" style="font-size:11.5px;margin-left:auto" id="bcPriceHint"></span>
        </div>
        <div id="bcPriceRows"></div>
        <div class="bar" style="margin-top:10px">
          <button class="btn sm" id="bcPriceAddRow">➕ 添加设价行</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="bcPriceSave">💾 保存设价</button>
        </div>
        <div class="tbl-min pg-host" style="padding:0 18px" id="bcPriceList"><div class="empty">选客户后加载当前生效专价</div></div>
      </div>
    </div>

    <div id="bcTabRcv" style="display:none">
      <div class="card" style="padding-bottom:16px">
        <h3>应收台账 </h3>
        <div class="bar">
          <select id="bcRcvCust" style="min-width:240px"></select>
          <button class="btn sm" id="bcRcvRefresh">刷新</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="bcCollect">💰 回款登记</button>
        </div>
        <div style="padding:0 18px 6px" id="bcRcvKpi"></div>
        <div style="padding:0 18px 10px" id="bcRcvAging"></div>
        <div class="tbl-min pg-host" style="padding:0 18px" id="bcRcvOrders"></div>
        <div class="tbl-min pg-host" style="padding:0 18px" id="bcRcvPay"></div>
      </div>
    </div>

    <div id="bcTabRch" style="display:none">
      <div class="card" style="padding-bottom:16px">
        <h3>💳 充值明细
          <span class="muted" style="font-weight:400">大客户预充值流水（先存后用；下单可选「预存余额」抵扣，不计应收）</span></h3>
        <div class="bar">
          <select id="bcRchCust" style="min-width:240px"></select>
          <input id="bcRchKw" placeholder="方式/备注关键字" style="width:200px">
          <button class="btn sm" id="bcRchRefresh">查询</button>
        </div>
        <div class="tbl-min pg-host" id="bcRchList" style="margin-top:8px"></div>
      </div>
    </div>

    <div id="bcTabReq" style="display:none">
      <div class="card" style="padding-bottom:16px">
        <h3>📨 专属价申请 
          <span class="muted" style="font-weight:400">连锁模式：门店提交申请 → 总部审批 → 价目生效（提货仍在门店）</span></h3>
        <div id="bcReqBanner"></div>
        <div class="bar" style="padding:10px 14px;border:1px dashed var(--line);border-radius:10px;margin-bottom:10px;flex-wrap:wrap">
          <select id="bcReqCust" style="min-width:180px"><option value="">— 选择客户 —</option></select>
          <input id="bcReqProd" placeholder="商品（条码/名称/拼音）" style="flex:1;min-width:180px">
          <input id="bcReqPrice" type="number" min="0.01" step="0.01" placeholder="申请价" style="width:100px">
          <input id="bcReqReason" placeholder="申请原因（选填）" style="flex:1;min-width:140px">
          <button class="btn pri sm" id="bcReqGo">⇪ 提交申请</button>
        </div>
        <div class="bar">
          <select id="bcReqStatus" style="width:120px">
            <option value="pending">待审批</option><option value="approved">已通过</option>
            <option value="rejected">已驳回</option><option value="all">全部</option>
          </select>
          <button class="btn sm" id="bcReqRefresh">刷新</button>
          <span class="muted" style="font-size:11.5px;margin-left:auto" id="bcReqHint"></span>
        </div>
        <div class="tbl-min pg-host" id="bcReqList" style="margin-top:8px"></div>
      </div>
    </div>

    <div class="modal-mask" id="bcCustModal" style="display:none">
      <div class="modal">
        <h3 id="bcCustTitle">➕ 新建客户</h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label class="req">客户名称</label><input id="bcCustName" placeholder="如：华联采购中心"></div>
          <div class="fld"><label>联系人</label><input id="bcCustContact" placeholder="采购对接人"></div>
          <div class="fld"><label>联系电话</label><input id="bcCustPhone" placeholder="手机/座机"></div>
          <div class="fld"><label>信用额度（赊账上限）</label><input id="bcCustCredit" type="number" min="0" step="100" value="0" placeholder="0 = 不限制"></div>
          <div class="fld"><label class="req">整单折扣</label><input id="bcCustDiscount" type="number" min="0.01" max="1" step="0.05" value="1"></div>
          <div class="fld"><label title="赊账款按此账期滚动结算">账期（月）</label><input id="bcCustTerm" type="number" min="0" max="36" step="1" value="0" placeholder="0 = 现结" title="0 = 现结；如填 3，挂账日起 3 个月内滚动结清，超期未收计入「已逾期」"></div>
          <div class="fld"><label>状态</label><select id="bcCustStatus"><option value="1">启用</option><option value="0">停用</option></select></div>
        </div>
        <div style="margin:10px 18px 0;padding:10px 12px;border:1px dashed var(--line);border-radius:10px">
          <div style="font-size:13px;font-weight:700;margin-bottom:6px">✍️ 业务/联系人电子签字（同供应商预采方式，用于业务单据留痕）</div>
          <canvas id="bcSignPad" width="560" height="120" style="width:100%;max-width:560px;height:120px;border:1px solid var(--line);border-radius:8px;background:#fff;touch-action:none;cursor:crosshair"></canvas>
          <div class="bar" style="margin-top:6px;gap:8px">
            <button class="btn sm" id="bcSignClear">🧹 重写</button>
            <span class="muted" id="bcSignStat" style="font-size:11.5px">在上方手写签字；已有签字不重写则保留原样</span>
          </div>
        </div>
        <div class="doc-tip">💡 折扣 0.9 = 9 折，仅作用于未设专属价的商品；专属价商品不再叠加折扣（防双重优惠）</div>
        <div class="doc-foot">
          <button class="btn" id="bcCustCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="bcCustSave">💾 保存</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="bcCollectModal" style="display:none">
      <div class="modal">
        <h3>💰 回款登记 <span class="muted" style="font-weight:400" id="bcCollectFor"></span></h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label class="req">回款金额</label><input id="bcCollectAmount" type="number" min="0.01" step="0.01"></div>
          <div class="fld"><label>收款方式</label>
            <select id="bcCollectMethod"><option>现金</option><option>转账</option><option>微信</option><option>支付宝</option><option>其他</option></select></div>
          <div class="fld" style="grid-column:1/-1"><label>备注</label><input id="bcCollectRemark" placeholder="如：8 月货款部分回款"></div>
        </div>
        <div class="doc-foot">
          <button class="btn" id="bcCollectCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="bcCollectSave">✔ 登记回款</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="bcOrderModal" style="display:none">
      <div class="modal" style="width:720px">
        <h3>🛒 团购下单 <span class="muted" style="font-weight:400" id="bcOrderFor"></span></h3>
        <div id="bcOrderRows" style="max-height:38vh;overflow:auto"></div>
        <div class="bar" style="margin-top:10px">
          <button class="btn sm" id="bcOrderAddRow">➕ 添加商品</button>
          <span style="flex:1"></span>
          <span class="muted" id="bcOrderTotal" style="font-size:12.5px"></span>
        </div>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label class="req">支付方式</label>
            <select id="bcOrderPay"><option value="赊账">赊账（记应收）</option><option value="预存余额">预存余额（先充值后抵扣）</option><option value="现金">现金</option><option value="微信">微信</option><option value="支付宝">支付宝</option><option value="转账">转账</option></select></div>
          <div class="fld"><label>备注</label><input id="bcOrderRemark" placeholder="订单备注（选填）"></div>
        </div>
        <div class="doc-foot">
          <button class="btn" id="bcOrderCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="bcOrderGo">✔ 提交订单</button>
        </div>
      </div>
    </div>`;

  const $ = s => view.querySelector(s);
  const state = { customers: [], curId: 0, editId: 0, tab: 'cust' };
  let custPage = 1, pricePage = 1, ordPage = 1, payPage = 1;

  /* ── 客户档案 ── */
  async function loadCustomers(keepCur = true) {
    const kw = $('#bcKw').value.trim();
    const r = await must(get(`/big-customers?keyword=${encodeURIComponent(kw)}&status=${$('#bcStatus').value}`));
    state.customers = r;
    $('#bcCount').textContent = `共 ${r.length} 位客户`;
    const opts = r.map(c => `<option value="${c.id}">${esc(c.name)}${Number(c.status) === 1 ? '' : '（停用）'}</option>`).join('');
    $('#bcPriceCust').innerHTML = '<option value="">— 选择客户 —</option>' + opts;
    $('#bcRcvCust').innerHTML = '<option value="">— 选择客户 —</option>' + opts;
    $('#bcRchCust').innerHTML = '<option value="">— 选择客户 —</option>' + opts;
    $('#bcReqCust').innerHTML = '<option value="">— 选择客户 —</option>' + opts;
    if (keepCur && state.curId) { $('#bcPriceCust').value = String(state.curId); $('#bcRcvCust').value = String(state.curId); }
    drawCustTable();
  }

  function drawCustTable() {
    const rows = state.customers;
    const pg = paginate(rows, custPage, 10);
    $('#bcCustBody').innerHTML = rows.length ? `
      <table class="tbl">
        <thead><tr>
          <th class="seq">序号</th><th>名称</th><th>联系人</th><th>电话</th><th>建档时间</th><th class="num">信用额度</th><th class="num">整单折扣</th>
          <th class="num">订单数</th><th class="num">应收合计</th><th class="num">已收</th><th class="num">未收</th>
          <th>状态</th><th style="width:230px">操作</th>
        </tr></thead>
        <tbody>${pg.slice.map((c, i) => {
          const unpaid = Math.max(0, Number(c.total_receivable) - Number(c.paid_cash) - Number(c.paid_collect));
          return `<tr data-cust="${c.id}" style="cursor:pointer" title="双击查看客户详情">
            <td class="num seq">${(custPage - 1) * 10 + i + 1}</td><td><b>${esc(c.name)}</b>${c.signature_path ? ' <span class="tag g" title="已采集电子签字">✍</span>' : ''}</td>
            <td class="muted">${esc(c.contact || '—')}</td>
            <td class="muted">${esc(c.phone || '—')}</td>
            <td class="muted">${c.created_at ? dt(c.created_at) : '—'}</td>
            <td class="num">${Number(c.credit_limit) > 0 ? money(c.credit_limit) : '不限'}</td>
            <td class="num">${(Number(c.default_discount) * 100).toFixed(0)}%</td>
            <td class="num">${c.order_count ?? 0}</td>
            <td class="num">${money(c.total_receivable)}</td>
            <td class="num">${money((Number(c.paid_cash) || 0) + (Number(c.paid_collect) || 0))}</td>
            <td class="num"><b style="color:${unpaid > 0 ? 'var(--warn)' : 'inherit'}">${money(unpaid)}</b></td>
            <td>${Number(c.status) === 1 ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
            <td style="white-space:nowrap">
              ${unpaid > 0
                ? `<button class="btn sm pri" data-collect="${c.id}">💰 收款</button>`
                : '<span class="tag g" title="无未收欠款">已结清</span>'}
              <button class="btn sm pri" data-order="${c.id}">下单</button>
              <button class="btn sm ${Number(c.status) === 1 ? 'warn' : ''}" data-toggle="${c.id}">${Number(c.status) === 1 ? '停用' : '启用'}</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>${pg.bar}` : '<div class="empty">暂无客户（点「➕ 新建客户」建档）</div>';
    bindPager($('#bcCustBody'), p => { custPage = p; drawCustTable(); });

    $('#bcCustBody').querySelectorAll('[data-order]').forEach(b => b.onclick = () => openOrder(Number(b.dataset.order)));
    // V5.0.1：收款入口（仅对有未收欠款的客户显示；编辑/预充值/专价/台账均迁入客户详情弹窗）
    $('#bcCustBody').querySelectorAll('[data-collect]').forEach(b => b.onclick = () => openCollect(Number(b.dataset.collect)));
    $('#bcCustBody').querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const c = state.customers.find(x => Number(x.id) === Number(b.dataset.toggle));
      await must(put(`/big-customers/${b.dataset.toggle}`, { status: Number(c.status) === 1 ? 0 : 1 }),
        Number(c.status) === 1 ? `已停用「${c.name}」` : `已启用「${c.name}」`);
      await loadCustomers();
    });
    // V4.14.0 C2：预充值入口
    // V4.14.0 C3：双击客户行 → 客户详情弹窗（编辑/预充值/专价/台账均在此弹窗内）
    $('#bcCustBody').querySelectorAll('tr[data-cust]').forEach(tr => tr.ondblclick = () => openCustDetail(Number(tr.dataset.cust)));
  }

  /* ── V4.14.0 C3：客户详情弹窗（基本信息/信用额度/额度余额/预存余额/应收） ── */
  async function openCustDetail(id) {
    const c = state.customers.find(x => Number(x.id) === id);
    if (!c) return;
    const unpaid = Math.max(0, Number(c.total_receivable) - Number(c.paid_cash) - Number(c.paid_collect));
    openDetailModal(`🤝 客户详情`, `
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
        <tr><td style="color:var(--muted,#8a8577)">账期</td><td>${Number(c.payment_term_months ?? 0) > 0 ? `<b>${Number(c.payment_term_months)} 个月</b>（挂账日起 ${Number(c.payment_term_months)} 个月内滚动结清，超期未收计入「已逾期」）` : '现结'}</td>
            <td style="color:var(--muted,#8a8577)">结算方式</td><td>${Number(c.payment_term_months ?? 0) > 0 ? '按账期滚动结算' : '现结（下单即收）'}</td></tr>
        <tr><td style="color:var(--muted,#8a8577)">应收合计</td><td>${money(c.total_receivable)}</td>
            <td style="color:var(--muted,#8a8577)">已收</td><td>${money((Number(c.paid_cash) || 0) + (Number(c.paid_collect) || 0))}</td></tr>
        <tr><td style="color:var(--muted,#8a8577)">状态</td><td>${Number(c.status) === 1 ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
            <td style="color:var(--muted,#8a8577)">电子签字</td>
            <td>${c.signature_path
              ? `<img src="${imgUrl(c.signature_path)}" data-zoom style="max-height:44px;border:1px dashed var(--line);border-radius:6px;cursor:zoom-in;vertical-align:middle;background:#fff" title="点击放大预览">
                 <span class="tag g" id="cdResign" style="cursor:pointer" title="点击重新采集/补签">已采集 · 点击重采</span>`
              : `<span class="tag y" id="cdResign" style="cursor:pointer" title="点击采集签字">未采集 · 点击采集</span>`}</td></tr>
      </table>
      <div class="doc-tip">💡 口径说明：额度余额 = 信用额度 − 未收应收（可继续赊账的空间）；预存余额 = 预充值未消费的金额，下单可选「预存余额」直接抵扣。删除条件：未产生业务，或已停用且最近业务超过 90 天（历史业务单据保留）。</div>
      <div class="bar" style="justify-content:flex-end;margin-top:8px;flex-wrap:wrap">
        ${unpaid > 0 ? '<button class="btn pri" id="cdGoCollect">💰 收款</button>' : ''}
        <button class="btn pri" id="cdGoRc">💰 预充值</button>
        <button class="btn" id="cdGoEdit">✏️ 编辑档案</button>
        <button class="btn" id="cdGoPrice">🏷 专价</button>
        <button class="btn" id="cdGoRcv">📋 台账</button>
        ${(Number(c.order_count) === 0 || (Number(c.status) === 0 && (!c.last_order_at || (Date.now() - new Date(c.last_order_at).getTime()) > 90 * 86400000)))
          ? '<button class="btn" id="cdGoDel" style="color:#c0392b;border-color:#e6b8b1">🗑 删除</button>' : ''}
      </div>`, { width: 720 });
    const mask = [...document.querySelectorAll('.modal-mask')].pop();
    mask.querySelector('#cdGoRc').onclick = () => { mask.remove(); openRecharge(id); };
    mask.querySelector('#cdGoEdit').onclick = () => { mask.remove(); openCust(id); };
    // V5.0.1：专价/台账/收款迁入客户详情，形成单一操作入口
    mask.querySelector('#cdGoPrice').onclick = () => { mask.remove(); gotoPrice(id); };
    mask.querySelector('#cdGoRcv').onclick = () => { mask.remove(); gotoRcv(id); };
    const cc = mask.querySelector('#cdGoCollect');
    if (cc) cc.onclick = () => { mask.remove(); openCollect(id); };
    // V5.0.2：签字预览放大 / 点击状态文字补采重采（进入编辑弹窗签字区）
    const zp = mask.querySelector('[data-zoom]');
    if (zp) zp.onclick = () => zoomImg(zp.src);
    const rs = mask.querySelector('#cdResign');
    if (rs) rs.onclick = () => { mask.remove(); openCust(id); };
    // V5.0.2：条件删除（后端二次校验）
    const dl = mask.querySelector('#cdGoDel');
    if (dl) dl.onclick = async () => {
      if (!confirm(`确认删除客户「${c.name}」？\n档案/专属价/价目申请/资金流水将清除；已有业务单据保留留痕。`)) return;
      await must(del(`/big-customers/${id}`), '客户已删除');
      mask.remove();
      await loadCustomers();
    };
  }

  /* ── V4.14.0 C2：预充值弹窗 ── */
  function openRecharge(id) {
    const c = state.customers.find(x => Number(x.id) === id);
    if (!c) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.display = 'flex';
    mask.innerHTML = `<div class="modal" style="width:420px"><h3>💰 预充值
      <span class="muted" style="font-size:12px;font-weight:400">客户：${esc(c.name)}</span></h3>
      <div class="doc-head" style="grid-template-columns:1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
        <div class="fld"><label class="req">充值金额（元）</label><input id="brcAmt" type="number" min="0.01" step="0.01"></div>
        <div class="fld"><label>收款方式</label>
          <select id="brcMethod"><option>现金</option><option>转账</option><option>微信</option><option>支付宝</option><option>其他</option></select></div>
        <div class="fld"><label>备注</label><input id="brcRemark" placeholder="如：季度备货预存款"></div>
      </div>
      <div class="doc-tip">💡 预充值先存后用：金额入客户预存余额；下单时可选「预存余额」直接抵扣，不计入应收。</div>
      <div class="doc-foot"><button class="btn" id="brcNo">取消</button><span style="flex:1"></span>
        <button class="btn pri" id="brcGo">✔ 充值</button></div></div>`;
    document.body.appendChild(mask);
    mask.querySelector('#brcNo').onclick = () => mask.remove();
    mask.querySelector('#brcGo').onclick = async () => {
      const amount = Number(mask.querySelector('#brcAmt').value);
      if (!(amount > 0)) return toast('充值金额必须大于 0', false);
      await must(post(`/big-customers/${id}/recharge`, {
        amount, method: mask.querySelector('#brcMethod').value,
        remark: mask.querySelector('#brcRemark').value.trim() || undefined,
      }), `已预充值 ${money(amount)}`);
      mask.remove();
      await loadCustomers();
    };
  }

  /* ── V5.0.1 收款闭环：对账单弹窗（打印 A5 对账单 + 确认收款终结欠款） ── */
  async function openCollect(id) {
    const c = state.customers.find(x => Number(x.id) === id);
    if (!c) return;
    const d = await must(get(`/big-customers/${id}/receivables`));
    const s = d.summary;
    if (!(s.unpaid > 0)) { toast('该客户无未收欠款', false); return; }
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="width:860px;height:min(84vh,780px);display:flex;flex-direction:column">
      <h3 style="flex:none">💰 收款 <span class="muted" style="font-size:12px;font-weight:400">客户：${esc(c.name)} · 未收欠款 <b style="color:#c0392b">${money(s.unpaid)}</b></span></h3>
      <div id="bcCollBody" style="flex:1;overflow:auto">
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px">
          <div style="flex:1;min-width:130px;padding:10px 14px;border:1px solid var(--line);border-radius:10px"><div class="muted" style="font-size:12px">应收合计</div><b>${money(s.totalReceivable)}</b></div>
          <div style="flex:1;min-width:130px;padding:10px 14px;border:1px solid var(--line);border-radius:10px"><div class="muted" style="font-size:12px">现结实收</div><b>${money(s.paidCash)}</b></div>
          <div style="flex:1;min-width:130px;padding:10px 14px;border:1px solid var(--line);border-radius:10px"><div class="muted" style="font-size:12px">回款登记</div><b>${money(s.paidCollect)}</b></div>
          <div style="flex:1;min-width:130px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;border-color:#c0392b"><div class="muted" style="font-size:12px">未收欠款</div><b style="color:#c0392b">${money(s.unpaid)}</b></div>
        </div>
        <b>未清赊账单（${(d.unpaidOrders || []).length} 单）</b>
        <table style="margin:6px 0 12px"><thead><tr><th class="seq">序号</th><th>单号</th><th>日期</th><th class="num">应付</th></tr></thead>
          <tbody>${(d.unpaidOrders || []).map((o, i) => `<tr>
            <td class="num seq">${i + 1}</td><td style="font-family:var(--mono)">${esc(o.orderNo)}</td>
            <td class="muted">${String(o.date).slice(0, 10)}</td>
            <td class="num">${money(o.amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">—</td></tr>'}</tbody></table>
        <b>应收账龄</b>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 12px">
          ${(d.aging || []).map(a => `<div style="padding:8px 14px;border:1px solid var(--line);border-radius:10px">
            <div class="muted" style="font-size:11.5px">${esc(a.bucket)}</div><b>${money(a.amount)}</b></div>`).join('')}
        </div>
        <b>近期回款记录</b>
        <table style="margin-top:6px"><thead><tr><th class="seq">序号</th><th>时间</th><th class="num">金额</th><th>方式</th><th>备注</th><th>经办</th></tr></thead>
          <tbody>${(d.payments || []).slice(0, 8).map((p, i) => `<tr>
            <td class="num seq">${i + 1}</td><td class="muted">${dt(p.created_at)}</td><td class="num">${money(p.amount)}</td>
            <td>${esc(p.method)}</td><td class="muted">${esc(p.remark || '—')}</td><td class="muted">${esc(p.operator_name || '—')}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无</td></tr>'}</tbody></table>
      </div>
      <div class="bar" style="flex:none;margin-top:10px;flex-wrap:wrap;align-items:flex-end">
        <div><div class="muted" style="font-size:11.5px;margin-bottom:3px">本次收款（元）</div>
          <input id="bcColAmt" type="number" min="0.01" step="0.01" value="${Number(s.unpaid).toFixed(2)}" style="width:130px"></div>
        <div><div class="muted" style="font-size:11.5px;margin-bottom:3px">收款方式</div>
          <select id="bcColMethod"><option>现金</option><option>转账</option><option>微信</option><option>支付宝</option><option>其他</option></select></div>
        <div style="flex:1;min-width:160px"><div class="muted" style="font-size:11.5px;margin-bottom:3px">备注（留痕）</div>
          <input id="bcColRemark" placeholder="默认：对账单结清" style="width:100%"></div>
        <button class="btn" id="bcColPrint">🖨 打印A5对账单</button>
        <button class="btn pri" id="bcColGo">✔ 确认收款</button>
      </div>
      <div class="muted" style="flex:none;font-size:11.5px;margin-top:6px">确认收款后按先进先出冲抵未清赊账单；全额收清即终结欠款状态，列表「收款」按钮随之消失。</div></div>`;
    document.body.appendChild(mask);
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    // A5 对账单打印（@page A5 单页；账单抬头+汇总+未清明细+账龄+签署栏）
    mask.querySelector('#bcColPrint').onclick = () => {
      const w = window.open('', '_blank', 'noopener,width=820,height=900');   // F-07：无需 opener
      if (!w) { toast('浏览器拦截了打印窗口，请允许弹窗', false); return; }
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>对账单 · ${esc(c.name)}</title>
        <style>
          @page { size: A5 portrait; margin: 12mm; }
          body { font: 12px/1.6 "Microsoft YaHei", sans-serif; color: #222; }
          h1 { font-size: 17px; text-align: center; margin: 0 0 2px; }
          .sub { text-align: center; color: #666; font-size: 11px; margin-bottom: 10px; }
          .meta { display: flex; flex-wrap: wrap; gap: 4px 18px; border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
          th, td { border: 1px solid #bbb; padding: 4px 7px; font-size: 11px; }
          th { background: #f2efe6; }
          .num { text-align: right; font-family: Consolas, monospace; }
          .kpis { display: flex; gap: 8px; margin-bottom: 10px; }
          .kpi { flex: 1; border: 1px solid #ccc; border-radius: 6px; padding: 6px 10px; }
          .kpi b { display: block; font-size: 14px; }
          .sign { display: flex; gap: 40px; margin-top: 26px; }
          .sign div { flex: 1; border-top: 1px solid #333; padding-top: 4px; text-align: center; color: #555; font-size: 11px; }
          @media print { .noprint { display: none } }
        </style></head><body>
        <h1>大客户对账单</h1>
        <div class="sub">打印时间 ${new Date().toLocaleString('zh-CN')} · 截至今日未清口径（回款按先进先出冲抵）</div>
        <div class="meta">
          <span>客户：<b>${esc(c.name)}</b></span><span>联系人：${esc(c.contact || '—')}</span>
          <span>电话：${esc(c.phone || '—')}</span><span>信用额度：${Number(c.credit_limit) > 0 ? money(c.credit_limit) : '不限'}</span>
        </div>
        <div class="kpis">
          <div class="kpi">应收合计<b>${money(s.totalReceivable)}</b></div>
          <div class="kpi">现结实收<b>${money(s.paidCash)}</b></div>
          <div class="kpi">回款登记<b>${money(s.paidCollect)}</b></div>
          <div class="kpi">未收欠款<b style="color:#c0392b">${money(s.unpaid)}</b></div>
        </div>
        <table><thead><tr><th class="seq">序号</th><th>单号</th><th>日期</th><th class="num">应付金额</th></tr></thead>
        <tbody>${(d.unpaidOrders || []).map((o, i) => `<tr><td class="num seq">${i + 1}</td><td>${esc(o.orderNo)}</td><td>${String(o.date).slice(0, 10)}</td><td class="num">${money(o.amount)}</td></tr>`).join('')}
        <tr><td colspan="2"><b>未清合计</b></td><td class="num"><b>${money(s.unpaid)}</b></td></tr></tbody></table>
        <table><thead><tr><th>账龄段</th><th class="num">金额</th></tr></thead>
        <tbody>${(d.aging || []).map(a => `<tr><td>${esc(a.bucket)}</td><td class="num">${money(a.amount)}</td></tr>`).join('')}</tbody></table>
        <div class="sign"><div>客户确认签字</div><div>经办人</div></div>
        <script>window.onload = () => { window.print(); };</script>
        </body></html>`);
      w.document.close();
    };
    mask.querySelector('#bcColGo').onclick = async () => {
      const amount = Number(mask.querySelector('#bcColAmt').value);
      if (!(amount > 0)) return toast('收款金额必须大于 0', false);
      await must(post(`/big-customers/${id}/collect`, {
        amount, method: mask.querySelector('#bcColMethod').value,
        remark: mask.querySelector('#bcColRemark').value.trim() || '对账单结清',
      }), `已登记收款 ${money(amount)}`);
      mask.remove();
      await loadCustomers();
      // 全额收清 → 终结欠款状态提示（FIFO 冲抵后未收为 0）
      const c2 = state.customers.find(x => Number(x.id) === id);
      const left = c2 ? Math.max(0, Number(c2.total_receivable) - Number(c2.paid_cash) - Number(c2.paid_collect)) : 0;
      toast(left <= 0.004 ? `✅ 欠款已全部结清，「${c.name}」收款闭环完成` : `仍余未收 ${money(left)}（FIFO 冲抵后）`, left <= 0.004);
    };
  }

  /* ── 客户建档/编辑 ── */
  let signDirty = false, signDataUrl = '';
  function attachSignPad() {
    const cv = $('#bcSignPad');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a1a';
    let drawing = false, moved = false;
    const pos = e => {
      const r = cv.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return [(t.clientX - r.left) * (cv.width / r.width), (t.clientY - r.top) * (cv.height / r.height)];
    };
    const start = e => { drawing = true; moved = false; ctx.beginPath(); ctx.moveTo(...pos(e)); e.preventDefault(); };
    const move = e => {
      if (!drawing) return;
      moved = true; signDirty = true;
      ctx.lineTo(...pos(e)); ctx.stroke(); e.preventDefault();
    };
    const end = () => {
      if (!drawing) return;
      drawing = false;
      if (moved) signDataUrl = cv.toDataURL('image/png');
      $('#bcSignStat').textContent = moved ? '✅ 已书写（保存档案后上传）' : '在上方手写签字；已有签字不重写则保留原样';
    };
    cv.onpointerdown = start; cv.onpointermove = move; cv.onpointerup = end; cv.onpointerleave = end;
  }
  $('#bcSignClear').onclick = () => {
    const cv = $('#bcSignPad');
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    signDirty = false; signDataUrl = '';
    $('#bcSignStat').textContent = '已清空（保存后为未签字状态）';
  };
  attachSignPad();

  function openCust(id) {
    state.editId = id;
    const c = id ? state.customers.find(x => Number(x.id) === id) : null;
    $('#bcCustTitle').textContent = c ? '✏️ 编辑客户' : '➕ 新建客户';
    $('#bcCustName').value = c?.name || '';
    $('#bcCustContact').value = c?.contact || '';
    $('#bcCustPhone').value = c?.phone || '';
    $('#bcCustCredit').value = c ? Number(c.credit_limit) : 0;
    $('#bcCustDiscount').value = c ? Number(c.default_discount) : 1;
    $('#bcCustTerm').value = c ? Number(c.payment_term_months ?? 0) : 0;
    $('#bcCustStatus').value = String(c ? Number(c.status) : 1);
    // 重置签字板（编辑已有签字客户时提示已有签字）
    const cv = $('#bcSignPad');
    if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    signDirty = false; signDataUrl = '';
    $('#bcSignStat').textContent = c?.signature_path ? '✅ 已有电子签字；重新手写并保存则替换' : '在上方手写签字；已有签字不重写则保留原样';
    $('#bcCustModal').style.display = 'flex';
    setTimeout(() => $('#bcCustName').focus(), 50);
  }
  $('#bcNew').onclick = () => openCust(0);
  $('#bcCustCancel').onclick = () => { $('#bcCustModal').style.display = 'none'; };
  $('#bcCustSave').onclick = async () => {
    const body = {
      name: $('#bcCustName').value.trim(),
      contact: $('#bcCustContact').value.trim() || undefined,
      phone: $('#bcCustPhone').value.trim() || undefined,
      creditLimit: Number($('#bcCustCredit').value) || 0,
      defaultDiscount: Number($('#bcCustDiscount').value) || 1,
      paymentTermMonths: Math.max(0, Math.min(36, Math.round(Number($('#bcCustTerm').value) || 0))),
      status: Number($('#bcCustStatus').value),
    };
    if (!body.name) return toast('客户名称必填', false);
    let savedId = state.editId;
    if (state.editId) await must(put(`/big-customers/${state.editId}`, body), '客户档案已更新');
    else { const d = await must(post('/big-customers', body), '客户已建档'); savedId = d.id; }
    // V4.14.0 C1：新写字签字随档案保存上传
    if (signDirty && signDataUrl && savedId) {
      try { await must(post(`/big-customers/${savedId}/signature`, { signature: signDataUrl }), '');
        toast('客户档案已更新（含电子签字）');
      } catch { toast('签字上传失败，可重新编辑后再试', false); }
    }
    $('#bcCustModal').style.display = 'none';
    await loadCustomers();
  };

  /* ── 专属价目 ── */
  const priceRows = [];
  function addPriceRow() {
    const row = document.createElement('div');
    row.className = 'bar';
    row.style.cssText = 'padding:8px 14px;border:1px dashed var(--line);border-radius:10px;margin-bottom:8px';
    row.innerHTML = `
      <input class="bc-ps" placeholder="商品（条码/名称/拼音）" style="flex:1;min-width:200px">
      <input class="bc-price" type="number" min="0.01" step="0.01" placeholder="专价" style="width:90px">
      <input class="bc-valid" type="date" title="有效期至（留空=长期）" style="width:130px">
      <span class="muted" style="font-size:11px;width:110px"></span>
      <button class="btn sm" data-rm>移除</button>`;
    row.querySelector('[data-rm]').onclick = () => { row.remove(); priceRows.splice(priceRows.indexOf(row), 1); };
    attachProductSearch(row.querySelector('.bc-ps'), {
      placeholder: '商品（条码/名称/拼音）',
      onPick: p => { row.dataset.pid = p.id; row.querySelector('.bc-price').value = p.sell_price;
        row.querySelector('.muted').textContent = `零售 ¥${Number(p.sell_price).toFixed(2)}`; },
    });
    $('#bcPriceRows').appendChild(row);
    priceRows.push(row);
  }
  $('#bcPriceAddRow').onclick = () => addPriceRow();

  async function gotoPrice(id) {
    switchTab('price');
    state.curId = id;
    $('#bcPriceCust').value = String(id);
    await loadPriceList();
  }
  $('#bcPriceLoad').onclick = () => { state.curId = Number($('#bcPriceCust').value) || 0; if (state.curId) loadPriceList(); };

  async function loadPriceList() {
    const c = state.customers.find(x => Number(x.id) === Number(state.curId));
    if (!c) { $('#bcPriceList').innerHTML = '<div class="empty">先选择客户</div>'; $('#bcPriceHint').textContent = ''; return; }
    $('#bcPriceHint').textContent = `客户：${c.name} · 整单折扣 ${(Number(c.default_discount) * 100).toFixed(0)}%`;
    const d = await must(get(`/big-customers/${state.curId}/prices`));
    const pg = paginate(d.items || [], pricePage, 10);
    $('#bcPriceList').innerHTML = d.count ? `
      <div style="margin:6px 0 4px"><b>当前生效专价（${d.count} 条）</b></div>
      <table class="tbl">
        <thead><tr><th class="seq">序号</th><th>商品</th><th>条码</th><th class="num">零售价</th><th class="num">专价</th><th>有效期至</th><th style="width:90px">操作</th></tr></thead>
        <tbody>${pg.slice.map((p, i) => `<tr>
          <td class="num seq">${(pricePage - 1) * 10 + i + 1}</td><td>${esc(p.name)}</td><td class="muted">${esc(p.barcode || '—')}</td>
          <td class="num">${money(p.sell_price)}</td>
          <td class="num"><b style="color:var(--pri)">${money(p.price)}</b></td>
          <td class="muted">${p.valid_to ? String(p.valid_to).slice(0, 10) : '长期'}</td>
          <td><button class="btn sm" data-pdel="${p.product_id}">移除</button></td>
        </tr>`).join('')}</tbody>
      </table>${pg.bar}` : '<div class="empty">该客户暂无生效专价（下方添加设价行后保存）</div>';
    bindPager($('#bcPriceList'), p => { pricePage = p; loadPriceList(); });
    $('#bcPriceList').querySelectorAll('[data-pdel]').forEach(b => b.onclick = async () => {
      const pid = Number(b.dataset.pdel);
      const target = d.items.find(x => Number(x.product_id) === pid);
      await must(put(`/big-customers/${state.curId}/prices`,
        { items: [{ productId: pid, price: Number(target.price), validTo: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }] }),
        '专价已移除');
      await loadPriceList();
    });
  }

  $('#bcPriceSave').onclick = async () => {
    if (!state.curId) return toast('请先选择客户', false);
    const items = [];
    for (const row of priceRows) {
      if (!row.dataset.pid) continue;
      const price = Number(row.querySelector('.bc-price').value);
      if (!(price > 0)) return toast('设价行缺少有效专价', false);
      items.push({ productId: Number(row.dataset.pid), price, validTo: row.querySelector('.bc-valid').value || undefined });
    }
    if (!items.length) return toast('至少一条设价记录', false);
    await must(put(`/big-customers/${state.curId}/prices`, { items }), `已保存 ${items.length} 条专价`);
    $('#bcPriceRows').innerHTML = ''; priceRows.length = 0;
    await loadPriceList();
  };

  /* ── 应收台账 ── */
  async function gotoRcv(id) {
    switchTab('rcv');
    state.curId = id;
    $('#bcRcvCust').value = String(id);
    await loadRcv();
  }
  $('#bcRcvCust').onchange = () => { state.curId = Number($('#bcRcvCust').value) || 0; if (state.curId) loadRcv(); };
  $('#bcRcvRefresh').onclick = () => { if (state.curId) loadRcv(); };

  async function loadRcv() {
    const c = state.customers.find(x => Number(x.id) === Number(state.curId));
    if (!c) { $('#bcRcvKpi').innerHTML = ''; $('#bcRcvAging').innerHTML = ''; $('#bcRcvOrders').innerHTML = ''; $('#bcRcvPay').innerHTML = '<div class="empty">先选择客户</div>'; return; }
    const d = await must(get(`/big-customers/${state.curId}/receivables`));
    const s = d.summary;
    const limitCls = s.limitUsed >= 80 ? 'r' : s.limitUsed >= 50 ? 'o' : 'g';
    const kpi = (label, val, sub = '', cls = '') => `<div style="flex:1;min-width:130px;padding:12px 16px;border:1px solid var(--line);border-radius:12px">
      <div class="muted" style="font-size:12px">${label}</div>
      <div style="font-size:19px;font-weight:800;margin-top:2px" class="${cls}">${val}</div>
      <div style="font-size:11.5px" class="muted">${sub}</div></div>`;
    $('#bcRcvKpi').innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px">
      ${kpi('订单数', s.orderCount, `信用额度 ${Number(s.creditLimit) > 0 ? money(s.creditLimit) : '不限'}`)}
      ${kpi('应收合计', money(s.totalReceivable), '已完成团购单应付合计')}
      ${kpi('现结实收', money(s.paidCash), '下单即收（非赊账）')}
      ${kpi('回款登记', money(s.paidCollect), '赊账后登记到账')}
      ${kpi('未收金额', money(s.unpaid), Number(s.creditLimit) > 0 ? `额度使用 ${s.limitUsed}%` : '', s.unpaid > 0 ? 'o' : 'g')}
      ${Number(s.creditLimit) > 0 ? `<div style="flex:1;min-width:200px;padding:12px 16px;border:1px solid var(--line);border-radius:12px">
        <div class="muted" style="font-size:12px">额度使用</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
          <div style="flex:1;height:8px;border-radius:99px;background:var(--line-2);overflow:hidden">
            <div style="width:${s.limitUsed}%;height:100%;background:${s.limitUsed >= 80 ? 'var(--err)' : s.limitUsed >= 50 ? 'var(--warn)' : 'var(--pri)'}"></div>
          </div>
          <b class="${limitCls}">${s.limitUsed}%</b>
        </div></div>` : ''}
    </div>`;

    const agingMax = Math.max(...d.aging.map(a => Number(a.amount)), 1);
    $('#bcRcvAging').innerHTML = `
      <div style="margin:8px 0 4px"><b>应收账龄</b> <span class="muted" style="font-size:11.5px">未收 ${money(s.unpaid)} 元按赊账单逐单冲抵分段</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${d.aging.map(a => `<div style="flex:1;min-width:120px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--paper-2)">
          <div class="muted" style="font-size:11.5px">${a.bucket}</div>
          <b style="font-size:15px">${money(a.amount)}</b>
          <div style="height:5px;border-radius:99px;background:var(--line-2);overflow:hidden;margin-top:4px">
            <div style="width:${Math.round(Number(a.amount) / agingMax * 100)}%;height:100%;background:${a.bucket.includes('>90') ? 'var(--err)' : a.bucket.includes('60') ? 'var(--warn)' : 'var(--pri)'}"></div>
          </div>
        </div>`).join('')}
      </div>`;

    const pgO = paginate(d.unpaidOrders, ordPage, 10);
    $('#bcRcvOrders').innerHTML = d.unpaidOrders.length ? `
      <div style="margin:8px 0 4px"><b>未清赊账单（${d.unpaidOrders.length} 单，按账龄冲抵）</b></div>
      <table class="tbl">
        <thead><tr><th class="seq">序号</th><th>单号</th><th>日期</th><th class="num">应付</th><th class="num">本单未清</th></tr></thead>
        <tbody>${pgO.slice.map((o, i) => `<tr>
          <td class="num seq">${(ordPage - 1) * 10 + i + 1}</td><td style="font-family:var(--mono);font-weight:600">${esc(o.orderNo)}</td>
          <td class="muted">${String(o.date).slice(0, 10)}</td>
          <td class="num">${money(o.amount)}</td>
          <td class="num"><b style="color:var(--warn)">${money(o.amount)}</b></td>
        </tr>`).join('')}</tbody>
      </table>${pgO.bar}` : '<div class="empty" style="margin-top:8px">暂无未清赊账单</div>';
    bindPager($('#bcRcvOrders'), p => { ordPage = p; loadRcv(); });

    const pgP = paginate(d.payments, payPage, 10);
    $('#bcRcvPay').innerHTML = d.payments.length ? `
      <div style="margin:8px 0 4px"><b>回款记录</b></div>
      <table class="tbl">
        <thead><tr><th class="seq">序号</th><th>时间</th><th class="num">金额</th><th>方式</th><th>备注</th><th>经办</th></tr></thead>
        <tbody>${pgP.slice.map((p, i) => `<tr>
          <td class="num seq">${(payPage - 1) * 10 + i + 1}</td><td class="muted">${dt(p.created_at)}</td>
          <td class="num"><b>${money(p.amount)}</b></td>
          <td>${esc(p.method)}</td>
          <td class="muted">${esc(p.remark || '—')}</td>
          <td class="muted">${esc(p.operator_name || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>${pgP.bar}` : '<div class="empty" style="margin-top:8px">暂无回款记录</div>';
    bindPager($('#bcRcvPay'), p => { payPage = p; loadRcv(); });
  }

  /* ── 回款登记 ── */
  $('#bcCollect').onclick = () => {
    const c = state.customers.find(x => Number(x.id) === Number(state.curId));
    if (!c) return toast('请先在应收台账选择客户', false);
    $('#bcCollectFor').textContent = `· ${c.name}`;
    $('#bcCollectAmount').value = '';
    $('#bcCollectRemark').value = '';
    $('#bcCollectModal').style.display = 'flex';
    setTimeout(() => $('#bcCollectAmount').focus(), 50);
  };
  $('#bcCollectCancel').onclick = () => { $('#bcCollectModal').style.display = 'none'; };
  $('#bcCollectSave').onclick = async () => {
    const amount = Number($('#bcCollectAmount').value);
    if (!(amount > 0)) return toast('回款金额必须大于 0', false);
    await must(post(`/big-customers/${state.curId}/collect`, {
      amount, method: $('#bcCollectMethod').value,
      remark: $('#bcCollectRemark').value.trim() || undefined,
    }), `已登记回款 ${money(amount)}`);
    $('#bcCollectModal').style.display = 'none';
    await loadRcv(); await loadCustomers();
  };

  /* ── 团购下单 ── */
  const orderRows = [];
  function addOrderRow() {
    const row = document.createElement('div');
    row.className = 'bar';
    row.style.cssText = 'padding:8px 12px;border:1px dashed var(--line);border-radius:10px;margin-bottom:8px';
    row.innerHTML = `
      <input class="bc-ops" placeholder="商品（条码/名称/拼音）" style="flex:1;min-width:200px">
      <input class="bc-qty" type="number" min="0.001" step="1" value="1" style="width:80px" title="数量">
      <span class="muted" style="font-size:11px;width:130px"></span>
      <button class="btn sm" data-rm>移除</button>`;
    row.querySelector('[data-rm]').onclick = () => { row.remove(); orderRows.splice(orderRows.indexOf(row), 1); updateOrderTotal(); };
    attachProductSearch(row.querySelector('.bc-ops'), {
      placeholder: '商品（条码/名称/拼音）',
      onPick: p => { row.dataset.pid = p.id; row.querySelector('.muted').textContent = `零售 ¥${Number(p.sell_price).toFixed(2)}`; },
    });
    row.querySelector('.bc-qty').addEventListener('input', updateOrderTotal);
    $('#bcOrderRows').appendChild(row);
    orderRows.push(row);
  }
  function updateOrderTotal() {
    const n = orderRows.filter(r => r.dataset.pid && Number(r.querySelector('.bc-qty').value) > 0).length;
    $('#bcOrderTotal').textContent = n ? `已选 ${n} 种商品（提交后服务端计价）` : '';
  }
  $('#bcOrderAddRow').onclick = () => addOrderRow();

  function openOrder(id) {
    const c = state.customers.find(x => Number(x.id) === Number(id));
    if (!c) return;
    if (Number(c.status) !== 1) return toast(`客户「${c.name}」已停用，无法下单`, false);
    $('#bcOrderFor').textContent = `整单折扣 ${(Number(c.default_discount) * 100).toFixed(0)}%`;
    $('#bcOrderRows').innerHTML = ''; orderRows.length = 0;
    $('#bcOrderRemark').value = '';
    updateOrderTotal();
    $('#bcOrderModal').style.display = 'flex';
    addOrderRow();
  }
  $('#bcOrderCancel').onclick = () => { $('#bcOrderModal').style.display = 'none'; };
  $('#bcOrderGo').onclick = async () => {
    const items = [];
    for (const row of orderRows) {
      const qty = Number(row.querySelector('.bc-qty').value);
      if (row.dataset.pid && qty > 0) items.push({ productId: Number(row.dataset.pid), qty });
    }
    if (!items.length) return toast('请至少添加一件商品', false);
    const d = await must(post(`/big-customers/${state.curId}/order`, {
      items, payChannel: $('#bcOrderPay').value, remark: $('#bcOrderRemark').value.trim() || undefined,
    }), `下单成功：${d.orderNo} 应付 ${money(d.payable)}`);
    $('#bcOrderModal').style.display = 'none';
    await loadCustomers();
    if ($('#bcTabRcv').style.display !== 'none') await loadRcv();
  };

  /* ── 价申请 ── */
  const chain = { isHq: false, enabled: false };
  (async () => {
    try {
      const me = await must(get('/auth/me'));
      chain.isHq = !!me.hq;
      const cfg = await get('/settings/chain.enabled').catch(() => null);
      const on = cfg && cfg.data && (cfg.data.value === true || String(cfg.data.value) === 'true');
      chain.enabled = !!on || !!chain.isHq;
    } catch { chain.enabled = false; }
    // 连锁门店：专属价直设禁用（定价权归总部），引导走「价申请」
    if (chain.enabled && !chain.isHq) {
      const banner = $('#bcReqBanner');
      if (banner) banner.innerHTML = `<div class="doc-tip" style="margin-bottom:8px">ℹ️ 连锁模式下专属价由总部统一管理：下方提交申请，总部审批通过后自动生效。批发价由总部在商品档案统一维护。</div>`;
      const save = $('#bcPriceSave');
      if (save) { save.disabled = true; save.title = '连锁模式：请走「价申请」提交总部审批'; }
      const hint = $('#bcPriceHint');
      if (hint) hint.textContent = '连锁模式：直设已禁用，请走「价申请」';
    }
  })();

  let reqPage = 1;
  attachProductSearch($('#bcReqProd'), {
    placeholder: '商品（条码/名称/拼音）',
    onPick: p => { $('#bcReqProd').dataset.pid = p.id;
      $('#bcReqProd').value = p.name;
      $('#bcReqProd').dataset.ref = `零售 ¥${Number(p.sell_price).toFixed(2)}${Number(p.wholesale_price) > 0 ? ` · 批发 ¥${Number(p.wholesale_price).toFixed(2)}` : ''}`;
      $('#bcReqHint').textContent = $('#bcReqProd').dataset.ref || ''; },
  });
  $('#bcReqGo').onclick = async () => {
    const customerId = Number($('#bcReqCust').value);
    const productId = Number($('#bcReqProd').dataset.pid);
    const reqPrice = Number($('#bcReqPrice').value);
    if (!customerId) return toast('请选择客户', false);
    if (!productId) return toast('请选择商品', false);
    if (!(reqPrice > 0)) return toast('申请价必须大于 0', false);
    const d = await must(post('/bc-price-requests', {
      customerId, productId, reqPrice,
      reason: $('#bcReqReason').value.trim() || undefined,
    }), `申请已提交：${d.reqNo}（待总部审批）`);
    $('#bcReqPrice').value = ''; $('#bcReqReason').value = '';
    delete $('#bcReqProd').dataset.pid;
    await loadRequests();
  };
  async function loadRequests() {
    const st = $('#bcReqStatus').value;
    const d = await must(get(`/bc-price-requests?status=${st}&page=${reqPage}&size=15`));
    const items = d.items || [];
    const stTag = s => s === 'pending' ? '<span class="tag y">待审批</span>'
      : s === 'approved' ? '<span class="tag g">已通过</span>' : '<span class="tag r">已驳回</span>';
    $('#bcReqList').innerHTML = items.length ? `
      <table class="tbl">
        <thead><tr><th class="seq">序号</th><th>单号</th><th>门店</th><th>客户</th><th>商品</th>
          <th class="num">申请价</th><th class="num">零售参考</th><th>原因</th><th>状态</th>
          <th class="num">批准价</th><th>审批备注</th>${(chain.isHq || !chain.enabled) ? '<th style="width:150px">操作</th>' : ''}</tr></thead>
        <tbody>${items.map((r, i) => `<tr>
          <td class="num seq">${(reqPage - 1) * 15 + i + 1}</td><td style="font-family:var(--mono)">${esc(r.req_no)}</td>
          <td class="muted">${esc(r.store_name || '—')}</td>
          <td>${esc(r.customer_name || '—')}</td>
          <td>${esc(r.product_name || '—')}</td>
          <td class="num"><b>${money(r.req_price)}</b></td>
          <td class="num muted">${money(r.base_price)}</td>
          <td class="muted">${esc(r.reason || '—')}</td>
          <td>${stTag(r.status)}</td>
          <td class="num">${r.approved_price ? `<b style="color:var(--pri)">${money(r.approved_price)}</b>` : '—'}</td>
          <td class="muted">${esc(r.audit_remark || '—')}</td>
          ${(chain.isHq || !chain.enabled) && r.status === 'pending'
            ? `<td><button class="btn sm pri" data-req-ok="${r.id}" data-price="${r.req_price}">✔ 通过</button>
               <button class="btn sm warn" data-req-no="${r.id}">✖ 驳回</button></td>`
            : (chain.isHq || !chain.enabled) ? '<td>—</td>' : ''}</tr>`).join('')}</tbody>
      </table>` : '<div class="empty">暂无申请记录</div>';
    $('#bcReqList').querySelectorAll('[data-req-ok]').forEach(b => b.onclick = async () => {
      await must(post(`/bc-price-requests/${b.dataset.reqOk}/audit`,
        { approve: true, approvedPrice: Number(b.dataset.price) }), '已通过，价目已生效');
      await loadRequests();
    });
    $('#bcReqList').querySelectorAll('[data-req-no]').forEach(b => b.onclick = async () => {
      const remark = prompt('驳回原因（可留空）：') ?? '';
      await must(post(`/bc-price-requests/${b.dataset.reqNo}/audit`, { approve: false, remark: remark.trim() || undefined }), '已驳回');
      await loadRequests();
    });
  }
  $('#bcReqStatus').onchange = () => { reqPage = 1; loadRequests(); };
  $('#bcReqRefresh').onclick = () => loadRequests();

  /* ── Tab 切换 ── */
  function switchTab(tab) {
    state.tab = tab;
    view.querySelectorAll('.segbtn[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('#bcTabCust').style.display = tab === 'cust' ? '' : 'none';
    $('#bcTabPrice').style.display = tab === 'price' ? '' : 'none';
    $('#bcTabReq').style.display = tab === 'req' ? '' : 'none';
    $('#bcTabRcv').style.display = tab === 'rcv' ? '' : 'none';
    $('#bcTabRch').style.display = tab === 'rch' ? '' : 'none';
    if (tab === 'rch') loadRch();
  }

  /* ── V5.0.2 充值明细 ── */
  async function loadRch() {
    const id = Number($('#bcRchCust').value) || 0;
    const box = $('#bcRchList');
    if (!id) { box.innerHTML = '<div class="empty">先选择客户</div>'; return; }
    const rows = await must(get(`/big-customers/${id}/recharges?keyword=${encodeURIComponent($('#bcRchKw').value.trim())}`)).catch(() => []);
    box.innerHTML = rows.length ? `<table><thead><tr><th class="seq">序号</th><th>充值时间</th><th class="num">金额</th><th>方式</th><th>备注</th><th>经办</th></tr></thead>
      <tbody>${rows.map((p, i) => `<tr>
        <td class="num seq">${i + 1}</td><td class="muted">${dt(p.created_at)}</td>
        <td class="num"><b style="color:var(--pri)">${money(p.amount)}</b></td>
        <td>${esc(p.method)}</td>
        <td class="muted">${esc(p.remark || '—')}</td>
        <td class="muted">${esc(p.operator_name || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">暂无充值记录</div>';
  }
  $('#bcRchCust').onchange = loadRch;
  $('#bcRchRefresh').onclick = loadRch;
  $('#bcRchKw').addEventListener('keydown', e => { if (e.key === 'Enter') loadRch(); });
  view.querySelectorAll('.segbtn[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

  /* ── 查询 ── */
  $('#bcGo').onclick = () => loadCustomers(false);
  $('#bcKw').addEventListener('keydown', e => { if (e.key === 'Enter') loadCustomers(false); });

  await loadCustomers();
  await loadRequests();
}
