# -*- coding: utf-8 -*-
"""V4.8.19 快改补丁：档位充值/等级列/流水筛选/行内设置/交接班信息 + e2e Y 段"""
import io, sys

ROOT = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-初版代码"

def patch(path, pairs, label):
    p = ROOT + path
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        if new in s and old not in s:
            continue  # 幂等
        assert old in s, f"[{label}] 锚点未命中: {old[:60]!r}"
        s = s.replace(old, new, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    chk = io.open(p, encoding="utf-8").read()
    for _, new in pairs:
        assert new in chk, f"[{label}] 落盘校验失败: {new[:60]!r}"
    print(f"OK: {label}")

# ── A. members.module.ts：列表等级列 + 充值档位 ──
patch("/backend/src/modules/members.module.ts", [
    (
        """      `SELECT m.id, m.card_no, m.phone, m.name, m.pinyin_code, m.level_id, m.points, m.status,
              m.last_active_date, m.invalid_at, a.balance, a.dividend_balance, a.dividend_capped
         FROM members m JOIN member_accounts a ON a.member_id = m.id
        WHERE ${where} ORDER BY m.id LIMIT $2 OFFSET $3`, [kw, sz, (pn - 1) * sz]);""",
        """      `SELECT m.id, m.card_no, m.phone, m.name, m.pinyin_code, m.level_id, m.points, m.status,
              m.last_active_date, m.invalid_at, a.balance, a.dividend_balance, a.dividend_capped,
              COALESCE(l.name, '普通会员') AS level_name
         FROM members m JOIN member_accounts a ON a.member_id = m.id
         LEFT JOIN member_levels l ON l.id = m.level_id
        WHERE ${where} ORDER BY m.id LIMIT $2 OFFSET $3`, [kw, sz, (pn - 1) * sz]);""",
    ),
    (
        """    @Body() b: { principal: number; gift?: number; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const principal = Number(b.principal);
    const gift = Number(b.gift || 0);
    if (!(principal > 0) || gift < 0) throw new BizException(40003, 'principal 必须为正数');""",
        """    @Body() b: { principal?: number; gift?: number; planId?: number; remark?: string },
    @CurrentUser() user: AuthUser,
  ) {
    let principal = Number(b.principal || 0);
    let gift = Number(b.gift || 0);
    // V4.8.19：支持按充值档位（服务端按档入账，与 H5 同口径防篡改）
    if (b.planId) {
      const p = await q1(`SELECT * FROM recharge_plans WHERE id=$1 AND status='启用'`, [b.planId]);
      if (!p) throw new BizException(42016, '充值档位不存在或已停用');
      principal = Number(p.principal);
      gift = Number(p.gift);
    }
    if (!(principal > 0) || gift < 0) throw new BizException(40003, 'principal 必须为正数');""",
    ),
], "members.module")

# ── B. sales.module.ts：流水筛选（收银员/商品关键字/供应商） ──
patch("/backend/src/modules/sales.module.ts", [
    (
        """    @Query('page') page = '1', @Query('size') size = '20',
    @Query('from') from?: string, @Query('to') to?: string,
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    const items = await q(
      `SELECT o.*, m.name AS member_name, e.name AS cashier_name
         FROM sales_orders o
         LEFT JOIN members m ON m.id = o.member_id
         LEFT JOIN employees e ON e.id = o.cashier_id
        WHERE ($1::date IS NULL OR o.created_at::date >= $1::date)
          AND ($2::date IS NULL OR o.created_at::date <= $2::date)
        ORDER BY o.id DESC LIMIT $3 OFFSET $4`, [from || null, to || null, sz, (pn - 1) * sz]);
    return { page: pn, size: sz, items };""",
        """    @Query('page') page = '1', @Query('size') size = '20',
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('cashierId') cashierId?: string, @Query('keyword') keyword?: string,
    @Query('supplierId') supplierId?: string,
  ) {
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    const kw = (keyword || '').trim();
    const items = await q(
      `SELECT o.*, m.name AS member_name, e.name AS cashier_name
         FROM sales_orders o
         LEFT JOIN members m ON m.id = o.member_id
         LEFT JOIN employees e ON e.id = o.cashier_id
        WHERE ($1::date IS NULL OR o.created_at::date >= $1::date)
          AND ($2::date IS NULL OR o.created_at::date <= $2::date)
          AND ($3::bigint IS NULL OR o.cashier_id = $3::bigint)
          AND ($4 = '' OR EXISTS (SELECT 1 FROM sale_items si4 JOIN products p4 ON p4.id = si4.product_id
                WHERE si4.order_id = o.id AND (p4.name ILIKE '%'||$4||'%' OR p4.barcode = $4)))
          AND ($5::bigint IS NULL OR EXISTS (SELECT 1 FROM sale_items si5 JOIN products p5 ON p5.id = si5.product_id
                WHERE si5.order_id = o.id AND p5.supplier_default_id = $5::bigint))
        ORDER BY o.id DESC LIMIT $6 OFFSET $7`,
      [from || null, to || null, cashierId || null, kw, supplierId || null, sz, (pn - 1) * sz]);
    return { page: pn, size: sz, items };""",
    ),
], "sales.module")

# ── C. members.js：等级列 + 档位充值 ──
patch("/frontend-web/screens/members.js", [
    (
        """      <table><thead><tr><th>卡号</th><th>姓名</th><th>手机号</th><th class="num">余额</th>""",
        """      <table><thead><tr><th>卡号</th><th>姓名</th><th>手机号</th><th>等级</th><th class="num">余额</th>""",
    ),
    (
        """        <td>${esc(m.card_no)}</td><td>${esc(m.name)}</td><td>${esc(m.phone)}</td>""",
        """        <td>${esc(m.card_no)}</td><td>${esc(m.name)}</td><td>${esc(m.phone)}</td>
        <td><span class="tag b">${esc(m.level_name || '普通会员')}</span></td>""",
    ),
    (
        """      <div class="bar muted">积分 ${Number(m.points)} · 注册 ${dt(m.created_at)}</div>""",
        """      <div class="bar muted">等级 <span class="tag b">${esc(m.level_name || '普通会员')}</span> · 积分 ${Number(m.points)} · 注册 ${dt(m.created_at)}</div>""",
    ),
    (
        """      <div class="bar" style="margin-top:10px">
        <input id="rAmt" type="number" step="0.01" placeholder="储值本金" style="width:120px">
        <input id="rGift" type="number" step="0.01" placeholder="赠送(可选)" style="width:110px">
        <button class="btn pri" id="rGo">储值</button>
      </div></div>`;""",
        """      <div class="bar" style="margin-top:10px">
        <select id="rPlan" style="width:250px"></select>
        <input id="rAmt" type="number" step="0.01" placeholder="储值本金" style="width:120px">
        <input id="rGift" type="number" step="0.01" placeholder="赠送(可选)" style="width:110px">
        <button class="btn pri" id="rGo">储值</button>
        <span class="muted">选档位自动按「充X送Y」入账（服务端计算防篡改）；赠送不计分红权重</span>
      </div></div>`;""",
    ),
    (
        """    view.querySelector('#rGo').onclick = async () => {
      const amt = Number(view.querySelector('#rAmt').value);
      const gift = Number(view.querySelector('#rGift').value) || undefined;
      if (!(amt > 0)) return toast('储值金额必填', false);
      await must(post(`/members/${id}/recharges`, { principal: amt, gift }), '储值成功');
      await list(); await detail(id);
    };""",
        """    // V4.8.19：充值档位下拉（启用档位；选档=服务端按档入账；自定义=手输本金/赠送）
    const sel = view.querySelector('#rPlan');
    const amtI = view.querySelector('#rAmt'), giftI = view.querySelector('#rGift');
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
    view.querySelector('#rGo').onclick = async () => {
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
      await list(); await detail(id);
    };""",
    ),
], "members.js")

# ── D. sales.js：筛选区重排 ──
patch("/frontend-web/screens/sales.js", [
    (
        """      <div class="bar">
        <input type="date" id="fFrom"> <span class="muted">至</span> <input type="date" id="fTo">
        <button class="btn" id="fGo">查询</button>
      </div>""",
        """      <div class="bar">
        <select id="fSup" style="width:190px"><option value="">全部供应商</option></select>
        <select id="fCashier" style="width:140px"><option value="">全部收银员</option></select>
        <input id="fKw" placeholder="商品名称/条码" style="width:150px">
        <input type="date" id="fFrom"> <span class="muted">至</span> <input type="date" id="fTo">
        <button class="btn pri" id="fGo">查询</button>
        <span class="muted">供应商按单内商品的默认供应商匹配；先定条件与日期段再查询</span>
      </div>""",
    ),
    (
        """  async function list() {
    const from = view.querySelector('#fFrom').value, to = view.querySelector('#fTo').value;
    const d = await must(get(`/sales?from=${from}&to=${to}&size=50`));""",
        """  // 筛选项数据源（供应商/收银员；加载失败自动隐藏对应下拉）
  async function loadFilters() {
    const sup = view.querySelector('#fSup'), csh = view.querySelector('#fCashier');
    try {
      const sd = await get('/purchase/suppliers?size=100');
      const items = sd.items || sd || [];
      sup.innerHTML = '<option value="">全部供应商</option>' +
        items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    } catch { sup.style.display = 'none'; }
    try {
      const ed = await get('/auth/employees?size=100');
      const items = ed.items || ed || [];
      csh.innerHTML = '<option value="">全部收银员</option>' +
        items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    } catch { csh.style.display = 'none'; }
  }

  async function list() {
    const from = view.querySelector('#fFrom').value, to = view.querySelector('#fTo').value;
    const sup = view.querySelector('#fSup').value, csh = view.querySelector('#fCashier').value;
    const kw = encodeURIComponent(view.querySelector('#fKw').value.trim());
    const d = await must(get(`/sales?from=${from}&to=${to}&size=50` +
      (sup ? `&supplierId=${sup}` : '') + (csh ? `&cashierId=${csh}` : '') + (kw ? `&keyword=${kw}` : '')));""",
    ),
    (
        """  view.querySelector('#fGo').onclick = list;""",
        """  view.querySelector('#fGo').onclick = list;
  view.querySelector('#fKw').addEventListener('keydown', e => { if (e.key === 'Enter') list(); });
  await loadFilters();""",
    ),
], "sales.js")

# ── E. shifts.js：当前班次补收银机/开班时间 ──
patch("/frontend-web/screens/shifts.js", [
    (
        """        <div class="kpi"><div class="t">班次</div><div class="v">#${s.id} <span class="tag g">进行中</span></div></div>
        <div class="kpi"><div class="t">收银员</div><div class="v" style="font-size:16px">${esc(s.cashier_name)}</div></div>""",
        """        <div class="kpi"><div class="t">班次</div><div class="v">#${s.id} <span class="tag g">进行中</span></div></div>
        <div class="kpi"><div class="t">收银机编号</div><div class="v">${esc(s.pos_no || '—')}</div></div>
        <div class="kpi"><div class="t">收银员</div><div class="v" style="font-size:16px">${esc(s.cashier_name)}</div></div>
        <div class="kpi"><div class="t">开班时间</div><div class="v" style="font-size:14px">${dt(s.opened_at)}</div></div>""",
    ),
], "shifts.js")

# ── F. e2e：Y 段 ──
Y_BLOCK = """
  // ═══ Y. V4.8.19 档位充值 + 会员等级列 + 流水筛选 ═══
  console.log('■ Y. V4.8.19 档位充值 + 流水筛选');
  const yM = data(await api('POST', '/members', { token: T, body: { phone: '13900009901', name: '档位充值员', privacyAgreed: true } }));
  const yRaw = await api('POST', `/members/${yM.id}/recharges`, { token: T, body: { planId: uPlan.id } });
  eq(yRaw.code, 0, 'Y1 按档充值成功（planId）');
  near(data(yRaw)?.balanceAfter, 110, 'Y1 按档入账 100+10=110（服务端按档，防篡改）');
  eq((await api('POST', `/members/${yM.id}/recharges`, { token: T, body: { planId: 999999 } })).code, 42016,
     'Y1 不存在档位 → 42016');
  const yDetail = data(await api('GET', `/members/${yM.id}`, { token: T }));
  ok(!!yDetail?.level_name, 'Y2 会员详情返回等级名', JSON.stringify(yDetail?.level_name));
  const yList = data(await api('GET', '/members?keyword=档位充值员', { token: T }));
  ok(yList?.items?.[0]?.level_name !== undefined, 'Y3 会员列表返回等级列');
  // 流水筛选（供应商/收银员/商品关键字）
  const ySup = data(await api('POST', '/purchase/suppliers', { token: T, body: { name: '流水过滤供应商' } }));
  const yP = data(await api('POST', '/products', { token: T, body: {
    name: '流水过滤专用奶', base_unit: '盒', sellPrice: 3, barcode: '6901234509911', keepDays: 60, supplierDefaultId: ySup.id } }));
  const yIn = data(await api('POST', '/purchase/inbounds', { token: T, body: { supplierId: ySup.id, items: [
    { productId: yP.id, qty: 50, unitCost: 2, productionDate: '2026-09-01' } ] } }));
  await api('POST', `/purchase/inbounds/${yIn.id}/audit`, { token: T });
  const yCo = data(await api('POST', '/sales/checkout', { token: T, body: {
    items: [{ productId: yP.id, qty: 2 }], payments: [{ channel: '现金', amount: 6 }] } }));
  near(yCo?.payable, 6, 'Y4 造流水 checkout 2×3=6');
  const yOid = Number(yCo?.orderId || yCo?.id);
  const yKw = data(await api('GET', '/sales?keyword=' + encodeURIComponent('流水过滤专用奶') + '&size=100', { token: T }));
  ok((yKw?.items || []).some(o => Number(o.id) === yOid), 'Y5 商品关键字过滤命中');
  const yKw0 = data(await api('GET', '/sales?keyword=' + encodeURIComponent('绝对不存在xyz'), { token: T }));
  ok(!(yKw0?.items || []).some(o => Number(o.id) === yOid), 'Y6 无关关键字不命中');
  const yBySup = data(await api('GET', '/sales?supplierId=' + ySup.id + '&size=100', { token: T }));
  ok((yBySup?.items || []).some(o => Number(o.id) === yOid), 'Y7 供应商过滤命中（按单内商品默认供应商）');
  const yAll = data(await api('GET', '/sales?size=100', { token: T }));
  const yOrder = (yAll?.items || []).find(o => Number(o.id) === yOid);
  if (yOrder && yOrder.cashier_id) {
    const yC = data(await api('GET', '/sales?cashierId=' + yOrder.cashier_id + '&size=100', { token: T }));
    ok((yC?.items || []).some(o => Number(o.id) === yOid), 'Y8 收银员过滤命中');
  } else ok(true, 'Y8 无 cashier_id（跳过）');

"""
patch("/backend/tests/e2e.mjs", [
    ("  // ═══ 汇总 ═══", Y_BLOCK + "  // ═══ 汇总 ═══"),
], "e2e Y段")

print("ALL PATCHES APPLIED")
