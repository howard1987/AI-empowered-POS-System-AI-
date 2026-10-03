import { post, get, must, esc, toast } from '../api.js';
import { bindPad, padDirty, clearPad } from '../ui.js';

/**
 * P1-P2 电子签字通用组件（桌面端入库/退货/报损/盘点共用）
 *   signCell(row)          → 列表「签字」列：已签字/未签字徽标
 *   signBtn(id)            → 列表「补签」按钮（未签字单据显示）
 *   openSignPad(view,o)    → 现场补签弹窗（canvas 手写 → POST /purchase/signatures/attach）
 *   openSmsConfirm(view,o) → 大额·短信确认弹窗（6 位确认码 → POST /purchase/signatures/confirm）
 *   openCollectPad(view,o) → 预采集签字模板弹窗（供应商业务员 → POST /purchase/signatures）
 *   handleSignInfo(view,o) → 开单响应 signInfo 分流：needsLive→现场补签；needSms→短信确认
 *   mountSignActions(view) → 列表渲染后绑定 [data-sign]/[data-sms] 按钮事件
 */

/** 列表「签字」列：有 sign_record_id → 已签字，否则未签字（矩阵内单据过审前必须补齐） */
export function signCell(row) {
  const signed = Number(row.sign_record_id ?? row.signRecordId ?? 0) > 0;
  return signed
    ? '<span class="tag g">已签字</span>'
    : '<span class="tag y">未签字</span>';
}

/** 列表「补签」按钮（已签字不显示） */
export function signBtn(id) {
  return `<button class="btn sm" data-sign="${id}" title="现场手写补签留底">🖋 补签</button>`;
}

/** 开单响应 signInfo 分流（P1-1）：大额·现场补签需立即弹签字板；大额·短信确认弹确认码 */
export function handleSignInfo(view, signInfo, o) {
  if (!signInfo) return;
  if (signInfo.needsLive) {
    toast('该单据金额已达大额签字阈值，请现场补签', false);
    openSignPad(view, { ...o, title: '大额单据 · 现场补签（必签后才能过审）' });
  } else if (signInfo.needSms) {
    openSmsConfirm(view, { ...o, smsCode: signInfo.smsCode, personName: signInfo.personName });
  }
}

/** 现场补签弹窗：canvas 手写 → 落证据链并回填单据 sign_record_id */
export function openSignPad(view, o) {
  const box = ensureModal(view);
  box.querySelector('.sp-title').textContent = o.title || '电子签字 · 现场补签';
  box.querySelector('#spName').value = '';
  box.querySelector('#spRole').value = '';
  clearPad(box.querySelector('#spPad'));
  box.querySelector('#spTip').textContent =
    o.tip || '下方签字板手写签名后点「确认签字」；签字即留证据链并回填单据（必签场景审核前必须完成）';
  box.style.display = 'flex';
  // V4.15.3 手机采集：无手写板时发起远程请求，手机端 PWA「我的-电子签名」手写回传
  box.querySelector('#spRemote').onclick = () =>
    remoteCapture(view, box, `补签 ${o.bizType} #${o.bizId}`, async (images, name) => {
      await must(post('/purchase/signatures/attach', {
        bizType: o.bizType, bizId: o.bizId,
        personName: name, roleTitle: box.querySelector('#spRole').value.trim() || undefined,
        image: images[0],
      }), '手机签字已留存并回填单据');
      box.style.display = 'none';
      o.onDone?.();
    });
  box.querySelector('#spGo').onclick = async () => {
    const name = box.querySelector('#spName').value.trim();
    if (!name) return toast('签字人姓名必填', false);
    if (!padDirty(box.querySelector('#spPad'))) return toast('请先在签字板上签名', false);
    const image = box.querySelector('#spPad').toDataURL('image/png');
    await must(post('/purchase/signatures/attach', {
      bizType: o.bizType, bizId: o.bizId,
      personName: name, roleTitle: box.querySelector('#spRole').value.trim() || undefined,
      image,
    }), '签字已留存并回填单据');
    box.style.display = 'none';
    o.onDone?.();
  };
}

