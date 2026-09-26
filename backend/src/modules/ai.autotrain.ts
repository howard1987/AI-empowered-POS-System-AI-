/**
 * V4.27.6 · AI 自动训练调度（把"每周手动跑三步脚本"变成系统设置里的自动任务）
 * ================================================================================
 * 通俗版说明：系统平时自动收集店员拍的商品照片（样本库）。本模块在您设置的时间
 * （比如每周日凌晨 2 点，收银闲时），自动在服务器上执行：
 *   ① 打包样本成训练集（export_dataset.py）
 *   ② 用 GPU 训练出新模型（train_detect.py，产出 best.onnx）
 *   ③ 把新模型自动"导入"到系统模型库（版本号 +1，可在训练台看到）
 * 默认【不自动启用】：需在后台设置打开 ai.autotrain.enabled，并配好服务器上的
 * Python + ultralytics（一次性准备，见 backend/ai-train/README.md）。
 * 默认【不自动激活】：新模型导入后店长在训练台确认效果再点"激活"（可设置改为自动激活）。
 *
 * 前置条件（一次性）：
 *   - 服务器装有 NVIDIA 显卡 + CUDA 版 PyTorch + ultralytics（pip install -r requirements.txt）
 *   - 后端进程能读到 AI_UPLOADS_DIR（样本图片目录）与数据库
 * 安全设计：
 *   - 同时只允许一个训练任务；低样本量自动跳过；日志只留尾部；异常不阻断收银主链路。
 */
import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import { q, audit } from '../common/db';

/* ── 路径 ── */
const AI_TRAIN_DIR = path.join(__dirname, '..', '..', 'ai-train');           // backend/ai-train
const MODELS_DIR = path.join(__dirname, '..', '..', 'models');               // backend/models

/* ── 设置读取（全部带默认值，缺迁移/缺设置不报错） ── */
const sget = async (key: string, def: string): Promise<string> => {
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
    const v = r[0]?.value;
    return v == null || v === '' ? def : String(typeof v === 'object' ? JSON.stringify(v) : v);
  } catch { return def; }
};

export interface AutoTrainStatus {
  enabled: boolean;
  running: boolean;
  schedule: string;            // 人类可读，如"每周日 02:00"
  lastRun: any | null;
}

const readCfg = async () => ({
  enabled: (await sget('ai.autotrain.enabled', 'false')).toLowerCase() === 'true',
  dayOfWeek: Math.min(6, Math.max(0, Number(await sget('ai.autotrain.day_of_week', '0')) || 0)),   // 0=周日
  hour: Math.min(23, Math.max(0, Number(await sget('ai.autotrain.hour', '2')) || 2)),
  minNewSamples: Math.max(10, Number(await sget('ai.autotrain.min_samples', '30')) || 30),
  epochs: Math.min(200, Math.max(5, Number(await sget('ai.autotrain.epochs', '60')) || 60)),
  model: (await sget('ai.autotrain.model', 'yolo26n.pt')).replace(/[^\w.\-]/g, '') || 'yolo26n.pt',
  python: (await sget('ai.autotrain.python', 'python')).slice(0, 120),
  device: (await sget('ai.autotrain.device', '0')).slice(0, 20),
  autoActivate: (await sget('ai.autotrain.auto_activate', 'false')).toLowerCase() === 'true',
});

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 读上次运行记录（system_settings ai.autotrain.last_run） */
export async function autotrainStatus(): Promise<AutoTrainStatus> {
  const cfg = await readCfg();
  let lastRun: any = null;
  try {
    const r = await q(`SELECT value FROM system_settings WHERE setting_key='ai.autotrain.last_run'`);
    if (r[0]?.value) lastRun = typeof r[0].value === 'string' ? JSON.parse(r[0].value) : r[0].value;
  } catch { /* 忽略 */ }
  return { enabled: cfg.enabled, running, schedule: `每周${WEEK_CN[cfg.dayOfWeek]} ${String(cfg.hour).padStart(2, '0')}:00`, lastRun };
}

