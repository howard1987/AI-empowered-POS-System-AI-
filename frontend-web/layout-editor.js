/**
 * V4.15.9 可视化模版排版编辑器（hiprint 内核搬运集成）
 *   - 内核：vue-plugin-hiprint 0.0.61-beta5（vendor/hiprint/，UMD 全局 window.hiprint + jQuery + JsBarcode）
 *   - 元素：左侧拖入画布；业务字段随业务类型注入（字段池 + 示例值）；基础元素 文本/直线/矩形/图片/长文本；
 *           单据类多「明细表」（hiprint table，列随单据类型预置，激光/喷墨打印自动分页）
 *   - 纸张：标签 40x30/50x30/60x40/自定义；小票 58/80（宽固定、高可调连续纸）；A5/A4/A3/自定义
 *   - 交互：拖拽 + 对齐辅助线 + 吸附（hiprint 内建）、网格、缩放、旋转纸张、Ctrl+Z/Ctrl+Shift+Z 撤销重做、
 *           Ctrl+C/V 复制粘贴、Delete 删除（均为 hiprint 内建快捷键）
 *   - 存储：content = { version:3, title, hp:<hiprint JSON>, options }；旧 v1/v2 模板打开时自动转换，保存后升级 v3
 *   - 消费：热敏（TSPL/ZPL/ESC-POS）由 hiprint JSON → mm 元素转换渲染；激光/喷墨（A5/A4）由 hiprint getHtml 出整页 HTML
 */
import { put, post, must, esc, toast } from './api.js';

const PT = 72 / 25.4;                                            // 1mm = 2.8346pt（hiprint 元素坐标单位）
const pt2mm = v => Math.round(((Number(v) || 0) / PT) * 100) / 100;
const mm2pt = v => Math.round(((Number(v) || 0) * PT) * 100) / 100;

/** 纸张预设（mm） */
const KIND_PAPER = {
  '小票58': { w: 58, h: 160, fixedW: true },
  '小票80': { w: 80, h: 200, fixedW: true },
  '标签': { w: 40, h: 30 },
  'A5单据': { w: 148, h: 210 },
  'A4单据': { w: 210, h: 297 },
};

/** 示例值（画布 testData / 转换兜底） */
const SAMPLE = {
  name: '红富士苹果', price: '￥9.98', promoPrice: '￥7.99', barcode: '6901234567890',
  unit: '千克', spec: '500g', keepDays: '保质12个月', info: '千克 · 500g · 保质12个月',
  unitPrice: '￥9.98/千克', weight: '1.234kg', amount: '￥12.31', time: '2026/09/10 16:20',
  store: '绿源社区超市', orderNo: 'RK20260910001', cashier: '王秀英', member: '王女士（金卡）',
  discount: '-￥0.50', coupon: '-￥10.00', pay: '微信 ￥118.45', change: '￥0.00', points: '+118',
  subtotal: '￥118.45', total: '￥1,234.56', thanks: '谢谢惠顾 · 退换货请凭小票',
  supplier: '康师傅经销部', operator: '张三', counter: '李四', period: '2026/08/01~2026/08/31',
  from: '中心仓', to: '门店A', reason: '临期/破损', remark: '无', diff: '+2 / -1',
  confirm: '签名：＿＿＿＿', sign: '签字：＿＿＿＿', items: '（商品明细）',
};
const sampleVal = k => SAMPLE[k] || '示例值';

/** A5/A4 明细表列预设 [field, title, widthPt]（A5 可用宽约 363pt） */
const DOC_COLS = {
  inbound: [['name', '商品', 90], ['unit', '单位', 32], ['qty', '数量', 40], ['price', '进价', 44], ['pdate', '生产日期', 58], ['batch', '批次', 50], ['amount', '金额', 46]],
  return: [['name', '商品', 100], ['unit', '单位', 36], ['qty', '退货数量', 52], ['price', '原批次价', 54], ['batch', '批次', 62], ['amount', '金额', 48]],
  order: [['name', '商品', 90], ['unit', '单位', 32], ['qty', '订购数量', 52], ['arrived', '已到货', 44], ['price', '含税进价', 52], ['amount', '金额', 46], ['rmk', '备注', 44]],
  loss: [['name', '商品', 100], ['unit', '单位', 36], ['batch', '批次', 62], ['qty', '数量', 44], ['price', '成本', 48], ['amount', '金额', 48]],
  count: [['name', '商品', 96], ['unit', '单位', 34], ['book', '账面', 44], ['qty', '实盘', 44], ['diff', '差异', 44], ['amount', '差异成本', 60]],
  transfer: [['name', '商品', 100], ['unit', '单位', 36], ['batch', '批次', 62], ['qty', '数量', 44], ['price', '成本', 48], ['amount', '金额', 48]],
  recon: [['rmk', '类别', 48], ['name', '原始单号', 110], ['pdate', '日期', 70], ['amount', '金额', 60], ['batch', '未付金额', 62]],
};

