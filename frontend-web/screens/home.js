import { API, get, post, must, money, esc } from '../api.js';

/** 全局搜索索引（原型 #1：搜索直达功能模块；零后端，纯前端关键字映射） */
const MODULES = [
  { key: 'home',       title: '后台首页',   icon: '🏠', kw: '首页 工作台 全局搜索 待办 预警 快捷入口' },
  { key: 'dashboard',  title: '经营看板',   icon: '📊', kw: '看板 老板 业绩 周期 ABC 防损 大客户' },
  { key: 'report',     title: '报表中心',   icon: '📈', kw: '报表 销售明细 会员报表 员工业绩 导出 csv' },
  { key: 'products',   title: '商品档案',   icon: '📦', kw: '商品 货号 条码 分类 建档 保质期' },
  { key: 'stock',      title: '库存批次',   icon: '🏷️', kw: '库存 批次 临期 过期 预警 溯源 保质期 低库存' },
  { key: 'ops',        title: '库存作业',   icon: '🧾', kw: '盘点 报损 调拨 库存作业 差异' },
  { key: 'suppliers',  title: '供应商档案', icon: '🏭', kw: '供应商 供货商 档案 联营' },
  { key: 'po',         title: '采购订单',   icon: '📋', kw: '采购 订单 PO 补货 审批 下单 建议单' },
  { key: 'prices',     title: '商品调价单', icon: '💱', kw: '调价 价格 变价 最低价' },
  { key: 'bundles',    title: '组合拆分',   icon: '🧩', kw: '组合 拆分 捆绑 赠品 套包' },
  { key: 'purchase',   title: '采购入库',   icon: '🚚', kw: '入库 审核 到货 采购入库 批次' },
  { key: 'returns',    title: '采购退货',   icon: '↩️', kw: '退货 退回 凭证 拍照' },
  { key: 'recon',      title: '对账结算',   icon: '📑', kw: '对账 结算 签字 往来 费用 账 电子签字' },
  { key: 'consign',    title: '联营对账',   icon: '🤝', kw: '联营 对账 扣点 保底 电子签字 次卡' },
  { key: 'sales/orders', title: '销售单据', icon: '🧾', kw: '销售 单据 流水 订单 小票 收银' },
  { key: 'sales/items', title: '销售明细', icon: '📋', kw: '销售 明细 商品 毛利 卖了' },
  { key: 'counter',    title: '挂单/价目表', icon: '🛎️', kw: '挂单 价目 收银 价格表 台号' },
  { key: 'shifts',     title: '交接班',     icon: '⏱️', kw: '交接班 交班 班次 对班' },
  { key: 'members',    title: '会员管理',   icon: '👥', kw: '会员 储值 积分 等级 充值 档案 消费' },
  { key: 'dividend',   title: '分红引擎',   icon: '💰', kw: '分红 计提 股东 池 抵扣' },
  { key: 'marketing',  title: '营销引擎',   icon: '🎯', kw: '营销 生日 触达 临期 折扣 分红到期 提醒 规则' },
  { key: 'promotions', title: '促销活动',   icon: '🎉', kw: '促销 活动 折扣 满减 效果' },
  { key: 'coupons',    title: '优惠券',     icon: '🎟️', kw: '优惠券 券 次卡 月卡 核销' },
  { key: 'ai',         title: 'AI 训练台',  icon: '🤖', kw: 'AI 训练 识别 称重 模型 图像' },
  { key: 'staff',      title: '员工与权限', icon: '🔐', kw: '员工 权限 角色 账号 密码 操作员' },
  { key: 'settings',   title: '系统设置',   icon: '⚙️', kw: '设置 参数 打印 开关 门店' },
];

/** 快捷入口（原型 #1：高频功能一键直达）；qr:true = 弹出扫码登录二维码（qrTarget: pwa=店员端 | boss=老板端） */
const QUICK = [
  { icon: '📥', title: '入库审核', to: 'purchase' },
  { icon: '🏷️', title: '商品档案', to: 'products' },
  { icon: '🧾', title: '采购订单', to: 'po' },
  { icon: '📦', title: '库存管理', to: 'stock' },
  { icon: '👥', title: '会员中心', to: 'members' },
  { icon: '📈', title: '报表中心', to: 'report' },
  { icon: '💰', title: '分红引擎', to: 'dividend' },
  { icon: '📱', title: '手机端登录', qr: true, qrTarget: 'pwa' },
  { icon: '👔', title: '老板端登录', qr: true, qrTarget: 'boss' },
  { icon: '🛒', title: '会员端登录', h5: true },
  { icon: '⚙️', title: '系统设置', to: 'settings' },
];

