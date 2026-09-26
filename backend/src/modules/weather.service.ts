/**
 * 天气服务（V4.16.1 P10）：气象数据拉取 + 缓存 + 静默降级
 *  - 数据源：默认 Open-Meteo（免注册免 Key，Open-Meteo Geocoding 城市名→经纬度）；
 *            填了 ai.weather.qweather_key 自动切和风天气为主源（国内精度更高）
 *  - 缓存：weather_cache 表每日一行（今日+未来 3 天），1 小时刷新一次
 *  - 降级：外网失败/城市解析失败 → 静默读缓存旧值（stale 标记），绝不抛错阻塞业务（同条码链「宁缺毋滥」）
 */
import { q, q1 } from '../common/db';

export interface WxDay {
  date: string;            // YYYY-MM-DD
  tempMax: number | null;
  tempMin: number | null;
  condText: string;        // 中文：晴/多云/小雨…
  condCode: number | null; // WMO code（open-meteo）
  precipMm: number | null; // 降水量 mm
  windMax: number | null;  // 最大风速 km/h
}

/* ── WMO weather code → 中文 ── */
const WMO_CN: [number[], string][] = [
  [[0], '晴'], [[1], '多云'], [[2], '多云'], [[3], '阴'],
  [[45, 48], '雾'], [[51, 53, 55], '毛毛雨'], [[56, 57], '冻毛毛雨'],
  [[61], '小雨'], [[63], '中雨'], [[65], '大雨'], [[66, 67], '冻雨'],
  [[71], '小雪'], [[73], '中雪'], [[75], '大雪'], [[77], '雪粒'],
  [[80], '小阵雨'], [[81], '阵雨'], [[82], '强阵雨'],
  [[85, 86], '阵雪'], [[95], '雷阵雨'], [[96, 99], '雷阵雨伴冰雹'],
];
export function wmoToCn(code: number | null): string {
  if (code == null) return '未知';
  for (const [codes, name] of WMO_CN) if (codes.includes(code)) return name;
  return '未知';
}

const isRainy = (d: WxDay): boolean =>
  /雨|雪/.test(d.condText) || (d.precipMm != null && d.precipMm >= 0.1);
const isSnowy = (d: WxDay): boolean => /雪/.test(d.condText);

/* ═══ 天气经营因子（供备货建议与问答共用） ═══
 * traffic：客流系数（雨天/雪天到店客流下降）；
 * boosts：品类加成（按品类名关键词匹配，只做增量建议，下单权在人） */
export interface WxBoost { keywords: string[]; factor: number; label: string }
export interface WxFactor { date: string; condText: string; tempRange: string; traffic: number; boosts: WxBoost[]; tip: string }

export interface WxCalibration { rain?: number; snow?: number; hot?: number; cold?: number; clear?: number; days?: number; calibratedAt?: string }

/** V4.16.5 天气-销量历史对齐回归：本地沉淀 ≥30 天后，用回归比率替换固定客流系数（未校准回落固定值） */
export function dayFactor(d: WxDay, prev?: WxDay, cal?: WxCalibration | null): WxFactor {
  const boosts: WxBoost[] = [], tips: string[] = [];
  let tf = 1;
  if (isSnowy(d)) { tf = (cal && Number.isFinite(Number(cal.snow)) ? Number(cal.snow) : 0.8); tips.push('降雪天到店客流明显下降，但速冻/火锅类走量'); }
  else if (isRainy(d)) {
    tf = (cal && Number.isFinite(Number(cal.rain)) ? Number(cal.rain) : 0.9); tips.push('雨天到店客流预计下降，可少订些即兴消费品');
    boosts.push({ keywords: ['泡面', '方便面', '速食', '罐头', '火腿肠', '速冻'], factor: 1.15, label: '雨天宅家速食走量↑' });
  }
  const tmax = d.tempMax != null ? Number(d.tempMax) : null;
  const drop = prev?.tempMax != null && tmax != null ? Number(prev.tempMax) - tmax : 0;
  if (tmax != null && tmax >= 32) {
    if (cal && Number.isFinite(Number(cal.hot)) && !isRainy(d) && !isSnowy(d)) tf = Number(cal.hot);   // 高温日学习比率覆盖
    boosts.push({ keywords: ['饮料', '饮用水', '矿泉水', '冰', '雪糕', '冰淇淋', '啤酒', '乳', '酸奶', '冷饮'], factor: 1.3, label: '高温冷饮冰品走量↑' });
    tips.push(`最高温 ${tmax}℃ 偏热，冷饮/冰品/啤酒建议多备`);
  }
  if (drop >= 8 || (tmax != null && tmax <= 5)) {
    if (cal && Number.isFinite(Number(cal.cold)) && !isRainy(d) && !isSnowy(d) && !(tmax != null && tmax >= 32)) tf = Number(cal.cold);
    boosts.push({ keywords: ['速冻', '冷冻', '火锅', '饺子', '汤圆', '馄饨', '暖'], factor: 1.25, label: '降温速冻火锅走量↑' });
    tips.push(drop >= 8 ? `较前一日骤降 ${Math.round(drop)}℃，速冻/火锅类需求上升` : '气温偏低，速冻/火锅类需求上升');
  }
  if (!isRainy(d) && !isSnowy(d) && cal && Number.isFinite(Number(cal.clear)) && tmax != null && tmax < 32) tf = Number(cal.clear);   // 平常日基线比率
  if (cal?.days) tips.push(`客流系数已按本地 ${cal.days} 天天气-销量回归校准`);
  if (isRainy(d)) {
    boosts.push({ keywords: ['雨伞', '雨衣', '雨具'], factor: 1.4, label: isSnowy(d) ? '雪天防滑保暖用品走量↑' : '雨天雨具走量↑' });
  }
  if (!tips.length) tips.push('天气平稳，按正常节奏备货即可');
  return {
    date: d.date, condText: d.condText,
    tempRange: d.tempMax != null || d.tempMin != null
      ? `${d.tempMin ?? '?'}~${d.tempMax ?? '?'}℃` : '—',
    traffic: Math.round(tf * 100) / 100, boosts,
    tip: tips.join('；'),
  };
}

