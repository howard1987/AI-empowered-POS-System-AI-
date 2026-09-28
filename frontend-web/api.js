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
}

export function logout() {
  setAuth('', null);
  location.hash = '#/login';
}

export async function call(method, path, body) {
  const res = await fetch(API.base + path, {
    method,
    headers: {
      ...(API.token ? { authorization: 'Bearer ' + API.token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ code: -1, msg: 'HTTP ' + res.status, data: null }));
  if (res.status === 401) { logout(); }
  return j; // { code, msg, data }
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
/** 图片地址补全：/uploads/... 相对路径 → 拼后端 base（Web 后台在 :8088，图片文件在后端 :3100）
 *  V4.28.5 F-09：/uploads 已挂登录鉴权，<img src> 无法带 Authorization 头 → 自动拼 ?token=；
 *  非 /uploads 图片（data:/blob: 等）不受影响。 */
export const imgUrl = p => {
  const s = String(p || '');
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  const url = API.base + (s.startsWith('/') ? s : '/' + s);
  if (!/^\/uploads\//.test(s) || !API.token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(API.token);
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
