import { Module, Controller, Get, Post, Body, Res } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { normalizeChineseText } from './text-normalize';

/**
 * V4.24.1 服务端离线神经语音（piper）：
 *  背景：Windows「讲述人 → 添加自然语音」装的音色（如 晓晓 Natural HD）仅限讲述人自己使用，
 *        不注册 SAPI/OneCore token，Chrome/收银台（Electron/Chromium）内核枚举不到
 *        ——注册表 + Electron44 渲染层探针双实测确认（可见音色恒为 Huihui/Kangkang/Yaoyao 三机械音）。
 *  方案：后端跑 piper（中文女声 zh_CN-huayan-medium，完全离线），新增 /tts 合成接口，
 *        收银台/浏览器/老板端/手机端统一走服务端播报，效果一致且不依赖本机音色。
 *  ⚠ 路径红线（实测）：piper/espeak-ng 崩在非 ASCII 路径（0xC0000409）——引擎目录必须纯 ASCII，
 *    顺序 = POS_TTS_DIR 环境变量 → backend/tts（ASCII 时）→ C:\ProgramData\pos-cashier\tts（回退）。
 *  目录：{tts}/piper/piper.exe(+espeak-ng-data) · {tts}/voices/zh_CN-huayan-medium.onnx(+json) · {tts}/cache/*.wav
 *  部署：tts/ 目录整体随包分发（约 80MB）；缺文件时 /tts/health=available:false，前端自动回落本机音色。
 */
const asciiOk = (p: string) => !/[^\x00-\x7F]/.test(p);
function resolveTtsDir(): string {
  const engineOk = (base: string) => {
    try { return fs.existsSync(path.join(base, 'piper', 'piper.exe')) && fs.existsSync(path.join(base, 'voices', 'zh_CN-huayan-medium.onnx')); }
    catch { return false; }
  };
  const def = path.join(__dirname, '..', '..', 'tts');             // dist/modules → backend/tts
  const cands: string[] = [];
  if (process.env.POS_TTS_DIR) cands.push(process.env.POS_TTS_DIR);
  cands.push(def, 'C:\\ProgramData\\pos-cashier\\tts');            // 与 server-up 数据目录同一 ASCII 根
  for (const c of cands) { if (asciiOk(c) && engineOk(c)) return c; }   // ASCII 且引擎齐全 → 直接用
  for (const c of cands) { if (engineOk(c)) return c; }            // 引擎在但路径非 ASCII → 仍返回（合成时报错提示挪目录）
  return def;                                                       // 引擎未部署 → health=false，前端回落本机音色
}
const TTS_DIR = resolveTtsDir();
const PIPER_EXE = path.join(TTS_DIR, 'piper', 'piper.exe');
const VOICE_ONNX = path.join(TTS_DIR, 'voices', 'zh_CN-huayan-medium.onnx');
const CACHE_DIR = path.join(TTS_DIR, 'cache');
const CACHE_MAX_BYTES = 300 * 1024 * 1024;                        // 缓存上限 300MB，超出按最旧清理

const hasEngine = () => {
  try { return fs.existsSync(PIPER_EXE) && fs.existsSync(VOICE_ONNX); } catch { return false; }
};

/* ═══ V5.0.15 播报片段拼接（零推理延迟）═════════════════════════════════════
 * 背景：piper 每次冷启动 ~855ms（实测），收银播报首句要等这一下；且金额靠文本前端转读法，
 *       存在读错风险。而播报是**封闭集**（收款/找零/金额/固定话术）。
 * 方案：backend/tools/bake-tts-fragments.mjs 用同一个 piper 离线烘焙高频「词」片段
 *       （0-99 全词 + 百千位 + 单位 + 固定话术 + 标点静音）→ public/tts-frag/*.wav
 *       运行时**纯字节拼接 PCM**（同采样率/位深/声道），无进程启动、无推理，
 *       金额读法由代码确定 → 读音绝对正确。
 * 未命中（含开放词如商品名）→ 原样回落 piper 整句合成并缓存，功能与音质不变。
 * 语速：片段库按 rate=1 烘焙；请求非 1 时仍在拼接路径上，通过响应头 x-tts-engine-rate
 *       告知前端用 Audio.playbackRate 补偿（变速不改音高、无质量损失）。
 */
