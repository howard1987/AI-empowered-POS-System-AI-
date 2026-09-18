# 社区超市收银系统 · 部署总说明

本文件说明 `release/` 产物的构成与部署方式。**四端解耦**：服务端先起，其余三端连上它即可用。

---

## 一、产物构成

```
release/
├─ server/            ① 服务端独立包（内置便携 PostgreSQL，双击即跑）
│  ├─ 管理后台       → http://<服务器IP>:3100/admin/
│  ├─ 收银台(PWA)    → http://<服务器IP>:3100/pwa/
│  ├─ 老板端/会员H5/客显 → /boss/  /member/  /display/
│  └─ start-server.bat / stop-server.bat / README-SERVER.md
├─ pos-desktop/       ② 收银台桌面端安装包（Electron）
│  ├─ 超市收银系统-<版本>-win-x64-setup.exe      安装版
│  └─ 超市收银系统-<版本>-x64-portable.exe       绿色版
├─ build-all.ps1      一键构建脚本（源码侧 deploy/build-all.ps1 的副本）
└─ README_DEPLOY.md   本文件
```

产物由一条命令生成（在源码项目内执行）：

```powershell
.\deploy\build-all.ps1              # 全量：清理 → 编译 → 装配 → 打包 Win11 EXE → 冒烟
.\deploy\build-all.ps1 -SkipExe     # 只出服务端包（最快）
.\deploy\build-all.ps1 -Win7        # 追加 Win7(ia32) 轨 EXE（定稿后再用）
```

脚本只动**构建/配置/部署产物**，不改任何业务逻辑。

---

## 二、四端形态与部署方式

| # | 端 | 形态 | 部署方式 | 访问地址 |
|---|---|---|---|---|
| ① | 服务端 | Node + NestJS + 内置 PostgreSQL | 拷 `server/` 到服务器，双击 `start-server.bat` | 见上 |
| ② | 管理后台 | 静态页（24 屏，零构建） | **随服务端包发布**，由服务端同源托管 | `…:3100/admin/` |
| ③ | 收银 Web（PWA） | 静态 PWA（Service Worker） | **随服务端包发布** | `…:3100/pwa/` |
| ④ | 收银桌面端 | Electron 双轨 EXE | 收银机安装 exe | 首启填写服务器地址 |

**关键设计**
- ②③ 直接挂在服务端 `/admin`、`/pwa` 子路径 → **同源，无跨域，无额外部署**。
- 后台 API 地址不再硬编码：优先 `localStorage.api_base`（登录页可改）→ 再 `window.__API_BASE__`（独立端口部署时注入）→ 最后 `window.location.origin`（同源自动）。
- ④ 的服务器地址由**首次启动向导**写入 `%APPDATA%\超市收银系统\desktop-config.json`，可在向导里「测试连接」；服务器换 IP 只需改这一处。
- 「挂单/离线缓存」：④ 断网时仍可打开界面并本地挂单，服务端恢复后补传。

---

## 三、部署顺序（推荐）

### 步骤 1 — 部署服务端
1. 服务器装 **Node.js 20 LTS+**。
2. 把 `release\server\` 整个拷到服务器（建议 `D:\pos-server\`，**避免中文路径**）。
3. 双击 `start-server.bat`，等它打印出访问地址（首次 1~3 分钟）。
4. 浏览器 `http://localhost:3100/` 打开入口页，进 `/admin/` 登录（`ADMIN` / `admin123`）并**立即改密**。
5. 在后台完成：商店信息、商品/条码、员工与权限、支付通道、打印设备等基础配置。
6. 放行防火墙 3100 / 3443（详见 `server\README-SERVER.md` 第四节）。

### 步骤 2 — 接入收银机 / 平板
- 收银机浏览器：`http://<服务器IP>:3100/pwa/`
- 手机/平板：`https://<服务器IP>:3443/pwa/`（首次需信任自签证书；或 `https://pos-server.local:3443/pwa/`）
- 如需限制接入设备：后台 → 设置 → 设备管理 → 开启「收银机授权」，逐台审批。

### 步骤 3 — 安装收银桌面端（可选，代浏览器）
1. 收银机运行 `pos-desktop\超市收银系统-<版本>-win-x64-setup.exe`。
2. 首次启动向导填服务器地址（`http://192.168.0.6:3100`）→ 点「测试连接」→ 保存。
3. 桌面端的额外能力：kiosk 全屏、静默打印（无预览弹窗）、第二屏客显、全局快捷键、串口/USB 外设直连。

> 服务端与桌面端互不阻断：服务端没起时，桌面端会显示「无法连接服务器」提示页并允许重新配置，不会白屏。

---

## 四、EXE 版本策略

当前**先只发布 Windows 11 轨**（Electron 44 / x64，兼容 Win10 21H2+）。
待真机回归定稿后，再用 `build-all.ps1 -Win7` 追加 Win7 轨（Electron 22.3.27 / ia32）。

EXE 未做代码签名 → 首次运行 SmartScreen 会提示，点「更多信息 → 仍要运行」即可。

---

## 五、技术要点备忘

| 主题 | 说明 |
|---|---|
| 端口 | 服务端默认 `3100`（HTTP）/ `3443`（HTTPS 自签，IP 变化自动重签） |
| 数据库 | 内嵌便携 PostgreSQL，数据在 `C:\ProgramData\pos-cashier`；**不需要 Redis** |
| 迁移 | `db\*.sql` 幂等，启动时按序重放；升级直接覆盖程序目录即可 |
| 路由 | 后台与收银端均为 hash / 页内路由，**无刷新 404 问题**，无需 history 回退配置 |
| PWA 限制 | 摄像头与「安装到桌面」需要 HTTPS 安全上下文（走 3443） |
| 外设 | 扫码枪=键盘模拟免驱动；小票机走网口(9100)/WebUSB/WebSerial，装了系统驱动的 USB 小票机由服务端 `rawprint.ps1` 直发 |
| 离线打包 | `node_modules` 已随包（含 onnxruntime 原生库），目标机**无需联网 npm install** |
| 换机迁移 | 带 `C:\ProgramData\pos-cashier` + `server\.env` + `public\uploads` 三样即可 |

---

## 六、源码侧与构建产物对照

| 产物 | 来源 | 说明 |
|---|---|---|
| `server/dist` | `backend/src` → `npm run build` | NestJS 编译产物 |
| `server/public` | `backend/public` | 收银端 `/pwa`、老板端 `/boss`、会员 `/member`、客显 `/display`、签名 `/signatures` |
| `server/public/admin` | `frontend-web/` | 24 屏完整管理后台，零构建，整目录即产物 |
| `server/pg` | `backend/node_modules/@embedded-postgres/windows-x64/native` | 便携 PostgreSQL 二进制 |
| `server/scripts` | `backend/scripts/` | `server-up.mjs`（启动编排）、`rawprint.ps1`（USB 打印直发）等运行时脚本 |
| `server/*.bat` `README-SERVER.md` `.env.example` | `deploy/` | 部署模板 |
| `pos-desktop/*.exe` | `frontend-desktop` → `electron-builder` | 收银台桌面端安装包 |

> 构建模板统一放在源码目录 `超市收银系统-初版代码/deploy/`，便于版本管理；`build-all.ps1` 会把自身与本文档复制一份到 `release/`，让发布包自描述。