let _uid = 0;
const nid = () => 'e' + (++_uid) + Math.random().toString(36).slice(2, 6);

/* ═══════════ hiprint JSON ↔ v2 元素(mm) 互转（前后端各一份同逻辑） ═══════════ */

/** hiprint 模板 JSON → { paper:{wmm,hmm}, elements:[v2] }；失败返回 null */
export function hip2els(hp) {
  const panel = hp && Array.isArray(hp.panels) ? hp.panels[0] : null;
  if (!panel) return null;
  const paper = { wmm: Math.max(10, Math.round(Number(panel.width) || 40)), hmm: Math.max(10, Math.round(Number(panel.height) || 30)) };
  const elements = (panel.printElements || []).map(pe => {
    const o = (pe && pe.options) || {};
    const t = ((pe && pe.printElementType) || {}).type || '';
    const base = { id: nid(), x: pt2mm(o.left), y: pt2mm(o.top), w: pt2mm(o.width), h: pt2mm(o.height), show: true };
    if (t === 'hline') return { ...base, type: 'divider', h: 0.4 };
    if (t === 'rect' || t === 'oval') return { ...base, type: 'rect', th: 0.3 };
    if (t === 'barcode') return { ...base, type: 'barcode', key: o.field || 'barcode' };
    if (t === 'qrcode') return { ...base, type: 'qrcode', key: o.field || 'barcode' };
    if (t === 'table') return { ...base, type: 'items', h: Math.max(base.h, 10) };
    if (t === 'text' || t === 'longText' || t === 'customText') {
      if (o.textType === 'barcode') return { ...base, type: 'barcode', key: o.field || 'barcode' };
      if (o.textType === 'qrcode') return { ...base, type: 'qrcode', key: o.field || 'barcode' };
      const el = { ...base, type: o.field ? 'field' : 'text', fontSize: Math.max(1.5, pt2mm(o.fontSize || 6.75)),
        align: o.textAlign === 'center' ? 'center' : o.textAlign === 'right' ? 'right' : 'left',
        bold: ['bold', '600', '700'].includes(String(o.fontWeight)) };
      if (o.field) el.key = o.field; else el.text = o.title || o.testData || '';
      return el;
    }
    return null;                                   // image/vline/html 热敏不支持：设计器可摆，出字节时忽略
  }).filter(Boolean);
  return { paper, elements };
}

/** v2 元素 → hiprint 模板 JSON（设计器加载用） */
export function els2hp(els, paper, bizType) {
  const cols = DOC_COLS[bizType] || DOC_COLS.inbound;
  const printElements = (els || []).map(el => {
    const o = { left: mm2pt(el.x), top: mm2pt(el.y), width: mm2pt(el.w || 30), height: mm2pt(el.h || 5),
      textAlign: el.align || 'left', hideTitle: true, coordinateSync: false, widthHeightSync: false };
    if (el.fontSize) o.fontSize = mm2pt(el.fontSize);
    if (el.bold) o.fontWeight = 'bold';
    const T = (title, type) => ({ options: o, printElementType: { title, type } });
    if (el.type === 'text') { o.title = el.text || ''; return T('文本', 'text'); }
    if (el.type === 'field' || el.type === 'kv') {
      o.field = el.key || ''; o.testData = sampleVal(el.key);
      if (el.type === 'kv') { o.title = el.label || ''; o.hideTitle = false; }
      return T(el.key === 'items' ? '商品明细' : '字段', 'text');
    }
    if (el.type === 'divider') return { options: { ...o, height: mm2pt(0.4) }, printElementType: { title: '直线', type: 'hline' } };
    if (el.type === 'rect') return T('矩形', 'rect');
    if (el.type === 'barcode') { o.field = el.key || 'barcode'; o.testData = sampleVal(el.key || 'barcode'); o.textType = 'barcode'; return T('条码', 'text'); }
    if (el.type === 'qrcode') { o.field = el.key || 'barcode'; o.testData = sampleVal(el.key || 'barcode'); o.textType = 'qrcode'; return T('二维码', 'text'); }
    if (el.type === 'items') {
      const to = { ...o, field: 'items', tableHeaderRepeat: 'first', tableFooterRepeat: 'last',
        fields: cols.map(c => ({ text: c[1], field: c[0] })),
        columns: [cols.map(c => ({ title: c[1], field: c[0], width: c[2], tableTextAlign: 'center' }))] };
      return { options: to, printElementType: { title: '明细表', type: 'table' } };
    }
    return null;
  }).filter(Boolean);
  return { panels: [{ index: 0, name: 1, width: paper.wmm, height: paper.hmm,
    paperHeader: 0, paperFooter: mm2pt(paper.hmm), printElements }] };
}