const FRAG_DIR = path.join(__dirname, '..', '..', 'public', 'tts-frag');
const FRAG_MANIFEST = path.join(FRAG_DIR, 'manifest.json');
interface FragMan {
  version?: number; engine?: string; voice?: string;
  sampleRate?: number; channels?: number; bitsPerSample?: number; lengthScale?: number;
  count?: number; bytes?: number; fragments: Record<string, string>;
}
let fragCache: { mtimeMs: number; man: FragMan; keys: string[]; pcm: Map<string, Buffer> } | null = null;
function loadFrag() {
  try {
    if (!fs.existsSync(FRAG_MANIFEST)) return null;
    const st = fs.statSync(FRAG_MANIFEST);
    if (fragCache && fragCache.mtimeMs === st.mtimeMs) return fragCache;
    const man: FragMan = JSON.parse(fs.readFileSync(FRAG_MANIFEST, 'utf8'));
    if (!man || !man.fragments || !Object.keys(man.fragments).length) return null;
    fragCache = {
      mtimeMs: st.mtimeMs, man,
      keys: Object.keys(man.fragments).sort((a, b) => b.length - a.length),   // 最长匹配优先
      pcm: new Map(),
    };
    return fragCache;
  } catch { return null; }
}
/** 解析 WAV（按 chunk 遍历，兼容非标准头）；失败返回 null */
function parseWav(buf: Buffer) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bits = buf.readUInt16LE(34);
    let off = 12, data: Buffer | null = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const sz = buf.readUInt32LE(off + 4);
      if (id === 'data') { data = buf.subarray(off + 8, Math.min(off + 8 + sz, buf.length)); break; }
      off += 8 + sz + (sz % 2);
    }
    if (!data || !data.length) return null;
    return { channels, sampleRate, bits, data };
  } catch { return null; }
}
/** 片段 PCM（带内存缓存；片段库总量 ~7MB，按需加载） */
function fragPcm(f: { man: FragMan; pcm: Map<string, Buffer> }, key: string) {
  const hit = f.pcm.get(key);
  if (hit) return hit;
  const file = f.man.fragments[key];
  if (!file) return null;
  try {
    const w = parseWav(fs.readFileSync(path.join(FRAG_DIR, file)));
    if (!w) return null;
    f.pcm.set(key, w.data);
    return w.data;
  } catch { return null; }
}
/** 文本 → 片段序列（最长匹配）；存在无法覆盖的字符则返回 null（→ 回落 piper） */
function planFragments(text: string): string[] | null {
  const f = loadFrag();
  if (!f) return null;
  const s = String(text || '').replace(/\s+/g, '');          // 空格忽略（标点仍走静音片段）
  if (!s) return null;
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let hit: string | null = null;
    for (const k of f.keys) { if (s.startsWith(k, i)) { hit = k; break; } }
    if (!hit) return null;
    out.push(hit); i += hit.length;
  }
  return out.length ? out : null;
}
/** 拼接 PCM → 标准 WAV */
function concatWav(parts: Buffer[], sr: number, ch: number, bits: number) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + total, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * ch * bits / 8, 28); h.writeUInt16LE(ch * bits / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(total, 40);
  return Buffer.concat([h, ...parts]);
}
const CONCAT_CACHE = new Map<string, Buffer>();
const CONCAT_CACHE_MAX = 600;
/** 尝试用片段库拼出整句；命中返回 {buf, rate}，否则 null
 *  ⚠ V5.0.15 默认关闭（POS_TTS_CONCAT=1 才启用）：老板实测「拼接听感明显不如整句合成」
 *  —— 每个片段独立合成自带句末降调，拼接后有逐词感。整句自然度优先，拼接仅作备选保留。 */
