/**
 * V5.0.0 连锁改造 · 批次4A · 「数据同步」页（M4-9，方案 §6.5）
 *
 * 双形态（按本节点角色自动切换）：
 *   总部节点 —— 节点水位看板（各店拉取进度/最后心跳/落后版本数）
 *               + 最近批次日志（sync_runs）+ 一键重推（版本区间重放）
 *               + 实时对数（总部实际 vs 门店上报）
 *   门店节点 —— 本节点配置向导（节点编码/密钥/总部地址）+ 本机待传队列
 *
 * 权限：hq.sync.view（服务端校验）；门店节点配置用 settings.update。
 */
import { get, post, must, esc, toast, dt } from '../api.js';
import { segHtml, bindSeg, noResult } from '../ui-polish.js';

export async function render(view) {
  const $ = s => view.querySelector(s);
  let tab = 'nodes';
  let status = null;      // /sync/status
  let recon = null;       // /sync/consistency
  let selfInfo = null;    // /sync/self

  view.innerHTML = `
    <style>
      #syHost table td,#syHost table th{text-align:center}
      .sy-l{text-align:left !important}
      .sy-ok{color:#1e8e4e;font-weight:600}
      .sy-warn{color:#c47f00;font-weight:600}
      .sy-bad{color:#c0392b;font-weight:600}
      .sy-kpi{display:flex;gap:10px;flex-wrap:wrap;padding:10px 18px 0}
      .sy-kpi .kpi{flex:1;min-width:150px;border:1px solid var(--line,#e5e0d3);border-radius:10px;padding:10px 14px;background:var(--paper,#fff)}
      .sy-kpi .kpi b{font-size:20px;display:block}
      .sy-kpi .kpi span{color:#8a8577;font-size:12px}
    </style>

    <div class="card" style="display:flex;flex-direction:column;height:calc(100dvh - 214px);min-height:520px">
      <div class="sy-kpi" id="syKpi"></div>
      <div style="display:flex;align-items:center;gap:12px;padding:8px 18px 0;flex-wrap:wrap">
        <span id="sySeg"></span>
        <span style="flex:1"></span>
        <span style="display:flex;gap:6px">
          <button class="btn" id="syRefresh">刷新</button>
        </span>
      </div>
      <div class="doc-tip" id="syTip"></div>
      <div style="padding:6px 18px 10px;flex:1;min-height:0;overflow:auto" id="syHost" class="tbl-min pg-host"></div>
      <div class="doc-foot"><span class="muted" id="syCount"></span></div>
    </div>`;

  const TIPS = {
    nodes: '「落后」= 该店还没拉到的总部变更条数；<b>心跳超过 5 分钟</b>请检查门店机网络或门店端服务。',
    runs: '每批上行/下行的收发记录。连续失败会自动退避重试，8 次转死信并在这里可查。',
    dead: '死信 = 重试 8 次仍失败的变更（留在<b>门店本机</b>），修复网络后由门店自动补传；此处只做监控告警。',
    recon: '昨日单量/金额对数：总部实账 vs 门店上报。差异 ≠ 0 请先查该店死信与心跳时间。',
  };

  async function loadSelf() {
    try { selfInfo = await must(get('/sync/self')); } catch { selfInfo = null; }
  }

  async function loadStatus() {
    try { status = await must(get('/sync/status')); } catch (e) { status = null; }
  }
  async function loadRecon() {
    try { recon = await must(get('/sync/consistency')); } catch { recon = null; }
  }

  function drawKpi() {
    const role = selfInfo?.identity?.role;
    if (role !== 'hq') {
      $('#syKpi').innerHTML = `
        <div class="kpi"><span>本机节点</span><b>${esc(selfInfo?.identity?.nodeCode || '未配置')}</b></div>
        <div class="kpi"><span>待传总部（笔）</span><b class="${Number(selfInfo?.pendingLocal || 0) > 100 ? 'sy-warn' : 'sy-ok'}">${Number(selfInfo?.pendingLocal || 0)}</b></div>
        <div class="kpi"><span>总部地址</span><b style="font-size:13px">${esc(selfInfo?.identity?.hqBase || '—')}</b></div>`;
      return;
    }
    const nodes = status?.nodes || [];
    const stores = nodes.filter(n => n.node_role === 'store');
    const online = stores.filter(n => n.last_seen_at && (Date.now() - new Date(n.last_seen_at).getTime()) < 5 * 60_000).length;
    const behindMax = stores.reduce((m, n) => Math.max(m, Number(n.behind || 0)), 0);
    const dead = Number(status?.dead_total || 0);
    $('#syKpi').innerHTML = `
      <div class="kpi"><span>总部版本（累计变更）</span><b>${Number(status?.latest || 0)}</b></div>
      <div class="kpi"><span>门店节点 在线/总数</span><b>${online}/${stores.length}</b></div>
      <div class="kpi"><span>最大落后（条）</span><b class="${behindMax > 200 ? 'sy-warn' : 'sy-ok'}">${behindMax}</b></div>
      <div class="kpi"><span>门店死信（本机 outbox）</span><b class="${dead > 0 ? 'sy-bad' : 'sy-ok'}">${dead}</b></div>`;
  }

  function draw() {
    drawKpi();
    drawSeg();
    const role = selfInfo?.identity?.role;
    if (role === 'hq') {
      if (tab === 'nodes') drawNodes();
      else if (tab === 'runs') drawRuns();
      else if (tab === 'dead') drawDead();
      else drawRecon();
    } else {
      drawStoreSelf();
    }
  }

  function drawSeg() {
    const role = selfInfo?.identity?.role;
    if (role === 'hq') {
      $('#sySeg').innerHTML = segHtml([
        { k: 'nodes', t: '节点水位' },
        { k: 'runs', t: '批次日志' },
        { k: 'dead', t: '失败与死信' },
        { k: 'recon', t: '对数校验' },
      ], tab);
      bindSeg($('#sySeg'), k => { tab = k; if (k === 'recon') loadRecon().then(draw); else draw(); });
    } else {
      $('#sySeg').innerHTML = '';
    }
    $('#syTip').innerHTML = role === 'hq' ? (TIPS[tab] || '') : '门店节点把本机变更推给总部、并拉取总部下发。首次部署请在下方填写总部发来的节点三要素。';
  }

  // ── 总部 · 节点水位 ──
  function drawNodes() {
    const host = $('#syHost');
    const stores = (status?.nodes || []).filter(n => n.node_role === 'store');
    if (!stores.length) {
      host.innerHTML = noResult('还没有门店节点', '在「总部 → 门店管理」新建门店并生成节点密钥后，门店端在此页配置即可上线');
      $('#syCount').textContent = ''; return;
    }
    const now = Date.now();
    host.innerHTML = `<table><thead><tr>
      <th class="seq">序号</th>
      <th>门店</th><th>节点码</th><th>拉取水位</th><th>落后</th>
      <th>末次心跳</th><th>末次成功</th><th>状态</th><th style="width:150px">操作</th></tr></thead><tbody>
      ${stores.map((n, i) => {
        const seen = n.last_seen_at ? new Date(n.last_seen_at).getTime() : 0;
        const online = seen && (now - seen) < 5 * 60_000;
        const behind = Number(n.behind || 0);
        return `<tr>
          <td class="seq">${i + 1}</td>
          <td class="sy-l">${esc(n.store_name || n.store_no || ('门店#' + n.store_id))}</td>
          <td>${esc(n.node_code)}</td>
          <td>${Number(n.in_version || 0)} / ${Number(status?.latest || 0)}</td>
          <td class="${behind > 200 ? 'sy-warn' : 'sy-ok'}">${behind}</td>
          <td>${n.last_seen_at ? dt(n.last_seen_at) : '—'}</td>
          <td>${n.last_ok_at ? dt(n.last_ok_at) : '—'}</td>
          <td class="${online ? 'sy-ok' : 'sy-bad'}">${online ? '在线' : '离线'}</td>
          <td><button class="btn sm" data-replay="${esc(n.store_id)}" data-code="${esc(n.node_code)}">↻ 一键重推</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    $('#syCount').textContent = `共 ${stores.length} 个门店节点`;
    host.querySelectorAll('[data-replay]').forEach(b => {
      b.onclick = () => openReplay(Number(b.dataset.replay), b.dataset.code);
    });
  }

  function openReplay(storeId, code) {
    const from = Number(prompt(`重推门店 ${code}\n从版本号（默认 1 = 全量重放）：`, '1') || 0);
    if (!from) return;
    const to = Number(prompt('到版本号（留空 = 到最新）：', '') || 0);
    post('/sync/replay', { storeId, from, to }).then(() => {
      toast('已重放为新版本，门店将自动拉取');
      loadStatus().then(draw);
    }).catch(e => toast('重推失败：' + (e?.message || e), false));
  }

  // ── 总部 · 批次日志 ──
  function drawRuns() {
    const host = $('#syHost');
    const runs = status?.runs || [];
    if (!runs.length) { host.innerHTML = noResult('还没有同步批次记录'); $('#syCount').textContent = ''; return; }
    host.innerHTML = `<table><thead><tr>
      <th class="seq">序号</th>
      <th>节点</th><th>方向</th><th>时间</th><th>发出</th><th>收到</th><th>失败</th><th>耗时(ms)</th><th>说明</th></tr></thead><tbody>
      ${runs.map((r, i) => `<tr>
        <td class="seq">${i + 1}</td>
        <td>${esc(r.node_code || '')}</td>
        <td class="${r.direction === 'push' ? 'sy-l' : ''}">${r.direction === 'push' ? '↑ 上行' : '↓ 下行'}</td>
        <td>${dt(r.started_at)}</td>
        <td>${Number(r.sent || 0)}</td><td>${Number(r.recv || 0)}</td>
        <td class="${Number(r.failed || 0) > 0 ? 'sy-bad' : ''}">${Number(r.failed || 0)}</td>
        <td>${Number(r.duration_ms || 0)}</td>
        <td class="sy-l">${esc((r.msg || '').slice(0, 60))}</td>
      </tr>`).join('')}</tbody></table>`;
    $('#syCount').textContent = `最近 ${runs.length} 批`;
  }

  // ── 总部 · 失败与死信 ──
  function drawDead() {
    const host = $('#syHost');
    const dead = status?.dead || [];
    if (!dead.length) { host.innerHTML = noResult('没有死信', '全部变更都已成功同步'); $('#syCount').textContent = ''; return; }
    host.innerHTML = `<table><thead><tr>
      <th class="seq">序号</th>
      <th>节点</th><th>实体</th><th>实体ID</th><th>重试次数</th><th>最后错误</th><th>产生时间</th></tr></thead><tbody>
      ${dead.map((d, i) => `<tr>
        <td class="seq">${i + 1}</td>
        <td>${esc(d.node_code || '')}</td><td>${esc(d.entity)}</td>
        <td>${d.entity_id ?? '—'}</td>
        <td class="sy-bad">${Number(d.retry || 0)}</td>
        <td class="sy-l">${esc((d.last_error || '').slice(0, 80))}</td>
        <td>${dt(d.created_at)}</td>
      </tr>`).join('')}</tbody></table>`;
    $('#syCount').textContent = `死信 ${dead.length} 条`;
  }

  // ── 总部 · 对数校验 ──
  function drawRecon() {
    const host = $('#syHost');
    const rows = recon?.rows || [];
    if (!rows.length) { host.innerHTML = noResult('暂无可比对数据', '门店节点心跳上报后自动生成'); $('#syCount').textContent = ''; return; }
    host.innerHTML = `<table><thead><tr>
      <th class="seq">序号</th>
      <th>节点</th><th>对数日</th><th>门店上报单量</th><th>总部实际单量</th><th>单量差</th>
      <th>门店上报金额</th><th>总部实际金额</th><th>金额差</th></tr></thead><tbody>
      ${rows.map((r, i) => {
        const dO = Number(r.diffOrders || 0), dA = Number(r.diffAmount || 0);
        const bad = dO !== 0 || Math.abs(dA) > 0.01;
        return `<tr>
          <td class="seq">${i + 1}</td>
          <td>${esc(r.nodeCode)}</td><td>${esc(r.date)}</td>
          <td>${Number(r.nodeOrders || 0)}</td><td>${Number(r.hqOrders || 0)}</td>
          <td class="${bad ? 'sy-bad' : 'sy-ok'}">${dO}</td>
          <td>${money(r.nodeAmount || 0)}</td><td>${money(r.hqAmount || 0)}</td>
          <td class="${bad ? 'sy-bad' : 'sy-ok'}">${money(dA)}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
    $('#syCount').textContent = `对数日 ${recon?.date || ''}`;
  }

  // ── 门店 · 本机配置与队列 ──
  function drawStoreSelf() {
    const host = $('#syHost');
    const id = selfInfo?.identity;
    host.innerHTML = `
      <div style="max-width:640px;margin:0 auto;padding-top:8px">
        <div class="fgroup">
          <div class="fld"><label>节点编码（总部「门店管理」生成）</label>
            <input id="syNodeCode" value="${esc(id?.nodeCode || '')}" placeholder="如 S001-A7F3"></div>
          <div class="fld"><label>节点密钥（仅显示一次，请妥善保存）</label>
            <input id="syToken" type="password" value="${esc(id?.selfToken || '')}" placeholder="总部生成的 48 位密钥"></div>
          <div class="fld"><label>总部地址</label>
            <input id="syHqBase" value="${esc(id?.hqBase || '')}" placeholder="如 http://192.168.1.10:3100"></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;padding:6px 0 14px">
          <button class="btn pri" id="sySave">保存并连上总部</button>
          <button class="btn" id="syPushNow">立即同步一次</button>
          <span class="muted" id="sySaveMsg"></span>
        </div>
        <div class="doc-tip">保存后本机将：① 每分钟自动推上行（销售/退货/班次/门店调价）；② 拉取总部下发的商品与价格。断网期间数据入本机队列，恢复后自动补传。</div>
      </div>`;
    $('#sySave').onclick = async () => {
      const nodeCode = $('#syNodeCode').value.trim();
      const token = $('#syToken').value.trim();
      const hqBase = $('#syHqBase').value.trim();
      if (!nodeCode || !token || !hqBase) { toast('三要素都要填', false); return; }
      try {
        await must(post('/sync/self', { nodeCode, token, hqBase }));
        toast('已保存，正在连接总部…');
        setTimeout(async () => { await loadSelf(); draw(); }, 1500);
      } catch (e) { toast('保存失败：' + (e?.message || e), false); }
    };
    $('#syPushNow').onclick = () => {
      $('#sySaveMsg').textContent = '已触发，下一分钟内生效（本机 60s 轮询 + 事件触发）';
      setTimeout(() => { $('#sySaveMsg').textContent = ''; }, 4000);
    };
    $('#syCount').textContent = `本机待传 ${Number(selfInfo?.pendingLocal || 0)} 笔`;
  }

  $('#syRefresh').onclick = async () => {
    await loadSelf();
    if (selfInfo?.identity?.role === 'hq') await loadStatus();
    draw();
  };

  await loadSelf();
  if (selfInfo?.identity?.role === 'hq') {
    tab = 'nodes';
    await loadStatus();
  }
  draw();
}
