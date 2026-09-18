import { Module, Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, tx, cx, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { notifyStaff } from '../common/notices';
import { renderTestPage, renderTemplatePreview } from './print.render';
import { brandToLang, buildLayoutBytes, buildLabelTestBytes, LABEL_SIZES } from './print.label';
import { normalizeLayoutDoc } from './print.hiprint';
import { connect as netConnect, createConnection } from 'net';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { storePrice } from './store-price.service';   // V4.26.5 门店覆盖价（价签按门店）
import * as os from 'os';

/** V4.18.7b 系统驱动 RAW 直发（USB 已装 Windows 驱动的小票机，如 POS-80）：
 *  winspool RAW 字节流交打印驱动，免 WebUSB/免改驱动。打印机名=Windows「打印机和扫描仪」里的名称。
 *  返回 { ok, n, err }；脚本 backend/scripts/rawprint.ps1（纯 ASCII，PS5.1 兼容）。 */
function osRawPrint(winPrinterName: string, bytes: Buffer): { ok: boolean; n: number; err?: string } {
  const script = path.join(process.cwd(), 'scripts', 'rawprint.ps1');
  if (!fs.existsSync(script)) return { ok: false, n: 0, err: 'rawprint.ps1 缺失（部署不完整）' };
  const tmp = path.join(os.tmpdir(), `pos-raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  try {
    fs.writeFileSync(tmp, bytes);
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Printer', String(winPrinterName), '-File', tmp], { encoding: 'utf8', timeout: 20000 });
    const out = String(r.stdout || '').trim();
    const m = out.match(/^(OK\|(\d+)|ERR\|(.+))$/);
    if (r.status === 0 && m && m[2] != null) return { ok: true, n: Number(m[2]) };
    return { ok: false, n: 0, err: (m && m[3]) || out || String(r.stderr || '').slice(-200) || `exit=${r.status}` };
  } catch (e: any) {
    return { ok: false, n: 0, err: e.message || String(e) };
  } finally { try { fs.unlinkSync(tmp); } catch { /* noop */ } }
}

const DEVICE_KINDS = ['收银主机', '扫码枪', '电子秤', 'AI秤摄像头', '小票机', '副屏', '钱箱', '人脸设备'];
const PRINTER_CONNS = ['USB', '网口', '蓝牙', '串口'];   // V4.15.6 串口=浏览器 WebSerial 直驱（免系统驱动）
const PRINTER_BRANDS = ['芯烨', '佳博', '得力', '爱普生', '汉印', 'TSC', '斑马', '通用'];
const PRINTER_TYPES = ['小票', '标签'];                   // V4.15.7 P2：小票机(ESC/POS) / 标签机(TSPL/ZPL)
const LABEL_SIZE_KEYS = Object.keys(LABEL_SIZES);        // 40x30 / 50x30 / 60x40
const TEMPLATE_KINDS = ['小票58', '小票80', 'A5单据', 'A4单据', '标签'];
const BIZ_TYPES = ['receipt', 'inbound', 'return', 'order', 'transfer', 'count', 'loss', 'recon', 'settlement', 'pricetag', 'scale'];

/** 字段池（小票/单据全量字段，模板编辑器据此渲染勾选项） */
export const FIELD_POOL: Record<string, { key: string; label: string }[]> = {
  receipt: [
    { key: 'store', label: '门店' }, { key: 'orderNo', label: '单号' }, { key: 'time', label: '时间' },
    { key: 'cashier', label: '收银员' }, { key: 'items', label: '商品明细' }, { key: 'subtotal', label: '合计' },
    { key: 'discount', label: '优惠' }, { key: 'member', label: '会员' }, { key: 'coupon', label: '券抵扣' },
    { key: 'pay', label: '支付' }, { key: 'change', label: '找零' }, { key: 'points', label: '积分' },
    { key: 'thanks', label: '感谢语' },
  ],
  inbound: [
    { key: 'store', label: '门店' }, { key: 'orderNo', label: '单号' }, { key: 'supplier', label: '供应商' },
    { key: 'time', label: '日期' }, { key: 'operator', label: '经手人' }, { key: 'items', label: '明细' },
    { key: 'total', label: '合计' }, { key: 'remark', label: '备注' },
  ],
  return: [
    { key: 'store', label: '门店' }, { key: 'orderNo', label: '单号' }, { key: 'supplier', label: '供应商' },
    { key: 'time', label: '日期' }, { key: 'operator', label: '经手人' }, { key: 'items', label: '明细' },
    { key: 'total', label: '合计' }, { key: 'reason', label: '退货原因' }, { key: 'remark', label: '备注' },
  ],
  transfer: [
    { key: 'store', label: '门店' }, { key: 'orderNo', label: '单号' }, { key: 'from', label: '调出' },
    { key: 'to', label: '调入' }, { key: 'time', label: '日期' }, { key: 'operator', label: '经手人' },
    { key: 'items', label: '明细' }, { key: 'total', label: '合计' }, { key: 'remark', label: '备注' },
  ],
  count: [
    { key: 'store', label: '门店' }, { key: 'orderNo', label: '单号' }, { key: 'time', label: '日期' },
    { key: 'counter', label: '盘点人' }, { key: 'items', label: '明细' }, { key: 'diff', label: '差异' },
    { key: 'remark', label: '备注' },
  ],
  loss: [
    { key: 'store', label: '门店' }, { key: 'orderNo', label: '单号' }, { key: 'time', label: '日期' },
    { key: 'operator', label: '经手人' }, { key: 'items', label: '明细' }, { key: 'total', label: '合计' },
    { key: 'reason', label: '报损原因' }, { key: 'remark', label: '备注' },
  ],
  recon: [
    { key: 'store', label: '门店' }, { key: 'supplier', label: '供应商' }, { key: 'period', label: '账期' },
    { key: 'orderNo', label: '单号' }, { key: 'time', label: '日期' }, { key: 'items', label: '明细' },
    { key: 'total', label: '应付合计' }, { key: 'confirm', label: '确认' }, { key: 'remark', label: '备注' },
  ],
  settlement: [
    { key: 'store', label: '门店' }, { key: 'supplier', label: '供应商' }, { key: 'period', label: '账期' },
    { key: 'orderNo', label: '单号' }, { key: 'time', label: '日期' }, { key: 'items', label: '明细' },
    { key: 'total', label: '结算金额' }, { key: 'sign', label: '签字' }, { key: 'remark', label: '备注' },
  ],
  // V4.15.8 P4：标签两类（价签/秤贴）字段池
  pricetag: [
    { key: 'name', label: '品名' }, { key: 'price', label: '售价' }, { key: 'promoPrice', label: '促销价' },
    { key: 'barcode', label: '条码' }, { key: 'unit', label: '单位' }, { key: 'spec', label: '规格' },
    { key: 'keepDays', label: '保质期' },
  ],
  scale: [
    { key: 'name', label: '品名' }, { key: 'unitPrice', label: '单价' }, { key: 'weight', label: '重量' },
    { key: 'amount', label: '金额' }, { key: 'barcode', label: '条码' }, { key: 'time', label: '称重时间' },
  ],
};

/** 网口 TCP 探测（自检真实化：IP:port 可达性） */
function probe(addr: string, ms = 2500): Promise<boolean> {
  return new Promise(res => {
    const m = String(addr).trim().match(/^([0-9a-zA-Z.\-]+):(\d{1,5})$/);
    if (!m) { res(false); return; }
    const sock = netConnect(Number(m[2]), m[1]);
    const t = setTimeout(() => { sock.destroy(); res(false); }, ms);
    sock.on('connect', () => { clearTimeout(t); sock.destroy(); res(true); });
    sock.on('error', () => { clearTimeout(t); res(false); });
  });
}

/** 解析模板 content JSONB（兼容字符串/对象） */
function parseContent(c: any): any {
  if (!c) return {};
  if (typeof c === 'string') { try { return JSON.parse(c); } catch { return {}; } }
  return c;
}

// ═════════════════════ 设备管理 /devices（Device Profile 9.1）═════════════════════
@Controller('devices')
class DevicesController {

  /** 设备档案列表（kind/status 过滤；枚举列 cast text 比较） */
  @Get()
  async list(@Query('kind') kind?: string, @Query('status') status?: string, @CurrentUser() user?: AuthUser) {
    return q(
      `SELECT d.*, EXTRACT(EPOCH FROM (now() - COALESCE(d.last_heartbeat, d.created_at)))::int AS idle_sec
         FROM devices d WHERE d.store_id=$1
           AND ($2::text IS NULL OR d.kind::text=$2::text)
           AND ($3::text IS NULL OR d.status::text=$3::text)
        ORDER BY d.kind, d.id DESC`, [user!.storeId, kind || null, status || null],
    );
  }

  /** 健康看板聚合（按类型在线/离线/故障 + 在线率） */
  @Get('health')
  async health(@CurrentUser() user: AuthUser) {
    const rows = await q<any>(
      `SELECT d.kind,
              count(*)::int AS total,
              count(*) FILTER (WHERE d.status='在线')::int AS online,
              count(*) FILTER (WHERE d.status='离线')::int AS offline,
              count(*) FILTER (WHERE d.status='故障')::int AS fault
         FROM devices d WHERE d.store_id=$1 GROUP BY d.kind`, [user.storeId]);
    const total = rows.reduce((s, r) => s + r.total, 0);
    const online = rows.reduce((s, r) => s + r.online, 0);
    return { kinds: rows, total, online, offlineRate: total ? Math.round(online / total * 100) : 0 };
  }

  /** 建档（kind 枚举校验；conn_addr 必填） */
  @Post()
  @RequirePerms('device.manage')
  async create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    const kind = String(dto.kind || '');
    if (!DEVICE_KINDS.includes(kind)) throw new BizException(40003, `设备类型须为：${DEVICE_KINDS.join('/')}`);
    const name = String(dto.name || '').trim();
    if (!name) throw new BizException(40003, '设备名称必填');
    const r = await q1(
      `INSERT INTO devices (store_id, kind, name, model, conn_type, conn_addr, bound_pos, status, profile)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'在线',$8::jsonb) RETURNING id`,
      [user.storeId, kind, name, dto.model ?? null, dto.connType ?? null, String(dto.connAddr ?? ''),
       dto.boundPos ?? null, JSON.stringify(dto.profile || {})]);
    await audit(user.storeId, user.sub, '设备', 'device.create', 'device', r.id, { kind, name, addr: dto.connAddr ?? '' });
    return { id: r.id, name, kind };
  }

  /** 改档案（模型/连接/绑定收银台/参数） */
  @Put(':id')
  @RequirePerms('device.manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    const cur = await q1(`SELECT * FROM devices WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '设备不存在');
    if (dto.kind !== undefined && !DEVICE_KINDS.includes(String(dto.kind))) throw new BizException(40003, '设备类型非法');
    const r = await q1(
      `UPDATE devices SET kind=$3, name=$4, model=$5, conn_type=$6, conn_addr=$7, bound_pos=$8,
              status=$9, profile=$10::jsonb
        WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId,
       dto.kind !== undefined ? dto.kind : cur.kind,
       dto.name !== undefined ? String(dto.name).trim() : cur.name,
       dto.model !== undefined ? dto.model : cur.model,
       dto.connType !== undefined ? dto.connType : cur.conn_type,
       dto.connAddr !== undefined ? dto.connAddr : cur.conn_addr,
       dto.boundPos !== undefined ? dto.boundPos : cur.bound_pos,
       dto.status !== undefined ? dto.status : cur.status,
       JSON.stringify(dto.profile !== undefined ? dto.profile : parseContent(cur.profile))]);
    await audit(user.storeId, user.sub, '设备', 'device.update', 'device', id, { name: cur.name });
    return { id: r.id };
  }

  /** 删除（print_jobs 引用置空后删除） */
  @Delete(':id')
  @RequirePerms('device.manage')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT * FROM devices WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '设备不存在');
    await q(`DELETE FROM devices WHERE id=$1`, [id]);
    await audit(user.storeId, user.sub, '设备', 'device.delete', 'device', id, { name: cur.name });
    return { id };
  }

  /** 心跳上报（收银端/硬件网关周期调用：置在线 + 刷新时间） */
  @Post(':id/heartbeat')
  async heartbeat(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const r = await q1(
      `UPDATE devices SET status='在线', last_heartbeat=now() WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId]);
    if (!r) throw new BizException(40400, '设备不存在');
    return { id: r.id, status: '在线', at: new Date().toISOString() };
  }

  /** 设备自检：网口 TCP 探测，其余模拟；结果回写状态 + 审计留痕 */
  @Post('self-test')
  @RequirePerms('device.manage')
  async selfTest(@CurrentUser() user: AuthUser) {
    const devices = await q<any>(`SELECT * FROM devices WHERE store_id=$1`, [user.storeId]);
    const results = await Promise.all(devices.map(async d => {
      let ok: boolean;
      if (String(d.conn_type) === '网口') ok = await probe(String(d.conn_addr || ''));
      else ok = true; // USB/蓝牙/串口：本机进程不可探，按在线处理
      const status = ok ? '在线' : '故障';
      await q(`UPDATE devices SET status=$2, last_heartbeat=now() WHERE id=$1`, [d.id, status]);
      return { id: Number(d.id), name: d.name, kind: d.kind, connType: d.conn_type, addr: d.conn_addr, ok, status };
    }));
    const failed = results.filter(r => !r.ok).length;
    await audit(user.storeId, user.sub, '设备', 'device.self_test', 'device', undefined,
      { total: results.length, failed });
    return { total: results.length, failed, results };
  }
}

