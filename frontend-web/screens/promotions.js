import { get, post, must, money, esc, dt, toast } from '../api.js';
import { openDetailModal, paginate, bindPager } from '../common-ui.js';
import { attachProductSearch } from '../product-search.js';

/** 促销活动：两个标签页——
 *  「促销模板」：模板卡片，点「使用此模板」→ 弹窗配置活动参数（名称/起止/规则）→ 创建；
 *  「促销活动列表」：查询（名称关键字/类型/状态）+ 列表 + 启停/效果（效果弹窗展示）。
 */
export async function render(view) {
  view.innerHTML = `
    <div class="doc-tools" style="margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)">
      <span style="font-weight:700;font-size:14.5px">🎉 促销活动</span>
      <span class="muted" style="font-size:11.5px">模板 = 玩法骨架，参数你定；活动命中后收银自动计价并留痕</span>
      <span style="display:flex;gap:2px;margin-left:auto">
        <button class="btn sm segbtn on" data-tab="tpl">🧩 促销模板</button>
        <button class="btn sm segbtn" data-tab="list">📋 促销活动列表</button>
      </span>
    </div>

    <div id="tabTpl">
      <div class="card">
        <h3>促销模板 </h3>
        <div class="doc-tip" style="margin:0 18px 10px">💡 模板只是「玩法骨架」——满多少减多少、打几折、特价多少，点「使用此模板」后在弹窗里改参数再创建活动。</div>
        <div id="tplCards" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px;padding:0 18px 16px"></div>
      </div>
    </div>

    <div id="tabList" style="display:none">
      <div class="card">
        <h3>促销活动列表 </h3>
        <div class="bar">
          <input id="pKw" placeholder="活动名称关键字（模糊）" style="width:200px">
          <select id="pKind" style="width:130px">
            <option value="">全部类型</option>
            ${['满减', '折扣', '第二件半价', '特价', '定时打折', '捆绑销售', '消费后奖励', '满件折扣'].map(k => `<option>${k}</option>`).join('')}
          </select>
          <select id="pStatus" style="width:120px">
            <option value="">全部状态</option>
            ${['进行中', '排期', '已停止'].map(k => `<option>${k}</option>`).join('')}
          </select>
          <button class="btn pri" id="pGo">查询</button>
        </div>
        <div id="plist" class="tbl-min"></div>
      </div>
    </div>`;

  const kindTag = k => ({ '满减': 'b', '折扣': 'g', '第二件半价': 'y', '特价': 'y',
    '定时打折': 'b', '捆绑销售': 'g', '消费后奖励': 'y', '满件折扣': 'g' }[k] || 'b');
  const zhe = v => { const r = Number(v); return r > 0 && r < 1 ? Math.round(r * 100) / 10 : r; };

  /* ── 连锁上下文 ── */
  const chain = { isHq: false, enabled: false, stores: [] };
  (async () => {
    try {
      const me = await must(get('/auth/me'));
      chain.isHq = !!me.hq;
      const cfg = await get('/settings/chain.enabled').catch(() => null);
      const on = cfg && cfg.data && (cfg.data.value === true || String(cfg.data.value) === 'true');
      chain.enabled = !!on || !!chain.isHq;
      if (chain.enabled && chain.isHq) {
        const st = await get('/hq/stores?size=200&status=1').catch(() => null);
        chain.stores = (st && st.data && st.data.items) ? st.data.items.filter(s => s.org_type !== 'hq') : [];
      }
    } catch { chain.enabled = false; }
  })();

  /* ── 模板卡片 ── */
  let tpls = [], curTpl = null, curRules = null;
  const s = new Date(Date.now() + 3600e3), e = new Date(Date.now() + 86400e3);
  const loc = d => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);

  function rulesSummary(kind, r) {
    try {
      if (kind === '满减') return (r.tiers || []).map(t => `满${Number(t.threshold)}减${Number(t.off)}`).join(' · ');
      if (kind === '折扣') return `满${Number(r.threshold || 0)}打${Math.round(Number(r.rate) * 10)}折`;
      if (kind === '特价') return `特价 ${money(r.specialPrice)}`;
      if (kind === '第二件半价') return '同商品第 2 件半价';
      if (kind === '定时打折') return `每日 ${r.startTime || '?'}~${r.endTime || '?'} 打${zhe(r.rate)}折`;
      if (kind === '捆绑销售') {
        const names = (r.items || []).map((x, i) => x.name || `商品${String(i + 1).padStart(2, '0')}#`).join('+');
        return `${names || '组合'} = ${money(r.bundlePrice)}`;
      }
      if (kind === '消费后奖励') return `消费满 ${Number(r.threshold)} 元 → ${r.rewardType === 'gift' ? `送赠品${r.giftName ? '「' + r.giftName + '」' : ''}${r.needConfirm ? '（需确认）' : ''}` : '发购物券'}`;
      if (kind === '满件折扣') return `满 ${Number(r.minQty)} 件打${zhe(r.rate)}折`;
      return '—';
    } catch { return '—'; }
  }
  /** V4.28.9e：会员专享活动在列表规则列前置标记，一眼可辨 */
  function rulesSummaryWithMember(kind, r) {
    const s = rulesSummary(kind, r);
    return r.memberOnly ? `👤会员专享 · ${s}` : s;
  }

  function drawCards() {
    view.querySelector('#tplCards').innerHTML = tpls.length ? tpls.map(t => {
      const r = typeof t.rules_template === 'string' ? JSON.parse(t.rules_template) : (t.rules_template || {});
      return `<div data-tpl="${t.id}" style="border:2px solid var(--line);border-radius:14px;padding:14px;cursor:pointer;
        background:var(--bg-1, #fff);box-shadow:var(--shadow);transition:transform .15s">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="tag ${kindTag(t.kind)}">${esc(t.kind)}</span>
          <b style="font-size:14px">${esc(t.name)}</b>
        </div>
        <div style="margin:10px 0 6px;font-size:20px;font-weight:800;color:var(--pri)">${esc(rulesSummary(t.kind, r))}</div>
        <div class="muted" style="font-size:12px">${esc(t.remark || '点击卡片配置参数并创建活动')}</div>
        <div style="margin-top:10px"><button class="btn sm pri" data-use="${t.id}">使用此模板 →</button></div>
      </div>`;
    }).join('') : '<div class="empty">无促销模板</div>';
    view.querySelectorAll('[data-tpl]').forEach(card => card.onclick = e => {
      if (e.target.closest('[data-use]')) return;
      openCfg(Number(card.dataset.tpl));
    });
    view.querySelectorAll('[data-use]').forEach(b => b.onclick = () => openCfg(Number(b.dataset.use)));
  }

  /* ── V4.14.0 P1：使用此模板 → 弹窗配置活动参数 ── */
  let curScope = null;   // V4.16.4：活动适用范围 {productIds, categoryIds}；null=全部商品
  function scopeSummary(scope) {
    if (!scope) return '<span class="tag g">全部商品</span>';
    const c = (scope.categoryIds || []).length, p = (scope.productIds || []).length;
    if (!c && !p) return '<span class="tag g">全部商品</span>';
    return (c ? `<span class="tag b">品类×${c}</span>` : '') + (p ? `<span class="tag y">商品×${p}</span>` : '');
  }
  function openCfg(tplId) {
    curTpl = tpls.find(t => Number(t.id) === tplId);
    if (!curTpl) return;
    curRules = JSON.parse(JSON.stringify(typeof curTpl.rules_template === 'string'
      ? JSON.parse(curTpl.rules_template) : (curTpl.rules_template || {})));
    curScope = { productIds: [], categoryIds: [], products: [] };   // V4.16.4：默认全品类
    const { mask } = openDetailModal(
      `配置活动参数：<b>${esc(curTpl.name)}</b> <span class="tag ${kindTag(curTpl.kind)}">${esc(curTpl.kind)}</span>`, `
      <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr))">
        <div class="fld"><label class="req">活动名称</label><input id="tName" placeholder="留空用模板名"></div>
        <div class="fld"><label class="req">开始时间</label><input id="tStart" type="datetime-local" value="${loc(s)}"></div>
        <div class="fld"><label class="req">结束时间</label><input id="tEnd" type="datetime-local" value="${loc(e)}"></div>
        <div class="fld"><label>&nbsp;</label>
          <label class="muted" style="min-width:0"><input type="checkbox" id="tNow" checked> 保存并立即启动</label></div>
      </div>
      <div id="cfgRules" style="padding:4px 0 8px"></div>
      <div id="cfgScope" style="padding:4px 0 8px;border-top:1px dashed var(--line)"></div>
      <div class="doc-foot">
        <button class="btn" id="cfgCancel">取消</button>
        <span style="flex:1"></span>
        <button class="btn pri" id="tGo">💾 创建活动</button>
      </div>`, { width: 700 });
    drawRules(mask);
    drawScope(mask);
    mask.querySelector('#cfgCancel').onclick = () => mask.remove();
    mask.querySelector('#tGo').onclick = async () => {
      const startAt = mask.querySelector('#tStart').value, endAt = mask.querySelector('#tEnd').value;
      if (!startAt || !endAt || startAt >= endAt) return toast('起止时间无效（开始须早于结束）', false);
      const hasScope = curScope.categoryIds.length || curScope.productIds.length;
      await must(post('/promotions', {
        templateId: curTpl.id,
        name: mask.querySelector('#tName').value.trim() || undefined,
        startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(),
        startNow: mask.querySelector('#tNow').checked,
        isStackable: mask.querySelector('#rStack').checked,
        rules: curRules,
        scope: hasScope ? { categoryIds: curScope.categoryIds, productIds: curScope.productIds } : undefined,
      }), '活动已创建（按你修改后的参数生效）');
      mask.remove();
      switchTab('list');
      await list();
    };
  }

  /* ── V4.16.4 适用范围（所有模版通用）：全品类 / 多品类勾选 / 多商品搜索添加（可组合） ── */
  async function drawScope(mask) {
    const box = mask.querySelector('#cfgScope');
    const cats = await must(get('/products/categories')).catch(() => []);
    const flat = [];
    const walk = (list, depth) => (list || []).forEach(c => { flat.push({ ...c, depth }); walk(c.children, depth + 1); });
    walk(cats, 0);
    const renderInner = () => {
      const cN = curScope.categoryIds.length, pN = curScope.productIds.length;
      box.innerHTML = `
        <label style="font-weight:700;font-size:13px">适用范围 <span class="muted" style="font-weight:400">（不选 = 全品类参与；品类与商品可同时指定，取并集）</span></label>
        <div class="bar" style="flex-wrap:wrap;margin-top:8px;align-items:flex-start">
          <div style="max-width:280px">
            <div class="muted" style="font-size:12px;margin-bottom:4px">品类（可多选）</div>
            <div style="max-height:130px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 10px">
              ${flat.length ? flat.map(c => `<label style="display:flex;align-items:center;gap:5px;font-size:12.5px;margin:2px 0;padding-left:${c.depth * 14}px">
                <input type="checkbox" class="sc-cat" value="${c.id}" ${curScope.categoryIds.includes(Number(c.id)) ? 'checked' : ''}>
                <span>${esc(c.name)}</span></label>`).join('') : '<span class="muted" style="font-size:12px">无分类数据</span>'}
            </div>
          </div>
          <div style="flex:1;min-width:220px">
            <div class="muted" style="font-size:12px;margin-bottom:4px">指定商品（可多选，搜索条码/名称/拼音）</div>
            <div class="bar" style="flex-wrap:nowrap;gap:6px">
              <button class="btn sm" id="scProdPick" style="flex:none">➕ 添加指定商品</button>
              <input id="scProdBox" readonly placeholder="未添加指定商品" style="flex:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                value="${(curScope.products || []).map(p => p.name).join('，')}" title="${esc((curScope.products || []).map(p => p.name).join('，'))}">
            </div>
          </div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">当前：${(cN || pN) ? `品类 ${cN} 个 · 商品 ${pN} 个` : '全部商品（全品类参与）'}；
          满减/满折带范围时门槛按范围内商品金额计（如「饮料品类满30减5」只看饮料小计）。</div>`;
      const kidsOfAt = pIdx => { const a = []; for (let i = pIdx + 1; i < flat.length && flat[i].depth > 0; i++) a.push(flat[i]); return a; };
      box.querySelectorAll('.sc-cat').forEach(cb => {
        const idx = flat.findIndex(c => Number(c.id) === Number(cb.value));
        const isRoot = flat[idx] && flat[idx].depth === 0;
        cb.onchange = () => {
          const id = Number(cb.value);
          if (isRoot) {
            // V5.0.3：一级勾选 → 自动勾选全部所属次级（父级勾选态完全由子级推导，不再单独存父 id）
            kidsOfAt(idx).forEach(k => {
              if (cb.checked) { if (!curScope.categoryIds.includes(Number(k.id))) curScope.categoryIds.push(Number(k.id)); }
              else curScope.categoryIds = curScope.categoryIds.filter(x => x !== Number(k.id));
            });
          }
          if (cb.checked) { if (!curScope.categoryIds.includes(id)) curScope.categoryIds.push(id); }
          else curScope.categoryIds = curScope.categoryIds.filter(x => x !== id);
          // 子级变动后父级归位：全勾 → 勾父；部分 → 不勾父（渲染为半选淡态）
          if (!isRoot) {
            let pIdx = idx; for (let i = idx; i >= 0; i--) { if (flat[i].depth === 0) { pIdx = i; break; } }
            if (pIdx !== idx) {
              const pid = Number(flat[pIdx].id);
              const kids = kidsOfAt(pIdx);
              const done = kids.filter(k => curScope.categoryIds.includes(Number(k.id))).length;
              if (done === kids.length) { if (!curScope.categoryIds.includes(pid)) curScope.categoryIds.push(pid); }
              else curScope.categoryIds = curScope.categoryIds.filter(x => x !== pid);
            }
          }
          renderInner();
        };
        // 半选态渲染：父级部分勾选 → indeterminate 淡色半选；全勾 → 正常勾选
        if (isRoot) {
          const kids = kidsOfAt(idx);
          if (kids.length) {
            const done = kids.filter(k => curScope.categoryIds.includes(Number(k.id))).length;
            if (done > 0 && done < kids.length) { cb.checked = false; cb.indeterminate = true; }
          }
        }
      });
      // V5.0.2：指定商品选择器（弹窗查询 + 复选多选；确定后逗号回填输入框，点击可再选）
      const openPicker = () => {
        const pm = document.createElement('div');
        pm.className = 'modal-mask';
        const sel = new Map((curScope.products || []).map(p => [Number(p.id), p]));
        pm.innerHTML = `<div class="modal" style="width:640px;height:min(80vh,700px);display:flex;flex-direction:column">
          <h3 style="flex:none">选择指定商品 <input id="pkKw" placeholder="条码/名称/拼音，输入即查" style="margin-left:8px;width:220px"></h3>
          <div id="pkList" style="flex:1;overflow:auto"></div>
          <div class="bar" style="flex:none;margin-top:8px;justify-content:flex-end">
            <span class="muted" style="margin-right:auto;font-size:12px">已选 <b id="pkN">0</b> 个（跨查询保留勾选）</span>
            <button class="btn" id="pkCancel">取消</button>
            <button class="btn pri" id="pkOk">确定</button></div></div>`;
        document.body.appendChild(pm);
        pm.onclick = e => { if (e.target === pm) pm.remove(); };
        const loadPk = async () => {
          const kw = encodeURIComponent(pm.querySelector('#pkKw').value.trim());
          const d = await must(get(`/products?size=50${kw ? `&keyword=${kw}` : ''}`)).catch(() => null);
          const items = d?.items || [];
          pm.querySelector('#pkN').textContent = String(sel.size);
          pm.querySelector('#pkList').innerHTML = items.length ? `<table><tbody>${items.map(p => `
            <tr><td style="width:30px"><input type="checkbox" data-pk="${p.id}" ${sel.has(Number(p.id)) ? 'checked' : ''}></td>
            <td><b>${esc(p.name)}</b></td><td class="muted" style="font-family:var(--mono)">${esc(p.barcode || '—')}</td>
            <td class="num">${Number(p.sell_price ?? 0).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
            : '<div class="empty">无匹配商品</div>';
          pm.querySelectorAll('[data-pk]').forEach(cb => cb.onchange = () => {
            const id = Number(cb.dataset.pk);
            const p = items.find(x => Number(x.id) === id);
            if (cb.checked && p) sel.set(id, { id, name: p.name }); else sel.delete(id);
            pm.querySelector('#pkN').textContent = String(sel.size);
          });
        };
        pm.querySelector('#pkKw').oninput = () => { clearTimeout(openPicker._t); openPicker._t = setTimeout(loadPk, 300); };
        pm.querySelector('#pkCancel').onclick = () => pm.remove();
        pm.querySelector('#pkOk').onclick = () => {
          curScope.products = [...sel.values()];
          curScope.productIds = curScope.products.map(x => x.id);
          pm.remove(); renderInner();
        };
        pm.querySelector('#pkKw').focus();
        loadPk();
      };
      box.querySelector('#scProdPick').onclick = openPicker;
      box.querySelector('#scProdBox').onclick = openPicker;
    };
    renderInner();
  }

  /* ── 规则参数编辑（按类型渲染不同表单） ── */
  function drawRules(mask) {
    const box = mask.querySelector('#cfgRules');
    const kind = curTpl.kind;
    if (kind === '满减') {
      curRules.tiers = Array.isArray(curRules.tiers) && curRules.tiers.length ? curRules.tiers : [{ threshold: 100, off: 20 }];
      box.innerHTML = `<label style="font-weight:700;font-size:13px">满减档位（满多少 · 减多少，可增删多档）</label>
        <table style="margin-top:8px;max-width:520px"><thead><tr><th>满（元）</th><th>减（元）</th><th style="width:60px">操作</th></tr></thead>
        <tbody id="tierRows">${curRules.tiers.map((t, i) => `
          <tr><td><input type="number" step="0.01" min="0" value="${Number(t.threshold)}" data-th="${i}" style="width:130px"></td>
              <td><input type="number" step="0.01" min="0" value="${Number(t.off)}" data-off="${i}" style="width:130px"></td>
              <td><button class="btn sm warn" data-del="${i}">删</button></td></tr>`).join('')}</tbody></table>
        <button class="btn sm" data-add="1" style="margin-top:8px">➕ 添加档位</button>`;
      box.querySelectorAll('[data-th]').forEach(inp => inp.onchange = () => { curRules.tiers[Number(inp.dataset.th)].threshold = Number(inp.value) || 0; });
      box.querySelectorAll('[data-off]').forEach(inp => inp.onchange = () => { curRules.tiers[Number(inp.dataset.off)].off = Number(inp.value) || 0; });
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { curRules.tiers.splice(Number(b.dataset.del), 1); drawRules(mask); });
      box.querySelector('[data-add]').onclick = () => { curRules.tiers.push({ threshold: 100, off: 20 }); drawRules(mask); };
    } else if (kind === '折扣') {
      const rate = Number(curRules.rate || 0.8);
      box.innerHTML = `<label style="font-weight:700;font-size:13px">整单折扣</label>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-top:8px">
          <div class="fld"><label>满足金额（元，0 = 不限）</label><input id="rTh" type="number" step="0.01" min="0" value="${Number(curRules.threshold || 0)}"></div>
          <div class="fld"><label>折扣（打几折，填 8 = 8 折）</label><input id="rRate" type="number" step="0.1" min="0.1" max="9.9" value="${Math.round(rate * 10 * 10) / 10}"></div>
        </div>`;
      mask.querySelector('#rTh').onchange = () => { curRules.threshold = Number(mask.querySelector('#rTh').value) || 0; };
      mask.querySelector('#rRate').onchange = () => { curRules.rate = (Number(mask.querySelector('#rRate').value) || 8) / 10; };
    } else if (kind === '特价') {
      box.innerHTML = `<label style="font-weight:700;font-size:13px">特价金额</label>
        <div class="doc-head" style="grid-template-columns:220px;margin-top:8px">
          <div class="fld"><label>特价（元/件）</label><input id="rSp" type="number" step="0.01" min="0" value="${Number(curRules.specialPrice || 0)}"></div>
        </div>`;
      mask.querySelector('#rSp').onchange = () => { curRules.specialPrice = Number(mask.querySelector('#rSp').value) || 0; };
    } else if (kind === '定时打折') {
      box.innerHTML = `<label style="font-weight:700;font-size:13px">每日时间窗 + 折扣（活动起止时间内，每天到点自动生效，如晚 8 点后生鲜 7 折）</label>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-top:8px">
          <div class="fld"><label>每日开始</label><input id="rS" type="time" value="${esc(curRules.startTime || '20:00')}"></div>
          <div class="fld"><label>每日结束</label><input id="rE" type="time" value="${esc(curRules.endTime || '22:00')}"></div>
          <div class="fld"><label>折扣（填 7 = 7 折）</label><input id="rRate" type="number" step="0.1" min="0.1" max="9.9" value="${zhe(curRules.rate || 0.7)}"></div>
        </div>`;
      mask.querySelector('#rS').onchange = () => { curRules.startTime = mask.querySelector('#rS').value || '20:00'; };
      mask.querySelector('#rE').onchange = () => { curRules.endTime = mask.querySelector('#rE').value || '22:00'; };
      mask.querySelector('#rRate').onchange = () => { curRules.rate = (Number(mask.querySelector('#rRate').value) || 7) / 10; };
    } else if (kind === '捆绑销售') {
      curRules.items = Array.isArray(curRules.items) && curRules.items.length ? curRules.items : [];
      box.innerHTML = `<label style="font-weight:700;font-size:13px">捆绑组合（购物车同时含以下商品时按组合价计，如 A10+B5 → 组合价 12）</label>
        <div class="doc-head" style="grid-template-columns:minmax(220px,320px);margin-top:8px">
          <div class="fld"><label>搜索添加商品（条码/名称/拼音）</label><input id="rItem" placeholder="输入关键字或扫码…"></div>
        </div>
        <table style="margin-top:6px;max-width:560px" id="rItemTbl"><thead><tr><th>商品</th><th style="width:110px">数量</th><th style="width:60px">操作</th></tr></thead>
        <tbody>${curRules.items.map((it, i) => `<tr>
          <td>${esc(it.name || `商品${String(i + 1).padStart(2, '0')}#`)}</td>
          <td><input type="number" min="1" step="1" value="${Number(it.qty || 1)}" data-qi="${i}" style="width:80px"></td>
          <td><button class="btn sm warn" data-idel="${i}">删</button></td></tr>`).join('')}</tbody></table>
        ${curRules.items.length < 2 ? '<div class="muted" style="font-size:12px;margin-top:4px">⚠ 至少需要 2 个商品</div>' : ''}
        <div class="doc-head" style="grid-template-columns:220px;margin-top:8px">
          <div class="fld"><label>组合价（元/组）</label><input id="rBp" type="number" step="0.01" min="0.01" value="${Number(curRules.bundlePrice || 0)}"></div>
        </div>`;
      attachProductSearch(mask.querySelector('#rItem'), { onPick: p => {
        if (curRules.items.some(x => Number(x.productId) === Number(p.id))) return toast('该商品已在组合内', false);
        curRules.items.push({ productId: Number(p.id), name: p.name, qty: 1 });
        drawRules(mask);
      } });
      box.querySelectorAll('[data-qi]').forEach(inp => inp.onchange = () => { curRules.items[Number(inp.dataset.qi)].qty = Math.max(1, Number(inp.value) || 1); });
      box.querySelectorAll('[data-idel]').forEach(b => b.onclick = () => { curRules.items.splice(Number(b.dataset.idel), 1); drawRules(mask); });
      mask.querySelector('#rBp').onchange = () => { curRules.bundlePrice = Number(mask.querySelector('#rBp').value) || 0; };
    } else if (kind === '消费后奖励') {
      box.innerHTML = `<label style="font-weight:700;font-size:13px">结账后发奖（单笔实付满阈值 → 会员自动得购物券/赠品，收银小票留痕）</label>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(250px,1fr));margin-top:8px">
          <div class="fld"><label>消费满（元）</label><input id="rTh" type="number" step="0.01" min="0.01" value="${Number(curRules.threshold || 0)}" placeholder="单笔实付满额"></div>
          <div class="fld"><label>奖励方式</label><select id="rType">
            <option value="coupon" ${curRules.rewardType !== 'gift' ? 'selected' : ''}>发购物券</option>
            <option value="gift" ${curRules.rewardType === 'gift' ? 'selected' : ''}>送赠品</option></select></div>
          <div class="fld" id="rGiftFld" style="display:${curRules.rewardType === 'gift' ? '' : 'none'}"><label>赠品名称</label><input id="rGift" value="${esc(curRules.giftName || '')}" placeholder="如 矿泉水550ml"></div>
          <div class="fld" id="rGiftPidFld" style="display:${curRules.rewardType === 'gift' ? '' : 'none'}"><label>赠品商品 ID</label><input id="rGiftPid" type="number" min="1" value="${curRules.giftProductId ? Number(curRules.giftProductId) : ''}" placeholder="填写=自动出库（商品档案 ID）"></div>
          <div class="fld" id="rGiftQtyFld" style="display:${curRules.rewardType === 'gift' ? '' : 'none'}"><label>每次赠送数量</label><input id="rGiftQty" type="number" min="1" step="1" value="${Number(curRules.giftQty || 1)}"></div>
          <div class="fld" id="rCpFld" style="display:${curRules.rewardType === 'coupon' ? '' : 'none'}"><label>发放券模板</label><select id="rCp"><option value="">加载中…</option></select></div>
          <div class="fld" id="rCQtyFld" style="display:${curRules.rewardType === 'coupon' ? '' : 'none'}"><label>每单发券张数</label><input id="rCQty" type="number" min="1" step="1" value="${Number(curRules.couponQty || 1)}"></div>
          <div class="fld" id="rGcFld" style="display:${curRules.rewardType === 'gift' ? '' : 'none'}"><label>发放确认</label>
            <label style="display:flex;gap:6px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" id="rGc" ${curRules.needConfirm ? 'checked' : ''}> 需收银员确认（贵重赠品建议勾选）</label></div>
          <div class="fld"><label>总发放上限（次）</label><input id="rTL" type="number" min="0" step="1" value="${Number(curRules.totalLimit || 0)}" placeholder="0=不限"></div>
          <div class="fld"><label>单会员上限（次）</label><input id="rPML" type="number" min="0" step="1" value="${Number(curRules.perMemberLimit || 0)}" placeholder="0=不限"></div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">发购物券 = 写入会员营销引擎券账户（金额走营销预算）。送赠品：填写「赠品商品 ID」后，结账时自动按 0 元赠品行<b>真实出库</b>（扣批次库存、进赠送记录报表）；不填则仅在收银小票备注，由店员现场手工加赠品行。默认<b>自动发放</b>（结算横幅+客显提示，零打断）；勾选「需收银员确认」后弹出确认框（默认选是），选「否」则本单不发放。<b>数量约束</b>：每单 1 次参与（赠品按「每次赠送数量」、券按「每单发券张数」发放）；「总发放上限」控制整个活动最多参与多少单（成本封顶，达标后自动停止提示与发放）；「单会员参与上限」防同一会员反复套利。</div>`;
      mask.querySelector('#rTh').onchange = () => { curRules.threshold = Number(mask.querySelector('#rTh').value) || 0; };
      mask.querySelector('#rType').onchange = () => {
        curRules.rewardType = mask.querySelector('#rType').value;
        ['rGiftFld', 'rGiftPidFld', 'rGiftQtyFld', 'rGcFld'].forEach(id => mask.querySelector('#' + id).style.display = curRules.rewardType === 'gift' ? '' : 'none');
        ['rCpFld', 'rCQtyFld'].forEach(id => { const el = mask.querySelector('#' + id); if (el) el.style.display = curRules.rewardType === 'coupon' ? '' : 'none'; });
      };
      // V4.28.9f：券模板下拉（发券奖励必填，此前 Web 无法配置 → 活动提交必被后端拒绝 = 死活动）
      mask.querySelector('#rCp').onchange = () => { curRules.couponTemplateId = Number(mask.querySelector('#rCp').value) || undefined; };
      get('/coupons').then(d => {
        const arr = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : []);
        const sel = mask.querySelector('#rCp');
        if (!sel) return;
        sel.innerHTML = `<option value="">请选择券模板…</option>` + arr.filter(c => Number(c.status) !== 0).map(c =>
          `<option value="${Number(c.id)}" ${Number(curRules.couponTemplateId) === Number(c.id) ? 'selected' : ''}>${
            esc(c.name)}（${esc(c.type)}${c.type === '满减券' ? ` 满${money(c.threshold)}减${money(c.discount)}` : ''}）</option>`).join('');
      }).catch(() => { });
      mask.querySelector('#rCQty').onchange = () => { curRules.couponQty = Math.max(1, Number(mask.querySelector('#rCQty').value) || 1); };
      mask.querySelector('#rTL').onchange = () => { curRules.totalLimit = Math.max(0, Number(mask.querySelector('#rTL').value) || 0); };
      mask.querySelector('#rPML').onchange = () => { curRules.perMemberLimit = Math.max(0, Number(mask.querySelector('#rPML').value) || 0); };
      mask.querySelector('#rGc').onchange = () => { curRules.needConfirm = mask.querySelector('#rGc').checked || undefined; };
      mask.querySelector('#rGift').onchange = () => { curRules.giftName = mask.querySelector('#rGift').value.trim() || undefined; };
      mask.querySelector('#rGiftPid').onchange = () => { curRules.giftProductId = Number(mask.querySelector('#rGiftPid').value) || undefined; };
      mask.querySelector('#rGiftQty').onchange = () => { curRules.giftQty = Number(mask.querySelector('#rGiftQty').value) || 1; };
    } else if (kind === '满件折扣') {
      box.innerHTML = `<label style="font-weight:700;font-size:13px">范围内商品合计满 N 件，总价打折（如雪糕满 5 支 8 折）</label>
        <div class="doc-head" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-top:8px">
          <div class="fld"><label>满（件，≥2）</label><input id="rQty" type="number" step="1" min="2" value="${Number(curRules.minQty || 2)}"></div>
          <div class="fld"><label>折扣（填 8 = 8 折）</label><input id="rRate" type="number" step="0.1" min="0.1" max="9.9" value="${zhe(curRules.rate || 0.8)}"></div>
        </div>`;
      mask.querySelector('#rQty').onchange = () => { curRules.minQty = Number(mask.querySelector('#rQty').value) || 2; };
      mask.querySelector('#rRate').onchange = () => { curRules.rate = (Number(mask.querySelector('#rRate').value) || 8) / 10; };
    } else {
      box.innerHTML = `<div class="doc-tip">该类型（${esc(kind)}）无需参数，直接设置起止时间创建即可。</div>`;
    }
    // V4.28.9e 通用开关：是否必须会员参与（所有活动类型）——勾选后非会员一律不享受本活动
    // V5.0.3：「活动叠加」与「会员专享」同排展示
    box.insertAdjacentHTML('beforeend', `
      <div style="margin-top:10px;display:flex;align-items:center;gap:18px;font-size:13px;flex-wrap:wrap">
        <span style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="rMemOnly" ${curRules.memberOnly ? 'checked' : ''}>
          <label for="rMemOnly" style="font-weight:400;cursor:pointer">会员专享（勾选后非会员不享受本活动）</label></span>
        <span style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="rStack" ${curRules.isStackable ? 'checked' : ''}>
          <label for="rStack" style="font-weight:400;cursor:pointer" title="勾选后本活动可与其它促销/优惠券叠加；不勾选=排他（结算取最优单活动）">活动叠加</label></span>
      </div>`);
    mask.querySelector('#rMemOnly').onchange = () => { curRules.memberOnly = mask.querySelector('#rMemOnly').checked || undefined; };
  }

  /* ── 活动列表（查询 + 效果弹窗；V4.16.4 本地分页 + 范围列） ── */
  let promoPage = 1;
  async function list(keepPage) {
    if (!keepPage) promoPage = 1;
    const kw = encodeURIComponent(view.querySelector('#pKw').value.trim());
    const kind = encodeURIComponent(view.querySelector('#pKind').value);
    const status = encodeURIComponent(view.querySelector('#pStatus').value);
    const d = await must(get(`/promotions?size=200&keyword=${kw}&kind=${kind}&status=${status}`));
    const rows = d.items || [];
    const pg = paginate(rows, promoPage, 10);
    view.querySelector('#plist').innerHTML = rows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>ID</th><th>名称</th><th>类型</th><th>规则</th><th>范围</th><th>起止</th><th>状态</th><th></th></tr></thead>
      <tbody>${pg.slice.map((p, i) => `<tr>
        <td class="num seq">${(promoPage - 1) * 10 + i + 1}</td><td>${p.id}</td><td>${esc(p.name)}</td>
        <td><span class="tag ${kindTag(p.kind)}">${esc(p.kind)}</span></td>
        <td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(rulesSummaryWithMember(p.kind, p.rules ?? {}))}</td>
        <td>${scopeSummary(p.scope)}</td>
        <td class="muted">${(p.start_at || p.start_date || '').slice(0, 16).replace('T', ' ')} ~ ${(p.end_at || p.end_date || '').slice(0, 16).replace('T', ' ')}</td>
        <td><span class="tag ${p.status === '进行中' ? 'g' : p.status === '排期' ? 'y' : 'r'}">${esc(p.status)}</span></td>
        <td>
          ${p.status !== '进行中' ? `<button class="btn sm pri" data-start="${p.id}">启动</button>` : `<button class="btn sm warn" data-stop="${p.id}">停止</button>`}
          <button class="btn sm" data-eff="${p.id}">效果</button>
          ${chain.isHq && chain.enabled ? `<button class="btn sm" data-pub="${p.id}">投放门店</button>` : ''}
        </td></tr>`).join('')}</tbody></table>${pg.bar}` : '<div class="empty">无促销活动（可调整查询条件，或到「促销模板」创建）</div>';
    bindPager(view.querySelector('#plist'), p => { promoPage = p; list(true); });
    view.querySelectorAll('[data-start]').forEach(b => b.onclick = async () => {
      await must(post(`/promotions/${b.dataset.start}/start`), '已启动');
      await list();
    });
    view.querySelectorAll('[data-stop]').forEach(b => b.onclick = async () => {
      await must(post(`/promotions/${b.dataset.stop}/stop`), '已停止');
      await list();
    });
    view.querySelectorAll('[data-eff]').forEach(b => b.onclick = () => detail(b.dataset.eff));
    view.querySelectorAll('[data-pub]').forEach(b => b.onclick = () => openPublish(Number(b.dataset.pub)));
  }

  /** V5.0.0 P2-5 连锁促销投放弹窗（仅总部显示按钮） */
  async function openPublish(pid) {
    const stores = chain.stores.length ? chain.stores
      : await must(get('/hq/stores?size=200&status=1')).then(d => (d.items || []).filter(s => s.org_type !== 'hq')).catch(() => []);
    if (!stores.length) { toast('没有可投放的门店（单店模式无需投放）', false); return; }
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:999';
    mask.innerHTML = `
      <div style="background:var(--bg,#fff);border-radius:16px;padding:22px 24px;width:min(430px,92vw);max-height:80vh;overflow:auto;box-shadow:0 18px 60px rgba(0,0,0,.25)">
        <h3 style="margin:0 0 6px">📤 投放促销到门店</h3>
        <div class="muted" style="font-size:12px;margin-bottom:12px">门店在线后自动拉取生效；重复投放 = 更新门店侧内容。撤销投放请用「停止活动」后再次投放已停用状态。</div>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-bottom:8px"><input type="checkbox" id="pubAll"> 全选门店</label>
        <div id="pubList" style="display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow:auto;margin-bottom:14px">
          ${stores.map(s => `<label style="display:flex;gap:8px;align-items:center;font-size:13.5px"><input type="checkbox" class="pubPick" value="${s.id}"> 🏪 ${esc(s.name)}（${esc(s.store_no || s.id)}）</label>`).join('')}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" id="pubCancel">取消</button>
          <button class="btn pri" id="pubGo">确认投放</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    mask.querySelector('#pubAll').onchange = e => mask.querySelectorAll('.pubPick').forEach(c => { c.checked = e.target.checked; });
    mask.querySelector('#pubCancel').onclick = () => mask.remove();
    mask.querySelector('#pubGo').onclick = async () => {
      const ids = [...mask.querySelectorAll('.pubPick:checked')].map(c => Number(c.value));
      if (!ids.length) { toast('请选择要投放的门店', false); return; }
      const r = await must(post(`/hq/promotions/${pid}/publish`, { storeIds: ids }));
      toast(`已投放 ${r.published} 家门店（门店在线后自动生效）`);
      mask.remove();
    };
  }

  /** 活动效果弹窗 */
  async function detail(id) {
    const d = await must(get(`/promotions/${id}`));
    const p = d.promo, e2 = d.effect;
    openDetailModal(`活动效果`, `
      <div class="bar muted" style="margin-bottom:8px">活动：<b>${esc(p.name)}</b></div>
      <div class="grid kpis">
        <div class="kpi"><div class="t">命中订单数</div><div class="v">${e2.order_hits}</div></div>
        <div class="kpi"><div class="t">整单让利总额</div><div class="v">${money(e2.order_saved)}</div></div>
        <div class="kpi"><div class="t">行级命中行数</div><div class="v">${e2.line_hits}</div></div>
      </div>`, { width: 560 });
  }

  /* ── Tab 切换 ── */
  function switchTab(tab) {
    view.querySelectorAll('.segbtn[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    view.querySelector('#tabTpl').style.display = tab === 'tpl' ? '' : 'none';
    view.querySelector('#tabList').style.display = tab === 'list' ? '' : 'none';
  }
  view.querySelectorAll('.segbtn[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

  view.querySelector('#pGo').onclick = list;
  view.querySelector('#pKw').addEventListener('keydown', e => { if (e.key === 'Enter') list(); });

  const tp = await must(get('/promotions/templates')).catch(() => ({ items: [] }));
  tpls = tp.items || tp || [];
  drawCards();
  await list();
}
