/* 员工移动端 PWA · Service Worker（8.5）：离线缓存应用外壳
 * 网络优先（network-first）：在线总是拉最新代码并回写缓存，离线回退缓存外壳。
 * API（同源 /auth /purchase /inventory /sales ...）直通网络，离线时由 app.js 走「离线暂存队列」兜底 */
const CACHE = 'pwa-shell-v77';   // P3-1/2：大客户价申请+批发价兜底+团购单上行；分红每日利润明细（改动必须升版本）
const SHELL = ['./', './index.html', './app.js', '../tts.js', './sign-pad.js', './ai-scan.js', './vendor/zxing.min.js', './work.js', './checkout.js', './cashier.js', './cdisp.js', './docs.js', './ops2.js', './scale.js', './voice.js', './pick-panel.js',
  './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/pwa/')) return;
  // 网络优先：在线用最新文件并回写缓存；断网回退缓存外壳
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then(hit => hit || caches.match('./index.html'))
    )
  );
});