// ═════════════════════ 打印机管理 /printers（9.9.1 多机并存/默认机）═════════════════════
@Controller('printers')
class PrintersController {

  /** 打印机列表（含模板数） */
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return q(
      `SELECT p.*,
              (SELECT count(*) FROM print_templates t WHERE t.store_id=p.store_id)::int AS template_count
         FROM printers p WHERE p.store_id=$1 ORDER BY p.is_default DESC, p.id`, [user.storeId]);
  }

  /** 新增（conn_type 校验；本店首台自动设为默认） */
  @Post()
  @RequirePerms('printer.manage')
  async create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    const connType = String(dto.connType || '');
    if (!PRINTER_CONNS.includes(connType)) throw new BizException(40003, `连接方式须为：${PRINTER_CONNS.join('/')}`);
    const name = String(dto.name || '').trim();
    if (!name) throw new BizException(40003, '打印机名称必填');
    const addr = String(dto.connAddr || '').trim();
    if (!['串口', 'USB'].includes(connType) && !addr) throw new BizException(40003, '连接地址必填（网口 IP:port / 蓝牙MAC）');
    // V4.15.7 P2：设备类型 小票/标签；标签机纸型 40x30/50x30/60x40（width_mm 存纸宽，版式由 label_size 决定）
    const printerType = PRINTER_TYPES.includes(String(dto.printerType)) ? String(dto.printerType) : '小票';
    let width = Number(dto.widthMm) || 80;
    let labelSize = String(dto.labelSize || '40x30');
    if (printerType === '标签') {
      if (!LABEL_SIZE_KEYS.includes(labelSize)) throw new BizException(40003, `标签纸型须为：${LABEL_SIZE_KEYS.join('/')}`);
      width = Number(labelSize.split('x')[0]);
    } else {
      if (![58, 80].includes(width)) throw new BizException(40003, '纸宽仅支持 58/80mm');
      labelSize = '40x30';
    }
    const brand = PRINTER_BRANDS.includes(String(dto.brand)) ? String(dto.brand) : '通用';
    const cnt = await q1<any>(`SELECT count(*)::int AS n FROM printers WHERE store_id=$1`, [user.storeId]);
    const isDefault = cnt.n === 0 || dto.isDefault === true;
    const r = await tx(async c => {
      if (isDefault) await cx(c, `UPDATE printers SET is_default=false WHERE store_id=$1`, [user.storeId]);
      const m = await cx(c,
        `INSERT INTO printers (store_id, name, conn_type, conn_addr, width_mm, is_default, auto_reconnect, status, brand, printer_type, label_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'在线',$8,$9,$10) RETURNING id`,
        [user.storeId, name, connType, addr, width, isDefault, dto.autoReconnect !== false, brand, printerType, labelSize]);
      return m[0];
    });
    await audit(user.storeId, user.sub, '打印', 'printer.create', 'printer', r.id,
      { name, connType, addr, isDefault, brand, printerType, labelSize });
    return { id: r.id, name, isDefault };
  }

  /** 修改（连接/宽度/自动重连/名称；纸宽变更不触发重排历史） */
  @Put(':id')
  @RequirePerms('printer.manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    const cur = await q1(`SELECT * FROM printers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '打印机不存在');
    if (dto.connType !== undefined && !PRINTER_CONNS.includes(String(dto.connType))) throw new BizException(40003, '连接方式非法');
    // V4.15.7 P2：设备类型/纸型（标签机 width_mm 随纸型宽同步）
    const printerType = dto.printerType !== undefined
      ? (PRINTER_TYPES.includes(String(dto.printerType)) ? String(dto.printerType) : (() => { throw new BizException(40003, `设备类型须为：${PRINTER_TYPES.join('/')}`); })())
      : (cur.printer_type || '小票');
    let labelSize = String(cur.label_size || '40x30');
    let widthMm = dto.widthMm !== undefined ? Number(dto.widthMm) : Number(cur.width_mm);
    if (printerType === '标签') {
      labelSize = dto.labelSize !== undefined ? String(dto.labelSize) : labelSize;
      if (!LABEL_SIZE_KEYS.includes(labelSize)) throw new BizException(40003, `标签纸型须为：${LABEL_SIZE_KEYS.join('/')}`);
      widthMm = Number(labelSize.split('x')[0]);
    } else {
      if (widthMm !== undefined && ![58, 80].includes(widthMm)) throw new BizException(40003, '纸宽仅支持 58/80mm');
    }
    const r = await q1(
      `UPDATE printers SET name=$3, conn_type=$4, conn_addr=$5, width_mm=$6, auto_reconnect=$7, brand=$8, printer_type=$9, label_size=$10
        WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId,
       dto.name !== undefined ? String(dto.name).trim() : cur.name,
       dto.connType !== undefined ? dto.connType : cur.conn_type,
       dto.connAddr !== undefined ? dto.connAddr : cur.conn_addr,
       widthMm,
       dto.autoReconnect !== undefined ? !!dto.autoReconnect : cur.auto_reconnect,
       dto.brand !== undefined ? (PRINTER_BRANDS.includes(String(dto.brand)) ? String(dto.brand) : '通用') : (cur.brand || '通用'),
       printerType, labelSize]);
    await audit(user.storeId, user.sub, '打印', 'printer.update', 'printer', id, { name: cur.name });
    return { id: r.id };
  }

  /** 删除（历史打印记录置空引用） */
  @Delete(':id')
  @RequirePerms('printer.manage')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT * FROM printers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '打印机不存在');
    await tx(async c => {
      await cx(c, `UPDATE print_jobs SET printer_id=NULL WHERE printer_id=$1`, [id]);
      await cx(c, `DELETE FROM printers WHERE id=$1`, [id]);
    });
    await audit(user.storeId, user.sub, '打印', 'printer.delete', 'printer', id, { name: cur.name });
    return { id };
  }

  /** 网口 TCP 直发原始字节（V4.15.6 P1）：此前试打只探测可达性，本端点真正把 ESC/POS 字节送到打印机 */
  @Post(':id/send')
  @RequirePerms('printer.manage')
  async send(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    const p = await q1(`SELECT * FROM printers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!p) throw new BizException(40400, '打印机不存在');
    const raw = Buffer.from(String(dto.dataBase64 || ''), 'base64');
    if (['串口', 'USB'].includes(String(p.conn_type))) {
      // V4.18.7b USB+绑定系统打印机名 → 后端 winspool RAW 直发（已装驱动机器，WebUSB 不可见的场景）
      if (String(p.conn_type) === 'USB' && String(p.conn_addr || '').trim()) {
        if (!raw.length) throw new BizException(40003, '打印内容为空');
        const t0 = Date.now();
        const r = osRawPrint(String(p.conn_addr).trim(), raw);
        const cost = Date.now() - t0;
        await q(
          `INSERT INTO print_jobs (store_id, printer_id, template_id, biz_type, job_type, status, content, cost_ms, operator_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [user.storeId, id, dto.templateId ?? null, String(dto.bizType || 'receipt'),
           String(dto.jobType || '打印'), r.ok ? '成功' : '失败', `（系统驱动直发「${p.conn_addr}」 ${raw.length} 字节）`, cost, user.sub]);
        await q(`UPDATE printers SET status=$2, last_test_at=now() WHERE id=$1`, [id, r.ok ? '在线' : '故障']);
        if (!r.ok) throw new BizException(40005, `系统驱动直发失败：${r.err}（已记失败历史）`);
        return { ok: true, channel: 'os', costMs: cost };
      }
      // V4.18.6 串口/USB 直驱：字节由浏览器（WebSerial/WebUSB）发出（dataBase64 为空），这里只落打印历史
      await q(
        `INSERT INTO print_jobs (store_id, printer_id, template_id, biz_type, job_type, status, content, cost_ms, operator_id)
         VALUES ($1,$2,$3,$4,$5,'成功',$6,$7,$8)`,
        [user.storeId, id, dto.templateId ?? null, String(dto.bizType || 'receipt'),
         String(dto.jobType || '打印'), `（${p.conn_type}直驱 ${Number(dto.bytes) || raw.length} 字节）`, Number(dto.costMs) || 0, user.sub]);
      return { ok: true, channel: String(p.conn_type) === 'USB' ? 'usb' : 'serial' };
    }
    if (!raw.length) throw new BizException(40003, '打印内容为空');
    if (String(p.conn_type) !== '网口') throw new BizException(40003, `该设备连接方式为「${p.conn_type}」，仅网口支持服务端直发`);
    const m = String(p.conn_addr || '').trim().match(/^([0-9a-zA-Z.\-]+):(\d{1,5})$/);
    if (!m) throw new BizException(40003, '网口地址格式须为 IP:端口（如 192.168.1.100:9100）');
    const t0 = Date.now();
    const ok = await new Promise<boolean>(res => {
      const sock = createConnection(Number(m[2]), m[1]);
      const done = (v: boolean) => { try { sock.destroy(); } catch { /* noop */ } res(v); };
      const t = setTimeout(() => done(false), 6000);
      sock.on('connect', () => sock.end(raw, () => { clearTimeout(t); done(true); }));
      sock.on('error', () => { clearTimeout(t); done(false); });
    });
    const cost = Date.now() - t0;
    await q(
      `INSERT INTO print_jobs (store_id, printer_id, template_id, biz_type, job_type, status, content, cost_ms, operator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [user.storeId, id, dto.templateId ?? null, String(dto.bizType || 'receipt'),
       String(dto.jobType || '打印'), ok ? '成功' : '失败', `（网口直发 ${raw.length} 字节）`, cost, user.sub]);
    await q(`UPDATE printers SET status=$2, last_test_at=now() WHERE id=$1`, [id, ok ? '在线' : '故障']);
    if (!ok) throw new BizException(40005, `网口打印失败：${p.conn_addr} 不可达（已记失败历史）`);
    return { ok: true, channel: 'network', costMs: cost };
  }

  /** V4.18.7b 本机 Windows 打印机列表（USB 系统驱动直发绑定用）：Get-Printer 枚举 */
  @Get('os-list')
  @RequirePerms('printer.manage')
  async osPrinters(@CurrentUser() user: AuthUser) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Printer | ForEach-Object { "{0}|{1}|{2}" -f $_.Name, $_.PortName, $_.PrinterStatus }`],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20 });
    const items: { name: string; port: string; online: boolean }[] = [];
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const seg = line.split('|');
      if (!seg[0]) continue;
      // PrinterStatus: 3=Idle 4=Printing 5=WarmingUp 7=Offline（正常状态都算可用）
      items.push({ name: seg[0], port: seg[1] || '', online: String(seg[2]) !== '7' });
    }
    return { items };
  }

  /** 打印机品牌列表（前端下拉用，品牌通用适配）；V4.15.7 加设备类型与标签纸型 */
  @Get('brands')
  brands() {
    return { brands: PRINTER_BRANDS, conns: PRINTER_CONNS, printerTypes: PRINTER_TYPES, labelSizes: LABEL_SIZE_KEYS };
  }

  /**
   * 价签数据（V4.15.7 P2）：按商品 id 批量出「打印用字段」——零售价 + 进行中促销价（特价/定时打折，取对顾客更优）。
   * 促销价划线角标 = 前端/标签内核按 promoPrice < price 判定。
   */
  @Post('price-tags')
  @RequirePerms('printer.manage')
  async priceTags(@CurrentUser() user: AuthUser, @Body() dto: any) {
    const ids = (Array.isArray(dto?.ids) ? dto.ids : []).map(Number).filter((n: number) => n > 0).slice(0, 200);
    if (!ids.length) throw new BizException(40003, '请先勾选商品');
    const prods = await q<any>(
      `SELECT id, name, barcode, spec, base_unit, sell_price, member_price, keep_days
         FROM products WHERE store_id=$1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`, [user.storeId, ids]);
    if (!prods.length) throw new BizException(40404, '未找到可打印的商品（可能已删除）');
    // V4.26.5 按门店隔离价格：价签必须印本门店价（打折基线也随门店价走，印错价即现场事故）
    await storePrice.overlay(user.storeId, prods);
    // 进行中的行级促销：特价(specialPrice)/定时打折(rate+时间窗)，命中取更低价
    const promos = await q<any>(
      `SELECT kind, rules, scope FROM promotions
        WHERE store_id=$1 AND status='进行中' AND start_at <= now() AND end_at >= now()
          AND kind IN ('特价','定时打折')`, [user.storeId]);
    const scopeHit = (scope: any, p: any): boolean => {
      if (!scope) return true;
      const pids: number[] = (scope.productIds ?? []).map(Number);
      const cids: number[] = (scope.categoryIds ?? []).map(Number);
      if (!pids.length && !cids.length) return true;
      return pids.includes(Number(p.id)) || (p.category_id != null && cids.includes(Number(p.category_id)));
    };
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const items = prods.map(p => {
      let promoPrice: number | null = null;
      for (const pr of promos) {
        if (!scopeHit(pr.scope, p)) continue;
        if (pr.kind === '特价') {
          const sp = Math.round(Number(pr.rules?.specialPrice) * 100) / 100;
          if (sp > 0 && sp < Number(p.sell_price) && (promoPrice == null || sp < promoPrice)) promoPrice = sp;
        } else {   // 定时打折：当前时间窗内 rate 折
          const [h1, m1] = String(pr.rules?.startTime || '').split(':').map(Number);
          const [h2, m2] = String(pr.rules?.endTime || '').split(':').map(Number);
          const s1 = (h1 || 0) * 60 + (m1 || 0), s2 = (h2 || 0) * 60 + (m2 || 0);
          const inWin = s1 <= s2 ? (nowMin >= s1 && nowMin <= s2) : (nowMin >= s1 || nowMin <= s2);
          const rate = Number(pr.rules?.rate);
          if (inWin && rate > 0 && rate < 1) {
            const sp = Math.round(Math.round(Number(p.sell_price) * 100) * rate) / 100; // 决策③(A4)：售价先化整分再乘折率，杜绝元域浮点二次舍入
            if (promoPrice == null || sp < promoPrice) promoPrice = sp;
          }
        }
      }
      return {
        id: Number(p.id), name: p.name, barcode: p.barcode || '', spec: p.spec || '',
        unit: p.base_unit, price: Number(p.sell_price), promoPrice,
        keepDays: p.keep_days ? Number(p.keep_days) : null,
      };
    });
    return { items };
  }

  /**
   * 标签打印（V4.15.7 P2）：价签批量 / 秤贴。
   * 字节按品牌自动选内核（斑马=ZPL UTF-8，其余=TSPL GBK），纸型取设备 label_size。
   * 网口=服务端直发并落 print_jobs；串口=留痕并返回 base64 由浏览器 WebSerial 发送。
   */
  @Post(':id/labels')
  @RequirePerms('printer.manage')
  async labels(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    const p = await q1(`SELECT * FROM printers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!p) throw new BizException(40400, '打印机不存在');
    if (String(p.printer_type || '小票') !== '标签') throw new BizException(40003, '该设备是小票机，请在打印中心新增「标签机」后再打价签/秤贴');
    const rawItems: any[] = Array.isArray(dto?.items) ? dto.items : [];
    if (!rawItems.length) throw new BizException(40003, '打印内容为空');
    const items = rawItems.slice(0, 500).map(it => ({
      name: String(it.name || '').slice(0, 60),
      price: Number(it.price) || 0,
      promoPrice: it.promoPrice != null && Number(it.promoPrice) < Number(it.price) ? Number(it.promoPrice) : undefined,
      barcode: String(it.barcode || '').trim() || undefined,
      unit: String(it.unit || '').trim() || undefined,
      spec: String(it.spec || '').trim() || undefined,
      keepDays: it.keepDays != null ? Number(it.keepDays) : undefined,
      weight: it.weight != null ? Number(it.weight) : undefined,
      time: String(it.time || '').slice(0, 16) || undefined,
      copies: Number(it.copies) || 1,
    }));
    const [wmm, hmm] = LABEL_SIZES[String(p.label_size || '40x30')] || LABEL_SIZES['40x30'];
    const lang = brandToLang(p.brand);
    const totalCopies = items.reduce((s, it) => s + it.copies, 0);
    const jobType = String(dto.jobType || (items.some(i => i.weight != null) ? '秤贴' : '价签打印'));
    // V4.15.8 P4：模版字段显隐——dto.templateId 优先，否则按业务取默认标签模板（秤贴→scale / 其余→pricetag）
    let labelCfg: any;
    const tplBiz = jobType.includes('秤') ? 'scale' : 'pricetag';
    const tpl = dto.templateId
      ? await q1(`SELECT content FROM print_templates WHERE id=$1 AND store_id=$2 AND kind='标签'`, [Number(dto.templateId), user.storeId])
      : await q1(`SELECT content FROM print_templates WHERE store_id=$1 AND kind='标签' AND biz_type=$2 AND is_default ORDER BY id LIMIT 1`, [user.storeId, tplBiz]);
    if (tpl) { try { labelCfg = typeof tpl.content === 'string' ? JSON.parse(tpl.content) : tpl.content; } catch { labelCfg = undefined; } }
    // V4.15.9：v3(hiprint 排版) 由 normalizeLayoutDoc 转为 mm 元素渲染；v1/v2 原样
    const layoutDoc = normalizeLayoutDoc(labelCfg);
    const bytes = layoutDoc
      ? buildLayoutBytes(lang, items as any, wmm, hmm, 1, layoutDoc as any)
      : buildLayoutBytes(lang, items as any, wmm, hmm, 1, labelCfg);
    const summary = `（${lang.toUpperCase()} ${bytes.length} 字节 · ${items.length} 品 ${totalCopies} 张 · ${p.label_size}）`;
    if (['串口', 'USB'].includes(String(p.conn_type))) {
      // V4.18.7b USB+绑定系统打印机名 → 后端 RAW 直发标签
      if (String(p.conn_type) === 'USB' && String(p.conn_addr || '').trim()) {
        const r = osRawPrint(String(p.conn_addr).trim(), bytes);
        await q(
          `INSERT INTO print_jobs (store_id, printer_id, biz_type, job_type, status, content, cost_ms, operator_id)
           VALUES ($1,$2,'标签',$3,$4,$5,0,$6)`,
          [user.storeId, id, jobType, r.ok ? '成功' : '失败',
           `（系统驱动直发「${p.conn_addr}」 ${summary}）`, user.sub]);
        if (!r.ok) throw new BizException(40005, `系统驱动直发失败：${r.err}（已记失败历史）`);
        return { ok: true, channel: 'os', lang, bytes: bytes.length };
      }
      // V4.18.6 串口/USB 直驱：字节由浏览器（WebSerial/WebUSB）发出（返回 base64），这里只落打印历史
      await q(
        `INSERT INTO print_jobs (store_id, printer_id, biz_type, job_type, status, content, cost_ms, operator_id)
         VALUES ($1,$2,'标签',$3,'成功',$4,$5,$6)`,
        [user.storeId, id, jobType, summary, 0, user.sub]);
      return { ok: true, channel: String(p.conn_type) === 'USB' ? 'usb' : 'serial', lang, dataBase64: bytes.toString('base64'), bytes: bytes.length };
    }
    if (String(p.conn_type) !== '网口') throw new BizException(40003, `该设备连接方式为「${p.conn_type}」，标签直驱仅支持网口/串口/USB（蓝牙请走系统驱动）`);
    const m = String(p.conn_addr || '').trim().match(/^([0-9a-zA-Z.\-]+):(\d{1,5})$/);
    if (!m) throw new BizException(40003, '网口地址格式须为 IP:端口（如 192.168.1.100:9100）');
    const t0 = Date.now();
    const ok = await new Promise<boolean>(res => {
      const sock = createConnection(Number(m[2]), m[1]);
      const done = (v: boolean) => { try { sock.destroy(); } catch { /* noop */ } res(v); };
      const t = setTimeout(() => done(false), 6000);
      sock.on('connect', () => sock.end(bytes, () => { clearTimeout(t); done(true); }));
      sock.on('error', () => { clearTimeout(t); done(false); });
    });
    const cost = Date.now() - t0;
    await q(
      `INSERT INTO print_jobs (store_id, printer_id, biz_type, job_type, status, content, cost_ms, operator_id)
       VALUES ($1,$2,'标签',$3,$4,$5,$6,$7)`,
      [user.storeId, id, jobType, ok ? '成功' : '失败', summary, cost, user.sub]);
    await q(`UPDATE printers SET status=$2, last_test_at=now() WHERE id=$1`, [id, ok ? '在线' : '故障']);
    if (!ok) throw new BizException(40005, `标签机网口打印失败：${p.conn_addr} 不可达（已记失败历史）`);
    return { ok: true, channel: 'network', lang, bytes: bytes.length, costMs: cost };
  }

  /** 设为默认机（店内唯一） */
  @Put(':id/default')
  @RequirePerms('printer.manage')
  async setDefault(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT * FROM printers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '打印机不存在');
    await tx(async c => {
      await cx(c, `UPDATE printers SET is_default=false WHERE store_id=$1`, [user.storeId]);
      await cx(c, `UPDATE printers SET is_default=true WHERE id=$1`, [id]);
    });
    await audit(user.storeId, user.sub, '打印', 'printer.default', 'printer', id, { name: cur.name });
    return { id, isDefault: true };
  }

  /** 一键测试页：网口机真发 ESC/POS 字节（GBK 编码）；其余连接方式渲染+落历史（由浏览器/驱动出纸） */
  @Post(':id/test')
  @RequirePerms('printer.manage')
  async test(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const p = await q1(`SELECT * FROM printers WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!p) throw new BizException(40400, '打印机不存在');
    const t0 = Date.now();
    const isLabel = String(p.printer_type || '小票') === '标签';
    const content = isLabel ? renderTestPage(p) : renderTestPage(p);
    const cost = Date.now() - t0;
    let sent: boolean | null = null;   // null=非网口（走浏览器/驱动通道）
    if (String(p.conn_type) === '网口') {
      const m = String(p.conn_addr || '').trim().match(/^([0-9a-zA-Z.\-]+):(\d{1,5})$/);
      if (!m) throw new BizException(40003, '网口地址格式须为 IP:端口（如 192.168.1.100:9100）');
      const iconv = require('iconv-lite');
      const bytes = isLabel
        ? buildLabelTestBytes(brandToLang(p.brand), ...(LABEL_SIZES[String(p.label_size || '40x30')] || LABEL_SIZES['40x30']))
        : (() => {
            const text = content + '\n\n\n';
            return Buffer.concat([
              Buffer.from([0x1B, 0x40, 0x1B, 0x61, 0x01]),            // init + 居中
              iconv.encode(text, 'gbk'),
              Buffer.from([0x1D, 0x56, 0x42, 0x00]),                  // 走纸切刀
            ]);
          })();
      sent = await new Promise<boolean>(res => {
        const sock = createConnection(Number(m[2]), m[1]);
        const done = (v: boolean) => { try { sock.destroy(); } catch { /* noop */ } res(v); };
        const t2 = setTimeout(() => done(false), 6000);
        sock.on('connect', () => sock.end(bytes, () => { clearTimeout(t2); done(true); }));
        sock.on('error', () => { clearTimeout(t2); done(false); });
      });
    }
    await tx(async c => {
      await cx(c, `UPDATE printers SET last_test_at=now(), status=$2 WHERE id=$1`, [id, sent === false ? '故障' : '在线']);
      await cx(c,
        `INSERT INTO print_jobs (store_id, printer_id, job_type, status, content, cost_ms, operator_id)
         VALUES ($1,$2,'测试页',$3,$4,$5,$6)`,
        [user.storeId, id, sent === false ? '失败' : '成功', content, cost, user.sub]);
    });
    await audit(user.storeId, user.sub, '打印', 'printer.test', 'printer', id, { name: p.name, cost, sent });
    if (sent === false) throw new BizException(40005, `网口测试失败：${p.conn_addr} 不可达（已记失败历史）`);
    return { id, status: '成功', channel: sent === null ? 'browser' : 'network', costMs: cost, preview: content };
  }
}

// ═════════════════════ 打印模板 /print-templates（9.9.2/9.9.3 字段显隐/联次/预览）═════════════════════
@Controller('print-templates')
class PrintTemplatesController {

  /** 模板列表（bizType/kind 过滤；kind 枚举列 cast text） */
  @Get()
  async list(@Query('bizType') bizType?: string, @Query('kind') kind?: string, @CurrentUser() user?: AuthUser) {
    return q(
      `SELECT t.*, e.name AS updated_name
         FROM print_templates t LEFT JOIN employees e ON e.id=t.updated_by
        WHERE t.store_id=$1
          AND ($2::text IS NULL OR t.biz_type=$2::text)
          AND ($3::text IS NULL OR t.kind::text=$3::text)
        ORDER BY t.kind, t.biz_type, t.id`, [user!.storeId, bizType || null, kind || null],
    );
  }

  /** 模板字段池（编辑器勾选项） */
  @Get('fields')
  async fields() {
    return FIELD_POOL;
  }

  /** 默认模板（V4.15.8：PWA 收银取小票模版 / docprint 取 A5 模版用；仅要求登录） */
  @Get('default')
  async defaultTpl(@Query('bizType') bizType?: string, @Query('kind') kind?: string, @CurrentUser() user?: AuthUser) {
    const t = await q1(
      `SELECT id, name, kind, biz_type, content, copies FROM print_templates
        WHERE store_id=$1 AND biz_type=$2 AND ($3::text IS NULL OR kind::text=$3::text) AND is_default
        ORDER BY id LIMIT 1`, [user!.storeId, String(bizType || 'receipt'), kind || null]);
    if (!t) return null;
    return { id: Number(t.id), name: t.name, kind: t.kind, bizType: t.biz_type, copies: Number(t.copies) || 1,
      content: typeof t.content === 'string' ? JSON.parse(t.content) : t.content };
  }

  /** 恢复预置模板（缺啥补啥，已改过的同名模板不动）；V4.15.9 预置为 v2 排版内容（打开编辑器自动升级 v3） */
  @Post('restore-presets')
  @RequirePerms('print.template')
  async restorePresets(@CurrentUser() user: AuthUser) {
    const els = (o: any) => ({ version: 2, paper: { wmm: 40, hmm: 30 }, ...o });
    const want: Array<{ name: string; kind: string; bizType: string; content: any; copies: number }> = [
      { name: '标准价签', kind: '标签', bizType: 'pricetag', copies: 1, content: els({
        title: '商品价签',
        elements: [
          { id: 'e1', type: 'field', key: 'name', x: 2, y: 1.5, w: 36, h: 5, fontSize: 3, align: 'center', show: true },
          { id: 'e2', type: 'field', key: 'price', x: 2, y: 8, w: 22, h: 7, fontSize: 6, align: 'left', show: true },
          { id: 'e3', type: 'field', key: 'info', x: 2, y: 17, w: 36, h: 4, fontSize: 2.5, align: 'left', show: true },
          { id: 'e4', type: 'barcode', key: 'barcode', x: 3, y: 22, w: 34, h: 7.5, show: true },
        ] }) },
      { name: '标准秤贴', kind: '标签', bizType: 'scale', copies: 1, content: els({
        title: '称重标签',
        elements: [
          { id: 'e1', type: 'field', key: 'name', x: 2, y: 1.5, w: 26, h: 5, fontSize: 3, align: 'left', show: true },
          { id: 'e2', type: 'field', key: 'time', x: 28, y: 2, w: 10, h: 4, fontSize: 2, align: 'right', show: true },
          { id: 'e3', type: 'field', key: 'unitPrice', x: 2, y: 8, w: 22, h: 4, fontSize: 2.5, align: 'left', show: true },
          { id: 'e4', type: 'field', key: 'weight', x: 2, y: 13, w: 22, h: 4, fontSize: 2.5, align: 'left', show: true },
          { id: 'e5', type: 'field', key: 'amount', x: 2, y: 17.5, w: 24, h: 6, fontSize: 5, align: 'left', show: true },
          { id: 'e6', type: 'barcode', key: 'barcode', x: 3, y: 24, w: 34, h: 5.5, show: true },
        ] }) },
    ];
    let added = 0;
    for (const w of want) {
      const dup = await q1(`SELECT id FROM print_templates WHERE store_id=$1 AND biz_type=$2 AND kind=$3 AND name=$4`,
        [user.storeId, w.bizType, w.kind, w.name]);
      if (dup) continue;
      await q1(`INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies)
                VALUES ($1,$2,$3,$4,$5::jsonb,true,$6)`,
        [user.storeId, w.name, w.kind, w.bizType, JSON.stringify(w.content), w.copies]);
      added++;
    }
    await audit(user.storeId, user.sub, '打印', 'template.restore_presets', undefined, undefined, { added });
    return { added };
  }

  /** 新建模板（content 结构校验：title/fields/options） */
  @Post()
  @RequirePerms('print.template')
  async create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    const name = String(dto.name || '').trim();
    if (!name) throw new BizException(40003, '模板名称必填');
    const kind = String(dto.kind || '');
    if (!TEMPLATE_KINDS.includes(kind)) throw new BizException(40003, `模板类型须为：${TEMPLATE_KINDS.join('/')}`);
    const bizType = String(dto.bizType || '');
    if (!BIZ_TYPES.includes(bizType)) throw new BizException(40003, `业务类型须为：${BIZ_TYPES.join('/')}`);
    const content = parseContent(dto.content);
    if (!content.title) content.title = name;
    const dup = await q1(
      `SELECT id FROM print_templates WHERE store_id=$1 AND biz_type=$2 AND kind=$3 AND name=$4`,
      [user.storeId, bizType, kind, name]);
    if (dup) throw new BizException(40003, '同类型下模板名称已存在');
    const r = await tx(async c => {
      if (dto.isDefault) await cx(c,
        `UPDATE print_templates SET is_default=false WHERE store_id=$1 AND biz_type=$2 AND kind=$3`,
        [user.storeId, bizType, kind]);
      const m = await cx(c,
        `INSERT INTO print_templates (store_id, name, kind, biz_type, content, is_default, copies, updated_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
        [user.storeId, name, kind, bizType, JSON.stringify(content), !!dto.isDefault,
         Number(dto.copies) || 1, user.sub]);
      return m[0];
    });
    await audit(user.storeId, user.sub, '打印', 'template.create', 'print_template', r.id, { name, kind, bizType });
    return { id: r.id, name };
  }

  /** 更新模板（字段勾选/抬头/联次/选项） */
  @Put(':id')
  @RequirePerms('print.template')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    const cur = await q1(`SELECT * FROM print_templates WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '模板不存在');
    if (dto.content !== undefined) {
      const content = parseContent(dto.content);
      // V4.15.9：v1(fields)/v2(elements)/v3(hiprint) 三种 content 均合法
      const ok = Array.isArray(content.fields) || Array.isArray(content.elements) || (content.version === 3 && content.hp);
      if (!ok) throw new BizException(40003, 'content 须为 fields/elements 数组或 v3 排版（hp）');
    }
    const r = await q1(
      `UPDATE print_templates SET name=$3, content=$4::jsonb, copies=$5, updated_by=$6, updated_at=now()
        WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId,
       dto.name !== undefined ? String(dto.name).trim() : cur.name,
       dto.content !== undefined ? JSON.stringify(parseContent(dto.content)) : JSON.stringify(parseContent(cur.content)),
       dto.copies !== undefined ? Number(dto.copies) : Number(cur.copies), user.sub]);
    await audit(user.storeId, user.sub, '打印', 'template.update', 'print_template', id, { name: cur.name });
    return { id: r.id };
  }

  /** 删除模板 */
  @Delete(':id')
  @RequirePerms('print.template')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT * FROM print_templates WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '模板不存在');
    await tx(async c => {
      await cx(c, `UPDATE print_jobs SET template_id=NULL WHERE template_id=$1`, [id]);
      await cx(c, `DELETE FROM print_templates WHERE id=$1`, [id]);
    });
    await audit(user.storeId, user.sub, '打印', 'template.delete', 'print_template', id, { name: cur.name });
    return { id };
  }

  /** 设默认（同 biz_type+kind 唯一） */
  @Put(':id/default')
  @RequirePerms('print.template')
  async setDefault(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT * FROM print_templates WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40400, '模板不存在');
    await tx(async c => {
      await cx(c, `UPDATE print_templates SET is_default=false WHERE store_id=$1 AND biz_type=$2 AND kind=$3`,
        [user.storeId, cur.biz_type, cur.kind]);
      await cx(c, `UPDATE print_templates SET is_default=true WHERE id=$1`, [id]);
    });
    await audit(user.storeId, user.sub, '打印', 'template.default', 'print_template', id, { name: cur.name });
    return { id, isDefault: true };
  }

  /** 实时预览（渲染引擎出文本） */
  @Get(':id/preview')
  async preview(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const t = await q1(`SELECT * FROM print_templates WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!t) throw new BizException(40400, '模板不存在');
    return { id, kind: t.kind, bizType: t.biz_type, name: t.name, text: renderTemplatePreview(t) };
  }

  /** 试打：走默认打印机（无默认机报错） */
  @Post(':id/print')
  @RequirePerms('printer.manage')
  async print(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const t = await q1(`SELECT * FROM print_templates WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!t) throw new BizException(40400, '模板不存在');
    const p = await q1(`SELECT * FROM printers WHERE store_id=$1 AND is_default ORDER BY id LIMIT 1`, [user.storeId]);
    if (!p) throw new BizException(40400, '无默认打印机，请先在打印中心配置');
    const t0 = Date.now();
    const content = renderTemplatePreview(t);
    const cost = Date.now() - t0;
    const r = await q1(
      `INSERT INTO print_jobs (store_id, printer_id, template_id, biz_type, job_type, status, content, cost_ms, operator_id)
       VALUES ($1,$2,$3,$4,'打印','成功',$5,$6,$7) RETURNING id`,
      [user.storeId, p.id, t.id, t.biz_type, content, cost, user.sub]);
    await audit(user.storeId, user.sub, '打印', 'template.print', 'print_template', id,
      { name: t.name, printer: p.name, cost });
    return { jobId: Number(r.id), printer: p.name, status: '成功', costMs: cost, preview: content };
  }
}

