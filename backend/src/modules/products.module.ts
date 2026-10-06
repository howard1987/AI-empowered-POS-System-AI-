import { Module, Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { q, q1, tx, cx, audit, seqLock } from '../common/db';
import { curStore, curEmp } from '../common/context';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { decryptSecret } from '../common/secret';
import { genPinyin } from '../common/pinyin';   // V4.18.2 拼音码自动生成
import { storePrice } from './store-price.service';  // V4.26.5 门店覆盖价（按门店隔离价格）
import { PRODUCT_VISIBLE, PRODUCT_BROWSABLE, COST_REF } from '../common/sql';   // V5.0.0 商品可售/可查可见性 + 标准进价 L1
import { hqStoreId, chainEnabled, crossStore, assertStoreAllowed } from '../common/scope';  // V5.0.0 连锁数据范围
import { enqueueSync, publish, nodeIdentity } from '../common/outbox';  // V5.0.0 批次4A：双向同步 + 节点身份
import { SyncStoreService } from './sync-store.service';      // V5.0.0：事件触发立即推送

/**
 * V5.0.15 极限测试：camelCase ↔ snake_case 字段别名映射。
 * 此前建档接口只对 base_unit / sell_price 两个字段做了 snake 兼容，
 * 其余字段传 snake_case 会被「静默忽略」（用户以为设置成功，实际落库 NULL）；
 * 而 sell_price 反过来又因 INSERT 读 camelCase 导致 500。建档/改档统一按本表双向补齐。
 */
const SNAKE_ALIASES: [string, string][] = [
  ['baseUnit', 'base_unit'], ['sellPrice', 'sell_price'], ['memberPrice', 'member_price'],
  ['memberDiscount', 'member_discount'], ['wholesalePrice', 'wholesale_price'],
  ['minStock', 'min_stock'], ['maxStock', 'max_stock'], ['trackInventory', 'track_inventory'],
  ['photoPath', 'photo_path'], ['supplierDefaultId', 'supplier_default_id'], ['bizMode', 'biz_mode'],
  ['minPrice', 'min_price'], ['minDiscountRate', 'min_discount_rate'], ['isWeighted', 'is_weighted'],
  ['keepDays', 'keep_days'], ['shortName', 'short_name'], ['goodsNo', 'goods_no'],
  ['categoryId', 'category_id'], ['pinyinCode', 'pinyin_code'], ['costPrice', 'cost_price'],
  ['standardCost', 'standard_cost'], ['isNew', 'is_new'], ['productId', 'product_id'],
];

/** 把请求体里两种命名风格的同义字段互相补齐（只补 undefined，不覆盖已显式传入的值） */
function fillSnakeAliases(b: any) {
  for (const [camel, snake] of SNAKE_ALIASES) {
    if (b[camel] === undefined && b[snake] !== undefined) b[camel] = b[snake];
    if (b[snake] === undefined && b[camel] !== undefined) b[snake] = b[camel];
  }
  return b;
}

// ─── V4.9.11 条码大数据自动填充（建档输码 → 自动带出名称/规格/预估价等，填错可改） ───
// 数据源链：①本店商品库（products/product_barcodes/product_units）
//          ②mxnzp 在线条码库（国内最全，需在系统设置配置 barcode.lookup.mxnzp.app_id / app_secret，免费自助申请）
//          ③Open Food Facts（全球开放食品库，免 key 兜底）
// 设计原则：只做「预填不做锁定」——查到的字段仅填充空位，用户可随意修改；保质期各库均无权威数据，留人工必填。
// ─── V4.9.12 条码数据升级（用户实测：常见商品查不到/不准 → 数据更合理与真实） ───
//  ①纠错回写闭环：建档保存的商品数据回写 barcode_cache(manual=true)，同码再次查询优先采用——越用越准、完全本地
//  ②名称清洗：在线源/爬虫标题去营销词（旗舰店/正品/包邮/批发…），剥站点后缀，剥条码数字
//  ③自建爬虫互补：全部源未命中时低频抓必应中国结果标题（SSR 实测可用），码间≥3s+每日上限，结果标 unverified 待核对
//  ④批量导入：/products/import-file 接收 xlsx/CSV base64（SheetJS 解析，GBK CSV 容错），按条码 upsert
const _bcCache = new Map<string, { exp: number; data: any }>();

async function settingVal(key: string, fb: any = null): Promise<any> {
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
    return r.length ? r[0].value : fb;
  } catch { return fb; }
}

/** 从规格/品名文本推断常用基本单位（纯启发式，推断不出留空由用户补） */
function guessUnit(text: string): string {
  const m = String(text || '').match(/(瓶|袋|盒|罐|包|支|听|桶|箱|条|卷|块|枚|粒|片|杯|碗|个)/);
  return m ? m[1] : '';
}

// ─── V4.9.12 名称清洗：去营销词 / 剥站点后缀 / 剥条码数字 / 规整空白 ───
const MKT_WORDS = /(官方旗舰店|旗舰店|官方店|专卖店|专营店|自营|正品|包邮|特价|促销|新款|热卖|爆款|抖音同款|网红|限时|秒杀|直营|厂家直销|一手货源|批发价|欢迎选购|可议|优惠|折扣|同款|跑量)/g;
const SITE_SUFFIX = /[-_|·~]+\s*(京东|淘宝|天猫|苏宁易购|苏宁|1688阿里巴巴|阿里巴巴|亚马逊|拼多多|条形码查询|条码查询网?|商品搜索|中国物品编码中心|报价[，,]?(价格|评测|参数)?).*$/;

function cleanName(title: string, code: string): string {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  t = t.replace(SITE_SUFFIX, '');                       // " - 条形码查询 - 京东" 类站点尾巴
  t = code ? t.split(String(code)).join('') : t;        // 标题里的条码数字剥掉
  t = t.replace(/[(（]\s*\d{8,14}\s*[)）]/g, '');        // 括号条码
  t = t.replace(MKT_WORDS, '');
  t = t.replace(/^[-_|·~，,\s]+|[-_|·~，,\s]+$/g, '').trim();
  return t;
}

/** 从标题提取规格（550ml / 500g / 1L …，取第一个量化段） */
function extractSpec(title: string): string {
  const m = String(title || '').match(/\d+(?:\.\d+)?\s*(?:ml|mL|毫升|L|升|g|克|kg|千克|斤)/i);
  return m ? m[0].replace(/\s+/g, '') : '';
}

// ─── V4.9.12 barcode_cache 读写 ───
async function bcGet(code: string, manualOnly: boolean) {
  const rows = await q(
    `SELECT * FROM barcode_cache WHERE barcode=$1 ${manualOnly ? 'AND manual' : ''} LIMIT 1`, [code]);
  return rows[0] || null;
}

/** V4.16.3 外部商品池查询：命中记一次使用（hits/last_used_at） */
async function poolGet(code: string) {
  const r = await q1<any>(`SELECT * FROM ref_product_pool WHERE barcode=$1 AND name <> '' LIMIT 1`, [code]);
  if (r) q(`UPDATE ref_product_pool SET hits=hits+1, last_used_at=now() WHERE id=$1`, [r.id]).catch(() => {});
  return r;
}

/** 回写缓存：manual=true 覆盖一切；manual=false 不降级已人工确认的行 */
async function bcUpsert(code: string, d: { name?: string; spec?: string; unit?: string; price?: any; brand?: string },
                        source: string, manual: boolean) {
  try {
    const cur = await bcGet(code, false);
    if (cur?.manual && !manual) return;                 // 人工确认数据永不被在线源/爬虫覆盖
    if (cur) {
      await q(
        `UPDATE barcode_cache SET
           name=$2, spec=COALESCE(NULLIF($3,''), spec), unit=COALESCE(NULLIF($4,''), unit),
           price=COALESCE($5, price), brand=COALESCE(NULLIF($6,''), brand),
           source=$7, manual=GREATEST(manual, $8), updated_at=now()
         WHERE barcode=$1`,
        [code, d.name ?? cur.name, d.spec ?? '', d.unit ?? '',
         d.price != null && d.price !== '' ? Number(d.price) : null, d.brand ?? '', source, manual]);
    } else {
      await q(
        `INSERT INTO barcode_cache (barcode, name, spec, unit, price, brand, source, manual, hits, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,now())
         ON CONFLICT (barcode) DO NOTHING`,
        [code, d.name ?? '', d.spec ?? '', d.unit ?? '',
         d.price != null && d.price !== '' ? Number(d.price) : null, d.brand ?? '', source, manual]);
    }
  } catch { /* 缓存写失败不影响主流程 */ }
}

function bcTouch(code: string) {
  q(`UPDATE barcode_cache SET hits=hits+1, last_used_at=now() WHERE barcode=$1`, [code]).catch(() => {});
}

// ─── V4.9.12 爬虫互补（必应中国结果标题，SSR 实测可用；严格限速防反爬） ───
let _lastCrawlAt = 0;
const _crawlCount = { date: '', n: 0 };

function crawlAllowed(limitCfg: any): boolean {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (_crawlCount.date !== today) { _crawlCount.date = today; _crawlCount.n = 0; }
  const limit = Number(limitCfg ?? 50) || 0;
  return limit > 0 && _crawlCount.n < limit;
}

async function crawlBingTitle(code: string): Promise<{ title: string } | null> {
  const res = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(code)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
               'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`bing HTTP ${res.status}`);
  const html = await res.text();
  const titles: string[] = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (t.length >= 4) titles.push(t);
  }
  if (!titles.length) return null;
  // 质量护栏（V4.9.12 实测教训：无条码命中时首条可能是知乎问答等无关页——宁缺毋滥）
  // 优先：标题含条码的（条码查询站，最准）；其次：含规格/单位词的商品式标题；都不满足 → 放弃
  const withCode = titles.find(t => t.includes(code));
  const cand = withCode || titles.find(t => /\d+(?:\.\d+)?\s*(ml|mL|L|升|g|克|kg|千克)/i.test(t) || /(瓶|袋|盒|罐|听|支|桶)/.test(t));
  if (!cand) return null;
  return { title: cand };
}

/** 爬虫补库入口（仅当手动缓存/在线源全部未命中时调用）：限速 → 抓标题 → 清洗 → 存缓存 */
async function crawlAndCache(code: string): Promise<any | null> {
  const enable = await settingVal('barcode.crawler.enable', true);
  if (enable === false || enable === 'false' || enable === 0 || enable === '0') return null;
  if (!crawlAllowed(await settingVal('barcode.crawler.daily_limit', 50))) return null;
  const gap = Date.now() - _lastCrawlAt;
  if (gap < 3000) await new Promise(r => setTimeout(r, 3000 - gap));   // 码间≥3s
  _lastCrawlAt = Date.now(); _crawlCount.n++;
  const hit = await crawlBingTitle(code);
  if (!hit) return null;
  const name = cleanName(hit.title, code);
  if (!name || name.length < 2) return null;
  const spec = extractSpec(hit.title);
  const unit = guessUnit(hit.title);
  await bcUpsert(code, { name, spec, unit, price: null as number | null, brand: '' }, 'crawler', false);
  return { source: '网络补库（必应搜索，参考数据请核对）', exists: false, name, spec, unit, price: null as number | null,
           brand: '', supplier: '', shelfLifeDays: null as number | null, unverified: true };
}

async function lookupOwnDb(code: string) {
  const rows = await q(
    `SELECT p.name, p.spec, p.base_unit, p.sell_price, p.keep_days FROM products p
      LEFT JOIN product_barcodes pb ON pb.product_id = p.id
      LEFT JOIN product_units pu ON pu.barcode = $1 AND pu.product_id = p.id
     WHERE p.deleted_at IS NULL AND (p.barcode = $1 OR pb.barcode = $1 OR pu.barcode = $1) LIMIT 1`, [code],
  );
  if (!rows.length) return null;
  const p = rows[0];
  return { source: '本店商品库', exists: true, name: p.name || '', spec: p.spec || '', unit: p.base_unit || '',
           price: p.sell_price ?? null, brand: '', supplier: '', shelfLifeDays: p.keep_days ?? null };
}

