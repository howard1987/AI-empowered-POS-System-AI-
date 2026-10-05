'use strict';
/* V4.27.5 · 多商品同拍采集 · 人工纠错版（共享组件：收银台 AI 采集弹窗 / PWA 作业页通用）
 * ==================================================================================================
 * 核心场景：AI 秤上同时放多个商品 → 收银台一次识别全部并结算。多品同拍采集=核心训练数据来源。
 *
 * 流程：摄像头/相册取一帧（画面摆 2~10 个商品）→ POST /ai/recognize(mode=multi) 分层识别
 *   → 返回逐件明细 cropDetail（每件裁剪框 + 是否自动命中 + Top3 候选）：
 *     ① 自动命中  —— 绿标，默认勾选（置信度展示），免纠错直采；
 *     ② 待确认    —— 黄标，展示 Top3 候选点击即指定，或扫码/搜索指定正确商品；
 *     ③ 未识别    —— 红标，扫码/搜索指定商品（人工纠错，来源标记"人工纠错"供审核重点把关）；
 *     ④ 画面漏检  —— 「手动框选补采」在帧图上拉框后指定商品。
 *   → 勾选提交（≤10 个商品）→ 逐件裁剪 /upload → POST /ai/samples/batch-collect → 待审核。
 *
 * 权限设计：采集免店长放权（任何登录员工可闲时采集），店长/管理员在后台异步审核，不打断其工作。
 * 防反馈回路：自动命中件 = 过三门槛的高置信件；人工纠错件单独标记来源；全部待审核可批量驳回。
 * 依赖全局：call / unwrap / esc / toast / lookupProduct / watermarkImage（PWA 页面均已加载）。 */
