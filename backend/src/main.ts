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

// ── 进程级兜底（收银系统=门店关键服务，进程退出=全店收银中断）──
// VQA-C2：启动轮转——error.log 超 5MB 滚动为 .1（单代备份，防无限增长）
try {
  const __lf = join(__dirname, 'logs', 'error.log');
  if (existsSync(__lf) && fs.statSync(__lf).size > 5 * 1024 * 1024) fs.renameSync(__lf, __lf + '.1');
} catch { /* 轮转失败不影响启动 */ }
// 背景：PG 瞬断 / 并发竞态等偶发未捕获异常会以 code=1 直接打崩整个后端，
// 且崩溃时 stderr 无栈可查。策略：任何未捕获异常/拒绝 → 追加写 logs/error.log + 控制台，进程继续存活；
// 坏掉的数据库连接由 pg-pool 自动丢弃重建，单个失败请求由业务层返回错误重试。
const logFatal = (tag: string, e: unknown) => {
  const line = `[${new Date().toISOString()}] [${tag}] ${(e as any)?.stack || (e as any)?.message || String(e)}\n`;
  try {
    fs.mkdirSync(join(__dirname, '..', 'logs'), { recursive: true });
    fs.appendFileSync(join(__dirname, '..', 'logs', 'error.log'), line);
  } catch { /* 日志失败不影响主流程 */ }
  console.error(line.trimEnd());
};
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
        const privateIp = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host);
        const mdns = /\.local$/i.test(host);
        const sameHost = !!req.headers.host && (host + (u.port ? ':' + u.port : '')) === String(req.headers.host);
        ok = loopback || privateIp || mdns || sameHost;
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
  // V4.15.5：AI 图片目录外置（冷热分层）——AI_UPLOADS_DIR 指向其他数据盘/NAS 时，/uploads 静态路由跟随
  const uploadsExternal = process.env.AI_UPLOADS_DIR;
  if (uploadsExternal) {
    if (!existsSync(uploadsExternal)) mkdirSync(uploadsExternal, { recursive: true });
    app.use('/uploads', (await import('express')).default.static(uploadsExternal));
    console.log(`  图片目录: ${uploadsExternal}（AI_UPLOADS_DIR 外置）`);
  }
  app.useStaticAssets(join(__dirname, '..', 'public')); // 极简管理页
  // 照片类接口（上传样本/凭证/AI 识别）走 base64 JSON，放宽到 15MB
  // （先于 Nest 默认解析器注册；body-parser 见 req._body 已置位会跳过，不双重解析）
  app.use(json({ limit: '15mb' }));

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
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
      await new Promise<void>(res => server.listen(httpsPort, () => res()));
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