async function lookupMxnzp(code: string) {
  const appId = await settingVal('barcode.lookup.mxnzp.app_id');
  // V4.13.6：app_secret 已改 secret 型（加密落库）；存量明文由 decryptSecret 原样透传，新老值兼容
  const appSecret = decryptSecret(String(await settingVal('barcode.lookup.mxnzp.app_secret') ?? ''));
  if (!appId || !appSecret) return null;                    // 未配置凭据 → 静默跳过该源
  const res = await fetch(
    `https://www.mxnzp.com/api/barcode/goods/details?barcode=${encodeURIComponent(code)}` +
    `&app_id=${encodeURIComponent(appId)}&app_secret=${encodeURIComponent(appSecret)}`,
    { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`mxnzp HTTP ${res.status}`);
  const j: any = await res.json();
  if (!j || j.code !== 1 || !j.data) return null;
  const d = j.data;
  return { source: '在线条码库', exists: false, name: d.goodsName || '', spec: d.standard || '',
           unit: guessUnit(`${d.standard || ''}${d.goodsName || ''}`),
           price: d.price != null && d.price !== '' ? Number(d.price) : null,
           brand: d.brand || '', supplier: d.supplier || '', shelfLifeDays: null as number | null };
}

async function lookupOpenFoodFacts(code: string) {
  const res = await fetch(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json` +
    `?fields=product_name,product_name_zh,quantity,brands,categories`,
    { signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'CommunitySupermarket-POS/1.0' } });
  if (!res.ok) throw new Error(`OFF HTTP ${res.status}`);
  const j: any = await res.json();
  if (!j || j.status !== 1 || !j.product) return null;
  const p = j.product;
  const name = p.product_name_zh || p.product_name || '';
  return { source: '开放商品库（Open Food Facts）', exists: false, name, spec: p.quantity || '',
           unit: guessUnit(`${p.quantity || ''}${name}`), price: null as number | null, brand: p.brands || '', supplier: '', shelfLifeDays: null as number | null };
}

async function lookupBarcodeBig(code: string) {
  const hit = _bcCache.get(code);
  if (hit && hit.exp > Date.now()) return hit.data;
  // ① 本店商品库（最高优先：店内真实档案）
  const own = await lookupOwnDb(code);
  if (own) { _bcCache.set(code, { exp: Date.now() + 3600e3, data: own }); return own; }
  // ② 本店人工纠错缓存（V4.9.12：建档保存回写的确认数据，压过一切在线源）
  const confirmed = await bcGet(code, true);
  if (confirmed) {
    bcTouch(code);
    const r = { source: '本店确认档案（纠错回写）', exists: false, name: confirmed.name || '', spec: confirmed.spec || '',
                unit: confirmed.unit || '', price: confirmed.price ?? null, brand: confirmed.brand || '',
                supplier: '', shelfLifeDays: null as number | null, confirmed: true };
    _bcCache.set(code, { exp: Date.now() + 3600e3, data: r });
    return r;
  }
  const enabled = await settingVal('barcode.lookup.enable', true);
  if (enabled === false || enabled === 'false' || enabled === 0 || enabled === '0')
    throw new BizException(40404, '条码未建档（在线条码库查询已在系统设置中关闭）', 404);
  // ③' 外部商品池（V4.16.3）：供应商目录/行业条码库导入的本地参考数据——本地秒回，压过在线源与爬虫
  const pool = await poolGet(code);
  if (pool) {
    const r = { source: '外部商品池（导入参考数据请核对）', exists: false, name: pool.name, spec: pool.spec || '',
                unit: pool.unit || '', price: pool.price ?? null, brand: pool.brand || '',
                supplier: '', shelfLifeDays: null as number | null, category: pool.category || '', confirmed: false };
    _bcCache.set(code, { exp: Date.now() + 3600e3, data: r });
    return r;
  }
  // ③④ 在线源：mxnzp（未配凭据静默跳过）→ Open Food Facts；命中即清洗名称
  const errs: string[] = [];
  let mxnzpSkipped = false;
  for (const [name, fn] of [['mxnzp', lookupMxnzp], ['OpenFoodFacts', lookupOpenFoodFacts]] as const) {
    try {
      let r: any = await fn(code);
      if (name === 'mxnzp' && r === null) mxnzpSkipped = true;
      if (r && (r.name || r.spec)) {
        r.name = cleanName(r.name, code) || r.name;
        r.spec = r.spec || extractSpec(r.name);
        r.unit = r.unit || guessUnit(r.name);
        await bcUpsert(code, r, name === 'mxnzp' ? 'mxnzp' : 'off', false);
        _bcCache.set(code, { exp: Date.now() + 86400e3, data: r });
        return r;
      }
    } catch (e: any) { errs.push(`${name}: ${e?.message || e}`); }
  }
  // ⑤ 爬虫互补（V4.9.12）：缓存里有先取缓存；没有才实时低频抓必应
  const crawled = await bcGet(code, false);
  if (crawled && crawled.source === 'crawler' && (crawled.name || '').length >= 2) {
    bcTouch(code);
    const r = { source: '网络补库缓存（参考数据请核对）', exists: false, name: crawled.name, spec: crawled.spec || '',
                unit: crawled.unit || '', price: crawled.price ?? null, brand: crawled.brand || '',
                supplier: '', shelfLifeDays: null as number | null, unverified: true };
    _bcCache.set(code, { exp: Date.now() + 3600e3, data: r });
    return r;
  }
  const fresh = await crawlAndCache(code);
  if (fresh) return fresh;
  const hint = mxnzpSkipped ? '；提示：在系统设置配置 mxnzp 凭据可大幅提升国内商品覆盖率' : '';
  throw new BizException(40404, `条码库未收录该条码，请手工建档${errs.length ? `（${errs.join('；')}）` : ''}${hint}`, 404);
}

// ─── Controller（商品中心：分类树 / 商品档案 / 多单位 / 条码查询，方案 4.2 + V4.5.3 列表优先） ───
@Controller('products')
class ProductsController {

  /** 分类树（三级，V4.4.7） */
  @Get('categories')
  async categories() {
    const rows = await q(`SELECT * FROM categories WHERE status=1 ORDER BY level, sort_no, id`);
    const byId = new Map<number, any>();
    const tree: any[] = [];
    for (const r of rows) { r.children = []; byId.set(r.id, r); }
    for (const r of rows) {
      if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(r);
      else tree.push(r);
    }
    return tree;
  }

  @RequirePerms('product.manage')
  @Post('categories')
  async createCategory(@Body() b: { parentId?: number; name: string; sortNo?: number }) {
    if (!b.name) throw new BizException(40003, '分类名称必填');
    let level = 1, path = '';
    if (b.parentId) {
      const p = await q1<any>(`SELECT * FROM categories WHERE id=$1 AND status=1`, [b.parentId]);
      if (!p) throw new BizException(40404, '父分类不存在', 404);
      if (p.level >= 3) throw new BizException(50040, '分类最多三级（V4.4.7）');
      level = p.level + 1;
    }
    const row = await q1<any>(
      `INSERT INTO categories (store_id, parent_id, name, level, sort_no, path)
       VALUES (${curStore()}, $1, $2, $3, $4, '') RETURNING id`, [b.parentId ?? null, b.name, level, b.sortNo ?? 0],
    );
    // 物化路径（子树查询用）：先查父路径再回填
    let parentPath = '/';
    if (b.parentId) {
      const p = await q1<any>(`SELECT path FROM categories WHERE id=$1`, [b.parentId]);
      parentPath = p!.path || '/';
    }
    path = `${parentPath}${row!.id}/`;
    await q(`UPDATE categories SET path=$2 WHERE id=$1`, [row!.id, path]);
    return { id: row!.id, path };
  }

  /** 编辑分类（改名 / 拖拽移动父级 / 排序）：移动时校验层级 ≤3 且禁止移入自身子树，子树 path/level 级联更新 */
  @RequirePerms('product.manage')
  @Put('categories/:id')
  async updateCategory(@Param('id', ParseIntPipe) id: number, @Body() b: { name?: string; parentId?: number; sortNo?: number }) {
    const cur = await q1<any>(`SELECT * FROM categories WHERE id=$1 AND status=1`, [id]);
    if (!cur) throw new BizException(40404, '分类不存在', 404);
    // 仅改名 / 排序
    if (b.parentId === undefined) {
      if (b.name !== undefined && !b.name.trim()) throw new BizException(40003, '分类名称不能为空');
      return q1(`UPDATE categories SET name=COALESCE($2,name), sort_no=COALESCE($3,sort_no) WHERE id=$1 RETURNING *`,
        [id, b.name?.trim() ?? null, b.sortNo ?? null]);
    }
    // 移动父级
    const newParent = b.parentId; // 0/null = 提升为一级
    if (newParent && Number(newParent) === Number(id)) throw new BizException(40003, '不能移动到自身');
    let level = 1, parentPath = '/';
    if (newParent) {
      const p = await q1<any>(`SELECT * FROM categories WHERE id=$1 AND status=1`, [newParent]);
      if (!p) throw new BizException(40404, '目标父分类不存在', 404);
      if (p.path && cur.path && p.path.startsWith(cur.path)) throw new BizException(40003, '不能移动到自己的子分类下');
      // 目标父级深度 + 本子树深度 ≤ 3
      const subTreeDepth = (await q1<{ n: string }>(
        `SELECT COALESCE(MAX(level),0) AS n FROM categories WHERE path LIKE $1 AND status=1`, [cur.path + '%']))!.n;
      const depth = Number(subTreeDepth) - cur.level + 1;   // 本子树层数
      if (Number(p.level) + depth > 3) throw new BizException(50040, `移动后超过三级（当前子树 ${depth} 层，目标父级为第 ${p.level} 级）`);
      level = Number(p.level) + 1; parentPath = p.path || '/';
    }
    const levelShift = level - Number(cur.level);
    const newPath = `${parentPath}${id}/`;
    await tx(async c => {
      await c.query(`UPDATE categories SET parent_id=$2, level=$3, sort_no=COALESCE($4, sort_no), path=$5 WHERE id=$1`,
        [id, newParent || null, level, b.sortNo ?? null, newPath]);
      // 子树级联：path 前缀替换 + level 平移
      await c.query(
        `UPDATE categories SET path = $2 || substring(path from length($3)+1), level = level + $4
          WHERE path LIKE $3 || '%' AND id <> $1`, [id, newPath, cur.path, levelShift]);
    });
    return { id, path: newPath, level };
  }

  /** 同级排序（拖拽排序落库）：ids 顺序即 sort_no 顺序 */
  @RequirePerms('product.manage')
  @Post('categories/reorder')
  async reorderCategories(@Body() b: { parentId?: number; ids: number[] }) {
    if (!Array.isArray(b.ids) || !b.ids.length) throw new BizException(40003, 'ids 不能为空');
    await tx(async c => {
      for (const [i, cid] of b.ids.entries()) {
        await c.query(`UPDATE categories SET sort_no=$2 WHERE id=$1`, [cid, i]);
      }
    });
    return { ok: true, count: b.ids.length };
  }

  /** 删除分类（仅空分类：无子分类且无商品挂载；软删留痕 status=0） */
  @RequirePerms('product.manage')
  @Delete('categories/:id')
  async deleteCategory(@Param('id', ParseIntPipe) id: number) {
    const cur = await q1<any>(`SELECT * FROM categories WHERE id=$1 AND status=1`, [id]);
    if (!cur) throw new BizException(40404, '分类不存在', 404);
    const child = await q1(`SELECT id FROM categories WHERE parent_id=$1 AND status=1 LIMIT 1`, [id]);
    if (child) throw new BizException(40003, '该分类下还有子分类，请先删除/移出子分类');
    const prod = await q1(`SELECT id FROM products WHERE category_id=$1 AND deleted_at IS NULL LIMIT 1`, [id]);
    if (prod) throw new BizException(40003, '该分类下仍有商品，请先移出商品再删除');
    await q(`UPDATE categories SET status=0 WHERE id=$1`, [id]);
    return { ok: true, id };
  }

  /** 合并分类：源分类的商品与子分类并入目标，源分类软删留痕（拖拽合并） */
  @RequirePerms('product.manage')
  @Post('categories/merge')
  async mergeCategories(@Body() b: { sourceId: number; targetId: number }) {
    const s = Number(b.sourceId), t = Number(b.targetId);
    if (!s || !t) throw new BizException(40003, 'sourceId / targetId 必填');
    if (s === t) throw new BizException(40003, '不能合并到自身');
    const rows = await q(`SELECT * FROM categories WHERE id = ANY($1::bigint[]) AND status=1`, [[s, t]]);
    const src = rows.find(r => Number(r.id) === s), tgt = rows.find(r => Number(r.id) === t);
    if (!src || !tgt) throw new BizException(40404, '源/目标分类不存在', 404);
    const movedProducts = await q1<{ n: string }>(`SELECT count(*) AS n FROM products WHERE category_id=$1 AND deleted_at IS NULL`, [s]);
    const movedChildren = await q1<{ n: string }>(`SELECT count(*) AS n FROM categories WHERE parent_id=$1 AND status=1`, [s]);
    await tx(async c => {
      await c.query(`UPDATE products SET category_id=$2 WHERE category_id=$1`, [s, t]);
      await c.query(`UPDATE categories SET parent_id=$2 WHERE parent_id=$1 AND status=1`, [s, t]);
      await c.query(`UPDATE categories SET status=0 WHERE id=$1`, [s]);
    });
    return { ok: true, movedProducts: Number(movedProducts?.n || 0), movedChildren: Number(movedChildren?.n || 0) };
  }

  /** 分类商品数固定统计（V4.9.4：左侧分类树计数不随当前筛选变化；仅统计直挂商品，深层由前端汇总） */
  @Get('category-counts')
  async categoryCounts() {
    const rows = await q(
      `SELECT category_id, count(*)::int AS n FROM products
        WHERE deleted_at IS NULL AND category_id IS NOT NULL
        GROUP BY category_id`);
    // V4.9.5：「全部商品」须包含未分类商品
    const unc = await q1<{ n: string }>(
      `SELECT count(*) AS n FROM products WHERE deleted_at IS NULL AND category_id IS NULL`);
    return { items: rows.map(r => ({ categoryId: Number(r.category_id), n: Number(r.n) })), uncategorized: Number(unc!.n) };
  }

  /**
   * V4.9.5 供应商商品绑定：某供应商可供商品清单（建档绑定 supplier_default_id ∪ 有采购进价记录 supplier_product_prices）
   * last_price / min_price 用于入库单「自动填充上次含税进价 + 低价保护提示」
   */
  @Get('supplier-products/:supplierId')
  async supplierProducts(@Param('supplierId', ParseIntPipe) supplierId: number) {
    const rows = await q(
      `SELECT p.id, p.barcode, p.goods_no, p.name, p.pinyin_code, p.spec, p.base_unit,
              c.name AS category_name, p.sell_price,
              COALESCE(ic.qty_total, 0) AS stock_qty,
              lp.last_price, lp.min_price
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = ${curStore()}
         LEFT JOIN LATERAL (
              SELECT price AS last_price,
                     (SELECT MIN(min_price) FROM supplier_product_prices x
                       WHERE x.product_id = p.id AND x.supplier_id = $1) AS min_price
                FROM supplier_product_prices s2
               WHERE s2.product_id = p.id AND s2.supplier_id = $1
               ORDER BY s2.id DESC LIMIT 1) lp ON true
        WHERE p.deleted_at IS NULL
          AND (p.supplier_default_id = $1
               OR EXISTS (SELECT 1 FROM supplier_product_prices s3
                           WHERE s3.product_id = p.id AND s3.supplier_id = $1))
        ORDER BY p.id LIMIT 1000`, [supplierId]);
    await storePrice.overlay(curStore(), rows);   // V4.26.5 入库参考售价按当前门店
    return { items: rows };
  }

  /**
   * 商品列表（列表优先 + 搜索即输即查 V4.5.3）
   * keyword 命中：名称 / 拼音码 / 条码 / 货号
   *
   * V5.0.0 连锁：新增 scope 区分「可售 / 可查 / 全部」（方案 §3.3.0）
   *   sellable（默认）本店可售 = 本店建档 ∪ 总部已下发且上架          ← 商品运营用
   *   browse          本店可查 = 本店建档 ∪ 总部全量档案（只读，可申请上架）
   *   all             全部（仅总部 dataScope='all' 可传，用于总部汇总视图）
   * ⚠️ 单店零回归：单店下全部商品 store_id = 本店 → sellable 与改造前「无门店过滤」等价。
   */
  @Get()
  async list(
    @Query('keyword') keyword?: string,
    @Query('categoryId') categoryId?: string,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('size') size = '20',
    @Query('storeId') storeId?: string,
    @Query('scope') scope?: string,
  ) {
    const kw = (keyword || '').trim();
    const pn = Math.max(1, Number(page) || 1);
    const sz = Math.min(100, Math.max(1, Number(size) || 20));
    const sc = (scope || 'sellable').toLowerCase();
    const selfStore = curStore();
    const hqId = await hqStoreId();
    // 数据范围闸：门店只能按本店视角查；总部可指定门店/全量
    const viewStore = (await chainEnabled()) && crossStore() && storeId
      ? Number(storeId) : selfStore;
    if (Number(storeId) && Number(storeId) !== selfStore) assertStoreAllowed(Number(storeId), '该门店的商品视图');
    let visSql: string;
    if (sc === 'all' && crossStore()) {
      visSql = 'true';
    } else if (sc === 'browse') {
      // 可查：本店自建 + 总部档案（只读）；单店下 hqId === 本店 → 等价本店全部
      visSql = PRODUCT_BROWSABLE(String(hqId), String(selfStore));
    } else if (sc === 'local') {
      // V5.0.0 R2：门店自建品（非总部建档）——总部可看全连锁待收编清单，门店只看本店
      visSql = crossStore()
        ? (storeId ? `p.store_id = ${Number(storeId)} AND p.store_id <> ${hqId}` : `p.store_id <> ${hqId}`)
        : `p.store_id = ${selfStore} AND p.store_id <> ${hqId}`;
    } else {
      visSql = PRODUCT_VISIBLE(String(viewStore));
    }
    // V5.0.7 分类管理：点一级/二级分类 → 展示该分类「及所有子孙分类」的商品（递归 CTE；
    // 与分类树上的深度商品数统计口径一致）。未传 categoryId 时 CTE 为空，走 IS NULL 全量分支。
    const rows = await q(
      `WITH RECURSIVE cat_tree AS (
         SELECT id FROM categories WHERE id = $2::bigint AND status = 1
         UNION ALL
         SELECT c.id FROM categories c JOIN cat_tree t ON c.parent_id = t.id WHERE c.status = 1
       )
       SELECT p.id, p.goods_no, p.barcode, p.name, p.pinyin_code, p.spec, p.base_unit, p.is_weighted,
              p.sell_price, p.member_price, p.member_discount, p.wholesale_price, p.keep_days, p.status, p.abc_class,
              p.min_price, p.min_discount_rate,   -- V4.25.3 价格红线（列表回显最低卖价/最低折扣）
              p.category_id, c.name AS category_name,
              p.biz_mode, p.supplier_default_id, sup.name AS supplier_name,
              /* V5.0.0 连锁：商品归属与下发状态（门店视图显示「总部品 / 本店自建」） */
              p.store_id AS owner_store_id,
              CASE WHEN p.store_id = ${hqId} THEN 'hq' ELSE 'local' END AS owner_kind,
              sp.is_listed AS sp_listed, COALESCE(sp.is_forced_off, false) AS sp_forced_off, sp.source AS sp_source,
              COALESCE(ic.qty_total, 0) AS stock_qty,
              COALESCE((SELECT spp.price FROM supplier_product_prices spp
                         WHERE spp.product_id = p.id ORDER BY spp.id DESC LIMIT 1), 0) AS cost_price,
              CASE WHEN p.member_price IS NOT NULL AND p.member_price > 0
                    AND COALESCE((SELECT spp.price FROM supplier_product_prices spp
                         WHERE spp.product_id = p.id ORDER BY spp.id DESC LIMIT 1), 0) > 0
                    AND p.member_price < COALESCE((SELECT spp.price FROM supplier_product_prices spp
                         WHERE spp.product_id = p.id ORDER BY spp.id DESC LIMIT 1), 0)
                   THEN 0 ELSE 1 END AS price_warn
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN suppliers sup ON sup.id = p.supplier_default_id
         LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.store_id = ${viewStore}
         LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = ${curStore()}
         LEFT JOIN product_barcodes pbk ON pbk.product_id = p.id AND pbk.barcode = $1
        WHERE p.deleted_at IS NULL
          AND (${visSql})
          AND ($1 = '' OR p.name ILIKE '%'||$1||'%' OR p.pinyin_code ILIKE '%'||$1||'%'
               OR p.barcode = $1 OR p.barcode ILIKE '%'||$1||'%' OR p.goods_no = $1 OR pbk.barcode = $1)
          AND ($2::bigint IS NULL OR p.category_id IN (SELECT id FROM cat_tree))
          AND ($3::int IS NULL OR p.status = $3::int)
        ORDER BY price_warn, p.id DESC
        LIMIT $4 OFFSET $5`,
      [kw, categoryId ? Number(categoryId) : null, status !== undefined && status !== '' ? Number(status) : null, sz, (pn - 1) * sz],
    );
    const cnt = await q1<{ n: string }>(
      `WITH RECURSIVE cat_tree AS (
         SELECT id FROM categories WHERE id = $2::bigint AND status = 1
         UNION ALL
         SELECT c.id FROM categories c JOIN cat_tree t ON c.parent_id = t.id WHERE c.status = 1
       )
       SELECT count(*) AS n FROM products p
        WHERE p.deleted_at IS NULL
          AND (${visSql})
          AND ($1 = '' OR p.name ILIKE '%'||$1||'%' OR p.pinyin_code ILIKE '%'||$1||'%' OR p.barcode=$1 OR p.barcode ILIKE '%'||$1||'%' OR p.goods_no=$1)
          AND ($2::bigint IS NULL OR p.category_id IN (SELECT id FROM cat_tree))
          AND ($3::int IS NULL OR p.status = $3::int)`,
      [kw, categoryId ? Number(categoryId) : null, status !== undefined && status !== '' ? Number(status) : null],
    );
    // V4.26.5 门店价可见性：
    //   不传 storeId → 展示「基线价」并回带 store_price_stores（有几家门店设了特价，列表可提示）
    //   传 storeId   → 按该门店有效价展示，并据门店价重算 price_warn（会员价低于进价的预警）
    const sid = Number(storeId) || 0;
    const storeCnt = await storePrice.countStores((rows as any[]).map(r => Number(r.id)).filter(Boolean));
    for (const r of rows as any[]) r.store_price_stores = storeCnt.get(Number(r.id)) || 0;
    if (sid) {
      await storePrice.overlay(sid, rows);
      for (const r of rows as any[]) {
        const cost = Number(r.cost_price) || 0;
        const mp = r.member_price === null || r.member_price === undefined ? 0 : Number(r.member_price);
        r.price_warn = (mp > 0 && cost > 0 && mp < cost) ? 0 : 1;
      }
    }
    return { total: Number(cnt!.n), page: pn, size: sz, items: rows };
  }

  /** 新建商品（货号自动生成；建档必填校验对应 V4.4.5 保质期禁售规则） */
  @RequirePerms('product.manage')
  @Post()
  async create(@Body() b: any) {
    // 兼容 camelCase（接口约定，前端在用）与 snake_case 两种传参。
    // V5.0.15 极限测试发现两处真实缺陷：
    //   ① 原先只把 sell_price 回填给校验层，而 INSERT 读的是 b.sellPrice
    //      → 「传 snake_case」这条路径必然 500（sell_price not-null 违例）；
    //   ② 其余 camelCase 字段（min_discount_rate 等）压根没做兼容，
    //      传 snake_case 会被「静默忽略」——用户以为设置成功，实际落库 NULL。
    // 现在按映射表双向补齐，两种写法都能真正生效。
    fillSnakeAliases(b);
    if (!b.name || !b.base_unit || b.sell_price === undefined) {
      throw new BizException(40003, 'name / base_unit / sell_price 必填');
    }
    // V5.0.15 极限测试：负售价会直接落库（sell_price=-5 建档成功），收银时产生负金额。
    // 零价可能是「赠品/样品」，予以放行；负数一律拒绝。
    if (Number(b.sell_price) < 0) {
      throw new BizException(40003, `售价不能为负数（当前 ${Number(b.sell_price)}），请核对后重试`);
    }
    if (b.is_weighted && (b.keep_days === undefined || b.keep_days === null) && b.categoryRequiresKeepDays) {
      throw new BizException(50041, '食品类商品建档保质期必填（V4.3.6）');
    }
    // V4.13.9 保质期校验：换算成天须在 1~32750 内（SMALLINT 上限 32767），给出中文提示而不是数据库报错
    const keepDaysNum = Number(b.keepDays ?? b.keep_days ?? 0);
    if (keepDaysNum > 0 && (keepDaysNum < 1 || keepDaysNum > 32750)) {
      throw new BizException(40003, `保质期换算成天须在 1～32750 天内（当前 ${keepDaysNum} 天超出范围，请检查数量×单位）`);
    }
    // V4.9.7 价格红线：售价 / 会员价 严禁低于进价（活动价不受限，走促销模块）
    const costNum = Number(b.costPrice ?? b.cost_price ?? 0);
    if (costNum > 0) {
      if (Number(b.sell_price) > 0 && Number(b.sell_price) < costNum) {
        throw new BizException(40003, `售价 ${Number(b.sell_price)} 低于进价 ${costNum}，严禁保存（活动低价请走促销活动）`);
      }
      if (b.memberPrice != null && Number(b.memberPrice) > 0 && Number(b.memberPrice) < costNum) {
        throw new BizException(40003, `会员价 ${Number(b.memberPrice)} 低于进价 ${costNum}，严禁保存`);
      }
    }
    // 一码一品（V4.9.1）：条码是商品在系统中的唯一标识，商品可重名，但一个条码只能对应一个商品。
    // 主条码 / 附加条码 / 包装条码 任一被占用即拒绝建档。
    if (b.barcode) {
      const code = String(b.barcode).trim();
      const dupMain = await q1(`SELECT id, name FROM products WHERE barcode=$1 AND deleted_at IS NULL LIMIT 1`, [code]);
      if (dupMain) throw new BizException(41003, `条码 ${code} 已被商品「${dupMain.name}」占用（一码一品）`);
      const dupAux = await q1(`SELECT pb.product_id, p.name FROM product_barcodes pb JOIN products p ON p.id=pb.product_id AND p.deleted_at IS NULL WHERE pb.barcode=$1 LIMIT 1`, [code]);
      if (dupAux) throw new BizException(41003, `条码 ${code} 已被商品「${dupAux.name}」的附加条码占用（一码一品）`);
      const dupUnit = await q1(`SELECT pu.product_id, p.name FROM product_units pu JOIN products p ON p.id=pu.product_id AND p.deleted_at IS NULL WHERE pu.barcode=$1 LIMIT 1`, [code]);
      if (dupUnit) throw new BizException(41003, `条码 ${code} 已被商品「${dupUnit.name}」的包装条码占用（一码一品）`);
    }
    if (Array.isArray(b.units)) {
      const pkgCodes = b.units.map((u: any) => String(u.barcode || '').trim()).filter(Boolean);
      for (const code of pkgCodes) {
        const dupMain = await q1(`SELECT id, name FROM products WHERE barcode=$1 AND deleted_at IS NULL LIMIT 1`, [code]);
        if (dupMain) throw new BizException(41003, `包装条码 ${code} 已被商品「${dupMain.name}」占用（一码一品）`);
        const dupAux = await q1(`SELECT pb.product_id, p.name FROM product_barcodes pb JOIN products p ON p.id=pb.product_id AND p.deleted_at IS NULL WHERE pb.barcode=$1 LIMIT 1`, [code]);
        if (dupAux) throw new BizException(41003, `包装条码 ${code} 已被商品「${dupAux.name}」的附加条码占用（一码一品）`);
      }
    }
    const created = await tx(async c => {
      const seq = await cx(c, `SELECT COALESCE(MAX(id),0)+1 AS n FROM products`);
      let goodsNo = b.goods_no || `SKU-${String(seq[0].n).padStart(4, '0')}`;
      // V5.0.0 批次4A（R2）：门店节点建档自动加门店编码前缀（如 S001-SKU-0007），
      // 避免上行总部时与他店/总部货号撞车；总部/单店节点保持原格式（零回归）
      try {
        const nid = await nodeIdentity();
        if (!b.goods_no && nid && nid.role === 'store' && nid.storeId) {
          const sn = await cx(c, `SELECT store_no FROM stores WHERE id=$1`, [nid.storeId]);
          const pre = String(sn[0]?.store_no ?? `S${nid.storeId}`);
          goodsNo = `${pre}-SKU-${String(seq[0].n).padStart(4, '0')}`;
        }
      } catch { /* 节点查询失败保持原号 */ }
      const rows = await cx(c,
        `INSERT INTO products (store_id, category_id, goods_no, barcode, name, pinyin_code, short_name, spec,
                               base_unit, is_weighted, keep_days, sell_price, member_price, member_discount,
                               wholesale_price, min_stock, max_stock,
                               track_inventory, photo_path, status, supplier_default_id, remark, biz_mode,
                               min_price, min_discount_rate)
         VALUES (${curStore()},$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [b.categoryId ?? null, goodsNo, b.barcode ?? null, b.name, b.pinyinCode || genPinyin(b.name), b.shortName ?? null,
         b.spec ?? null, b.base_unit || b.baseUnit, !!b.isWeighted, b.keepDays ?? null, b.sellPrice,
         b.memberPrice ?? null, b.memberDiscount ?? null, b.wholesalePrice ?? null,
         b.minStock ?? 0, b.maxStock ?? 0,
         b.trackInventory === false ? false : true, b.photoPath ?? null, b.status ?? 1,
         b.supplierDefaultId ?? null, b.remark ?? null, b.bizMode === '联营' ? '联营' : '购销',
         // V4.25.3 价格红线：最低卖价 / 最低折扣率（NULL=不限制）
         b.minPrice != null && Number(b.minPrice) > 0 ? Number(b.minPrice) : null,
         b.minDiscountRate != null && Number(b.minDiscountRate) > 0 ? Number(b.minDiscountRate) : null]);
      // 多单位
      if (Array.isArray(b.units)) {
        for (const u of b.units) {
          await cx(c, `INSERT INTO product_units (product_id, unit_name, rate, barcode, price, is_default_sale)
                       VALUES ($1,$2,$3,$4,$5,$6)`,
            [rows[0].id, u.unitName, u.rate, u.barcode ?? null, u.price ?? null, !!u.isDefaultSale]);
        }
      }
      // 建档初始进价基准（可选）：填了进货价 → 写入供应商进价基线（后续进价只能走调价单）
      if (b.costPrice !== undefined && b.costPrice !== null && Number(b.costPrice) > 0) {
        const sid = Number(b.supplierDefaultId ?? 0);
        if (!sid) throw new BizException(40003, '填写了初始进货价必须同时选择主供应商（进价按供应商记账）');
        await cx(c,
          `INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
           VALUES ($1,$2,$3,$3,'建档初始价')`, [rows[0].id, sid, Number(b.costPrice)]);
      }
      // V5.0.0 批次4A（R2）：门店自建品建档后【同事务】上行总部（总部/单店节点 no-op）
      await enqueueSync(c, 'product', Number(rows[0].id), {
        goodsNo, barcode: b.barcode ?? null, name: b.name,
        baseUnit: b.base_unit || b.baseUnit, spec: b.spec ?? null, categoryId: b.categoryId ?? null,
        sellPrice: Number(b.sellPrice ?? 0), memberPrice: b.memberPrice ?? null,
        minPrice: b.minPrice ?? null, bizMode: b.bizMode === '联营' ? '联营' : '购销',
        trackInventory: b.trackInventory !== false, isWeighted: !!b.isWeighted, status: b.status ?? 1,
      });
      return rows[0];
    }).then(async (r: any) => { SyncStoreService.kick(); return r; });
    // V4.9.12 纠错回写闭环：建档数据写条码缓存（manual=true），同码再查优先采用本店确认数据
    if (b.barcode) {
      await bcUpsert(String(b.barcode).trim(),
        { name: b.name, spec: b.spec ?? '', unit: b.base_unit || b.baseUnit || '', price: b.sellPrice ?? null, brand: '' },
        'manual', true);
    }
    return created;
  }

  /** 编辑商品（P0-F1：挂 product.manage；改价字段另需 pos.price.manual 并强制留痕——审批外直改价通道关闭） */
  @RequirePerms('product.manage')
  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() b: any, @CurrentUser() user: AuthUser) {
    fillSnakeAliases(b);   // V5.0.15：改档同样支持 snake_case，避免字段被静默忽略
    if (b.sellPrice != null && Number(b.sellPrice) < 0) {
      throw new BizException(40003, `售价不能为负数（当前 ${Number(b.sellPrice)}），请核对后重试`);
    }
    const row = await q1<any>(`SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new BizException(40404, '商品不存在', 404);
    // V4.25.3：最低卖价 / 最低折扣率 属价格红线，纳入改价权限与留痕口径
    const priceTouched = [b.sellPrice, b.sell_price, b.memberPrice, b.member_price, b.wholesalePrice,
      b.minPrice, b.min_price, b.minDiscountRate, b.min_discount_rate].some(v => v !== undefined);
    if (priceTouched && !(user.perms.includes('*') || user.perms.includes('pos.price.manual'))) {
      throw new BizException(40301, '售价/会员价变更需要「手工改价」权限（pos.price.manual），请走调价单审批流程', 403);
    }
    // 一码一品：改主条码时同样全局查重（排除自身）
    if (b.barcode) {
      const code = String(b.barcode).trim();
      const dup = await q1(`SELECT id, name FROM products WHERE barcode=$1 AND deleted_at IS NULL AND id<>$2 LIMIT 1`, [code, id]);
      if (dup) throw new BizException(41003, `条码 ${code} 已被商品「${dup.name}」占用（一码一品）`);
      const dupAux = await q1(`SELECT pb.product_id, p.name FROM product_barcodes pb JOIN products p ON p.id=pb.product_id AND p.deleted_at IS NULL WHERE pb.barcode=$1 AND pb.product_id<>$2 LIMIT 1`, [code, id]);
      if (dupAux) throw new BizException(41003, `条码 ${code} 已被商品「${dupAux.name}」的附加条码占用（一码一品）`);
    }
    // V4.9.7 价格红线：售价 / 会员价 严禁低于进价（进价取 supplier_product_prices 最新记录；活动价不受限）
    // 仅校验本次请求实际传入的字段——历史违规数据（列表已 price_warn 预警）编辑其他字段不受阻，改到该字段时强制纠正
    const cur = await q1<any>(
      `SELECT p.sell_price, p.member_price, p.wholesale_price, p.min_price, p.min_discount_rate,
              (SELECT spp.price FROM supplier_product_prices spp WHERE spp.product_id = p.id ORDER BY spp.id DESC LIMIT 1) AS cost_price
         FROM products p WHERE p.id=$1`, [id]);
    const costNum = Number(cur?.cost_price ?? 0);
    const newSell = b.sellPrice ?? b.sell_price;
    const newMember = b.memberPrice ?? b.member_price;
    if (costNum > 0) {
      if (newSell != null && Number(newSell) > 0 && Number(newSell) < costNum) {
        throw new BizException(40003, `售价 ${Number(newSell)} 低于进价 ${costNum}，严禁保存（活动低价请走促销活动 / 调价单走审批）`);
      }
      if (newMember != null && Number(newMember) > 0 && Number(newMember) < costNum) {
        throw new BizException(40003, `会员价 ${Number(newMember)} 低于进价 ${costNum}，严禁保存`);
      }
    }
    // V4.13.9 保质期校验（编辑同口径）：SMALLINT 上限保护
    const keepDaysEdit = Number(b.keepDays ?? 0);
    if (keepDaysEdit > 0 && (keepDaysEdit < 1 || keepDaysEdit > 32750)) {
      throw new BizException(40003, `保质期换算成天须在 1～32750 天内（当前 ${keepDaysEdit} 天超出范围，请检查数量×单位）`);
    }
    const updated = await q1(
      `UPDATE products SET
         name        = COALESCE($2, name),
         barcode     = COALESCE($3, barcode),
         category_id = COALESCE($4, category_id),
         sell_price  = COALESCE($5, sell_price),
         member_price= COALESCE($6, member_price),
         keep_days   = COALESCE($7, keep_days),
         status      = COALESCE($8, status),
         min_stock   = COALESCE($9, min_stock),
         max_stock   = COALESCE($10, max_stock),
         base_unit   = COALESCE($11, base_unit),
         photo_path  = CASE WHEN $12 = '' THEN NULL ELSE COALESCE($12, photo_path) END,
         supplier_default_id = COALESCE($13, supplier_default_id),
         biz_mode    = COALESCE($14, biz_mode),
         spec            = COALESCE($15, spec),
         wholesale_price = COALESCE($16, wholesale_price),
         member_discount = COALESCE($17, member_discount),
         pinyin_code     = COALESCE(NULLIF($18,''), pinyin_code),   -- V4.18.2 改名时自动重算拼音码
         min_price       = COALESCE($19, min_price),                -- V4.25.3 最低卖价（0=不限制）
         min_discount_rate = COALESCE($20, min_discount_rate),      -- V4.25.3 最低折扣率（100=不打折）
         updated_at  = now()
       WHERE id=$1 RETURNING *`,
       [id, b.name ?? null, b.barcode ?? null, b.categoryId ?? null, b.sellPrice ?? null,
       b.memberPrice ?? null, b.keepDays ?? null, b.status ?? null, b.minStock ?? null, b.maxStock ?? null,
       b.baseUnit ?? null, b.photoPath ?? null, b.supplierDefaultId ?? null,
       b.bizMode ? (b.bizMode === '联营' ? '联营' : '购销') : null,
       b.spec ?? null, b.wholesalePrice ?? null, b.memberDiscount ?? null,
       b.name ? genPinyin(String(b.name)) : '',
       (b.minPrice ?? b.min_price) !== undefined ? (Number(b.minPrice ?? b.min_price) || 0) : null,
       (b.minDiscountRate ?? b.min_discount_rate) !== undefined ? (Number(b.minDiscountRate ?? b.min_discount_rate) || 0) : null],
    );
    // V4.9.12 纠错回写闭环：编辑保存同样回写（用户改过的名字/规格就是最真实的数据）
    const newBarcode = b.barcode ? String(b.barcode).trim() : '';
    if (newBarcode && (b.name || b.spec || b.sellPrice !== undefined)) {
      await bcUpsert(newBarcode,
        { name: b.name ?? '', spec: b.spec ?? '', unit: b.base_unit || b.baseUnit || '', price: b.sellPrice ?? null, brand: '' },
        'manual', true);
    }
    // V4.26.5 门店价一致性：商品档案直接改价 = 改「基线价」→ 清空该商品的门店覆盖行。
    //   否则残留的门店特价会 COALESCE 压住新基线价，用户看到「改了价不生效」的鬼现象。
    let clearedCoverRows = 0;
    if (updated && (b.sellPrice !== undefined || b.sell_price !== undefined
                    || b.memberPrice !== undefined || b.member_price !== undefined)) {
      clearedCoverRows = await tx(async c => storePrice.clearProduct(c, id));
    }
    // P0-F1 留痕：凡本次改动了价格字段，无论走哪条通道都记审计（旧值→新值 + 操作人）
    if (priceTouched && updated) {
      await audit(user.storeId, user.sub, '商品', 'product.price.change', 'product', id, {
        old: { sell_price: cur?.sell_price, member_price: cur?.member_price, wholesale_price: cur?.wholesale_price,
               min_price: cur?.min_price, min_discount_rate: cur?.min_discount_rate },
        new: { sell_price: updated.sell_price, member_price: updated.member_price, wholesale_price: updated.wholesale_price,
               min_price: updated.min_price, min_discount_rate: updated.min_discount_rate },
        via: 'products.update',
        clearedStoreCoverRows: clearedCoverRows,
      });
    }
    return updated;
  }

  /** V4.9.5 编辑弹窗一品多包装：全量覆盖 product_units（行内 chips 提交完整清单） */
  @RequirePerms('product.manage')
  @Put(':id/units')
  async replaceUnits(@Param('id', ParseIntPipe) id: number, @Body() b: { units: { unitName: string; rate: number; barcode?: string }[] }) {
    const row = await q1(`SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new BizException(40404, '商品不存在', 404);
    const units = Array.isArray(b.units) ? b.units : [];
    for (const u of units) {
      if (!u.unitName || !(Number(u.rate) > 0)) throw new BizException(40003, '包装单位需含 unitName / rate>0');
    }
    return tx(async c => {
      await cx(c, `DELETE FROM product_units WHERE product_id=$1`, [id]);
      for (const u of units) {
        await cx(c,
          `INSERT INTO product_units (product_id, unit_name, rate, barcode) VALUES ($1,$2,$3,$4)`,
          [id, String(u.unitName).trim(), Number(u.rate), u.barcode ? String(u.barcode).trim() : null]);
      }
      return { id, units: await cx(c, `SELECT * FROM product_units WHERE product_id=$1 ORDER BY id`, [id]) };
    });
  }

  /**
   * 商城上下架（在线商城 online_visible）：建档默认上架，此接口可下架/重上架；
   * 下架后会员端 H5 商城列表与详情立即不可见（member-app 查询均带 online_visible 过滤）
   */
  @RequirePerms('product.manage', 'promo.manage')
  @Put(':id/online')
  async setOnline(@Param('id', ParseIntPipe) id: number, @Body() b: any) {
    const row = await q1<any>(
      `SELECT id, name, online_visible FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new BizException(40404, '商品不存在', 404);
    const visible = b.visible === undefined ? !row.online_visible : !!b.visible; // 不传 visible = 切换
    return q1(
      `UPDATE products SET online_visible=$2, updated_at=now()
        WHERE id=$1 RETURNING id, name, online_visible AS "onlineVisible"`, [id, visible]);
  }

  /** V4.16.5 商城图上传/清除（详情弹窗左图点击上传；会员商城/小票/收银展示时优先商城图） */
  @RequirePerms('product.manage')
  @Post(':id/mall-image')
  async setMallImage(@Param('id', ParseIntPipe) id: number, @Body() b: { image?: string }, @CurrentUser() user: AuthUser) {
    const img = String(b.image || '');
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,.+$/.test(img)) throw new BizException(40003, '图片必须为 base64 dataURL');
    if (img.length > 8 * 1024 * 1024) throw new BizException(40003, '图片过大（≤6MB）');
    const row = await q1<any>(`SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new BizException(40404, '商品不存在', 404);
    const { saveUploadImage } = await import('../common/uploads');
    const buf = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const path = saveUploadImage(buf, `mall_${id}_${Date.now()}.jpg`);
    return q1(
      `UPDATE products SET mall_image=$2, updated_at=now() WHERE id=$1
        RETURNING id, mall_image AS "mallImage"`, [id, path]);
  }

  @RequirePerms('product.manage')
  @Delete(':id/mall-image')
  async delMallImage(@Param('id', ParseIntPipe) id: number) {
    return q1(`UPDATE products SET mall_image='', updated_at=now()
               WHERE id=$1 RETURNING id, mall_image AS "mallImage"`, [id]);
  }

  /**
   * 商品批量导入（V4.8.21 CSV 粘贴/文件解析后的行数组；V4.9.12 升级）：
   * upsert=true（默认）时条码已存在则按行更新（仅覆盖文件提供的字段）并回写条码缓存，否则逐行建档；
   * 成功/失败/更新逐行返回；name/unit/sellPrice 必填
   */
  @RequirePerms('product.manage')
  @Post('import')
  async importRows(@Body() b: { rows: any[]; upsert?: boolean }) {
    if (!Array.isArray(b.rows) || !b.rows.length) throw new BizException(40003, 'rows 不能为空');
    // 名称 → id 解析缓存（供应商 / 分类按名称关联）
    const supCache = new Map<string, number | null>();
    const catCache = new Map<string, number | null>();
    const resolveSupplier = async (name: string): Promise<number | null> => {
      const key = String(name || '').trim();
      if (!key) return null;
      if (supCache.has(key)) return supCache.get(key)!;
      const r = await q1<any>(`SELECT id FROM suppliers WHERE name=$1 AND status=1 LIMIT 1`, [key]);
      supCache.set(key, r ? Number(r.id) : null);
      return supCache.get(key)!;
    };
    const resolveCategory = async (name: string): Promise<number | null> => {
      const key = String(name || '').trim();
      if (!key) return null;
      if (catCache.has(key)) return catCache.get(key)!;
      let r = await q1<any>(`SELECT id FROM categories WHERE name=$1 AND status=1 ORDER BY level DESC LIMIT 1`, [key]);
      if (!r) r = await q1<any>(`SELECT id FROM categories WHERE name ILIKE $1 AND status=1 ORDER BY level DESC LIMIT 1`, ['%' + key + '%']);
      catCache.set(key, r ? Number(r.id) : null);
      return catCache.get(key)!;
    };
    const results: any[] = [];
    for (const raw of b.rows) {
      const r: any = { name: raw.name, ok: false };
      try {
        const name = String(raw.name || '').trim();
        const unit = String(raw.baseUnit || raw.base_unit || '个').trim() || '个';
        const price = Number(raw.sellPrice ?? raw.sell_price);
        const barcode = raw.barcode !== undefined && raw.barcode !== null ? String(raw.barcode).trim() : undefined;
        const spec = String(raw.spec ?? '').trim();
        const keepDaysRaw = raw.keepDays ?? raw.keep_days;
        const keepDays = keepDaysRaw !== undefined && keepDaysRaw !== null && String(keepDaysRaw).trim() !== '' ? Number(keepDaysRaw) : null;
        if (!name) throw new Error('名称必填');
        if (!barcode) throw new Error('条码必填（散称商品可留空需人工确认，批量导入暂不支持）');
        if (!(price > 0)) throw new Error('售价必须大于 0');
        const supId = await resolveSupplier(raw.supplierName ?? raw.supplier_name ?? '');
        const catId = await resolveCategory(raw.categoryName ?? raw.category_name ?? '');
        // V4.9.12 upsert：条码已存在 → 按行更新提供字段（文件即真相，真实开局数据通道）
        if (barcode) {
          const ex = await q1<any>(
            `SELECT p.id FROM products p
              LEFT JOIN product_barcodes pb ON pb.product_id = p.id
              WHERE p.deleted_at IS NULL AND (p.barcode=$1 OR pb.barcode=$1) LIMIT 1`, [barcode]);
          if (ex && b.upsert !== false) {
            await q1(
              `UPDATE products SET
                 name = COALESCE(NULLIF($2,''), name),
                 spec = COALESCE(NULLIF($3,''), spec),
                 base_unit = COALESCE(NULLIF($4,''), base_unit),
                 sell_price = COALESCE($5, sell_price),
                 keep_days = COALESCE($6, keep_days),
                 category_id = COALESCE($7, category_id),
                 supplier_default_id = COALESCE($8, supplier_default_id),
                 updated_at = now()
               WHERE id=$1`,
              [ex.id, name, spec, unit, price > 0 ? price : null, keepDays, catId, supId]);
            await bcUpsert(barcode, { name, spec, unit, price, brand: '' }, 'manual', true);
            r.ok = true; r.id = ex.id; r.action = 'updated';
            results.push(r);
            continue;
          }
          if (ex) throw new Error('条码已存在（未开启覆盖更新）');
        }
        const created = await this.create({
          ...raw, name, barcode, baseUnit: unit, sellPrice: price,
          keepDays: keepDays ?? undefined,
          supplierDefaultId: supId ?? raw.supplierDefaultId ?? undefined,
          categoryId: catId ?? raw.categoryId ?? undefined,
          costPrice: supId ? raw.costPrice : undefined,   // 无供应商时不落进价基线
        });
        await bcUpsert(barcode, { name, spec, unit, price, brand: '' }, 'manual', true);
        r.ok = true; r.id = created.id; r.goodsNo = created.goods_no; r.action = 'created';
      } catch (e: any) {
        r.error = e.message || String(e);
      }
      results.push(r);
    }
    return { total: results.length, ok: results.filter(x => x.ok).length,
             created: results.filter(x => x.ok && x.action === 'created').length,
             updated: results.filter(x => x.ok && x.action === 'updated').length,
             fail: results.filter(x => !x.ok).length, results };
  }

  /**
   * V4.9.12 批量导入文件：前端读 xlsx/CSV → base64 上传，SheetJS 统一解析（codepage 936 兼容 GBK 编码 CSV）。
   * 中文/英文列名自动映射：条码/名称/规格/单位/售价/进价/保质期/分类/供应商
   */
  @RequirePerms('product.manage')
  @Post('import-file')
  async importFile(@Body() b: { filename?: string; b64: string; upsert?: boolean }) {
    if (!b?.b64) throw new BizException(40003, 'b64 不能为空');
    let buf: Buffer;
    try { buf = Buffer.from(b.b64, 'base64'); } catch { throw new BizException(40003, 'b64 不是合法 base64'); }
    let wb: XLSX.WorkBook;
    try { wb = XLSX.read(buf, { type: 'buffer', codepage: 936 }); }
    catch (e: any) { throw new BizException(40003, `文件解析失败：${e?.message || e}（xlsx/CSV 均支持）`); }
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new BizException(40003, '文件中没有工作表');
    const rawRows = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
    const pick = (row: any, keys: string[]): any => {
      for (const k of keys) {
        for (const rk of Object.keys(row)) {
          if (String(rk).trim().toLowerCase() === k.toLowerCase()) return row[rk];
        }
      }
      return '';
    };
    const rows = rawRows.map(row => ({
      barcode: String(pick(row, ['条码', '条形码', 'barcode'])).trim(),
      name: String(pick(row, ['名称', '商品名称', '品名', 'name'])).trim(),
      spec: String(pick(row, ['规格', 'spec'])).trim(),
      baseUnit: String(pick(row, ['单位', '基本单位', 'unit'])).trim(),
      sellPrice: pick(row, ['售价', '零售价', '卖价', '价格', 'sellPrice']),
      costPrice: pick(row, ['进价', '进货价', '采购价', 'costPrice']),
      keepDays: pick(row, ['保质期', '保质期天数', '保质期(天)', 'keepDays']),
      categoryName: String(pick(row, ['分类', '类别', '分类名称', 'category'])).trim(),
      supplierName: String(pick(row, ['供应商', '供应商名称', 'supplier'])).trim(),
    })).filter(r => r.barcode || r.name);
    if (!rows.length) throw new BizException(40003, '未解析到有效数据行（表头需含 条码/名称 列）');
    return this.importRows({ rows, upsert: b.upsert !== false });
  }

  /** 一品多码管理（V4.8.21）：附加条码整组替换 */
  @RequirePerms('product.manage')
  @Post(':id/barcodes')
  async setBarcodes(@Param('id', ParseIntPipe) id: number, @Body() b: { barcodes: string[] }) {
    // 防御：字段名写错（如传 barcode 而非 barcodes）时明确报错，避免静默清空全部附加条码
    if (!Array.isArray(b?.barcodes)) throw new BizException(40003, 'barcodes 必须为字符串数组');
    const p = await q1(`SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!p) throw new BizException(40404, '商品不存在', 404);
    return tx(async c => {
      await cx(c, `DELETE FROM product_barcodes WHERE product_id=$1`, [id]);
      const codes = [...new Set((b.barcodes || []).map(x => String(x).trim()).filter(Boolean))];
      for (const code of codes) {
        // barcode 全局唯一：被其他商品占用时明确报错，而非静默吞掉
        const owner = await cx(c, `SELECT product_id FROM product_barcodes WHERE barcode=$1`, [code]);
        if (owner.length && Number(owner[0].product_id) !== Number(id)) {
          throw new BizException(41003, `条码已被其他商品占用：${code}`);
        }
        if (!owner.length) {
          await cx(c, `INSERT INTO product_barcodes (product_id, barcode) VALUES ($1,$2)`, [id, code]);
        }
      }
      const finalRows = await cx(c, `SELECT barcode FROM product_barcodes WHERE product_id=$1 ORDER BY id`, [id]);
      return { id, barcodes: finalRows.map(r => r.barcode) };
    });
  }

  /** V4.9.13 店内在用单位清单（建档/编辑单位下拉数据源：常用字典 + 店内已用单位） */
  @Get('units')
  async usedUnits() {
    const rows = await q(
      `SELECT DISTINCT base_unit AS unit FROM products
        WHERE deleted_at IS NULL AND base_unit IS NOT NULL AND base_unit <> '' ORDER BY 1`);
    return rows.map(r => r.unit).filter(Boolean);
  }

  /** 条码精确查询（扫码枪直扫：主条码 + 辅助条码 + 大单位条码；V4.11.2 兜底：别名精确匹配） */
  @Get('barcode/:code')
  async byBarcode(@Param('code') code: string) {
    let rows = await q(
      `SELECT DISTINCT p.* FROM products p
        LEFT JOIN product_barcodes pb ON pb.product_id = p.id
        LEFT JOIN product_units pu ON pu.barcode = $1 AND pu.product_id = p.id
        WHERE p.deleted_at IS NULL AND (p.barcode = $1 OR pb.barcode = $1 OR pu.barcode = $1)`, [code],
    );
    // 别名兜底：口语叫法/称重前缀码查不到条码时，按别名精确命中（收银员手输简称场景）
    if (!rows.length) {
      rows = await q(
        `SELECT p.* FROM products p
           JOIN product_aliases pa ON pa.product_id = p.id AND pa.store_id = p.store_id
          WHERE pa.alias=$1 AND p.deleted_at IS NULL`, [code],
      );
    }
    if (!rows.length) throw new BizException(40404, '商品条码不存在', 404);
    if (rows.length === 1) {
      const units = await q(`SELECT * FROM product_units WHERE product_id=$1`, [rows[0].id]);
      return { product: rows[0], units };
    }
    // 一码多品：多个商品共用同一码（建档时已明确确认）→ 返回全部候选，
    // 由收银端/PWA 弹窗人工选择，禁止静默取第一个
    const items = [];
    for (const p of rows) {
      items.push({ product: p, units: await q(`SELECT * FROM product_units WHERE product_id=$1`, [p.id]) });
    }
    return { ambiguous: true, items };
  }

  /** 条码大数据查询（建档自动填充）：本店库 → mxnzp → Open Food Facts；只预填不锁定，用户可改 */
  @Get('barcode-lookup/:code')
  async barcodeLookup(@Param('code') code: string) {
    const c = String(code || '').trim();
    if (!/^\d{8,14}$/.test(c)) throw new BizException(40003, '条码格式不正确（应为 8~14 位数字）');
    return lookupBarcodeBig(c);
  }

  /** V4.16.5 条码秤码解析：按 ai.scale.barcode_format 模板解析秤码 → 商品 + 重量/金额
   *  模板字符：F前缀(任意1位) W重量(克,7位常见) E金额(分) N商品码(PLU) P单价(分) C校验 D忽略 . 小数点锚
   *  返回 hit=false 时收银端继续走普通条码链路 */
  @Get('scale-parse/:code')
  async scaleParse(@Param('code') code: string) {
    const c = String(code || '').trim();
    const tplRow = await q1<any>(`SELECT value FROM system_settings WHERE setting_key='ai.scale.barcode_format'`);
    const cusRow = await q1<any>(`SELECT value FROM system_settings WHERE setting_key='ai.scale.custom_format'`);
    let tpl = String(tplRow?.value || '').trim();
    if (tpl === '自定义') tpl = String(cusRow?.value || '').trim();
    if (!/^[FWENPCDOT.]{6,24}$/i.test(tpl)) return { hit: false, note: '未配置条码秤格式或格式非法' };
    if (!/^\d+$/.test(c)) return { hit: false, note: '非纯数字条码不走秤码解析' };
    if (tpl.replace(/\./g, '').length !== c.length) return { hit: false, note: `长度不匹配（模板 ${tpl.replace(/\./g, '').length} 位 vs 条码 ${c.length} 位）` };
    const tplU = tpl.toUpperCase();
    const stripped = tplU.replace(/\./g, '');
    // VQA-1（DEF-01）：秤码校验位验算 —— EAN 风格 mod10：除 C 位外全部数字，自右向左权重 3/1 交替
    const cpos = stripped.lastIndexOf('C');
    if (cpos >= 0) {
      const cvRow = await q1<any>(`SELECT value FROM system_settings WHERE setting_key='ai.scale.check_verify'`);
      const verifyOn = String(cvRow?.value ?? 'on').replace(/"/g, '') !== 'off';
      if (verifyOn) {
        let sum = 0, w = 3;
        for (let i = stripped.length - 1; i >= 0; i--) {
          if (i === cpos) continue;
          sum += Number(c[i]) * w;
          w = w === 3 ? 1 : 3;
        }
        const expect = (10 - (sum % 10)) % 10;
        if (expect !== Number(c[cpos])) return { hit: false, note: `秤码校验位验算失败（期望 ${expect}，实际 ${c[cpos]}）` };
      }
    }
    // 逐字符归段：'.' 表示前一字段在该位含小数点（如 NN.N → N 段带 1 位小数）
    // VQA-1b（DEF-16）：原实现以模板下标直接取码位，含 '.' 锚的模板会整体错位一格 → 按去点模板与条码逐位对齐
    const seg: Record<string, { s: string; dp: number }> = { W: { s: '', dp: 0 }, E: { s: '', dp: 0 }, N: { s: '', dp: 0 }, P: { s: '', dp: 0 }, T: { s: '', dp: 0 } };
    let last = '';
    for (const chRaw of tplU) {
      const ch = chRaw.toUpperCase();
      if (ch === '.') { if (last && seg[last]) seg[last].dp++; continue; }
      last = ch;
    }
    for (let i = 0; i < stripped.length; i++) { const ch = stripped[i]; if (seg[ch]) seg[ch].s += c[i]; }
    const intOf = (x: { s: string; dp: number }) => parseInt(x.s || '0', 10) || 0;
    // W 无小数点 = 克（kg=/1000）；带小数点 = 已是 kg（/10^dp）。E/P 无小数点 = 分（/100）；带 = 元（/10^dp）
    const weightKg = seg.W.dp > 0 ? intOf(seg.W) / Math.pow(10, seg.W.dp) : intOf(seg.W) / 1000;
    const amount = intOf(seg.E) / (seg.E.dp > 0 ? Math.pow(10, seg.E.dp) : 100);
    const price = intOf(seg.P) / (seg.P.dp > 0 ? Math.pow(10, seg.P.dp) : 100);
    const plu = seg.N.s.replace(/\D/g, '');
    // VQA-GAP06：T 段=秤签打印日期（6 位 YYMMDD / 8 位 YYYYMMDD）→ 有效期校验；无 T 段的模板行为不变
    if (seg.T.s) {
      const vdRow = await q1<any>(`SELECT value FROM system_settings WHERE setting_key='ai.scale.label_valid_days'`);
      const days = Math.max(1, Number(String(vdRow?.value ?? '1').replace(/"/g, '')) || 1);
      const ds = seg.T.s;
      let yy: number, mo: number, dd: number;
      if (ds.length === 6) { yy = 2000 + Number(ds.slice(0, 2)); mo = Number(ds.slice(2, 4)); dd = Number(ds.slice(4, 6)); }
      else if (ds.length === 8) { yy = Number(ds.slice(0, 4)); mo = Number(ds.slice(4, 6)); dd = Number(ds.slice(6, 8)); }
      else return { hit: false, note: `T 段须 6 位(YYMMDD)或 8 位(YYYYMMDD)，实际 ${ds.length} 位` };
      const label = new Date(yy, mo - 1, dd);
      if (!(mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) || Number.isNaN(label.getTime()))
        return { hit: false, note: '秤签日期非法：' + ds };
      const now = new Date();
      const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - label.getTime()) / 86400000);
      if (diff < 0) return { hit: false, note: `秤签日期在未来（${ds}），拒收` };
      if (diff >= days) return { hit: false, note: `秤签已过期：打印于 ${diff} 天前，有效期 ${days} 天` };
    }
    // 商品定位：N 段 = PLU/货号 → 匹配 goods_no 或条码后缀
    // VQA-1c（DEF-04）：多候选不再 LIMIT 1 静默取一 → 返回 ambiguous + 候选，收银端人工选择
    let product: any = null;
    const outParsed = { weightG: seg.W.s, amountFen: seg.E.s, plu, priceFen: seg.P.s };
    const outBase = { format: tpl, weightKg: Math.round(weightKg * 1000) / 1000, amount: Math.round(amount * 100) / 100, unitPrice: price, parsed: outParsed };
    if (plu) {
      const n = String(parseInt(plu, 10));
      const rows = await q<any>(
        `SELECT id, name, sell_price, base_unit, is_weighted, track_inventory, photo_path, mall_image
           FROM products WHERE deleted_at IS NULL AND (goods_no=$1 OR RIGHT(barcode, LENGTH($1))=$1)
         ORDER BY CASE WHEN goods_no=$1 THEN 0 ELSE 1 END LIMIT 8`, [n]);
      const distinct: any[] = [];
      for (const r of rows) if (!distinct.some(d => String(d.id) === String(r.id))) distinct.push(r);
      if (distinct.length > 1)
        return { hit: false, ambiguous: true, product: null as any,
          candidates: distinct.map(d => ({ id: Number(d.id), name: d.name, sellPrice: Number(d.sell_price), baseUnit: d.base_unit })),
          ...outBase };
      product = distinct[0] || null;
    }
    return {
      hit: !!product,
      product: product ? { id: Number(product.id), name: product.name, sellPrice: Number(product.sell_price), baseUnit: product.base_unit, isWeighted: !!product.is_weighted } : null,
      ...outBase,
    };
  }

  /* ── V4.16.3 外部商品池：供应商全量目录/行业条码库导入 → ref_product_pool（不进正式档案）。
   *    建档/扫码未命中本店库时先查本地池秒回补齐，再走在线源——与网络查询互补。 ── */

  /** 外部商品池导入：xlsx/CSV base64，表头 条码/名称/规格/单位/品牌/类别/售价（宽匹配同 import-file）；按条码 upsert */
  @RequirePerms('product.manage')
  @Post('pool/import')
  async poolImport(@Body() b: { filename?: string; b64: string; batchNo?: string }) {
    if (!b?.b64) throw new BizException(40003, 'b64 不能为空');
    let buf: Buffer;
    try { buf = Buffer.from(b.b64, 'base64'); } catch { throw new BizException(40003, 'b64 不是合法 base64'); }
    // 编码自适应：xlsx(ZIP) 直读；CSV 文本先 UTF-8 解码、表头识别失败再 GBK（SheetJS 对 CSV buffer 两档都会乱码，必须自解码）
    const parseRows = (): any[] => {
      const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4B;
      const variants: { wb: XLSX.WorkBook | null }[] = [];
      if (isZip) {
        try { variants.push({ wb: XLSX.read(buf, { type: 'buffer' }) }); } catch { /* 忽略 */ }
      } else {
        for (const dec of [new TextDecoder('utf-8'), new TextDecoder('gbk')]) {
          try { variants.push({ wb: XLSX.read(dec.decode(buf), { type: 'string' }) }); } catch { /* 忽略 */ }
        }
      }
      for (const v of variants) {
        const wb = v.wb; if (!wb) continue;
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) continue;
        const rows = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
        if (!rows.length) continue;
        const keys = Object.keys(rows[0]).map(k => String(k).trim().toLowerCase());
        const hasHeader = keys.some(k => ['条码', '条形码', 'barcode'].includes(k)) || keys.some(k => ['名称', '商品名称', '品名', 'name'].includes(k));
        if (hasHeader) return rows;
      }
      return [];
    };
    const rawRows = parseRows();
    if (!rawRows.length) throw new BizException(40003, '未解析到有效数据行（表头需含 条码/名称 列；支持 UTF-8 与 GBK 编码 CSV）');
    const pick = (row: any, keys: string[]): any => {
      for (const k of keys) {
        for (const rk of Object.keys(row)) {
          if (String(rk).trim().toLowerCase() === k.toLowerCase()) return row[rk];
        }
      }
      return '';
    };
    const batchNo = String(b.batchNo || '').trim() || `IMP-${Date.now()}`;
    let inserted = 0, updated = 0, skipped = 0;
    for (const row of rawRows) {
      const barcode = String(pick(row, ['条码', '条形码', 'barcode'])).replace(/\D/g, '');
      const name = cleanName(String(pick(row, ['名称', '商品名称', '品名', 'name'])).trim(), barcode);
      if (!/^\d{8,14}$/.test(barcode) || !name) { skipped++; continue; }
      const spec = String(pick(row, ['规格', 'spec'])).trim() || extractSpec(name);
      const unit = String(pick(row, ['单位', 'unit'])).trim() || guessUnit(name);
      const brand = String(pick(row, ['品牌', 'brand'])).trim();
      const category = String(pick(row, ['分类', '类别', 'category'])).trim();
      const priceRaw = pick(row, ['售价', '零售价', '参考价', '价格', 'price']);
      const price = priceRaw !== '' && !isNaN(Number(priceRaw)) ? Number(priceRaw) : null;
      const cur = await q1<{ id: number }>(`SELECT id FROM ref_product_pool WHERE barcode=$1`, [barcode]);
      if (cur) {
        await q(`UPDATE ref_product_pool SET name=$2, spec=$3, unit=$4, brand=$5, category=$6,
                 price=COALESCE($7, price), source=$8, batch_no=$9 WHERE id=$1`,
          [cur.id, name, spec, unit, brand, category, price, 'import', batchNo]);
        updated++;
      } else {
        await q(`INSERT INTO ref_product_pool (barcode, name, spec, unit, brand, category, price, source, batch_no)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'import',$8)`, [barcode, name, spec, unit, brand, category, price, batchNo]);
        inserted++;
      }
    }
    if (!inserted && !updated) throw new BizException(40003, `未导入任何行（表头需含 条码/名称 列，条码须为 8~14 位数字）；跳过 ${skipped} 行`);
    return { inserted, updated, skipped, batchNo, total: inserted + updated };
  }

  /** 外部商品池列表/搜索（建档弹窗补数据用） */
  @Get('pool')
  async poolList(@Query('q') qkw: string, @Query('size') size: string, @Query('offset') offset: string) {
    const kw = String(qkw || '').trim();
    const lim = Math.min(200, Math.max(1, Number(size) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const where = kw ? `WHERE barcode ILIKE $1 OR name ILIKE $1 OR brand ILIKE $1 OR category ILIKE $1` : '';
    const args: any[] = kw ? [`%${kw}%`] : [];
    const rows = await q(`SELECT * FROM ref_product_pool ${where} ORDER BY last_used_at DESC NULLS LAST, id DESC LIMIT ${lim} OFFSET ${off}`, args);
    const cnt = await q1<{ n: string }>(`SELECT count(*) AS n FROM ref_product_pool ${where}`, args);
    return { items: rows, total: Number(cnt?.n ?? 0) };
  }

  /* ── V4.11.2 商品别名（方案 v3.2 M2「别名表落地」）：
   *    口语叫法与档案名解耦；扫码兜底走别名精确匹配，CLIP rerank 文本信号纳入别名。 ── */

  /** 别名列表 */
  @Get(':id/aliases')
  async aliases(@Param('id', ParseIntPipe) id: number) {
    return q(
      `SELECT a.*, e.name AS creator_name FROM product_aliases a
        LEFT JOIN employees e ON e.id = a.created_by
       WHERE a.product_id=$1 ORDER BY a.id`, [id]);
  }

  /** 新增/更新别名（同店唯一：重复即改挂商品并留痕 created_by） */
  @Post(':id/aliases')
  async addAlias(@Param('id', ParseIntPipe) id: number,
                 @Body() b: { alias: string; source?: string },
                 @CurrentUser() user: AuthUser) {
    const alias = String(b.alias || '').trim();
    if (!alias || alias.length > 200) throw new BizException(40003, '别名为空或超长（200 字内）');
    const source = ['手动', '称重前缀', 'AI训练学习'].includes(b.source || '') ? b.source : '手动';
    const p = await q1(`SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!p) throw new BizException(40404, '商品不存在', 404);
    return tx(async c => {
      const dup = await cx(c, `SELECT product_id FROM product_aliases WHERE store_id=$1 AND alias=$2`, [user.storeId, alias]);
      if (dup.length && Number(dup[0].product_id) !== id) {
        throw new BizException(40003, `别名「${alias}」已挂在其他商品上，请先删除原绑定`);
      }
      await cx(c,
        `INSERT INTO product_aliases (store_id, product_id, alias, source, created_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (store_id, alias) DO UPDATE SET product_id=EXCLUDED.product_id, source=EXCLUDED.source, created_by=EXCLUDED.created_by`,
        [user.storeId, id, alias, source, user.sub]);
      await audit(user.storeId, user.sub, '商品', 'product.alias.set', 'product', id, { alias, source });
      return { ok: true, alias };
    });
  }

  /** 删除别名（按别名 id） */
  @Delete('alias/:aliasId')
  async delAlias(@Param('aliasId', ParseIntPipe) aliasId: number, @CurrentUser() user: AuthUser) {
    const r = await tx(async c => {
      const rows = await cx(c, `DELETE FROM product_aliases WHERE id=$1 AND store_id=$2 RETURNING product_id, alias`, [aliasId, user.storeId]);
      if (!rows.length) throw new BizException(40404, '别名不存在', 404);
      await audit(user.storeId, user.sub, '商品', 'product.alias.del', 'product', Number(rows[0].product_id), { alias: rows[0].alias });
      return rows[0];
    });
    return { ok: true, deleted: r.alias };
  }

  /** 商品详情（含多单位 + AI 样本数与样本列表，供档案弹窗预览缩略图） */
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const p = await q1(`SELECT * FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!p) throw new BizException(40404, '商品不存在', 404);
    const units = await q(`SELECT * FROM product_units WHERE product_id=$1`, [id]);
    const barcodes = (await q(`SELECT barcode FROM product_barcodes WHERE product_id=$1 ORDER BY id`, [id]))
      .map(r => r.barcode);
    const aiSamples = await q(
      `SELECT s.id, s.image_path, s.status, s.source, s.task_id, t.task_no,
              COALESCE(s.annotation->>'angle', '') AS angle, s.created_at
         FROM ai_samples s LEFT JOIN ai_tasks t ON t.id = s.task_id
        WHERE s.product_id=$1
        ORDER BY s.id DESC LIMIT 60`, [id]);
    // 供应商报价 / 进价历史（详情弹窗展示；商品 × 供应商维度）
    const supplierPrices = await q(
      `SELECT spp.id, spp.supplier_id, s.name AS supplier_name, spp.price, spp.min_price,
              spp.source_doc, spp.created_at
         FROM supplier_product_prices spp
         LEFT JOIN suppliers s ON s.id = spp.supplier_id
        WHERE spp.product_id=$1
        ORDER BY spp.id DESC LIMIT 12`, [id]);
    // 库存 / 最新进价 / 主供应商名（主表格与详情展示）
    const extra = await q1<any>(
      `SELECT COALESCE(ic.qty_total, 0) AS stock_qty,
              ${COST_REF('p')} AS cost_price, p.standard_cost,
              (SELECT s.name FROM suppliers s WHERE s.id = p.supplier_default_id) AS supplier_name
         FROM products p
         LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = ${curStore()}
        WHERE p.id=$1`, [id]);
    return {
      product: {
        ...p,
        stock_qty: Number(extra?.stock_qty || 0),
        cost_price: Number(extra?.cost_price || 0),
        supplier_name: extra?.supplier_name ?? null,
      },
      units, barcodes, aiSamples, aiSampleCount: aiSamples.length, supplierPrices,
    };
  }

  /** 删除商品（软删除留痕：deleted_at 置位 + 停售；有在库库存时拒绝，防账实脱节） */
  @RequirePerms('product.manage')
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const p = await q1<any>(`SELECT id, name, deleted_at FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!p) throw new BizException(40404, '商品不存在或已删除', 404);
    const stock = await q1<{ n: string }>(
      `SELECT COALESCE(SUM(remain_qty),0) AS n FROM batches WHERE product_id=$1 AND status='在库'`, [id]);
    if (Number(stock?.n || 0) > 0) {
      throw new BizException(40003, `「${p.name}」仍有在库库存 ${Number(stock.n)}（基本单位），请先清库/退货再删除，避免账实脱节`);
    }
    await tx(async c => {
      await cx(c, `UPDATE products SET deleted_at=now(), status=0, updated_at=now() WHERE id=$1`, [id]);
      await audit(user.storeId, user.sub, '商品', 'product.delete', 'product', id, { name: p.name });
    });
    return { ok: true, id };
  }
}

