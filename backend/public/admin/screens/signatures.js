import { API, get, post, del, must, esc, dt, toast, imgUrl } from '../api.js';
import { confirmBox, bindPad as uiBindPad, padInk, clearPad as uiClearPad } from '../ui.js';
import { paginate, bindPager, pagerBar } from '../common-ui.js';

/** 授权管理：签字授权 + 设备授权统一入口，挂「系统」菜单
 *  V4.14.8 签字1~4：
 *   ① 采集时 AI 识别签名姓名 → 自动匹配供应商业务员（非供应商侧不关联），样本自动入库；
 *   ② 完整性甄别在服务端 attach（签名姓名须完整包含单据署名，张五/刘三类不符拒绝）；
 *   ③ 预采集须连续签 3 遍 → 形成签字画像（profile.images / sample_count）；
 *   ④ 样本表：单行「删除」按钮 + ID 前复选框列，支持批量删除/停用/启用。
 *  「调用记录」：signature-records 证据链（全业务类型），可按类型筛选。
 *  「授权设备」：收银机等设备白名单（待授权/已授权/已停用），仅管理员/老板端可审批。 */

const MIN_SAMPLES = 3;   // 画像最少采集次数

export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>🖊️ 签字授权（预采集） 
        <button class="btn sm pri" id="sgAdd" style="margin-left:12px">➕ 预采集签字</button></h3>
      <div class="doc-tip" style="margin:0 18px 10px">💡 采集时须连续签名 <b>${MIN_SAMPLES} 遍</b>形成签字画像（提升识别精度）；系统自动识别签名姓名并联动供应商业务员。现场补签（入库/退货等）也会自动采集进样本库。</div>
      <div class="bar" id="sgBatchBar" style="padding:0 18px 8px;display:none">
        <span class="muted" style="font-size:12.5px">已选 <b id="sgSelN">0</b> 项：</span>
        <button class="btn sm" data-ba="enable">启用</button>
        <button class="btn sm warn" data-ba="disable">停用</button>
        <button class="btn sm danger" data-ba="delete">🗑 删除</button>
      </div>
      <!-- V4.15.0：人员分类严格分栏（门店人员/供应商人员/大客户人员）——调用签字时按分类正确取用 -->
      <div class="bar" id="sgCatBar" style="padding:0 18px 6px">
        <span class="muted" style="font-size:12.5px">人员分类：</span>
        <span class="pill on" style="cursor:pointer" data-cat="">全部</span>
        <span class="pill g" style="cursor:pointer" data-cat="门店人员">🏪 门店人员</span>
        <span class="pill b" style="cursor:pointer" data-cat="供应商人员">🚚 供应商人员</span>
        <span class="pill o" style="cursor:pointer" data-cat="大客户人员">🤝 大客户人员</span>
        <span class="pill" style="cursor:pointer" data-cat="待确认">❓ 待确认</span>
      </div>
      <div class="bar" id="sgInvalidBar" style="padding:0 18px 8px;display:none">
        <span class="muted" style="font-size:12.5px">检测到 <b id="sgInvalidN">0</b> 张疑似无效样本（近空白/纯色块）：</span>
        <button class="btn sm danger" id="sgInvalidDel">🗑 删除疑似无效</button>
      </div>
      <div style="padding:0 18px 16px" id="sgList" class="tbl-min">加载中…</div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>🖥️ 授权设备 </h3>
      <div class="bar" style="padding:0 18px 8px">
        <select id="dvFilter" style="width:130px">
          <option value="">全部状态</option>
          <option>待授权</option>
          <option>已授权</option>
          <option>已停用</option>
        </select>
        <button class="btn sm" id="dvGo">查询</button>
        <span class="muted" style="font-size:12px">开启「收银机授权」开关后，新设备首次登录自动登记为待授权，管理员在此审批。</span>
      </div>
      <div style="padding:0 18px 16px" id="dvList" class="tbl-min">加载中…</div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>🗂 操作记录 </h3>
      <div class="bar" style="padding:0 18px 8px">
        <select id="sgBiz" style="width:170px">
          <option value="">全部类型</option>
          <option>inbound</option><option>return</option><option>order</option><option>loss</option>
          <option>count</option><option>transfer</option><option>对账确认</option>
          <option value="sample">样本编辑</option>
        </select>
        <button class="btn sm" id="sgGo">查询</button>
        <span class="muted" style="font-size:12px">入库=入库单签字 · return=退货单 · 对账确认=联营对账；图片点开可放大</span>
      </div>
      <div style="padding:0 18px 16px" id="sgRecList" class="tbl-min">加载中…</div>
    </div>

    <div class="modal-mask" id="sgModal" style="display:none">
      <div class="modal">
        <h3 id="sgModalTitle">✍️ 预采集签字（采集即授权用于日后业务单据 5.6.8）</h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label class="req">签字人姓名 <button class="btn mini" id="sgAI" title="用本地 AI 识别第 1 遍签名">🤖 AI 识别</button></label>
            <input id="sgName" placeholder="如：王业务（可手填或 AI 识别）"></div>
          <div class="fld"><label>身份备注</label><input id="sgRole" placeholder="业务员/店长（选填）"></div>
          <div class="fld" style="grid-column:1/3"><label>绑定供应商业务员（选填；按识别姓名自动匹配）</label>
            <select id="sgSupplier"><option value="">— 不绑定（通用样本） —</option></select></div>
        </div>
        <div class="doc-tip" id="sgTip">✍️ 请签名第 <b>1</b>/${MIN_SAMPLES} 遍（画像采集：每遍请完整书写姓名，笔画过少视为乱签）</div>
        <canvas id="sgPad" width="560" height="170" style="border:1px dashed var(--line);border-radius:8px;touch-action:none;cursor:crosshair"></canvas>
        <div class="bar" style="margin-top:8px">
          <button class="btn sm" id="sgClear">🧽 清除重签</button>
          <div id="sgShots" style="display:flex;gap:6px"></div>
        </div>
        <div class="doc-foot">
          <button class="btn" id="sgCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="sgSave">💾 保存样本</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="sgCatModal" style="display:none">
      <div class="modal" style="max-width:420px">
        <h3>🏷 改人员分类 <span class="api" id="sgCatWho"></span></h3>
        <div class="doc-tip" style="margin:0 0 10px">自动推断落了「待确认」的样本，请按实际身份纠正；纠正后按分类参与业务单据的自动带签。</div>
        <div class="fld"><label class="req">人员分类</label>
          <select id="sgCatSel">
            <option value="门店人员">🏪 门店人员（店员/店长/审核人）</option>
            <option value="供应商人员">🚚 供应商人员（业务员）</option>
            <option value="大客户人员">🤝 大客户人员（对账/确认）</option>
          </select></div>
        <div class="fld"><label>身份备注（选填）</label><input id="sgCatRole" placeholder="如：业务员 / 店长"></div>
        <div class="doc-foot">
          <button class="btn" id="sgCatCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="sgCatSave">💾 保存</button>
        </div>
      </div>
    </div>

    <!-- 样本图预览弹窗：行内只显示计数，点数字看签名图（节约行高空间） -->
    <div class="modal-mask" id="sgPrevModal" style="display:none">
      <div class="modal" style="max-width:680px">
        <h3 id="sgPrevTitle">🖼 签字样本预览</h3>
        <div id="sgPrevBody" style="display:flex;flex-wrap:wrap;gap:12px;padding:4px 0 12px"></div>
        <div class="doc-foot">
          <button class="btn" id="sgPrevClose">关闭</button>
        </div>
      </div>
    </div>

    <!-- 停用/删除原因弹窗（V4.17.0：操作留痕须带原因，如离职/调岗） -->
    <div class="modal-mask" id="sgReasonModal" style="display:none">
      <div class="modal" style="max-width:440px">
        <h3 id="sgReasonTitle">📝 操作原因</h3>
        <div class="doc-tip" style="margin:0 0 10px">停用/删除会写入<b>操作记录</b>留痕，请说明原因，便于日后追溯（该人员仍可重新预采集）。</div>
        <div class="fld"><label class="req">常用原因</label>
          <select id="sgReasonSel">
            <option>离职</option>
            <option>调岗</option>
            <option>换人（重新采集）</option>
            <option>清理无效样本</option>
            <option value="__other">其他（手动填写）</option>
          </select></div>
        <div class="fld" id="sgReasonOtherWrap" style="display:none"><label class="req">原因说明</label>
          <input id="sgReasonText" maxlength="64" placeholder="请填写原因（≤64字，如：长期休假由他人代签）"></div>
        <div class="doc-foot">
          <button class="btn" id="sgReasonCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="sgReasonOk">✅ 确认执行</button>
        </div>
      </div>
    </div>`;

  /* ── 签字板（统一走 ui.js；笔画统计用于 V4.14.8 乱签初筛） ── */
  const padState = { strokes: 0 };
  function clearPad(pad) { padState.strokes = 0; uiClearPad(pad); }
  const pad = view.querySelector('#sgPad');
  uiBindPad(pad, { onStroke: () => { padState.strokes++; } });

  /* ── 采集会话（≥3 遍画像；V4.17.0 支持「重采模式」整体替换某人的画像） ── */
  let shots = [];   // dataURL[]
  let resampleId = 0;   // >0 = 重采模式（替换该模板画像）
  const suppliersArr = [];   // {id,name,contact}
  function freshPad() { clearPad(pad); }
  function shotThumb() {
    const box = view.querySelector('#sgShots');
    box.innerHTML = shots.map((s, i) => `<img src="${esc(s)}" style="height:30px;border:1px solid var(--line);border-radius:5px;background:#fff">`).join('')
      + `<span class="muted" style="font-size:12px;align-self:center">${shots.length}/${MIN_SAMPLES}</span>`;
  }
  function nextRound() {
    const tip = view.querySelector('#sgTip');
    tip.innerHTML = shots.length >= MIN_SAMPLES
      ? `✅ 已采满 ${MIN_SAMPLES} 遍画像（继续签名可追加）`
      : `✍️ 请签名第 <b>${shots.length + 1}</b>/${MIN_SAMPLES} 遍（画像采集：每遍请完整书写姓名，笔画过少视为乱签）`;
  }
  function openRecapture(id, name) {
    resampleId = id;
    view.querySelector('#sgModalTitle').textContent = `🔁 重采签字画像 · ${name}（整体替换原样本，清理占位/乱签）`;
    view.querySelector('#sgName').value = name;
    view.querySelector('#sgName').readOnly = true;
    view.querySelector('#sgRole').value = '';
    view.querySelector('#sgSupplier').value = '';
    shots = []; shotThumb(); freshPad(); nextRound();
    view.querySelector('#sgModal').style.display = 'flex';
  }
  function openCollect() {
    resampleId = 0;
    view.querySelector('#sgModalTitle').textContent = '✍️ 预采集签字（采集即授权用于日后业务单据 5.6.8）';
    view.querySelector('#sgName').readOnly = false;
    view.querySelector('#sgName').value = '';
    view.querySelector('#sgRole').value = '';
    view.querySelector('#sgSupplier').value = '';
    shots = []; shotThumb(); freshPad(); nextRound();
    view.querySelector('#sgModal').style.display = 'flex';
  }

  view.querySelector('#sgAdd').onclick = openCollect;
  view.querySelector('#sgCancel').onclick = () => { view.querySelector('#sgModal').style.display = 'none'; resampleId = 0; };
  view.querySelector('#sgClear').onclick = () => { freshPad(); };

  // 签完一遍 → 「+ 记录本遍」按钮化：保存时逐遍校验。这里用「清除重签/保存」二段式：
  // 点保存：若 <3 遍 → 把当前板面记为一遍并清板继续；满 3 遍后点保存 → 提交全部。
  view.querySelector('#sgSave').onclick = async () => {
    const name = view.querySelector('#sgName').value.trim();
    const inkRatio = padInk(pad) / (pad.width * pad.height);
    if (padState.strokes < 2 || inkRatio < 0.001) {
      return toast('疑似乱签（笔画过少），请完整书写姓名后再记录', false);
    }
    if (inkRatio > 0.85) {
      return toast('疑似整块涂色（非签名笔迹），请清除后正常书写姓名', false);   // V4.17.0：纯色块占位拒绝入库
    }
    if (shots.length < MIN_SAMPLES) {
      shots.push(pad.toDataURL('image/png'));
      shotThumb(); freshPad(); nextRound();
      if (shots.length === 1 && !resampleId) tryReadName();   // 第一遍完成 → AI 识别姓名（重采模式姓名已定不再识别）
      if (shots.length < MIN_SAMPLES) return toast(`已记录第 ${shots.length} 遍，请继续签名（共 ${MIN_SAMPLES} 遍）`);
      return toast(`画像采集完成（${shots.length} 遍），再次点击「保存样本」提交`);
    }
    if (!name) return toast('签字人姓名必填（可点「🤖 AI 识别」）', false);
    shots.push(pad.toDataURL('image/png'));            // 满遍数后最后一块板面一并提交
    if (resampleId) {
      await must(post(`/purchase/signatures/${resampleId}/recapture`, { images: shots }), '重采完成，画像已整体替换');
    } else {
      const sup = Number(view.querySelector('#sgSupplier').value) || undefined;
      await must(post('/purchase/signatures', {
        personName: name, roleTitle: view.querySelector('#sgRole').value.trim() || undefined,
        images: shots, supplierId: sup,
      }), `签字样本已保存（画像 ${shots.length} 遍）`);
    }
    view.querySelector('#sgModal').style.display = 'none';
    resampleId = 0;
    await drawSigs();
  };

  /* ── AI 识别签名姓名 → 自动匹配供应商业务员（非供应商侧人工留空即可） ── */
  async function tryReadName() {
    const btn = view.querySelector('#sgAI');
    btn.disabled = true;
    try {
      const r = await must(post('/ai/signature/read', { image: shots[0] }));
      if (r.name) {
        view.querySelector('#sgName').value = r.name;
        toast(`AI 识别姓名：${r.name}（可修改）`);
        // 自动匹配供应商：contact_person 与识别名归一化一致 → 自动选中
        const hit = suppliersArr.find(s => (s.contact || '').replace(/[\s·.。/、,，-]/g, '') === r.name);
        if (hit) {
          view.querySelector('#sgSupplier').value = hit.id;
          if (!view.querySelector('#sgRole').value) view.querySelector('#sgRole').value = '业务员';
          toast(`已自动关联供应商：${hit.name}`);
        }
      } else toast(r.note || '未能辨认，请手工填写', false);
    } catch { /* AI 不可达静默：人工填写 */ }
    btn.disabled = false;
  }
  view.querySelector('#sgAI').onclick = () => {
    if (!shots.length) return toast('请先签名第 1 遍再识别', false);
    tryReadName();
  };

  // V5.0.3：书写停顿 1.8s 防抖自动识别——无需手动点「AI 识别」；识别结果填姓名框（可手改）；失败静默
  let sigRecT = null, sigRecBusy = false;
  pad.addEventListener('pointerup', () => {
    if (shots.length || resampleId) return;                   // 样本已记录/重采模式：不再自动识别
    if (view.querySelector('#sgName').value.trim()) return;   // 已有姓名（手填或已识别）：不覆盖
    clearTimeout(sigRecT);
    sigRecT = setTimeout(async () => {
      if (sigRecBusy) return;
      if (padState.strokes < 1 || padInk(pad) / (pad.width * pad.height) < 0.002) return;
      if (view.querySelector('#sgName').value.trim()) return;
      sigRecBusy = true;
      try {
        const r = await post('/ai/signature/read', { image: pad.toDataURL('image/png') });
        const nm = String((r?.data || r)?.name || '').trim();
        if (nm && !view.querySelector('#sgName').value.trim()) {
          view.querySelector('#sgName').value = nm;
          toast(`AI 识别姓名：${nm}（可修改）`, true);
        }
      } catch { /* 识别服务不可达：静默，仍可手动点「AI 识别」或手填 */ }
      sigRecBusy = false;
    }, 1800);
  });

  /* ── 签字样本表（复选框批量 + 单行删除 + 人员分类筛选；V4.16.5 分页 10 条/页） ── */
  let sgRows = [], sgCat = '', sgPage = 1, recPage = 1;   // 两表各自独立页码
  const sgRowById = {};   // id → {name, imgs[]}（点「样本数」弹窗预览用）
  view.querySelectorAll('[data-cat]').forEach(p => p.onclick = () => {
    sgCat = p.dataset.cat;
    view.querySelectorAll('[data-cat]').forEach(x => x.classList.toggle('on', x === p));
    sgPage = 1;
    drawSigs();
  });
  const catTag = c => ({ '门店人员': '<span class="tag g">🏪 门店人员</span>',
    '供应商人员': '<span class="tag b">🚚 供应商人员</span>',
    '大客户人员': '<span class="tag y">🤝 大客户人员</span>',
    '待确认': '<span class="tag" title="分类未定，请点「改分类」人工纠正">❓ 待确认</span>' }[c] || `<span class="tag">${esc(c || '—')}</span>`);
  async function drawSigs() {
    const d = await must(get('/purchase/signatures' + (sgCat ? `?cat=${encodeURIComponent(sgCat)}` : '')));
    sgRows = d.items;
    const pg = paginate(sgRows, sgPage, 10);
    sgPage = pg.page;
    const rows = pg.slice;
    const list = view.querySelector('#sgList');
    list.innerHTML = rows.length ? `
      <table><thead><tr>
        <th style="width:34px"><input type="checkbox" id="sgAll"></th>
        <th class="seq">序号</th><th>ID</th><th>签字人</th><th>人员分类</th><th>身份</th><th>供应商业务员</th><th>样本数</th><th>画像</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows.map((t, i) => {
        const profN = Math.max(Number(t.sample_count) || 1, (t.profile?.images || []).length);
        // 同一人员的全部签名照片路径（画像 3 遍；旧数据回落单图）——行内不摆图，点「样本数」弹窗预览
        const sigImgs = (t.profile?.images?.length ? t.profile.images : [t.image_path]).filter(Boolean);
        sgRowById[Number(t.id)] = { name: t.person_name, imgs: sigImgs };
        const n = sigImgs.length;
        return `<tr>
        <td><input type="checkbox" class="sg-chk" data-id="${t.id}"></td>
        <td class="num seq">${(sgPage - 1) * 10 + i + 1}</td><td>${t.id}</td><td>${esc(t.person_name)}</td><td>${catTag(t.person_cat)}${String(t.person_cat) === '待确认' ? ` <button class="btn mini" data-catfix="${t.id}" data-nm="${esc(t.person_name)}">改分类</button>` : ''}</td><td class="muted">${esc(t.role_title || '—')}</td>
        <td class="muted">${esc(t.supplier_name || (t.supplier_id ? '#' + t.supplier_id : '—'))}</td>
        <td style="text-align:center">${n > 0
          ? `<span data-prev="${t.id}" title="点击预览签字样本" style="cursor:pointer;color:#e03131;font-weight:700;text-decoration:underline;text-underline-offset:3px">${n}</span>`
          : `<span title="无样本图" style="color:inherit">0</span>`}</td>
        <td class="muted" title="画像采集遍数"><span data-prof="${t.id}">${profN >= MIN_SAMPLES ? `<span class="tag g">${profN} 遍</span>` : `<span class="tag y">${profN} 遍</span>`}</span></td>
        <td>${Number(t.status) === 1 ? '<span class="tag g">有效</span>' : '<span class="tag r">停用</span>'}</td>
        <td style="white-space:nowrap">
          ${Number(t.status) !== 1 ? `<button class="btn sm pri" data-resample="${t.id}" data-nm="${esc(t.person_name)}">重采</button>` : ''}
          <button class="btn sm ${Number(t.status) === 1 ? 'warn' : 'pri'}" data-sig="${t.id}" data-s="${t.status}">${Number(t.status) === 1 ? '停用' : '启用'}</button>
          <button class="btn sm danger" data-del="${t.id}" data-nm="${esc(t.person_name)}">删除</button></td>
      </tr>`; }).join('')}</tbody></table>${pg.bar}`
      : '<div class="empty">暂无签字样本（预采集后对账确认可免签）</div>';
    bindPager(list, p => { sgPage = p; drawSigs(); });
    syncBatchBar();
    const all = view.querySelector('#sgAll');
    if (all) {
      all.onchange = () => view.querySelectorAll('.sg-chk').forEach(c => { c.checked = all.checked; syncBatchBar(); });
      // V5.0.3：行勾选变化时同步表头全选框（部分取消 → 表头自动取消勾选，可再次全选/取消全选）
      view.querySelectorAll('.sg-chk').forEach(c => c.onchange = () => {
        all.checked = view.querySelectorAll('.sg-chk').length > 0 && [...view.querySelectorAll('.sg-chk')].every(x => x.checked);
        syncBatchBar();
      });
    }
    view.querySelectorAll('[data-sig]').forEach(b => b.onclick = async () => {
      const toStatus = Number(b.dataset.s) === 1 ? 0 : 1;
      const id = Number(b.dataset.sig);
      if (toStatus === 1) {   // 启用：无需原因
        await must(post(`/purchase/signatures/${id}/status`, { status: 1 }), '已启用');
        return drawSigs();
      }
      // 停用：须说明原因（离职/调岗等，写入操作记录）
      openReason({ title: '📝 停用签字样本', okText: '⏸ 确认停用', run: async reason => {
        await must(post(`/purchase/signatures/${id}/status`, { status: 0, reason }), '已停用并留痕');
        await drawSigs();
      } });
    });
    view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const id = Number(b.dataset.del);
      openReason({ title: `🗑 删除签字样本 · ${b.dataset.nm}`, okText: '🗑 确认删除', run: async reason => {
        await must(post(`/purchase/signatures/batch`, { ids: [id], action: 'delete', reason }), '已删除并留痕');
        sgInvalidIds.delete(id); syncInvalidBar();
        await drawSigs();
      } });
    });
    // V4.17.0 P13②：改分类（自动推断落「待确认」的纠错入口）
    view.querySelectorAll('[data-catfix]').forEach(b => b.onclick = () => openCatFix(Number(b.dataset.catfix), b.dataset.nm));
    // V4.17.0 P13④：重采（整体替换画像，清理占位/乱签主通道）
    view.querySelectorAll('[data-resample]').forEach(b => b.onclick = () => openRecapture(Number(b.dataset.resample), b.dataset.nm));
    // 样本数点击 → 弹窗预览签名图（行内不摆图）
    view.querySelectorAll('[data-prev]').forEach(s => s.onclick = () => openPrev(Number(s.dataset.prev)));
    // V4.17.0 P13④：存量样本无效检测（近空白/纯色块双阈值，canvas 逐张分析打标）
    analyzeInvalid(rows);
  }
  /* ── 无效样本检测：墨量 <0.3% 疑似空白 / >85% 疑似纯色块，打标不自动删 ── */
  const sgInvalidIds = new Set();   // 疑似无效样本的模板 id（跨页累积）
  const INK_MIN = 0.003, INK_MAX = 0.85;
  function inkRatioOfUrl(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';   // 跨域（8088→3100）取图避免 canvas 污染，依赖后端 CORS 放开
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          const w = cv.width = Math.min(img.naturalWidth || 300, 480);
          const h = cv.height = Math.min(img.naturalHeight || 100, 200);
          const cx2 = cv.getContext('2d', { willReadFrequently: true });
          cx2.fillStyle = '#fff'; cx2.fillRect(0, 0, w, h);   // 透底 PNG 补白底再比墨
          cx2.drawImage(img, 0, 0, w, h);
          const d = cx2.getImageData(0, 0, w, h).data;
          let ink = 0, total = w * h;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 40) continue;                       // 透明 → 非墨
            if (d[i] + d[i + 1] + d[i + 2] < 620) ink++;       // 深色像素 = 笔迹
          }
          resolve(ink / total);
        } catch { resolve(-1); }
      };
      img.onerror = () => resolve(-1);
      img.src = url;
    });
  }
  async function analyzeInvalid(rows) {
    for (const t of rows) {
      const imgs = (t.profile?.images?.length ? t.profile.images : [t.image_path]).filter(Boolean);
      if (!imgs.length) continue;
      let bad = 0;
      for (const p of imgs) {
        const r = await inkRatioOfUrl(imgUrl(p));   // V4.28.5 F-09：/uploads 鉴权后带 token
        if (r >= 0 && (r < INK_MIN || r > INK_MAX)) bad++;
      }
      if (bad) {
        sgInvalidIds.add(Number(t.id));
        const cell = view.querySelector(`[data-prof="${t.id}"]`);
        if (cell) cell.insertAdjacentHTML('beforeend', ` <span class="tag r" title="${bad}/${imgs.length} 张近空白或纯色块">⚠ 疑似无效 ${bad}/${imgs.length}</span>`);
      }
    }
    syncInvalidBar();
  }
  function syncInvalidBar() {
    const n = sgInvalidIds.size;
    view.querySelector('#sgInvalidBar').style.display = n ? 'flex' : 'none';
    view.querySelector('#sgInvalidN').textContent = String(n);
  }
  view.querySelector('#sgInvalidDel').onclick = () => {
    const ids = [...sgInvalidIds];
    if (!ids.length) return;
    openReason({ title: `🗑 删除疑似无效样本（${ids.length} 个）`, okText: '🗑 确认删除', run: async reason => {
      await must(post('/purchase/signatures/batch', { ids, action: 'delete', reason }), '已删除并留痕');
      sgInvalidIds.clear(); syncInvalidBar();
      await drawSigs();
    } });
  };

  /* ── 停用/删除原因弹窗（V4.17.0：操作留痕必须带原因） ── */
  let reasonPending = null;
  function openReason({ title, okText, run }) {
    reasonPending = { run };
    view.querySelector('#sgReasonTitle').textContent = title || '📝 操作原因';
    view.querySelector('#sgReasonOk').textContent = okText || '✅ 确认执行';
    view.querySelector('#sgReasonSel').value = '离职';
    view.querySelector('#sgReasonText').value = '';
    view.querySelector('#sgReasonOtherWrap').style.display = 'none';
    view.querySelector('#sgReasonModal').style.display = 'flex';
  }
  view.querySelector('#sgReasonSel').onchange = e => {
    view.querySelector('#sgReasonOtherWrap').style.display = e.target.value === '__other' ? 'block' : 'none';
  };
  view.querySelector('#sgReasonCancel').onclick = () => { view.querySelector('#sgReasonModal').style.display = 'none'; reasonPending = null; };
  view.querySelector('#sgReasonOk').onclick = async () => {
    if (!reasonPending) return;
    const sel = view.querySelector('#sgReasonSel').value;
    const other = view.querySelector('#sgReasonText').value.trim();
    const reason = sel === '__other' ? other : sel;
    if (!reason) return toast('请说明原因（选常用项或手动填写）', false);
    view.querySelector('#sgReasonModal').style.display = 'none';
    const run = reasonPending.run; reasonPending = null;
    await run(reason);
  };

  /* ── 样本图预览弹窗（点行内「样本数」打开；图可再点放大） ── */
  function zoomImg(url) {
    const lb = document.createElement('div');
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out';
    lb.innerHTML = `<img src="${esc(url)}" style="max-width:80vw;max-height:80vh;min-width:min(72vw,560px);background:#fff;border-radius:10px;padding:10px;object-fit:contain">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  }
  function openPrev(id) {
    const row = sgRowById[id];
    if (!row || !row.imgs.length) return;
    view.querySelector('#sgPrevTitle').textContent = `🖼 签字样本预览 · ${row.name}（${row.imgs.length} 张，点图放大）`;
    view.querySelector('#sgPrevBody').innerHTML = row.imgs.map(p =>
      `<img data-zoom="${esc(imgUrl(p))}" src="${esc(imgUrl(p))}" style="height:110px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:zoom-in">`).join('');
    view.querySelector('#sgPrevBody').querySelectorAll('[data-zoom]').forEach(img => img.onclick = () => zoomImg(img.dataset.zoom));
    view.querySelector('#sgPrevModal').style.display = 'flex';
  }
  view.querySelector('#sgPrevClose').onclick = () => { view.querySelector('#sgPrevModal').style.display = 'none'; };

  /* ── 改分类弹窗 ── */
  let catfixId = 0;
  function openCatFix(id, name) {
    catfixId = id;
    view.querySelector('#sgCatWho').textContent = name || '';
    view.querySelector('#sgCatSel').value = '门店人员';
    view.querySelector('#sgCatRole').value = '';
    view.querySelector('#sgCatModal').style.display = 'flex';
  }
  view.querySelector('#sgCatCancel').onclick = () => { view.querySelector('#sgCatModal').style.display = 'none'; catfixId = 0; };
  view.querySelector('#sgCatSave').onclick = async () => {
    if (!catfixId) return;
    await must(post(`/purchase/signatures/${catfixId}/cat`, {
      personCat: view.querySelector('#sgCatSel').value,
      roleTitle: view.querySelector('#sgCatRole').value.trim() || undefined,
    }), '人员分类已更新');
    view.querySelector('#sgCatModal').style.display = 'none';
    catfixId = 0;
    await drawSigs();
  };
  function selIds() { return [...view.querySelectorAll('.sg-chk:checked')].map(c => Number(c.dataset.id)); }
  function syncBatchBar() {
    const n = selIds().length;
    view.querySelector('#sgBatchBar').style.display = n ? 'flex' : 'none';
    view.querySelector('#sgSelN').textContent = String(n);
  }
  view.querySelectorAll('[data-ba]').forEach(b => b.onclick = async () => {
    const ids = selIds();
    if (!ids.length) return toast('请先勾选签字样本', false);
    const act = b.dataset.ba;
    // 停用/删除须说明原因（V4.17.0：写入操作记录留痕）；启用直接执行
    if (act === 'disable' || act === 'delete') {
      openReason({
        title: act === 'delete' ? `🗑 批量删除签字样本（${ids.length} 个）` : `⏸ 批量停用签字样本（${ids.length} 个）`,
        okText: act === 'delete' ? '🗑 确认删除' : '⏸ 确认停用',
        run: async reason => {
          await must(post('/purchase/signatures/batch', { ids, action: act, reason }), '已更新并留痕');
          if (act === 'delete') { ids.forEach(i => sgInvalidIds.delete(i)); syncInvalidBar(); }
          await drawSigs();
        },
      });
      return;
    }
    await must(post('/purchase/signatures/batch', { ids, action: act }), '已更新');
    await drawSigs();
  });

  // 绑定供应商业务员（采集弹窗下拉 + AI 自动匹配数据源）
  try {
    const d = await must(get('/purchase/suppliers'));
    const arr = Array.isArray(d) ? d : (d.items || []);
    suppliersArr.push(...arr.map(s => ({ id: s.id, name: s.name, contact: s.contact_person || '' })));
    view.querySelector('#sgSupplier').innerHTML = '<option value="">— 不绑定（通用样本） —</option>' +
      arr.map(s => `<option value="${s.id}">${esc(s.name)}${s.contact_person ? `（业务员：${esc(s.contact_person)}）` : ''}</option>`).join('');
  } catch { /* 供应商加载失败不阻塞 */ }

  /* ── 调用记录（全业务类型；V4.16.5 分页 10 条/页） ── */
  async function drawRecs() {
    const biz = encodeURIComponent(view.querySelector('#sgBiz').value || '');
    const d = await must(get(`/purchase/signature-records?bizType=${biz}`));
    const pg = paginate(d.items, recPage, 10);
    recPage = pg.page;
    const rows = pg.slice;
    // V4.25.1：操作记录分页条改为跟随容器，不再 sticky 浮动在视口底部
    const bar = pagerBar({ page: pg.page, pages: pg.pages, total: pg.total, size: 10, sticky: false });
    const list = view.querySelector('#sgRecList');
    list.innerHTML = rows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>ID</th><th>类型</th><th class="num">业务ID</th><th>签字人</th><th>角色</th><th>场景</th><th>操作人</th><th>样本</th><th>备注</th><th>时间</th></tr></thead>
      <tbody>${rows.map((r, i) => {
        // V4.17.0：样本编辑行（scene 以「编辑」开头）角色显示「管理」；其余维持 操作员/业务员
        const isEdit = String(r.scene || '').startsWith('编辑');
        const role = r.role_label
          || (isEdit ? '管理'
            : ((r.scene === '操作员签名' || String(r.person_name || '') === String(r.operator_name || '')) ? '操作员' : '业务员'));
        return `<tr>
        <td class="num seq">${(recPage - 1) * 10 + i + 1}</td><td>${r.id}</td><td class="muted">${isEdit ? '样本编辑' : esc(r.biz_type)}</td><td class="num">${r.biz_id}</td>
        <td>${esc(r.person_name || '—')}</td>
        <td><span class="tag ${isEdit ? 'y' : (role === '操作员' ? 'b' : 'g')}">${role}</span></td>
        <td><span class="tag ${r.scene === '调用' ? 'b' : 'y'}">${esc(r.scene)}</span></td>
        <td>${esc(r.used_by_name || '—')}</td>
        <td>${r.image_path ? `<img data-sgimg="${esc(imgUrl(r.image_path))}" src="${esc(imgUrl(r.image_path))}" style="height:30px;border:1px solid var(--line);border-radius:5px;background:#fff;cursor:zoom-in" onerror="this.style.display='none'">` : '—'}</td>
        <td class="muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.note || '')}">${esc(r.note || '—')}</td>
        <td>${dt(r.used_at)}</td></tr>`;
      }).join('')}</tbody></table>${bar}`
      : '<div class="empty">暂无调用记录</div>';
    bindPager(list, p => { recPage = p; drawRecs(); });
    view.querySelectorAll('[data-sgimg]').forEach(img => img.onclick = () => zoomImg(img.dataset.sgimg));
  }
  view.querySelector('#sgGo').onclick = () => { recPage = 1; drawRecs(); };
  view.querySelector('#sgBiz').onchange = () => { recPage = 1; drawRecs(); };

  /* ── 授权设备（V4.25.1：收银机/浏览器端白名单，仅管理员可审批/操作） ── */
  const perms = API.user?.perms || [];
  const canApprove = perms.includes('*') || perms.includes('sys.settings');
  async function drawDevices() {
    const status = encodeURIComponent(view.querySelector('#dvFilter').value || '');
    const list = view.querySelector('#dvList');
    try {
      const rows = await must(get(`/pos-devices?status=${status}`));
      if (!Array.isArray(rows) || !rows.length) {
        list.innerHTML = '<div class="empty">暂无设备登记。开启「收银机授权」开关后，新设备首次登录会自动登记为「待授权」。</div>';
        return;
      }
      const stColor = s => s === '待授权' ? '#b5544a' : (s === '已授权' ? 'var(--pri,#20663f)' : '#8a8577');
      list.innerHTML = `<table><thead><tr><th>设备码</th><th>名称</th><th>状态</th><th>最后活跃</th><th>操作</th></tr></thead>
        <tbody>${rows.map(d => `<tr>
          <td style="font-family:Consolas,monospace;font-size:12px">${esc(d.deviceCode)}</td>
          <td>${esc(d.deviceName || '—')}</td>
          <td><b style="color:${stColor(d.status)}">${esc(d.status)}</b></td>
          <td class="muted">${d.lastSeenAt ? dt(d.lastSeenAt) : '—'}${d.lastIp ? ' · ' + esc(d.lastIp) : ''}</td>
          <td style="white-space:nowrap">
            ${canApprove && d.status === '待授权' ? `<button class="btn sm pri" data-dvok="${d.id}" data-name="${esc(d.deviceName || '')}">✓ 授权</button> ` : ''}
            ${canApprove && d.status === '已停用'
              ? `<button class="btn sm" data-dvstatus="${d.id}" data-st="已授权">启用</button> `
              : (canApprove ? `<button class="btn sm warn" data-dvstatus="${d.id}" data-st="已停用">停用授权</button> ` : '')}
            ${canApprove ? `<button class="btn sm" data-dvrename="${d.id}" data-name="${esc(d.deviceName || '')}">命名</button> ` : ''}
            ${canApprove ? `<button class="btn sm danger" data-dvdel="${d.id}">删除</button>` : ''}
          </td>
        </tr>`).join('')}</tbody></table>
        <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5">
          说明：浏览器拿不到 MAC 地址（且 MAC 可伪造），所以用<b>设备码 + 浏览器指纹</b>做白名单。
          删除或停用后，该设备再登录会重新登记为「待授权」。
          ${canApprove ? '' : '<span style="color:#b5544a">仅超级管理员/老板端可审批或管理设备授权。</span>'}
        </div>`;
      if (canApprove) {
        list.querySelectorAll('[data-dvok]').forEach(b => b.onclick = async () => {
          const name = prompt('设备名称（如：1号收银机）', b.dataset.name || '') ?? '';
          try { await must(post(`/pos-devices/${b.dataset.dvok}/approve`, { name })); toast('已授权通过'); drawDevices(); } catch { /* must 已 toast */ }
        });
        list.querySelectorAll('[data-dvrename]').forEach(b => b.onclick = async () => {
          const name = prompt('设备名称（如：1号收银机）', b.dataset.name || '');
          if (name === null) return;
          try { await must(post(`/pos-devices/${b.dataset.dvrename}/approve`, { name })); toast('已保存名称'); drawDevices(); } catch { /* must 已 toast */ }
        });
        list.querySelectorAll('[data-dvstatus]').forEach(b => b.onclick = async () => {
          try { await must(post(`/pos-devices/${b.dataset.dvstatus}/status`, { status: b.dataset.st })); toast(b.dataset.st === '已停用' ? '已停用授权' : '已启用授权'); drawDevices(); } catch { /* must 已 toast */ }
        });
        list.querySelectorAll('[data-dvdel]').forEach(b => b.onclick = async () => {
          if (!confirm('删除该设备登记？删除后该设备再登录会重新登记为待授权。')) return;
          try { await must(del(`/pos-devices/${b.dataset.dvdel}`)); toast('已删除'); drawDevices(); } catch { /* must 已 toast */ }
        });
      }
    } catch (e) {
      list.innerHTML = `<div class="empty">设备列表加载失败：${esc(e?.msg || e?.message || '')}</div>`;
    }
  }
  view.querySelector('#dvGo').onclick = () => drawDevices();
  view.querySelector('#dvFilter').onchange = () => drawDevices();

  await drawSigs(); await drawDevices(); await drawRecs();
}
