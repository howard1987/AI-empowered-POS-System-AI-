import { get, post, put, del, must, money, esc, dt, toast, imgUrl, API } from '../api.js';
import { renderLines, makeLine, toBase, createUnitsCache } from './docentry.js';
import { confirmBox } from '../ui.js';
import { paginate, bindPager } from '../common-ui.js';
import { openA5Print, autoPrintA5AfterAudit, canPrintA5 } from '../docprint.js';

/** 采购订单（V4.9.6：状态文案「已下单/待入库」· 双击行开明细 · 状态列前移 · 已完成可作废二次确认
 *  · 供应商输入匹配 · AI 智能按供应商分组拆单 · 新建页切换标签保留草稿 · 明细弹窗打印含电子签字
 *  · V4.15.7 P3：A5 打印统一走 docprint.js（份数 + 留痕 + 勾选批量打印 + 审批后自动弹） */

const STATUS_TAG = { 草稿: 'y', 待审批: 'b', 已下单: 'g', 到货中: 'b', 已完成: 'g', 已取消: 'r' };
const STATUS_TXT = { 已下单: '已下单', 到货中: '待入库' };   // V4.9.6 仅改展示文案（DB 状态值不变）
const APPROVABLE = ['已下单', '到货中', '已完成'];   // 审批后可打印
const DELETABLE = ['草稿', '待审批', '已取消'];      // 未产生业务可删（后端二次校验）

let draftCache = null;   // V4.9.6 新建页草稿缓存：切换左侧菜单再回来不丢数据
/* V4.15.7 P3：旧 printDoc/printPo 已移除，A5 打印统一走 docprint.js */