/** 扫码登录弹窗（target: pwa=店员端 | boss=老板端）：一次性二维码（5 分钟），指向服务器局域网真实 IP，手机扫码免密登录 */
async function showQrLoginModal(target = 'pwa') {
  const isBoss = target === 'boss';
  const appName = isBoss ? '老板端' : '店员端';
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(20,25,18,.45);z-index:99;display:grid;place-items:center';
  mask.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:20px 22px;width:360px;max-width:92vw;text-align:center;box-shadow:0 24px 60px -20px rgba(0,0,0,.4)">
      <h3 style="margin:0 0 4px;font-size:16px">${isBoss ? '👔' : '📱'} ${appName}扫码登录</h3>
      <div style="font-size:11.5px;color:var(--ink-3,#8a8577);margin-bottom:10px">手机连<b>同一 WiFi</b> · 相机/微信扫一扫 · 免密登录${appName}（5 分钟 · 一次性）</div>
      <div class="qrbox" style="display:grid;place-items:center;min-height:206px;border:1px dashed var(--line-2,#d8d2c4);border-radius:12px;padding:8px;color:var(--ink-3,#8a8577);font-size:12px">生成中…</div>
      <div class="qrmeta" style="font-size:11px;color:var(--ink-3,#8a8577);margin:8px 0 12px;word-break:break-all"></div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn" data-a="re">↻ 重新生成</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  mask.querySelector('[data-a="re"]').onclick = genQr;
  const box = mask.querySelector('.qrbox');
  const meta = mask.querySelector('.qrmeta');
  async function genQr() {
    box.textContent = '生成中…'; meta.textContent = '';
    try {
      const d = await must(post('/auth/qr-tickets', { target: isBoss ? 'boss' : 'pwa' }));
      box.innerHTML = d.qrSvg;
      const svg = box.querySelector('svg');
      if (svg) { svg.style.width = '190px'; svg.style.height = '190px'; svg.style.display = 'block'; }
      meta.innerHTML = `服务器 <b>https://${esc(d.lanIp)}:${d.port}</b> · 有效期 ${d.expiresInSec} 秒<br><span style="font-size:10px">${esc(d.url)}</span><br><span style="font-size:10px;color:var(--muted,#8a8577)">首次扫码出现证书警告 → 点「高级 → 继续前往」<br>长期使用：浏览器收藏 <b>https://${esc(d.mdnsHost || 'pos-server.local')}:${d.port}</b>（服务器换 IP 不用改，需 Chrome/系统浏览器；部分国产浏览器开「云端加速」会解析不了域名，扫码登录请用 IP 地址）</span>`;
    } catch (e) {
      box.textContent = '生成失败：' + (e.message || e);
    }
  }
  await genQr();
}

const CAT_COLORS = ['#4d8a54', '#e8912d', '#4a7fb5', '#b5544a', '#8a7ba8', '#c9c2b4'];

