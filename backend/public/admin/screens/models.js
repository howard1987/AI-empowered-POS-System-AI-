import { get, post, put, must, esc, toast } from '../api.js';

/** AI 模型管理（M1）：本地大模型为主 · 规则为辅
 *  GET /ai/models/runtime —— 运行时状态（自动探测/手动路径 → 已安装模型清单）
 *  POST /ai/models/scan   —— 手动识别（服务地址 或 安装/数据路径）
 *  POST /ai/models/select —— 设为主模型（qa/日报/识别兜底生效）
 *  POST /ai/models/auto   —— 重新自动探测（成功即接管）
 *  PUT /settings/ai.llm.enabled —— 大模型开关（关=规则引擎兜底） */
export async function render(view) {
  view.innerHTML = `
    <style>
      .llm-state { display:flex; align-items:center; gap:10px; margin:8px 0; flex-wrap:wrap; }
      .llm-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
    </style>
    <div class="card">
      <h3>🔌 接入配置 </h3>
      <div class="bar">
        <select id="mMode" style="width:150px">
          <option value="auto">自动探测</option>
          <option value="manual">手动识别</option>
          <option value="none">未接入（规则兜底）</option>
        </select>
        <button class="btn" id="mModeGo">保存接入模式</button>
        <span class="muted" id="mState"></span>
      </div>
      <div class="bar">
        <span class="muted">服务地址</span>
        <input id="mBase" placeholder="http://localhost:11434" style="width:230px">
        <button class="btn" id="mScanBase">扫描（服务地址）</button>
      </div>
      <div class="bar">
        <span class="muted">安装/数据路径</span>
        <input id="mPath" placeholder="如 D:\\Ollama 或 C:\\Users\\xxx\\.ollama" style="width:280px">
        <button class="btn" id="mScanPath">扫描（路径）</button>
      </div>
      <div class="bar">
        <button class="btn pri" id="mAuto">🔄 重新自动探测</button>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="mEnabled">
          <span>启用本地大模型问答增强（关 = 纯规则引擎，零依赖）</span>
        </label>
      </div>
    </div>
    <div class="card">
      <h3>📦 已安装模型 </h3>
      <div id="mList" class="mt8"></div>
    </div>
    <div class="card">
      <h3>💡 兜底策略说明</h3>
      <div class="muted">接入模式 = <b>自动探测</b>：优先访问服务地址 /api/tags 取模型清单；不可达且配置了安装路径时自动解析本地 manifests。
      接入模式 = <b>手动识别</b>：仅按配置的服务地址或安装路径识别。
      接入模式 = <b>未接入</b>：完全离线，问答/日报/识别兜底全部走内置规则引擎。
      主模型 = 自然语言问答、AI 日报、识别低置信度兜底使用的模型；识别主链路仍为本地 YOLO/ONNX 模型。</div>
    </div>`;

  const $ = id => view.querySelector(id.startsWith('#') ? id : '#' + id);

  async function load() {
    const r = await must(get('/ai/models/runtime'));
    $('#mMode').value = r.mode || 'auto';
    $('#mBase').value = r.base || '';
    $('#mPath').value = r.path || '';
    $('#mEnabled').checked = !!r.enabled;
    const dot = r.reachable ? '<span class="llm-dot" style="background:#2e9e5b"></span>' : '<span class="llm-dot" style="background:#c0392b"></span>';
    $('#mState').innerHTML = dot + (r.reachable
      ? ` 已识别：${esc(r.source)} · ${r.models.length} 个模型`
      : ` 未连接：${esc(r.err || '待探测')}`) + ` · 主模型：<b>${esc(r.selected)}</b>${r.selectedKnown ? '' : '（清单中不存在）'}`;
    const rows = r.models || [];
    $('#mList').innerHTML = rows.length ? `
      <table><thead><tr><th>模型</th><th class="num">大小</th><th>族</th><th>量化</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows.map(m => `<tr>
        <td style="font-family:Consolas,monospace">${esc(m.name)}</td>
        <td class="num">${m.size ? (m.size / 1e9).toFixed(1) + ' GB' : '—'}</td>
        <td class="muted">${esc(m.family || '—')}</td>
        <td class="muted">${esc(m.quant || '—')}</td>
        <td>${m.name === r.selected ? '<span class="tag g">主模型</span>' : '<span class="tag y">候选</span>'}</td>
        <td>${m.name === r.selected ? '' : `<button class="btn sm pri" data-sel="${esc(m.name)}">设为主模型</button>`}</td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="empty">未识别到已安装模型（检查 Ollama 服务是否启动 / 路径是否正确）</div>';
    view.querySelectorAll('[data-sel]').forEach(b => b.onclick = async () => {
      await must(post('/ai/models/select', { model: b.dataset.sel }), '主模型已切换');
      await load();
    });
  }

  $('#mModeGo').onclick = async () => {
    await must(put('/settings/ai.llm.mode', { value: $('#mMode').value, reason: 'AI 模型管理切换接入模式' }), '接入模式已保存');
    await load();
  };
  $('#mScanBase').onclick = async () => {
    const base = $('#mBase').value.trim();
    if (!base) return toast('请填写服务地址', false);
    const d = await must(post('/ai/models/scan', { base }), '已识别服务地址');
    $('#mList').innerHTML = `<div class="empty">识别到 ${d.models.length} 个模型（已写入配置）</div>`;
    await load();
  };
  $('#mScanPath').onclick = async () => {
    const path = $('#mPath').value.trim();
    if (!path) return toast('请填写安装/数据路径', false);
    const d = await must(post('/ai/models/scan', { path }), '已识别安装路径');
    $('#mList').innerHTML = `<div class="empty">识别到 ${d.models.length} 个模型（已写入配置）</div>`;
    await load();
  };
  $('#mAuto').onclick = async () => {
    await must(post('/ai/models/auto'), '自动探测成功，已接管接入模式');
    await load();
  };
  $('#mEnabled').onchange = async () => {
    await must(put('/settings/ai.llm.enabled', { value: $('#mEnabled').checked, reason: 'AI 模型管理切换大模型开关' }),
      $('#mEnabled').checked ? '本地大模型已启用（规则引擎兜底保留）' : '已切换为规则引擎模式');
    await load();
  };

  await load();
}
