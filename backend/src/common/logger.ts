import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * 统一运行日志出口（Q-07 备案项 #8 Log Adapter）。
 * 约定：运行日志只经本模块输出——logInfo/logWarn 走 console，logError 额外独占追加写
 * backend/logs/error.log（唯一写入口，避免多实现漂移）。业务审计仍走 audit()（DB），与此无关。
 * 新增代码请用 logger；存量 console.* 调用点渐进迁移，不要求一次性替换。
 */
const LOG_DIR = join(__dirname, '..', '..', 'logs');
const ERROR_LOG = join(LOG_DIR, 'error.log');

const fmt = (v: unknown): string => {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

export function logInfo(tag: string, ...args: unknown[]): void {
  console.log(`[${tag}]`, ...args);
}

export function logWarn(tag: string, ...args: unknown[]): void {
  console.warn(`[${tag}]`, ...args);
}

export function logError(tag: string, detail: unknown, err?: unknown): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${fmt(detail)}${err !== undefined ? ` | ${fmt(err)}` : ''}\n`;
  console.error(line.trimEnd());
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(ERROR_LOG, line);
  } catch { /* 日志写失败不影响主流程 */ }
}
