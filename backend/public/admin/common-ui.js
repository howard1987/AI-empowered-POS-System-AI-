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
  // V5.0.6：同时认 .pg-bar-sticky（serverPagerBar 出的是吸底条，不含 .pg-bar 类）
  const isBar = el => !!el?.classList?.contains?.('pg-bar') || !!el?.classList?.contains?.('pg-bar-sticky');
  const bar = isBar(root) ? root : root?.querySelector?.('.pg-bar, .pg-bar-sticky');
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

/** 服务端分页条（数据由后端分页、前端只渲染当前页时用）。
 *  与 pagerBar 的差别：不显示「每页 N 条」，保留原 .pg-bar-sticky 吸底样式。
 *  出 HTML → bindPager(容器, go) 绑事件。原 sales.js / salesitems.js 各写一份的收敛点。
 *  V5.0.7：去掉内联 position:sticky；V5.0.7b：分页条由 autoFillTables 挪到滚动宿主正下方
 *  固定显示（不再 sticky 吸底——sticky 会盖住最下面一行数据，见 scanFillCards 注释）。 */
export function serverPagerBar({ page, total, size = 10, unit = '条' }) {
  const pages = Math.max(Math.ceil(total / size), 1);
  const cur = Math.min(Math.max(page, 1), pages);
  return `<div class="bar pg-bar-sticky" style="justify-content:flex-end;margin:8px 0 0;background:var(--bg,#faf9f5);padding:6px 8px;border-top:1px solid var(--line,#e8e4d8);z-index:2">
    <span class="muted" style="font-size:12px">共 ${total} ${unit}</span>
    <button class="btn sm pg-prev" ${cur <= 1 ? 'disabled' : ''}>‹ 上一页</button>
    <span class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px">第
      <input type="number" class="pg-jump" min="1" max="${pages}" value="${cur}" style="width:52px;text-align:center;padding:2px 4px"> / ${pages} 页</span>
    <button class="btn sm pg-next" ${cur >= pages ? 'disabled' : ''}>下一页 ›</button></div>`;
}

/**
 * 单据表格统一构建器（V5.0.6）——全站单据/列表表格只用这一个入口拼装：
 *   docTable({
 *     cols:  [ { h:'单号' }, { h:'数量', cls:'num' }, { h:'操作', w:190 }, ... ]    // 表头列：h=内容(可含控件HTML)；w=列宽px；cls=num/seq 等
 *     rows:  [ { attrs:'data-po="12" style="cursor:pointer"', cells:[ ... ] }, ... ] // 行：attrs=tr 属性串；cells=单元格
 *     empty: '无符合条件的采购订单',   // 空态文案（自动跨全列表宽）
 *     foot:  '<tr>…</tr>',            // 可选：tfoot 内层（合计行）
 *     cls:   '', style: ''            // 可选：table 附加 class / style（如 'margin-top:10px'）
 *   })
 * 单元格写法三选一：
 *   '纯文本/HTML'                                  → <td>…</td>
 *   { h:内容, cls:'num', style:'…', colspan:2 }     → 带对齐/样式/跨列的 <td>
 *   '<td …>…</td>' 原生串                           → 原样透传（含控件/按钮的复杂格）
 * 展示内容、列、文案一律由调用方给出——本函数只统一 thead/tbody/空态/tfoot 的构建与写法。 */
export function docTable({ cols, rows, empty = '暂无数据', foot = '', cls = '', style = '' }) {
  const th = cols.map(c => `<th${c.w ? ` style="width:${c.w}px"` : ''}${c.cls ? ` class="${c.cls}"` : ''}>${c.h}</th>`).join('');
  const td = c => (typeof c === 'object' && c !== null)
    ? `<td${c.cls ? ` class="${c.cls}"` : ''}${c.style ? ` style="${c.style}"` : ''}${c.colspan ? ` colspan="${c.colspan}"` : ''}>${c.h}</td>`
    : (typeof c === 'string' && /^<td[\s>]/i.test(c) ? c : `<td>${c}</td>`);
  /* V5.0.11h 修复「所有表格行双击弹详情失效」：
   * 原写法 `<tr${r.attrs || ''}>` 在 attrs 非空时拼出 `<trdata-in="50" ...>` ——
   * **tr 后面少了一个空格**。HTML 解析器会把标签名读成 `trdata-in` 这个未知元素，
   * 在 <tbody> 里直接丢弃（in-table 插入模式忽略不认识的标签），
   * 随后遇到的第一个 <td> 触发「隐式创建 tr」，
   * 于是表格看起来渲染正常，但**每一行都是隐式 tr、属性全丢**。
   * 后果：全站 `querySelectorAll('[data-xxx]')` 命中 0 → 双击/单击处理器一个都绑不上，
   * 而页面看着完全正常，极难定位（V5.0.11 真机联调时发现）。
   * 修法：补空格，并对空 attrs 做处理，避免生成 `<tr >` 这种多余空格。 */
  const trAttrs = r => (r && typeof r.attrs === 'string') ? r.attrs.trim() : '';
  const body = rows.length
    ? rows.map(r => { const a = trAttrs(r); return `<tr${a ? ' ' + a : ''}>${r.cells.map(td).join('')}</tr>`; }).join('')
    : `<tr><td colspan="${cols.length}" class="empty">${empty}</td></tr>`;
  return `<table${cls ? ` class="${cls}"` : ''}${style ? ` style="${style}"` : ''}><thead><tr>${th}</tr></thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table>`;
}

