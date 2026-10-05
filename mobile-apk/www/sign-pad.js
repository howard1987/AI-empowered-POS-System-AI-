'use strict';
/* 员工移动端 PWA · 现场签名板（sign-pad.js）
 * V4.15.3：手机屏幕手写 → base64 → /purchase/signatures/attach
 * V4.16.5：新增 openCollect —— 手机采集签字样本专用：
 *   ① 一次连采 3 遍（后台无需分次发起）；② 横屏采集板 + 田字格引导（按 2字/3字姓名自动分格）
 *   ③ 提交后进入「待签收」，后台预览：签收 → 完成；退回 → 自动重新开始采集
 *   ④ 后台取消/过期 → 采集板自动关闭
 */
window.SignPad = {
  /**
   * 打开签名板（单次签字：单据补签等场景）
   * @param o { title, hint?, defaultName?, operatorName?, onSave }
   *   onSave(signData): signData = { personName, roleTitle, image(base64 png) }
   */
  open(o) {
    if (document.querySelector('#signPadModal')) return;
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = 'signPadModal';
    m.innerHTML = `<div class="sheet" style="padding:16px">
      <div style="display:flex;align-items:center;margin-bottom:8px">
        <b style="flex:1;font-size:15px">✍️ ${esc(o.title || '现场签名')}</b>
        <button class="mini-btn" id="spClose">关闭</button>
      </div>
      <div class="hint" style="margin:0 0 10px">${esc(o.hint || '请签字人在手机屏幕手写签名，提交后随单据留痕')}</div>
      <div class="field"><label>签字人姓名</label>
        <input id="spName" type="text" value="${esc(o.defaultName || '')}" placeholder="签字人姓名" style="font-size:15px"></div>
      <div style="margin:10px 0 6px;font-size:13px;color:var(--ink-3)">签字区（手指/手写笔书写）</div>
      <canvas id="spPad" width="680" height="220"
        style="width:100%;height:170px;border:1px dashed var(--line);border-radius:10px;touch-action:none;background:#fff;display:block"></canvas>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn ghost" id="spClear" style="flex:1">清除重签</button>
        <button class="btn ok" id="spSave" style="flex:1.6">✅ 确认提交签名</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    const pad = m.querySelector('#spPad');
    bindInk(pad);
    const dirty = () => padInkDirty(pad);
    const close = () => m.remove();
    m.querySelector('#spClose').onclick = close;
    m.querySelector('#spClear').onclick = () => pad.getContext('2d').clearRect(0, 0, pad.width, pad.height);
    m.querySelector('#spSave').onclick = () => {
      const name = m.querySelector('#spName').value.trim();
      if (!name) { toast('请填写签字人姓名'); return; }
      if (!dirty()) { toast('请先在签字区手写签名'); return; }
      const btn = m.querySelector('#spSave');
      btn.disabled = true; btn.textContent = '提交中…';
      try {
        o.onSave({ personName: name, roleTitle: o.roleTitle || '业务员', image: pad.toDataURL('image/png') });
        close();
      } catch (e) { btn.disabled = false; btn.textContent = '✅ 确认提交签名'; toast(e.message); }
    };
  },

  /**
   * V4.16.5 手机采集模式（预采集样本 / 远程补签共用入口）：
   *   nameLen 选 2/3 → 田字格分格引导；连采 samples 遍（默认 3）；onDone({ personName, images:[...] })
   *   watch(): 每次采集前/提交后轮询请求状态，后台取消/过期自动关闭；退回重签自动重来
   * @param o { reqId, reqNo, title, personHint?, bizRef?, samples?, onDone, getDetail, onSubmit }
   */
  openCollect(o) {
    if (document.querySelector('#signPadModal')) return;
    const NEED = Math.max(1, Math.min(3, Number(o.samples) || 3));
    const hintName = String(o.personHint || '').trim();
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = 'signPadModal';
    m.innerHTML = `<div class="sheet" style="padding:14px">
      <div style="display:flex;align-items:center;margin-bottom:6px">
        <b style="flex:1;font-size:15px">✍️ ${esc(o.title || '手机采集签名')}</b>
        <span class="pill orange" style="margin-right:6px">取件码 ${esc(o.reqNo || '')}</span>
        <button class="mini-btn" id="spClose">关闭</button>
      </div>
      <div class="hint" id="spStage" style="margin:0 0 8px">建议横屏书写。请选择姓名字数（田字格引导）：</div>
      <div style="display:flex;gap:8px;margin-bottom:8px" id="spLenBar">
        <button class="btn ghost" data-len="2" style="flex:1">2字名字</button>
        <button class="btn ghost" data-len="3" style="flex:1">3字名字</button>
      </div>
      <div class="field" id="spNameRow"><label>签字人姓名</label>
        <input id="spName" type="text" value="${esc(hintName)}" placeholder="签字人姓名" style="font-size:15px"></div>
      <canvas id="spPad" width="900" height="240"
        style="width:100%;height:200px;border:1px dashed var(--line);border-radius:10px;touch-action:none;background:#fff;display:block"></canvas>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="spClear" style="flex:1">清除重写</button>
        <button class="btn ok" id="spSave" style="flex:1.6">✅ 第 1/` + NEED + ` 遍确认</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    const pad = m.querySelector('#spPad');
    bindInk(pad);
    const nameIn = m.querySelector('#spName');
    const stage = m.querySelector('#spStage');
    const saveBtn = m.querySelector('#spSave');
    let nameLen = [2, 3].includes(hintName.length) ? hintName.length : 0;   // 有提示名自动选格
    let cellCount = 0, round = 0, images = [], closed = false, submitting = false;
    const drawGrid = () => {
      const ctx = pad.getContext('2d');
      ctx.clearRect(0, 0, pad.width, pad.height);
      if (!cellCount) return;
      ctx.save();
      ctx.strokeStyle = '#9db8d8'; ctx.lineWidth = 1.4; ctx.setLineDash([7, 7]);
      const cw = pad.width / cellCount;
      for (let i = 1; i < cellCount; i++) {           // 格间分隔线
        ctx.beginPath(); ctx.moveTo(i * cw, 10); ctx.lineTo(i * cw, pad.height - 10); ctx.stroke();
      }
      for (let i = 0; i < cellCount; i++) {           // 每格田字虚线
        const cx = i * cw + cw / 2;
        ctx.beginPath(); ctx.moveTo(cx, 12); ctx.lineTo(cx, pad.height - 12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i * cw + 10, pad.height / 2); ctx.lineTo((i + 1) * cw - 10, pad.height / 2); ctx.stroke();
      }
      ctx.restore();
    };
    const setLen = n => {
      nameLen = n; cellCount = n;
      m.querySelectorAll('#spLenBar [data-len]').forEach(b =>
        b.style.background = Number(b.dataset.len) === n ? 'var(--ok, #2e8b57)' : '');
      m.querySelectorAll('#spLenBar [data-len]').forEach(b =>
        b.style.color = Number(b.dataset.len) === n ? '#fff' : '');
      drawGrid();
      stage.textContent = `建议横屏书写。请在 ${n} 个田字格内逐字书写「${esc(nameIn.value.trim() || '姓名')}」（第 ${round + 1}/${NEED} 遍）`;
    };
    m.querySelectorAll('#spLenBar [data-len]').forEach(b => b.onclick = () => setLen(Number(b.dataset.len)));
    if (nameLen) setLen(nameLen); else stage.textContent = '建议横屏书写。请先选择姓名字数（田字格引导）：';
    nameIn.addEventListener('input', () => { if (nameLen) setLen(nameLen); });
    const clearPad = () => { pad.getContext('2d').clearRect(0, 0, pad.width, pad.height); drawGrid(); };
    m.querySelector('#spClear').onclick = clearPad;
    const close = () => { closed = true; try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch {} m.remove(); };
    m.querySelector('#spClose').onclick = close;
    // 横屏引导（尽力而为：需用户手势与系统允许）
    const tryLandscape = () => {
      if (window.innerWidth > window.innerHeight) return;
      try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch {}
    };
    m.addEventListener('click', tryLandscape, { once: true });
    saveBtn.onclick = () => {
      if (submitting) return;
      const name = nameIn.value.trim();
      if (!name) { toast('请先填写签字人姓名'); return; }
      if (!nameLen) { toast('请先选择姓名字数（2字/3字）'); return; }
      if (!padInkDirty(pad)) { toast('请在田字格内手写签名'); return; }
      const ir = padInkRatio(pad);                     // V4.17.0：近空白/纯色块占位拒绝（与后台同口径）
      if (ir >= 0 && (ir < 0.001 || ir > 0.85)) { toast(ir < 0.001 ? '笔迹过少，请完整书写姓名' : '疑似整块涂色（非签名），请清除后正常书写'); return; }
      images.push(pad.toDataURL('image/png'));
      round++;
      if (round < NEED) {
        clearPad();
        saveBtn.textContent = `✅ 第 ${round + 1}/${NEED} 遍确认`;
        stage.textContent = `写得不错！再写第 ${round + 1}/${NEED} 遍（同一签名，利于形成签字画像）`;
        toast(`第 ${round}/${NEED} 遍已采集，请继续`);
        return;
      }
      submitting = true;
      saveBtn.disabled = true; saveBtn.textContent = '提交中…';
      stage.textContent = '已采集 3 遍，提交后台签收…';
      Promise.resolve(o.onSubmit({ personName: name, images }))
        .then(() => {
          stage.textContent = '✅ 已提交，等待后台预览签收…（退回将自动重新采集）';
          watchReturn();
        })
        .catch(e => {
          submitting = false;
          saveBtn.disabled = false; saveBtn.textContent = `✅ 第 ${NEED}/${NEED} 遍确认`;
          toast('提交失败：' + (e.message || e));
        });
    };
    /** 提交后监听：退回 → 重采；签收/取消/过期 → 收尾 */
    async function watchReturn() {
      while (!closed) {
        await new Promise(r => setTimeout(r, 3000));
        if (closed) return;
        let d = null;
        try { d = await o.getDetail(); } catch { continue; }
        const st = String(d && d.status || '');
        if (st === '待签字' && Number(d.attempts || 0) > 0) {
          toast(`后台退回重签：${d.returnNote || '预览不合格，请重写'}`);
          images = []; round = 0; submitting = false;
          saveBtn.disabled = false; saveBtn.textContent = '✅ 第 1/' + NEED + ' 遍确认';
          clearPad(); setLen(nameLen);
          return;                      // 回到采集循环
        }
        if (st === '已签字') { toast('✅ 后台已签收，签名生效'); close(); return; }
        if (['已取消', '已过期'].includes(st)) { toast(`采集已${st}（后台取消即失效）`); close(); return; }
      }
    }
    /** 未提交阶段也监听取消：后台点取消 → 手机端随即关闭采集板（④ 指令失效） */
    (async function watchCancel() {
      while (!closed && round === 0) {
        await new Promise(r => setTimeout(r, 4000));
        if (closed || round > 0) return;
        let d = null;
        try { d = await o.getDetail(); } catch { continue; }
        if (['已取消', '已过期'].includes(String(d && d.status || ''))) {
          toast('后台已取消采集，本指令失效'); close(); return;
        }
      }
    })();
  },
};

/* ── 公共：压感绑定 / 脏判定 ── */
function bindInk(pad) {
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, last = null;
  const pos = e => {
    const r = pad.getBoundingClientRect();
    return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height };
  };
  pad.onpointerdown = e => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); };
  pad.onpointermove = e => { if (!drawing) return; const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; };
  pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
}
function padInkDirty(pad) {
  const d = pad.getContext('2d').getImageData(0, 0, pad.width, pad.height).data;
  return d.some(v => v !== 0);
}
/** V4.17.0：墨量占比（0~1）；异常返回 -1 —— 与后台签名管理页同一双阈值口径 */
function padInkRatio(pad) {
  try {
    const d = pad.getContext('2d').getImageData(0, 0, pad.width, pad.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      if (d[i] + d[i + 1] + d[i + 2] < 620) ink++;
    }
    return ink / (pad.width * pad.height);
  } catch { return -1; }
}
