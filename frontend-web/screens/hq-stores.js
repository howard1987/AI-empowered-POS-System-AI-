/**
 * V5.0.0 连锁改造 · 批次2 · 门店管理（总部专属，M2-4）
 *
 * 功能：门店列表（编码/名称/组织/区域/状态/店长/员工数/节点/最近同步）
 *      新建门店（服务端自动初始化门店内置角色）
 *      编辑 / 启停闭店 / 一键建店长账号 / 重建内置角色 / 查看门店员工
 *
 * UI：沿用后台统一表格规范（.card + .doc-head + table + 分页条 + .pg-host），
 *     仅供总部账号可见（菜单 hqOnly + 服务端 hq.store.* 权限点 + data_scope 三重）。
 */
import { get, post, put, must, esc, toast, dt } from '../api.js';
import { openDetailModal, paginate, bindPager, pagerBar } from '../common-ui.js';
import { confirmBox } from '../ui.js';

const PAGE_SIZE = 15;

const STATUS_TXT = { 1: ['营业中', 'ok'], 0: ['已停业', 'warn'], 2: ['已闭店', 'off'] };
const ORG_TXT = { hq: ['🏢 总部', '#7a4fd0'], region: ['🗺️ 区域', '#3a7bd5'], store: ['🏪 门店', '#1e8e4e'] };

const statusTag = s => {
  const [t, k] = STATUS_TXT[Number(s)] || ['未知', 'off'];
  const color = k === 'ok' ? '#1e8e4e' : k === 'warn' ? '#c47f00' : '#8a8577';
  return `<span style="color:${color};font-weight:600">${t}</span>`;
};
const orgTag = t => {
  const [txt, color] = ORG_TXT[t] || ['门店', '#1e8e4e'];
  return `<span style="color:${color}">${txt}</span>`;
};

