import { get, post, del, must, money, esc, dt, toast, imgUrl, API } from '../api.js';
import { signCell, signBtn, handleSignInfo, mountSignActions } from './signpad.js';
import { renderLines, makeLine, toBase, createUnitsCache, loadSupplierProducts, loadBatchesFor } from './docentry.js';
import { confirmBox } from '../ui.js';
import { openA5Print, autoPrintA5AfterAudit, canPrintA5 } from '../docprint.js';
import { pagerBar, bindPager } from '../common-ui.js';

/** 采购入库（V4.9.6：数量列整数 · 已作废可勾删 · 表头全选复选框 · 打印移明细弹窗（含操作员签字）
 *  · 双击行开明细 · 供应商输入匹配 · 新建页切换标签保留草稿） */

let draftCache = null;   // V4.9.6 新建页草稿缓存（切菜单不丢；采购单预填场景除外）

/* V4.15.7 P3：A5 打印统一收敛到 docprint.js（七类版式 + 份数 + 留痕），本屏旧 printDoc/printInbound 已移除 */

export async function render(view) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  // 关联采购订单（#/purchase?po=ID）：预填未到货明细，保存时回传 poId 并回写到货量
  let poId = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('po')) || 0;
  let poNo = '';
  view.innerHTML = `
    <div id="tab-new" style="display:none">
      <div class="card">
        <div class="doc-tools">
          <button class="btn" id="puBackList">← 返回列表</button>
          <span style="font-weight:700;font-size:14.5px">📥 新建采购入库单</span>
          <span class="pill o" id="docStat">录入中</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn" id="iReset">删单重录</button>
            <button class="btn pri" id="iSubmit">💾 保存单据</button>
          </span>
        </div>
        <div class="doc-head">
          <div class="fld"><label class="req">供应商</label><input id="iSup" list="iSupDl" placeholder="输入名称快速匹配" style="flex:1;min-width:0">
            <datalist id="iSupDl"></datalist></div>
          <div class="fld"><label>制单人</label><input id="iMaker" value="${esc(API.user?.name || '')}" readonly></div>
          <div class="fld"><label class="req">单据日期</label><input id="iDate" type="date" value="${today}"></div>
          <div class="fld"><label>备注</label><input id="iMemo" placeholder="备注（选填）"></div>
        </div>
        <div class="doc-grid" style="padding:6px 18px 4px">
          <table>
            <thead><tr><th style="width:70px">＋/−</th><th style="width:38px">序号</th><th>条码</th><th>名称</th><th>单位</th>
              <th>类别</th><th>规格</th><th style="width:82px" id="iQtyHead">数量</th><th style="width:88px">含税进价</th>
              <th style="width:78px">售价</th><th style="width:136px">生产日期</th><th style="width:56px">库存</th><th>备注</th><th class="num">金额</th></tr></thead>
            <tbody id="iLines"></tbody>
            <tfoot><tr><td colspan="7">合计</td><td class="num" id="iSumQty">0</td><td></td><td></td>
              <td></td><td></td><td></td><td class="num" id="iSumAmt">0.00</td></tr></tfoot>
          </table>
        </div>
        <div class="doc-tip">💡 「条码」列扫码枪 / 手输条码 / 输名称定位商品（仅限当前供应商供应的商品）：自动带出名称·单位·类别·规格·<b>上次含税进价</b>·<b>档案售价</b>·库存，并按历史最低价做<b>低价保护提示</b>；进价可改、<b>售价改后审核即更新商品档案最新售价</b>；条码未识别可选择 <b>AI 自动建品入库</b>；数量默认整数（散称商品支持小数）。</div>
        <div class="doc-foot">
          <span class="muted" id="iCount">明细 0 行</span>
          <span class="sum">单据金额：<b id="iFootAmt">0.00</b> 元</span>
        </div>
      </div>
    </div>

    <div id="tab-list">
      <div class="card">
        <div class="doc-head" style="grid-template-columns:1.5fr 1fr 1.2fr auto;align-items:end">
          <div class="fld"><label>单据日期</label><span style="display:flex;gap:4px;align-items:center"><input id="qFrom" type="date" value="${monthStart}" style="flex:1;min-width:0"><span style="color:var(--ink-3)">~</span><input id="qTo" type="date" value="${today}" style="flex:1;min-width:0"></span></div>
          <div class="fld"><label>供应商</label><input id="qSup" placeholder="输入名称快速匹配（留空=全部）" style="min-width:150px"></div>
          <div class="fld"><label>审核状态</label><span class="seg" id="qStat" style="display:flex;gap:2px;flex-wrap:wrap">
            <button class="btn sm segbtn" data-v="未审核">未审核</button>
            <button class="btn sm segbtn" data-v="已审核">已审核</button>
            <button class="btn sm segbtn" data-v="已作废">已作废</button>
            <button class="btn sm segbtn on" data-v="">全部</button></span></div>
          <div class="fld"><label>&nbsp;</label><span style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn pri" id="qGo">🔍 查询</button>
            <button class="btn" id="qRefresh">刷新</button>
            <button class="btn" id="qBatch">批量审核</button>
            <button class="btn" id="qPrints" style="display:none">🖨 打印所选(<b id="qPrN">0</b>)</button>
            <button class="btn" id="qDel" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 删除(<b id="qDelN">0</b>)</button>
            <button class="btn pri" id="puNewDoc" style="white-space:nowrap">＋ 新增入库单</button>
          </span></div>
        </div>
        <div style="padding:10px 18px 16px;height:calc(100dvh - 210px);min-height:420px;overflow:auto" id="iList"></div>
        <div class="doc-foot"><span class="muted" id="qCount"></span>
          <span class="sum">金额合计：<b id="qSum">0.00</b> 元</span></div>
      </div>
    </div>

    <div class="modal-mask" id="inModal" style="display:none">
      <div class="modal" style="width:auto;min-width:760px;max-width:96vw;max-height:90dvh;overflow:auto">
        <h3 id="inModalTitle">入库单详情</h3>
        <div id="inMeta" style="font-size:12.5px;line-height:1.9;color:var(--ink-2);margin:6px 0 10px"></div>
        <div id="inItems"></div>
        <div class="doc-foot">
          
          <span style="flex:1"></span>
          <button class="btn" id="inPrint">🖨 打印</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="opSignModal" style="display:none">
      <div class="modal" style="width:640px">
        <h3>✍️ 操作员电子签字采集</h3>
        <div class="doc-tip">该单据已保存。按规范采集<b>操作员本人</b>电子签字入库签字库：需采集 <b>3 次</b>（当前已采 <b id="osDone">0</b> / 3），签满 3 次后自动关闭。</div>
        <div class="fld" style="margin:10px 0"><label>签字人</label><input id="osName" value="${esc(API.user?.name || '')}" readonly style="background:var(--paper-2)"></div>
        <canvas id="osPad" width="560" height="170" style="border:1px dashed var(--line);border-radius:8px;touch-action:none;cursor:crosshair;width:100%"></canvas>
        <div class="bar" style="margin-top:8px"><button class="btn sm" id="osClear">🧽 清除重签</button></div>
        <div class="doc-foot">
          <button class="btn" id="osLater">稍后再签</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="osGo">✓ 保存本次签字</button>
        </div>
      </div>
    </div>`;

  const lines = [];
  const unitsCache = createUnitsCache();
  let allProducts = [];
  let products = [];      // 当前供应商可供商品
  const delSel = new Set();
  const inPrSel = delSel;   // V4.26.2 合并为一列：批量打印复用「选择」集合（原为独立 Set）
  function syncPrBtn() {
    const btn = view.querySelector('#qPrints');
    if (!btn) return;
    btn.style.display = inPrSel.size ? '' : 'none';
    view.querySelector('#qPrN').textContent = String(inPrSel.size);
  }
  view.querySelector('#qPrints').onclick = () => { if (inPrSel.size) openA5Print('inbound', [...inPrSel]); };
  // V4.15.1 入库单列表每页 15 条分页
  const IB_SIZE = 15;
  let ibRows = [], ibPage = 1, ibPages = 1;
  const fmt = n => (Number(n) || 0).toFixed(2);
  let detailId = 0;

  /* ── 分页式：列表页 ⇄ 新增页 ── */
  const showPage = (mode) => {
    view.querySelector('#tab-new').style.display = mode === 'new' ? '' : 'none';
    view.querySelector('#tab-list').style.display = mode === 'list' ? '' : 'none';
    if (mode === 'list') { try { loadList(); } catch { /* 切页不阻断 */ } }
  };
  view.querySelector('#puNewDoc').onclick = () => { showPage('new'); draftCache ? restoreDraft() : newDoc(); };
  view.querySelector('#puBackList').onclick = () => showPage('list');

  /* V4.9.6 供应商输入匹配（datalist）→ 商品绑定过滤 */
  const resolveSupId = () => {
    const name = view.querySelector('#iSup').value.trim();
    if (!name) return 0;
    const s = supList.find(x => x.name === name) ||
      supList.find(x => (x.name || '').includes(name) || name.includes(x.name || ''));
    return s ? Number(s.id) : 0;
  };
  const bindSupplierProducts = async () => {
    const sid = resolveSupId();
    products = await loadSupplierProducts(sid, allProducts);
    await loadBatchesFor(products);
    const okIds = new Set(products.map(p => String(p.id)));
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].productId && !okIds.has(String(lines[i].productId))) lines.splice(i, 1);
    }
    drawLines();
  };
  view.querySelector('#iSup').addEventListener('input', () => {
    clearTimeout(view.__supT);
    view.__supT = setTimeout(bindSupplierProducts, 350);
  });

  function snapshotDraft() {
    if (poId) return;   // 采购单预填场景不缓存
    draftCache = {
      sup: view.querySelector('#iSup').value,
      date: view.querySelector('#iDate').value,
      memo: view.querySelector('#iMemo').value,
      qtyHead: view.querySelector('#iQtyHead').textContent,
      lines: lines.map(l => ({ ...l, _p: undefined })),
    };
  }
  function newDoc() {
    lines.length = 0;
    lines.push(makeLine({ productionDate: today }));
    if (poId) history.replaceState(null, '', '#/purchase/in');
    poId = 0; poNo = '';
    view.querySelector('#iQtyHead').textContent = '数量';
    view.querySelector('#iMemo').value = '';
    drawLines();
  }
  function restoreDraft() {
    if (!draftCache) return newDoc();
    lines.length = 0;
    for (const l of draftCache.lines) {
      const p = allProducts.find(x => String(x.id) === String(l.productId)) || null;
      lines.push({ ...l, _p: p });
    }
    view.querySelector('#iSup').value = draftCache.sup || '';
    view.querySelector('#iDate').value = draftCache.date || today;
    view.querySelector('#iMemo').value = draftCache.memo || '';
    view.querySelector('#iQtyHead').textContent = draftCache.qtyHead || '数量';
    if (!lines.length) lines.push(makeLine({ productionDate: today }));
    drawLines();
  }

  /* ── 开单：条码定位录入表格 ── */
  function sums() {
    const q = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 1), 0);
    const a = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
    view.querySelector('#iSumQty').textContent = String(Math.round(q * 1000) / 1000);
    view.querySelector('#iSumAmt').textContent = fmt(a);
    view.querySelector('#iFootAmt').textContent = fmt(a);
    view.querySelector('#iCount').textContent = `明细 ${lines.length} 行`;
    view.querySelector('#docStat').textContent = poNo
      ? `📋 采购单 ${poNo}${lines.length ? ` · ${lines.length} 行` : ''}`
      : lines.length ? `录入中 · ${lines.length} 行` : '录入中';
    snapshotDraft();
  }
  function drawLines() {
    renderLines(view.querySelector('#iLines'), lines, {
      products, unitsCache, price: true, sell: true, prodDate: true, stock: true, today,
      lowProtect: true, onSum: sums,
      onUnknown: onUnknownBarcode,
    });
  }
  /* V4.9.5 条码未识别 → AI 建品分流 */
  function onUnknownBarcode(val, rowIdx) {
    const v = String(val || '').trim();
    if (!v) return toast('请先扫码或输入条码', false);
    if (confirm(`未识别到商品：${v}\n\n「确定」= 提交时 AI 自动创建新商品并入库（名称待完善，事后在商品档案补全）\n「取消」= 暂不处理（可先到商品档案手动新建）`)) {
      const l = lines[rowIdx];
      l._aiCreate = true;
      l._q = v;
      toast(`已标记 AI 建品：${v}（提交入库单时自动创建商品档案）`);
      drawLines();
      const qty = view.querySelector(`input[data-f="qty"][data-i="${rowIdx}"]`);
      qty && qty.focus();
    }
  }
  view.querySelector('#iReset').onclick = () => { draftCache = null; newDoc(); };
  view.querySelector('#iSubmit').onclick = async () => {
    const sid = resolveSupId();
    if (!sid) return toast('请输入并选择供应商', false);
    const items = [];
    for (const l of lines) {
      if (l._aiCreate && !l.productId) {
        if (!(Number(l.qty) > 0)) continue;
        const b = toBase(l);
        items.push({ barcode: String(l._q || '').trim(), aiCreate: true, qty: b.qty, unitCost: b.unitCost,
          sellPrice: Number(l.sellPrice) > 0 ? Number(l.sellPrice) : undefined,
          productionDate: l.productionDate || today });
        continue;
      }
      if (!l.productId || !(Number(l.qty) > 0)) continue;
      const b = toBase(l);
      items.push({ productId: Number(l.productId), qty: b.qty, unitCost: b.unitCost,
        sellPrice: Number(l.sellPrice) > 0 ? Number(l.sellPrice) : undefined,
        productionDate: l.productionDate || today });
    }
    if (!items.length) return toast('无有效明细行（需定位商品+数量>0）', false);
    if (items.some(it => !it.productionDate)) return toast('生产日期必填（V4.3.6）', false);
    const d = await must(post('/purchase/inbounds', {
      supplierId: sid,
      ...(poId ? { poId } : {}), items }),
      poId ? `入库单已保存（已回写采购订单 ${poNo} 到货量）` : '入库单已保存（未审核）');
    if (d) {
      draftCache = null;
      showPage('list');
      handleSignInfo(view, d.signInfo, { bizType: 'inbound', bizId: d.id, onDone: loadList });
      await maybeCollectOperatorSigns();   // V4.9.5 操作员签字（≥3 次存签字库）
    }
  };

  /* ── V4.9.5 操作员电子签字：签字库中本人有效签字 <3 → 弹板补采至 3 ── */
  async function operatorSignCount() {
    try {
      const d = await must(get('/purchase/signatures'));
      const uid = Number(API.user?.id ?? API.user?.sub ?? 0);
      const items = (d && d.items) || [];
      return items.filter(t => t.ref_employee_id === uid && Number(t.status) === 1).length;
    } catch { return 3; }   // 查询失败不阻断业务
  }
  async function maybeCollectOperatorSigns() {
    let done = await operatorSignCount();
    if (done >= 3) return;
    const modal = view.querySelector('#opSignModal');
    const pad = view.querySelector('#osPad');
    const ctx = pad.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    let draw = false, last = null;
    const pos = e => { const r = pad.getBoundingClientRect();
      return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
    pad.onpointerdown = e => { draw = true; last = pos(e); pad.setPointerCapture(e.pointerId); };
    pad.onpointermove = e => { if (!draw) return; const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; };
    pad.onpointerup = pad.onpointercancel = () => { draw = false; };
    const clear = () => ctx.clearRect(0, 0, pad.width, pad.height);
    view.querySelector('#osClear').onclick = clear;
    view.querySelector('#osLater').onclick = () => { modal.style.display = 'none'; toast('已稍后再签（下次保存入库单时会再次提醒）', false); };
    view.querySelector('#osDone').textContent = String(done);
    const syncTip = () => {
      view.querySelector('#osDone').textContent = String(done);
      if (done >= 3) { modal.style.display = 'none'; toast('操作员签字已采满 3 次，已存入电子签字库'); }
    };
    view.querySelector('#osGo').onclick = async () => {
      if (!ctx.getImageData(0, 0, pad.width, pad.height).data.some(v => v !== 0)) return toast('请先在签字板上签名', false);
      const uid = Number(API.user?.id ?? API.user?.sub ?? 0);
      await must(post('/purchase/signatures', {
        personName: API.user?.name || '操作员', roleTitle: '操作员',
        image: pad.toDataURL('image/png'), refEmployeeId: uid || undefined,
      }), `签字 ${done + 1}/3 已存入电子签字库`);
      clear(); done += 1; syncTip();
    };
    modal.style.display = 'flex';
  }

  /* ── 浏览：查询/批量审核/作废/删除 ── */
  let qStatus = '';
  view.querySelectorAll('#qStat .segbtn').forEach(b => b.onclick = () => {
    view.querySelectorAll('#qStat .segbtn').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); qStatus = b.dataset.v; loadList();
  });
  view.querySelector('#qGo').onclick = loadList;
  view.querySelector('#qRefresh').onclick = loadList;
  view.querySelector('#qBatch').onclick = async () => {
    const ids = [...view.querySelectorAll('[data-chk]:checked')].filter(c => c.dataset.auditable === '1').map(c => c.dataset.chk);
    if (!ids.length) return toast('请勾选未审核的入库单', false);
    for (const id of ids) await post(`/purchase/inbounds/${id}/audit`);
    toast(`已批量审核 ${ids.length} 张，批次已生成`);
    loadList();
  };
  view.querySelector('#qDel').onclick = async () => {
    const ids = [...delSel];
    if (!ids.length) return;
    if (!await confirmBox({
      title: '🗑 删除入库单',
      html: `确认删除 ${ids.length} 张未产生业务的入库单（含已作废）？\n删除后不可恢复（审计留痕）。`,
    })) return;
    let ok = 0; const errs = [];
    for (const id of ids) {
      try { await must(del(`/purchase/inbounds/${id}`)); ok++; delSel.delete(Number(id)); }
      catch (e) { errs.push(e.msg || e.message); }
    }
    if (errs.length) toast(`成功 ${ok} 张，失败 ${errs.length} 张：${errs[0]}`, false);
    else toast(`已删除 ${ok} 张入库单`);
    syncDelBtn();
    loadList();
  };
  function syncDelBtn() {
    view.querySelector('#qDel').style.display = delSel.size ? '' : 'none';
    view.querySelector('#qDelN').textContent = String(delSel.size);
  }

  /* ── 双击行：入库单详情（弹窗自适应宽度；打印含操作员电子签字） ── */
  const inModal = view.querySelector('#inModal');
  async function openDetail(id) {
    const d = await must(get(`/purchase/inbounds/${id}`));
    const o = d.order || {}, its = d.items || [];
    detailId = Number(id);
    view.querySelector('#inModalTitle').textContent = `入库单 ${o.inbound_no || ''}`;
    const signImgHtml = o.sign_image_path
      ? `　操作员签字：<img src="${esc(imgUrl(o.sign_image_path))}" style="height:34px;vertical-align:middle;border:1px dashed var(--line);border-radius:6px;background:#fff">` : '';
    view.querySelector('#inMeta').innerHTML = `
      供应商：<b>${esc(o.supplier_name || '')}</b>　
      状态：<span class="tag ${o.status === '已审核' ? 'g' : o.status === '已作废' ? 'r' : 'y'}">${esc(o.status || '')}</span>　
      制单人：${esc(o.maker_name || '—')}　
      日期：${(o.created_at || '').slice(0, 10)}　
      大批次：<span class="mono">${esc(o.inbound_no || '—')}</span>（同一张入库单一个大批次）　
      ${o.po_id ? `关联采购订单：#${o.po_id}` : ''}${signImgHtml}`;
    view.querySelector('#inItems').innerHTML = its.length ? `
      <table><thead><tr><th>序号</th><th>条码</th><th>商品</th><th>单位</th><th class="num">数量</th>
        <th class="num">进价</th><th class="num">售价</th><th>生产日期</th><th>批次</th><th class="num">进货金额</th></tr></thead>
      <tbody>${its.map((it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="mono">${esc(it.barcode || '—')}</td>
        <td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '')}</td>
        <td class="num">${it.qty}</td><td class="num">${Number(it.unit_cost).toFixed(2)}</td>
        <td class="num">${it.sell_price != null ? Number(it.sell_price).toFixed(2) : '—'}</td>
        <td>${String(it.production_date).slice(0, 10)}</td>
        <td class="mono">${esc(String(it.batch_no || (o.status === '未审核' ? '未审核' : '—')).replace(/-\d{2}$/, ''))}</td>
        <td class="num">${(Number(it.qty) * Number(it.unit_cost)).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">无明细</div>';
    inModal.style.display = 'flex';
  }
  // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）
  // V4.15.7 P3：打印按钮走统一 docprint（份数选择 + 留痕）；无权限提示隐藏
  view.querySelector('#inPrint').onclick = () => {
    if (!detailId) return;
    if (!canPrintA5()) { toast('需要「A5单据打印」权限（店长及以上）', false); return; }
    openA5Print('inbound', [detailId]);
  };

  async function loadList() {
    const d = await must(get('/purchase/inbounds?size=100'));
    const allRows = d.items || d || [];
    // V4.9.7 供应商改输入匹配：按名称模糊过滤（含未输完整名）
    const supName = view.querySelector('#qSup').value.trim();
    const supHit = supName ? supList.find(x => x.name === supName)
      || supList.find(x => (x.name || '').includes(supName) || supName.includes(x.name || '')) : null;
    const sup = supHit ? String(supHit.id) : '';
    const from = view.querySelector('#qFrom').value, to = view.querySelector('#qTo').value;
    const rows = allRows.filter(r => {
      if (qStatus && r.status !== qStatus) return false;
      if (sup && String(r.supplier_id ?? r.supplierId ?? '') !== sup) return false;
      const day = (r.created_at || r.createdAt || '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
    const sum = rows.reduce((s, r) => s + (Number(r.total_amount ?? r.totalAmount) || 0), 0);
    view.querySelector('#qSum').textContent = fmt(sum);
    view.querySelector('#qCount').textContent = `共 ${rows.length} 张单据`;
    // V4.15.1：全选态只看「可勾选（未审核/已作废）」的行——原来 all rows 全是不可删时也判 true，表头复选框恒勾且取消无效
    const deligible = rows.filter(b => b.status === '未审核' || b.status === '已作废');
    // V4.26.2 合并为一列后，回显条件与勾选范围一致（原来只统计「可删行」，本页全是已审核单时
    // deligible 为空 → allChecked 恒 false → 全选后表头不复原，看起来"只能全选不能取消"）
    const allChecked = rows.length > 0 && rows.every(b => delSel.has(Number(b.id)));
    void deligible;
    // V4.15.1：每页 15 条本地分页（原 size=100 一页铺全量）
    ibRows = rows;
    ibPages = Math.max(Math.ceil(rows.length / IB_SIZE), 1);
    if (ibPage > ibPages) ibPage = ibPages;
    const pageRows = rows.slice((ibPage - 1) * IB_SIZE, ibPage * IB_SIZE);
    view.querySelector('#iList').innerHTML = rows.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="iChkAll" title="全选/取消全选" ${allChecked ? 'checked' : ''}></th>
        <th>入库单号</th><th>供应商</th><th class="num">数量</th><th class="num">金额</th>
        <th>批次</th><th>状态</th><th>创建</th><th style="width:150px">操作</th></tr></thead>
      <tbody>${pageRows.map(b => {
        const deletable = b.status === '未审核' || b.status === '已作废';   // V4.9.6 已作废可勾删
        return `<tr data-in="${b.id}" style="cursor:pointer" title="双击查看单据详情">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-chk="${b.id}" data-del="${b.id}" data-deletable="${deletable ? 1 : 0}" data-auditable="${b.status === '未审核' ? 1 : 0}"
          ${delSel.has(Number(b.id)) ? 'checked' : ''}
          title="${deletable ? '勾选：批量打印 / 批量审核 / 批量删除' : '勾选：批量打印（已产生业务的单据不可删除）'}"></td>
        <td style="font-family:var(--mono);font-weight:600">${esc(b.inbound_no || b.inboundNo)}</td>
        <td>${esc(b.supplier_name || b.supplierName || '')}</td>
        <td class="num">${Math.round(Number(b.total_qty ?? 0))}</td>
        <td class="num">${money(b.total_amount ?? b.totalAmount)}</td>
        <td class="mono" style="font-size:12px">${esc(b.inbound_no || b.inboundNo || '—')}</td>
        <td><span class="tag ${b.status === '已审核' ? 'g' : b.status === '已作废' ? 'r' : 'y'}">${esc(b.status)}</span></td>
        <td>${dt(b.created_at || b.createdAt)}</td>
        <td style="white-space:nowrap">
          ${b.status === '未审核' ? `<button class="btn sm pri" data-audit="${b.id}">✓ 审核</button>` : ''}
          ${(b.status === '未审核' || b.status === '已审核') ? `<button class="btn sm warn" data-void="${b.id}">✖ 作废</button>` : ''}
        </td>
      </tr>`; }).join('')}</tbody></table>`
      + pagerBar({ page: ibPage, pages: ibPages, total: rows.length, size: IB_SIZE, unit: '张' })
      : '<div class="empty">无符合条件的入库单</div>';
    bindPager(view.querySelector('#iList'), p => { ibPage = p; loadList(); });
    // V4.9.6 双击行任意处打开明细；表头复选框全选/取消全选
    view.querySelectorAll('[data-in]').forEach(tr => tr.ondblclick = () => openDetail(tr.dataset.in));
    const chkAll = view.querySelector('#iChkAll');
    if (chkAll) chkAll.onchange = () => {
      // V4.26.2 合并为一列：勾选范围放开到本页所有单据（供批量打印 A5）；
      // 批量审核/删除时再按单据状态校验，不可操作的会被拒绝并提示。
      rows.forEach(b => { if (chkAll.checked) delSel.add(Number(b.id)); else delSel.delete(Number(b.id)); });
      loadList();
      syncDelBtn();
      syncPrBtn();   // V4.26.2：批量打印按钮与选择集合共用，全选后需同步显示/计数
    };
    view.querySelectorAll('[data-del]').forEach(cb => cb.onchange = (e) => {
      e.stopPropagation();
      const id = Number(cb.dataset.del);
      if (cb.checked) delSel.add(id); else delSel.delete(id);
      syncDelBtn();
      syncPrBtn();   // V4.26.2：批量打印按钮与选择集合共用，需同步计数
    });
    view.querySelectorAll('[data-audit]').forEach(btn => btn.onclick = async (e) => {
      e.stopPropagation();
      await must(post(`/purchase/inbounds/${btn.dataset.audit}/audit`), '审核通过，批次已生成');
      autoPrintA5AfterAudit('inbound', [Number(btn.dataset.audit)]);   // V4.15.7 设置开启时自动弹 A5
      loadList();
    });
    view.querySelectorAll('[data-void]').forEach(btn => btn.onclick = async (e) => {
      e.stopPropagation();
      // V4.9.7 样式化作废二次确认（提醒风险）
      if (!await confirmBox({
        title: '⚠️ 作废提醒',
        html: '作废后单据不可恢复。\n已审核单据作废时商品将退回库存、本次改价（进价/售价）无效。\n确定要作废吗？',
        okText: '确认作废',
      })) return;
      const reason = prompt('作废原因（选填）：') ?? '';
      if (reason === null) return;
      await must(post(`/purchase/inbounds/${btn.dataset.void}/void`, { reason }),
        '已作废（已审核单批次未动用时库存同步回退）');
      loadList();
    });
    mountSignActions(view, { bizType: 'inbound', onDone: loadList });
    syncDelBtn();
  }

  const [sups, prods] = await Promise.all([
    must(get('/purchase/suppliers')).catch(() => ({})),
    must(get('/products?size=500')).catch(() => ({})),
  ]);
  const supList = sups.items || sups || [];
  allProducts = prods.items || prods || [];
  products = allProducts;
  view.querySelector('#iSupDl').innerHTML = supList.map(s => `<option value="${esc(s.name)}">`).join('');
  // V4.9.7 列表筛选供应商：输入匹配（datalist）
  const qSupDl = document.createElement('datalist');
  qSupDl.id = 'qSupDl7';
  qSupDl.innerHTML = supList.map(s => `<option value="${esc(s.name)}">`).join('');
  view.querySelector('#qSup').setAttribute('list', 'qSupDl7');
  view.querySelector('#qSup').insertAdjacentElement('afterend', qSupDl);
  if (poId) {
    try {
      const o = await must(get('/purchase/orders/' + poId));
      const remaining = (o.items || []).filter(it => Number(it.order_qty) - Number(it.arrived_qty || 0) > 0).map(it => {
        const p = allProducts.find(x => String(x.id) === String(it.product_id)) || null;
        return makeLine({ productId: it.product_id, _p: p, _q: p ? p.barcode || '' : '',
          qty: Number(it.order_qty) - Number(it.arrived_qty || 0), unitCost: it.price ?? '', productionDate: today,
          _ordered: Number(it.order_qty), _arrived: Number(it.arrived_qty || 0) });
      });
      if (o.supplier_id) {
        const s = supList.find(x => Number(x.id) === Number(o.supplier_id));
        view.querySelector('#iSup').value = s ? s.name : '';
      }
      view.querySelector('#iMemo').value = o.remark || '';
      poNo = o.po_no || '';
      view.querySelector('#iQtyHead').textContent = '订购数量';
      if (remaining.length) { lines.length = 0; lines.push(...remaining); toast(`已按采购订单 ${poNo} 预填 ${remaining.length} 行未到货明细`); }
      else toast(`采购订单 ${poNo} 已全部到货，无需再入库`, false);
    } catch (e) { /* must() 已 toast */ }
  }
  // V4.9.7 进入页面固定落在列表页（草稿仍在，点「＋新增入库单」可恢复编辑）
  newDoc();
  await bindSupplierProducts();
  drawLines();
  await loadList().catch(() => {});
}