export async function render(view) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const d3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const canApprove = (API.user?.perms || []).includes('purchase.po.approve');

  view.innerHTML = `
    <div id="tab-new" style="display:none">
      <div class="card">
        <div class="doc-tools">
          <button class="btn" id="poBackList">← 返回列表</button>
          <span style="font-weight:700;font-size:14.5px">📝 新建采购订单</span>
          <span class="pill o" id="poStat">录入中</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn" id="poReset">删单重录</button>
            <button class="btn pri" id="poSubmit">💾 保存订单</button>
          </span>
        </div>
        <div class="doc-head">
          <div class="fld"><label>供应商（选填·可自动分组）</label><input id="poSupIn" list="poSupDl" placeholder="输入名称快速匹配；留空按商品自动分组" style="flex:1;min-width:0">
            <datalist id="poSupDl"></datalist></div>
          <div class="fld"><label>预计到货</label><input id="poDate" type="date" value="${d3}"></div>
          <div class="fld"><label>制单人</label><input id="poMaker" value="${esc(API.user?.name || '')}" readonly></div>
          <div class="fld"><label>备注</label><input id="poMemo" placeholder="备注（选填）"></div>
        </div>
        <div class="doc-grid" style="padding:6px 18px 4px">
          <table>
            <thead><tr><th style="width:70px">＋/−</th><th style="width:38px">序号</th><th>条码</th><th>名称</th><th>单位</th>
              <th>类别</th><th>规格</th><th style="min-width:90px">供应商</th><th style="width:82px">数量</th><th style="width:88px">含税进价</th>
              <th style="width:60px">库存</th><th>行备注</th><th class="num">金额</th></tr></thead>
            <tbody id="poLines"></tbody>
            <tfoot><tr><td colspan="8">合计</td><td class="num" id="poSumQty">0</td><td></td><td></td>
              <td></td><td class="num" id="poSumAmt">0.00</td></tr></tfoot>
          </table>
        </div>
        <div class="doc-tip">💡 🤖 AI 智能分组：无需先选供应商——「条码」列扫码 / 手输 / 名称拼音定位任意商品（自动带出名称·单位·类别·规格·进价·库存），<b>保存时按商品所属供应商自动分组，一次生成多张采购单</b>；也可在「供应商」行输入名称锁定单一供应商。数量默认整数（散称商品支持小数）。</div>
        <div class="doc-foot">
          <span class="muted" id="poCount">明细 0 行</span>
          <span class="sum">订单金额：<b id="poFootAmt">0.00</b> 元</span>
        </div>
      </div>
    </div>

    <div id="tab-list">
      <div class="card">
        <div class="doc-head" style="grid-template-columns:1.5fr 1fr 1.6fr auto;align-items:end">
          <div class="fld"><label>单据日期</label><span style="display:flex;gap:4px;align-items:center"><input id="poFrom" type="date" value="${monthStart}" style="flex:1;min-width:0"><span style="color:var(--ink-3)">~</span><input id="poTo" type="date" value="${today}" style="flex:1;min-width:0"></span></div>
          <div class="fld"><label>供应商</label><input id="poQSup" list="poQSupDl7" placeholder="输入名称快速匹配（留空=全部）" style="min-width:150px"><datalist id="poQSupDl7"></datalist></div>
          <div class="fld"><label>状态</label><span class="seg" id="poStatSel" style="display:flex;gap:2px;flex-wrap:wrap">
            <button class="btn sm segbtn" data-v="草稿">草稿</button>
            <button class="btn sm segbtn" data-v="待审批">待审批</button>
            <button class="btn sm segbtn" data-v="已下单">已下单</button>
            <button class="btn sm segbtn" data-v="到货中">待入库</button>
            <button class="btn sm segbtn" data-v="已完成">已完成</button>
            <button class="btn sm segbtn" data-v="已取消">已取消</button>
            <button class="btn sm segbtn on" data-v="">全部</button></span></div>
          <div class="fld"><label>&nbsp;</label><span style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn pri" id="poGo">🔍 查询</button>
            <button class="btn" id="poRefresh">刷新</button>
            <button class="btn pri" id="poNewDoc" style="white-space:nowrap">＋ 新增订单</button>
            <button class="btn" id="poPrints" style="display:none">🖨 打印所选(<b id="poPrN">0</b>)</button>
            <button class="btn" id="poDel" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 删除(<b id="poDelN">0</b>)</button>
          </span></div>
        </div>
        <div style="padding:10px 18px 16px" id="poList" class="tbl-min"></div>
        <div class="doc-foot"><span class="muted" id="poQCount"></span>
          <span class="sum">金额合计：<b id="poQSum">0.00</b> 元</span></div>
      </div>
    </div>

    <div class="modal-mask" id="poModal" style="display:none">
      <div class="modal" style="width:auto;min-width:720px;max-width:96vw;max-height:90dvh;overflow:auto">
        <h3 id="poModalTitle">采购订单明细</h3>
        <div id="poMeta" style="font-size:12.5px;line-height:1.9;color:var(--ink-2);margin:6px 0 10px"></div>
        <div id="poItems"></div>
        <div class="doc-foot">
          
          <span style="flex:1"></span>
          <button class="btn" id="poPrint" style="display:none">🖨 打印</button>
          <button class="btn pri" id="poSaveDraft" style="display:none">💾 保存修改</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="signModal" style="display:none">
      <div class="modal" style="width:640px">
        <h3>✍️ 审批电子签名</h3>
        <div class="doc-tip" id="sgTip">审批通过即「已下单」；签名将插入单据（审批人 + 电子签名留痕）</div>
        <div class="fld" style="margin:10px 0"><label>审批人</label><input id="sgName" value="${esc(API.user?.name || '')}" readonly style="background:var(--paper-2)"></div>
        <canvas id="sgPad" width="560" height="170" style="border:1px dashed var(--line);border-radius:8px;touch-action:none;cursor:crosshair;width:100%"></canvas>
        <div class="bar" style="margin-top:8px"><button class="btn sm" id="sgClear">🧽 清除重签</button></div>
        <div class="doc-foot">
          <button class="btn" id="sgCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="sgGo">✓ 审批通过并签名</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="voidModal" style="display:none">
      <div class="modal" style="width:440px">
        <h3 id="voidTitle">✖ 作废采购订单</h3>
        <div class="doc-tip" style="color:#c0392b">⚠️ 作废后单据不可恢复，已产生的到货计划随之失效，请谨慎操作！</div>
        <div class="fld" style="margin:10px 0"><label>作废原因</label>
          <textarea id="voidReason" rows="3" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit" placeholder="请填写作废原因（留痕必填）"></textarea></div>
        <div class="doc-foot">
          <button class="btn" id="voidCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn warn" id="voidGo">确认作废</button>
        </div>
      </div>
    </div>`;

  const lines = [];
  const unitsCache = createUnitsCache();
  let allProducts = [];        // 全量商品（智能分组开单：不限供应商）
  let products = [];           // 开单可用商品 = 全量（保存时按供应商分组）
  let detailLines = [];
  let detailPoId = 0;
  let detailStatus = '';
  let signPoId = 0;
  let voidPoId = 0;
  const poSel = new Set();
  const poPrSel = poSel;   // V4.26.2 合并为一列：批量打印复用「选择」集合（原为独立 Set）
  function syncPrBtn() {
    const btn = view.querySelector('#poPrints');
    if (!btn) return;
    btn.style.display = poPrSel.size ? '' : 'none';
    view.querySelector('#poPrN').textContent = String(poPrSel.size);
  }
  view.querySelector('#poPrints').onclick = () => { if (poPrSel.size) openA5Print('order', [...poPrSel]); };
  const fmt = n => (Number(n) || 0).toFixed(2);

  /* ── 分页式：列表页 ⇄ 新增页（V4.9.7：切页失败不再卡死，返回列表必生效） ── */
  const showPage = (mode) => {
    view.querySelector('#tab-new').style.display = mode === 'new' ? '' : 'none';
    view.querySelector('#tab-list').style.display = mode === 'list' ? '' : 'none';
    if (mode === 'list') { try { loadList(); } catch { /* 加载失败不阻断切页 */ } }
  };

  /* V4.9.6 智能分组开单：不再按供应商过滤商品；「供应商」行输入名称可锁定单一供应商 */
  view.querySelector('#poNewDoc').onclick = () => { showPage('new'); draftCache ? restoreDraft() : newDoc(); };
  // V4.14.1 修复：采购订单「返回列表」按钮此前未绑定事件（死按钮）
  view.querySelector('#poBackList').onclick = () => showPage('list');
  const bindSupplierProducts = () => { products = allProducts; };
  const resolveHeaderSid = () => {
    const name = view.querySelector('#poSupIn').value.trim();
    if (!name) return 0;
    const s = supList.find(x => x.name === name) ||
      supList.find(x => (x.name || '').includes(name) || name.includes(x.name || ''));
    return s ? Number(s.id) : -1;   // -1 = 输入了但匹配不到
  };

  function snapshotDraft() {
    draftCache = {
      sup: view.querySelector('#poSupIn').value,
      date: view.querySelector('#poDate').value,
      memo: view.querySelector('#poMemo').value,
      lines: lines.map(l => ({ ...l, _p: undefined })),
    };
  }
  function newDoc() {
    lines.length = 0;
    lines.push(makeLine());
    view.querySelector('#poMemo').value = '';
    view.querySelector('#poDate').value = d3;
    drawLines();
  }
  function restoreDraft() {
    if (!draftCache) return newDoc();
    lines.length = 0;
    for (const l of draftCache.lines) {
      const p = allProducts.find(x => String(x.id) === String(l.productId)) || null;
      lines.push({ ...l, _p: p });
    }
    view.querySelector('#poSupIn').value = draftCache.sup || '';
    view.querySelector('#poDate').value = draftCache.date || d3;
    view.querySelector('#poMemo').value = draftCache.memo || '';
    if (!lines.length) lines.push(makeLine());
    drawLines();
  }

  /* ── 开单：条码定位录入表格 ── */
  function sums() {
    const q = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 1), 0);
    const a = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
    view.querySelector('#poSumQty').textContent = String(Math.round(q * 1000) / 1000);
    view.querySelector('#poSumAmt').textContent = fmt(a);
    view.querySelector('#poFootAmt').textContent = fmt(a);
    view.querySelector('#poCount').textContent = `明细 ${lines.length} 行`;
    view.querySelector('#poStat').textContent = lines.length ? `录入中 · ${lines.length} 行` : '录入中';
    snapshotDraft();   // V4.9.6 实时缓存草稿（切菜单不丢）
  }
  function drawLines() {
    renderLines(view.querySelector('#poLines'), lines, {
      products, unitsCache, price: true, prodDate: false, stock: true, today, supCol: true, onSum: sums,
    });
  }
  view.querySelector('#poReset').onclick = () => { draftCache = null; newDoc(); };
  view.querySelector('#poSubmit').onclick = async () => {
    const headerSid = resolveHeaderSid();
    if (headerSid === -1) return toast('供应商名称未匹配到档案，请从下拉建议中选择', false);
    // V4.9.6 🤖 智能分组：按商品所属供应商分组，一次生成多张采购单
    const groups = new Map();   // sid -> items
    const noSup = [];
    for (const l of lines) {
      if (!l.productId || !(Number(l.qty) > 0)) continue;
      const b = toBase(l);
      const item = { productId: Number(l.productId), orderQty: b.qty, price: b.unitCost, lineRemark: (l.remark || '').trim() || undefined };
      const sid = Number(l._p && l._p.supplier_default_id) || headerSid;
      if (!sid) { noSup.push(l._p ? l._p.name : l._q); continue; }
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid).push(item);
    }
    if (noSup.length) return toast(`以下商品未绑定供应商且未指定供应商，请先在商品档案设置：${noSup.join('、')}`, false);
    if (!groups.size) return toast('无有效明细行（需定位商品+数量>0）', false);
    const expectArrival = view.querySelector('#poDate').value || undefined;
    const memo = view.querySelector('#poMemo').value.trim() || undefined;
    const nos = [...groups.keys()];
    const saved = [];
    for (const sid of nos) {
      const d = await must(post('/purchase/orders', {
        supplierId: sid, expectArrival, remark: memo, items: groups.get(sid),
      }), nos.length > 1 ? `分组 ${saved.length + 1}/${nos.length} 已保存` : '采购订单已保存（草稿）');
      if (d) saved.push(d);
    }
    if (saved.length === nos.length) {
      draftCache = null;
      toast(nos.length > 1
        ? `🤖 已按供应商智能拆分生成 ${nos.length} 张采购单`
        : '采购订单已保存（草稿）');
      showPage('list');
    }
  };

  /* ── 浏览：筛选 / 勾选删除 / 状态流转 ── */
  let qStatus = '';
  view.querySelectorAll('#poStatSel .segbtn').forEach(b => b.onclick = () => {
    view.querySelectorAll('#poStatSel .segbtn').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); qStatus = b.dataset.v; loadList();
  });
  view.querySelector('#poGo').onclick = loadList;
  view.querySelector('#poRefresh').onclick = loadList;
  view.querySelector('#poDel').onclick = async () => {
    const ids = [...poSel];
    if (!ids.length) return;
    if (!await confirmBox({
      title: '🗑 删除采购订单',
      html: `确认删除 ${ids.length} 张未产生业务的订单？\n删除后不可恢复（审计留痕）。`,
    })) return;
    let ok = 0; const errs = [];
    for (const id of ids) {
      try { await must(del(`/purchase/orders/${id}`)); ok++; poSel.delete(Number(id)); }
      catch (e) { errs.push(e.msg || e.message); }
    }
    if (errs.length) toast(`成功 ${ok} 张，失败 ${errs.length} 张：${errs[0]}`, false);
    else toast(`已删除 ${ok} 张订单`);
    syncDelBtn();
    loadList();
  };
  function syncDelBtn() {
    view.querySelector('#poDel').style.display = poSel.size ? '' : 'none';
    view.querySelector('#poDelN').textContent = String(poSel.size);
  }

  /* ── 审批签名板 ── */
  const signModal = view.querySelector('#signModal');
  const sgPad = view.querySelector('#sgPad');
  const sgCtx = sgPad.getContext('2d');
  sgCtx.lineWidth = 2.2; sgCtx.lineCap = 'round'; sgCtx.strokeStyle = '#111';
  let sgDraw = false, sgLast = null;
  const sgPos = e => { const r = sgPad.getBoundingClientRect();
    return { x: (e.clientX - r.left) * sgPad.width / r.width, y: (e.clientY - r.top) * sgPad.height / r.height }; };
  sgPad.onpointerdown = e => { sgDraw = true; sgLast = sgPos(e); sgPad.setPointerCapture(e.pointerId); };
  sgPad.onpointermove = e => { if (!sgDraw) return; const p = sgPos(e);
    sgCtx.beginPath(); sgCtx.moveTo(sgLast.x, sgLast.y); sgCtx.lineTo(p.x, p.y); sgCtx.stroke(); sgLast = p; };
  sgPad.onpointerup = sgPad.onpointercancel = () => { sgDraw = false; };
  const sgClearPad = () => sgCtx.clearRect(0, 0, sgPad.width, sgPad.height);
  view.querySelector('#sgClear').onclick = sgClearPad;
  view.querySelector('#sgCancel').onclick = () => { signModal.style.display = 'none'; };
  view.querySelector('#sgGo').onclick = async () => {
    if (!sgCtx.getImageData(0, 0, sgPad.width, sgPad.height).data.some(v => v !== 0)) return toast('请先在签字板上签名', false);
    try {
      await must(post(`/purchase/orders/${signPoId}/approve`, { signature: sgPad.toDataURL('image/png') }), '审批通过（已下单），签名已留痕');
      signModal.style.display = 'none';
      loadList();
      if (detailPoId === signPoId) openDetail(signPoId);
      autoPrintA5AfterAudit('order', [signPoId]);   // V4.15.7 设置开启时审批通过自动弹 A5
    } catch (e) { toast(e.message, false); }
  };

  /* ── 作废弹窗（V4.9.6 二次确认风险） ── */
  const voidModal = view.querySelector('#voidModal');
  view.querySelector('#voidCancel').onclick = () => { voidModal.style.display = 'none'; };
  view.querySelector('#voidGo').onclick = async () => {
    const reason = view.querySelector('#voidReason').value.trim();
    if (!reason) return toast('作废原因必填（留痕）', false);
    // V4.9.7 样式化二次确认（提醒作废风险）
    if (!await confirmBox({
      title: '⚠️ 作废二次确认',
      html: '作废后单据不可恢复、相关到货计划失效。\n确定继续作废吗？',
      okText: '确认作废',
    })) return;
    await must(post(`/purchase/orders/${voidPoId}/void`, { reason }), '订单已作废');
    voidModal.style.display = 'none';
    loadList();
  };

  /* ── 明细弹窗（双击行打开；草稿可编辑保存；审批后可打印含签字） ── */
  async function openDetail(id) {
    const o = await must(get('/purchase/orders/' + id));
    if (!o) return;
    detailPoId = Number(id);
    detailStatus = o.status || '';
    const stTxt = STATUS_TXT[o.status] || o.status || '';
    const signImg = o.approver_sign_path
      ? ` <img src="${esc(imgUrl(o.approver_sign_path))}" style="height:38px;vertical-align:middle;border:1px dashed var(--line);border-radius:6px;background:#fff" title="审批人电子签名">` : '';
    view.querySelector('#poModalTitle').textContent = `采购订单 ${o.po_no || ''}`;
    view.querySelector('#poMeta').innerHTML = `
      供应商：<b>${esc(o.supplier_name || '')}</b>　
      状态：<span class="tag ${STATUS_TAG[o.status] || 'y'}">${esc(stTxt)}</span>　
      预计到货：${o.expect_arrival ? String(o.expect_arrival).slice(0, 10) : '—'}　
      备注：${esc(o.remark || '—')}
      ${o.approver_name ? `　审批人：<b>${esc(o.approver_name)}</b>${signImg}　审批时间：${dt(o.approved_at)}` : ''}
      ${o.void_reason ? `　<span style="color:#c0392b">作废原因：${esc(o.void_reason)}</span>` : ''}`;
    const editable = o.status === '草稿';
    const its = o.items || [];
    view.querySelector('#poSaveDraft').style.display = editable ? '' : 'none';
    view.querySelector('#poPrint').style.display = APPROVABLE.includes(o.status) ? '' : 'none';
    if (editable) {
      detailLines = its.map(it => {
        const p = allProducts.find(x => String(x.id) === String(it.product_id)) || null;
        return makeLine({ productId: it.product_id, _p: p, _q: p ? p.barcode || '' : '',
          qty: Number(it.order_qty), unitCost: it.price ?? '', remark: it.line_remark || '' });
      });
      if (!detailLines.length) detailLines.push(makeLine());
      view.querySelector('#poItems').innerHTML = `
        <div class="doc-tip" style="margin-bottom:6px">📝 草稿单据可修改：条码定位增改行、数量/进价/备注可编辑，保存后重新合计</div>
        <table>
          <thead><tr><th style="width:70px">＋/−</th><th style="width:38px">序号</th><th>条码</th><th>名称</th><th>单位</th>
            <th>类别</th><th>规格</th><th style="width:82px">订购数量</th><th style="width:88px">含税进价</th>
            <th style="width:60px">库存</th><th>行备注</th><th class="num">金额</th></tr></thead>
          <tbody id="poDetailLines"></tbody>
        </table>`;
      renderLines(view.querySelector('#poDetailLines'), detailLines, {
        products: allProducts, unitsCache, price: true, prodDate: false, stock: true, today, qtyLabel: '数量', onSum: () => {},
      });
    } else {
      view.querySelector('#poItems').innerHTML = its.length ? `
        <table><thead><tr><th>序号</th><th>条码</th><th>商品</th><th>单位</th><th class="num">订购数量</th>
          <th class="num">已到货</th><th class="num">含税进价</th><th class="num">金额</th><th>到货状态</th></tr></thead>
        <tbody>${its.map((it, i) => {
          const p = allProducts.find(x => String(x.id) === String(it.product_id));
          const arrived = Number(it.arrived_qty || 0), order = Number(it.order_qty || 0);
          const lineStat = arrived >= order ? '<span class="tag g">已到齐</span>'
            : arrived > 0 ? `<span class="tag y">部分到货 ${arrived}</span>` : '<span class="tag b">待收</span>';
          return `<tr><td class="num">${i + 1}</td><td class="mono">${esc(p ? p.barcode || '—' : '—')}</td><td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '—')}</td>
            <td class="num">${order}</td><td class="num">${arrived}</td>
            <td class="num">${it.price != null ? money(it.price) : '—'}</td>
            <td class="num">${money(order * (Number(it.price) || 0))}</td><td>${lineStat}</td></tr>`;
        }).join('')}</tbody></table>`
        : '<div class="empty">无明细</div>';
    }
    view.querySelector('#poModal').style.display = 'flex';
  }
  // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）
  // V4.15.7 P3：打印按钮走统一 docprint（份数选择 + 留痕）
  view.querySelector('#poPrint').onclick = () => {
    if (!detailPoId) return;
    if (!canPrintA5()) { toast('需要「A5单据打印」权限（店长及以上）', false); return; }
    openA5Print('order', [detailPoId]);
  };
  view.querySelector('#poSaveDraft').onclick = async () => {
    const items = detailLines.filter(l => l.productId && Number(l.qty) > 0).map(l => {
      const b = toBase(l);
      return { productId: Number(l.productId), orderQty: b.qty, price: b.unitCost, lineRemark: (l.remark || '').trim() || undefined };
    });
    if (!items.length) return toast('无有效明细行', false);
    await must(put(`/purchase/orders/${detailPoId}`, { items }), '草稿明细已更新');
    view.querySelector('#poModal').style.display = 'none';
    loadList();
  };

  /* ── 浏览列表：取数后缓存 poRows，drawList 按 10 条/页本地分页重画 ── */
  let poRows = [];
  let poPage = 1;
  async function loadList() {
    const p = new URLSearchParams();
    // V4.9.7 供应商改输入匹配（名称精确/模糊 → id）
    const supName = view.querySelector('#poQSup').value.trim();
    const supHit = supName ? supList.find(x => x.name === supName)
      || supList.find(x => (x.name || '').includes(supName) || supName.includes(x.name || '')) : null;
    const from = view.querySelector('#poFrom').value, to = view.querySelector('#poTo').value;
    if (supHit) p.set('supplierId', supHit.id);
    if (qStatus) p.set('status', qStatus);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const d = await must(get('/purchase/orders?' + p));
    poRows = Array.isArray(d) ? d : (d.items || []);
    poPage = 1;
    const sum = poRows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
    view.querySelector('#poQSum').textContent = fmt(sum);
    view.querySelector('#poQCount').textContent = `共 ${poRows.length} 张订单`;
    drawList();
  }
  function drawList() {
    const rows = poRows;
    const pg = paginate(rows, poPage, 10);
    poPage = pg.page;
    // V4.26.2 合并为一列后，回显条件必须与勾选范围一致：本页所有单据都在选择集合里才算「全选」
    // （原来只统计可删行，导致全选后表头复选框不复原、看起来"只能全选不能取消"）
    const allChecked = rows.length > 0 && rows.every(o => poSel.has(Number(o.id)));
    view.querySelector('#poList').innerHTML = rows.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="poChkAll" title="全选/取消全选" ${allChecked ? 'checked' : ''}></th>
        <th>单号</th><th>供应商</th><th class="num">数量</th><th class="num">金额</th>
        <th>预计到货</th><th>创建</th><th>来源</th><th>状态</th><th style="width:190px">操作</th></tr></thead>
      <tbody>${rows.map(o => {
        const deletable = DELETABLE.includes(o.status);
        const cancellable = o.status !== '已取消';   // V4.9.6 已完成也可作废
        return `<tr data-po="${o.id}" style="cursor:pointer" title="双击查看单据详情">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-pochk="${o.id}" data-deletable="${deletable ? 1 : 0}" ${poSel.has(Number(o.id)) ? 'checked' : ''} title="${deletable ? '勾选：批量打印 / 批量删除' : '勾选：批量打印（已产生业务的单据不可删除，可作废）'}"></td>
        <td style="font-family:var(--mono);font-weight:600">${esc(o.po_no)}</td>
        <td>${esc(o.supplier_name || '')}</td>
        <td class="num">${Math.round(Number(o.total_qty ?? o.totalQty ?? 0))}</td>
        <td class="num">${money(o.total_amount ?? o.totalAmount)}</td>
        <td>${o.expect_arrival ? String(o.expect_arrival).slice(0, 10) : '—'}</td>
        <td>${dt(o.created_at || o.createdAt)}</td>
        <td><span class="tag ${o.source === '补货建议' ? 'b' : o.source === '订货申请' ? 'y' : o.source === '库存缺货' ? 'n' : ''}" title="单据来源">${esc(o.source_label || '自建')}</span></td>
        <td><span class="tag ${STATUS_TAG[o.status] || 'y'}">${esc(STATUS_TXT[o.status] || o.status)}</span></td>
        <td style="white-space:nowrap">
          ${o.status === '草稿' ? `<button class="btn sm" data-submit="${o.id}">提交审批</button>` : ''}
          ${o.status === '待审批' && canApprove ? `<button class="btn sm pri" data-approve="${o.id}">✓ 审批</button>` : ''}
          ${cancellable ? `<button class="btn sm warn" data-void="${o.id}">作废</button>` : ''}
        </td>
      </tr>`; }).join('')}</tbody></table>
      ${pg.bar}`
      : '<div class="empty">无符合条件的采购订单</div>';
    bindPager(view.querySelector('#poList'), p => { poPage = p; drawList(); });
    // V4.9.6 双击行任意处打开明细；表头复选框全选/取消全选（仅可删行）
    view.querySelectorAll('[data-po]').forEach(tr => tr.ondblclick = () => openDetail(tr.dataset.po));
    const chkAll = view.querySelector('#poChkAll');
    if (chkAll) chkAll.onchange = () => {
      // V4.26.2 合并为一列：勾选范围放开到本页所有单据（供批量打印），
      // 批量删除/审核时再按状态过滤（不可操作的会被后端拒绝并提示）。
      rows.forEach(o => { if (chkAll.checked) poSel.add(Number(o.id)); else poSel.delete(Number(o.id)); });
      loadList();
      syncDelBtn();
      syncPrBtn();   // V4.26.2：批量打印按钮与选择集合共用，全选后需同步显示/计数
    };
    view.querySelectorAll('[data-pochk]').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.pochk);
      if (cb.checked) poSel.add(id); else poSel.delete(id);
      syncDelBtn();
      syncPrBtn();   // V4.26.2：打印按钮与选择集合共用，需同步计数
    });
    view.querySelectorAll('[data-submit]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      await must(post(`/purchase/orders/${b.dataset.submit}/submit`), '已提交审批');
      loadList();
    });
    view.querySelectorAll('[data-approve]').forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      signPoId = Number(b.dataset.approve);
      sgClearPad();
      signModal.style.display = 'flex';
    });
    view.querySelectorAll('[data-void]').forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      voidPoId = Number(b.dataset.void);
      view.querySelector('#voidReason').value = '';
      voidModal.style.display = 'flex';
    });
    syncDelBtn();
  }

  const [sups, prods] = await Promise.all([
    must(get('/purchase/suppliers')).catch(() => ({})),
    must(get('/products?size=500')).catch(() => ({})),
  ]);
  const supList = sups.items || sups || [];
  allProducts = prods.items || prods || [];
  bindSupplierProducts();
  view.querySelector('#poSupDl').innerHTML = supList.map(s => `<option value="${esc(s.name)}">`).join('');
  view.querySelector('#poQSupDl7').innerHTML = supList.map(s => `<option value="${esc(s.name)}">`).join('');
  // V4.9.7 进入页面固定落在列表页（草稿仍在，点「＋新增订单」可恢复编辑，不再直接跳到新增页）
  newDoc();
  await loadList().catch(() => {});
}
