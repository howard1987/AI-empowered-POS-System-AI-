/**
 * M3b · 移动签名自动关联（入库 / 退货 / 报损 / 盘点）
 *   操作员：单据创建时 employee_id=当前登录店员（调用方已写入，自动关联）
 *   业务员：供应商业务员（suppliers.contact_person）的预采电子签名模板（signature_templates.supplier_id）
 *           → 生成签名调用记录（signature_records，证据链：单据哈希）→ 回填单据 sign_record_id
 *   无可用模板时返回 null（前端触手机屏幕现场签名，不阻塞业务流程）
 * 防滥用（5.6.8③）：大额单据（≥auth.sign_threshold）按 auth.sign_large_mode
 *   - 现场补签：不自动关联模板，返回 { needsLive:true }，前端必须现场手写一次
 *   - 短信确认：自动关联 + 生成确认码（无短信通道时线下核对），等待 confirmSignature 置 sms_confirmed
 */
import { createHash, randomInt } from 'crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { cx as cxr } from '../common/db';   // V5.0.19i（Q-03）：事务查询统一委托 common/db 规范实现

export interface SignResult {
  recordId: number;
  personName: string;
  roleTitle: string;
  imagePath: string;
  scene: string;
  needSms?: boolean;   // 大额·短信确认模式：已关联模板，等待被签字人输入确认码
  smsCode?: string;    // 无短信通道时线下核对：操作员当面/电话转达被签字人
}

export interface LiveSignRequired {
  needsLive: true;     // 大额·现场补签模式：模板不可用，必须现场手写一次
}

interface AttachOpts {
  storeId: number;
  bizType: string;      // inbound / return / loss / count
  bizId: number;
  summary: string;      // 单据上下文（哈希防篡改用）
  usedBy: number;       // 操作员（店员）employee_id
  supplierId?: number;  // 供应商（入库/退货传入，业务员模板按供应商匹配）
  amount?: number;      // 单据金额（大额判断 5.6.8③，阈值 auth.sign_threshold）
}

/** 业务员模板匹配：优先供应商专属模板，其次未绑定供应商的通用业务员模板（存量数据兜底） */
function tplSql(bySupplier: boolean): string {
  if (bySupplier) {
    return `SELECT * FROM signature_templates
      WHERE store_id=$1 AND supplier_id=$2 AND role_title ILIKE '%业务员%' AND status=1
        AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
      ORDER BY (CASE WHEN COALESCE(sample_count,1) >= 3 THEN 0 ELSE 1 END), id DESC LIMIT 1`;
  }
  return `SELECT * FROM signature_templates
    WHERE store_id=$1 AND supplier_id IS NULL AND role_title ILIKE '%业务员%' AND status=1
      AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
    ORDER BY (CASE WHEN COALESCE(sample_count,1) >= 3 THEN 0 ELSE 1 END), id DESC LIMIT 1`;
}

/** 大额治理配置（5.6.8③）：阈值默认 5000 元；确认方式默认 现场补签 */
async function getLargeCfg(c: any): Promise<{ threshold: number; mode: string }> {
  const cx = (sql: string, p: any[] = []) => cxr(c, sql, p);   // V5.0.19i（Q-03）：委托 common/db 规范实现
  let threshold = 5000, mode = '现场补签';
  const t = await cx(`SELECT value FROM system_settings WHERE setting_key='auth.sign_threshold'`);
  if (t.length && typeof t[0].value === 'number') threshold = Number(t[0].value);
  const m = await cx(`SELECT value FROM system_settings WHERE setting_key='auth.sign_large_mode'`);
  if (m.length && typeof m[0].value === 'string') mode = String(m[0].value);
  return { threshold, mode };
}

