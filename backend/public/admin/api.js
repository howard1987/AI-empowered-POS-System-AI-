// ─── API 封装：后端 NestJS ───
// 兜底优先级：显式设置(localStorage.api_base) → 页面注入(window.__API_BASE__，独立部署时用) → 同源 window.location.origin
// 同源情形：本后台由服务端静态托管于 /admin（http://<服务器>:3100/admin/）→ origin 即后端地址，免 CORS、免手工配置
const INJECTED = window.__API_BASE__ || '';
let _base = localStorage.getItem('api_base') || INJECTED || window.location.origin;

// V4.26.2 防呆一：静态站点端口（如开发用的 8088）本身不提供 API。若 localStorage 里存的正好是
// 当前静态站点同源地址，而服务端已注入真实后端地址（__API_BASE__），一律以注入地址为准 ——
// 否则历史版本会把 8088 写进 api_base，导致所有接口 403、登录页误判「未检测到管理员」。
if (INJECTED && String(_base).replace(/\/$/, '') === String(window.location.origin).replace(/\/$/, '')) {
  _base = INJECTED;
  try { localStorage.removeItem('api_base'); } catch { /* 隐私模式忽略 */ }
}

export const API = {
  base: _base,
  token: localStorage.getItem('token') || '',
  user: JSON.parse(localStorage.getItem('user') || 'null'),
};

