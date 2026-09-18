import * as stock from './stock.js';
import * as ops from './ops.js';
import { segHtml, bindSeg } from '../ui-polish.js';   // V4.26.4 统一分段控件

/** 库存管理（合并入口：库存批次 + 库存作业） */
const SUBS = [
  { key: 'stock', title: '🏷️ 库存批次', mod: stock },
  { key: 'ops', title: '🧾 库存作业', mod: ops },
];

export async function render(view) {
  view.innerHTML = `
    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <span id="invSeg"></span>
      <span class="muted" style="margin-left:auto;font-size:11.5px">库存管理：批次台账（FIFO 溯源）与作业单据（盘点/报损/调拨）统一入口</span>
    </div>
    <div id="invSub"></div>`;
  const sub = view.querySelector('#invSub');
  const renderSub = async (key) => {
    const item = SUBS.find(s => s.key === key) || SUBS[0];
    sub.innerHTML = '<div class="empty">加载中…</div>';
    try { await item.mod.render(sub); }
    catch (e) {
      if (!(e && e.code !== undefined)) sub.innerHTML = `<div class="empty">渲染异常：${e.message || e}</div>`;
    }
  };
  /* ── 子模块切换（V4.26.4：改用 .seg 分段控件）── */
  function drawSubs(cur) {
    const host = view.querySelector('#invSeg');
    host.innerHTML = segHtml(SUBS.map(s => ({ k: s.key, t: s.title })), cur);
    bindSeg(host, k => { drawSubs(k); renderSub(k); });
  }
  drawSubs('stock');
  await renderSub('stock');
}
