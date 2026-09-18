import { get, post, must, money, esc, dt, toast, API, unwrap } from '../api.js';
import { signCell, signBtn, handleSignInfo, mountSignActions, openSignPad } from './signpad.js';
import { openA5Print, autoPrintA5AfterAudit, canPrintA5 } from '../docprint.js';
import { paginate, bindPager } from '../common-ui.js';
import { anchorNav } from '../ui-polish.js';   // V4.26.4 长页面锚点导航

/** 库存作业（盘点任务 / 报损 / 调拨，后端 /inventory/count-tasks|counts|losses|transfers）
 *  · V4.15.7 P3：三张单（报损/盘点/调拨）接入 A5 统一打印——详情弹窗打印 + 列表勾选批量 + 审核后自动弹 */

const REASON_TYPES = ['损耗', '过期', '破损', '质量问题'];
const TAG = { 进行中: 'b', 待审核: 'y', 待确认: 'y', 已审核: 'g', 已入库: 'g', 已完成: 'g', 已取消: 'r', 待执行: 'b', 执行中: 'o', 待发货: 'b', 在途: 'o', 驳回: 'r' };

export async function render(view, opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const curType = opts.type || 'count';   // count | loss | transfer（由左侧树形菜单第三级传入）
  const canCountAudit = (API.user?.perms || []).includes('stock.count.audit') || (API.user?.perms || []).includes('stock.count.task');
  const canLoss = (API.user?.perms || []).includes('stock.loss.create');
  const canTransfer = (API.user?.perms || []).includes('stock.transfer');
  // V5.0.0 批次6（R5）：跨店调拨总部唯一审核；前端按钮只是体验，服务端有权限闸
  const canTransferAudit = (API.user?.perms || []).includes('hq.stock.transfer.audit');

  view.innerHTML = `
    <div id="tab-count">
      <div class="card page-new" style="display:none">
        <div class="doc-tools">
          <button class="btn" data-backlist="count">← 返回列表</button>
          <span style="font-weight:700;font-size:14.5px">📝 创建盘点任务</span>
          <span class="pill o" id="skStat">新建</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn pri" id="skSave">💾 创建盘点任务</button>
          </span>
        </div>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr))">
          <div class="fld"><label>任务名称</label><input id="skName" placeholder="如：水饮周盘"></div>
          <div class="fld"><label>盘点范围</label><select id="skScope"><option>全仓</option><option>按分类</option><option>按供应商</option></select></div>
          <div class="fld"><label>指派店员</label><select id="skAssignee"><option value="">— 待指派 —</option></select></div>
          <div class="fld"><label>截止日期</label><input id="skDue" type="date"></div>
        </div>
        <div class="doc-head" id="skSupplierRow" style="display:none;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))">
          <div class="fld"><label class="req">供应商</label><input id="skSupplier" list="skSupDl7" placeholder="输入名称快速匹配" style="width:100%"><datalist id="skSupDl7"></datalist></div>
        </div>
        <div id="skCatsBox" style="display:none;padding:4px 18px 10px">
          <label style="font-size:12.5px;color:var(--ink-2)">盘点品类（可多选，含子分类）</label>
          <div id="skCats" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px"></div>
        </div>
        <div class="doc-head" style="grid-template-columns:1fr">
          <div class="fld"><label>备注</label><input id="skMemo" placeholder="备注（选填）"></div>
        </div>
        <div class="doc-tip">💡 创建任务后，被指派店员在手机端「工作台 → 盘点任务」按分类逐项实盘提交；全部录完后在此「审核」生成盘点单，差异按 FIFO 生效。</div>
      </div>
      <div class="card page-list" style="padding-bottom:14px">
        <div class="doc-tools">
          <span style="font-weight:700;font-size:14.5px">🗂️ 盘点任务列表</span>
          <input id="skKw" placeholder="🔍 任务号 / 任务名称" style="width:180px">
          <button class="btn pri" id="skGo">🔍 查询</button>
          <button class="btn" id="skRefresh">刷新</button>
          <button class="btn pri" data-newdoc="count">＋ 新增盘点任务</button>
          <span style="margin-left:auto">
            <select id="skQStatus"><option value="">全部状态</option><option>待执行</option><option>执行中</option><option>待审核</option><option>已完成</option></select>
          </span>
        </div>
        <div class="tbl-min pg-host" style="padding:10px 18px" id="skList"></div>
      </div>
      <div class="card page-list" style="padding-bottom:14px">
        <div class="doc-tools">
          <span style="font-weight:700;font-size:14.5px">📝 盘点单据（任务审核生成 / 手工直录）</span>
          <input id="ctKw" placeholder="🔍 盘点单号 / 范围" style="width:170px">
          <button class="btn pri" id="ctGo">🔍 查询</button>
          <button class="btn" id="ctRefresh">刷新</button>
          <button class="btn" id="ctPrints" style="display:none">🖨 打印所选(<b id="ctPrN">0</b>)</button>
          <span style="margin-left:auto">
            <input id="ctFrom" type="date" value="${today.slice(0, 8)}01"><span style="color:var(--ink-3)">~</span><input id="ctTo" type="date" value="${today}">
            <select id="ctQStatus"><option value="">全部状态</option><option>进行中</option><option>已审核</option></select>
          </span>
        </div>
        <div class="tbl-min pg-host" style="padding:10px 18px" id="ctList"></div>
      </div>
    </div>

    <div id="tab-loss" style="display:none">
      <div class="card page-new" style="display:none">
        <div class="doc-tools">
          <button class="btn" data-backlist="loss">← 返回列表</button>
          <span style="font-weight:700;font-size:14.5px">📷 新建报损单</span>
          <span class="pill o" id="lsStat">录入中</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn" id="lsAddRow">➕ 添加行</button>
            <button class="btn" id="lsReset">重录</button>
            <button class="btn pri" id="lsSave">💾 保存报损单</button>
          </span>
        </div>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
          <div class="fld"><label class="req">原因类型</label><select id="lsReason">${REASON_TYPES.map(r => `<option>${r}</option>`).join('')}</select></div>
          <div class="fld"><label>备注</label><input id="lsMemo" placeholder="备注（选填）"></div>
        </div>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
          <div class="fld">
            <label class="req">报损照片（拍摄或选择，≥1 张）</label>
            <input id="lsPhotoFile" type="file" accept="image/*" capture="environment" style="padding:6px">
          </div>
          <div class="fld" style="display:flex;align-items:center;gap:10px">
            <img id="lsPhotoPrev" style="display:none;max-height:64px;border-radius:8px;border:1px solid var(--line)">
            <span class="muted" id="lsPhotoTip" style="font-size:12px">未上传照片</span>
          </div>
        </div>
        <div class="doc-grid" style="padding:6px 18px 4px">
          <table>
            <thead><tr><th style="width:44px">序号</th><th style="min-width:220px">商品（行内直选）</th><th>单位</th>
              <th style="width:130px">数量</th><th style="width:50px">操作</th></tr></thead>
            <tbody id="lsLines"><tr><td colspan="5" class="empty">空单：点「➕ 添加行」添加明细（批次自动归属：临期优先）</td></tr></tbody>
            <tfoot><tr><td colspan="3">合计</td><td class="num" id="lsSumQty">0</td><td></td></tr></tfoot>
          </table>
        </div>
        <div class="doc-tip">💡 照片直接拍摄/上传（留存证据链）；保存后须操作员电子签名，审核通过即扣减对应批次与库存。</div>
      </div>
      <div class="card page-list" style="padding-bottom:14px">
        <div class="doc-tools">
          <span style="font-weight:700;font-size:14.5px">📋 报损单据</span>
          <input id="lsKw" placeholder="🔍 报损单号 / 原因" style="width:170px">
          <button class="btn pri" id="lsGo">🔍 查询</button>
          <button class="btn" id="lsRefresh">刷新</button>
          <button class="btn" id="lsPrints" style="display:none">🖨 打印所选(<b id="lsPrN">0</b>)</button>
          <button class="btn pri" data-newdoc="loss">＋ 新增报损单</button>
          <span style="margin-left:auto">
            <input id="lsFrom" type="date" value="${today.slice(0, 8)}01"><span style="color:var(--ink-3)">~</span><input id="lsTo" type="date" value="${today}">
            <select id="lsQStatus"><option value="">全部状态</option><option>待审核</option><option>已审核</option></select>
          </span>
        </div>
        <div class="tbl-min pg-host" style="padding:10px 18px" id="lsList"></div>
      </div>
    </div>

    <div id="tab-transfer" style="display:none">
      <div class="card page-new" style="display:none">
        <div class="doc-tools">
          <button class="btn" data-backlist="transfer">← 返回列表</button>
          <span style="font-weight:700;font-size:14.5px">🔄 新建调拨单</span>
          <span class="pill o" id="trStat">录入中</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn" id="trAddRow">➕ 添加行</button>
            <button class="btn" id="trReset">重录</button>
            <button class="btn pri" id="trSave">💾 保存调拨单</button>
          </span>
        </div>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
          <div class="fld"><label class="req">调出门店</label><select id="trFromStore"></select></div>
          <div class="fld"><label class="req">调入门店</label><select id="trToStore"></select></div>
          <div class="fld"><label>调拨原因</label><input id="trReason" placeholder="原因（选填）"></div>
        </div>
        <div class="doc-grid" style="padding:6px 18px 4px">
          <table>
            <thead><tr><th style="width:44px">序号</th><th style="min-width:220px">商品（行内直选）</th><th>单位</th>
              <th style="width:130px">数量</th><th style="width:50px">操作</th></tr></thead>
            <tbody id="trLines"><tr><td colspan="5" class="empty">空单：点「➕ 添加行」添加明细（批次整体转移，成本不变）</td></tr></tbody>
            <tfoot><tr><td colspan="3">合计</td><td class="num" id="trSumQty">0</td><td></td></tr></tfoot>
          </table>
        </div>
        <div class="doc-tip">💡 调出/调入门店均下拉选择；保存后操作员电子签名，确认执行时扣源批次并生成转入批次，库存流水双边记账。</div>
      </div>
      <div class="card page-list" style="padding-bottom:14px">
        <div class="doc-tools">
          <span style="font-weight:700;font-size:14.5px">📋 调拨单据</span>
          <input id="trKw" placeholder="🔍 调拨单号 / 原因" style="width:170px">
          <button class="btn pri" id="trGo">🔍 查询</button>
          <button class="btn" id="trRefresh">刷新</button>
          <button class="btn" id="trPrints" style="display:none">🖨 打印所选(<b id="trPrN">0</b>)</button>
          <button class="btn pri" data-newdoc="transfer">＋ 新增调拨单</button>
          <span style="margin-left:auto">
            <input id="trFrom" type="date" value="${today.slice(0, 8)}01"><span style="color:var(--ink-3)">~</span><input id="trTo" type="date" value="${today}">
            <select id="trQStatus"><option value="">全部状态</option><option>待确认</option><option>待审核</option><option>待发货</option><option>在途</option><option>驳回</option><option>已入库</option><option>已取消</option></select>
          </span>
        </div>
        <div class="tbl-min pg-host" style="padding:10px 18px" id="trList"></div>
      </div>
    </div>

    <div class="modal-mask" id="opsModal" style="display:none">
      <div class="modal" style="width:760px">
        <h3 id="opsTitle">单据明细</h3>
        <div id="opsMeta" style="font-size:12.5px;line-height:1.9;color:var(--ink-2);margin:6px 0 10px"></div>
        <div style="max-height:46vh;overflow:auto" id="opsItems"></div>
        <div class="doc-foot">
          <span style="flex:1"></span>
          <button class="btn" id="opsPrint">🖨 打印单据 A5</button>
        </div>
      </div>
    </div>`;

  /* ── 分页式：类型由左侧菜单第三级进入，每类内 列表页 ⇄ 新增页 ── */
  const PAGES = { count: 'tab-count', loss: 'tab-loss', transfer: 'tab-transfer' };
  const show = (type, mode) => {
    Object.entries(PAGES).forEach(([k, id]) => view.querySelector('#' + id).style.display = k === type ? '' : 'none');
    const box = view.querySelector('#' + PAGES[type]);
    box.querySelectorAll('.page-new').forEach(el => el.style.display = mode === 'new' ? '' : 'none');
    box.querySelectorAll('.page-list').forEach(el => el.style.display = mode === 'new' ? 'none' : '');
    // V4.26.4：锚点胶囊条只在「盘点（count）· 列表模式」下有意义（该页两节列表），其余情况隐藏
    const ab = view.querySelector(':scope > .anchors');
    if (ab) ab.style.display = (type === 'count' && mode === 'list') ? '' : 'none';
    if (mode === 'list') {
      if (type === 'count') { loadTasks(); loadCounts(); }
      if (type === 'loss') loadLosses();
      if (type === 'transfer') loadTransfers();
    }
  };
  view.querySelectorAll('[data-newdoc]').forEach(b => b.onclick = () => show(b.dataset.newdoc, 'new'));
  view.querySelectorAll('[data-backlist]').forEach(b => b.onclick = () => show(b.dataset.backlist, 'list'));

  /* ── 基础数据（商品/员工/品类/供应商/门店）——加载失败不阻断页面绑定
      V4.9.7 修复：供应商走 /purchase/suppliers；品类走 /products/categories（含子级树，扁平化） ── */
  let products = [], staff = [], cats = [], suppliers = [], stores = [];
  const one = async (url, key) => {
    try { const d = unwrap(await get(url)); return Array.isArray(d) ? d : (d[key] || d.items || []); }
    catch { return []; }
  };
  [products, staff, stores] = await Promise.all([
    one('/products?size=200', 'items'),
    one('/basic/employees', 'items'),
    one('/basic/stores', 'items'),
  ]);
  // 品类：/products/categories 树 → 扁平
  try {
    const cd = await get('/products/categories');
    const tree = (cd && cd.data) || cd || [];
    const fa = (list) => list.forEach(c => { cats.push(c); fa(c.children || []); });
    fa(tree);
  } catch { cats = []; }
  // 供应商：/purchase/suppliers
  try {
    const sd = await get('/purchase/suppliers');
    suppliers = (Array.isArray(sd) ? sd : (sd.items || sd.data || [])) || [];
  } catch { suppliers = []; }
  const prodOpts = (sel) => `<option value="">— 选择商品 —</option>` +
    products.map(p => `<option value="${p.id}" ${String(sel) === String(p.id) ? 'selected' : ''}>${esc(p.name)} · ${esc(p.barcode || p.goods_no || '')}</option>`).join('');

  /* ── 通用：行内直录明细表 ── */
  function makeLines(tbId, sumId, statId) {
    const lines = [];
    function draw() {
      const tb = view.querySelector('#' + tbId);
      if (!lines.length) {
        tb.innerHTML = `<tr><td colspan="5" class="empty">空单：点「➕ 添加行」添加明细</td></tr>`;
      } else {
        tb.innerHTML = lines.map((l, i) => {
          const p = products.find(x => String(x.id) === String(l.productId)) || {};
          return `<tr>
            <td class="num">${i + 1}</td>
            <td><select data-i="${i}" style="width:100%">${prodOpts(l.productId)}</select></td>
            <td>${esc(p.base_unit || '—')}</td>
            <td><input data-i="${i}" type="number" step="0.001" min="0" value="${l.qty ?? ''}" style="width:100%"></td>
            <td><button class="btn sm warn" data-del="${i}">删</button></td>
          </tr>`;
        }).join('');
        tb.querySelectorAll('select').forEach(s => s.onchange = () => {
          lines[Number(s.dataset.i)].productId = s.value ? Number(s.value) : ''; draw();
        });
        tb.querySelectorAll('input[type=number]').forEach(inp => inp.onchange = () => {
          lines[Number(inp.dataset.i)].qty = inp.value; draw();
        });
        tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { lines.splice(Number(b.dataset.del), 1); draw(); });
      }
      const q = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
      view.querySelector('#' + sumId).textContent = String(q);
      view.querySelector('#' + statId).textContent = lines.length ? `录入中 · ${lines.length} 行` : '录入中';
    }
    draw();
    return { lines, draw, add: () => { lines.push({ productId: '', qty: '' }); draw(); },
             reset: () => { lines.length = 0; draw(); } };
  }

  /* ═══════════ 盘点任务 ═══════════ */
  // 范围联动
  const skScope = view.querySelector('#skScope');
  const syncScope = () => {
    const v = skScope.value;
    view.querySelector('#skCatsBox').style.display = v === '按分类' ? '' : 'none';
    view.querySelector('#skSupplierRow').style.display = v === '按供应商' ? '' : 'none';
  };
  skScope.onchange = syncScope; syncScope();
  // 品类多选（checkbox）
  view.querySelector('#skCats').innerHTML = cats.map(c =>
    `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12.5px;border:1px solid var(--line);border-radius:8px;padding:4px 10px">
       <input type="checkbox" value="${c.id}" data-cat="${esc(c.name)}"> ${esc(c.name)}</label>`).join('') || '<span class="muted" style="font-size:12px">无品类数据</span>';
  // 指派店员下拉
  view.querySelector('#skAssignee').innerHTML = `<option value="">— 待指派 —</option>` +
    staff.map(s => `<option value="${s.id}">${esc(s.name)}${s.role_name ? ' · ' + esc(s.role_name) : ''}</option>`).join('');
  // 供应商：输入匹配（datalist）
  view.querySelector('#skSupDl7').innerHTML = suppliers.map(s => `<option value="${esc(s.name)}">`).join('');

  view.querySelector('#skSave').onclick = async () => {
    const scope = skScope.value;
    const catIds = [...view.querySelectorAll('#skCats input:checked')].map(x => Number(x.value));
    if (scope === '按分类' && !catIds.length) return toast('按分类盘点请至少勾选一个品类', false);
    // 供应商：输入名称匹配 id（精确 / 模糊）
    let skSupId;
    if (scope === '按供应商') {
      const supName = view.querySelector('#skSupplier').value.trim();
      const supHit = suppliers.find(s => s.name === supName)
        || suppliers.find(s => (s.name || '').includes(supName) || supName.includes(s.name || ''));
      if (!supHit) return toast('按供应商盘点请输入并匹配到供应商', false);
      skSupId = supHit.id;
    }
    const body = {
      name: view.querySelector('#skName').value.trim() || undefined,
      scopeType: scope,
      categoryIds: scope === '按分类' ? catIds : undefined,
      supplierId: scope === '按供应商' ? Number(skSupId) : undefined,
      assigneeId: Number(view.querySelector('#skAssignee').value) || undefined,
      dueDate: view.querySelector('#skDue').value || undefined,
      remark: view.querySelector('#skMemo').value.trim() || undefined,
    };
    const d = await must(post('/inventory/count-tasks', body), '盘点任务已创建，店员手机端已可接收');
    if (d) {
      view.querySelector('#skName').value = ''; view.querySelector('#skMemo').value = '';
      view.querySelectorAll('#skCats input:checked').forEach(x => x.checked = false);
      show('count', 'list');
    }
  };

  let skStatus = '', skPage = 1;
  view.querySelector('#skGo').onclick = loadTasks;
  view.querySelector('#skRefresh').onclick = loadTasks;
  view.querySelector('#skQStatus').onchange = e => { skStatus = e.target.value; loadTasks(); };

  async function loadTasks() {
    const p = new URLSearchParams();
    if (skStatus) p.set('status', skStatus);
    const d = await must(get('/inventory/count-tasks?' + p));
    let rows = Array.isArray(d) ? d : (d.items || []);
    // V4.9.7 搜索框过滤（任务号 / 名称）
    const kw = (view.querySelector('#skKw').value || '').trim().toLowerCase();
    if (kw) rows = rows.filter(o => String(o.task_no || '').toLowerCase().includes(kw) || String(o.name || '').toLowerCase().includes(kw));
    const pg = paginate(rows, skPage, 10);
    view.querySelector('#skList').innerHTML = rows.length ? `
      <table><thead><tr><th>任务号</th><th>名称</th><th>范围</th><th class="num">进度</th>
        <th>状态</th><th>指派给</th><th>创建</th><th style="width:220px">操作</th></tr></thead>
      <tbody>${pg.slice.map(o => `<tr data-taskrow="${o.id}" style="cursor:pointer" title="双击查看任务明细">
        <td style="font-family:var(--mono);font-weight:600">${esc(o.task_no)}</td>
        <td>${esc(o.name)}</td>
        <td>${esc(o.category_names || o.scope_type)}</td>
        <td class="num">${o.counted_sku}/${o.total_sku}</td>
        <td><span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span></td>
        <td>${esc(o.assignee_name || '—')}</td><td>${dt(o.created_at)}</td>
        <td style="white-space:nowrap">
          ${o.status === '待执行' ? `<button class="btn sm" data-tstart="${o.id}">▶ 开始</button>` : ''}
          ${o.status === '待审核' && canCountAudit ? `<button class="btn sm pri" data-taudit="${o.id}">✓ 审核生成盘点单</button>` : ''}
        </td></tr>`).join('')}</tbody></table>${pg.bar}`
      : '<div class="empty">无盘点任务</div>';
    bindPager(view.querySelector('#skList'), p => { skPage = p; loadTasks(); });
    view.querySelectorAll('[data-taskrow]').forEach(tr => tr.ondblclick = () => openTaskDetail(Number(tr.dataset.taskrow)));
    view.querySelectorAll('[data-tstart]').forEach(b => b.onclick = async () => {
      await must(post(`/inventory/count-tasks/${b.dataset.tstart}/start`), '任务已开始');
      loadTasks();
    });
    view.querySelectorAll('[data-taudit]').forEach(b => b.onclick = async () => {
      if (!confirm('确认审核该盘点任务？将生成盘点单并按 FIFO 立即生效差异。')) return;
      await must(post(`/inventory/count-tasks/${b.dataset.taudit}/audit`), '任务已审核，盘点单已生成并生效');
      loadTasks(); loadCounts();
    });
  }

  async function openTaskDetail(id) {
    const o = await must(get('/inventory/count-tasks/' + id));
    if (!o) return;
    const groups = {};
    (o.items || []).forEach(it => { const g = it.category_name || '未分类'; (groups[g] = groups[g] || []).push(it); });
    openModal(`盘点任务 ${o.task_no || ''} · ${o.name || ''}`,
      `范围：<b>${esc(o.category_names || o.scope_type || '')}</b>　状态：<span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span>　
       指派：${esc(o.assignee_name || '—')}　进度：<b>${o.counted_sku}/${o.total_sku}</b>　截止：${o.due_date ? String(o.due_date).slice(0, 10) : '—'}　
       备注：${esc(o.remark || '—')}`,
      Object.keys(groups).map(g => `
        <div style="font-weight:700;margin:10px 0 4px">📂 ${esc(g)}</div>
        <table><thead><tr><th>商品</th><th>单位</th><th class="num">账面</th><th class="num">实盘</th><th class="num">差异</th><th>实盘时间</th></tr></thead>
        <tbody>${groups[g].map(it => { const d = it.diff_qty != null ? Number(it.diff_qty) : null;
          return `<tr><td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '—')}</td>
            <td class="num">${Number(it.book_qty)}</td>
            <td class="num">${it.actual_qty != null ? Number(it.actual_qty) : '—'}</td>
            <td class="num" style="color:${d == null ? 'inherit' : d < 0 ? 'var(--warn)' : d > 0 ? 'var(--ok)' : 'inherit'}">${d != null ? Number(d) : '—'}</td>
            <td>${it.counted_at ? dt(it.counted_at) : '—'}</td></tr>`; }).join('')}</tbody></table>`).join('')
      || '<div class="empty">无明细</div>');
  }

  /* ═══════════ 盘点单据列表 ═══════════ */
  const fmt = n => (Number(n) || 0).toFixed(2);
  let ctStatus = '', ctPage = 1;
  view.querySelector('#ctGo').onclick = loadCounts;
  view.querySelector('#ctRefresh').onclick = loadCounts;
  view.querySelector('#ctQStatus').onchange = e => { ctStatus = e.target.value; loadCounts(); };

  async function loadCounts() {
    const p = new URLSearchParams();
    if (ctStatus) p.set('status', ctStatus);
    const from = view.querySelector('#ctFrom').value, to = view.querySelector('#ctTo').value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const d = await must(get('/inventory/counts?' + p));
    let rows = Array.isArray(d) ? d : (d.items || []);
    const kw = (view.querySelector('#ctKw').value || '').trim().toLowerCase();
    if (kw) rows = rows.filter(o => String(o.count_no || '').toLowerCase().includes(kw) || String(o.scope || '').toLowerCase().includes(kw));
    // V4.9.7 列重排：明细行→总数量 · 创建→制单时间 · 签字移制单时间后 · 状态移签字后 · 数据靠左
    const pg = paginate(rows, ctPage, 10);
    view.querySelector('#ctList').innerHTML = rows.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="ctPrAll" title="全选打印"></th><th>单号</th><th>范围</th><th>总数量</th><th>差异合计</th>
        <th>盘点人</th><th>制单时间</th><th>签字</th><th>状态</th><th style="width:180px">操作</th></tr></thead>
      <tbody>${pg.slice.map(o => `<tr data-cntrow="${o.id}" style="cursor:pointer" title="双击查看明细">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-ctpr="${o.id}" ${ctPrSel.has(Number(o.id)) ? 'checked' : ''} title="勾选批量打印 A5"></td>
        <td style="font-family:var(--mono);font-weight:600">${esc(o.count_no)}</td>
        <td>${esc(o.scope)}</td><td>${Number(o.total_qty ?? 0)}</td>
        <td style="color:${Number(o.diff_sum) < 0 ? 'var(--warn)' : 'inherit'}">${fmt(o.diff_sum)}</td>
        <td>${esc(o.employee_name || '')}</td><td>${dt(o.created_at)}</td>
        <td>${signCell(o)}${(o.status === '进行中' && !Number(o.sign_record_id)) ? ' ' + signBtn(o.id) : ''}</td>
        <td><span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span></td>
        <td style="white-space:nowrap">
          ${o.status === '进行中' && canCountAudit ? `<button class="btn sm pri" data-audit="${o.id}" data-kind="count">✓ 审核</button>` : ''}
        </td></tr>`).join('')}</tbody></table>${pg.bar}`
      : '<div class="empty">无盘点单</div>';
    bindPager(view.querySelector('#ctList'), p => { ctPage = p; loadCounts(); });
    view.querySelectorAll('[data-cntrow]').forEach(tr => tr.ondblclick = () => openCountDetail(Number(tr.dataset.cntrow)));
    bindPrintSel('#ctList', 'ctpr', ctPrSel, 'ctPrAll', rows, 'ctPrints', 'ctPrN');
    view.querySelectorAll('[data-kind="count"][data-audit]').forEach(b => b.onclick = async () => {
      if (!confirm('确认审核该盘点单？差异将立即生效（盘亏扣批次/盘盈调增库存）。')) return;
      await must(post(`/inventory/counts/${b.dataset.audit}/audit`), '盘点已审核，差异已生效');
      autoPrintA5AfterAudit('count', [Number(b.dataset.audit)]);   // V4.15.7 设置开启时自动弹 A5
      loadCounts();
    });
    mountSignActions(view, { bizType: 'count', onDone: loadCounts });
  }

  async function openCountDetail(id) {
    const o = await must(get('/inventory/counts/' + id));
    if (!o) return;
    openModal(`盘点单 ${o.count_no || ''}`,
      `范围：<b>${esc(o.scope || '')}</b>　状态：<span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span>　
       盘点人：${esc(o.employee_name || '—')}　差异合计：<b>${fmt((o.items || []).reduce((s, i) => s + Number(i.diff_qty || 0), 0))}</b>　
       备注：${esc(o.remark || '—')}`,
      (o.items || []).length ? `
      <table><thead><tr><th>序号</th><th>商品</th><th>单位</th><th class="num">账面</th><th class="num">实盘</th>
        <th class="num">差异</th><th class="num">差异成本</th></tr></thead>
      <tbody>${o.items.map((it, i) => { const d = Number(it.diff_qty || 0);
        return `<tr><td class="num">${i + 1}</td><td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '—')}</td>
          <td class="num">${Number(it.book_qty)}</td><td class="num">${Number(it.actual_qty)}</td>
          <td class="num" style="color:${d < 0 ? 'var(--warn)' : d > 0 ? 'var(--ok)' : 'inherit'}">${fmt(d)}</td>
          <td class="num">${it.diff_cost != null ? money(it.diff_cost) : '—'}</td></tr>`; }).join('')}</tbody></table>`
      : '<div class="empty">无明细</div>',
      { type: 'count', id });
  }

  /* ═══════════ 报损（照片上传 + 操作员电子签名） ═══════════ */
  const ls = makeLines('lsLines', 'lsSumQty', 'lsStat');
  view.querySelector('#lsAddRow').onclick = ls.add;
  view.querySelector('#lsReset').onclick = ls.reset;

  let lsPhotoPath = '';
  view.querySelector('#lsPhotoFile').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toast('照片不能超过 8MB', false);
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
    });
    view.querySelector('#lsPhotoTip').textContent = '上传中…';
    try {
      const d = await must(post('/upload', { image: dataUrl }), '照片已上传');
      lsPhotoPath = d.path;
      const prev = view.querySelector('#lsPhotoPrev');
      prev.src = dataUrl; prev.style.display = '';
      view.querySelector('#lsPhotoTip').textContent = `已上传：${d.path}`;
    } catch { view.querySelector('#lsPhotoTip').textContent = '上传失败，请重试'; }
  };

  view.querySelector('#lsSave').onclick = async () => {
    const items = ls.lines.filter(l => l.productId && Number(l.qty) > 0).map(l => ({
      productId: Number(l.productId), qty: Number(l.qty) }));
    if (!items.length) return toast('无有效明细行（需选商品+数量>0）', false);
    if (!lsPhotoPath) return toast('请先拍摄/上传报损照片（≥1 张）', false);
    const d = await must(post('/inventory/losses', {
      reasonType: view.querySelector('#lsReason').value,
      photoPath: lsPhotoPath,
      remark: view.querySelector('#lsMemo').value.trim() || undefined,
      items }), `报损单已保存（${items.length} 行，待审核）`);
    if (d) {
      ls.reset(); view.querySelector('#lsMemo').value = ''; lsPhotoPath = '';
      view.querySelector('#lsPhotoPrev').style.display = 'none';
      view.querySelector('#lsPhotoTip').textContent = '未上传照片';
      view.querySelector('#lsPhotoFile').value = '';
      show('loss', 'list');
      // 操作员电子签名：保存后弹签字板，签字即随单据留痕
      openSignPad(view, { bizType: 'loss', bizId: d.id, title: '报损单 · 操作员电子签名',
        defaultName: API.user?.name || '', onDone: loadLosses });
      handleSignInfo(view, d.signInfo, { bizType: 'loss', bizId: d.id, onDone: loadLosses });
    }
  };

  /* ═══════════ 调拨（门店下拉 + 操作员电子签名） ═══════════ */
  const storeOpts = (sel) => stores.map(s =>
    `<option value="${s.id}" ${String(sel) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
    || `<option value="1">本店</option>`;
  view.querySelector('#trFromStore').innerHTML = storeOpts(stores[0]?.id);
  view.querySelector('#trToStore').innerHTML = storeOpts(stores[0]?.id);

  const tr = makeLines('trLines', 'trSumQty', 'trStat');
  view.querySelector('#trAddRow').onclick = tr.add;
  view.querySelector('#trReset').onclick = tr.reset;
  view.querySelector('#trSave').onclick = async () => {
    const items = tr.lines.filter(l => l.productId && Number(l.qty) > 0).map(l => ({
      productId: Number(l.productId), qty: Number(l.qty) }));
    if (!items.length) return toast('无有效明细行（需选商品+数量>0）', false);
    const toStore = Number(view.querySelector('#trToStore').value) || undefined;
    const d = await must(post('/inventory/transfers', {
      toStoreId: toStore,
      reason: view.querySelector('#trReason').value.trim() || undefined,
      items }), `调拨单已保存（${items.length} 行，待确认）`);
    if (d) {
      tr.reset(); view.querySelector('#trReason').value = '';
      show('transfer', 'list');
      openSignPad(view, { bizType: 'transfer', bizId: d.id, title: '调拨单 · 操作员电子签名',
        defaultName: API.user?.name || '', onDone: loadTransfers });
    }
  };

  /* ── 单据明细弹窗 ── */
  // V4.15.7 P3：详情弹窗打印按钮——openModal 传入 a5={type,id} 后「打印单据 A5」可用
  let opsA5 = null;
  const ctPrSel = new Set(), lsPrSel = new Set(), trPrSel = new Set();
  function bindPrintSel(wrapSel, attr, sel, allId, rows, btnId, nId) {
    const wrap = view.querySelector(wrapSel);
    wrap.querySelectorAll(`[data-${attr}]`).forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset[attr]);
      if (cb.checked) sel.add(id); else sel.delete(id);
      syncPrBtn(btnId, nId, sel);
    });
    const all = wrap.querySelector('#' + allId);
    if (all) all.onchange = () => {
      rows.forEach(o => { if (all.checked) sel.add(Number(o.id)); else sel.delete(Number(o.id)); });
      // V4.26.2：把勾选状态同步到行内复选框，否则全选/取消全选在界面上完全看不出变化，
      // 用户会以为"只能全选、无法取消全选"。
      wrap.querySelectorAll(`[data-${attr}]`).forEach(cb => { cb.checked = all.checked; });
      syncPrBtn(btnId, nId, sel);
    };
    const btn = view.querySelector('#' + btnId);
    if (btn) btn.onclick = () => {
      if (!sel.size) return;
      if (!canPrintA5()) { toast('需要「A5单据打印」权限（店长及以上）', false); return; }
      openA5Print(btnId === 'ctPrints' ? 'count' : btnId === 'lsPrints' ? 'loss' : 'transfer', [...sel]);
    };
  }
  function syncPrBtn(btnId, nId, sel) {
    const btn = view.querySelector('#' + btnId);
    if (!btn) return;
    btn.style.display = sel.size ? '' : 'none';
    view.querySelector('#' + nId).textContent = String(sel.size);
  }
  function openModal(title, metaHtml, itemsHtml, a5) {
    view.querySelector('#opsTitle').textContent = title;
    view.querySelector('#opsMeta').innerHTML = metaHtml;
    view.querySelector('#opsItems').innerHTML = itemsHtml;
    opsA5 = a5 || null;
    view.querySelector('#opsPrint').style.display = a5 ? '' : 'none';
    view.querySelector('#opsModal').style.display = 'flex';
  }
  // V4.15.7 P3：详情弹窗 A5 打印（份数选择 + 留痕）
  view.querySelector('#opsPrint').onclick = () => {
    if (!opsA5) return;
    if (!canPrintA5()) { toast('需要「A5单据打印」权限（店长及以上）', false); return; }
    openA5Print(opsA5.type, [opsA5.id]);
  };
  // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）

  /* ── 报损列表 ── */
  let lsStatus = '', lsPage = 1;
  view.querySelector('#lsGo').onclick = loadLosses;
  view.querySelector('#lsRefresh').onclick = loadLosses;
  view.querySelector('#lsQStatus').onchange = e => { lsStatus = e.target.value; loadLosses(); };

  async function loadLosses() {
    const p = new URLSearchParams();
    if (lsStatus) p.set('status', lsStatus);
    const from = view.querySelector('#lsFrom').value, to = view.querySelector('#lsTo').value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const d = await must(get('/inventory/losses?' + p));
    let rows = Array.isArray(d) ? d : (d.items || []);
    const kw = (view.querySelector('#lsKw').value || '').trim().toLowerCase();
    if (kw) rows = rows.filter(o => String(o.loss_no || '').toLowerCase().includes(kw) || String(o.reason_type || '').toLowerCase().includes(kw));
    // V4.9.7 列重排：明细行→总数量 · 创建→制单时间 · 签字移制单时间后 · 状态移签字后 · 数据靠左
    const pg = paginate(rows, lsPage, 10);
    view.querySelector('#lsList').innerHTML = rows.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="lsPrAll" title="全选打印"></th><th>单号</th><th>原因</th><th>总数量</th><th>报损金额</th>
        <th>经办人</th><th>制单时间</th><th>签字</th><th>状态</th><th style="width:180px">操作</th></tr></thead>
      <tbody>${pg.slice.map(o => `<tr data-lsrow="${o.id}" style="cursor:pointer" title="双击查看明细（右侧凭证照片）">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-lspr="${o.id}" ${lsPrSel.has(Number(o.id)) ? 'checked' : ''} title="勾选批量打印 A5"></td>
        <td style="font-family:var(--mono);font-weight:600">${esc(o.loss_no)}</td>
        <td>${esc(o.reason_type)}</td><td>${Number(o.total_qty ?? 0)}</td>
        <td style="color:var(--warn)">${money(o.total_cost)}</td>
        <td>${esc(o.employee_name || '')}</td><td>${dt(o.created_at)}</td>
        <td>${signCell(o)}${(o.status === '待审核' && !Number(o.sign_record_id)) ? ' ' + signBtn(o.id) : ''}</td>
        <td><span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span></td>
        <td style="white-space:nowrap">
          ${o.status === '待审核' && canLoss ? `<button class="btn sm pri" data-audit="${o.id}" data-kind="loss">✓ 审核</button>` : ''}
        </td></tr>`).join('')}</tbody></table>${pg.bar}`
      : '<div class="empty">无报损单</div>';
    bindPager(view.querySelector('#lsList'), p => { lsPage = p; loadLosses(); });
    view.querySelectorAll('[data-lsrow]').forEach(tr => tr.ondblclick = () => openLossDetail(Number(tr.dataset.lsrow)));
    bindPrintSel('#lsList', 'lspr', lsPrSel, 'lsPrAll', rows, 'lsPrints', 'lsPrN');
    view.querySelectorAll('[data-kind="loss"][data-audit]').forEach(b => b.onclick = async () => {
      if (!confirm('确认审核该报损单？将扣减对应批次库存。')) return;
      await must(post(`/inventory/losses/${b.dataset.audit}/audit`), '报损已审核，批次已扣减');
      autoPrintA5AfterAudit('loss', [Number(b.dataset.audit)]);   // V4.15.7 设置开启时自动弹 A5
      loadLosses();
    });
    mountSignActions(view, { bizType: 'loss', onDone: loadLosses });
  }

  /** V4.9.7 报损明细：退货单同款左右版式（左明细右照片·可多张·点击放大）；批次号列移到商品列前 */
  async function openLossDetail(id) {
    const { zoomImg } = await import('../ui.js');
    const o = await must(get('/inventory/losses/' + id));
    if (!o) return;
    const photos = String(o.photo_path || '').split(',').map(x => x.trim()).filter(Boolean);
    const itemsHtml = (o.items || []).length ? `
      <table><thead><tr><th>序号</th><th>批次号</th><th>商品</th><th>单位</th><th>数量</th><th>成本</th><th>金额</th></tr></thead>
      <tbody>${o.items.map((it, i) => `<tr><td>${i + 1}</td>
        <td class="mono">${esc(it.batch_no || '—')}</td><td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '—')}</td>
        <td>${Number(it.qty)}</td>
        <td>${money(it.unit_cost)}</td><td>${money(Number(it.qty) * Number(it.unit_cost))}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">无明细</div>';
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.zIndex = 80;
    mask.innerHTML = `
      <div class="modal" style="width:auto;min-width:900px;max-width:96vw;max-height:90dvh;overflow:auto">
        <h3>📷 报损单 ${esc(o.loss_no || '')}</h3>
        <div style="font-size:12.5px;line-height:1.9;color:var(--ink-2);margin:6px 0 10px">
          原因：<b>${esc(o.reason_type || '')}</b>　状态：<span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span>　
          金额：<b style="color:var(--warn)">${money(o.total_cost)}</b>　经办人：${esc(o.employee_name || '—')}</div>
        <div style="display:flex;gap:14px;align-items:stretch">
          <div style="flex:1;min-width:0;max-height:560px;overflow:auto">${itemsHtml}</div>
          <div style="width:300px;flex:none;border:1px dashed var(--line);border-radius:10px;padding:10px 12px;height:560px;display:flex;flex-direction:column">
            <div class="muted" style="font-size:12px;margin-bottom:6px">📎 报损凭证${photos.length > 1 ? `（${photos.length} 张）` : ''}（点击放大）</div>
            <div style="flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px">
              ${photos.length ? photos.map(u => `<img data-lszoom="${esc(u)}" src="${esc(u)}" style="width:100%;max-height:500px;object-fit:contain;border-radius:8px;border:1px solid var(--line);cursor:zoom-in;background:#fff" alt="报损照片">`).join('')
                : '<span class="tag r">缺照片</span>'}
            </div>
          </div>
        </div>
        <div class="doc-foot">
          <span style="flex:1"></span>
          <button class="btn" id="lsA5Print">🖨 打印单据 A5</button>
        </div>
      </div>`;
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    mask.querySelectorAll('[data-lszoom]').forEach(img => img.onclick = () => zoomImg(img.dataset.lszoom));
    mask.querySelector('#lsA5Print').onclick = () => {
      if (!canPrintA5()) { toast('需要「A5单据打印」权限（店长及以上）', false); return; }
      openA5Print('loss', [id]);
    };
    document.body.appendChild(mask);
  }

  /* ── 调拨列表（含签字列） ── */
  let trStatus = '', trPage = 1;
  view.querySelector('#trGo').onclick = loadTransfers;
  view.querySelector('#trRefresh').onclick = loadTransfers;
  view.querySelector('#trQStatus').onchange = e => { trStatus = e.target.value; loadTransfers(); };

  async function loadTransfers() {
    const p = new URLSearchParams();
    if (trStatus) p.set('status', trStatus);
    const from = view.querySelector('#trFrom').value, to = view.querySelector('#trTo').value;
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const d = await must(get('/inventory/transfers?' + p));
    let rows = Array.isArray(d) ? d : (d.items || []);
    const kw = (view.querySelector('#trKw').value || '').trim().toLowerCase();
    if (kw) rows = rows.filter(o => String(o.transfer_no || '').toLowerCase().includes(kw) || String(o.reason || '').toLowerCase().includes(kw));
    // V4.9.7 列重排：明细行→总数量 · 创建→制单时间 · 签字移制单时间后 · 状态移签字后 · 数据靠左
    const pg = paginate(rows, trPage, 10);
    view.querySelector('#trList').innerHTML = rows.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="trPrAll" title="全选打印"></th><th>单号</th><th>调入</th><th>原因</th><th>总数量</th><th>调拨金额</th>
        <th>经办人</th><th>制单时间</th><th>签字</th><th>状态</th><th style="width:180px">操作</th></tr></thead>
      <tbody>${pg.slice.map(o => `<tr data-trrow="${o.id}" style="cursor:pointer" title="双击查看明细">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-trpr="${o.id}" ${trPrSel.has(Number(o.id)) ? 'checked' : ''} title="勾选批量打印 A5"></td>
        <td style="font-family:var(--mono);font-weight:600">${esc(o.transfer_no)}</td>
        <td>${esc(o.to_store_name || '本店（店内）')}</td><td>${esc(o.reason || '—')}</td>
        <td>${Number(o.total_qty ?? 0)}</td><td>${money(o.total_cost)}</td>
        <td>${esc(o.employee_name || '')}</td><td>${dt(o.created_at)}</td>
        <td>${signCell(o)}${(o.status === '待确认' && !Number(o.sign_record_id)) ? ' ' + signBtn(o.id) : ''}</td>
        <td><span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span></td>
        <td style="white-space:nowrap">
          ${o.status === '待确认' && canTransfer ? `<button class="btn sm pri" data-confirm="${o.id}" data-kind="tr">✓ 确认</button>` : ''}
          ${o.status === '待审核' && canTransferAudit ? `<button class="btn sm pri" data-taudit="${o.id}" data-pass="1" data-kind="tr">✓ 通过</button>
            <button class="btn sm" data-taudit="${o.id}" data-pass="0" data-kind="tr">✕ 驳回</button>` : ''}
          ${o.status === '待发货' && canTransfer ? `<button class="btn sm pri" data-ship="${o.id}" data-kind="tr">🚚 发货</button>` : ''}
          ${o.status === '在途' && canTransfer ? `<button class="btn sm pri" data-recv="${o.id}" data-kind="tr">📥 收货确认</button>` : ''}
          ${['待审核', '待发货', '驳回', '待确认'].includes(o.status) && canTransfer ? `<button class="btn sm" data-tcancel="${o.id}" data-kind="tr">取消</button>` : ''}
        </td></tr>`).join('')}</tbody></table>${pg.bar}`
      : '<div class="empty">无调拨单</div>';
    bindPager(view.querySelector('#trList'), p => { trPage = p; loadTransfers(); });
    view.querySelectorAll('[data-trrow]').forEach(tr => tr.ondblclick = () => openTransferDetail(Number(tr.dataset.trrow)));
    bindPrintSel('#trList', 'trpr', trPrSel, 'trPrAll', rows, 'trPrints', 'trPrN');
    view.querySelectorAll('[data-kind="tr"][data-confirm]').forEach(b => b.onclick = async () => {
      if (!confirm('确认执行该调拨单？将扣源批次并生成转入批次。')) return;
      await must(post(`/inventory/transfers/${b.dataset.confirm}/confirm`), '调拨已确认执行');
      autoPrintA5AfterAudit('transfer', [Number(b.dataset.confirm)]);   // V4.15.7 设置开启时自动弹 A5
      loadTransfers();
    });
    // ── V5.0.0 批次6：跨店调拨状态机（审核/发货/收货/取消） ──
    view.querySelectorAll('[data-kind="tr"][data-taudit]').forEach(b => b.onclick = async () => {
      const pass = b.dataset.pass === '1';
      let remark = '';
      if (!pass) { remark = prompt('驳回原因（必填）：') || ''; if (!remark) return; }
      try {
        await must(post(`/inventory/transfers/${b.dataset.taudit}/audit`, { pass, remark }));
        toast(pass ? '已通过，待调出方发货' : '已驳回');
        loadTransfers();
      } catch (e) { toast('审核失败：' + (e?.message || e), false); }
    });
    view.querySelectorAll('[data-kind="tr"][data-ship]').forEach(b => b.onclick = async () => {
      if (!confirm('确认发货？将扣减调出方批次与库存（在途），收货方确认后入账。')) return;
      try {
        const r = await must(post(`/inventory/transfers/${b.dataset.ship}/ship`));
        toast(Number(r?.shortfallTotal) > 0 ? `已发货；总部仓缺口 ${r.shortfallTotal}，已自动生成采购需求` : '已发货，等待收货方确认');
        loadTransfers();
      } catch (e) { toast('发货失败：' + (e?.message || e), false); }
    });
    view.querySelectorAll('[data-kind="tr"][data-recv]').forEach(b => b.onclick = async () => {
      const diffs = prompt('如全部足量收货请留空确认；如有差异，按「明细ID:实收数量」逗号分隔填写（如 12:8,13:10）：', '');
      if (diffs === null) return;
      const body = {};
      if (diffs.trim()) {
        body.diffs = diffs.split(',').map(s => {
          const [itemId, recvQty] = s.split(':').map(x => Number(String(x).trim()));
          return { itemId, recvQty };
        }).filter(d => d.itemId > 0 && d.recvQty >= 0);
      }
      try {
        const r = await must(post(`/inventory/transfers/${b.dataset.recv}/receive`, body));
        toast(`收货完成${Number(r?.diffTotal) > 0 ? `；差异 ${r.diffTotal} 已记录（请走报损流程）` : ''}`);
        loadTransfers();
      } catch (e) { toast('收货失败：' + (e?.message || e), false); }
    });
    view.querySelectorAll('[data-kind="tr"][data-tcancel]').forEach(b => b.onclick = async () => {
      if (!confirm('确认取消该调拨单？')) return;
      await must(post(`/inventory/transfers/${b.dataset.tcancel}/cancel`), '已取消');
      loadTransfers();
    });
    mountSignActions(view, { bizType: 'transfer', onDone: loadTransfers });
  }

  /** V4.9.7 调拨明细：批次号列移到商品列前 · 数据靠左 */
  async function openTransferDetail(id) {
    const o = await must(get('/inventory/transfers/' + id));
    if (!o) return;
    openModal(`调拨单 ${o.transfer_no || ''}`,
      `调出：<b>${esc(o.from_store_name || '本店')}</b>　调入：<b>${esc(o.to_store_name || '本店（店内）')}</b>　
       状态：<span class="tag ${TAG[o.status] || 'y'}">${esc(o.status)}</span>　金额：<b>${money(o.total_cost)}</b>　
       原因：${esc(o.reason || '—')}`,
      (o.items || []).length ? `
      <table><thead><tr><th>序号</th><th>批次号</th><th>商品</th><th>单位</th><th>到期</th><th>数量</th><th>成本</th></tr></thead>
      <tbody>${o.items.map((it, i) => `<tr><td>${i + 1}</td>
        <td class="mono">${esc(it.batch_no || '—')}</td><td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '—')}</td>
        <td>${it.expiry_date ? String(it.expiry_date).slice(0, 10) : '—'}</td>
        <td>${Number(it.qty)}</td><td>${money(it.unit_cost)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">无明细</div>',
      { type: 'transfer', id });
  }

  /* V4.26.4 锚点导航：只有「盘点」页是两节列表（盘点任务 / 盘点单据），
     报损、调拨各只有一节，挂胶囊条纯占地方 —— 只给 #tab-count 挂。
     标题取自 .doc-tools 首个 span（这两节卡片没有 h3）。 */
  anchorNav(view, {
    scope: '#tab-count',
    item: '.card.page-list',
    label: el => el.querySelector('.doc-tools > span')?.textContent.trim() || '列表',
    refresh: true,
  });

  show(curType, 'list');
}
