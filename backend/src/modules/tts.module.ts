import { Module, Controller, Get, Post, Body, Res } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, Public } from '../common/auth';

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

/** 合成一段文本 → WAV Buffer（缓存命中直接回） */
async function synthesize(text: string, rate: number): Promise<Buffer> {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) throw new BizException(40003, 'text 必填', 400);
  // 前端 rate（0.5~2，越大越快）→ piper length-scale（越大越慢）
  const ls = Math.min(2, Math.max(0.5, 1 / (Number(rate) || 1)));
  const key = crypto.createHash('sha1').update(`${clean}|${ls.toFixed(3)}`).digest('hex');
  const cacheFile = path.join(CACHE_DIR, `${key}.wav`);
  if (fs.existsSync(cacheFile)) {
    try { const d = new Date(); await fs.promises.utimes(cacheFile, d, d); } catch { /* LRU 时间戳失败忽略 */ }
    return fs.promises.readFile(cacheFile);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = path.join(CACHE_DIR, `${key}.tmp.wav`);
  // 文本走 stdin（避免命令行转义/长度问题）；失败时清理半成品
  try {
    await new Promise<void>((resolve, reject) => {
      // V4.25.7：windowsHide —— 此前每次合成都会在收银机桌面闪一下 cmd 黑窗（老板实测反馈）
      const p = spawn(PIPER_EXE, ['-m', VOICE_ONNX, '-f', tmp, '--length-scale', ls.toFixed(3)],
        { cwd: path.dirname(PIPER_EXE), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err += String(d); });
      p.on('error', e => reject(new Error('piper 启动失败：' + (e.message || e))));
      p.on('close', code => (code === 0 ? resolve() : reject(new Error(`piper 退出码 ${code}：${err.slice(0, 300)}`))));
      p.stdin.on('error', () => { /* 忽略管道错误，交给 close 判定 */ });
      p.stdin.end(clean, 'utf8');
    });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 44) throw new Error('piper 未产出音频');
    const buf = await fs.promises.readFile(tmp);
    try { await fs.promises.rename(tmp, cacheFile); } catch { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } }
    trimCache();
    return buf;
  } catch (e: any) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw new BizException(50202, `语音合成失败：${(e && e.message) || e}`, 500);
  }
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
  /** 引擎可用性（公开：只暴露引擎是否存在，无敏感信息；前端据此决定播报引擎） */
  @Public()
  @Get('health')
  health() {
    const ok = hasEngine();
    return {
      available: ok,
      engine: 'piper',
      voice: ok ? '花言（中文女声 · 离线神经）' : null,
      dir: asciiOk(TTS_DIR) ? undefined : TTS_DIR,   // 非 ASCII 路径时回带，便于现场定位「路径红线」问题
    };
  }

  /** 合成播报音频：body {text, rate?} → audio/wav（同文本+语速命中缓存，秒回） */
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
    const buf = await synthesize(String(b.text || ''), Number(b.rate) || 1);
    res.set({
      'content-type': 'audio/wav',
      'content-length': String(buf.length),
      'cache-control': 'private, max-age=86400',
    });
    res.status(200).send(buf);
  }
}

@Module({ controllers: [TtsController] })
export class TtsModule {}