/** 大额·短信确认弹窗：操作员把确认码转达被签字人（线下核对 5.6.8③），输入后校验 */
export function openSmsConfirm(view, o) {
  const box = ensureModal(view);
  box.querySelector('.sp-title').textContent = '短信确认 · 大额单据签字';
  box.querySelector('#spName').value = o.personName || '';
  box.querySelector('#spRole').value = '';
  box.querySelector('#spTip').innerHTML =
    `单据已自动关联签字人 <b>${esc(o.personName || '业务员')}</b> 的预采签名，需被签字人确认。
     ${o.smsCode ? `<div style="margin-top:6px">确认码：<b style="font-size:18px;letter-spacing:4px;color:var(--pri)">${esc(o.smsCode)}</b>（请当面/电话转达被签字人）</div>` : ''}`;
  box.querySelector('#spPad').style.display = 'none';
  box.querySelector('.sp-padbar').style.display = 'none';
  box.querySelector('#spCode').style.display = '';
  box.querySelector('#spCodeIn').value = '';
  box.style.display = 'flex';
  box.querySelector('#spGo').onclick = async () => {
    const code = box.querySelector('#spCodeIn').value.trim();
    if (!/^\d{6}$/.test(code)) return toast('请输入 6 位数字确认码', false);
    await must(post('/purchase/signatures/confirm', { bizType: o.bizType, bizId: o.bizId, code }), '确认码校验通过，签字生效');
    box.style.display = 'none';
    o.onDone?.();
  };
}

/** 预采集签字模板弹窗（P2-2 供应商管理页）：采集即授权，绑定 supplierId 供入库/退货自动提取 */
export function openCollectPad(view, o) {
  const box = ensureModal(view);
  box.querySelector('.sp-title').textContent = o.title || '✍️ 预采集签字（业务员）';
  box.querySelector('#spName').value = o.personName || '';
  box.querySelector('#spRole').value = o.roleTitle || '业务员';
  clearPad(box.querySelector('#spPad'));
  box.querySelector('#spTip').textContent =
    o.tip || '下方签字板签名后点「确认签字」；采集即授权用于该供应商日后业务单据（入库/退货自动提取）';
  box.style.display = 'flex';
  // V4.15.3 手机采集：手机端手写预采样本（取件码核对），回传后走同一保存入口
  box.querySelector('#spRemote').onclick = () =>
    remoteCapture(view, box, `预采集 ${o.personName || ''}`.trim(), async (images, name) => {
      await must(post('/purchase/signatures', {
        personName: name, roleTitle: box.querySelector('#spRole').value.trim() || '业务员',
        images, supplierId: o.supplierId || undefined,
      }), '签字模板已保存（手机采集 · 采集即授权）');
      box.style.display = 'none';
      o.onDone?.();
    });
  box.querySelector('#spGo').onclick = async () => {
    const name = box.querySelector('#spName').value.trim();
    if (!name) return toast('签字人姓名必填', false);
    if (!padDirty(box.querySelector('#spPad'))) return toast('请先在签字板上签名', false);
    const image = box.querySelector('#spPad').toDataURL('image/png');
    await must(post('/purchase/signatures', {
      personName: name, roleTitle: box.querySelector('#spRole').value.trim() || '业务员',
      image, supplierId: o.supplierId || undefined,
    }), '签字模板已保存（采集即授权）');
    box.style.display = 'none';
    o.onDone?.();
  };
}

/** 列表渲染后绑定补签/短信按钮（data-sign=补签，data-sms=短信确认） */
export function mountSignActions(view, o) {
  view.querySelectorAll('[data-sign]').forEach(b => b.onclick = () =>
    openSignPad(view, { bizType: o.bizType, bizId: Number(b.dataset.sign), onDone: o.onDone }));
  view.querySelectorAll('[data-sms]').forEach(b => b.onclick = () =>
    openSmsConfirm(view, { bizType: o.bizType, bizId: Number(b.dataset.sms), onDone: o.onDone }));
}

