import { get, post, must, esc, toast, money } from '../api.js';
import { attachProductSearch } from '../product-search.js';
import { ScaleSerial } from '../scale-protocols/serial.js';
import { transmitScaleItems } from '../scale-protocols/transmit.js';

/** 传秤小工具 V4.26.0
 *  - 管理后台新增页面，复刻科脉智海鲸截图的表头与勾选交互
 *  - 支持多品牌条码秤协议：大华/顶尖/寺冈/托利多/凯士/通用
 *  - 串口走 Web Serial 直发；网口 TCP 由服务端直连下发；导出 CSV 兜底
 *  - V4.26.1：支持中文化秤名（后端 iconv-lite 编码 GBK/GB2312，前端按字边界裁剪）
 */
export async function render(view) {
  let rows = [];      // 当前表格数据（带 _idx/_checked 运行时状态）
  let categories = [];
  let config = {};
  let logs = [];

  view.innerHTML = `
    <div class="card">
      <h3>⚖️ 生鲜管理 </h3>
      <div class="tabs" id="stTabs">
        <button class="tab active" data-tab="goods">生鲜商品</button>
        <button class="tab" data-tab="logs">下发记录</button>
      </div>

      <!-- 生鲜商品 -->
      <div id="stPanelGoods" class="tab-panel">
        <div class="bar" style="flex-wrap:wrap;gap:8px">
          <select id="stCat"><option value="">全部类别</option></select>
          <input id="stKw" placeholder="🔍 商品名称/条码/货号/拼音" style="min-width:180px">
          <label><input type="checkbox" id="stOnlyEnabled"> 仅已勾选</label>
          <button class="btn" id="stQuery">查询</button>
          <button class="btn" id="stLoadWeighted">扫描生鲜商品(Q)</button>
          <button class="btn pri" id="stSave">保存(S)</button>
          <button class="btn pri" id="stTransmit">传秤(T)</button>
          <button class="btn" id="stExport">导出</button>
          <button class="btn" id="stClear">清除(L)</button>
        </div>
        <div class="st-table-wrap tbl-min">
          <table id="stTable">
            <thead><tr>
              <th><input type="checkbox" id="stCheckAll" title="全选" ${rows.length && rows.every(r => r._checked) ? 'checked' : ''}></th>
              <th class="seq">序号</th><th>部门号</th><th>商品秤内码</th><th>商品编号</th>
              <th>商品名称</th><th>商品生鲜码</th><th>商品简称</th>
              <th class="num">零售价</th><th class="num">会员价</th><th class="num">批发价</th>
              <th>热键</th>
            </tr></thead>
            <tbody id="stTbody"></tbody>
          </table>
        </div>
        <div id="stPager" class="pager"></div>
      </div>

      <!-- 日志 -->
      <div id="stPanelLogs" class="tab-panel" style="display:none">
        <div id="stLogList" class="tbl-min"></div>
      </div>
    </div>

    <!-- 下发进度弹窗 -->
    <div id="stProgress" class="modal-mask" style="display:none">
      <div class="modal" style="width:min(520px,92vw);padding:22px 24px">
        <h3 id="stProgTitle">正在传秤</h3>
        <div id="stProgBar" style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin:14px 0">
          <div id="stProgFill" style="height:100%;width:0%;background:var(--pri);transition:width .2s"></div>
        </div>
        <div id="stProgText" class="muted" style="font-size:13px;max-height:220px;overflow:auto"></div>
        <div style="text-align:right;margin-top:16px">
          <button class="btn" id="stProgClose">关闭</button>
        </div>
      </div>
    </div>`;

  const $ = s => view.querySelector(s);
  const $$ = s => view.querySelectorAll(s);

  function tab(name) {
    $$('#stTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    ['goods', 'logs'].forEach(k => {
      $(`#stPanel${k[0].toUpperCase() + k.slice(1)}`).style.display = k === name ? '' : 'none';
    });
    if (name === 'logs') loadLogs();
  }
  $('#stTabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) tab(t.dataset.tab); });

  async function loadConfig() {
    try {
      config = await must(get('/scale-transmission/config'));
    } catch (e) {
      config = { protocol: 'dahua', portType: 'serial', port: 'COM3', baud: 9600, tcpHost: '192.168.1.100', tcpPort: 9100, department: '01', barcodePrefix: '22', useMemberPrice: false, charset: 'gbk' };
    }
    // 配置在「系统设置 → 传秤工具」中维护（与本站重复项已移除），此处仅读取后直用
  }

  async function loadCategories() {
    try {
      const data = await must(get('/categories'));
      categories = Array.isArray(data) ? data : (data.items || []);
      $('#stCat').innerHTML = '<option value="">全部类别</option>' + categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    } catch { /* 忽略 */ }
  }

  async function loadProducts(opts = {}) {
    const page = opts.page || 1;
    const cat = $('#stCat').value;
    const kw = $('#stKw').value.trim();
    const onlyEnabled = $('#stOnlyEnabled').checked ? 'true' : '';
    const url = `/scale-transmission/products?page=${page}&pageSize=50&keyword=${encodeURIComponent(kw)}&category=${encodeURIComponent(cat)}&onlyEnabled=${onlyEnabled}&weighted=true`;
    const data = await must(get(url));
    rows = (data.rows || []).map((r, i) => ({
      ...r,
      _idx: i,
      _checked: r.scale_enabled,
      scale_plu_code: r.scale_plu_code || makeDefaultPlu(r),
      scale_department: r.scale_department || config.department || '01',
    }));
    drawTable();
    drawPager(data);
  }

  function makeDefaultPlu(p) {
    const code = String(p.barcode || p.goods_no || p.id).replace(/\D/g, '');
    return code.slice(-5).padStart(4, '0');
  }

  function drawTable() {
    const tbody = $('#stTbody');
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--ink-3)">暂无商品，点击「扫描生鲜商品」加载称重商品</td></tr>'; return; }
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td><input type="checkbox" class="st-row-check" data-i="${i}" ${r._checked ? 'checked' : ''}></td>
        <td class="seq">${i + 1}</td>
        <td><input class="st-in" data-i="${i}" data-f="scale_department" value="${esc(r.scale_department || '')}" maxlength="4" style="width:60px"></td>
        <td><input class="st-in" data-i="${i}" data-f="scale_plu_code" value="${esc(r.scale_plu_code || '')}" maxlength="12" style="width:90px"></td>
        <td>${esc(r.goods_no)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.barcode || '')}</td>
        <td>${esc(r.short_name || '')}</td>
        <td class="num">${money(r.sell_price)}</td>
        <td class="num">${money(r.member_price || 0)}</td>
        <td class="num">¥0.00</td>
        <td><input class="st-in" data-i="${i}" data-f="scale_hotkey" value="${esc(r.scale_hotkey || '')}" maxlength="8" style="width:60px"></td>
      </tr>`).join('');
    bindRowEvents();
  }

  function bindRowEvents() {
    $$('#stTbody .st-row-check').forEach(cb => {
      cb.onchange = () => { const r = rows[cb.dataset.i]; r._checked = cb.checked; };
    });
    $$('#stTbody .st-in').forEach(inp => {
      inp.onchange = () => { const r = rows[inp.dataset.i]; r[inp.dataset.f] = inp.value.trim(); };
      inp.onkeydown = e => {
        if (e.key === 'Enter') {
          const next = inp.parentElement.nextElementSibling;
          if (next) { const ni = next.querySelector('input'); if (ni) { e.preventDefault(); ni.focus(); } }
        }
      };
    });
    $('#stCheckAll').onchange = () => {
      const on = $('#stCheckAll').checked;
      rows.forEach(r => r._checked = on);
      drawTable();
    };
  }

  function drawPager(data) {
    const p = data.page || 1, pages = data.pages || 1;
    if (pages <= 1) { $('#stPager').innerHTML = ''; return; }
    let html = '';
    if (p > 1) html += `<button class="btn sm" data-p="${p - 1}">上一页</button>`;
    html += `<span class="muted">第 ${p}/${pages} 页 · 共 ${data.total} 条</span>`;
    if (p < pages) html += `<button class="btn sm" data-p="${p + 1}">下一页</button>`;
    $('#stPager').innerHTML = html;
    $('#stPager').onclick = e => { const b = e.target.closest('button[data-p]'); if (b) loadProducts({ page: Number(b.dataset.p) }); };
  }

  async function saveRows() {
    const items = rows.map(r => ({
      productId: r.id,
      scalePluCode: r.scale_plu_code,
      scaleEnabled: r._checked,
      scaleHotkey: r.scale_hotkey,
      scaleDepartment: r.scale_department,
    }));
    await must(post('/scale-transmission/products/batch', { items }));
    toast('商品传秤字段已保存');
  }

  function selectedRows() {
    return rows.filter(r => r._checked).map(r => ({ ...r }));
  }

  async function doTransmit() {
    const sel = selectedRows();
    if (!sel.length) { toast('请先勾选要传秤的商品', false); return; }
    // 配置来自「系统设置 → 传秤工具」，后端直读；实际下发走共享模块 transmitScaleItems
    const cfg = config;
    if (cfg.portType === 'serial' && !ScaleSerial.supported()) {
      toast('当前浏览器不支持 Web Serial，请改用网口 TCP 或导出 CSV', false);
      return;
    }
    showProgress(true);
    try {
      const res = await transmitScaleItems(sel, cfg, {
        onStart: appendProgress,
        onProgress: (m, e) => appendProgress(m, e),
        onFinish: (ok, fail) => toast(`传秤完成：成功 ${ok}，失败 ${fail}`),
      });
      updateProgress(res.total, res.total);
    } catch (err) {
      toast('传秤异常：' + err.message, false);
    } finally {
      showProgress(false);
    }
  }

  function showProgress(on) { $('#stProgress').style.display = on ? 'flex' : 'none'; }
  function updateProgress(cur, total) {
    const pct = total ? Math.round((cur / total) * 100) : 0;
    $('#stProgFill').style.width = pct + '%';
    $('#stProgText').scrollTop = $('#stProgText').scrollHeight;
  }
  function appendProgress(text, isErr) {
    const div = document.createElement('div');
    div.style.cssText = 'padding:3px 0;border-bottom:1px solid #f0f0f0;' + (isErr ? 'color:#c0392b' : '');
    div.textContent = text;
    $('#stProgText').appendChild(div);
  }
  $('#stProgClose').onclick = () => showProgress(false);

  function exportCsv() {
    const sel = selectedRows();
    const data = sel.length ? sel : rows;
    const cfg = config;   // 配置来自「系统设置 → 传秤工具」，后端直读
    const head = '是否传秤,流水号,部门号,商品秤内码,商品编号,商品名称,商品生鲜码,商品简称,零售价,会员价,批发价';
    const body = data.map((r, i) => {
      const cols = [
        r._checked ? '1' : '0',
        i + 1,
        r.scale_department || cfg.department || '01',
        r.scale_plu_code || makeDefaultPlu(r),
        r.goods_no,
        r.name,
        r.barcode || '',
        r.short_name || r.name.slice(0, 6),
        Number(r.sell_price || 0).toFixed(4),
        Number(r.member_price || 0).toFixed(4),
        '0.0000',
      ];
      return cols.map(v => {
        const s = String(v ?? '').replace(/"/g, '""');
        return /[",\n]/.test(s) ? '"' + s + '"' : s;
      }).join(',');
    }).join('\n');
    const blob = new Blob(['\uFEFF' + head + '\n' + body], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `传秤数据_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    toast('传秤 CSV 已下载');
  }

  async function loadLogs() {
    try {
      const data = await must(get('/scale-transmission/logs?page=1&pageSize=20'));
      logs = data.rows || [];
      $('#stLogList').innerHTML = logs.length ? `
        <table class="tbl-min"><thead><tr>
          <th>时间</th><th>协议</th><th>端口</th><th>总数</th><th>成功</th><th>失败</th><th>状态</th>
        </tr></thead><tbody>
        ${logs.map(l => `<tr>
          <td>${esc(l.created_at)}</td>
          <td>${esc(l.protocol)}</td>
          <td>${esc(l.port_path)}</td>
          <td>${l.total_count}</td>
          <td>${l.ok_count}</td>
          <td>${l.fail_count}</td>
          <td>${esc(l.status)}</td>
        </tr>`).join('')}
        </tbody></table>` : '<div class="empty">暂无下发记录</div>';
    } catch { $('#stLogList').innerHTML = '<div class="empty">加载失败</div>'; }
  }

  // 事件绑定
  $('#stQuery').onclick = () => loadProducts({ page: 1 });
  $('#stLoadWeighted').onclick = () => { $('#stKw').value = ''; $('#stCat').value = ''; $('#stOnlyEnabled').checked = false; loadProducts({ page: 1 }); };
  $('#stSave').onclick = saveRows;
  $('#stTransmit').onclick = doTransmit;
  $('#stExport').onclick = () => {
    const data = (selectedRows().length ? selectedRows() : rows);
    const cols = [
      { k: 'idx', t: '流水号' }, { k: 'dept', t: '部门号' }, { k: 'plu', t: '商品秤内码' },
      { k: 'goods', t: '商品编号' }, { k: 'name', t: '商品名称' }, { k: 'fresh', t: '商品生鲜码' },
      { k: 'short', t: '商品简称' }, { k: 'sell', t: '零售价' }, { k: 'member', t: '会员价' }, { k: 'wholesale', t: '批发价' },
    ];
    const rowsData = data.map((r, i) => ({
      idx: i + 1, dept: r.scale_department || config.department || '01', plu: r.scale_plu_code || makeDefaultPlu(r),
      goods: r.goods_no, name: r.name, fresh: r.barcode || '', short: (r.short_name || r.name || '').slice(0, 6),
      sell: Number(r.sell_price || 0).toFixed(2), member: Number(r.member_price || 0).toFixed(2), wholesale: Number(r.wholesale_price || 0).toFixed(2),
    }));
    openExportPicker({ filename: '传秤商品', columns: cols, rows: rowsData });
  };
  $('#stClear').onclick = () => {
    rows.forEach(r => { r._checked = false; r.scale_plu_code = makeDefaultPlu(r); r.scale_department = config.department || '01'; r.scale_hotkey = ''; });
    drawTable();
  };
  // 键盘快捷键
  document.addEventListener('keydown', e => {
    if (!view.isConnected) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    const map = { KeyQ: () => $('#stLoadWeighted').click(), KeyL: () => $('#stClear').click(), KeyS: () => $('#stSave').click(), KeyT: () => $('#stTransmit').click(), KeyE: () => $('#stExport').click() };
    if (map[e.code]) { e.preventDefault(); map[e.code](); }
  });

  await loadCategories();
  await loadConfig();
  await loadProducts({ page: 1 });
}