/** v1 字段模板 → 默认版式（打开即所见，可拖拽调整） */
export function v1ToEls(bizType, kind, content, fieldPool, preset) {
  const pool = (fieldPool && fieldPool[bizType]) || [];
  const src = (Array.isArray(content.fields) && content.fields.length ? content.fields : pool.map(f => ({ ...f, show: true })))
    .filter(f => f.show !== false).map(f => f.key);
  const W = preset.w;
  const mk = (o) => ({ id: nid(), show: true, fontSize: 2.5, align: 'left', ...o });
  const els = [];
  const isLabel = kind === '标签';
  if (isLabel) {
    const has = k => src.includes(k);
    if (bizType === 'pricetag' && has('name') && has('price')) {
      els.push(mk({ type: 'field', key: 'name', x: 2, y: 1.5, w: W - 4, h: 5, fontSize: 3, align: 'center' }),
        mk({ type: 'field', key: 'price', x: 2, y: 8, w: (W - 4) * 0.6, h: 7, fontSize: 6 }),
        mk({ type: 'field', key: 'info', x: 2, y: 17, w: W - 4, h: 4 }),
        mk({ type: 'barcode', key: 'barcode', x: 3, y: 22, w: W - 6, h: 7.5 }));
    } else if (bizType === 'scale' && has('name')) {
      els.push(mk({ type: 'field', key: 'name', x: 2, y: 1.5, w: (W - 4) * 0.7, h: 5, fontSize: 3 }),
        mk({ type: 'field', key: 'time', x: W - 2 - (W - 4) * 0.3, y: 2, w: (W - 4) * 0.3, h: 4, fontSize: 2, align: 'right' }),
        mk({ type: 'field', key: 'unitPrice', x: 2, y: 8, w: W - 4, h: 4 }),
        mk({ type: 'field', key: 'weight', x: 2, y: 13, w: W - 4, h: 4 }),
        mk({ type: 'field', key: 'amount', x: 2, y: 17.5, w: (W - 4) * 0.6, h: 6, fontSize: 5 }),
        mk({ type: 'barcode', key: 'barcode', x: 3, y: 24, w: W - 6, h: 5.5 }));
    } else {
      let y = 2;
      for (const k of src.filter(k => k !== 'barcode')) {
        els.push(mk({ type: 'field', key: k, x: 2, y, w: W - 4, h: 4.5, fontSize: 2.5 }));
        y += 5.5;
      }
      if (src.includes('barcode')) els.push(mk({ type: 'barcode', key: 'barcode', x: 2, y, w: W - 4, h: 8 }));
    }
    return { paper: { wmm: 40, hmm: 30 }, elements: els };
  }
  const isDoc = kind === 'A5单据' || kind === 'A4单据';
  if (isDoc) {
    els.push(mk({ type: 'field', key: src[0] === 'store' ? 'store' : 'orderNo', x: 10, y: 8, w: W - 20, h: 8, fontSize: 5, align: 'center' }));
    let y = 20;
    for (const k of src.filter(k => k !== 'items' && k !== 'store')) {
      els.push(mk({ type: 'kv', key: k, label: (pool.find(f => f.key === k) || {}).label || k, x: 10, y, w: W - 20, h: 4.5 }));
      y += 5.5;
    }
    els.push(mk({ type: 'items', x: 10, y, w: W - 20, h: 40 }));
    return { paper: { wmm: W, hmm: preset.h }, elements: els };
  }
  // 小票：标题 → 分隔 → 键值字段 → 分隔 → 明细 → 分隔 → 实收 → 感谢语
  const kvKeys = src.filter(k => !['items', 'subtotal', 'total', 'pay', 'thanks'].includes(k));
  if (src.includes('store') || content.title) els.push(mk({ type: 'text', text: content.title || '门店销售小票', x: 4, y: 2, w: W - 8, h: 6, fontSize: 3.5, align: 'center' }));
  els.push(mk({ type: 'divider', x: 2, y: 10, w: W - 4, h: 0.4 }));
  let y = 13;
  for (const k of kvKeys) { els.push(mk({ type: 'kv', key: k, label: (pool.find(f => f.key === k) || {}).label || k, x: 2, y, w: W - 4, h: 4.5 })); y += 5.5; }
  els.push(mk({ type: 'divider', x: 2, y, w: W - 4, h: 0.4 })); y += 2;
  if (src.includes('items')) els.push(mk({ type: 'field', key: 'items', x: 2, y, w: W - 4, h: 10, fontSize: 2.5 })), y += 12;
  els.push(mk({ type: 'divider', x: 2, y, w: W - 4, h: 0.4 })); y += 2;
  if (src.includes('pay') || src.includes('total') || src.includes('subtotal')) els.push(mk({ type: 'field', key: 'total', x: 2, y, w: W - 4, h: 5.5, fontSize: 3.5 })), y += 7;
  if (src.includes('thanks')) els.push(mk({ type: 'text', text: SAMPLE.thanks, x: 2, y, w: W - 4, h: 4.5, align: 'center' }));
  return { paper: { wmm: W, hmm: preset.h }, elements: els };
}

