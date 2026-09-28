/**
 * 通用 UI 组件：
 *   openDetailModal(title, html, opts) → 双击行/点击弹出的订单·单据详情弹窗（宽度自适应，右上关闭）
 *   exportRows({ filename, columns, rows, format }) → CSV / Excel(.xls) 导出，全系统复用
 *   paginate({ rows, page, size }) → 本地分页（每页 10 条，超出翻页）
 */
import { esc, toast } from './api.js';

/** 详情弹窗：title 标题；html 内容；onClose 关闭回调。V4.14.1：去掉「关闭」文字按钮；
 *  V4.14.9：右上 ✕ 由 decorateModal 统一挂窗口按钮（— □ ✕）；
 *  V4.15.1：去掉 h3 内自带的 cdm-close ✕——它与 decorateModal 的窗口 ✕ 叠成两个关闭按钮（用户截图指认） */
export function openDetailModal(title, html, opts = {}) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.style.cssText = 'display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:4vh 12px';
  mask.innerHTML = `<div class="modal" style="width:min(${opts.width || 860}px, 94vw);max-width:94vw;max-height:88vh;display:flex;flex-direction:column;margin-bottom:6vh">
    <h3 style="display:flex;align-items:center;gap:10px"><span style="flex:1">${title}</span></h3>
    <div class="cdm-body" style="overflow:auto">${html}</div></div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); opts.onClose?.(); };
  mask.__modalClose = close;   // V5.0.1：供 ui.js 窗口按钮 ✕ / 遮罩点击走统一真关闭
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  return { mask, close };
}

/**
 * 导出（CSV / Excel）：columns=[{k,t}]；rows=对象数组；format 'csv' | 'xls'
 * xls 用 HTML 表格包装（Excel/WPS 直接打开，含列名与数字列右对齐）
 */
export function exportRows({ filename, columns, rows, format = 'csv' }) {
  if (!rows?.length) { toast?.('当前条件下无数据可导出'); return false; }
  const cell = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const name = `${filename}_${new Date().toISOString().slice(0, 10)}`;
  if (format === 'xls') {
    const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>${name.slice(0, 28)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
<table border="1"><thead><tr>${columns.map(c => `<th style="background:#efece2">${esc(c.t)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r => `<tr>${columns.map(c => `<td style="mso-number-format:'\\@'">${esc(r[c.k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' }));
    a.download = `${name}.xls`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else {
    const csv = '\ufeff' + [columns.map(c => c.t).join(','),
      ...rows.map(r => columns.map(c => cell(r[c.k])).join(','))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return true;
}

/** 统一「导出」入口：弹窗选择 Excel / CSV 格式后调用 exportRows。
 *  所有需要导出的表格统一使用：按钮文案「导出」→ onclick 调 openExportPicker({ filename, columns, rows }) */
export function openExportPicker({ filename, columns, rows }) {
  if (!rows?.length) { toast?.('当前条件下无数据可导出'); return; }
  const m = document.createElement('div');
  m.className = 'modal-mask';
  m.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9999';
  m.innerHTML = `<div class="modal" style="width:min(360px,92vw);padding:20px 22px">
    <h3 style="margin:0 0 12px">导出「${esc(filename)}」</h3>
    <p class="muted" style="font-size:13px;margin:0 0 14px">请选择导出格式</p>
    <div style="display:flex;gap:10px">
      <button class="btn pri" id="epXls" style="flex:1">📊 Excel (.xls)</button>
      <button class="btn" id="epCsv" style="flex:1">📄 CSV (.csv)</button>
    </div>
    <div style="text-align:right;margin-top:14px"><button class="btn" id="epClose">取消</button></div>
  </div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('#epClose').onclick = close;
  m.onclick = e => { if (e.target === m) close(); };
  m.querySelector('#epXls').onclick = () => { exportRows({ filename, columns, rows, format: 'xls' }); close(); };
  m.querySelector('#epCsv').onclick = () => { exportRows({ filename, columns, rows, format: 'csv' }); close(); };
}

/** 统一分页条：上一页/下一页右对齐 + 页码 + 手输页码跳转。
 *  所有含翻页展示的模块统一使用：pagerBar(...) 出 HTML → bindPager(...) 绑事件
 *
 *  ⚠ V4.26.4 修正：sticky 默认值由 true 改 false。
 *  原因：分页条的滚动祖先是整个页面滚动容器（#view），不是它所属的表格区域。
 *  一旦开启 sticky:bottom:0，页面处于滚动中间态时它会被吸附到**屏幕底边**，
 *  脱离表格浮到别的行上面盖住数据（供应商变更记录页已复现）。
 *  需要「固定底部分页」的表格，改用宿主容器类 .pg-host（限高 + 内部滚动），
 *  CSS 里有 `.pg-host > .pg-bar { position: sticky; bottom: 0 }`，分页条就固定在容器底部，
 *  内容不溢出时容器高度自适应，分页条自然跟随表格 —— 两种场景都对。 */
export function pagerBar({ page, pages, total, size, unit = '条', hint = '', sticky = false }) {
  pages = Math.max(1, Number(pages) || 1);
  page = Math.min(Math.max(1, Number(page) || 1), pages);
  const stickyCss = sticky ? 'position:sticky;bottom:0;' : '';
  return `<div class="bar pg-bar${sticky ? ' pg-bar-sticky' : ''}" style="justify-content:flex-end;align-items:center;margin:8px 0 0;${stickyCss}background:var(--bg,#faf9f5);padding:6px 8px;border-top:1px solid var(--line,#e8e4d8);z-index:2;flex-wrap:wrap">
    ${hint ? `<span class="muted" style="font-size:12px;margin-right:auto">${hint}</span>` : ''}
    <span class="muted" style="font-size:12px">共 ${total} ${unit}${size ? ` · 每页 ${size} ${unit}` : ''}</span>
    <button class="btn sm pg-prev" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
    <span class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px">第
      <input type="number" class="pg-jump" min="1" max="${pages}" value="${page}" style="width:52px;text-align:center;padding:2px 4px"> / ${pages} 页</span>
    <button class="btn sm pg-next" ${page >= pages ? 'disabled' : ''}>下一页 ›</button></div>`;
}

/** 绑定分页条事件：go(targetPage) 由调用方重渲染。上一页/下一页/手输页码（Enter 或失焦生效） */
export function bindPager(root, go) {
  // root 既可以是「包含分页条的容器」，也可以直接就是分页条本身（原先两种写法下后者静默失效）
  const bar = root?.classList?.contains('pg-bar') ? root : root?.querySelector?.('.pg-bar');
  if (!bar) return;
  const jump = () => {
    const inp = bar.querySelector('.pg-jump');
    const max = Number(inp?.max) || 1;
    const p = Math.min(Math.max(1, Number(inp?.value) || 1), max);
    go(p);
  };
  bar.querySelector('.pg-prev')?.addEventListener('click', () => {
    const inp = bar.querySelector('.pg-jump');
    go(Math.max(1, (Number(inp?.value) || 1) - 1));
  });
  bar.querySelector('.pg-next')?.addEventListener('click', () => {
    const inp = bar.querySelector('.pg-jump');
    go((Number(inp?.value) || 1) + 1);
  });
  const inp = bar.querySelector('.pg-jump');
  if (inp) {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); jump(); } });
    inp.addEventListener('change', () => jump());   // 失焦/确定同样跳页
  }
}

/** 本地分页：返回 {slice, page, pages, total, bar(html)}；翻页事件由调用方在插入 DOM 后
 *  用 bindPager(container, p => ...) 绑定。
 *  V4.14.1：分页条吸底；V4.14.9：统一走 pagerBar（右对齐+手输跳页）；
 *  V4.26.4：sticky 默认关闭（原因见 pagerBar 注释）；需要「固定底部分页」给表格容器加 .pg-host。 */
export function paginate(rows, page, size = 10, sticky = false) {
  const total = rows.length;
  const pages = Math.max(Math.ceil(total / size), 1);
  const cur = Math.min(Math.max(page, 1), pages);
  const slice = rows.slice((cur - 1) * size, cur * size);
  const bar = pagerBar({ page: cur, pages, total, size, sticky });
  return { slice, page: cur, pages, total, bar };
}

/** 双击行辅助：给 tbody 的 tr 绑 dblclick（触屏双击退化为点击「详情」按钮仍可用） */
export function bindDblClick(container, selector, handler) {
  container.querySelectorAll(selector).forEach(tr => {
    tr.addEventListener('dblclick', () => handler(tr));
  });
}
