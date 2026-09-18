/**
 * 共享 SQL 片段常量（V5.0.0 连锁改造）
 *
 * 设计动机（方案 §3.3.3）：商品可见性 SQL 会出现在 8+ 处不同模块，
 * 若每处各写一份（甚至各写一个变体），后期必然分裂 → 收银能卖 / 后台看不到 这类鬼现象。
 * 所以【一处定义、多处引用】。
 */

/**
 * 商品「可售」可见性条件（用于价目表 / 库存 / 促销 / 大客户等**业务可用**场景）。
 *
 * 语义（方案 §3.3.1）：
 *   ① 本店建档品（保留原单机能力，含门店自建品）        → product.store_id = 本店
 *   ② 总部下发且本店可见（已上架 且 未被总部强制停售）  → store_products 命中
 *
 * ⚠️ 单店零回归保证：`store_products` 为空时只有 ① 命中，
 *    行为与改造前 `WHERE p.store_id=$1` 100% 一致（此点必须实测）。
 *
 * ⚠️ 与「可查」的区别（方案 §3.3.1）：门店**可查**总部全量档案（档案查询接口不加本条件），
 *    但**可售**必须走本条件 —— 否则下发机制形同虚设（未获批的商品也能扫码结账）。
 *
 * @param storeParam 门店 id 的 SQL 表达式（如 `$1`、`${curStore()}`、`42`），调用方负责其参数位置
 * @param alias      商品表的 SQL 别名，默认 `p`
 */
export const PRODUCT_VISIBLE = (storeParam: string, alias = 'p') => `
  ( ${alias}.store_id = ${storeParam}
    OR EXISTS (SELECT 1 FROM store_products sp
                WHERE sp.product_id = ${alias}.id
                  AND sp.store_id = ${storeParam}
                  AND sp.is_listed AND NOT sp.is_forced_off) )`;

/**
 * 商品「可售」条件（别名取反写法，便于 JOIN 场景：已 LEFT JOIN store_products sp）
 * 用于已经在 FROM 中 JOIN 了 store_products 的查询，避免重复 EXISTS 扫描。
 *
 * @param storeParam 门店 id 的 SQL 表达式
 * @param alias      商品表别名，默认 `p`
 * @param spAlias    store_products 的别名，默认 `sp`
 */
export const PRODUCT_VISIBLE_JOINED = (storeParam: string, alias = 'p', spAlias = 'sp') => `
  ( ${alias}.store_id = ${storeParam}
    OR ( ${spAlias}.product_id IS NOT NULL AND ${spAlias}.is_listed AND NOT ${spAlias}.is_forced_off ) )`;

/**
 * 标准进价 L1 的有效取值（V5.0.0 · R8 乙模型，方案 §5.1.6-⓪）。
 *
 * 语义：**L1 优先，为空时回落旧口径**（供应商报价最新一条 = `supplier_product_prices`）。
 *
 * ⚠️ 为什么必须回落（这是单店零回归的关键）：
 *   改造前进价唯一来源就是「供应商最新一条报价」，`standard_cost` 是本次新增列（存量全 NULL）。
 *   若不回落 → 所有存量商品的红线立刻失去「进价兜底」，只剩 `min_price 或 售价×0.6`，
 *   生鲜等低毛利品类会出现「卖亏了还合规」的事故。
 *
 * ⚠️ 一旦总部维护了 L1（进价管理页 / 采购入库采纳），红线就以 L1 为唯一依据，
 *   门店再也无法通过「录一笔高进价入库」把红线抬上去（堵死舞弊口）。
 *
 * @param alias 商品表别名，默认 `p`
 */
export const COST_REF = (alias = 'p') => `
  COALESCE(${alias}.standard_cost,
           (SELECT spp.price FROM supplier_product_prices spp
             WHERE spp.product_id = ${alias}.id ORDER BY spp.id DESC LIMIT 1), 0)`;

/**
 * 价格红线价 = max(最低卖价线, 标准进价 L1)。
 * 最低卖价线 = `min_price`，未设时按售价 6 折（沿用 V4.25.4 口径）。
 *
 * @param alias 商品表别名，默认 `p`
 */
export const MIN_PRICE_EXPR = (alias = 'p') => `
  GREATEST(
    COALESCE(NULLIF(${alias}.min_price, 0), ROUND(${alias}.sell_price * 0.6, 2)),
    ${COST_REF(alias)}
  )`;

/**
 * 商品「可查」条件（用于后台档案查询 / 门店申请上架的选择器）。
 *
 * 语义（方案 §3.3.0）：门店可读**总部全量档案**（含尚未下发本店的）+ 本店自建品。
 * 注意：这只是**查询可见**，不代表可售 —— 收银/库存等业务路径必须用 PRODUCT_VISIBLE。
 */
export const PRODUCT_BROWSABLE = (hqStoreParam: string, selfStoreParam: string, alias = 'p') => `
  ( ${alias}.store_id = ${selfStoreParam} OR ${alias}.store_id = ${hqStoreParam} )`;
