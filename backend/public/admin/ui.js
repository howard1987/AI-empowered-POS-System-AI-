import { API, get, esc, unwrap } from './api.js';

/** V4.9.7 全局 UI 组件：
 *  · decorateModals —— 所有 .modal 自动挂「最小化 / 最大化 / 关闭」窗口按钮（app.js MutationObserver 调用）
 *  · confirmBox    —— 样式化确认/删除弹窗（替代原生 confirm，两段风险提示）
 *  · zoomImg       —— 图片点击放大（全屏遮罩）
 *  · supMatcher    —— 供应商输入匹配（datalist，替代下拉选择） */

/* ── 弹窗窗口按钮 ── */
export function decorateModal(mask) {
  if (mask.dataset.winDecorated) return;
  const m = mask.querySelector(':scope > .modal, :scope > .drawer');
  if (!m) return;
  const isConfirm = !!m.classList.contains('confirm-modal');
  mask.dataset.winDecorated = '1';
  const bar = document.createElement('div');
  bar.className = 'winbar';
  // V4.14.9：恢复右上 ✕ 关闭按钮（V4.14.8 理解偏差误删——用户要去掉的是弹窗内容里的 X，不是容器窗口按钮）
  bar.innerHTML = `
    <button type="button" data-w="min" title="最小化">—</button>
    <button type="button" data-w="max" title="最大化">□</button>
    ${isConfirm ? '' : '<button type="button" data-w="close" title="关闭">✕</button>'}`;
  m.style.position = m.style.position || 'relative';
  // V4.9.8 改为 sticky 首子元素：弹窗内容滚动时窗口按钮钉在右上角不随内容移动
  m.insertBefore(bar, m.firstChild);
  bar.querySelector('[data-w="min"]').onclick = () => {
    mask.style.display = 'none';
    let chip = document.querySelector(`[data-restore-for="${mask.id || mask.dataset.mid}"]`);
    if (!chip) {
      const mid = mask.id || ('m' + Math.random().toString(36).slice(2, 8));
      mask.dataset.mid = mid;
      chip = document.createElement('button');
      chip.className = 'win-restore';
      chip.dataset.restoreFor = mid;
      const t = mask.querySelector('h3');
      chip.textContent = '📎 ' + (t ? t.textContent.trim().slice(0, 18) : '已最小化窗口');
      chip.onclick = () => { mask.style.display = 'flex'; chip.remove(); };
      document.body.appendChild(chip);
    }
  };
  bar.querySelector('[data-w="max"]').onclick = () => {
    m.classList.toggle('modal-max');
    bar.querySelector('[data-w="max"]').textContent = m.classList.contains('modal-max') ? '❐' : '□';
  };
  // V4.14.9：恢复的 ✕ 关闭（确认框除外——必须经「取消/确定」结算 Promise）
  const btnClose = bar.querySelector('[data-w="close"]');
  if (btnClose) btnClose.onclick = () => {
    mask.style.display = 'none';
    m.classList.remove('modal-max');
    bar.querySelector('[data-w="max"]').textContent = '□';
    const chip = document.querySelector(`[data-restore-for="${mask.id || mask.dataset.mid}"]`);
    if (chip) chip.remove();
  };
  // V4.14.8：全局统一关闭交互 = 点遮罩关闭（确认框除外——它必须经「取消/确定」结算 Promise）
  if (!mask.querySelector('.confirm-modal')) {
    mask.addEventListener('click', e => {
      if (e.target !== mask) return;
      mask.style.display = 'none';
      m.classList.remove('modal-max');
      bar.querySelector('[data-w="max"]').textContent = '□';
      const chip = document.querySelector(`[data-restore-for="${mask.id || mask.dataset.mid}"]`);
      if (chip) chip.remove();
    });
  }
}

