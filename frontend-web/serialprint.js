/**
 * 浏览器 WebSerial 串口直发（V4.15.7 P2/P3 共用）：
 *   标签机/小票机为「串口」连接方式时，后端返回 base64 指令字节，由桌面 Chrome/Edge 通过串口写出。
 *   requestPort 必须在用户点击手势内调用；授权记忆由浏览器管理（同一设备二次免弹窗）。
 */

/** 串口发送 base64 指令字节；成功返回 true。波特率默认 115200（热敏标签机常用） */
export async function serialSendBase64(b64, baudRate = 115200) {
  if (!navigator.serial) throw new Error('当前浏览器不支持 WebSerial（请用电脑 Chrome/Edge）');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  const writer = port.writable.getWriter();
  try {
    await writer.write(bytes);
    // 稍作等待让打印机走完走纸，避免立刻 close 截断
    await new Promise(r => setTimeout(r, 400));
  } finally {
    writer.releaseLock();
    try { await port.close(); } catch { /* noop */ }
  }
  return true;
}
