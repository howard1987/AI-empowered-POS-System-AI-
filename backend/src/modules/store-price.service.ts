/**
 * 门店覆盖价服务（V4.26.5）——「按门店隔离价格」的唯一读价入口
 *
 * 为什么需要它：
 *   products.goods_no 全局唯一 → 同一商品在多店共用一行档案，单表无法表达「一店一价」。
 *   故新增 product_store_prices 覆盖表，只存「与基线价不同」的门店，读价统一 COALESCE 兜底。
 *
 * 三条铁律（保证单店部署零回归）：
 *   ① 无覆盖行 = 沿用 products 基线价 —— 单店（store_id=1）从不写覆盖行时行为与改造前完全一致；
 *   ② 覆盖一律「就地改内存对象」，不改任何既有 SQL 的列表达式 —— 避免 30+ 处读价点逐个改写带来的回归风险；
 *   ③ 只在「取到商品行之后」覆盖，故结算、价目表、商品列表等下游逻辑（红线价/折扣/会员价）自动同口径。
 *
 * 生效范围：
 *   整体调价（apply_scope='all'）→ 改基线价 + 清空该商品全部覆盖行（全门店 + 未来新店都生效）
 *   本地门店调价（apply_scope='local'）→ 只 upsert 目标门店覆盖行（其余门店不受影响）
 *   商品档案直接改价 → 等同改基线，同时清空覆盖行（杜绝「改了价不生效」的隐形优先级坑）
 */

import { q } from '../common/db';

export interface StorePriceRow {
  sell_price: number;
  member_price: number | null;
}

/** 事务客户端最小契约（pg PoolClient 子集，避免引入 pg 类型依赖） */
export interface SqlClient {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export class StorePriceService {
  /**
   * 批量载入门店覆盖价 → Map<productId, {sell_price, member_price}>
   * 覆盖行仅存「与基线不同」的门店，行数天然稀疏，全量拉取开销可忽略。
   */
  async loadMap(storeId: number, client?: SqlClient): Promise<Map<number, StorePriceRow>> {
    const map = new Map<number, StorePriceRow>();
    const sid = Number(storeId) || 1;
    try {
      // L-15 修复：结算事务内传事务客户端（cx 同连接），不再用全局 q() 脱事务+抢第二连接
      const rows = client
        ? (await client.query(
            `SELECT product_id, sell_price, member_price FROM product_store_prices WHERE store_id=$1`, [sid])).rows
        : await q(
            `SELECT product_id, sell_price, member_price FROM product_store_prices WHERE store_id=$1`, [sid]);
      for (const r of rows) {
        map.set(Number(r.product_id), {
          sell_price: r.sell_price === null || r.sell_price === undefined ? NaN : Number(r.sell_price),
          member_price: r.member_price === null || r.member_price === undefined ? null : Number(r.member_price),
        });
      }
    } catch {
      // 迁移 103 未执行时静默降级为「全部走基线价」，不影响收银可用性
      return new Map();
    }
    return map;
  }

