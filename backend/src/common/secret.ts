import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 敏感设置项加密（V4.13.3 支付设置：APIv3 密钥/商户私钥等落库即密文、界面脱敏）
 *   - 存储格式：enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>（AES-256-GCM 认证加密）
 *   - 主密钥（P0-F2 整改）：env PAY_ENC_KEY 优先；未配置时首启随机生成并持久化
 *     backend/.runtime/pay-enc-key（0600），杜绝「拿到源码 = 拿到密钥」。
 *   - 兼容：历史用旧内置默认密钥加密的密文仍可解密（LEGACY 仅解密路径使用），
 *     重新保存各 secret 后即彻底脱离旧密钥。
 *   - 密文前缀识别：非 enc:v1: 开头的旧明文值 decrypt 时原样透传（兼容回退）
 */

/** 旧版内置固定派生密钥（仅限解密兼容，勿用于新密文） */
const LEGACY_KEY = createHash('sha256').update('cashier-local-pay-enc-key-v1').digest();

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
  catch { return dec(LEGACY_KEY); } // P0-F2 兼容：旧默认密钥密文仍可解，重新保存后自动升级到新密钥
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