@Controller('price-changes')
class PriceChangeController {
  /** 调价单列表（V4.8.20 加状态过滤：pending/approved/voided） */
  @Get()
  async listPc(@Query('from') from = '', @Query('to') to = '', @Query('type') type = '', @Query('status') status = '') {
    return q(
      `SELECT pc.*, u.name AS creator_name, ts.name AS target_store_name
         FROM price_changes pc LEFT JOIN employees u ON u.id = pc.created_by
         LEFT JOIN stores ts ON ts.id = pc.target_store_id
        WHERE ($1 = '' OR pc.created_at >= $1::date)
          AND ($2 = '' OR pc.created_at < $2::date + 1)
          AND ($3 = '' OR pc.price_type = $3)
          AND ($4 = '' OR pc.status = $4)
        ORDER BY pc.id DESC LIMIT 200`, [from, to, type, status],
    );
  }

  /**
   * 现进价基线查询（开单带出现进价）：
   * 逐商品取默认供应商；旧进价 = 该供应商最近一次进价（无历史则 0）
   */
  @Get('cost-base')
  async costBase(@Query('productIds') productIds = '', @Query('storeId') storeId = '') {
    const ids = productIds.split(',').map(s => Number(s)).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
    if (!ids.length) return { items: [] };
    const rows = await q(
      `SELECT p.id AS product_id, p.name AS product_name, p.barcode, p.base_unit,
              p.supplier_default_id, p.sell_price, p.member_price, p.standard_cost,
              /* V5.0.0（R8）：现进价 = 标准进价 L1 优先；为空回落「默认供应商最新报价」→ 存量零回归 */
              COALESCE(p.standard_cost, (SELECT spp.price FROM supplier_product_prices spp
                         WHERE spp.product_id = p.id
                           AND spp.supplier_id = p.supplier_default_id
                         ORDER BY spp.id DESC LIMIT 1), 0) AS old_cost
         FROM products p
        WHERE p.deleted_at IS NULL AND p.id = ANY($1)`, [ids],
    );
    // V4.26.5 本地门店调价：「现价」须取该门店有效价（门店覆盖价优先），否则开单现价与差额都不对
    const sid = Number(storeId) || 0;
    if (sid) await storePrice.overlay(sid, rows);
    return { items: rows };
  }

