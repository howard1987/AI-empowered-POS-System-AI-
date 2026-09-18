import { Module, Controller, Get, Query } from '@nestjs/common';
import { q } from '../common/db';

/** 基础数据下拉接口（门店 / 员工 / 品类）：供调拨门店、盘点任务指派、品类筛选等场景使用 */
@Controller('basic')
class BasicController {
  /** 门店列表（多门店扩展预留；单店版返回本店） */
  @Get('stores')
  async stores() {
    // 决策②：输出经纬度与营业时间——H5 端「定位就近分配」由客户端 haversine 计算；亦供手动选择门店列表
    return q(`SELECT id, name, address, phone, status, business_hours AS \"businessHours\", lat, lng FROM stores ORDER BY id`);
  }

  /** 员工列表（在职）：盘点任务指派、经办人下拉 */
  @Get('employees')
  async employees(@Query('role') role?: string) {
    return q(
      `SELECT e.id, e.name, e.emp_no,
              (SELECT r.name FROM employee_roles er JOIN roles r ON r.id = er.role_id
                WHERE er.employee_id = e.id LIMIT 1) AS role_name
         FROM employees e
        WHERE e.status = '在职'
          AND ($1::text IS NULL OR EXISTS (
                SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id
                 WHERE er.employee_id = e.id AND r.name = $1))
        ORDER BY e.id`, [role || null]);
  }

  /** 品类列表（含层级路径）：盘点任务按分类、商品筛选 */
  @Get('categories')
  async categories() {
    return q(`SELECT id, parent_id, name, level, path FROM categories WHERE status = 1 ORDER BY path`);
  }
}

@Module({ controllers: [BasicController] })
export class BasicModule {}