/** 后台首页（P1-4 / 原型 #1）：全局搜索 + 经营数据 + 待办预警 + 快捷入口 */
export async function render(view) {
  view.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div style="padding:14px 18px 10px;display:flex;gap:10px;align-items:center">
        <div style="position:relative;flex:1">
          <input id="gsInput" type="text" autocomplete="off"
                 placeholder="🔍 全局搜索：输入功能名称 / 关键字（如：入库、分红、报表、临期、采购…）→ 回车直达"
                 style="font:inherit;font-size:14.5px;width:100%;padding:12px 16px;border:2px solid var(--line-2);border-radius:11px;background:#fff;color:var(--ink);outline:none">
          <div id="gsList" style="display:none;position:absolute;top:calc(100% + 6px);left:0;right:0;background:#fff;border:1px solid var(--line-2);border-radius:11px;box-shadow:0 12px 28px -10px rgba(30,40,20,.25);z-index:30;max-height:280px;overflow:auto"></div>
        </div>
        <span class="pill b" style="flex:0 0 auto">⭐ 搜索直达 ${MODULES.length} 个模块</span>
      </div>
      <div style="padding:0 18px 12px;font-size:11.5px;color:var(--ink-3)">支持功能名、别名与业务关键字模糊匹配（如“补货”→采购订单、“过期”→库存批次、“签字”→对账结算）；搜商品 / 会员 / 单号请到对应模块内搜索</div>
    </div>
    <div id="homeBody"></div>`;

  // ═══ 全局搜索（本地索引模糊匹配；Enter / 点击直达） ═══
  const gsInput = view.querySelector('#gsInput');
  const gsList = view.querySelector('#gsList');
  let gsIdx = -1, gsHits = [];
  const go = key => { location.hash = '#/' + key; };
  const mark = () => [...gsList.children].forEach((el, i) => el.classList.toggle('on', i === gsIdx));
  const search = v => {
    const q = v.toLowerCase().split(/\s+/).filter(Boolean);
    if (!q.length) { gsList.style.display = 'none'; return; }
    gsHits = MODULES.filter(m => q.every(t => (m.title + ' ' + m.kw + ' ' + m.key).toLowerCase().includes(t))).slice(0, 8);
    gsIdx = -1;
    gsList.innerHTML = gsHits.length
      ? gsHits.map((h, i) =>
          `<div class="gs-item ${i === gsIdx ? 'on' : ''}" data-key="${h.key}">${h.icon} <b>${esc(h.title)}</b><span class="muted">${esc(h.kw.slice(0, 42))}</span></div>`).join('')
      : '<div class="gs-item" style="cursor:default;color:var(--ink-3)">无匹配模块，请换关键字</div>';
    gsList.style.display = 'block';
  };
  gsInput.addEventListener('input', () => search(gsInput.value));
  gsInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const h = gsHits[gsIdx >= 0 ? gsIdx : 0]; if (h) go(h.key); }
    else if (e.key === 'ArrowDown') { gsIdx = Math.min(gsIdx + 1, gsHits.length - 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { gsIdx = Math.max(gsIdx - 1, 0); mark(); e.preventDefault(); }
    else if (e.key === 'Escape') gsList.style.display = 'none';
  });
  gsInput.addEventListener('blur', () => setTimeout(() => { gsList.style.display = 'none'; }, 120));
  gsList.addEventListener('mousedown', e => { const it = e.target.closest('[data-key]'); if (it) go(it.dataset.key); });

  // ═══ 经营数据 + 待办预警 ═══
  const safe = p => p.then(r => (r && r.code === 0) ? r.data : []).catch(() => []);
  const [d, expiry, inbounds, orders, recons, low] = await Promise.all([
    must(get('/reports/dashboard?period=day')),
    safe(get('/inventory/expiry-alerts')),
    safe(get('/purchase/inbounds?status=未审核')),
    safe(get('/purchase/orders?status=待审批')),
    safe(get('/purchase/recons')),
    safe(get('/inventory/summary?onlyShort=1')),
  ]);
  const c = d.current;

  // 待办与预警（原型 #1：点条目直达处理）
  const alerts = [];
  if (expiry.length) alerts.push({ icon: '🟠', cls: 'o', to: 'stock',
    text: `${expiry.length} 个批次临期（${expiry.slice(0, 2).map(x => x.product_name).join(' · ')}）`, pill: '库存管理 ▸' });
  if (inbounds.length) alerts.push({ icon: '🔵', cls: 'b', to: 'purchase',
    text: `${inbounds.length} 张入库单待审核（${inbounds.slice(0, 2).map(x => x.inbound_no).join(' · ')}）`, pill: '入库审核 ▸' });
  if (orders.length) alerts.push({ icon: '⚡', cls: 'b', to: 'po',
    text: `${orders.length} 张采购订单待审批（${orders.slice(0, 2).map(x => x.po_no).join(' · ')}）`, pill: '采购订单 ▸' });
  const pendRecon = recons.filter(r => r.status === '生成' || r.status === '待供应商确认');
  if (pendRecon.length) alerts.push({ icon: '🧾', cls: 'n', to: 'recon',
    text: `${pendRecon.length} 张对账单待确认（${pendRecon.slice(0, 2).map(r => r.supplier_name).join(' · ')}）`, pill: '对账结算 ▸' });
  if (low.length) alerts.push({ icon: '🔻', cls: 'y', to: 'stock',
    text: `${low.length} 个商品库存偏低（≤ 最低库存）`, pill: '库存管理 ▸' });

  // 近 7 日柱图
  const max = Math.max(...d.trend.map(t => Number(t.salesTotal)), 0);
  const bars = d.trend.map((t, i) => {
    const h = max ? Math.max(Number(t.salesTotal) / max * 100, 2) : 2;
    const last = i === d.trend.length - 1;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
      <small style="font-size:10px;color:var(--ink-3)">${Number(t.salesTotal).toFixed(1)}</small>
      <div style="width:100%;height:${h}%;background:linear-gradient(180deg,${last ? '#e8912d' : '#6aa36f'},${last ? '#d4791a' : '#4d8a54'});border-radius:4px 4px 0 0"></div>
      <small style="font-size:10px;${last ? 'font-weight:700;color:var(--ink-2)' : 'color:var(--ink-3)'}">${String(t.bizDate).slice(5, 10)}${last ? ' 今日' : ''}</small>
    </div>`;
  }).join('');

  // 分类销售占比（近 30 日 Top8）
  const catTotal = d.categoryShare.reduce((s, x) => s + Number(x.revenue), 0);
  const cats = d.categoryShare.slice(0, 8).map((x, i) => {
    const pct = catTotal ? Number(x.revenue) / catTotal * 100 : 0;
    return `<div style="display:flex;align-items:center;gap:6px;font-size:11.5px">
      <span style="width:9px;height:9px;border-radius:2px;background:${CAT_COLORS[i % CAT_COLORS.length]}"></span>${esc(x.name)}
      <b class="num" style="margin-left:auto">${pct.toFixed(1)}%</b></div>`;
  }).join('');

  const body = view.querySelector('#homeBody');
  body.innerHTML = `
    <div class="grid kpis">
      <div class="kpi"><div class="t">今日营业额</div><div class="v">${money(c.salesTotal)}</div></div>
      <div class="kpi"><div class="t">毛利额</div><div class="v">${money(c.profitTotal)}</div></div>
      <div class="kpi"><div class="t">订单数</div><div class="v">${c.orderCount} 单</div></div>
      <div class="kpi"><div class="t">客单价</div><div class="v">${money(c.avgTicket)}</div></div>
      <div class="kpi"><div class="t">新增会员</div><div class="v">${c.newMembers} 人</div></div>
      <div class="kpi"><div class="t">分红计提 / 抵扣</div><div class="v" style="font-size:18px;color:var(--warn)">${money(c.dividendGiven)}</div><div class="t">抵扣 ${money(c.dividendUsed)}</div></div>
    </div>
    <div class="grid" style="grid-template-columns:1.15fr .85fr;margin-top:14px">
      <div class="grid" style="gap:16px;align-content:start">
        <div class="card"><h3>近 7 日营业额（万元）</h3>
          <div style="padding:12px 16px 14px">
            <div style="display:flex;align-items:flex-end;gap:14px;height:110px;padding:0 4px;border-bottom:1px solid var(--line)">${bars}</div>
            <div style="font-size:10.5px;color:var(--ink-3);margin-top:6px">日均 ${money(max ? d.trend.reduce((s, t) => s + Number(t.salesTotal), 0) / d.trend.length : 0)} · 点击柱图直达报表中心（同口径：已完成订单）</div>
          </div>
        </div>
        <div class="card"><h3>🥧 分类销售占比（近 30 日 Top8）</h3>
          <div style="padding:12px 16px 14px;display:flex;gap:16px;align-items:center">
            <div style="width:108px;height:108px;border-radius:50%;background:conic-gradient(${d.categoryShare.slice(0, 8).map((x, i) => {
              const p = catTotal ? Number(x.revenue) / catTotal * 100 : 0;
              return `${CAT_COLORS[i % CAT_COLORS.length]} ${p.toFixed(2)}%`;
            }).join(',')});position:relative;flex:0 0 auto">
              <div style="position:absolute;inset:24px;background:#fff;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center"><b style="font-size:13px">${money(c.salesTotal)}</b><small style="font-size:9.5px;color:var(--ink-3)">总销售额</small></div>
            </div>
            <div style="flex:1;display:grid;gap:5px">${cats || '<div class="empty">暂无数据</div>'}</div>
          </div>
        </div>
      </div>
      <div class="grid" style="gap:16px;align-content:start">
        <div class="card" id="wxTimeCard"><h3>🕒 今日概览 <span class="api">时间 · 天气（V4.16.1）</span></h3>
          <div style="padding:10px 16px 12px">
            <div id="wxTime"></div>
            <div id="wxBody" class="muted" style="font-size:12.5px;margin-top:4px">天气加载中…</div>
          </div>
        </div>
        <div class="card"><h3>⏰ 待办与预警（${alerts.length}）</h3>
          <div style="padding:8px 16px 12px;display:grid;gap:7px;font-size:12.5px">
            ${alerts.length ? alerts.map(a => `
              <div onclick="location.hash='#/${a.to}'" style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border:1px solid var(--line);border-radius:9px;cursor:pointer;background:#fff">
                <span>${a.icon} ${esc(a.text)}</span><span class="pill ${a.cls}" style="font-size:10px">${esc(a.pill)}</span>
              </div>`).join('') : '<div class="empty">暂无待办，一切正常 ✓</div>'}
          </div>
        </div>
        <div class="card"><h3>🚀 快捷入口</h3>
          <div style="padding:10px 16px 14px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
            ${QUICK.map(q => q.qr
              ? `<button class="btn" data-qr="1" data-qr-target="${q.qrTarget || 'pwa'}" style="padding:10px 4px;font-size:12px">${q.icon} ${q.title}</button>`
              : q.h5
              ? `<button class="btn" data-h5="1" style="padding:10px 4px;font-size:12px">${q.icon} ${q.title}</button>`
              : `<button class="btn" style="padding:10px 4px;font-size:12px" onclick="location.hash='#/${q.to}'">${q.icon} ${q.title}</button>`).join('')}
          </div>
          <div style="padding:0 16px 12px;font-size:11.5px;color:var(--ink-3)">快捷入口与待办清单按角色权限动态显示；店长 / 老板默认全量，收银员仅见收银相关</div>
        </div>
      </div>
    </div>`;

  // 扫码登录（快捷入口 → 弹窗出码；按入口分别指向店员端 PWA / 老板端）
  view.querySelectorAll('[data-qr]').forEach(b => b.onclick = () => showQrLoginModal(b.dataset.qrTarget === 'boss' ? 'boss' : 'pwa'));

  // V4.14.8：会员端登录（新窗口打开会员 H5；地址优先取设置 member.h5.entry_url）
  view.querySelectorAll('[data-h5]').forEach(b => b.onclick = async () => {
    let url = '';
    try {
      const all = await get('/settings');
      const rows = all?.data ?? all ?? [];
      const row = Array.isArray(rows) ? rows.find(x => x.setting_key === 'member.h5.entry_url') : null;
      url = String(row?.value ?? '').replace(/^"|"$/g, '');
    } catch { /* 设置读取失败走默认地址 */ }
    if (!url) url = API.base + '/member/';
    window.open(url, '_blank');
  });

  // ═══ V4.16.2 天气+时间小卡：时钟 15s 刷新（元素不在即自清）；天气复用 /brain/weather，失败静默 ═══
  const wxCard = view.querySelector('#wxTimeCard');
  const clock = () => {
    const el = wxCard?.querySelector('#wxTime');
    if (!el) { clearInterval(homeClockTimer); return; }
    const n = new Date();
    const wk = '日一二三四五六'[n.getDay()];
    el.innerHTML = `<b style="font-size:26px;font-variant-numeric:tabular-nums;letter-spacing:1px">${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}</b>
      <span class="muted" style="font-size:12px;margin-left:8px">${n.getMonth() + 1}月${n.getDate()}日 周${wk}</span>`;
  };
  clock();
  const homeClockTimer = setInterval(clock, 15000);
  try {
    const w = await get('/brain/weather');
    const d = w?.data;
    const box = wxCard?.querySelector('#wxBody');
    if (box) {
      if (!d?.enabled || !(d.days || []).length) {
        box.innerHTML = `<span class="muted" style="font-size:12px">${esc(d?.note || '天气未启用（设置 → AI赋能 → 天气因素接入）')}</span>`;
      } else {
        const t0 = d.days[0], f0 = (d.factors || [])[0] || {};
        const icon = /雨|雪/.test(t0.condText || '') ? '🌧' : (t0.tempMax != null && Number(t0.tempMax) >= 32 ? '☀️' : '⛅');
        box.innerHTML = `
          <span style="font-size:22px;margin-right:6px">${icon}</span>
          <b style="font-size:14px">${esc(d.city)} ${esc(t0.condText || '')}</b>
          <span class="muted" style="font-size:12.5px;margin-left:6px">${t0.tempMin ?? '?'}~${t0.tempMax ?? '?'}℃${t0.precipMm != null && Number(t0.precipMm) > 0 ? ' · 降水 ' + Number(t0.precipMm) + 'mm' : ''}${d.stale ? ' · 缓存' : ''}${d.provider ? ` · <span title="${d.provider === 'qweather' ? '和风天气' : 'Open-Meteo 免 Key 源（配置和风 Key 后优先走和风）'}">${d.provider === 'qweather' ? '和风' : d.provider === 'open-meteo' ? 'OM源' : esc(d.provider)}</span>` : ''}</span>
          ${f0.tip ? `<div class="muted" style="font-size:11.5px;margin-top:3px">💡 ${esc(f0.tip)}</div>` : ''}`;
      }
    }
  } catch {
    const box = wxCard?.querySelector('#wxBody');
    if (box) box.innerHTML = '<span class="muted" style="font-size:12px">天气服务不可用（检查后端连通性）</span>';
  }
}