  /**
   * V4.26.5 门店特价清单（按门店隔离价格的全部覆盖行）：
   *   后台「门店特价」弹窗用，可核对某商品在各门店的实际价，并支持逐条清除恢复默认价。
   *   必须声明在 @Get(':id') 之前，否则 'store-prices' 会被 :id 路由抢占。
   */
  @Get('store-prices')
  async listStorePrices(@Query('storeId') storeId = '', @Query('keyword') keyword = '') {
    const kw = (keyword || '').trim();
    const sid = Number(storeId) || 0;
    return q(
      `SELECT psp.id, psp.store_id, psp.product_id, psp.sell_price, psp.member_price,
              psp.source_pc_id, psp.source_pc_no, psp.remark, psp.updated_at,
              st.name AS store_name, p.name AS product_name, p.barcode, p.base_unit,
              p.sell_price AS base_price
         FROM product_store_prices psp
         JOIN products p ON p.id = psp.product_id AND p.deleted_at IS NULL
         LEFT JOIN stores st ON st.id = psp.store_id
        WHERE ($1::bigint IS NULL OR psp.store_id = $1::bigint)
          AND ($2 = '' OR p.name ILIKE '%'||$2||'%' OR p.barcode = $2)
        ORDER BY psp.updated_at DESC, psp.id DESC LIMIT 300`,
      [sid || null, kw],
    );
  }