/* ═══ V5.0.7 主表格铺满窗口（不溢出）· 统一布局机制 ═══ */

const __fitViews = new Set();   // 已注册自适应的宿主（resize 时统一重算）
let __fitBound = false;

/** 让 .fill-pane / .split-rows / 顶层 .fill-card 的高度 = 「视口剩余高度」（精确测量，不溢出屏幕）。
 *  display:none 的元素（隐藏 Tab）自动跳过；切到该 Tab 后再调一次即可。
 *  window resize 全局监听一次，所有注册过的宿主一起重算（模块级单例）。 */
export function fitFillPanes(view) {
  __fitViews.add(view);
  const adjust = () => {
    __fitViews.forEach(v => {
      /* V5.0.11c 修复（V5.0.7c 判据的真正落地点）：原先这里对**每一张** .fill-card /
       * .fill-pane / .split-rows 无条件设 height = innerHeight - top - 46，导致
       * 「授权管理」这类一屏 3 张表的页面每张卡都被撑成一屏高 —— 正是 scanFillCards
       * 上方注释里警告的「页面变成 N 屏长」。且 r.top 为负（卡片已滚到视口上方）时
       * 算出的高度会超过视口（实测 1598px > 1105px），高度又会写进 style 粘住不放。
       * 现在按 V5.0.7c 的原意执行：只有「独立主表格屏」（顶层卡片 ≤2 张）才铺满视口，
       * 多卡工作流屏保持自然高度，并**显式清除**先前写入的高度。 */
      const allTop = [...(v.querySelectorAll?.('.card') || [])]
        .filter(c => !c.parentElement?.closest?.('.card'));
      const standalone = allTop.length > 0 && allTop.length <= 2;
      (v.querySelectorAll?.('.fill-pane, .split-rows, .fill-card') || []).forEach(el => {
        // 只量「顶层」元素：嵌在其它定高面板里的交给 flex 分配
        if (el.parentElement?.closest?.('.fill-pane, .split-rows')) return;
        if (!standalone) {          // 多卡屏：自然高度 + 清掉历史残留
          el.style.height = '';
          return;
        }
        const r = el.getBoundingClientRect();
        if (!r.height && !r.width) return;   // display:none
        // 46 ≈ #view 底部留白 40 + 呼吸；量不到（异常）就不动
        // r.top 可能为负（卡片已滚到视口上方），此时按 innerHeight-top-46 会算出超过视口的高度，
        // 需夹在视口内，否则页面会出现"空白一屏还点不到底"。
        const h = Math.min(Math.max(320, window.innerHeight - r.top - 46), window.innerHeight);
        el.style.height = h + 'px';
      });
    });
  };
  adjust();
  if (!__fitBound) {
    __fitBound = true;
    window.addEventListener('resize', adjust);
  }
}

/** 扫描「含 <table> 且含分页条」的卡片并改造为 fill 布局（幂等，可重复调用）。
 *  V5.0.7 修复：卡片扫描时列表可能尚未渲染出表格（异步 loadList）——找不到宿主就**不标记**
 *  已扫描，等 MutationObserver 触发后再扫，保证晚到的列表也能被 fill 接管。
 *  V5.0.7b 翻页条出滚动区：sticky 翻页条虽然吸在滚动宿主底部，但会**盖住最下面一行数据**，
 *  且容器 padding-bottom 会把下一行顶出一截残影在翻页条下方（采购入库列表老板复核复现）。
 *  改为把分页条挪出滚动宿主、作为其兄弟节点固定在卡片底部——永不盖行、下方永无数据。
 *  loadList 重渲染会在宿主内重新生成分页条 → 每次扫描都重做「清理旧条 + 挪出新条」，幂等。
 *  V5.0.7c 分级接管：翻页页脚统一所有屏生效；「视口定高铺满」只给**独立主表格屏**（顶层
 *  表格卡 ≤2 张）——对账结算/库存作业等多卡工作流屏保持自然高度（表格由 .pg-host 48vh
 *  兜底内滚），否则每张卡都被撑满一屏、页面变成 N 屏长。 */
