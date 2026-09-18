/**
 * Electron 主进程（收银端 T16 壳 + 双屏/kiosk/AI 改造）：
 *   1) 主屏：登录前 = 卡片大小普通窗口（不置顶/可切换）；登录后 = 全屏铺满（盖任务栏、不置顶、防误退出）
 *      —— V4.22.3：全屏但**不做 alwaysOnTop**，Alt+Tab / 任务栏切换其他程序照常可用
 *   2) 双屏：自动识别显示器数量（screen.getAllDisplays），>1 台时在副显示器开顾客信任屏（全屏）
 *   3) 双屏同步：主屏 IPC pos:sync 推送购物车明细/金额/支付状态 → 副屏渲染
 *   4) 打印：小票走外设适配器（ESC/POS），A5 单据走隐藏窗口 silent print
 *   5) 外设：扫码枪/电子秤/小票机三件套（降级模拟，见 peripherals/index.js）
 *   6) AI 识别：放行摄像头权限（渲染层 getUserMedia 拍照 → POST /ai/recognize 免扫码直识预包装）
 *
 * 开发调试：POS_KIOSK=0 npm start 以窗口模式启动（生产默认全屏 kiosk）
 */
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');

// 店内收银机兼容加固（V4.8.18）：低端显卡/驱动旧时 GPU 进程易崩 → 软件渲染；
// P1-H9：渲染进程沙箱默认开启；仅老驱动兼容机经 POS_LEGACY_GPU=1 显式回退 no-sandbox
app.disableHardwareAcceleration();
if (process.env.POS_LEGACY_GPU === '1') app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-compositing');
// V4.24.1：收款/告警播报无需用户手势（收银场景扫码后无人点击也要出声；服务端 WAV 与本机 TTS 同受益）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('path');
const { Scanner, Scale, ReceiptPrinter, hasSerial } = require('./peripherals');

// ─── kiosk 开关：生产默认全屏；开发调试设 POS_KIOSK=0 回窗口模式 ───
const KIKS = process.env.POS_KIOSK !== '0';

