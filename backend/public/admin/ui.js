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
  // V5.0.2：动态详情弹窗（openDetailModal 等注册了 mask.__modalClose）走真关闭（remove+onClose）；
  // 静态弹窗（页面内常驻、靠 display 切换，如客户建档弹窗）保持隐藏行为——remove 会把 DOM 摘掉，
  // 之后 openXxx 找不到节点直接抛错、入口按钮"点不动"。
  const btnClose = bar.querySelector('[data-w="close"]');
  if (btnClose) btnClose.onclick = () => {
    const chip0 = document.querySelector(`[data-restore-for="${mask.id || mask.dataset.mid}"]`);
    if (chip0) chip0.remove();
    if (typeof mask.__modalClose === 'function') { mask.__modalClose(); return; }
    mask.style.display = 'none';
    m.classList.remove('modal-max');
    bar.querySelector('[data-w="max"]').textContent = '□';
  };
  // V4.14.8：全局统一关闭交互 = 点遮罩关闭（确认框除外——它必须经「取消/确定」结算 Promise）
  if (!mask.querySelector('.confirm-modal')) {
    mask.addEventListener('click', e => {
      if (e.target !== mask) return;
      const chip1 = document.querySelector(`[data-restore-for="${mask.id || mask.dataset.mid}"]`);
      if (chip1) chip1.remove();
      if (typeof mask.__modalClose === 'function') { mask.__modalClose(); return; }
      mask.style.display = 'none';
      m.classList.remove('modal-max');
      bar.querySelector('[data-w="max"]').textContent = '□';
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

/* ── 手写签字板（canvas + 指针事件） ──
 * V5.0.6 收敛：consign / recon / signatures / signpad / purchase 五处曾是同一份实现的复制，
 * 统一走本模块，改一处即全端生效。
 *   bindPad(pad, { onStroke }) —— 落笔回调用于笔画计数/脏标记
 *   padDirty(pad) 任一像素非零　padInk(pad) 不透明像素数（乱签初筛）　clearPad(pad) 清空 */
export function bindPad(pad, { onStroke } = {}) {
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, last = null;
  const pos = e => { const r = pad.getBoundingClientRect();
    return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
  pad.onpointerdown = e => { drawing = true; onStroke?.(); last = pos(e); pad.setPointerCapture(e.pointerId); };
  pad.onpointermove = e => { if (!drawing) return; const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; };
  pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
}
export function padDirty(pad) {
  const d = pad.getContext('2d').getImageData(0, 0, pad.width, pad.height).data;
  return d.some(v => v !== 0);
}
export function padInk(pad) {
  const d = pad.getContext('2d').getImageData(0, 0, pad.width, pad.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
}
export function clearPad(pad) { pad.getContext('2d').clearRect(0, 0, pad.width, pad.height); }

/* ── 供应商名称 → id（全等优先，其次互含）。原 purchase / returns 两处各写一份 ── */
export function matchSupplierId(name, suppliers) {
  const n = String(name || '').trim();
  if (!n) return 0;
  const s = suppliers.find(x => x.name === n) ||
    suppliers.find(x => (x.name || '').includes(n) || n.includes(x.name || ''));
  return s ? Number(s.id) : 0;
}

/* ── 本机取景拍照 → dataURL（#camModal / #camVideo / #camCancel / #camShot 四件套） ──
 * V5.0.6 收敛：ops.js（报损）与 returns.js（退货凭证）曾各写一份。
 *   onFail(why)  why = 'none' 无摄像头设备 | 'denied' 授权/启动失败
 *   onShot(dataUrl) 拍摄完成（遮罩与摄像头已自动关闭释放） */
export async function capturePhoto(scope, { onFail, onShot } = {}) {
  let hasCam = false;
  try {
    hasCam = (await navigator.mediaDevices.enumerateDevices()).some(d => d.kind === 'videoinput');
  } catch { hasCam = false; }
  if (!hasCam) return onFail?.('none');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch { return onFail?.('denied'); }
  const modal = scope.querySelector('#camModal');
  const video = scope.querySelector('#camVideo');
  video.srcObject = stream;
  modal.style.display = 'flex';
  const close = () => { stream.getTracks().forEach(t => t.stop()); modal.style.display = 'none'; };
  scope.querySelector('#camCancel').onclick = close;
  scope.querySelector('#camShot').onclick = () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    close();
    onShot?.(canvas.toDataURL('image/jpeg', 0.85));
  };
}