// ═════════════════════ 打印历史 /print-jobs ═════════════════════
@Controller('print-jobs')
class PrintJobsController {

  /** 最近打印历史（含打印机/模板/操作人；V4.15.8 P5 加 biz_no/biz_id 与筛选） */
  @Get()
  async list(@Query('limit') limit?: string, @Query('bizType') bizType?: string, @Query('jobType') jobType?: string,
    @Query('status') status?: string, @Query('q') qk?: string, @CurrentUser() user?: AuthUser) {
    return q(
      `SELECT j.id, j.job_type, j.status, j.cost_ms, j.created_at, j.biz_type, j.biz_no, j.biz_id,
              COALESCE(p.name,'（已删除）') AS printer_name,
              COALESCE(t.name,'') AS template_name,
              e.name AS operator_name,
              LEFT(j.content, 80) AS content_snippet
         FROM print_jobs j
         LEFT JOIN printers p ON p.id=j.printer_id
         LEFT JOIN print_templates t ON t.id=j.template_id
         LEFT JOIN employees e ON e.id=j.operator_id
        WHERE j.store_id=$1
          AND ($2::text IS NULL OR j.biz_type=$2::text)
          AND ($3::text IS NULL OR j.job_type=$3::text)
          AND ($4::text IS NULL OR j.status=$4::text)
          AND ($5::text IS NULL OR j.biz_no ILIKE '%'||$5::text||'%' OR j.content ILIKE '%'||$5::text||'%')
        ORDER BY j.id DESC LIMIT $6`,
      [user!.storeId, bizType || null, jobType || null, status || null, (qk || '').trim() || null,
       Math.min(Number(limit) || 50, 200)],
    );
  }

