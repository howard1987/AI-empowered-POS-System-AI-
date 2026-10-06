/**
 * M3a · 票据 OCR 识别入库 + 低价保护（本地大模型为主 · 规则兜底）
 *   POST /ai/ocr-invoice —— 供应商票据 → 结构化明细 → 商品匹配 → 低价保护 → 入库草稿
 *   输入两种通道：
 *     imageBase64：真机 OCR —— 走本地多模态模型（ai.ocr.vl_model，Ollama /api/generate）转文本
 *     text       ：规则/手工 OCR —— 文本行「名称,条码,单价,数量[,生产日期][,保质期天]」直接解析
 *   低价保护（ai.ocr.low_price=on）：
 *     入库价 < 该商品+该供应商历史最低进价（supplier_product_prices.min_price）→
 *       block=拦截（apply 跳过该行，须 forceLowPrice=true 强推放行）/ warn=仅标黄提示放行
 *   未匹配商品：标记 unmatched；autoCreate=true 且条码/名称齐全时自动建档（售价默认单价）
 */
import { Body, Controller, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/auth';
import { BizException } from '../common/http';
import { q, tx, audit } from '../common/db';
import { PRODUCT_VISIBLE } from '../common/sql';   // V5.0.0 商品可售可见性

/** V4.14.8 签字1：手写签名姓名识别（本地 VL 模型；未启用/不可达时返回空名 → 前端回退人工填写） */
@Controller('ai/signature')
export class AiSignatureController {
  @Post('read')
  async readName(@Body() b: { image?: string }, @CurrentUser() user: AuthUser) {
    const image = String(b.image || '').replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    if (!image) throw new BizException(40003, '请上传签字图片');
    const llmOn = Boolean(await getSetting('ai.llm.enabled', false));
    // V5.0.1：提示具体怎么开启（老板反馈 #13「AI识别提示识别服务不可达」不知如何处理）
    if (!llmOn) return { name: '', note: '本地大模型未启用：请先安装并启动 Ollama（ollama.com，命令行 ollama serve），再在 系统设置→AI赋能 打开「本地大模型」开关；当前请手工填写姓名' };
    const base = String(await getSetting('ai.llm.base', DEFAULT_BASE)).replace(/\/$/, '');
    const model = String(await getSetting('ai.ocr.vl_model', DEFAULT_OCR_MODEL));
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '图片中是一个手写中文签名。请只输出签名中的中文姓名本身（2~4 个汉字），不要解释、不要标点、不要空格。无法辨认时只输出：无',
          images: [image], stream: false,
        }),
      });
      if (!res.ok) return { name: '', note: `识别服务 HTTP ${res.status}（${base}），请手工填写或检查 Ollama` };
      const j: any = await res.json().catch((): any => null);
      const name = (String(j?.response || '').match(/[\u4e00-\u9fa5]/g) || []).join('').slice(0, 4);
      return { name, note: name ? '' : '未能辨认，请手工填写' };
    } catch {
      return { name: '', note: `识别服务不可达（${base}）：请确认 Ollama 正在运行（ollama serve）且已拉取 ${String(await getSetting('ai.ocr.vl_model', DEFAULT_OCR_MODEL))} 模型；当前可手工填写` };
    }
  }
}

const DEFAULT_OCR_MODEL = 'qwen2.5-vl:7b';
const DEFAULT_BASE = 'http://localhost:11434';
const DEFAULT_KEEP_DAYS = 365;

async function getSetting(key: string, fb: any = null): Promise<any> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
  return r.length ? r[0].value : fb;
}

