import * as po from './po.js';
import * as purchase from './purchase.js';
import * as returns from './returns.js';
import { segHtml, bindSeg } from '../ui-polish.js';   // V4.26.4 统一分段控件

/** 采购管理（合并入口：采购订单 + 采购入库 + 采购退货） */
const SUBS = [
  { key: 'po', title: '📋 采购订单', mod: po },
  { key: 'purchase', title: '🚚 采购入库', mod: purchase },
  { key: 'returns', title: '↩️ 采购退货', mod: returns },
];

export async function render(view) {
  view.innerHTML = `
    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <span id="purSeg"></span>
      <span class="muted" style="margin-left:auto;font-size:11.5px">采购管理：订单 → 入库（生成批次）→ 退货（原批次退回）全流程统一入口</span>
    </div>
    <div id="purSub"></div>`;
  const sub = view.querySelector('#purSub');
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
    const host = view.querySelector('#purSeg');
    host.innerHTML = segHtml(SUBS.map(s => ({ k: s.key, t: s.title })), cur);
    bindSeg(host, k => { drawSubs(k); renderSub(k); });
  }
  drawSubs('po');
  await renderSub('po');
}
