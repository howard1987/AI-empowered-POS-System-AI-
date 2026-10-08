/**
 * 预加载桥（contextIsolation 安全暴露）：渲染层只见到 window.cashier API
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cashier', {
  // 双屏
  syncToSecond: payload => ipcRenderer.send('pos:sync', payload),
  onSync: fn => ipcRenderer.on('pos:sync', (_e, p) => fn(p)),
  // 显示器状态（自动识别单/双屏）
  displays: () => ipcRenderer.invoke('pos:displays'),
  // 程序退出（登录屏「关闭程序」）
  quitApp: () => ipcRenderer.send('pos:quit'),
  // 外设
  peripherals: () => ipcRenderer.invoke('pos:peripherals'),
  scanFeed: code => ipcRenderer.send('pos:scan-feed', code),
  scaleFeed: kg => ipcRenderer.send('pos:scale-feed', kg),
  onScan: fn => ipcRenderer.on('pos:scan', (_e, code) => fn(code)),
  // 打印
  printReceipt: (order, widthMm) => ipcRenderer.invoke('pos:print-receipt', { order, widthMm }),
  printA5: (doc, fields) => ipcRenderer.invoke('pos:print-a5', { doc, fields }),
  printerConnect: opts => ipcRenderer.invoke('pos:printer-connect', opts),
  printerDisconnect: () => ipcRenderer.invoke('pos:printer-disconnect'),
});

// V4.20.0 P16：EXE 壳标记 + 通用 HTML 静默打印（PWA receipt.js/cashier.js 检测此入口，真静默无预览）
// V4.21.0 P16 批2：快捷键自定义（PWA 设置保存后按映射重新注册全局键）
// V4.22.1：首次配置向导 / 断连错误页（setup.html、neterr.html 经同一 preload 使用）
contextBridge.exposeInMainWorld('DesktopShell', {
  isDesktop: true,
  // V5.0.18g：硬件稳定标识（Windows MachineGuid，卸载重装 EXE 不变）→ 渲染层 deviceCode() 派生 HW- 设备码
  machineGuid: () => ipcRenderer.invoke('pos:machine-guid'),
  silentPrintHtml: (html, opts = {}) => ipcRenderer.invoke('pos:print-html', { html, widthMm: opts.widthMm }),
  registerHotkeys: keys => ipcRenderer.invoke('pos:hotkeys-register', keys),
  // V4.22.2：桌面端「关闭程序」按钮（登录页/退出收银台后使用；kiosk 下唯一正规退出通道）
  quitApp: () => ipcRenderer.send('pos:quit'),
  // V4.22.3：窗口形态切换（'cashier' 全屏铺满不置顶 / 'login' 卡片小窗）——登录成功、退出登录时调用
  setShellMode: mode => ipcRenderer.send('pos:shell-mode', mode === 'cashier' ? 'cashier' : 'login'),
  shellState: () => ipcRenderer.invoke('pos:shell-state'),   // 窗口状态自检（现场排查/自动化实测）
  // V4.24.0 ⑤：登录页标题栏窗口按钮（最小化 / 最大化 / 关闭）
  winMinimize: () => ipcRenderer.send('pos:win-minimize'),
  winMaximize: () => ipcRenderer.send('pos:win-maximize'),
  winClose: () => ipcRenderer.send('pos:win-close'),
  // V4.24.0 ⑦：强 Kiosk 置顶（后台 pos.desktop.kiosk_topmost → 渲染层读回传，立即生效）
  setKioskTopmost: on => ipcRenderer.send('pos:kiosk-topmost', !!on),
  // 配置向导与错误页
  desktopInfo: () => ipcRenderer.invoke('pos:desktop-info'),
  testServer: url => ipcRenderer.invoke('pos:desktop-test-server', url),
  saveServer: url => ipcRenderer.invoke('pos:desktop-save-server', url),
  applyAndStart: () => ipcRenderer.send('pos:desktop-apply'),
  retryConnect: () => ipcRenderer.send('pos:desktop-retry'),
  openSetup: () => ipcRenderer.send('pos:desktop-open-setup'),
});
