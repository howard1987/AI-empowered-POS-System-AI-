import { get, post, del, must, esc, dt, toast, imgUrl, API } from '../api.js';
import { signCell, signBtn, handleSignInfo, mountSignActions } from './signpad.js';
import { renderLines, makeLine, createUnitsCache, loadSupplierProducts, loadBatchesFor } from './docentry.js';
import { confirmBox } from '../ui.js';
import { openA5Print, autoPrintA5AfterAudit, canPrintA5 } from '../docprint.js';
import { paginate, bindPager } from '../common-ui.js';

/** 采购退货（V4.9.6：状态文案 待审核/已审核/已取消/已作废 · 列重排（退货数量/退货金额/制单时间/凭证/状态/操作）
 *  · 弹窗左右结构（左明细右凭证可点击放大）· 明细打印含电子签字 · 双击行开明细 · 供应商输入匹配
 *  · 摄像头检测（本机拍摄 / 派单移动端）· 新建页切换标签保留草稿）
 *  · V4.15.7 P3：A5 打印统一走 docprint.js（份数 + 留痕 + 勾选批量打印 + 审核后自动弹） */

let draftCache = null;   // V4.9.6 新建页草稿缓存

export async function render(view) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  view.innerHTML = `
    <div id="tab-new" style="display:none">
      <div class="card">
        <div class="doc-tools">
          <button class="btn" id="rBackList">← 返回列表</button>
          <span style="font-weight:700;font-size:14.5px">↩️ 新建采购退货单</span>
          <span class="pill o" id="docStat">录入中</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <button class="btn" id="rReset">删单重录</button>
            <button class="btn pri" id="rGo">💾 保存单据</button>
          </span>
        </div>
        <div class="doc-head">
          <div class="fld"><label class="req">供应商</label><input id="rSup" list="rSupDl" placeholder="输入名称快速匹配" style="flex:1;min-width:0">
            <datalist id="rSupDl"></datalist></div>
          <div class="fld"><label>制单人</label><input id="rMaker" value="${esc(API.user?.name || '')}" readonly></div>
          <div class="fld"><label class="req">单据日期</label><input id="rDate" type="date" value="${today}"></div>
          <div class="fld"><label>退货原因</label><input id="rMemo" placeholder="退货原因/备注"></div>
          <div class="fld"><label>凭证</label>
            <span style="display:flex;gap:6px;align-items:center;flex:1;min-width:0">
              <button class="btn sm" id="rEviCam" title="检测本机摄像头：有则直接拍摄，无则派单移动端">📷 拍摄</button>
              <button class="btn sm" id="rEviPic" title="从本机选择图片上传">🖼 选择图片</button>
              <input type="file" id="rEviFile" accept="image/*" style="display:none">
              <img id="rEviPrev" src="" style="display:none;height:34px;border-radius:6px;border:1px solid var(--line)">
              <span id="rEviTip" class="muted" style="font-size:11.5px">未上传（可后置补传；也可派单给移动端拍摄）</span>
            </span>
          </div>
        </div>
        <div class="doc-grid" style="padding:6px 18px 4px">
          <table>
            <thead><tr><th style="width:70px">编辑</th><th style="width:38px">序号</th><th>条码</th><th>名称</th><th>单位</th>
              <th>类别</th><th>规格</th><th style="width:88px">退货数量</th><th style="width:56px">库存</th>
              <th style="min-width:96px">批次</th><th style="min-width:92px">到期日期</th><th>行备注</th></tr></thead>
            <tbody id="rLines"></tbody>
            <tfoot><tr><td colspan="7">合计</td><td class="num" id="rSumQty">0</td><td colspan="4"></td></tr></tfoot>
          </table>
        </div>
        <div class="doc-tip">💡 「条码」列扫码枪 / 手输条码 / 输名称定位商品（仅限当前供应商供应的商品）；定位后自动填充该供应商在库<b>最早到期批次号与到期日期</b>（与审核自动归属口径一致）；单位可切换大小包装；回车跳下一格，行末回车自动加行。退货成本=原入库批次价。</div>
        <div class="doc-foot">
          <span class="muted" id="rCount">明细 0 行</span>
          <span class="sum">退货数量合计：<b id="rFootQty">0</b></span>
        </div>
      </div>
    </div>

    <div id="tab-list">
      <div class="card">
        <div class="doc-head" style="grid-template-columns:1.5fr 1fr 1.2fr auto;align-items:end">
          <div class="fld"><label>单据日期</label><span style="display:flex;gap:4px;align-items:center"><input id="qFrom" type="date" value="${monthStart}" style="flex:1;min-width:0"><span style="color:var(--ink-3)">~</span><input id="qTo" type="date" value="${today}" style="flex:1;min-width:0"></span></div>
          <div class="fld"><label>供应商</label><input id="qSup" placeholder="输入名称快速匹配（留空=全部）" style="min-width:150px"></div>
          <div class="fld"><label>审核状态</label><span id="qStat" style="display:flex;gap:2px;flex-wrap:wrap">
            <button class="btn sm segbtn" data-v="待审核">待审核</button>
            <button class="btn sm segbtn" data-v="已审核">已审核</button>
            <button class="btn sm segbtn" data-v="已取消">已取消</button>
            <button class="btn sm segbtn" data-v="已作废">已作废</button>
            <button class="btn sm segbtn on" data-v="">全部</button></span></div>
          <div class="fld"><label>&nbsp;</label><span style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn pri" id="qGo">🔍 查询</button>
            <button class="btn" id="qRefresh">刷新</button>
            <button class="btn" id="qBatch">批量审核</button>
            <button class="btn" id="qPrints" style="display:none">🖨 打印所选(<b id="qPrN">0</b>)</button>
            <button class="btn" id="qDel" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 删除(<b id="qDelN">0</b>)</button>
            <button class="btn pri" id="rNewDoc" style="white-space:nowrap">＋ 新增退货单</button>
          </span></div>
        </div>
        <div style="padding:10px 18px 16px" id="rList" class="tbl-min"></div>
        <div class="doc-foot"><span class="muted" id="qCount"></span>
          <span class="sum">退货金额合计：<b id="qSum">0.00</b> 元</span></div>
      </div>
    </div>

    <div class="modal-mask" id="retModal" style="display:none">
      <div class="modal" style="width:auto;min-width:900px;max-width:96vw;max-height:90dvh;overflow:auto">
        <h3 id="retModalTitle">退货单详情</h3>
        <div id="retMeta" style="font-size:12.5px;line-height:1.9;color:var(--ink-2);margin:6px 0 10px"></div>
        <div style="display:flex;gap:14px;align-items:stretch">
          <div style="flex:1;min-width:0;max-height:560px;overflow:auto" id="retItems"></div>
          <div style="width:340px;flex:none" id="retEviBox"></div>
        </div>
        <div class="doc-foot">
          
          <span style="flex:1"></span>
          <button class="btn" id="retPrint">🖨 打印</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="camModal" style="display:none">
      <div class="modal" style="width:560px">
        <h3>📷 拍摄退货凭证</h3>
        <video id="camVideo" autoplay playsinline style="width:100%;border-radius:10px;background:#000;min-height:300px"></video>
        <div class="doc-foot">
          <button class="btn" id="camCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="camShot">📸 拍摄并上传</button>
        </div>
      </div>
    </div>`;

  const lines = [];
  const unitsCache = createUnitsCache();
  let allProducts = [];
  let products = [];
  let evidencePath = '';
  const delSel = new Set();
  let qStatus = '';
  let detailId = 0;

  /* ── 分页式：列表页 ⇄ 新增页 ── */
  const showPage = (mode) => {
    view.querySelector('#tab-new').style.display = mode === 'new' ? '' : 'none';
    view.querySelector('#tab-list').style.display = mode === 'list' ? '' : 'none';
    if (mode === 'list') { try { loadList(); } catch { /* 切页不阻断 */ } }
  };
  view.querySelector('#rNewDoc').onclick = () => { showPage('new'); draftCache ? restoreDraft() : newDoc(); };
  view.querySelector('#rBackList').onclick = () => showPage('list');

  /* V4.9.6 供应商输入匹配（datalist）→ 商品绑定过滤 */
  const resolveSupId = () => {
    const name = view.querySelector('#rSup').value.trim();
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
  view.querySelector('#rSup').addEventListener('input', () => {
    clearTimeout(view.__supT);
    view.__supT = setTimeout(bindSupplierProducts, 350);
  });

  function snapshotDraft() {
    draftCache = {
      sup: view.querySelector('#rSup').value,
      date: view.querySelector('#rDate').value,
      memo: view.querySelector('#rMemo').value,
      evidence: evidencePath,
      lines: lines.map(l => ({ ...l, _p: undefined })),
    };
  }
  function newDoc() {
    lines.length = 0;
    lines.push(makeLine());
    view.querySelector('#rMemo').value = '';
    setEvidence('');
    drawLines();
  }
  function restoreDraft() {
    if (!draftCache) return newDoc();
    lines.length = 0;
    for (const l of draftCache.lines) {
      const p = allProducts.find(x => String(x.id) === String(l.productId)) || null;
      lines.push({ ...l, _p: p });
    }
    view.querySelector('#rSup').value = draftCache.sup || '';
    view.querySelector('#rDate').value = draftCache.date || today;
    view.querySelector('#rMemo').value = draftCache.memo || '';
    setEvidence(draftCache.evidence || '');
    if (!lines.length) lines.push(makeLine());
    drawLines();
  }

  /* ── V4.9.6 凭证：本机拍摄（检测摄像头）/ 选择图片 / 派单移动端 ── */
  function setEvidence(p) {
    evidencePath = p || '';
    const prev = view.querySelector('#rEviPrev'), tip = view.querySelector('#rEviTip');
    if (evidencePath) { prev.src = imgUrl(evidencePath); prev.style.display = ''; tip.textContent = '已上传凭证'; }
    else { prev.style.display = 'none'; tip.textContent = '未上传（可后置补传；也可派单给移动端拍摄）'; }
  }
  const upEvidence = async f => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toast('凭证图片不能超过 8MB', false);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = () => rej(new Error('读取失败'));
        r.readAsDataURL(f);
      });
      const r = await must(post('/upload', { image: dataUrl }), '凭证已上传');
      setEvidence(r.path);
    } catch (e) { toast(e.message || '凭证上传失败', false); }
  };
  const uploadDataUrl = async (dataUrl, tipMsg) => {
    try {
      const r = await must(post('/upload', { image: dataUrl }), tipMsg || '凭证已上传');
      setEvidence(r.path);
    } catch (e) { toast(e.message || '凭证上传失败', false); }
  };
  /* V4.9.6 摄像头检测：有则本机 getUserMedia 拍摄；无则派单同账号移动端 */
  const dispatchMobile = () => {
    toast('本机未检测到摄像头。请先保存退货单，保存后可一键派单移动端拍摄（同账号 PWA 消息页接收指令）', false);
  };
  const openCamera = async () => {
    let hasCam = false;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      hasCam = devs.some(d => d.kind === 'videoinput');
    } catch { hasCam = false; }
    if (!hasCam) return dispatchMobile();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
    catch { return dispatchMobile(); }
    const modal = view.querySelector('#camModal');
    const video = view.querySelector('#camVideo');
    video.srcObject = stream;
    modal.style.display = 'flex';
    const close = () => { stream.getTracks().forEach(t => t.stop()); modal.style.display = 'none'; };
    view.querySelector('#camCancel').onclick = close;
    view.querySelector('#camShot').onclick = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      close();
      await uploadDataUrl(canvas.toDataURL('image/jpeg', 0.85), '凭证已拍摄上传');
    };
  };
  view.querySelector('#rEviCam').onclick = openCamera;
  view.querySelector('#rEviPic').onclick = () => {
    const f = view.querySelector('#rEviFile');
    f.removeAttribute('capture');
    f.click();
  };
  view.querySelector('#rEviFile').onchange = e => { upEvidence(e.target.files[0]); e.target.value = ''; };

  /* ── 开单：条码定位录入表格 ── */
  function sums() {
    const q = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 1), 0);
    view.querySelector('#rSumQty').textContent = String(Math.round(q * 1000) / 1000);
    view.querySelector('#rFootQty').textContent = String(Math.round(q * 1000) / 1000);
    view.querySelector('#rCount').textContent = `明细 ${lines.length} 行`;
    view.querySelector('#docStat').textContent = lines.length ? `录入中 · ${lines.length} 行` : '录入中';
    snapshotDraft();
  }
  function drawLines() {
    renderLines(view.querySelector('#rLines'), lines, {
      products, unitsCache, price: false, prodDate: false, stock: true, batch: true,
      headLabel: '编辑', today, qtyLabel: '数量', onSum: sums,
    });
  }
  view.querySelector('#rReset').onclick = () => { draftCache = null; newDoc(); };
  view.querySelector('#rGo').onclick = async () => {
    const sid = resolveSupId();
    if (!sid) return toast('请输入并选择供应商', false);
    const items = lines.filter(l => l.productId && Number(l.qty) > 0).map(l => ({
      productId: Number(l.productId), qty: Math.round(Number(l.qty) * (Number(l.rate) || 1) * 1000) / 1000,
      lineRemark: (l.remark || '').trim() || undefined }));
    if (!items.length) return toast('无有效明细行（需定位商品+数量>0）', false);
    const d = await must(post('/purchase/returns', { supplierId: sid,
      items, evidencePath: evidencePath || undefined,
      remark: view.querySelector('#rMemo').value.trim() || undefined }), '退货单已保存（待审核·凭证可后置补传）');
    if (d) {
      draftCache = null;
      showPage('list');
      handleSignInfo(view, d.signInfo, { bizType: 'return', bizId: d.id, onDone: loadList });
      // V4.9.6 未上传凭证 → 一键派单给同账号移动端拍摄（指令置顶，回传后自动预览）
      if (!evidencePath && confirm(`凭证未上传。\n\n「确定」= 发送指令到移动端（同账号 PWA 消息页置顶），店员用手机摄像头拍摄回传\n「取消」= 稍后在列表「📎 补凭证」上传`)) {
        try {
          await must(post(`/purchase/returns/${d.id}/evidence-request`), '已发送移动端拍摄指令');
          watchEvidence(d.id);
        } catch (e) { toast(e.message || '派单失败', false); }
      }
    }
  };
  /* V4.9.5 等待移动端回传凭证：轮询单据详情，凭证就位自动预览 */
  function watchEvidence(id) {
    let tries = 0;
    const timer = setInterval(async () => {
      if (++tries > 20) { clearInterval(timer); return; }
      try {
        const d = await get(`/purchase/returns/${id}`);
        const evi = (d.data?.order || d.order || {}).evidence_path;
        if (evi) {
          clearInterval(timer);
          toast('📷 移动端已回传退货凭证');
          const w = window.open(imgUrl(evi), '_blank');
          if (!w) loadList();
        }
      } catch { /* 忽略，继续轮询 */ }
    }, 3000);
  }

  /* ── 浏览 ── */
  view.querySelectorAll('#qStat .segbtn').forEach(b => b.onclick = () => {
    view.querySelectorAll('#qStat .segbtn').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); qStatus = b.dataset.v; loadList();
  });
  view.querySelector('#qGo').onclick = loadList;
  view.querySelector('#qRefresh').onclick = loadList;
  view.querySelector('#qBatch').onclick = async () => {
    const ids = [...view.querySelectorAll('[data-chk]:checked')].filter(c => c.dataset.auditable === '1').map(c => c.dataset.chk);
    if (!ids.length) return toast('请勾选待审核的退货单', false);
    for (const id of ids) await post(`/purchase/returns/${id}/audit`);
    toast(`已批量审核 ${ids.length} 张，库存已扣减`);
    autoPrintA5AfterAudit('return', ids.map(Number));   // V4.15.7 设置开启时自动弹 A5
    loadList();
  };
  // V4.15.7 P3：勾选批量打印（rePrSel 与同步函数在下方定义，函数声明提升可用）
  view.querySelector('#qPrints').onclick = () => { if (rePrSel.size) openA5Print('return', [...rePrSel]); };
  view.querySelector('#qDel').onclick = async () => {
    const ids = [...delSel];
    if (!ids.length) return;
    if (!await confirmBox({
      title: '🗑 删除退货单',
      html: `确认删除 ${ids.length} 张未产生业务的退货单？\n删除后不可恢复（审计留痕）。`,
    })) return;
    let ok = 0; const errs = [];
    for (const id of ids) {
      try { await must(del(`/purchase/returns/${id}`)); ok++; delSel.delete(Number(id)); }
      catch (e) { errs.push(e.msg || e.message); }
    }
    if (errs.length) toast(`成功 ${ok} 张，失败 ${errs.length} 张：${errs[0]}`, false);
    else toast(`已删除 ${ok} 张退货单`);
    syncDelBtn();
    loadList();
  };
  function syncDelBtn() {
    view.querySelector('#qDel').style.display = delSel.size ? '' : 'none';
    view.querySelector('#qDelN').textContent = String(delSel.size);
  }
  // V4.15.7 P3：打印勾选集合与按钮同步
  const rePrSel = delSel;   // V4.26.2 合并为一列：批量打印复用「选择」集合（原为独立 Set）
  function syncPrBtn() {
    const btn = view.querySelector('#qPrints');
    if (!btn) return;
    btn.style.display = rePrSel.size ? '' : 'none';
    view.querySelector('#qPrN').textContent = String(rePrSel.size);
  }

  /* ── 双击行：退货单详情（左明细右凭证 · 凭证点击放大 · 打印含电子签字） ── */
  const retModal = view.querySelector('#retModal');
  async function openDetail(id) {
    const d = await must(get(`/purchase/returns/${id}`));
    const o = d.order || {}, its = d.items || [];
    detailId = Number(id);
    view.querySelector('#retModalTitle').textContent = `退货单 ${o.return_no || ''}`;
    view.querySelector('#retMeta').innerHTML = `
      供应商：<b>${esc(o.supplier_name || '')}</b>　
      状态：<span class="tag ${o.status === '已审核' ? 'g' : (o.status === '已取消' || o.status === '已作废') ? 'r' : 'y'}">${esc(o.status || '')}</span>　
      制单人：${esc(o.maker_name || '—')}　
      备注：${esc(o.remark || '—')}`;
    view.querySelector('#retItems').innerHTML = its.length ? `
      <table><thead><tr><th>序号</th><th>条码</th><th>商品</th><th>单位</th><th class="num">数量</th>
        <th class="num">原批次价</th><th class="num">金额</th><th>批次</th><th>到期日期</th><th>行备注</th></tr></thead>
      <tbody>${its.map((it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="mono">${esc(it.barcode || '—')}</td>
        <td>${esc(it.product_name)}</td><td>${esc(it.base_unit || '')}</td>
        <td class="num">${it.qty}</td>
        <td class="num">${it.unit_cost != null ? Number(it.unit_cost).toFixed(2) : '—'}</td>
        <td class="num">${(Number(it.qty) * Number(it.unit_cost || 0)).toFixed(2)}</td>
        <td class="mono">${esc(String(it.batch_no || '—').replace(/-\d{2}$/, ''))}</td>
        <td class="num">${it.expiry_date ? String(it.expiry_date).slice(0, 10) : '—'}</td>
        <td class="muted">${esc(it.line_remark || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">无明细</div>';
    // V4.9.7 右侧凭证区：固定高度 560 显示大图（点击放大）；支持多张
    const eviList = String(o.evidence_path || '').split(',').map(x => x.trim()).filter(Boolean);
    view.querySelector('#retEviBox').innerHTML = eviList.length
      ? `<div style="border:1px dashed var(--line);border-radius:10px;padding:10px 12px;height:560px;display:flex;flex-direction:column">
           <div class="muted" style="font-size:12px;margin-bottom:6px">📎 退货凭证${eviList.length > 1 ? `（${eviList.length} 张）` : ''}（点击放大）</div>
           <div style="flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px">
             ${eviList.map(u => `<img data-evizoom="${esc(imgUrl(u))}" src="${esc(imgUrl(u))}" style="width:100%;max-height:520px;object-fit:contain;border-radius:8px;border:1px solid var(--line);cursor:zoom-in;background:#fff" alt="退货凭证">`).join('')}
           </div>
         </div>`
      : '<div class="muted" style="font-size:12px;padding:12px;border:1px dashed var(--line);border-radius:10px;height:560px;box-sizing:border-box">📎 暂无退货凭证（待审核状态可在列表「📎 补凭证 / 📷 拍摄」上传）</div>';
    view.querySelectorAll('#retEviBox [data-evizoom]').forEach(zoom => zoom.onclick = () => {
      const lb = document.createElement('div');
      lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out;padding:24px';
      lb.innerHTML = `<img src="${esc(zoom.dataset.evizoom)}" style="max-width:92vw;max-height:92vh;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.5)">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    });
    retModal.style.display = 'flex';
  }
  // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）
  // V4.15.7 P3：打印按钮走统一 docprint（份数选择 + 留痕）
  view.querySelector('#retPrint').onclick = () => {
    if (!detailId) return;
    if (!canPrintA5()) { toast('需要「A5单据打印」权限（店长及以上）', false); return; }
    openA5Print('return', [detailId]);
  };

  /* ── 列表行补凭证：拍摄 / 选择图片 ── */
  function openEviPicker(id) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast('凭证图片不能超过 8MB', false);
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = () => rej(new Error('读取失败'));
        r.readAsDataURL(f);
      });
      const r = await must(post('/upload', { image: dataUrl }), '凭证已上传');
      await must(post(`/purchase/returns/${id}/evidence`, { evidencePath: r.path }), '凭证已关联退货单');
      loadList();
    };
    inp.click();
  }

  /* ── 列表：取数+过滤后缓存 reRows，drawList 按 10 条/页本地分页重画 ── */
  let reRows = [];
  let rePage = 1;
  async function loadList() {
    const d = await must(get('/purchase/returns'));
    const all = d.items || d || [];
    // V4.9.7 供应商改输入匹配（名称模糊过滤）
    const supName = view.querySelector('#qSup').value.trim();
    const supHit = supName ? supList.find(x => x.name === supName)
      || supList.find(x => (x.name || '').includes(supName) || supName.includes(x.name || '')) : null;
    const sup = supHit ? String(supHit.id) : '';
    const from = view.querySelector('#qFrom').value, to = view.querySelector('#qTo').value;
    reRows = all.filter(r => {
      if (qStatus && r.status !== qStatus) return false;
      if (sup && String(r.supplier_id ?? r.supplierId ?? '') !== sup) return false;
      const day = (r.created_at || r.createdAt || '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
    rePage = 1;
    const sum = reRows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
    view.querySelector('#qSum').textContent = sum.toFixed(2);
    view.querySelector('#qCount').textContent = `共 ${reRows.length} 张单据`;
    drawList();
  }
  function drawList() {
    const rows = reRows;
    const pg = paginate(rows, rePage, 10);
    rePage = pg.page;
    const DELETABLE = ['待审核', '已取消', '已作废'];
    // V4.26.2 合并为一列后，回显条件与勾选范围一致
    const allChecked = rows.length > 0 && rows.every(r => delSel.has(Number(r.id)));
    view.querySelector('#rList').innerHTML = rows.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="rChkAll" title="全选/取消全选" ${allChecked ? 'checked' : ''}></th>
        <th>退货单号</th><th>供应商</th><th class="num">退货数量</th><th class="num">退货金额</th>
        <th>制单时间</th><th>凭证</th><th>状态</th><th style="width:220px">操作</th></tr></thead>
      <tbody>${pg.slice.map(r => {
        const pre = r.status === '待审核';
        const deletable = DELETABLE.includes(r.status);
        const evi = r.evidence_path || r.evidencePath || '';
        return `<tr data-ret="${r.id}" style="cursor:pointer" title="双击查看单据详情">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-chk="${r.id}" data-del="${r.id}" data-deletable="${deletable ? 1 : 0}" data-auditable="${pre ? 1 : 0}"
          ${delSel.has(Number(r.id)) ? 'checked' : ''}
          title="${deletable ? '勾选：批量打印 / 批量审核 / 批量删除' : '勾选：批量打印（已产生业务的单据不可删除）'}"></td>
        <td style="font-family:var(--mono);font-weight:600">${esc(r.return_no || r.returnNo)}</td>
        <td>${esc(r.supplier_name || r.supplierName || '')}</td>
        <td class="num">${Math.round(Number(r.total_qty ?? 0))}</td>
        <td class="num">${Number(r.total_amount || 0).toFixed(2)}</td>
        <td>${dt(r.created_at || r.createdAt)}</td>
        <td>${evi ? `<img data-eviimg="${esc(imgUrl(evi))}" src="${esc(imgUrl(evi))}" style="height:32px;border-radius:6px;border:1px solid var(--line);cursor:zoom-in">` : '<span class="muted">—</span>'}</td>
        <td><span class="tag ${r.status === '已审核' ? 'g' : (r.status === '已取消' || r.status === '已作废') ? 'r' : 'y'}">${esc(r.status)}</span>
            ${pre && !evi ? '<span class="tag r">缺凭证</span>' : ''}</td>
        <td style="white-space:nowrap">
          ${pre ? `<button class="btn sm ${evi ? 'pri' : 'warn'}" data-evi="${r.id}">${evi ? '🔄 换凭证' : '📎 补凭证'}</button>
                   <button class="btn sm pri" data-a="${r.id}">✓ 审核</button>
                   <button class="btn sm warn" data-v="${r.id}">✖ 作废</button>` : ''}
        </td>
      </tr>`; }).join('')}</tbody></table>
      ${pg.bar}`
      : '<div class="empty">无符合条件的退货单</div>';
    bindPager(view.querySelector('#rList'), p => { rePage = p; drawList(); });
    // 双击行任意处打开明细；表头复选框全选/取消全选；凭证缩略图点击放大
    view.querySelectorAll('[data-ret]').forEach(tr => tr.ondblclick = () => openDetail(tr.dataset.ret));
    view.querySelectorAll('[data-eviimg]').forEach(img => img.onclick = (e) => {
      e.stopPropagation();
      const lb = document.createElement('div');
      lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out;padding:24px';
      lb.innerHTML = `<img src="${esc(img.dataset.eviimg)}" style="max-width:92vw;max-height:92vh;border-radius:12px">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    });
    const chkAll = view.querySelector('#rChkAll');
    if (chkAll) chkAll.onchange = () => {
      // V4.26.2 合并为一列：勾选范围放开到本页所有单据（供批量打印 A5）；
      // 批量审核/删除时再按单据状态校验。
      rows.forEach(r => { if (chkAll.checked) delSel.add(Number(r.id)); else delSel.delete(Number(r.id)); });
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
    view.querySelectorAll('[data-a]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      await must(post(`/purchase/returns/${b.dataset.a}/audit`), '退货审核完成（库存已扣减）');
      autoPrintA5AfterAudit('return', [Number(b.dataset.a)]);   // V4.15.7 设置开启时自动弹 A5
      loadList();
    });
    view.querySelectorAll('[data-evi]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openEviPicker(b.dataset.evi); });
    view.querySelectorAll('[data-v]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('⚠️ 作废提醒：作废后单据不可恢复，请谨慎操作。确定要作废该退货单吗？')) return;
      const reason = prompt('作废原因（选填）：') ?? '';
      if (reason === null) return;
      await must(post(`/purchase/returns/${b.dataset.v}/void`, { reason }), '退货单已作废');
      loadList();
    });
    mountSignActions(view, { bizType: 'return', onDone: loadList });
    syncDelBtn();
  }

  const [sups, prods] = await Promise.all([
    must(get('/purchase/suppliers')).catch(() => ({})),
    must(get('/products?size=500')).catch(() => ({})),
  ]);
  const supList = sups.items || sups || [];
  allProducts = prods.items || prods || [];
  products = allProducts;
  view.querySelector('#rSupDl').innerHTML = supList.map(s => `<option value="${esc(s.name)}">`).join('');
  // V4.9.7 列表筛选供应商：输入匹配（datalist）
  const rqSupDl = document.createElement('datalist');
  rqSupDl.id = 'rQSupDl7';
  rqSupDl.innerHTML = supList.map(s => `<option value="${esc(s.name)}">`).join('');
  view.querySelector('#qSup').setAttribute('list', 'rQSupDl7');
  view.querySelector('#qSup').insertAdjacentElement('afterend', rqSupDl);
  // V4.9.7 进入页面固定落在列表页（草稿仍在，点「＋新增退货单」可恢复编辑）
  newDoc();
  await bindSupplierProducts();
  await loadList().catch(() => {});
}