  /** 调价单详情（含明细与双轨价留痕） */
  @Get(':id')
  async pcDetail(@Param('id') id: string) {
    const head = await q1<any>(`SELECT pc.*, u.name AS creator_name FROM price_changes pc LEFT JOIN employees u ON u.id = pc.created_by WHERE pc.id = $1`, [id]);
    if (!head) throw new BizException(40404, '调价单不存在', 404);
    const items = await q(
      `SELECT i.*, p.name AS product_name, p.barcode, p.base_unit, p.is_weighted,
              p.scale_plu_code, p.scale_department, p.short_name, p.member_price, p.goods_no,
              s.name AS supplier_name
         FROM price_change_items i JOIN products p ON p.id = i.product_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.change_id = $1 ORDER BY i.id`, [id],
    );
    // V4.26.5 本地门店调价：回带该单已落地的门店覆盖价（前端展示「已生效门店」）
    const storeOverrides = await q(
      `SELECT psp.product_id, psp.store_id, psp.sell_price, st.name AS store_name
         FROM product_store_prices psp LEFT JOIN stores st ON st.id = psp.store_id
        WHERE psp.source_pc_id = $1 ORDER BY psp.product_id`, [id],
    ).catch(() => [] as any[]);
    return { ...head, items, storeOverrides };
  }