  /**
   * A5 业务单据打印留痕（V4.15.7 P3）：浏览器打印无法回执字节，前端打印成功后调本端点落历史。
   * 权限 docs.print.a5（店长及以上）——打印按钮显隐与留痕端点双重约束。
   */
  @Post('a5')
  @RequirePerms('docs.print.a5')
  async logA5(@CurrentUser() user: AuthUser, @Body() dto: any) {
    const bizType = String(dto.bizType || '');
    if (!BIZ_TYPES.includes(bizType)) throw new BizException(40003, `业务类型须为：${BIZ_TYPES.join('/')}`);
    const jobType = String(dto.jobType || '打印') === '重打' ? '重打' : '打印';
    const copies = Math.min(Math.max(Number(dto.copies) || 1, 1), 5);
    const bizNo = String(dto.bizNo || '').slice(0, 64);
    const bizId = Number(dto.bizId) > 0 ? Number(dto.bizId) : null;
    const r = await q1(
      `INSERT INTO print_jobs (store_id, biz_type, biz_no, biz_id, job_type, status, content, cost_ms, operator_id)
       VALUES ($1,$2,$3,$4,'A5打印','成功',$5,$6,$7) RETURNING id`,
      [user.storeId, bizType, bizNo || null, bizId, `（A5 浏览器打印 ${copies} 份${bizNo ? ' · ' + bizNo : ''}${jobType === '重打' ? ' · 重打' : ''}）`, 0, user.sub]);
    await audit(user.storeId, user.sub, '打印', 'doc.a5_print', undefined, Number(r.id), { bizType, bizNo, copies });
    return { jobId: Number(r.id) };
  }
}

