import { Module, Controller, Get, Post, Body, Query, Param, ParseIntPipe } from '@nestjs/common';
import * as net from 'net';
import { q, q1, tx, cx } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价
import { PRODUCT_VISIBLE } from '../common/sql';       // V5.0.0 商品可售可见性

// iconv-lite：项目已有依赖（见 device.module.ts），用于中文名编码为 GBK/GB2312 字节
const iconv = require('iconv-lite');

/** 秤字段批量更新 */
interface ScaleBatchDto {
  items: { productId: number; scalePluCode?: string; scaleEnabled?: boolean; scaleHotkey?: string; scaleDepartment?: string }[];
}

/** 传秤配置（键值对） */
interface ScaleConfigDto {
  protocol?: string;
  portType?: string;
  port?: string;
  baud?: number;
  tcpHost?: string;
  tcpPort?: number;
  department?: string;
  barcodePrefix?: string;
  useMemberPrice?: boolean;
  charset?: string;
}

/** 中文名编码请求 */
interface EncodeNamesDto {
  charset?: string;
  names?: string[];
}

/** 网口 TCP 下发请求（前端组好帧，后端只做字节管道） */
interface TransmitTcpDto {
  host?: string;
  port?: number;
  frames?: number[][];
  interDelay?: number;
  readMs?: number;
  connectMs?: number;
}

const CONFIG_KEYS = [
  'scale.tx.protocol', 'scale.tx.port_type', 'scale.tx.port', 'scale.tx.baud',
  'scale.tx.tcp_host', 'scale.tx.tcp_port', 'scale.tx.department',
  'scale.tx.barcode_prefix', 'scale.tx.use_member_price', 'scale.tx.charset',
];

@Controller('scale-transmission')
class ScaleTransmissionController {

  /** 列出可传秤商品（默认仅称重商品，keyword 可扩全部） */
  @Get('products')
  async listProducts(
    @Query('keyword') keyword?: string,
    @Query('category') category?: string,
    @Query('weighted') weighted?: string,
    @Query('onlyEnabled') onlyEnabled?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const storeId = curStore();
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const p = Math.max(Number(page) || 1, 1);
    const params: any[] = [storeId];
    // V5.0.0 连锁：可售可见性（本店建档 ∪ 总部已下发且上架）
    const conds: string[] = ['p.deleted_at IS NULL', PRODUCT_VISIBLE('$1')];

    if (weighted !== 'false') {
      conds.push('(p.is_weighted = true OR p.base_unit IN (\'kg\',\'克\',\'斤\',\'g\'))');
    }
    if (onlyEnabled === 'true') conds.push('p.scale_enabled = true');
    if (category) { params.push(category); conds.push(`p.category_id=$${params.length}`); }
    if (keyword) {
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
      const i = params.length - 3;
      conds.push(`(p.name ILIKE $${i} OR p.pinyin_code ILIKE $${i + 1} OR p.barcode ILIKE $${i + 2} OR p.goods_no ILIKE $${i + 2})`);
    }

    const where = conds.join(' AND ');
    const total = Number((await q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM products p WHERE ${where}`, params,
    ))?.n ?? 0);

    const rows = await q<any>(
      `SELECT p.id, p.goods_no, p.barcode, p.name, p.short_name, p.base_unit, p.sell_price, p.member_price,
              p.is_weighted, p.scale_plu_code, p.scale_enabled, p.scale_hotkey, p.scale_department,
              c.name AS category_name
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${where}
        ORDER BY p.scale_enabled DESC, p.category_id NULLS LAST, p.name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (p - 1) * size],
    );
    // V4.26.5 按门店隔离价格：传秤售价必须用当前门店价（传错价=收银事故）
    await storePrice.overlay(storeId, rows);

    return { rows, total, page: p, pageSize: size, pages: Math.max(Math.ceil(total / size), 1) };
  }

  /** 批量更新商品的秤字段 */
  @RequirePerms('product.manage')
  @Post('products/batch')
  async batchUpdate(@Body() body: ScaleBatchDto) {
    const storeId = curStore();
    if (!Array.isArray(body?.items) || !body.items.length) {
      throw new BizException(40002, '缺少商品列表');
    }
    await tx(async c => {
      for (const it of body.items) {
        const sets: string[] = [];
        const vals: any[] = [Number(it.productId), storeId];
        if (it.scalePluCode !== undefined) { sets.push(`scale_plu_code=$${vals.length + 1}`); vals.push(it.scalePluCode || null); }
        if (it.scaleEnabled !== undefined) { sets.push(`scale_enabled=$${vals.length + 1}`); vals.push(!!it.scaleEnabled); }
        if (it.scaleHotkey !== undefined) { sets.push(`scale_hotkey=$${vals.length + 1}`); vals.push(it.scaleHotkey || null); }
        if (it.scaleDepartment !== undefined) { sets.push(`scale_department=$${vals.length + 1}`); vals.push(it.scaleDepartment || '01'); }
        if (!sets.length) continue;
        await cx(c,
          `UPDATE products SET ${sets.join(',')}, updated_at=now() WHERE id=$1 AND store_id=$2`,
          vals,
        );
      }
    });
    return { ok: true, count: body.items.length };
  }