// ─── V4.20.0 P16：EXE 部署形态收口 ───
//  1) 新收银台模式：加载后端 PWA 收银台（desktop-config.json 可配 ui/server；ui:'pwa' 生效，默认沿用本机旧 UI）
//  2) 全局快捷键：F2/F4/F6/F7/F8/F9 → 转发按键到主屏页面（浏览器收银台同键位，EXE 内全局生效）
//  3) 静默打印通道：pos:print-html（隐藏窗口 webContents.print silent，真静默无预览弹窗）
function loadDesktopConfig() {
  const def = { ui: 'pwa', server: 'http://127.0.0.1:3100' };
  try {
    const fs = require('fs');
    const p = path.join(app.getPath('userData'), 'desktop-config.json');
    if (fs.existsSync(p)) return { ...def, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch { /* 配置损坏用默认 */ }
  if (process.env.POS_UI) def.ui = process.env.POS_UI;
  if (process.env.POS_SERVER) def.server = process.env.POS_SERVER;
  return def;
}
const DESKTOP_CFG = loadDesktopConfig();

// ─── V4.22.1 EXE 白屏根治：启动前置探活 + 首次配置向导 + 断连错误页 ───
//  旧缺陷：服务器不可达时 loadURL 静默失败 → kiosk 全屏只剩底色（用户报障"打开就是一片白"）
//  新逻辑：
//   a) 首次启动（无 desktop-config.json 且未设 POS_SERVER）→ 先弹「服务器地址配置」向导
//   b) 已配置 → 主进程先探 {server}/health，通过才进收银台；探活失败/加载失败 → 本地错误页（重试/改地址/退出），绝不再白屏
const fs = require('fs');
let lastNetError = null;   // { server, reason, at } 供错误页展示
const cfgFilePath = () => path.join(app.getPath('userData'), 'desktop-config.json');
const hasConfigFile = () => { try { return fs.existsSync(cfgFilePath()); } catch { return false; } };
function saveConfigFile(server) {
  const cfg = { ui: 'pwa', server: normalizeServer(server) };
  fs.writeFileSync(cfgFilePath(), JSON.stringify(cfg, null, 2), 'utf8');
  DESKTOP_CFG.ui = cfg.ui; DESKTOP_CFG.server = cfg.server;
}
function normalizeServer(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}
/** 主进程探活（绕开渲染层 CORS）：GET {server}/health，3s 超时 */
function probeServer(server) {
  return new Promise(resolve => {
    let done = false;
    const fin = r => { if (!done) { done = true; resolve(r); } };
    try {
      const url = normalizeServer(server) + '/health';
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.get(url, { timeout: 3000 }, res => { res.resume(); fin({ ok: res.statusCode > 0 && res.statusCode < 500, status: res.statusCode }); });
      req.on('timeout', () => { req.destroy(); fin({ ok: false, error: '连接超时（3 秒无响应）' }); });
      req.on('error', e => fin({ ok: false, error: e.message || String(e) }));
    } catch (e) { fin({ ok: false, error: e.message || String(e) }); }
    setTimeout(() => fin({ ok: false, error: '连接超时' }), 5000);
  });
}
/** 首次配置向导（普通小窗口，非 kiosk） */
let setupWindow = null;
function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.focus(); return; }
  // V4.22.3：向导是普通窗口，收银台处于全屏时会把它压住 → 先切回登录态（小窗/不置顶/不拦关闭），关闭后按原形态恢复
  const prevMode = shellMode;
  if (mainWindow && !mainWindow.isDestroyed()) applyLoginMode(mainWindow);
  setupWindow = new BrowserWindow({
    width: 560, height: 520, resizable: false, autoHideMenuBar: true, title: '收银端 · 服务器配置',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  setupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (prevMode === 'cashier') applyCashierMode(mainWindow); else applyLoginMode(mainWindow);
  });
}
/** 主窗口显示断连错误页（本地文件，不依赖服务器） */
function showNetError(server, reason) {
  lastNetError = { server: normalizeServer(server), reason: String(reason || '连接失败'), at: new Date().toLocaleString('zh-CN') };
  if (mainWindow && !mainWindow.isDestroyed()) {
    // V4.22.3：错误页也用普通窗口（不铺满、不置顶）→ 老板可先去排查网络，再回来重试
    applyWindowedMode(mainWindow, 720, 560);
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'neterr.html')).catch(() => {});
  }
}
/** 启动收银台：探活 → 建窗/加载；失败落错误页 */
async function startCashier() {
  const srv = normalizeServer(DESKTOP_CFG.server);
  const probe = DESKTOP_CFG.ui === 'pwa' ? await probeServer(srv) : { ok: true };   // 旧本机 UI 不依赖服务器
  if (!mainWindow || mainWindow.isDestroyed()) { createWindows(); registerHotkeys(); }
  if (!probe.ok) showNetError(srv, probe.error || ('HTTP ' + probe.status));
}

let mainWindow = null;
let secondWindow = null;
let printWindow = null;
let quitting = false;
const scanner = new Scanner();
const scale = new Scale();
const printer = new ReceiptPrinter();

// ─── 单实例锁（V4.8.21）：杜绝多开导致的进程占用与安装冲突 ───
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/** V4.22.2 全屏加固：kiosk 单开关（不再与 fullscreen 并用，二者叠加时 Win11 会露出任务栏）
 *  + 按显示器 bounds 精确占位 + 脱离全屏自动回位 + 分辨率/缩放变化后重新占位（外接屏热插拔）
 *  V4.22.3：去掉 alwaysOnTop——用户要求「全屏但允许切换其他程序」；
 *           任务栏遮挡由 kiosk（Chromium 全屏，Windows 会自动隐藏任务栏）+ 铺满 bounds 保证。 */
function applyKiosk(win, display) {
  if (!KIKS || !win || win.isDestroyed()) return;
  const d = display || screen.getPrimaryDisplay();
  try { win.setBounds(d.bounds); } catch { /* noop */ }
  try { win.setKiosk(true); } catch { /* noop */ }
  // V4.24.0 ⑦：置顶与否由后台开关决定——默认关（全屏但可用 Alt+Tab 切走）；
  //   开=screen-saver 级强制置顶（压过 Win11 置顶任务栏，Alt+Tab 也切不走，适合顾客可触碰的收银机）
  try { win.setAlwaysOnTop(!!kioskTopmost, kioskTopmost ? 'screen-saver' : 'normal'); } catch { /* noop */ }
  if (!win.__kioskBound) {
    win.__kioskBound = true;
    // 任何原因脱离全屏（如系统手势/远程桌面切换）→ 立即回位
    win.on('leave-full-screen', () => {
      if (KIKS && !quitting && !win.isDestroyed() && shellMode === 'cashier') { try { win.setKiosk(true); } catch { /* noop */ } }
    });
  }
}

