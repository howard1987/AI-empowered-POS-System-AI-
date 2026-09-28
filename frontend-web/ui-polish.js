/**
 * V4.26.3 UI 精修层（纯增强，零业务耦合）
 *
 *   installBackToTop()                 返回顶部：#view 滚动 > 360px 浮出，点击回顶
 *   anchorNav(view, opts)              长页面锚点导航：扫小节 → 吸顶胶囊条 + 滚动高亮
 *   applyGlass() / loadGlassSetting()  液态玻璃开关：读 ui.glass.enabled → html.no-glass
 *   segHtml(opts)                      状态筛选（分段控件，带数量角标）
 *   stepsHtml(list, cur)               步骤导航
 *   hl(text, kw) / noResult(text)      搜索命中高亮 / 无结果空态
 *
 * 用法：页面 render() 末尾调 anchorNav(view, {...})；其余为纯函数，直接取 HTML 串。
 */
import { esc, get } from './api.js';

/** 找真正的滚动容器：后台是 #view，个别页面可能自己套了滚动盒 */
export function scrollHost(el) {
  let n = el;
  while (n && n !== document.body) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    n = n.parentElement;
  }
  return document.getElementById('view') || document.scrollingElement;
}

/** ①-1 返回顶部（全局只装一次） */
export function installBackToTop() {
  if (document.getElementById('toTop')) return;
  const btn = document.createElement('button');
  btn.id = 'toTop';
  btn.className = 'glass';
  btn.title = '返回顶部';
  btn.innerHTML = '↑';
  document.body.appendChild(btn);

  const view = document.getElementById('view');
  const host = view || document.scrollingElement;
  const onScroll = () => {
    const top = view ? view.scrollTop : (window.scrollY || document.documentElement.scrollTop);
    btn.classList.toggle('show', top > 360);
  };
  host.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  btn.onclick = () => {
    if (view) view.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  onScroll();
}

/**
 * ③-4 液态玻璃开关
 * 关掉时给 <html> 加 .no-glass，样式层统一回退为实底（低配收银机 / Win7 省掉 backdrop-filter 开销）
 */
export function applyGlass(on) {
  document.documentElement.classList.toggle('no-glass', on === false);
}

/** 读后台设置 ui.glass.enabled（bool，默认开）。读不到时保守按「开」处理 */
export async function loadGlassSetting() {
  try {
    // get() 返回完整响应 {code,msg,data}，业务字段在 .data 里
    const r = await get('/settings/key/ui.glass.enabled');
    applyGlass(r?.data?.value !== false);
  } catch { applyGlass(true); }
}

/**
 * ①-3 锚点导航：把长页面里的「小节」抽成吸顶胶囊条
 * @param {HTMLElement} view  页面根节点
 * @param {object} opts
 *   scope  小节所在容器选择器（默认 view）
 *   item   小节元素选择器（默认 '[data-anchor]'；也支持 '.grp-row,.sec-row'）
 *   label  小节标题取值：'.xxx' 取子元素文本，或函数(el)=>string
 *   count  数量角标：函数(el)=>number|string
 *   prefix 生成的 id 前缀
 */
export function anchorNav(view, opts = {}) {
  // scope 可传选择器字符串，也可直接传元素（app.js 全局自动挂载走后者）
  const scope = typeof opts.scope === 'string'
    ? view.querySelector(opts.scope)
    : (opts.scope || view);
  if (!scope) return;
  /* 挂点规则：scope 本身就是页面根时，胶囊条要放在页面内第一个位置；
     此前一律 insertBefore(scope)，遇到「卡片直接挂在 view 根下」的页面（members）会把条插到 #view 外面。 */
  const mount = scope === view ? view : scope.parentNode;
  // refresh=true：容器内容重绘后重建（先摘掉挂在同层的旧胶囊条）
  if (scope.dataset.anchored === '1') {
    if (!opts.refresh) return;
    mount?.querySelectorAll(':scope > .anchors').forEach(x => x.remove());
    delete scope.dataset.anchored;
  }
  const items = [...scope.querySelectorAll(opts.item || '[data-anchor]')];
  if (items.length < 2) return;                       // 少于 2 节不值得加导航

  items.forEach((el, i) => { if (!el.id) el.id = `${opts.prefix || 'anc'}-${i}`; });

  const label = el => {
    if (typeof opts.label === 'function') return opts.label(el);
    if (opts.label) return el.querySelector(opts.label)?.textContent?.trim() || el.textContent.trim();
    return el.dataset.anchor || el.textContent.trim();
  };

  const bar = document.createElement('div');
  bar.className = 'anchors';
  bar.innerHTML = items.map(el => {
    const n = opts.count ? opts.count(el) : '';
    return `<span class="an" data-t="${el.id}">${esc(String(label(el)).slice(0, 14))}${n !== '' && n != null ? `<span class="n">${esc(String(n))}</span>` : ''}</span>`;
  }).join('');
  if (scope === view) view.prepend(bar); else mount?.insertBefore(bar, scope);
  scope.dataset.anchored = '1';

  const host = scrollHost(scope);
  const jump = el => el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  bar.querySelectorAll('.an').forEach(a => {
    a.onclick = () => {
      bar.querySelectorAll('.an').forEach(x => x.classList.toggle('on', x === a));
      jump(document.getElementById(a.dataset.t));
    };
  });

  // 滚动高亮：用 IntersectionObserver 判定「当前处于视口上部的小节」
  if ('IntersectionObserver' in window) {
    const links = new Map([...bar.querySelectorAll('.an')].map(a => [a.dataset.t, a]));
    const setOn = id => bar.querySelectorAll('.an').forEach(x => x.classList.toggle('on', x.dataset.t === id));
    let locked = null, lockT = 0;                     // 点击后短暂锁定，避免滚动过程中闪到别的小节
    bar.addEventListener('click', () => { locked = true; lockT = Date.now(); });
    const io = new IntersectionObserver(es => {
      if (locked) {
        if (Date.now() - lockT < 700) return;
        locked = null;
      }
      const vis = es.filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis.length) setOn(vis[0].target.id);
    }, { root: host, rootMargin: '-8px 0px -72% 0px', threshold: 0 });
    items.forEach(el => io.observe(el));
    // 页面被缓存/移除时断开，防泄漏
    const mo = new MutationObserver(() => { if (!document.body.contains(scope)) { io.disconnect(); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  return bar;
}

/** ①-2 状态筛选：items = [{k, t, n}]，cur = 当前选中 k */
export function segHtml(items = [], cur = '') {
  return `<div class="seg">${items.map(x =>
    `<span class="sg${String(x.k) === String(cur) ? ' on' : ''}" data-seg="${esc(String(x.k))}">${esc(x.t)}${x.n != null ? `<span class="n">${esc(String(x.n))}</span>` : ''}</span>`).join('')}</div>`;
}

/** 绑定状态筛选：onPick(k) 由调用方重渲染 */
export function bindSeg(root, onPick) {
  root.querySelectorAll?.('.seg .sg').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = () => onPick(el.dataset.seg);
  });
}

/** ①-4 步骤导航：list = ['选择商品','确认金额','完成']，cur = 当前步（0 起） */
export function stepsHtml(list = [], cur = 0) {
  return `<div class="steps">${list.map((t, i) =>
    `<span class="st${i === cur ? ' on' : ''}${i < cur ? ' done' : ''}"><i>${i < cur ? '✓' : i + 1}</i>${esc(t)}</span>`).join('')}</div>`;
}

/** ①-5 搜索命中高亮（先 esc 再插 mark，避免注入） */
export function hl(text, kw) {
  const s = text == null ? '' : String(text);
  const k = (kw || '').trim();
  if (!k) return esc(s);
  const lower = s.toLowerCase(), needle = k.toLowerCase();
  let out = '', i = 0;
  while (true) {
    const p = lower.indexOf(needle, i);
    if (p < 0) { out += esc(s.slice(i)); break; }
    out += esc(s.slice(i, p)) + '<mark class="hl">' + esc(s.slice(p, p + needle.length)) + '</mark>';
    i = p + needle.length;
  }
  return out;
}

/** ①-5 无结果空态 */
export function noResult(title = '没有找到匹配的内容', hint = '') {
  return `<div class="no-result"><div class="big">${esc(title)}</div>${hint ? `<div>${esc(hint)}</div>` : ''}</div>`;
}
