/**
 * M1 · AI 模型管理（本地大模型为主 · 规则为辅）
 *   GET  /ai/models/runtime  —— 运行时状态：自动探测 / 手动路径解析 → 已安装模型清单 + 当前主模型
 *   POST /ai/models/scan     —— 手动识别：{ base? } 服务地址 / { path? } 安装或数据路径
 *   POST /ai/models/select   —— { model } 设置默认主模型（qa/日报/识别兜底生效）
 *   POST /ai/models/auto     —— 重新自动探测（成功即接管，失败不覆盖 manual）
 *   探测逻辑：优先 base 地址 GET /api/tags；手动路径解析 Ollama models/manifests 清单
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePerms } from '../common/auth';
import { BizException } from '../common/http';
import { q, audit } from '../common/db';
import { assertSafeBaseUrl, safeProbeError, UnsafeTargetError } from '../common/netguard';
import { existsSync, readdirSync, statSync } from 'fs';

const DEFAULT_BASE = 'http://localhost:11434';
const TIMEOUT_MS = 4000;

async function getSetting(key: string, fb: any = null): Promise<any> {
  const r = await q(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
  return r.length ? r[0].value : fb;
}
async function setSetting(key: string, value: any) {
  // V4.14.8 修复：原 UPDATE-only 写法在行不存在时影响 0 行被静默吞掉 →
  // 「设为主模型」重启后回退候选。改为 upsert（setting_key UNIQUE）。
  await q(
    `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type)
     VALUES ('AI赋能', $1, $1, $2::jsonb, $2::jsonb, 'string')
     ON CONFLICT (setting_key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
    [key, JSON.stringify(value)]);
}

/** 探测 Ollama 服务：GET /api/tags → [{name,size,family,quant}] */
async function probeBase(base: string): Promise<{ ok: boolean; models: any[]; err?: string }> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, models: [], err: `HTTP ${res.status}` };
    const j: any = await res.json();
    const models = (j?.models ?? []).map((m: any) => ({
      name: String(m.name ?? ''),
      size: Number(m.size ?? 0),
      family: String(m.details?.family ?? ''),
      quant: String(m.details?.quantization_level ?? ''),
    }));
    return { ok: true, models };
  } catch (e: any) {
    return { ok: false, models: [], err: safeProbeError(e) };
  }
}

/** 递归收集 manifests 下 <ns>/<model>/<tag>.json → 模型名（最多 6 层防深扫） */
function collectManifests(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || !existsSync(root)) return out;
  let entries: import('fs').Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = `${root}\\${e.name}`;
    if (e.isDirectory()) {
      collectManifests(full, depth + 1, out);
    } else if (e.name.endsWith('.json')) {
      // 形如 ...manifests\registry.ollama.ai\library\qwen2.5\7b.json
      const parts = full.replace(/\\/g, '/').split('manifests/');
      const rel = parts[parts.length - 1].replace(/\.json$/, '').split('/');
      if (rel.length >= 2) {
        const ns = rel.length >= 3 ? rel[rel.length - 3] : 'library';
        const name = rel[rel.length - 2];
        const tag = rel[rel.length - 1];
        out.push(ns === 'library' ? `${name}:${tag}` : `${ns}/${name}:${tag}`);
      }
    }
  }
  return [...new Set(out)].sort();
}

/** 手动路径解析：接受安装目录或 .ollama 数据目录，自动定位 manifests */
function probePath(path: string): { ok: boolean; models: string[]; root?: string; err?: string } {
  const p = String(path || '').trim();
  // P1-M2 收口：拒绝 .. 与过深路径（≤6 级），防把本接口当全盘目录浏览器
  if (p.includes('..') || p.split(/[\\/]+/).filter(Boolean).length > 6) {
    return { ok: false, models: [], err: '路径层级过深或不合法' };
  }
  if (!p || !existsSync(p)) return { ok: false, models: [], err: '路径不存在' };
  const cands = [
    path,
    `${path}\\models\\manifests`,
    `${path}\\.ollama\\models\\manifests`,
    `${path}\\models`,
  ];
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isDirectory()) {
      const names = collectManifests(c);
      if (names.length) return { ok: true, models: names, root: c };
    }
  }
  return { ok: false, models: [], err: '未在路径下发现 Ollama 模型清单（models/manifests）' };
}