window.AiBatchCollect = {
  open(opts = {}) {
    const MAXP = 10;                    // 单次最多商品数
    const scene = opts.scene || 'checkout';
    let stream = null;
    let frameData = '';                 // 识别帧 dataURL
    let frameImg = null;                // Image 对象（手动框选用）
    let items = [];                     // [{cropBox, hit, productId, name, conf, cands, checked}]
    let drawMode = false;               // 手动框选模式
    let drawStart = null, tempBox = null;
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="width:min(640px,94vw);max-height:calc(var(--vhs,100vh)*0.92);overflow:auto">
      <h3>📸 多商品同拍采集<button class="btn ghost mini-btn" id="bcX" style="float:right">关闭</button></h3>
      <div class="hint" style="margin-bottom:8px">把 <b>2~${MAXP}</b> 个商品平铺进画面 → 拍照识别 → 逐件核对：
        <b style="color:var(--ok)">绿=自动命中</b>、<b style="color:#c07f00">黄=点候选确认</b>、<b style="color:var(--bad)">红=扫码/搜索指定</b>。
        采集<b>无需店长放权</b>，提交后由店长/管理员后台审核。多换摆放组合多拍，样本越多样识别越准。</div>
      <video id="bcVideo" playsinline muted style="width:100%;max-height:220px;object-fit:cover;border-radius:10px;background:#000"></video>
      <div class="hint" id="bcCamHint" style="margin:6px 0">摄像头检测中…</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="btn" id="bcShot" style="flex:1">📸 拍照识别</button>
        <button class="btn ghost" id="bcFile" style="flex:1">📁 从相册选择</button>
      </div>
      <div id="bcRes"><div class="hint">尚未识别。摆好商品后点「拍照识别」。</div></div>
      <div id="bcDrawWrap" style="display:none;margin-top:8px">
        <div class="hint" style="margin-bottom:4px">✏️ 框选模式：在下方帧图上<b>拖拽拉框</b>圈住漏检商品，松开后为其指定商品。</div>
        <canvas id="bcCanvas" style="width:100%;border-radius:10px;cursor:crosshair;touch-action:none"></canvas>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="bcDraw" style="flex:1">✏️ 手动框选补采（漏检商品）</button>
        <button class="btn ok" id="bcGo" style="flex:2" disabled>提交训练样本</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    const $ = s => m.querySelector(s);
    const close = () => { if (stream) stream.getTracks().forEach(t => t.stop()); m.remove(); };
    $('#bcX').onclick = close;

    const stopBtns = () => { const b1 = $('#bcShot'); if (b1) { b1.disabled = false; b1.textContent = '📸 拍照识别'; } renderGo(); };
    const assignedCount = () => items.filter(x => x.checked && x.productId).length;

    /* 取帧 */
    const grabFrame = () => {
      const v = $('#bcVideo');
      if (stream && v && v.videoWidth) {
        const MAX_W = 1280, MAX_H = 720;
        const k = Math.min(1, MAX_W / v.videoWidth, MAX_H / v.videoHeight);
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.8);
      }
      return '';
    };
    const fromFile = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment'; inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.onchange = async () => {
        const f = inp.files[0]; inp.remove();
        if (!f) return;
        try {
          frameData = await watermarkImage(f, `多品同拍 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
          await recognize();
        } catch (e) { toast('读取失败：' + (e.message || e)); }
      };
      inp.click();
    };

    /* 裁剪：帧 + cropBox(原图坐标) → dataURL */
    const cropDataUrl = box => new Promise((res, rej) => {
      const img = frameImg || new Image();
      const done = () => {
        const pad = 6;
        const x0 = Math.max(0, Math.round(box.x - pad)), y0 = Math.max(0, Math.round(box.y - pad));
        const w = Math.min(img.width - x0, Math.round(box.w + pad * 2)), h = Math.min(img.height - y0, Math.round(box.h + pad * 2));
        if (w < 8 || h < 8) { rej(new Error('裁剪区过小')); return; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, x0, y0, w, h, 0, 0, w, h);
        res(c.toDataURL('image/jpeg', 0.85));
      };
      if (img.complete && img.naturalWidth) done();
      else { img.onload = done; img.onerror = () => rej(new Error('帧图加载失败')); img.src = frameData; }
    });

    /* ── 结果渲染 ── */
    const badge = it => it.hit
      ? `<span class="pill blue">${Math.round((it.conf || 0) * 100)}% 自动命中</span>`
      : `<span class="pill" style="background:#fff6e5;color:#c07f00">${it.cands.length ? '待确认' : '未识别'}</span>`;
    const renderItems = () => {
      if (!items.length) {
        $('#bcRes').innerHTML = `<div class="hint">⚠ 本帧没有检出商品件。<br>
          建议：商品平铺不堆叠、光线充足再拍一次；或「手动框选补采」圈住商品并指定；新商品请先走单品 6 角度采集建库。</div>`;
        return;
      }
      $('#bcRes').innerHTML = `<div class="sec">逐件核对（勾选 = 入训练样本，待店长审核；上限 ${MAXP} 个）</div>` + items.map((it, i) => `
        <div class="row" style="padding:6px 0;align-items:flex-start">
          <label style="display:flex;align-items:flex-start;gap:8px;flex:1;min-width:0">
            <input type="checkbox" data-bci="${i}" style="margin-top:4px" ${it.checked ? 'checked' : ''} ${it.productId ? '' : 'disabled'}>
            <img data-bct="${i}" style="width:52px;height:52px;object-fit:cover;border-radius:8px;background:#eef1f4;flex:none">
            <span style="flex:1;min-width:0">
              <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                ${it.productId ? `<b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;display:inline-block">${esc(it.name)}</b>` : '<b style="color:var(--bad)">未指定商品</b>'}
                ${badge(it)}
              </span>
              ${it.hit ? '' : `
                ${it.cands.length ? `<div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap">候选：
                  ${it.cands.map((c, ci) => `<button class="mini-btn" data-bcc="${i}:${ci}" style="padding:2px 8px">${esc(c.name)} ${Math.round(c.conf * 100)}%</button>`).join('')}</div>` : ''}
                <div style="margin-top:3px;display:flex;gap:4px">
                  <input data-bcs="${i}" placeholder="扫码/输条码或名称，回车指定" autocomplete="off"
                    style="flex:1;min-width:0;padding:4px 8px;border:1px solid var(--line);border-radius:8px;font-size:12.5px">
                </div>`}
            </span>
          </label>
        </div>`).join('');
      // 缩略图
      $('#bcRes').querySelectorAll('[data-bct]').forEach(img => {
        const it = items[Number(img.dataset.bct)];
        cropDataUrl(it.cropBox).then(u => { img.src = u; }).catch(() => {});
      });
      // 勾选
      $('#bcRes').querySelectorAll('input[data-bci]').forEach(cb => cb.onchange = () => {
        const it = items[Number(cb.dataset.bci)];
        if (!cb.checked) { it.checked = false; renderGo(); return; }
        if (assignedCount() >= MAXP) { cb.checked = false; toast(`一次最多提交 ${MAXP} 个商品，超出部分请下一轮采集`); return; }
        it.checked = !!it.productId; cb.checked = it.checked; renderGo();
      });
      // 候选点击
      $('#bcRes').querySelectorAll('[data-bcc]').forEach(b => b.onclick = () => {
        const [i, ci] = b.dataset.bcc.split(':').map(Number);
        const it = items[i]; const c = it.cands[ci];
        it.productId = c.productId; it.name = c.name; it.conf = c.conf; it.checked = true;
        renderItems(); renderGo();
      });
      // 搜索指定（回车提交；扫码枪扫入自动回车）
      $('#bcRes').querySelectorAll('[data-bcs]').forEach(inp => inp.addEventListener('keydown', async e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const i = Number(inp.dataset.bcs);
        const kw = String(inp.value || '').trim();
        if (!kw) return;
        try {
          const p = await lookupProduct(kw);
          if (!p) { toast('未找到商品：' + kw); return; }
          const it = items[i];
          it.productId = Number(p.id); it.name = p.name; it.conf = null; it.checked = true;
          inp.value = '';
          renderItems(); renderGo();
          toast(`✅ 已指定：${p.name}（人工纠错，审核时重点把关）`);
        } catch (e2) { toast(e2.message || '查询失败'); }
      }));
    };
    const renderGo = () => {
      const go = $('#bcGo');
      const n = assignedCount();
      go.disabled = !n;
      go.textContent = n ? `提交训练样本（${n} 个商品）` : '提交训练样本';
    };

    /* 识别 → 组装逐件明细 */
    const recognize = async () => {
      const shot = $('#bcShot');
      shot.disabled = true; shot.textContent = '识别中…';
      $('#bcRes').innerHTML = '<div class="hint">识别中…（条码 → CLIP 逐件检索）</div>';
      try {
        const d = unwrap(await call('POST', '/ai/recognize', { imageBase64: frameData, scene, mode: 'multi' }));
        frameImg = new Image(); frameImg.src = frameData;
        const detail = Array.isArray(d.cropDetail) ? d.cropDetail : [];
        items = detail.map(x => ({
          cropBox: x.cropBox,
          hit: !!x.hit,
          productId: x.hit ? Number(x.productId) : null,
          name: x.hit ? x.name : null,
          conf: x.hit ? x.conf : null,
          cands: (x.cands || []).filter(c => c.productId),
          checked: !!x.hit,
        }));
        $('#bcDrawWrap').style.display = items.length ? '' : 'none';
        setupCanvas();
        renderItems(); renderGo();
        const nHit = items.filter(x => x.hit).length;
        if (!items.length) toast('本帧未检出商品件：请调整摆放/光线重拍，或手动框选补采');
        else if (nHit < items.length) toast(`${nHit} 件自动命中，${items.length - nHit} 件待纠错：点候选或扫码/搜索指定后即可一并提交`);
      } catch (e) {
        items = [];
        $('#bcRes').innerHTML = `<div class="hint">识别失败：${esc(e.message || e)}（可重拍重试，或改单品 6 角度采集）</div>`;
        renderGo();
      } finally { stopBtns(); }
    };

    /* ── 手动框选补采（漏检商品）：帧图画布拉框 → 新增"未识别"件 → 指定商品 ── */
    const setupCanvas = () => {
      const cv = $('#bcCanvas');
      if (!cv || !frameData) return;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 560 / Math.max(img.width, img.height));
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        const ctx = cv.getContext('2d');
        const redraw = () => {
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          if (tempBox) {
            ctx.strokeStyle = '#f5a623'; ctx.lineWidth = 2;
            ctx.strokeRect(tempBox.x * scale, tempBox.y * scale, tempBox.w * scale, tempBox.h * scale);
          }
        };
        img._redraw = redraw; redraw();
        const pos = ev => { const r = cv.getBoundingClientRect(); return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) }; };
        cv.onpointerdown = ev => { if (!drawMode) return; drawStart = pos(ev); tempBox = null; cv.setPointerCapture(ev.pointerId); };
        cv.onpointermove = ev => {
          if (!drawMode || !drawStart) return;
          const p = pos(ev);
          tempBox = { x: Math.round(Math.min(drawStart.x, p.x) / scale), y: Math.round(Math.min(drawStart.y, p.y) / scale),
                      w: Math.round(Math.abs(p.x - drawStart.x) / scale), h: Math.round(Math.abs(p.y - drawStart.y) / scale) };
          redraw();
        };
        cv.onpointerup = () => {
          if (!drawMode || !tempBox) { drawStart = null; return; }
          if (tempBox.w < 16 || tempBox.h < 16) { tempBox = null; redraw(); return; }
          items.push({ cropBox: tempBox, hit: false, productId: null, name: null, conf: null, cands: [], checked: false });
          tempBox = null; drawStart = null;
          renderItems(); renderGo();
          toast('已框选：请在列表中为该件指定商品（扫码/搜索）');
        };
      };
      img.src = frameData;
    };
    $('#bcDraw').onclick = () => {
      if (!frameData) { toast('请先拍照识别，再框选补采'); return; }
      drawMode = !drawMode;
      $('#bcDraw').textContent = drawMode ? '✏️ 框选中（再点退出）' : '✏️ 手动框选补采（漏检商品）';
      $('#bcDrawWrap').style.display = frameData ? '' : 'none';
    };

    /* 提交：勾选且已指定商品 → 裁剪 /upload → batch-collect */
    $('#bcGo').onclick = async () => {
      const go = $('#bcGo');
      const list = items.filter(x => x.checked && x.productId).slice(0, MAXP);
      if (!list.length) { toast('请先为要采集的件指定商品（候选点击或扫码/搜索）'); return; }
      go.disabled = true; go.textContent = '裁剪上传中…';
      try {
        const payloads = [];
        for (const it of list) {
          const crop = await cropDataUrl(it.cropBox);
          const u = unwrap(await call('POST', '/upload', { image: crop }));
          payloads.push({ productId: it.productId, imagePath: u.path, conf: it.conf, angle: '俯拍', manual: !it.hit });
        }
        const r = unwrap(await call('POST', '/ai/samples/batch-collect', { items: payloads }));
        const manualN = payloads.filter(p => p.manual).length;
        toast(`✅ 多品同拍采集完成：${r.collected} 个商品样本已入库（待店长审核${manualN ? `，其中 ${manualN} 件为人工纠错` : ''}）${r.failedCount ? `；${r.failedCount} 条失败` : ''}`);
        if (typeof opts.onDone === 'function') { try { opts.onDone(r.collected); } catch { /* 回调异常不阻断 */ } }
        close();
      } catch (e) {
        toast('提交失败：' + (e.message || e));
        go.disabled = false; renderGo();
      }
    };

    $('#bcShot').onclick = async () => {
      const data = grabFrame();
      if (!data) { toast('摄像头未就绪：请稍候，或用「从相册选择」'); return; }
      frameData = data;
      await recognize();
    };
    $('#bcFile').onclick = fromFile;

    /* 摄像头就绪检测（失败不阻断：文件上传兜底） */
    (async () => {
      const v = $('#bcVideo');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('#bcCamHint').textContent = '无摄像头：请用「从相册选择」上传照片'; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
        v.srcObject = stream; await v.play();
        $('#bcCamHint').textContent = '✅ 摄像头就绪：把 2~10 个商品平铺进画面后点「拍照识别」';
      } catch { $('#bcCamHint').textContent = '摄像头不可用：请用「从相册选择」上传照片'; }
    })();
  },
};
