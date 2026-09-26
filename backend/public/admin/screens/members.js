import { get, post, put, must, money, esc, dt, toast, API, unwrap } from '../api.js';
import { openDetailModal, exportRows } from '../common-ui.js';
import { anchorNav, segHtml, bindSeg } from '../ui-polish.js';   // V4.26.3：锚点导航 / 统一状态筛选

/** 会员管理（V4.14.0 M）：
 *  建档（手机号/姓名/生日 + 隐私协议点击可查看全文、可更新）→ 充值档位（已上移至列表之上）
 *  → 会员列表（每页 10 条 + 固定容器高度 + 双击行弹详情 + 重置密码）
 *  会员等级价格说明卡：读设置 member.level_price_mode / member.level_discount 人话解释当前联动。
 */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>会员建档 </h3>
      <div class="bar">
        <input id="mPhone" placeholder="手机号*" style="width:130px">
        <input id="mName" placeholder="姓名*" style="width:110px">
        <input id="mBirth" type="date" title="生日（生日触达/生日权益用）" style="width:150px">
        <label class="muted"><input type="checkbox" id="mPrivacy" checked>
          隐私协议 <a href="javascript:void 0" id="mPrivacyView" style="text-decoration:underline">点击查看全文</a></label>
        <button class="btn pri" id="mSave">建档</button>
      </div>
      <div class="doc-tip" style="margin:8px 18px 0">💡 会员也可在移动端（收银台「会员」区）由店长/管理员/有权限的收银员建档；会员 H5/小程序自助注册后自动建档并同步到本列表（渠道=H5）。</div>
    </div>

    <div class="card">
      <h3>充值档位 </h3>
      <div class="bar">
        <input id="pName" placeholder="档位名称*" style="width:120px">
        <input id="pPrincipal" type="number" step="0.01" placeholder="充(元)*" style="width:100px">
        <input id="pGift" type="number" step="0.01" placeholder="送(元)" style="width:100px">
        <button class="btn pri" id="pSave">新增档位</button>
      </div>
      <div id="pList" class="muted"></div>
      <div class="muted" style="margin-top:6px">档位供会员 H5 端选择发起充值单，收银台代收现金/扫码后入账（赠送不计分红权重）</div>
      <div class="doc-tip" id="lvMode" style="margin:10px 18px 0"></div>
    </div>

    <div class="card">
      <h3>会员列表 
        <input id="mKw" placeholder="手机号/卡号/姓名" style="margin-left:12px">
        <button class="btn" id="mGo">查询</button>
        <span class="muted" style="font-weight:400;margin-left:8px">每页 10 条 · 双击行弹会员详情</span></h3>
      <div id="mList" class="tbl-min" style="max-height:calc(10 * 40px + 42px);overflow:auto"></div>
      <div class="bar" style="justify-content:flex-end;margin-top:8px">
        <button class="btn sm" id="mPrev">‹ 上一页</button>
        <span class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px">共 <span id="mTotal">0</span> 人 · 第
          <input type="number" id="mJump" min="1" value="1" style="width:52px;text-align:center;padding:2px 4px"> /
          <span id="mPages">1</span> 页</span>
        <button class="btn sm" id="mNext">下一页 ›</button>
      </div>
    </div>

    <div class="card">
      <h3>断网挂账 
        <button class="btn sm" id="offGo" style="margin-left:12px">刷新</button></h3>
      <div id="offSum" class="muted" style="margin:6px 0"></div>
      <div id="offList" class="tbl-min" style="max-height:280px;overflow:auto"></div>
      <div class="doc-tip" style="margin:8px 18px 0">💡 连锁门店断网时用会员余额结账会先「挂账」，恢复联网后自动向总部清算扣款；若清算时会员余额不足（<b style="color:#c0392b">拒付</b>），请向会员收取现金/微信/支付宝后点「补付结清」——总部不再扣该会员余额，该笔转为现场收款。</div>
    </div>`;

  let page = 1, total = 0;
  const mSel = new Set();   // V4.14.9 勾选（重渲染间保持）

  /* ── 隐私协议：查看全文 / 更新（需 sys.settings 权限） ── */
  view.querySelector('#mPrivacyView').onclick = async () => {
    let text = '';
    try {
      const d = unwrap(await get('/settings/key/member.privacy_text'));
      text = typeof d.value === 'string' ? d.value.replace(/^"|"$/g, '') : String(d.value ?? '');
    } catch { text = '（协议文本未配置）'; }
    const canEdit = (API.user?.perms || []).includes('sys.settings');
    const { mask } = openDetailModal('📄 会员隐私协议', `
      <div style="white-space:pre-wrap;line-height:1.9;font-size:13.5px;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">${esc(text)}</div>
      ${canEdit ? `
      <div style="margin-top:10px">
        <label style="font-weight:700;font-size:13px">✏️ 更新协议文本（仅系统设置权限可见）</label>
        <textarea id="pvEdit" style="width:100%;min-height:90px;margin-top:6px;border:1px solid var(--line);border-radius:8px;padding:8px">${esc(text)}</textarea>
        <button class="btn pri" id="pvSave" style="margin-top:6px">💾 保存更新</button>
        <span class="muted" style="font-size:11.5px;margin-left:8px">更新留痕；已建档会员不受影响，新建档按新文本提示</span>
      </div>` : '<div class="muted" style="margin-top:8px;font-size:12px">如需更新协议文本，请联系有「系统设置」权限的管理员。</div>'}`, { width: 640 });
    const save = mask.querySelector('#pvSave');
    if (save) save.onclick = async () => {
      const v = mask.querySelector('#pvEdit').value.trim();
      if (!v) return toast('协议文本不能为空', false);
      await must(put('/settings/' + encodeURIComponent('member.privacy_text'), { value: v, reason: '更新会员隐私协议文本' }), '隐私协议已更新');
      mask.remove();
    };
  };

  /* ── 会员列表（每页 10 条，双击行弹详情） ── */
  let lastPage = 0;
  async function list() {
    if (page !== lastPage) { mSel.clear(); lastPage = page; }   // 翻页后勾选重置（导出仅针对本页所选）
    const kw = view.querySelector('#mKw').value.trim();
    const d = await must(get('/members?keyword=' + encodeURIComponent(kw) + '&size=10&page=' + page));
    const items = d.items || [];
    total = d.total ?? items.length;
    const pages = Math.max(Math.ceil(total / 10), 1);
    if (page > pages && items.length === 0) { page = pages; return list(); }   // V4.15.1 防御：越界空页自动回退末页重拉
    view.querySelector('#mList').innerHTML = items.length ? `
      <div class="bar" style="padding:4px 2px 0">
        <button class="btn sm" id="mBatExp" style="display:none">📥 导出所选 (<b id="mExpN">0</b>)</button>
        <span class="muted" style="font-size:12px" id="mSelN"></span>
      </div>
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="mChkAll" title="全选/取消全选本页"></th><th>卡号</th><th>姓名</th><th>手机号</th><th>等级</th><th class="num">余额</th>
        <th class="num">其中本金</th><th class="num">分红余额</th><th class="num">积分</th>
        <th>封顶</th><th>最后活跃</th><th></th></tr></thead>
      <tbody>${items.map(m => `<tr data-mid="${m.id}" style="cursor:pointer" title="双击查看会员详情">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-mchk="${m.id}" ${mSel.has(Number(m.id)) ? 'checked' : ''}></td>
        <td style="font-family:var(--mono)">${esc(m.card_no)}</td><td>${esc(m.name || '—')}</td><td>${esc(m.phone || '—')}</td>
        <td><span class="tag b">${esc(m.level_name || '普通会员')}</span></td>
        <td class="num"><b>${money(m.balance)}</b></td>
        <td class="num">${money(m.principal_balance ?? m.balance)}</td>
        <td class="num">${money(m.dividend_balance)}</td>
        <td class="num">${Number(m.points)}</td>
        <td>${m.dividend_capped ? '<span class="tag r">已封顶</span>' : '<span class="tag g">正常</span>'}</td>
        <td>${m.last_active_date ? String(m.last_active_date).slice(0, 10) : '—'}</td>
        <td style="white-space:nowrap">
          <button class="btn sm" data-id="${m.id}">详情/储值</button>
          <button class="btn sm" data-rpwd="${m.id}">🔑 重置密码</button>
        </td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">无会员</div>';
    // V4.14.9 勾选批量导出（CSV）
    const syncExp = () => {
      const btn = view.querySelector('#mBatExp');
      if (btn) {
        btn.style.display = mSel.size ? '' : 'none';
        view.querySelector('#mExpN').textContent = String(mSel.size);
        view.querySelector('#mSelN').textContent = mSel.size ? `已选 ${mSel.size} 人` : '';
      }
    };
    syncExp();
    view.querySelectorAll('[data-mchk]').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.mchk);
      if (cb.checked) mSel.add(id); else mSel.delete(id);
      syncExp();
    });
    const mChkAll = view.querySelector('#mChkAll');
    if (mChkAll) mChkAll.onchange = () => {
      items.forEach(m => { if (mChkAll.checked) mSel.add(Number(m.id)); else mSel.delete(Number(m.id)); });
      list();
    };
    const mBatExp = view.querySelector('#mBatExp');
    if (mBatExp) mBatExp.onclick = () => {
      const picked = items.filter(m => mSel.has(Number(m.id)));
      if (!picked.length) return;
      exportRows({ filename: '会员列表', format: 'xls',
        columns: [{ k: 'card_no', t: '卡号' }, { k: 'name', t: '姓名' }, { k: 'phone', t: '手机号' },
          { k: 'level_name', t: '等级' }, { k: 'balance', t: '余额' }, { k: 'principal_balance', t: '本金' },
          { k: 'dividend_balance', t: '分红余额' }, { k: 'points', t: '积分' }, { k: 'last_active_date', t: '最后活跃' }],
        rows: picked.map(m => ({ ...m, last_active_date: m.last_active_date ? String(m.last_active_date).slice(0, 10) : '' })) });
    };
    view.querySelector('#mPages').textContent = String(pages);
    view.querySelector('#mTotal').textContent = String(total);
    const mJump = view.querySelector('#mJump');
    mJump.max = String(pages); mJump.value = String(page);
    view.querySelectorAll('[data-id]').forEach(b => b.onclick = () => detail(b.dataset.id));
    view.querySelectorAll('[data-rpwd]').forEach(b => b.onclick = () => resetPwd(b.dataset.rpwd));
    view.querySelectorAll('tr[data-mid]').forEach(tr => tr.ondblclick = () => detail(tr.dataset.mid));
  }

  /** 管理员重置会员密码：生成随机临时密码，弹窗一次性展示 */
  async function resetPwd(id) {
    const m = await must(get(`/members/${id}`)).catch(() => null);
    const name = m?.member?.name || m?.name || `#${id}`;
    if (!confirm(`确认为会员「${name}」重置密码？将生成随机临时密码（旧密码与锁定状态同时清空）。`)) return;
    const d = await must(post(`/members/${id}/reset-password`), '');
    openDetailModal('🔑 密码已重置', `
      <div class="grid kpis" style="grid-template-columns:1fr">
        <div class="kpi"><div class="t">会员「${esc(name)}」的临时密码（仅此一次展示，请当场告知会员）</div>
          <div class="v" style="font-family:var(--mono);letter-spacing:2px">${esc(d.tempPassword)}</div></div>
      </div>
      <div class="doc-tip">💡 会员用 手机号 + 该临时密码 登录会员端后，请尽快在「我的」中自行修改密码；短密码连续错误 5 次会锁 30 分钟。</div>`, { width: 480 });
  }

  /* ── 会员详情抽屉（增加生日/密保状态展示） ── */
  async function detail(id) {
    const d = await must(get(`/members/${id}`));
    const m = d.member || d, acc = d.account || m.account || {};
    const o = d.orders || [], bf = d.balanceFlows || [], df = d.dividendFlows || [],
          cp = d.coupons || [], pf = d.pref || [], lg = d.logs || [];
    const secN = Array.isArray(m.security_questions) ? m.security_questions.length : 0;

    // 右侧抽屉（P1-2 原型 #11）：消费流水/充值记录/分红/优惠券/消费偏好 五页签
    const mask = document.createElement('div');
    mask.className = 'drawer-mask';
    mask.innerHTML = `
      <div class="drawer">
        <h3>会员详情：${esc(m.name || '—')}（${esc(m.card_no)}） </h3>
        <div class="bar muted">等级 <span class="tag b">${esc(m.level_name || '普通会员')}</span> · 积分 ${Number(m.points)}
          · 注册 ${dt(m.created_at)} · 渠道 ${esc(m.register_channel || '到店')}
          · 生日 ${m.birthday ? String(m.birthday).slice(0, 10) : '未填'}
          · 密保 ${secN ? `<span class="tag g">${secN} 问</span>` : '<span class="tag y">未设置</span>'}
          ${m.locked_until && new Date(m.locked_until) > new Date() ? ' · <span class="tag r">登录锁定中</span>' : ''}</div>
        <div class="grid kpis" style="grid-template-columns:repeat(4,1fr)">
          <div class="kpi"><div class="t">余额</div><div class="v">${money(acc.balance)}</div></div>
          <div class="kpi"><div class="t">本金余额</div><div class="v">${money(acc.principal_balance)}</div></div>
          <div class="kpi"><div class="t">赠送余额</div><div class="v">${money(acc.gift_balance)}</div></div>
          <div class="kpi"><div class="t">分红余额</div><div class="v" style="color:var(--warn)">${money(acc.dividend_balance)}</div></div>
        </div>
        <div class="bar" style="margin-top:10px">
          <select id="rPlan" style="width:250px"></select>
          <input id="rAmt" type="number" step="0.01" placeholder="储值本金" style="width:120px">
          <input id="rGift" type="number" step="0.01" placeholder="赠送(可选)" style="width:110px">
          <button class="btn pri" id="rGo">储值</button>
          <span class="muted">选档位自动按「充X送Y」入账（服务端计算防篡改）；赠送不计分红权重</span>
        </div>
        <div id="mkTabs" style="margin:14px 0"></div>
        <div id="mkBody"></div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    const body = mask.querySelector('#mkBody');

    const renderOrders = () => {
      body.innerHTML = o.length ? `
        <table><thead><tr><th>单号</th><th>渠道</th><th class="num">件数</th><th class="num">应收</th><th class="num">毛利</th><th class="num">积分</th><th>时间</th></tr></thead>
        <tbody>${o.map(x => `<tr><td>${esc(x.order_no)}</td><td>${esc(x.channel)}</td>
          <td class="num">${x.item_count}</td><td class="num"><b>${money(x.payable_amount)}</b></td>
          <td class="num">${money(x.profit_amount)}</td><td class="num">${x.points_earned}</td>
          <td>${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">暂无消费记录</div>';
    };
    const renderBal = () => {
      body.innerHTML = bf.length ? `
        <table><thead><tr><th>方向</th><th class="num">金额</th><th class="num">本金/赠送</th><th>类型</th><th class="num">余额快照</th><th>备注</th><th>时间</th></tr></thead>
        <tbody>${bf.map(x => `<tr>
          <td>${x.direction === '入' ? '<span class="tag g">入</span>' : '<span class="tag r">出</span>'}</td>
          <td class="num">${money(x.amount)}</td>
          <td class="num muted">${Number(x.principal_part) || ''} / ${Number(x.gift_part) || ''}</td>
          <td>${esc(x.biz_type)}</td><td class="num">${money(x.balance_after)}</td>
          <td class="muted">${esc(x.remark || '—')}</td><td>${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">暂无储值流水</div>';
    };
    const renderDiv = () => {
      const tag = { '计提': '<span class="tag b">计提</span>', '抵扣': '<span class="tag g">抵扣</span>',
                    '失效回冲': '<span class="tag y">失效回冲</span>' };
      body.innerHTML = df.length ? `
        <table><thead><tr><th>类型</th><th class="num">金额</th><th class="num">权重快照</th><th>失效日</th><th>备注</th><th>时间</th></tr></thead>
        <tbody>${df.map(x => `<tr>
          <td>${tag[x.record_type] || esc(x.record_type)}</td><td class="num">${money(x.amount)}</td>
          <td class="num">${Number(x.weight_snapshot) || '—'}</td>
          <td>${x.expire_at ? String(x.expire_at).slice(0, 10) : '—'}</td>
          <td class="muted">${esc(x.remark || '—')}</td><td>${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">暂无分红记录</div>';
    };
    const renderCoupon = () => {
      body.innerHTML = cp.length ? `
        <table><thead><tr><th>券</th><th>类型</th><th class="num">门槛/面额</th><th>券码</th><th>状态</th><th>有效期至</th><th>使用时间</th></tr></thead>
        <tbody>${cp.map(x => `<tr>
          <td>${esc(x.name)}</td><td>${esc(x.type)}</td>
          <td class="num">${x.type === '次卡'
            ? `已用 ${Number(x.times_used ?? 0)} / 共 ${Number(x.discount)} 次`
            : Number(x.threshold) ? `满${Number(x.threshold)} 减 ${Number(x.discount)}` : `直减 ${Number(x.discount)}`}</td>
          <td class="mono">${esc(x.code || '—')}</td>
          <td><span class="tag ${x.status === '未使用' ? 'g' : x.status === '已使用' ? 'b' : 'r'}">${esc(x.status)}</span></td>
          <td>${String(x.expire_at).slice(0, 10)}</td><td>${x.used_at ? dt(x.used_at) : '—'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">暂无优惠券</div>';
    };
    const renderPref = () => {
      const maxS = Math.max(...pf.map(p => Number(p.spend)), 0);
      body.innerHTML = pf.length ? pf.map(p => `
        <div style="margin-bottom:10px">
          <div class="bar" style="justify-content:space-between"><b>${esc(p.category_name)}</b><span class="muted">${p.order_count} 单 · ${money(p.spend)}</span></div>
          <div style="height:8px;border-radius:99px;background:var(--line);overflow:hidden">
            <div style="height:100%;width:${maxS ? (Number(p.spend) / maxS * 100).toFixed(1) : 0}%;background:var(--pri)"></div>
          </div>
        </div>`).join('') : '<div class="empty">暂无消费偏好数据</div>';
    };
    const renderLog = () => {
      const label = { 'member.register': '建档', 'member.recharge': '储值', 'member.recharge.plan.create': '新增充值档位',
                      'member.recharge.plan.status': '档位启停', 'member.levels.sync': '等级同步', 'member.unlock': '解锁/恢复',
                      'member.password.reset': '重置密码' };
      const summarize = x => {
        const dtl = x.detail && typeof x.detail === 'object' ? x.detail : (() => { try { return JSON.parse(x.detail || '{}'); } catch { return {}; } })();
        const parts = [];
        if (dtl.amount !== undefined) parts.push(`金额 ${money(dtl.amount)}`);
        if (dtl.principal !== undefined) parts.push(`本金 ${Number(dtl.principal)}`);
        if (dtl.gift !== undefined) parts.push(`赠送 ${Number(dtl.gift)}`);
        if (dtl.cardNo) parts.push(`卡号 ${dtl.cardNo}`);
        if (dtl.changed !== undefined) parts.push(`变更 ${dtl.changed}`);
        return parts.join(' · ');
      };
      body.innerHTML = lg.length ? `
        <table><thead><tr><th>操作</th><th>模块</th><th>操作人</th><th>摘要</th><th>时间</th></tr></thead>
        <tbody>${lg.map(x => `<tr>
          <td><span class="tag b">${esc(label[x.action] || x.action)}</span></td>
          <td>${esc(x.module)}</td><td>${esc(x.operator_name)}</td>
          <td class="muted">${esc(summarize(x) || '—')}</td><td>${dt(x.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">暂无操作日志</div>';
    };
    // V4.16.3 AI 画像：读缓存；无则可一键生成（Ollama 开启为人话画像，失败回落规则文案）
    const renderPort = async () => {
      body.innerHTML = '<div class="empty">画像加载中…</div>';
      let p = null;
      try { p = await must(get(`/brain/member-portraits/${id}`)); } catch { p = null; }
      if (!p) {
        body.innerHTML = `
          <div class="empty">尚未生成该会员的 AI 画像</div>
          <div class="bar"><button class="btn pri" id="portGen">🤖 生成会员画像（近180天消费 TOP 榜单内）</button>
          <span class="muted">按消费额取 TOP N 逐人生成；Ollama 开启时为一人一段人话画像</span></div>`;
        const btn = body.querySelector('#portGen');
        if (btn) btn.onclick = async () => {
          btn.disabled = true; btn.textContent = '⏳ 生成中…（含大模型逐人生成，请稍候）';
          try { await must(post('/brain/member-portraits')); await renderPort(); }
          catch (e) { btn.disabled = false; btn.textContent = '🤖 生成失败，点击重试'; }
        };
        return;
      }
      const kp = p.payload || p;
      body.innerHTML = `
        <div class="bar" style="justify-content:space-between">
          <span><span class="tag b">${esc(p.engine === 'ollama' ? '大模型画像' : '规则画像')}</span>
            生成于 ${dt(p.generated_at)}</span>
          <button class="btn ghost" id="portGen">🔄 重新生成</button></div>
        <div style="background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:12px;line-height:1.8;white-space:pre-wrap">${esc(p.text || '')}</div>
        <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin-top:10px">
          <div class="kpi"><div class="t">近180天消费</div><div class="v">${Number(kp.orders ?? 0)} 单</div></div>
          <div class="kpi"><div class="t">消费金额</div><div class="v">${money(kp.spend ?? 0)}</div></div>
          <div class="kpi"><div class="t">客单价</div><div class="v">${money(kp.avgTicket ?? 0)}</div></div>
          <div class="kpi"><div class="t">距上次消费</div><div class="v" style="color:${Number(kp.daysIdle) >= 30 ? 'var(--warn)' : 'inherit'}">${Number(kp.daysIdle ?? 0)} 天</div></div>
        </div>
        <div class="bar" style="margin-top:8px;flex-wrap:wrap">
          <span class="tag g">常买 ${(kp.favItems || []).map(f => esc(f.name)).join(' / ') || '—'}</span>
          <span class="tag b">偏好品类 ${(kp.favCats || []).map(f => esc(f.cat)).join(' / ') || '—'}</span>
          <span class="tag y">习惯${esc(kp.favHour || '—')}到店</span>
          <span class="tag ${kp.churnRisk ? 'r' : 'g'}">${kp.churnRisk ? '⚠️ 流失前兆，建议唤醒' : '消费' + esc(kp.trend || '平稳')}</span>
        </div>`;
      const btn2 = body.querySelector('#portGen');
      if (btn2) btn2.onclick = async () => {
        btn2.disabled = true; btn2.textContent = '⏳ 生成中…';
        try { await must(post('/brain/member-portraits')); await renderPort(); }
        catch { btn2.disabled = false; btn2.textContent = '🔄 重新生成'; }
      };
    };
    const tabs = { orders: renderOrders, bal: renderBal, div: renderDiv, coupon: renderCoupon, pref: renderPref, port: () => renderPort(), log: renderLog };
    // V4.26.3：详情分区切换改用统一 .seg（原来 7 个 btn.tabbtn，视觉重量过大且选中态靠手工加 class）
    const TABS = [
      { k: 'orders', t: '🧾 消费流水' }, { k: 'bal', t: '💳 充值记录' }, { k: 'div', t: '💰 分红' },
      { k: 'coupon', t: '🎟️ 优惠券' }, { k: 'pref', t: '📊 消费偏好' }, { k: 'port', t: '🤖 AI画像' },
      { k: 'log', t: '🔍 操作日志' },
    ];
    const segBox = mask.querySelector('#mkTabs');
    const drawTabs = cur => {
      segBox.innerHTML = segHtml(TABS, cur);
      bindSeg(segBox, k => { tabs[k](); drawTabs(k); });
    };
    drawTabs('orders');
    renderOrders();   // 默认落在「消费流水」

    // 充值档位下拉（启用档位；选档=服务端按档入账；自定义=手输本金/赠送）
    const sel = mask.querySelector('#rPlan');
    const amtI = mask.querySelector('#rAmt'), giftI = mask.querySelector('#rGift');
    const pd = await get('/members/recharge/plans/all').catch(() => null);
    const planItems = (pd?.data || pd || []).filter(p => p.status === '启用');
    sel.innerHTML = '<option value="">自定义金额…</option>' +
      planItems.map(p => `<option value="${p.id}">${esc(p.name)}：充${money(p.principal)} 送${money(p.gift)}</option>`).join('');
    const syncInputs = () => {
      const custom = !sel.value;
      amtI.style.display = custom ? '' : 'none';
      giftI.style.display = custom ? '' : 'none';
    };
    sel.onchange = syncInputs; syncInputs();
    mask.querySelector('#rGo').onclick = async () => {
      let body;
      if (sel.value) body = { planId: Number(sel.value) };
      else {
        const amt = Number(amtI.value);
        if (!(amt > 0)) return toast('储值金额必填', false);
        body = { principal: amt, gift: Number(giftI.value) || undefined };
      }
      const r = await must(post(`/members/${id}/recharges`, body), '储值成功');
      const lv = r?.level || r?.data?.level;
      if (lv && lv.name) toast(`储值成功，当前等级：${lv.name}`);
      await list(); close(); await detail(id);
    };
  }

  /* ── 充值档位 ── */
  async function plans() {
    const d = await get('/members/recharge/plans/all').catch(() => null);
    const items = d?.data || d || [];
    const box = view.querySelector('#pList');
    box.innerHTML = Array.isArray(items) && items.length ? `
      <table><thead><tr><th>名称</th><th class="num">充</th><th class="num">送</th><th>状态</th><th></th></tr></thead>
      <tbody>${items.map(p => `<tr>
        <td>${esc(p.name)}</td><td class="num">${money(p.principal)}</td><td class="num">${money(p.gift)}</td>
        <td>${p.status === '启用' ? '<span class="tag g">启用</span>' : '<span class="tag r">停用</span>'}</td>
        <td><button class="btn sm" data-pid="${p.id}" data-to="${p.status === '启用' ? '停用' : '启用'}">${p.status === '启用' ? '停用' : '启用'}</button></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无档位</div>';
    box.querySelectorAll('[data-pid]').forEach(b => b.onclick = async () => {
      await must(post(`/members/recharge-plans/${b.dataset.pid}/status`, { status: b.dataset.to }), '已更新');
      await plans();
    });
  }
  view.querySelector('#pSave').onclick = async () => {
    const name = view.querySelector('#pName').value.trim();
    const principal = Number(view.querySelector('#pPrincipal').value);
    const gift = Number(view.querySelector('#pGift').value) || 0;
    if (!name || !(principal > 0)) return toast('名称与充值金额必填', false);
    await must(post('/members/recharge-plans', { name, principal, gift }), '档位已创建');
    view.querySelector('#pName').value = ''; view.querySelector('#pPrincipal').value = ''; view.querySelector('#pGift').value = '';
    await plans();
  };

  /* ── 会员等级价格说明（读当前设置，人话化） ── */
  async function drawLvMode() {
    let mode = '商品档案会员价优先', lvOn = false;
    try {
      const a = unwrap(await get('/settings/key/member.level_price_mode'));
      mode = typeof a.value === 'string' ? a.value.replace(/^"|"$/g, '') : String(a.value ?? mode);
    } catch { /* 未配置用默认 */ }
    try {
      const b = unwrap(await get('/settings/key/member.level_discount'));
      lvOn = Number(String(b.value).replace(/[^0-9.]/g, '')) === 1;
    } catch { /* ignore */ }
    view.querySelector('#lvMode').innerHTML = `💡 <b>会员等级价格怎么算？（当前模式：${esc(mode)}）</b><br>
      ① 商品档案里单独设了「会员价」的商品 → 按商品会员价（优先级最高，不受档位影响）；<br>
      ② 未设会员价的商品 → ${lvOn ? '按会员等级折扣（银卡/金卡/钻石在「会员等级」中配置折扣率）' : '当前等级折扣开关为关，按零售价'}；<br>
      ③ 充值档位只决定「充多少送多少」，不直接改变商品价格；等级由累计余额自动升降。如需改为「按充值档位定价格档」，需在系统设置调整模式并配套等级折扣方案。`;
  }

  view.querySelector('#mGo').onclick = () => { page = 1; list(); };
  view.querySelector('#mKw').addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; list(); } });
  view.querySelector('#mPrev').onclick = () => { if (page > 1) { page--; list(); } };
  // V4.15.1：下一页先按当前 total 算出总页数再翻——原来 page++ 无上界，翻过界后拉到空页白屏且上一页被钳回第 1 页（形同卡死）
  view.querySelector('#mNext').onclick = () => {
    const pages = Math.max(Math.ceil((total || 0) / 10), 1);
    if (page < pages) { page++; list(); }
  };
  // V4.14.9 手输页码跳页
  const mJumpGo = () => {
    const inp = view.querySelector('#mJump');
    const pages = Math.max(Math.ceil(total / 10), 1);
    page = Math.min(Math.max(1, Number(inp.value) || 1), pages);
    list();
  };
  view.querySelector('#mJump').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); mJumpGo(); } });
  view.querySelector('#mJump').addEventListener('change', mJumpGo);

  view.querySelector('#mSave').onclick = async () => {
    const phone = view.querySelector('#mPhone').value.trim();
    const name = view.querySelector('#mName').value.trim();
    const birthday = view.querySelector('#mBirth').value || undefined;
    if (!phone || !name) return toast('手机号与姓名必填', false);
    if (!view.querySelector('#mPrivacy').checked) return toast('请勾选同意隐私协议（点击可查看全文）', false);
    await must(post('/members', { phone, name, birthday, privacyAgreed: true, registerChannel: '到店' }), '建档成功');
    view.querySelector('#mPhone').value = ''; view.querySelector('#mName').value = ''; view.querySelector('#mBirth').value = '';
    page = 1;
    await list();
  };

  /* ── P2：断网挂账台账 + 拒付补付结清（现金/微信/支付宝） ── */
  const offSum = view.querySelector('#offSum'), offList = view.querySelector('#offList');
  async function drawOff() {
    try {
      const d = unwrap(await get('/member-offline-credits?days=30'));
      offSum.innerHTML = `近 30 天：待清算 <b>${d.sum.pendingCnt}</b> 笔 / ¥${money(d.sum.pendingAmt)}`
        + ` · 拒付待补付 <b style="color:#c0392b">${d.sum.rejectedCnt}</b> 笔 / ¥${money(d.sum.rejectedAmt)}`;
      offList.innerHTML = !d.items.length
        ? '<div class="muted" style="padding:8px">无挂账记录（断网余额支付后才会产生）</div>'
        : `<table class="tbl"><thead><tr><th>时间</th><th>卡号</th><th>会员</th><th>订单号</th><th>金额</th><th>状态</th><th>补付通道</th><th>操作</th></tr></thead><tbody>`
        + d.items.map(r => `<tr>
            <td>${dt(r.created_at)}</td><td>${esc(r.card_no || '')}</td>
            <td>${esc(r.member_name || '')}</td><td>${esc(r.ref_no || '')}</td>
            <td>¥${money(r.amount)}</td>
            <td>${r.status === 'pending' ? '待清算' : r.status === 'settled' ? '已结清' : '<b style="color:#c0392b">拒付</b>'}</td>
            <td>${esc(r.settle_channel || '—')}</td>
            <td>${r.status === 'rejected' ? `<button class="btn sm" data-off="${r.id}">补付结清</button>` : '—'}</td>
          </tr>`).join('') + '</tbody></table>';
      offList.querySelectorAll('[data-off]').forEach(b => {
        b.onclick = async () => {
          const ch = prompt('补付通道（现金 / 微信 / 支付宝）：', '现金');
          if (!ch || !['现金', '微信', '支付宝'].includes(ch.trim())) return toast('通道须为 现金/微信/支付宝', false);
          await must(post('/member-offline-credits/pay', { id: Number(b.dataset.off), channel: ch.trim() }), '补付结清成功');
          await drawOff();
        };
      });
    } catch {
      offSum.textContent = '';
      offList.innerHTML = '<div class="muted" style="padding:8px">无查看权限或本店未启用断网挂账</div>';
    }
  }
  view.querySelector('#offGo').onclick = drawOff;

  await plans();
  await drawLvMode();
  await list();
  await drawOff();

  /* V4.26.3 锚点导航：会员建档 / 充值档位 / 会员列表 三节，页面一长就靠顶部胶囊条跳。
     卡片标题 <h3> 里混着 <span class="api">接口说明，取首个子文本节点就是纯名称。 */
  anchorNav(view, {
    item: '.card',
    label: el => (el.querySelector('h3')?.firstChild?.textContent || '').trim() || el.textContent.trim(),
    refresh: true,
  });
}
