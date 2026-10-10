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

/* ═══ V5.0.3 首页节日倒计时条 ═══
   公历固定节日 + 星期规则节日（母亲/父亲/感恩节）+ 农历节日（内置 2026–2030 公历换算表，
   表外/缺项年份自动跳过农历项，公历项不受影响）。
   展示未来一年内的节日，按日历日期先后排列（1月1日、2月14日…依次）。 */
const FEST_LUNAR = {   // 农历节日公历日期表：春节/端午/七夕/中秋/重阳（元宵=春节+14 天、除夕=春节-1 天自动推导）
  2026: { chunjie: '02-17', duanwu: '06-19', qixi: '08-19', zhongqiu: '09-25', zhongyang: '10-18' },
  2027: { chunjie: '02-06', duanwu: '06-09', qixi: '08-08', zhongqiu: '09-15', zhongyang: '10-08' },
  2028: { chunjie: '01-26', duanwu: '05-28', qixi: '08-26', zhongqiu: '10-03', zhongyang: '10-26' },
  2029: { chunjie: '02-13', duanwu: '06-16', qixi: '08-16', zhongqiu: '09-22', zhongyang: '10-16' },
  2030: { chunjie: '02-03', duanwu: '06-05', qixi: '08-05', zhongqiu: '09-12' },
};
const FEST_FIXED = [   // [月-日, 名称]
  ['01-01', '元旦'], ['02-14', '情人节'], ['03-08', '妇女节'], ['03-12', '植树节'],
  ['03-15', '消费者权益日'], ['04-01', '愚人节'], ['04-05', '清明节'], ['05-01', '劳动节'],
  ['05-04', '青年节'], ['05-12', '护士节'], ['05-20', '520'], ['06-01', '儿童节'],
  ['06-18', '618购物节'], ['08-01', '建军节'], ['09-10', '教师节'], ['10-01', '国庆节'],
  ['10-31', '万圣夜'], ['11-11', '双11购物节'], ['12-12', '双12购物节'],
  ['12-24', '平安夜'], ['12-25', '圣诞节'],
];
/** 第 month 月第 nth 个周 day（0=周日）的日期，如母亲节=5月第2个周日 */
function nthWeekday(year, month, nth, day) {
  const d = new Date(year, month - 1, 1);
  const offset = (day - d.getDay() + 7) % 7;
  return new Date(year, month - 1, 1 + offset + (nth - 1) * 7);
}
function festCollection(year) {
  const list = FEST_FIXED.map(([md, name]) => ({ date: new Date(`${year}-${md}T00:00:00`), name }));
  list.push({ date: nthWeekday(year, 5, 2, 0), name: '母亲节' });
  list.push({ date: nthWeekday(year, 6, 3, 0), name: '父亲节' });
  list.push({ date: nthWeekday(year, 11, 4, 4), name: '感恩节' });
  const L = FEST_LUNAR[year];
  if (L) {
    const mk = (md, name) => list.push({ date: new Date(`${year}-${md}T00:00:00`), name });
    const cj = new Date(`${year}-${L.chunjie}T00:00:00`);
    mk(L.duanwu, '端午节'); mk(L.qixi, '七夕'); mk(L.zhongqiu, '中秋节');
    if (L.zhongyang) mk(L.zhongyang, '重阳节');
    list.push({ date: cj, name: '春节' });
    list.push({ date: new Date(cj.getTime() + 14 * 864e5), name: '元宵节' });
    list.push({ date: new Date(cj.getTime() - 864e5), name: '除夕' });
  }
  return list;
}
function renderFestBar(view) {
  const bar = view.querySelector('#festBar');
  const scroll = view.querySelector('#festScroll');
  if (!bar || !scroll) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const DAY = 864e5;
  // V5.0.3：按日历日期先后排列（1月1日、2月14日…依次），窗口扩到未来一年
  const items = [...festCollection(today.getFullYear()), ...festCollection(today.getFullYear() + 1)]
    .map(x => ({ ...x, left: Math.round((x.date - today) / DAY) }))
    .filter(x => x.left >= 0 && x.left <= 366)
    .sort((a, b) => a.date - b.date)
    .slice(0, 40);
  if (!items.length) return;
  const near = items[0]?.left;
  const pad = n => String(n).padStart(2, '0');
  scroll.innerHTML = items.map(x => {
    const cls = x.left === 0 ? 'today' : x.left === near ? 'near' : '';
    const cnt = x.left === 0 ? '<b>今天</b>' : `剩<b>${x.left}</b>天`;
    return `<div class="fest-item ${cls}" title="${x.name}：${x.date.getFullYear()}-${pad(x.date.getMonth() + 1)}-${pad(x.date.getDate())}">
      <div class="d">${pad(x.date.getMonth() + 1)}-${pad(x.date.getDate())}</div>
      <div class="c">${cnt}</div><div class="n">${esc(x.name)}</div></div>`;
  }).join('');
  bar.style.display = 'flex';
  const prev = view.querySelector('#festPrev'), next = view.querySelector('#festNext');
  // V5.0.3：箭头不做 disabled（避免灰色被误解为失效），滚动到头自然钳位；scrollBy 平滑失败时回退 scrollLeft
  const go = dx => {
    try { scroll.scrollBy({ left: dx, behavior: 'smooth' }); }
    catch { scroll.scrollLeft = Math.max(0, Math.min(scroll.scrollLeft + dx, scroll.scrollWidth - scroll.clientWidth)); }
  };
  prev.onclick = () => go(-280);
  next.onclick = () => go(280);
}

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
      <div class="fest-bar" id="festBar" style="display:none">
        <button class="fest-arrow" id="festPrev" title="向左">◂</button>
        <div class="fest-scroll" id="festScroll"></div>
        <button class="fest-arrow" id="festNext" title="向右">▸</button>
      </div>
    </div>
    <div id="homeBody"></div>`;
  renderFestBar(view);

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
  const ibPending = inbounds.items || inbounds || [];   // V5.0.18g：入库列表已改 {items,total} 分页结构
  if (expiry.length) alerts.push({ icon: '🟠', cls: 'o', to: 'stock',
    text: `${expiry.length} 个批次临期（${expiry.slice(0, 2).map(x => x.product_name).join(' · ')}）`, pill: '库存管理 ▸' });
  if (ibPending.length) alerts.push({ icon: '🔵', cls: 'b', to: 'purchase',
    text: `${ibPending.length} 张入库单待审核（${ibPending.slice(0, 2).map(x => x.inbound_no).join(' · ')}）`, pill: '入库审核 ▸' });
  if (orders.length) alerts.push({ icon: '⚡', cls: 'b', to: 'po',
    text: `${orders.length} 张采购订单待审批（${orders.slice(0, 2).map(x => x.po_no).join(' · ')}）`, pill: '采购订单 ▸' });
  const pendRecon = recons.filter(r => r.status === '生成' || r.status === '待供应商确认');
  if (pendRecon.length) alerts.push({ icon: '🧾', cls: 'n', to: 'recon',
    text: `${pendRecon.length} 张对账单待确认（${pendRecon.slice(0, 2).map(r => r.supplier_name).join(' · ')}）`, pill: '对账结算 ▸' });
  if (low.length) alerts.push({ icon: '🔻', cls: 'y', to: 'stock',
    text: `${low.length} 个商品库存偏低（≤ 最低库存）`, pill: '库存管理 ▸' });

  // 近 7 日柱图（V5.0.3：单位可切换 元/千元/万元，选择记忆到 localStorage）
  const SALES_UNIT_KEY = 'home_sales_unit';
  const salesTrend = d.trend;
  function paintSales7(unit) {
    const div = unit === '元' ? 1 : unit === '千元' ? 1e3 : 1e4;
    const fmt = v => { const r = v / div; return r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2); };
    const max = Math.max(...salesTrend.map(t => Number(t.salesTotal)), 0);
    const bars = salesTrend.map((t, i) => {
      // V5.0.18g 修复：柱高改 px——原 height:xx% 的直接父容器（column flex）无定高（外层 align-items:flex-end 不拉伸），
      // 百分比高度失效塌缩为 0 → 柱图不显示。110px 容器扣除上下文字约 38px，柱区最大 72px。
      const h = max ? Math.max(Math.round(Number(t.salesTotal) / max * 72), 3) : 3;
      const last = i === salesTrend.length - 1;
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
        <small style="font-size:10px;color:var(--ink-3)">${fmt(Number(t.salesTotal))}</small>
        <div style="width:100%;height:${h}px;background:linear-gradient(180deg,${last ? '#e8912d' : '#6aa36f'},${last ? '#d4791a' : '#4d8a54'});border-radius:4px 4px 0 0"></div>
        <small style="font-size:10px;${last ? 'font-weight:700;color:var(--ink-2)' : 'color:var(--ink-3)'}">${String(t.bizDate).slice(5, 10)}${last ? ' 今日' : ''}</small>
      </div>`;
    }).join('');
    const avg = salesTrend.length ? salesTrend.reduce((s, t) => s + Number(t.salesTotal), 0) / salesTrend.length : 0;
    const box = view.querySelector('#sales7Box');
    if (!box) return;
    box.innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:14px;height:110px;padding:0 4px;border-bottom:1px solid var(--line)">${bars}</div>
      <div style="font-size:10.5px;color:var(--ink-3);margin-top:6px">日均 ${fmt(avg)} ${unit} · 点击柱图直达报表中心（同口径：已完成订单）</div>`;
    view.querySelectorAll('#salesUnitSeg [data-u]').forEach(b => {
      const on = b.dataset.u === unit;
      b.style.background = on ? 'var(--pri)' : 'transparent';
      b.style.color = on ? '#fff' : 'var(--ink-3)';
      b.style.fontWeight = on ? '700' : '400';
      b.onclick = () => { try { localStorage.setItem(SALES_UNIT_KEY, b.dataset.u); } catch { } paintSales7(b.dataset.u); };
    });
  }

  // 分类销售占比（近 30 日 Top8）——V5.0.18g：导引线引出「名称+占比」标签（名称与数据合并，不再分居两端）
  const catTotal = d.categoryShare.reduce((s, x) => s + Number(x.revenue), 0);
  const catSegs = (() => {
    const total = catTotal || 1;
    let prev = 0;
    return d.categoryShare.filter(x => Number(x.revenue) > 0).slice(0, 8).map((x, i) => {
      const start = prev;
      const end = Math.min(prev + Number(x.revenue) / total * 100, 100);
      prev = end;
      return { name: String(x.name), pct: end - start, start, end, color: CAT_COLORS[i % CAT_COLORS.length] };
    });
  })();
  // 生成 ECharts 风格环形图 SVG：donut 弧段（段间留白）+ 中心总额 + 外侧导引线标签（名称: 占比%）
  function catDonutSvg() {
    const CX = 165, CY = 105, R = 80, RI = 48, W = 330, H = 210, TAU = Math.PI * 2;
    const pt = (r, a) => [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
    const segs = catSegs.map(s => {
      const a0 = s.start / 100 * TAU - Math.PI / 2, a1 = s.end / 100 * TAU - Math.PI / 2;
      return { ...s, a0, a1, mid: (a0 + a1) / 2, side: Math.cos((a0 + a1) / 2) >= 0 ? 1 : -1 };
    });
    const gapA = 0.016;   // 扇区间白缝（弧度）
    const arcs = segs.map(s => {
      let b0 = s.a0 + gapA, b1 = s.a1 - gapA;
      if (b1 - b0 < 0.01) { const m = (s.a0 + s.a1) / 2; b0 = m - 0.005; b1 = m + 0.005; }   // 极小段保可见
      const [ox0, oy0] = pt(R, b0), [ox1, oy1] = pt(R, b1), [ix1, iy1] = pt(RI, b1), [ix0, iy0] = pt(RI, b0);
      const large = (b1 - b0) > Math.PI ? 1 : 0;
      return `<path d="M${ox0.toFixed(2)},${oy0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${ox1.toFixed(2)},${oy1.toFixed(2)}
          L${ix1.toFixed(2)},${iy1.toFixed(2)} A${RI} ${RI} 0 ${large} 0 ${ix0.toFixed(2)},${iy0.toFixed(2)} Z"
          fill="${s.color}" stroke="#fff" stroke-width="1"></path>`;
    }).join('');
    // 导引线：中角引出 径向段→水平段→「名称: 占比%」；同侧标签垂直防重叠（17px）
    const L = segs.map(s => ({ ...s, ly: CY + Math.sin(s.mid) * (R + 14) }));
    for (const side of [1, -1]) {
      const g = L.filter(s => s.side === side).sort((a, b) => a.ly - b.ly);
      for (let i = 1; i < g.length; i++) if (g[i].ly - g[i - 1].ly < 17) g[i].ly = g[i - 1].ly + 17;
    }
    const leaders = L.map(s => {
      const [x0, y0] = pt(R + 2, s.mid);
      const ex = CX + s.side * (R + 26);
      return `<polyline points="${x0.toFixed(1)},${y0.toFixed(1)} ${CX + s.side * (R + 16)},${s.ly.toFixed(1)} ${ex},${s.ly.toFixed(1)}"
          fill="none" stroke="${s.color}" stroke-width="1.2" opacity=".9"></polyline>
        <text x="${ex + s.side * 4}" y="${(s.ly + 3.8).toFixed(1)}" fill="var(--ink-2)" font-size="11"
          text-anchor="${s.side > 0 ? 'start' : 'end'}">${esc(s.name)}: <tspan fill="var(--ink)" font-weight="700">${s.pct.toFixed(2)}%</tspan></text>`;
    }).join('');
    return `<svg width="${W}" height="${H}" style="overflow:visible;font-size:11.5px">
      ${arcs}${leaders}
      <text x="${CX}" y="${CY - 2}" text-anchor="middle" font-size="15" font-weight="700" fill="var(--ink)">${money(catTotal)}</text>
      <text x="${CX}" y="${CY + 15}" text-anchor="middle" font-size="9.5" fill="var(--ink-3)">近30日销售额</text>
    </svg>`;
  }

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
    <div style="display:grid;grid-template-columns:1.15fr .85fr;grid-template-rows:auto 1fr;gap:16px;margin-top:14px">
        <div class="card"><h3>近 7 日营业额
          <span id="salesUnitSeg" style="margin-left:auto;display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-weight:400">
            ${['元', '千元', '万元'].map(u => `<button data-u="${u}" style="border:none;padding:3px 10px;font-size:11.5px;cursor:pointer;color:var(--ink-3);background:transparent">${u}</button>`).join('')}
          </span></h3>
          <div id="sales7Box" style="padding:12px 16px 14px"></div>
        </div>
        <div class="card" id="wxTimeCard"><h3>🕒 今日概览 </h3>
          <div style="padding:10px 16px 12px">
            <div id="wxTime"></div>
            <div id="wxBody" class="muted" style="font-size:12.5px;margin-top:4px">天气加载中…</div>
          </div>
        </div>
        <div class="card" style="display:flex;flex-direction:column;min-height:0"><h3>🥧 分类销售占比（近 30 日 Top8）</h3>
          <div id="catPieBox" style="flex:1;min-height:250px;display:flex;align-items:center;justify-content:center">
            ${catSegs.length ? catDonutSvg() : '<div class="empty">暂无数据</div>'}
          </div>
        </div>
      <div style="display:flex;flex-direction:column;gap:16px;min-height:0">
        <div class="card"><h3>⏰ 待办与预警（${alerts.length}）</h3>
          <div style="padding:8px 16px 12px;display:grid;gap:7px;font-size:12.5px">
            ${alerts.length ? alerts.map(a => `
              <div onclick="location.hash='#/${a.to}'" style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border:1px solid var(--line);border-radius:9px;cursor:pointer;background:#fff">
                <span>${a.icon} ${esc(a.text)}</span><span class="pill ${a.cls}" style="font-size:10px">${esc(a.pill)}</span>
              </div>`).join('') : '<div class="empty">暂无待办，一切正常 ✓</div>'}
          </div>
        </div>
        <div class="card" style="flex:1"><h3>🚀 快捷入口</h3>
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
  paintSales7((() => { try { return localStorage.getItem(SALES_UNIT_KEY) || '元'; } catch { return '元'; } })());

  // V5.0.18g：分类占比饼图改用 ECharts 渲染（与参考版式一致：outer 标签 + smooth 导引线折角 + 圆角扇区 + 右侧图例）。
  // vendor/echarts.min.js 本地 1MB 动态加载；加载失败时保留上方 SVG donut 兜底。
  function renderCatPie() {
    const box = view.querySelector('#catPieBox');
    if (!box || !catSegs.length || !window.echarts) return;
    const data = d.categoryShare.filter(x => Number(x.revenue) > 0).slice(0, 8)
      .map(x => ({ name: String(x.name), value: Number(x.revenue) }));
    const total = data.reduce((s, x) => s + x.value, 0) || 1;
    echarts.init(box).setOption({
      tooltip: { trigger: 'item', formatter: p => `${p.name}<br/>${money(p.value)}（${p.percent.toFixed(2)}%）` },
      legend: {
        orient: 'vertical', right: 6, top: 'middle', itemWidth: 12, itemHeight: 12, itemGap: 8,
        textStyle: { fontSize: 11.5 },
        formatter: name => { const it = data.find(x => x.name === name); return `${name}: ${(it ? it.value / total * 100 : 0).toFixed(2)}%`; },
      },
      title: {
        text: money(catTotal), subtext: '近30日销售额', left: '36%', top: '48%', textAlign: 'center',
        textStyle: { fontSize: 15, fontWeight: 700 }, subtextStyle: { fontSize: 10 },
      },
      series: [{
        type: 'pie', radius: ['40%', '62%'], center: ['36%', '56%'],
        label: { show: true, fontSize: 11.5, formatter: '{b}: {d}%', position: 'outer', alignTo: 'labelLine', bleedMargin: 5 },
        labelLine: { show: true, length: 12, length2: 12, smooth: true, distanceToLabelLine: 3 },
        avoidLabelOverlap: true,
        data,
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      }],
    });
  }
  if (catSegs.length) {
    if (window.echarts) renderCatPie();
    else {
      const s = document.createElement('script');
      s.src = 'vendor/echarts.min.js';
      s.onload = renderCatPie;
      document.head.appendChild(s);
    }
  }

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
    // F-07：新窗口默认持有 opener（可通过 window.opener 反向操纵本页），强制 noopener/noreferrer
    window.open(url, '_blank', 'noopener,noreferrer');
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
