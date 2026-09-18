import { get, post, put, del, must, esc, dt, toast, API } from '../api.js';
import { confirmBox } from '../ui.js';
import { openDetailModal } from '../common-ui.js';
import { anchorNav, applyGlass } from '../ui-polish.js';   // V4.26.3 长页面锚点导航 / 液态玻璃开关

/** 系统设置：行内编辑（开关/下拉/结构化编辑器），变更全量留痕（每页 10 条翻页） */
export async function render(view) {
  // P2-6：总部视角才显示「下发门店」（门店级设置统一下发）
  let isHq = false;
  try { isHq = !!((await must(get('/auth/me')))?.hq); } catch { /* 保持 false */ }
  let groups = [];
  let chgPage = 1, chgPages = 1, chgTotal = 0;
  view.innerHTML = `
    <style>
      .sw { position:relative; display:inline-block; width:44px; height:22px; vertical-align:middle; }
      .sw input { opacity:0; width:0; height:0; }
      .sw i { position:absolute; inset:0; background:#c9c4b8; border-radius:22px; transition:.2s; cursor:pointer; }
      .sw i::before { content:''; position:absolute; width:18px; height:18px; left:2px; top:2px;
        background:#fff; border-radius:50%; transition:.2s; }
      .sw input:checked + i { background:var(--pri,#20663f); }
      .sw input:checked + i::before { transform:translateX(22px); }
      .set-key { font-family:Consolas,monospace; font-size:11px; color:var(--muted,#8a8577); }
      .set-val { width:230px; }
      select.set-val { width:auto; min-width:200px; max-width:440px; } /* 下拉随内容自适应，不再截断 */
      .set-secret { font-family:Consolas,monospace; letter-spacing:1px; }
      .set-masked { font-family:Consolas,monospace; font-size:11.5px; color:var(--muted,#8a8577); margin-left:6px; }
      /* 固定列宽 + 长词换行：说明/默认值不再溢出容器 */
      #slist table { table-layout:fixed; width:100%; }
      #slist th:nth-child(1) { width:20%; } #slist th:nth-child(2) { width:33%; }
      #slist th:nth-child(3) { width:13%; } #slist th:nth-child(4) { width:34%; }
      #slist td { white-space:normal; word-break:break-word; overflow-wrap:anywhere; } /* 全局 td nowrap 覆盖 */
      .set-unit { color:#8a94a6; font-size:11.5px; margin-left:3px; } /* V4.13.7 单位后置：值后面跟 天/元/%/秒… */
      .saved-flash { color:var(--pri,#20663f); font-size:12px; margin-left:6px; }
      .tiers-row { display:flex; gap:6px; align-items:center; margin-bottom:4px; flex-wrap:wrap; }
      .tiers-row input { width:64px; padding:4px 6px; border:1px solid var(--line,#ddd); border-radius:6px; }
      .tiers-row .x { cursor:pointer; color:#c33; padding:0 4px; }
      .chk-list { display:flex; gap:10px; flex-wrap:wrap; }
      .chk-list label { display:flex; gap:4px; align-items:center; font-size:13px; cursor:pointer; }
      .ro-json { font-family:Consolas,monospace; font-size:11px; max-width:420px; max-height:100px;
        overflow:auto; white-space:pre-wrap; word-break:break-all; background:#faf9f5;
        border:1px solid var(--line,#ddd); border-radius:6px; padding:6px 8px; }
      .pager { display:flex; gap:10px; align-items:center; padding:8px 2px; font-size:13px; }
      .pager button { padding:4px 12px; }
      .set-mini { width:58px; padding:4px 6px; border:1px solid var(--line,#ddd); border-radius:6px; }
      .set-btn { padding:5px 10px; font-size:12px; }
      .grp-row td { background:#efece2; font-weight:800; font-size:13px; padding:8px 10px; border-top:2px solid var(--line,#ddd); }
      .sec-row td { background:#f7f5ec; color:var(--pri,#20663f); font-weight:700; font-size:12.5px;
        padding:6px 10px 6px 20px; letter-spacing:.5px; border-top:1px dashed var(--line,#ddd); }
    </style>
    <div class="bar" id="gTabs"></div>
    <div class="card"><h3>设置项 <span class="api">行内修改 · PUT /settings/:key（变更全量留痕）</span></h3>
      <div class="bar" style="margin:0 18px 8px">
        <input id="setKw" placeholder="🔍 搜索设置项：名称 / 键 / 当前值（即输即查，支持模糊）" style="flex:1;min-width:240px">
        <button class="btn sm" id="setKwClear">清空</button>
      </div>
      <div id="slist"></div></div>
    <div class="card" id="devCard" style="display:none"><h3>🖥️ 收银机授权 <span class="api">GET /pos-devices · 审批/停用/删除（需「系统设置」权限）</span></h3>
      <div id="devBody"></div></div>
    <div class="card" id="initCard" style="display:none"><h3>🏗️ 开业初始化 <span class="api">GET /admin/reset/preview · POST /admin/reset/execute（需「备份恢复操作」权限）· 仅「系统初始化」页签显示</span></h3>
      <div id="initBody"></div></div>
    <div class="card"><h3>变更留痕 <span class="api">GET /settings/changes · 每页 10 条</span></h3>
      <div class="bar" style="margin:0 18px 8px">
        <input id="chgFrom" type="date" title="起始日期" style="width:140px">
        <span class="muted">至</span>
        <input id="chgTo" type="date" title="结束日期" style="width:140px">
        <input id="chgOp" placeholder="操作人（模糊）" style="width:130px">
        <button class="btn sm pri" id="chgGo">查询</button>
        <button class="btn sm" id="chgReset">重置</button>
      </div>
      <div id="chg"></div>
      <div class="pager" id="chgPager"></div></div>`;

  let curGroup = '';   // V4.13.9：当前选中分组（''=全部）；保存后重绘留在本页，不再跳回「全部」
  let initPermOk = false, initLoaded = false;   // V4.16.4：开业初始化卡状态（声明上移防 TDZ）

  async function loadGroups() {
    const all = await must(get('/settings'));
    allRowsCache = all;
    groups = [...new Set(all.map(s => s.group_name))];
    // V4.25.7：页签顺序微调——「系统初始化」固定排到最后（低频、危险操作，避免误点）
    if (groups.includes('系统初始化')) {
      groups = groups.filter(g => g !== '系统初始化').concat(['系统初始化']);
    }
    view.querySelector('#gTabs').innerHTML =
      `<button class="btn pri" data-g="">全部</button>` +
      groups.map(g => `<button class="btn" data-g="${esc(g)}">${esc(g)}</button>`).join('');
    view.querySelectorAll('#gTabs [data-g]').forEach(b => b.onclick = () => {
      curGroup = b.dataset.g;
      view.querySelectorAll('#gTabs .btn').forEach(x => x.classList.toggle('pri', x === b));
      draw(all.filter(s => !b.dataset.g || s.group_name === b.dataset.g));
      syncInitCard();   // V4.14.8：开业初始化仅在「系统初始化」页签显示
      renderDevCard();  // V4.21.2：收银机授权列表仅在「设备管理」页签显示
    });
    // 恢复当前分组高亮（保存后重进不再落回「全部」）
    view.querySelectorAll('#gTabs [data-g]').forEach(b => b.classList.toggle('pri', b.dataset.g === curGroup));
    draw(all.filter(s => !curGroup || s.group_name === curGroup));
    renderDevCard();
  }

  /** V4.21.2 设备管理页签：收银机授权列表（审批通过/停用启用/命名/删除，待授权排前） */
  async function renderDevCard() {
    const card = view.querySelector('#devCard');
    if (!card) return;
    const show = curGroup === '设备管理';
    card.style.display = show ? '' : 'none';
    if (!show) return;
    const body = view.querySelector('#devBody');
    try {
      const rows = await must(get('/pos-devices'));
      if (!Array.isArray(rows) || !rows.length) {
        body.innerHTML = '<div class="empty">暂无设备登记。开启上方「收银机授权」开关后，新设备首次登录会自动登记为「待授权」，回到这里审批即可。</div>';
        return;
      }
      const stColor = s => s === '待授权' ? '#b5544a' : (s === '已授权' ? 'var(--pri,#20663f)' : '#8a8577');
      body.innerHTML = `<table><thead><tr><th>设备码</th><th>名称</th><th>状态</th><th>最后活跃</th><th>操作</th></tr></thead>
        <tbody>${rows.map(d => `<tr>
          <td style="font-family:Consolas,monospace">${esc(d.deviceCode)}</td>
          <td>${esc(d.deviceName || '—')}</td>
          <td><b style="color:${stColor(d.status)}">${esc(d.status)}</b></td>
          <td class="muted">${d.lastSeenAt ? dt(d.lastSeenAt) : '—'}${d.lastIp ? ' · ' + esc(d.lastIp) : ''}</td>
          <td style="white-space:nowrap">
            ${d.status !== '已授权' ? `<button class="btn sm pri" data-dvok="${d.id}" data-name="${esc(d.deviceName || '')}">✓ 通过</button> ` : ''}
            ${d.status === '已停用'
              ? `<button class="btn sm" data-dvstatus="${d.id}" data-st="已授权">启用</button> `
              : `<button class="btn sm" data-dvstatus="${d.id}" data-st="已停用">停用</button> `}
            <button class="btn sm" data-dvrename="${d.id}" data-name="${esc(d.deviceName || '')}">命名</button>
            <button class="btn sm danger" data-dvdel="${d.id}">删除</button>
          </td>
        </tr>`).join('')}</tbody></table>
        <div class="muted" style="font-size:12px;margin-top:6px">说明：浏览器拿不到 MAC 地址（且 MAC 可伪造），采用<b>设备码 + 浏览器指纹</b>白名单，强于 MAC 绑定。审批前建议先「命名」便于识别；删除后该设备再登录会重新登记为待授权。</div>`;
      body.querySelectorAll('[data-dvok]').forEach(b => b.onclick = async () => {
        const name = prompt('设备名称（如：1号收银机）', b.dataset.name || '') ?? '';
        try { await must(post(`/pos-devices/${b.dataset.dvok}/approve`, { name })); toast('已授权通过'); renderDevCard(); } catch { /* must 已 toast */ }
      });
      body.querySelectorAll('[data-dvrename]').forEach(b => b.onclick = async () => {
        const name = prompt('设备名称（如：1号收银机）', b.dataset.name || '');
        if (name === null) return;
        try { await must(post(`/pos-devices/${b.dataset.dvrename}/approve`, { name })); toast('已保存名称'); renderDevCard(); } catch { /* must 已 toast */ }
      });
      body.querySelectorAll('[data-dvstatus]').forEach(b => b.onclick = async () => {
        try { await must(post(`/pos-devices/${b.dataset.dvstatus}/status`, { status: b.dataset.st })); toast(b.dataset.st === '已停用' ? '已停用（该设备将无法登录员工账号）' : '已启用'); renderDevCard(); } catch { /* must 已 toast */ }
      });
      body.querySelectorAll('[data-dvdel]').forEach(b => b.onclick = async () => {
        if (!confirm('删除该设备登记？删除后该设备再登录会重新登记为待授权。')) return;
        try { await must(del(`/pos-devices/${b.dataset.dvdel}`)); toast('已删除'); renderDevCard(); } catch { /* must 已 toast */ }
      });
    } catch (e) {
      body.innerHTML = `<div class="empty">设备列表加载失败：${esc(e?.msg || e?.message || '')}</div>`;
    }
  }

  /** 保存后回读刷新：重拉数据并按当前分组重绘（留在本页） */
  async function refreshCur() { await loadGroups(); }

  /** V4.13.9 A2：启用真实通道（pay.gateway.mode=real）→ 自动填充微信/支付宝正式网关，用户只填商户号/密钥 */
  async function autofillGateways() {
    const official = { 'pay.wechat.gateway': 'https://api.mch.weixin.qq.com', 'pay.alipay.gateway': 'https://openapi.alipay.com/gateway.do' };
    let changed = 0;
    for (const [k, v] of Object.entries(official)) {
      try {
        const row = allRowsCache.find(s => s.setting_key === k);
        if (row && String(row.value) !== v) { await must(put(`/settings/${encodeURIComponent(k)}`, { value: v, reason: '启用真实通道：自动切换正式网关' }), ''); changed++; }
      } catch { /* 单项失败不阻断 */ }
    }
    toast(changed ? '已启用真实通道，正式网关地址已自动填充' : '已启用真实通道（网关地址已是正式值）');
  }
  let allRowsCache = [];

  const isBool = s => s.value_type === 'bool' || typeof s.value === 'boolean' ||
    String(s.value) === 'true' || String(s.value) === 'false';

  // ── V4.13.4 枚举选项：enum_options 支持 [{v,label}] JSONB 数组（051 迁移已全量补齐）──
  function enumOpts(s) {
    const raw = s.enum_options;
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object')
      return raw.map(o => ({ v: String(o.v ?? o.value ?? ''), label: String(o.label ?? o.v ?? o.value ?? '') }));
    if (Array.isArray(raw) && raw.length) return raw.map(v => ({ v: String(v), label: String(v) }));
    if (typeof raw === 'string' && raw.trim())
      return raw.split(/[,，/]/).map(x => x.trim()).filter(Boolean).map(v => ({ v, label: v }));
    return [];
  }

  // ── V4.13.4 JSON 型设置项：结构化编辑器注册表（让用户看得懂、点得动）──
  const JSON_EDITORS = {
    // 临期预警提前天数 [7,3] → 两个「提前 X 天」输入框
    'stock.expiry_warn_days': {
      read: v => (Array.isArray(v) ? v : [7, 3]).map(Number),
      render: (vals, key) => `<span style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${vals.map((n, i) => `临期 <input class="set-mini num" type="number" min="0" value="${n}" data-i="${i}"> 天前`).join(' + ')}
        <button class="btn set-btn" data-jsonsave="${key}">保存</button></span>`,
      collect: box => [...box.querySelectorAll('.num')].map(i => Math.max(0, Number(i.value) || 0)).sort((a, b) => b - a),
    },
    // 临期自动折扣档位 [{pct,days}] → 档位行编辑（临期 ≤ X 天 → 按 Y% 原价卖）
    'promo.expiry_auto_discount': {
      read: v => (Array.isArray(v) ? v : []).map(t => ({ days: Number(t.days) || 0, pct: Number(t.pct) || 100 })),
      tiersHTML: tiers => `<div data-tierbox>
          ${tiers.map((t, i) => `<div class="tiers-row">临期 ≤
            <input class="set-mini td" type="number" min="0" value="${t.days}" data-i="${i}"> 天 →
            按 <input class="set-mini tp" type="number" min="1" max="100" value="${t.pct}" data-i="${i}">% 原价销售
            <span class="x" data-del="${i}" title="删除该档">✕</span></div>`).join('')}
        </div>`,
      render(tiers, key) {
        return `${this.tiersHTML(tiers)}
        <button class="btn set-btn" data-tieradd="${key}">＋ 加一档</button>
        <button class="btn pri set-btn" data-jsonsave="${key}">保存</button>`;
      },
      collect: box => [...box.querySelectorAll('.tiers-row')].map(r => ({
        days: Math.max(0, Number(r.querySelector('.td').value) || 0),
        pct: Math.min(100, Math.max(1, Number(r.querySelector('.tp').value) || 100)),
      })).sort((a, b) => a.days - b.days),
    },
    // 必签单据类型 → 复选框
    'auth.sign_required_scenes': {
      read: v => Array.isArray(v) ? v.map(String) : [],
      options: [
        { v: 'inbound', label: '入库单' }, { v: 'return', label: '退供单' },
        { v: 'loss', label: '报损单' }, { v: 'recon', label: '对账单' }, { v: 'count', label: '盘点单' },
      ],
      render(vals, key) {
        return `<span class="chk-list" data-chkbox>
          ${this.options.map(o => `<label><input type="checkbox" value="${o.v}" ${vals.includes(o.v) ? 'checked' : ''}>${o.label}</label>`).join('')}
          </span> <button class="btn pri set-btn" data-jsonsave="${key}">保存</button>`;
      },
      collect: box => [...box.querySelectorAll('input:checked')].map(i => i.value),
    },
    // 应急收银角色 → 复选框（预设 + 已配角色兜底展示）
    'ops.emergency_pay': {
      read: v => Array.isArray(v) ? v.map(String) : [],
      options: [
        { v: '店长', label: '店长' }, { v: '收银员', label: '收银员' },
        { v: '收银主管', label: '收银主管' }, { v: '库存管理员', label: '库存管理员' },
      ],
      render: function (vals, key) {
        const extra = vals.filter(v => !this.options.some(o => o.v === v))
          .map(v => ({ v, label: v }));
        return `<span class="chk-list" data-chkbox>
          ${[...this.options, ...extra].map(o => `<label><input type="checkbox" value="${esc(o.v)}" ${vals.includes(o.v) ? 'checked' : ''}>${esc(o.label)}</label>`).join('')}
          </span> <button class="btn pri set-btn" data-jsonsave="${key}">保存</button>`;
      },
      collect: box => [...box.querySelectorAll('input:checked')].map(i => i.value),
    },
    // ── V4.21.2 整单折扣预设规则 → 档位行编辑（折扣名 + 打 X 折）──
    'pos.discount.presets': {
      read: v => (Array.isArray(v) ? v : []).map(t => ({ name: String(t.name || ''), rate: Number(t.rate) || 95 })),
      rowsHTML: rows => `<div data-tierbox>${rows.map(t => `<div class="tiers-row">
          <input class="set-mini pn" type="text" value="${esc(t.name)}" placeholder="折扣名" style="width:96px"> 打
          <input class="set-mini pr" type="number" min="1" max="99" value="${t.rate}" style="width:52px"> 折
          <span class="x" data-del="1" title="删除该档">✕</span></div>`).join('')}</div>`,
      render(rows, key) {
        return `${this.rowsHTML(rows)}
        <button class="btn set-btn" data-padd="${key}">＋ 加一档</button>
        <button class="btn pri set-btn" data-jsonsave="${key}">保存</button>`;
      },
      collect: box => [...box.querySelectorAll('.tiers-row')].map(r => ({
        name: r.querySelector('.pn').value.trim() || '折扣',
        rate: Math.min(99, Math.max(1, Number(r.querySelector('.pr').value) || 95)),
      })),
    },
    // ── V4.21.2 客显空闲轮播 → 行编辑（图标 + 主标题 + 副标题）──
    'display.ads': {
      read: v => (Array.isArray(v) ? v : []).map(t => ({
        emoji: String(t.emoji || ''), title: String(t.title || ''), sub: String(t.sub || ''),
      })),
      rowsHTML: rows => `<div data-tierbox>${rows.map(t => `<div class="tiers-row">
          <input class="set-mini ae" type="text" value="${esc(t.emoji)}" placeholder="图标" style="width:56px">
          <input class="set-mini at" type="text" value="${esc(t.title)}" placeholder="主标题" style="width:150px">
          <input class="set-mini as" type="text" value="${esc(t.sub)}" placeholder="副标题（可空）" style="width:150px">
          <span class="x" data-del="1" title="删除该条">✕</span></div>`).join('')}</div>`,
      render(rows, key) {
        return `${this.rowsHTML(rows)}
        <button class="btn set-btn" data-aadd="${key}">＋ 加一条</button>
        <button class="btn pri set-btn" data-jsonsave="${key}">保存</button>`;
      },
      collect: box => [...box.querySelectorAll('.tiers-row')].map(r => ({
        emoji: r.querySelector('.ae').value.trim(),
        title: r.querySelector('.at').value.trim(),
        sub: r.querySelector('.as').value.trim(),
      })).filter(t => t.title),
    },
    // ── V4.21.2 收银快捷键映射 → 固定六个动作 × 功能键下拉（冲突互换在收银台设置面板处理）──
    'pos.cashier.hotkey_map': {
      read: v => {
        const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
        return ['pay', 'hold', 'take', 'repeat', 'print', 'lock'].map(k => ({ k, key: String(o[k] || '').toUpperCase() }));
      },
      actions: [['pay', '收款结算'], ['hold', '挂单'], ['take', '取单'], ['repeat', '重复上一单'], ['print', '打印开关'], ['lock', '锁屏']],
      render(rows, key) {
        const KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
        return `<div style="display:flex;gap:10px;flex-wrap:wrap" data-hkbox>${rows.map(r =>
          `<label style="font-size:12px;display:flex;gap:4px;align-items:center">${esc((this.actions.find(a => a[0] === r.k) || [])[1] || r.k)}
            <select class="set-mini hk" data-k="${r.k}" style="width:66px">${KEYS.map(k =>
            `<option ${k === r.key ? 'selected' : ''}>${k}</option>`).join('')}</select></label>`).join('')}
          </div> <button class="btn pri set-btn" data-jsonsave="${key}">保存</button>`;
      },
      collect: box => {
        const o = {};
        box.querySelectorAll('select.hk').forEach(s => { o[s.dataset.k] = s.value; });
        return o;
      },
    },
  };
  // 系统自动维护的缓存项：只读展示，不让用户碰 JSON
  const SYSTEM_JSON = new Set(['ai.fraud_baseline', 'ai.assoc_rules']);

  /** JSON 型设置项的编辑控件（结构化编辑器 / 系统只读 / 通用 pretty 文本域兜底） */
  function jsonControl(s) {
    const key = esc(s.setting_key);
    if (SYSTEM_JSON.has(s.setting_key)) {
      return `<div class="ro-json">${esc(JSON.stringify(s.value, null, 1))}</div>
        <span class="set-masked">系统自动维护，无需手工修改</span>`;
    }
    const ed = JSON_EDITORS[s.setting_key];
    if (ed) {
      const vals = ed.read(s.value);
      return ed.render.call(ed, vals, key);
    }
    const pretty = JSON.stringify(s.value, null, 1);
    return `<textarea data-key="${key}" data-type="json" rows="2" style="width:280px;font-family:Consolas,monospace;font-size:11.5px"
      title="JSON 格式；回车（Ctrl+Enter）保存">${esc(pretty)}</textarea>`;
  }

  function control(s) {
    const key = esc(s.setting_key);
    if (isBool(s)) {
      const on = String(s.value) === 'true' || s.value === true;
      return `<label class="sw" title="${on ? '开' : '关'}">
        <input type="checkbox" data-key="${key}" data-type="bool" ${on ? 'checked' : ''}><i></i></label>
        <span class="muted">${on ? '开' : '关'}</span>`;
    }
    if (s.value_type === 'enum') {
      const opts = enumOpts(s);
      if (opts.length) {
        const cur = String(s.value ?? '');
        return `<select class="set-val" data-key="${key}" data-type="enum">${
          opts.map(o => `<option value="${esc(o.v)}" ${o.v === cur ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
        }</select>`; /* 下拉本身已展示当前选中项，不再叠加「当前：X」冗余提示 */
      }
    }
    if (s.value_type === 'secret') {
      // V4.13.3 密钥项：服务端只返回脱敏值（未配置 / ••••尾号）；输入框留空 = 不修改
      const configured = s.value && s.value !== '未配置';
      return `<input class="set-val set-secret" type="password" autocomplete="new-password" data-key="${key}" data-type="secret"
        placeholder="${configured ? '输入新密钥覆盖' : '未配置：输入后保存'}" title="回车保存；留空 = 不修改">
        <span class="set-masked">${configured ? `已加密配置 ${esc(String(s.value))}` : ''}</span>`;
    }
    // V4.16.6 决策自动化（分域三档/成熟度门槛）——必须在 jsonControl 早退之前特判，否则永远渲染成 JSON 文本框
    if (s.setting_key === 'ai.decision.modes') {
      const cur = (s.value && typeof s.value === 'object') ? s.value : {};
      const DOMS = [['补货', '补货建议'], ['定价', '定价建议'], ['备货', '节假日/天气备货']];
      return `<div style="display:flex;gap:12px;flex-wrap:wrap" data-dmwrap>` + DOMS.map(([d, tip]) =>
        `<label style="font-size:12px;display:flex;align-items:center;gap:4px" title="${tip}">${d}
          <select class="set-val" data-dm="${esc(d)}" style="width:96px">${['手动确认', '半自动', '全自动'].map(m =>
            `<option ${String(cur[d] ?? '手动确认') === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>`).join('') +
        `<span class="muted" style="font-size:11px">全自动需成熟度解锁（采纳率/连续达标周）</span></div>`;
    }
    if (s.setting_key === 'ai.decision.maturity') {
      const cur = (s.value && typeof s.value === 'object') ? s.value : {};
      const F = [['minAcceptRate', '采纳率 ≥', '%'], ['minWeeks', '连续达标', '周'], ['minDecided', '已决策样本 ≥', '条']];
      return `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">` + F.map(([k, label, unit]) =>
        `<label style="font-size:12px;display:flex;align-items:center;gap:4px">${label}
          <input class="set-val" type="number" step="1" data-mt="${k}" value="${Number(cur[k] ?? 0)}" style="width:64px;text-align:center">${unit}</label>`).join('') +
        `<span class="muted" style="font-size:11px">三项同时满足后自动解锁「全自动」</span></div>`;
    }
    if (s.value_type === 'json' || (s.value !== null && typeof s.value === 'object')) return jsonControl(s);
    // V4.13.8 播报音色：动态枚举本机 speechSynthesis 中文音色（⭐=拟真人声）+ 试听按钮
    // V4.21.2：收银台音色 pos.cashier.tts.voice 同款下拉（原先空文本框无选项看不懂）
    if (s.setting_key === 'voice.tts.voice' || s.setting_key === 'pos.cashier.tts.voice') {
      let vs = [];
      try { vs = speechSynthesis ? speechSynthesis.getVoices().filter(v => /^zh/i.test(v.lang || '')) : []; } catch { /* 忽略 */ }
      const nat = v => /Natural|Online/i.test(v.name || '');
      const cur = String(s.value ?? '').replace(/^"|"$/g, '');
      const opts = [`<option value="" ${!cur ? 'selected' : ''}>自动（最佳中文声，女声优先）</option>`]
        .concat(vs.sort((a, b) => (nat(b) ? 1 : 0) - (nat(a) ? 1 : 0)).map(v =>
          `<option value="${esc(v.name)}" ${v.name === cur ? 'selected' : ''}>${nat(v) ? '⭐ ' : ''}${esc(v.name)}</option>`)).join('');
      return `<select class="set-val voicesel" data-key="${key}" data-type="string">${opts}</select>
        <button class="btn set-btn" data-voiceprev style="width:auto;padding:4px 10px;font-size:12px">🔊 试听</button>
        ${vs.length ? '' : '<span class="muted" style="font-size:11.5px">（本机暂未枚举到中文音色，打开系统语音设置或换 Edge 浏览器）</span>'}`;
    }
    // V4.21.2 播报语速：收银台/老板端同款下拉（原先空文本框无选项）
    if (s.setting_key === 'voice.tts.rate' || s.setting_key === 'pos.cashier.tts.rate') {
      const cur = String(s.value ?? '').replace(/^"|"$/g, '');
      return `<select class="set-val" data-key="${key}" data-type="string">${
        [['', '跟随老板端'], ['0.85', '0.85 倍（慢）'], ['1', '1 倍（正常）'], ['1.1', '1.1 倍'], ['1.25', '1.25 倍（快）']]
          .map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')
      }</select>`;
    }
    // V4.25.7 店长授权策略（设备管理分组）：改价授权频次 / 店长本人是否免输授权码
    if (s.setting_key === 'pos.price.auth_reuse' || s.setting_key === 'pos.price.auth_self') {
      const cur = String(s.value ?? '').replace(/^"|"$/g, '');
      const OPTS = s.setting_key === 'pos.price.auth_reuse'
        ? [['batch', '一次授权，本单连续改价免再输码（票据 120 秒 · 结算作废）'], ['once', '每次改价都弹窗要求店长输授权码']]
        : [['off', '店长本人操作也需输授权码（责任最严）'], ['on', '店长本人操作免输授权码（自动授权 · 仍留痕）']];
      return `<select class="set-val" data-key="${key}" data-type="string">${
        OPTS.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')
      }</select>`;
    }
    // V4.14.8：开业日期 → 日期选择器（键级特判；存值口径 YYYY-MM-DD 不变）
    if (s.setting_key === 'init.opening_date') {
      const dv = String(s.value ?? '').replace(/^"|"$/g, '');
      return `<input class="set-val" type="date" data-key="${key}" data-type="string" value="${esc(dv)}" title="选择日期，失焦保存">`;
    }
    // V4.16.5 条码秤格式：预设模板下拉（自定义时用 ai.scale.custom_format 值）
    if (s.setting_key === 'ai.scale.barcode_format') {
      const cur = String(s.value ?? '').replace(/^"|"$/g, '');
      const PRESETS = [
        { v: '', label: '无（不解析秤码）' },
        { v: 'FWWWWWWC', label: 'FWWWWWWC · 重量码（前缀+7位克重+校验）' },
        { v: 'FWWWWWWWEEEEEC', label: 'FWWWWWWWEEEEEC · 金额码（克重+5位金额分）' },
        { v: 'FWWWWWWWNNNNNC', label: 'FWWWWWWWNNNNNC · 商品码（克重+5位PLU）' },
        { v: 'FWWWWWWWEEEEEENNNNNC', label: 'FWWWWWWWEEEEEENNNNNC · 金额+商品码' },
        { v: 'FWWWWWWWNNNNNEEEEEC', label: 'FWWWWWWWNNNNNEEEEEC · 商品码+金额' },
        { v: 'FWWWWWWWEEEEEENNNNNO', label: 'FWWWWWWWEEEEEENNNNNO · 金额+商品码(O尾)' },
        { v: 'FFWWWWWWNNNNNC', label: 'FFWWWWWWNNNNNC · 双前缀重量+商品码' },
        { v: 'DDDDDDDDDDDC', label: 'DDDDDDDDDDDC · 11位全忽略+校验（占位）' },
        { v: 'FWWWWWEEEEEC', label: 'FWWWWWEEEEEC · 6位克重+5位金额' },
        { v: 'FWWWWWWEEEEECNNNNN', label: 'FWWWWWWEEEEECNNNNN · 金额+校验+商品码' },
        { v: 'FWWWWWWWNN.NEEEE.EC', label: 'FWWWWWWWNN.NEEEE.EC · 带小数点锚' },
        { v: 'FWWWWWWWNNN.NEEEE.EC', label: 'FWWWWWWWNNN.NEEEE.EC · 带小数点锚' },
        { v: 'FFWWWWWWNNNNNPPPPPC', label: 'FFWWWWWWNNNNNPPPPPC · 商品码+单价' },
        { v: 'CCCCCCCCCCCCCFWWWWWWNN.NNCCCCCCC', label: 'CCCCCCCCCCCCCFWWWWWWNN.NNCCCCCCC · 校验前缀式' },
        { v: '自定义', label: '自定义（下方「自定义秤码格式」填写模板）' },
      ];
      return `<select class="set-val" data-key="${key}" data-type="string">${
        PRESETS.map(o => `<option value="${esc(o.v)}" ${o.v === cur ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
      }</select>`;
    }
    const type = s.value_type === 'number' ? 'number' : 'text';
    const val = String(s.value ?? '');
    // V4.13.7 单位后置：数字型在输入框后跟单位（天/元/%/秒…），说明列不再放单位
    const unit = s.value_type === 'number' && s.unit ? ` <span class="set-unit">${esc(s.unit)}</span>` : '';
    return `<input class="set-val" type="${type}" step="0.01" data-key="${key}" data-type="${esc(s.value_type)}"
      value="${esc(val)}" title="回车或失焦保存">${unit}`;
  }

  // ── V4.13.5 分组内小节聚类：同渠道/同主题的设置聚合展示（微信归微信、支付宝归支付宝），
  //    未命中的归「其他」；prefixes 按键前缀匹配，order 指定小节内展示顺序 ──
  const SECTIONS = {
    '支付': [
      { title: '通道模式与支付确认', prefixes: ['pay.gateway.'] },
      { title: '微信支付（V3 付款码支付）', prefixes: ['pay.wechat.'],
        order: ['pay.wechat.enabled', 'pay.wechat.mchid', 'pay.wechat.appid', 'pay.wechat.cert_serial',
                'pay.wechat.apiv3_key', 'pay.wechat.private_key', 'pay.wechat.gateway'] },
      { title: '支付宝（当面付）', prefixes: ['pay.alipay.'],
        order: ['pay.alipay.enabled', 'pay.alipay.app_id', 'pay.alipay.private_key',
                'pay.alipay.public_key', 'pay.alipay.gateway'] },
    ],
    'AI赋能': [
      { title: '识别引擎与自动采信', prefixes: ['ai.engine', 'ai.recog.', 'ai.vlm_fallback', 'ai.fallback_conf',
        'ai.emb.', 'ai.multi.', 'ai.kb.'] },
      { title: '本地大模型（Ollama）', prefixes: ['ai.llm.'] },
      { title: '票据 OCR 收货', prefixes: ['ai.ocr.'] },
      { title: '补货与销量预测', prefixes: ['ai.restock.', 'ai.forecast.'] },
      { title: '选品与定价建议', prefixes: ['ai.assortment.', 'ai.pricing.'] },
      { title: '防损对账与经营安全', prefixes: ['ai.fraud', 'ai.assoc', 'antileak.',
        'ai.suggest.auto', 'finance.billrecon'] },
      { title: '决策自动化（自决策中心迁入 V4.16.5）', prefixes: ['ai.decision.'] },
      { title: '日常运营', prefixes: ['ai.daily_report.'] },
      { title: '天气因素（V4.16.1 天气备货/问答）', prefixes: ['ai.weather.'] },
      { title: '条码秤参数（V4.16.5）', prefixes: ['ai.scale.'] },
      { title: '节日表与会员AI画像（V4.16.3）', prefixes: ['ai.holiday.', 'ai.member.'] },
    ],
    '商品管理': [
      { title: '商品与保质期', prefixes: ['product.', 'stock.expiry'] },
      { title: '库存与退货', prefixes: ['stock.'] },
      { title: '采购与结算', prefixes: ['po.', 'recon.'] },
      { title: '条码大数据', prefixes: ['barcode.'] },
    ],
    '营销与线上': [
      { title: '促销与优惠叠加', prefixes: ['promo.', 'coupon.'] },
      { title: '会员 H5 门户（掌上会员 V4.14.8）', prefixes: ['member.h5.'] },
      { title: '会员设置（V4.14.1 自「会员」组并入）', prefixes: ['member.', 'points.'] },
      { title: 'H5 线上商城', prefixes: ['h5.'] },
      { title: '在线配送与门店位置', prefixes: ['delivery.', 'store.'] },
      { title: '营销引擎', prefixes: ['marketing.'] },
    ],
    '财务管理': [
      { title: '会员分红机制', prefixes: ['dividend.'] },
    ],
    '通用设置': [
      { title: '收银与小票钱箱', prefixes: ['pos.', 'sales.refund'] },
      { title: '销售与扫码购（V4.14.1 自「销售」组并入）', prefixes: ['sales.'] },
      { title: '移动端', prefixes: ['mobile.'] },
      { title: '语音播报（拟人音色）', prefixes: ['voice.tts.', 'voice.assistant.', 'voice.product.', 'pos.voice_broadcast'] },
      { title: '签字审批与安全', prefixes: ['auth.'] },
      { title: '应急与运维', prefixes: ['ops.', 'report.', 'ops.backup_hour'] },
      { title: '硬件外设', prefixes: ['scale.'] },
    ],
    '设备管理': [
      { title: '收银机授权（设备白名单）', prefixes: ['pos.device.'] },
      { title: '收银台与客显', prefixes: ['pos.', 'display.'] },
    ],
    '系统初始化': [
      { title: '开业初始', prefixes: ['init.'] },
    ],
    '门店与运维': [
      { title: '商店信息（门头/小票抬头/商城 V4.16.5）', prefixes: ['store.info.'] },
    ],
  };
  const ordIdx = (arr, k) => { const i = arr.indexOf(k); return i === -1 ? 999 : i; };

  /** 把行聚成 [{group,title,items}]：组内按 SECTIONS 小节聚类，未命中进「其他」 */
  function cluster(rows) {
    const gNames = [], byGroup = new Map();
    for (const r of rows) {
      if (!byGroup.has(r.group_name)) { byGroup.set(r.group_name, []); gNames.push(r.group_name); }
      byGroup.get(r.group_name).push(r);
    }
    const out = [];
    for (const g of gNames) {
      const items = byGroup.get(g);
      const secs = SECTIONS[g];
      if (!secs) { out.push({ group: g, title: null, items }); continue; }
      const used = new Set();
      for (const sec of secs) {
        let sub = items.filter(r => !used.has(r.setting_key) && sec.prefixes.some(p => r.setting_key.startsWith(p)));
        if (sec.order) sub = [...sub].sort((a, b) => ordIdx(sec.order, a.setting_key) - ordIdx(sec.order, b.setting_key));
        if (sub.length) { sub.forEach(r => used.add(r.setting_key)); out.push({ group: g, title: sec.title, items: sub }); }
      }
      const rest = items.filter(r => !used.has(r.setting_key));
      if (rest.length) out.push({ group: g, title: '其他', items: rest });
    }
    return out;
  }

  const SCENE_LABELS = { inbound:'入库单', return:'退供单', loss:'报损单', recon:'对账单', count:'盘点单' };

  /** 默认值中文展示：布衣→开/关；枚举→中文 label；JSON 数组→人话描述（用户看不懂 true/["inbound"…]） */
  function fmtDefault(s) {
    const v = s.default_value;
    if (v === true || String(v) === 'true') return '开';
    if (v === false || String(v) === 'false') return '关';
    if (s.value_type === 'enum' && v !== null && v !== undefined) {
      const hit = (enumOpts(s).find(o => String(o.v) === String(v)) || {}).label;
      if (hit) return hit;
    }
    if (Array.isArray(v)) {
      if (s.setting_key === 'auth.sign_required_scenes') return v.map(x => SCENE_LABELS[x] || x).join('、') || '无';
      if (s.setting_key === 'stock.expiry_warn_days') return v.map(n => `提前 ${n} 天`).join('、');
      if (s.setting_key === 'promo.expiry_auto_discount')
        return v.length ? v.map(t => `临期≤${t.days}天按${t.pct}%`).join('、') : '未启用';
      if (s.setting_key === 'ops.emergency_pay') return v.length ? v.join('、') : '未启用';
      return JSON.stringify(v);
    }
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    let out = String(v ?? '');
    if (s.value_type === 'number' && s.unit) out += ' ' + s.unit; // V4.13.7 默认值后拼单位
    if ((s.setting_key === 'voice.tts.voice' || s.setting_key === 'pos.cashier.tts.voice') && !out) out = '自动（最佳中文声）'; // V4.13.8 / V4.21.2
    if ((s.setting_key === 'voice.tts.rate' || s.setting_key === 'pos.cashier.tts.rate') && !out) out = '跟随老板端'; // V4.21.2
    return out;
  }

  function draw(rows) {
    const secs = cluster(rows);
    const multi = new Set(rows.map(r => r.group_name)).size > 1; // 全部视图下加分组大标题
    let lastG = null;
    const body = secs.map(sec => {
      const gHead = multi && sec.group !== lastG
        ? `<tr class="grp-row" data-anchor="${esc(sec.group)}"><td colspan="4">🗂 ${esc(sec.group)}</td></tr>` : '';
      lastG = sec.group;
      const sHead = sec.title ? `<tr class="sec-row" data-anchor="${esc(sec.title)}"><td colspan="4">▸ ${esc(sec.title)}</td></tr>` : '';
      return gHead + sHead + sec.items.map(s => `<tr>
        <td><b>${esc(s.display_name)}</b></td>
        <td>${control(s)}<span class="saved-flash" data-flash="${esc(s.setting_key)}"></span></td>
        <td class="muted">${esc(fmtDefault(s))}</td>
        <td class="muted" style="max-width:260px">${esc(s.remark || '')}${isHq && s.scope === 'store'
          ? ` <button class="btn sm set-btn" data-push="${esc(s.setting_key)}" title="把此设置统一下发到指定门店（门店本地修改将被覆盖）">⤓ 下发</button>` : ''}</td>
      </tr>`).join('');
    }).join('');
    view.querySelector('#slist').innerHTML = rows.length ? `
      <table><thead><tr><th>设置项</th><th>当前值（行内修改）</th><th>默认值</th><th>说明</th></tr></thead>
      <tbody>${body}</tbody></table>` : '<div class="empty">无设置项</div>';

    // V4.26.3 长页面锚点导航：多分组视图按「分组」跳，单分组视图按「小节」跳（条目少于 2 节自动不加）
    anchorNav(view, { scope: '#slist', item: multi ? '.grp-row' : '.sec-row', refresh: true });

    // P2-6：总部统一下发门店级设置到指定门店
    view.querySelectorAll('[data-push]').forEach(btn => btn.onclick = () => pushToStores(btn.dataset.push));

    // 开关：切换即保存
    view.querySelectorAll('input[type=checkbox][data-key]').forEach(inp => {
      inp.onchange = async () => {
        await save(inp.dataset.key, inp.checked, inp.closest('td'));
      };
    });
    // 下拉：选择即保存
    view.querySelectorAll('select[data-key]').forEach(sel => {
      sel.onchange = async () => {
        await save(sel.dataset.key, sel.value, sel.closest('td'));
        await loadGroups(); // 回读刷新「当前」标签
      };
    });
    // V4.16.5 决策自动化分域下拉：任一变更 → 组装对象整体保存
    view.querySelectorAll('select[data-dm]').forEach(sel => {
      sel.onchange = async () => {
        const val = {};
        view.querySelectorAll('select[data-dm]').forEach(x => { val[x.dataset.dm] = x.value; });
        await save('ai.decision.modes', val, sel.closest('td'));
        await loadGroups();
      };
    });
    // V4.16.6 决策自动化成熟度门槛：数字输入失焦/回车 → 组装对象整体保存
    view.querySelectorAll('input[data-mt]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const val = {};
        view.querySelectorAll('input[data-mt]').forEach(x => { val[x.dataset.mt] = Number(x.value) || 0; });
        await save('ai.decision.maturity', val, inp.closest('td'));
        await loadGroups();
      });
    });
    // 输入框：回车或失焦保存（值变化才提交）
    view.querySelectorAll('input.set-val[data-key]').forEach(inp => {
      const orig = inp.value;
      const commit = async () => {
        if (inp.value === orig) return;
        let v = inp.value;
        if (inp.dataset.type === 'number') v = Number(v);
        else if (inp.dataset.type === 'json') { try { v = JSON.parse(v); } catch { toast('JSON 格式不合法', false); return; } }
        else if (inp.dataset.type === 'secret') { if (!v.trim()) { inp.value = ''; return; } v = v.trim(); } // 密钥留空 = 不修改
        await save(inp.dataset.key, v, inp.closest('td'));
        if (inp.dataset.type === 'secret') { inp.value = ''; await loadGroups(); } // 保存后刷新脱敏回显
      };
      inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
      inp.onblur = commit;
    });
    // JSON 文本域兜底：Ctrl+Enter 保存
    view.querySelectorAll('textarea[data-key]').forEach(ta => {
      ta.onkeydown = e => {
        if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'Tab') {
          e.preventDefault();
          try {
            const v = JSON.parse(ta.value);
            save(ta.dataset.key, v, ta.closest('td'));
          } catch { toast('JSON 格式不合法', false); }
        }
      };
    });
    // 结构化编辑器：保存 / 加档位 / 删档位
    view.querySelectorAll('[data-jsonsave]').forEach(btn => {
      btn.onclick = async () => {
        const key = btn.dataset.jsonsave;
        const box = btn.closest('td');
        const ed = JSON_EDITORS[key];
        if (!ed) return;
        await save(key, ed.collect(box), box);
        await loadGroups(); // 重绘回读值
      };
    });
    // V4.16.5 ② 节日表一键联网更新（公历+农历法定节日，当年+次年）
    const holiRow = view.querySelector('[data-key="ai.holiday.custom"]')?.closest('tr');
    if (holiRow) {
      const cell = holiRow.querySelector('td:nth-child(2)');
      const btn = document.createElement('button');
      btn.className = 'btn set-btn';
      btn.style.cssText = 'width:auto;padding:4px 12px;font-size:12px;margin-left:8px';
      btn.textContent = '🌐 一键联网更新';
      btn.title = '拉取当年+次年公历与农历法定节日（含春节/端午/中秋等农历日期），合并进上方节日表';
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '更新中…';
        try {
          const r = await must(post('/brain/holidays/sync', {}));
          toast(`已联网更新：拉取 ${r.fetched} 个节日，节日表现有 ${r.merged} 条（${(r.years || []).join('/')}）`, true);
          await loadGroups();
        } catch { /* must 已 toast */ }
        btn.disabled = false; btn.textContent = '🌐 一键联网更新';
      };
      cell.appendChild(btn);
    }
    // V4.16.5 ③ 天气-销量回归：沉淀状态 + 立即校准（每日刷新自动沉淀，此处手动触发）
    const wxRow = view.querySelector('[data-key^="ai.weather."]');
    if (wxRow) {
      const cell = wxRow.closest('tr').querySelector('td:nth-child(2)');
      const btn = document.createElement('button');
      btn.className = 'btn set-btn';
      btn.style.cssText = 'width:auto;padding:4px 12px;font-size:12px;margin-left:8px';
      btn.textContent = '🎓 立即校准天气回归';
      btn.title = '把本地天气与销量历史对齐回归（≥30 天自动生效），学习出的雨雪/高温/低温客流系数替代固定值';
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '校准中…';
        try {
          const r = await must(post('/brain/weather-calibrate', {}));
          toast(r.calibrated
            ? `✅ 已按本地 ${r.days} 天数据回归校准天气客流系数（雨/雪/高温/低温/平常）`
            : r.note, r.calibrated);
          await loadGroups();
        } catch { /* must 已 toast */ }
        btn.disabled = false; btn.textContent = '🎓 立即校准天气回归';
      };
      cell.appendChild(btn);
    }
    view.querySelectorAll('[data-tieradd]').forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.tieradd;
        const ed = JSON_EDITORS[key];
        const box = btn.closest('td');
        const cur = ed.collect(box);
        cur.push({ days: 0, pct: 90 });
        box.querySelector('[data-tierbox]').outerHTML = ed.tiersHTML(cur);
        toast('已加一档，记得点「保存」');
      };
    });
    // V4.21.2 整单折扣预设：加一档（折扣名空 + 90 折）
    view.querySelectorAll('[data-padd]').forEach(btn => {
      btn.onclick = () => {
        const ed = JSON_EDITORS[btn.dataset.padd];
        const box = btn.closest('td');
        const cur = ed.collect(box);
        cur.push({ name: '', rate: 90 });
        box.querySelector('[data-tierbox]').outerHTML = ed.rowsHTML(cur);
        toast('已加一档，记得点「保存」');
      };
    });
    // V4.21.2 客显轮播：加一条（空行）
    view.querySelectorAll('[data-aadd]').forEach(btn => {
      btn.onclick = () => {
        const ed = JSON_EDITORS[btn.dataset.aadd];
        const box = btn.closest('td');
        const cur = ed.collect(box);
        cur.push({ emoji: '', title: '', sub: '' });
        box.querySelector('[data-tierbox]').outerHTML = ed.rowsHTML(cur);
        toast('已加一条，记得点「保存」');
      };
    });
    view.querySelectorAll('[data-del]').forEach(x => {
      x.onclick = () => { x.closest('.tiers-row').remove(); toast('已删档，记得点「保存」'); };
    });
    // V4.13.8 音色试听（用当前下拉选中音色念一句，验证拟人效果）；V4.21.2 改行内取下拉（两处音色行共存）
    view.querySelectorAll('[data-voiceprev]').forEach(btn => {
      btn.onclick = () => {
        const sel = btn.closest('td').querySelector('select.voicesel');
        if (!sel || typeof speechSynthesis === 'undefined') { toast('本机不支持语音合成'); return; }
        try {
          speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance('您好，收款五十八元，找零两元，谢谢惠顾');
          u.lang = 'zh-CN';
          const v = speechSynthesis.getVoices().find(x => x.name === sel.value);
          if (v) u.voice = v;
          u.rate = 1.05;
          speechSynthesis.speak(u);
        } catch { toast('试听失败'); }
      };
    });
    // 音色列表异步就绪：首绘可能为空，就绪后重拉一次
    if (view.querySelector('.voicesel') && typeof speechSynthesis !== 'undefined' && !speechSynthesis.getVoices().length) {
      speechSynthesis.onvoiceschanged = () => { loadGroups(); };
    }
  }

  async function save(key, val, td) {
    try {
      await must(put(`/settings/${encodeURIComponent(key)}`, { value: val, reason: 'Web 后台行内修改' }), '');
      if (key === 'ui.glass.enabled') applyGlass(val);   // V4.26.3 玻璃开关即时生效，不用刷新页面
      const flash = td?.querySelector(`[data-flash="${CSS.escape(key)}"]`);
      if (flash) { flash.textContent = '已保存 ✓'; setTimeout(() => { flash.textContent = ''; }, 2000); }
      await loadChanges(chgPage);
      return true;
    } catch (e) {
      // V4.21.2：失败必须明示（原先静默回退，用户看像「开关设置后无法保存」）
      toast('保存失败：' + (e?.msg || e?.message || '请检查「系统设置」权限'), false);
      await refreshCur();
      return false;
    }
  }

  // ── P2-6：总部统一下发门店级设置 ──
  async function pushToStores(key) {
    const row = allRowsCache.find(s => s.setting_key === key);
    if (!row) return;
    let stores = [];
    try {
      const d = await must(get('/hq/stores?page=1&pageSize=200'));
      stores = (d.items || d.rows || []).filter(s => Number(s.status) === 1 && s.org_type !== 'hq');
    } catch { toast('门店列表获取失败（需总部身份）', false); return; }
    if (!stores.length) { toast('没有营业中的门店可下发', false); return; }
    const curVal = row.value === null || row.value === undefined ? '' : (typeof row.value === 'object' ? JSON.stringify(row.value) : String(row.value));
    const m = openDetailModal(`⤓ 下发设置：${esc(row.display_name)}`, `
      <div style="display:flex;flex-direction:column;gap:12px;padding:6px 10px 14px">
        <div><div class="muted" style="margin-bottom:4px">键</div><code class="set-key">${esc(key)}</code></div>
        <div><div class="muted" style="margin-bottom:4px">下发的值（可改）</div>
          <input id="psVal" class="inp" style="width:100%" value="${esc(curVal)}"></div>
        <div><div class="muted" style="margin-bottom:4px">目标门店</div>
          <div style="display:flex;gap:8px;margin-bottom:6px">
            <button class="btn sm" id="psAll">全选</button>
            <button class="btn sm" id="psNone">全不选</button>
            <span class="muted" style="font-size:12px;align-self:center">门店本地同键的修改将被覆盖；「恢复默认」= 清除门店覆盖值</span>
          </div>
          <div id="psStores" style="display:flex;gap:10px;flex-wrap:wrap;max-height:200px;overflow:auto;border:1px solid var(--line,#ddd);border-radius:8px;padding:8px">
            ${stores.map(s => `<label style="display:flex;gap:4px;align-items:center;font-size:13px"><input type="checkbox" value="${s.id}">${esc(s.name)}</label>`).join('')}
          </div></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" id="psClear" style="color:var(--bad,#c0392b)">恢复默认（清除门店覆盖）</button>
          <button class="btn pri" id="psGo">⤓ 下发到所选门店</button>
        </div>
      </div>`, { width: 560 });
    const picked = () => [...m.mask.querySelectorAll('#psStores input:checked')].map(x => Number(x.value));
    m.mask.querySelector('#psAll').onclick = () => m.mask.querySelectorAll('#psStores input').forEach(x => x.checked = true);
    m.mask.querySelector('#psNone').onclick = () => m.mask.querySelectorAll('#psStores input').forEach(x => x.checked = false);
    m.mask.querySelector('#psGo').onclick = async () => {
      const sids = picked();
      if (!sids.length) { toast('请先选择门店', false); return; }
      let v = m.mask.querySelector('#psVal').value;
      if (row.value_type === 'number') v = Number(v);
      else if (row.value_type === 'boolean') v = v === 'true';
      else if (row.value_type === 'json') { try { v = JSON.parse(v); } catch { toast('JSON 格式不合法', false); return; } }
      try {
        const r = await must(post('/hq/settings/push', { items: [{ key, value: v }], storeIds: sids }));
        toast(`已下发到 ${r?.stores ?? sids.length} 家门店 ✓`);
        m.close(); await loadGroups();
      } catch (e) { toast('下发失败：' + (e?.msg || e?.message || ''), false); }
    };
    m.mask.querySelector('#psClear').onclick = async () => {
      const sids = picked();
      if (!sids.length) { toast('请先选择门店', false); return; }
      if (!(await confirmBox({ title: '恢复默认', html: `确定清除所选 ${sids.length} 家门店的「${esc(row.display_name)}」覆盖值？门店将回落总部默认值。`, okText: '确定清除' }))) return;
      try {
        await must(post('/hq/settings/push/clear', { keys: [key], storeIds: sids }));
        toast('已清除门店覆盖 ✓'); m.close(); await loadGroups();
      } catch (e) { toast('清除失败：' + (e?.msg || e?.message || ''), false); }
    };
  }

  // ── 变更留痕：每页 10 条翻页 + 日期/操作人过滤（V4.14.0 ST2）──
  /** 把设置键翻译成 display_name（人话），回退显示原键 */
  const keyName = k => allRowsCache.find(s => s.setting_key === k)?.display_name || k;
  /** 变更值中文展示：布尔→开/关、空→空、对象→JSON 摘要、字符串去外层引号 */
  const fmtChange = v => {
    if (v === true || String(v) === 'true') return '开';
    if (v === false || String(v) === 'false') return '关';
    if (v === null || v === undefined || String(v).trim() === '') return '空';
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
    const s = String(v);
    return s.replace(/^"(.+)"$/, '$1').slice(0, 80);
  };

  async function loadChanges(page = 1) {
    const from = view.querySelector('#chgFrom')?.value || '';
    const to = view.querySelector('#chgTo')?.value || '';
    const op = encodeURIComponent(view.querySelector('#chgOp')?.value.trim() || '');
    const d = await must(get(`/settings/changes?page=${page}&pageSize=10&from=${from}&to=${to}&operator=${op}`)).catch(() => null);
    if (!d || !Array.isArray(d.rows)) { view.querySelector('#chg').innerHTML = '<div class="empty">无变更记录</div>'; return; }
    chgPage = d.page; chgPages = d.pages ?? 1; chgTotal = d.total ?? d.rows.length;
    view.querySelector('#chg').innerHTML = d.rows.length ? `
      <table style="table-layout:fixed;width:100%"><thead><tr>
        <th style="width:140px">时间</th>
        <th style="width:220px">设置项</th>
        <th>变更内容</th>
        <th style="width:110px">操作人</th>
      </tr></thead>
      <tbody>${d.rows.map(c => `<tr>
        <td>${dt(c.created_at)}</td>
        <td>
          <div style="font-weight:600;font-size:12.5px;word-break:break-all">${esc(keyName(c.setting_key))}</div>
          <div class="set-key" style="margin-top:2px">${esc(c.setting_key)}</div>
        </td>
        <td style="font-size:12px;line-height:1.55">
          <div style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="改前：${esc(fmtChange(c.old_value))}">
            <span class="muted">改前</span> ${esc(fmtChange(c.old_value))}</div>
          <div style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="改后：${esc(fmtChange(c.new_value))}">
            <span class="muted">改后</span> ${esc(fmtChange(c.new_value))}</div>
        </td>
        <td>${esc(c.operator_name || '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">无变更记录</div>';
    const pg = view.querySelector('#chgPager');
    pg.innerHTML = `
      <button class="btn" id="chgPrev" ${chgPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span style="display:flex;align-items:center;gap:4px;font-size:12.5px">第
        <input type="number" id="chgJump" min="1" max="${chgPages}" value="${chgPage}" style="width:52px;text-align:center;padding:2px 4px"> / ${chgPages} 页 · 共 ${chgTotal} 条</span>
      <button class="btn" id="chgNext" ${chgPage >= chgPages ? 'disabled' : ''}>下一页 ›</button>`;
    const prev = pg.querySelector('#chgPrev'), next = pg.querySelector('#chgNext');
    if (prev) prev.onclick = () => loadChanges(chgPage - 1);
    if (next) next.onclick = () => loadChanges(chgPage + 1);
    // V4.14.9 手输页码跳页
    const cj = pg.querySelector('#chgJump');
    const chgGo = () => {
      const p = Math.min(Math.max(1, Number(cj.value) || 1), chgPages);
      if (p !== chgPage) loadChanges(p);
    };
    cj.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); chgGo(); } });
    cj.addEventListener('change', chgGo);
  }

  // 留痕过滤按钮
  view.querySelector('#chgGo').onclick = () => loadChanges(1);
  view.querySelector('#chgReset').onclick = () => {
    view.querySelector('#chgFrom').value = ''; view.querySelector('#chgTo').value = ''; view.querySelector('#chgOp').value = '';
    loadChanges(1);
  };

  // ── 设置项搜索（V4.14.0 ST1：名称/键/当前值模糊，即输即查，跨分组） ──
  view.querySelector('#setKw').addEventListener('input', () => {
    const kw = view.querySelector('#setKw').value.trim().toLowerCase();
    const rows = allRowsCache.filter(s => !kw ||
      String(s.display_name || '').toLowerCase().includes(kw) ||
      String(s.setting_key || '').toLowerCase().includes(kw) ||
      String(s.value ?? '').toLowerCase().includes(kw));
    draw(rows);
  });
  view.querySelector('#setKwClear').onclick = () => {
    view.querySelector('#setKw').value = '';
    draw(allRowsCache.filter(s => !curGroup || s.group_name === curGroup));
  };

  await loadGroups();
  await loadChanges(1);
  renderInitCard();

  /* ── V4.14.6 会员 H5 入口二维码（复用后端 vendor 的 zxing，离线生成，无外网依赖）── */
  renderH5Card();

  function loadZxing() {
    return new Promise((res, rej) => {
      if (window.ZXing && window.ZXing.QRCodeWriter) return res();
      let s = document.querySelector('script[data-zxing]');
      if (!s) {
        s = document.createElement('script');
        s.src = API.base + '/pwa/vendor/zxing.min.js';
        s.dataset.zxing = '1';
        document.head.appendChild(s);
      }
      s.addEventListener('load', () => res());
      s.addEventListener('error', () => rej(new Error('二维码组件加载失败（检查后端服务）')));
    });
  }

  function drawQr(canvas, text) {
    const ZX = window.ZXing;
    const m = new ZX.QRCodeWriter().encode(text, ZX.BarcodeFormat.QR_CODE, 0, 0, new Map());
    const n = m.getWidth(), scale = Math.max(2, Math.floor(264 / n));
    canvas.width = canvas.height = n * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1a1a1a';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      if (m.get(x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
  }

  async function renderH5Card() {
    const card = view.querySelector('#h5Card');
    if (!card) return;   // V4.16.5：入口卡元素已随版式调整移除，无元素时跳过（不再抛 TypeError）
    card.style.display = '';
    const urlInp = view.querySelector('#h5Url');
    const tip = view.querySelector('#h5Tip');
    const qr = view.querySelector('#h5Qr');
    // V4.14.8：入口地址默认取设置 member.h5.entry_url（营销与线上 ▸ 会员 H5 门户）→ 本地记忆 → 当前服务器
    if (!urlInp.value) {
      const row = (allRowsCache || []).find(s => s.setting_key === 'member.h5.entry_url');
      const cfg = String(row?.value ?? '').replace(/^"|"$/g, '');
      urlInp.value = cfg || localStorage.getItem('h5_entry_url') || (API.base + '/member/');
    }
    const regen = async () => {
      const url = urlInp.value.trim();
      if (!url) return tip.textContent = '请填写 H5 地址';
      try { await loadZxing(); drawQr(qr, url); tip.textContent = ''; localStorage.setItem('h5_entry_url', url); }
      catch (e) { tip.textContent = e.message; }
      // V4.14.8：有权限则回写设置 member.h5.entry_url（首页快捷入口同步使用）
      try { await put('/settings/member.h5.entry_url', { value: url }); } catch { /* 无权限静默 */ }
    };
    await regen();
    view.querySelector('#h5Refresh').onclick = regen;
    urlInp.onkeydown = e => { if (e.key === 'Enter') regen(); };
    view.querySelector('#h5Copy').onclick = async () => {
      try { await navigator.clipboard.writeText(urlInp.value.trim()); toast('已复制'); }
      catch { tip.textContent = '复制失败，请手动选择地址复制'; }
    };
    view.querySelector('#h5Download').onclick = () => {
      if (!qr.width) return tip.textContent = '二维码未生成';
      const a = document.createElement('a');
      a.href = qr.toDataURL('image/png');
      a.download = '会员H5入口二维码.png';
      a.click();
    };
    tip.title = '提示：默认地址是管理后台连的后端；会员手机要能访问，请改成局域网/外网可达的地址（如 https://门店IP:3443/member/）';
  }

  /* ── V4.14.5 开业初始化一键执行（V4.14.0 遗留#3：接 V4.12 admin.reset）
     V4.14.8：仅「系统初始化」页签显示，排在「设置项」下
     V4.16.4：状态变量上移到 render 顶部声明区（原在此处声明，79/530 行先于声明调用触发 TDZ 报错） ── */
  function syncInitCard() {
    view.querySelector('#initCard').style.display = (initPermOk && curGroup === '系统初始化') ? '' : 'none';
    if (initPermOk && curGroup === '系统初始化' && !initLoaded) { initLoaded = true; loadInitPreview(); }
  }
  function renderInitCard() {
    const perms = API.user?.perms || [];
    if (!perms.includes('sys.data.backup') && !perms.includes('*')) return; // 无权限不显示
    initPermOk = true;
    syncInitCard();
  }

  async function loadInitPreview() {
    const body = view.querySelector('#initBody');
    try {
      const p = await must(get('/admin/reset/preview'));
      // V4.25.2：面向普通用户的模块化风险提示（不再罗列具体表名/行数）
      const MODULE_TIPS = {
        '交易与结算': '销售单、收款退款、交接班流水、挂单等经营流水会被清空',
        '库存与单据': '入库/退货/盘点/调拨/损耗等库存流水会被清空',
        '会员与分红': '会员账户流水、积分、分红记录等会被清空（会员档案可选保留）',
        '供应商往来': '对账单、供应商费用、代销结算等往来记录会被清空',
        'AI 数据': 'AI 识别日志、建议、训练样本等会被清空',
        '操作日志': '系统操作记录、设置变更留痕会被清空',
      };
      const totalRows = (p.groups || []).reduce((s, g) => s + (g.tables || []).reduce((t, r) => t + (Number(r.n) || 0), 0), 0);
      const hasDataGroups = (p.groups || []).filter(g => (g.tables || []).reduce((s, t) => s + (Number(t.n) || 0), 0) > 0);
      const emptyGroups = (p.groups || []).filter(g => (g.tables || []).reduce((s, t) => s + (Number(t.n) || 0), 0) === 0);
      const keepList = (p.keepAlways || []).map(t => ({
        name: t.name, n: t.n,
        cn: ({ stores: '门店信息', employees: '员工账号', roles: '角色定义', permission_points: '权限点',
          role_permissions: '角色权限配置', employee_roles: '员工角色分配', system_settings: '系统设置',
          ai_models: 'AI 模型' })[t.name] || t.name,
      }));
      body.innerHTML = `
        <div class="banner" style="background:#fff3f0;border:1px solid #f5c6c0;border-radius:10px;padding:14px;font-size:13px;color:#7c1f14;line-height:1.7">
          <div style="font-weight:700;margin-bottom:6px">⚠️ 危险操作，请谨慎</div>
          <div>点击「执行初始化」后，系统会把下面勾选的<b>业务数据清空，且无法恢复</b>。此功能只建议在开业前清理演练数据，或二次开业时使用。</div>
          <div style="margin-top:6px">✅ 员工账号、角色权限、系统设置、商品条码缓存会始终保留，不会被清空。</div>
        </div>

        <div style="margin:16px 0 10px;display:flex;align-items:center;gap:10px">
          <b style="font-size:14px">🗑️ 将清空的业务模块</b>
          <span class="muted" style="font-size:12px">共涉及 ${hasDataGroups.length} 个模块</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:14px">
          ${hasDataGroups.map(g => {
            const tip = MODULE_TIPS[g.label] || '该模块下的业务记录会被清空';
            return `<div style="border:1px solid var(--line,#e8e4d8);border-radius:10px;padding:14px;background:#fff">
              <div style="font-weight:700;font-size:13px;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <span style="color:#c62828">●</span>
                <span>${esc(g.label)}</span>
                <span class="tag warn" style="margin-left:auto;font-size:11px">有数据</span>
              </div>
              <div style="font-size:12.5px;line-height:1.7;color:#555">${esc(tip)}</div>
            </div>`;
          }).join('')}
          ${emptyGroups.map(g => {
            const tip = MODULE_TIPS[g.label] || '该模块暂无业务记录';
            return `<div style="border:1px dashed var(--line,#e8e4d8);border-radius:10px;padding:14px;background:#faf9f5;opacity:.85">
              <div style="font-weight:700;font-size:13px;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <span style="color:#999">●</span>
                <span>${esc(g.label)}</span>
                <span class="tag" style="margin-left:auto;font-size:11px">暂无数据</span>
              </div>
              <div style="font-size:12.5px;line-height:1.7;color:#777">${esc(tip)}</div>
            </div>`;
          }).join('')}
        </div>

        <div style="border:1px solid #c8e6c9;border-radius:10px;padding:14px;background:#f1f8e9;margin-bottom:14px">
          <div style="font-weight:700;font-size:13px;color:#2e7d32;margin-bottom:4px">✅ 这些档案默认保留（取消勾选 = 初始化时一并清空）</div>
          <div style="font-size:12.5px;color:#777;margin-bottom:8px">⚠️ 员工账号被清空后将无法登录，需重新引导创建管理员，请谨慎操作。</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px 18px">
            ${keepList.map(t => `<label style="display:flex;gap:5px;align-items:center;font-size:13px;cursor:pointer" title="${t.n} 行">
              <input type="checkbox" class="init-keep" value="${esc(t.name)}" checked>
              <span>${esc(t.cn)}${t.n ? ` <span class="muted" style="font-size:11px">(${t.n})</span>` : ''}</span></label>`).join('')}
          </div>
        </div>

        <div style="border:1px solid var(--line,#e8e4d8);border-radius:10px;padding:14px;background:#faf9f5;margin-bottom:14px">
          <div style="font-weight:700;font-size:13px;margin-bottom:10px">⚙️ 清空范围</div>
          <div class="bar" style="flex-wrap:wrap;gap:14px">
            <label style="display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer">
              <input type="radio" name="initMode" value="keep-master" checked>
              <span>保留基础档案：商品、供应商、会员、客户</span></label>
            <label style="display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer">
              <input type="radio" name="initMode" value="full">
              <span>出厂全清：连基础档案一起清空</span></label>
          </div>
          <label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-top:10px;cursor:pointer">
            <input type="checkbox" id="initDevices">
            <span>同时清空设备与模板配置</span></label>
        </div>

        <div class="bar" style="gap:10px">
          <input id="initConfirm" placeholder='请输入「初始化」三个字确认执行' style="flex:1;min-width:200px">
          <button class="btn danger" id="initGo">🏗️ 执行初始化</button>
        </div>`;
      body.querySelector('#initGo').onclick = async () => {
        const mode = body.querySelector('input[name=initMode]:checked')?.value || 'keep-master';
        const confirmText = body.querySelector('#initConfirm').value.trim();
        const clearDevices = body.querySelector('#initDevices').checked;
        // V4.25.2：保留清单未勾选的 = 要一并清空的骨架表（如清空员工账号/角色）
        const clearKeep = [...body.querySelectorAll('.init-keep')].filter(c => !c.checked).map(c => c.value);
        if (confirmText !== '初始化') return toast('请先在输入框输入「初始化」确认', false);
        const ok = await confirmBox({ title: '最终确认 · 不可恢复', okText: '确认清空', okClass: 'danger',
          html: `即将按 <b>${mode === 'full' ? '出厂全清（含基础档案）' : '保留基础档案'}</b> 模式清空业务数据${clearDevices ? '，<b>并清空设备与模板配置</b>' : ''}${clearKeep.length ? `。<br><span style="color:#c62828">同时清空已取消勾选的档案：${esc(clearKeep.join('、'))}</span>` : ''}。<br>
                 <span class="muted">清空后所有销售/库存流水不可恢复，请确认已完成数据备份。</span>` });
        if (!ok) return;
        try {
          await must(post('/admin/reset/execute', { mode, clearDevices, clearKeep, confirm: '初始化' }));
          toast('✅ 初始化完成'); loadInitPreview();
        } catch (e) { toast(e.msg || e.message || '初始化失败', false); }
      };
    } catch (e) {
      body.innerHTML = `<div class="muted" style="padding:6px 0">预览加载失败：${esc(e.msg || e.message || '')}</div>`;
    }
  }
}
