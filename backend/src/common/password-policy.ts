/**
 * 密码强度策略（V4.14.6 R8：员工端与会员端共用同一策略）
 * 策略来源：system_settings 键 auth.password_policy（enum，与设置页「安全与登录」分组一致）：
 *   6位以上 / 8位字母数字（默认） / 8位字母数字符号 / 10位强密码
 * checkPasswordPolicy：不达标抛 BizException(40003)；
 * passwordPolicyLabel：只取文案（公开端点用，不抛错）。
 */
import { BizException } from './http';
import { SettingsService } from '../modules/settings.module';

const RULES: Record<string, { min: number; letter?: boolean; num?: boolean; upper?: boolean; symbol?: boolean; label: string }> = {
  '6位以上': { min: 6, label: '至少 6 位' },
  '8位字母数字': { min: 8, letter: true, num: true, label: '至少 8 位且同时包含字母和数字' },
  '8位字母数字符号': { min: 8, letter: true, num: true, symbol: true, label: '至少 8 位且包含字母、数字和特殊符号' },
  '10位强密码': { min: 10, letter: true, num: true, upper: true, label: '至少 10 位且包含大小写字母和数字' },
};

async function currentPolicy() {
  const raw = String(await new SettingsService().getVal('auth.password_policy') ?? '8位字母数字').replace(/^"|"$/g, '');
  return RULES[raw] || RULES['8位字母数字'];
}

export async function passwordPolicyLabel(): Promise<string> {
  return (await currentPolicy()).label;
}

export async function checkPasswordPolicy(pwd: string) {
  const r = await currentPolicy();
  if (!pwd || pwd.length < r.min) throw new BizException(40003, `新密码不符合强度策略：${r.label}`);
  if (r.letter && !/[A-Za-z]/.test(pwd)) throw new BizException(40003, `新密码不符合强度策略：${r.label}`);
  if (r.num && !/\d/.test(pwd)) throw new BizException(40003, `新密码不符合强度策略：${r.label}`);
  if (r.upper && !/[A-Z]/.test(pwd)) throw new BizException(40003, `新密码不符合强度策略：${r.label}`);
  if (r.symbol && !/[^A-Za-z0-9]/.test(pwd)) throw new BizException(40003, `新密码不符合强度策略：${r.label}`);
}