function scanFillCards(view) {
  const entries = [];                    // { card, hosts }
  view.querySelectorAll?.('.card').forEach(card => {
    // 宿主候选：card 自身 + 所有后代中「直接子元素同时含 table 和分页条」的元素
    const hosts = [];
    const scan = el => {
      if (el.querySelector(':scope > table') &&
          el.querySelector(':scope > .pg-bar, :scope > .pg-bar-sticky')) hosts.push(el);
    };
    scan(card);
    card.querySelectorAll('*').forEach(scan);
    if (!hosts.length) return;          // 还没渲染出表格：不标记，等下次 DOM 变化重扫
    entries.push({ card, hosts });
  });
  entries.forEach(({ card, hosts }) => {
    card.classList.add('fill-card');
    hosts.forEach(h => {
      h.classList.add('tbl-host');
      if (h === card) return;            // 宿主即卡片本身（表+条直接挂在卡片下）：退回 sticky 兜底
      // ① 清理上一轮挪出来的旧分页条（重渲染后残留在宿主后面的兄弟位置）
      let sib = h.nextElementSibling;
      while (sib && (sib.classList.contains('pg-bar') || sib.classList.contains('pg-bar-sticky'))) {
        const next = sib.nextElementSibling;
        sib.remove();
        sib = next;
      }
      // ② 把本轮新生成的分页条挪到宿主正下方（元素整体搬移，bindPager 绑的事件不丢），
      //    并统一刷成「商品档案式」通栏页脚：贴底全宽、虚线上边、18px 内边距、控件右对齐。
      //    同时把宿主/页脚的 CSS 默认外边距（.card > div 的 14px 18px）归零，做到无缝通栏
      h.style.margin = '0';
      if (!h.style.padding) h.style.padding = '0 18px';
      const bar = h.querySelector(':scope > .pg-bar, :scope > .pg-bar-sticky');
      if (bar) {
        h.parentElement.insertBefore(bar, h.nextSibling);
        bar.style.margin = '0';
        bar.style.padding = '9px 18px';
        bar.style.background = 'transparent';
        bar.style.borderTop = '1px dashed var(--line)';
        bar.style.width = '100%';
      }
      const foot = card.querySelector(':scope > .doc-foot');
      if (foot) foot.style.margin = '0';
    });
  });
  /* 视口定高（fill-pane）：仅「独立主表格屏」启用。
   * V5.0.11c 修复：判定基数原本是 entries（**只含带分页条的卡片**）。像「授权管理」这种
   * 一屏 3 张表的页面，其中「授权设备」表没有分页条 → 不计入 → 基数被算成 2 →
   * 误判为独立表屏 → 每张卡都被撑成一屏高（用户反馈「签字授权容器太高」）。
   * 正确做法是统计**所有顶层卡片**，与页面上给人的视觉观感一致。 */
  const allTop = [...view.querySelectorAll('.card')]
    .filter(c => !c.parentElement?.closest?.('.card'));      // 排除嵌套在别的卡片里的
  const topCards = entries
    .filter(({ card }) => !card.closest('.fill-pane, .split-rows') || card.closest('.fill-pane, .split-rows') === card);
  const standalone = allTop.length > 0 && allTop.length <= 2;   // 一屏只有 1~2 张卡 = 独立表屏
  topCards.forEach(({ card }) => {
    if (standalone) card.classList.add('fill-pane');             // 顶层卡片自行定高
    else {
      // 多卡工作流屏：撤掉定高，走自然高度（否则每张卡一屏高，页面变成 N 屏长）
      card.classList.remove('fill-pane');
      card.style.height = '';
    }
  });
}

/** 全站主表格自动接管：把「含 <table> 且含分页条」的卡片改造为 fill 布局——
 *  卡片设 .fill-card；最深一层同时直接包含 table 与 (.pg-bar|.pg-bar-sticky) 的元素设 .tbl-host
 *  （内部滚动、表头吸顶）；分页条挪出滚动宿主、固定在卡片底部（V5.0.7b，不盖行无残影）。
 *  已在 .fill-pane / .split-rows 里的卡片不再追加顶层定高（高度由面板分配）。
 *  幂等：每次调用都重扫重整（重渲染后新分页条会被再次挪出）；app.js 在每次渲染后调用。 */
export function autoFillTables(view) {
  scanFillCards(view);
  fitFillPanes(view);
  // 页面内后续 DOM 变化（Tab 切换 / 局部重绘 / 异步列表加载）自动重扫+重算——
  // 只观察子树结构，忽略样式属性，避免自触发死循环
  if (!view.__fillObs) {
    view.__fillObs = true;
    let t = 0;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        scanFillCards(view);
        // 高度计算统一交给 fitFillPanes（V5.0.11c：那里才是真正设 height 的地方，
        // 且已带「独立表屏 ≤2 张卡」判据 + 多卡屏清除残留 + 高度夹在视口内）
        fitFillPanes(view);
      }, 120);
    }).observe(view, { childList: true, subtree: true });
  }
}
