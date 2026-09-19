/* 员工移动端 PWA · Service Worker（8.5）：离线缓存应用外壳
 * 网络优先（network-first）：在线总是拉最新代码并回写缓存，离线回退缓存外壳。
 * API（同源 /auth /purchase /inventory /sales ...）直通网络，离线时由 app.js 走「离线暂存队列」兜底 */
const CACHE = `pwa-shell-v78`
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
        caches.open(CACHE).then(async c => {
          await c.put(req, copy);
          // VQA：缓存条目上限 120——超出按 FIFO 淘汰最旧，防无限增长
          try {
            const keys = await c.keys();
            for (let i = 0; i < keys.length - 120; i++) await c.delete(keys[i]);
          } catch { /* 清理失败不影响响应 */ }
        });
      }
      return res;
    }).catch(() =>
      caches.match(req).then(hit => hit || caches.match('./index.html'))
    )
  );
});
