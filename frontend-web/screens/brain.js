import { get, post, put, del, must, esc, dt, toast, API, money } from '../api.js';
import { openDetailModal } from '../common-ui.js';
import { promptBox } from '../ui.js';

/** 智能决策中心（9.8）：9 项智能应用 + 建议闭环 + AI 日报 + 知识库 + 自然语言问答 */
const canAI = () => (API.user?.perms || []).includes('ai.decision');

const APP_BTN = [
  { k: 'restock', label: '📦 智能补货' },
  { k: 'memberTouch', label: '🎯 会员推送' },
  { k: 'forecast', label: '📈 销量预测' },
  { k: 'pricing', label: '🏷️ 定价建议' },
  { k: 'expiryLoss', label: '⏰ 临期损耗' },
  { k: 'assocRules', label: '🧺 购物篮关联' },
  { k: 'fraudBaseline', label: '🛡️ 防损基线' },
  { k: 'effectRecovery', label: '🔁 效果回收' },
  { k: 'holidayStock', label: '🗓 节假日备货' },
  { k: 'weatherStock', label: '🌦 天气备货' },
  { k: 'memberPortraits', label: '👥 会员画像' },
  { k: 'memberMarketing', label: '🎯 画像营销' },
];

function payloadBrief(p) {
  p = p || {};
  const items = p.items || [];
  if (p.rule === '安全库存法' && items.length) {
    return `${p.count} 项：` + items.slice(0, 3).map(i => `${i.name} +${i.suggestQty}`).join('、') + (items.length > 3 ? ` 等` : '');
  }
  if (p.rule === '沉默唤醒') {
    return `${p.count} 人：` + (p.members || []).slice(0, 3).map(m => m.name).join('、') + (p.count > 3 ? ' 等' : '');
  }
  if (p.rule === '慢动销折扣建议' && items.length) {
    return `${p.count} 项：` + items.slice(0, 3).map(i => `${i.name}→¥${i.suggestPrice}`).join('、') + (items.length > 3 ? ' 等' : '');
  }
  if (p.rule === '临期损耗预警' && items.length) {
    return `${p.count} 批：` + items.slice(0, 3).map(i => `${i.productName}(${i.daysLeft}天)`).join('、') + (items.length > 3 ? ' 等' : '');
  }
  if (p.rule === '收银异常基线' && items.length) {
    return `${p.count} 人异常：` + items.slice(0, 3).map(i => `${i.name}(退${i.refundRate}%)`).join('、');
  }
  if (p.rule === '动销周转打分' && items.length) {
    return `${p.count} 项：` + items.slice(0, 3).map(i => `${i.name}（${i.suggest || '评估'}）`).join('、') + (items.length > 3 ? ' 等' : '');
  }
  // V4.15.2：选品建议 payload 结构是 eliminated/expand（无 items），此前列表摘要会吐 JSON 原文
  if (p.rule === '动销周转打分') {
    const el = p.eliminated || [], ex = p.expand || [];
    if (el.length) return `${el.length} 项建议淘汰：` + el.slice(0, 3).map(i => `${i.name}（${i.suggest || '停补'}）`).join('、') + (el.length > 3 ? ' 等' : '');
    if (ex.length) return `${ex.length} 个品类建议扩容 SKU：` + ex.slice(0, 3).map(i => i.category).join('、');
    return '暂无淘汰/扩容建议';
  }
  // V4.16.0 P8：节假日/周末备货建议摘要
  if ((p.rule === '节假日备货清单' || p.rule === '周末备货提醒') && (p.categories || []).length) {
    return `${p.festival || '周末'}${p.daysLeft != null ? `(${p.daysLeft}天)` : ''} ${p.count} 个品类增量备货：` +
      p.categories.slice(0, 3).map(c => `${c.category} +${c.extraQty}`).join('、') + (p.count > 3 ? ' 等' : '');
  }
  // V4.16.1 天气因素备货建议摘要
  if (p.rule === '天气因素备货' && (p.items || p.categories || []).length) {
    const cs = p.items || p.categories || [];
    return `${p.city || ''}天气备货 ${cs.length} 个品类：` +
      cs.slice(0, 3).map(c => `${c.category} +${c.extraQty}`).join('、') + (cs.length > 3 ? ' 等' : '');
  }
  if (p.rule === '天气因素备货') {
    const d0 = (p.days || [])[0];
    return d0 ? `${p.city || ''} ${d0.condText} ${d0.tempRange}：${d0.tip || ''}` : '天气备货建议（文字版）';
  }
  // V4.16.5 会员画像营销分群摘要
  if (p.rule === '会员画像营销' && Array.isArray(p.segments)) {
    return p.segments.map(s => `${s.name} ${s.count} 人`).join('，') || '暂无分群命中';
  }
  return JSON.stringify(p).slice(0, 60);
}