/* ── 运行状态（进程内，重启即清零） ── */
let running = false;
let stage = '';

const setLastRun = async (patch: any) => {
  try {
    const cur = await autotrainStatus();
    const next = { ...(cur.lastRun || {}), ...patch };
    await q(
      `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
       VALUES ('AI赋能','ai.autotrain.last_run','自动训练上次运行',$1::jsonb,'null','json','自动写回，勿手工改')
       ON CONFLICT (setting_key) DO UPDATE SET value=$1::jsonb`,
      [JSON.stringify(next)]);
  } catch { /* 状态写回失败不影响训练 */ }
};

/** 子进程执行 + 输出尾部捕获（防日志爆炸） */
function runStep(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; tail: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    const collect = (d: Buffer) => {
      out += d.toString();
      if (out.length > 256 * 1024) out = out.slice(-128 * 1024);   // 只保留尾部
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, tail: out.slice(-6000) }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, tail: `${out}\n[spawn] ${e.message}`.slice(-6000) }); });
  });
}

/* ══════════════ V4.27.7 训练环境检测 + 一键安装（pip 两连） ══════════════ */

interface EnvJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  steps: { name: string; status: 'running' | 'ok' | 'failed' | 'skipped'; log: string }[];
}
let envJob: EnvJob | null = null;

/** 环境检测：python / pip / torch(+CUDA) / ultralytics */
export async function autotrainEnvCheck(): Promise<any> {
  const cfg = await readCfg();
  const py = cfg.python;
  const probe = async (args: string[], timeoutMs = 60_000) => {
    const r = await runStep(py, args, AI_TRAIN_DIR, timeoutMs);
    return { ok: r.code === 0, out: r.tail.trim().split(/\r?\n/).filter(Boolean).slice(-3) };
  };
  const pyVer = await probe(['--version']);
  const pipVer = await probe(['-m', 'pip', '--version']);
  const torch = await probe(['-c', 'import torch;print(torch.__version__);print(bool(torch.cuda.is_available()));print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "no-gpu")'], 120_000);
  const ultra = await probe(['-c', 'import ultralytics;print(ultralytics.__version__)'], 120_000);
  return {
    python: py,
    pythonVersion: pyVer.ok ? (pyVer.out[0] || '') : null,
    pip: pipVer.ok,
    torchVersion: torch.ok ? (torch.out[0] || null) : null,
    cudaAvailable: torch.ok ? (torch.out[1] === 'true') : null,
    gpuName: torch.ok ? (torch.out[2] && torch.out[2] !== 'no-gpu' ? torch.out[2] : null) : null,
    ultralytics: ultra.ok ? (ultra.out[0] || null) : null,
    ready: pyVer.ok && pipVer.ok && torch.ok && ultra.ok && torch.out[1] === 'true',
    verdict: !pyVer.ok ? '未找到 Python：请先安装 Python 3.9+ 并勾选加入 PATH'
      : !torch.ok ? 'PyTorch 未安装：请点「一键安装训练环境」'
      : torch.out[1] !== 'true' ? 'PyTorch 是 CPU 版（训练慢的根因）：请点「一键安装」重装 GPU 版；若本机无 NVIDIA 显卡则只能 CPU 训练或换机'
      : !ultra.ok ? 'ultralytics 未安装：请点「一键安装训练环境」'
      : '✅ 训练环境就绪（GPU 可用）',
  };
}