  /**
   * 新建调价单（V4.8.20 重构）：售价/进价可同行（同单）调整，保存=待审核，审核通过才生效
   *  - 行内 newPrice 调售价、newCost 调进价（至少其一）；price_type=sale/cost/dual 按单内容自动推导
   *  - 进价调整须可解析供应商（行 supplierId 或商品默认供应商）
   */
  @Post()
  @RequirePerms('pos.price.manual')
  async createPc(
    @Body() b: { items: { productId: number; newPrice?: number; newCost?: number; supplierId?: number }[]; effectiveDate?: string; remark?: string; applyScope?: string; targetStoreId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '调价明细不能为空');
    if (items.length > 200) throw new BizException(40003, '单笔调价明细最多 200 行');
    const norm = items.map(it => ({
      productId: Number(it.productId),
      newPrice: it.newPrice === undefined || it.newPrice === null || (it.newPrice as any) === '' ? null : Number(it.newPrice),
      newCost: it.newCost === undefined || it.newCost === null || (it.newCost as any) === '' ? null : Number(it.newCost),
      supplierId: it.supplierId ? Number(it.supplierId) : null,
    }));
    for (const it of norm) {
      if (!it.productId) throw new BizException(40003, '明细须含 productId');
      if (it.newPrice !== null && !(it.newPrice >= 0)) throw new BizException(40003, '新售价须为非负数');
      if (it.newCost !== null && !(it.newCost >= 0)) throw new BizException(40003, '新进价须为非负数');
      if (it.newPrice === null && it.newCost === null) throw new BizException(40003, '明细行须至少填写新售价或新进价其一');
    }
    const seen = new Set<number>();
    for (const it of norm) {
      if (seen.has(it.productId)) throw new BizException(40003, '同一商品在单内重复');
      seen.add(it.productId);
    }
    const hasSale = norm.some(i => i.newPrice !== null);
    const hasCost = norm.some(i => i.newCost !== null);
    // V5.0.0（R8）进价总部统一：门店**不可开进价型/混合型调价单**（服务端硬校验，前端隐藏不算安全）。
    //   单店部署（chainEnabled=false）下本店即总部 → 放行，行为与改造前一致（零回归）。
    if (hasCost && chainEnabled() && !crossStore() && !(user?.perms || []).includes('hq.cost.manage')) {
      throw new BizException(40301, '进价由总部统一管理：门店不能开进价/混合调价单（请提交「进价差异申请」）', 403);
    }
    const priceType = hasSale && hasCost ? 'dual' : hasCost ? 'cost' : 'sale';
    // V5.0.0（R8）进价总部统一：门店**不得开进价型调价单**（改价红线的进价兜底必须单一来源）。
    //   门店发现实际进价与总部基准不符 → 走「进价差异申请」（cost_diff_requests，批次4 接入）。
    //   ⚠️ 单店零回归：单店部署下该店即总部（crossStore 恒真）→ 行为与改造前一致。
    if (hasCost && !crossStore()) {
      throw new BizException(40301, '进价由总部统一管理，门店不能开进价单；如实际进价与总部基准不符，请提交「进价差异申请」', 403);
    }
    const eff = b.effectiveDate || null;
    // V4.26.5 连锁调价：apply_scope 决定生效范围（all=整体调价 / local=本地门店调价）
    const scope = (b.applyScope === 'local') ? 'local' : 'all';
    let targetStoreId: number | null = null;
    if (scope === 'local') {
      targetStoreId = b.targetStoreId ? Number(b.targetStoreId) : (user?.storeId || 1);
      const st = await q1<any>(`SELECT id FROM stores WHERE id=$1`, [targetStoreId]);
      if (!st) throw new BizException(40404, '目标门店不存在', 404);
    }
    const prefix = priceType === 'cost' ? 'JC' : 'TJ';  // 纯进价单 JC-；售价/混合单 TJ-
    const out = await tx(async c => {
      const ids = norm.map(i => i.productId);
      const rows = (await c.query(
        `SELECT id, name, sell_price, supplier_default_id FROM products WHERE id = ANY($1) FOR UPDATE`, [ids],
      )).rows;
      const byId = new Map(rows.map(r => [Number(r.id), r]));
      const oldCosts = new Map<number, number>();
      // V4.26.5 本地门店调价：开单「现价」须取该门店有效价（门店覆盖价优先），否则差额/重复校验都不对
      const storeNow = new Map<number, number>();
      if (scope === 'local' && targetStoreId) {
        const ovs = (await c.query(
          `SELECT product_id, sell_price FROM product_store_prices
            WHERE store_id=$1 AND product_id = ANY($2) AND sell_price IS NOT NULL`,
          [targetStoreId, ids])).rows;
        for (const o of ovs) storeNow.set(Number(o.product_id), Number(o.sell_price));
      }
      const curSaleOf = (pid: number) => storeNow.get(pid) ?? Number(byId.get(pid)!.sell_price);
      let diffTotal = 0;
      for (const it of norm) {
        const p = byId.get(it.productId);
        if (!p) throw new BizException(40404, `商品 ${it.productId} 不存在`, 404);
        if (it.newCost !== null) {
          const sid = it.supplierId ?? Number(p.supplier_default_id ?? 0);
          if (!sid) throw new BizException(40003, `商品「${p.name}」未设供应商，进价调整须指定 supplierId 或默认供应商`);
          it.supplierId = sid;
          const base = (await c.query(
            `SELECT price FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2 ORDER BY id DESC LIMIT 1`,
            [it.productId, sid],
          )).rows[0];
          const oldCost = base ? Number(base.price) : 0;
          oldCosts.set(it.productId, oldCost);
          if (oldCost > 0 && it.newCost === oldCost) throw new BizException(40003, `商品「${p.name}」新进价与现进价相同`);
          diffTotal += it.newCost - oldCost;
        }
        if (it.newPrice !== null) {
          const oldSale = curSaleOf(it.productId);
          if (it.newPrice === oldSale) {
            const where = scope === 'local' ? `门店#${targetStoreId}` : '本店';
            throw new BizException(40003, `商品「${p.name}」新售价与${where}现售价（${oldSale}）相同`);
          }
          diffTotal += it.newPrice - oldSale;
        }
      }
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      await seqLock(c, 'price_changes', 'pc_no', `${prefix}-${ym}-%`);
      const seq = await c.query(`SELECT count(*)+1 AS n FROM price_changes WHERE pc_no LIKE $1`, [`${prefix}-${ym}-%`]);
      const no = `${prefix}-${ym}-${String(seq.rows[0].n).padStart(3, '0')}`;
      const head = await c.query(
        `INSERT INTO price_changes (pc_no, effective_date, remark, item_count, diff_total, created_by, price_type, status, apply_scope, target_store_id)
         VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, 'pending', $8, $9) RETURNING id, pc_no`,
        [no, eff, b.remark || '', norm.length, diffTotal.toFixed(2), user?.sub ?? null, priceType, scope, targetStoreId],
      );
      const cid = head.rows[0].id;
      for (const it of norm) {
        const p = byId.get(it.productId)!;
        await c.query(
          `INSERT INTO price_change_items (change_id, product_id, supplier_id, old_price, new_price, old_cost, new_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cid, it.productId,
           it.newCost !== null ? it.supplierId : null,
           it.newPrice !== null ? curSaleOf(it.productId) : null,
           it.newPrice,
           it.newCost !== null ? (oldCosts.get(it.productId) ?? 0) : null,
           it.newCost],
        );
      }
      return { id: cid, pcNo: head.rows[0].pc_no, priceType, itemCount: norm.length, status: 'pending', diffTotal: Number(diffTotal.toFixed(2)) };
    });
    return out;
  }

  /**
   * V4.26.5 清除门店特价（恢复默认价）：
   *   传 storeId → 只清该门店；不传 → 清该商品在所有门店的门店特价。
   *   注意：本端点必须声明在 @Post(':id/approve') 之前，否则 'store-prices/clear' 会被 :id 路由抢占。
   */
  @Post('store-prices/clear')
  @RequirePerms('pos.price.manual')
  async clearStorePrice(@Body() b: { productId: number; storeId?: number }, @CurrentUser() user: AuthUser) {
    const pid = Number(b?.productId);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizException(40003, 'productId 非法');
    const sid = Number(b?.storeId) || 0;   // 0 = 全部门店
    return tx(async c => {
      const prow = await cx(c, `SELECT id, name, sell_price FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid]);
      const p = prow[0];
      if (!p) throw new BizException(40404, '商品不存在', 404);
      const removed = sid
        ? await storePrice.clearProductAtStore(c, pid, sid)
        : await storePrice.clearProduct(c, pid);
      await audit(user.storeId, user.sub, '商品', 'store_price.clear', 'product', pid,
        { name: p.name, storeId: sid || null, removed, fallbackPrice: Number(p.sell_price) });
      return { productId: pid, storeId: sid || null, removed, fallbackPrice: Number(p.sell_price) };
    });
  }

