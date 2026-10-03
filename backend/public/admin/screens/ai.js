import { get, post, del, must, esc, dt, toast, imgUrl, money } from '../api.js';
import { openDetailModal, pagerBar, bindPager } from '../common-ui.js';
import { attachProductSearch } from '../product-search.js';

/** AI 训练台（9.4）：任务工单（AICJ/AIXL/AIPG）→ 工单详情 → 预检合格/回退 → 审核通过 → 模型版本 → 单活部署
 *  统一状态颜色规则（全模块一致）：绿=已审核通过/已完成 · 红=待审核/待执行（需行动） · 黄=回退待重拍/临期 · 蓝=进行中/预检合格待终审 · 灰=停用/失效 */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>任务工单（采集/训练/评估） </h3>
      <div class="bar">
        <select id="tType"><option>采集</option><option>训练</option><option>评估</option></select>
        <input id="tTarget" type="number" placeholder="目标样本数" style="width:110px">
        <input id="tRemark" placeholder="备注" style="width:180px">
        <button class="btn pri" id="tGo">创建任务（生成工单号）</button>
        <span style="flex:1"></span>
        <button class="btn pri" id="tByProd" title="勾选商品清单发布采集任务，目标样本数=商品数，每商品采到才算完成">📋 按商品明细发布（采集）</button>
      </div>
      <div id="tList" class="mt8"></div>
    </div>
    <div class="card">
      <h3>样本库 </h3>
      <div class="bar">
        <input id="sKw" placeholder="商品名称/条码（模糊）" style="width:180px">
        <select id="sStatus" style="width:120px">
          <option value="">全部状态</option>
          <option>待审核</option><option>已入库</option><option>不合格</option>
        </select>
        <button class="btn" id="sGo">查询</button>
        <span class="muted" id="sCount" style="font-size:12px"></span>
      </div>
      <div id="sList" class="tbl-min-12"></div>
    </div>
    <div class="card">
      <h3>向量索引（CLIP 实时识别提速层） </h3>
      <div class="bar">
        <span id="embStat" class="muted" style="font-size:12.5px">加载中…</span>
        <span style="flex:1"></span>
        <button class="btn" id="embBuild">🔄 一键建索引（补缺失）</button>
        <button class="btn" id="embRebuild">♻️ 强制重建（全量重算）</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px">识别管线：条码先行（秒级）→ CLIP 向量检索（毫秒级，Top-1 相似度 ≥ 0.90 自动命中）→ 未达标弹候选卡片人工确认 → VL 兜底。新样本审核通过后自动索引，无需手动重建。</div>
      <div id="embOut" class="mt8"></div>
    </div>
    <div class="card">
      <h3>模型版本（单活部署） </h3>
      <div id="mList"></div>
    </div>
    <div class="card">
      <h3>商品识别（向量检索 + 样本匹配） </h3>
      <div class="bar">
        <input type="file" id="rImg" accept="image/*" style="display:none">
        <button class="btn" id="rPick">📷 上传图片测试真实识别</button>
        <span class="muted" style="font-size:12px">用拍到的商品照片验证：条码/向量检索/dHash 分层识别，没传过样本的商品不会出现</span>
        <input id="ocrTxt" placeholder="OCR 文本（逗号分隔：品名,单位,售价,条码）" style="width:300px">
        <button class="btn" id="ocrGo">OCR 建档</button>
      </div>
      <div id="rOut" class="mt8"></div>
    </div>
    <div class="card">
      <h3>📄 供应商票据识别入库 </h3>
      <div class="bar">
        <select id="invSup" style="width:200px"></select>
        <input type="file" id="invFile" accept="image/*" style="display:none">
        <button class="btn" id="invPick">📷 上传票据图</button>
        <button class="btn pri" id="invRecognize">🔍 识别票据</button>
      </div>
      <textarea id="invTxt" placeholder="或直接粘贴票据文本：每行 商品名,条码,单价,数量[,生产日期][,保质期天]" style="width:100%;height:64px;margin-top:6px;box-sizing:border-box"></textarea>
      <div id="invOut" class="mt8"></div>
      <div class="bar mt8">
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="invForce"> 强制通过低价行（店长强推）</label>
        <button class="btn pri" id="invApply" style="display:none">📦 生成入库草稿</button>
      </div>
    </div>
    <div class="modal-mask" id="woModal" style="display:none">
      <div class="modal" style="width:min(760px,94vw)">
        <h3 id="woTitle">工单详情</h3>
        <div id="woBody" style="max-height:60dvh;overflow:auto"></div>
        <div class="doc-foot" style="margin-top:10px">
          <span style="flex:1"></span>
          <span id="woPrecheckBox" style="display:flex;gap:8px;align-items:center">
            <button class="btn" id="woPass" style="color:var(--pri);border-color:var(--pri)">✓ 合格</button>
            <button class="btn" id="woBack" style="color:#b34f18;border-color:#e6b0aa">↩ 回退重拍</button>
            <input id="woRemark" placeholder="预检备注（选填）" style="width:150px">
            <button class="btn pri" id="woApprove">✅ 审核通过</button>
          </span>
        </div>
      </div>
    </div>`;

  // 工单号着色（统一规则）：绿=已审核通过 · 红=未审核 · 黄=已回退 · 蓝=预检合格待终审
  const orderColor = o => {
    if (o.review_result === '合格' && o.status === '已完成') return 'g';
    if (o.review_result === '回退') return 'y';
    if (o.review_result === '合格') return 'b';
    if (o.status === '已完成') return 'g';
    if (o.status === '进行中') return 'r';   // 进行中待提交/待审核 = 需行动（红）
    return 'r';
  };

  async function tasks() {
    const rows = await must(get('/ai/orders'));
    const arr = rows.items || rows || [];
    view.querySelector('#tList').innerHTML = arr.length ? `
      <table><thead><tr><th class="seq">序号</th><th>工单号</th><th>类型</th><th>状态</th><th>预检</th><th class="num">样本(总/待审/入库/不合格)</th><th class="num">目标</th><th>创建人</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${arr.map((t, i) => `<tr>
        <td class="num seq">${i + 1}</td><td><a data-wo="${t.id}" href="javascript:void 0" style="font-family:var(--mono);font-weight:700;text-decoration:underline">${esc(t.task_no || '#' + t.id)}</a></td>
        <td>${esc(t.task_type || t.taskType)}</td>
        <td><span class="tag ${String(t.status).includes('完成') ? 'g' : String(t.status).includes('进行') ? 'b' : 'r'}">${esc(t.status)}</span></td>
        <td>${t.review_result ? `<span class="tag ${t.review_result === '合格' ? 'b' : 'y'}">${esc(t.review_result)}</span>` : '<span class="tag r">未审核</span>'}</td>
        <td class="num muted">${t.sample_total ?? 0} / ${t.sample_pending ?? 0} / ${t.sample_ok ?? 0} / ${t.sample_bad ?? 0}</td>
        <td class="num">${t.target_count ?? t.targetCount ?? '—'}${(t.total_products ?? t.totalProducts) ? `<div class="muted" style="font-size:11px">商品 ${t.done_products ?? 0}/${t.total_products ?? 0} 已采</div>` : ''}</td>
        <td class="muted">${esc(t.creator_name || '')}</td><td>${dt(t.created_at || t.createdAt)}</td>
        <td>${t.status === '待执行' ? `<button class="btn sm" data-s="${t.id}">开始</button>` : ''}
            ${t.status === '进行中' && t.task_type === '训练' ? `<button class="btn sm pri" data-f="${t.id}">完成</button>` : ''}
            ${['待执行', '待审核'].includes(t.status) ? `<button class="btn sm warn" data-del="${t.id}">删除</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无工单（创建任务即生成 AICJ/AIXL/AIPG 工单号）</div>';
    view.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
      await must(post(`/ai/tasks/${b.dataset.s}/start`), '任务已开始'); await tasks();
    });
    // V5.0.2：未开始/未审核工单可删除（后端同口径校验；样本解除挂接但保留）
    view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('确认删除该工单？已挂接样本将解除关联（样本本身保留）。')) return;
      await must(del(`/ai/tasks/${b.dataset.del}`), '工单已删除'); await tasks();
    });
    view.querySelectorAll('[data-f]').forEach(b => b.onclick = async () => {
      await must(post(`/ai/tasks/${b.dataset.f}/finish`), '任务已完成（生成模型版本）'); await tasks(); await models();
    });
    view.querySelectorAll('[data-wo]').forEach(a => a.onclick = () => openOrder(Number(a.dataset.wo)));
  }

  // 工单详情弹窗：任务头 + 商品分组样本图 + 预检合格/回退 + 审核通过（预检合格才点亮）
  async function openOrder(id) {
    const d = await must(get('/ai/orders/' + id));
    const t = d.order || {};
    const samples = d.samples || [];
    const byProduct = {};
    for (const s of samples) {
      const key = s.product_id || 0;
      (byProduct[key] = byProduct[key] || { name: s.product_name || `商品${key}`, barcode: s.product_barcode || '', list: [] }).list.push(s);
    }
    const approved = t.review_result === '合格' && t.status === '已完成';
    view.querySelector('#woTitle').innerHTML = `📋 工单详情 · <span class="mono">${esc(t.task_no || '')}</span>
      <span class="tag ${orderColor(t)}" style="margin-left:8px">${t.review_result === '合格' && t.status === '已完成' ? '已审核通过' : t.review_result === '回退' ? '已回退·待重拍' : t.review_result === '合格' ? '预检合格·待终审' : '未审核'}</span>`;
    view.querySelector('#woBody').innerHTML = `
      <div class="bar" style="flex-wrap:wrap;gap:14px;font-size:12.5px;padding:4px 0 10px;border-bottom:1px dashed var(--line)">
        <span>类型：<b>${esc(t.task_type)}</b></span>
        <span>状态：<span class="tag ${String(t.status).includes('完成') ? 'g' : String(t.status).includes('进行') ? 'b' : 'r'}">${esc(t.status)}</span></span>
        <span>采集进度：<b class="num">${t.done_count ?? 0} / ${t.target_count ?? '—'}</b>（${Number(t.progress || 0)}%）</span>
        <span>创建人：${esc(t.creator_name || '—')}</span>
        <span>创建：${dt(t.created_at)}</span>
        ${t.review_remark ? `<span>备注：${esc(t.review_remark)}</span>` : ''}
      </div>
      ${t.status === '进行中' && t.task_type === '采集' && Number(t.done_count || 0) >= Number(t.target_count || 0) ? `
        <div style="margin:10px 0;padding:9px 12px;background:var(--green-soft);border-radius:10px;font-size:12.5px;color:var(--pri)">
          ✅ 采集已满 ${t.target_count} 张 —— 店长在下方点「合格」预检 → 再点「审核通过」即完成工单（样本全部入库）
        </div>` : t.status === '进行中' && t.task_type === '采集' ? `
        <div style="margin:10px 0;padding:9px 12px;background:var(--info-soft);border-radius:10px;font-size:12.5px;color:var(--info)">
          ℹ️ 店员在手机端「AI 训练采集」执行工单 ${esc(t.task_no || '')} 拍照上传，采集满 ${t.target_count ?? '—'} 张后由店长预检 → 审核通过完成
        </div>` : ''}
      ${Object.keys(byProduct).length ? Object.values(byProduct).map(g => `
        <div style="padding:10px 0 4px">
          <b style="font-size:13px">🏷️ ${esc(g.name)}</b>
          <span class="muted mono" style="margin-left:6px">${esc(g.barcode || '')}</span>
          <span class="muted" style="margin-left:6px;font-size:11.5px">${g.list.length} 张</span>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
            ${g.list.map(s => `
              <div data-img="${esc(imgUrl(s.image_path))}" style="cursor:zoom-in;text-align:center;width:76px">
                <img src="${esc(imgUrl(s.image_path))}" loading="lazy" style="width:72px;height:72px;border-radius:8px;object-fit:cover;border:1px solid var(--line)" onerror="this.style.opacity=.25">
                <div class="muted" style="font-size:10.5px">${esc(s.angle || '样本')}</div>
                <div><span class="tag ${s.status === '已入库' ? 'g' : s.status === '不合格' ? 'n' : 'r'}" style="font-size:10px;padding:1px 6px">${esc(s.status)}</span></div>
              </div>`).join('')}
          </div>
        </div>`).join('') : '<div class="empty">本工单暂无样本 —— 店员在手机端「AI 训练采集」选择本工单（' + esc(t.task_no || '') + '）拍照上传后，此处即显示样本图</div>'}`;
    // 样本大图
    view.querySelectorAll('#woBody [data-img]').forEach(el => el.onclick = () => {
      const lb = document.createElement('div');
      lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out;padding:24px';
      lb.innerHTML = `<img src="${esc(el.dataset.img)}" style="max-width:92vw;max-height:92vh;border-radius:12px">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    });
    // 预检 / 终审按钮
    const box = view.querySelector('#woPrecheckBox');
    box.style.display = samples.length ? 'flex' : 'none';
    const pass = view.querySelector('#woPass'), back = view.querySelector('#woBack'), approve = view.querySelector('#woApprove');
    const refreshBtns = () => {
      const t2 = t;
      pass.disabled = approved || t2.review_result === '合格';
      back.disabled = approved;
      approve.disabled = !(t2.review_result === '合格' && t2.status !== '已完成');
      approve.title = approve.disabled ? (t2.review_result === '合格' ? '' : '需先预检「合格」才能审核通过（回退工单须店员重新拍照提交）') : '';
    };
    refreshBtns();
    view.querySelector('#woPass').onclick = async () => {
      const r = await must(post(`/ai/orders/${id}/precheck`, { result: '合格', remark: view.querySelector('#woRemark').value.trim() || undefined }), '预检合格：可点击「审核通过」终审');
      await openOrder(id); await tasks();
    };
    view.querySelector('#woBack').onclick = async () => {
      if (!confirm('确认回退该工单？\n回退后工单内待审核样本将标记「不合格」，任务回到进行中，由店员重新拍照提交。')) return;
      await must(post(`/ai/orders/${id}/precheck`, { result: '回退', remark: view.querySelector('#woRemark').value.trim() || '回退重拍' }), '已回退给店员重拍');
      await openOrder(id); await tasks();
    };
    view.querySelector('#woApprove').onclick = async () => {
      const r = await must(post(`/ai/orders/${id}/approve`), '审核通过');
      toast(`工单 ${r.taskNo || ''} 审核通过：${r.approved} 张样本入库（工单号已变绿）`);
      await openOrder(id); await tasks(); await samples();
    };
    view.querySelector('#woModal').style.display = 'flex';
  }
  view.querySelector('#woModal').onclick = e => { if (e.target === view.querySelector('#woModal')) view.querySelector('#woModal').style.display = 'none'; };

  /* ── V4.14.1 样本库：分页 + 关键字 + 逐张审核/删除（操作列）；V4.14.9：首列复选框批量入库/不合格/删除 + 统一分页条 ── */
  let sPage = 1;
  const S_SIZE = 12;
  const sSel = new Set();
  async function samples() {
    const kw = encodeURIComponent(view.querySelector('#sKw').value.trim());
    const st = encodeURIComponent(view.querySelector('#sStatus').value);
    const rows = await must(get(`/ai/samples?keyword=${kw}&status=${st}&page=${sPage}&size=${S_SIZE}`));
    let arr = rows.items || rows || [];
    const hasMore = arr.length > S_SIZE;
    if (hasMore) arr = arr.slice(0, S_SIZE);
    arr.forEach(s => sSel.delete(Number(s.id)));   // 只保留当前页可见项的勾选语义
    const pages = hasMore ? sPage + 1 : sPage;     // size+1 探测：有更多则至少还有下一页
    // V4.26.2：全选框必须回显勾选状态。其 onchange 里会重绘本页列表，若无回显则重绘后
    // 又变回未勾选 → 用户再点只能是"全选"，表现为「只能全选、无法取消全选」。
    const sAllChecked = arr.length > 0 && arr.every(s => sSel.has(Number(s.id)));
    view.querySelector('#sList').innerHTML = arr.length ? `
      <div class="bar" style="padding:6px 2px 0">
        <button class="btn sm pri" id="sBatOk" style="display:none">✓ 批量入库</button>
        <button class="btn sm warn" id="sBatNo" style="display:none">✗ 批量不合格</button>
        <button class="btn sm" id="sBatDel" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 批量删除</button>
        <span class="muted" style="font-size:12px" id="sSelN"></span>
      </div>
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="sChkAll" title="全选/取消全选本页" ${sAllChecked ? 'checked' : ''}></th><th class="seq">序号</th><th>样本图</th><th>商品</th><th>工单号</th><th>来源</th><th>状态</th><th>采集时间</th><th style="width:190px">操作</th></tr></thead>
      <tbody>${arr.map((s, i) => `<tr>
        <td onclick="event.stopPropagation()"><input type="checkbox" data-schk="${s.id}" ${sSel.has(Number(s.id)) ? 'checked' : ''}></td><td class="num seq">${i + 1}</td>
        <td>${!s.image_path ? '<span class="muted">—</span>'
          : s.image_path.startsWith('/uploads/')
          ? `<img data-img="${esc(imgUrl(s.image_path))}" src="${esc(imgUrl(s.image_path))}" loading="lazy" style="width:48px;height:48px;border-radius:6px;object-fit:cover;cursor:zoom-in;border:1px solid var(--line)" onerror="this.style.opacity=.25">`
          : s.image_path.startsWith('img://')
          ? `<div style="width:64px;height:64px;border-radius:8px;border:1px dashed var(--line);display:grid;place-items:center;font-size:10.5px;color:var(--ink-3);text-align:center">本机帧<br>未上传</div>`
          : '<span class="muted">—</span>'}</td>
        <td>${esc(s.product_name || s.product_id || '')}</td>
        <td class="muted mono">${esc(s.task_no || '—')}</td>
        <td class="muted">${esc(s.source || '')}${s.angle ? ' · ' + esc(s.angle) : ''}</td>
        <td><span class="tag ${s.status === '已入库' ? 'g' : s.status === '不合格' ? 'n' : 'r'}">${esc(s.status)}</span></td>
        <td>${dt(s.created_at || s.createdAt)}</td>
        <td style="white-space:nowrap">
          ${s.status === '待审核' ? `<button class="btn sm pri" data-ok="${s.id}">✓ 入库</button>
          <button class="btn sm warn" data-no="${s.id}">✗ 不合格</button>` : ''}
          <button class="btn sm" style="color:#c0392b;border-color:#e6b0aa" data-del="${s.id}" title="删除样本（误采/重复，留痕）">🗑</button>
        </td>
      </tr>`).join('')}</tbody></table>
      <div class="muted" style="padding:6px 2px 0;font-size:12px">审核以工单为单位（点上方工单号批量合格/回退），也可在此逐张/勾选批量处理；删除不可恢复（审计留痕）。</div>`
      : '<div class="empty">样本库为空（手机端「AI 训练采集」上传 / 收银纠正自动入库）</div>';
    // 分页条（统一组件：右对齐 + 页码 + 手输跳页）
    const listHost = view.querySelector('#sList');
    if (arr.length) {
      listHost.insertAdjacentHTML('beforeend', pagerBar({ page: sPage, pages, total: hasMore ? `${sPage * S_SIZE}+` : (sPage - 1) * S_SIZE + arr.length, size: S_SIZE }));
    }
    const syncBat = () => {
      const show = sSel.size > 0;
      for (const id of ['sBatOk', 'sBatNo', 'sBatDel']) { const el = view.querySelector('#' + id); if (el) el.style.display = show ? '' : 'none'; }
      const n = view.querySelector('#sSelN');
      if (n) n.textContent = show ? `已选 ${sSel.size} 张` : '';
    };
    syncBat();
    const goPage = p => { sPage = Math.max(1, p); samples(); };
    bindPager(listHost, goPage);
    view.querySelectorAll('[data-schk]').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.schk);
      if (cb.checked) sSel.add(id); else sSel.delete(id);
      syncBat();
    });
    const chkAll = view.querySelector('#sChkAll');
    if (chkAll) chkAll.onchange = () => {
      arr.forEach(s => { if (chkAll.checked) sSel.add(Number(s.id)); else sSel.delete(Number(s.id)); });
      samples();
    };
    // 批量操作：入库 / 不合格 / 删除（后端批量端点，逐条结果汇总）
    if (arr.length) {
      const batchRun = async (action, okMsg) => {
        const ids = [...sSel];
        if (!ids.length) return;
        if (action === '删除' && !confirm(`确认删除所选 ${ids.length} 张样本？删除后不可恢复（审计留痕）。`)) return;
        try {
          const r = await must(post('/ai/samples/batch', { ids, action }));
          sSel.clear();
          toast(okMsg(r));
        } catch { /* must 已 toast */ }
        await samples(); await tasks();
        if (action !== '不合格') await embRefresh();
      };
      view.querySelector('#sBatOk').onclick = () => batchRun('已入库', r => `批量入库完成：成功 ${r.ok} 张${r.skip ? `，跳过 ${r.skip} 张（已审核/不存在）` : ''}`);
      view.querySelector('#sBatNo').onclick = () => batchRun('不合格', r => `批量标记完成：成功 ${r.ok} 张${r.skip ? `，跳过 ${r.skip} 张` : ''}`);
      view.querySelector('#sBatDel').onclick = () => batchRun('删除', r => `批量删除完成：成功 ${r.ok} 张${r.skip ? `，跳过 ${r.skip} 张` : ''}`);
    }
    const pager = id => { const el = view.querySelector('#' + id); if (el) el.onclick = () => { sPage = Math.max(1, sPage + (id === 'sNext' ? 1 : -1)); samples(); }; };
    pager('sPrev'); pager('sNext');
    view.querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => {
      await must(post(`/ai/samples/${b.dataset.ok}/review`, { status: '已入库' }), '样本已入库（自动建向量索引）');
      await samples(); await tasks();
    });
    view.querySelectorAll('[data-no]').forEach(b => b.onclick = async () => {
      await must(post(`/ai/samples/${b.dataset.no}/review`, { status: '不合格' }), '样本已标记不合格');
      await samples();
    });
    view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('确认删除该样本？删除后不可恢复（审计留痕）。')) return;
      await must(post(`/ai/samples/${b.dataset.del}/delete`), '样本已删除');
      await samples(); await embRefresh();
    });
    view.querySelectorAll('[data-img]').forEach(el => el.onclick = () => {
      const lb = document.createElement('div');
      lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out;padding:24px';
      lb.innerHTML = `<img src="${esc(el.dataset.img)}" style="max-width:92vw;max-height:92vh;border-radius:12px">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    });
  }
  view.querySelector('#sGo').onclick = () => { sPage = 1; samples(); };
  view.querySelector('#sKw').addEventListener('keydown', e => { if (e.key === 'Enter') { sPage = 1; samples(); } });
  view.querySelector('#sStatus').onchange = () => { sPage = 1; samples(); };

  /* ── V4.14.1 按商品明细发布采集任务：勾选商品清单 → 目标样本数=商品数，逐商品采到才算完成 ── */
  view.querySelector('#tByProd').onclick = () => openByProduct();

  async function openByProduct() {
    let cats = [];
    try {
      const tree = await must(get('/products/categories'));
      const flat = [];
      const walk = (arr, depth) => (arr || []).forEach(c2 => { flat.push({ id: c2.id, name: (depth > 0 ? '　'.repeat(depth) + '└ ' : '') + c2.name }); walk(c2.children, depth + 1); });
      walk(tree, 0);
      cats = flat;
    } catch { /* 无分类也可用 */ }
    const { mask } = openDetailModal('📋 按商品明细发布采集任务 ', `
      <div class="bar" style="padding:2px 0 8px">
        <select id="bpCat" style="width:170px">
          <option value="">全部分类</option>
          ${cats.map(c2 => `<option value="${c2.id}">${esc(c2.name || c2)}</option>`).join('')}
        </select>
        <input id="bpKw" placeholder="商品名称/条码关键字" style="width:200px">
        <button class="btn" id="bpGo">查询</button>
        <span style="flex:1"></span>
        <span class="muted" style="font-size:12px">已选 <b id="bpN" style="color:var(--pri)">0</b> 个商品（目标样本数 = 商品数）</span>
      </div>
      <div id="bpList" style="max-height:52dvh;overflow:auto;border:1px dashed var(--line);border-radius:10px;padding:6px 10px">加载中…</div>
      <div class="bar mt8" style="align-items:center">
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="bpHide" checked> 只看未采集过样本的商品（推荐）</label>
        <input id="bpRemark" placeholder="任务备注（选填）" style="width:200px">
        <span style="flex:1"></span>
        <button class="btn" id="bpCancel">取消</button>
        <button class="btn pri" id="bpCreate">📤 发布采集任务</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px">发布后店员在手机端「AI 训练采集」看到该工单，每个商品至少采到 1 张样本；后台按「商品 N/M 已采」跟踪进度，全部采完才允许预检合格。</div>`,
      { width: 820 });
    const picked = new Set();
    const loadList = async () => {
      const kw = encodeURIComponent(mask.querySelector('#bpKw').value.trim());
      const cat = mask.querySelector('#bpCat').value;
      const hide = mask.querySelector('#bpHide').checked;
      const d = await must(get(`/products?size=100${kw ? `&keyword=${kw}` : ''}${cat ? `&categoryId=${cat}` : ''}`));
      let items = d.items || d || [];
      // V5.0.2：按近 90 天消费频次降序——卖得越快的商品越优先采集
      let freqMap = {};
      try { const f = await must(get('/ai/products-frequency')); freqMap = f?.freq || {}; } catch { /* 无数据保持原序 */ }
      items = [...items].sort((a, b) => (Number(freqMap[b.id]) || 0) - (Number(freqMap[a.id]) || 0));
      if (hide) {
        try {
          const smp = await must(get(`/ai/samples?page=1&size=100`));
          const seen = new Set((smp.items || smp || []).map(s => Number(s.product_id)));
          if ((smp.items || smp || []).length >= 100) {
            // 样本多于 100 时退回显示全部（避免误判已采集）
            mask.querySelector('#bpList').innerHTML = `<div class="muted" style="padding:8px">样本较多，已关闭「只看未采集」过滤以防遗漏，请用勾选方式挑选。</div>`;
            return;
          }
          items = items.filter(p => !seen.has(Number(p.id)));
        } catch { /* 过滤失败则显示全部 */ }
      }
      mask.querySelector('#bpList').innerHTML = items.length ? `
        <table><thead><tr><th style="width:34px"></th><th class="seq">序号</th><th>商品</th><th>条码</th><th class="num">90天销量</th><th class="num">售价</th><th>主供应商</th></tr></thead>
        <tbody>${items.map((p, i) => `<tr>
          <td><input type="checkbox" data-pk="${p.id}" ${picked.has(Number(p.id)) ? 'checked' : ''}></td><td class="num seq">${i + 1}</td>
          <td>${esc(p.name)}</td>
          <td class="muted mono">${esc(p.barcode || '—')}</td>
          <td class="num" style="font-weight:700;color:${(Number(freqMap[p.id]) || 0) > 0 ? 'var(--pri)' : 'var(--ink-3,#8a8577)'}">${Number(freqMap[p.id]) || 0}</td>
          <td class="num">${money(p.sell_price ?? 0)}</td>
          <td class="muted">${esc(p.supplier_name || '—')}</td>
        </tr>`).join('')}</tbody></table>
        ${items.length >= 100 ? '<div class="muted" style="padding:4px 0">仅显示前 100 条，请用关键字/分类缩小范围</div>' : ''}`
        : '<div class="empty">无匹配商品</div>';
      mask.querySelectorAll('[data-pk]').forEach(cb => cb.onchange = () => {
        const id = Number(cb.dataset.pk);
        if (cb.checked) picked.add(id); else picked.delete(id);
        mask.querySelector('#bpN').textContent = String(picked.size);
      });
    };
    mask.querySelector('#bpGo').onclick = loadList;
    mask.querySelector('#bpKw').addEventListener('keydown', e => { if (e.key === 'Enter') loadList(); });
    mask.querySelector('#bpCat').onchange = loadList;
    mask.querySelector('#bpHide').onchange = loadList;
    mask.querySelector('#bpCancel').onclick = () => mask.remove();
    mask.querySelector('#bpCreate').onclick = async () => {
      if (!picked.size) return toast('请先勾选至少 1 个商品', false);
      const d = await must(post('/ai/tasks', { taskType: '采集', productIds: [...picked], remark: mask.querySelector('#bpRemark').value.trim() || undefined }), '采集任务已发布');
      toast(`工单已生成：${d?.task_no || '（见列表）'}，目标 ${picked.size} 个商品`);
      mask.remove();
      await tasks();
    };
    await loadList();
  }

  async function models() {
    const rows = await must(get('/ai/models'));
    const arr = rows.items || rows || [];
    view.querySelector('#mList').innerHTML = arr.length ? `
      <table><thead><tr><th class="seq">序号</th><th>版本</th><th class="num">mAP</th><th>状态</th><th>训练任务</th><th>部署时间</th></tr></thead>
      <tbody>${arr.map((m, i) => `<tr>
        <td class="num seq">${i + 1}</td><td>${esc(m.version)}</td><td class="num">${m.map ?? m.mAP ?? '—'}</td>
        <td><span class="tag ${m.status === '已部署' ? 'g' : 'y'}">${esc(m.status)}</span></td>
        <td>${m.task_id ?? m.taskId ?? '—'}</td><td>${dt(m.deployed_at || m.deployedAt)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无模型版本（完成训练任务后生成）</div>';
  }

  view.querySelector('#tGo').onclick = async () => {
    const target = Number(view.querySelector('#tTarget').value);
    const d = await must(post('/ai/tasks', { taskType: view.querySelector('#tType').value,
      targetCount: target || undefined, remark: view.querySelector('#tRemark').value || undefined }), '任务已创建');
    toast(`工单已生成：${d?.task_no || '（见列表）'}`);
    await tasks();
  };
  // ── V4.10.1 向量索引面板：状态 + 一键建索引 + 强制重建 ──
  async function embRefresh() {
    try {
      const s = await must(get('/ai/emb/status'));
      const badge = !s.modelReady ? '<span style="color:#b34f18">⚠️ 模型文件缺失</span>'
        : !s.enabled ? '<span style="color:#b34f18">已关闭</span>'
        : `<span style="color:#1f7a33">✅ 就绪</span> · 已索引 ${s.indexed}/${s.total} 张${s.error ? `（解码失败 ${s.error} 张）` : ''} · 覆盖 ${s.products} 个商品`;
      view.querySelector('#embStat').innerHTML = badge;
    } catch (e) { view.querySelector('#embStat').textContent = '状态获取失败：' + (e.message || ''); }
  }
  view.querySelector('#embBuild').onclick = async () => {
    try {
      const r = await must(post('/ai/emb/reindex', {}));
      toast(`索引完成：成功 ${r?.indexed ?? 0} 张`);
      await embRefresh();
    } catch (e) { /* must 已 toast 错误 */ }
  };
  view.querySelector('#embRebuild').onclick = async () => {
    try {
      const r = await must(post('/ai/emb/reindex', { force: true }));
      toast(`重建完成：成功 ${r?.indexed ?? 0} 张，失败 ${r?.failed ?? 0} 张`);
      await embRefresh();
    } catch (e) { /* must 已 toast 错误 */ }
  };
  embRefresh();

  // 真实识别测试：上传商品照片 → 与样本库比对（模拟已废除）
  view.querySelector('#rPick').onclick = () => view.querySelector('#rImg').click();
  view.querySelector('#rImg').onchange = async () => {
    const f = view.querySelector('#rImg').files[0];
    if (!f) return;
    try {
      const img = await new Promise(res => { const rd = new FileReader(); rd.onload = e => res(e.target.result); rd.readAsDataURL(f); });
      const MAX = 960, im = new Image();
      await new Promise(res => { im.onload = res; im.src = img; });
      const k = Math.min(1, MAX / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      const d = await must(post('/ai/recognize', { imageBase64: c.toDataURL('image/jpeg', 0.72), mode: 'multi' }));
      const items = (d?.result || []);
      const layerName = { clip: '⚡ CLIP 向量检索', 'clip-multi': '⚡ CLIP 多件识别（轮廓分割×逐件检索）', 'clip-cand': '🔎 CLIP 候选待确认', vl: '🧠 VL 大模型兜底', dhash: '🔍 dHash 样本匹配', onnx: '📦 ONNX 模型', barcode: '📊 条码' }[d?.layer] || (d?.layer || '-');
      const candRows = (d?.candidates || []).map(x => `<tr><td>${esc(x.name || '')}</td><td class="num">${Math.round((x.conf || 0) * 100)}%</td></tr>`).join('');
      view.querySelector('#rOut').innerHTML = `
        <div class="${items.length ? 'ok' : 'muted'}" style="margin-bottom:6px">${items.length ? '✅' : '⚠️'} ${esc(d?.notice || '未识别出商品')}</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px">识别层：${esc(layerName)} · 全程 ${d?.latencyMs ?? '-'}ms</div>
        ${items.length ? `<table><thead><tr><th class="seq">序号</th><th>识别商品</th><th class="num">数量</th><th class="num">相似度</th></tr></thead>
        <tbody>${items.map((x, i) => `<tr><td class="num seq">${i + 1}</td><td>${esc(x.name || '')}</td>
          <td class="num">${x.count ?? 1}</td><td class="num">${Math.round((x.conf || 0) * 100)}%</td></tr>`).join('')}</tbody></table>` : ''}
        ${candRows ? `<div class="muted" style="font-size:12px;margin:8px 0 4px">候选卡片（Top-${(d?.candidates || []).length}，未自动命中时移动端会弹出供店员点选确认）</div>
        <table><thead><tr><th>候选商品</th><th class="num">相似度</th></tr></thead><tbody>${candRows}</tbody></table>` : ''}`;
    } catch (e) { toast(e.message || '识别失败', false); }
    view.querySelector('#rImg').value = '';
  };
  view.querySelector('#ocrGo').onclick = async () => {
    const txt = view.querySelector('#ocrTxt').value.trim();
    if (!txt) return toast('请输入 OCR 文本', false);
    await must(post('/ai/ocr-intake', { text: txt }), 'OCR 建档完成');
  };

  // ── M3a 票据识别入库：供应商 → 票据图/文本 → 识别预览（低价保护）→ 生成入库草稿 ──
  let invRows = [], invImg = '';
  (async () => {
    const d = await must(get('/purchase/suppliers')).catch(() => null);
    const list = d?.items || d || [];
    if (Array.isArray(list) && list.length) {
      view.querySelector('#invSup').innerHTML = '<option value="">选择供应商…</option>' +
        list.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    }
  })();
  view.querySelector('#invPick').onclick = () => view.querySelector('#invFile').click();
  view.querySelector('#invFile').onchange = async () => {
    const f = view.querySelector('#invFile').files[0];
    if (!f) return;
    const img = await new Promise(res => { const rd = new FileReader(); rd.onload = e => res(e.target.result); rd.readAsDataURL(f); });
    const MAX = 1600, im = new Image();
    await new Promise(res => { im.onload = res; im.src = img; });
    const k = Math.min(1, MAX / Math.max(im.width, im.height));
    const c = document.createElement('canvas');
    c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    invImg = c.toDataURL('image/jpeg', 0.72);
    toast('票据图片已就绪');
  };
  view.querySelector('#invRecognize').onclick = async () => {
    const supplierId = Number(view.querySelector('#invSup').value);
    if (!supplierId) return toast('请先选择供应商', false);
    const txt = view.querySelector('#invTxt').value.trim();
    if (!invImg && !txt) return toast('请上传票据图或粘贴票据文本', false);
    const d = await must(post('/ai/ocr-invoice', { supplierId, ...(invImg ? { imageBase64: invImg } : {}), ...(txt ? { text: txt } : {}) }), '识别完成');
    invRows = (d.rows || []).map(r => ({ ...r, qty: Number(r.qty) || 1, price: Number(r.price) || 0 }));
    const ok = invRows.filter(r => r.ok && r.matched);
    view.querySelector('#invOut').innerHTML = invRows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>票据行</th><th>商品</th><th>匹配</th><th class="num">数量</th><th class="num">单价</th><th>状态</th></tr></thead>
      <tbody>${invRows.map((r, i) => `<tr>
        <td class="num seq">${i + 1}</td><td class="muted">${r.line}</td>
        <td>${esc(r.name)}${r.matchedName && r.matchedName !== r.name ? `<div class="muted">→ ${esc(r.matchedName)}</div>` : ''}</td>
        <td>${r.matched ? `<span class="tag g">已匹配</span>` : r.unmatched ? '<span class="tag y">未建档</span>' : '<span class="tag r">缺字段</span>'}</td>
        <td class="num"><input data-i="${i}" data-f="qty" type="number" min="1" step="1" value="${r.qty}" style="width:64px"></td>
        <td class="num"><input data-i="${i}" data-f="price" type="number" min="0.01" step="0.01" value="${r.price}" style="width:80px"></td>
        <td>${r.blocked ? '<span class="tag r">⛔ 低价拦截</span>' : r.lowPrice ? `<span class="tag y">⚠ 低于历史最低 ${money(r.minPrice)}</span>` : !r.ok ? `<span class="muted">${esc(r.err.join('；'))}</span>` : '<span class="tag g">✓</span>'}</td>
      </tr>`).join('')}</tbody></table>
      <div class="muted mt8">可入库 ${ok.length} 条 · 低价 ${invRows.filter(x => x.lowPrice).length} · 拦截 ${invRows.filter(x => x.blocked).length} · 未建档 ${invRows.filter(x => x.unmatched).length}</div>`
      : '<div class="empty">未识别到明细（检查票据文本格式或本地 OCR 服务）</div>';
    view.querySelector('#invApply').style.display = invRows.some(r => r.ok) ? '' : 'none';
    view.querySelector('#invOut').querySelectorAll('input[data-i]').forEach(inp => inp.onchange = () => {
      const r = invRows[+inp.dataset.i];
      r[inp.dataset.f] = Math.max(inp.dataset.f === 'qty' ? 1 : 0.01, Number(inp.value) || 0);
    });
  };
  view.querySelector('#invApply').onclick = async () => {
    const supplierId = Number(view.querySelector('#invSup').value);
    const d = await must(post('/ai/ocr-invoice', {
      supplierId,
      rows: invRows.filter(r => r.ok).map(r => ({ line: r.line, name: r.name, barcode: r.barcode, price: r.price, qty: r.qty })),
      apply: true, forceLowPrice: view.querySelector('#invForce').checked, autoCreate: true,
    }), '入库草稿已生成');
    view.querySelector('#invOut').innerHTML = `<div class="ok mt8">✅ 草稿 <b>${esc(d.inboundNo)}</b> 已生成（${d.createdCount} 条${d.blocked ? `，低价拦截 ${d.blocked} 条` : ''}），请到「进货入库」审核</div>`;
    view.querySelector('#invApply').style.display = 'none';
  };

  await tasks(); await samples(); await models();
}