/** 真机 OCR：本地多模态模型把票据图转文本（仅 ai.llm.enabled=on 且服务可达时走） */
async function ocrImageToText(imageBase64: string): Promise<string> {
  const llmOn = Boolean(await getSetting('ai.llm.enabled', false));
  if (!llmOn) throw new BizException(40004, '本地大模型未启用：票据图片识别需开启 Ollama（AI 模型管理），或改用文本模式');
  const base = String(await getSetting('ai.llm.base', DEFAULT_BASE)).replace(/\/$/, '');
  const model = String(await getSetting('ai.ocr.vl_model', DEFAULT_OCR_MODEL));
  const ctl = AbortSignal.timeout(20000);
  let res: Response;
  try {
    res = await fetch(`${base}/api/generate`, {
      method: 'POST', signal: ctl,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: '请把这张供应商送货票据/入库单图片转成纯文本：每行一个商品，字段用英文逗号分隔：商品名称,条码(没有就空),单价,数量,生产日期(YYYY-MM-DD,没有就空),保质期天数(没有就空)。只输出数据行，不要解释。',
        images: [imageBase64], stream: false,
      }),
    });
  } catch {
    throw new BizException(40004, `OCR 模型不可达（${base}），请检查 Ollama 服务或改用手工文本模式`);
  }
  if (!res.ok) throw new BizException(40004, `OCR 模型返回 HTTP ${res.status}`);
  const j: any = await res.json().catch((): any => null);
  const text = String(j?.response || '').trim();
  if (!text) throw new BizException(40004, 'OCR 未识别到票据文本，请换角度重拍或改用手工文本模式');
  return text;
}

