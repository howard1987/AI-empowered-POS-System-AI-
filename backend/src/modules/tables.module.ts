/**
 * 台位档案（V4.21.0 P16 批2 · §13.16）
 *  - 堂食/休息区台位：编号+区域+座位数+状态（空闲/使用中/预留/停用）+绑定设备（副屏/收银机）
 *  - 状态流转：落单挂台位自动「使用中」（sales.module checkout 事务内）；清台/预留由收银台或本模块操作
 *  - 台位数据轻量、门店内共享，写操作走 sys.settings 权限（店长），占用/释放登录即可
 */
import { Module, Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { q, q1, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';

const TABLE_STATUS = ['空闲', '使用中', '预留', '停用'];

@Controller('tables')
class TablesController {

  /** 台位列表（status/area/q 过滤；按区域+编号排序） */
  @Get()
  async list(
    @Query('status') status?: string, @Query('area') area?: string, @Query('q') qk?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    const conds = ['t.store_id=$1']; const params: any[] = [user!.storeId];
    if (status) { params.push(status); conds.push(`status=$${params.length}`); }
    if (area) { params.push(area); conds.push(`area=$${params.length}`); }
    if ((qk || '').trim()) { params.push(`%${qk.trim()}%`); conds.push(`(name ILIKE $${params.length} OR COALESCE(area,'') ILIKE $${params.length} OR COALESCE(note,'') ILIKE $${params.length})`); }
    const rows = await q(
      `SELECT t.*, d.name AS device_name
         FROM dining_tables t LEFT JOIN devices d ON d.id=t.device_id
        WHERE ${conds.join(' AND ')}
        ORDER BY COALESCE(t.area,''), t.name, t.id`, params);
    return rows.map((r: any) => ({ ...r, id: Number(r.id), seats: Number(r.seats) || 0, deviceId: r.device_id ? Number(r.device_id) : null }));
  }

  /** 建档（编号必填且店内唯一；状态可选绑定设备） */
  @Post()
  @RequirePerms('sys.settings')
  async create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    const name = String(dto.name || '').trim();
    if (!name) throw new BizException(40003, '台位编号必填');
    const dup = await q1(`SELECT id FROM dining_tables WHERE store_id=$1 AND name=$2`, [user.storeId, name]);
    if (dup) throw new BizException(40003, '台位编号已存在');
    const status = TABLE_STATUS.includes(String(dto.status)) ? String(dto.status) : '空闲';
    if (dto.deviceId) {
      const dev = await q1(`SELECT id FROM devices WHERE id=$1 AND store_id=$2`, [Number(dto.deviceId), user.storeId]);
      if (!dev) throw new BizException(40404, '绑定的设备不存在');
    }
    const r = await q1(
      `INSERT INTO dining_tables (store_id, name, area, seats, status, device_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [user.storeId, name, String(dto.area || '').trim() || null, Number(dto.seats) || 0, status,
       dto.deviceId ? Number(dto.deviceId) : null, String(dto.note || '').trim() || null]);
    await audit(user.storeId, user.sub, '台位', 'table.create', 'dining_table', r.id, { name, area: dto.area || '', status });
    return { id: Number(r.id), name };
  }

  /** 改档案（编号/区域/座位/状态/绑定设备/备注） */
  @Put(':id')
  @RequirePerms('sys.settings')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    const cur = await q1(`SELECT * FROM dining_tables WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40404, '台位不存在');
    const name = dto.name !== undefined ? String(dto.name).trim() : cur.name;
    if (!name) throw new BizException(40003, '台位编号必填');
    if (name !== cur.name) {
      const dup = await q1(`SELECT id FROM dining_tables WHERE store_id=$1 AND name=$2 AND id<>$3`, [user.storeId, name, id]);
      if (dup) throw new BizException(40003, '台位编号已存在');
    }
    const status = dto.status !== undefined
      ? (TABLE_STATUS.includes(String(dto.status)) ? String(dto.status) : (() => { throw new BizException(40003, `状态须为：${TABLE_STATUS.join('/')}`); })())
      : cur.status;
    let deviceId = dto.deviceId !== undefined ? (dto.deviceId ? Number(dto.deviceId) : null) : (cur.device_id ? Number(cur.device_id) : null);
    if (deviceId) {
      const dev = await q1(`SELECT id FROM devices WHERE id=$1 AND store_id=$2`, [deviceId, user.storeId]);
      if (!dev) throw new BizException(40404, '绑定的设备不存在');
    }
    const r = await q1(
      `UPDATE dining_tables SET name=$3, area=$4, seats=$5, status=$6, device_id=$7, note=$8, updated_at=now()
        WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId, name, dto.area !== undefined ? (String(dto.area).trim() || null) : cur.area,
       dto.seats !== undefined ? (Number(dto.seats) || 0) : (Number(cur.seats) || 0),
       status, deviceId, dto.note !== undefined ? (String(dto.note).trim() || null) : cur.note]);
    await audit(user.storeId, user.sub, '台位', 'table.update', 'dining_table', id, { name: cur.name, status });
    return { id: Number(r.id) };
  }

  /** 删除（历史订单保留 table_id 文本痕迹：sales_orders.table_id 不设外键，直接删） */
  @Delete(':id')
  @RequirePerms('sys.settings')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const cur = await q1(`SELECT * FROM dining_tables WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!cur) throw new BizException(40404, '台位不存在');
    await q(`DELETE FROM dining_tables WHERE id=$1`, [id]);
    await audit(user.storeId, user.sub, '台位', 'table.delete', 'dining_table', id, { name: cur.name });
    return { id };
  }

  /** 占用（手动开台；落单自动占用走 checkout 事务） */
  @Post(':id/occupy')
  async occupy(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const r = await q1(
      `UPDATE dining_tables SET status='使用中', updated_at=now() WHERE id=$1 AND store_id=$2 AND status IN ('空闲','预留') RETURNING id`,
      [id, user.storeId]);
    if (!r) throw new BizException(40005, '台位不可占用（使用中/停用）');
    return { id, status: '使用中' };
  }

  /** 清台/释放（回到空闲） */
  @Post(':id/release')
  async release(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const r = await q1(
      `UPDATE dining_tables SET status='空闲', updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId]);
    if (!r) throw new BizException(40404, '台位不存在');
    return { id, status: '空闲' };
  }

  /** 预留/停用切换（status 由 Body 传入，仅这两个值） */
  @Post(':id/mark')
  async mark(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: { status?: string }) {
    const st = String(b?.status || '');
    if (!['预留', '停用', '空闲'].includes(st)) throw new BizException(40003, '状态须为：预留/停用/空闲');
    const r = await q1(
      `UPDATE dining_tables SET status=$3, updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING id`,
      [id, user.storeId, st]);
    if (!r) throw new BizException(40404, '台位不存在');
    return { id, status: st };
  }
}

@Module({ controllers: [TablesController] })
export class TablesModule {}