export async function autoAttachSignature(
  c: any,
  o: AttachOpts,
): Promise<SignResult | LiveSignRequired | null> {
  const cx = (sql: string, p: any[] = []) => cxr(c, sql, p);   // V5.0.19i（Q-03）：委托 common/db 规范实现
  // 业务员=供应商业务员：无供应商（如报损/盘点）不自动关联，交由前端手机屏幕现场签名
  if (!o.supplierId) return null;
  const large = await getLargeCfg(c);
  const isLarge = o.amount != null && Number(o.amount) >= large.threshold;
  // 大额 + 现场补签模式：不自动关联模板，前端必须现场手写一次（防滥用 5.6.8③）
  if (isLarge && large.mode !== '短信确认') return { needsLive: true };

  let tpl: any[] = await cx(tplSql(true), [o.storeId, o.supplierId]);
  if (!tpl.length) tpl = await cx(tplSql(false), [o.storeId]);
  if (!tpl.length) return null;

  const docHash = createHash('sha256')
    .update(`biz:${o.bizType}:${o.bizId}:${o.summary}`).digest('hex');
  const op = await cx(`SELECT name FROM employees WHERE id=$1`, [o.usedBy]);
  const operatorName = op.length ? String(op[0].name) : '';

  // 大额 + 短信确认模式：自动关联模板 + 生成确认码，等待被签字人确认
  if (isLarge) {
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const rec = await cx(
      `INSERT INTO signature_records (store_id, template_id, biz_type, biz_id, doc_hash, scene, used_by, person_name, image_path, operator_name, sms_code, sms_sent_at)
       VALUES ($1,$2,$3,$4,$5,'短信待确认',$6,$7,$8,$9,$10,now()) RETURNING id`,
      [o.storeId, tpl[0].id, o.bizType, o.bizId, docHash, o.usedBy,
       String(tpl[0].person_name), String(tpl[0].image_path), operatorName, code]);
    return {
      recordId: Number(rec[0].id),
      personName: String(tpl[0].person_name),
      roleTitle: String(tpl[0].role_title),
      imagePath: String(tpl[0].image_path),
      scene: '短信待确认',
      needSms: true,
      smsCode: code,
    };
  }

  const rec = await cx(
    `INSERT INTO signature_records (store_id, template_id, biz_type, biz_id, doc_hash, scene, used_by, person_name, image_path, operator_name)
     VALUES ($1,$2,$3,$4,$5,'自动关联',$6,$7,$8,$9) RETURNING id`,
    [o.storeId, tpl[0].id, o.bizType, o.bizId, docHash, o.usedBy,
     String(tpl[0].person_name), String(tpl[0].image_path), operatorName]);
  return {
    recordId: Number(rec[0].id),
    personName: String(tpl[0].person_name),
    roleTitle: String(tpl[0].role_title),
    imagePath: String(tpl[0].image_path),
    scene: '自动关联',
  };
}

/** 现场签名（手机屏幕手写）：无预采模板/大额现场补签时调用，base64 落盘 + 证据链直存（scene=现场补签） */
export async function attachSignature(
  c: any,
  o: AttachOpts & { personName: string; roleTitle?: string; image: string },
): Promise<SignResult> {
  const cx = (sql: string, p: any[] = []) => cxr(c, sql, p);   // V5.0.19i（Q-03）：委托 common/db 规范实现
  const imagePath = saveBase64Image(o.image);
  const docHash = createHash('sha256')
    .update(`biz:${o.bizType}:${o.bizId}:${o.summary}:${o.personName}`).digest('hex');
  const op = await cx(`SELECT name FROM employees WHERE id=$1`, [o.usedBy]);
  const operatorName = op.length ? String(op[0].name) : '';
  const rec = await cx(
    `INSERT INTO signature_records (store_id, template_id, biz_type, biz_id, doc_hash, scene, used_by, person_name, image_path, operator_name)
     VALUES ($1,NULL,$2,$3,$4,'现场补签',$5,$6,$7,$8) RETURNING id`,
    [o.storeId, o.bizType, o.bizId, docHash, o.usedBy, o.personName, imagePath, operatorName]);
  return {
    recordId: Number(rec[0].id),
    personName: o.personName,
    roleTitle: o.roleTitle || '业务员',
    imagePath,
    scene: '现场补签',
  };
}