  /**
   * 就地覆盖商品行的有效价（直接把 p.sell_price / p.member_price 改成门店价）。
   * 调用点在「取到商品行之后、任何价格计算之前」——覆盖后下游一切逻辑自动同口径。
   * 只在门店确有覆盖值时改写，故对未设门店价的商品零影响。
   */
  async overlay(storeId: number, rows: any[], opts: { aliases?: string[] } = {}, client?: SqlClient): Promise<any[]> {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const map = await this.loadMap(storeId, client);
    if (!map.size) return rows;
    const alias = opts.aliases || [];
    // 优先取显式的商品 id 列（product_id / productId），最后才回落到 id ——
    //   像「批次 JOIN 商品」的行里 id 是批次 id，若先取 id 会把门店价套到错误商品上。
    const idKeys = ['product_id', 'productId', ...alias, 'id'];
    // 售价/会员价在各方 SQL 里有多种别名（sell_price / sellPrice / sell），一律「存在即改」
    const SELL_KEYS = ['sell_price', 'sellPrice', 'sell'];
    const MEMBER_KEYS = ['member_price', 'memberPrice', 'member'];
    for (const r of rows) {
      if (!r) continue;
      let pid = 0;
      for (const k of idKeys) {
        if (r[k] !== undefined && r[k] !== null && r[k] !== '') { pid = Number(r[k]); break; }
      }
      if (!pid) continue;
      const ov = map.get(pid);
      if (!ov) continue;
      const hasSell = !Number.isNaN(ov.sell_price);
      for (const k of SELL_KEYS) if (hasSell && r[k] !== undefined) r[k] = ov.sell_price;
      for (const k of MEMBER_KEYS) if (ov.member_price !== null && r[k] !== undefined) r[k] = ov.member_price;
    }
    return rows;
  }

  /** 便捷：单行覆盖（结算等逐行取价的场景；事务内传 client 走同连接） */
  async overlayOne(storeId: number, row: any, client?: SqlClient): Promise<any> {
    const [r] = await this.overlay(storeId, [row], {}, client);
    return r;
  }

  /** upsert 门店覆盖价（须在事务内调用；只写非 undefined 的字段） */
  async upsert(c: SqlClient, p: {
    storeId: number; productId: number;
    sellPrice?: number | null; memberPrice?: number | null;
    sourcePcId?: number | null; sourcePcNo?: string | null; remark?: string | null;
  }): Promise<void> {
    await c.query(
      `INSERT INTO product_store_prices
         (store_id, product_id, sell_price, member_price, source_pc_id, source_pc_no, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (store_id, product_id) DO UPDATE SET
         sell_price   = COALESCE(EXCLUDED.sell_price,   product_store_prices.sell_price),
         member_price = COALESCE(EXCLUDED.member_price, product_store_prices.member_price),
         source_pc_id = COALESCE(EXCLUDED.source_pc_id, product_store_prices.source_pc_id),
         source_pc_no = COALESCE(EXCLUDED.source_pc_no, product_store_prices.source_pc_no),
         remark       = COALESCE(EXCLUDED.remark,       product_store_prices.remark),
         updated_at   = now()`,
      [Number(p.storeId), Number(p.productId),
       p.sellPrice ?? null, p.memberPrice ?? null,
       p.sourcePcId ?? null, p.sourcePcNo ?? null, p.remark ?? null]);
  }

  /** 清空某商品的全部门店覆盖行（整体调价改基线 / 商品档案改价时调用）→ 返回清理条数 */
  async clearProduct(c: SqlClient, productId: number): Promise<number> {
    const r = await c.query(`DELETE FROM product_store_prices WHERE product_id=$1 RETURNING product_id`, [Number(productId)]);
    return Array.isArray(r.rows) ? r.rows.length : 0;
  }

  /** 清空某商品在某门店的覆盖行（等价于「该门店恢复默认价」） */
  async clearProductAtStore(c: SqlClient, productId: number, storeId: number): Promise<number> {
    const r = await c.query(
      `DELETE FROM product_store_prices WHERE product_id=$1 AND store_id=$2 RETURNING product_id`,
      [Number(productId), Number(storeId)]);
    return Array.isArray(r.rows) ? r.rows.length : 0;
  }

  /** 某商品存在门店特价的门店数（商品列表标记「有门店特价」用） */
  async countStores(productIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!productIds.length) return out;
    try {
      const rows = await q(
        `SELECT product_id, count(*)::int AS n FROM product_store_prices
          WHERE product_id = ANY($1) GROUP BY product_id`, [productIds]);
      for (const r of rows) out.set(Number(r.product_id), Number(r.n));
    } catch { /* 迁移未执行 → 无标记 */ }
    return out;
  }
}

export const storePrice = new StorePriceService();
