/**
 * A5 业务单据统一打印：
 *   - 七类：入库 / 退货 / 订货 / 报损 / 盘点 / 调拨 / 对账（一单一页 A5，CSS @page 精确版式）
 *   - 三入口：详情弹窗「打印单据」+ 列表勾选批量 + 审核通过后自动弹（doc.print.auto_a5，可关）
 *   - 权限：docs.print.a5（店长及以上）——按钮显隐 + 留痕端点双重约束
 *   - 份数 1~3；每次打印成功后 POST /print-jobs/a5 落 print_jobs（重打加「重打」标识）
 */
import { get, post, must, esc, dt, money, toast, imgUrl, API } from './api.js';

/* ── 权限与设置 ── */
export function canPrintA5() {
  const perms = API.user?.perms || [];
  return perms.includes('docs.print.a5') || perms.includes('*');
}

let autoA5Cache, autoA5At = 0;
/** 审核后自动弹 A5 打印开关（doc.print.auto_a5，60s 缓存；缺省关）。value 为 jsonb（可能 0/1 数字或字符串） */
export async function autoA5Enabled() {
  if (autoA5Cache !== undefined && Date.now() - autoA5At < 60000) return String(autoA5Cache) === '1';
  try {
    const v = await must(get('/settings/key/doc.print.auto_a5')).catch(() => null);
    const val = v?.value;
    autoA5Cache = Array.isArray(val) ? val[0] : val;
  } catch { autoA5Cache = '0'; }
  autoA5At = Date.now();
  return String(autoA5Cache) === '1';
}

/* ── 七类单据取数 + 归一化 ──
   归一结构：{ docNo, title, meta:[[label,value]], cols:[{k,label,num}], lines:[...], totalLabel, totalQty, totalAmount, signImg, remark, footer } */