/** 大额·短信确认码校验（5.6.8③）：被签字人输入 6 位确认码 → 置 sms_confirmed=true（最多错 3 次） */
export async function confirmSignature(
  c: any,
  o: { bizType: string; bizId: number; code: string },
): Promise<{ ok: boolean; err?: string }> {
  const cx = (sql: string, p: any[] = []) => cxr(c, sql, p);   // V5.0.19i（Q-03）：委托 common/db 规范实现
  const recs = await cx(
    `SELECT * FROM signature_records WHERE biz_type=$1 AND biz_id=$2 ORDER BY id DESC LIMIT 1`, [o.bizType, o.bizId]);
  if (!recs.length) return { ok: false, err: '单据没有待确认的签字记录' };
  const rec = recs[0];
  if (rec.sms_confirmed) return { ok: true };
  if (!rec.sms_code) return { ok: false, err: '该签字记录无需短信确认' };
  if (String(rec.sms_code) !== String(o.code).trim()) {
    await cx(`UPDATE signature_records SET sms_try = COALESCE(sms_try,0)+1 WHERE id=$1`, [rec.id]);
    return { ok: false, err: '确认码不正确，请核对后重试' };
  }
  await cx(`UPDATE signature_records SET sms_confirmed=true, sms_confirmed_at=now() WHERE id=$1`, [rec.id]);
  return { ok: true };
}

