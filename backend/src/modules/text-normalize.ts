/**
 * V5.0.16 中文播报文本前端（TN，Text Normalization）
 * ------------------------------------------------------------------
 * 目的：送入 TTS 引擎前，把「机器难读」的文本转成自然中文读法。
 *   · 引擎无关资产（piper / CosyVoice 都先用它），与声学模型解耦——换模型不用重写。
 *   · 解决：日期/时间/金额/百分比/电话/序数/单位的「读错」，以及长数字串不知所云。
 *   · 前端 mobile-apk/www/tts.js 已有 V5.0.14d 版（逐位年份已对）；此处为**后端权威版**，
 *     统一覆盖点分隔日期等前端漏掉的场景，并作为本地音色/旧前端/直连 API 的兜底。
 *   · 多音字说明：纯 piper(espeak) 下文本层无法「强制」读音（根治需 g2p，见 PaddleSpeech 路线），
 *     这里预留 POLYPHONE 词典位；espeak 自身多音字消歧对常见词已较准（银行/重庆等）。
 */
const CN_D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_TEL = ['零', '幺', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 逐位读法（年份 / 长号 / 序号）：2026 → 二零二六 */
function cnSeq(s: string): string {
  return String(s).split('').map(ch => (/\d/.test(ch) ? CN_D[+ch] : ch)).join('');
}
/** 整数 1-9999 中文（月/日/时/分/秒/序数；<20 习惯省「一」：十二/十五） */
function cnInt(n: number): string {
  n = Math.round(Number(n));
  if (!Number.isFinite(n) || n < 0 || n > 9999) return String(n);
  if (n < 10) return CN_D[n];
  if (n < 20) return '十' + (n % 10 ? CN_D[n % 10] : '');
  const U = ['', '十', '百', '千'];
  let out = '', i = 0, x = n;
  while (x > 0) {
    const d = x % 10;
    if (d) out = CN_D[d] + U[i] + out;
    else if (out && !out.startsWith('零')) out = '零' + out;
    x = Math.floor(x / 10); i++;
  }
  return out;
}
/** 金额读法（元角分；只处理带「元」的，避免误伤普通小数） */
function cnAmount(str: string): string {
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
/** 数值读法（百分比/通用整数；<10000 用 cnInt，更大加「万」） */
function cnValue(s: string): string {
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return s;
  if (n < 0) return '负' + cnValue(String(-n));
  if (n < 10000) return cnInt(n);
  if (n < 1e8) {
    const w = Math.floor(n / 1e4), r = n % 1e4;
    return cnInt(w) + '万' + (r ? (r < 1000 ? '零' : '') + cnInt(r) : '');
  }
  return String(s);
}

/** 可扩展多音字/易错词修正位（文本层仅缓解；根治需 g2p） */
const POLYPHONE: [RegExp, string][] = [
  // [/词/g, '替换']  // 例：若实测 piper 把某词读错，在此加一条（文本层无法强制读音，仅换词）
];

export function normalizeChineseText(text: string): string {
  let s = String(text || '');
  // 1) 日期：支持 - / . 年 月 分隔（重点补前端漏掉的「.」分隔 → 否则 piper 把 2026 当数值读）
  s = s.replace(/(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?/g,
    (m: string, y: string, mo: string, d: string) => cnSeq(y) + '年' + cnInt(+mo) + '月' + cnInt(+d) + '日');
  // 2) 时间
  s = s.replace(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g,
    (m: string, h: string, mi: string, sec?: string) => cnInt(+h) + '点' + cnInt(+mi) + '分' + (sec && +sec !== 0 ? cnInt(+sec) + '秒' : ''));
  // 3) 百分比
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, (m: string, a: string) => {
    if (a.includes('.')) {
      const [i, f] = a.split('.');
      return '百分之' + cnValue(i) + '点' + cnSeq(f);
    }
    return '百分之' + cnValue(a);
  });
  // 4) 电话（手机号，首位读「幺」）
  s = s.replace(/1[3-9]\d{9}/g, m => m.split('').map((c, i) => (i === 0 ? CN_TEL[+c] : CN_D[+c])).join(''));
  // 5) 序数
  s = s.replace(/第\s*(\d+)/g, (m: string, n: string) => '第' + cnInt(+n));
  // 6) 金额（带「元」；cnAmount 自身已含「元」，不要重复加）
  s = s.replace(/(\d+(?:\.\d+)?)\s*元/g, (m: string, a: string) => cnAmount(a));
  // 7) 长数字串（7-13 位，单号/条码/批次）逐位
  s = s.replace(/(\d{7,13})/g, m => cnSeq(m));
  // 8) 单位（用前后顾防误伤英文词；g 前是数字时也有边界，故不能用 \b）
  s = s.replace(/(?<![a-z])(kg|g|ml|l|cm|mm|km|m²|m³)(?![a-z])/gi,
    m => ({ kg: '千克', g: '克', ml: '毫升', l: '升', cm: '厘米', mm: '毫米', km: '千米', 'm²': '平方米', 'm³': '立方米' }[m.toLowerCase()] || m));
  // 9) 多音字（可扩展）
  for (const [re, v] of POLYPHONE) s = s.replace(re, v);
  return s;
}