// ─── V4.22.3：窗口形态随「登录 / 收银」切换 ───
//  用户反馈：① 登录界面铺满整屏、还置顶最前，想去处理别的程序都切不走；
//            ② 收银台要全屏（盖任务栏）但必须能用 Alt+Tab / 任务栏切到别的程序。
//  规则：登录前 = 一张卡片大小的普通窗口（居中、不置顶、任务栏有图标、可 Alt+F4 关）；
//        登录后 = 全屏 kiosk（盖任务栏）+ **不置顶** → 切换其他程序不受影响。
//  渲染层在登录成功/退出登录时经 pos:shell-mode 通知主进程切换。
const LOGIN_WIN = { width: 480, height: 680 };   // V4.24.0：登录窗加高（标题栏 + 卡片 + 底部圆入口）
let shellMode = 'login';
let kioskOn = false;
let kioskTopmost = false;    // V4.24.0：后台 pos.desktop.kiosk_topmost —— 开=全屏强制置顶（不可切走）

/** 普通窗口形态（登录页 / 断连错误页共用）：不 kiosk、不置顶、任务栏可见、可缩放 */
function applyWindowedMode(win, w, h) {
  const wasKiosk = kioskOn;
  shellMode = 'login'; kioskOn = false;
  if (!win || win.isDestroyed()) return;
  try { win.setAlwaysOnTop(false); } catch { /* noop */ }
  try { win.setSkipTaskbar(false); } catch { /* noop */ }
  try { win.setResizable(true); } catch { /* noop */ }
  const place = () => {
    if (win.isDestroyed()) return;
    try {
      const a = screen.getPrimaryDisplay().workArea || screen.getPrimaryDisplay().bounds;
      const W = Math.min(w, a.width), H = Math.min(h, a.height);
      win.setBounds({ x: Math.round(a.x + (a.width - W) / 2), y: Math.round(a.y + (a.height - H) / 2), width: W, height: H });
    } catch { /* noop */ }
  };
  if (!wasKiosk) { place(); return; }
  // 退出全屏是异步的（setKiosk(false) 立即返回、真正退全屏在下一帧）：
  // 直接摆位会被随后的全屏恢复覆盖 → 实测「退出收银台后登录页仍是全屏」。等 leave-full-screen 再摆 + 兜底重摆。
  let done = false;
  const settle = () => { if (done) return; done = true; place(); };
  try { win.setKiosk(false); } catch { /* noop */ }
  try { win.setFullScreen(false); } catch { /* noop */ }
  try { win.once('leave-full-screen', settle); } catch { /* noop */ }
  setTimeout(settle, 400);
  setTimeout(place, 1000);
}

/** 登录态：卡片大小窗口、居中、不置顶、任务栏可见 */
function applyLoginMode(win) {
  applyWindowedMode(win, LOGIN_WIN.width, LOGIN_WIN.height);
}

/** 收银态：全屏铺满（盖任务栏）、不置顶 */
function applyCashierMode(win) {
  shellMode = 'cashier';
  if (!win || win.isDestroyed()) return;
  if (!KIKS) {                      // 开发调试（POS_KIOSK=0）：不强制全屏
    try { win.setKiosk(false); } catch { /* noop */ }
    kioskOn = false;
    return;
  }
  applyKiosk(win, screen.getPrimaryDisplay());
  try { win.setSkipTaskbar(true); } catch { /* noop */ }
  kioskOn = true;
}

