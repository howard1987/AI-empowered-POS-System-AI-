/**
 * 商品拼音码自动生成（V4.18.2）
 * 背景：pinyin_code 一直依赖手工填写，实测大量商品为 NULL → 收银台拼音搜索无数据。
 * 规则：中文名取拼音首字母串（测试商品→cssp），英数字原样保留，最终只留 [a-z0-9]，截断 20 位。
 * pinyin-pro 纯 JS 无字典文件依赖，NestJS 直接 require。
 */
import { pinyin } from 'pinyin-pro';

export function genPinyin(name: string): string {
  const s = String(name || '').trim();
  if (!s) return '';
  try {
    return pinyin(s, { pattern: 'first', toneType: 'none', type: 'array' })
      .join('').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  } catch { return ''; }
}