function tryConcat(text: string): { buf: Buffer; rate: number } | null {
  if (process.env.POS_TTS_CONCAT !== '1') return null;   // 默认走整句合成（自然度优先）
  const f = loadFrag();
  if (!f) return null;
  const key = text.replace(/\s+/g, '');
  const cached = CONCAT_CACHE.get(key);
  if (cached) return { buf: cached, rate: Number(f.man.lengthScale || 1) ? 1 / Number(f.man.lengthScale || 1) : 1 };
  const plan = planFragments(text);
  if (!plan) return null;
  const sr = Number(f.man.sampleRate || 22050), ch = Number(f.man.channels || 1), bits = Number(f.man.bitsPerSample || 16);
  const parts: Buffer[] = [];
  for (const k of plan) { const p = fragPcm(f, k); if (!p) return null; parts.push(p); }
  if (!parts.length) return null;
  const buf = concatWav(parts, sr, ch, bits);
  if (CONCAT_CACHE.size >= CONCAT_CACHE_MAX) {
    const first = CONCAT_CACHE.keys().next().value;
    if (first !== undefined) CONCAT_CACHE.delete(first);
  }
  CONCAT_CACHE.set(key, buf);
  return { buf, rate: Number(f.man.lengthScale || 1) ? 1 / Number(f.man.lengthScale || 1) : 1 };
}

/* ═══ V5.0.15b piper 常驻进程（消除 837ms 冷启动）════════════════════════════
 * 实测分解：模型加载 0.37s + 合成 RTF 0.08（2.5s 音频仅 ~0.2s）+ 进程启停开销
 *   → 端到端 837ms 里绝大部分是「每句都重新 spawn 并重新加载模型」。
 * 方案：--json-input 长驻一个进程，stdin 持续喂 JSON 行，模型只加载一次 → 单句降到 ~150ms。
 * ⚠ 实测坑（务必记住）：json-input 的 output_file 字段是相对 **cwd（piper.exe 所在目录）** 解析的，
 *   不是相对 --output_dir！传相对名会把 wav 写进引擎目录（曾误写 162 个文件进去）。
 *   → output_file 必须传绝对路径；--output_dir 仅在省略 output_file 时才生效（自动时间戳文件名）。
 * 兜底：常驻不可用/超时 → 自动杀掉并回落一次性 spawn（行为与旧版一致），播报不中断。
 */
interface Resident { proc: ChildProcess; tmpDir: string; last: number; chain: Promise<unknown>; ls: string; }
/* V5.0.15b 补：实测 json-input **不支持** length_scale 字段（rate=1.8 只短了 8%，理论该短 44%）。
 * → 改按语速分档：每个 length_scale 起一个常驻进程，语速走命令行 --length-scale（必然生效）。
 *   实际档位极少（收款 1.05 / 告警 0.95 → 至多两三个进程），上限 3 个，超出回收最旧的。 */
