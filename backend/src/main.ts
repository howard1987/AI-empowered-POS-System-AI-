import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { json } from 'express';
import { existsSync, mkdirSync } from 'fs';
import * as fs from 'fs';
import * as https from 'https';
import { AppModule } from './app.module';
import { runWithStoreCtx } from './common/context';
import { ensureLanCert, MDNS_HOST } from './common/cert';
import { startMdns } from './common/mdns';
import { logError } from './common/logger';

// ── 进程级兜底（收银系统=门店关键服务，进程退出=全店收银中断）──
// VQA-C2：启动轮转——error.log 超 5MB 滚动为 .1（单代备份，防无限增长）
try {
  const __lf = join(__dirname, 'logs', 'error.log');
  if (existsSync(__lf) && fs.statSync(__lf).size > 5 * 1024 * 1024) fs.renameSync(__lf, __lf + '.1');
} catch { /* 轮转失败不影响启动 */ }
// 背景：PG 瞬断 / 并发竞态等偶发未捕获异常会以 code=1 直接打崩整个后端，
// 且崩溃时 stderr 无栈可查。策略：任何未捕获异常/拒绝 → 追加写 logs/error.log + 控制台，进程继续存活；
// 坏掉的数据库连接由 pg-pool 自动丢弃重建，单个失败请求由业务层返回错误重试。
// Q-07 #8：logFatal 迁移到统一 logger（error.log 由 logger.ts 独占写）
const logFatal = (tag: string, e: unknown) => logError(tag, e);
process.on('uncaughtException', (e) => logFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => logFatal('unhandledRejection', e));