export function factorsOf(days: WxDay[], cal?: WxCalibration | null): WxFactor[] {
  return days.map((d, i) => dayFactor(d, i > 0 ? days[i - 1] : undefined, cal));
}

/** 读取本地回归校准（forecast/备货/问答共用；无校准返回 null） */
export async function getCalibration(): Promise<WxCalibration | null> {
  const v = await setting('ai.weather.calibration', null);
  return v && typeof v === 'object' && Number(v.days) > 0 ? v as WxCalibration : null;
}

/* ═══ 设置读取 ═══ */
async function setting(key: string, fb: any = null): Promise<any> {
  const r = await q1<{ value: any }>(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
  return r ? r.value : fb;
}

/* ═══ 城市名 → 经纬度（内存缓存，进程内不重复解析） ═══ */
const geoMem = new Map<string, { lat: number; lng: number; id?: string }>();

async function geocodeOpenMeteo(city: string): Promise<{ lat: number; lng: number; id?: string } | null> {
  const mem = geoMem.get('om:' + city);
  if (mem) return mem;
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const hit = j?.results?.[0];
    if (!hit) return null;
    const v = { lat: Number(hit.latitude), lng: Number(hit.longitude) };
    geoMem.set('om:' + city, v);
    return v;
  } catch { return null; }
}

async function geocodeQWeather(city: string, key: string, host: string): Promise<{ lat: number; lng: number; id?: string } | null> {
  const mem = geoMem.get('qw:' + city);
  if (mem) return mem;
  try {
    // 和风官方免费域名走 geoapi.qweather.com；专属 Host 走 {host}/geo/v2/city/lookup
    const legacy = host.includes('qweather.com');
    const geoHost = legacy ? 'https://geoapi.qweather.com' : `${host.replace(/\/+$/, '')}/geo`;
    const url = `${geoHost}/v2/city/lookup?location=${encodeURIComponent(city)}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { 'X-QW-Api-Key': key }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const hit = j?.location?.[0];
    if (!hit || String(j.code) !== '200') return null;
    const v = { lat: Number(hit.lat), lng: Number(hit.lon), id: String(hit.id) };
    geoMem.set('qw:' + city, v);
    return v;
  } catch { return null; }
}

/* ═══ 预报拉取（Open-Meteo / 和风） ═══ */
async function fetchOpenMeteo(lat: number, lng: number): Promise<WxDay[] | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max`
      + `&timezone=Asia%2FShanghai&forecast_days=4`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const dl = j?.daily; if (!dl?.time) return null;
    return (dl.time as string[]).map((t, i) => ({
      date: String(t),
      tempMax: dl.temperature_2m_max?.[i] ?? null,
      tempMin: dl.temperature_2m_min?.[i] ?? null,
      condCode: dl.weather_code?.[i] ?? null,
      condText: wmoToCn(dl.weather_code?.[i] ?? null),
      precipMm: dl.precipitation_sum?.[i] ?? null,
      windMax: dl.wind_speed_10m_max?.[i] ?? null,
    }));
  } catch { return null; }
}

