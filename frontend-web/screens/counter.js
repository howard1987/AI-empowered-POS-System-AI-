import qrcode from '../vendor/qrcode.mjs';
import { get, post, del, must, money, esc, dt, toast } from '../api.js';

/** 挂单/取单 + 价目表新鲜度（V4.15.4：单据号/刷新/查询/时间筛选/复选框批量取消/详情弹窗/10s 自动刷新） */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>挂单列表 </h3>
      <div class="bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <input id="hKw" placeholder="单号 / 商品 / 挂单人 / 备注" style="width:220px">
        <label class="muted">从 <input id="hFrom" type="date"></label>
        <label class="muted">至 <input id="hTo" type="date"></label>
        <select id="hStatus">
          ${['挂单中', '已取单', '已取消', '全部'].map(s => `<option>${s}</option>`).join('')}
        </select>
        <button class="btn sm pri" id="hSearch">查询</button>
        <button class="btn sm" id="hRefresh">🔄 刷新</button>
        <span style="flex:1"></span>
        <button class="btn sm warn" id="hBatch" disabled>批量取消选中</button>
        <span class="muted" id="hCount"></span>
      </div>
      <div id="hList"></div>
      <div class="muted" style="margin-top:6px;font-size:12px">列表每 10 秒自动刷新：移动端「取单」后挂单即时从这里消失；点击单号查看挂单详情</div>
    </div>
    <div class="card"><h3>价目表新鲜度（应急硬闸） </h3>
      <div id="hFresh" class="muted">加载中…</div></div>`;

  const $ = s => view.querySelector(s);

  /** 金额汇总：新快照有 lineTotal；旧快照回退 qty×unitPrice；再缺则 — */
  const sumQty = items => items.reduce((a, i) => a + (Number(i?.qty) || 0), 0);
  const sumAmt = items => {
    if (!items.length) return null;
    if (items.every(i => i?.lineTotal != null || i?.unitPrice != null))
      return items.reduce((a, i) => a + (Number(i?.lineTotal ?? (Number(i?.unitPrice) || 0) * (Number(i?.qty) || 0))), 0);
    return null;
  };

  async function list() {
    const kw = $('#hKw').value.trim();
    const from = $('#hFrom').value, to = $('#hTo').value;
    const st = $('#hStatus').value;
    const qs = new URLSearchParams({ status: st });
    if (kw) qs.set('keyword', kw);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const d = await must(get('/pos/held?' + qs.toString()));
    const rows = Array.isArray(d) ? d : (d.items || []);
    $('#hCount').textContent = `共 ${rows.length} 单`;
    $('#hBatch').disabled = true;
    $('#hList').innerHTML = rows.length ? `
      <table><thead><tr><th><input type="checkbox" id="hAll"></th><th class="seq">序号</th><th>单号</th><th>POS</th><th>挂单人</th>
        <th class="num">商品数量</th><th class="num">金额</th><th>备注</th><th>挂单时间</th><th>操作</th></tr></thead>
      <tbody>${rows.map((h, i) => {
        const items = h.items || [];
        const amt = sumAmt(items);
        return `<tr><td><input type="checkbox" class="hSel" data-id="${h.id}" data-st="${esc(h.status)}"></td><td class="num seq">${i + 1}</td>
        <td><a href="javascript:void 0" data-detail="${h.id}" style="font-weight:600">${esc(h.order_no || ('#' + h.id))}</a></td>
        <td>${esc(h.pos_no)}</td><td>${esc(h.held_by_name || '—')}</td>
        <td class="num">${sumQty(items)}</td>
        <td class="num" style="font-weight:600">${amt != null ? money(amt) : '—'}</td>
        <td class="muted">${esc(h.remark || '')}</td><td>${dt(h.created_at)}</td>
        <td>
          <button class="btn sm pri" data-pick="${h.id}" ${h.status === '挂单中' ? '' : 'disabled'}>取单结账</button>
          <button class="btn sm warn" data-cancel="${h.id}" ${h.status === '挂单中' ? '' : 'disabled'}>取消</button>
        </td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">当前无挂单</div>';

    // 复选框：全选（只勾挂单中）+ 选中数联动批量按钮
    $('#hList').querySelectorAll('.hSel').forEach(cb => cb.onchange = () => {
      const n = [...$('#hList').querySelectorAll('.hSel:checked')].length;
      $('#hBatch').disabled = !n;
      $('#hBatch').textContent = n ? `批量取消选中（${n}）` : '批量取消选中';
    });
    const all = $('#hList').querySelector('#hAll');
    if (all) all.onchange = () => $('#hList').querySelectorAll('.hSel').forEach(cb => {
      cb.checked = all.checked && cb.dataset.st === '挂单中';
      cb.onchange();
    });

    $('#hList').querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
      await must(del(`/pos/held/${b.dataset.cancel}`), '挂单已取消（留痕）');
      await list();
    });
    $('#hList').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => pick(Number(b.dataset.pick)));
    $('#hList').querySelectorAll('[data-detail]').forEach(a => a.onclick = () => detail(Number(a.dataset.detail)));
  }

  /** 批量取消（复选框勾选的挂单中单据，逐单留痕取消） */
  $('#hBatch').onclick = async () => {
    const ids = [...view.querySelectorAll('.hSel:checked')].map(cb => Number(cb.dataset.id));
    if (!ids.length) return;
    for (const id of ids) { await must(del(`/pos/held/${id}`), `挂单 #${id} 已取消`); }
    toast(`已批量取消 ${ids.length} 单`);
    await list();
  };

  $('#hRefresh').onclick = () => list();
  $('#hSearch').onclick = () => list();
  $('#hKw').onkeydown = e => { if (e.key === 'Enter') list(); };
  $('#hStatus').onchange = () => list();

  /** 挂单详情弹窗：商品列表（名称/条码/单位/数量/单价/小计/行备注）+ 单据头信息 */
  async function detail(id) {
    const h = await must(get('/pos/held/' + id));
    const items = h.items || [];
    const amt = sumAmt(items);
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="max-width:720px"><h3>挂单详情 ${esc(h.order_no || ('#' + h.id))}</h3>
      <div class="muted" style="margin-bottom:8px">
        单号 ${esc(h.order_no || '#' + h.id)} · POS ${esc(h.pos_no)} · ${esc(h.member_name || '散客')} ·
        挂单人 ${esc(h.held_by_name || '—')} · ${dt(h.created_at)} ·
        状态 <b>${esc(h.status)}</b>${h.picked_at ? ` · 取单时间 ${dt(h.picked_at)}` : ''}${h.remark ? ` · 备注：${esc(h.remark)}` : ''}
      </div>
      ${items.length ? `<table><thead><tr><th class="seq">序号</th><th>商品</th><th>条码</th><th>单位</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th><th>行备注</th></tr></thead>
      <tbody>${items.map((i, k) => `<tr>
        <td class="seq">${k + 1}</td><td>${esc(i.productName || ('#' + i.productId))}</td>
        <td class="muted">${esc(i.barcode || '—')}</td><td>${esc(i.unitName || i.unit || '—')}</td>
        <td class="num">${Number(i.qty) || 0}</td>
        <td class="num">${i.unitPrice != null ? money(i.unitPrice) : '—'}</td>
        <td class="num">${i.lineTotal != null ? money(i.lineTotal) : (i.unitPrice != null ? money(i.unitPrice * (Number(i.qty) || 0)) : '—')}</td>
        <td class="muted">${esc(i.lineRemark || '')}</td></tr>`).join('')}
      <tr><td colspan="6" style="text-align:right;font-weight:600">合计（${sumQty(items)} 件）</td>
        <td class="num" style="font-weight:700">${amt != null ? money(amt) : '—'}</td><td></td></tr></tbody></table>`
      : '<div class="empty">无商品明细</div>'}
      <div class="bar" style="margin-top:12px"><button class="btn" id="hdClose">关闭</button></div>
      <div class="muted" style="margin-top:6px;font-size:12px">金额为挂单时快照价；实际结算以取单结账时服务端重新计价为准</div></div>`;
    document.body.appendChild(mask);
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    mask.querySelector('#hdClose').onclick = () => mask.remove();
  }

  /** 取单结账：弹层输入支付（演示用现金；实际收银在 POS 端） */
  function pick(id) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal"><h3>取单结账 #${id}</h3>
      <label class="muted">支付方式</label>
      <select id="pkCh">${['现金', '微信', '支付宝', '余额'].map(c => `<option>${c}</option>`).join('')}</select>
      <div style="height:8px"></div>
      <label class="muted">金额（以服务端重新计价为准，可先填 0 触发提示）</label>
      <input id="pkAmt" type="number" step="0.01" style="width:140px">
      <div style="height:8px"></div>
      <label class="muted">散客手机号（选填·留资后可积分/转会员）</label>
      <input id="pkPhone" placeholder="11位手机号" style="width:160px" maxlength="11">
      <div class="bar" style="margin-top:14px">
        <button class="btn pri" id="pkGo">结账</button>
      </div>
      <div class="muted" id="pkTip" style="margin-top:8px"></div></div>`;
    document.body.appendChild(mask);
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    mask.querySelector('#pkGo').onclick = async () => {
      const ch = mask.querySelector('#pkCh').value;
      const amt = Number(mask.querySelector('#pkAmt').value);
      const phone = (mask.querySelector('#pkPhone').value || '').trim();
      try {
        const d = await must(post(`/pos/held/${id}/checkout`, {
          payments: amt > 0 ? [{ channel: ch, amount: amt }] : [],
          guestPhone: phone || undefined,
        }));
        // 会员 H5 入口：优先用设置的正式域名地址（member.h5.entry_url），未配置则回落当前服务器（联调模式）
        let h5entry = '';
        try { const r = await get('/settings/key/member.h5.entry_url'); h5entry = String(r?.value ?? '').replace(/^"|"$/g, '').trim(); } catch { /* 读不到就用当前服务器地址 */ }
        const base = h5entry ? h5entry.replace(/\/+$/, '') : location.origin + '/member';
        const h5reg = base + '/?orderId=' + encodeURIComponent(d.orderId);
        const qr = qrcode(0, 'M');
        qr.addData(h5reg);
        qr.make();
        const qrUrl = qr.createDataURL(4, 8);
        mask.querySelector('#pkTip').innerHTML =
          `✅ 结账成功：单号 ${esc(d.orderNo)}，应收 ${money(d.payable)}，抹零 ${money(d.roundAmount)}` +
          `<div style="margin-top:10px"><div style="font-weight:600;margin-bottom:6px">📱 扫码自助注册会员（本单自动归集）</div>` +
          `<img src="${qrUrl}" style="width:160px;height:160px;border:6px solid #fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);background:#fff" alt="注册二维码">` +
          `<div class="muted" style="font-size:11px;margin-top:4px">顾客微信扫此码注册，散客订单自动转为会员积分</div></div>`;
        setTimeout(() => { mask.remove(); list(); }, 6000);
      } catch { /* toast 已提示 */ }
    };
  }

  (async () => {
    const f = await must(get('/pos/pricebook/freshness')).catch(() => null);
    view.querySelector('#hFresh').innerHTML = f
      ? (f.generatedAt === null
        ? '<span class="tag r">从未下发</span> 请先在收银端联网同步价目表'
        : (f.fresh
          ? `<span class="tag g">新鲜</span> 版本 ${esc(f.version?.slice(0, 8))}… · 更新于 ${dt(f.generatedAt)}（上限 ${f.limitHours}h）`
          : `<span class="tag r">过期</span> 已 ${f.ageHours}h 未更新（上限 ${f.limitHours}h）→ 禁止应急收银`))
      : '加载失败';
  })();

  await list();
  // V4.15.4：10 秒自动刷新（移动端取单后，挂单列表即时消失；弹窗打开时跳过刷新避免打断）
  const timer = setInterval(() => {
    if (!document.querySelector('.modal-mask') && view.isConnected) list().catch(() => {});
    else if (!view.isConnected) clearInterval(timer);
  }, 10000);
}
