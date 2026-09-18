/** H5 会员端静态服务器（零依赖）：node server.mjs [端口，默认 8089] */
import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8089;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  if (pathname.includes('..')) { res.writeHead(403); return res.end(); }
  // P2-M12：resolve 后强制目录内 + 未知扩展名不回读
  const rootAbs = path.resolve(ROOT) + path.sep;
  const file = path.resolve(path.join(ROOT, pathname.replace(/^\/+/, '')));
  if (!file.startsWith(rootAbs) || !(path.extname(file) in MIME)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}).listen(PORT, () => console.log(`[H5 会员端] http://localhost:${PORT}（手机访问请改为本机局域网 IP）`));
