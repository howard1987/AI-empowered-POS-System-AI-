import { get, post, must, esc, money, toast } from '../api.js';
import { paginate, bindPager } from '../common-ui.js';

/** M5a AI 动态定价：临期/滞销调价建议（含成本底线），应用后生成待审核调价草稿 */
export async function render(view) {
  const $ = s => view.querySelector(s);
  let data = null;
  let curPage = 1;          // V4.16.5 建议清单当前页（10 条/页）
  const selSet = new Set(); // 勾选集合（跨页保留）

  const upd = () => {
    const el = view.querySelector('#ppSel');
    if (el) el.textContent = selSet.size;
  };
  // V4.16.5 建议清单分页渲染（10 条/页，翻页只重画清单区，勾选状态存 selSet 跨页保留）
  const drawRows = () => {
    const list = data?.suggestions || [];
    const wrap = view.querySelector('#ppListWrap');
    if (!wrap) return;
    const pg = paginate(list, curPage, 10);
    curPage = pg.page;
    wrap.innerHTML = list.length ? `
        <table>
          <thead><tr><th style="width:34px"></th><th>类型</th><th>商品</th><th class="num">现售价</th><th class="num">建议价</th><th class="num">成本底线</th><th class="num">在库</th><th class="num">剩余天数</th><th>原因</th><th class="num">预计让利</th></tr></thead>
          <tbody id="ppBody">${pg.slice.map(s => `
            <tr>
              <td><input type="checkbox" value="${esc(s.id)}" ${selSet.has(s.id) ? 'checked' : ''}></td>
              <td><span class="badge ${s.type === 'expiry' ? 'o' : 'b'}">${s.type === 'expiry' ? '⏳ 临期' : '📦 滞销'}</span></td>
              <td><b>${esc(s.name)}</b><div class="muted" style="font-size:11px">${esc(s.barcode || '—')}</div></td>
              <td class="num">¥${money(s.sellPrice)}</td>
              <td class="num" style="color:#c0392b;font-weight:700">¥${money(s.suggestedPrice)}${s.atFloor ? '<div class="muted" style="font-size:10px">触底线</div>' : ''}</td>
              <td class="num muted">¥${money(s.floorPrice)}</td>
              <td class="num">${s.stock}</td>
              <td class="num">${s.daysLeft != null ? s.daysLeft + ' 天' : '—'}</td>
              <td class="muted" style="font-size:12px">${esc(s.reason)}</td>
              <td class="num">¥${money(s.impact)}</td>
            </tr>`).join('')}</tbody>
        </table>
        ${pg.bar}
        <div class="muted" style="padding:8px 18px;font-size:11.5px">共 ${pg.total} 条建议 · 已勾选 <span id="ppSel">0</span> 条</div>`
      : '<div class="empty">暂无调价建议（商品临期批次/滞销库存达标后自动出现）</div>';
    view.querySelectorAll('#ppBody input').forEach(i => i.onchange = () => {
      if (i.checked) selSet.add(i.value); else selSet.delete(i.value);
      upd();
    });
    bindPager(view.querySelector('#ppCard'), p => { curPage = p; drawRows(); });
    upd();
  };

  const load = async () => {
    data = await must(get('/ai/pricing/suggestions'));
    const th = data.thresholds || {};
    const list = data.suggestions || [];
    selSet.clear();   // 刷新/应用后重置勾选（与原行为一致；翻页勾选由 drawRows/selSet 保留）
    const html = `
      <div class="card">
        <h3>💹 AI 动态定价 <span class="api">GET /ai/pricing/suggestions · 临期≤${th.expiryDays}天 / 滞销≥${th.staleDays}天无销售&在库≥${th.staleQty}件 · 底线 进价×(1+${(th.minMargin ?? 0.05) * 100}%)</span>
          <button class="btn sm" id="ppRefresh">🔄 刷新</button>
        </h3>
        <div class="kpis" style="margin:14px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px">
          <div class="kpi" style="margin:0"><div class="v">${data.count}</div><div class="t">待调价商品</div></div>
          <div class="kpi" style="margin:0"><div class="v">${list.filter(x => x.type === 'expiry').length}</div><div class="t">临期</div></div>
          <div class="kpi" style="margin:0"><div class="v">${list.filter(x => x.type === 'stale').length}</div><div class="t">滞销</div></div>
          <div class="kpi" style="margin:0"><div class="v">¥${money(data.impactTotal)}</div><div class="t">预计让利（按在库量）</div></div>
        </div>
        <div class="bar" style="flex-wrap:wrap">
          <button class="btn pri" id="ppApply">✅ 生成调价草稿（勾选项）</button>
          <span class="muted" style="font-size:11.5px">草稿进入「商品调价单」待审核，审核通过才生效 · 建议价已自动守住成本底线</span>
        </div>
      </div>
      <div class="card tbl-min" id="ppCard">
        <h3>调价建议清单 <span class="api">勾选后生成 price_changes（status=pending）</span></h3>
        <div id="ppListWrap"></div>
      </div>`;
    view.innerHTML = html;
    drawRows();
    view.querySelector('#ppRefresh').onclick = load;
    const applyBtn = view.querySelector('#ppApply');
    if (applyBtn) applyBtn.onclick = async () => {
      const ids = [...selSet];
      if (!ids.length) { toast('请先勾选要调价的商品', false); return; }
      const r = await post('/ai/pricing/apply', { ids });
      if (r.code !== 0) { toast(r.msg || ('错误码 ' + r.code), false); return; }
      toast(r.data?.note || '调价草稿已生成');
      load();
    };
  };
  await load();
}
