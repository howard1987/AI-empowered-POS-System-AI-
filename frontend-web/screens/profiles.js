import { get, post, must, esc, dt, money, toast } from '../api.js';
import { paginate, bindPager } from '../common-ui.js';

/** M4b 会员智能画像：生命周期/偏好品类/贡献度/频次标签（member_profiles） */
export async function render(view) {
  let tag = '';
  let pfPage = 1;
  const list = async () => {
    const kw = view.querySelector('#pfKw')?.value.trim() || '';
    const d = await must(get(`/members/profile/list?keyword=${encodeURIComponent(kw)}&tag=${encodeURIComponent(tag)}&size=80`));
    const items = d.items || [];
    const pg = paginate(items, pfPage, 10);
    view.querySelector('#pfList').innerHTML = items.length ? `
      <table><thead><tr><th>会员</th><th>等级</th><th>生命周期</th><th>贡献</th><th>频次</th><th>偏好品类</th><th class="num">总消费</th><th class="num">单量</th><th>最近消费</th></tr></thead>
      <tbody>${pg.slice.map(m => {
        const tags = (m.tags || []).reduce((o, t) => (o[t.k] = t.v, o), {});
        const p = m.profile || {};
        const fav = (tags.fav1 ? [tags.fav1, tags.fav2, tags.fav3].filter(Boolean).join(' / ') : '—');
        const tier = { '高贡献': 'g', '中贡献': 'y', '低贡献': '' }[tags.tier] || '';
        return `<tr data-id="${m.member_id}" style="cursor:pointer">
          <td><b>${esc(m.name)}</b><div class="muted">${esc(m.phone || '')}</div></td>
          <td class="muted">${esc(m.level_name || '—')}</td>
          <td><span class="tag ${tags.lifecycle === '活跃' || tags.lifecycle === '新客' ? 'g' : tags.lifecycle === '沉睡' ? 'y' : tags.lifecycle === '流失' ? 'r' : ''}">${esc(tags.lifecycle || '—')}</span></td>
          <td><span class="tag ${tier}">${esc(tags.tier || '—')}</span></td>
          <td class="muted">${esc(tags.freq || '—')}</td>
          <td class="muted">${esc(fav)}</td>
          <td class="num">${money(p.totalAmount)}</td>
          <td class="num">${p.orderCount ?? 0}</td>
          <td class="muted">${p.lastBuyAt ? dt(p.lastBuyAt) : '—'}</td>
        </tr>`;
      }).join('')}</tbody></table>${pg.bar}
      <div class="muted mt8">共 ${d.total ?? items.length} 位会员画像 · 点击行查看详情</div>`
      : '<div class="empty">暂无画像数据（点击右上角「重算画像」生成）</div>';
    bindPager(view.querySelector('#pfList'), p => { pfPage = p; list(); });
    view.querySelectorAll('#pfList tr[data-id]').forEach(tr => tr.onclick = () => detail(Number(tr.dataset.id)));
  };
  const detail = async memberId => {
    const d = await must(get('/members/profile/' + memberId));
    const tags = (d.tags || []).reduce((o, t) => (o[t.k] = t.v, o), {});
    const p = d.profile || {};
    const ov = view.querySelector('#pfDetail');
    ov.innerHTML = `
      <div class="card">
        <h3>🔍 ${esc(d.name || ('会员 #' + memberId))} 画像 <span class="api">GET /members/profile/:id</span>
          </h3>
        <div class="bar">
          ${['lifecycle', 'tier', 'freq'].map(k => tags[k] ? `<span class="tag g">${k === 'lifecycle' ? '生命周期' : k === 'tier' ? '贡献度' : '频次'}：${esc(tags[k])}</span>` : '').join('')}
          ${[1, 2, 3].map(i => tags['fav' + i] ? `<span class="tag y">偏好：${esc(tags['fav' + i])}</span>` : '').join('')}
        </div>
        <div class="kpis">
          <div class="kpi"><div class="v">${money(p.totalAmount)}</div><div class="t">累计消费</div></div>
          <div class="kpi"><div class="v">${p.orderCount ?? 0}</div><div class="t">订单数</div></div>
          <div class="kpi"><div class="v">${money(p.avgOrder)}</div><div class="t">客单价</div></div>
          <div class="kpi"><div class="v">${Number(p.monthlyFreq ?? 0).toFixed(1)}</div><div class="t">月均单量</div></div>
        </div>
        <div class="bar mt8">
          <span class="muted">入会 ${d.joinedAt ? dt(d.joinedAt) : '—'}</span>
          <span class="muted">首购 ${p.firstBuyAt ? dt(p.firstBuyAt) : '—'} · 最近 ${p.lastBuyAt ? dt(p.lastBuyAt) : '—'} · 活跃 ${p.months ?? 0} 个月</span>
        </div>
        ${d.orders?.length ? `
        <table class="mt8"><thead><tr><th>订单号</th><th>渠道</th><th class="num">金额</th><th>时间</th></tr></thead>
        <tbody>${d.orders.map(o => `<tr><td>${esc(o.order_no)}</td><td class="muted">${esc(o.channel)}</td>
          <td class="num">${money(o.payable_amount)}</td><td class="muted">${dt(o.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">暂无订单</div>'}
      </div>`;
    // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）
    ov.onclick = e => { if (e.target === ov) { ov.innerHTML = ''; } };
    ov.scrollIntoView({ behavior: 'smooth' });
  };

  view.innerHTML = `
    <div class="card">
      <h3>👥 会员智能画像 <span class="api">member_profiles（生命周期/偏好品类/贡献度/频次）</span></h3>
      <div class="bar">
        <button class="btn pri" id="pfRefresh">🔄 重算画像（全量）</button>
        <select id="pfTag" style="width:140px">
          <option value="">全部生命周期</option>
          <option>新客</option><option>活跃</option><option>沉睡</option><option>流失</option><option>未消费</option>
        </select>
        <input id="pfKw" placeholder="姓名 / 手机号" style="width:180px">
        <button class="btn" id="pfSearch">查询</button>
      </div>
      <div id="pfList"></div>
    </div>
    <div id="pfDetail"></div>`;

  view.querySelector('#pfRefresh').onclick = async () => {
    await must(post('/members/profile/refresh'), '画像已重算（全量）');
    await list();
  };
  view.querySelector('#pfTag').onchange = () => { tag = view.querySelector('#pfTag').value; pfPage = 1; list(); };
  view.querySelector('#pfSearch').onclick = () => { pfPage = 1; list(); };
  view.querySelector('#pfKw').addEventListener('keydown', e => { if (e.key === 'Enter') { pfPage = 1; list(); } });
  await list();
}
