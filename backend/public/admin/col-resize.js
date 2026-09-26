/**
 * 表格列宽可调（V4.26.2）——Excel 式拖拽列宽
 *
 * 通用能力（全局自动挂载，任何后台表格都可用，无需逐页改造）：
 *   1. 拖动表头右边界：调整该列宽度
 *   2. 双击分隔线：按本列内容自动适应宽度
 *   3. 右键分隔线：恢复本表默认列宽
 *   4. 宽度记忆到 localStorage（按「表标识 + 列标题」存，列结构变化自动失效）
 *
 * 设计要点：
 *   - 默认**不改变**表格观感；用户首次拖动时才切换为 table-layout:fixed
 *     （先按当前实测宽度做快照再切，避免切布局瞬间列宽跳变）
 *   - 含 colspan 的表头跳过（多表头表格拖拽会错位）
 *   - 列键用「列标题文本」而非序号，列增减后不会串列
 */
const LS_PREFIX = 'colresize:';
const MIN_W = 44;
const MAX_W = 560;

let ctx2d = null;
function measure(text, font) {
  try {
    ctx2d = ctx2d || document.createElement('canvas').getContext('2d');
    ctx2d.font = font || '13px "Microsoft YaHei", sans-serif';
    return ctx2d.measureText(String(text || '')).width;
  } catch { return 60; }
}

function injectStyle() {
  if (document.getElementById('colResizeStyle')) return;
  const s = document.createElement('style');
  s.id = 'colResizeStyle';
  s.textContent = `
    .col-resizer { position:absolute; top:0; right:-3px; width:7px; height:100%; cursor:col-resize;
      z-index:3; user-select:none; background:transparent; }
    .col-resizer::after { content:''; position:absolute; top:0; right:3px; width:2px; height:100%; background:transparent; }
    .col-resizer:hover::after, .col-resizer.on::after { background:var(--pri, #2e8557); }
    /* 拖动时跟随的竖向指示线（Element Plus el-table 同款） */
    .col-resize-proxy { position:fixed; top:0; width:0; border-left:2px dashed var(--pri, #2e8557);
      z-index:9998; pointer-events:none; }
    body.col-resizing { cursor:col-resize !important; user-select:none; }
    th[data-cr] { position:relative; }
  `;
  document.head.appendChild(s);
}

/** 表标识：显式 data-colresize / id 优先，否则「路由 + 列标题」组合 */
function tableKey(tb) {
  if (tb.dataset.colresize) return tb.dataset.colresize;
  if (tb.id) return tb.id;
  const heads = headCells(tb).map(th => (th.textContent || '').trim()).join(',');
  return (location.hash || '#/') + '|' + heads;
}

function headCells(tb) { return tb.tHead ? [...tb.tHead.rows[0].cells] : []; }

/** 列键：列标题（无标题时回退 placeholder 或序号） */
function colKey(th, i) {
  const t = (th.textContent || '').trim();
  return t || String(i);
}

function loadSaved(key) {
  try { return JSON.parse(localStorage.getItem(LS_PREFIX + key) || '{}') || {}; } catch { return {}; }
}
function saveCols(tb) {
  const key = tableKey(tb);
  const obj = {};
  headCells(tb).forEach((th, i) => { if (th.style.width) obj[colKey(th, i)] = th.style.width; });
  try {
    if (Object.keys(obj).length) localStorage.setItem(LS_PREFIX + key, JSON.stringify(obj));
    else localStorage.removeItem(LS_PREFIX + key);
  } catch { /* 隐私模式忽略 */ }
}

/** 拖动前把 auto 布局切成 fixed：先快照当前实测宽度，避免跳变 */
function ensureFixed(tb) {
  if (getComputedStyle(tb).tableLayout === 'fixed') return;
  const ths = headCells(tb);
  ths.forEach(th => { if (!th.style.width) th.style.width = Math.round(th.getBoundingClientRect().width) + 'px'; });
  tb.style.tableLayout = 'fixed';
  if (!tb.style.width) tb.style.width = '100%';
}