/* V4.14.9 决策按钮结果人话化（此前直接弹 JSON 报错观感） */
const APP_HINT = {
  restock: r => r.count > 0 ? `分析完成：${r.count} 项商品需要补货，已生成补货建议（见下方清单，可执行生成采购单）`
    : '库存充足（或在途已覆盖），本期无需补货',
  memberTouch: r => r.count > 0 ? `找出 ${r.count} 位超过 30 天没来消费的会员，已生成推送建议（见下方清单）`
    : '近期没有沉默会员，暂不需要推送唤醒',
  forecast: r => {
    let s = `预测完成：覆盖 ${r.products ?? 0} 个商品，生成 ${r.snapshots ?? 0} 条未来 7 天预测${r.maeBackfilled ? `，回填 ${r.maeBackfilled} 条误差评估` : ''}`;
    if (Array.isArray(r.backtest) && r.backtest.length) {
      const avg = r.backtest.reduce((a, b) => a + b.mape * b.n, 0) / Math.max(1, r.backtest.reduce((a, b) => a + b.n, 0));
      s += `；近14天回测 MAPE ${avg.toFixed(1)}%（` + r.backtest.map(b => `提前${b.lead}天 ${b.mape}%`).join('，') + '）';
    }
    return s;
  },
  pricing: r => r.count > 0 ? `${r.count} 个慢动销商品建议打折清货（原价、建议价见建议清单明细）`
    : '暂无慢动销商品，无需调价',
  expiryLoss: r => r.count > 0 ? `发现 ${r.count} 个批次 15 天内到期，已生成临期损耗预警（建议打折去化或退货）`
    : '近期没有临期批次，无需处理',
  assocRules: r => `分析完成：新沉淀 ${r.ruleCount ?? 0} 条商品关联规则（覆盖近 90 天 ${r.totalOrders ?? 0} 单），收银台「顺便带一件」自动引用`,
  fraudBaseline: r => r.count > 0 ? `基线更新完成：发现 ${r.count} 名收银员指标异常，已生成防损建议`
    : '各收银员指标正常，基线已更新',
  effectRecovery: r => `效果回收完成：已对历史执行的建议做效果对比并回写训练信号`,
  assortment: r => `选品分析完成：建议淘汰/停补 ${r.eliminated ?? 0} 项，${r.expand ?? 0} 个品类建议扩容 SKU（明细见建议清单）`,
  holidayStock: r => r.count > 0 ? `${r.festival ?? '周末'}${r.daysLeft != null ? `（${r.daysLeft} 天后）` : ''}备货提醒已生成：${r.count} 个品类需增量备货（基于销量预测）`
    : (r.note || '近期无节日、非周五，暂不需要备货提醒'),
  weatherStock: r => r.count > 0 ? `天气备货建议已生成：${r.count} 个品类按天气系数增量（雨↓客流、高温↑冷饮、骤冷↑速冻）`
    : (r.note || '未来三天天气平稳，无需天气备货'),
  memberPortraits: r => r.count > 0 ? `会员画像已生成 ${r.count} 位（${r.engine === 'ollama' ? '大模型人话版' : '规则版'}，可在「会员」页详情看 🤖AI画像 页签）`
    : (r.note || '近180天无会员消费数据，暂无可生成画像的会员'),
  memberMarketing: r => r.count > 0
    ? `画像营销分群完成：共 ${r.count} 人 — ` + (r.segments || []).map(s => `${s.name} ${s.members.length} 人`).join('，') + '（名单已入建议清单，发送权在人）'
    : (r.note || '暂无可分群的画像会员'),
  dailyReport: r => `今日 AI 日报已生成`,
};