  /** 读取传秤配置 */
  @Get('config')
  async getConfig() {
    const storeId = curStore();
    const rows = await q<any>(
      `SELECT setting_key, value, default_value, value_type, display_name, remark
         FROM system_settings WHERE setting_key = ANY($1) ORDER BY id`, [CONFIG_KEYS],
    );
    const map: Record<string, any> = {};
    for (const r of rows) map[r.setting_key] = r.value ?? r.default_value;
    return {
      protocol: String(map['scale.tx.protocol'] || 'dahua'),
      portType: String(map['scale.tx.port_type'] || 'serial'),
      port: String(map['scale.tx.port'] || 'COM3'),
      baud: Number(map['scale.tx.baud'] || 9600),
      tcpHost: String(map['scale.tx.tcp_host'] || '192.168.1.100'),
      tcpPort: Number(map['scale.tx.tcp_port'] || 9100),
      department: String(map['scale.tx.department'] || '01'),
      barcodePrefix: String(map['scale.tx.barcode_prefix'] || '22'),
      useMemberPrice: map['scale.tx.use_member_price'] === true || map['scale.tx.use_member_price'] === 'true',
      charset: String(map['scale.tx.charset'] || 'gbk'),
    };
  }

  /** 保存传秤配置 */
  @RequirePerms('sys.settings')
  @Post('config')
  async saveConfig(@Body() body: ScaleConfigDto, @CurrentUser() user: AuthUser) {
    const map: Record<string, any> = {};
    if (body.protocol !== undefined) map['scale.tx.protocol'] = String(body.protocol);
    if (body.portType !== undefined) map['scale.tx.port_type'] = String(body.portType);
    if (body.port !== undefined) map['scale.tx.port'] = String(body.port);
    if (body.baud !== undefined) map['scale.tx.baud'] = Number(body.baud);
    if (body.tcpHost !== undefined) map['scale.tx.tcp_host'] = String(body.tcpHost);
    if (body.tcpPort !== undefined) map['scale.tx.tcp_port'] = Number(body.tcpPort);
    if (body.department !== undefined) map['scale.tx.department'] = String(body.department);
    if (body.barcodePrefix !== undefined) map['scale.tx.barcode_prefix'] = String(body.barcodePrefix);
    if (body.useMemberPrice !== undefined) map['scale.tx.use_member_price'] = !!body.useMemberPrice;
    if (body.charset !== undefined) map['scale.tx.charset'] = String(body.charset);

    await tx(async c => {
      for (const [key, val] of Object.entries(map)) {
        await cx(c,
          `UPDATE system_settings SET value=$2::jsonb, updated_by=$3, updated_at=now() WHERE setting_key=$1`,
          [key, JSON.stringify(val), user.sub],
        );
      }
    });
    return { ok: true };
  }

  /** 中文名编码：把商品名编码为秤端字符集字节，供前端组帧（GBK/GB2312） */
  @Post('encode-names')
  async encodeNames(@Body() body: EncodeNamesDto) {
    const charset = String(body?.charset || 'gbk').toLowerCase();
    const names = Array.isArray(body?.names) ? body.names.slice(0, 1000) : [];
    if (!names.length) throw new BizException(40003, '缺少名称列表');
    if (charset === 'ascii') {
      return {
        charset,
        bytes: names.map(n => Array.from(Buffer.from(String(n ?? '').replace(/[^\x20-\x7E]/g, '?'), 'ascii'))),
      };
    }
    if (!['gbk', 'gb2312', 'gb18030', 'big5'].includes(charset)) {
      throw new BizException(40004, `不支持的秤端编码：${charset}`);
    }
    try {
      return { charset, bytes: names.map(n => Array.from(iconv.encode(String(n ?? ''), charset))) };
    } catch (e: any) {
      throw new BizException(50001, '名称编码失败：' + (e?.message || '未知错误'));
    }
  }