  /**
   * 审核调价单（V4.8.20）：待审核 → 生效。
   * 售价更新 products.sell_price；进价落地供应商基线（调价通知：min_price=LEAST 刷新最低价保护线 V4.3.6）
   */
  @Post(':id/approve')
  @RequirePerms('pos.price.manual')
  async approvePc(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return tx(async c => {
      const head = (await c.query(`SELECT * FROM price_changes WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!head) throw new BizException(40404, '调价单不存在', 404);
      if (head.status !== 'pending' && head.status !== 'scheduled')
        throw new BizException(40003, `仅待审核/已排程单可审核（当前 ${head.status}）`);
      // VQA-GAP07：调价预约生效——effective_date（日粒度）未到则只登记排程，不动任何价格
      if (head.status === 'pending' && head.effective_date) {
        const ed = head.effective_date;
        const eff = ed instanceof Date
          ? new Date(ed.getFullYear(), ed.getMonth(), ed.getDate())
          : new Date(String(ed).slice(0, 10) + 'T00:00:00');
        if (!Number.isNaN(eff.getTime()) && eff.getTime() > Date.now()) {
          await c.query(`UPDATE price_changes SET status='scheduled', audited_by=$2, audited_at=now() WHERE id=$1`, [id, user?.sub ?? null]);
          try {
            await audit(user.storeId, user.sub ?? null, '商品', 'price_change.schedule', 'price_change', Number(id), { pcNo: head.pc_no, effectiveDate: head.effective_date });
          } catch { /* 系统态审计失败不阻断排程 */ }
          return { id: Number(id), status: 'scheduled', effectiveAt: eff.toISOString(), note: '已排程：未到生效日期不落地价格' };
        }
      }
      const items = (await c.query(
        `SELECT i.*, p.name AS product_name, p.supplier_default_id
           FROM price_change_items i JOIN products p ON p.id = i.product_id
          WHERE i.change_id = $1 FOR UPDATE`, [id])).rows;
      // V4.26.5 连锁调价分流（真隔离）：
      //   all   → 改 products 基线价 + 清空该商品全部门店覆盖行（所有门店 + 未来新店统一生效）
      //   local → 不动基线，只写目标门店覆盖行（其余门店价格完全不受影响）
      const isLocal = head.apply_scope === 'local';
      const targetStore = Number(head.target_store_id || 0);
      if (isLocal && !targetStore) {

        throw new BizException(40003, '本地门店调价单缺少目标门店，无法生效（请作废后重新开单）');
      }
      const storeOverrides: { productId: number; storeId: number; price: number }[] = [];
      let clearedCover = 0;
      for (const it of items) {
        if (it.new_cost !== null && it.new_cost !== undefined) {
          const sid = Number(it.supplier_id ?? it.supplier_default_id ?? 0);
          if (!sid) throw new BizException(40003, `商品「${it.product_name}」未设供应商，无法落地进价`);
          await c.query(
            `INSERT INTO supplier_product_prices (product_id, supplier_id, price, min_price, source_doc)
             VALUES ($1,$2,$3, LEAST($3, COALESCE((SELECT MIN(min_price) FROM supplier_product_prices
                                                  WHERE product_id=$1 AND supplier_id=$2), $3)), $4)`,
            [it.product_id, sid, it.new_cost, head.pc_no],
          );
          // V5.0.0（R8）总部进价统一：进价单是**唯一**能抬升 L1 的通道之一（另一条是总部采购入库）。
          // 门店端已被服务端禁止开进价型单据（见 createPc 的 403 校验）→ 此处写入即「总部维护标准进价」。
          if (crossStore()) {
            await c.query(`UPDATE products SET standard_cost=$2, updated_at=now() WHERE id=$1`,
              [it.product_id, it.new_cost]);
          }
        }
        if (it.new_price !== null && it.new_price !== undefined) {
          const pid = Number(it.product_id);
          const newSale = Number(it.new_price);
          if (isLocal) {
            // 只该门店生效：写覆盖行，基线价不动
            await storePrice.upsert(c, {
              storeId: targetStore, productId: pid, sellPrice: newSale,
              sourcePcId: Number(id), sourcePcNo: head.pc_no,
              remark: `本地门店调价单 ${head.pc_no}`,
            });
            storeOverrides.push({ productId: pid, storeId: targetStore, price: newSale });
          } else {
            // 全门店生效：改基线 + 清除覆盖行（否则残留门店价会「压住」新基线价）
            await c.query(`UPDATE products SET sell_price=$2, updated_at=now() WHERE id=$1`, [pid, newSale]);
            clearedCover += await storePrice.clearProduct(c, pid);
          }
        }
      }
      const upd = await c.query(
        `UPDATE price_changes SET status='approved', audited_by=$2, audited_at=now() WHERE id=$1 RETURNING status, audited_at`,
        [id, user?.sub ?? null],
      );
      await audit(user.storeId, user.sub, '商品', 'price_change.approve', 'price_change', Number(id), {
        pcNo: head.pc_no, applyScope: head.apply_scope, targetStoreId: head.target_store_id || null,
        itemCount: items.length, storeOverrides, clearedStoreCoverRows: clearedCover,
      });

      // ── V5.0.0 批次4A：生效后同步（双向各取所需，均内部判定角色，错调无副作用） ──
      //   门店节点 → enqueueSync 上行售价单（R8：门店只上行售价单）；总部节点 no-op
      //   总部节点 → publish 下发新价（基线/门店覆盖价）；门店节点 no-op
      if (isLocal) {
        if (items.some((x: any) => x.new_price != null)) {
          await enqueueSync(c, 'price_change', Number(id), {
            pcNo: head.pc_no, effectiveDate: head.effective_date, remark: head.remark,
            itemCount: items.length, diffTotal: Number(head.diff_total ?? 0),
            createdAt: head.created_at ?? new Date().toISOString(),
            items: items.filter((x: any) => x.new_price != null)
              .map((x: any) => ({ productId: Number(x.product_id), oldPrice: Number(x.old_price ?? 0), newPrice: Number(x.new_price) })),
          });
        }
        for (const so of storeOverrides) {
          await publish('product_store_prices', so.productId,
            { store_id: so.storeId, product_id: so.productId, sell_price: so.price, updated_at: new Date().toISOString() },
            'store', [so.storeId]);
        }
      } else {
        for (const it of items) {
          if (it.new_price != null) {
            await publish('products', Number(it.product_id),
              { id: Number(it.product_id), sell_price: Number(it.new_price), updated_at: new Date().toISOString() });
          }
          if (it.new_cost != null && crossStore()) {
            await publish('products', Number(it.product_id),
              { id: Number(it.product_id), standard_cost: Number(it.new_cost), updated_at: new Date().toISOString() });
          }
        }
      }

      return {
        id: Number(id), status: upd.rows[0].status, itemCount: items.length, auditedAt: upd.rows[0].audited_at,
        applyScope: head.apply_scope || 'all', targetStoreId: head.target_store_id || null,
        storeOverrideCount: storeOverrides.length, clearedStoreCoverRows: clearedCover,
      };
    }).then(async r => { SyncStoreService.kick(); return r; });
  }

  /** VQA-GAP07：扫描到点的排程调价单并落地（定时器 + POST /price-changes/sweep 手动触发） */
  @Post('sweep')
  @RequirePerms('pos.price.manual')
  async sweepPc(@CurrentUser() user: AuthUser) {
    const due = await q<any>(`SELECT id, store_id, audited_by FROM price_changes
       WHERE status='scheduled' AND effective_date IS NOT NULL AND effective_date <= CURRENT_DATE ORDER BY id LIMIT 20`);
    const items: any[] = [];
    for (const d of due) {
      try {
        items.push(await this.approvePc(String(d.id), { storeId: Number(d.store_id) || 1, sub: Number(d.audited_by) || null, empNo: 'SYSTEM', name: '预约生效' } as any));
      } catch (e: any) {
        items.push({ id: Number(d.id), err: String((e && e.message) || e).slice(0, 80) });
      }
    }
    return { checked: due.length, applied: items.filter(x => x && x.status === 'approved').length, items };
  }

  /** 作废调价单（V4.8.20）：仅待审核可作废；已生效单价格已落地，不可作废 */
  @Post(':id/void')
  @RequirePerms('pos.price.manual')
  async voidPc(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const r = await q1<any>(
      `UPDATE price_changes SET status='voided', voided_by=$2, voided_at=now()
        WHERE id=$1 AND status IN ('pending','scheduled') RETURNING id, status`, [id, user?.sub ?? null]);
    if (!r) {
      const ex = await q1<any>(`SELECT status FROM price_changes WHERE id=$1`, [id]);
      if (!ex) throw new BizException(40404, '调价单不存在', 404);
      throw new BizException(40003, `仅待审核单可作废（当前 ${ex.status}）`);
    }
    return r;
  }
}

// ─── 组合拆分（V4.8.17）：组装 ZZ- / 拆分 CF-，FIFO 成本守恒，权限 stock.transfer ───

/** FIFO 消费 N 份数量（行锁防超卖）：返回摊销明细与总成本；不记库存商品按最近进价 */
async function fifoConsume(
  c: any, storeId: number, productId: number, pName: string, trackInv: boolean, qty: number,
  refType: string, refId: number, employeeId: number,
): Promise<{ cost: number; unitCost: number; rows: { productId: number; qty: number; unitCost: number; costTotal: number }[] }> {
  let cost = 0;
  const rows: { productId: number; qty: number; unitCost: number; costTotal: number }[] = [];
  if (trackInv) {
    const batches = (await c.query(
      `SELECT id, remain_qty, inbound_cost FROM batches
        WHERE store_id=$1 AND product_id=$2 AND status='在库' AND remain_qty > 0
        ORDER BY expiry_date, inbound_date FOR UPDATE`, [storeId, productId])).rows;
    let avail = 0;
    for (const b of batches) avail += Number(b.remain_qty);
    if (avail < qty) throw new BizException(50001, `${pName} 库存不足（现有 ${avail}，需 ${qty}）`);
    let need = qty;
    for (const b of batches) {
      if (need <= 0) break;
      const take = Math.min(Number(b.remain_qty), need);
      const sub = take * Number(b.inbound_cost);
      cost += sub;
      rows.push({ productId, qty: take, unitCost: Number(b.inbound_cost), costTotal: Number(sub.toFixed(2)) });
      await c.query(
        `UPDATE batches SET remain_qty = remain_qty - $2,
            status = CASE WHEN remain_qty - $2 <= 0 THEN '售罄' ELSE status END WHERE id=$1`,
        [b.id, take]);
      await c.query(
        `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, employee_id)
         VALUES ($1,$2,$3,'出库',$4,$5,$6,$7,$8)`,
        [storeId, productId, b.id, take, Number(b.inbound_cost), refType, refId, employeeId]);
      need = Math.round((need - take) * 1000) / 1000;
    }
    await c.query(
      `UPDATE inventory_current SET qty_total = qty_total - $2, updated_at=now() WHERE store_id=$1 AND product_id=$3`,
      [storeId, qty, productId]);
  } else {
    const last = (await c.query(
      `SELECT unit_cost FROM inbound_order_items WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [productId])).rows;
    const u = last.length ? Number(last[0].unit_cost) : 0;
    cost = qty * u;
    rows.push({ productId, qty, unitCost: u, costTotal: Number((qty * u).toFixed(2)) });
  }
  return { cost: Number(cost.toFixed(4)), unitCost: qty > 0 ? cost / qty : 0, rows };
}

/** 入库建批次（组装产物/拆分子件共用）：stock_flows 入库 + inventory_current 累加 */
async function fifoProduce(
  c: any, storeId: number, productId: number, batchNo: string, keepDays: number | null,
  qty: number, unitCost: number, refType: string, refId: number, employeeId: number,
) {
  const expiry = keepDays && keepDays > 0 ? keepDays : 365;
  const bt = (await c.query(
    `INSERT INTO batches (store_id, product_id, supplier_id, batch_no, inbound_date, production_date,
                          expiry_date, inbound_cost, inbound_qty, remain_qty, status)
     VALUES ($1,$2,0,$3,CURRENT_DATE,CURRENT_DATE, CURRENT_DATE + ($4 || ' days')::interval, $5,$6,$6,'在库') RETURNING id`,
    [storeId, productId, batchNo, expiry, unitCost, qty])).rows;
  await c.query(
    `INSERT INTO stock_flows (store_id, product_id, batch_id, direction, qty, unit_cost, ref_type, ref_id, employee_id)
     VALUES ($1,$2,$3,'入库',$4,$5,$6,$7,$8)`,
    [storeId, productId, bt[0].id, qty, unitCost, refType, refId, employeeId]);
  await c.query(
    `INSERT INTO inventory_current (store_id, product_id, qty_total) VALUES ($1,$2,$3)
      ON CONFLICT (store_id, product_id) DO UPDATE SET qty_total = inventory_current.qty_total + $3, updated_at = now()`,
    [storeId, productId, qty]);
  return bt[0].id;
}

@Controller('bundles')
class BundleController {
  /** 组合档案列表（含明细与子商品名） */
  @Get()
  async listBundles() {
    const rows = await q(`SELECT * FROM product_bundles ORDER BY id DESC LIMIT 200`);
    const out = [];
    for (const b of rows) {
      const items = await q(
        `SELECT i.*, p.name AS product_name, p.barcode, p.base_unit,
                COALESCE(ic.qty_total, 0) AS stock_qty
           FROM product_bundle_items i
           JOIN product_bundles bd ON bd.id = i.bundle_id
           JOIN products p ON p.id = i.product_id
           LEFT JOIN inventory_current ic ON ic.product_id = p.id AND ic.store_id = bd.store_id
          WHERE i.bundle_id = $1 ORDER BY i.id`, [b.id]);
      out.push({ ...b, items });
    }
    return { items: out };
  }