function createWindows() {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  const base = {
    frame: false, autoHideMenuBar: true, skipTaskbar: true,
    resizable: false, maximizable: false, minimizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  };

  // 主屏：启动即「登录态」小窗（卡片大小、居中、不置顶）；登录成功后渲染层切全屏收银态
  mainWindow = new BrowserWindow({
    ...base,
    backgroundColor: '#f5f2ea',
    width: LOGIN_WIN.width, height: LOGIN_WIN.height, center: true,
  });
  applyLoginMode(mainWindow);
  mainWindow.once('ready-to-show', () => { if (shellMode === 'login') applyLoginMode(mainWindow); });
  // V4.20.0 P16：ui='pwa' → 加载后端 PWA 新收银台（?desktop=1 标记供页面识别 EXE 壳）；否则沿用本机旧 UI
  if (DESKTOP_CFG.ui === 'pwa') {
    mainWindow.loadURL(String(DESKTOP_CFG.server).replace(/\/$/, '') + '/pwa/?desktop=1');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  // 收银态才拦关闭手势/Alt+F4（防顾客误触）；登录态小窗允许正常关闭；程序内 pos:quit → app.quit()
  mainWindow.on('close', e => { if (kioskOn && !quitting) e.preventDefault(); });
  // V4.22.1：加载失败（服务器没开/地址错）→ 本地错误页，绝不白屏
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    showNetError(DESKTOP_CFG.server, desc + '（code ' + code + '）');
  });

  // 副屏：顾客信任屏 —— 仅检测到第二台显示器时创建，附着在副显示器全屏
  const second = displays.length > 1 ? displays.find(d => d.id !== primary.id) : null;
  if (second) {
    secondWindow = new BrowserWindow({
      ...base,
      backgroundColor: '#10231a',
      x: second.bounds.x, y: second.bounds.y,
      width: second.bounds.width, height: second.bounds.height,
    });
    // V4.21.0 P16 批2：新收银台模式 → 副屏加载后端客显页（SSE 实时同步：明细/支付引导/轮播/会员卡）；旧 UI 沿用本机 second.html
    if (DESKTOP_CFG.ui === 'pwa') {
      secondWindow.loadURL(String(DESKTOP_CFG.server).replace(/\/$/, '') + '/display/?v=20260914c').catch(() => {});
    } else {
      secondWindow.loadFile(path.join(__dirname, '..', 'renderer', 'second.html')).catch(() => {});
    }
    applyKiosk(secondWindow, second);   // V4.22.2：副屏同样 kiosk 占满（不再靠 fullscreen 选项）
  }
}

/** 隐藏打印窗口（A5 silent print） */
function ensurePrintWindow() {
  if (printWindow && !printWindow.isDestroyed()) return printWindow;
  printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  return printWindow;
}

app.whenReady().then(() => {
  // AI 识别：仅放行摄像头/麦克风权限（其余默认拒绝，避免网页类权限弹窗）
  // V4.18.6：放行 usb——渲染层 WebUSB 直驱 USB 小票机（与 PWA 同链路）
  // V4.20.0 P16：放行 serial——PWA 钱箱/串口小票机（WebSerial）在 EXE 内同样可用
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'usb', 'serial'].includes(permission)));
  // kiosk 无设备选择弹窗：WebUSB 自动选中首个设备并持久化授权
  session.defaultSession.setDevicePermissionHandler(details => details.deviceType === 'usb');
  session.defaultSession.on('select-usb-device', (_event, devices, callback) => {
    callback(devices && devices.length ? devices[0].deviceId : '');
  });
  // V4.22.1：首次启动先弹服务器配置向导（无配置文件且未设 POS_SERVER）；否则探活后进收银台
  if (DESKTOP_CFG.ui === 'pwa' && !hasConfigFile() && !process.env.POS_SERVER) openSetup();
  else startCashier();
  // V4.22.2：显示器分辨率/缩放变化（热插拔外接屏、投屏切换）后重新占位，防任务栏露出
  try {
    screen.on('display-metrics-changed', () => {
      if (shellMode === 'cashier') applyKiosk(mainWindow, screen.getPrimaryDisplay());
      if (secondWindow && !secondWindow.isDestroyed()) {
        const ds = screen.getAllDisplays();
        const s2 = ds.find(d => d.id !== screen.getPrimaryDisplay().id);
        if (s2) applyKiosk(secondWindow, s2);
      }
    });
  } catch { /* noop */ }
});

