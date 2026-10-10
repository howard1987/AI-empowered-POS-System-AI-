/**
 * V5.0.19i（Q-07 低危卫生）：超时/延迟魔法数命名常量。
 * 数值与原散落字面量逐一相等，仅命名不改变任何行为；新增代码请引用常量而非字面量。
 */
export const DEVICE_PROBE_TIMEOUT_MS = 6000;      // 局域网 socket 探测/握手超时（device.module 打印机/钱箱探测等）
export const HQ_HTTP_TIMEOUT_MS = Number(process.env.HQ_HTTP_TIMEOUT_MS || 5000); // L-04：8s→5s（结账持锁事务内跨网调用，超时越短锁持有越短；连锁离线挂账兜底承接超时失败）
export const EXTERNAL_API_TIMEOUT_MS = 8000;      // 外部第三方 HTTP API 常规档（天气/节假日/bing 标题）
export const EXTERNAL_API_FAST_TIMEOUT_MS = 6000; // 外部第三方 HTTP API 快速失败档（条码在线库多源串行，单源不能久等）
export const TTS_PREHEAT_DELAY_MS = 3000;         // 服务启动后 TTS 常驻进程预热延迟