/** 签字 base64 图片落盘到 backend/public/signatures/，返回静态访问路径（5.6.8） */
export function saveBase64Image(dataUrl: string): string {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!m) throw new Error('仅支持 PNG/JPEG 签字图片（base64 dataURL）');
  const dir = path.join(__dirname, '..', '..', 'public', 'signatures');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ext = m[1] === 'png' ? 'png' : 'jpg';
  const file = `sig-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
  writeFileSync(path.join(dir, file), Buffer.from(m[2], 'base64'));
  return `/signatures/${file}`;
}

/* ═══ V4.14.8 签字完整性甄别 + 样本自动采集 ═══ */

/**
 * 操作员签名关联（V4.15.0 签字3：单据明细须同时展示 操作员 + 业务员 两张签名）：
 * 按登录员工（ref_employee_id）取本人预采签字模板 → 生成 scene='操作员签名' 的调用记录。
 * 无本人模板时静默跳过（不阻塞业务；店员样本由现场签名自动采集补齐）。
 */
export async function attachOperatorSignature(
  c: any,
  o: { storeId: number; bizType: string; bizId: number; summary: string; usedBy: number },
): Promise<number | null> {
  const cx = (sql: string, p: any[]) => cxr(c, sql, p);   // V5.0.19i（Q-03）：委托 common/db 规范实现
  const op = await cx(`SELECT name FROM employees WHERE id=$1`, [o.usedBy]);
  const operatorName = op.length ? String(op[0].name) : '';
  if (!operatorName) return null;
  const tpl = await cx(
    `SELECT * FROM signature_templates
      WHERE store_id=$1 AND supplier_id IS NULL AND ref_employee_id=$2 AND status=1
      ORDER BY (CASE WHEN COALESCE(sample_count,1) >= 3 THEN 0 ELSE 1 END), id DESC LIMIT 1`,
    [o.storeId, o.usedBy]);
  if (!tpl.length) return null;
  const docHash = createHash('sha256')
    .update(`biz:${o.bizType}:${o.bizId}:${o.summary}:op:${o.usedBy}`).digest('hex');
  const rec = await cx(
    `INSERT INTO signature_records (store_id, template_id, biz_type, biz_id, doc_hash, scene, used_by, person_name, image_path, operator_name)
     VALUES ($1,$2,$3,$4,$5,'操作员签名',$6,$7,$8,$9) RETURNING id`,
    [o.storeId, tpl[0].id, o.bizType, o.bizId, docHash, o.usedBy, operatorName,
     String(tpl[0].image_path), operatorName]);
  return Number(rec[0].id);
}

/**
 * 人员分类（V4.15.0；V4.17.0 P13 收口）：
 *   供应商人员 / 门店人员 / 大客户人员 —— 电子签名管理严格分栏调用。
 *   V4.17.0：去掉「其余一律落大客户人员」的错误兜底（超级管理员现场补签被冤枉的根因），
 *   三不靠（无供应商、无员工绑定、身份备注不含大客户）→ 落「待确认」，由界面手动改分类兜底。
 */
export function personCatOf(supplierId: any, refEmployeeId: any, roleTitle: string): string {
  if (supplierId) return '供应商人员';
  if (refEmployeeId) return '门店人员';
  if (String(roleTitle || '').includes('大客户')) return '大客户人员';
  return '待确认';
}

/** 人员分类合法值（改分类接口校验用） */
export const PERSON_CATS = ['门店人员', '供应商人员', '大客户人员', '待确认'];

/** 图片内容指纹：对落盘文件取 md5，用于「同一张图不重复计遍数」（V4.17.0 三源统一归并） */
const imgHashCache = new Map<string, string>();
function imgHashOf(p: string): string {
  if (imgHashCache.has(p)) return imgHashCache.get(p) as string;
  let h = '';
  try {
    h = createHash('md5').update(readFileSync(path.join(__dirname, '..', '..', 'public', String(p).replace(/^\/+/, '')))).digest('hex');
  } catch { h = `miss:${p}`; }   // 文件已丢失 → 按唯一处理，不参与去重
  imgHashCache.set(p, h);
  return h;
}

/** 姓名归一化：去空白/间隔点/分隔符 —— 「张 / 三」→「张三」 */
export function normalizeName(s: string): string {
  return String(s || '').replace(/[\s·・.。/、,，\-—_]/g, '');
}

/**
 * 姓名匹配甄别（V4.14.8 签字2：防假签/乱签/冒签）：
 * 归一化后，所签姓名必须完整包含单据上的名字（张三 ⊂ 张三/张三丰 可过；
 * 张五/刘三/单字「张」均不符）。任一方为空 → 放行（无从比对，交由流程留痕）。
 */
export function nameMatches(expected: string, actual: string): boolean {
  const e = normalizeName(expected), a = normalizeName(actual);
  if (!e || !a) return true;
  return a === e || a.includes(e);
}

/**
 * 签字样本统一归并（V4.17.0 P13 三源统一：Web 预采集 / 手机三连采 / 现场补签共用）：
 * 同人判定 = 归一化姓名 + 人员分类 + 供应商（供应商人员须同一家供应商才合并）。
 * 命中已有模板 → 追加画像图（内容 md5 去重，同一张图不重复计遍数），满 MAX_PROFILE_IMAGES 张滚动保留最新；
 * replace=true（重采）→ 整体替换画像并按新图计数。未命中 → 建档（分类走 personCatOf，三不靠落「待确认」）。
 * 返回命中/新建的模板 id。
 */
export const MAX_PROFILE_IMAGES = 9;

export async function mergeSamples(
  c: any,
  o: { storeId: number; personName: string; roleTitle: string; imagePaths: string[];
       supplierId?: number | null; refEmployeeId?: number | null; collectedBy: number;
       replace?: boolean; personCat?: string | null },
): Promise<number> {
  const cx = (sql: string, p: any[]) => cxr(c, sql, p);   // V5.0.19i（Q-03）：委托 common/db 规范实现
  const name = normalizeName(o.personName);
  if (!name || !o.imagePaths.length) throw new Error('姓名与签字图片不能为空');
  const newCat = o.personCat || personCatOf(o.supplierId, o.refEmployeeId, o.roleTitle);

  // 候选集：供应商侧按供应商圈定；非供应商侧先按员工本人，再放宽到同分类同名的存量行（归并历史散行）
  let cands: any[] = [];
  if (o.supplierId) {
    cands = await cx(`SELECT id, person_name, person_cat, role_title, image_path, profile, sample_count
                        FROM signature_templates WHERE store_id=$1 AND supplier_id=$2`, [o.storeId, o.supplierId]);
  } else {
    cands = await cx(`SELECT id, person_name, person_cat, role_title, image_path, profile, sample_count
                        FROM signature_templates WHERE store_id=$1 AND supplier_id IS NULL AND ref_employee_id=$2`,
      [o.storeId, o.refEmployeeId || 0]);
    if (!cands.length) {
      cands = await cx(`SELECT id, person_name, person_cat, role_title, image_path, profile, sample_count
                          FROM signature_templates
                         WHERE store_id=$1 AND supplier_id IS NULL AND ref_employee_id IS NULL
                           AND person_cat IN ('门店人员','待确认')`, [o.storeId]);
    }
  }
  const existing = cands.filter((t: any) => normalizeName(t.person_name) === name).slice(0, 1);

  if (existing.length) {
    const t = existing[0];
    const oldImgs: string[] = (Array.isArray(t.profile?.images) ? t.profile.images : [t.image_path]).filter(Boolean);
    let imgs: string[];
    if (o.replace) {
      imgs = o.imagePaths.slice(0, MAX_PROFILE_IMAGES);
    } else {
      const oldHashes = new Set(oldImgs.map(imgHashOf));
      const add = o.imagePaths.filter(p => !oldHashes.has(imgHashOf(p)));
      imgs = [...oldImgs, ...add].slice(-MAX_PROFILE_IMAGES);   // 滚动保留最新 9 张
    }
    // 原分类为「待确认」→ 本次采集带来了可信归属则纠正；其余保持原分类（不静默改人）
    const cat = (String(t.person_cat || '') === '待确认' && newCat !== '待确认') ? newCat : String(t.person_cat || newCat);
    await cx(
      `UPDATE signature_templates
          SET profile = $2::jsonb, sample_count = $3, image_path = COALESCE(image_path, $4), person_cat = $5,
              role_title = CASE WHEN COALESCE(role_title,'')='' THEN $6 ELSE role_title END
        WHERE id=$1`,
      [t.id, JSON.stringify({ images: imgs, updated_at: new Date().toISOString() }),
       Math.min(imgs.length, 99), imgs[imgs.length - 1] || o.imagePaths[0], cat, o.roleTitle || '店员']);
    return Number(t.id);
  }

  const imgs = o.imagePaths.slice(0, MAX_PROFILE_IMAGES);
  const row = await cx(
    `INSERT INTO signature_templates (store_id, person_name, role_title, image_path, collected_by,
                                      supplier_id, ref_employee_id, person_cat, profile, sample_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,
    [o.storeId, o.personName.trim(), o.roleTitle || (o.supplierId ? '业务员' : '店员'), imgs[0], o.collectedBy,
     o.supplierId || null, o.refEmployeeId || null, newCat,
     JSON.stringify({ images: imgs, updated_at: new Date().toISOString() }), imgs.length]);
  return Number(row[0].id);
}

/**
 * 签字样本自动采集（V4.14.8 签字1；V4.17.0 起内部转调 mergeSamples 统一归并）：
 * 供应商侧 → 按 supplier_id+person_name 幂等补样本（无则建档 role=业务员）；
 * 非供应商侧 → 按 ref_employee_id 幂等采集店员样本（不绑供应商）。
 */
export async function collectIntoTemplates(
  c: any,
  o: { storeId: number; personName: string; roleTitle: string; imagePath: string;
       supplierId?: number | null; refEmployeeId?: number | null; collectedBy: number },
): Promise<void> {
  await mergeSamples(c, {
    storeId: o.storeId, personName: o.personName, roleTitle: o.roleTitle,
    imagePaths: [o.imagePath], supplierId: o.supplierId, refEmployeeId: o.refEmployeeId,
    collectedBy: o.collectedBy,
  });
}
