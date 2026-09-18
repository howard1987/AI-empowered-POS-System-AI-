/* V4.9.15 PWA 全局自绘下拉增强器（与后台 pick-panel.js 同范本，普通 script 自包含版）：
   · <select> → 只读展示框 + 芯片面板；真实 select 保留 DOM（display:none），.value/change 全兼容
   · MutationObserver 自动覆盖动态渲染的弹窗/表单；幂等 dataset.pickEnhanced */
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function buildPanel(anchor, getList, emptyHint) {
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
        : `<span class="pick-opt" style="color:var(--ink-3);cursor:default">${esc(emptyHint || '暂无选项')}</span>`;
      panel.style.display = 'flex';
      onDoc = e => { if (!panel.contains(e.target) && e.target !== anchor) close(); };
      document.addEventListener('pointerdown', onDoc, true);
    };
    anchor.addEventListener('mousedown', e => { e.preventDefault(); panel.style.display === 'flex' ? close() : open(); });
    // 手机端 touch 也走 click 语义：preventDefault 的 mousedown 在部分安卓 WebView 不触发 click，这里统一用 mousedown/touchstart
    anchor.addEventListener('touchstart', e => { if (panel.style.display !== 'flex') { e.preventDefault(); open(); } }, { passive: false });
    return { panel, close };
  }

  function enhanceSelect(sel) {
    sel.dataset.pickEnhanced = '1';
    if (getComputedStyle(sel).display === 'none') return;
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
    };
    sel.before(disp);
    sel.style.display = 'none';
    sel.__pickDisp = disp; disp.__pickSync = sync;
    const panel = buildPanel(disp, () => [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })), '（空）');
    panel.panel.addEventListener('mousedown', e => {
      const b = e.target.closest('[data-pick-val]');
      if (!b) return;
      e.preventDefault();
      if (sel.value !== b.dataset.pickVal) {
        sel.value = b.dataset.pickVal;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sync();
      panel.close();
    });
    sync();
  }

  function enhancePick(root) {
    const targets = [];
    if (root.nodeType === 1) {
      if (root.matches?.('select')) targets.push(root);
    }
    if (root.querySelectorAll) targets.push(...root.querySelectorAll('select'));
    for (const sel of targets) {
      if (sel.dataset.pickEnhanced || sel.multiple || sel.hasAttribute('size')) continue;
      try { enhanceSelect(sel); } catch { /* 单个失败不拖垮全局 */ }
    }
  }
  window.pwaEnhancePick = enhancePick;

  document.addEventListener('change', e => {
    if (e.target?.tagName === 'SELECT' && e.target.dataset.pickEnhanced === '1') e.target.__pickDisp?.__pickSync?.();
  }, true);
  setInterval(() => {
    document.querySelectorAll('select[data-pick-enhanced="1"]').forEach(s => s.__pickDisp?.__pickSync?.());
  }, 600);
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1) enhancePick(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
  enhancePick(document);
})();