export async function render(view) {
  const CAN = canAI();
  view.innerHTML = `
    <div class="card">
      <h3>🧠 智能决策中心 </h3>
      <div id="kpis" class="kpi-row"></div>
      <div class="bar">
        <button class="btn pri" id="bRefresh" ${CAN ? '' : 'disabled'}>一键全量刷新（8 项学习闭环）</button>
        <button class="btn" id="bDaily" ${CAN ? '' : 'disabled'}>生成今日 AI 日报</button>
        <span id="llmTip" class="muted"></span>
      </div>
      <div class="bar">
        <input id="qaInput" placeholder="自然语言问经营，如：今天毛利多少 / 哪些商品缺货 / 近7天热销排行" style="flex:1">
        <button class="btn pri" id="qaGo">发送</button>
      </div>
      <div id="qaOut" class="mt8 qa-box muted" style="display:none"></div>
      <div class="bar mt8">
        ${APP_BTN.map(b => `<button class="btn sm" data-app="${b.k}" ${CAN ? '' : 'disabled'}>${b.label}</button>`).join('')}
        ${CAN ? '' : '<span class="muted">（生成/执行需「智能决策中心」权限）</span>'}
      </div>
    </div>
    <div class="card">
      <h3>🌦 天气因素 </h3>
      <div id="weatherBox" class="muted" style="font-size:12.5px">加载中…</div>
    </div>
    <div class="card">
      <h3>⚙️ 决策自动化 </h3>
      <div id="maturityBox" class="muted" style="font-size:12.5px">加载中…</div>
    </div>
    <div class="card">
      <h3>🔍 智能对账体检 </h3>
      <div class="bar"><button class="btn" id="bRecon">运行对账体检</button><span class="muted" id="reconTip"></span></div>
      <div id="reconOut" class="muted mt8" style="display:none;white-space:pre-wrap;font-size:12.5px;line-height:1.8"></div>
    </div>
    <div class="card">
      <h3>💡 建议清单 </h3>
      <div class="bar">
        <select id="fDomain"><option value="">全部域</option>
          <option>补货</option><option>定价</option><option>备货</option><option>促销</option>
          <option>营销推送</option><option>防损</option><option>选品</option></select>
        <select id="fStatus"><option value="">全部状态</option>
          <option>待处理</option><option>已执行</option><option>已否决</option></select>
        <span class="muted" id="sTotal"></span>
      </div>
      <div id="sList" class="mt8"></div>
    </div>
    <div class="card">
      <h3>📚 店内知识库 </h3>
      <div class="bar">
        <input id="kbTitle" placeholder="文档标题（如：门店操作手册）" style="width:200px">
        <input id="kbContent" placeholder="正文内容（合规话术/操作规范/供应商协议摘要）" style="flex:1">
        <button class="btn" id="kbAdd" ${CAN ? '' : 'disabled'}>入库</button>
      </div>
      <div id="kbList" class="mt8"></div>
    </div>`;

  const $ = id => view.querySelector(id.startsWith('#') ? id : '#' + id);

  /* V4.16.5 决策自动化：此处只读成熟度状态，三档开关在 系统设置 → AI赋能 → 决策自动化 */
  async function maturity() {
    const m = await must(get('/brain/maturity'));
    const modes = m.modes || {};
    $('#maturityBox').innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">` + (m.domains || []).map(d => {
      const cur = modes[d.domain] || '手动确认';
      const status = d.unlocked
        ? '<span class="tag g">✅ 已解锁全自动</span>'
        : `<span class="tag y">未解锁：采纳率 ${d.acceptRate != null ? d.acceptRate + '%' : '—'}（门槛 ${m.thresholds?.minAcceptRate ?? 70}%）· 连续达标 ${d.consecutiveWeeks}/${m.thresholds?.minWeeks ?? 2} 周 · 已决策 ${d.decided}/${m.thresholds?.minDecided ?? 5} 条</span>`;
      return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b style="width:52px">${esc(d.domain)}</b>
        <span class="tag b">${esc(cur)}</span>
        ${status}
      </div>`;
    }).join('') + `<div style="text-align:right"><button class="btn sm pri" id="matGo">⚙️ 前往系统设置修改开关</button>
      <span class="muted" style="font-size:11.5px">开关已迁至「系统设置 → AI赋能 → 决策自动化」，保存后立即生效</span></div></div>`;
    $('#matGo').onclick = () => { location.hash = '#/settings'; };
  }

  /* V4.16.0 P9 智能对账体检：渠道对账差异 + 进销存账实差异人话解读 */
  async function recon() {
    const r = await must(post('/brain/recon-insight'));
    const box = $('#reconOut');
    box.style.display = 'block';
    box.textContent = r.text || '';
    $('#reconTip').textContent = `渠道差异单 ${r.reconDiffRuns ?? 0} · 账实差异商品 ${r.stockGaps ?? 0}`;
  }

  /* V4.16.1 天气因素卡：今日+未来 3 天预报 + 经营提示 + 天气备货按钮 */
  async function weather() {
    const w = await get('/brain/weather');
    const box = $('#weatherBox');
    if (w.code !== 0 || !w.data) { box.textContent = '天气服务不可用'; return; }
    const d = w.data;
    if (!d.enabled) { box.textContent = '天气因素未开启（设置 → AI赋能 → 天气因素接入）'; return; }
    if (!(d.days || []).length) { box.textContent = `🌧 ${d.note || '暂无天气数据（检查外网连通性）'}`; return; }
    const DATE_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const rows = (d.days || []).map((x, i) => {
      const dt0 = new Date(x.date + 'T00:00:00');
      const label = i === 0 ? '今天' : (DATE_CN[dt0.getDay()] || x.date.slice(5));
      const f = (d.factors || [])[i] || {};
      const hot = x.tempMax != null && Number(x.tempMax) >= 32;
      const rain = /雨|雪/.test(x.condText || '');
      return `<tr>
        <td><b>${label}</b><div class="muted" style="font-size:11px">${x.date.slice(5)}</div></td>
        <td>${rain ? '🌧' : hot ? '☀️' : '⛅'} ${esc(x.condText || '—')}</td>
        <td class="num">${x.tempMin ?? '?'}~${x.tempMax ?? '?'}℃</td>
        <td class="num">${x.precipMm != null ? Number(x.precipMm) + 'mm' : '—'}</td>
        <td class="muted">${esc(f.tip || '按正常节奏备货')}</td>
      </tr>`;
    }).join('');
    const tips = (d.factors || []).filter(f => f.traffic < 1 || (f.boosts || []).length);
    box.innerHTML = `
      <div class="bar" style="flex-wrap:wrap;gap:10px;font-size:12px;padding-bottom:6px">
        <span>📍 <b>${esc(d.city)}</b></span>
        <span class="tag b">数据源：${d.provider === 'qweather' ? '和风天气' : d.provider === 'open-meteo' ? 'Open-Meteo' : '缓存'}</span>
        ${d.stale ? '<span class="tag y">缓存旧值（外网暂不可达，自动重试中）</span>' : ''}
        ${d.note ? `<span class="muted">${esc(d.note)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="btn sm pri" id="bWxStock" ${CAN ? '' : 'disabled'}>生成天气备货建议</button>
      </div>
      <table style="font-size:12.5px"><thead><tr><th>日期</th><th>天气</th><th class="num">气温</th><th class="num">降水</th><th>经营提示</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${tips.length ? `<div class="muted" style="font-size:11.5px;margin-top:6px">因子规则：雨/雪 客流×${Math.round((d.factors[0]?.traffic || 1) * 100)}%；高温≥32℃ 冷饮冰品×1.3；骤降≥8℃/≤5℃ 速冻火锅×1.25 —— 只做增量建议，下单权在人</div>` : ''}`;
    const btn = box.querySelector('#bWxStock');
    if (btn) btn.onclick = async () => {
      const r2 = await must(post('/brain/run/weatherStock'), '执行完成');
      const hint = (APP_HINT.weatherStock || (() => '执行完成'))(r2 || {});
      toast(`天气备货：${hint}`);
      await suggestions(); await overview();
    };
  }

  async function overview() {
    const o = await must(get('/brain/overview'));
    const fwdQty = (o.forecasts?.byCategory || []).reduce((a, c) => a + Number(c.qty), 0);
    const cells = [
      ['建议采纳率', o.acceptRate != null ? o.acceptRate + '%' : '—'],
      ['未来 7 天预测', fwdQty > 0 ? fwdQty.toFixed(0) + ' 件' : '—'],
      ['预测误差 MAE', o.mae != null ? o.mae : '—'],
      ['关联规则', o.assocRules + ' 条'],
      ['知识库文档', o.kbDocs + ' 篇'],
      ['AI 日报', o.dailyReports + ' 篇'],
      ['识别纠正率', o.recognition?.rate != null ? o.recognition.rate + '%' : '—'],
      ['最近学习', o.lastRefresh ? o.lastRefresh : '—'],
    ];
    $('#kpis').innerHTML = `<div class="kpis grid">` + cells.map(([k, v]) =>
      `<div class="kpi"><div class="v">${v}</div><div class="t">${k}</div></div>`).join('') + `</div>`;
  }

  async function llmTip() {
    const r = await get('/brain/llm/check');
    if (r.code !== 0) { $('#llmTip').textContent = ''; return; }
    const d = r.data;
    $('#llmTip').textContent = d.enabled
      ? (d.reachable ? `Ollama 已连接（${(d.models || []).join('、') || '无模型'}）` : `Ollama 不可达：${d.reason || ''}`)
      : `本地大模型(Ollama)：预留底座，默认关闭（规则引擎兜底）`;
  }

  async function qa(text) {
    const q = text || $('#qaInput').value.trim();
    if (!q) return toast('请输入经营问题', false);
    const r = await must(post('/brain/qa', { question: q }));
    $('#qaOut').style.display = 'block';
    $('#qaOut').textContent = r.answer || '';
    $('#qaInput').value = '';
  }

  /* V4.14.9 建议明细弹窗：点行查看 —— 选品明细 / 定价明细 / 推送人群 / 临期批次
   * V4.15.1：定价/补货明细升级为可编辑（勾选行改价改量可删行、实际价↔实际折扣双向联动、利润率实时显示），
   *          弹窗底部常驻「执行 / 否决」处置按钮；执行时把用户确认结果回传后端生效并写入学习库。 */
  function payloadDetailTable(p) {
    p = p || {};
    const items = p.items || [], members = p.members || [];
    const money = n => '¥' + Number(n ?? 0).toFixed(2);
    if (p.rule === '安全库存法' && items.length) return `
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">选品明细（按日均销量 × 覆盖天数 − 现有库存 − 在途 计算建议量）</div>
      <table><thead><tr><th class="seq">序号</th><th>商品</th><th class="num">现有库存</th><th class="num">在途</th><th class="num">日均销量</th><th class="num">可售天数</th><th class="num">建议订货量</th><th class="num">参考售价</th></tr></thead>
      <tbody>${items.map((i, idx) => `<tr>
        <td class="num seq">${idx + 1}</td><td>${esc(i.name || '')}</td><td class="num">${Number(i.stock ?? 0)}</td><td class="num">${Number(i.inTransit ?? 0)}</td>
        <td class="num">${Number(i.avgDaily ?? 0)}</td><td class="num">${i.daysLeft ?? '—'}</td>
        <td class="num" style="font-weight:700;color:var(--pri)">${Number(i.suggestQty ?? 0)}</td>
        <td class="num">${i.sellPrice != null ? money(i.sellPrice) : '—'}</td></tr>`).join('')}</tbody></table>`;
    if (p.rule === '沉默唤醒' && members.length) return `
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">推送人群明细（${p.silentDays ?? 30} 天无有效消费，且有余额/未用券）</div>
      <table><thead><tr><th class="seq">序号</th><th>会员</th><th>手机号</th><th class="num">余额</th><th class="num">分红余额</th><th class="num">沉默天数</th></tr></thead>
      <tbody>${members.map((m, i) => `<tr><td class="num seq">${i + 1}</td><td>${esc(m.name || '')}</td><td class="mono">${esc(m.phone || '—')}</td>
        <td class="num">${money(m.balance)}</td><td class="num">${money(m.dividendBalance)}</td><td class="num">≥ ${m.silentDays ?? 30}</td></tr>`).join('')}</tbody></table>`;
    if ((p.rule === '慢动销折扣建议' || p.rule === '临期损耗预警') && items.length) return `
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">定价明细（哪些商品建议改价：原售价 → 现售价）</div>
      <table><thead><tr><th class="seq">序号</th><th>商品</th><th class="num">进价</th><th class="num">原售价</th><th class="num">建议价</th><th class="num">建议折扣</th><th>原因</th>${p.rule === '临期损耗预警' ? '<th class="num">剩余天数</th>' : '<th class="num">近7天销量</th>'}</tr></thead>
      <tbody>${items.map((i, idx) => `<tr>
        <td class="num seq">${idx + 1}</td><td>${esc(i.name || i.productName || '')}</td>
        <td class="num">${i.cost != null ? money(i.cost) : '—'}</td>
        <td class="num">${money(i.sellPrice)}</td>
        <td class="num" style="font-weight:700;color:var(--warn)">${money(i.suggestPrice)}</td>
        <td class="num">${Number(i.discount ?? 1) * 10 === 10 ? '—' : (Number(i.discount) * 10).toFixed(1).replace(/\.0$/, '') + ' 折'}</td>
        <td class="muted">${esc(i.reason || (p.rule === '临期损耗预警' ? `${i.daysLeft} 天后到期（批次 ${esc(i.batchNo || '')}，剩余 ${Number(i.remainQty ?? 0)}）` : '—'))}</td>
        <td class="num">${p.rule === '临期损耗预警' ? i.daysLeft : Number(i.qty7 ?? 0)}</td></tr>`).join('')}</tbody></table>`;
    // V4.15.2 修复：选品建议 payload 结构是 { eliminated, expand }（无 items），此前弹窗落到 JSON 原文兜底
    if (p.rule === '动销周转打分') {
      const el = p.eliminated || p.items || [], ex = p.expand || [];
      if (!el.length && !ex.length) return '<div class="empty">该建议无明细数据</div>';
      return `
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">淘汰评估明细（窗口 ${p.windowDays ?? 30} 天动销/周转打分：动销越慢分越低，建议「清仓/停补淘汰」的是重灾对象；执行权在人）</div>
      <table><thead><tr><th class="seq">序号</th><th>商品</th><th>类别</th><th class="num">库存</th><th class="num">窗口销量</th><th class="num">动销天数</th><th class="num">周转天数</th><th class="num">售价</th><th class="num">打分</th><th>建议</th></tr></thead>
      <tbody>${el.map((i, idx) => `<tr>
        <td class="num seq">${idx + 1}</td><td>${esc(i.name || '')}</td><td class="muted">${esc(i.category || '未分类')}</td>
        <td class="num">${Number(i.stock ?? 0)}</td><td class="num">${Number(i.qtyWindow ?? 0)}</td>
        <td class="num">${i.sellDays ?? '—'}</td>
        <td class="num">${i.turnoverDays != null ? i.turnoverDays : '—'}</td>
        <td class="num">${i.sellPrice != null ? money(i.sellPrice) : '—'}</td>
        <td class="num" style="font-weight:700">${i.confidence != null ? (Number(i.confidence) * 100).toFixed(0) + ' 分' : '—'}</td>
        <td class="muted">${esc(i.suggest || '—')}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">无淘汰候选</td></tr>'}</tbody></table>
      ${ex.length ? `<div class="muted" style="font-size:12.5px;margin:12px 0 6px">品类扩容建议（收入占比显著高于 SKU 占比 → 建议扩充该品类商品结构）</div>
      <table><thead><tr><th class="seq">序号</th><th>品类</th><th class="num">收入占比</th><th class="num">SKU 占比</th></tr></thead>
      <tbody>${ex.map((x, i) => `<tr><td class="num seq">${i + 1}</td><td>${esc(x.category || '')}</td><td class="num">${Number(x.revShare ?? 0)}%</td><td class="num">${Number(x.skuShare ?? 0)}%</td></tr>`).join('')}</tbody></table>` : ''}`;
    }
    if (p.rule === '收银异常基线' && items.length) return `
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">异常人员明细</div>
      <table><thead><tr><th class="seq">序号</th><th>收银员</th><th class="num">退款率%</th><th class="num">其他指标</th></tr></thead>
      <tbody>${items.map((i, idx) => `<tr><td class="num seq">${idx + 1}</td><td>${esc(i.name || '')}</td><td class="num">${i.refundRate ?? '—'}</td><td class="muted">${esc(JSON.stringify(Object.fromEntries(Object.entries(i).filter(([k]) => !['name', 'refundRate'].includes(k)))).slice(0, 80))}</td></tr>`).join('')}</tbody></table>`;
    return `<pre style="white-space:pre-wrap;font-size:12px">${esc(JSON.stringify(p, null, 2))}</pre>`;
  }

  /* V4.15.1 可编辑明细（定价 / 补货）：勾选行参与执行，可删行、改量、改实际价/实际折扣（双向联动） */
  /* V4.15.2：历史定价建议 payload 可能缺 cost（旧版引擎未写进价，或批次无在库行）
   * → 两级回填：① 即时库存 last_cost（最近批次进价） ② 商品档案 supplier 进价
   * 避免「进价/利润率」恒显示 —；两级都查不到时保持 — 不阻塞弹窗 */
  async function enrichPricingCost(p) {
    try {
      const items = p && Array.isArray(p.items) ? p.items : [];
      const missing = () => items.filter(i => i && i.cost == null);
      if (!items.length || !missing().length) return p;
      // ① 最近批次进价（remain>0）
      try {
        const rows = await must(get('/inventory/summary'));
        const list = Array.isArray(rows) ? rows : (rows && rows.items) || [];
        const m = new Map(list.map(r => [Number(r.id), r]));
        missing().forEach(i => {
          const r = m.get(Number(i.productId));
          if (r && r.last_cost != null) i.cost = Number(r.last_cost);
        });
      } catch { /* 查不到走下一级 */ }
      if (!missing().length) return p;
      // ② 商品档案供应商最近进价
      try {
        const d = await must(get('/products?size=100'));
        const plist = Array.isArray(d) ? d : (d && d.items) || [];
        const m2 = new Map(plist.map(r => [Number(r.id), r]));
        missing().forEach(i => {
          const r = m2.get(Number(i.productId));
          const c = r ? Number(r.cost_price ?? r.costPrice ?? 0) : 0;
          if (c > 0) i.cost = c;
        });
      } catch { /* 保持 — */ }
    } catch { /* 整体兜底不阻塞弹窗 */ }
    return p;
  }

  function openEditableDetail(s) {
    const p = s.payload || {};
    const items = (p.items || []).slice();
    const isPricing = p.rule === '慢动销折扣建议' || p.rule === '临期损耗预警';
    const isRestock = p.rule === '安全库存法';
    const money = n => '¥' + Number(n ?? 0).toFixed(2);
    const discTxt = d => (Number(d) * 10).toFixed(1).replace(/\.0$/, '');
    if (!isPricing && !isRestock) return null;
    const colHead = isPricing
      ? `<th style="width:34px"><input type="checkbox" id="edAll" checked></th><th>商品</th><th class="num">进价</th><th class="num">原售价</th>
         <th class="num">建议价</th><th class="num" style="width:104px">实际价</th><th class="num">建议折扣</th>
         <th class="num" style="width:96px">实际折扣</th><th class="num">利润率</th>${p.rule === '临期损耗预警' ? '<th class="num">剩余天数</th>' : '<th class="num">近7天销量</th>'}`
      : `<th style="width:34px"><input type="checkbox" id="edAll" checked></th><th>商品</th><th class="num">现有库存</th><th class="num">在途</th>
         <th class="num">日均销量</th><th class="num" style="width:104px">订货数量</th><th class="num">参考售价</th>`;
    const rowsHtml = items.map((i, ix) => {
      const sugP = Number(i.suggestPrice ?? 0), orig = Number(i.sellPrice ?? 0);
      const disc = Number(i.discount ?? (orig > 0 ? sugP / orig : 1));
      if (isPricing) return `<tr data-ix="${ix}">
        <td><input type="checkbox" class="ed-chk" data-ix="${ix}" checked></td>
        <td><b>${esc(i.name || '')}</b><div class="muted" style="font-size:11px">${esc(i.reason || (p.rule === '临期损耗预警' ? `${i.daysLeft} 天后到期` : ''))}</div></td>
        <td class="num">${i.cost != null ? money(i.cost) : '—'}</td>
        <td class="num">${money(orig)}</td>
        <td class="num" style="color:var(--warn)">${money(sugP)}</td>
        <td class="num"><input type="number" class="ed-ap" data-ix="${ix}" min="0" step="0.01" value="${sugP.toFixed(2)}" style="width:88px;text-align:right;padding:3px 6px"></td>
        <td class="num">${discTxt(disc)} 折</td>
        <td class="num"><input type="number" class="ed-ad" data-ix="${ix}" min="0" max="10" step="0.1" value="${discTxt(disc)}" style="width:76px;text-align:right;padding:3px 6px"></td>
        <td class="num ed-margin">—</td>
        <td class="num">${p.rule === '临期损耗预警' ? (i.daysLeft ?? '—') : Number(i.qty7 ?? 0)}</td></tr>`;
      return `<tr data-ix="${ix}">
        <td><input type="checkbox" class="ed-chk" data-ix="${ix}" checked></td>
        <td><b>${esc(i.name || '')}</b></td>
        <td class="num">${Number(i.stock ?? 0)}</td><td class="num">${Number(i.inTransit ?? 0)}</td>
        <td class="num">${Number(i.avgDaily ?? 0)}</td>
        <td class="num"><input type="number" class="ed-qty" data-ix="${ix}" min="1" step="1" value="${Number(i.suggestQty ?? 1)}" style="width:88px;text-align:right;padding:3px 6px"></td>
        <td class="num">${i.sellPrice != null ? money(i.sellPrice) : '—'}</td></tr>`;
    }).join('');
    const { mask, close } = openDetailModal(`💡 建议 #${s.id} 明细 · ${esc(s.domain)} · ${esc(p.rule || '')}`, `
      <div class="bar" style="flex-wrap:wrap;gap:14px;font-size:12.5px;padding:4px 0 10px;border-bottom:1px dashed var(--line)">
        <span>状态：<span class="tag y">${esc(s.status)}</span></span>
        <span>置信度：<b>${s.confidence != null ? (Number(s.confidence) * 100).toFixed(0) + '%' : '—'}</b></span>
        <span>创建：${dt(s.created_at)}</span>
        <span class="muted" style="font-size:11.5px">勾选行参与执行；不想处理的行取消勾选即可；数字可直接改</span>
      </div>
      ${isPricing ? `<div class="bar" style="padding:6px 0;gap:8px">
        <span class="muted" style="font-size:12px">批量改折扣：</span>
        <input type="number" id="edBatDisc" min="1" max="9.9" step="0.1" value="8.5" style="width:70px;text-align:right;padding:3px 6px">
        <span class="muted" style="font-size:12px">折</span>
        <button class="btn sm" id="edBatApply">应用到勾选行</button>
        <button class="btn sm" id="edBatDrop" style="color:#c0392b;border-color:#e6b0aa">🗑 移除所选行</button>
      </div>` : `<div class="bar" style="padding:6px 0;gap:8px">
        <button class="btn sm" id="edBatDrop" style="color:#c0392b;border-color:#e6b0aa">🗑 移除所选行</button>
      </div>`}
      <table><thead><tr>${colHead}</tr></thead><tbody id="edBody">${rowsHtml}</tbody></table>
      <div class="muted" style="font-size:12px;margin-top:8px">判定依据：${esc(s.reason?.rule || s.reason?.note || JSON.stringify(s.reason || {}).slice(0, 120))}
        ${isPricing ? '<br>💡 利润率 =（实际价 − 进价）÷ 实际价；改「实际价」自动算折扣，改「实际折扣」自动算价格，两边联动。' : ''}
      </div>
      <div class="bar" style="justify-content:flex-end;margin-top:12px;gap:10px">
        <button class="btn" id="edReject">✗ 否决</button>
        <button class="btn pri" id="edExec">✔ 执行</button>
      </div>`, { width: 980 });
    const rowOf = el => el.closest('tr[data-ix]');
    const recalc = tr => {
      if (!tr) return;
      const i = items[Number(tr.dataset.ix)];
      if (!isPricing) return;
      const cost = i.cost != null ? Number(i.cost) : null;
      const apEl = tr.querySelector('.ed-ap');
      tr.querySelector('.ed-margin').textContent =
        cost != null && Number(apEl.value) > 0 ? ((Number(apEl.value) - cost) / Number(apEl.value) * 100).toFixed(1) + '%' : '—';
    };
    const recalcAll = () => mask.querySelectorAll('tbody tr[data-ix]').forEach(recalc);
    mask.addEventListener('input', e => {
      const tr = rowOf(e.target); if (!tr) return;
      const i = items[Number(tr.dataset.ix)];
      if (!isPricing) return;
      const orig = Number(i.sellPrice || 0);
      if (e.target.classList.contains('ed-ap')) {
        const ap = Number(e.target.value);
        if (ap > 0 && orig > 0) tr.querySelector('.ed-ad').value = (ap / orig * 10).toFixed(1);
      } else if (e.target.classList.contains('ed-ad')) {
        const d = Number(e.target.value);
        if (d > 0 && d <= 10 && orig > 0) tr.querySelector('.ed-ap').value = (orig * d / 10).toFixed(2);
      }
      recalc(tr);
    });
    recalcAll();
    const edAll = mask.querySelector('#edAll');
    if (edAll) {
      edAll.onchange = e => mask.querySelectorAll('.ed-chk').forEach(cb => cb.checked = e.target.checked);
      // V5.0.3：行勾选变化时同步表头全选框（部分取消 → 表头自动取消勾选，可再次全选/取消全选）
      mask.querySelectorAll('.ed-chk').forEach(cb => cb.onchange = () => {
        edAll.checked = mask.querySelectorAll('.ed-chk').length > 0 && [...mask.querySelectorAll('.ed-chk')].every(x => x.checked);
      });
    }
    const batDrop = mask.querySelector('#edBatDrop');
    if (batDrop) batDrop.onclick = () => {
      const sel = [...mask.querySelectorAll('.ed-chk')].filter(cb => cb.checked);
      if (!sel.length) return toast('请先勾选要移除的行', false);
      sel.forEach(cb => { const tr = rowOf(cb); items.splice(Number(tr.dataset.ix), 1); tr.remove(); });
      // 重新编号 data-ix，避免后续取行错位
      mask.querySelectorAll('tbody tr[data-ix]').forEach((tr, ix) => {
        tr.dataset.ix = String(ix);
        tr.querySelectorAll('[data-ix]').forEach(el => el.dataset.ix = String(ix));
      });
      toast(`已移除 ${sel.length} 行（仅本次执行范围，不改建议原文）`);
    };
    const batApply = mask.querySelector('#edBatApply');
    if (batApply) batApply.onclick = () => {
      const d = Number(mask.querySelector('#edBatDisc').value);
      if (!(d > 0 && d < 10)) return toast('折扣需在 0 < 折 < 10 之间', false);
      let n = 0;
      mask.querySelectorAll('tbody tr[data-ix]').forEach(tr => {
        if (!tr.querySelector('.ed-chk').checked) return;
        const i = items[Number(tr.dataset.ix)];
        const orig = Number(i.sellPrice || 0);
        if (orig > 0) {
          tr.querySelector('.ed-ad').value = String(d);
          tr.querySelector('.ed-ap').value = (orig * d / 10).toFixed(2);
          recalc(tr); n++;
        }
      });
      toast(n ? `已对 ${n} 行应用 ${d} 折` : '请先勾选行', n > 0);
    };
    const collect = () => {
      const out = [];
      mask.querySelectorAll('tbody tr[data-ix]').forEach(tr => {
        if (!tr.querySelector('.ed-chk').checked) return;
        const i = items[Number(tr.dataset.ix)];
        if (isPricing) {
          out.push({ ...i, actualPrice: Number(tr.querySelector('.ed-ap').value) || Number(i.suggestPrice) });
        } else {
          out.push({ ...i, actualQty: Number(tr.querySelector('.ed-qty').value) || Number(i.suggestQty) });
        }
      });
      return out;
    };
    mask.querySelector('#edReject').onclick = async () => {
      const reason = await promptBox({
        title: '否决该建议？',
        html: '<span class="muted" style="font-size:12.5px">否决原因（选填，作为 AI 学习信号留痕）</span>',
        placeholder: '如：当前不需要 / 价格太低 / 人工已处理…',
        okText: '确认否决',
      });
      if (reason === null) return;
      await must(post(`/brain/suggestions/${s.id}/reject`, { reason }), '建议已否决');
      close();
      await suggestions(); await overview();
    };
    mask.querySelector('#edExec').onclick = async () => {
      const finalItems = collect();
      if (!finalItems.length) return toast('请至少勾选一行参与执行', false);
      let payload = null, learning = null;
      if (isPricing) {
        payload = { rule: p.rule, count: finalItems.length, items: finalItems };
        // 学习摘要：AI 建议 vs 人工最终定价（采纳/偏离），进知识库累计
        const lines = finalItems.map(i => {
          const sug = Number(i.suggestPrice), act = Number(i.actualPrice ?? sug), orig = Number(i.sellPrice);
          const tag = Math.abs(act - sug) < 0.005 ? '采纳建议' : (act > sug ? `高于建议（保守）` : `低于建议（更激进）`);
          return `${i.name}：原售 ¥${orig.toFixed(2)} → AI 建议 ¥${sug.toFixed(2)}（${discTxt(Number(i.discount))} 折），最终定价 ¥${act.toFixed(2)}（${orig > 0 ? (act / orig * 10).toFixed(1) : '—'} 折，${tag}）`;
        });
        learning = { title: `定价执行学习 · ${new Date().toLocaleDateString('zh-CN')} · 建议 #${s.id}`,
          content: `【定价执行学习】 rule=${p.rule}；共 ${finalItems.length} 项。\n` + lines.join('\n') +
            '\n学习要点：店长对慢动销商品的折价幅度偏好以上述最终折扣为准，后续同类（零动销高库存/周转偏慢）建议应向该折扣区间收敛。' };
      } else {
        payload = { rule: p.rule, count: finalItems.length, items: finalItems };
        const lines = finalItems.map(i => `${i.name}：AI 建议 ${i.suggestQty}，最终订 ${i.actualQty}`);
        learning = { title: `补货执行学习 · ${new Date().toLocaleDateString('zh-CN')} · 建议 #${s.id}`,
          content: `【补货执行学习】共 ${finalItems.length} 项。\n` + lines.join('\n') };
      }
      const d = await must(post(`/brain/suggestions/${s.id}/execute`, { payload, learning }), d2 => d2?.note || '建议已执行');
      close();
      await suggestions(); await overview();
      void d;
    };
    return true;
  }

  async function openSuggestionDetail(s) {
    const p = s.payload || {};
    // V4.15.2：定价类建议先回填缺失进价（老建议 payload 无 cost），可编辑/只读两条路径都受益
    if (p.rule === '慢动销折扣建议' || p.rule === '临期损耗预警') await enrichPricingCost(p);
    // V4.15.1：定价/补货建议且待处理 → 可编辑明细（批量操作+执行/否决）；其余走只读表
    if (s.status === '待处理' && CAN && openEditableDetail(s)) return;
    openDetailModal(`💡 建议 #${s.id} 明细 · ${esc(s.domain)} · ${esc(p.rule || '')}`, `
      <div class="bar" style="flex-wrap:wrap;gap:14px;font-size:12.5px;padding:4px 0 10px;border-bottom:1px dashed var(--line)">
        <span>状态：<span class="tag ${s.status === '已执行' ? 'g' : s.status === '已否决' ? 'r' : 'y'}">${esc(s.status)}</span></span>
        <span>置信度：<b>${s.confidence != null ? (Number(s.confidence) * 100).toFixed(0) + '%' : '—'}</b></span>
        <span>创建：${dt(s.created_at)}</span>
        ${s.decided_by_name ? `<span>决定人：${esc(s.decided_by_name)}</span>` : ''}
        ${s.biz_ref_type === 'purchase_order' && s.biz_ref_id ? `<span>关联采购单：#<b>${s.biz_ref_id}</b></span>` : ''}
      </div>
      ${payloadDetailTable(p)}
      <div class="muted" style="font-size:12px;margin-top:8px">判定依据：${esc(s.reason?.rule || s.reason?.note || JSON.stringify(s.reason || {}).slice(0, 120))}</div>`,
      { width: 900 });
  }

  async function suggestions() {
    const dom = $('#fDomain').value, st = $('#fStatus').value;
    const qp = new URLSearchParams();
    if (dom) qp.set('domain', dom);
    if (st) qp.set('status', st);
    qp.set('size', '30');
    const r = await must(get('/brain/suggestions?' + qp));
    $('#sTotal').textContent = `共 ${r.total} 条`;
    const arr = r.items || [];
    $('#sList').innerHTML = arr.length ? `
      <table><thead><tr><th class="seq">序号</th><th>ID</th><th>域</th><th>建议内容</th><th class="num">置信度</th><th>状态</th><th>原因/决定人</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${arr.map((s, i) => {
        const conf = s.confidence != null ? (Number(s.confidence) * 100).toFixed(0) + '%' : '—';
        const tag = s.status === '已执行' ? 'g' : s.status === '已否决' ? 'r' : 'y';
        const dec = s.status === '待处理' ? '—'
          : (s.status === '已否决' ? `✗ ${esc(s.reject_reason || '未填原因')}` : '✓')
            + (s.autoExecuted ? '<span class="tag b" style="margin-left:4px">🤖 自动执行</span>'
              : s.decided_by_name ? `（${esc(s.decided_by_name)}）` : '');
        return `<tr data-sg="${s.id}" style="cursor:pointer" title="点击查看建议明细（选品/定价/人群）">
          <td class="num seq">${i + 1}</td><td>${s.id}</td><td>${esc(s.domain)}</td>
          <td class="muted">${esc(payloadBrief(s.payload))}</td>
          <td class="num">${conf}</td>
          <td><span class="tag ${tag}">${esc(s.status)}</span></td>
          <td class="muted">${dec}</td>
          <td>${dt(s.created_at)}</td>
          <td style="white-space:nowrap">${CAN && s.status === '待处理' ? `
            <button class="btn sm pri" data-x="${s.id}">执行</button>
            <button class="btn sm" data-r="${s.id}">否决</button>`
            : CAN && s.status === '已执行' && s.canRollback ? `<button class="btn sm" data-rb="${s.id}" title="撤销本次执行（定价还原原价/补货取消未到货采购单）">↩ 回滚</button>`
            : '<span class="muted" style="font-size:11.5px">点行看明细</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">暂无建议（可点击「一键全量刷新」生成）</div>';
    // 点行 → 建议明细弹窗
    view.querySelectorAll('[data-sg]').forEach(tr => tr.onclick = e => {
      if (e.target.closest('button')) return;   // 点按钮不触发明细
      const hit = arr.find(x => Number(x.id) === Number(tr.dataset.sg));
      if (hit) openSuggestionDetail(hit);
    });
    view.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
      const d = await must(post(`/brain/suggestions/${b.dataset.x}/execute`), d2 => d2?.note || '建议已执行');
      await suggestions(); await overview();
    });
    view.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => {
      // V4.14.9：否决原因改样式化输入弹窗（原 prompt）
      const reason = await promptBox({
        title: '否决该建议？',
        html: `<span class="muted" style="font-size:12.5px">否决原因（选填，作为 AI 学习信号留痕）</span>`,
        placeholder: '如：当前不需要 / 价格太低 / 人工已处理…',
        okText: '确认否决',
      });
      if (reason === null) return;
      await must(post(`/brain/suggestions/${b.dataset.r}/reject`, { reason }), '建议已否决');
      await suggestions(); await overview();
    });
    view.querySelectorAll('[data-rb]').forEach(b => b.onclick = async () => {
      if (!confirm('确认回滚该建议的执行效果？（定价→还原原价；补货→取消未到货采购单）')) return;
      const d = await must(post(`/brain/suggestions/${b.dataset.rb}/rollback`), d2 => d2?.note || '已回滚');
      toast(d?.note || '已回滚');
      await suggestions(); await overview();
    });
  }

  const kbSel = new Set();   // 知识库勾选（重渲染间保持）
  async function kb() {
    const r = await must(get('/brain/kb'));
    const arr = Array.isArray(r) ? r : r.items || [];
    $('#kbList').innerHTML = arr.length ? `
      <div class="bar" style="padding:4px 2px 0">
        <button class="btn sm" id="kbBatDel" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 批量删除 (<b id="kbDelN">0</b>)</button>
      </div>
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="kbChkAll" title="全选/取消全选" ${arr.length && arr.every(d => kbSel.has(Number(d.id))) ? 'checked' : ''}></th><th class="seq">序号</th><th>标题</th><th>来源</th><th>状态</th><th>预览</th><th>收录时间</th><th></th></tr></thead>
      <tbody>${arr.map((d, i) => `<tr>
        <td onclick="event.stopPropagation()"><input type="checkbox" data-kbchk="${d.id}" ${kbSel.has(Number(d.id)) ? 'checked' : ''}></td><td class="num seq">${i + 1}</td>
        <td>${esc(d.title)}</td>
        <td class="muted">${esc(d.source_type)}</td>
        <td><span class="tag g">${esc(d.status)}</span></td>
        <td class="muted">${esc(d.preview || '')}</td>
        <td>${dt(d.created_at)}</td>
        <td>${CAN ? `<button class="btn sm" data-kb="${d.id}">删除</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">知识库为空（AI 日报每天自动归档；也可手动录入操作规范）</div>';
    const syncDel = () => {
      const btn = $('#kbBatDel');
      if (btn) { btn.style.display = kbSel.size ? '' : 'none'; $('#kbDelN').textContent = String(kbSel.size); }
    };
    view.querySelectorAll('[data-kbchk]').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.kbchk);
      if (cb.checked) kbSel.add(id); else kbSel.delete(id);
      syncDel();
    });
    const chkAll = $('#kbChkAll');
    if (chkAll) chkAll.onchange = () => {
      arr.forEach(d => { if (chkAll.checked) kbSel.add(Number(d.id)); else kbSel.delete(Number(d.id)); });
      kb();
    };
    const batBtn = $('#kbBatDel');
    if (batBtn) batBtn.onclick = async () => {
      if (!kbSel.size || !confirm(`确认删除所选 ${kbSel.size} 篇知识库文档？`)) return;
      let ok = 0;
      for (const id of kbSel) { try { await must(del(`/brain/kb/${id}`)); ok++; kbSel.delete(id); } catch { /* 单篇失败继续 */ } }
      toast(`已删除 ${ok} 篇文档`);
      await kb();
    };
    view.querySelectorAll('[data-kb]').forEach(b => b.onclick = async () => {
      if (!confirm('确认删除该知识库文档？')) return;
      await must(del(`/brain/kb/${b.dataset.kb}`), '文档已删除');
      await kb();
    });
    syncDel();
  }

  $('#bRefresh').onclick = async () => {
    await must(post('/brain/refresh'), '全量刷新完成（8 项学习闭环）');
    await overview(); await suggestions();
  };
  $('#bDaily').onclick = async () => {
    const d = await must(post('/brain/daily-report'), d2 => d2?.created ? '今日 AI 日报已生成' : '今日日报已存在（幂等跳过）');
    toast(d?.created ? '今日 AI 日报已生成' : '今日日报已存在');
    await overview(); await kb();
  };
  $('#qaGo').onclick = () => qa();
  $('#qaInput').addEventListener('keydown', e => { if (e.key === 'Enter') qa(); });
  $('#bRecon').onclick = () => recon().catch(e => toast(e.message || '对账体检失败', false));
  view.querySelectorAll('[data-app]').forEach(b => b.onclick = async () => {
    const r = await must(post('/brain/run/' + b.dataset.app), '执行完成');
    // V4.14.9：结果人话化（此前直接弹 JSON 原文，观感差）
    const hint = (APP_HINT[b.dataset.app] || (() => '执行完成'))(r || {});
    toast(`${b.textContent.replace(/^[\u{1F300}-\u{1FAFF}]\s*/u, '')}：${hint}`);
    await overview(); await suggestions();
  });
  $('#fDomain').onchange = suggestions;
  $('#fStatus').onchange = suggestions;
  $('#kbAdd').onclick = async () => {
    const title = $('#kbTitle').value.trim(), content = $('#kbContent').value.trim();
    if (!title || !content) return toast('标题与内容不能为空', false);
    await must(post('/brain/kb', { title, content }), '知识库入库完成');
    $('#kbTitle').value = ''; $('#kbContent').value = '';
    await kb();
  };

  await overview(); await llmTip(); await suggestions(); await kb(); await maturity().catch(() => {}); await weather().catch(() => {});
}