// ─── V4.22.3：渲染层通知窗口形态（登录页 = 小窗不置顶；收银台 = 全屏盖任务栏但不置顶） ───
ipcMain.on('pos:shell-mode', (_e, mode) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mode === 'cashier') applyCashierMode(mainWindow);
  else applyLoginMode(mainWindow);
});
// 窗口状态自检（现场排查「登录页还是全屏 / 窗口被压住」类问题；也供自动化实测断言）
ipcMain.handle('pos:shell-state', () => {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return {
    shellMode, kioskOn, kioskTopmost,
    isKiosk: !!(w && typeof w.isKiosk === 'function' && w.isKiosk()),
    isFullScreen: !!(w && w.isFullScreen()),
    isMaximized: !!(w && typeof w.isMaximized === 'function' && w.isMaximized()),
    isAlwaysOnTop: !!(w && typeof w.isAlwaysOnTop === 'function' && w.isAlwaysOnTop()),
    bounds: w ? w.getBounds() : null,
    resizable: w ? w.isResizable() : null,
    skipTaskbar: w ? (typeof w.isSkipTaskbar === 'function' ? w.isSkipTaskbar() : null) : null,
    display: screen.getPrimaryDisplay().bounds,
    workArea: screen.getPrimaryDisplay().workArea,
  };
});

// ─── V4.24.0 ⑤：登录页标题栏窗口按钮（最小化 / 最大化 / 关闭，替代原「关闭程序」按钮）───
ipcMain.on('pos:win-minimize', () => {
  const w = mainWindow;
  if (w && !w.isDestroyed()) { try { w.minimize(); } catch { /* noop */ } }
});
ipcMain.on('pos:win-maximize', () => {
  const w = mainWindow;
  if (!w || w.isDestroyed() || kioskOn) return;   // 收银态已全屏铺满，最大化无意义
  try { w.isMaximized() ? w.unmaximize() : w.maximize(); } catch { /* noop */ }
});
ipcMain.on('pos:win-close', () => { quitting = true; app.quit(); });

// ─── V4.24.0 ⑦：强 Kiosk 置顶开关（渲染层读到 pos.desktop.kiosk_topmost 后回传，立即生效）───
ipcMain.on('pos:kiosk-topmost', (_e, on) => {
  kioskTopmost = !!on;
  if (kioskOn && mainWindow && !mainWindow.isDestroyed()) applyCashierMode(mainWindow);
});

// ─── V4.22.1：配置向导 / 错误页 IPC ───
ipcMain.handle('pos:desktop-info', () => ({
  server: normalizeServer(DESKTOP_CFG.server), configPath: cfgFilePath(),
  hasConfigFile: hasConfigFile(), lastError: lastNetError, version: app.getVersion(),
}));
ipcMain.handle('pos:desktop-test-server', (_e, url) => probeServer(url));
ipcMain.handle('pos:desktop-save-server', (_e, url) => {
  const srv = normalizeServer(url);
  if (!/^https?:\/\/[^\s/:]+(:\d+)?$/.test(srv)) return { ok: false, error: '地址格式不对：应形如 http://192.168.0.6:3100' };
  saveConfigFile(srv);
  return { ok: true, server: srv };
});
ipcMain.on('pos:desktop-apply', () => {   // 配置页「保存并启动」
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  startCashier();
});
ipcMain.on('pos:desktop-retry', () => {   // 错误页「重试连接」：探活通过才进收银台，失败留在错误页并刷新原因
  const srv = normalizeServer(DESKTOP_CFG.server);
  probeServer(srv).then(p => {
    if (p.ok) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        applyLoginMode(mainWindow);   // V4.22.3：错误页是 720×560，回到页面后收成登录小窗（登录成功再进全屏收银）
        mainWindow.loadURL(srv + '/pwa/?desktop=1').catch(() => {});
      } else startCashier();
    } else {
      showNetError(srv, p.error || ('HTTP ' + p.status));
    }
  });
});
ipcMain.on('pos:desktop-open-setup', () => openSetup());   // 错误页「修改服务器地址」

// ─── V4.20.0 P16：全局快捷键（EXE 内全局生效，转发到主屏页面——浏览器收银台同键位） ───
const HOTKEYS = ['F2', 'F4', 'F6', 'F7', 'F8', 'F9'];
function registerHotkeys() {
  const { globalShortcut } = require('electron');
  for (const key of HOTKEYS) {
    try {
      globalShortcut.register(key, () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      });
    } catch { /* 注册失败不影响启动 */ }
  }
}
function unregisterHotkeys() {
  try { require('electron').globalShortcut.unregisterAll(); } catch { /* noop */ }
}
// ─── V4.21.0 P16 批2：快捷键自定义（PWA 设置保存后经 DesktopShell.registerHotkeys 重新注册全局键） ───
ipcMain.handle('pos:hotkeys-register', (_e, keys) => {
  const { globalShortcut } = require('electron');
  try { globalShortcut.unregisterAll(); } catch { /* noop */ }
  const list = (Array.isArray(keys) ? keys : [])
    .map(String)
    .filter(k => /^(F([1-9]|1[0-2])|[A-Z])$/.test(k));
  for (const key of list) {
    try {
      globalShortcut.register(key, () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      });
    } catch { /* 单键被系统占用不阻断其余键 */ }
  }
  return { ok: true, registered: list };
});
app.on('will-quit', unregisterHotkeys);
app.on('before-quit', () => { quitting = true; printer.disconnect(); });
app.on('window-all-closed', () => app.quit());