/* ── 样式化确认框（替代原生 confirm；danger 红色强调风险） ── */
export function confirmBox({ title = '请确认', html = '', okText = '确认删除', okClass = 'danger' } = {}) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.zIndex = 90;
    mask.innerHTML = `
      <div class="modal confirm-modal">
        <h3>${esc(title)}</h3>
        <div class="confirm-body">${html}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
          <button class="btn" data-c>取消</button>
          <button class="btn ${okClass}" data-o>${esc(okText)}</button>
        </div>
      </div>`;
    const done = v => { mask.remove(); resolve(v); };
    mask.querySelector('[data-c]').onclick = () => done(false);
    mask.querySelector('[data-o]').onclick = () => done(true);
    mask.onclick = e => { if (e.target === mask) done(false); };
    document.body.appendChild(mask);
  });
}

/* ── 样式化输入弹窗（V4.14.9 替代原生 prompt；resolve(输入值|null)） ── */
export function promptBox({ title = '请输入', html = '', placeholder = '', value = '', okText = '确定', inputType = 'text' } = {}) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.style.zIndex = 90;
    mask.innerHTML = `
      <div class="modal confirm-modal" style="width:min(460px,92vw)">
        <h3>${esc(title)}</h3>
        <div class="confirm-body">${html}</div>
        <input id="pbInput" type="${esc(inputType)}" placeholder="${esc(placeholder)}" value="${esc(value)}"
               style="width:100%;margin-top:10px;padding:8px 10px;border:1px solid var(--line,#e8e4d8);border-radius:8px;font:inherit;box-sizing:border-box">
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
          <button class="btn" data-c>取消</button>
          <button class="btn pri" data-o>${esc(okText)}</button>
        </div>
      </div>`;
    const done = v => { mask.remove(); resolve(v); };
    const inp = mask.querySelector('#pbInput');
    mask.querySelector('[data-c]').onclick = () => done(null);
    mask.querySelector('[data-o]').onclick = () => done(inp.value);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } });
    mask.onclick = e => { if (e.target === mask) done(null); };
    document.body.appendChild(mask);
    setTimeout(() => inp.focus(), 30);
  });
}

/* ── 图片放大 ── */
export function zoomImg(url) {
  const lb = document.createElement('div');
  lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out;padding:24px';
  lb.innerHTML = `<img src="${esc(url)}" style="max-width:92vw;max-height:92vh;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.5)">`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

/* ── 供应商输入匹配（datalist）：返回选中的供应商 id（未匹配返回 0） ── */
export function supMatcher(input, suppliers, { allowEmpty = true, emptyText = '' } = {}) {
  const dl = document.createElement('datalist');
  dl.id = 'sdl_' + Math.random().toString(36).slice(2, 9);
  dl.innerHTML = (allowEmpty ? [`<option value="__CLEAR__">${esc(emptyText || '全部供应商（清空）')}</option>`] : [])
    .concat(suppliers.map(s => `<option value="${esc(s.name)}">`).join('')).join('');
  input.setAttribute('list', dl.id);
  input.insertAdjacentElement('afterend', dl);
  input.dataset.supName = input.value.trim();
  input.addEventListener('change', () => {
    const v = input.value.trim();
    input.dataset.supName = v;
    const hit = suppliers.find(s => s.name === v);
    input.dataset.supId = hit ? String(hit.id) : '';
  });
  // 初始匹配
  const init = suppliers.find(s => s.name === input.value.trim());
  input.dataset.supId = init ? String(init.id) : '';
  return {
    get id() { return Number(input.dataset.supId || 0); },
    get name() { return (input.dataset.supName || '').trim(); },
    set(name) { input.value = name || ''; input.dataset.supName = name || ''; const h = suppliers.find(s => s.name === name); input.dataset.supId = h ? String(h.id) : ''; },
  };
}

/* ── 加载供应商清单（统一走 /purchase/suppliers） ── */
export async function loadSuppliers() {
  try {
    const d = unwrap(await get('/purchase/suppliers'));
    return (Array.isArray(d) ? d : (d.items || [])) || [];
  } catch { return []; }
}