/* ═══════════ 编辑器挂载 ═══════════ */

/**
 * @param container 挂载容器
 * @param tpl 打印模板行（print_templates）
 * @param fieldPool FIELD_POOL（GET /print-templates/fields）
 * @param hooks { onSaved, onDelete, onSetDefault, canTpl }
 * @returns { destroy }
 */
export function mountLayoutEditor(container, tpl, fieldPool, hooks = {}) {
  const H = window.hiprint, $ = window.jQuery || window.$;
  if (!H || !$ || !H.PrintTemplate) {
    container.innerHTML = '<div class="empty">排版引擎加载失败：请刷新页面（vendor/hiprint 未就绪）</div>';
    return { destroy() { } };
  }
  const canTpl = !!hooks.canTpl;
  const kind = tpl.kind;
  const bizType = tpl.biz_type || tpl.bizType;
  const preset = KIND_PAPER[kind] || KIND_PAPER['A5单据'];
  const isDoc = kind === 'A5单据' || kind === 'A4单据';
  const isReceipt = kind === '小票58' || kind === '小票80';
  const isLabel = kind === '标签';

  let content = {};
  try { content = typeof tpl.content === 'string' ? JSON.parse(tpl.content || '{}') : (tpl.content || {}); } catch { content = {}; }
  let doc = null;
  if (content.version === 3 && content.hp) doc = hip2els(content.hp);
  else if (content.version === 2 && Array.isArray(content.elements) && content.elements.length) {
    doc = { paper: { wmm: content.paper?.wmm || preset.w, hmm: content.paper?.hmm || preset.h }, elements: content.elements };
  }
  const converted = !doc;
  if (!doc) doc = v1ToEls(bizType, kind, content, fieldPool, preset);

  const state = {
    paper: { ...doc.paper }, name: tpl.name || '', title: content.title || tpl.name || '',
    copies: Number(tpl.copies) || 1, scale: 1, grid: true,
    options: { qr: !!content.options?.qr, ad: !!content.options?.ad, cut: content.options?.cut !== false,
      cashDrawer: !!content.options?.cashDrawer },
  };
  // V5.0.5：编辑期在纸张四周预留空白（mm），让 hiprint 认为的“纸张”比真实打印纸大，元素可拖到纸外排列
  const PAD_W = 120, PAD_H = 240;
  const designPaper = () => ({ wmm: state.paper.wmm + PAD_W, hmm: state.paper.hmm + PAD_H });

  container.innerHTML = `
    <style>
      .le-wrap { display:grid; grid-template-columns:190px 1fr 265px; gap:10px; align-items:stretch; }
      .le-palette { border:1px solid var(--line,#e5e2da); border-radius:10px; background:#fff; padding:8px;
        overflow:auto; height:calc(100vh - 250px); }
      .le-palette .hiprint-printElement-type { margin-bottom:4px; }
      .le-canvas { border:1px solid var(--line,#e5e2da); border-radius:10px; background:#eef0f2; padding:14px;
        overflow:auto; height:calc(100vh - 250px); position:relative; }
      .le-setting { border:1px solid var(--line,#e5e2da); border-radius:10px; background:#fff; padding:8px;
        overflow:auto; height:calc(100vh - 250px); }
      /* V5.0.5：编辑期纸张虚拟放大（四周留白），纸张区显示为灰底空白，元素可拖到纸外排列；保存时还原真实尺寸 */
      .hiprint-printPaper.design { background:#eef0f2; }
      .le-bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:10px; }
      .le-bar input, .le-bar select { padding:4px 8px; border:1px solid var(--line,#e5e2da); border-radius:6px; }
      .le-hint { font-size:11.5px; color:var(--muted,#8a8577); }
      .le-paperbtn.on { background:var(--pri,#20663f); color:#fff; border-color:var(--pri,#20663f); }
      .le-paperbtn { border:1px solid var(--line,#e5e2da); background:#fff; border-radius:6px; padding:3px 8px;
        cursor:pointer; font-size:12px; }
      @media (max-width:1100px) { .le-wrap { grid-template-columns:1fr; } }
    </style>
    <div class="le-bar">
      <b>${isLabel ? '🏷️ 标签' : isReceipt ? '🧾 小票' : '📄 单据'}排版</b>
      <input id="leName" value="${esc(state.name)}" title="模板名称" style="width:130px">
      <input id="leTitle" value="${esc(state.title)}" title="抬头标题（打印顶部主标题）" style="width:130px">
      <label class="le-hint">联次</label><input id="leCopies" type="number" min="1" max="5" value="${state.copies}" style="width:52px">
      ${isReceipt ? `<span class="le-hint">小票选项</span>
        <label class="le-hint"><input type="checkbox" id="leOptCut" ${state.options.cut ? 'checked' : ''}>切刀</label>
        <label class="le-hint"><input type="checkbox" id="leOptDrawer" ${state.options.cashDrawer ? 'checked' : ''}>钱箱联动</label>` : ''}
      <span style="flex:1"></span>
      <span class="le-hint">纸张</span>
      <span id="lePapers"></span>
      <span id="leCustom" class="le-hint">自定义 <input id="leCw" type="number" min="15" max="297" style="width:56px" placeholder="宽mm"> ×
        <input id="leCh" type="number" min="15" max="500" style="width:56px" placeholder="高mm">
        <button class="le-paperbtn" id="leCApply">应用</button></span>
      <button class="le-paperbtn" id="leZoomOut" title="缩小">－</button><span class="le-hint" id="leZoomPct">100%</span>
      <button class="le-paperbtn" id="leZoomIn" title="放大">＋</button><span class="le-hint" title="在排版画布区滚动鼠标滚轮可缩放">滚轮缩放</span>
      <button class="le-paperbtn" id="leGrid">网格</button>
      <button class="le-paperbtn" id="leRotate" title="纸张旋转（横/竖向）">旋转</button>
      <button class="le-paperbtn" id="leClear" title="清空画布">清空</button>
    </div>
    ${converted ? '<div class="le-hint" style="margin:-6px 0 8px">ℹ️ 该模板为旧版字段模板，已自动转换为可视化版式（未改动原模板；点「保存」后升级为新版排版）。</div>' : ''}
    <div class="le-wrap">
      <div class="le-palette le-ep"></div>
      <div class="le-canvas"><div id="leDesign" style="min-height:300px"></div></div>
      <div class="le-setting"><div id="leSetting"></div></div>
    </div>
    <div class="le-bar" style="margin-top:10px">
      <span class="le-hint">拖入元素 · 拖动对齐自动吸附 · 方向键微调 · Ctrl+Z 撤销 / Ctrl+Shift+Z 重做 · Ctrl+C/V 复制粘贴 · Delete 删除</span>
      <span style="flex:1"></span>
      ${canTpl ? `<button class="btn r" id="leDel">删除模板</button>
        <button class="btn" id="leExport" title="导出模板 JSON（备份/跨店共享）">导出</button>
        <button class="btn" id="leImport" title="导入模板 JSON 覆盖当前">导入</button>
        <input type="file" id="leFile" accept=".json,application/json" style="display:none">
        <button class="btn" id="lePrint" title="按当前内容渲染并送默认打印机试打">试打</button>
        <button class="btn ${tpl.is_default ? '' : ''}" id="leDef" ${tpl.is_default ? 'disabled' : ''}>${tpl.is_default ? '已是默认' : '设为默认'}</button>
        <button class="btn pri" id="leSave">保存模板</button>`
      : '<span class="muted">无编辑权限（只读查看）</span>'}
    </div>
    <div id="lePages" style="display:none"></div>`;

  /* ── 业务字段/基础元素组 ── */
  function buildGroups() {
    const groups = [];
    const base = [
      { tid: 'pos.text', title: '文本', data: '文本内容', type: 'text',
        options: { title: '文本内容', testData: '文本内容', height: mm2pt(6), fontSize: 9, textAlign: 'center', hideTitle: true } },
      { tid: 'pos.hline', title: '直线', data: '', type: 'hline', options: { height: mm2pt(0.4), strokeWidth: mm2pt(0.4) } },
      { tid: 'pos.rect', title: '矩形框', data: '', type: 'rect', options: { height: mm2pt(10), strokeWidth: mm2pt(0.3) } },
      { tid: 'pos.image', title: '图片', data: '', type: 'image', options: { height: mm2pt(12) } },
    ];
    groups.push(new H.PrintElementTypeGroup('基础元素', base));
    const pool = (fieldPool && fieldPool[bizType]) || [];
    // V5.0.1：电子签字是图片字段——用 hiprint image 元素绑定 data.signImg（URL），拖入即打印签字图
    // V5.0.2：左侧字段面板「中文 + 字段英文」对照展示（如 供应商 supplier）
    const fields = pool.map(f => {
      const isImg = f.key === 'signImg' || f.key === 'signImgBiz';
      return isImg ? {
        tid: 'pos.f.' + f.key, title: `${f.label} ${f.key}`, data: '', type: 'image',
        options: { field: f.key, testData: '', height: mm2pt(12), hideTitle: true },
      } : {
        tid: 'pos.f.' + f.key, title: `${f.label} ${f.key}`, data: sampleVal(f.key), type: 'text',
        options: { field: f.key, testData: sampleVal(f.key), height: mm2pt(5), fontSize: 6.75, textAlign: 'left', hideTitle: true },
      };
    });
    if (isReceipt && !fields.some(f => f.options.field === 'items')) {
      fields.push({ tid: 'pos.f.items', title: '商品明细', data: '（商品明细）', type: 'text',
        options: { field: 'items', testData: '（商品明细）', height: mm2pt(10), fontSize: 7.5, hideTitle: true } });
    }
    groups.push(new H.PrintElementTypeGroup('业务字段', fields));
    const codes = [
      { tid: 'pos.barcode', title: '条码', data: sampleVal('barcode'), type: 'barcode',
        options: { field: 'barcode', testData: sampleVal('barcode'), height: mm2pt(10), hideTitle: true } },
      { tid: 'pos.qrcode', title: '二维码', data: sampleVal('barcode'), type: 'qrcode',
        options: { field: 'barcode', testData: sampleVal('barcode'), height: mm2pt(10), hideTitle: true } },
    ];
    groups.push(new H.PrintElementTypeGroup('码', codes));
    if (isDoc) {
      const cols = DOC_COLS[bizType] || DOC_COLS.inbound;
      groups.push(new H.PrintElementTypeGroup('明细表', [{
        tid: 'pos.table', title: '明细表', type: 'table',
        options: { field: 'items', tableHeaderRepeat: 'first', tableFooterRepeat: 'last',
          fields: cols.map(c => ({ text: c[1], field: c[0] })),
          columns: [cols.map(c => ({ title: c[1], field: c[0], width: c[2], tableTextAlign: 'center' }))],
          minHeight: mm2pt(40) },
      }]));
    }
    return groups;
  }

  /* ── 设计器初始化 ── */
  let hpTpl = null;
  const provider = function () { };
  provider.prototype.addElementTypes = function (context) {
    context.removePrintElementTypes('pos');
    context.addPrintElementTypes('pos', buildGroups());
  };
  H.init({ providers: [new provider()] });

  function buildTpl(templateJson) {
    container.querySelector('#leDesign').innerHTML = '';
    hpTpl = new H.PrintTemplate({
      template: templateJson,
      settingContainer: '#leSetting',
      paginationContainer: '#lePages',
      defaultPanelName: '页面',
    });
    hpTpl.design('#leDesign', { grid: state.grid });
    // V5.0.2：右侧属性面板「确定」兜底——hiprint 对部分元素类型的 submitOption 内部绑定会失效，
    // 而其 .auto-submit 的 change 路径始终可用：点击「确定」时代为触发一次 change（幂等提交选项）。
    container.querySelector('#leSetting').addEventListener('click', e => {
      if (!e.target.classList || !e.target.classList.contains('hiprint-option-item-submitBtn')) return;
      const inputs = container.querySelectorAll('#leSetting .auto-submit');
      inputs.forEach(inp => inp.dispatchEvent(new Event('change', { bubbles: true })));
      if (inputs.length) toast('属性已应用', true);
    });
    applyScale();
  }

  buildTpl(els2hp(doc.elements, designPaper(), bizType));
  H.PrintElementTypeManager.build('.le-ep', 'pos');

  /* ── 纸张按钮 ── */
  const PAPERS = {
    '标签': [['40x30', 40, 30], ['50x30', 50, 30], ['60x40', 60, 40]],
    '小票58': [['58mm 宽', 58, state.paper.hmm]],
    '小票80': [['80mm 宽', 80, state.paper.hmm]],
    'A5单据': [['A5', 148, 210]],
    'A4单据': [['A4', 210, 297], ['A3', 297, 420]],
  };
  const paperBox = container.querySelector('#lePapers');
  const paperList = PAPERS[kind] || PAPERS['A5单据'];
  function drawPapers() {
    paperBox.innerHTML = paperList.map(([n, w, h], i) =>
      `<button class="le-paperbtn ${w === state.paper.wmm && h === state.paper.hmm ? 'on' : ''}" data-p="${i}">${n}</button>`).join('');
    paperBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
      const [, w, h] = paperList[Number(b.dataset.p)];
      setPaper(w, h);
    });
  }
  function setPaper(w, h) {
    state.paper.wmm = Math.round(w); state.paper.hmm = Math.round(h);
    try { hpTpl.setPaper(state.paper.wmm + PAD_W, state.paper.hmm + PAD_H); } catch { buildTpl(els2hp(currentEls(), designPaper(), bizType)); }
    drawPapers();
  }
  drawPapers();
  const customBox = container.querySelector('#leCustom');
  if (isReceipt) customBox.style.display = 'none';
  container.querySelector('#leCApply').onclick = () => {
    const cw = container.querySelector('#leCw'), ch = container.querySelector('#leCh');
    let w = Number((cw.value || '').trim()), h = Number((ch.value || '').trim());
    // 兼容在「宽」框内直接填 "40x30" / "40*30" / "40×30" 整体形式
    // （浏览器 number 输入框遇非数字会清空，导致 leCh 为空、误报「超出范围」）
    const m = (cw.value || '').match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/);
    if (m) { w = Number(m[1]); h = Number(m[2]); }
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) { toast('请填写纸张宽与高（mm），如 40x30', false); return; }
    if (w >= 15 && w <= 297 && h >= 15 && h <= 500) setPaper(w, h);
    else toast('纸张宽高超出范围（15~297 × 15~500mm）', false);
  };

  /* ── 缩放 / 网格 / 旋转 / 清空 ── */
  function applyScale() {
    container.querySelector('#leZoomPct').textContent = Math.round(state.scale * 100) + '%';
    try { hpTpl.editingPanel && hpTpl.editingPanel.zoom(state.scale); } catch { /* 兼容 */ }
  }
  container.querySelector('#leZoomIn').onclick = () => { state.scale = Math.min(2, Math.round((state.scale + 0.1) * 10) / 10); applyScale(); };
  container.querySelector('#leZoomOut').onclick = () => { state.scale = Math.max(0.5, Math.round((state.scale - 0.1) * 10) / 10); applyScale(); };
  // V5.0.5：在排版画布区滚动鼠标滚轮即可缩放，方便编辑时微调查看
  const leCanvas = container.querySelector('.le-canvas');
  leCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const next = Math.min(2, Math.max(0.5, Math.round((state.scale + dir * 0.1) * 10) / 10));
    if (next !== state.scale) { state.scale = next; applyScale(); }
  }, { passive: false });
  // V5.0.5：在画布空白处（非元素/控件）按住左键拖动可平移视图，方便把元素拖到纸张外排列
  leCanvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.hiprint-printElement') || e.target.closest('.le-paperbtn')
      || e.target.closest('input') || e.target.closest('button') || e.target.closest('select')) return;
    const sx = e.clientX, sy = e.clientY, sl = leCanvas.scrollLeft, st = leCanvas.scrollTop;
    leCanvas.style.cursor = 'grabbing';
    const mv = (ev) => { leCanvas.scrollLeft = sl - (ev.clientX - sx); leCanvas.scrollTop = st - (ev.clientY - sy); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); leCanvas.style.cursor = ''; };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    e.preventDefault();
  });
  const gridBtn = container.querySelector('#leGrid');
  gridBtn.classList.toggle('le-paperbtn', true);
  gridBtn.onclick = () => {
    state.grid = !state.grid;
    gridBtn.style.background = state.grid ? 'var(--pri,#20663f)' : '';
    gridBtn.style.color = state.grid ? '#fff' : '';
    const d = container.querySelector('#leDesign .hiprint-printPaper.design');
    if (d) d.classList.toggle('grid', state.grid);
  };
  container.querySelector('#leRotate').onclick = () => { try { hpTpl.rotatePaper(); } catch { /* noop */ } };
  container.querySelector('#leClear').onclick = async () => {
    if (!canTpl) { toast('无编辑权限', false); return; }
    if (!confirm('确认清空画布所有元素？（不保存不生效）')) return;
    buildTpl(els2hp([], designPaper(), bizType));
  };

  /* ── 保存 / 试打 / 导入导出 / 删除 / 设默认 ── */
  function currentEls() {
    try {
      const r = hip2els(hpTpl.getJson());
      return r ? r.elements : doc.elements;
    } catch { return doc.elements; }
  }
  function collect() {
    const raw = hpTpl.getJson();
    const json = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw));
    // 编辑期纸张放大了留白，保存时还原为真实纸张尺寸（超界元素打印/预览按真实纸裁切）
    const fixPaper = (j) => {
      if (!j) return;
      const ps = j.panels || (j.template && j.template.panels);
      if (ps && ps[0]) {
        ps[0].width = state.paper.wmm; ps[0].height = state.paper.hmm; ps[0].paperFooter = mm2pt(state.paper.hmm);
      }
      if (typeof j.width === 'number') { j.width = state.paper.wmm; j.height = state.paper.hmm; }
    };
    fixPaper(json); fixPaper(json && json.template);
    return {
      name: container.querySelector('#leName').value.trim() || tpl.name,
      copies: Number(container.querySelector('#leCopies').value) || 1,
      content: {
        version: 3,
        title: container.querySelector('#leTitle').value.trim() || tpl.name,
        hp: json,
        paper: { wmm: state.paper.wmm, hmm: state.paper.hmm },
        options: state.options,
      },
    };
  }
  if (isReceipt) {
    const oc = container.querySelector('#leOptCut'), od = container.querySelector('#leOptDrawer');
    if (oc) oc.onchange = () => state.options.cut = oc.checked;
    if (od) od.onchange = () => state.options.cashDrawer = od.checked;
  }
  if (canTpl) {
    container.querySelector('#leSave').onclick = async () => {
      const d = collect();
      if (!d.name) { toast('模板名称必填', false); return; }
      await must(put(`/print-templates/${tpl.id}`, d), '排版已保存');
      hooks.onSaved && hooks.onSaved();
    };
    container.querySelector('#lePrint').onclick = async () => {
      const d = collect();
      await must(put(`/print-templates/${tpl.id}`, { content: d.content }), '');
      const r = await must(post(`/print-templates/${tpl.id}/print`));
      toast(`试打已送 ${r?.printer || '默认打印机'}`);
    };
    container.querySelector('#leDef').onclick = async () => {
      if (tpl.is_default) return;
      await must(put(`/print-templates/${tpl.id}/default`), '已设为默认');
      hooks.onSaved && hooks.onSaved();
    };
    container.querySelector('#leDel').onclick = async () => {
      if (!confirm(`确认删除模板「${tpl.name}」？`)) return;
      hooks.onDelete && await hooks.onDelete();
    };
    container.querySelector('#leExport').onclick = () => {
      const d = collect();
      const blob = new Blob([JSON.stringify({ name: d.name, kind, bizType, copies: d.copies, content: d.content }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `print-template-${d.name || tpl.id}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      toast('已导出模板 JSON');
    };
    const fileInput = container.querySelector('#leFile');
    container.querySelector('#leImport').onclick = () => fileInput.click();
    fileInput.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j.content || !(j.content.hp || (j.content.version === 2 && Array.isArray(j.content.elements)))) {
          throw new Error('JSON 须为新版排版模板（content.hp）');
        }
        await must(put(`/print-templates/${tpl.id}`, { name: j.name || tpl.name, copies: Number(j.copies) || tpl.copies, content: j.content }), '模板已导入');
        hooks.onSaved && hooks.onSaved();
      } catch (err) { toast('导入失败：' + (err.message || err), false); }
      e.target.value = '';
    };
  }

  return {
    destroy() { try { container.querySelector('#leDesign').innerHTML = ''; } catch { /* noop */ } hpTpl = null; },
  };
}
