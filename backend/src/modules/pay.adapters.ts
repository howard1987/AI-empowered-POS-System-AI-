import { createSign, createVerify, createPrivateKey, createPublicKey, randomBytes, createDecipheriv } from 'crypto';
import { SettingsService } from './settings.module';
import { decryptSecret } from '../common/secret';
import { BizException } from '../common/http';

/**
 * V4.13.3 真通道适配器（模拟通道的正式替代，接口签名一致，业务层零改动）：
 *   - WechatPayAdapter：微信支付 V3「付款码支付」POST /v3/pay/transactions/codepay（被扫 B-scan-C）
 *     + V3 退款 /v3/refund/domestic/refunds + 查单 /v3/pay/transactions/out-trade-no/{no}；
 *     SHA256withRSA 商户私钥签名（WECHATPAY2-SHA256-RSA2048）；
 *     V4.13.4：应答强制平台证书验签（/v3/certificates 下载 + AES-256-GCM 解密 + 内存缓存），
 *     USERPAYING 走 query 查单轮询由 pay.gateway 驱动
 *   - AlipayAdapter：支付宝「当面付」alipay.trade.pay（scene=bar_code）+ alipay.trade.refund；
 *     RSA2 请求签名 + 应答验签（支付宝公钥）
 *   - 通用约定：任何失败都返回 {success:false, failCode, failMsg}（不抛异常），由 pay.gateway 统一落 FAIL 流水；
 *     配置缺失抛 40904（调用方可提示补齐）；渠道未启用抛 40905
 */

export interface MicropayInput { outTradeNo: string; authCode: string; amountCents: number; description?: string; }
export interface RefundInput { outTradeNo: string; outRefundNo: string; totalCents: number; refundCents: number; }
export interface QueryResult { tradeState: string; transactionId?: string; }
export interface GatewayResult { success: boolean; transactionId?: string; refundId?: string; failCode?: string; failMsg?: string; }

/** 配置完整性：缺失即 40904（提示补齐，不发起请求） */
function need(cfg: Record<string, string | undefined>, keys: [string, string][]) {
  const miss = keys.filter(([k]) => !(cfg[k] || '').trim()).map(([, label]) => label);
  if (miss.length) throw new BizException(40904, `通道配置不完整（缺少：${miss.join('、')}），请到支付设置补齐`);
}