/* ── 弹窗单例（每个 view 注入一份，样式对齐桌面通用 modal） ── */
function ensureModal(view) {
  let box = view.querySelector('.sp-modal');
  if (box) { box.querySelector('#spPad').style.display = ''; box.querySelector('.sp-padbar').style.display = ''; box.querySelector('#spCode').style.display = 'none'; return box; }
  box = document.createElement('div');
  box.className = 'modal-mask sp-modal';
  box.style.display = 'none';
  box.innerHTML = `
    <div class="modal">
      <h3 class="sp-title">电子签字</h3>
      <div class="doc-head" style="grid-template-columns:1fr 1fr;border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
        <div class="fld"><label class="req">签字人姓名</label><input id="spName" placeholder="如：王业务"></div>
        <div class="fld"><label>身份备注</label><input id="spRole" placeholder="业务员/供应商代表（选填）"></div>
      </div>
      <div class="doc-tip sp-tip" id="spTip">下方签字板手写签名后点「确认签字」</div>
      <canvas id="spPad" width="560" height="170" style="border:1px dashed var(--line);border-radius:8px;touch-action:none;cursor:crosshair"></canvas>
      <div class="bar sp-padbar" style="margin-top:8px">
        <button class="btn sm" id="spClear">🧽 清除重签</button>
        <button class="btn sm" id="spRemote" title="电脑没接手写板？发到手机上，签字人用手机屏幕手写">📱 手机采集</button>
      </div>
      <div class="fld" id="spCode" style="display:none;margin-top:6px">
        <label class="req">6 位确认码</label>
        <input id="spCodeIn" placeholder="被签字人收到的确认码" style="letter-spacing:6px;font-size:16px">
      </div>
      <div class="doc-foot">
        <button class="btn" id="spCancel">取消</button>
        <span style="flex:1"></span>
        <button class="btn pri" id="spGo">✔ 确认签字</button>
      </div>
    </div>`;
  bindPad(box.querySelector('#spPad'));
  box.querySelector('#spClear').onclick = () => clearPad(box.querySelector('#spPad'));
  box.querySelector('#spCancel').onclick = () => { box.style.display = 'none'; };
  box.querySelector('#spCodeIn').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  box.addEventListener('click', e => { if (e.target === box) box.style.display = 'none'; });
  view.appendChild(box);
  return box;
}

/* ── V4.15.3 手机采集 / V4.16.5 重构：预览签收+退回重签 ──
 * 流程：POST /sign-remote 建请求（6 位取件码）→ 提示签字人 → 每 2.5s 轮询 GET /sign-remote?id=
 * → 手机连采样本提交（status=待签收，返回样本图组）→ 后台预览：
 *   ✅ 签收 → POST /:id/accept → submit(images, name) 走既有 attach/预采集入口落证据链
 *   ↩ 退回 → POST /:id/return（可带原因）→ 手机端自动重新采集，继续轮询
 * 取消：点「取消」→ POST /:id/cancel → 手机端采集板自动关闭（指令失效） */