/** 一键安装：两条 pip 命令顺序执行（GPU 版 torch 体积大，可能 10~30 分钟），后台任务 + 日志 */
export async function autotrainEnvSetup(): Promise<{ ok: boolean; message: string }> {
  if (envJob?.running) return { ok: false, message: '环境安装已在运行中（见步骤日志）' };
  const cfg = await readCfg();
  envJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, steps: [] };
  const push = (name: string, status: EnvJob['steps'][0]['status'], log = '') => {
    envJob!.steps.push({ name, status, log });
  };
  (async () => {
    try {
      const r1 = await runStep(cfg.python, ['-m', 'pip', 'install', 'torch', 'torchvision',
        '--index-url', 'https://download.pytorch.org/whl/cu121'], AI_TRAIN_DIR, 90 * 60 * 1000);
      push('① 安装 GPU 版 PyTorch（约 2.5GB，视网速 10~30 分钟）', r1.code === 0 ? 'ok' : 'failed', r1.tail);
      if (r1.code !== 0) { envJob!.running = false; envJob!.finishedAt = new Date().toISOString(); return; }

      const r2 = await runStep(cfg.python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], AI_TRAIN_DIR, 30 * 60 * 1000);
      push('② 安装 ultralytics 等训练依赖（requirements.txt）', r2.code === 0 ? 'ok' : 'failed', r2.tail);
      if (r2.code !== 0) { envJob!.running = false; envJob!.finishedAt = new Date().toISOString(); return; }

      const chk = await autotrainEnvCheck();
      push('③ 复检：GPU 是否可用', chk.cudaAvailable ? 'ok' : 'failed',
        chk.cudaAvailable ? `GPU：${chk.gpuName}；PyTorch ${chk.torchVersion}` : `仍未检测到 GPU：${chk.verdict}`);
    } catch (e: any) {
      push('安装异常', 'failed', String(e.message || e));
    } finally {
      envJob!.running = false; envJob!.finishedAt = new Date().toISOString();
    }
  })().catch(() => { envJob!.running = false; envJob!.finishedAt = new Date().toISOString(); });
  return { ok: true, message: '环境安装已启动（后台执行，10~30 分钟，进度在本页实时刷新）' };
}

export function autotrainEnvJob(): EnvJob | null {
  return envJob;
}

