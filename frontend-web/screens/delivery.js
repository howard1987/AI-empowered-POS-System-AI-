import { get, post, must, esc, dt, toast } from '../api.js';

/** T6 本店配送调度：
 *  门店查看进行中的配送/外卖订单 → 出车（配送员出发）→ 送达核销（核验收货码）。
 *  订单由会员 H5 端下单（mall/orders，pickup_mode=配送/外卖）产生；本页是门店侧的调度闭环。 */
export async function render(view) {
  view.innerHTML = `
    <div class="card">
      <h3>本店配送调度（T6）
        <select id="dMode" style="margin-left:12px">
          <option value="">配送 + 外卖</option>
          <option value="外卖">仅外卖</option>
        </select>
        <button class="btn" id="dGo" style="margin-left:8px">刷新</button>
        <span class="muted" style="font-weight:400;margin-left:8px">出车后由本店配送员送达，到店核验收货码</span></h3>
      <div id="dList" class="tbl-min" style="max-height:calc(10*40px+42px);overflow:auto"></div>
    </div>`;

  async function load() {
    const mode = view.querySelector('#dMode').value;
    const d = await must(get('/pos/deliveries' + (mode ? '?mode=' + encodeURIComponent(mode) : '')));
    const items = d.items || [];
    view.querySelector('#dList').innerHTML = items.length ? `
      <table><thead><tr><th>单号</th><th>模式</th><th class="num">应收</th><th>收货人</th><th>电话</th>
        <th>地址</th><th>状态</th><th>出车时间</th><th></th></tr></thead>
      <tbody>${items.map(o => `<tr>
        <td style="font-family:var(--mono)">${esc(o.orderNo)}</td>
        <td><span class="tag b">${esc(o.pickupMode)}</span></td>
        <td class="num">${o.payable != null ? '¥' + Number(o.payable).toFixed(2) : '—'}</td>
        <td>${esc(o.receiver || o.memberName || '—')}</td>
        <td>${esc(o.receiverPhone || o.memberPhone || '—')}</td>
        <td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(o.receiverAddress || '—')}</td>
        <td>${o.dispatchedAt ? '<span class="tag g">配送中</span>' : '<span class="tag">待配送</span>'}</td>
        <td>${o.dispatchedAt ? dt(o.dispatchedAt).slice(0, 16) : '—'}</td>
        <td style="white-space:nowrap">
          ${o.dispatchedAt ? '' : `<button class="btn sm" data-disp="${o.id}">出车</button> `}
          <button class="btn sm pri" data-done="${o.id}" ${o.status === '已完成' ? 'disabled' : ''}>送达核销</button>
        </td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">暂无进行中的配送 / 外卖订单</div>';
    view.querySelectorAll('[data-disp]').forEach(b => b.onclick = async () => {
      if (!confirm('确认该订单已出车配送？')) return;
      await must(post('/pos/deliveries/' + b.dataset.disp + '/dispatch', {}), '已出车');
      toast('已出车', true); load();
    });
    view.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
      const code = prompt('请输入顾客出示的收货码（6 位；可留空跳过校验）');
      if (code === null) return;
      await must(post('/pos/deliveries/' + b.dataset.done + '/complete', { code: code || undefined }), '已核销');
      toast('已送达核销', true); load();
    });
  }
  view.querySelector('#dGo').onclick = load;
  load();
}