const DOC_DEFS = {
  inbound: {
    title: '采购入库单',
    fetch: id => get(`/purchase/inbounds/${id}`),
    norm: d => {
      const o = d.order || {}, its = d.items || [];
      return {
        docNo: o.inbound_no || '', meta: [['供应商', o.supplier_name], ['日期', String(o.inbound_date || o.created_at || '').slice(0, 10)],
          ['状态', o.status], ['制单人', o.maker_name]],
        cols: [{ k: 'name', label: '商品' }, { k: 'unit', label: '单位' }, { k: 'qty', label: '数量', num: 1 },
          { k: 'price', label: '进价', num: 1 }, { k: 'pdate', label: '生产日期' }, { k: 'batch', label: '批次' }, { k: 'amount', label: '金额', num: 1 }],
        lines: its.map(it => ({ name: it.product_name, unit: it.base_unit || '', qty: Number(it.qty) || 0, price: it.unit_cost != null ? Number(it.unit_cost) : null,
          pdate: it.production_date ? String(it.production_date).slice(0, 10) : '—', batch: String(it.batch_no || '未审核').replace(/-\d{2}$/, '') })),
        totalQty: its.reduce((s, x) => s + Number(x.qty || 0), 0), totalAmount: Number(o.total_amount || 0),
        // V5.0.18g 修复主体关联：operator_sign_image_path=操作员本人（登录人）签名；
        // sign_image_path=供应商业务员预采签名（原被误标操作员）——按角色分槽，姓名图一一配对
        signItems: [
          ...(o.operator_sign_image_path ? [{ path: o.operator_sign_image_path, name: o.operator_sign_name || '', role: '操作员' }] : []),
          ...(o.sign_image_path ? [{ path: o.sign_image_path, name: '', role: '业务员' }] : []),
        ],
        signImg: o.operator_sign_image_path || o.sign_image_path || '', footer: ['操作员签字', '仓管', '审核'],
      };
    },
  },
  return: {
    title: '采购退货单',
    fetch: id => get(`/purchase/returns/${id}`),
    norm: d => {
      const o = d.order || {}, its = d.items || [];
      return {
        docNo: o.return_no || '', meta: [['供应商', o.supplier_name], ['状态', o.status], ['制单人', o.maker_name], ['备注', o.remark || '—']],
        cols: [{ k: 'name', label: '商品' }, { k: 'unit', label: '单位' }, { k: 'qty', label: '退货数量', num: 1 },
          { k: 'price', label: '原批次价', num: 1 }, { k: 'batch', label: '批次' }, { k: 'amount', label: '金额', num: 1 }],
        lines: its.map(it => ({ name: it.product_name, unit: it.base_unit || '', qty: Number(it.qty) || 0, price: it.unit_cost != null ? Number(it.unit_cost) : null,
          batch: String(it.batch_no || '—').replace(/-\d{2}$/, '') })),
        totalQty: its.reduce((s, x) => s + Number(x.qty || 0), 0), totalAmount: Number(o.total_amount || 0),
        signItems: [
          ...(o.operator_sign_image_path ? [{ path: o.operator_sign_image_path, name: o.operator_sign_name || '', role: '操作员' }] : []),
          ...(o.sign_image_path ? [{ path: o.sign_image_path, name: '', role: '业务员' }] : []),
        ],
        signImg: o.operator_sign_image_path || o.sign_image_path || '', footer: ['操作员签字', '仓管', '审核'],
      };
    },
  },
  order: {
    title: '采购订货单',
    fetch: id => get(`/purchase/orders/${id}`),
    norm: d => {
      const o = d, its = d.items || [];
      const PO_ST = { 草稿: '草稿', 待审批: '待审批', 待到货: '待到货', 部分到货: '部分到货', 已到货: '已到货', 已作废: '已作废' };
      return {
        docNo: o.po_no || '', meta: [['供应商', o.supplier_name], ['状态', PO_ST[o.status] || o.status || ''],
          ['预计到货', o.expect_arrival ? String(o.expect_arrival).slice(0, 10) : '—'], ['备注', o.remark || '—']],
        cols: [{ k: 'name', label: '商品' }, { k: 'unit', label: '单位' }, { k: 'qty', label: '订购数量', num: 1 },
          { k: 'arrived', label: '已到货', num: 1 }, { k: 'price', label: '含税进价', num: 1 }, { k: 'amount', label: '金额', num: 1 }, { k: 'rmk', label: '备注' }],
        lines: its.map(it => ({ name: it.product_name, unit: it.base_unit || '', qty: Number(it.order_qty) || 0, arrived: Number(it.arrived_qty || 0),
          price: it.price != null ? Number(it.price) : null, rmk: it.line_remark || '' })),
        totalQty: its.reduce((s, x) => s + Number(x.order_qty || 0), 0), totalAmount: Number(o.total_amount || 0),
        signImg: o.approver_sign_path, footer: ['制单人', '审批人'],
      };
    },
  },
  loss: {
    title: '报损单',
    fetch: id => get(`/inventory/losses/${id}`),
    norm: d => {
      const o = d, its = d.items || [];
      return {
        docNo: o.loss_no || '', meta: [['原因', o.reason_type], ['状态', o.status], ['经办人', o.employee_name], ['备注', o.remark || '—']],
        cols: [{ k: 'name', label: '商品' }, { k: 'unit', label: '单位' }, { k: 'batch', label: '批次' },
          { k: 'qty', label: '数量', num: 1 }, { k: 'price', label: '成本', num: 1 }, { k: 'amount', label: '金额', num: 1 }],
        lines: its.map(it => ({ name: it.product_name, unit: it.base_unit || '', batch: it.batch_no || '—', qty: Number(it.qty) || 0,
          price: it.unit_cost != null ? Number(it.unit_cost) : null })),
        totalQty: its.reduce((s, x) => s + Number(x.qty || 0), 0), totalAmount: Number(o.total_cost || 0),
        footer: ['经办人签字', '审核'],
      };
    },
  },
  count: {
    title: '盘点单',
    fetch: id => get(`/inventory/counts/${id}`),
    norm: d => {
      const o = d, its = d.items || [];
      return {
        docNo: o.count_no || '', meta: [['范围', o.scope], ['盘点人', o.employee_name], ['状态', o.status], ['备注', o.remark || '—']],
        cols: [{ k: 'name', label: '商品' }, { k: 'unit', label: '单位' }, { k: 'book', label: '账面', num: 1 },
          { k: 'qty', label: '实盘', num: 1 }, { k: 'diff', label: '差异', num: 1 }, { k: 'amount', label: '差异成本', num: 1 }],
        lines: its.map(it => ({ name: it.product_name, unit: it.base_unit || '', book: Number(it.book_qty) || 0, qty: Number(it.actual_qty) || 0,
          diff: Number(it.diff_qty || 0), amount: it.diff_cost != null ? Number(it.diff_cost) : null })),
        totalQty: its.reduce((s, x) => s + Number(x.actual_qty || 0), 0),
        totalLabel: '差异合计', totalAmount: its.reduce((s, x) => s + Number(x.diff_cost || 0), 0),
        footer: ['盘点人签字', '审核'],
      };
    },
  },
  transfer: {
    title: '库存调拨单',
    fetch: id => get(`/inventory/transfers/${id}`),
    norm: d => {
      const o = d, its = d.items || [];
      return {
        docNo: o.transfer_no || '', meta: [['调出', o.from_store_name || '本店'], ['调入', o.to_store_name || '本店（店内）'],
          ['原因', o.reason || '—'], ['经办人', o.employee_name], ['状态', o.status]],
        cols: [{ k: 'name', label: '商品' }, { k: 'unit', label: '单位' }, { k: 'batch', label: '批次' },
          { k: 'qty', label: '数量', num: 1 }, { k: 'price', label: '成本', num: 1 }, { k: 'amount', label: '金额', num: 1 }],
        lines: its.map(it => ({ name: it.product_name, unit: it.base_unit || '', batch: it.batch_no || '—', qty: Number(it.qty) || 0,
          price: it.unit_cost != null ? Number(it.unit_cost) : null })),
        totalQty: its.reduce((s, x) => s + Number(x.qty || 0), 0), totalAmount: Number(o.total_cost || 0),
        footer: ['经办人签字', '确认', '审核'],
      };
    },
  },
  recon: {
    title: '对账单',
    fetch: id => get(`/purchase/recons/${id}`),
    norm: d => {
      const o = d.recon || {}, its = d.items || [];
      const DOC_CN = { inbound: '入库', return: '退货', fee: '费用' };
      return {
        docNo: o.recon_no || '', meta: [['供应商', o.supplier_name], ['账期', `${String(o.period_start || '').slice(0, 10)} ~ ${String(o.period_end || '').slice(0, 10)}`],
          ['状态', o.status], ['业务员', o.salesman || '—']],
        cols: [{ k: 'rmk', label: '类别' }, { k: 'name', label: '原始单号' }, { k: 'pdate', label: '日期' },
          { k: 'amount', label: '金额', num: 1 }, { k: 'batch', label: '未付金额', num: 1 }],
        lines: its.map(it => ({ rmk: DOC_CN[it.doc_type] || it.doc_type || '', name: it.doc_no, pdate: it.doc_date ? String(it.doc_date).slice(0, 10) : '—',
          amount: Number(it.amount || 0), batch: it.unpaid_amount != null ? Number(it.unpaid_amount) : null })),
        totalLabel: '应付合计', totalAmount: Number(o.payable_total || 0),
        footer: ['供应商确认', '店长签字'],
      };
    },
  },
};