/** 解析票据文本行：名称,条码,单价,数量[,生产日期][,保质期天]（兼容 , | ， \t 顿号） */
function parseInvoiceLines(text: string): any[] {
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((raw, i) => {
    const parts = raw.split(/[,|，、\t]+/).map(s => s.trim());
    const name = parts[0] || '';
    const barcode = parts[1] || '';
    const price = Number(parts[2]);
    const qty = Number(parts[3] || 1);
    const productionDate = /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(parts[4] || '')
      ? parts[4]!.replace(/\//g, '-') : '';
    const keepDays = Number(parts[5] || 0);
    const err: string[] = [];
    if (!name) err.push('缺商品名');
    if (!(price > 0)) err.push('单价非法');
    if (!(qty > 0)) err.push('数量非法');
    return { line: i + 1, raw, name, barcode, price, qty, productionDate, keepDays, err };
  });
}

/** T3 增强：供应商证照/合同图片 → 结构化字段
 *  架构：专用 OCR 引擎做主力文本提取（ai.ocr.engine_url）；
 *        仅当 OCR 未部署/不可达时才回退 Ollama 多模态（ai.ocr.vl_model）看图识字。
 *        OCR 文本的结构化（→JSON 字段）交由本地文本模型（ai.llm.model），更快更准。 */
export async function recognizeDocument(imageBase64: string, docType = '证照/合同') {
  const engineUrl = String(await getSetting('ai.ocr.engine_url', '') || '').trim();

  // —— 主力：专用 OCR 引擎（识别文字，不负责理解）——
  let ocrText = '';
  if (engineUrl) {
    try {
      const res = await fetch(engineUrl, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: imageBase64 }),
      });
      if (res.ok) {
        const j: any = await res.json().catch((): any => null);
        ocrText = String(j?.text || '');
        if (!ocrText && Array.isArray(j?.lines)) ocrText = j.lines.map((l: any) => (typeof l === 'string' ? l : l.text || '')).join('\n');
      }
    } catch { /* OCR 不可达 → 走 Ollama 兜底 */ }
  }

  if (ocrText && ocrText.trim()) {
    const byLlm = await parseDocFieldsWithLLM(ocrText, docType);   // 优先：本地文本模型把 OCR 文本结构化
    if (byLlm) { byLlm.ok = true; return byLlm; }
    const byRule = parseDocFieldsByRule(ocrText);                  // 兜底：规则提取关键字段（不依赖大模型）
    if (byRule.certNo || byRule.expireDate || byRule.issueDate) { byRule.ok = true; byRule.note = '已用 OCR + 规则提取关键字段，请核对发证机关/名称等'; return byRule; }
    return { ok: false, note: 'OCR 已提取文本，但本地大模型未开启无法自动结构化，请开启「本地大模型」或手工填写' };
  }

  // —— 兜底：Ollama 多模态直接看图（OCR 未部署 / 不可用）——
  const llmOn = Boolean(await getSetting('ai.llm.enabled', false));
  if (!llmOn) return { ok: false, note: '未部署 OCR 引擎且本地大模型未开启：请在「系统设置→AI赋能」开启本地大模型，或部署 OCR 引擎（见 backend/tools/ocr-server.py）并填写「OCR引擎地址」；当前请手工填写。' };
  const base = String(await getSetting('ai.llm.base', DEFAULT_BASE)).replace(/\/$/, '');
  const model = String(await getSetting('ai.ocr.vl_model', DEFAULT_OCR_MODEL));
  const prompt = `这是一张${docType}的清晰照片。请从中提取以下字段并以 JSON 输出（字段名固定）：
title（文档标题/合同名称，没有则空串）、cert_no（证件编号/合同编号/注册号/统一社会信用代码，没有则空串）、issuer（发证机关/甲方/盖章单位，没有则空串）、issue_date（发证或签订日期，格式 YYYY-MM-DD，没有则空串）、expire_date（有效期至或到期日，格式 YYYY-MM-DD；若标注“长期有效”或无到期则空串）、name（持证单位/乙方名称，没有则空串）。
只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余字符。`;
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, images: [imageBase64], stream: false, format: 'json' }),
    });
    if (!res.ok) return { ok: false, note: `识别服务 HTTP ${res.status}（${base}），请手工填写或检查 Ollama` };
    const j: any = await res.json().catch((): any => null);
    let raw = String(j?.response || '');
    let obj: any = {};
    try { obj = JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { obj = JSON.parse(m[0]); } catch { /* ignore */ }
    }
    if (!obj || Object.keys(obj).length === 0) return { ok: false, note: '未能从图片识别出结构化字段，请换角度重拍或部署 OCR 引擎' };
    const clean = (v: any) => String(v == null ? '' : v).trim();
    return {
      ok: true,
      title: clean(obj.title),
      certNo: clean(obj.cert_no || obj.certNo),
      issuer: clean(obj.issuer),
      issueDate: fmtDocDate(clean(obj.issue_date || obj.issueDate)),
      expireDate: fmtDocDate(clean(obj.expire_date || obj.expireDate)),
      name: clean(obj.name),
    };
  } catch {
    return { ok: false, note: `识别服务不可达（${base}）：请确认 Ollama 正在运行（ollama serve）且已拉取 ${model}；当前可手工填写` };
  }
}

/** OCR 文本 + 本地文本模型（ai.llm.model，非 VL）→ 结构化字段；模型不可用返回 null */
async function parseDocFieldsWithLLM(ocrText: string, docType: string): Promise<any> {
  const llmOn = Boolean(await getSetting('ai.llm.enabled', false));
  if (!llmOn) return null;
  const base = String(await getSetting('ai.llm.base', DEFAULT_BASE)).replace(/\/$/, '');
  const model = String(await getSetting('ai.llm.model', 'qwen2.5:7b'));
  const prompt = `以下是${docType}图片经 OCR 得到的全部文本：\n"""\n${ocrText}\n"""\n请从中提取以下字段并以 JSON 输出（字段名固定）：
title（文档标题/合同名称）、cert_no（证件编号/合同编号/统一社会信用代码/注册号）、issuer（发证机关/甲方/盖章单位）、issue_date（发证或签订日期 YYYY-MM-DD，无则空）、expire_date（有效期至 YYYY-MM-DD，长期或无则空）、name（持证单位/乙方名称）。
只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余字符。`;
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch((): any => null);
    let raw = String(j?.response || '');
    let obj: any = {};
    try { obj = JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { obj = JSON.parse(m[0]); } catch { /* ignore */ }
    }
    if (!obj || !Object.keys(obj).length) return null;
    const clean = (v: any) => String(v == null ? '' : v).trim();
    return {
      title: clean(obj.title),
      certNo: clean(obj.cert_no || obj.certNo),
      issuer: clean(obj.issuer),
      issueDate: fmtDocDate(clean(obj.issue_date || obj.issueDate)),
      expireDate: fmtDocDate(clean(obj.expire_date || obj.expireDate)),
      name: clean(obj.name),
    };
  } catch { return null; }
}

