import { get, post, put, del, must, esc, dt, toast, API } from '../api.js';
import { printDocs, canPrintA5 } from '../docprint.js';
import { paginate, bindPager } from '../common-ui.js';
import { mountLayoutEditor } from '../layout-editor.js';

/** 打印中心（9.9）：打印机管理 / 设备健康看板 / 打印模板编辑器（字段显隐+排序+联次+预览试打+导入导出） */
const KIND_ICON = {
  '收银主机': '🖥️', '扫码枪': '🔫', '电子秤': '⚖️', 'AI秤摄像头': '🤖',
  '小票机': '🧾', '副屏': '🖥️', '钱箱': '💵', '人脸设备': '👤',
};
const KIND_ORDER = ['收银主机', '扫码枪', '电子秤', 'AI秤摄像头', '小票机', '副屏', '钱箱', '人脸设备'];
const TPL_ORDER = ['小票58', '小票80', 'A5单据', 'A4单据', '标签'];
const BIZ_CN = {
  receipt: '收银小票', inbound: '采购入库', return: '采购退货', order: '采购订货', transfer: '库存调拨',
  count: '盘点', loss: '报损', recon: '对账', settlement: '结算',
  pricetag: '价签', scale: '秤贴',
};
const ST = { 在线: ['g', '在线'], 离线: ['', '离线'], 故障: ['r', '故障'] };
// V5.0.4：默认用途维度（每业务一个默认机，打对应单据自动路由）
const DF_CN = { receipt: '小票', pricetag: '价签', scale: '秤贴', a5: '单据' };
const DF_OPTIONS = {
  '小票': [['receipt', '小票（收银出单）']],
  '标签': [['pricetag', '价签'], ['scale', '秤贴']],
  '激光': [['a5', 'A5/单据（激光·喷墨）']],
};
let curPage = 1;   // V4.16.5 打印历史当前页码（翻页不重请求，重查时归 1）

