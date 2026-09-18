'use strict';
/* 员工移动端 PWA · 共享 AI 多商品识别（ai-scan.js，M2 + 自动识别 · 真实样本匹配）
 * 打开相机 → 【自动连续识别】（1.6s/帧，无需手动拍照）→ 候选自动勾选 → 防抖累计数量 → 确认回调
 * 识别为【分层真实识别】：条码先行（秒级）→ CLIP 向量检索（毫秒级，Top-1 相似度达阈值自动命中）
 * → 未达标携带候选卡片人工确认 → VL/dHash 兜底。只认真实上传过样本的商品，拍其他物体一律「未识别」。
 * 数量策略：新商品 count=1；同商品"消失后重新出现"（如放入第二瓶）防抖 4s 自动 +1；
 *          持续在画面中不重复累计；识别数量有误可随时 ±/手动修改。 */
const AiScan = {
  /** 打开识别弹层
   *  opts: { scene:'checkout'|'intake'|'return'|'loss'|'count'|'order'|'transfer', title, onConfirm(items) }
   *  items: [{productId, name, count}] —— 勾选确认后回调 */
  open(opts) {
    const scene = opts.scene || 'checkout';
    const title = opts.title || 'AI 识别商品';
    const SCAN_FORMATS_LOCAL = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'data_matrix', 'codabar'];
    const DEBOUNCE_MS = 4000;   // 同商品"重新出现"计数防抖
    let stream = null, dataUrl = '', items = [];
    let autoOn = false, autoBusy = false, autoTimer = 0;
    let prevIds = new Set();        // 上一帧识别到的商品
    let lastIncAt = new Map();      // pid → 上次自动 +1 时间
    let stableRuns = 0, stableNotified = false, lastSig = '';
    let emptyRounds = 0;         // 连续空识别轮次（达阈值自动暂停，避免无效耗电等待）
    let lastLogId = 0;           // V4.11.3 最近一次识别日志 ID（纠正回传用）
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="padding:14px">
      <div style="display:flex;align-items:center;margin-bottom:8px">
        <b style="flex:1;font-size:15px">🤖 ${esc(title)}</b>
        <button class="mini-btn" id="asClose">关闭</button>
      </div>
      <div class="hint" style="margin:0 0 8px"><span id="asState">🔄 自动识别中… 带条码商品对准即秒识别；无条码商品需已采集样本</span></div>
      <div id="asGuide" class="hidden" style="background:#fff6e5;border:1px solid #f0d9a8;border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:13px;line-height:1.6">
        <b>⚠️ 还没有可用的识别样本</b><br>
        AI 识别只认真实拍过样本的商品（识别帧与样本库逐一比对），不会凭空猜测。<br>
        请先在「AI 训练采集」给商品拍满 6 个角度并经审核入库，之后即可识别。
        <button class="btn" id="asGoCollect" style="width:100%;margin-top:8px">📸 去采集样本</button>
      </div>
      <div id="asMulti" style="background:#e8f4ff;border:1px solid #bcd9f5;border-radius:10px;padding:8px 12px;margin-bottom:8px;font-size:12.5px;line-height:1.7">
        📸 <b>分步拍引导</b>：单张建议放 3~5 件，平铺不重叠，拍完自动累计<br>
        <span>已识别 <b id="mgK">0</b> 种 / <b id="mgP">0</b> 件 · 待确认 <b id="mgU" style="color:#c07f00">0</b> 件</span><span id="mgTip" style="color:#1a6fb5"></span>
      </div>
      <div id="asReshoot" class="hidden" style="background:#fdeeee;border:1px solid #eac8c6;border-radius:10px;padding:8px 12px;margin-bottom:8px;font-size:12.5px;line-height:1.6">
        🔁 <span id="asReshootTxt"></span>
        <button class="btn" id="asReshootGo" style="width:100%;margin-top:6px">📸 去补拍样本（建库增强）</button>
      </div>
      <video id="asVideo" playsinline muted style="width:100%;border-radius:12px;background:#000;max-height:44dvh;object-fit:cover"></video>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" id="asAuto" style="flex:1">⏸ 暂停自动</button>
        <button class="btn ghost" id="asShot" style="flex:1">📷 立即识别一次</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn ghost" id="asScan" style="flex:1">🔦 改用扫码加入</button>
        <button class="btn ghost" id="asHelp" style="flex:1">❓ 识别不出？</button>
      </div>
      <img id="asPrev" class="hidden" style="width:100%;border-radius:12px;margin-top:8px">
      <div class="sec" id="asSec" style="display:none">候选商品（数量可手动修改）</div>
      <div id="asList" class="hidden"></div>
      <button class="btn ok hidden" id="asOk" style="margin-top:10px">加入明细</button>
    </div>`;
    document.body.appendChild(m);
    const video = m.querySelector('#asVideo'), prev = m.querySelector('#asPrev');
    const listBox = m.querySelector('#asList'), sec = m.querySelector('#asSec'), okBtn = m.querySelector('#asOk');
    const stateEl = m.querySelector('#asState');
    const stop = () => { setAuto(false); if (autoTimer) clearInterval(autoTimer); if (stream) stream.getTracks().forEach(t => t.stop()); m.remove(); };
    m.querySelector('#asClose').onclick = stop;

    const setState = t => { stateEl.textContent = t; };

    /* ── V4.16.0 P6 易混补拍引导：相近候选无法自动区分 → 引导去随手拍补背面/侧面样本 ── */
    const showReshoot = r => {
      if (!r) return;
      const box = m.querySelector('#asReshoot');
      m.querySelector('#asReshootTxt').textContent = r.text || '';
      box.classList.remove('hidden');
      m.querySelector('#asReshootGo').onclick = () => {
        stop();
        if (typeof View !== 'undefined' && View.aiCollect) push('AI 训练采集', View.aiCollect);
        else toast('请从「作业」页进入 AI 训练采集补拍样本');
      };
    };

    /* ── V4.16.0 P6 分步拍引导：多件识别每轮回报件数账，待确认多时引导补拍 ── */
    const updateGuide = g => {
      if (!g) return;
      m.querySelector('#mgK').textContent = String(g.recognizedKinds ?? 0);
      m.querySelector('#mgP').textContent = String(g.recognizedPieces ?? 0);
      m.querySelector('#mgU').textContent = String(g.unconfirmedPieces ?? 0);
      m.querySelector('#mgTip').textContent = g.suggestMore
        ? ' 💡 待确认偏多：把没认出的几件分开摆平/换角度再拍一张即可累计'
        : ((g.recognizedPieces ?? 0) > 0 ? ' ✅ 本张识别良好，可继续补拍或直接加入' : '');
    };

    /* ── V4.9.8 兜底：识别不出时「改用扫码」——扫中的商品直接并入本次候选清单 ── */
    const scanFallback = () => {
      if (typeof Scanner === 'undefined' || !Scanner.start) { toast('扫码组件未加载，请返回后重试'); return; }
      const tmp = document.createElement('input');
      tmp.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(tmp);
      Scanner.start(tmp, async code => {
        tmp.remove();
        try {
          const p = await lookupProduct(code);
          if (p) {
            const it = items.find(x => x.productId === Number(p.id));
            if (it) { it.count += 1; it.conf = 1; it.checked = true; it.manual = true; it.aiSrc = 'barcode'; }
            else items.push({ productId: Number(p.id), name: p.name, count: 1, conf: 1, checked: true, manual: true, aiSrc: 'barcode' });
            sec.style.display = ''; listBox.classList.remove('hidden'); renderList();
            setState(`✅ 扫码命中「${p.name}」，可在下方改数量后加入`);
          } else {
            setState(`⚠️ 扫码未命中：${code}（该码未维护到商品档案，可改关键词搜索或先建档）`);
          }
        } catch (e) { setState('⚠️ 扫码查询失败：' + (e.message || '')); }
      });
    };
    m.querySelector('#asScan').onclick = scanFallback;
    m.querySelector('#asHelp').onclick = () => {
      toast('带条码商品对准条码秒识别；无条码商品走向量检索（毫秒级），未达阈值会弹候选卡片点选确认。没采集过样本的商品识别不出');
      setState('💡 条码 → 向量检索 → 候选确认 → VL 兜底，分层识别');
    };

    /* ── 条码优先识别（核心能力）：每帧检测画面内所有条码 → 各自定位商品 → 并入候选 ──
     *  带条码的商品（绝大多数零售品）无需依赖样本/dHash，直接可靠识别，秒级命中。
     *  dHash 仅作为无条码商品的相似度兜底（见服务端 /ai/recognize）。 */
    const mergeBarcodeHits = async () => {
      if (typeof BarcodeDecode === 'undefined' || !video.videoWidth) return false;
      let codes = [];
      try { codes = await BarcodeDecode.decode(video); }
      catch { return false; }
      const raw = codes.map(c => String(c.text || '').trim()).filter(Boolean);
      if (!raw.length) return false;
      let hitAny = false;
      for (const code of raw) {
        let p = null;
        try { if (typeof lookupProduct === 'function') p = await lookupProduct(code); } catch { p = null; }
        if (!p) continue;                       // 非商品条码（如 URL/文本）→ 跳过
        const pid = Number(p.id);
        const it = items.find(x => x.productId === pid);
        if (!it) { items.push({ productId: pid, name: p.name, count: 1, conf: 1, checked: true, byBarcode: true, aiSrc: 'barcode' }); hitAny = true; }
        else { it.conf = 1; it.byBarcode = true; it.aiSrc = 'barcode'; if (!it.checked) { it.checked = true; hitAny = true; } }
      }
      if (hitAny) {
        sec.style.display = ''; listBox.classList.remove('hidden'); renderList();
        setState(`✅ 条码识别命中 ${items.filter(x => x.byBarcode).length} 种商品，可在下方核对数量`);
      }
      return hitAny;
    };

    /* V4.9.8 样本就绪度预检：样本库为空时直接给出去采集入口，避免用户干等空识别 */
    (async () => {
      try {
        const list = unwrap(await call('GET', '/ai/samples'));
        const n = new Set((Array.isArray(list) ? list : []).map(s => Number(s.product_id)).filter(Boolean)).size;
        if (n === 0) {
          m.querySelector('#asGuide').classList.remove('hidden');
          setState('⚠️ 样本库为空：请先采集商品样本，否则识别必然为空');
          m.querySelector('#asGoCollect').onclick = () => {
            stop();
            if (typeof View !== 'undefined' && View.aiCollect) push('AI 训练采集', View.aiCollect);
            else toast('请从「作业」页进入 AI 训练采集');
          };
        }
      } catch { /* 样本接口不可用时不影响识别主流程 */ }
    })();

    const renderList = () => {
      if (!items.length) { listBox.innerHTML = '<div class="empty">尚未识别到商品…对准商品保持不动</div>'; return; }
      // V4.16.0 P6 差异高亮：列表内商品某字段取值不一致 → 该字段标红，帮店员一眼看出相近品的区别点
      const metas = items.filter(x => x.category != null || x.sellPrice != null || x.spec);
      const diff = {};
      for (const f of ['sellPrice', 'spec', 'category']) {
        const vs = new Set(metas.map(x => String(x[f] ?? '')));
        diff[f] = vs.size > 1;
      }
      const fx = (v, isDiff, fmt) => (v == null || v === '') ? '' :
        `<span style="${isDiff ? 'color:#c0392b;font-weight:700' : 'color:#888'}">${esc(fmt ?? String(v))}</span>`;
      listBox.innerHTML = items.map((it, i) => {
        const metaBits = [
          fx(it.category, diff.category),
          it.sellPrice != null ? fx(it.sellPrice, diff.sellPrice, '¥' + Number(it.sellPrice).toFixed(2)) : '',
          it.spec ? fx(it.spec, diff.spec) : (it.unit ? esc(it.unit) : ''),
          it.freq != null ? `<span style="color:#888">月销 ${it.freq}</span>` : '',
        ].filter(Boolean).join('<span style="color:#ccc"> · </span>');
        return `
        <div class="row">
          <label style="display:flex;align-items:center;gap:8px;flex:1">
            <input type="checkbox" data-ci="${i}" ${it.checked ? 'checked' : ''}>
            <span style="flex:1;min-width:0">${esc(it.name)}${metaBits ? `<span style="display:block;font-size:11.5px;margin-top:1px">${metaBits}</span>` : ''}</span>
            <span class="pill blue">${Math.round((it.conf || 0) * 100)}%</span>
          </label>
          <div class="qty" data-q="${i}"><button data-m="${i}">−</button><span>${it.count}</span><button data-p="${i}">＋</button></div>
        </div>`;
      }).join('');
      listBox.querySelectorAll('input[type=checkbox][data-ci]').forEach(cb => cb.onchange = () => {
        items[+cb.dataset.ci].checked = cb.checked;
        okBtn.classList.toggle('hidden', !items.some(x => x.checked));
      });
      listBox.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
        const it = items[+b.dataset.m]; it.count = Math.max(1, it.count - 1); it.manual = true;
        listBox.querySelector(`[data-q="${b.dataset.m}"] span`).textContent = it.count;
      });
      listBox.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
        const it = items[+b.dataset.p]; it.count++; it.manual = true;
        listBox.querySelector(`[data-q="${b.dataset.p}"] span`).textContent = it.count;
      });
      okBtn.classList.toggle('hidden', !items.some(x => x.checked));
    };

    /** 抓当前帧（960px JPEG，够识别且省流量） */
    const grabFrame = () => {
      if (!stream || video.readyState < 2) return '';
      const MAX = 960;
      const k = Math.min(1, MAX / Math.max(video.videoWidth || MAX, video.videoHeight || MAX));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((video.videoWidth || MAX) * k));
      c.height = Math.max(1, Math.round((video.videoHeight || MAX) * k));
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.66);
    };

    /** 合并一轮识别结果：已有→刷新置信度/勾选；新出现→追加或防抖 +1
     *  V4.11.2 多件识别（exact）：count 为轮廓分割实点数，非手动改过则直填（不再走"重现 +1"防抖） */
    const mergeResults = list => {
      const curIds = new Set();
      let changed = false;
      for (const r of list) {
        const pid = Number(r.productId);
        curIds.add(pid);
        let it = items.find(x => x.productId === pid);
        if (!it) {
          items.push({ productId: pid, name: r.name || `商品${pid}`, count: Math.max(1, Number(r.count) || 1), conf: Number(r.conf || 0), checked: true, aiSrc: 'ai', aiCount: Math.max(1, Number(r.count) || 1) });
          lastIncAt.set(pid, Date.now());
          changed = true;
        } else {
          it.conf = Number(r.conf || it.conf || 0);
          if (r.exact && !it.manual) {
            if (it.count !== r.count) { it.count = Number(r.count) || 1; changed = true; }   // 分割实点直填
          } else if (!it.manual && !prevIds.has(pid) && Date.now() - (lastIncAt.get(pid) || 0) > DEBOUNCE_MS) {
            it.count += 1;                       // 消失后重新出现 → 视为新的一件（防抖内不重复计）
            lastIncAt.set(pid, Date.now());
            changed = true;
          }
          if (!it.checked) { it.checked = true; changed = true; }
          if (!it.aiSrc) it.aiSrc = 'ai';
          if (!it.manual) it.aiCount = it.count;   // AI 侧最新断言（人工改过即冻结，作纠正比对基准）
        }
      }
      prevIds = curIds;
      // 稳定提示：连续 2 帧结果一致且非空
      const sig = [...curIds].sort((a, b) => a - b).join(',');
      if (list.length) {
        stableRuns = sig === lastSig ? stableRuns + 1 : 0;
        if (stableRuns >= 1 && !stableNotified) { stableNotified = true; toast('已自动识别，请核对数量（可 ±/勾选后加入）'); }
      } else stableRuns = 0;
      lastSig = sig;
      if (changed || true) { sec.style.display = ''; listBox.classList.remove('hidden'); renderList(); prev.classList.add('hidden'); }
    };

    const recognize = async (silent) => {
      const shot = m.querySelector('#asShot');
      if (!silent) { shot.disabled = true; shot.textContent = '识别中…'; }
      try {
        if (!video.videoWidth && !dataUrl) {
          setState('📷 相机未就绪：对准商品后自动识别');
          return;
        }
        const d = await call('POST', '/ai/recognize', { imageBase64: dataUrl || grabFrame(), scene, mode: 'multi' });
        if (d.logId) lastLogId = Number(d.logId);   // V4.11.3 记录日志 ID，确认时回传纠正
        const multiExact = d.layer === 'clip-multi';   // 多件识别：count 为分割实点数，直接采信
        const list = (d.result || []).map(r => ({ productId: Number(r.productId), name: r.name || `商品${r.productId}`, count: Math.max(1, Number(r.count) || 1), conf: Number(r.conf || 0), exact: multiExact }));
        if (list.length) { emptyRounds = 0; mergeResults(list); }
        else if ((d.candidates || []).length) {
          // V4.10.1 候选卡片：向量检索 Top-K 未达自动采信阈值 → 列出供店员点选确认（默认不勾选、不自动计数）
          emptyRounds = 0;
          let added = false;
          for (const c of d.candidates) {
            const pid = Number(c.productId);
            if (!pid || items.some(x => x.productId === pid)) continue;
            items.push({ productId: pid, name: c.name || `商品${pid}`, count: 1, conf: Number(c.conf || 0), checked: false, cand: true, aiSrc: 'cand', aiCount: 0, cropBox: c.cropBox || null });
            added = true;
          }
          if (added) {
            sec.style.display = ''; listBox.classList.remove('hidden'); renderList(); prev.classList.add('hidden');
            setState(`🔎 候选商品 ${items.filter(x => x.cand).length} 项：请勾选确认（相似度未达自动采信阈值）`);
          }
        }
        else {
          emptyRounds += 1;
          // 连续多轮空识别 → 主动暂停并给可执行建议，避免用户举着手机一直等
          if (autoOn && emptyRounds >= 4) {
            setAuto(false);
            setState('⏸ 连续多次未识别，已暂停自动：请对准商品正面/补光，或点「改用扫码加入」');
          }
        }
        if (d.notice) setState(list.length ? `✅ ${d.notice}` : `⚠️ ${d.notice}`);
        updateGuide(d.guide);          // V4.16.0 P6 分步拍引导（多件识别每轮回报）
        if (d.reshoot) showReshoot(d.reshoot);   // V4.16.0 P6 易混补拍引导
        if (!silent && !list.length) toast(d.notice || '未识别到商品：请对准正面重拍，或改用扫码加入（该商品须已采集样本）', false);
      } catch (e) {
        if (!silent) toast(e.message);
        else setState('⚠️ 识别失败，稍后自动重试');
      } finally {
        if (!silent) { shot.disabled = false; shot.textContent = '📷 立即识别一次'; }
      }
    };

    // 手动拍照识别（先试条码，再走 dHash）
    m.querySelector('#asShot').onclick = async () => {
      if (!stream || video.readyState < 2) { toast(window.isSecureContext ? '相机未就绪，请稍候或重进弹窗' : '相机不可用：请改用 HTTPS 地址打开本页'); return; }
      await mergeBarcodeHits();
      dataUrl = grabFrame(); prev.src = dataUrl; prev.classList.remove('hidden');
      recognize(false);
    };

    // ── 自动识别循环（防抖：上一帧未完成不叠加请求）──
    const autoOnce = async () => {
      if (!autoOn || autoBusy) return;
      autoBusy = true;
      try {
        const hit = await mergeBarcodeHits();     // 条码优先：每帧检测，可靠识别带码商品
        if (!hit) { dataUrl = grabFrame(); await recognize(true); }  // 仅条码未命中才走 dHash 样本比对
      }
      finally { autoBusy = false; }
    };
    const setAuto = on => {
      autoOn = on;
      const b = m.querySelector('#asAuto');
      if (b) { b.textContent = on ? '⏸ 暂停自动' : '▶️ 开启自动'; }
      if (on) setState('🔄 自动识别中… 对准商品即可');
      else setState('⏸ 自动识别已暂停，可手动拍照识别');
    };
    m.querySelector('#asAuto').onclick = () => setAuto(!autoOn);

    /** V4.11.3 纠正回传：店员确认结果 ≠ AI 断言 → POST /ai/recognize/:id/correct
     *  条码命中=真值不回传；候选件勾选=人工裁决（低置信闭环，带 cropBox 供后端裁单件样本）；
     *  AI 自动命中件被取消勾选/改数=纠正；手输补录=manualAdd（仅统计信号，后端不建样本防画面外挂错）。
     *  V4.11.5：整单全取消也回传（全取消是最强的"AI 全错"负信号） */
    const reportCorrection = chosen => {
      if (!lastLogId) return;
      try {
        const chosenMap = new Map((chosen || []).map(x => [Number(x.productId), x.count]));
        const corrected = [];
        for (const it of items) {
          if (it.aiSrc === 'barcode') continue;                       // 条码识别即真值
          const cnt = chosenMap.get(Number(it.productId)) || 0;
          if (it.aiSrc === 'cand') {
            if (cnt > 0) corrected.push({ productId: Number(it.productId), count: cnt, cropBox: it.cropBox });   // 候选被店员确认
            continue;                                                 // 候选未勾选=维持"不采信"，无信号
          }
          if (it.aiSrc === 'ai') {
            if (cnt === 0 && it.aiCount > 0) corrected.push({ productId: Number(it.productId), count: 0 });        // AI 命中被取消
            else if (cnt > 0 && cnt !== it.aiCount) corrected.push({ productId: Number(it.productId), count: cnt, cropBox: it.cropBox });  // 数量被改
          } else if (cnt > 0) {
            corrected.push({ productId: Number(it.productId), count: cnt, manualAdd: true });   // 手输补录（AI 漏检）：不建样本
          }
        }
        if (corrected.length) {
          // V4.16.5：附带当前帧（有相机的最后帧），识别帧未落盘时后端落盘挂样本——纠正项从此有样本图
          let frameImage = null;
          try { if (typeof grabFrame === 'function') frameImage = grabFrame(); } catch { /* 无帧忽略 */ }
          call('POST', `/ai/recognize/${lastLogId}/correct`, { corrected, frameImage })
            .catch(() => { /* 回传失败不影响收银，下一次识别会带新 logId */ });
        }
      } catch { /* 任何回传异常不阻断确认流程 */ }
    };

    okBtn.onclick = () => {
      const chosen = items.filter(x => x.checked);
      reportCorrection(chosen);
      if (chosen.length) opts.onConfirm(chosen.map(x => ({ productId: x.productId, name: x.name, count: x.count })));
      stop();
    };

    // 打开相机（提升分辨率，识别/扫码更稳）
    (async () => {
      if (!window.isSecureContext) {
        toast('当前为 HTTP 访问，浏览器禁止摄像头。请用 HTTPS 地址重新打开（后台重新生成二维码）');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        video.srcObject = stream;
        await video.play();
        // 自动对焦常开（部分安卓支持）
        try {
          const track = stream.getVideoTracks()[0];
          const cap = track.getCapabilities ? track.getCapabilities() : {};
          if (cap.focusMode && cap.focusMode.includes('continuous')) {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
          }
        } catch { /* 不支持则忽略 */ }
      } catch { /* 无摄像头权限 → 模拟一帧仍可用 */ }
      // 自动识别循环无条件启动（无相机时抓帧为空串，mock 引擎仍可联调）
      setAuto(true);
      autoTimer = setInterval(autoOnce, 1600);
      autoOnce();
    })();
  },
};
window.AiScan = AiScan;   // 调试/CDP 访问