export async function render(view) {
  let rows = [];
  let total = 0;
  let page = 1;
  let summary = {};
  const q = { keyword: '', status: '', orgType: '', region: '' };

  view.innerHTML = `
    <style>
      #hsList table td{text-align:center}
      #hsList table th{text-align:center}
      #hsList table td.l{text-align:left}
      .hs-node{font-family:var(--mono,monospace);font-size:11.5px;color:var(--ink-3)}
      .hs-sync-off{color:#b23b2e}
    </style>

    <div class="card" style="display:flex;flex-direction:column;height:calc(100dvh - 230px);min-height:520px">
      <div class="doc-head" style="grid-template-columns:1.3fr 0.9fr 0.9fr 0.9fr auto;align-items:end">
        <div class="fld"><label>门店</label><input id="hsKw" placeholder="名称 / 编码 / 地址 / 区域"></div>
        <div class="fld"><label>状态</label><select id="hsStatus">
          <option value="">全部</option><option value="1">营业中</option>
          <option value="0">已停业</option><option value="2">已闭店</option></select></div>
        <div class="fld"><label>组织类型</label><select id="hsOrg">
          <option value="">全部</option><option value="store">门店</option>
          <option value="region">区域</option><option value="hq">总部</option></select></div>
        <div class="fld"><label>区域</label><select id="hsRegion"><option value="">全部</option></select></div>
        <div class="fld"><label>&nbsp;</label><span style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn pri" id="hsSearch">🔍 查询</button>
          <button class="btn" id="hsRefresh">刷新</button>
          <button class="btn pri" id="hsNew">➕ 新建门店</button>
        </span></div>
      </div>
      <div class="muted" style="padding:4px 18px 0;font-size:11.5px">
        新建门店会自动初始化「店长 / 收银员 / 库管 / 财务」四个门店角色（权限点从总部模板克隆，<b>不含总部权限</b>）。
        双击行查看门店详情与员工。
      </div>
      <div style="padding:10px 18px 4px;flex:1;min-height:0;overflow:auto" id="hsList" class="tbl-min"></div>
      <div class="doc-foot">
        <span class="muted" id="hsCount"></span>
        <span style="display:flex;gap:6px;align-items:center" id="hsPager"></span>
        <span class="sum" id="hsSum"></span>
      </div>
    </div>

    <div class="modal-mask" id="hsModal" style="display:none">
      <div class="modal" style="width:min(680px,94vw)">
        <h3 id="hsModalTitle">➕ 新建门店</h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label>门店名称 <span style="color:#c0392b">*</span></label>
            <input id="hsName" maxlength="64" placeholder="如：乐美鲜祥成家园店"></div>
          <div class="fld"><label>门店编码</label>
            <input id="hsNo" maxlength="16" placeholder="留空自动生成 S001"></div>
          <div class="fld"><label>组织类型</label>
            <select id="hsOrgType"><option value="store">门店</option><option value="region">区域</option></select></div>
          <div class="fld"><label>经营方式</label>
            <select id="hsFranchise"><option>直营</option><option>加盟</option></select></div>
          <div class="fld"><label>区域</label><input id="hsRegionIn" maxlength="32" placeholder="如：川东片区"></div>
          <div class="fld"><label>开业日期</label><input id="hsOpen" type="date"></div>
          <div class="fld"><label>联系电话</label><input id="hsPhone" maxlength="20"></div>
          <div class="fld"><label>营业时间</label><input id="hsHours" maxlength="64" placeholder="07:30-22:00"></div>
          <div class="fld" style="grid-column:1/-1"><label>地址</label><input id="hsAddr" maxlength="128"></div>
          <div class="fld" style="grid-column:1/-1"><label>备注</label><input id="hsRemark" maxlength="128"></div>
        </div>
        <div class="muted" style="margin-top:10px;font-size:12px" id="hsModalTip">
          保存后系统将自动创建该店的「店长/收银员/库管/财务」角色。建议紧接着用「店长账号」为该店开通登录账号。
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button class="btn" id="hsCancel">取消</button>
          <button class="btn pri" id="hsSave">💾 保存</button>
        </div>
      </div>
    </div>`;

  const $ = s => view.querySelector(s);

  // ── 区域下拉 ──
  async function loadRegions() {
    try {
      const r = await get('/hq/stores/meta/regions');
      const items = r?.data?.items || [];
      const sel = $('#hsRegion');
      sel.innerHTML = '<option value="">全部</option>' + items.map(x => `<option>${esc(x)}</option>`).join('');
    } catch { /* 忽略 */ }
  }

  // ── 列表 ──
  async function load() {
    const p = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) });
    if (q.keyword) p.set('keyword', q.keyword);
    if (q.status !== '') p.set('status', String(q.status));
    if (q.orgType) p.set('orgType', q.orgType);
    if (q.region) p.set('region', q.region);
    try {
      const r = await must(get('/hq/stores?' + p.toString()));
      rows = r.items || [];
      total = Number(r.total || 0);
      summary = r.summary || {};
    } catch { rows = []; total = 0; summary = {}; }
    draw();
  }

  function draw() {
    const host = $('#hsList');
    if (!rows.length) {
      host.innerHTML = '<div class="empty">没有符合条件的门店</div>';
      $('#hsPager').innerHTML = '';
      $('#hsCount').textContent = '';
      $('#hsSum').innerHTML = '';
      return;
    }
    const isHqRow = r => r.org_type === 'hq';
    host.innerHTML = `<table><thead><tr>
      <th style="width:78px">编码</th><th style="width:150px">门店名称</th><th style="width:74px">组织</th>
      <th style="width:84px">区域</th><th style="width:76px">状态</th><th style="width:86px">店长</th>
      <th style="width:66px">员工</th><th style="width:80px">门店特价</th>
      <th style="width:118px">同步节点</th><th style="width:112px">最近同步</th>
      <th style="width:210px">操作</th></tr></thead>
    <tbody>${paginate(rows, 1, PAGE_SIZE).slice.map(r => {
      const hq = isHqRow(r);
      return `<tr data-id="${r.id}" style="cursor:pointer" title="双击查看门店详情">
      <td class="mono">${esc(r.store_no || '—')}</td>
      <td class="l" style="font-weight:600">${hq ? '🏢 ' : ''}${esc(r.name || '')}
        ${r.franchise === '加盟' ? '<span class="muted" style="font-size:11px">（加盟）</span>' : ''}</td>
      <td>${orgTag(r.org_type)}</td>
      <td>${esc(r.region || '—')}</td>
      <td>${hq ? '—' : statusTag(r.status)}</td>
      <td>${esc(r.mgrName || '—')}</td>
      <td class="num">${Number(r.empCount || 0)}</td>
      <td class="num">${Number(r.storePriceCount || 0) > 0 ? `<span style="color:#c47f00;font-weight:600">${Number(r.storePriceCount)}</span>` : '0'}</td>
      <td><span class="hs-node ${r.sync_enabled ? '' : 'hs-sync-off'}">${esc(r.node_code || '—')}</span></td>
      <td class="muted">${r.last_sync_at ? dt(r.last_sync_at).slice(5, 16) : '—'}</td>
      <td style="white-space:nowrap">
        <button class="btn sm" data-edit="${r.id}">编辑</button>
        <button class="btn sm" data-mgr="${r.id}" title="为该店创建/重置店长登录账号">店长账号</button>
        ${hq ? '' : `<button class="btn sm" data-role="${r.id}" title="按总部模板重建该店内置角色">重建角色</button>
        <button class="btn sm ${Number(r.status) === 1 ? 'warn' : ''}" data-st="${r.id}">${Number(r.status) === 1 ? '停业/闭店' : '恢复营业'}</button>`}
      </td></tr>`;
    }).join('')}</tbody></table>`;

    $('#hsCount').textContent = `共 ${total} 个门店`;
    $('#hsSum').innerHTML = `营业 <b>${Number(summary.openStores || 0)}</b> 家 · 停业/闭店 <b>${Number(summary.closedStores || 0)}</b> 家`;
    const pg = paginate(rows, 1, PAGE_SIZE);
    $('#hsPager').innerHTML = pagerBar({ page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, size: PAGE_SIZE, unit: '家' });
    bindPager($('#hsPager'), p => { page = p; load(); });

    host.querySelectorAll('[data-id]').forEach(tr => tr.ondblclick = () => openDetail(Number(tr.dataset.id)));
    host.querySelectorAll('[data-edit]').forEach(b => b.onclick = e => { e.stopPropagation(); openEdit(Number(b.dataset.edit)); });
    host.querySelectorAll('[data-mgr]').forEach(b => b.onclick = e => { e.stopPropagation(); openMgr(Number(b.dataset.mgr)); });
    host.querySelectorAll('[data-role]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const id = Number(b.dataset.role);
      const ok = await confirmBox({
        title: '重建门店内置角色',
        html: '<div style="font-size:13px;line-height:1.8">将按<b>总部模板</b>补齐该店的「店长/收银员/库管/财务」角色权限（<b>只补不删</b>，不会回收你手工勾选的权限）。<br>用于：总部调整过模板、或该店角色缺失时。</div>',
        okText: '确认重建',
      });
      if (!ok) return;
      try {
        const r = await must(post(`/hq/stores/${id}/roles/reset`, {}));
        toast(`✅ 已重建角色 ${r.roles} 个、补齐权限点 ${r.perms} 项`);
        await load();
      } catch { /* must 已提示 */ }
    });
    host.querySelectorAll('[data-st]').forEach(b => b.onclick = e => { e.stopPropagation(); openStatus(Number(b.dataset.st)); });
  }

  // ── 详情 ──
  async function openDetail(id) {
    try {
      const d = (await get('/hq/stores/' + id)).data;
      const emps = (await get(`/hq/stores/${id}/employees`)).data || [];
      const roles = (d.roles || []).map(r =>
        `<span class="tag" style="margin:2px 4px 2px 0">${esc(r.name)} <span class="muted">${r.permCount}点</span></span>`).join('') || '<span class="muted">未初始化</span>';
      const empHtml = emps.length ? `<table style="margin-top:6px"><thead><tr>
          <th>工号</th><th>姓名</th><th>状态</th><th>角色</th><th>最近登录</th></tr></thead>
        <tbody>${emps.map(e => `<tr>
          <td class="mono">${esc(e.empNo)}</td><td>${esc(e.name)}</td>
          <td>${esc(e.status)}</td>
          <td>${(e.roles || []).map(r => esc(r.name)).join('、') || '—'}</td>
          <td class="muted">${e.lastLoginAt ? dt(e.lastLoginAt) : '—'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="muted" style="padding:8px 0">该门店暂无员工，请先用「店长账号」开通登录账号</div>';
      openDetailModal(`🏪 ${esc(d.name)}`, `
        <div class="muted" style="font-size:12.5px;line-height:2;margin-bottom:8px">
          编码：<b>${esc(d.store_no || '—')}</b> · 组织：${orgTag(d.org_type)} · 状态：${statusTag(d.status)} ·
          区域：${esc(d.region || '—')} · 经营：${esc(d.franchise || '直营')}<br>
          地址：${esc(d.address || '—')} · 电话：${esc(d.phone || '—')} · 营业时间：${esc(d.business_hours || '—')}<br>
          节点：<span class="hs-node">${esc(d.node_code || '—')}</span> · 同步：${d.sync_enabled ? '已启用' : '<span style="color:#b23b2e">已停用</span>'} · 最近同步：${d.last_sync_at ? dt(d.last_sync_at) : '—'}<br>
          备注：${esc(d.remark || '—')}
        </div>
        <h4 style="margin:14px 0 4px">内置角色</h4><div>${roles}</div>
        <h4 style="margin:14px 0 4px">门店员工（${emps.length}）</h4>${empHtml}`,
        { width: 820 });
    } catch { /* must/get 已提示 */ }
  }

  // ── 新建 / 编辑 ──
  let editId = 0;
  function openEdit(id = 0) {
    editId = id;
    const r = id ? rows.find(x => Number(x.id) === id) : null;
    $('#hsModalTitle').textContent = id ? `✏️ 编辑门店 · ${r?.name || ''}` : '➕ 新建门店';
    $('#hsName').value = r?.name || '';
    $('#hsNo').value = r?.store_no || '';
    $('#hsNo').disabled = !!id;
    $('#hsOrgType').value = r?.org_type === 'hq' ? 'store' : (r?.org_type || 'store');
    $('#hsOrgType').disabled = !!id;
    $('#hsFranchise').value = r?.franchise || '直营';
    $('#hsRegionIn').value = r?.region || '';
    $('#hsOpen').value = r?.open_date ? String(r.open_date).slice(0, 10) : '';
    $('#hsPhone').value = r?.phone || '';
    $('#hsHours').value = r?.businessHours || '07:30-22:00';
    $('#hsAddr').value = r?.address || '';
    $('#hsRemark').value = r?.remark || '';
    $('#hsModalTip').textContent = id
      ? '编辑不会影响该店已有角色与员工。'
      : '保存后系统将自动创建该店的「店长/收银员/库管/财务」角色。建议紧接着用「店长账号」为该店开通登录账号。';
    $('#hsModal').style.display = '';
  }
  const closeModal = () => { $('#hsModal').style.display = 'none'; };
  $('#hsCancel').onclick = closeModal;
  $('#hsModal').onclick = e => { if (e.target === $('#hsModal')) closeModal(); };

  $('#hsSave').onclick = async () => {
    const body = {
      name: $('#hsName').value.trim(),
      storeNo: $('#hsNo').value.trim() || undefined,
      orgType: $('#hsOrgType').value,
      franchise: $('#hsFranchise').value,
      region: $('#hsRegionIn').value.trim() || '',
      openDate: $('#hsOpen').value || undefined,
      phone: $('#hsPhone').value.trim(),
      businessHours: $('#hsHours').value.trim(),
      address: $('#hsAddr').value.trim(),
      remark: $('#hsRemark').value.trim(),
    };
    if (!body.name) return toast('门店名称必填', false);
    try {
      if (editId) {
        await must(put('/hq/stores/' + editId, body));
        toast('✅ 门店已更新');
      } else {
        const r = await must(post('/hq/stores', body));
        toast(`✅ 门店 ${r.storeNo} 已创建，已初始化 ${r.roles} 个内置角色`);
      }
      closeModal();
      await loadRegions();
      await load();
    } catch { /* must 已提示 */ }
  };

  // ── 店长账号 ──
  function openMgr(id) {
    const r = rows.find(x => Number(x.id) === id);
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="width:min(460px,94vw)">
      <h3>👤 门店店长账号 · ${esc(r?.name || '')}</h3>
      <div class="muted" style="font-size:12px;margin:6px 0 10px">
        为该门店创建（或重置）一个绑定「店长」角色的登录账号。工号全局唯一，不会重复建号。
      </div>
      <div class="fld"><label>工号 <span style="color:#c0392b">*</span></label><input id="hgNo" maxlength="32" placeholder="如 S001-01"></div>
      <div class="fld"><label>姓名 <span style="color:#c0392b">*</span></label><input id="hgName" maxlength="32"></div>
      <div class="fld"><label>手机号</label><input id="hgPhone" maxlength="20"></div>
      <div class="fld"><label>登录密码 <span style="color:#c0392b">*</span></label><input id="hgPw" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button class="btn" id="hgCancel">取消</button>
        <button class="btn pri" id="hgSave">💾 保存</button>
      </div></div>`;
    document.body.appendChild(mask);
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    mask.querySelector('#hgCancel').onclick = () => mask.remove();
    mask.querySelector('#hgSave').onclick = async () => {
      const b = {
        empNo: mask.querySelector('#hgNo').value.trim(),
        name: mask.querySelector('#hgName').value.trim(),
        phone: mask.querySelector('#hgPhone').value.trim(),
        password: mask.querySelector('#hgPw').value,
      };
      if (!b.empNo || !b.name || !b.password) return toast('工号、姓名、密码均为必填', false);
      try {
        const r2 = await must(post(`/hq/stores/${id}/manager`, b));
        toast(r2.created ? `✅ 店长账号 ${r2.empNo} 已创建` : `✅ 店长账号 ${r2.empNo} 已重置`);
        mask.remove();
        await load();
      } catch { /* must 已提示 */ }
    };
  }

  // ── 启停 ──
  function openStatus(id) {
    const r = rows.find(x => Number(x.id) === id);
    if (!r) return;
    const on = Number(r.status) === 1;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.zIndex = 90;
    mask.innerHTML = on
      ? `<div class="modal confirm-modal" style="width:min(520px,94vw)">
          <h3>停业 / 闭店</h3>
          <div class="confirm-body" style="font-size:13px;line-height:1.9">
            将门店 <b>${esc(r.name)}</b> 置为：<br>
            <label style="display:block;margin:8px 0"><input type="radio" name="hsSt" value="0" checked> 停业（保留数据，可随时恢复；账号仍可用）</label>
            <label style="display:block"><input type="radio" name="hsSt" value="2"> 闭店（<b style="color:#c0392b">该店全部账号将停用</b>，节点不再下发与同步；历史数据保留）</label>
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
            <button class="btn" data-c>取消</button>
            <button class="btn danger" data-o>确认执行</button>
          </div></div>`
      : `<div class="modal confirm-modal" style="width:min(520px,94vw)">
          <h3>恢复营业</h3>
          <div class="confirm-body" style="font-size:13px;line-height:1.9">
            将门店 <b>${esc(r.name)}</b> 恢复为「营业中」？<br>
            <span class="muted">（闭店时被停用的账号不会自动恢复，需到「员工与权限」里重新启用）</span>
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
            <button class="btn" data-c>取消</button>
            <button class="btn pri" data-o>恢复营业</button>
          </div></div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.onclick = e => { if (e.target === mask) close(); };
    mask.querySelector('[data-c]').onclick = close;
    mask.querySelector('[data-o]').onclick = async () => {
      const st = on ? Number(mask.querySelector('input[name="hsSt"]:checked')?.value ?? 0) : 1;
      const btn = mask.querySelector('[data-o]'); btn.disabled = true;
      try {
        await must(post(`/hq/stores/${id}/status`, { status: st }));
        toast(st === 1 ? '✅ 门店已恢复营业' : st === 0 ? '✅ 门店已停业' : '✅ 门店已闭店');
        close();
        await load();
      } catch { btn.disabled = false; /* must 已提示 */ }
    };
  }

  // ── 事件绑定 ──
  $('#hsSearch').onclick = () => {
    q.keyword = $('#hsKw').value.trim();
    q.status = $('#hsStatus').value;
    q.orgType = $('#hsOrg').value;
    q.region = $('#hsRegion').value;
    page = 1;
    load();
  };
  $('#hsKw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#hsSearch').click(); });
  $('#hsRefresh').onclick = () => { loadRegions(); load(); };
  $('#hsNew').onclick = () => openEdit(0);

  await loadRegions();
  await load();
}