/** OCR 文本规则兜底（不依赖大模型）：提取统一社会信用代码 + 日期，尽力而为 */
function parseDocFieldsByRule(text: string): any {
  const um = text.match(/(^|[^0-9A-Z])([0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10})(?=$|[^0-9A-Z])/);
  const usci = um ? um[2] : '';
  const dts = (text.match(/\d{4}[-年./]\d{1,2}[-月./]\d{1,2}/g) || [])
    .map(fmtDocDate).filter(Boolean);
  const issueDate = dts.length > 1 ? dts[0] : '';
  const expireDate = dts.length ? dts[dts.length - 1] : '';
  return { title: '', certNo: usci, issuer: '', issueDate, expireDate, name: '' };
}

/** 把“2026年10月05日 / 2026.10.05 / 2026/10/05”等归一成 YYYY-MM-DD */
function fmtDocDate(s: string): string {
  if (!s) return '';
  const m = String(s).match(/(\d{4})\s*[-年./]\s*(\d{1,2})\s*[-月./]\s*(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return String(s);
  return '';
}

@Controller('ai/ocr-invoice')
export class AiOcrController {
  /**
   * 票据识别入库：preview（默认）→ 校验修正 → apply=true 生成入库草稿
   * body: { imageBase64?, text?, supplierId, apply?, forceLowPrice?, autoCreate? }
   * 权限：与移动收货同口径（登录即可，产出为草稿仍需入库审核）；未匹配商品建档需 ai.train.launch
   */
  @Post()
  async ocrInvoice(@Body() b: {
    imageBase64?: string; text?: string; supplierId?: number;
    apply?: boolean; forceLowPrice?: boolean; autoCreate?: boolean;
    rows?: { line: number; name: string; barcode: string; price: number; qty: number }[];
  }, @CurrentUser() user: AuthUser) {
    const canCreateProduct = user.perms.includes('*') || user.perms.includes('ai.train.launch') || user.empNo === 'ADMIN';
    const autoCreate = !!b.autoCreate && canCreateProduct;   // 无 AI 训练权限时自动关闭建档（未匹配商品提示先建档，不报 403）
    const supplierId = Number(b.supplierId || 0);
    // V4.14.1：未选供应商时允许先识别（preview），按票据指名/明细主供应商投票建议供应商；apply 时必须已定供应商
    let sup: any[] = [];
    if (supplierId) {
      sup = await q(`SELECT id, name FROM suppliers WHERE id=$1`, [supplierId]);
      if (!sup.length) throw new BizException(40004, '供应商不存在');
    } else if (b.apply) {
      throw new BizException(40003, '请先选择供应商');
    }

    // 1) 明细来源：preview 编辑后的 rows 直提（已解析）→ 票据文本（imageBase64 OCR / text 解析）
    const editedRows = Array.isArray(b.rows) && b.rows.length ? b.rows : null;
    let text = String(b.text || '').trim();
    if (!editedRows && !text && b.imageBase64) text = await ocrImageToText(b.imageBase64);
    if (!editedRows && !text) throw new BizException(40003, '请上传票据图片、粘贴票据文本或回传识别明细');

    // 1.5) 供应商自动建议（未选时）：票据文本指名 → 命中商品主供应商投票
    let suggestedSupplier: { id: number; name: string } | null = null;
    if (!supplierId) {
      const nameHit = await q(
        `SELECT id, name FROM suppliers
          WHERE store_id=$1 AND $2 <> '' AND (position(name in $2) > 0 OR position($3 in name) > 0)
          ORDER BY id LIMIT 1`,
        [user.storeId, text.slice(0, 400), text.slice(0, 12)]);
      if (nameHit.length) suggestedSupplier = { id: Number(nameHit[0].id), name: String(nameHit[0].name) };
    }

    // 2) 解析 + 商品匹配 + 低价保护
    const lowPriceOn = Boolean(await getSetting('ai.ocr.low_price', true));
    const lowPriceMode = String(await getSetting('ai.ocr.low_price_mode', 'block'));
    const rows: any[] = [];
    const vote = new Map<number, number>();
    const parsed = editedRows
      ? editedRows.map(r => ({
          line: Number(r.line) || 0, raw: `${r.name},${r.barcode || ''},${r.price},${r.qty}`,
          name: String(r.name || ''), barcode: String(r.barcode || ''), price: Number(r.price),
          qty: Number(r.qty) || 1, productionDate: '', keepDays: 0,
          err: (!r.name ? ['缺商品名'] : []).concat(!(Number(r.price) > 0) ? ['单价非法'] : []),
        }))
      : parseInvoiceLines(text);
    for (const r of parsed) {
      const row: any = { line: r.line, raw: r.raw, name: r.name, barcode: r.barcode,
                         price: r.price, qty: r.qty, productionDate: r.productionDate,
                         keepDays: r.keepDays, err: r.err.slice(), matched: false, matchedId: null,
                         matchedName: '', minPrice: null, lowPrice: false, blocked: false };
      if (row.err.length) { row.ok = false; rows.push(row); continue; }

      // 商品匹配：条码精确 → 名称模糊
      let prod: any[] = [];
      if (r.barcode) prod = await q(`SELECT id, name, sell_price FROM products WHERE barcode=$1 LIMIT 1`, [r.barcode]);
      if (!prod.length) prod = await q(
        `SELECT id, name, sell_price FROM products WHERE ${PRODUCT_VISIBLE('$1')} AND status=1 AND name ILIKE '%'||$2||'%' ORDER BY id LIMIT 1`,
        [user.storeId, r.name.slice(0, 20)]);
      if (prod.length) {
        row.matched = true; row.matchedId = Number(prod[0].id); row.matchedName = String(prod[0].name);
        // V4.14.1：未选供应商时按命中商品的主供应商投票建议
        if (!supplierId) {
          const psup = await q(`SELECT supplier_default_id AS sid FROM products WHERE id=$1 AND supplier_default_id IS NOT NULL`, [row.matchedId]);
          if (psup.length) vote.set(Number(psup[0].sid), (vote.get(Number(psup[0].sid)) || 0) + 1);
        }
        // 低价保护：该商品+该供应商历史最低进价
        if (lowPriceOn && supplierId) {
          const mp = await q(
            `SELECT MIN(min_price) AS m FROM supplier_product_prices WHERE product_id=$1 AND supplier_id=$2`,
            [row.matchedId, supplierId]);
          row.minPrice = mp[0]?.m != null ? Number(mp[0].m) : null;
          if (row.minPrice != null && r.price < row.minPrice) {
            row.lowPrice = true;
            if (lowPriceMode === 'block' && !b.forceLowPrice) row.blocked = true;
          }
        }
      } else {
        row.unmatched = true;   // 未建档商品：可勾选 autoCreate 建档
      }
      row.ok = !row.err.length;
      rows.push(row);
    }

    const okRows = rows.filter(r => r.ok && r.matched);
    const lowRows = okRows.filter(r => r.lowPrice);
    const blockedRows = okRows.filter(r => r.blocked);
    const unmatched = rows.filter(r => r.ok && r.unmatched);
    if (!b.apply) {
      // V4.14.1：文本指名未命中时，用命中商品主供应商投票兑底建议
      if (!suggestedSupplier && vote.size) {
        let best = 0, bestN = -1;
        vote.forEach((n, sid) => { if (n > bestN) { bestN = n; best = sid; } });
        const s2 = await q(`SELECT id, name FROM suppliers WHERE id=$1`, [best]);
        if (s2.length) suggestedSupplier = { id: Number(s2[0].id), name: String(s2[0].name) };
      }
      return {
        apply: false, supplier: sup[0] || null, suggestedSupplier, lowPriceOn, lowPriceMode,
        okCount: okRows.length, lowCount: lowRows.length, blockedCount: blockedRows.length,
        unmatchedCount: unmatched.length, rows,
      };
    }

    // 3) apply：生成入库草稿（blocked 行跳过；生产日期缺省=今天，备注提示核对）
    const writable = okRows.filter(r => !r.blocked);
    if (!writable.length) throw new BizException(50010, '全部明细被低价保护拦截（可在识别结果中勾选强制通过）');
    return tx(async c => {
      const cx = (sql: string, p: any[] = []) => c.query(sql, p).then((x: any) => x.rows);
      const seq = await cx(`SELECT count(*)+1 AS n FROM inbound_orders WHERE inbound_no LIKE $1`, [`RK-${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, '')}-%`]);
      const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, '');
      const no = `RK-${today}-${String(seq[0].n).padStart(3, '0')}`;
      const ord = await cx(
         `INSERT INTO inbound_orders (store_id, inbound_no, supplier_id, status, employee_id, remark)
         VALUES ($1,$2,$3,'草稿',$4,$5) RETURNING id`,
         [user.storeId, no, supplierId, user.sub, `票据OCR生成（${sup[0].name}）${b.forceLowPrice ? '·已强推低价' : ''}`]);

      const created: any[] = [];
      for (const r of writable) {
        let productId = r.matchedId;
        if (!productId && autoCreate && r.name) {
          if (!r.barcode) continue;   // 建档须条码
          const dup = await cx(`SELECT id FROM products WHERE barcode=$1`, [r.barcode]);
          if (dup.length) { productId = Number(dup[0].id); }
          else {
            const seq2 = await cx(`SELECT COALESCE(MAX(id),0)+1 AS n FROM products`);
            const ins = await cx(
              `INSERT INTO products (store_id, goods_no, barcode, name, base_unit, keep_days, sell_price, status)
               VALUES ($1,$2,$3,$4,'件',$5,$6,1) RETURNING id`,
               [user.storeId, `SKU-${String(seq2[0].n).padStart(4, '0')}`, r.barcode, r.name,
                r.keepDays || DEFAULT_KEEP_DAYS, r.price]);
            productId = Number(ins[0].id);
          }
        }
        if (!productId) continue;
        await cx(
          `INSERT INTO inbound_order_items (inbound_id, product_id, production_date, qty, unit_cost, line_remark)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ord[0].id, productId, r.productionDate || today, r.qty, r.price,
           r.lowPrice ? `低于历史最低进价 ¥${r.minPrice}${r.blocked ? '' : '（warn）'}` : null]);
        created.push({ line: r.line, productId, name: r.matchedName || r.name, qty: r.qty,
                       price: r.price, lowPrice: r.lowPrice, blocked: r.blocked });
      }
      if (!created.length) throw new BizException(50010, '无有效明细可生成草稿');
      await audit(user.storeId, user.sub, 'AI', 'ai.ocr.invoice', 'inbound', ord[0].id,
        { no, supplierId, rows: created.length, low: created.filter(x => x.lowPrice).length });
      return { apply: true, inboundId: Number(ord[0].id), inboundNo: no, status: '草稿',
               createdCount: created.length, blocked: blockedRows.length, created };
    });
  }
}