// ═════════════════════ 设备埋点 /device/events（V4.19.0 P15.5 #9/#10） ═════════════════════
// 打印失败/连接失败/补传失败/秤离线统一埋点；severity=warn 同步 notifyStaff 推老板端消息中心+角标
@Controller('device/events')
class DeviceEventsController {

  /** 上报（登录即可：收银台/作业端硬件异常都能记；同 batchKey 幂等由 notices 侧保证） */
  @Post()
  async report(
    @CurrentUser() user: AuthUser,
    @Body() b: { deviceType?: string; deviceName?: string; eventType?: string; severity?: string; detail?: any; batchKey?: string },
  ) {
    const deviceType = String(b.deviceType || '').slice(0, 16);
    const eventType = String(b.eventType || '').slice(0, 24);
    if (!deviceType || !eventType) throw new BizException(40003, '缺少 deviceType / eventType');
    const severity = b.severity === 'warn' ? 'warn' : 'info';
    const r = await q1(
      `INSERT INTO device_events (store_id, device_type, device_name, event_type, severity, detail, employee_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
      [user.storeId, deviceType, String(b.deviceName || '').slice(0, 64) || null, eventType, severity,
       JSON.stringify(b.detail ?? {}), user.sub]);
    // H2：warn 级同步推老板端/店长消息中心（同批次 10 分钟去重，防缺纸风暴刷屏）
    if (severity === 'warn') {
      const CN: Record<string, string> = {
        print_fail: '小票打印失败', connect_fail: '设备连接失败', sync_fail: '离线单补传失败',
        scale_offline: '电子秤离线', low_paper: '小票机缺纸',
      };
      await notifyStaff(user.storeId, 'device_warn',
        `⚠ ${CN[eventType] || '设备告警'}：${String(b.deviceName || deviceType)}`,
        { eventId: Number(r.id), eventType, deviceType, detail: b.detail ?? {} },
        'sys.settings',
        b.batchKey ? `dev:${b.batchKey}` : null);
    }
    return { eventId: Number(r.id) };
  }

  /** 埋点查询（设置页可查；分页 10/20/50） */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('deviceType') deviceType?: string, @Query('severity') severity?: string,
  ) {
    const pg0 = Math.max(1, Number(page) || 1), sz = Math.min(Math.max(Number(size) || 10, 1), 50);
    const conds = ['e.store_id=$1']; const params: any[] = [user.storeId];
    if (deviceType) { params.push(deviceType); conds.push(`e.device_type=$${params.length}`); }
    if (severity) { params.push(severity); conds.push(`e.severity=$${params.length}`); }
    const where = conds.join(' AND ');
    const total = await q1(`SELECT count(*)::int AS n FROM device_events e WHERE ${where}`, params);
    const rows = await q(
      `SELECT e.*, emp.name AS employee_name
         FROM device_events e LEFT JOIN employees emp ON emp.id = e.employee_id
        WHERE ${where} ORDER BY e.id DESC LIMIT ${sz} OFFSET ${(pg0 - 1) * sz}`, params);
    return { total: Number(total?.n ?? 0), page: pg0, size: sz, items: rows.map((r: any) => ({ ...r, id: Number(r.id) })) };
  }
}

// ═════════════════════ 收银机授权管理 /pos-devices（V4.21.1） ═════════════════════
// pos.device.auth 开启后：新设备首登自动登记「待授权」；管理员在此审批白名单（设备码+UA，强于 MAC——浏览器不可得 MAC 且可伪造）
@Controller('pos-devices')
class PosDevicesController {

  /** 授权设备列表（待授权优先）。V4.25.1：查看无需 sys.settings，审批/状态/删除仍限管理员 */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    const conds = ['d.store_id=$1']; const params: any[] = [user.storeId];
    if (status && ['待授权', '已授权', '已停用'].includes(status)) { params.push(status); conds.push(`d.status=$${params.length}`); }
    const rows = await q(
      `SELECT d.*, a.name AS approved_by_name
         FROM pos_devices d LEFT JOIN employees a ON a.id = d.approved_by
        WHERE ${conds.join(' AND ')} ORDER BY (d.status='待授权') DESC, d.last_seen_at DESC NULLS LAST, d.id DESC`, params);
    return rows.map((r: any) => ({
      id: Number(r.id), deviceCode: r.device_code, deviceName: r.device_name, ua: r.ua,
      status: r.status, approvedAt: r.approved_at, approvedByName: r.approved_by_name,
      lastSeenAt: r.last_seen_at, lastIp: r.last_ip, createdAt: r.created_at,
    }));
  }

  /** 审批通过（可同时命名，如「1号收银机」） */
  @Post(':id/approve')
  @RequirePerms('sys.settings')
  async approve(@Param('id', ParseIntPipe) id: number, @Body() b: { name?: string }, @CurrentUser() user: AuthUser) {
    const r = await q1<any>(
      `UPDATE pos_devices SET status='已授权', approved_by=$2, approved_at=now(),
              device_name=COALESCE(NULLIF($3,''), device_name)
       WHERE id=$1 AND store_id=$4 RETURNING id, device_code, status`,
      [id, user.sub, String(b?.name || '').trim().slice(0, 60), user.storeId]);
    if (!r) throw new BizException(41004, '设备不存在', 404);
    await audit(user.storeId, user.sub, '系统', 'pos_device.approve', 'pos_device', id, { code: r.device_code });
    return { id: Number(r.id), deviceCode: r.device_code, status: r.status };
  }

  /** 状态流转：已停用/待授权/已授权（停用即拒绝登录） */
  @Post(':id/status')
  @RequirePerms('sys.settings')
  async setStatus(@Param('id', ParseIntPipe) id: number, @Body() b: { status: string }, @CurrentUser() user: AuthUser) {
    if (!['待授权', '已授权', '已停用'].includes(String(b?.status || ''))) throw new BizException(40003, '状态仅支持 待授权/已授权/已停用');
    const r = await q1<any>(
      `UPDATE pos_devices SET status=$2, approved_by=$3, approved_at=now() WHERE id=$1 AND store_id=$4 RETURNING id, status`,
      [id, b.status, user.sub, user.storeId]);
    if (!r) throw new BizException(41004, '设备不存在', 404);
    await audit(user.storeId, user.sub, '系统', 'pos_device.status', 'pos_device', id, { status: b.status });
    return { id: Number(r.id), status: r.status };
  }

  /** 删除登记（误登记/设备退役；删除后该设备再登录会重新登记为待授权） */
  @Delete(':id')
  @RequirePerms('sys.settings')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const r = await q1<any>(`DELETE FROM pos_devices WHERE id=$1 AND store_id=$2 RETURNING id, device_code`, [id, user.storeId]);
    if (!r) throw new BizException(41004, '设备不存在', 404);
    await audit(user.storeId, user.sub, '系统', 'pos_device.delete', 'pos_device', id, { code: r.device_code });
    return { ok: true };
  }
}

@Module({
  controllers: [DevicesController, PrintersController, PrintTemplatesController, PrintJobsController, DeviceEventsController, PosDevicesController],
})
export class DeviceModule {}
