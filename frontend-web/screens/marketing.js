import { get, put, post, must, money, esc, dt, toast } from '../api.js';

/** 规则类型元数据（图标/徽章/配置项；V4.14.0 MK 补齐四条规则的中文与人话配置） */
const RULE_META = {
  birthday:      { icon: '🎂', label: '生日', cls: 'g', cfg: [['lead_days', '提前天数(天)']] },
  expiry:        { icon: '⏳', label: '临期', cls: 'o', cfg: [['lead_days', '提前天数(天)'], ['discount', '建议折扣(0.8=8折)']] },
  dividend:      { icon: '💰', label: '分红', cls: 'b', cfg: [['lead_days', '提前天数(天)']] },
  dormant:       { icon: '💤', label: '沉默唤醒', cls: 'b', cfg: [['silent_days', '多少天未到店算沉睡(天)']] },
  low_balance:   { icon: '🪫', label: '低余额提醒', cls: 'o', cfg: [['threshold', '余额低于多少提醒(元)']] },
  guest_convert: { icon: '🎯', label: '散客转会员', cls: 'g', cfg: [['min_visits', '多少次散客单引导办卡(次)'], ['days', '回看多少天内(天)']] },
  receivable:    { icon: '📣', label: '大客户催收', cls: 'r', cfg: [['aging_days', '应收超多少天催收(天)']] },
};

