/**
 * 打印渲染引擎（9.9 打印中心）：测试页 + 模板预览文本渲染
 * 中文字符按 2 半角宽度折行；宽度：58mm=32 列、80mm=48 列（A5 单据走 80 列）
 */

const COL: Record<string, number> = { 58: 32, 80: 48, A5: 48, A4: 72, 标签: 24 };
import { normalizeLayoutDoc } from './print.hiprint';

/** 显示宽度（全角=2） */
function w(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0)! > 255 ? 2 : 1;
  return n;
}

/** 居中对齐 */
export function center(s: string, col: number): string {
  const pad = Math.max(0, col - w(s));
  return ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(pad - Math.floor(pad / 2));
}

/** 左右两段对齐（key: value） */
function kv(k: string, v: string, col: number): string {
  const pad = Math.max(1, col - w(k) - w(v));
  return k + ' '.repeat(pad) + v;
}

/** 分隔线 */
export function line(ch: string, col: number): string {
  return ch.repeat(col);
}

/** 按列宽折行（长文本分段） */
export function wrap(s: string, col: number): string[] {
  const rows: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (w(cur + ch) > col) { rows.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) rows.push(cur);
  return rows;
}

/** 测试页渲染：走纸自检 + 型号 + 时间 + 字符覆盖 */
export function renderTestPage(printer: any, ts = new Date()): string {
  const col = COL[String(printer.width_mm || 80)] || 48;
  const t = ts.toLocaleString('zh-CN', { hour12: false });
  const rows: string[] = [
    center('打印机测试页', col),
    line('=', col),
    kv('设备名', printer.name || '未命名', col),
    kv('连接', `${printer.conn_type || ''} ${printer.conn_addr || ''}`, col),
    kv('纸宽', `${printer.width_mm || 80}mm`, col),
    kv('时间', t, col),
    line('-', col),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'abcdefghijklmnopqrstuvwxyz !@#$%^&*()',
    '中文打印测试：超市收银系统 打印中心',
    line('=', col),
    center('打印正常 · 联次齐全 · 切刀/钱箱已就绪', col),
    center('绿源社区超市', col),
  ];
  return rows.join('\n');
}

/** 字段示例值（v1/v2 预览共用；V4.15.9 提升到模块级） */
const samples: Record<string, string> = {
  store: '绿源社区超市（示范店）',
  orderNo: '单号 SO20260906001',
  time: '日期 2026/09/06 10:30',
  cashier: '收银员 王秀英',
  supplier: '供应商 康师傅经销部',
  operator: '经手人 张三',
  counter: '盘点人 李四',
  period: '账期 2026/08/01 - 2026/08/31',
  from: '调出 中心仓',
  to: '调入 门店A',
  items: '',
  total: '合计 ¥1,234.56',
  subtotal: '合计 ¥123.45',
  discount: '优惠 -¥5.00',
  member: '会员 王女士（金卡）',
  coupon: '券抵扣 -¥10.00',
  pay: '支付 微信 ¥118.45',
  change: '找零 ¥0.00',
  points: '积分 +118',
  reason: '原因 临期/破损',
  diff: '差异 +2 / -1',
  confirm: '确认 签名：＿＿＿＿',
  sign: '签字 ＿＿＿＿＿＿',
  remark: '备注 无',
  thanks: '谢谢惠顾，欢迎再次光临！',
  // V4.15.8 P4：标签两类（价签/秤贴）样例
  name: '红富士苹果',
  price: '售价 ￥9.98',
  promoPrice: '促销价 ￥7.99（原价划线）',
  barcode: '6901234567890',
  unit: '单位 千克',
  spec: '规格 500g',
  keepDays: '保质期 12个月',
  unitPrice: '单价 ￥9.98/千克',
  weight: '重量 1.234kg',
  amount: '金额 ￥12.31',
  info: '千克 · 500g · 保质12个月',
};

/** v2 排版预览：elements 逐元素按示例值渲染文本近似版（V4.15.9） */
function renderLayoutPreview(tpl: any, content: any): string {
  const isLabel = String(tpl.kind) === '标签';
  const els = (Array.isArray(content.elements) ? content.elements : [])
    .filter((e: any) => e && e.show !== false)
    .sort((a: any, b: any) => (Number(a.y) || 0) - (Number(b.y) || 0));
  const rows: string[] = [];
  for (const el of els) {
    const t = typeof el.type === 'string' ? el.type : '';
    if (t === 'barcode') { rows.push(`▌▌▍▌▍▌ ${(samples[el.key] || el.key || '条码')}`); continue; }
    if (t === 'qrcode') { rows.push(`▚▚▚ 二维码（${el.key || ''}）`); continue; }
    if (t === 'divider' || t === 'line') { rows.push('-'.repeat(isLabel ? 22 : 32)); continue; }
    if (t === 'rect' || t === 'box') { rows.push('┌' + '─'.repeat(20) + '┐'); continue; }
    if (t === 'items') { rows.push('商品A x1 ￥5.98', '商品B x2 ￥12.00'); continue; }
    if (t === 'total') { rows.push('合计 ￥18.46'); continue; }
    if (t === 'kv') { rows.push(`${el.label || ''}${samples[el.key] || '示例值'}`); continue; }
    if (t === 'field') { rows.push(samples[el.key] || `字段 ${el.key || '—'}`); continue; }
    if (t === 'text') { rows.push(String(el.text ?? '')); continue; }
    rows.push(`〔${t}〕`);
  }
  const head = content.title ? [content.title] : [];
  return [...head, ...rows].join('\n');
}

/** 模板预览：v2/v3 排版走 renderLayoutPreview；v1 按模板字段池渲染示例值 */
export function renderTemplatePreview(tpl: any): string {
  const content = (typeof tpl.content === 'string' ? JSON.parse(tpl.content) : tpl.content) || {};
  const doc = normalizeLayoutDoc(content);
  if (doc && Array.isArray(doc.elements) && doc.elements.length) {
    return renderLayoutPreview(tpl, { title: content.title, elements: doc.elements });
  }
  const col = COL[String(tpl.kind || 'A5单据')] || 48;
  const title = content.title || tpl.name || '单据';
  const fields: any[] = Array.isArray(content.fields) ? content.fields : [];
  const rows: string[] = [center(title, col), line('=', col)];

  for (const f of fields) {
    if (!f.show) continue;
    if (f.key === 'items') {
      rows.push('--- 明细（示例） ---');
      rows.push(kv('苹果 1kg', '¥5.98', col));
      rows.push(kv('牛奶 2瓶', '¥12.00', col));
      rows.push(line('-', col));
      continue;
    }
    const s = samples[f.key] || `${f.label || f.key}：示例值`;
    rows.push(...wrap(s, col));
  }
  if (content.options?.qr) rows.push('', '▌▌▌▌▌▌ 扫码溯源/评价 ▌▌▌▌▌▌');
  if (content.options?.ad) rows.push('全场满 29 元免配送费 · 会员充值有礼');
  rows.push(line('=', col));
  if (content.options?.cut) rows.push('【切刀】');
  return rows.join('\n');
}

/** 打印机名称 → 打印历史 job_type 展示 */
export const JOB_TYPE = { 打印: '打印', 测试页: '测试页' };