  /** 网口 TCP 传秤：连接条码秤后逐帧下发，回收每条结果（后端只做字节管道） */
  @Post('transmit-tcp')
  async transmitTcp(@Body() body: TransmitTcpDto) {
    const host = String(body?.host || '').trim();
    const port = Number(body?.port) || 9100;
    const frames = Array.isArray(body?.frames) ? body.frames : [];
    if (!host) throw new BizException(40005, '请先填写条码秤的 IP 地址');
    if (!frames.length) throw new BizException(40006, '没有要下发的帧');
    const interDelay = Math.min(Math.max(Number(body?.interDelay) || 60, 0), 2000);
    const readMs = Math.min(Math.max(Number(body?.readMs) || 120, 0), 3000);
    const connectMs = Math.min(Math.max(Number(body?.connectMs) || 3000, 500), 15000);

    const detail: any[] = [];
    let ok = 0, fail = 0, sockErr = '';
    const sock = new net.Socket();
    let buf: Buffer = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => { buf = Buffer.concat([buf, d]); });
    sock.on('error', (e: any) => { sockErr = e?.message || 'socket error'; });
    sock.setTimeout(connectMs);

    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: any) => reject(e instanceof Error ? e : new Error(String(e?.message || e)));
        sock.once('error', onErr);
        sock.once('timeout', () => reject(new Error('连接超时')));
        sock.connect(port, host, () => { sock.removeListener('error', onErr); resolve(); });
      });

      for (let i = 0; i < frames.length; i++) {
        if (sockErr) { fail++; detail.push({ index: i, status: 'fail', msg: sockErr }); continue; }
        try {
          const bytes = Buffer.from(frames[i] || []);
          const before = buf.length;
          await new Promise<void>((resolve, reject) => {
            sock.write(bytes, (err?: any) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()));
          });
          await new Promise(r => setTimeout(r, interDelay));
          // 等待秤端回应；多数标签秤不回应，超时即视为已接收
          const deadline = Date.now() + readMs;
          while (Date.now() < deadline && buf.length === before) {
            await new Promise(r => setTimeout(r, 20));
          }
          const resp = buf.length > before ? buf.subarray(before).toString('hex') : '';
          ok++;
          detail.push({ index: i, status: 'ok', bytes: bytes.length, resp: resp || null });
        } catch (e: any) {
          fail++;
          detail.push({ index: i, status: 'fail', msg: e?.message || '写入失败' });
        }
      }
    } catch (e: any) {
      try { sock.destroy(); } catch { /* noop */ }
      throw new BizException(50002, `无法连接条码秤 ${host}:${port}（${e?.message || '未知错误'}）`);
    }
    try { sock.destroy(); } catch { /* noop */ }
    return { ok, fail, total: frames.length, detail };
  }

  /** 网口连通性测试：只建立 TCP 连接，不发送任何数据 */
  @Post('test-tcp')
  async testTcp(@Body() body: TransmitTcpDto) {
    const host = String(body?.host || '').trim();
    const port = Number(body?.port) || 9100;
    if (!host) throw new BizException(40005, '请先填写条码秤的 IP 地址');
    const connectMs = Math.min(Math.max(Number(body?.connectMs) || 3000, 500), 15000);
    const sock = new net.Socket();
    sock.setTimeout(connectMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: any) => reject(e instanceof Error ? e : new Error(String(e?.message || e)));
        sock.once('error', onErr);
        sock.once('timeout', () => reject(new Error('连接超时')));
        sock.connect(port, host, () => { sock.removeListener('error', onErr); resolve(); });
      });
      return { ok: true, host, port };
    } catch (e: any) {
      throw new BizException(50002, `无法连接 ${host}:${port}（${e?.message || '未知错误'}）`);
    } finally {
      try { sock.destroy(); } catch { /* noop */ }
    }
  }

  /** 记录一次下发日志 */
  @Post('logs')
  async createLog(@Body() body: any, @CurrentUser() user: AuthUser) {
    const storeId = curStore();
    const r = await q1<any>(
      `INSERT INTO scale_transmission_logs
         (store_id, employee_id, task_no, protocol, port_type, port_path, total_count, ok_count, fail_count, detail, status, error_msg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        storeId, user?.sub || null, String(body.taskNo || ''), String(body.protocol || ''),
        String(body.portType || 'serial'), String(body.portPath || ''),
        Number(body.totalCount || 0), Number(body.okCount || 0), Number(body.failCount || 0),
        JSON.stringify(body.detail || []), String(body.status || 'done'), body.errorMsg || null,
      ],
    );
    return { id: r?.id };
  }

  /** 下发记录列表 */
  @Get('logs')
  async listLogs(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const storeId = curStore();
    const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
    const p = Math.max(Number(page) || 1, 1);
    const total = Number((await q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM scale_transmission_logs WHERE store_id=$1`, [storeId],
    ))?.n ?? 0);
    const rows = await q<any>(
      `SELECT l.*, e.name AS employee_name
         FROM scale_transmission_logs l LEFT JOIN employees e ON e.id = l.employee_id
        WHERE l.store_id=$1
        ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`,
      [storeId, size, (p - 1) * size],
    );
    return { rows, total, page: p, pageSize: size, pages: Math.max(Math.ceil(total / size), 1) };
  }
}

@Module({ controllers: [ScaleTransmissionController] })
export class ScaleTransmissionModule {}
