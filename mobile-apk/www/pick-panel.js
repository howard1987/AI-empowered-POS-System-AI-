/* V5.0.6 全局自绘下拉增强器（唯一源：后台 admin 与收银 PWA 共用本文件）：
   · <select>     → 只读展示框 + 芯片面板；真实 select 保留在 DOM（display:none），
                    .value / change 事件全兼容，业务代码零改动
   · input[list]  → 摘除 list 属性，面板候选从关联 datalist 惰性读取（弹面板时才取最新）
   · 面板定位：offsetLeft/offsetTop 相对父级精确对齐（修复「下拉贴容器最左侧」通病）
   · 触屏：touchstart 打开（部分安卓 WebView 对 preventDefault 后的 mousedown 不触发 click）
   · 幂等（dataset.pickEnhanced 防重）
   两种加载方式皆可：
   · ESM 导入：`import { enhancePick } from './pick-panel.js'`（app.js 在 decorateDeep / Observer / 首屏中显式调用）
   · 独立模块：`<script type="module" src="./pick-panel.js">` —— 文件底部自初始化（Observer + 首屏扫描），
     自初始化带 window.__pickPanelInited__ 防重；与显式调用共存无害（增强幂等）。 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildPickPanel(anchor, { getList, emptyHint = '暂无选项' }) {
  const panel = document.createElement('div');
  panel.className = 'pick-panel';
  anchor.parentElement.style.position = anchor.parentElement.style.position || 'relative';
  anchor.parentElement.appendChild(panel);
  let onDoc = null;
  const close = () => {
    panel.style.display = 'none';
    if (onDoc) { document.removeEventListener('pointerdown', onDoc, true); onDoc = null; }
  };
  const open = () => {
    const opts = getList();
    panel.innerHTML = opts.length
      ? opts.map(o => o.disabled
        ? `<span class="pick-opt" style="color:var(--ink-3);cursor:default">${esc(o.text)}</span>`
        : `<button type="button" class="pick-opt" data-pick-val="${esc(o.value)}">${esc(o.text)}</button>`).join('')
      : `<span class="pick-opt" style="color:var(--ink-3);cursor:default">${esc(emptyHint)}</span>`;
    // 面板定位到控件本身（而非外层容器最左）：偏移父级即 anchor.parentElement（已置 position:relative），
    // 用 offsetLeft/offsetTop 相对该父级精确对齐，修复「下拉永远贴容器最左侧」的通病
    panel.style.left = anchor.offsetLeft + 'px';
    panel.style.top = (anchor.offsetTop + anchor.offsetHeight + 2) + 'px';
    panel.style.display = 'flex';
    onDoc = e => { if (!panel.contains(e.target) && e.target !== anchor) close(); };
    document.addEventListener('pointerdown', onDoc, true);
  };
  anchor.addEventListener('mousedown', e => {
    e.preventDefault();
    panel.style.display === 'flex' ? close() : open();
  });
  // 手机端 touch 也走 click 语义：preventDefault 的 mousedown 在部分安卓 WebView 不触发 click，这里统一用 mousedown/touchstart
  anchor.addEventListener('touchstart', e => { if (panel.style.display !== 'flex') { e.preventDefault(); open(); } }, { passive: false });
  return { panel, close };
}

function enhanceSelect(sel) {
  sel.dataset.pickEnhanced = '1';
  if (getComputedStyle(sel).display === 'none') return;   // 隐藏型数据占位 select 不改 UI
  const disp = document.createElement('input');
  disp.readOnly = true;
  disp.className = sel.className || '';
  disp.setAttribute('autocomplete', 'off');
  disp.style.cssText = sel.style.cssText;
  disp.style.cursor = 'pointer';
  disp.classList.add('pick-display');
  const sync = () => {
    const o = sel.selectedOptions && sel.selectedOptions[0];
    disp.value = o ? o.textContent.trim() : '';
    disp.title = disp.value;
  };
  sel.before(disp);
  sel.style.display = 'none';
  sel.__pickDisp = disp; disp.__pickSel = sel; disp.__pickSync = sync;
  const getList = () => [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled }));
  const panel = buildPickPanel(disp, { getList, emptyHint: '（空）' });
  panel.panel.addEventListener('mousedown', e => {
    const b = e.target.closest('[data-pick-val]');
    if (!b) return;
    e.preventDefault();
    if (sel.value !== b.dataset.pickVal) {
      sel.value = b.dataset.pickVal;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
    panel.close();                              // 点选后自动收起
  });
  sync();
}

function enhanceDatalistInput(inp) {
  const dl = document.getElementById(inp.getAttribute('list'));
  if (!dl) { inp.dataset.pickEnhanced = '1'; return; }
  inp.removeAttribute('list');
  inp.dataset.pickEnhanced = '1';
  const getList = () => {
    const kw = inp.value.trim().toLowerCase();
    const all = [...dl.querySelectorAll('option')].map(o => ({ value: o.value, text: o.value, disabled: false }));
    return kw ? all.filter(o => o.text.toLowerCase().includes(kw)) : all;
  };
  const panel = buildPickPanel(inp, { getList, emptyHint: '无匹配——可直接输入' });
  panel.panel.addEventListener('mousedown', e => {
    const b = e.target.closest('[data-pick-val]');
    if (!b) return;
    inp.value = b.dataset.pickVal;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    panel.close();                              // 点选后自动收起
  });
}

export function enhancePick(root = document) {
  const targets = [];
  if (root.nodeType === 1) {
    if (root.matches?.('select')) targets.push(root);
    if (root.matches?.('input[list]')) targets.push(root);
  }
  if (root.querySelectorAll) targets.push(...root.querySelectorAll('select, input[list]'));
  for (const el of targets) {
    if (el.dataset.pickEnhanced || el.multiple || el.hasAttribute('size')) continue;
    try { el.tagName === 'SELECT' ? enhanceSelect(el) : enhanceDatalistInput(el); } catch { /* 单个失败不拖垮全局 */ }
  }
}

// 展示框与真实 select 的值保持同步：change 捕获即时同步 + 兜底轮询（覆盖直接赋 .value 不发事件的场景）
document.addEventListener('change', e => {
  if (e.target?.tagName === 'SELECT' && e.target.dataset.pickEnhanced === '1') e.target.__pickDisp?.__pickSync?.();
}, true);
setInterval(() => {
  document.querySelectorAll('select[data-pick-enhanced="1"]').forEach(s => s.__pickDisp?.__pickSync?.());
}, 600);

// 自初始化（独立加载时生效；被 ESM 导入时与调用方的显式调用幂等共存）
if (!window.__pickPanelInited__) {
  window.__pickPanelInited__ = true;
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1) enhancePick(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
  enhancePick(document);
}