/** 营销引擎（P2-1）：3 条规则（生日触达/临期折扣/分红到期提醒）+ 触达记录留痕 + 手动执行 + M4c AI 定向营销 */
export async function render(view) {
  view.innerHTML = `
    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <span style="font-weight:600">🎯 智能营销引擎</span>
      <span class="muted" style="font-size:11.5px">每日定时扫描（系统设置·促销营销·执行时刻，默认 08:30）· 触达当天同对象去重 · 站内信留痕</span>
      <button class="btn pri" id="mkRunAll" style="margin-left:auto">⚡ 立即执行全部</button>
    </div>

    <div id="mkRules" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:14px"></div>

    <div class="card" style="border-color:#b98a1c">
      <h3>🤖 AI 定向营销方案 
        <button class="btn pri sm" id="mkAiGen">✨ 生成方案</button></h3>
      <div id="mkAiPlans"></div>
      <div class="bar" style="border-top:1px dashed var(--line);margin:0;padding:12px 18px">
        <span style="font-weight:600">📈 效果回测 <span class="api">触达前后 7 天目标人群消费对比</span></span>
        <button class="btn sm" id="mkAiFx" style="margin-left:auto">刷新效果</button>
      </div>
      <div id="mkAiEffects"></div>
    </div>

    <div class="card">
      <h3>触达记录 </h3>
      <div class="bar">
        <select id="mkType" style="width:150px">
          <option value="">全部类型</option>
          <option value="birthday">🎂 生日</option>
          <option value="expiry">⏳ 临期</option>
          <option value="dividend">💰 分红</option>
          <option value="dormant">💤 沉默唤醒</option>
          <option value="low_balance">🪫 低余额</option>
          <option value="guest_convert">🎯 散客转会员</option>
          <option value="receivable">📣 大客户催收</option>
        </select>
        <select id="mkStatus" style="width:120px">
          <option value="">全部状态</option>
          <option value="待处理">待处理</option>
          <option value="已处理">已处理</option>
          <option value="已忽略">已忽略</option>
        </select>
        <input id="mkKw" placeholder="会员名/手机号/商品/内容" style="width:180px">
        <button class="btn pri" id="mkGo">查询</button>
        <span class="muted" id="mkTotal" style="margin-left:auto;font-size:11.5px"></span>
      </div>
      <div id="mkBody"></div>
      <div class="doc-foot" style="justify-content:flex-end;margin-top:0">
        <button class="btn sm" id="mkPrev">‹ 上一页</button>
        <span class="muted" style="font-size:11.5px;display:flex;align-items:center;gap:4px">第
          <input type="number" id="mkJump" min="1" value="1" style="width:52px;text-align:center;padding:2px 4px"> /
          <span id="mkPages">1</span> 页</span>
        <button class="btn sm" id="mkNext">下一页 ›</button>
      </div>
    </div>`;

  const state = { page: 1, total: 0, rules: [] };
  const $ = s => view.querySelector(s);

  /* ── 规则卡片 ── */
  const loadRules = async () => {
    state.rules = await must(get('/marketing/rules'));
    $('#mkRules').innerHTML = state.rules.map(r => {
      const meta = RULE_META[r.rule_key] || { icon: '🎯', label: r.rule_key, cls: '', cfg: [] };
      const cfg = r.config || {};
      return `<div class="card" style="margin:0">
        <h3 style="display:flex;align-items:center;gap:8px">
          <span class="badge ${meta.cls}" style="padding:2px 10px">${meta.icon} ${meta.label}</span> ${esc(r.name)}
          <span class="pill ${r.enabled ? 'b' : ''}" style="margin-left:auto">${r.enabled ? '已启用' : '已停用'}</span>
        </h3>
        <div style="padding:2px 18px 8px;font-size:12px;color:var(--ink-3)">${esc(r.description)}</div>
        <div class="bar" style="margin:8px 18px 12px;gap:8px">
          ${meta.cfg.map(([k, ph]) =>
            `<input data-cfg="${k}" type="number" step="0.05" value="${cfg[k] ?? ''}" placeholder="${ph}"
                    style="width:96px;font-size:12px" title="${ph}">`).join('')}
          <button class="btn sm pri" data-save="${r.id}" style="margin-left:auto">保存</button>
          <button class="btn sm ${r.enabled ? 'warn' : ''}" data-toggle="${r.id}">${r.enabled ? '停用' : '启用'}</button>
          <button class="btn sm" data-run="${r.id}">⚡ 执行</button>
        </div>
        <div style="padding:0 18px 12px;font-size:11px;color:var(--ink-3)">上次执行：${dt(r.last_run_at)}</div>
      </div>`;
    }).join('');

    $('#mkRules').querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
      const r = state.rules.find(x => x.id === Number(b.dataset.save));
      const cfg = {};
      b.parentElement.querySelectorAll('[data-cfg]').forEach(i => { cfg[i.dataset.cfg] = Number(i.value); });
      await must(put(`/marketing/rules/${b.dataset.save}`, { config: cfg }), '配置已保存');
      loadRules();
    });
    $('#mkRules').querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const r = state.rules.find(x => x.id === Number(b.dataset.toggle));
      await must(put(`/marketing/rules/${b.dataset.toggle}`, { enabled: !r.enabled }),
        r.enabled ? '规则已停用' : '规则已启用');
      loadRules();
    });
    $('#mkRules').querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
      const r = state.rules.find(x => x.id === Number(b.dataset.run));
      await runRule(r.rule_key);
    });
  };

  const runRule = async key => {
    const out = await must(post('/marketing/run', key ? { ruleKey: key } : {}));
    const n = out.byRule?.[key];
    toast(key ? `${RULE_META[key]?.label}规则生成 ${n} 条触达` : `执行完成：${JSON.stringify(out.byRule)}`);
    loadRules(); loadTouches();
  };
  $('#mkRunAll').onclick = () => runRule(null);

  /* ── 触达记录 ── */
  const TYPE_ICON = { birthday: '🎂', expiry: '⏳', dividend: '💰', dormant: '💤', low_balance: '🪫', guest_convert: '🎯', receivable: '📣' };
  const mkSel = new Set();   // V5.0.2：触达批量勾选（跨翻页保留，批量处理/忽略后清除）
  const loadTouches = async () => {
    const kw = $('#mkKw').value.trim();
    const r = await must(get(`/marketing/touches?type=${$('#mkType').value}&status=${$('#mkStatus').value}&keyword=${encodeURIComponent(kw)}&page=${state.page}`));
    state.total = r.total;
    $('#mkTotal').textContent = `共 ${r.total} 条`;
    const mkPages = Math.max(1, Math.ceil(r.total / r.size));
    $('#mkPages').textContent = String(mkPages);
    const mkJump = $('#mkJump');
    mkJump.max = String(mkPages); mkJump.value = String(state.page);
    $('#mkPrev').disabled = state.page <= 1;
    $('#mkNext').disabled = state.page >= mkPages;
    if (!r.items.length) { $('#mkBody').innerHTML = '<div class="empty">暂无触达记录（可点规则卡片「⚡ 执行」立即生成）</div>'; return; }
    $('#mkBody').innerHTML = `
      <div class="bar" style="margin-bottom:6px">
        <button class="btn sm" id="mkBatDone" style="display:none">✓ 批量已处理 (<b>0</b>)</button>
        <button class="btn sm ghost" id="mkBatIgn" style="display:none">忽略 (<b>0</b>)</button>
        <span class="muted" style="font-size:12px" id="mkSelN"></span>
      </div>
      <table class="tbl">
        <thead><tr><th style="width:30px"><input type="checkbox" id="mkChkAll" title="全选/取消全选本页" ${r.items.length && r.items.every(t => mkSel.has(Number(t.id))) ? 'checked' : ''}></th><th class="seq">序号</th><th>时间</th><th>类型</th><th>对象</th><th>内容</th><th>状态</th><th style="width:150px">操作</th></tr></thead>
        <tbody>${r.items.map((t, i) => {
          const obj = t.member_name ? `👤 ${esc(t.member_name)}${t.phone ? ' · ' + esc(t.phone) : ''}`
            : t.product_name ? `📦 ${esc(t.product_name)}` : '—';
          const stCls = t.status === '待处理' ? 'o' : t.status === '已处理' ? 'g' : '';
          // V5.0.1：大客户催收触达 → 直接「去收款」，打通提醒→回款闭环（与「大客户与团购」收款同接口）
          let rcv = null;
          if (t.touch_type === 'receivable' && t.payload) {
            try { rcv = typeof t.payload === 'string' ? JSON.parse(t.payload) : t.payload; } catch { /* payload 异常忽略 */ }
          }
          const obj2 = rcv?.customerName ? `🤝 ${esc(rcv.customerName)}${rcv.phone ? ' · ' + esc(rcv.phone) : ''}` : obj;
          return `<tr>
            <td><input type="checkbox" class="mk-chk" data-id="${t.id}" ${mkSel.has(t.id) ? 'checked' : ''}></td>
            <td class="num seq">${i + 1}</td><td style="white-space:nowrap;color:var(--ink-3);font-size:12px">${dt(t.created_at)}</td>
            <td><span class="badge ${RULE_META[t.touch_type]?.cls || ''}">${TYPE_ICON[t.touch_type] || '🎯'} ${RULE_META[t.touch_type]?.label || t.touch_type}</span></td>
            <td style="white-space:nowrap">${obj2}</td>
            <td style="max-width:420px"><b>${esc(t.title)}</b><div class="muted" style="font-size:11.5px">${esc(t.content)}</div></td>
            <td><span class="pill ${stCls}">${t.status}</span></td>
            <td>${t.status === '待处理' ? `
              ${rcv?.customerId ? `<button class="btn sm pri" data-gocollect="${t.id}">💰 去收款</button>` : ''}
              <button class="btn sm" data-done="${t.id}">✓ 已处理</button>
              <button class="btn sm" data-ign="${t.id}">忽略</button>` : '<span class="muted">—</span>'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    $('#mkBody').querySelectorAll('[data-done]').forEach(b => b.onclick = () => setStatus(b.dataset.done, '已处理'));
    $('#mkBody').querySelectorAll('[data-ign]').forEach(b => b.onclick = () => setStatus(b.dataset.ign, '已忽略'));
    // V5.0.2：批量勾选（处理/忽略）
    const syncSel = () => {
      const n = mkSel.size;
      const d1 = $('#mkBatDone'), d2 = $('#mkBatIgn');
      if (d1) { d1.style.display = n ? '' : 'none'; d1.querySelector('b').textContent = String(n); }
      if (d2) { d2.style.display = n ? '' : 'none'; d2.querySelector('b').textContent = String(n); }
      const sn = $('#mkSelN'); if (sn) sn.textContent = n ? `已选 ${n} 条` : '';
    };
    syncSel();
    $('#mkBody').querySelectorAll('.mk-chk').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) mkSel.add(id); else mkSel.delete(id);
      syncSel();
    });
    const chkAll = $('#mkChkAll');
    if (chkAll) chkAll.onchange = () => { r.items.forEach(t => { if (chkAll.checked) mkSel.add(t.id); else mkSel.delete(t.id); }); loadTouches(); };
    const bat = async status => {
      const ids = [...mkSel]; if (!ids.length) return;
      let ok = 0; const errs = [];
      for (const id of ids) {
        try { await must(post(`/marketing/touches/${id}/status`, { status })); mkSel.delete(id); ok++; }
        catch (e) { errs.push(e.msg || e.message || '未知错误'); }
      }
      toast(errs.length ? `成功 ${ok} 条，失败 ${errs.length} 条：${errs[0]}` : `已${status} ${ok} 条`, !errs.length);
      loadTouches();
    };
    $('#mkBatDone').onclick = () => bat('已处理');
    $('#mkBatIgn').onclick = () => bat('已忽略');
    $('#mkBody').querySelectorAll('[data-gocollect]').forEach(b => b.onclick = () => {
      const t = (r.items || []).find(x => Number(x.id) === Number(b.dataset.gocollect));
      let p = {};
      try { p = typeof t?.payload === 'string' ? JSON.parse(t.payload) : (t.payload || {}); } catch { /* noop */ }
      if (!p.customerId) return;
      openQuickCollect(p);
    });
  };

  /** V5.0.1：催收触达行内快捷收款（确认即终结该客户欠款；金额默认=当前未收） */
  function openQuickCollect(p) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="width:440px"><h3>💰 催收回款 · ${esc(p.customerName || ('客户 #' + p.customerId))}</h3>
      <div class="doc-head" style="grid-template-columns:1fr;border:1px dashed var(--line);border-radius:10px;padding:12px 14px">
        <div class="muted" style="font-size:12px">账龄 ${esc(String(p.agingDays ?? '—'))} 天 · 触达口径未收 <b style="color:#c0392b">${money(p.receivable ?? 0)}</b></div>
        <div class="fld"><label class="req">收款金额（元）</label><input id="qcAmt" type="number" min="0.01" step="0.01" value="${Number(p.receivable ?? 0).toFixed(2)}"></div>
        <div class="fld"><label>收款方式</label>
          <select id="qcMethod"><option>现金</option><option>转账</option><option>微信</option><option>支付宝</option><option>其他</option></select></div>
        <div class="fld"><label>备注</label><input id="qcRemark" placeholder="默认：催收回款"></div>
      </div>
      <div class="doc-tip">💡 收款按先进先出冲抵未清赊账单；全额收清即终结欠款（「大客户与团购」列表的收款按钮随之消失）。</div>
      <div class="doc-foot"><button class="btn" id="qcNo">取消</button><span style="flex:1"></span>
        <button class="btn pri" id="qcGo">✔ 确认收款</button></div></div>`;
    document.body.appendChild(mask);
    mask.querySelector('#qcNo').onclick = () => mask.remove();
    mask.querySelector('#qcGo').onclick = async () => {
      const amount = Number(mask.querySelector('#qcAmt').value);
      if (!(amount > 0)) return toast('收款金额必须大于 0', false);
      await must(post(`/big-customers/${p.customerId}/collect`, {
        amount, method: mask.querySelector('#qcMethod').value,
        remark: mask.querySelector('#qcRemark').value.trim() || '催收回款',
      }), `已登记收款 ${money(amount)}`);
      mask.remove();
      loadTouches();
    };
  }

  const setStatus = async (id, status) => {
    await must(post(`/marketing/touches/${id}/status`, { status }), `已标记${status}`);
    loadTouches();
  };

  /* ── M4c AI 定向营销：生成方案 → 执行 → 效果回测 ── */
  const AI_TYPE = { wake: ['沉睡唤醒', 'g'], vip: ['高贡献回馈', 'o'], fav: ['偏好品类', 'b'], none: ['无人群', ''] };
  /** V5.0.1：类型中文名兜底——回测数据可能来自营销规则类型（low_balance/receivable 等），
   *  AI_TYPE 未覆盖时回落 RULE_META 的中文标签，杜绝英文枚举直出。 */
  const aiLabel = t => AI_TYPE[t] || (RULE_META[t] ? [RULE_META[t].label, RULE_META[t].cls || ''] : null) || [t, ''];
  const loadAiPlans = async () => {
    const d = await must(post('/ai/marketing/generate', {}));
    $('#mkAiPlans').innerHTML = d.plans?.length ? d.plans.map(p => {
      const [label, cls] = aiLabel(p.type);
      return `<div class="bar" style="border:1px solid var(--line);border-radius:10px;margin:8px 18px;padding:10px 12px;flex-wrap:wrap">
        <span class="badge ${cls}" style="padding:2px 10px">${label}</span>
        <b style="margin-left:8px">${esc(p.title)}</b>
        <span class="muted" style="font-size:11.5px;margin-left:10px">${esc(p.targetTag)} · ${p.targetCount} 人</span>
        <div style="flex-basis:100%;color:var(--ink-3);font-size:12px;margin:4px 0 0 2px">
          内容：${esc(p.content)}<br>
          <span class="api">成本≈${money(p.estimateCost)} · 预估增量 ${money(p.expectedIncrement)} · ${esc(p.basis)}</span>
        </div>
        <button class="btn sm pri" data-exec="${p.type}" style="margin-left:auto" ${p.type === 'none' ? 'disabled' : ''}>▶ 执行方案</button>
      </div>`;
    }).join('') : '<div class="empty">暂无方案（先到「会员画像」重算画像）</div>';
    $('#mkAiPlans').querySelectorAll('[data-exec]').forEach(b => b.onclick = async () => {
      const p = d.plans.find(x => x.type === b.dataset.exec);
      const r = await post('/ai/marketing/execute', { plan: p });
      if (r.code !== 0) { toast(r.msg || ('错误码 ' + r.code), false); return; }
      toast(r.data?.note || '方案已执行');
      loadAiFx(); loadTouches();
    });
  };
  const loadAiFx = async () => {
    const d = await must(get('/ai/marketing/effects'));
    $('#mkAiEffects').innerHTML = d.items?.length ? `
      <div style="padding:2px 18px 14px">
      <table><thead><tr><th class="seq">序号</th><th>方案类型</th><th class="num">目标会员</th><th class="num">触达前7天</th><th class="num">触达后消费</th><th class="num">增量</th><th class="num">触达/处理</th></tr></thead>
      <tbody>${d.items.map((x, i) => {
        const [label, cls] = aiLabel(x.type);
        const up = Number(x.delta) > 0;
        return `<tr><td class="num seq">${i + 1}</td><td><span class="badge ${cls}">${label}</span></td>
          <td class="num">${x.members}</td><td class="num">${money(x.before7d)}（${x.beforeBuyers}人）</td>
          <td class="num">${money(x.afterAmt)}（${x.afterBuyers}人）</td>
          <td class="num" style="color:${up ? '#2e9e5b' : '#c0392b'}">${Number(x.delta) >= 0 ? '+' : ''}${money(x.delta)}</td>
          <td class="num">${x.touches} / ${x.handled}</td></tr>`;
      }).join('')}</tbody></table>
      <div class="muted" style="font-size:11px;margin-top:6px">注：触达后统计为执行时刻至今的全量消费；增量 = 触达后 − 触达前 7 天同期消费。</div>
      </div>` : '<div class="empty" style="margin:0 18px 14px">暂无回测数据（先在方案卡片点「▶ 执行方案」）</div>';
  };
  $('#mkAiGen').onclick = async () => {
    await must(post('/ai/marketing/generate', {}));
    await loadAiPlans();
  };
  $('#mkAiFx').onclick = loadAiFx;

  $('#mkGo').onclick = () => { state.page = 1; loadTouches(); };
  $('#mkPrev').onclick = () => { if (state.page > 1) { state.page--; loadTouches(); } };
  $('#mkNext').onclick = () => { state.page++; loadTouches(); };
  // V4.14.9 手输页码跳页
  const mkJumpGo = () => {
    const inp = $('#mkJump');
    const pages = Math.max(1, Math.ceil(state.total / 10) || 1);
    state.page = Math.min(Math.max(1, Number(inp.value) || 1), pages);
    loadTouches();
  };
  $('#mkJump').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); mkJumpGo(); } });
  $('#mkJump').addEventListener('change', mkJumpGo);
  $('#mkKw').addEventListener('keydown', e => { if (e.key === 'Enter') { state.page = 1; loadTouches(); } });

  loadRules();
  loadTouches();
  loadAiFx();
}
