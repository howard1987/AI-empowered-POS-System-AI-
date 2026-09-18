/**
 * 顾客副屏（客显）通道（V4.21.0 P16 批2 · §13.16）
 *  - 主屏（PWA 收银台 / EXE）登录后 POST /display/push 推送实时状态（购物明细/金额/支付引导/会员卡/台位）
 *  - 副屏（EXE secondWindow 或任意浏览器第二窗口）打开 GET /display 页面（backend/public/display/index.html 静态），
 *    经 GET /display/events SSE（EventSource 断线自动重连）接收广播——E3 副屏断连主屏角标提示、恢复自动续推
 *  - 快照按店驻留内存（进程重启副屏自动收到最新一帧）；配置（店招/欢迎语/轮播）GET /display/cfg 免登录读取
 *  - 局域网部署形态：/display 与 SSE 仅本店网络可达，不承载敏感数据（只推脱敏后的展示字段）
 */
import { Module, Controller, Post, Get, Body, Query, Res } from '@nestjs/common';
import { q1 } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { SettingsService } from './settings.module';

/** 每店最新快照 + 订阅连接（进程内） */
const snapshot = new Map<number, { payload: any; ts: number }>();
const clients = new Map<number, Set<any>>();

function broadcast(storeId: number, event: string, data: any) {
  const set = clients.get(storeId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(frame); } catch { set.delete(res); } }
}

@Controller('display')
class DisplayController {
  private settings = new SettingsService();

  /** 主屏推送（登录即可：收银台/移动收银共用；只存展示字段，不落库） */
  @Post('push')
  async push(@CurrentUser() user: AuthUser, @Body() payload: any) {
    if (!payload || typeof payload !== 'object') throw new BizException(40003, '推送内容为空');
    const clean = { ...payload };
    delete clean.token;   // 防误传凭据
    const snap = { payload: clean, ts: Date.now() };
    snapshot.set(user.storeId, snap);
    broadcast(user.storeId, 'state', clean);
    return { ok: true, clients: (clients.get(user.storeId) || new Set()).size };
  }

  /** SSE 事件流（副屏订阅；@Public：副屏无操作员登录，靠局域网边界保护） */
  @Public()
  @Get('events')
  events(@Query('store') storeQ?: string, @Res() res?: any) {
    const storeId = Number(storeQ) || 1;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // 握手：先发当前快照（进程重启/副屏晚开也能立即还原画面）
    const snap = snapshot.get(storeId);
    if (snap) res.write(`event: state\ndata: ${JSON.stringify(snap.payload)}\n\n`);
    let set = clients.get(storeId);
    if (!set) { set = new Set(); clients.set(storeId, set); }
    set.add(res);
    // 25s 心跳防代理断流
    const hb = setInterval(() => { try { res.write(`: hb\n\n`); } catch { /* 断开由 close 统一清理 */ } }, 25000);
    res.on('close', () => { clearInterval(hb); set!.delete(res); });
  }

  /** 副屏配置（店招/欢迎语/轮播；免登录局域网读取） */
  @Public()
  @Get('cfg')
  async cfg(@Query('store') storeQ?: string) {
    const storeId = Number(storeQ) || 1;
    const [store, welcome, ads] = await Promise.all([
      q1(`SELECT name FROM stores WHERE id=$1`, [storeId]).catch((): any => null),
      this.settings.getVal('display.welcome').catch((): any => undefined),
      this.settings.getJson('display.ads', []).catch((): any[] => []),
    ]);
    return {
      storeName: String(store?.name ?? '').trim() || '社区超市',
      welcome: String(welcome ?? '').trim() || '欢迎光临',
      ads: Array.isArray(ads) ? ads.filter(a => a && (a.title || a.image)).slice(0, 20) : [],
    };
  }

  /**
   * V4.22.0 P16 批3：串口客显 GBK 编码助手（浏览器无 GBK 编码器，服务端 iconv-lite 代编）。
   * 输入 texts[]，返回逐条 base64(GBK)。仅展示文本，无敏感数据；@Public 与副屏同边界。
   */
  @Public()
  @Post('gbk')
  gbk(@Body() b: { texts?: string[] }) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const iconv = require('iconv-lite');
    const texts = Array.isArray(b?.texts) ? b.texts.slice(0, 16) : [];
    return { items: texts.map(t => iconv.encode(String(t ?? '').slice(0, 64), 'gbk').toString('base64')) };
  }
}

@Module({ controllers: [DisplayController] })
export class DisplayModule {}