// ─── IPC：双屏同步（购物车明细/金额/支付状态 → 顾客信任屏） ───
ipcMain.on('pos:sync', (_e, payload) => {
  if (secondWindow && !secondWindow.isDestroyed()) {
    secondWindow.webContents.send('pos:sync', payload);
  }
});

// ─── IPC：显示器状态（渲染层据此显示 单屏/双屏 标识） ───
ipcMain.handle('pos:displays', () => {
  const ds = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return {
    count: ds.length,
    secondActive: !!(secondWindow && !secondWindow.isDestroyed()),
    primary: { x: primary.bounds.x, y: primary.bounds.y, width: primary.bounds.width, height: primary.bounds.height },
    scaleFactor: primary.scaleFactor || 1,
  };
});

// ─── IPC：程序退出（登录屏「关闭程序」调用，绕过 kiosk 关闭拦截） ───
ipcMain.on('pos:quit', () => app.quit());

// ─── IPC：外设状态与事件 ───
ipcMain.handle('pos:peripherals', () => ({
  serialport: hasSerial, scanner: scanner.describe(), scale: scale.describe(), printer: printer.describe(),
}));
ipcMain.on('pos:scan-feed', (_e, code) => scanner.feed(code));       // keyboard 模式由渲染层喂入
ipcMain.on('pos:scale-feed', (_e, kg) => scale.feedMock(kg));
ipcMain.on('pos:scanner-event', (_e, code) => mainWindow.webContents.send('pos:scan', code));

// ─── IPC：小票打印（58/80） ───
ipcMain.handle('pos:print-receipt', async (_e, { order, widthMm }) => {
  const { renderReceipt } = require('./print/templates');
  const text = renderReceipt(order, widthMm || 80);
  if (!printer.describe().connected) {
    return { ok: false, reason: '小票机未连接', preview: text }; // 预览模式：测试页可直接看版面
  }
  return printer.print(text);
});

// ─── IPC：小票机连接（三种方式） ───
ipcMain.handle('pos:printer-connect', async (_e, { mode, host, port, path, baudRate }) => {
  if (mode === 'net') return printer.connectNet(host, port || 9100);
  if (mode === 'usb' || mode === 'bluetooth') return printer.connectSerial(path, baudRate || 9600);
  return { ok: false, reason: '未知连接方式' };
});
ipcMain.handle('pos:printer-disconnect', () => { printer.disconnect(); return { ok: true }; });

// ─── IPC：A5 单据 silent print（字段可配模板） ───
ipcMain.handle('pos:print-a5', async (_e, { doc, fields }) => {
  const { renderA5Html } = require('./print/templates');
  const w = ensurePrintWindow();
  const html = renderA5Html(doc, fields);
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return new Promise(resolve => {
    w.webContents.print(
      { silent: true, printBackground: true, margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } },
      (success, reason) => resolve({ ok: success, reason }));
  });
});

// ─── IPC：V4.20.0 P16 通用 HTML 静默打印（PWA 小票/交接单/日报共用；隐藏窗口 silent，无预览弹窗） ───
ipcMain.handle('pos:print-html', async (_e, { html, widthMm }) => {
  const w = ensurePrintWindow();
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(html || '')));
  const wmm = Number(widthMm) || 80;
  const margin = wmm <= 58 ? 0.12 : 0.16;   // 热敏小票窄边距（英寸）
  return new Promise(resolve => {
    w.webContents.print(
      { silent: true, printBackground: true,
        margins: { marginType: 'custom', top: margin, bottom: margin, left: margin, right: margin },
        pageSize: { width: wmm * 1000, height: 297 * 1000 } },   // 微米：80mm→80000
      (success, reason) => resolve({ ok: success, reason }));
  });
});