/** PEM 规范化：兼容粘贴时丢换行/无头尾（按 PKCS8 重包，PKCS1 带头尾原样透传） */
function normalizePem(raw: string, kind: 'private' | 'public'): string {
  const s = String(raw || '').trim();
  if (s.includes('BEGIN')) return s;
  const body = s.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim();
  if (kind === 'private') return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

// ─── 微信支付 V3（付款码支付 / 退款）───
export class WechatPayAdapter {
  private settings = new SettingsService();

  private async cfg() {
    const g = async (k: string) => String(await this.settings.getVal(k) ?? '').trim();
    const cfg = {
      mchid: await g('pay.wechat.mchid'),
      appid: await g('pay.wechat.appid'),
      serial: await g('pay.wechat.cert_serial'),
      apiv3: decryptSecret(await g('pay.wechat.apiv3_key')),
      keyPem: normalizePem(decryptSecret(await g('pay.wechat.private_key')), 'private'),
      gateway: (await g('pay.wechat.gateway')).replace(/\/+$/, '') || 'https://api.mch.weixin.qq.com',
    };
    need(cfg, [['mchid', '微信商户号'], ['appid', '微信 APPID'], ['serial', '商户证书序列号'],
      ['apiv3', 'APIv3 密钥'], ['keyPem', '商户 API 私钥']]);
    createPrivateKey(cfg.keyPem); // 私钥格式尽早暴露（抛 40904 之外格式错误）
    return cfg;
  }

  /** V3 请求签名头：WECHATPAY2-SHA256-RSA2048（message = method\npath\nts\nnonce\nbody\n） */
  private authHeader(c: any, method: string, path: string, body: string) {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${path}\n${ts}\n${nonce}\n${body}\n`;
    const signature = createSign('RSA-SHA256').update(message).sign(c.keyPem, 'base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${c.serial}"`;
  }

  // ── V4.13.4 平台证书：内存缓存 serial→PEM（12h 刷新），应答验签用 ──
  private static platCerts = new Map<string, { pem: string; fetchedAt: number }>();
  private static PLAT_TTL_MS = 12 * 3600 * 1000;

  /** 下载平台证书：GET /v3/certificates → 逐张 AES-256-GCM 解密（associated_data='certificate'） */
  private async downloadPlatCerts(c: any): Promise<Map<string, string>> {
    const path = '/v3/certificates';
    const res = await fetch(c.gateway + path, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: this.authHeader(c, 'GET', path, '') },
    });
    const j: any = await res.json().catch(() => ({}));
    const list = j?.data;
    if (res.status !== 200 || !Array.isArray(list) || !list.length) {
      throw new Error(`平台证书下载失败（HTTP ${res.status}${j?.code ? ' ' + j.code : ''}）`);
    }
    const key = Buffer.from(c.apiv3, 'utf8');
    const out = new Map<string, string>();
    for (const d of list) {
      const { nonce, associated_data, ciphertext } = d.encrypt_certificate ?? {};
      if (!ciphertext) continue;
      const buf = Buffer.from(ciphertext, 'base64');
      const tag = buf.subarray(buf.length - 16);
      const data = buf.subarray(0, buf.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(associated_data ?? 'certificate', 'utf8'));
      const pem = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      out.set(String(d.serial_no), pem);
    }
    if (!out.size) throw new Error('平台证书解密结果为空');
    return out;
  }

  /** 取（并按需刷新）平台证书；返回 serial→公钥 */
  private async platKeys(c: any, needSerial?: string): Promise<Map<string, any>> {
    const now = Date.now();
    const expired = [...WechatPayAdapter.platCerts.values()].some(v => now - v.fetchedAt > WechatPayAdapter.PLAT_TTL_MS);
    if (!WechatPayAdapter.platCerts.size || expired ||
        (needSerial && !WechatPayAdapter.platCerts.has(needSerial))) {
      const fresh = await this.downloadPlatCerts(c); // TLS 通道内首次信任（TOFU），之后按 serial 验签
      fresh.forEach((pem, serial) => WechatPayAdapter.platCerts.set(serial, { pem, fetchedAt: now }));
    }
    const keys = new Map<string, any>();
    WechatPayAdapter.platCerts.forEach((v, serial) => {
      try { keys.set(serial, createPublicKey(v.pem)); } catch { /* 跳过坏证书 */ }
    });
    return keys;
  }

  /**
   * 应答验签（V4.13.4）：Wechatpay-Timestamp/Nonce/Signature/Serial 四头 + 原始应答体。
   * message = ts\nnonce\nbody\n，平台证书公钥 SHA256withRSA。
   * 返回 null = 应答无签名头（非微信网关应答，交由调用方按错误处理）；
   * 验签失败直接抛错（拒绝信任该应答——防中间人伪造「支付成功」）。
   */
  private async verifyResp(c: any, res: any, rawBody: string) {
    const ts = String(res.headers.get('wechatpay-timestamp') ?? '');
    const nonce = String(res.headers.get('wechatpay-nonce') ?? '');
    const sig = String(res.headers.get('wechatpay-signature') ?? '');
    const serial = String(res.headers.get('wechatpay-serial') ?? '');
    if (!ts || !nonce || !sig || !serial) return null; // 无签名头
    let keys = await this.platKeys(c, serial);
    let pub = keys.get(serial);
    if (!pub) { // 未知序列号（微信轮换证书）→ 强制刷新一次再验
      WechatPayAdapter.platCerts.clear();
      keys = await this.platKeys(c, serial);
      pub = keys.get(serial);
    }
    if (!pub) throw new Error(`平台证书序列号 ${serial} 不在证书列表中，拒绝信任本次应答`);
    const ok = createVerify('RSA-SHA256').update(`${ts}\n${nonce}\n${rawBody}\n`, 'utf8').verify(pub, sig, 'base64');
    if (!ok) throw new Error('微信应答验签失败（可能遭遇篡改，拒绝本次结果）');
    return true;
  }

  /** 查单（V4.13.4）：GET /v3/pay/transactions/out-trade-no/{no}——USERPAYING 轮询与补查共用 */
  async query(outTradeNo: string): Promise<QueryResult> {
    const c = await this.cfg();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`;
    const qs = `?mchid=${encodeURIComponent(c.mchid)}`;
    const res = await fetch(c.gateway + path + qs, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: this.authHeader(c, 'GET', path + qs, '') },
    });
    const raw = await res.text();
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new Error('微信查单应答非 JSON：' + raw.slice(0, 120)); }
    await this.verifyResp(c, res, raw); // 查单结果同样验签（查单是「支付成功」的另一来源）
    if (res.status === 200) {
      return { tradeState: String(j.trade_state ?? 'UNKNOWN'), transactionId: j.transaction_id ? String(j.transaction_id) : undefined };
    }
    if (res.status === 404 && j?.code === 'ORDER_NOT_EXIST') return { tradeState: 'NOT_PAY' };
    throw new Error(`微信查单失败（HTTP ${res.status}${j?.code ? ' ' + j.code : ''}）`);
  }

  async micropay(input: MicropayInput): Promise<GatewayResult> {
    try {
      const c = await this.cfg();
      const path = '/v3/pay/transactions/codepay';
      const body = JSON.stringify({
        appid: c.appid, mchid: c.mchid,
        description: input.description || '门店扫码收款',
        out_trade_no: input.outTradeNo,
        amount: { total: input.amountCents, currency: 'CNY' },
        payer: { auth_code: input.authCode },
      });
      const res = await fetch(c.gateway + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: this.authHeader(c, 'POST', path, body) },
        body,
      });
      const raw = await res.text();
      const j: any = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
      // V4.13.4：200（含 SUCCESS / USERPAYING）必须验签通过才可信；4xx/5xx 错误应答有签名头也验
      if (res.status === 200) await this.verifyResp(c, res, raw);
      else if (res.headers.get('wechatpay-signature')) await this.verifyResp(c, res, raw);
      if (res.status === 200 && j.trade_state === 'SUCCESS') return { success: true, transactionId: String(j.transaction_id) };
      if (res.status === 200) {
        return { success: false, failCode: String(j.trade_state || 'TRADE_STATE'),
          failMsg: `微信未完成支付（trade_state=${j.trade_state ?? '未知'}）：请顾客重新出示付款码或查单确认` };
      }
      return { success: false, failCode: String(j.code ?? res.status), failMsg: String(j.message ?? '微信扣款失败') };
    } catch (e: any) {
      if (e instanceof BizException) throw e; // 配置缺失 40904 等业务异常必须透传（否则被吞成 NETWORK）
      return { success: false, failCode: 'NETWORK', failMsg: '微信通道网络异常：' + (e?.message || e) };
    }
  }

  async refund(input: RefundInput): Promise<GatewayResult> {
    try {
      const c = await this.cfg();
      const path = '/v3/refund/domestic/refunds';
      const body = JSON.stringify({
        out_trade_no: input.outTradeNo, out_refund_no: input.outRefundNo,
        amount: { refund: input.refundCents, total: input.totalCents, currency: 'CNY' },
      });
      const res = await fetch(c.gateway + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: this.authHeader(c, 'POST', path, body) },
        body,
      });
      const raw = await res.text();
      const j: any = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
      if (res.status === 200) await this.verifyResp(c, res, raw); // 退款受理结果同样验签
      if (res.status === 200 && ['SUCCESS', 'PROCESSING', 'ACCEPTED'].includes(String(j.status))) {
        return { success: true, refundId: String(j.refund_id ?? '') };
      }
      return { success: false, failCode: String(j.code ?? res.status), failMsg: String(j.message ?? '微信退款失败') };
    } catch (e: any) {
      if (e instanceof BizException) throw e;
      return { success: false, failCode: 'NETWORK', failMsg: '微信退款网络异常：' + (e?.message || e) };
    }
  }
}

// ─── 支付宝当面付（付款码支付 / 退款）───
export class AlipayAdapter {
  private settings = new SettingsService();

  private async cfg() {
    const g = async (k: string) => String(await this.settings.getVal(k) ?? '').trim();
    const cfg = {
      appId: await g('pay.alipay.app_id'),
      privPem: normalizePem(decryptSecret(await g('pay.alipay.private_key')), 'private'),
      pubPem: normalizePem(decryptSecret(await g('pay.alipay.public_key')), 'public'),
      gateway: (await g('pay.alipay.gateway')).replace(/\/+$/, '') || 'https://openapi.alipay.com/gateway.do',
    };
    need(cfg, [['appId', '支付宝 APPID'], ['privPem', '支付宝应用私钥'], ['pubPem', '支付宝公钥']]);
    return cfg;
  }

  /** RSA2 签名：参数按 key ASCII 升序拼 k=v&…（不含 sign），SHA256withRSA */
  private rsaSign(c: any, params: Record<string, string>) {
    const src = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return createSign('RSA-SHA256').update(src, 'utf8').sign(c.privPem, 'base64');
  }

  /** 统一调用：请求签名 → form POST → 应答验签（RSA2，支付宝公钥）→ code 判定 */
  private async call(c: any, method: string, biz: object) {
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
    const params: Record<string, string> = {
      app_id: c.appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2',
      timestamp, version: '1.0', biz_content: JSON.stringify(biz),
    };
    params.sign = this.rsaSign(c, params);
    const res = await fetch(c.gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
    });
    const raw = await res.text();
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new Error('支付宝应答非 JSON：' + raw.slice(0, 120)); }
    const respKey = method.replace(/\./g, '_') + '_response';
    const resp = j[respKey] ?? {};
    // 应答验签：签名原文 = 响应体中 xxx_response 对象的原文片段（不含外层 sign 字段）
    if (j.sign) {
      const start = raw.indexOf('{', raw.indexOf(`"${respKey}"`));
      const end = raw.indexOf(',"sign"', start);
      const signSrc = raw.slice(start, end);
      const ok = createVerify('RSA-SHA256').update(signSrc, 'utf8').verify(c.pubPem, j.sign, 'base64');
      if (!ok) throw new Error('支付宝应答验签失败（可能遭遇篡改，拒绝本次结果）');
    }
    return resp;
  }

  async micropay(input: MicropayInput): Promise<GatewayResult> {
    try {
      const c = await this.cfg();
      const resp: any = await this.call(c, 'alipay.trade.pay', {
        out_trade_no: input.outTradeNo, scene: 'bar_code', auth_code: input.authCode,
        total_amount: (input.amountCents / 100).toFixed(2),
        subject: input.description || '门店扫码收款',
      });
      if (String(resp.code) === '10000') return { success: true, transactionId: String(resp.trade_no) };
      return { success: false, failCode: String(resp.sub_code ?? resp.code ?? 'ERROR'),
        failMsg: String(resp.sub_msg ?? resp.msg ?? '支付宝扣款失败') };
    } catch (e: any) {
      if (e instanceof BizException) throw e;
      return { success: false, failCode: 'NETWORK', failMsg: '支付宝通道异常：' + (e?.message || e) };
    }
  }

  async refund(input: RefundInput): Promise<GatewayResult> {
    try {
      const c = await this.cfg();
      const resp: any = await this.call(c, 'alipay.trade.refund', {
        out_trade_no: input.outTradeNo, out_request_no: input.outRefundNo,
        refund_amount: (input.refundCents / 100).toFixed(2),
      });
      if (String(resp.code) === '10000') return { success: true, refundId: String(resp.trade_no ?? '') };
      return { success: false, failCode: String(resp.sub_code ?? resp.code ?? 'ERROR'),
        failMsg: String(resp.sub_msg ?? resp.msg ?? '支付宝退款失败') };
    } catch (e: any) {
      if (e instanceof BizException) throw e;
      return { success: false, failCode: 'NETWORK', failMsg: '支付宝退款异常：' + (e?.message || e) };
    }
  }
}
