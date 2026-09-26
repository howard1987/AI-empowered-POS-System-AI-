import { get, post, must, esc, dt, toast, del } from '../api.js';
import { confirmBox, promptBox } from '../ui.js';
import { openCollectPad } from './signpad.js';

/** 员工与权限（V4.8.21）：员工弹窗创建（工号留空自动 SY/CN/DZ/EM 前缀）+ 自定义角色（权限点勾选矩阵） */
export async function render(view) {
  let roles = [];
  view.innerHTML = `
    <div class="card">
      <h3>🔑 我的账号安全 </h3>
      <div class="bar" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        <div class="fld"><label>当前密码</label><input id="secOld" type="password" style="width:150px"></div>
        <div class="fld"><label>新密码（≥6位）</label><input id="secNew" type="password" style="width:150px"></div>
        <button class="btn pri" id="secPwd">修改密码</button>
        <span style="width:24px"></span>
        <button class="btn" id="secQ">🛡️ 设置密保问题（3 问 3 答）</button>
      </div>
      <div class="doc-tip">💡 密保问题用于移动端登录页「忘记密码」自助找回；答案哈希存储不落明文。</div>
    </div>
    <div class="card">
      <div class="doc-tools">
        <span style="font-weight:700;font-size:14.5px">员工列表</span>
        <span class="muted" style="font-size:11.5px">工号规则：收银员 SY0001 · 仓管 CN0001 · 店长 DZ0001 · 通用 EM0001（创建时留空自动生成）</span>
        <span style="margin-left:auto;display:flex;gap:8px">
          <button class="btn" id="rNewRole">🎭 新建角色</button>
          <button class="btn pri" id="eNew">➕ 新建员工</button>
        </span>
      </div>
      <div id="eList"></div>
    </div>
    <div class="card">
      <h3>角色与权限点 </h3>
      <div id="rList"></div>
      <div id="pList" class="mt8"></div>
    </div>

    <div class="modal-mask" id="empModal" style="display:none">
      <div class="modal">
        <h3>➕ 新建员工 </h3>
        <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld"><label>工号（留空自动生成）</label><input id="mEmpNo" placeholder="如 SY0002 / 留空按角色生成"></div>
          <div class="fld"><label class="req">姓名</label><input id="mName"></div>
          <div class="fld"><label>手机号</label><input id="mPhone"></div>
          <div class="fld"><label class="req">初始密码（≥6位）</label><input id="mPwd" type="password"></div>
          <div class="fld" style="grid-column:1/-1"><label>角色（决定权限与工号前缀）</label>
            <select id="mRole" style="width:100%"><option value="">不绑角色（EM 前缀）</option></select></div>
        </div>
        <div class="doc-tip">💡 工号前缀按第一个角色自动推断：收银员→SY · 仓管→CN · 店长→DZ · 其他→EM。</div>
        <div class="doc-foot">
          <button class="btn" id="mCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="mSave">💾 创建员工</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="roleModal" style="display:none">
      <div class="modal">
        <h3>🎭 新建角色 </h3>
        <div class="bar" style="margin-bottom:10px">
          <input id="rlName" placeholder="角色名称*" style="width:160px">
          <input id="rlRemark" placeholder="备注（选填）" style="flex:1">
        </div>
        <div class="doc-tip">💡 勾选该角色拥有的权限点（三权分立底线权限不可绕过，仅超级管理员可配）</div>
        <div id="rlPerms" style="max-height:300px;overflow:auto;border:1px dashed var(--line);border-radius:10px;padding:12px 14px"></div>
        <div class="doc-foot">
          <button class="btn" id="rlCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="rlSave">💾 创建角色</button>
        </div>
      </div>
    </div>`;

  /* ── 账号安全：本人修改密码 / 设置密保（V4.13.9 B8） ── */
  view.querySelector('#secPwd').onclick = async () => {
    const o = view.querySelector('#secOld').value, n = view.querySelector('#secNew').value;
    if (!o || !n) return toast('请填写当前密码与新密码', false);
    if (n.length < 6) return toast('新密码至少 6 位', false);
    await must(post('/auth/change-password', { oldPassword: o, newPassword: n }), '密码已修改');
    view.querySelector('#secOld').value = ''; view.querySelector('#secNew').value = '';
  };
  // V4.14.2：密保设置弹窗样式化（原 prompt 链）+ 常用问题下拉（末项自定义）
  const SQ_PRESETS = ['您的母亲姓氏是？', '您的第一所学校是？', '您宠物的名字是？', '您出生的城市是？', '您最喜欢的食物是？', '自定义问题…'];
  view.querySelector('#secQ').onclick = () => {
    const m = document.createElement('div');
    m.className = 'modal-mask';
    m.innerHTML = `<div class="modal">
      <h3>🛡️ 设置密保问题（3 问 3 答）</h3>
      <div class="doc-head" style="border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
        <div class="fld" style="grid-column:1/-1"><label class="req">当前密码（验证身份）</label><input id="sqPwd" type="password"></div>
        ${[1, 2, 3].map(i => `
        <div class="fld"><label class="req">密保问题 ${i}/3</label>
          <select id="sqQ${i}">${SQ_PRESETS.map(q => `<option>${q}</option>`).join('')}</select>
          <input id="sqQC${i}" placeholder="输入自定义问题" style="display:none;margin-top:6px"></div>
        <div class="fld"><label class="req">答案 ${i}</label><input id="sqA${i}" placeholder="答案（哈希存储）"></div>`).join('')}
      </div>
      <div class="doc-tip">💡 密保用于移动端登录页「忘记密码」自助找回；答案哈希存储不落明文。</div>
      <div class="doc-foot">
        <button class="btn" id="sqCancel">取消</button>
        <span style="flex:1"></span>
        <button class="btn pri" id="sqSave">💾 保存密保</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    for (let i = 1; i <= 3; i++) {
      m.querySelector(`#sqQ${i}`).onchange = () => {
        m.querySelector(`#sqQC${i}`).style.display = m.querySelector(`#sqQ${i}`).value === '自定义问题…' ? '' : 'none';
      };
    }
    m.querySelector('#sqCancel').onclick = () => m.remove();
    m.querySelector('#sqSave').onclick = async () => {
      const cur = m.querySelector('#sqPwd').value;
      if (!cur) return toast('请输入当前密码验证身份', false);
      const qs = [];
      for (let i = 1; i <= 3; i++) {
        let q = m.querySelector(`#sqQ${i}`).value;
        if (q === '自定义问题…') q = m.querySelector(`#sqQC${i}`).value.trim();
        const a = m.querySelector(`#sqA${i}`).value.trim();
        if (!q || !a) return toast('问题与答案均必填', false);
        qs.push({ question: q, answer: a });
      }
      await must(post('/auth/security-questions', { currentPassword: cur, questions: qs }), '密保问题已保存');
      m.remove();
    };
  };

  /* ── 员工弹窗 ── */
  const empModal = view.querySelector('#empModal');
  const roleSel = view.querySelector('#mRole');
  view.querySelector('#eNew').onclick = () => {
    for (const id of ['mEmpNo', 'mName', 'mPhone', 'mPwd']) view.querySelector('#' + id).value = '';
    empModal.style.display = 'flex';
    view.querySelector('#mName').focus();
  };
  view.querySelector('#mCancel').onclick = () => { empModal.style.display = 'none'; };
  view.querySelector('#mSave').onclick = async () => {
    const name = view.querySelector('#mName').value.trim();
    const pwd = view.querySelector('#mPwd').value;
    if (!name || pwd.length < 6) return toast('姓名必填，密码≥6位', false);
    const created = await must(post('/auth/employees', {
      empNo: view.querySelector('#mEmpNo').value.trim() || undefined,
      name, phone: view.querySelector('#mPhone').value.trim() || undefined,
      password: pwd,
      roleIds: roleSel.value ? [Number(roleSel.value)] : [],
    }), '员工已创建');
    if (created?.empNo) toast(`工号：${created.empNo}`);
    empModal.style.display = 'none';
    await emps();
  };

  /* ── 角色弹窗（权限勾选矩阵） ── */
  const roleModal = view.querySelector('#roleModal');
  view.querySelector('#rNewRole').onclick = () => {
    view.querySelector('#rlName').value = '';
    view.querySelector('#rlRemark').value = '';
    roleModal.style.display = 'flex';
  };
  view.querySelector('#rlCancel').onclick = () => { roleModal.style.display = 'none'; };
  view.querySelector('#rlSave').onclick = async () => {
    const name = view.querySelector('#rlName').value.trim();
    if (!name) return toast('角色名称必填', false);
    const perms = [...view.querySelectorAll('[data-perm]:checked')].map(c => c.dataset.perm);
    await must(post('/auth/roles', { name, perms,
      remark: view.querySelector('#rlRemark').value.trim() || undefined }),
      `角色已创建（${perms.length} 个权限点）`);
    roleModal.style.display = 'none';
    await roleList(); await emps();
  };

  async function emps() {
    const rows = await must(get('/auth/employees'));
    const arr = rows.items || rows || [];
    const empSel = window.__empSel || (window.__empSel = new Set());   // V4.14.9 批量勾选（页面缓存内保持）
    view.querySelector('#eList').innerHTML = `
      <div class="bar" style="padding:4px 2px 0">
        <button class="btn sm" id="eBatOff" style="display:none">⏸ 批量停用 (<b>0</b>)</button>
        <button class="btn sm pri" id="eBatOn" style="display:none">▶ 批量复职 (<b>0</b>)</button>
        <span class="muted" style="font-size:12px" id="eSelN"></span>
      </div>
      ${arr.length ? `
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="eChkAll" title="全选/取消全选（ADMIN 除外）"></th><th>工号</th><th>姓名</th><th>手机</th><th>角色</th><th>状态</th><th>授权码</th><th>最近登录</th><th></th></tr></thead>
      <tbody>${arr.map(e => `<tr>
        <td onclick="event.stopPropagation()">${e.empNo !== 'ADMIN' ? `<input type="checkbox" data-echk="${e.id}" ${empSel.has(Number(e.id)) ? 'checked' : ''}>` : ''}</td>
        <td><b>${esc(e.empNo)}</b></td><td>${esc(e.name)}</td><td>${esc(e.phone || '—')}</td>
        <td>${(e.roles || []).map(r => `<span class="tag b">${esc(r.name)}</span>`).join(' ') || '<span class="muted">无</span>'}</td>
        <td><span class="tag ${e.status === '在职' ? 'g' : 'r'}">${esc(e.status)}</span></td>
        <td>${e.authCodeSet ? '<span class="tag g" title="收银员改价/打折时，该工号可现场授权">已设置</span>' : '<span class="muted" title="未设置：该工号无法在收银台审批改价/打折">未设置</span>'}</td>
        <td class="muted">${e.lastLoginAt ? dt(e.lastLoginAt) : '从未'}</td>
        <td>${e.empNo !== 'ADMIN' ? `<button class="btn sm ${e.status === '在职' ? 'warn' : 'pri'}" data-t="${e.id}" data-s="${e.status === '在职' ? '停用' : '在职'}">${e.status === '在职' ? '停用' : '复职'}</button>` : ''}
            <button class="btn sm" data-rp="${e.id}" data-no="${esc(e.empNo)}" data-nm="${esc(e.name)}">重置密码</button>
            <button class="btn sm" data-ac="${e.id}" data-no="${esc(e.empNo)}" data-nm="${esc(e.name)}" data-set="${e.authCodeSet ? 1 : 0}" title="店长授权码：收银员改价/打折时的现场授权凭据（独立于登录密码，4~8 位数字）">授权码</button>
            <button class="btn sm" data-sig="${e.id}" data-nm="${esc(e.name)}" title="采集该员工电子签名，存入签字样本（对账/单据确认可自动带出）">✍️ 签名</button>${e.status !== '在职' && e.empNo !== 'ADMIN' ? `<button class="btn sm" data-del="${e.id}" data-no="${esc(e.empNo)}" data-nm="${esc(e.name)}" style="color:#c0392b;border-color:#e6b0aa" title="仅可删除无任何业务记录的停用账号；有流水的员工请保留停用">删除</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无员工</div>'}`;
    // V4.14.9 批量停用/复职
    const syncBat = () => {
      const n = empSel.size;
      const off = view.querySelector('#eBatOff'), on = view.querySelector('#eBatOn');
      if (off) { off.style.display = n ? '' : 'none'; off.querySelector('b').textContent = String(n); }
      if (on) { on.style.display = n ? '' : 'none'; on.querySelector('b').textContent = String(n); }
      const sn = view.querySelector('#eSelN'); if (sn) sn.textContent = n ? `已选 ${n} 人` : '';
    };
    syncBat();
    view.querySelectorAll('[data-echk]').forEach(cb => cb.onchange = () => {
      const id = Number(cb.dataset.echk);
      if (cb.checked) empSel.add(id); else empSel.delete(id);
      syncBat();
    });
    const chkAll = view.querySelector('#eChkAll');
    if (chkAll) chkAll.onchange = () => {
      arr.forEach(e => { if (e.empNo !== 'ADMIN') { if (chkAll.checked) empSel.add(Number(e.id)); else empSel.delete(Number(e.id)); } });
      emps();
    };
    const batSetStatus = async (status) => {
      const ids = [...empSel];
      if (!ids.length) return;
      const ok = await confirmBox({
        title: status === '停用' ? '⏸ 批量停用确认' : '▶ 批量复职确认',
        okText: status === '停用' ? '确认停用' : '确认复职',
        okClass: status === '停用' ? 'danger' : 'pri',
        html: `即将对 <b>${ids.length}</b> 名员工执行「${status}」${status === '停用' ? '，停用后立即<b>禁止登录</b>收银台/移动端' : '，恢复其登录权限'}。<br><span class="muted">单个员工的登录状态可在列表逐行操作。</span>`,
      });
      if (!ok) return;
      let okN = 0; const errs = [];
      for (const id of ids) {
        try { await must(post(`/auth/employees/${id}/status`, { status })); okN++; empSel.delete(id); }
        catch (e) { errs.push(e.msg || e.message || '未知错误'); }
      }
      toast(errs.length ? `成功 ${okN} 人，${errs.length} 人失败：${errs[0]}` : `已${status} ${okN} 名员工`, !errs.length);
      await emps();
    };
    const bOff = view.querySelector('#eBatOff'); if (bOff) bOff.onclick = () => batSetStatus('停用');
    const bOn = view.querySelector('#eBatOn'); if (bOn) bOn.onclick = () => batSetStatus('在职');
    view.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
      // V4.14.3 RV-10：敏感操作（risk_level=2）二次确认——停用即禁止登录
      if (b.dataset.s === '停用') {
        const ok = await confirmBox({ title: '敏感操作确认', okText: '确认停用', okClass: 'danger',
          html: `即将<b>停用员工 ${esc(b.dataset.no || '')} 的账号</b>，停用后立即<b>禁止登录</b>收银台/移动端。<br><span class="muted">复职可随时恢复（员工列表「复职」按钮）。</span>` });
        if (!ok) return;
      }
      await must(post(`/auth/employees/${b.dataset.t}/status`, { status: b.dataset.s }),
        b.dataset.s === '停用' ? '已停用（禁止登录）' : '已复职');
      await emps();
    });
    // V4.13.9 重置/修改员工密码（管理员、店长）：重置后通知员工在「我的 → 修改密码」改掉
    // V4.14.9：改用样式化输入弹窗（原浏览器 prompt 样式突兀）
    view.querySelectorAll('[data-rp]').forEach(b => b.onclick = async () => {
      const pwd = await promptBox({
        title: `🔑 重置登录密码`,
        html: `为 <b>${esc(b.dataset.nm)}</b>（${esc(b.dataset.no)}）设置新密码（≥6 位）。<br>
          <span class="muted" style="font-size:12px">重置后原密码立即失效，请通知员工在移动端「我的 → 修改密码」自行改掉。</span>`,
        placeholder: '输入新密码（至少 6 位）',
        inputType: 'password',
        okText: '下一步',
      });
      if (pwd === null) return;
      if (pwd.length < 6) return toast('密码至少 6 位', false);
      // V4.14.3 RV-10：敏感操作（risk_level=2）二次确认——防误点误重置
      const ok = await confirmBox({ title: '敏感操作确认', okText: '确认重置', okClass: 'danger',
        html: `即将重置 <b>${esc(b.dataset.nm)}（${esc(b.dataset.no)}）</b> 的<b>登录密码</b>，重置后原密码立即失效。<br><span class="muted">请通知员工尽快在移动端「我的 → 修改密码」改掉临时密码。</span>` });
      if (!ok) return;
      await must(post(`/auth/employees/${b.dataset.rp}/reset-password`, { newPassword: pwd }), '密码已重置');
    });
    // VQA（需求3）：删除已停用员工——服务端强校验「停用 + 无任何业务记录」，有记录会拒绝并提示保留停用
    view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const ok = await confirmBox({ title: '删除停用员工', okText: '确认删除', okClass: 'danger',
        html: `将物理删除 <b>${esc(b.dataset.nm)}（${esc(b.dataset.no)}）</b>。<br>
          <span class="muted">仅「停用」且无任何业务记录（订单/班次/审批/日志等）的账号可删除；有记录会被服务端拒绝并提示保留停用，以满足审计追溯。</span>` });
      if (!ok) return;
      await must(del(`/auth/employees/${b.dataset.del}`), `已删除员工 ${b.dataset.no}`);
      await emps();
    });
    // V4.25.7 店长授权码（收银员改价/打折现场授权；统一在后台员工管理设置/修改/清除）
    view.querySelectorAll('[data-ac]').forEach(b => b.onclick = async () => {
      const isSet = b.dataset.set === '1';
      const pwd = await promptBox({
        title: `🔐 店长授权码 · ${esc(b.dataset.nm)}（${esc(b.dataset.no)}）`,
        html: `收银员在收银台<b>改价/打折</b>时会弹出「店长授权」，输入该工号 + 此授权码即可放行该次价格操作。<br>
          <span class="muted" style="font-size:12px">授权码<b>独立于登录密码</b>，4~8 位数字；连续错 5 次锁 5 分钟。${isSet ? '<b>留空并确认 = 清除该员工的授权码。</b>' : ''}</span>`,
        placeholder: isSet ? '输入新授权码（4~8 位数字；留空 = 清除）' : '输入授权码（4~8 位数字）',
        inputType: 'password',
        okText: isSet ? '保存修改' : '设置授权码',
      });
      if (pwd === null) return;
      const code = String(pwd).trim();
      if (code && !/^\d{4,8}$/.test(code)) return toast('授权码须为 4~8 位数字', false);
      if (!code && !isSet) return;   // 本来就没设，空提交无事可做
      const ok = await confirmBox({
        title: code ? (isSet ? '确认修改授权码' : '确认设置授权码') : '确认清除授权码',
        okText: code ? (isSet ? '确认修改' : '确认设置') : '确认清除',
        okClass: code ? 'pri' : 'danger',
        html: code
          ? `即将为 <b>${esc(b.dataset.nm)}（${esc(b.dataset.no)}）</b>${isSet ? '修改' : '设置'}<b>店长授权码</b>——该工号将可在收银台审批收银员的改价/打折。`
          : `即将<b style="color:#c0392b">清除</b> <b>${esc(b.dataset.nm)}（${esc(b.dataset.no)}）</b> 的授权码，清除后该工号将无法再审批改价/打折。`,
      });
      if (!ok) return;
      await must(post(`/auth/employees/${b.dataset.ac}/auth-code`, { authCode: code || null }),
        code ? '授权码已保存' : '授权码已清除');
    });
    // V4.14.2：员工电子签名采集（存入签字样本，无供应商绑定 → 通用样本）
    view.querySelectorAll('[data-sig]').forEach(b => b.onclick = () => {
      openCollectPad(view, {
        personName: b.dataset.nm,
        title: `✍️ 采集签字 · ${b.dataset.nm}（员工）`,
        tip: '采集后存入「系统 → 授权管理」签字样本；对账确认/单据签字可自动带出',
        onDone: () => {},
      });
    });
  }

  async function roleList() {
    const rRows = await must(get('/auth/roles'));
    roles = rRows.items || rRows || [];
    roleSel.innerHTML = '<option value="">不绑角色（EM 前缀）</option>' +
      roles.map(r => `<option value="${r.id}">${esc(r.name)}${r.is_system ? '（内置）' : ''}</option>`).join('');
    view.querySelector('#rList').innerHTML = roles.length ? `
      <table><thead><tr><th>角色</th><th>系统内置</th><th class="num">权限点数</th><th>权限点</th></tr></thead>
      <tbody>${roles.map(r => `<tr>
        <td><b>${esc(r.name)}</b></td><td>${r.is_system ? '是' : '否'}</td>
        <td class="num">${(r.perms || []).length}</td>
        <td class="muted" data-role-perms="${esc((r.perms || []).join(','))}">…</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无角色</div>';
  }

  async function permList() {
    const pRows = await must(get('/auth/permissions'));
    const arr = pRows.items || pRows || [];
    const byMod = {};
    for (const p of arr) (byMod[p.module] = byMod[p.module] || []).push(p);
    // 权限点中文名映射（code 仅作勾选值，不再直接展示英文键）
    const cnMap = {};
    for (const p of arr) cnMap[p.code] = p.name || p.code;
    const cn = code => cnMap[code] || code;
    // 角色弹窗内的权限勾选矩阵（按模块分组）
    view.querySelector('#rlPerms').innerHTML = Object.entries(byMod).map(([mod, ps]) => `
      <div class="mb8"><b>${esc(mod)}</b><div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:8px">${ps.map(p =>
        `<label class="muted" style="min-width:0;white-space:nowrap" title="风险等级 ${p.risk_level}">
          <input type="checkbox" data-perm="${esc(p.code)}"> ${esc(p.name || p.code)}</label>`).join('')}</div></div>`).join('');
    // 角色权限快照也改用中文名
    view.querySelectorAll('[data-role-perms]').forEach(td => {
      const codes = (td.dataset.rolePerms || '').split(',').filter(Boolean);
      td.textContent = codes.slice(0, 12).map(cn).join(' · ') + (codes.length > 12 ? ' …' : '');
    });
    // 展示区（V4.14.9 版式统一：表格式两列布局——模块名固定列宽 + 权限点统一标签规格，附颜色图例）
    view.querySelector('#pList').innerHTML = `
      <table style="width:100%;font-size:12.5px">
        <thead><tr><th style="width:110px;text-align:left">模块</th><th style="text-align:left">权限点（<span class="tag g" style="font-size:10px;padding:1px 8px">常规</span> <span class="tag y" style="font-size:10px;padding:1px 8px">敏感</span> <span class="tag r" style="font-size:10px;padding:1px 8px">高危</span>，悬停看风险等级）</th></tr></thead>
        <tbody>${Object.entries(byMod).map(([mod, ps]) => `
          <tr><td><b>${esc(mod)}</b> <span class="muted" style="font-size:11px">${ps.length}</span></td>
          <td>${ps.map(p =>
            `<span class="tag ${p.risk_level >= 3 ? 'r' : p.risk_level === 2 ? 'y' : 'g'}" title="风险等级 ${p.risk_level}" style="display:inline-block;margin:2px 4px 2px 0;padding:2px 10px;font-size:12px">${esc(p.name || p.code)}</span>`).join('')}</td>
        </tr>`).join('')}</tbody></table>`;
  }

  await emps(); await roleList(); await permList();
}
