'use strict';
/* V4.13.8 拟人语音引擎（统一 TTS 出口）：多音色 / 语速 / 音调 / 分场景开关
 *  供 PWA 收银台（收款播报/语音查价）与老板端（智能客服朗读）共用，PWA 经 SW 缓存壳离线可用。
 *  分层策略（对齐系统 auto 探测惯例）：
 *    auto    = 拟真人声优先（浏览器在线神经音色，如 Edge「Microsoft Xiaoxiao/Yunxi Online (Natural)」，
 *              效果接近真人）；探测不到自动回落本地音色，离线环境不报错。
 *    natural = 强制拟真人声；local = 强制本地音色（纯离线，相对机械）。
 *  设置（后台「通用设置 → 语音播报」）：voice.tts.mode / voice.tts.voice / voice.tts.rate / voice.tts.pitch
 *  收银台覆盖（V4.18.7）：pos.cashier.tts.voice / rate / pitch 非空时覆盖，空=跟随老板端
 *  依赖调用方先定义 call(method, path)（pwa/app.js 与 boss/app.js 均已提供），加载失败静默用默认配置。 */
const PwaTTS = (() => {
  const S = { mode: 'auto', voice: '', rate: 1, pitch: 1 };
  /** V4.25.7：音色下拉里的「引擎语音」特殊值 —— 强制走服务端神经语音（piper），探测失败自动回落本机音色 */
  const ENGINE_VOICE = '__engine__';
  let cfgLoaded = false;
  // ── V4.24.1 服务端离线神经语音（piper，/tts/synthesize → WAV）──
  //  背景：「讲述人 → 自然语音」只给讲述人用，Chrome/收银台内核枚举不到（注册表+内核双实测）。
  //  策略：服务端引擎就绪（/tts/health）→ 播报一律走服务端（全端统一拟人声）；
  //        未就绪/合成失败 → 自动回落本机 speechSynthesis（行为与旧版完全一致）。
  let srv = { ok: null, at: 0, checking: false, voice: '', failAt: 0 };
  let audioEl = null;

  const supported = () => typeof speechSynthesis !== 'undefined' && 'speechSynthesis' in window;
  /* V4.22.2 拟真人声识别扩展：除 Edge 在线拟真（… Online (Natural)）外，还要认 Windows 11
   *   本地「自然语音」包（设置-辅助功能-讲述人-添加自然语音 / 语言选项-语音），其名称形如
   *   「Microsoft Xiaoxiao / 晓晓 / 云希」不带 Online/Natural 字样——旧正则漏判会导致电脑端
   *   明明装了拟真人声却仍按机械音播报。 */
  const NATURAL_RE = /Natural|Online|Neural|Xiaoxiao|Xiaoyi|Yunxi|Yunyang|Yunxia|晓晓|晓伊|晓萱|云希|云扬|云夏/i;
  const isNatural = v => NATURAL_RE.test(v.name || '');
  // 老式 SAPI 音色中的男声（机械感更强），仅在无女声/无拟真声时兜底
  const MALE_RE = /Kangkang|康康|Yunxi|云希|Yunyang|云扬|Yunjian|云健/i;
  /** 音色打分排序（越大越好）：拟真 > 晓晓 > 晓伊 > 瑶瑶 > 慧慧 > 在线谷歌 > 其他；男声降权 */
  function score(v) {
    let s = 0;
    if (isNatural(v)) s += 1000;
    if (/Xiaoxiao|晓晓/i.test(v.name || '')) s += 300;
    if (/Xiaoyi|晓伊/i.test(v.name || '')) s += 280;
    if (/Yaoyao|瑶/i.test(v.name || '')) s += 260;
    if (/Huihui|慧慧/i.test(v.name || '')) s += 200;
    if (/Google/i.test(v.name || '')) s += 150;
    if (v.localService === false) s -= 100;    // 在线音色断网会静默无声，降权
    if (MALE_RE.test(v.name || '')) s -= 400;
    if (v.default) s += 10;
    return s;
  }

  /** 本机全部中文音色（getVoices 首次可能为空，onvoiceschanged 后再取） */
  function zhVoices() {
    if (!supported()) return [];
    try { return speechSynthesis.getVoices().filter(v => /^zh/i.test(v.lang || '')); } catch { return []; }
  }

  /** 按配置挑音色：指定音色 > 拟真人声（女声优先）> 在线声（Google）> 本地女声 > 首个中文声
   *  V4.18.7：兜底段重排——旧逻辑命中机械男声（如 Microsoft Kangkang）导致「生硬」感，现优先在线/女声
   *  V4.22.2：改为打分择优（见 score）；mode='local' 时只在离线音色里挑（避免断网无声） */
  function pickVoice() {
    const vs = zhVoices();
    if (!vs.length) return null;
    // V4.25.7：__engine__ = 引擎语音（服务端神经语音），不参与本机音色查表
    if (S.voice && S.voice !== ENGINE_VOICE) { const hit = vs.find(v => v.name === S.voice); if (hit) return hit; }
    const pool = S.mode === 'local' ? vs.filter(v => v.localService !== false) : vs;
    const list = (pool.length ? pool : vs).slice();
    list.sort((a, b) => score(b) - score(a));
    return list[0] || null;
  }

  /** 供设置页/诊断显示：当前生效音色与可用音色概览（V4.22.2）
   *  两端（老板端浏览器 vs 收银端 EXE）音色不一致时，用这里的信息直接比对即可定位 */
  function voiceInfo() {
    const vs = zhVoices();
    const v = pickVoice();
    return {
      mode: S.mode,
      count: vs.length,
      configured: S.voice || '',
      current: v ? v.name : '',
      natural: !!(v && isNatural(v)),
      all: vs.map(x => ({ name: x.name, natural: isNatural(x), local: x.localService !== false })),
    };
  }

  /** 读后台配置（失败静默；一次会话只拉一遍， force 重拉）
   *  V4.18.7：老板端 voice.tts.* 为全局基准；收银台 pos.cashier.tts.voice/rate/pitch 非空时覆盖
   *  （「默认用老板端的播报语音」——收银端键留空即完全跟随老板端）
   *  V4.24.1：顺带探测服务端神经语音可用性 */
  async function loadCfg(force) {
    if (cfgLoaded && !force) return S;
    refreshServer();
    try {
      const ks = ['mode', 'voice', 'rate', 'pitch'];
      const rs = await Promise.all(ks.map(k =>
        (typeof call === 'function' ? call('GET', '/settings/key/voice.tts.' + k) : Promise.reject()).catch(() => null)));
      if (rs[0]) S.mode = String(rs[0].value ?? 'auto');
      if (rs[1]) S.voice = String(rs[1].value ?? '');
      if (rs[2]) S.rate = Math.min(2, Math.max(0.5, Number(rs[2].value) || 1));
      if (rs[3]) S.pitch = Math.min(2, Math.max(0.5, Number(rs[3].value) || 1));
      // 收银台覆盖（空串/未设置=跟随老板端；老板端 device 无 call 时此段自然跳过）
      if (typeof call === 'function') {
        const cs = await Promise.all(['voice', 'rate', 'pitch'].map(k =>
          call('GET', '/settings/key/pos.cashier.tts.' + k).catch(() => null)));
        if (cs[0] && String(cs[0].value ?? '') !== '') S.voice = String(cs[0].value);
        if (cs[1] && String(cs[1].value ?? '') !== '') S.rate = Math.min(2, Math.max(0.5, Number(cs[1].value) || 1));
        if (cs[2] && String(cs[2].value ?? '') !== '') S.pitch = Math.min(2, Math.max(0.5, Number(cs[2].value) || 1));
      }
      cfgLoaded = true;
    } catch { /* 离线：默认配置（auto） */ }
    return S;
  }

  // ═══ V4.24.1 服务端神经语音（piper）═══
  /** 服务端引擎状态（60s 缓存；失败 60s 内不重试，避免收款播报被拖慢） */
  async function refreshServer(force) {
    if (srv.checking) return srv;
    if (!force && srv.ok !== null && Date.now() - srv.at < 60000) return srv;
    srv.checking = true;
    try {
      const d = typeof call === 'function' ? await call('GET', '/tts/health') : null;
      srv = { ok: !!(d && d.available), at: Date.now(), checking: false, voice: (d && d.voice) || '' };
    } catch { srv = { ok: false, at: Date.now(), checking: false, voice: '' }; }
    return srv;
  }
  const serverInfo = () => ({ available: !!srv.ok, voice: srv.voice, engine: 'piper' });
  function authHeaders(extra) {
    const h = { 'content-type': 'application/json', ...(extra || {}) };
    try { if (typeof TOKEN !== 'undefined' && TOKEN) h.authorization = 'Bearer ' + TOKEN; } catch { /* 老板端无 TOKEN 变量 */ }
    return h;
  }
  /** 合成并播放（同文本+语速命中服务端缓存，秒回）；任何失败 → 标记引擎不可用并回落本机音色
   *  V5.0.14c 修复（真机「试听无声」根因）：宿主页的 API 基址解析。旧代码只认全局变量
   *  API_BASE，而员工端/老板端主应用都没有这个变量（都用动态 apiBase() 函数）→ base=''
   *  → APK 里请求打到 https://localhost/tts/synthesize（壳本地服务器）→ 拿回 HTML 而非音频
   *  → 播放失败回落本机 speechSynthesis → Android WebView 本机中文音色为空 → 全程无声。
   *  现按优先级取：全局 API_BASE 变量 → 宿主 apiBase()（老板端）/ currentApiBase()（员工端）→ 同源空串。
   *  V5.0.14e 补：两端函数名不同！老板端=apiBase()，员工端=currentApiBase()——上一版只兼容了
   *  apiBase，结果「老板端试听好了、手机收银台收款播报依旧无声」（真机实测复现）。 */
  async function playServer(text, opts) {
    try {
      const rate = Math.min(2, Math.max(0.5, S.rate * (Number(opts.rate) || 1)));
      const base = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE
        : (typeof apiBase === 'function' ? String(apiBase() || '')
          : (typeof currentApiBase === 'function' ? String(currentApiBase() || '') : ''));
      const r = await fetch(base + '/tts/synthesize', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: String(text), rate }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      /* V5.0.15：片段拼接的音频按片段库语速（rate=1）生成，服务端用 x-tts-engine-rate 回带；
       * 这里用 playbackRate 补偿到请求的语速——纯播放端变速，不改音高、无额外推理延迟。 */
      const engRate = (() => { try { return Number(r.headers.get('x-tts-engine-rate')) || rate; } catch { return rate; } })();
      const blob = await r.blob();
      /* V5.0.14e：基址为空时请求会打到 APK 壳本地服务器，SPA 回退返回 HTML（HTTP 200 但不是音频）
       * —— 旧版把它当音频喂给 Audio → NotSupportedError → 无声回落。这里显式识别非音频响应。 */
      if (!blob || !blob.size || (blob.type && !/audio|octet|binary/i.test(blob.type))) throw new Error('非音频响应（' + (blob && blob.type || 'empty') + '）');
      if (audioEl) { try { audioEl.pause(); } catch { /* 忽略 */ } }
      audioEl = new Audio(URL.createObjectURL(blob));
      try { audioEl.playbackRate = Math.min(2, Math.max(0.5, rate / (engRate || rate))); } catch { /* 不支持变速的设备忽略 */ }
      audioEl.onended = () => { try { if (audioEl) URL.revokeObjectURL(audioEl.src); } catch { /* 忽略 */ } };
      await audioEl.play();
    } catch {
      srv = { ok: false, at: Date.now(), checking: false, voice: srv.voice, failAt: Date.now() };
      speakLocal(text, opts);   // 引擎没就绪/断网：无缝回落本机音色，播报不中断
    }
  }
  /** 供设置页/诊断：服务端语音是否可用（cashier 音色诊断行展示） */
  async function ensureServerProbe() { await refreshServer(); return serverInfo(); }

  /* ═══ V5.0.14d 播报文本归一化（治「机械朗读」）═══
   *  痛点：TTS 引擎按字面读 —— 日期"2026-10-05"读成"二千零二十六十零五"，
   *  金额"12.5 元"读成"十二点五元"，长单号一坨数字读得不知所云。
   *  这里在送入引擎前统一转成中文读法：
   *    · 日期  2026-10-05 / 2026年10月5日 → 二零二六年十月五日（年份逐位读，月份日期按数值读）
   *    · 时间  14:30 → 十四点三十分
   *    · 金额  12.5 元 → 十二元五角；0.05 元 → 五分（只有带「元」的才算金额，避免误伤普通小数）
   *    · 长数字串（≥5 位，单号/批次号）逐位读 */
  const CN_D = '零一二三四五六七八九';
  const cnDigits = s => String(s).split('').map(ch => (/\d/.test(ch) ? CN_D[+ch] : ch)).join('');
  function cnInt(n) {
    n = Math.round(Number(n));
    if (!Number.isFinite(n) || n < 0 || n > 9999) return String(n);
    if (n < 10) return CN_D[n];
    if (n < 20) return '十' + (n % 10 ? CN_D[n % 10] : '');   // 十二/十五（习惯省「一」）
    const U = ['', '十', '百', '千'];
    let out = '', i = 0;
    while (n > 0) {
      const d = n % 10;
      if (d) out = CN_D[d] + U[i] + out;                       // 数字在权位前：三十/三百/一百一十二
      else if (out && !out.startsWith('零')) out = '零' + out;
      n = Math.floor(n / 10); i++;
    }
    return out;
  }
  function cnAmount(str) {
    const [y, f = ''] = String(str).split('.');
    const yuan = Number(y);
    let out = yuan === 0 ? '' : cnInt(yuan) + '元';
    const jiao = +((f + '00')[0] || 0), fen = +((f + '00')[1] || 0);
    if (!jiao && !fen) return out || '零元';
    if (jiao) out += CN_D[jiao] + '角';
    else if (fen && out) out += '零';
    if (fen) out += CN_D[fen] + '分';
    return out || '零元';
  }
  function normSpeechText(t) {
    let s = String(t || '');
    s = s.replace(/(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?/g, (m, y, mo, d) => cnDigits(y) + '年' + cnInt(+mo) + '月' + cnInt(+d) + '日');
    s = s.replace(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g, (m, h, mi, sec) => cnInt(+h) + '点' + cnInt(+mi) + '分' + (sec ? cnInt(+sec) + '秒' : ''));
    s = s.replace(/(\d+(?:\.\d+)?)\s*元/g, (m, a) => cnAmount(a));
    s = s.replace(/\d{5,}/g, m => cnDigits(m));
    return s;
  }

  /** 播报入口：服务端神经语音优先（拟人声、全端一致），未就绪/关闭 → 本机音色
   *  opts={rate 叠加倍率, onFail 失败回调}；打断上一条（收银场景不允许排队堆积）
   *  注意：浏览器端在用户点击手势后才允许出声（Chrome autoplay 策略）；EXE 壳已放行 no-user-gesture-required */
  function speak(text, opts = {}) {
    if (!text || S.mode === 'off') return false;
    text = normSpeechText(text);   // V5.0.14d：日期/时间/金额/长单号先转自然读法
    // V4.25.7：选了「引擎语音」→ 强制服务端 piper（探测/合成失败自动回落本机音色）
    if (S.voice === ENGINE_VOICE) {
      if (srv.ok) { playServer(String(text), opts); return true; }
      refreshServer(true).then(s => { if (s.ok) playServer(String(text), opts); else speakLocal(text, opts); });
      return true;
    }
    if (srv.ok) { playServer(String(text), opts); return true; }
    refreshServer().then(s => { if (s.ok) playServer(String(text), opts); else speakLocal(text, opts); });
    return true;
  }

  /** 本机 speechSynthesis 播报（V4.24.1 前的 speak 原样保留，作为回落路径）
   *  V4.18.7b：onstart/onerror 检测——Google 系在线音色被墙无输出、Edge 拟真声 Chrome 不支持等场景不再「无声无息」 */
  function speakLocal(text, opts = {}) {
    if (!supported() || !text || S.mode === 'off') return false;
    try {
      const v = pickVoice();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'zh-CN';
      if (v) u.voice = v;
      u.rate = Math.min(2, Math.max(0.5, S.rate * (Number(opts.rate) || 1)));
      u.pitch = Math.min(2, Math.max(0.5, S.pitch));
      u.volume = 1;
      let started = false, failed = '';
      u.onstart = () => { started = true; };
      u.onerror = e => {
        failed = (e && e.error) || 'error';
        if (opts.onFail) { try { opts.onFail(failed, v && v.name || ''); } catch { /* noop */ } }
      };
      speechSynthesis.speak(u);
      if (opts.onFail) {
        // 2.5s 未开播也未报错 → 判定无声（在线音色断网常见表现）
        setTimeout(() => {
          if (!started && !failed) {
            try { speechSynthesis.cancel(); } catch { /* noop */ }
            try { opts.onFail('no-output', v && v.name || ''); } catch { /* noop */ }
          }
        }, 2500);
      }
      return true;
    } catch { return false; }
  }

  /** 先同步配置再播报（首条略慢 <100ms，可接受） */
  async function say(text, opts) { await loadCfg(); return speak(text, opts); }

  /** 收款播报（场景开关 pos.voice_broadcast；现金/通道文案区分） */
  async function cash(payable, channel) {
    await loadCfg();
    try {
      if (typeof call === 'function') {
        const d = await call('GET', '/settings/key/pos.voice_broadcast');
        if (!(d && (d.value === true || d.value === 'true' || d.value === 1))) return false;
      }
    } catch { /* 拉不到开关：按开启播报 */ }
    const amt = Number(payable) || 0;
    const text = channel === '现金'
      ? `现金收款 ${amt} 元，谢谢惠顾`
      : `收款 ${amt} 元${channel ? `，${channel}已到账` : ''}，谢谢惠顾`;
    /* V5.0.14e：播报失败要可见——此前静默失败（回落本机音色而本机无声），
     * 店员只觉得"没播报"。失败时 toast 给出可行动提示。 */
    return speak(text, {
      rate: 1.05,
      onFail: why => {
        try { if (typeof toast === 'function') toast(`语音播报无声（${why || '音频获取失败'}）：请检查手机媒体音量；仍未解决请到 设置→智能能力开关 把音色选「引擎语音」`); } catch { }
      },
    });
  }

  /** 告警播报（V4.16.0 P9 语音增强：开关 ai.voice.alerts 默认开；用于临期/对账差异等经营告警）
   *  同一条告警由调用方用 sessionStorage 去重（每条每设备只播一次，防轰炸） */
  async function alert(text) {
    await loadCfg();
    try {
      if (typeof call === 'function') {
        const d = await call('GET', '/settings/key/ai.voice.alerts');
        if (d && (d.value === false || d.value === 'false' || d.value === 0)) return false;
      }
    } catch { /* 拉不到开关：按开启播报 */ }
    return speak(`告警，${text}`, { rate: 0.95 });
  }

  // 音色预热：部分浏览器 getVoices 异步就绪，登录后即触发枚举
  if (supported()) {
    try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => {}; } catch { /* 忽略 */ }
  }

  return { supported, say, speak, speakLocal, cash, alert, loadCfg, pickVoice, zhVoices, isNatural, score, voiceInfo, serverInfo, ensureServerProbe, refreshServer, ENGINE_VOICE, cfg: S, normSpeechText };
})();
window.PwaTTS = PwaTTS;   // 显式挂 window 供调试与 CDP 测试