export async function render(view) {
  const canDev = () => (API.user?.perms || []).includes('device.manage');
  const canPr = () => (API.user?.perms || []).includes('printer.manage');
  const canTpl = () => (API.user?.perms || []).includes('print.template');

  view.innerHTML = `
    <style>
      .plist { display:flex; flex-direction:column; gap:6px; }
      .plist .it { display:flex; justify-content:space-between; align-items:center; gap:8px;
        padding:7px 10px; border:1px solid var(--line,#e5e2da); border-radius:8px; cursor:pointer; background:#fff; }
      .plist .it.on { border-color:var(--pri,#20663f); background:#f0f7f0; }
      .plist .it small { color:var(--muted,#8a8577); }
      .tpl-editor { display:grid; gap:10px; }
      .tpl-editor .fld-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .chk { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line,#e5e2da);
        border-radius:6px; padding:4px 9px; background:#fff; font-size:12.5px; cursor:pointer; user-select:none; }
      .chk input { accent-color: var(--pri,#20663f); }
      .tpl-pre { background:#1c2128; color:#d8e0ea; font-family:Consolas,monospace; font-size:11.5px;
        line-height:1.45; padding:12px; border-radius:8px; white-space:pre; overflow:auto; max-height:420px; }
      .health-k { display:flex; gap:8px; flex-wrap:wrap; }
      .health-k .hk { flex:1; min-width:110px; border:1px solid var(--line,#e5e2da); border-radius:10px;
        padding:10px 12px; background:#fff; text-align:center; }
      .health-k .hk b { font-size:18px; display:block; margin-top:2px; }
    </style>
    <div class="bar" id="pTabs"></div>
    <div id="pBody"></div>`;

  let tab = 'printer';
  const TABS = [['printer', '🖨️ 打印机'], ['device', '📟 设备管理'], ['template', '📄 打印模板']];

  function tabBar() {
    view.querySelector('#pTabs').innerHTML = TABS.map(([k, t]) =>
      `<button class="btn ${k === tab ? 'pri' : ''}" data-t="${k}">${t}</button>`).join('');
    view.querySelectorAll('#pTabs [data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; tabBar(); draw(); });
  }

  /** Tab 分发渲染 */
  async function draw() {
    const body = view.querySelector('#pBody');
    body.innerHTML = '<div class="empty">加载中…</div>';
    if (tab === 'printer') await drawPrinters(body);
    else if (tab === 'device') await drawDevices(body);
    else await drawTemplates(body);
  }

  function modal(html, width = 520) {
    const m = document.createElement('div');
    m.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99;display:flex;align-items:center;justify-content:center;`;
    m.innerHTML = `<div style="background:#fff;border-radius:12px;padding:18px 20px;width:${width}px;max-width:92vw;max-height:84vh;overflow:auto">
      ${html}</div>`;
    m.onclick = e => { if (e.target === m) m.remove(); };
    document.body.appendChild(m);
    return m;
  }

  /** 设/改默认用途（每业务一个默认机） */
  function openDefaultFor(body, id) {
    const p = (state.printerRows || []).find(x => Number(x.id) === id) || {};
    const type = p.printer_type || '小票';
    const opts = DF_OPTIONS[type] || DF_OPTIONS['小票'];
    const m = modal(`<h3 style="margin:0 0 10px">设默认用途 · ${esc(p.name || '')}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:8px">不同用途各可设一台默认机：打对应单据时自动路由，免去每次手动选机。</div>
      <div style="display:flex;flex-direction:column;gap:8px">${opts.map(([v, t]) =>
        `<button class="btn ${p.default_for === v ? 'pri' : ''}" data-set="${v}">${t}${p.default_for === v ? ' ✓' : ''}</button>`).join('')}
        ${p.is_default ? `<button class="btn r" data-clear="1">取消默认</button>` : ''}</div>
      <div style="text-align:right;margin-top:14px"><button class="btn" id="dfCancel">关闭</button></div>`);
    m.querySelectorAll('[data-set]').forEach(b => b.onclick = async () => {
      await must(put(`/printers/${id}/default`, { defaultFor: b.dataset.set }), `已设为默认·${DF_CN[b.dataset.set] || b.dataset.set}`);
      m.remove(); drawPrinters(body);
    });
    const clr = m.querySelector('[data-clear]');
    if (clr) clr.onclick = async () => { await must(put(`/printers/${id}/default`, { defaultFor: '' }), '已取消默认'); m.remove(); drawPrinters(body); };
    m.querySelector('#dfCancel').onclick = () => m.remove();
  }

  // ═══════════ 打印机 Tab ═══════════
  async function drawPrinters(body) {
    const [ps, jobs] = await Promise.all([
      must(get('/printers')), must(get('/print-jobs?limit=20')).catch(() => []),
    ]);
    const st = x => { const [c, t] = ST[x] || ['', x]; return `<span class="pill ${c}">${t}</span>`; };
    body.innerHTML = `
      <div class="card"><h3>打印机管理 </h3>
        <div style="text-align:right;margin:0 0 8px">
          ${canPr() ? `<button class="btn pri" id="pAdd">＋ 新增打印机</button>` : ''}</div>
        <table><thead><tr><th class="seq">序号</th><th>名称</th><th>品牌</th><th>类型</th><th>连接</th><th>纸宽/纸型</th><th>自动重连</th><th>状态</th><th>最近测试</th><th style="width:230px">操作</th></tr></thead>
        <tbody>${ps.length ? ps.map((p, i) => `<tr>
          <td class="num seq">${i + 1}</td><td><b>${esc(p.name)}</b>${p.is_default && p.default_for ? ` <span class="pill b">默认·${DF_CN[p.default_for] || p.default_for}</span>` : ''}</td>
          <td class="muted">${esc(p.brand || '通用')}</td>
          <td>${p.printer_type === '激光' ? '🖨️ 激光' : (p.printer_type || '小票') === '标签' ? '🏷️ 标签机' : '🧾 小票机'}</td>
          <td class="muted">${esc(p.conn_type)}${p.conn_addr ? ' · ' + esc(p.conn_addr) : ''}</td>
          <td class="num">${(p.printer_type || '小票') === '标签' ? esc(p.label_size || '40x30') : p.width_mm + 'mm'}</td>
          <td>${p.auto_reconnect ? '✅' : '—'}</td>
          <td>${st(p.status)}</td>
          <td class="muted">${p.last_test_at ? dt(p.last_test_at) : '—'}</td>
          <td class="ops">
            ${canPr() ? `<button class="btn sm pri" data-test="${p.id}">测试页</button>
              <button class="btn sm" data-def="${p.id}">${p.is_default ? '改默认' : '设默认'}</button>
              <button class="btn sm" data-edit="${p.id}">编辑</button>
              <button class="btn sm r" data-del="${p.id}">删除</button>` : '<span class="muted">无权限</span>'}
          </td></tr>`).join('') : `<tr><td colspan="10" class="empty">暂无打印机，点击右上角新增</td></tr>`}
        </tbody></table></div>
      <div class="card"><h3>打印历史 </h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px" id="pjFilter">
          <select id="pjBiz" style="width:110px"><option value="">全部业务</option>${Object.entries(BIZ_CN).map(([k, v2]) => `<option value="${k}">${v2}</option>`).join('')}</select>
          <select id="pjJob" style="width:110px"><option value="">全部类型</option><option>打印</option><option>测试页</option><option>A5打印</option><option>价签打印</option><option>秤贴</option><option>弹箱</option></select>
          <select id="pjSt" style="width:90px"><option value="">全部状态</option><option>成功</option><option>失败</option></select>
          <input id="pjQ" placeholder="单号/内容搜索" style="width:150px">
          <button class="btn sm" id="pjGo">🔍 查询</button>
        </div>
        <div id="pjBox" class="tbl-min"></div></div>`;

    // V4.16.5 打印历史分页（10 条/页）：翻页用最后加载的全量数组重画，不重新请求
    let lastJobs = [];
    const drawJobs = (rows, resetPage = false) => {
      if (resetPage) curPage = 1;
      lastJobs = rows;
      const pg = paginate(rows, curPage, 10);
      curPage = pg.page;
      const box = body.querySelector('#pjBox');
      box.innerHTML = `<table><thead><tr><th class="seq">序号</th><th>类型</th><th>打印机</th><th>模板</th><th>业务</th><th>单号</th><th>状态</th><th>耗时</th><th>时间</th><th>操作人</th><th style="width:80px">操作</th></tr></thead>
        <tbody>${rows.length ? pg.slice.map((j, i) => {
          const jobTxt = j.job_type === '测试页' ? '🧪 测试页' : j.job_type === 'A5打印' ? '📄 A5打印'
            : j.job_type === '弹箱' ? '💵 弹箱' : j.job_type === '重打' ? '🖨️ 重打' : '🖨️ ' + esc(j.job_type || '打印');
          const canRe = j.job_type === 'A5打印' && j.biz_id && ['inbound', 'return', 'order', 'loss', 'count', 'transfer', 'recon'].includes(j.biz_type) && canPrintA5();
          return `<tr>
          <td class="num seq">${(curPage - 1) * 10 + i + 1}</td><td>${jobTxt}</td>
          <td>${esc(j.printer_name)}</td>
          <td>${esc(j.template_name || '—')}</td>
          <td class="muted">${BIZ_CN[j.biz_type] || esc(j.biz_type || '—')}</td>
          <td class="muted" style="font-family:var(--mono,monospace)">${esc(j.biz_no || '—')}</td>
          <td>${j.status === '成功' ? '<span class="pill g">成功</span>' : '<span class="pill r">失败</span>'}</td>
          <td class="num">${j.cost_ms ?? 0}ms</td>
          <td class="muted">${dt(j.created_at)}</td>
          <td>${esc(j.operator_name || '—')}</td>
          <td>${canRe ? `<button class="btn sm" data-reprint="${j.biz_type}|${j.biz_id}" title="重新调起浏览器打印（留痕标「重打」）">重打</button>` : ''}</td></tr>`;
        }).join('') : `<tr><td colspan="10" class="empty">暂无打印记录</td></tr>`}
        </tbody></table>${rows.length ? pg.bar : ''}`;
      body.querySelectorAll('[data-reprint]').forEach(b => b.onclick = async () => {
        const [bt, bid] = b.dataset.reprint.split('|');
        await printDocs(bt, [Number(bid)], 1, '重打');
      });
      bindPager(box, p => { curPage = p; drawJobs(lastJobs); });
    };
    drawJobs(jobs, true);
    const loadJobs = async () => {
      const p = new URLSearchParams({ limit: '50' });
      const biz = body.querySelector('#pjBiz').value, job = body.querySelector('#pjJob').value;
      const stv = body.querySelector('#pjSt').value, q = body.querySelector('#pjQ').value.trim();
      if (biz) p.set('bizType', biz);
      if (job) p.set('jobType', job);
      if (stv) p.set('status', stv);
      if (q) p.set('q', q);
      try { drawJobs(await must(get('/print-jobs?' + p.toString())), true); }
      catch (e) { toast(e.message, false); }
    };
    body.querySelector('#pjGo').onclick = loadJobs;
    body.querySelector('#pjQ').onkeydown = e => { if (e.key === 'Enter') loadJobs(); };

    if (canPr()) {
      body.querySelector('#pAdd').onclick = () => openPrinter(body, null);
      body.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
        await must(post(`/printers/${b.dataset.test}/test`), '测试页打印成功');
        drawPrinters(body);
      });
      body.querySelectorAll('[data-def]').forEach(b => b.onclick = () => openDefaultFor(body, Number(b.dataset.def)));
      body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openPrinter(body, Number(b.dataset.edit)));
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('确认删除该打印机？历史记录将保留。')) return;
        await must(del(`/printers/${b.dataset.del}`), '已删除');
        drawPrinters(body);
      });
    }
  }

  function openPrinter(body, id) {
    const ps = state.printerRows || [];
    const cur = ps.find(p => Number(p.id) === id) || {};
    const curType = cur.printer_type || '小票';
    const m = modal(`
      <h3 style="margin:0 0 12px">${id ? '编辑打印机' : '新增打印机'}</h3>
      <div class="fld" style="flex-direction:column;align-items:flex-start;gap:3px"><label style="min-width:0;text-align:left">名称</label>
        <input id="pfName" value="${esc(cur.name || '')}" placeholder="如：前台小票机" style="width:100%">
        <div class="muted" style="font-size:11px">用于区分用途，如：前台小票机 / 价签标签机 …</div></div>
      <div class="fld"><label>设备类型</label>
        <select id="pfType">${['小票', '标签', '激光'].map(t =>
          `<option value="${t}" ${curType === t ? 'selected' : ''}>${t === '小票' ? '小票机（ESC/POS 卷纸）' : t === '标签' ? '标签机（TSPL/ZPL 价签·秤贴）' : '激光/喷墨（A5 单据·本地打印）'}</option>`).join('')}</select></div>
      <div class="fld"><label>连接方式</label>
        <select id="pfConn">${['USB', '网口', '蓝牙', '串口'].map(c =>
          `<option ${cur.conn_type === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="fld" style="flex-direction:column;align-items:flex-start;gap:3px"><label style="min-width:0;text-align:left">连接地址</label>
        <input id="pfAddr" value="${esc(cur.conn_addr || '')}" placeholder="如：192.168.1.50:9100" style="width:100%">
        <div class="muted" style="font-size:11px">网口填 IP:port（如 192.168.1.50:9100）；串口/USB 可留空</div></div>
      <div class="fld" style="flex-direction:column;align-items:flex-start;gap:3px"><label style="min-width:0;text-align:left">品牌</label>
        <select id="pfBrand" style="width:100%">${['芯烨', '佳博', '得力', '爱普生', '汉印', 'TSC', '斑马', '通用'].map(b =>
          `<option ${(cur.brand || '通用') === b ? 'selected' : ''}>${b}</option>`).join('')}</select>
        <div class="muted" style="font-size:11px">通用适配：芯烨/佳博/得力/爱普生=ESC/POS；汉印/佳博/TSC=TSPL、斑马=ZPL</div></div>
      <div class="fld" id="pfWidthRow"><label>纸宽</label>
        <select id="pfWidth">${[58, 80].map(w => `<option value="${w}" ${Number(cur.width_mm || 80) === w ? 'selected' : ''}>${w}mm</option>`).join('')}</select></div>
      <div class="fld" id="pfLabelRow" style="display:none"><label>标签纸型（价签/秤贴）</label>
        <select id="pfLabel">${['40x30', '50x30', '60x40', '70x38', '90x50'].map(s =>
          `<option ${(cur.label_size || '40x30') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="fld"><label>自动重连</label>
        <select id="pfReconn"><option value="1" ${cur.auto_reconnect !== false ? 'selected' : ''}>开（断电恢复自动连）</option>
        <option value="0" ${cur.auto_reconnect === false ? 'selected' : ''}>关</option></select></div>
      <div class="fld" id="pfDefRow"><label>默认用途</label>
        <select id="pfDef"><option value="">非默认</option>${(DF_OPTIONS[curType] || DF_OPTIONS['小票']).map(([v, t]) =>
          `<option value="${v}" ${cur.default_for === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <div class="muted" style="font-size:11px">设为某用途默认机后，打该业务单据自动路由到本机，免去每次选机</div></div>
      <div style="text-align:right;margin-top:14px">
        <button class="btn" id="pfCancel">取消</button>
        <button class="btn pri" id="pfSave">保存</button></div>`);
    const syncType = () => {
      const t = m.querySelector('#pfType').value;
      const isLabel = t === '标签';
      const isLaser = t === '激光';
      m.querySelector('#pfWidthRow').style.display = (isLabel || isLaser) ? 'none' : '';
      m.querySelector('#pfLabelRow').style.display = isLabel ? '' : 'none';
    };
    m.querySelector('#pfType').onchange = syncType;
    syncType();
    m.querySelector('#pfCancel').onclick = () => m.remove();
    m.querySelector('#pfSave').onclick = async () => {
      const isLabel = m.querySelector('#pfType').value === '标签';
      const dto = {
        name: m.querySelector('#pfName').value.trim(),
        printerType: m.querySelector('#pfType').value,
        connType: m.querySelector('#pfConn').value,
        connAddr: m.querySelector('#pfAddr').value.trim(),
        brand: m.querySelector('#pfBrand').value,
        widthMm: isLabel ? undefined : Number(m.querySelector('#pfWidth').value),
        labelSize: isLabel ? m.querySelector('#pfLabel').value : undefined,
        autoReconnect: m.querySelector('#pfReconn').value === '1',
      };
      if (!dto.name) { toast('请填写打印机名称', false); return; }
      if (dto.connType === '网口' && !/^[0-9a-zA-Z.\-]+:\d{1,5}$/.test(dto.connAddr)) {
        toast('网口连接地址格式须为 IP:端口（如 192.168.1.50:9100）', false); return;
      }
      if (id) await must(put(`/printers/${id}`, dto), '已保存');
      else await must(post('/printers', dto), '已新增');
      // V5.0.4：默认用途变更单独同步（后端 setDefault 保证每业务唯一）
      const newDf = m.querySelector('#pfDef').value;
      if (id && newDf !== (cur.default_for || '')) {
        await must(put(`/printers/${id}/default`, { defaultFor: newDf }), newDf ? `已设为默认·${DF_CN[newDf] || newDf}` : '已取消默认');
      }
      m.remove();
      drawPrinters(body);
    };
  }

  // ═══════════ 设备 Tab ═══════════
  async function drawDevices(body) {
    const [health, devs] = await Promise.all([
      must(get('/devices/health')).catch(() => ({ kinds: [], total: 0, online: 0 })),
      must(get('/devices')),
    ]);
    state.deviceRows = devs;
    const idle = d => d.last_heartbeat
      ? (d.idle_sec < 60 ? '刚刚' : `${Math.round(d.idle_sec / 60)} 分钟前`)
      : '从未心跳';
    body.innerHTML = `
      <div class="card"><h3>设备健康看板 </h3>
        <div style="text-align:right;margin:0 0 10px">
          ${canDev() ? `<button class="btn" id="dSelf">🔍 一键自检</button>
            <button class="btn pri" id="dAdd">＋ 新增设备</button>` : ''}</div>
        <div class="health-k">
          <div class="hk" style="background:#f0f7f0;border-color:#bcd8c4"><span class="muted">设备总数</span><b>${health.total}</b></div>
          <div class="hk" style="background:#eef4ff;border-color:#c3d6f5"><span class="muted">在线</span><b style="color:var(--pri,#20663f)">${health.online}</b></div>
          <div class="hk" style="background:#f8f6f0;border-color:#e4dcc2"><span class="muted">在线率</span><b>${health.offlineRate}%</b></div>
          ${(health.kinds || []).map(k => `<div class="hk"><span class="muted">${KIND_ICON[k.kind] || '📟'} ${esc(k.kind)}</span>
            <b>${k.online}<small class="muted">/${k.total}</small></b></div>`).join('')}
        </div></div>
      <div class="card"><h3>设备档案</h3>
        <table><thead><tr><th class="seq">序号</th><th>设备</th><th>类型</th><th>型号</th><th>连接</th><th>绑定收银台</th><th>状态</th><th>心跳</th><th style="width:150px">操作</th></tr></thead>
        <tbody>${devs.length ? devs.map((d, i) => `<tr>
          <td class="num seq">${i + 1}</td><td><b>${KIND_ICON[d.kind] || ''} ${esc(d.name)}</b></td>
          <td class="muted">${esc(d.kind)}</td>
          <td class="muted">${esc(d.model || '—')}</td>
          <td class="muted">${esc(d.conn_type || '—')}${d.conn_addr ? ` · ${esc(d.conn_addr)}` : ''}</td>
          <td>${esc(d.bound_pos || '—')}</td>
          <td>${(() => { const [c, t] = ST[d.status] || ['', d.status]; return `<span class="pill ${c}">${t}</span>`; })()}</td>
          <td class="muted">${idle(d)}</td>
          <td class="ops">${canDev() ? `<button class="btn sm" data-edit="${d.id}">编辑</button>
            <button class="btn sm r" data-del="${d.id}">删除</button>` : '<span class="muted">无权限</span>'}</td>
        </tr>`).join('') : `<tr><td colspan="9" class="empty">暂无设备档案，点击右上角新增</td></tr>`}
        </tbody></table></div>`;

    if (canDev()) {
      body.querySelector('#dAdd').onclick = () => openDevice(body, null);
      body.querySelector('#dSelf').onclick = async () => {
        const r = await must(post('/devices/self-test'), '自检完成');
        if (r.failed) toast(`${r.failed} 台设备故障`, false);
        drawDevices(body);
      };
      body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openDevice(body, Number(b.dataset.edit)));
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('确认删除该设备档案？')) return;
        await must(del(`/devices/${b.dataset.del}`), '已删除');
        drawDevices(body);
      });
    }
  }

  function openDevice(body, id) {
    const cur = (state.deviceRows || []).find(d => Number(d.id) === id) || {};
    const m = modal(`
      <h3 style="margin:0 0 12px">${id ? '编辑设备' : '新增设备'}</h3>
      <div class="fld"><label>设备名称</label><input id="dfName" value="${esc(cur.name || '')}" placeholder="如：1号收银秤"></div>
      <div class="fld"><label>设备类型</label>
        <select id="dfKind">${KIND_ORDER.map(k => `<option ${cur.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="fld"><label>型号</label><input id="dfModel" value="${esc(cur.model || '')}" placeholder="如：大华 AI-BX58"></div>
      <div class="fld"><label>连接方式</label>
        <select id="dfConn">${['USB', '网口', '蓝牙', '串口'].map(c =>
          `<option ${cur.conn_type === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="fld"><label>连接地址（IP:port / COM口 / MAC）</label>
        <input id="dfAddr" value="${esc(cur.conn_addr || '')}" placeholder="网口自检将做 TCP 探测"></div>
      <div class="fld"><label>绑定收银台</label><input id="dfPos" value="${esc(cur.bound_pos || '')}" placeholder="如：POS-01"></div>
      <div style="text-align:right;margin-top:14px">
        <button class="btn" id="dfCancel">取消</button>
        <button class="btn pri" id="dfSave">保存</button></div>`);
    m.querySelector('#dfCancel').onclick = () => m.remove();
    m.querySelector('#dfSave').onclick = async () => {
      const dto = {
        name: m.querySelector('#dfName').value.trim(),
        kind: m.querySelector('#dfKind').value,
        model: m.querySelector('#dfModel').value.trim() || null,
        connType: m.querySelector('#dfConn').value,
        connAddr: m.querySelector('#dfAddr').value.trim(),
        boundPos: m.querySelector('#dfPos').value.trim() || null,
      };
      if (!dto.name) { toast('请填写设备名称', false); return; }
      if (id) await must(put(`/devices/${id}`, dto), '已保存');
      else await must(post('/devices', dto), '已新增');
      m.remove();
      drawDevices(body);
    };
  }

  // ═══════════ 模板 Tab ═══════════
  async function drawTemplates(body) {
    const [tpls, fieldPool] = await Promise.all([
      must(get('/print-templates')), must(get('/print-templates/fields')).catch(() => ({})),
    ]);
    state.fieldPool = fieldPool;
    let selId = state.selTplId && tpls.some(t => Number(t.id) === state.selTplId)
      ? state.selTplId : (tpls.find(t => t.is_default) || tpls[0])?.id;

    body.innerHTML = `
      <div class="grid" style="grid-template-columns:280px 1fr;align-items:start">
        <div class="card" style="min-height:380px">
          <h3>模板列表 </h3>
          <div style="text-align:right;margin:0 0 8px">
            ${canTpl() ? `<button class="btn sm" id="tRestore" title="缺失的预置模板（标准小票/价签/秤贴等）自动补回，已改过的不动">恢复预置</button>
              <button class="btn pri sm" id="tNew">＋ 新建</button>` : ''}</div>
          <div class="plist" id="tList"></div>
        </div>
        <div class="card"><div id="tEdit"></div></div>
      </div>`;

    const listBox = body.querySelector('#tList');
    function drawList() {
      listBox.innerHTML = TPL_ORDER.map(kind => {
        const items = tpls.filter(t => t.kind === kind);
        if (!items.length) return '';
        return `<div style="margin:6px 0 2px;font-size:11.5px;color:var(--muted,#8a8577)">${kind}</div>` +
          items.map(t => `<div class="it ${Number(t.id) === Number(selId) ? 'on' : ''}" data-sel="${t.id}">
            <span><b>${esc(t.name)}</b>${t.is_default ? ' <span class="pill g">默认</span>' : ''}<br>
            <small>${BIZ_CN[t.biz_type] || esc(t.biz_type)} · 联次 ${t.copies}</small></span></div>`).join('');
      }).join('') || '<div class="empty">暂无模板</div>';
      listBox.querySelectorAll('[data-sel]').forEach(el => el.onclick = () => {
        selId = Number(el.dataset.sel); state.selTplId = selId;
        drawList(); drawEditor();
      });
    }
    let leInst = null;
    async function drawEditor() {
      const t = tpls.find(x => Number(x.id) === Number(selId));
      const box = body.querySelector('#tEdit');
      if (leInst) { leInst.destroy(); leInst = null; }
      if (!t) { box.innerHTML = '<div class="empty">请选择或新建模板</div>'; return; }
      box.innerHTML = '<div id="leMount"></div>';
      // V4.15.9：可视化排版编辑器（hiprint 内核）——拖拽元素/对齐吸附/纸张设置，保存即打印模板
      leInst = mountLayoutEditor(box.querySelector('#leMount'), t, state.fieldPool, {
        canTpl: canTpl(),
        onSaved: () => drawTemplates(body),
        onDelete: async () => {
          await must(del(`/print-templates/${t.id}`), '已删除');
          state.selTplId = null;
          drawTemplates(body);
        },
      });
    }
    drawList();
    drawEditor();
    if (canTpl()) {
      body.querySelector('#tNew').onclick = () => openTplNew(body);
      body.querySelector('#tRestore').onclick = async () => {
        const r = await must(post('/print-templates/restore-presets'), '预置模板已恢复');
        toast(`已补齐 ${r?.added ?? 0} 个缺失预置（已改过的不动）`, true);
        drawTemplates(body);
      };
    }
  }

  function openTplNew(body) {
    const m = modal(`
      <h3 style="margin:0 0 12px">新建打印模板</h3>
      <div class="fld"><label>模板名称（如：标准小票 / 联营商对账单）</label>
        <input id="tnName" placeholder="模板名称"></div>
      <div class="fld"><label>模板类型</label>
        <select id="tnKind">${TPL_ORDER.map(k => `<option>${k}</option>`).join('')}</select></div>
      <div class="fld"><label>业务类型</label>
        <select id="tnBiz">${Object.entries(BIZ_CN).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="fld"><label>设为默认</label>
        <select id="tnDef"><option value="0">否</option><option value="1">是（同业务同类型唯一默认）</option></select></div>
      <div style="text-align:right;margin-top:14px">
        <button class="btn" id="tnCancel">取消</button>
        <button class="btn pri" id="tnSave">创建</button></div>`);
    m.querySelector('#tnCancel').onclick = () => m.remove();
    m.querySelector('#tnSave').onclick = async () => {
      const name = m.querySelector('#tnName').value.trim();
      if (!name) { toast('请填写模板名称', false); return; }
      const kind = m.querySelector('#tnKind').value;
      const bizType = m.querySelector('#tnBiz').value;
      const fields = (state.fieldPool[bizType] || []).map(f => ({ ...f, show: true }));
      const r = await must(post('/print-templates', {
        name, kind, bizType, isDefault: m.querySelector('#tnDef').value === '1',
        content: { title: name, fields, options: { qr: true, ad: true, cut: true, cashDrawer: false, lineHeight: 24, fontSize: 2 } },
      }), '已创建');
      m.remove();
      state.selTplId = r.id;
      drawTemplates(body);
    };
  }

  tabBar();
  await draw();
}

const state = { printerRows: [], deviceRows: [], fieldPool: {}, selTplId: null };
