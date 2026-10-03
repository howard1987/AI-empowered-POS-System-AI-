import { get, post, must, money, esc, dt, toast } from '../api.js';
import { openDetailModal, paginate, bindPager } from '../common-ui.js';

/** 交接班：
 *  当前班次：开班仅两个输入——①POS 编号（哪台收银机交班）②备用金（开班时钱箱里放的零钱，
 *  用来找零；交班时现金应收=备用金+本班现金销售，实盘与之比对得长短款）。
 *  班次报表：双击记录行弹窗查看该班次详情（汇总+当日订单入口）。
 */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>当前班次 </h3>
      <div id="cur"></div>
    </div>
    <div class="card">
      <h3>班次记录表 
        <span class="muted" style="font-weight:400;margin-left:12px">双击任意一行 → 弹窗查看该班次详情</span></h3>
      <div id="list" class="tbl-min"></div>
    </div>`;

  async function loadCurrent() {
    const d = await must(get('/shifts/current'));
    const el = view.querySelector('#cur');
    if (!d.shift) {
      el.innerHTML = `
        <div class="bar" style="flex-wrap:wrap;gap:10px">
          <div class="fld"><label>① POS 编号</label>
            <input id="oPos" placeholder="POS-01" style="width:120px"></div>
          <div class="fld"><label>② 备用金（开班放进钱箱的找零钱）</label>
            <input id="oFloat" type="number" step="0.01" style="width:130px" value="0"></div>
          <button class="btn pri" id="oGo" style="align-self:flex-end">开班</button>
        </div>
        <div class="doc-tip" style="margin:10px 18px">💡 <b>POS 编号</b>：标记本次班次用的是哪台收银机（多台 POS 时区分责任班次）。<br>
          💡 <b>备用金</b>：开班时点清钱箱里的零钱并填进来（用于日常找零）。交班时系统按「备用金 + 本班现金收入」算出现金应收，与你的现金实盘比对，差多少就是长/短款。</div>`;
      el.querySelector('#oGo').onclick = async () => {
        await must(post('/shifts/open', {
          posNo: el.querySelector('#oPos').value || undefined,
          openingFloat: Number(el.querySelector('#oFloat').value) || 0,
        }), '开班成功');
        await loadCurrent(); await loadList();
      };
      return;
    }
    const s = d.shift, m = d.summary;
    el.innerHTML = `
      <div class="grid kpis">
        <div class="kpi"><div class="t">班次</div><div class="v">#${s.id} <span class="tag g">进行中</span></div></div>
        <div class="kpi"><div class="t">收银机编号</div><div class="v">${esc(s.pos_no || '—')}</div></div>
        <div class="kpi"><div class="t">收银员</div><div class="v" style="font-size:16px">${esc(s.cashier_name)}</div></div>
        <div class="kpi"><div class="t">开班时间</div><div class="v" style="font-size:14px">${dt(s.opened_at)}</div></div>
        <div class="kpi"><div class="t">备用金</div><div class="v">${money(s.opening_float)}</div></div>
        <div class="kpi"><div class="t">现金应收</div><div class="v">${money(m.cashTotal)}</div></div>
        <div class="kpi"><div class="t">扫码收款</div><div class="v">${money(m.scanSales)}</div></div>
        <div class="kpi"><div class="t">余额支付</div><div class="v">${money(m.balanceSales)}</div></div>
        <div class="kpi"><div class="t">订单数</div><div class="v">${m.orderCount}</div></div>
      </div>
      <div class="bar" style="margin-top:12px">
        <input id="cCounted" type="number" step="0.01" placeholder="现金实盘" style="width:130px">
        <button class="btn pri" id="cGo">交班（盘点关班）</button>
        <span class="muted">现金实盘 = 交班时钱箱里数出来的现金总额</span>
      </div>`;
    el.querySelector('#cGo').onclick = async () => {
      const counted = el.querySelector('#cCounted').value;
      if (counted === '') return;
      const d2 = await must(post(`/shifts/${s.id}/close`, { cashCounted: Number(counted) }), '交班完成');
      const diff = Number(d2.shift.diff_amount);
      if (Math.abs(diff) > 0.005) {
        alert(`交班完成，差异 ${diff > 0 ? '长' : '短'}款 ${money(Math.abs(diff))}（已留痕）`);
      }
      await loadCurrent(); await loadList();
    };
  }

  let shPage = 1;
  async function loadList() {
    const d = await must(get('/shifts?size=20'));
    const rows = d.items || [];
    const pg = paginate(rows, shPage, 10);
    view.querySelector('#list').innerHTML = rows.length ? `
      <table><thead><tr><th class="seq">序号</th><th>班次</th><th>收银员</th><th>POS</th><th class="num">备用金</th>
        <th class="num">现金应收</th><th class="num">实盘</th><th class="num">差异</th>
        <th class="num">单数</th><th>开班</th><th>关班</th><th>状态</th></tr></thead>
      <tbody>${pg.slice.map((s, i) => {
        const diff = Number(s.diff_amount ?? 0);
        return `<tr data-shift="${s.id}" style="cursor:pointer" title="双击查看班次详情"><td class="num seq">${(shPage - 1) * 10 + i + 1}</td><td>#${s.id}</td><td>${esc(s.cashier_name)}</td><td>${esc(s.pos_no)}</td>
        <td class="num">${money(s.opening_float)}</td>
        <td class="num">${s.cash_total === null ? '—' : money(s.cash_total)}</td>
        <td class="num">${s.cash_counted === null ? '—' : money(s.cash_counted)}</td>
        <td class="num">${s.diff_amount === null ? '—' : `<span class="tag ${Math.abs(diff) <= 0.005 ? 'g' : diff > 0 ? 'b' : 'r'}">${money(diff)}</span>`}</td>
        <td class="num">${s.order_count ?? '—'}</td>
        <td>${dt(s.opened_at)}</td><td>${s.closed_at ? dt(s.closed_at) : '—'}</td>
        <td>${s.status === '进行中' ? '<span class="tag b">进行中</span>' : '<span class="tag g">已交班</span>'}</td></tr>`;
      }).join('')}</tbody></table>${pg.bar}` : '<div class="empty">无班次记录</div>';
    bindPager(view.querySelector('#list'), p => { shPage = p; loadList(); });
    view.querySelectorAll('[data-shift]').forEach(tr => tr.ondblclick = () => shiftDetail(tr.dataset.shift));
  }

  /** 班次详情弹窗：汇总 KPI + 跳转销售单据（按该班次时段+收银员过滤） */
  async function shiftDetail(id) {
    const d = await must(get(`/shifts/${id}`));
    const s = d.shift, m = d.summary;
    const diff = Number(s.diff_amount ?? 0);
    openDetailModal(`班次 #${s.id} 详情 `, `
      <div class="grid kpis" style="grid-template-columns:repeat(5,1fr)">
        <div class="kpi"><div class="t">收银员</div><div class="v" style="font-size:15px">${esc(s.cashier_name)}</div></div>
        <div class="kpi"><div class="t">收银机</div><div class="v" style="font-size:15px">${esc(s.pos_no || '—')}</div></div>
        <div class="kpi"><div class="t">开班</div><div class="v" style="font-size:13px">${dt(s.opened_at)}</div></div>
        <div class="kpi"><div class="t">关班</div><div class="v" style="font-size:13px">${s.closed_at ? dt(s.closed_at) : '进行中'}</div></div>
        <div class="kpi"><div class="t">状态</div><div class="v" style="font-size:15px">${s.status}</div></div>
        <div class="kpi"><div class="t">备用金</div><div class="v">${money(s.opening_float)}</div></div>
        <div class="kpi"><div class="t">现金应收</div><div class="v">${s.cash_total === null ? '—' : money(s.cash_total)}</div></div>
        <div class="kpi"><div class="t">现金实盘</div><div class="v">${s.cash_counted === null ? '—' : money(s.cash_counted)}</div></div>
        <div class="kpi"><div class="t">长/短款</div><div class="v" style="color:${Math.abs(diff) <= 0.005 ? 'var(--ok,#2e9e5b)' : '#c0392b'}">${s.diff_amount === null ? '—' : money(s.diff_amount)}</div></div>
        <div class="kpi"><div class="t">订单数</div><div class="v">${m.orderCount}</div></div>
        <div class="kpi"><div class="t">现金收入</div><div class="v">${money((m.cashTotal ?? 0) - Number(s.opening_float))}</div></div>
        <div class="kpi"><div class="t">扫码收款</div><div class="v">${money(m.scanSales)}</div></div>
        <div class="kpi"><div class="t">余额支付</div><div class="v">${money(m.balanceSales)}</div></div>
      </div>
      <div class="doc-tip">💡 长款=钱箱实盘比系统应收多；短款=少（短款需当天查小票与收款记录）。本班订单可在「销售单据」中按此时间段 + 收银员过滤查询。</div>`);
  }

  await loadCurrent();
  await loadList();
}
