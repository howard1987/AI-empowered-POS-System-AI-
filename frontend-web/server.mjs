/**
 * Web 后台静态服务（零依赖，Node 内置 http）：
 *   node server.mjs        → http://localhost:8088
 * 后端 API 直连（NestJS 已 enableCors），默认 http://localhost:3100，登录页可改。
 * 也可整体拷贝本目录到 backend/public/ 由后端静态托管（同源免配置）。
 */
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '') p = '/index.html';
    if (p.includes('..')) { res.writeHead(403); return res.end(); }
    // P2-M12：resolve 后强制目录内 + 未知扩展名不回读（防 .log/.env/源码旁路下载；兄弟目录前缀绕过一并关闭）
    const rootAbs = resolve(ROOT) + sep;
    const file = resolve(join(ROOT, p.replace(/^\/+/, '')));
    if (!file.startsWith(rootAbs) || !(extname(file) in MIME)) { res.writeHead(403); return res.end(); }
    const buf = await readFile(file);
    // 独立端口部署（开发/分离部署）时注入后端地址：api.js 兜底会读 window.__API_BASE__
    // 由服务端静态托管（/admin）时不注入，api.js 自动回落 window.location.origin 同源
    const inject = extname(file) === '.html'
      ? `<script>window.__API_BASE__=${JSON.stringify(process.env.API_BASE || 'http://localhost:3100')};</script>`
      : '';
    const body = inject
      ? buf.toString('utf8').replace(/<head([^>]*)>/i, (m) => m + inject)
      : buf;
    const noCache = ['.html', '.js', '.css', '.json'].includes(extname(file));
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      // html/js/css 永不长效缓存：改版立即生效，避免浏览器/中间层拿旧界面
      ...(noCache ? { 'cache-control': 'no-cache, must-revalidate' } : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}).listen(PORT, () => {
  console.log(`[Web 管理后台] http://localhost:${PORT}  （后端 API 默认 http://localhost:3100）`);
});
