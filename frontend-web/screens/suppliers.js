import { get, post, put, del, must, esc, toast, money, dt, API, imgUrl } from '../api.js';
import { openDetailModal, paginate, bindPager } from '../common-ui.js';
import { attachProductSearch } from '../product-search.js';
import { openCollectPad } from './signpad.js';
import { confirmBox } from '../ui.js';

/** 供应商管理（V4.9.6：GYS 编号 · 复选框勾选删除（未产生业务）· 弹窗删除 · 容器高度一致 · 分页 · 操作列去编辑） */
const PAGE_SIZE = 14;

export async function render(view) {
  let rows = [];
  let signMap = {};   // 供应商 → 电子签名（主表「预览」列 + 变更/签字判定），load 时构建
  let bizF = '';
  let editId = 0;   // >0 = 编辑模式
  let page = 1;
  const sel = new Set();
  view.innerHTML = `
    <style>#sList table td{text-align:center}#sList table th{text-align:center}</style>
    <div class="card" style="display:flex;flex-direction:column;height:calc(100dvh - 210px);min-height:520px">
      <div class="doc-head" style="grid-template-columns:1.4fr 1fr 0.9fr auto;align-items:end">
        <div class="fld"><label>名称</label><input id="sKw" placeholder="名称/拼音码"></div>
        <div class="fld"><label>经营方式</label><span id="sBiz" style="display:flex;gap:2px">
          <button class="btn sm segbtn on" data-v="">全部</button>
          <button class="btn sm segbtn" data-v="购销">购销</button>
          <button class="btn sm segbtn" data-v="联营">联营</button></span></div>
        <div class="fld"><label>结算方式</label><select id="sSettle">
          <option value="">全部</option><option>现结</option><option>周结</option>
          <option>月结</option><option>旬结</option></select></div>
        <div class="fld"><label>&nbsp;</label><span style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn pri" id="sSearch">🔍 查询</button>
          <button class="btn" id="sRefresh">刷新</button>
          <button class="btn" id="sDel" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 删除(<b id="sDelN">0</b>)</button>
          <button class="btn" id="sChange" title="调进价/售价/主供应商，即时生效全链路留痕（需入库审核权限）">🔁 供应商变更单</button>
          <button class="btn pri" id="sNew">➕ 新增供应商</button>
        </span></div>
      </div>
      <div class="muted" style="padding:4px 18px 0;font-size:11.5px">双击行可直接编辑；未产生业务的供应商可勾选删除（联系人=常驻业务员，对账电子签字预采集对象）</div>
      <div style="padding:10px 18px 4px;flex:1;min-height:0;overflow:auto" id="sList" class="tbl-min"></div>
      <div class="doc-foot">
        <span class="muted" id="sCount"></span>
        <span style="display:flex;gap:6px;align-items:center" id="sPager"></span>
        <span class="sum">合作供应商：<b id="sActive">0</b> 家</span>
      </div>
    </div>

    <!-- V4.14.2：供应商变更记录表格（每页 10 条，超过翻页） -->
    <div class="card" style="margin-top:14px;padding-bottom:14px">
      <h3>🔁 供应商变更记录 </h3>
      <div style="padding:0 18px 10px;display:flex;gap:8px;align-items:center">
        <label class="muted" style="font-size:12px">按供应商</label>
        <select id="chgSup" style="min-width:180px"><option value="">全部供应商</option></select>
      </div>
      <!-- V4.26.4：.pg-host 让分页条固定在此容器底部（表格内部滚动），不再吸附到页面底边浮动 -->
      <div id="chgList" class="pg-host" style="padding:0 18px">加载中…</div>
    </div>

    <div class="modal-mask" id="sModal" style="display:none">
      <div class="modal">
        <h3 id="sModalTitle">➕ 新增供应商</h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label class="req">名称</label><input id="nName"></div>
          <div class="fld"><label class="req">业务员（联系人）</label><input id="nContact" placeholder="常驻业务员（签字预采集对象）"></div>
          <div class="fld"><label class="req">电话</label><input id="nPhone" placeholder="如 13800000000"></div>
          <div class="fld"><label class="req">经营方式</label><select id="nBiz"><option>购销</option><option>联营</option></select></div>
          <div class="fld"><label>联营扣点（%）</label><input id="nRate" type="number" step="1" min="0" max="100" placeholder="如 15（联营毛利的 15%）；购销不可填" disabled></div>
          <div class="fld"><label>结算方式</label><select id="nSettle">
            <option>月结</option><option>现结</option><option>周结</option><option>旬结</option></select></div>
          <div class="fld" style="grid-column:1/-1"><label>地址</label><input id="nAddr" placeholder="供应商地址（选填）"></div>
          <div class="fld" style="grid-column:1/-1"><label>备注</label><input id="nRemark"></div>
        </div>
        <div class="doc-tip">💡 联营扣点 = 联营供应商销售商品毛利的百分比（整数，如 15 = 15%），仅「联营」可填；购销供应商该行锁定。费用（陈列/返利等）默认不计入分红池基数。</div>
        <div class="doc-foot">
          <button class="btn" id="nDelete" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 删除该供应商</button>
          <button class="btn" id="nCancel">取消</button>
          <button class="btn" id="nSign" title="采集该供应商业务员电子签字（保存前可先采集）">🖋 签字</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="nSave">💾 保存</button>
        </div>
      </div>
    </div>`;

  function gysCode(id) { return 'GYS' + String(id).padStart(4, '0'); }

  function apply() {
    const kw = view.querySelector('#sKw').value.trim();
    const settle = view.querySelector('#sSettle').value;
    const list = rows.filter(r => {
      if (bizF && (r.biz_mode || r.bizMode) !== bizF) return false;
      if (settle && (r.settle_period || r.settlePeriod) !== settle) return false;
      if (kw && !((r.name || '') + (r.pinyin_code || r.pinyinCode || '')).toLowerCase().includes(kw.toLowerCase())) return false;
      return true;
    });
    const pg = paginate(list, page, PAGE_SIZE);
    page = pg.page;
    const pageRows = pg.slice;
    view.querySelector('#sActive').textContent = String(list.length);
    view.querySelector('#sCount').textContent = `共 ${list.length} 家供应商`;
    const allChecked = pageRows.length > 0 && pageRows.every(s => sel.has(Number(s.id)));
    view.querySelector('#sList').innerHTML = pageRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th style="width:34px"><input type="checkbox" id="sChkAll" title="全选/取消全选" ${allChecked ? 'checked' : ''}></th>
        <th>编号</th><th>供应商名称</th><th>业务员</th><th>电话</th>
        <th>经营方式</th><th class="num">扣点</th><th>结算方式</th><th>地址</th><th>备注</th><th style="width:96px">签字预览</th><th style="width:70px">操作</th></tr></thead>
      <tbody>${pageRows.map((s, i) => {
        const rate = s.deduction_rate ?? s.deductionRate;
        const hasBiz = !!(s.has_business ?? s.hasBusiness);
        return `<tr data-edit="${s.id}" style="cursor:pointer" title="双击编辑">
        <td class="num seq">${(page - 1) * PAGE_SIZE + i + 1}</td><td onclick="event.stopPropagation()"><input type="checkbox" data-schk="${s.id}" ${sel.has(Number(s.id)) ? 'checked' : ''}
          ${hasBiz ? 'disabled title="已产生业务的供应商不可删除"' : 'title="未产生业务，可勾选删除"'}></td>
        <td class="num muted mono">${gysCode(s.id)}</td>
        <td><b>${esc(s.name)}</b></td>
        <td>${esc(s.contact_person || s.contactPerson || '—')}</td>
        <td style="font-family:var(--mono)">${esc(s.contact_phone || s.contactPhone || '—')}</td>
        <td><span class="tag ${(s.biz_mode || s.bizMode) === '联营' ? 'b' : 'g'}">${esc(s.biz_mode || s.bizMode || '购销')}</span></td>
        <td class="num">${rate != null ? (Number(rate) * 100).toFixed(0) + '%' : '—'}</td>
        <td>${esc(s.settle_period || s.settlePeriod || '—')}</td>
        <td class="muted" style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(s.address || '—')}</td>
        <td class="muted" style="max-width:130px;overflow:hidden;text-overflow:ellipsis">${esc(s.remark || '')}</td>
        ${(() => {
          const sg = signMap[Number(s.id)];
          if (!sg) return '<td class="muted" style="text-align:center;color:var(--ink-3)">—</td>';
          return `<td style="text-align:center"><img src="${esc(sg.url)}" data-sigprev="${s.id}" title="点击放大预览签字" style="height:34px;max-width:92px;border:1px solid var(--line);border-radius:5px;object-fit:contain;cursor:pointer;background:#fff"></td>`;
        })()}
        <td style="white-space:nowrap"><button class="btn sm" data-sigbtn="${s.id}" title="采集/更新该供应商业务员签字（入库/退货自动提取）">${signMap[Number(s.id)] ? '🔄 变更' : '🖋 签字'}</button></td>
      </tr>`; }).join('')}</tbody></table>` : '<div class="empty">无符合条件的供应商</div>';
    // 分页器（V4.16.6：始终显示，单页时按钮置灰——用户要求翻页组件常驻）
    view.querySelector('#sPager').innerHTML = `
      <button class="btn sm" data-pg="prev" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="muted" style="font-size:12px">第 ${page} / ${pg.pages} 页 · 共 ${pg.total} 条</span>
      <button class="btn sm" data-pg="next" ${page >= pg.pages ? 'disabled' : ''}>下一页 ›</button>`;
    view.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => {
      page += b.dataset.pg === 'prev' ? -1 : 1;
      apply();
    });
    // 勾选
    view.querySelectorAll('[data-schk]').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.schk);
      if (cb.checked) sel.add(id); else sel.delete(id);
      syncDelBtn();
    });
    const chkAll = view.querySelector('#sChkAll');
    if (chkAll) chkAll.onchange = () => {
      pageRows.forEach(s => { if (!Number(s.has_business ?? s.hasBusiness)) { if (chkAll.checked) sel.add(Number(s.id)); else sel.delete(Number(s.id)); } });
      apply();
      syncDelBtn();
    };
    view.querySelectorAll('[data-sigbtn]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const s = rows.find(x => Number(x.id) === Number(b.dataset.sigbtn)) || {};
      openCollectPad(view, {
        supplierId: Number(s.id), personName: s.contact_person || s.contactPerson || '',
        title: `✍️ 采集签字 · ${s.name || ''}（业务员）`,
        onDone: load,
      });
    });
    view.querySelectorAll('[data-sigprev]').forEach(img => img.onclick = e => {
      e.stopPropagation();
      const sg = signMap[Number(img.dataset.sigprev)] || {};
      if (!sg.url) return;
      openDetailModal('✍️ 签字预览' + (sg.name ? ' · ' + sg.name : ''),
        `<div style="text-align:center"><img src="${esc(sg.url)}" style="max-width:100%;max-height:70vh;border-radius:8px;background:#fff"></div>`, { width: 420 });
    });
    view.querySelectorAll('[data-edit]').forEach(tr => tr.ondblclick = () => open(tr.dataset.edit));
    syncDelBtn();
  }

  function syncDelBtn() {
    view.querySelector('#sDel').style.display = sel.size ? '' : 'none';
    view.querySelector('#sDelN').textContent = String(sel.size);
  }

  async function load() {
    const d = await must(get('/purchase/suppliers'));
    rows = d.items || d || [];
    // 构建 供应商→电子签名 映射（取每个供应商首张签名图，用于主表「预览」列与「变更/签字」判定）
    try {
      const sg = await get('/purchase/signatures');
      signMap = {};
      for (const t of (sg.items || [])) {
        if (t.supplier_id == null) continue;
        if (signMap[Number(t.supplier_id)]) continue;
        const imgs = (t.profile?.images?.length ? t.profile.images : [t.image_path]).filter(Boolean);
        if (imgs.length) signMap[Number(t.supplier_id)] = { url: imgUrl(imgs[0]), name: t.person_name || '', valid: Number(t.status) === 1 };   // V4.28.5 F-09 带 token
      }
    } catch { /* 签名加载失败不阻塞供应商列表 */ }
    apply();
  }

  /* ── 弹窗（新增/编辑两用） ── */
  const modal = view.querySelector('#sModal');
  // 经营方式联动：购销 → 联营扣点不可编辑（联营供应商销售商品毛利的百分比）；V4.14.2：已产生业务供应商经营方式锁定
  view.querySelector('#nBiz').onchange = syncRateLock;
  function syncRateLock() {
    const biz = view.querySelector('#nBiz').value;
    const rate = view.querySelector('#nRate');
    rate.disabled = biz !== '联营';
    if (rate.disabled) rate.value = '';
  }
  function open(id) {
    editId = Number(id) || 0;
    const s = editId ? rows.find(x => Number(x.id) === editId) || {} : {};
    view.querySelector('#sModalTitle').textContent = editId ? `✏️ 编辑供应商（${gysCode(s.id)} · ${s.name || ''}）` : '➕ 新增供应商';
    view.querySelector('#nName').value = s.name || '';
    view.querySelector('#nContact').value = s.contact_person || s.contactPerson || '';
    view.querySelector('#nPhone').value = s.contact_phone || s.contactPhone || '';
    const hasBiz = !!(s.has_business ?? s.hasBusiness);
    view.querySelector('#nBiz').value = s.biz_mode || s.bizMode || '购销';
    // V4.14.2：已产生业务的供应商经营方式锁定（变更经营方式请新增同名不同编号供应商，再用「供应商变更单」迁移商品）
    const bizSel = view.querySelector('#nBiz');
    bizSel.disabled = editId > 0 && hasBiz;
    const bizLockTip = view.querySelector('#nBizLockTip');
    if (bizLockTip) bizLockTip.remove();
    if (bizSel.disabled) {
      bizSel.insertAdjacentHTML('afterend', `<div class="muted" id="nBizLockTip" style="font-size:11px;margin-top:2px">🔒 已产生业务，经营方式不可改；如需变更请新增同名供应商（编号不同），再用「供应商变更单」迁移商品</div>`);
    }
    const rate = s.deduction_rate ?? s.deductionRate;
    view.querySelector('#nRate').value = rate != null ? Math.round(Number(rate) * 100) : '';
    view.querySelector('#nSettle').value = s.settle_period || s.settlePeriod || '月结';
    view.querySelector('#nAddr').value = s.address || '';
    view.querySelector('#nRemark').value = s.remark || '';
    // V4.9.6 未产生业务供应商可在编辑弹窗删除
    view.querySelector('#nDelete').style.display = editId && !hasBiz ? '' : 'none';
    syncRateLock();
    modal.style.display = 'flex';
    view.querySelector('#nName').focus();
  }
  view.querySelector('#sNew').onclick = () => open(0);
  view.querySelector('#nCancel').onclick = () => { modal.style.display = 'none'; };
  view.querySelector('#nDelete').onclick = async () => {
    if (!editId) return;
    const s = rows.find(x => Number(x.id) === editId) || {};
    // V4.9.7 样式化删除确认（替代原生 confirm）
    if (!await confirmBox({
      title: '🗑 删除供应商',
      html: `确认删除供应商「${gysCode(s.id)} ${s.name || ''}」？\n删除后不可恢复（审计留痕）；已产生业务的供应商不可删除。`,
    })) return;
    try {
      await must(del(`/purchase/suppliers/${editId}`), '供应商已删除');
      sel.delete(editId);
      modal.style.display = 'none';
      editId = 0;
      await load();
    } catch (e) { toast(e.msg || e.message, false); }
  };
  // 签字采集（保存前可先采集；新供应商保存后可在列表行「🖋 签字」绑定）
  view.querySelector('#nSign').onclick = () => {
    const name = view.querySelector('#nName').value.trim();
    const contact = view.querySelector('#nContact').value.trim();
    if (editId) {
      openCollectPad(view, {
        supplierId: editId, personName: contact,
        title: `✍️ 采集签字 · ${name}（业务员）`,
        onDone: load,
      });
    } else {
      openCollectPad(view, {
        personName: contact,
        title: '✍️ 预采集签字（新供应商）',
        tip: '该供应商尚未建档，签字先以「业务员姓名」存为模板；保存供应商后可在列表行点「🖋 签字」绑定到该供应商',
        onDone: () => {},
      });
    }
  };
  view.querySelector('#nSave').onclick = async () => {
    const name = view.querySelector('#nName').value.trim();
    const contact = view.querySelector('#nContact').value.trim();
    const phone = view.querySelector('#nPhone').value.trim();
    const bizMode = view.querySelector('#nBiz').value;
    if (!name) return toast('供应商名称必填', false);
    if (!contact) return toast('业务员（联系人）必填', false);
    if (!phone) return toast('电话必填', false);
    if (!bizMode) return toast('经营方式必填', false);
    const rateRaw = view.querySelector('#nRate').value;
    if (bizMode === '联营' && rateRaw !== '' && !(Number(rateRaw) > 0 && Number(rateRaw) <= 100))
      return toast('联营扣点为 1-100 的整数百分数（如 15 = 15%）', false);
    const body = {
      name,
      contactPerson: contact,
      contactPhone: phone,
      bizMode,
      deductionRate: bizMode === '联营' && rateRaw !== '' ? Number(rateRaw) / 100 : undefined,
      settlePeriod: view.querySelector('#nSettle').value,
      address: view.querySelector('#nAddr').value.trim() || undefined,
      remark: view.querySelector('#nRemark').value.trim() || undefined,
    };
    if (editId) {
      await must(put(`/purchase/suppliers/${editId}`, body), '供应商已更新');
    } else {
      await must(post('/purchase/suppliers', body), '供应商已建档');
    }
    modal.style.display = 'none';
    editId = 0;
    await load();
  };

  view.querySelector('#sDel').onclick = async () => {
    const ids = [...sel];
    if (!ids.length) return;
    if (!await confirmBox({
      title: '🗑 批量删除供应商',
      html: `确认删除 ${ids.length} 家未产生业务的供应商？\n删除后不可恢复（审计留痕）。`,
    })) return;
    let ok = 0; const errs = [];
    for (const id of ids) {
      try { await must(del(`/purchase/suppliers/${id}`)); ok++; sel.delete(id); }
      catch (e) { errs.push(e.msg || e.message); }
    }
    if (errs.length) toast(`成功 ${ok} 家，失败 ${errs.length} 家：${errs[0]}`, false);
    else toast(`已删除 ${ok} 家供应商`);
    await load();
  };

  view.querySelectorAll('#sBiz .segbtn').forEach(b => b.onclick = () => {
    view.querySelectorAll('#sBiz .segbtn').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); bizF = b.dataset.v; page = 1; apply();
  });
  view.querySelector('#sSearch').onclick = apply;
  view.querySelector('#sRefresh').onclick = load;
  view.querySelector('#sChange').onclick = openChange;
  view.querySelector('#sSettle').onchange = apply;
  view.querySelector('#sKw').addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });

  await load();

  /* ── V4.14.1 供应商变更单：调进价/售价/主供应商，即时生效全留痕（GYSBG 工单号） ── */
  async function openChange() {
    const chgRows = [];
    const { mask } = openDetailModal('🔁 供应商变更单 ', `
      <div class="doc-tip" style="margin:0 0 10px">💡 选定「新供应商」后逐行添加商品：可改<b>新进价</b>（落该供应商进价记录+联动历史最低价）、<b>新售价</b>（同步商品档案）、勾选<b>设为主供应商</b>（切换商品默认供货源）。提交即生效，全程留痕可回溯。</div>
      <div class="doc-head" style="grid-template-columns:1fr 1.2fr auto;align-items:end;border:1px dashed var(--line);border-radius:10px;padding:10px 14px">
        <div class="fld"><label class="req">新供应商（变更到）</label><select id="chgSup"><option value="">选择供应商…</option></select></div>
        <div class="fld"><label>变更原因</label><input id="chgReason" placeholder="如 供价调整/换供应商/促销调价"></div>
        <div class="fld"><label>&nbsp;</label><button class="btn pri" id="chgSubmit">📤 提交变更（即时生效）</button></div>
      </div>
      <div class="doc-head" style="grid-template-columns:minmax(240px,360px);margin-top:10px">
        <div class="fld"><label>添加商品（条码/名称/拼音）</label><input id="chgItem" placeholder="输入关键字或扫码…"></div>
      </div>
      <div id="chgRows">尚未添加商品行</div>
      <h3 style="margin:16px 0 6px;font-size:14px">变更记录（最近 100 单）</h3>
      <div id="chgLog" style="max-height:30dvh;overflow:auto">加载中…</div>`,
      { width: 940 });
    // 供应商下拉
    mask.querySelector('#chgSup').innerHTML = '<option value="">选择供应商…</option>' +
      rows.map(s => `<option value="${s.id}">${esc(s.name)}${(s.biz_mode || s.bizMode) === '联营' ? '（联营）' : ''}</option>`).join('');
    // 商品行
    const drawRows = () => {
      mask.querySelector('#chgRows').innerHTML = chgRows.length ? `
        <table><thead><tr><th class="seq">序号</th><th>商品</th><th style="width:120px">新进价（元）</th><th style="width:120px">新售价（元）</th><th style="width:150px">供应关系</th><th style="width:60px">操作</th></tr></thead>
        <tbody>${chgRows.map((r, i) => {
          const cur = r.independent ? 'independent' : r.isPrimary ? 'primary' : '';
          const sameSup = Number(r.p.supplier_default_id) === Number(mask.querySelector('#chgSup').value);
          return `<tr><td class="num seq">${i + 1}</td>
          <td><b>${esc(r.p.name)}</b>${r.p.barcode ? `<div class="muted mono" style="font-size:11px">${esc(r.p.barcode)}</div>` : ''}
            <div class="muted" style="font-size:11px">现售价 ¥${Number(r.p.sell_price ?? 0).toFixed(2)}${r.p.supplier_name ? ` · 主供 ${esc(r.p.supplier_name)}` : ' · 无主供应商'}</div></td>
          <td><input type="number" step="0.01" min="0" placeholder="不调" data-cost="${i}" value="${r.newCost ?? ''}" style="width:100px"></td>
          <td><input type="number" step="0.01" min="0" placeholder="不调" data-price="${i}" value="${r.newPrice ?? ''}" style="width:100px"></td>
          <td><select data-rel="${i}" style="width:140px">
            <option value="" ${!cur ? 'selected' : ''}>不变</option>
            <option value="primary" ${cur === 'primary' ? 'selected' : ''}>设为主供应商</option>
            <option value="independent" ${cur === 'independent' ? 'selected' : ''}>独立供应${sameSup ? '（已是）' : ''}</option>
          </select></td>
          <td><button class="btn sm warn" data-rdel="${i}">删</button></td>
        </tr>`; }).join('')}</tbody></table>`
        : '<div class="muted" style="padding:6px 2px;font-size:12px">尚未添加商品行（上方搜索添加）</div>';
      mask.querySelectorAll('[data-cost]').forEach(inp => inp.onchange = () => { chgRows[Number(inp.dataset.cost)].newCost = inp.value === '' ? null : Number(inp.value); });
      mask.querySelectorAll('[data-price]').forEach(inp => inp.onchange = () => { chgRows[Number(inp.dataset.price)].newPrice = inp.value === '' ? null : Number(inp.value); });
      mask.querySelectorAll('[data-rel]').forEach(sel => sel.onchange = () => {
        const v = sel.value;
        chgRows[Number(sel.dataset.rel)].isPrimary = v === 'primary';
        chgRows[Number(sel.dataset.rel)].independent = v === 'independent';
      });
      mask.querySelectorAll('[data-rdel]').forEach(b => b.onclick = () => { chgRows.splice(Number(b.dataset.rdel), 1); drawRows(); });
    };
    attachProductSearch(mask.querySelector('#chgItem'), { onPick: p => {
      if (chgRows.some(x => Number(x.p.id) === Number(p.id))) return toast('该商品已添加', false);
      chgRows.push({ p, newCost: null, newPrice: null, isPrimary: false, independent: false });
      drawRows();
    } });
    mask.querySelector('#chgSup').onchange = drawRows;
    // 提交
    mask.querySelector('#chgSubmit').onclick = async () => {
      const newSid = Number(mask.querySelector('#chgSup').value);
      if (!newSid) return toast('请先选择新供应商', false);
      if (!chgRows.length) return toast('请先添加商品行', false);
      const items = chgRows.map(r => ({
        productId: Number(r.p.id),
        newCost: r.newCost != null && Number.isFinite(r.newCost) ? r.newCost : undefined,
        newPrice: r.newPrice != null && Number.isFinite(r.newPrice) ? r.newPrice : undefined,
        isPrimary: !!r.isPrimary,
        independent: !!r.independent,
      }));
      const nInd = items.filter(x => x.independent).length;
      const yes = await confirmBox({
        title: '🔁 提交供应商变更单',
        html: `共 <b>${items.length}</b> 行（主供应商切换 ${items.filter(x => x.isPrimary).length} · 独立供应 ${nInd}）。<br>独立供应行将<b style="color:#c0392b">清除该商品与其他供应商的进价关联</b>（旧价快照已入留痕）。提交即生效，是否继续？`,
      });
      if (!yes) return;
      const d = await must(post('/purchase/supplier-changes', {
        newSupplierId: newSid,
        reason: mask.querySelector('#chgReason').value.trim() || undefined,
        items,
      }), '变更单已提交并即时生效');
      toast(`变更单 ${d.change_no || d.changeNo || ''} 完成：${items.length} 行`);
      mask.remove();
      await load();
      await chgRecords(1);   // V4.14.2：刷新底部变更记录表格
    };
    // 变更记录
    const loadLog = async () => {
      try {
        const d = await must(get('/purchase/supplier-changes'));
        const arr = d.items || [];
        mask.querySelector('#chgLog').innerHTML = arr.length ? `
          <table><thead><tr><th class="seq">序号</th><th>变更单号</th><th>商品行数</th><th>原供应商→新供应商</th><th>原因</th><th>操作人</th><th>时间</th><th></th></tr></thead>
          <tbody>${arr.map((c2, i) => `<tr><td class="num seq">${i + 1}</td>
            <td class="mono">${esc(c2.change_no)}</td>
            <td class="num">${Array.isArray(c2.items) ? c2.items.length : 0}</td>
            <td>${esc(c2.old_supplier_name || '（未切换）')} → <b>${esc(c2.new_supplier_name || '—')}</b></td>
            <td class="muted" style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(c2.reason || '—')}</td>
            <td class="muted">${esc(c2.creator_name || '—')}</td>
            <td>${dt(c2.created_at)}</td>
            <td><button class="btn sm" data-cd="${c2.id}">明细</button></td>
          </tr>`).join('')}</tbody></table>`
          : '<div class="empty">暂无变更记录</div>';
        mask.querySelectorAll('[data-cd]').forEach(b => b.onclick = () => showChangeDetail(Number(b.dataset.cd)));
      } catch (e) { mask.querySelector('#chgLog').innerHTML = `<div class="muted">加载失败：${esc(e.msg || e.message || '')}</div>`; }
    };
    await loadLog();
  }

  async function showChangeDetail(id) {
    const d = await must(get(`/purchase/supplier-changes/${id}`));
    const h = d.change || {}, items = d.items || [];
    const dt = (t) => String(t || '').slice(0, 16).replace('T', ' ');
    openDetailModal(`变更单明细 · <span class="mono">${esc(h.change_no || '')}</span>`, `
      <div class="bar" style="flex-wrap:wrap;gap:14px;font-size:12.5px;padding:4px 0 10px;border-bottom:1px dashed var(--line)">
        <span>状态：<span class="tag ${h.status === '已完成' ? 'g' : 'y'}">${esc(h.status || '—')}</span></span>
        <span>${esc(h.old_supplier_name || '（未切换）')} → <b>${esc(h.new_supplier_name || '—')}</b></span>
        <span>原因：${esc(h.reason || '—')}</span>
        <span>操作人：${esc(h.creator_name || '—')}</span>
        <span>时间：${dt(h.created_at)}</span>
      </div>
      ${items.length ? `<table><thead><tr><th class="seq">序号</th><th>商品</th><th class="num">原进价</th><th class="num">新进价</th><th class="num">原售价</th><th class="num">新售价</th><th>主供应商</th></tr></thead>
      <tbody>${items.map((it, i) => `<tr><td class="num seq">${i + 1}</td>
        <td><b>${esc(it.productName || '')}</b>${it.barcode ? `<div class="muted mono" style="font-size:11px">${esc(it.barcode)}</div>` : ''}</td>
        <td class="num muted">${it.oldCost != null ? '¥' + Number(it.oldCost).toFixed(2) : '—'}</td>
        <td class="num">${it.newCost != null ? '¥' + Number(it.newCost).toFixed(2) : '<span class="muted">不调</span>'}</td>
        <td class="num muted">${it.oldPrice != null ? '¥' + Number(it.oldPrice).toFixed(2) : '—'}</td>
        <td class="num">${it.newPrice != null ? '¥' + Number(it.newPrice).toFixed(2) : '<span class="muted">不调</span>'}</td>
        <td>${it.independent ? '<span class="tag r">独立供应</span>' : it.isPrimary ? '<span class="tag g">切换为该供应商</span>' : '<span class="muted">不变</span>'}
          ${(it.removedSuppliers || []).length ? `<div class="muted" style="font-size:11px">清除关联：${it.removedSuppliers.map(s2 => esc(s2.supplierName || ('#' + s2.supplierId))).join('、')}</div>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">无明细</div>'}`, { width: 820 });
  }

  /* ── V4.14.2 供应商变更记录表格（供应商明细下方，每页 10 条，超过翻页；V4.14.3 加按供应商过滤） ── */
  async function chgRecords(page = 1) {
    const box = view.querySelector('#chgList');
    if (!box) return;
    const CHG_SIZE = 10;
    try {
      const supSel = view.querySelector('#chgSup');
      if (supSel) {
        const cur = supSel.value;   // 每次重建选项（提交变更单后新供应商立即可选），保留当前选中
        supSel.innerHTML = '<option value="">全部供应商</option>' +
          rows.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
        supSel.value = cur;
        supSel.onchange = () => chgRecords(1);
      }
      const sid = supSel ? Number(supSel.value) || 0 : 0;
      const d = await must(get('/purchase/supplier-changes' + (sid ? `?supplierId=${sid}` : '')));
      const all = d.items || [];
      const pg = paginate(all, page, CHG_SIZE);
      box.innerHTML = all.length ? `
        <table><thead><tr><th class="seq">序号</th><th>变更单号</th><th class="num">行数</th><th>原供应商 → 新供应商</th><th>原因</th><th>操作人</th><th>时间</th><th></th></tr></thead>
        <tbody>${pg.slice.map((c2, i) => `<tr><td class="num seq">${(pg.page - 1) * CHG_SIZE + i + 1}</td>
          <td class="mono">${esc(c2.change_no)}</td>
          <td class="num">${Array.isArray(c2.items) ? c2.items.length : 0}</td>
          <td>${esc(c2.old_supplier_name || '（未切换）')} → <b>${esc(c2.new_supplier_name || '—')}</b></td>
          <td class="muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(c2.reason || '—')}</td>
          <td class="muted">${esc(c2.creator_name || '—')}</td>
          <td>${dt(c2.created_at)}</td>
          <td><button class="btn sm" data-chgd="${c2.id}">明细</button></td>
        </tr>`).join('')}</tbody></table>
        ${pg.bar}`
        : '<div class="empty">暂无变更记录（点上方「🔁 供应商变更单」新建）</div>';
      bindPager(box, p => chgRecords(p));
      box.querySelectorAll('[data-chgd]').forEach(b => b.onclick = () => showChangeDetail(Number(b.dataset.chgd)));
    } catch (e) {
      box.innerHTML = `<div class="muted" style="padding:6px 0">变更记录加载失败：${esc(e.msg || e.message || '')}</div>`;
    }
  }
  chgRecords();

  // V4.14.2：支持从对账页跳转自动打开指定供应商编辑弹窗（#/suppliers?edit=ID / ?del=ID）
  try {
    const m = (location.hash || '').match(/[?&](edit|del)=(\d+)/);
    if (m) {
      history.replaceState(null, '', location.pathname + location.search + '#/suppliers');
      if (rows.some(x => Number(x.id) === Number(m[2]))) open(Number(m[2]));
      if (m[1] === 'del') toast('请在编辑弹窗内点「🗑 删除该供应商」（未产生业务方可删除）');
    }
  } catch { /* 忽略解析失败 */ }
}