/* ── A5 模版：抬头标题 / 备注显隐 / 联次默认份数（60s 缓存，无模版=默认版式） ── */
let a5TplCache = {}, a5TplAt = 0;
async function a5Tpl(bizType, force) {
  if (!force && a5TplCache[bizType] !== undefined && Date.now() - a5TplAt < 60000) return a5TplCache[bizType];
  try { a5TplCache[bizType] = await must(get(`/print-templates/default?bizType=${bizType}&kind=A5单据`)).catch(() => null); }
  catch { a5TplCache[bizType] = null; }
  a5TplAt = Date.now();
  return a5TplCache[bizType];
}

/* ── V4.16.4 电子签名补全（核查整改）：入库/退货/订单详情接口自带 sign 字段；
   报损/盘点/调拨/对账等从签名证据链（signature_records）补图——屏幕展示与 A5 打印同一来源 ── */
const SIG_BIZ = { inbound: 'inbound', return: 'return', order: 'order', loss: 'loss', count: 'count', transfer: 'transfer', recon: '对账确认' };
async function attachSigs(type, norm, id) {
  // V5.0.2：签字证据按角色分组——「本店人员（操作员）」与「业务人员（业务员）」各自姓名+签字图配对，
  // 供 A5 版式把签字落到对应槽位（本店人员签字 / 业务人员签字），不再按顺序盲填、张冠李戴。
  try {
    const r = await must(get(`/purchase/signature-records?bizType=${encodeURIComponent(SIG_BIZ[type] || type)}&bizId=${id}`));
    const recs = (r.items || []).filter(x => x.image_path).map(x => ({
      path: x.image_path,
      name: x.person_name || x.result_person || '',
      role: String(x.role_label || '').includes('业务') ? '业务员' : '操作员',
    }));
    if (recs.length) {
      norm.signItems = recs;
      norm.signImgs = recs.map(s => s.path);
      if (!norm.signImg) norm.signImg = recs[0].path;
      norm.signNames = recs.map(s => s.name).filter(Boolean);
    } else if (norm.signImg && !norm.signItems) {
      norm.signItems = [{ path: norm.signImg, name: '', role: '操作员' }];
    }
  } catch {
    // 查询失败照常出单（签名栏留白手签），绝不阻断打印
    if (norm.signImg && !norm.signItems) norm.signItems = [{ path: norm.signImg, name: '', role: '操作员' }];
  }
}