async function remoteCapture(view, box, bizRef, submit) {
  const tip = box.querySelector('#spTip');
  const btn = box.querySelector('#spRemote');
  const cancelBtn = box.querySelector('#spCancel');
  const origTip = tip.innerHTML;
  let stopped = false, reqId = null;
  const stop = () => { stopped = true; btn.disabled = false; tip.innerHTML = origTip; };
  const cancelReq = async () => {
    if (stopped) return;
    stop();
    if (reqId) { try { await post(`/sign-remote/${reqId}/cancel`); } catch { /* 已处理 */ } }
  };
  btn.disabled = true;
  cancelBtn.addEventListener('click', cancelReq, { once: true });
  box.addEventListener('click', e => { if (e.target === box) cancelReq(); }, { once: true });
  try {
    const r = await must(post('/sign-remote', {
      title: `${box.querySelector('.sp-title').textContent} · 手机采集`.slice(0, 120),
      personHint: box.querySelector('#spName').value.trim() || undefined,
      bizRef,
    }));
    reqId = r.id;
    tip.innerHTML = `📱 手机采集中：请签字人打开手机端「<b>我的 → 电子签名</b>」，找到取件码 ` +
      `<b style="font-size:17px;letter-spacing:3px;color:var(--pri)">${esc(r.req_no)}</b> 的请求，连写 3 遍提交。<br>` +
      `<span class="muted">等待手机签字…（30 分钟内有效；点「取消」立即失效）</span>`;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!stopped) {
      if (Date.now() > deadline) { toast('手机采集超时：请重试或改用本机手写', false); stop(); return; }
      await new Promise(res => setTimeout(res, 2500));
      if (stopped) return;
      let d = null;
      try { d = await must(get('/sign-remote?id=' + r.id)); } catch { continue; }
      // 手机端已提交 → 后台预览签收/退回
      if (d.status === '待签收' && (d.images || []).length) {
        const ok = await previewSign(box, d);
        if (ok === 'accept') {
          await must(post(`/sign-remote/${r.id}/accept`));
          stop();
          toast(`已签收「${d.personName || '签字人'}」的手机签名，正在留存…`);
          await submit(d.images, d.personName || box.querySelector('#spName').value.trim() || '签字人');
          return;
        }
        if (ok === 'return') {           // 退回后手机端自动重采，继续轮询
          tip.innerHTML = `↩ 已退回重签，等待手机重新提交…<span class="muted">（取件码 ${esc(r.req_no)}）</span>`;
          continue;
        }
        continue;                        // 关闭预览未选择 → 继续等待
      }
      if (d.status === '已签字') {
        stop();
        toast(`已签收「${d.personName || '签字人'}」的手机签名，正在留存…`);
        await submit(d.images && d.images.length ? d.images : [d.image], d.personName || box.querySelector('#spName').value.trim() || '签字人');
        return;
      }
      if (d.status !== '待签字') { toast(`手机采集已${d.status}`, false); stop(); return; }
    }
  } catch (e) {
    toast(e?.msg || e?.message || '发起手机采集失败', false);
    stop();
  }
}

/** 签收预览：弹独立小窗展示 3 张样本，返回 'accept' | 'return' | null */
function previewSign(box, d) {
  return new Promise(resolve => {
    const pv = document.createElement('div');
    pv.className = 'modal-mask';
    pv.style.zIndex = '10001';
    pv.innerHTML = `
      <div class="modal" style="width:560px;max-width:94vw">
        <h3>📱 手机签名预览 · ${esc(d.personName || '签字人')}</h3>
        <div class="doc-tip">手机端连采 ${(d.images || []).length} 遍。合格请点「签收」进入留存；不合格点「退回重签」，手机端将自动重新采集。</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">
          ${(d.images || []).map((img, i) => `<div style="text-align:center">
            <img src="${esc(img)}" style="width:160px;height:76px;object-fit:contain;border:1px dashed var(--line);border-radius:8px;background:#fff">
            <div class="muted" style="font-size:11px">第 ${i + 1} 遍</div></div>`).join('')}
        </div>
        ${d.attempts > 0 ? `<div class="muted" style="font-size:12px">已退回 ${d.attempts} 次${d.returnNote ? ' · 上次原因：' + esc(d.returnNote) : ''}</div>` : ''}
        <div class="doc-foot">
          <button class="btn" id="pvClose">关闭（继续等待）</button>
          <span style="flex:1"></span>
          <button class="btn warn" id="pvBack">↩ 退回重签</button>
          <button class="btn pri" id="pvOk">✅ 签收</button>
        </div>
      </div>`;
    document.body.appendChild(pv);
    const done = v => { pv.remove(); resolve(v); };
    pv.querySelector('#pvOk').onclick = () => done('accept');
    pv.querySelector('#pvClose').onclick = () => done(null);
    pv.querySelector('#pvBack').onclick = () => {
      const note = prompt('退回原因（手机端可见，可留空）：') || '';
      must(post(`/sign-remote/${d.id}/return`, { note })).then(() => done('return')).catch(() => done(null));
    };
    pv.addEventListener('click', e => { if (e.target === pv) done(null); });
  });
}