async function fetchQWeather(lat: number, lng: number, city: string, key: string, host: string): Promise<WxDay[] | null> {
  try {
    const geo = await geocodeQWeather(city, key, host);
    const loc = geo?.id || `${lng},${lat}`;
    const base = host.includes('qweather.com') ? 'https://devapi.qweather.com' : host.replace(/\/+$/, '');
    const url = `${base}/v7/weather/3d?location=${encodeURIComponent(loc)}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { 'X-QW-Api-Key': key }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (String(j?.code) !== '200' || !Array.isArray(j?.daily)) return null;
    return j.daily.map((d: any) => ({
      date: String(d.fxDate),
      tempMax: d.tempMax != null ? Number(d.tempMax) : null,
      tempMin: d.tempMin != null ? Number(d.tempMin) : null,
      condText: String(d.textDay || d.textNight || '未知'),
      condCode: null as string | null,
      precipMm: d.precip != null && Number(d.precip) > 0 ? Number(d.precip) : null,
      windMax: d.windSpeedDay != null ? Number(d.windSpeedDay) : null,
    }));
  } catch { return null; }
}

/* ═══ 缓存读写 ═══ */
async function saveCache(storeId: number, provider: string, city: string, days: WxDay[]): Promise<void> {
  for (const d of days) {
    await q(
      `INSERT INTO weather_cache (store_id, provider, city, forecast_date, temp_max, temp_min, cond_text, cond_code, precip_mm, wind_max, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (store_id, forecast_date) DO UPDATE SET
         provider=EXCLUDED.provider, city=EXCLUDED.city, temp_max=EXCLUDED.temp_max, temp_min=EXCLUDED.temp_min,
         cond_text=EXCLUDED.cond_text, cond_code=EXCLUDED.cond_code, precip_mm=EXCLUDED.precip_mm,
         wind_max=EXCLUDED.wind_max, fetched_at=now()`,
      [storeId, provider, city, d.date, d.tempMax, d.tempMin, d.condText, d.condCode, d.precipMm, d.windMax]);
  }
}

async function readCache(storeId: number): Promise<{ days: WxDay[]; fetchedAt: Date | null; provider: string | null; city: string | null }> {
  const rows = await q<any>(
    `SELECT forecast_date, temp_max, temp_min, cond_text, cond_code, precip_mm, wind_max, provider, city, fetched_at
       FROM weather_cache WHERE store_id=$1 AND forecast_date >= CURRENT_DATE
      ORDER BY forecast_date LIMIT 4`, [storeId]);
  return {
    // pg 会把 DATE 解析成 JS Date（本地零点），必须显式格式化，否则 String() 变 "Thu Sep 10"
    days: rows.map((r: any) => ({
      date: r.forecast_date instanceof Date
        ? `${r.forecast_date.getFullYear()}-${String(r.forecast_date.getMonth() + 1).padStart(2, '0')}-${String(r.forecast_date.getDate()).padStart(2, '0')}`
        : String(r.forecast_date).slice(0, 10),
      tempMax: r.temp_max != null ? Number(r.temp_max) : null,
      tempMin: r.temp_min != null ? Number(r.temp_min) : null,
      condText: r.cond_text || '未知', condCode: r.cond_code != null ? Number(r.cond_code) : null,
      precipMm: r.precip_mm != null ? Number(r.precip_mm) : null,
      windMax: r.wind_max != null ? Number(r.wind_max) : null,
    })),
    fetchedAt: rows[0]?.fetched_at ? new Date(rows[0].fetched_at) : null,
    provider: rows[0]?.provider || null,
    city: rows[0]?.city || null,
  };
}

/* ═══ 主入口：取今日+未来 3 天天气（1 小时节流；失败降级读缓存） ═══ */
let lastFetchAt = 0;   // 进程内节流：30 分钟内不重复打外网
export async function getWeather(storeId = 1): Promise<{
  enabled: boolean; provider: string; city: string; stale: boolean;
  days: WxDay[]; factors: WxFactor[]; fetchedAt: string | null; note?: string;
}> {
  const enabled = Boolean(await setting('ai.weather.enabled', true));
  const city = String(await setting('ai.weather.city', '') || '').trim();
  const empty = { enabled, provider: '', city, stale: false, days: [] as WxDay[], factors: [] as WxFactor[], fetchedAt: null as string | null };
  if (!enabled) return { ...empty, note: '天气因素未开启（设置-AI赋能-天气因素接入）' };
  if (!city) return { ...empty, note: '未配置天气城市（设置-AI赋能-天气城市）' };

  const key = String(await setting('ai.weather.qweather_key', '') || '').trim();
  // V4.16.6：Host 规范化——用户常漏填 https:// 前缀（k85rk….qweatherapi.com），缺 scheme 时 fetch 直接抛错静默回落 open-meteo
  let host = String(await setting('ai.weather.qweather_host', 'https://devapi.qweather.com') || 'https://devapi.qweather.com').trim();
  if (host && !/^https?:\/\//i.test(host)) host = 'https://' + host;

  const cache = await readCache(storeId).catch(() => ({ days: [] as WxDay[], fetchedAt: null as Date | null, provider: null as string | null, city: null as string | null }));
  // V4.28.9 配置感知：城市变更，或（配置了和风 key 但缓存仍是 Open-Meteo 拉）→ 缓存视为过期，
  // 且绕过 1 小时缓存与 30 分钟节流——否则改配置后首页一直吃旧缓存（安装版首测实证）。
  const cfgChanged = (!!cache.city && cache.city !== city)
    || (!!key && cache.provider === 'open-meteo');
  const fresh = !cfgChanged && cache.days.length > 0 && cache.fetchedAt != null
    && (Date.now() - cache.fetchedAt.getTime()) < 3600_000;
  const throttle = cfgChanged ? 60_000 : 1_800_000;   // 配置变更后 1 分钟最多重试一次外网，其余场景维持原 30 分钟节流
  if (!cfgChanged && (fresh || Date.now() - lastFetchAt < 1800_000)) {
    const days = cache.days;
    return { ...empty, provider: cache.provider || 'cache', city, stale: !fresh && days.length === 0 ? false : !fresh,
             days, factors: factorsOf(days, await getCalibration()), fetchedAt: cache.fetchedAt?.toISOString() ?? null,
             note: fresh ? undefined : (days.length ? '使用缓存（稍后自动重试拉取）' : '天气服务暂不可用，稍后自动重试') };
  }
  if (Date.now() - lastFetchAt < throttle) {
    // 刚按当前配置试过外网（成功或失败）：节流窗口内先返回现状，不连击外网
    return { ...empty, provider: cache.days.length ? (cache.provider || 'cache') : '', city, stale: true,
             days: cache.days, factors: factorsOf(cache.days), fetchedAt: cache.fetchedAt?.toISOString() ?? null,
             note: '配置已更新，外网重试稍后自动进行（1 分钟内不重复请求）' };
  }
  if (cfgChanged) {
    // 清掉与当前配置不符的旧缓存行（旧城市/旧源），防旧行反复展示与误判
    await q(`DELETE FROM weather_cache WHERE store_id=$1 AND (city IS DISTINCT FROM $2 OR provider='open-meteo' AND $3<>'')`,
      [storeId, city, key]).catch(() => { /* 清理失败不影响主流程 */ });
  }

  let provider = 'open-meteo', days: WxDay[] | null = null;
  if (key) {
    const geo = await geocodeQWeather(city, key, host);
    if (geo) days = await fetchQWeather(geo.lat, geo.lng, city, key, host);
    if (days) provider = 'qweather';
  }
  if (!days) {
    const geo = await geocodeOpenMeteo(city);
    if (geo) days = await fetchOpenMeteo(geo.lat, geo.lng);
  }
  // V4.28.9：配了 key 却没拉到 → 明示回落原因（多为例行 key/专属 Host 不匹配，而非网络问题）
  const qwFailed = !!key && provider === 'open-meteo';

  if (days?.length) {
    lastFetchAt = Date.now();
    await saveCache(storeId, provider, city, days).catch(() => { /* 落库失败不影响返回 */ });
    return { ...empty, provider, city, stale: false, days, factors: factorsOf(days, await getCalibration()), fetchedAt: new Date().toISOString(),
             note: qwFailed ? '和风天气拉取失败，已回落 Open-Meteo（请检查 API Key 与控制台专属 API Host）' : undefined };
  }
  // 拉取失败：静默降级读缓存旧值
  lastFetchAt = Date.now(); // 防连击外网
  return { ...empty, provider: cache.days.length ? (cache.provider || 'cache') : '', city, stale: true,
           days: cache.days, factors: factorsOf(cache.days),
           fetchedAt: cache.fetchedAt?.toISOString() ?? null,
           note: cache.days.length ? '外网拉取失败，展示缓存旧值' : '外网拉取失败且无缓存（检查门店外网连通性）' };
}
