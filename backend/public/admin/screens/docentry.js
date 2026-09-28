import { get, esc, toast } from '../api.js';

/**
 * 单据录入表格通用组件—— 采购订单 / 采购入库 / 采购退货共用
 *   - 行首 ＋/−（可自定义列头文字，如退货单「编辑」）
 *   - 「条码」列：扫码枪 / 手输 / 名称拼音模糊 → 建议下拉定位商品（非下拉选择）
 *   - 定位后自动填充：名称 / 单位 / 类别 / 规格 / 上次含税进价 / 售价 / 库存 / 批次 / 到期日期
 *   - 「售价」列：入库可改，审核后自动更新商品档案最新售价（opts.sell=true）
 *   - 低价保护：输入进价时与该供应商历史最低价对比提示（opts.lowProtect=true）
 *   - 条码未识别：opts.onUnknown(value, rowIndex) 回调（AI 建品 / 手动新建分流）
 *   - 回车跳同行下一格，行末回车自动加行；↑/↓ 上下行同列切换
 */

/* ── 商品查找 ── */
export function findProduct(products, key) {
  const s = String(key || '').trim().toLowerCase();
  if (!s) return null;
  return products.find(p => String(p.barcode || '').toLowerCase() === s)
      || products.find(p => String(p.goods_no || '').toLowerCase() === s)
      || null;
}
export function fuzzyProducts(products, key, limit = 8) {
  const s = String(key || '').trim().toLowerCase();
  if (!s) return [];
  const out = [];
  for (const p of products) {
    if (String(p.barcode || '').toLowerCase().includes(s)
      || String(p.name || '').toLowerCase().includes(s)
      || String(p.pinyin_code || p.pinyinCode || '').toLowerCase().includes(s)
      || String(p.goods_no || '').toLowerCase() === s) {
      out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/* ── 建议下拉（全局单例；V4.26.2 导出供调价单等行内条码场景复用） ── */
let sugBox = null;
function ensureSug() {
  if (!sugBox) {
    sugBox = document.createElement('div');
    sugBox.style.cssText = 'position:fixed;z-index:9999;display:none;background:#fff;border:1px solid var(--line-2,#ccc);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);max-height:262px;overflow:auto;min-width:360px;font-size:12.5px';
    document.body.appendChild(sugBox);
    document.addEventListener('mousedown', e => { if (sugBox && !sugBox.contains(e.target)) sugBox.style.display = 'none'; });
  }
  return sugBox;
}
export const hideSug = () => { if (sugBox) sugBox.style.display = 'none'; };
export function showSuggest(input, products, onPick) {
  const hits = fuzzyProducts(products, input.value);
  const box = ensureSug();
  if (!hits.length) { hideSug(); return false; }
  const r = input.getBoundingClientRect();
  box.style.left = r.left + 'px';
  box.style.top = (r.bottom + 2) + 'px';
  box.style.width = Math.max(r.width, 400) + 'px';
  box.innerHTML = hits.map((p, i) => `
    <div data-si="${i}" style="padding:7px 12px;cursor:pointer;display:flex;gap:12px;align-items:center;border-bottom:1px dashed var(--line,#eee)"
         onmouseover="this.style.background='var(--green-soft,#eef7ef)'" onmouseout="this.style.background=''">
      <b style="font-family:var(--mono,monospace);min-width:118px">${esc(p.barcode || p.goods_no || '—')}</b>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
      <span style="color:var(--ink-3,#888);font-size:12px;flex:none">${esc(p.spec || '')} ${esc(p.base_unit || '')}</span>
    </div>`).join('');
  box.style.display = 'block';
  box.querySelectorAll('[data-si]').forEach(el => {
    el.onmousedown = e => { e.preventDefault(); onPick(hits[Number(el.dataset.si)]); hideSug(); };
  });
  return true;
}

/* ── 多单位缓存（按商品 id 拉取 product_units） ── */
export function createUnitsCache() { return {}; }
async function ensureUnits(cache, pid, onChange) {
  if (!pid || cache[pid]) return;
  try {
    // V4.26.2：后端统一包装 {code,msg,data}，必须取 .data，否则单位下拉恒为空
    const r = await get('/products/' + pid);
    const d = (r && r.data !== undefined) ? r.data : r;
    cache[pid] = (d && d.units) || [];
    onChange && onChange();
  } catch { cache[pid] = []; }
}

/* ── 行结构 ── */
export function makeLine(extra = {}) {
  return { productId: '', _p: null, _q: '', qty: '', unitCost: '', sellPrice: '', unitName: '', rate: 1,
           productionDate: '', remark: '', _ordered: null, _arrived: null, _batchNo: '', _expiry: '',
           _aiCreate: false, ...extra };
}

/**
 * 渲染明细表格并接管交互
 *   opts: { products, unitsCache, price=true, sell=false, prodDate=false, stock=true, batch=false,
 *           orderQty=false, headLabel='＋/−', today, qtyLabel='数量', lowProtect=false,
 *           onUnknown(value, rowIdx), onSum() }
 * 行保存字段：qty / unitCost 均按「当前所选单位」计；保存时按 rate 换算到基本单位
 */
export function renderLines(tb, lines, opts = {}) {
  const { products, unitsCache = {}, price = true, sell = false, prodDate = false, stock = true,
          batch = false, orderQty = false, headLabel = '＋/−', today = '', qtyLabel = '数量',
          lowProtect = false, supCol = false, onUnknown, onSum } = opts;
  const fmt = n => (Number(n) || 0).toFixed(2);
  const colN = 7 + (price ? 2 : 0) + (sell ? 1 : 0) + (prodDate ? 1 : 0) + (stock ? 1 : 0) + (batch ? 2 : 0) + (supCol ? 1 : 0) + 1;
  const emptyHtml = `<tr><td colspan="${colN}" class="empty">空单：在首行「条码」列扫码 / 输入定位商品</td></tr>`;

  if (!lines.length) { tb.innerHTML = emptyHtml; onSum && onSum(); return; }

  tb.innerHTML = lines.map((l, i) => {
    const p = l._p || products.find(x => String(x.id) === String(l.productId)) || null;
    const units = (l.productId && unitsCache[l.productId]) || [];
    const unitOpts = [`<option value="|1" ${!l.unitName ? 'selected' : ''}>${esc(p ? (p.base_unit || '基本') : '基本')} ×1</option>`]
      .concat(units.map(u => `<option value="${esc(u.unit_name)}|${Number(u.rate)}" ${l.unitName === u.unit_name ? 'selected' : ''}>${esc(u.unit_name)} ×${Number(u.rate)}</option>`)).join('');
    const orderedCell = orderQty
      ? `<td class="num muted" style="font-size:12px">${l._ordered != null ? `订 ${l._ordered} / 已到 ${l._arrived ?? 0}` : '—'}</td>`
      : '';
    return `<tr data-li="${i}" ${l._aiCreate ? 'style="background:#fff8e6"' : ''}>
      <td style="white-space:nowrap;width:64px">
        <button class="btn sm" data-plus="${i}" title="在下方插入一行" style="padding:2px 7px">＋</button>
        <button class="btn sm warn" data-minus="${i}" title="${i === 0 ? '首行不可删除（可清空本行数据）' : '删除本行'}" style="padding:2px 7px" ${i === 0 ? 'disabled' : ''}>−</button>
      </td>
      <td class="num" style="width:36px">${i + 1}</td>
      <td><input data-f="bc" data-i="${i}" data-nav="1" value="${esc(l._q || '')}" placeholder="扫码/条码/名称" autocomplete="off"
           style="width:128px;font-family:var(--mono,monospace)"></td>
      <td style="min-width:130px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p ? p.name : '')}">${p ? `<b>${esc(p.name)}</b>${l._aiCreate ? ' <span class="tag y" style="font-size:10px;padding:1px 6px">AI建品</span>' : ''}` : '<span class="muted">—</span>'}</td>
      <td><select data-f="unit" data-i="${i}" data-nav="1" style="width:86px" ${p ? '' : 'disabled'}>${p ? unitOpts : '<option>—</option>'}</select></td>
      <td class="muted" style="font-size:12px;min-width:64px">${p ? esc(p.category_name || '—') : '—'}</td>
      <td class="muted" style="font-size:12px;min-width:64px">${p ? esc(p.spec || '—') : '—'}</td>
      ${supCol ? `<td class="muted" style="font-size:12px;min-width:88px" data-sup="${i}">${p ? esc(p.supplier_name || (Number(p.supplier_default_id) > 0 ? '供应商#' + p.supplier_default_id : '未绑定')) : '—'}</td>` : ''}
      ${orderQty ? orderedCell : ''}
      <td><input data-f="qty" data-i="${i}" data-nav="1" type="number" step="${p && p.is_weighted ? '0.001' : '1'}" min="0" value="${l.qty ?? ''}" placeholder="${qtyLabel}" autocomplete="off" style="width:76px"></td>
      ${price ? `<td><input data-f="cost" data-i="${i}" data-nav="1" type="number" step="0.01" min="0" value="${l.unitCost === '' || l.unitCost == null ? '' : Number(l.unitCost).toFixed(2)}" placeholder="进价" autocomplete="off" style="width:82px" title="${p && p.min_price != null ? `历史最低 ${fmt(p.min_price)}` : ''}"></td>` : ''}
      ${sell ? `<td><input data-f="sell" data-i="${i}" data-nav="1" type="number" step="0.01" min="0" value="${l.sellPrice ?? ''}" placeholder="售价" autocomplete="off" style="width:78px" title="审核后自动更新商品档案最新售价"></td>` : ''}
      ${prodDate ? `<td><input data-f="pd" data-i="${i}" data-nav="1" type="date" value="${esc(l.productionDate || today)}" style="width:132px"></td>` : ''}
      ${stock ? `<td class="num muted" style="min-width:52px">${p ? Number(p.stock_qty ?? p.stockQty ?? 0) : '—'}</td>` : ''}
      ${batch ? `<td class="mono muted" style="font-size:11.5px;min-width:96px">${esc(l._batchNo || '—')}</td>
                 <td class="num muted" style="font-size:12px;min-width:92px">${esc(l._expiry || '—')}</td>` : ''}
      <td><input data-f="rm" data-i="${i}" data-nav="1" value="${esc(l.remark || '')}" placeholder="备注" autocomplete="off" style="width:104px"></td>
      ${price ? `<td class="num" data-amt="${i}" style="color:var(--warn);min-width:64px">${fmt((Number(l.qty) || 0) * (Number(l.unitCost) || 0))}</td>` : ''}
    </tr>`;
  }).join('');

  const rerender = () => renderLines(tb, lines, opts);

  /* 行首 ＋/− */
  tb.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => {
    lines.splice(Number(b.dataset.plus) + 1, 0, makeLine({ productionDate: prodDate ? today : '' }));
    rerender();
  });
  tb.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => {
    const mi = Number(b.dataset.minus);
    if (mi === 0) return;                                  // V4.26.2 首行不可删除
    lines.splice(mi, 1);
    rerender();
  });

  /* 商品定位（条码列） */
  const pick = (i, p) => {
    const l = lines[i];
    l.productId = p.id; l._p = p; l._q = p.barcode || ''; l._aiCreate = false;
    l.rate = 1; l.unitName = '';
    // V4.9.5：自动填充该供应商「上次含税进价」（lp.last_price），无记录再回退档案进价
    if (price && !(Number(l.unitCost) > 0)) {
      l.unitCost = Number(p.last_price) > 0 ? Number(p.last_price)
        : (Number(p.cost_price) > 0 ? Number(p.cost_price) : '');
    }
    if (sell && !(Number(l.sellPrice) > 0)) l.sellPrice = Number(p.sell_price) > 0 ? Number(p.sell_price) : '';
    // 批次/到期日期：最早到期在库批次（退货时与后端自动归属「最早剩余批次」口径一致）
    if (batch) {
      const bs = (p._batches || []).filter(b => Number(b.remain_qty) > 0);
      const first = bs[0];
      l._batchNo = first ? String(first.batch_no).replace(/-\d{2}$/, '') : '';
      l._expiry = first ? String(first.expiry_date).slice(0, 10) : '';
    }
    ensureUnits(unitsCache, p.id, rerender);
    rerender();
    const qty = tb.querySelector(`input[data-f="qty"][data-i="${i}"]`);
    qty && qty.focus();
  };
  tb.querySelectorAll('input[data-f="bc"]').forEach(inp => {
    const i = Number(inp.dataset.i);
    inp.addEventListener('input', () => { lines[i]._q = inp.value; showSuggest(inp, products, p => pick(i, p)); onSum && onSum(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const exact = findProduct(products, inp.value);
        if (exact) return pick(i, exact);
        const hits = fuzzyProducts(products, inp.value, 2);
        if (hits.length === 1) return pick(i, hits[0]);
        const shown = showSuggest(inp, products, p => pick(i, p));
        if (!shown) {
          if (onUnknown) onUnknown(inp.value, i);
          else toast(`未找到商品：${inp.value || '（空）'}`, false);
        }
      }
    });
  });

  /* 单位切换：数量 / 进价按换算率联动（保持基本单位量不变） */
  tb.querySelectorAll('select[data-f="unit"]').forEach(sel => sel.onchange = () => {
    const i = Number(sel.dataset.i);
    const [name, rateStr] = String(sel.value).split('|');
    const newRate = Number(rateStr) || 1;
    const l = lines[i];
    const oldRate = Number(l.rate) || 1;
    if (newRate !== oldRate) {
      if (l.qty !== '' && l.qty != null) l.qty = r3(Number(l.qty) * oldRate / newRate);
      if (price && l.unitCost !== '' && l.unitCost != null) l.unitCost = r4(Number(l.unitCost) * newRate / oldRate);
    }
    l.unitName = name; l.rate = newRate;
    rerender();
  });

  /* 行内编辑：只更新行与合计，不整体重绘（避免扫码/输入焦点丢失） */
  tb.querySelectorAll('input[data-f="qty"],input[data-f="cost"],input[data-f="sell"]').forEach(inp => inp.onchange = () => {
    const i = Number(inp.dataset.i);
    if (inp.dataset.f === 'qty') lines[i].qty = inp.value;
    else if (inp.dataset.f === 'cost') {
      // V5.0.3：含税进价统一保留两位小数（显示与存储一致；单位换算的内部精度不受影响）
      lines[i].unitCost = inp.value === '' ? '' : Number(inp.value).toFixed(2);
      inp.value = lines[i].unitCost;
    }
    else lines[i].sellPrice = inp.value;
    const amt = tb.querySelector(`[data-amt="${i}"]`);
    if (amt) amt.textContent = fmt((Number(lines[i].qty) || 0) * (Number(lines[i].unitCost) || 0));
    // V4.9.5 低价保护提示：进价 vs 该供应商历史最低价
    if (lowProtect && inp.dataset.f === 'cost') {
      const p = lines[i]._p;
      if (p && inp.value !== '' && Number(p.min_price) > 0) {
        const v = Number(inp.value), mp = Number(p.min_price);
        if (v < mp) toast(`⬇ 进价 ${fmt(v)} 低于历史保护低价 ${fmt(mp)}（审核按低价入账）`, false);
        else if (v > mp) toast(`⬆ 进价 ${fmt(v)} 高于历史保护低价 ${fmt(mp)}（注意核实）`);
      }
    }
    onSum && onSum();
  });
  tb.querySelectorAll('input[data-f="pd"]').forEach(inp => inp.onchange = () => { lines[Number(inp.dataset.i)].productionDate = inp.value; });
  tb.querySelectorAll('input[data-f="rm"]').forEach(inp => inp.onchange = () => { lines[Number(inp.dataset.i)].remark = inp.value; });

  /* 回车跳列 / 行末加行 / ↑↓ 切行 */
  const navEls = [...tb.querySelectorAll('[data-nav]')];
  navEls.forEach(el => {
    el.addEventListener('keydown', e => {
      const idx = navEls.indexOf(el);
      if (e.key === 'Enter') {
        e.preventDefault();
        const next = navEls[idx + 1];
        if (next) next.focus();
        else {  // 行末：自动加行
          lines.push(makeLine({ productionDate: prodDate ? today : '' }));
          rerender();
          setTimeout(() => {
            const firstBc = tb.querySelector(`input[data-f="bc"][data-i="${lines.length - 1}"]`);
            firstBc && firstBc.focus();
          }, 0);
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const col = el.dataset.f;
        const row = Number(el.dataset.i) + (e.key === 'ArrowDown' ? 1 : -1);
        const tgt = tb.querySelector(`[data-nav][data-f="${col}"][data-i="${row}"]`);
        tgt && tgt.focus();
      }
    });
  });

  onSum && onSum();
}

const r3 = n => Math.round(Number(n) * 1000) / 1000;
const r4 = n => Math.round(Number(n) * 10000) / 10000;

/** 保存前换算：行数量/进价（当前单位）→ 基本单位 */
export function toBase(l) {
  const rate = Number(l.rate) || 1;
  return { qty: r3(Number(l.qty) * rate), unitCost: r4(Number(l.unitCost) / rate) };
}

/** V4.9.5 拉取某供应商可供商品（含上次进价/最低价），失败回退全量商品 */
export async function loadSupplierProducts(supplierId, fallbackProducts) {
  if (!supplierId) return fallbackProducts;
  try {
    const r = await get(`/products/supplier-products/${supplierId}`);
    const d = (r && r.data !== undefined) ? r.data : r;
    const items = (d && d.items) || [];
    return items.length ? items : fallbackProducts;
  } catch { return fallbackProducts; }
}

/** V4.9.5 拉取商品在库批次（最早到期在前），挂到商品对象 _batches 上 */
export async function loadBatchesFor(products) {
  try {
    const resp = await get('/inventory/batches');
    const d = (resp && resp.data !== undefined) ? resp.data : resp;
    const rows = (Array.isArray(d) ? d : (d && d.items)) || [];
    const byP = {};
    for (const b of rows) {
      (byP[b.product_id] = byP[b.product_id] || []).push(b);
    }
    for (const p of products) p._batches = byP[p.id] || [];
  } catch { for (const p of products) p._batches = []; }
  return products;
}