/* ── V4.15.9 hiprint 排版模版打印（激光/喷墨 A5/A4）──
   模版 content.version===3 时：单据数据 → 字段映射 → hiprint getHtml 出整页 HTML → 浏览器打印 */
const HIP_META_KEY = {
  '供应商': 'supplier', '日期': 'time', '时间': 'time', '状态': 'status', '制单人': 'operator', '经手人': 'operator',
  '经办人': 'operator', '盘点人': 'counter', '操作员': 'operator', '备注': 'remark', '账期': 'period',
  '调出': 'from', '调入': 'to', '原因': 'reason', '范围': 'scope', '业务员': 'salesman', '预计到货': 'expect',
  '大客户': 'bigcustomer',
};
let hipLockCss = null;
async function hipPrintCss() {
  if (hipLockCss) return hipLockCss;
  try { hipLockCss = await (await fetch('vendor/hiprint/print-lock.css')).text(); } catch { hipLockCss = ''; }
  return hipLockCss;
}
function docPrintData(norm) {
  const data = { docNo: norm.docNo || '', orderNo: norm.docNo || '', title: norm.title || '', items: norm.lines || [],
    totalQty: norm.totalQty, total: norm.totalAmount, totalLabel: norm.totalLabel || '合计',
    printTime: new Date().toLocaleString('zh-CN', { hour12: false }) };
  for (const [k, v] of (norm.meta || [])) data[HIP_META_KEY[k] || k] = v;
  if (norm.remark) data.remark = norm.remark;
  // V5.0.2：签名按角色分组暴露给模版字段——
  //   本店人员：signImg（签字图）/ signName（姓名）；业务人员：signImgBiz / signNameBiz
  const sigItems = Array.isArray(norm.signItems) && norm.signItems.length ? norm.signItems
    : (norm.signImgs && norm.signImgs.length ? norm.signImgs.map(p => ({ path: p, name: '', role: '操作员' }))
      : (norm.signImg ? [{ path: norm.signImg, name: '', role: '操作员' }] : []));
  const opSigs = sigItems.filter(s => s.role !== '业务员');
  const bizSigs = sigItems.filter(s => s.role === '业务员');
  if (opSigs.length) { data.signImg = imgUrl(opSigs[0].path); data.signName = opSigs.map(s => s.name).filter(Boolean).join('、'); }
  if (bizSigs.length) { data.signImgBiz = imgUrl(bizSigs[0].path); data.signNameBiz = bizSigs.map(s => s.name).filter(Boolean).join('、'); }
  return data;
}
async function printDocsHiprint(hp, docs, copies, jobType, metas) {
  const css = await hipPrintCss();
  const tplHp = new window.hiprint.PrintTemplate({ template: hp });
  let html = '';
  for (const norm of docs) {
    const data = docPrintData(norm);
    if (jobType === '重打') data.reprint = '*** 重 打 ***';
    const sItems = Array.isArray(norm.signItems) && norm.signItems.length ? norm.signItems
      : (norm.signImgs && norm.signImgs.length ? norm.signImgs.map(p => ({ path: p, name: '', role: '操作员' }))
        : (norm.signImg ? [{ path: norm.signImg, name: '', role: '操作员' }] : []));
    for (let c = 0; c < copies; c++) {
      const $h = tplHp.getHtml(data);
      let one = ($h && $h[0] ? $h[0].outerHTML : String($h)) || '';
      // V4.16.4：模版未绑定签名图（HTML 中无 /signatures/ 资源）→ 兜底追加电子签名行（姓名+角色配对）
      if (sItems.length && !one.includes('/signatures/')) {
        one += `<div style="display:flex;gap:28px;align-items:flex-end;font-size:12.5px;color:#111;margin:6mm 10mm 0;flex-wrap:wrap">
          <span>✍️ 本店人员签字：${sItems.filter(s => s.role !== '业务员').map(s => `<img style="max-height:52px;vertical-align:middle;border:1px dashed #bbb;border-radius:6px" src="${esc(imgUrl(s.path))}">${s.name ? `<span style="font-size:11px;color:#555">（${esc(s.name)}）</span>` : ''}`).join(' ') || '__________'}</span>
          <span>✍️ 业务人员签字：${sItems.filter(s => s.role === '业务员').map(s => `<img style="max-height:52px;vertical-align:middle;border:1px dashed #bbb;border-radius:6px" src="${esc(imgUrl(s.path))}">${s.name ? `<span style="font-size:11px;color:#555">（${esc(s.name)}）</span>` : ''}`).join(' ') || '__________'}</span></div>`;
      }
      html += one;
    }
  }
  // F-07：打印窗口无需 opener（noopener 不影响 w.document.write 写入）
  const w = window.open('', '_blank', 'noopener,width=760,height=980');
  if (!w) { toast('浏览器拦截了打印窗口，请允许弹窗后重试', false); return false; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>单据打印</title>
    <style>${css}@page{margin:0}body{margin:0;-webkit-print-color-adjust:exact}</style></head>
    <body>${html}<script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script></body></html>`);
  w.document.close();
  toast(`已调起打印（可视化模版）× ${copies} 联${jobType === '重打' ? '（重打标识已印）' : ''}`);
  for (const m of metas) {
    post('/print-jobs/a5', { bizType: m.type, bizNo: m.docNo, bizId: m.id, copies, jobType }).catch(() => { /* 留痕失败不阻断 */ });
  }
  return true;
}

/* ── A5 版式 HTML ── */
function docHtml(type, doc, copyIdx, copies, jobType) {
  const meta = doc.meta.filter(m => m[1] != null && m[1] !== '').map(m => `${m[0]}：<b>${esc(String(m[1]))}</b>`).join('　');
  const rows = doc.lines.map((l, i) => `<tr><td class="num">${i + 1}</td>` + doc.cols.map(c => {
    const v = l[c.k] ?? (c.num ? '0' : '');
    return `<td${c.num ? ' class="num"' : ''}>${typeof v === 'number' ? v.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : esc(String(v))}</td>`;
  }).join('') + '</tr>').join('');
  const nCols = doc.cols.length + 1;
  // 合计行定位：数量列（k='qty'）下落数量合计，金额列下落金额合计；无数量列（对账单）则整行只落金额
  const qtyIdx = doc.cols.findIndex(c => c.k === 'qty');
  const totalRow = qtyIdx < 0
    ? `<tr><td colspan="${nCols - 1}"><b>${esc(doc.totalLabel || '合计')}</b></td><td class="num"><b>${money(doc.totalAmount || 0)}</b></td></tr>`
    : `<tr><td colspan="${qtyIdx + 1}">合计</td><td class="num">${doc.totalQty ?? ''}</td>
        <td colspan="${Math.max(0, nCols - qtyIdx - 3)}"></td><td class="num"><b>${money(doc.totalAmount || 0)}</b></td></tr>`;
  // V5.0.2 签名落位（按角色配对）：本店人员（操作员）签名落到本店签字槽（操作员/经办人/盘点人/店长/制单/审核），
  //   业务人员（业务员）签名落到「业务」槽；单据无业务槽时独立补「业务人员签字」槽——姓名与签字图一一配对。
  const sigItems = (Array.isArray(doc.signItems) && doc.signItems.length ? doc.signItems
    : (doc.signImgs && doc.signImgs.length ? doc.signImgs.map(p => ({ path: p, name: '', role: '操作员' }))
      : (doc.signImg ? [{ path: doc.signImg, name: '', role: '操作员' }] : [])));
  const sigHtml = s => `<img style="max-height:56px;vertical-align:middle;border:1px dashed #bbb;border-radius:6px" src="${esc(imgUrl(s.path))}">${s.name ? `<span style="font-size:10.5px;color:#555">（${esc(s.name)}）</span>` : ''}`;
  const opSigs = sigItems.filter(s => s.role !== '业务员');
  const bizSigs = sigItems.filter(s => s.role === '业务员');
  let opUsed = 0, bizUsed = 0;
  const hasBizSlot = doc.footer.some(f => /业务/.test(f));
  let footers = doc.footer.map(f => {
    const biz = /业务/.test(f);
    const pool = biz ? bizSigs : opSigs;
    const used = biz ? bizUsed : opUsed;
    if (used < pool.length) { if (biz) bizUsed++; else opUsed++; return `<span>${f}：${sigHtml(pool[used])}</span>`; }
    return `<span>${f}：__________</span>`;
  }).join('');
  if (bizSigs.length && !hasBizSlot) {
    footers += `<span>业务人员签字：${bizSigs.map(sigHtml).join(' ')}</span>`;
    bizUsed = bizSigs.length;
  }
  const rest = [...opSigs.slice(opUsed).map(sigHtml), ...bizSigs.slice(bizUsed).map(sigHtml)];
  if (rest.length) footers += `<span>✍️ 电子签名：${rest.join(' ')}</span>`;
  return `<div class="page">
    <h2>${esc(doc.title)}（A5）${jobType === '重打' ? '<span style="color:#c0392b;font-size:14px;vertical-align:middle">　*** 重打 ***</span>' : ''}</h2>
    <div class="sub">社区超市收银系统 · 打印时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>
    <div class="meta">单号：<b>${esc(doc.docNo)}</b>　${meta}</div>
    <table><thead><tr><th style="width:34px">序号</th>${doc.cols.map(c => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="num">（无明细）</td></tr>'}</tbody>
    <tfoot>${totalRow}</tfoot></table>
    ${doc.remark ? `<div class="rmk">备注：${esc(doc.remark)}</div>` : ''}
    <div class="ft">${footers}</div>
    <div class="copy">${copies > 1 ? (copyIdx === 1 ? '第一联 · 存根联（自留）' : `第${copyIdx}联 · 客户联（按需分发）`) : '正本'}</div>
  </div>`;
}

const PRINT_CSS = `
  @page { size: A5 portrait; margin: 9mm 10mm; }
  body { font-family:"Microsoft YaHei",sans-serif; color:#111; margin:0 }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  h2 { text-align:center; margin:0 0 2px; font-size:18px }
  .sub { text-align:center; font-size:11px; color:#555 }
  .meta { font-size:12px; margin-top:8px; line-height:1.9 }
  table { width:100%; border-collapse:collapse; margin-top:8px }
  th,td { border:1px solid #999; padding:4px 7px; font-size:12px } th { background:#f0f0f0 }
  .num { text-align:right } .ft { display:flex; margin-top:20px; font-size:12.5px; gap:40px; align-items:flex-end }
  .rmk { font-size:12px; margin-top:6px }
  .copy { text-align:right; font-size:10.5px; color:#888; margin-top:8px }`;

/** 打印窗口：一次打印多张单据（每单一页 × 份数）；成功后逐单留痕 */
function openPrintWindow(docs) {
  const w = window.open('', '_blank', 'noopener,width=700,height=920');   // F-07：同上
  if (!w) { toast('浏览器拦截了打印窗口，请允许弹窗后重试', false); return false; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>A5单据打印</title><style>${PRINT_CSS}</style></head><body>${docs.join('')}
    <script>window.onload=function(){setTimeout(function(){window.print()},150)}<\/script></body></html>`);
  w.document.close();
  return true;
}

/**
 * 打印 A5 单据（核心入口）
 * @param type 七类之一：inbound/return/order/loss/count/transfer/recon
 * @param ids 单据 id 数组
 * @param copies 份数 1~3
 * @param jobType 留痕 job_type：打印/重打
 */
export async function printDocs(type, ids, copies = 1, jobType = '打印') {
  const def = DOC_DEFS[type];
  if (!def) { toast(`未知单据类型：${type}`, false); return; }
  const idList = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (!idList.length) return;
  copies = Math.min(Math.max(Number(copies) || 1, 1), 3);
  // 模版消费：V4.15.9 v3（hiprint 排版）→ 可视化模版打印；v1/v2 → 固定版式（抬头/备注显隐）
  const tpl = await a5Tpl(type).catch(() => null);
  if (tpl?.content?.version === 3 && tpl?.content?.hp && window.hiprint) {
    const docs = [];
    const metas = [];
    for (const id of idList) {
      const d = await must(def.fetch(id));
      const norm = def.norm(d);
      norm.title = tpl?.content?.title && tpl.content.title !== tpl?.name ? tpl.content.title : def.title;
      await attachSigs(type, norm, id);   // V4.16.4：可视化模版打印同样带电子签名
      docs.push(norm);
      metas.push({ type, id, docNo: norm.docNo });
    }
    try {
      const ok = await printDocsHiprint(tpl.content.hp, docs, copies, jobType, metas);
      if (ok) return;
    } catch (err) { toast('可视化模版打印失败，已回落默认版式：' + (err.message || err), false); }
  }
  const tTitle = tpl?.content?.title && tpl.content.title !== tpl?.name ? tpl.content.title : null;
  const hideRemark = Array.isArray(tpl?.content?.fields) && tpl.content.fields.some(f => f.key === 'remark' && f.show === false);
  const docs = [];
  const metas = [];
  for (const id of idList) {
    const d = await must(def.fetch(id));
    const norm = def.norm(d);
    norm.title = tTitle || def.title;
    if (hideRemark) { norm.meta = (norm.meta || []).filter(m => m[0] !== '备注'); norm.remark = ''; }
    await attachSigs(type, norm, id);   // V4.16.4：签名补全（报损/盘点/调拨/对账从证据链取）
    for (let c = 1; c <= copies; c++) docs.push(docHtml(type, norm, c, copies, jobType));
    metas.push({ id, docNo: norm.docNo });
  }
  if (!openPrintWindow(docs)) return;
  toast(`已调起打印：${norm_title(def, tTitle)}${idList.length > 1 ? ` × ${idList.length} 单` : ''} × ${copies} 联${jobType === '重打' ? '（重打标识已印）' : ''}`);
  for (const m of metas) {
    post('/print-jobs/a5', { bizType: type, bizNo: m.docNo, bizId: m.id, copies, jobType }).catch(() => { /* 留痕失败不阻断 */ });
  }
}

function norm_title(def, tTitle) { return tTitle || def.title; }

/**
 * 弹窗打印（详情/列表入口）：份数选择 + 打印按钮
 */
export async function openA5Print(type, ids) {
  const def = DOC_DEFS[type];
  if (!def) return;
  const idList = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (!idList.length) { toast('请先勾选单据', false); return; }
  const tpl = await a5Tpl(type).catch(() => null);
  const defCopies = Math.min(Math.max(Number(tpl?.copies) || 1, 1), 3);
  const tTitle = tpl?.content?.title && tpl.content.title !== tpl?.name ? tpl.content.title : def.title;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.style.zIndex = 90;
  mask.innerHTML = `<div class="modal" style="width:min(430px,92vw)">
    <h3>🖨 打印${esc(tTitle)}（A5）</h3>
    <div class="muted" style="font-size:12.5px;margin:6px 0 10px">
      已选 <b>${idList.length}</b> 张单据${idList.length > 3 ? '（批量将按顺序逐张出页）' : ''}，一单一页 A5；打印成功自动记入打印中心历史。</div>
    <div class="fld"><label>打印联数（2 联起第二联为存根联）</label>
      <select id="a5Copies">${[1, 2, 3].map(n => `<option value="${n}" ${n === defCopies ? 'selected' : ''}>${n} 联${n === 1 ? '（正本）' : n === 2 ? '（存根联+客户联）' : ''}</option>`).join('')}</select></div>
    <div class="doc-foot">
      <button class="btn" id="a5Cancel">取消</button><span style="flex:1"></span>
      <button class="btn pri" id="a5Go">🖨 打印</button>
    </div></div>`;
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  document.body.appendChild(mask);
  mask.querySelector('#a5Cancel').onclick = () => mask.remove();
  mask.querySelector('#a5Go').onclick = async () => {
    const copies = Number(mask.querySelector('#a5Copies').value) || 1;
    mask.remove();
    await printDocs(type, idList, copies);
  };
}

/** 审核通过后自动弹（设置 doc.print.auto_a5 开 + 有权限才弹） */
export async function autoPrintA5AfterAudit(type, ids) {
  try {
    if (!canPrintA5()) return;
    if (!(await autoA5Enabled())) return;
    await printDocs(type, ids, 1);
  } catch { /* 自动弹失败静默 */ }
}
