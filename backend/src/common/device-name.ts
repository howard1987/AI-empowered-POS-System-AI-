/**
 * V5.0.11d 设备名称 / 类型自动识别
 *
 * 背景：此前 pos_devices.device_name 从不由系统填写（只能靠管理员手工点「命名」），
 * device_type 则完全相信前端自报。管理后台更是把 type 硬编码成 'pc'，
 * 于是手机浏览器登录后设备列表显示「— / 电脑」，管理员根本认不出哪台是自己的手机。
 *
 * 这里放到**后端**做，理由：
 *   ① 所有端（收银 PWA / 老板端 / 管理后台 / APK）都已把 User-Agent 发过来，后端是唯一收口点；
 *   ② 前端可以伪造 device_type，但 UA 骗不了人（至少骗起来成本高得多）；
 *   ③ 浏览器拿不到「设备友好名称」（那是隐私保护 API），UA 是唯一可用信号。
 *
 * 型号提取覆盖国内超市实际会出现的设备：Windows 收银机 / iPhone / iPad /
 * 安卓国产机（vivo、OPPO、小米、华为、荣耀、三星等）。
 */

/** 常见安卓品牌前缀 → 中文品牌名。UA 里的机型代号（V2309A、PHB110 等）不友好，补一层映射。 */
const BRAND_PREFIX: [RegExp, string][] = [
  [/^V(2[0-9]{3}|[0-9]{4})/i, 'vivo'],               // vivo: V2309A / V2021
  [/^(PJ[DF]|PHB|PDK|PDX|P[A-Z]{2}\d{2})/i, 'OPPO'],   // OPPO: PJD110 / PHB110
  // 小米/Redmi：M2102K1AC 这类，以及 2201123C / 23013RK75C 这类纯数字或数字+字母混合的机型代号
  [/^(M(19|20|21)\d{2}K|[23]\d{6,7}[A-Z]{0,3})/i, '小米/Redmi'],
  [/^(SM-[A-Z]\d+|GT-[A-Z]\d+)/i, '三星'],
  [/^(BLK|ALN|REA|NEO)/i, '真我(realme)'],
  [/^(PGT|PEM|ALA|CDY|NCO|DCO|MHA)-/i, '华为'],
  [/^(WGR|ANY|TNN|ABA)-/i, '荣耀'],
  [/^(CPH|PAD)\d+/i, 'OPPO/一加'],
];

/**
 * 从 UA 推断设备名称。
 * @param ua   User-Agent 原始串
 * @param type 已判定的设备类型（pc/mobile/pad），用于兜底措辞
 * @returns    如「vivo V2309A」「iPhone」「Windows 10/11 电脑」；认不出返回 ''
 */
export function detectDeviceName(ua: string, type?: string): string {
  const s = String(ua || '');
  // UA 为空也要给兜底措辞，否则设备列表名称是空的（比「电脑」更难认）
  if (!s) return type === 'mobile' ? '手机' : type === 'pad' ? '平板' : type === 'pc' ? '电脑' : '';

  // ── iPhone / iPad：Safari 的 UA 不含具体机型（只有 iPhone OS 17_0），只能给到产品族
  if (/\biPhone\b/i.test(s)) return 'iPhone';
  if (/\biPad\b/i.test(s)) return 'iPad';
  if (/\biPod\b/i.test(s)) return 'iPod';

  // ── 安卓：Android 13; V2309A Build/xxx   或   Android 13; V2309A
  // V5.0.19i：HeyTapBrowser（OPPO 自带浏览器）UA 是「Android 13; zh-cn; PHJ110 Build/…」——
  // locale 段（zh-cn）插在机型位之前，首段捕获会误返回 "zh-cn"。命中 locale 形态时跳过它取下一段。
  const am = s.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|\s*\)|;)/i);
  if (am) {
    let model = am[1].trim();
    // 某些定制 UA 在 ; 后跟的是 Linux/代号，抓到它反而比空着更糟
    if (/^(Linux|KO|WE|OPM|MMB|AOSP)/i.test(model)) model = '';
    // locale 段（zh-cn / en-us / zh-hans-cn 等）不是机型：向后找 Build 前的下一个分号段
    if (/^[a-z]{2,3}(-[a-z]{2,6})*$/i.test(model)) {
      const m2 = s.match(new RegExp(';\\s*' + model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ';\\s*([^;)]+?)(?:\\s+Build\\/|;|\\))', 'i'));
      model = m2 ? m2[1].trim() : '';
    }
    if (model) {
      for (const [re, brand] of BRAND_PREFIX) {
        if (re.test(model)) return brand + ' ' + model;
      }
      return model;
    }
    return 'Android 设备';
  }
  if (/Android/i.test(s)) return 'Android 设备';

  // ── Windows 收银机
  if (/Windows NT 10\.0/i.test(s)) return 'Windows 10/11 电脑';
  if (/Windows NT 6\.[123]/i.test(s)) return 'Windows 电脑';
  if (/Windows Phone/i.test(s)) return 'Windows 手机';
  if (/Windows/i.test(s)) return 'Windows 电脑';
  if (/Mac OS X|Macintosh/i.test(s)) return 'Mac 电脑';

  // ── 兜底：只按类型给中性措辞，总比空着强
  return type === 'pc' ? '电脑' : type === 'pad' ? '平板' : type === 'mobile' ? '手机' : '';
}

/**
 * 判定设备类型。**以 UA 为准**，前端自报的 type 只在 UA 无法判定时兜底 ——
 * 管理后台曾在手机浏览器上硬编码 'pc'，导致设备列表类型全错。
 */
export function detectDeviceType(ua: string, claimed?: string): 'pc' | 'mobile' | 'pad' | null {
  const s = String(ua || '');
  if (s) {
    if (/\biPad\b|\bTablet\b|\bPlayBook\b|\bSilk\b/i.test(s)) return 'pad';
    if (/Android/i.test(s) && !/\bMobile\b/i.test(s)) return 'pad';
    if (/\bMobi\b|\biPhone\b|\biPod\b|Android|\bWindows Phone\b/i.test(s)) return 'mobile';
    if (/Windows NT|Macintosh|Mac OS X|X11|Linux x86/i.test(s)) return 'pc';
  }
  const c = String(claimed || '').trim();
  return c === 'pc' || c === 'mobile' || c === 'pad' ? c : null;
}

/** 展示用中文类型名 */
export const DEVICE_TYPE_CN: Record<string, string> = { pc: '电脑', mobile: '手机', pad: '平板' };

/**
 * 汇总设备显示名。优先级（V5.0.11e）：
 *   ① 客户端自报名（APK 能通过 Android Settings.Global.DEVICE_NAME 拿到用户设的设备名，
 *      如「vivo X100」；浏览器拿不到，所以只有 APK 走得到这一档）
 *   ② 服务端主机名（仅回环设备：管理后台跑在服务器本机上时 os.hostname() = 「YL」）
 *   ③ UA 机型识别（含机型代号 → 营销名映射）
 * 都不行才返回 ''，由调用方留空。
 */
export function resolveDeviceName(opts: {
  reported?: string;   // 客户端自报（device.name）
  hostname?: string;   // 服务端主机名（回环设备）
  ua?: string;
  type?: string;
}): string {
  const rep = String(opts.reported || '').trim().slice(0, 60);
  if (rep) return rep;
  const hn = String(opts.hostname || '').trim().slice(0, 60);
  if (hn) return hn;
  return detectDeviceName(opts.ua || '', opts.type);
}