  /** 组装/拆分单浏览 */
  @Get('ops')
  async listOps(@Query('from') from = '', @Query('to') to = '', @Query('type') type = '') {
    return q(
      `SELECT o.*, p.name AS bundle_name, u.name AS creator_name
         FROM bundle_ops o JOIN products p ON p.id = o.bundle_product_id
         LEFT JOIN employees u ON u.id = o.created_by
        WHERE ($1 = '' OR o.created_at >= $1::date)
          AND ($2 = '' OR o.created_at < $2::date + 1)
          AND ($3 = '' OR o.op_type = $3)
        ORDER BY o.id DESC LIMIT 200`, [from, to, type]);
  }

  /** 新建组合档案：bundle_product_id 唯一；明细 ≥1；子商品不可与组合商品相同 */
  @Post()
  @RequirePerms('stock.transfer')
  async createBundle(
    @Body() b: { bundleProductId: number; name?: string; remark?: string; items: { productId: number; qty: number }[] },
    @CurrentUser() user: AuthUser,
  ) {
    const bp = await q1<any>(`SELECT * FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(b.bundleProductId)]);
    if (!bp) throw new BizException(40404, '组合商品不存在，请先在商品档案建档', 404);
    const dup = await q1(`SELECT id FROM product_bundles WHERE bundle_product_id=$1`, [bp.id]);
    if (dup) throw new BizException(40003, '该商品已存在组合定义');
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new BizException(40003, '组合明细不能为空');
    const seen = new Set<number>();
    for (const it of items) {
      if (!it.productId || !(Number(it.qty) > 0)) throw new BizException(40003, '明细须含 productId 与正数 qty');
      if (Number(it.productId) === Number(bp.id)) throw new BizException(40003, '子商品不能是组合商品本身');
      if (seen.has(Number(it.productId))) throw new BizException(40003, '同一子商品在组合内重复');
      seen.add(Number(it.productId));
    }
    return tx(async c => {
      for (const it of items) {
        const p = (await c.query(`SELECT id, name, deleted_at FROM products WHERE id=$1`, [Number(it.productId)])).rows[0];
        if (!p || p.deleted_at) throw new BizException(40404, `子商品 ${it.productId} 不存在`, 404);
      }
      const head = await c.query(
        `INSERT INTO product_bundles (store_id, bundle_product_id, name, remark) VALUES (${curStore()},$1,$2,$3) RETURNING id`,
        [bp.id, b.name || bp.name, b.remark || '']);
      for (const it of items) {
        await c.query(`INSERT INTO product_bundle_items (bundle_id, product_id, qty) VALUES ($1,$2,$3)`,
          [head.rows[0].id, it.productId, it.qty]);
      }
      await audit(curStore(), user.sub, '进销存', 'bundle.create', 'bundle', head.rows[0].id, { name: b.name || bp.name, items: items.length });
      return { id: head.rows[0].id };
    });
  }

  /**
   * 组装单 ZZ-（录入即生效）：按 BOM FIFO 消费子商品 → 生成组合商品批次
   * 单位成本 = Σ子批次成本 / 份数（守恒）；production_date=当天，保质期取组合商品 keep_days（缺省 365 天）
   */
  @Post('assemble')
  @RequirePerms('stock.transfer')
  async assemble(@Body() b: { bundleProductId: number; qty: number; remark?: string }, @CurrentUser() user: AuthUser) {
    const n = Math.round(Number(b.qty) * 1000) / 1000;
    if (!(n > 0)) throw new BizException(40003, '组装份数必须大于 0');
    return tx(async c => {
      const bd = (await c.query(
        `SELECT bd.*, p.name AS bundle_name, p.keep_days, p.track_inventory
           FROM product_bundles bd JOIN products p ON p.id = bd.bundle_product_id
          WHERE bd.bundle_product_id=$1 AND bd.status=1 FOR UPDATE`, [Number(b.bundleProductId)])).rows[0];
      if (!bd) throw new BizException(40404, '组合定义不存在或已停用', 404);
      const items = (await c.query(
        `SELECT i.*, p.name AS product_name, p.track_inventory, p.keep_days
           FROM product_bundle_items i JOIN products p ON p.id = i.product_id
          WHERE i.bundle_id=$1 ORDER BY i.id FOR UPDATE`, [bd.id])).rows;
      if (!items.length) throw new BizException(40003, '组合明细为空，不能组装');
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      await seqLock(c, 'bundle_ops', 'op_no', `ZZ-${ym}-%`);
      const seq = (await c.query(`SELECT count(*)+1 AS n FROM bundle_ops WHERE op_no LIKE $1`, [`ZZ-${ym}-%`])).rows[0];
      const no = `ZZ-${ym}-${String(seq.n).padStart(3, '0')}`;

      let total = 0;
      const detail: any[] = [];
      for (const it of items) {
        const need = Math.round(Number(it.qty) * n * 1000) / 1000;
        const r = await fifoConsume(c, bd.store_id, it.product_id, it.product_name, it.track_inventory, need, 'bundle_assemble', 0, user.sub);
        total += r.cost;
        detail.push({ productId: it.product_id, qty: need, unitCost: need > 0 ? Number((r.cost / need).toFixed(4)) : 0, costTotal: Number(r.cost.toFixed(2)) });
      }
      total = Number(total.toFixed(4));
      const unitCost = Number((total / n).toFixed(4));
      // 组合产物批次
      const r2 = await fifoProduce(c, bd.store_id, bd.bundle_product_id, `${no}-01`, bd.keep_days, n, unitCost, 'bundle_assemble', 0, user.sub);
      const head = await c.query(
        `INSERT INTO bundle_ops (store_id, op_no, op_type, bundle_product_id, qty, unit_cost, total_cost, remark, created_by)
         VALUES ($1,$2,'assemble',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [bd.store_id, no, bd.bundle_product_id, n, unitCost, total.toFixed(2), b.remark || '', user.sub]);
      for (const d of detail) {
        await c.query(`INSERT INTO bundle_op_items (op_id, product_id, qty, unit_cost, cost_total) VALUES ($1,$2,$3,$4,$5)`,
          [head.rows[0].id, d.productId, d.qty, d.unitCost, d.costTotal]);
      }
      await audit(curStore(), user.sub, '进销存', 'bundle.assemble', 'bundle_op', head.rows[0].id, { no, qty: n, total });
      return { id: head.rows[0].id, opNo: no, totalCost: Number(total.toFixed(2)), unitCost };
    });
  }

  /**
   * 拆分单 CF-（录入即生效）：FIFO 消费组合批次 → 按份数为子商品建批次
   * 成本守恒口径：子商品拆分单位成本 u = 组合单位成本 U / Σ(BOM数量)，Σ(子成本×数量) = U 精确守恒
   */
  @Post('split')
  @RequirePerms('stock.transfer')
  async split(@Body() b: { bundleProductId: number; qty: number; remark?: string }, @CurrentUser() user: AuthUser) {
    const n = Math.round(Number(b.qty) * 1000) / 1000;
    if (!(n > 0)) throw new BizException(40003, '拆分份数必须大于 0');
    return tx(async c => {
      const bd = (await c.query(
        `SELECT bd.*, p.name AS bundle_name
           FROM product_bundles bd JOIN products p ON p.id = bd.bundle_product_id
          WHERE bd.bundle_product_id=$1 AND bd.status=1 FOR UPDATE`, [Number(b.bundleProductId)])).rows[0];
      if (!bd) throw new BizException(40404, '组合定义不存在或已停用', 404);
      const items = (await c.query(
        `SELECT i.*, p.name AS product_name, p.keep_days
           FROM product_bundle_items i JOIN products p ON p.id = i.product_id
          WHERE i.bundle_id=$1 ORDER BY i.id FOR UPDATE`, [bd.id])).rows;
      if (!items.length) throw new BizException(40003, '组合明细为空，不能拆分');
      const sumQty = items.reduce((a, it) => a + Number(it.qty), 0);
      const ym = new Date().toISOString().slice(0, 7).replace('-', '');
      await seqLock(c, 'bundle_ops', 'op_no', `CF-${ym}-%`);
      const seq = (await c.query(`SELECT count(*)+1 AS n FROM bundle_ops WHERE op_no LIKE $1`, [`CF-${ym}-%`])).rows[0];
      const no = `CF-${ym}-${String(seq.n).padStart(3, '0')}`;

      // FIFO 消费组合批次（temp refId=0，落单后补记到单据）
      const r = await fifoConsume(c, bd.store_id, bd.bundle_product_id, bd.bundle_name, true, n, 'bundle_split', 0, user.sub);
      const unitU = Number((r.cost / n).toFixed(4));
      const u = sumQty > 0 ? Number((unitU / sumQty).toFixed(4)) : 0;
      let idx = 0;
      const detail: any[] = [];
      for (const it of items) {
        idx += 1;
        const qty = Math.round(Number(it.qty) * n * 1000) / 1000;
        await fifoProduce(c, bd.store_id, it.product_id, `${no}-${String(idx).padStart(2, '0')}`, it.keep_days, qty, u, 'bundle_split', 0, user.sub);
        detail.push({ productId: it.product_id, qty, unitCost: u, costTotal: Number((qty * u).toFixed(2)) });
      }
      const head = await c.query(
        `INSERT INTO bundle_ops (store_id, op_no, op_type, bundle_product_id, qty, unit_cost, total_cost, remark, created_by)
         VALUES ($1,$2,'split',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [bd.store_id, no, bd.bundle_product_id, n, unitU, r.cost.toFixed(2), b.remark || '', user.sub]);
      for (const d of detail) {
        await c.query(`INSERT INTO bundle_op_items (op_id, product_id, qty, unit_cost, cost_total) VALUES ($1,$2,$3,$4,$5)`,
          [head.rows[0].id, d.productId, d.qty, d.unitCost, d.costTotal]);
      }
      await audit(curStore(), user.sub, '进销存', 'bundle.split', 'bundle_op', head.rows[0].id, { no, qty: n, total: r.cost });
      return { id: head.rows[0].id, opNo: no, totalCost: Number(r.cost.toFixed(2)), unitCost: unitU };
    });
  }
}

// VQA-GAP07：预约调价到点自动落地（60s 扫描；到 effective_date 当日 00:00 后的第一轮内生效）
const __vqaPcCtl = new PriceChangeController();
const __vqaPcSweep = () => {
  Promise.resolve()
    .then(() => __vqaPcCtl.sweepPc({ storeId: 1, sub: null, empNo: 'SYSTEM', name: '预约生效' } as any))
    .catch(() => { /* 静默：下一轮重试 */ });
};
setTimeout(__vqaPcSweep, 8000)?.unref?.();
setInterval(__vqaPcSweep, 60000)?.unref?.();

@Module({ controllers: [ProductsController, PriceChangeController, BundleController,] })
export class ProductsModule {}