@Controller('ai/models')
export class AiModelsController {
  /** 运行时状态：自动探测 → 手动回退 → none（规则兜底） */
  @Get('runtime')
  async runtime() {
    const mode = String(await getSetting('ai.llm.mode', 'auto'));
    const base = String(await getSetting('ai.llm.base', DEFAULT_BASE));
    const path = String(await getSetting('ai.llm.path', '') || '');
    const selected = String(await getSetting('ai.llm.model', 'qwen2.5:7b'));
    const enabled = Boolean(await getSetting('ai.llm.enabled', false));

    let models: any[] = [];
    let source = '', reachable = false, err = '';
    if (mode !== 'none') {
      const p = await probeBase(base);
      if (p.ok) { models = p.models; source = `auto://${base}`; reachable = true; }
      else if (mode === 'manual' && path) {
        const pm = probePath(path);
        if (pm.ok) { models = pm.models.map(n => ({ name: n })); source = `path://${pm.root}`; reachable = true; }
        else err = `自动探测失败：${p.err || '不可达'}；手动路径：${pm.err}。请确认服务器已安装并启动 Ollama（命令行运行 ollama serve），或在 AI 模型管理中改用手动识别`;
      } else err = `自动探测失败：${p.err || '不可达'}。请确认服务器已安装并启动 Ollama（命令行运行 ollama serve），或在 AI 模型管理中改用手动识别`;
    }
    const selectedIn = models.some((m: any) => m.name === selected);
    return {
      mode, base, path, source, reachable, err, enabled,
      models, selected, selectedKnown: selectedIn,
      chatOn: reachable && enabled,
    };
  }

  /** 手动识别：base 服务地址 或 path 安装/数据路径，成功后写配置 */
  @Post('scan')
  @RequirePerms('sys.settings')
  async scan(@Body() b: { base?: string; path?: string }, @CurrentUser() u: AuthUser) {
    const base = (b?.base || '').trim().replace(/\/$/, '');
    const path = (b?.path || '').trim();
    if (!base && !path) throw new BizException(40003, '请提供服务地址或安装路径');
    if (base) {
      // P1-H2：目标地址校验（协议/内嵌凭据/云元数据等一律拒绝）
      try { assertSafeBaseUrl(base); }
      catch (e: any) { throw new BizException(40003, e instanceof UnsafeTargetError ? e.message : '服务地址不合法'); }
      const p = await probeBase(base);
      if (!p.ok) throw new BizException(40004, `服务不可达（${base}）`);
      await setSetting('ai.llm.base', base);
      await setSetting('ai.llm.path', null);
      await setSetting('ai.llm.mode', 'manual');
      await audit(u.storeId, u.sub, 'AI', 'ai.model.scan', 'setting', undefined, { base, models: p.models.length });
      return { ok: true, source: `base://${base}`, models: p.models };
    }
    const pm = probePath(path);
    if (!pm.ok) throw new BizException(40004, pm.err);
    await setSetting('ai.llm.path', path);
    await setSetting('ai.llm.mode', 'manual');
    await audit(u.storeId, u.sub, 'AI', 'ai.model.scan', 'setting', undefined, { path, root: pm.root, models: pm.models.length });
    return { ok: true, source: `path://${pm.root}`, models: pm.models.map(n => ({ name: n })) };
  }

  /** 设置默认主模型（qa / 日报 / 识别兜底生效） */
  @Post('select')
  @RequirePerms('sys.settings')
  async select(@Body() b: { model?: string }, @CurrentUser() u: AuthUser) {
    const model = (b?.model || '').trim();
    if (!model) throw new BizException(40003, '模型名不能为空');
    await setSetting('ai.llm.model', model);
    await audit(u.storeId, u.sub, 'AI', 'ai.model.select', 'setting', undefined, { model });
    return { ok: true, model };
  }

  /** 重新自动探测（成功即接管；失败保留原配置供手动） */
  @Post('auto')
  @RequirePerms('sys.settings')
  async auto(@CurrentUser() u: AuthUser) {
    const base = String(await getSetting('ai.llm.base', DEFAULT_BASE));
    const p = await probeBase(base);
    if (!p.ok) throw new BizException(40004, `自动探测失败（${base}）：${p.err}。请确认 Ollama 已启动（ollama serve），或改用手动识别`);
    await setSetting('ai.llm.mode', 'auto');
    await audit(u.storeId, u.sub, 'AI', 'ai.model.auto', 'setting', undefined, { base, models: p.models.length });
    return { ok: true, base, models: p.models };
  }
}