const residents = new Map<string, Resident>();
const RESIDENT_MAX = 3;
function killResident(key?: string) {
  if (key) {
    const r = residents.get(key);
    if (!r) return;
    residents.delete(key);
    try { (r.proc.stdin as any)?.end?.(); } catch { /* 忽略 */ }
    try { r.proc.kill(); } catch { /* 忽略 */ }
    return;
  }
  for (const k of [...residents.keys()]) killResident(k);
}
function ensureResident(lsKey: string): Resident {
  const hit = residents.get(lsKey);
  if (hit && !hit.proc.killed) return hit;
  const tmpDir = path.join(CACHE_DIR, 'live');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* 忽略 */ }
  if (residents.size >= RESIDENT_MAX) {                       // 上限：淘汰最久未用的
    let oldest: { k: string; last: number } | null = null;
    for (const [k, r] of residents) if (!oldest || r.last < oldest.last) oldest = { k, last: r.last };
    if (oldest) killResident(oldest.k);
  }
  const proc = spawn(PIPER_EXE, ['-m', VOICE_ONNX, '-d', tmpDir, '--json-input', '--length-scale', lsKey],
    { cwd: path.dirname(PIPER_EXE), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  proc.stdin.on('error', () => { /* 管道断开 → 下次请求重建 */ });
  const r: Resident = { proc, tmpDir, last: Date.now(), chain: Promise.resolve(), ls: lsKey };
  proc.on('close', () => { if (residents.get(lsKey) === r) residents.delete(lsKey); });
  residents.set(lsKey, r);
  return r;
}
/** 等待 wav 写完整（出现 + 大小连续两次稳定），避免读到半截文件 */
async function waitFileReady(file: string, ms = 20000) {
  const t0 = Date.now(); let lastSize = -1, stable = 0;
  while (Date.now() - t0 < ms) {
    try {
      const st = fs.statSync(file);
      if (st.size > 44) {
        if (st.size === lastSize) { if (++stable >= 2) return true; }
        else { stable = 0; lastSize = st.size; }
      }
    } catch { /* 尚未创建 */ }
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}
/** 常驻进程合成（串行化：同一进程一次只处理一句，避免完成判定混淆） */
async function synthResident(text: string, ls: number): Promise<Buffer> {
  const lsKey = ls.toFixed(3);
  const r = ensureResident(lsKey);
  const file = path.join(r.tmpDir, `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  const job = async () => {
    r.last = Date.now();
    r.proc.stdin.write(JSON.stringify({ text, output_file: file }) + '\n', 'utf8');
    const ok = await waitFileReady(file);
    if (!ok) { killResident(lsKey); throw new Error('常驻合成超时'); }
    const buf = await fs.promises.readFile(file);
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    return buf;
  };
  const p = r.chain.then(job, job);            // 排队执行，前一个失败不影响下一个
  r.chain = p.catch(() => { });
  return p as Promise<Buffer>;
}
// 空闲 90s 无请求 → 释放进程（不长期占内存）
setInterval(() => {
  for (const [k, r] of [...residents]) if (Date.now() - r.last > 90000) killResident(k);
}, 30000).unref();

/** 合成一段文本 → {buf, source}（source=concat 片段拼接 / piper 引擎合成） */
async function synthesize(text: string, rate: number): Promise<{ buf: Buffer; source: string; rate: number }> {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) throw new BizException(40003, 'text 必填', 400);
  // V5.0.16：先过中文文本前端（TN）——日期/时间/金额/百分比/电话/序数/单位的自然读法，
  //          引擎无关，无论 piper 还是未来的 CosyVoice 都用它。
  const spoken = normalizeChineseText(clean);
  // V5.0.15：封闭句（收款/找零/金额）优先走片段拼接——零进程启动、零推理，金额读音由代码确定
  const cc = tryConcat(spoken);
  if (cc) return { buf: cc.buf, source: 'concat', rate: cc.rate };
  // 未命中片段库（含开放词：商品名/告警正文等）→ piper 整句合成 + 磁盘缓存
  // 前端 rate（0.5~2，越大越快）→ piper length-scale（越大越慢）
  const ls = Math.min(2, Math.max(0.5, 1 / (Number(rate) || 1)));
  const key = crypto.createHash('sha1').update(`${spoken}|${ls.toFixed(3)}`).digest('hex');
  const cacheFile = path.join(CACHE_DIR, `${key}.wav`);
  if (fs.existsSync(cacheFile)) {
    try { const d = new Date(); await fs.promises.utimes(cacheFile, d, d); } catch { /* LRU 时间戳失败忽略 */ }
    return { buf: await fs.promises.readFile(cacheFile), source: 'piper-cache', rate: 1 / ls };
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = path.join(CACHE_DIR, `${key}.tmp.wav`);
  // V5.0.15b：优先走常驻进程（模型只加载一次，~150ms）；异常/超时自动回落一次性 spawn
  let buf: Buffer;
  try {
    buf = await synthResident(spoken, ls);
  } catch (e: any) {
    try {
      await new Promise<void>((resolve, reject) => {
        // V4.25.7：windowsHide —— 此前每次合成都会在收银机桌面闪一下 cmd 黑窗（老板实测反馈）
        const p = spawn(PIPER_EXE, ['-m', VOICE_ONNX, '-f', tmp, '--length-scale', ls.toFixed(3)],
          { cwd: path.dirname(PIPER_EXE), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', d => { err += String(d); });
        p.on('error', e2 => reject(new Error('piper 启动失败：' + (e2.message || e2))));
        p.on('close', code => (code === 0 ? resolve() : reject(new Error(`piper 退出码 ${code}：${err.slice(0, 300)}`))));
        p.stdin.on('error', () => { /* 忽略管道错误，交给 close 判定 */ });
        p.stdin.end(spoken, 'utf8');
      });
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 44) throw new Error('piper 未产出音频');
      buf = await fs.promises.readFile(tmp);
    } catch (e2: any) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      throw new BizException(50202, `语音合成失败：${(e2 && e2.message) || e2}`, 500);
    }
  }
  try { await fs.promises.writeFile(cacheFile, buf); } catch { /* 写缓存失败不影响本次播报 */ }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  trimCache();
  return { buf, source: 'piper', rate: 1 / ls };
}

/** 缓存容量控制（超过上限按最旧删除） */
function trimCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.wav')).map(f => {
      const p = path.join(CACHE_DIR, f);
      const st = fs.statSync(p);
      return { p, m: st.mtimeMs, s: st.size };
    });
    let total = files.reduce((a, b) => a + b.s, 0);
    files.sort((a, b) => a.m - b.m);
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES) break;
      try { fs.unlinkSync(f.p); total -= f.s; } catch { /* 单个删除失败不阻断 */ }
    }
  } catch { /* 清理失败不影响主流程 */ }
}

// ─── Controller ───
@Controller('tts')
class TtsController {
  /** 引擎可用性（公开：只暴露引擎是否存在，无敏感信息；前端据此决定播报引擎）
   *  V5.0.15：附带片段库状态（frag.count / frag.available），便于现场确认拼接是否生效 */
  @Public()
  @Get('health')
  health() {
    const ok = hasEngine();
    const f = loadFrag();
    return {
      available: ok,
      engine: 'piper',
      voice: ok ? '花言（中文女声 · 离线神经）' : null,
      dir: asciiOk(TTS_DIR) ? undefined : TTS_DIR,   // 非 ASCII 路径时回带，便于现场定位「路径红线」问题
      frag: { available: !!f, count: f ? Object.keys(f.man.fragments).length : 0, bytes: f ? f.man.bytes || 0 : 0 },
    };
  }

  /** 合成播报音频：body {text, rate?} → audio/wav
   *  V5.0.15：命中片段库 → 纯拼接返回（x-tts-source=concat，无进程启动）；
   *           否则 piper 整句合成（x-tts-source=piper|piper-cache）。
   *  x-tts-engine-rate 回带音频实际语速，前端用 Audio.playbackRate 补偿到请求语速。 */
  @Post('synthesize')
  async synthesize(
    @Body() b: { text?: string; rate?: number },
    @Res() res: any,
    @CurrentUser() user: AuthUser,
  ) {
    if (!hasEngine()) throw new BizException(50201,
      asciiOk(TTS_DIR)
        ? '服务端语音引擎未就绪（缺少 piper/模型文件，请检查 ' + TTS_DIR + ' 目录）'
        : '服务端语音引擎未就绪：引擎目录含中文（' + TTS_DIR + '），piper 不支持非 ASCII 路径——请把 tts 目录整体挪到纯 ASCII 路径并设 POS_TTS_DIR 指向它', 503);
    const r = await synthesize(String(b.text || ''), Number(b.rate) || 1);
    res.set({
      'content-type': 'audio/wav',
      'content-length': String(r.buf.length),
      'cache-control': 'private, max-age=86400',
      'x-tts-source': r.source,                       // concat | piper | piper-cache（诊断用）
      'x-tts-engine-rate': r.rate.toFixed(3),
      'access-control-expose-headers': 'x-tts-source, x-tts-engine-rate',
    });
    res.status(200).send(r.buf);
  }

  /** V5.0.15 调试/自检：某句能否走拼接（返回切分结果），不产出音频 */
  @Post('plan')
  plan(@Body() b: { text?: string }, @CurrentUser() user: AuthUser) {
    const text = String(b.text || '');
    const spoken = normalizeChineseText(text);          // V5.0.16：先归一化再切分，与实际合成一致
    const plan = planFragments(spoken);
    return { text, spoken, ok: !!plan, frags: plan || [], count: plan ? plan.length : 0 };
  }
}

@Module({ controllers: [TtsController] })
export class TtsModule {}

/* V5.0.15b：服务启动后预热常驻进程——模型加载（实测 ~0.37s）发生在开机阶段，
 * 顾客付款那一刻不再为「进程启动 + 加载模型」买单（首句延迟从 ~1.1s 降到 ~0.4s）。 */
if (hasEngine()) {
  // 预热常用档位：rate=1（默认）与 rate=1.05（收款播报 PwaTTS.cash 用的倍率）——否则首句要等新进程加载模型
  setTimeout(() => {
    synthResident('欢迎光临', 1).catch(() => { });
    synthResident('欢迎光临', 1.05).catch(() => { });
  }, 3000);
}