const BOOT_START = Date.now();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // P3-1：请求级店铺上下文（守卫认证通过后写入 holder，业务 SQL 经 curStore() 取权威 store_id）
  app.use((_req: any, _res: any, next: any) => runWithStoreCtx(() => next()));
  // P2-M12b：仅放行本机回环来源（各端口）与 Electron file://（null origin）；
  // V4.18.9 规范化：未授权来源直接 403（原 cors 回调抛 Error 会变 500，渗透测试 OBSERVE 项）
  // V4.21.1：放行局域网——同网段收银机/手机（私有 IPv4）、mDNS 域名（*.local）、同主机来源
  //          （此前 192.168.x 收银机与手机扫码登录被 403「CORS 未授权来源」拦死；本地化部署系统，内网来源可信）
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    let ok = !origin || origin === 'null';
    if (!ok) {
      try {
        const u = new URL(origin);
        const host = u.hostname;
        const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(host);
        const sameHost = !!req.headers.host && (host + (u.port ? ':' + u.port : '')) === String(req.headers.host);
        // V4.28.0 安全修复（F-15，P2-M12b 整改回归）：收银机/手机/老板端全部为同源加载（页面与 API 同主机），
        // 正常业务无需跨源；收紧为 回环 + 同主机，不再放行整个私有网段（防内网跨源带凭据请求）
        ok = loopback || sameHost;
      } catch { ok = false; }
    }
    if (!ok) return res.status(403).json({ code: 40300, msg: 'CORS 未授权来源', data: null });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH');
      res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] || '*'));
      return res.sendStatus(204);
    }
    next();
  });
  // P4 HSTS（可选/默认关闭）：自签名证书 LAN 部署启用 HSTS 会锁死浏览器，故仅在生产可信证书 + ENABLE_HSTS=true 时发送
  if (process.env.ENABLE_HSTS === 'true') {
    app.use((_req: any, res: any, next: any) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });
  }
  // ── V4.28.5 F-09：/uploads 图片目录鉴权（P1）——登录前不可直接翻图 ──
  //  目录里有报损照片/电子签名/AI 识别帧/退款凭证等敏感图片，此前任何人不登录即可按路径直读。
  //  接受 ① Authorization: Bearer <jwt>（fetch/XHR）② ?token=<jwt>（<img src> 场景）。
  //  仅校验登录态（员工 token；member token 与无效 token 一律 401）。中间件注册在两条静态路由之前，
  //  外置目录（AI_UPLOADS_DIR）与 public/uploads（useStaticAssets）统一被拦。
  {
    const { JWT_SECRET } = await import('./common/auth');
    const jwt = (await import('jsonwebtoken')).default;
    app.use('/uploads', (req: any, res: any, next: any) => {
      try {
        const m = /^Bearer (.+)$/.exec(String(req.headers['authorization'] || ''));
        const token = m ? m[1] : String(req.query.token || '');
        if (!token) throw new Error('no token');
        const payload: any = jwt.verify(token, JWT_SECRET);
        if (payload?.kind === 'member') throw new Error('member token 不可读员工图片');
        // V5.0.19h（F-05）：query 传 token 必须是 60s img 短时票据（见 /auth/img-ticket），
        // 拒绝长效员工 JWT 走 URL（防 access log/Referer 泄露后长期冒用）。header 场景不变（fetch 仍可用长效 token）。
        if (!m && payload?.scope !== 'img') throw new Error('URL token 须为 img 短时票据');
        next();
      } catch {
        res.status(401).json({ code: 40100, msg: '图片目录需登录后访问（F-09）', data: null });
      }
    });
  }
  // S-03：签名 PNG 落盘 public/signatures，此前与 /uploads 同为静态直读、无需登录即可按路径取（顾客签字可被冒名/泄露）。
  //   复用 /uploads 同款鉴权闸门（Bearer 或 ?token；member token 一律 401）。
  {
    const { JWT_SECRET: SIG_JWT_SECRET } = await import('./common/auth');
    const sigJwt = (await import('jsonwebtoken')).default;
    app.use('/signatures', (req: any, res: any, next: any) => {
      try {
        const m = /^Bearer (.+)$/.exec(String(req.headers['authorization'] || ''));
        const token = m ? m[1] : String(req.query.token || '');
        if (!token) throw new Error('no token');
        const payload: any = sigJwt.verify(token, SIG_JWT_SECRET);
        if (payload?.kind === 'member') throw new Error('member token 不可读签名图片');
        // V5.0.19h（F-05）：同 /uploads，query 须为 img 短时票据（见 /auth/img-ticket）
        if (!m && payload?.scope !== 'img') throw new Error('URL token 须为 img 短时票据');
        next();
      } catch {
        res.status(401).json({ code: 40100, msg: '签名目录需登录后访问（S-03）', data: null });
      }
    });
  }
  // V4.15.5：AI 图片目录外置（冷热分层）——AI_UPLOADS_DIR 指向其他数据盘/NAS 时，/uploads 静态路由跟随
  const uploadsExternal = process.env.AI_UPLOADS_DIR;
  if (uploadsExternal) {
    if (!existsSync(uploadsExternal)) mkdirSync(uploadsExternal, { recursive: true });
    app.use('/uploads', (await import('express')).default.static(uploadsExternal));
    console.log(`  图片目录: ${uploadsExternal}（AI_UPLOADS_DIR 外置）`);
  }
  // V4.27.9：前端资源禁用启发式缓存——no-cache（每次带 ETag 协商，内容未变返回 304，不浪费流量）。
  //  根因：Express 静态默认不带 Cache-Control，浏览器按启发式策略把 cashier.js 等当"仍新鲜"，
  //  收银端重启 EXE 也读到旧文件（F1 键位说明不同步即此因）。no-cache = 永远校验、永远最新。
  // ── PWA CSP（安全审计整改 P4）：阻断「XSS → Electron IPC」利用链 ──
  //   严格策略（主 PWA）：script-src 仅 'self' + 'wasm-unsafe-eval'（zxing-wasm 用 WebAssembly.instantiate 必须），
  //     无 'unsafe-inline'/'unsafe-eval' → 注入的内联脚本/处理器/ eval 一律拒绝。
  //   放行项：拍照 data URL 转 blob(fetch data:) 与相机 blob 预览需 data:/blob:（connect-src/img-src/media-src）；
  //     小票打印 iframe 走 blob: 需 frame-src blob:；同源 API 走 'self'。
  //   放宽策略（ai-train-env.html / label-review.html）：这两页是首方可信内联脚本（已 esc 渲染、无 eval），
  //     允许 'unsafe-inline' 但不放 'unsafe-eval'，仍禁外链/object/eval。
  const PWA_CSP_STRICT = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'; frame-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'";
  const PWA_CSP_RELAXED = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'; frame-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'";
  app.useStaticAssets(join(__dirname, '..', 'public'), {
    setHeaders: (res: any, p: string) => {
      if (/\.(js|mjs|html|webmanifest|css)$/i.test(p)) {
        // 管理端（/admin/）禁用缓存：浏览器若缓存 index.html 就会锁死 ?v= 版本号，
        // 导致改版后 CSS/JS 永远命中旧缓存（Ctrl+F5 也可能无效），故用 no-store 强制回源。
        // PWA 保持 no-cache，离线能力仍由其 Service Worker 负责。
        res.setHeader('Cache-Control', /[\\/]admin[\\/]/.test(p) ? 'no-store' : 'no-cache');
      }
      // 仅对 /pwa/ 下文档与资源下发 CSP（管理页/display/上传目录不受影响，避免误伤）
      if (/[\\/]pwa[\\/]/.test(p)) {
        const relaxed = /(^|[\\/])(ai-train-env|label-review)\.html$/.test(p);
        res.setHeader('Content-Security-Policy', relaxed ? PWA_CSP_RELAXED : PWA_CSP_STRICT);
      }
      // V5.0.19i（F-08）：admin/member 页防点击劫持 —— meta CSP 不支持 frame-ancestors，反嵌套走 HTTP 头
      if (/[\\/](admin|member)[\\/]/.test(p)) {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      }
    },
  }); // 极简管理页
  // 照片类接口（上传样本/凭证/AI 识别）走 base64 JSON，放宽到 15MB
  // （先于 Nest 默认解析器注册；body-parser 见 req._body 已置位会跳过，不双重解析）
  app.use(json({ limit: '15mb' }));

  const port = Number(process.env.PORT || 3000);
  const bindHost = process.env.BIND_HOST || undefined;   // P4：留空=监听全部网卡（LAN 收银兼容）；生产可设内网网卡/127.0.0.1
  await app.listen(port, bindHost);
  if (!bindHost) {
    console.warn(`  [安全] BIND_HOST 未设置，服务监听全部网卡（0.0.0.0）。若服务器有公网可达 IP，请设 BIND_HOST 为内网网卡或在防火墙限制 ${port}/${Number(process.env.HTTPS_PORT || 3443)} 端口`);
  }
  console.log(`[收银系统后端] 已启动 http://localhost:${port}（HTTP 就绪耗时 ${Date.now() - BOOT_START}ms）`);
  console.log(`  健康检查: http://localhost:${port}/health`);
  console.log(`  管理页:   http://localhost:${port}/index.html`);

  // ── HTTPS（手机端摄像头必须安全上下文：getUserMedia 仅 HTTPS 可用）──
  // 证书自动跟随动态 IP：每次启动比对当前网卡 IP 与 certs/meta.json 记录，
  // IP 变了（换路由器/DHCP 重新分配/换网段）自动重新签发，二维码地址实时取当前 IP，随之更新。
  const info = await ensureLanCert(join(__dirname, '..', 'certs'));
  const keyPath = join(info.dir, 'key.pem');
  const certPath = join(info.dir, 'cert.pem');
  if (!info.error && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const server = https.createServer(
        { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
        app.getHttpAdapter().getInstance() as any,
      );
      server.on('error', (e: any) => console.warn(`[HTTPS] 服务器异常（已兜底，不退出）: ${e?.message}`));
      const httpsPort = Number(process.env.HTTPS_PORT || 3443);
      await new Promise<void>(res => server.listen(httpsPort, bindHost, () => res()));
      console.log(`  HTTPS:    https://localhost:${httpsPort} （手机端 PWA 走此端口，首次访问需信任自签名证书）`);
      // mDNS 域名广播：设备用 https://pos-server.local:3443 访问，服务器 IP 变化无需改任何配置
      startMdns();
      console.log(`  域名访问: https://${MDNS_HOST}:${httpsPort}/pwa/ （推荐；IP 直连 https://${info.ips[0] || '本机IP'}:${httpsPort}/pwa/ 备用）`);
      if (info.regenerated) console.log(`  （检测到服务器 IP 变化，证书已自动重新签发，手机重新扫码即可）`);
    } catch (e: any) {
      console.warn(`  HTTPS 启动失败（不影响 HTTP）: ${e?.message}`);
    }
  } else {
    console.warn(`  HTTPS 未启用：证书不可用（${info.error || '未知原因'}），可运行 node scripts/gen-cert.js 手动生成`);
  }
}

bootstrap();