/** 主流程：导出数据集 → 训练 → 导入模型库 */
export async function autotrainRun(trigger: 'schedule' | 'manual'): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: '已有自动训练在运行中' };
  const cfg = await readCfg();
  running = true;
  const today = new Date().toISOString().slice(0, 10);
  const mark = { trigger, startedAt: new Date().toISOString(), status: 'running', stage: '', log: '' };
  await setLastRun({ ...mark, date: today });
  try {
    /* ① 样本量预检：太少不值得训练（模型没变化白占 GPU） */
    stage = '样本量预检';
    await setLastRun({ stage });
    const cnt = await q(
      `SELECT count(*)::int AS n FROM ai_samples WHERE status IN ('已审核','已入库') AND image_path LIKE '/uploads/%'`);
    const total = Number(cnt[0]?.n || 0);
    if (total < cfg.minNewSamples) {
      await setLastRun({ status: 'skipped', finishedAt: new Date().toISOString(), stage: '样本量不足',
                         message: `已入库样本 ${total} 张 < 阈值 ${cfg.minNewSamples} 张，本次跳过` });
      return { ok: false, message: `样本量不足（${total}/${cfg.minNewSamples}），已跳过` };
    }

    /* ② 导出数据集（YOLO-World 自动标注 + 8:1:1 划分） */
    stage = '导出数据集';
    await setLastRun({ stage });
    const work = path.join(AI_TRAIN_DIR, '.autotrain');
    await fsp.mkdir(work, { recursive: true });
    const exp = await runStep(cfg.python,
      ['export_dataset.py', '--labeler', 'auto', '--out', path.join(work, 'dataset'), '--limit', '8000'],
      AI_TRAIN_DIR, 60 * 60 * 1000);
    if (exp.code !== 0) throw new Error(`数据集导出失败：\n${exp.tail}`);

    /* ③ GPU 训练 + ONNX 导出（train_detect.py 内部完成 export） */
    stage = 'GPU 训练（可能数小时）';
    await setLastRun({ stage });
    const runName = `auto-${today}`;
    const train = await runStep(cfg.python,
      ['train_detect.py', '--data', path.join(work, 'dataset', 'data.yaml'), '--model', cfg.model,
       '--epochs', String(cfg.epochs), '--device', cfg.device, '--name', runName],
      AI_TRAIN_DIR, 6 * 60 * 60 * 1000);
    if (train.code !== 0) throw new Error(`训练失败：\n${train.tail}`);

    /* ④ 定位产物 best.onnx（ultralytics 默认 runs/detect/<name>/weights/best.onnx，cwd=ai-train） */
    stage = '导入模型库';
    await setLastRun({ stage });
    const onnxPath = path.join(AI_TRAIN_DIR, 'runs', 'detect', runName, 'weights', 'best.onnx');
    let buf: Buffer;
    try { buf = await fsp.readFile(onnxPath); } catch {
      throw new Error(`未找到训练产物 ${onnxPath}（检查 train_detect.py 输出目录）`);
    }
    await fsp.mkdir(MODELS_DIR, { recursive: true });
    const ver = await q(`SELECT COALESCE(MAX(version),0)+1 AS v FROM ai_models WHERE name='autotrain'`);
    const vN = Number(ver[0].v);
    const file = `autotrain-v${vN}.onnx`;
    await fsp.writeFile(path.join(MODELS_DIR, file), buf);
    const ins = await q(
      `INSERT INTO ai_models (store_id, name, task, version, file_path, base_model, metrics, is_active, deployed_at, remark)
       VALUES (NULL,'autotrain','detect',$1,$2,$3,$4,$5,CASE WHEN $5 THEN now() ELSE NULL END,$6) RETURNING id`,
      [vN, file, cfg.model,
       JSON.stringify({ mode: 'detect', auto: true, classes: { '0': { name: '商品' } }, trigger }),
       !!cfg.autoActivate,
       `自动训练 ${today}（样本 ${total} 张）`]);
    const modelId = Number(ins[0].id);
    if (cfg.autoActivate) {
      await q(`UPDATE ai_models SET is_active=false WHERE id <> $1`, [modelId]);
      try { const { clearSessionCache } = await import('./ai.detect'); clearSessionCache(); } catch { /* 忽略 */ }
      // 自动激活时顺带把多件定位切到新模型（收银重启会话缓存后生效，无需重启进程）
      await q(
        `INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
         VALUES ('AI赋能','ai.seg.model_id','多件定位模型',$1::text,'0','number','多件识别定位模型')
         ON CONFLICT (setting_key) DO UPDATE SET value=$1::text`,
        [String(modelId)]);
    }
    await audit(0, 0, 'AI', 'ai.autotrain.finish', 'ai_model', modelId, { version: vN, samples: total, trigger });

    stage = '完成';
    await setLastRun({ status: 'ok', finishedAt: new Date().toISOString(), stage, modelId, version: vN, samples: total,
                       activated: !!cfg.autoActivate, log: train.tail.slice(-1500) });
    return { ok: true, message: `训练完成：autotrain v${vN} 已导入${cfg.autoActivate ? '并激活' : '（待训练台确认激活）'}` };
  } catch (e: any) {
    await setLastRun({ status: 'failed', finishedAt: new Date().toISOString(), stage, message: String(e.message || e).slice(0, 1500) });
    return { ok: false, message: `自动训练失败（${stage}）：${String(e.message || e).slice(0, 300)}` };
  } finally {
    running = false;
    stage = '';
  }
}

/** 调度 tick（每 10 分钟）：到点且当天未跑过 → 触发。异常吞掉，绝不影响收银主链路。 */
let lastTickDate = '';
export const autotrainBusy = (): boolean => running;
export async function autotrainTick(): Promise<void> {
  try {
    const cfg = await readCfg();
    if (!cfg.enabled || running) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getDay() !== cfg.dayOfWeek || now.getHours() !== cfg.hour || lastTickDate === today) return;
    lastTickDate = today;
    const st = await autotrainStatus();
    if (st.lastRun?.date === today && st.lastRun?.status !== 'failed') return;   // 当天已跑过（失败可重试一次）
    autotrainRun('schedule').catch(() => {});
  } catch { /* 调度异常静默 */ }
}