/** 双击：按本列内容（含输入框 placeholder）自动适应宽度 */
function autoFit(tb, th, idx) {
  ensureFixed(tb);
  const ths = headCells(tb);
  const cs = getComputedStyle(th);
  const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  let w = measure((th.textContent || '').trim(), font);
  for (const body of tb.tBodies || []) {
    for (const tr of body.rows) {
      const td = tr.cells[idx];
      if (!td) continue;
      const inp = td.querySelector('input,select,textarea');
      const txt = (td.innerText || '').trim() || (inp ? (inp.value || inp.placeholder || '') : '');
      if (txt) w = Math.max(w, measure(txt, font));
    }
  }
  th.style.width = Math.min(MAX_W, Math.max(MIN_W, Math.round(w) + 26)) + 'px';
  saveCols(tb);
  void ths;
}

/** 右键：恢复本表默认列宽 */
export function resetColWidths(tb) {
  headCells(tb).forEach(th => { th.style.width = th.dataset.ow || ''; });
  tb.style.tableLayout = '';
  try { localStorage.removeItem(LS_PREFIX + tableKey(tb)); } catch { /* noop */ }
}

/** 应用已保存的列宽（表格重绘后调用；全局增强会自动调用） */
export function applyColWidths(tb) {
  const saved = loadSaved(tableKey(tb));
  const keys = Object.keys(saved);
  if (!keys.length) return;
  let hit = false;
  headCells(tb).forEach((th, i) => {
    const w = saved[colKey(th, i)];
    if (w) { th.style.width = w; hit = true; }
  });
  if (hit) { tb.style.tableLayout = 'fixed'; if (!tb.style.width) tb.style.width = '100%'; }
}

/** 给单张表格装列宽手柄（已装过会跳过） */
export function enableColResize(tb) {
  if (!tb || tb.dataset.crBound === '1') return;
  const ths = headCells(tb);
  if (!ths.length) return;
  if (ths.some(th => th.colSpan > 1)) return;      // 多表头跳过
  tb.dataset.crBound = '1';
  injectStyle();

  ths.forEach((th, i) => {
    if (!th.dataset.ow) th.dataset.ow = th.style.width || '';   // 记住模板初始宽度，供恢复默认
    th.setAttribute('data-cr', '1');
    const h = document.createElement('div');
    h.className = 'col-resizer';
    h.title = '拖动调整列宽 · 双击自适应内容 · 右键恢复默认';
    let dragging = false;
    h.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true;
      ensureFixed(tb);
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      h.classList.add('on');
      document.body.classList.add('col-resizing');
      // 竖向指示线（el-table 同款）：贯穿表格高度，跟随列的右边界
      const proxy = document.createElement('div');
      proxy.className = 'col-resize-proxy';
      document.body.appendChild(proxy);
      const syncProxy = () => {
        const r = tb.getBoundingClientRect(), c = th.getBoundingClientRect();
        proxy.style.top = r.top + 'px';
        proxy.style.height = r.height + 'px';
        proxy.style.left = (c.right - 1) + 'px';
      };
      syncProxy();
      const move = ev => {
        if (!dragging) return;
        const w = Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX));
        th.style.width = Math.round(w) + 'px';
        syncProxy();
      };
      const up = () => {
        dragging = false;
        h.classList.remove('on');
        document.body.classList.remove('col-resizing');
        proxy.remove();
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        saveCols(tb);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    h.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); autoFit(tb, th, i); });
    h.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      resetColWidths(tb);
    });
    h.addEventListener('click', e => e.stopPropagation());   // 避免误触发表头排序
    th.appendChild(h);
  });

  applyColWidths(tb);
}

/** 批量：把 root 内（含 root 自身）所有表格装上列宽手柄 */
export function enhanceColResize(root) {
  if (!root || !root.querySelectorAll) return;
  const list = [];
  if (root.tagName === 'TABLE') list.push(root);
  root.querySelectorAll?.('table').forEach(t => list.push(t));
  for (const tb of list) {
    if (!tb.tHead) continue;
    enableColResize(tb);
  }
}
