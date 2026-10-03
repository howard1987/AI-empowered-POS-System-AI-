import { get, must, put, money, esc, dt, imgUrl, toast } from '../api.js';
import { zoomImg } from '../ui.js';

/** V4.9.7 独立商品详情弹窗（供库存批次等页面复用，版式与商品档案详情一致） */
export async function showProductDetail(pid) {
  let d;
  try { d = await must(get('/products/' + pid)); } catch { return; }
  const p = d.product || {};
  let catName = '';
  try {
    const cr = await get('/products/categories');
    const cats = (cr && cr.data) || cr || [];
    const fa = (list, chain) => list.forEach(c => {
      const ch = chain.concat(c);
      if (Number(c.id) === Number(p.category_id)) catName = ch.map(x => x.name).join(' ▸ ');
      fa(c.children || [], ch);
    });
    fa(cats, []);
  } catch { /* 分类链获取失败不阻断 */ }
  const units = d.units || [];
  // V4.9.8 样本图最多展示 6 张（最新在前），可点「加载最新」重新拉取
  const SAMPLE_MAX = 6;
  const samplesSorted = (d.aiSamples || []).slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  const sampleThumb = s => `
    <div data-sample="${esc(imgUrl(s.image_path))}" style="cursor:zoom-in;text-align:center;width:68px">
      <img src="${esc(imgUrl(s.image_path))}" loading="lazy" style="width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid var(--line)"
           onerror="this.style.opacity=.25">
      <div class="muted" style="font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.angle || '样本')} · ${esc(s.status)}</div>
    </div>`;
  const fmtSampleCnt = arr => `最近 ${Math.min(SAMPLE_MAX, arr.length)} 张 / 共 ${arr.length} 张，点击放大`;
  const st = p.status === 1 ? '<span class="tag g">在售</span>' : '<span class="tag r">停售</span>';
  const photo = p.photo_path
    ? `<img src="${esc(imgUrl(p.photo_path))}" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:1px solid var(--line)">`
    : `<div style="width:72px;height:72px;border-radius:12px;background:linear-gradient(150deg,#e8f3ea,#d5e8f5);display:grid;place-items:center;font-size:36px">📦</div>`;
  const cell = (k, v) => `
    <div style="min-width:0;padding:6px 2px;border-bottom:1px dashed var(--line);font-size:12.5px">
      <div class="muted" style="font-size:11px;margin-bottom:2px">${k}</div>
      <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis">${v}</div>
    </div>`;
  const memberWarn = p.member_price != null && Number(p.member_price) > 0 && Number(p.cost_price || 0) > 0 && Number(p.member_price) < Number(p.cost_price);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.style.zIndex = 80;
  mask.innerHTML = `
    <div class="modal" style="width:min(860px,94vw);max-height:88dvh;overflow:auto">
      <h3>🏷️ ${esc(p.name || '商品详情')}</h3>
      <div style="display:flex;gap:14px;align-items:flex-start;padding:8px 0 10px">
        ${photo}
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 18px;flex:1;min-width:0">
          ${cell('状态', st)}
          ${cell('商品名称', esc(p.name || '—'))}
          ${cell('条码', `<span class="mono">${esc(p.barcode || (p.is_weighted ? 'PLU ' + (p.goods_no || '') : '—'))}</span>`)}
          ${cell('货号（SPU）', esc(p.goods_no || '—'))}
          ${cell('规格', esc(p.spec || '—'))}
          ${cell('单位', esc(p.base_unit || '—'))}
          ${cell('分类', catName ? esc(catName) : '—')}
          ${cell('进货价', Number(p.cost_price || 0) > 0 ? money(p.cost_price) + ' <span class="muted" style="font-weight:400;font-size:11px">（仅调价单可改）</span>' : '—')}
          ${cell('售价', `<span style="color:var(--pri)">${money(p.sell_price)}</span>`)}
          ${cell('会员价', memberWarn
            ? `<span style="color:#c0392b;font-weight:700">${money(p.member_price)} ⚠ 低于进价</span>`
            : (p.member_price != null ? money(p.member_price) : '—'))}
          ${cell('批发价', p.wholesale_price != null ? money(p.wholesale_price) : '—')}
          ${cell('会员折扣', p.member_discount != null && Number(p.member_discount) > 0 ? `是（${(Number(p.member_discount) * 10).toFixed(1).replace(/\.0$/, '')} 折）` : '否')}
          ${cell('供货商（主）', esc(p.supplier_name || '—'))}
          ${cell('保质期', p.keep_days ? `${p.keep_days} 天` : '<span class="tag y">未填 · 禁售拦截</span>')}
          ${cell('库存', `${Number(p.stock_qty || 0)} ${esc(p.base_unit || '')}`)}
          ${cell('库存上下限', `${Number(p.min_stock || 0)} ~ ${Number(p.max_stock || 0)}`)}
          ${cell('经营方式', esc(p.biz_mode || '购销'))}
          ${cell('商城', `<span class="tag ${p.online_visible === false ? 'y' : 'g'}">${p.online_visible === false ? '未上架' : '已上架'}</span>`)}
          ${cell('AI 识别样本', `${Number(d.aiSampleCount || 0)} 张`)}
          ${cell('记库存 / 称重', `${p.track_inventory === false ? '✗' : '✓'} / ${p.is_weighted ? '✓ 称重' : '✗'}`)}
        </div>
      </div>
      ${(d.aiSamples || []).length ? `
        <div style="padding:10px 0 2px;border-top:1px dashed var(--line)">
          <div class="muted" style="font-size:12px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
            <span id="pdSampleCnt7">${fmtSampleCnt(samplesSorted)}</span>
            <button class="btn" id="pdSampleBtn7" style="font-size:11.5px;padding:2px 10px">🔄 加载最新</button>
          </div>
          <div id="pdSampleGrid7" style="display:flex;flex-wrap:wrap;gap:8px">
            ${samplesSorted.slice(0, SAMPLE_MAX).map(sampleThumb).join('')}
          </div>
        </div>` : ''}
      ${units.length ? `
        <div style="padding-top:12px;border-top:1px dashed var(--line);margin-top:10px">
          <div class="muted" style="font-size:12px;margin-bottom:6px">🔄 多单位换算</div>
          <table class="tb" style="width:100%;font-size:12px;text-align:left;table-layout:auto"><thead><tr>
            <th class="seq">序号</th><th style="white-space:nowrap">包装单位</th><th style="white-space:nowrap">换算到基本单位</th><th style="white-space:nowrap;min-width:150px">该包装条码</th></tr></thead>
          <tbody>
            <tr><td class="num">—</td><td style="white-space:normal"><b>${esc(p.base_unit || '')}</b>（基本）</td><td style="white-space:normal">1 ${esc(p.base_unit || '')}</td><td class="mono" style="white-space:normal;word-break:break-all;min-width:150px">${esc(p.barcode || '—')}</td></tr>
            ${units.map((u, i) => `<tr><td class="num seq">${i + 1}</td><td style="white-space:normal"><b>${esc(u.unit_name)}</b></td><td style="white-space:normal">1 ${esc(u.unit_name)} = ${Number(u.rate)} ${esc(p.base_unit || '')}</td>
              <td class="mono" style="white-space:normal;word-break:break-all;min-width:150px">${esc(u.barcode || '—')}</td></tr>`).join('')}
          </tbody></table>
        </div>` : ''}
      ${(d.supplierPrices || []).length ? `
        <div style="padding-top:12px">
          <div class="muted" style="font-size:12px;margin-bottom:6px">🚚 供应商进价历史（最近 ${Math.min(5, d.supplierPrices.length)} 次）</div>
          <table class="tb" style="width:100%;font-size:12px"><thead><tr><th class="seq">序号</th><th>供应商</th><th class="num">进价</th><th class="num">历史最低</th><th>来源单据</th><th>时间</th></tr></thead>
          <tbody>${d.supplierPrices.slice(0, 5).map((s, i) => `<tr>
            <td class="num seq">${i + 1}</td><td>${esc(s.supplier_name || '供应商' + s.supplier_id)}</td>
            <td class="num">${money(s.price)}</td>
            <td class="num muted">${money(s.min_price)}</td>
            <td class="muted mono">${esc(s.source_doc || '—')}</td>
            <td class="muted">${dt(s.created_at)}</td>
          </tr>`).join('')}</tbody></table>
        </div>` : ''}
      <div class="doc-foot" style="margin-top:6px">
        <span style="flex:1"></span>
        <button class="btn" id="pdOnline7">${p.online_visible === false ? '🛒 商城上架' : '🛒 商城下架（停售）'}</button>
        <button class="btn pri" id="pdEdit7">✏️ 编辑商品</button>
      </div>
    </div>`;
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  // V4.9.8 商城上/下架（与商品档案详情一致）
  mask.querySelector('#pdOnline7').onclick = async () => {
    const target = p.online_visible === false; // 当前未上架 → 上架
    try {
      await must(put(`/products/${pid}/online`, { visible: target }), target ? '已上架商城' : '已下架商城（会员端立即不可见）');
      mask.remove();
      showProductDetail(pid); // 重新打开以刷新商城状态标签
    } catch { /* must 已 toast */ }
  };
  // V4.9.8 编辑商品：跳转商品档案页并直接打开编辑弹窗（由 products.js 监听 pd:edit 事件）
  mask.querySelector('#pdEdit7').onclick = () => {
    mask.remove();
    window.dispatchEvent(new CustomEvent('pd:edit', { detail: pid }));
  };
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  document.body.appendChild(mask);
  // 样本点击放大；抽成函数供「加载最新」刷新后重绑
  const bindSamples = () => mask.querySelectorAll('[data-sample]').forEach(el => el.onclick = () => zoomImg(el.dataset.sample));
  bindSamples();
  // V4.9.8 加载最新样本图片：重新拉取商品详情，仍最多展示 6 张（最新在前）
  const pdSampleBtn = mask.querySelector('#pdSampleBtn7');
  if (pdSampleBtn) pdSampleBtn.onclick = async () => {
    try {
      const nd = await must(get('/products/' + pid));
      const ns = (nd.aiSamples || []).slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const grid = mask.querySelector('#pdSampleGrid7'), cnt = mask.querySelector('#pdSampleCnt7');
      if (grid) grid.innerHTML = ns.slice(0, SAMPLE_MAX).map(sampleThumb).join('');
      if (cnt) cnt.textContent = fmtSampleCnt(ns);
      bindSamples();
      toast('已加载最新图片');
    } catch { /* must 已 toast */ }
  };
}