// V4.26.2 防呆二：启动探测。若保存/选中的地址不可用（后端换端口、地址写错），
// 自动回退到注入地址或同源，并清掉失效的 api_base，避免「一直连不上还不知道为什么」。
// V4.26.2 防呆二：自检/登录前同步确认可用地址（避免异步回退来不及，页面已用错地址拿完结果）。
// 依次探测 当前base → 注入地址 → 同源，取第一个 /health 返回 200 的；都失败则退回注入地址。
export async function ensureBase() {
  const list = [API.base, INJECTED, window.location.origin].filter(Boolean);
  const uniq = [...new Set(list.map(x => String(x).replace(/\/$/, '')))];
  for (const c of uniq) {
    try {
      const r = await fetch(c + '/health', { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (r.ok && j && (j.code === 0 || j.data)) {
        if (c !== API.base) {
          try { localStorage.removeItem('api_base'); } catch { /* noop */ }
          API.base = c;
        }
        return API.base;
      }
    } catch { /* 换下一个候选 */ }
  }
  if (INJECTED) API.base = INJECTED;
  return API.base;
}

(function probeBase() {
  const fallback = INJECTED || window.location.origin;
  if (!fallback || fallback === API.base) return;
  fetch(String(API.base).replace(/\/$/, '') + '/health', { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('bad'); })
    .catch(() => {
      try { localStorage.removeItem('api_base'); } catch { /* noop */ }
      API.base = fallback;
      console.warn('[api] 后端地址不可用，已自动回退到 ' + fallback);
    });
})();

export function setAuth(token, user) {
  API.token = token || '';
  API.user = user || null;
  if (token) localStorage.setItem('token', token); else localStorage.removeItem('token');
  if (user) localStorage.setItem('user', JSON.stringify(user)); else localStorage.removeItem('user');
  // V5.0.19h（F-05）：登录成功预取图片票据并启动定时刷新；登出清票据
  if (token) { refreshImgTicket(); ensureImgTicketTimer(); } else clearImgTicket();
}

export function logout() {
  setAuth('', null);
  location.hash = '#/login';
}

export async function call(method, path, body, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts && opts.timeout ? opts.timeout : 15000);
  try {
    const res = await fetch(API.base + path, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(API.token ? { authorization: 'Bearer ' + API.token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => ({ code: -1, msg: 'HTTP ' + res.status, data: null }));
    if (res.status === 401) { logout(); }
    return j; // { code, msg, data }
  } catch (e) {
    clearTimeout(timer);
    // F-03：弱网下 fetch 抛错（超时/DNS/断网）统一返回 {code:-1}，避免 unhandledrejection 致页面「点了没反应」
    return {
      code: -1,
      msg: e && e.name === 'AbortError' ? '请求超时，请稍后重试' : '网络异常，请检查连接',
      data: null,
    };
  }
}

export const get  = p => call('GET', p);
export const post = (p, b) => call('POST', p, b ?? {});
export const put  = (p, b) => call('PUT', p, b);
export const del  = p => call('DELETE', p);

/** V4.26.2：统一解包 —— 后端 WrapInterceptor 把一切响应包成 {code,msg,data}。
 *  直接 `await get(...)` 拿到的是**完整响应**，业务字段在 .data 里；本函数兼容两种形态：
 *  是包装体 → 返回 .data；否则（已是裸数据/数组）原样返回。 */
export function unwrap(r) {
  return (r && typeof r === 'object' && !Array.isArray(r) && ('code' in r || 'msg' in r) && 'data' in r)
    ? r.data
    : r;
}
/** 解包并规整为数组：data 可能是数组，也可能是 {items:[...]} */
export function unwrapList(r, key = 'items') {
  const d = unwrap(r);
  if (Array.isArray(d)) return d;
  return (d && Array.isArray(d[key])) ? d[key] : [];
}

// ─── 展示工具 ───
export const money = n => '¥' + Number(n ?? 0).toFixed(2);
/** 两位小数（不带 ¥）：金额/数量列统一口径（原各屏各自 `fmt` 的收敛点） */
export const num2 = n => (Number(n) || 0).toFixed(2);
// V5.0.19h（F-05）：图片短时票据 —— <img src> 无法带 Authorization 头，旧实现拼长效 JWT 进 ?token=，
// 一旦被 access log/Referer/历史记录捕获即可长期冒用。改用 /auth/img-ticket 签发的 60s 短时票据：
// ①泄露窗口 12h→60s；②scope:img 仅图片中间件接受，不能调业务接口。
// 票据缓存 50s（留 10s 余量），过期前自动刷新；setAuth 成功后预取，call 收到 401 时清缓存。
let _imgTicket = '', _imgTicketExp = 0;
export async function refreshImgTicket() {
  if (_imgTicketExp > Date.now() + 8000) return _imgTicket;
  try {
    const r = await call('POST', '/auth/img-ticket');
    _imgTicket = (r && r.data && r.data.ticket) || ''; _imgTicketExp = Date.now() + 50000;
  } catch { _imgTicket = ''; _imgTicketExp = 0; }   // 登录态丢失等 → imgUrl 退回无 token（图片 401 提示重新登录）
  return _imgTicket;
}
function clearImgTicket() { _imgTicket = ''; _imgTicketExp = 0; }
/** 幂等启动票据定时刷新（45s 刷新，票据 50s 有效，留余量）。登出后 API.token 为空 → 回调空转无副作用 */
function ensureImgTicketTimer() {
  if (ensureImgTicketTimer._t) return;
  ensureImgTicketTimer._t = setInterval(() => { if (API.token) refreshImgTicket(); }, 45000);
}
/** 图片地址补全：/uploads|/signatures 相对路径 → 拼后端 base + 60s img 票据。
 *  非 uploads/signatures 图片（data:/blob: 等）不受影响。票据未就绪时返回无 token URL（图片 401，触发重登录）。 */
export const imgUrl = p => {
  const s = String(p || '');
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  const url = API.base + (s.startsWith('/') ? s : '/' + s);
  if (!/^\/(uploads|signatures)\//.test(s) || !API.token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(_imgTicketExp > Date.now() ? _imgTicket : '');
};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 时间显示：timestamptz 转**本地**时区；纯日期串（DATE 列）原样返回防二次偏移 */
export const dt = s => {
  if (!s) return '—';
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;          // DATE 列：不解析，防 UTC 偏移显示成前一日
  const d = new Date(str);
  if (isNaN(d.getTime())) return str.replace('T', ' ').slice(0, 16);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const toast = (msg, ok = true) => {
  const el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
};

/** 统一请求 + 失败 toast（返回 data） */
export async function must(promise, okMsg) {
  const r = await promise;
  if (r.code !== 0) { toast(r.msg || ('错误码 ' + r.code), false); throw r; }
  if (okMsg) toast(okMsg);
  return r.data;
}

// F-03：弱网兜底——全局捕获未处理的 Promise 拒绝，弹出 toast 而非静默失败（桌面端范本同策略）
if (typeof window !== 'undefined' && !window.__apiUnhandledGuard__) {
  window.__apiUnhandledGuard__ = true;
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev && ev.reason;
    if (r && r.__handledByApi) return;
    console.warn('[api] 未处理的 Promise 拒绝：', r);
    try { toast('网络异常，请检查连接后重试', false); } catch { /* 早期无容器忽略 */ }
  });
}
