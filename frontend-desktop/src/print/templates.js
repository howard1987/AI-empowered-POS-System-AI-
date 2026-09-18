/**
 * 打印模板（T16，方案 V4.6.4）：
 *   小票：58mm / 80mm 两种纸宽，ESC/POS 文本渲染（纯函数，Node 可跑冒烟测试）
 *   A5 单据：字段可配（模板 JSON：fields 数组声明列与顺序，V4.6.4 8 列精简默认）
 * 所有模板只做「数据 → 行数组」，上层负责送打（USB/蓝牙/网口 或 Electron silent print）
 */

/** 金额格式化：¥1,234.50 */
function fmt(n) {
  return Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 按纸宽计算中文字符列宽：58mm≈32 列，80mm≈48 列（1 中文 = 2 列） */
function cols(widthMm) {
  return widthMm >= 80 ? 48 : 32;
}

/** 居中（中文按 2 列） */
function center(text, width) {
  const len = [...String(text)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  const pad = Math.max(0, Math.floor((width - len) / 2));
  return ' '.repeat(pad) + String(text);
}

/** 左右对齐一行：左文本 + 右金额 */
function twoCol(left, right, width) {
  const r = String(right);
  const rLen = [...r].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  let l = String(left);
  const lLen = [...l].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  if (lLen + rLen > width - 1) l = l.slice(0, Math.max(0, width - 1 - rLen)); // 超长截断
  const pad = Math.max(1, width - rLen - lLen);
  return l + ' '.repeat(pad) + r;
}

/**
 * 小票模板（58/80mm）
 * @param {object} order {orderNo, createdAt, storeName, cashierName, memberName, items:[{name,qty,unit,unitPrice,amount}], goodsAmount, promoAmount, memberDiscount, payable, payments:[{channel,amount}], points}
 * @param {58|80} widthMm
 */
function renderReceipt(order, widthMm = 80) {
  const W = cols(widthMm);
  const L = [];
  const line = '-'.repeat(W);
  L.push(center(order.storeName || '社区超市', W));
  L.push(line);
  L.push(`单号:${order.orderNo}`);
  L.push(`时间:${order.createdAt}`);
  if (order.cashierName) L.push(`收银员:${order.cashierName}`);
  if (order.memberName) L.push(`会员:${order.memberName}`);
  L.push(line);
  L.push(twoCol('商品', '金额', W));
  for (const it of order.items || []) {
    L.push(twoCol(`${it.name}`, fmt(it.amount), W));
    L.push(`  ${it.qty}${it.unit || ''} × ${fmt(it.unitPrice)}`);
  }
  L.push(line);
  L.push(twoCol('合计', fmt(order.goodsAmount), W));
  if (Number(order.promoAmount) > 0) L.push(twoCol('促销优惠', '-' + fmt(order.promoAmount), W));
  if (Number(order.memberDiscount) > 0) L.push(twoCol('会员折扣', '-' + fmt(order.memberDiscount), W));
  L.push(twoCol('应收', fmt(order.payable), W));
  L.push(line);
  for (const p of order.payments || []) L.push(twoCol(p.channel, fmt(p.amount), W));
  if (Number(order.points) > 0) L.push(`本单积分:+${order.points}`);
  L.push(line);
  L.push(center('谢谢惠顾，欢迎再次光临', W));
  L.push(center('会员分红按日发放，仅限消费抵用', W));
  return L.join('\n');
}

/** 默认 A5 单据列（8 列精简，V4.6.4：列可配） */
const DEFAULT_A5_FIELDS = [
  { key: 'productName', label: '商品名称', width: '22%' },
  { key: 'unit', label: '单位', width: '8%' },
  { key: 'qty', label: '数量', width: '10%', align: 'right' },
  { key: 'unitPrice', label: '单价', width: '12%', align: 'right' },
  { key: 'amount', label: '金额', width: '12%', align: 'right' },
  { key: 'promo', label: '优惠', width: '12%', align: 'right' },
  { key: 'cost', label: '成本', width: '12%', align: 'right' },
  { key: 'profit', label: '毛利', width: '12%', align: 'right' },
];

/**
 * A5 单据 HTML（列字段可配；Electron 隐藏窗口 silent print）
 * @param {object} doc {title, orderNo, createdAt, storeName, items:[...], totals:{...}}
 * @param {Array} fields 列配置（DEFAULT_A5_FIELDS 结构）
 */
function renderA5Html(doc, fields = DEFAULT_A5_FIELDS) {
  // P1-H9：注入 data:text/html 打印文档的动态值统一转义；样式属性白名单校验
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const safeWidth = w => /^[\d.]+(%|px|em|rem|mm)?$/.test(String(w ?? '')) ? esc(w) : 'auto';
  const safeAlign = a => ['left', 'right', 'center'].includes(a) ? a : 'left';
  const th = fields.map(f => `<th style="width:${safeWidth(f.width)};text-align:${safeAlign(f.align)}">${esc(f.label)}</th>`).join('');
  const td = row => fields.map(f => {
    const v = row[f.key] ?? '';
    return `<td style="text-align:${safeAlign(f.align)}">${esc(v)}</td>`;
  }).join('');
  const totalsRow = Object.assign({ productName: '合计' }, doc.totals || {});
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: A5; margin: 10mm; }
    body { font-family: "Microsoft YaHei", sans-serif; font-size: 10pt; }
    h2 { text-align: center; margin: 4px 0; }
    .meta { font-size: 9pt; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #333; padding: 3px 5px; font-size: 9pt; }
  </style></head><body>
  <h2>${esc(doc.title || '销售单据')}</h2>
  <div class="meta">${esc(doc.storeName || '')}　单号:${esc(doc.orderNo || '')}　时间:${esc(doc.createdAt || '')}</div>
  <table><thead><tr>${th}</tr></thead>
  <tbody>${(doc.items || []).map(r => `<tr>${td(r)}</tr>`).join('')}
  <tr>${td(totalsRow)}</tr>
  </tbody></table></body></html>`;
}

module.exports = { fmt, cols, center, twoCol, renderReceipt, renderA5Html, DEFAULT_A5_FIELDS };
