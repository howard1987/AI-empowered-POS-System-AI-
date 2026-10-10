import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BizException } from './http';

/**
 * 敏感设置项加密（V4.13.3 支付设置：APIv3 密钥/商户私钥等落库即密文、界面脱敏）
 *   - 存储格式：enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>（AES-256-GCM 认证加密）
 *   - 主密钥（P0-F2 整改）：env PAY_ENC_KEY 优先；未配置时首启随机生成并持久化
 *     backend/.runtime/pay-enc-key（0600），杜绝「拿到源码 = 拿到密钥」。
 *   - 兼容（S-04 整改）：历史旧内置密钥密文仅在宽限期内可解密——
 *     锚点 = .runtime/pay-enc-anchor 首建时刻，宽限期 PAY_LEGACY_GRACE_DAYS（默认 30 天）；
 *     启动与每次兼容解密时告警剩余天数；**期满后拒绝解密**并提示到「支付设置」重新录入商户密钥。
 *     宽限期内重新保存任一 secret 即以新密钥重加密、彻底脱离旧密钥。
 *   - 密文前缀识别：非 enc:v1: 开头的旧明文值 decrypt 时原样透传（兼容回退）
 */

/** 旧版内置固定派生密钥（仅限宽限期内解密兼容，勿用于新密文） */
const LEGACY_KEY = createHash('sha256').update('cashier-local-pay-enc-key-v1').digest();

/** S-04：旧密钥兼容宽限期（天）。0 = 立即禁用旧密钥解密 */
const LEGACY_GRACE_DAYS = Math.max(0, Number(process.env.PAY_LEGACY_GRACE_DAYS || 30));

/** 宽限锚点：.runtime/pay-enc-anchor 首建时刻；若运行期主密钥文件已存在则取其 mtime
 *  （旧密文只可能早于运行期密钥诞生——以更早者为锚，宽限期计算更精确），此后不重置。 */
function legacyAnchorMs(): number {
  const f = path.join(__dirname, '..', '..', '.runtime', 'pay-enc-anchor');
  const keyFile = path.join(__dirname, '..', '..', '.runtime', 'pay-enc-key');
  try {
    if (fs.existsSync(f)) return fs.statSync(f).mtimeMs;
    let anchor = Date.now();
    try { if (fs.existsSync(keyFile)) anchor = Math.min(anchor, fs.statSync(keyFile).mtimeMs); } catch { /* noop */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(anchor), { mode: 0o600 });
    return anchor;
  } catch { return Date.now(); }
}
const LEGACY_ANCHOR_MS = legacyAnchorMs();
const LEGACY_DEADLINE_MS = LEGACY_ANCHOR_MS + LEGACY_GRACE_DAYS * 86_400_000;

/** 启动告警：宽限期内提示剩余天数；已过期为红色警示 */
(() => {
  const remaining = Math.ceil((LEGACY_DEADLINE_MS - Date.now()) / 86_400_000);
  if (remaining > 0) {
    console.warn(`[安全] 支付商户密钥旧版加密兼容宽限期剩余 ${remaining} 天（截止 ${new Date(LEGACY_DEADLINE_MS).toISOString().slice(0, 10)}）。请在「支付设置」重新保存商户密钥以升级加密，期满后旧密文将无法解密`);
  } else if (LEGACY_GRACE_DAYS > 0 || LEGACY_GRACE_DAYS === 0) {
    console.warn(`[安全] 支付商户密钥旧版加密兼容宽限期已过——旧内置密钥加密的密文将拒绝解密。请在「支付设置」重新录入商户密钥`);
  }
})();

function resolvePayEncKey(): Buffer {
  if (process.env.PAY_ENC_KEY) return createHash('sha256').update(process.env.PAY_ENC_KEY).digest();
  const file = path.join(__dirname, '..', '..', '.runtime', 'pay-enc-key');
  try {
    if (fs.existsSync(file)) {
      const s = fs.readFileSync(file, 'utf8').trim();
      if (s.length >= 32) return createHash('sha256').update(s).digest();
    }
    const s = randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
    console.warn(`[安全] 未配置 PAY_ENC_KEY，已生成随机主密钥持久化：${file}（P0-F2；换机迁移请带走该文件或改配 env）`);
    return createHash('sha256').update(s).digest();
  } catch {
    console.warn('[安全] PAY_ENC_KEY 密钥文件读写失败，本次运行使用进程内随机密钥');
    return createHash('sha256').update(randomBytes(48).toString('hex')).digest();
  }
}
const KEY = resolvePayEncKey();

export function isEncrypted(v: string): boolean {
  return typeof v === 'string' && v.startsWith('enc:v1:');
}

/** 明文 → 密文（已加密的原样返回，幂等） */
export function encryptSecret(plain: string): string {
  if (isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

/** 密文 → 明文（非密文原样透传；先新密钥后旧内置密钥兼容解密；损坏抛错由调用方处理） */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const dec = (k: Buffer) => {
    const [, , ivB64, tagB64, ctB64] = stored.split(':');
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
  };
  try { return dec(KEY); }
  catch {
    // S-04：旧内置密钥兼容——仅宽限期内可用；期满拒绝并给出可行动指引（BizException 直达调用方提示）
    const remaining = Math.ceil((LEGACY_DEADLINE_MS - Date.now()) / 86_400_000);
    if (remaining <= 0) {
      throw new BizException(50000,
        '商户密钥仍为旧版加密，兼容宽限期已过（为安全不再使用旧内置密钥解密）。请到「支付设置」重新录入/保存商户密钥，保存后即以新密钥加密');
    }
    console.warn(`[安全] 检测到旧版加密密文，已用旧内置密钥兼容解密（宽限期剩余 ${remaining} 天）。请在「支付设置」重新保存商户密钥以升级加密`);
    return dec(LEGACY_KEY);
  }
}

/** 脱敏展示：••••+末 4 位（短值/空值全打码） */
export function maskSecret(stored: string): string {
  if (!stored) return '未配置';
  let tail = '';
  try {
    const plain = decryptSecret(stored);
    tail = plain.length >= 4 ? plain.slice(-4) : '';
  } catch { tail = '????'; }
  return `••••••${tail || '••••'}`;
}
