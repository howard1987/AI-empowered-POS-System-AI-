'use strict';
/* V4.13 ⑤ 语音查价单点（能力全景 2.1 单点 MVP：ASR→意图[查价]→报价 TTS，先验证店员是否真用）
 *  全链路本地零云端依赖：浏览器 Web Speech API（Chrome/Edge 内置中文识别）+ speechSynthesis 报价；
 *  查词走价目表缓存 Pricebook（归一化索引 + 名称模糊），不打扰扫码主链路。
 *  开关：voice.price.enabled（默认关；老板端 设置-智能能力 打开）。HTTPS 或 localhost 才可用麦克风。 */
const Voice = {
  supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); },
  ttsOk() { return 'speechSynthesis' in window; },

  /** 开关检查（登录态；后端 GET /settings/key/:key） */
  async enabled() {
    try {
      const d = await call('GET', '/settings/key/voice.price.enabled');
      return d.value === true || d.value === 'true' || d.value === 1;
    } catch { return false; }
  },

  /** 口语清洗：去"请问/帮我查/多少钱/谢谢"等，留商品名核心词 */
  clean(text) {
    let s = String(text || '').trim();
    s = s.replace(/^(请|麻烦|帮我|帮忙|帮我一下|给我)+(问|查|看|说说)?/g, '')
         .replace(/(一下|看看|查查)/g, '')
         .replace(/(多少钱|什么价|啥价|价格是多少|价格|价位|怎么卖|咋卖|报价|谢谢|多谢)+$/g, '')
         .replace(/(这个|那个|这|那)$/g, '')
         .replace(/[？?。！!，,、\s]/g, '');
    return s || String(text || '').trim();
  },

  /** TTS 报价（V4.13.8 起走 PwaTTS 拟人引擎：多音色/语速后台可配；无引擎时回落原生） */
  speak(text) {
    if (window.PwaTTS) { PwaTTS.say(text, { rate: 1.05 }); return; }
    if (!this.ttsOk()) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch { /* 静默 */ }
  },

  /** 一次听录（点按触发；最终结果回调 onText；出错/无结果回调 onErr） */
  listen(onText, onErr) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { onErr && onErr('浏览器不支持语音识别：请用 Chrome/Edge（HTTPS）'); return null; }
    let rec;
    try { rec = new SR(); } catch (e) { onErr && onErr('麦克风不可用：' + (e.message || e)); return null; }
    rec.lang = 'zh-CN'; rec.interimResults = false; rec.maxAlternatives = 1;
    let done = false;
    rec.onresult = ev => { done = true; const t = ev.results[0][0].transcript || ''; onText && onText(t); };
    rec.onerror = ev => { if (!done) onErr && onErr(ev.error === 'not-allowed' ? '麦克风权限被拒绝：请在浏览器地址栏允许麦克风' : '未听清，请再试一次'); };
    rec.onend = () => { if (!done) onErr && onErr('未听清，请靠近一点再试'); };
    try { rec.start(); } catch (e) { onErr && onErr('录音启动失败：' + (e.message || e)); return null; }
    return rec;
  },

  /** 查价主流程：听 → 清洗 → Pricebook 查 → TTS 报价；返回 {ok, product?, text} */
  async priceLookup(onState) {
    if (!await this.enabled()) {
      const r = { ok: false, text: '语音查价未开启：老板端 设置-智能能力 可打开' };
      onState && onState(r); this.speak(r.text); return r;
    }
    const text = await new Promise((res, rej) => {
      onState && onState({ ok: false, listening: true, text: '请说出商品名…' });
      const rec = this.listen(t => res(t), e => rej(new Error(e)));
      if (rec === null) rej(new Error('语音识别不可用'));
    }).catch(e => ({ err: e.message }));
    if (text && text.err) { const r = { ok: false, text: text.err }; onState && onState(r); return r; }
    const kw = this.clean(text);
    if (!kw) { const r = { ok: false, text: '没听清商品名，请再试' }; onState && onState(r); return r; }
    if (typeof Pricebook === 'undefined' || !Pricebook.ready) {
      const r = { ok: false, text: '价目表未就绪，请稍后再试' }; onState && onState(r); this.speak(r.text); return r;
    }
    const p = Pricebook.find(kw);
    if (!p) {
      const r = { ok: false, kw, text: `没找到「${kw}」，可以说得更具体些` };
      onState && onState(r); this.speak(r.text); return r;
    }
    const price = Number(p.sellPrice ?? p.sell_price ?? 0);
    const unit = p.baseUnit || p.base_unit || '件';
    const spec = p.spec ? `，规格 ${p.spec}` : '';
    // V4.13.8 口语化报价：整元不带小数点（2.50 元 → 2 块 5 更顺耳由 TTS 音色自然度决定，此处保数值准确）
    const priceTxt = Number.isInteger(price) ? String(price) : price.toFixed(2);
    const unitTxt = unit === '件' ? '' : `每${unit}`;
    const text2 = `${p.name}，${priceTxt} 元${unitTxt}${spec}`;
    const r = { ok: true, kw, product: p, text: text2 };
    onState && onState(r); this.speak(text2);
    return r;
  },
};
window.Voice = Voice;   // const 顶层不挂 window，显式暴露供调试与 CDP 测试
