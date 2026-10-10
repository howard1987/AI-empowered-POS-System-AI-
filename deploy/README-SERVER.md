# 社区超市收银系统 · 服务端部署说明

本目录是**独立可运行的服务端**：内置便携 PostgreSQL，装好 Node.js 后双击 `start-server.bat` 即可运行，
浏览器打开即可使用后台与收银端。无需另外安装数据库。

---

## 一、运行环境

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（64 位）｜ Windows Server 2016+ |
| Node.js | **20 LTS 或更高**（推荐 22 LTS）→ https://nodejs.org/ |
| 硬盘 | ≥ 3 GB 可用 |
| 权限 | 首次运行需能写入 `C:\ProgramData`（普通用户默认即可） |
| 其他 | 不需要 Redis、不需要 .NET、不需要额外装 PostgreSQL |

---

## 二、三步启动

1. **装 Node.js**（装完建议重启一次资源管理器/命令行，让 PATH 生效）。
2. **双击 `start-server.bat`**。
   首次运行会自动：复制 `.env` → 释放内置数据库到 `C:\ProgramData\pos-cashier` → 初始化并建表 → 启动服务。
   **首次约需 1~3 分钟**，请等窗口里打印出访问地址。
3. **浏览器打开** `http://localhost:3100/`（运维入口页），或直接进：

| 端 | 地址 | 说明 |
|---|---|---|
| 管理后台 | `http://<服务器IP>:3100/admin/` | 24 大模块完整后台 |
| 收银台 | `http://<服务器IP>:3100/pwa/` | 浏览器 / 平板 / 收银机 |
| 老板看板 | `http://<服务器IP>:3100/boss/` | 经营总览、消息中心 |
| 客显副屏 | `http://<服务器IP>:3100/display/` | 双屏收银机第二屏 |
| 健康检查 | `http://<服务器IP>:3100/health` | 运维探活 |

> **默认管理员：工号 `ADMIN`，密码 `admin123`** —— 首次登录会强制要求改密，请尽快处理。

**停止服务**：在 `start-server.bat` 窗口按 `Ctrl+C` 停后端；
再双击 `stop-server.bat` 停止内置数据库（也可只关窗口，数据库会继续驻留，下次秒起）。

---

## 三、配置（`.env`）

首次运行会自动生成 `.env`（来自 `.env.example`）。用记事本改完**保存后重新运行 `start-server.bat`** 生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3100` | 服务端口。局域网收银机/平板访问此端口 |
| `HTTPS_PORT` | `3443` | HTTPS 端口。**手机扫码/拍照/安装 PWA 必须走这个端口** |
| `PG_MODE` | `embedded` | `embedded`=用内置数据库；`external`=用外部已装 PostgreSQL |
| `PG_PORT` | `54329` | 内置数据库端口（仅监听 127.0.0.1，不对外暴露） |
| `PG_PASSWORD` | `password` | 内置数据库口令（仅本机使用） |
| `DATABASE_URL` | — | 仅 `PG_MODE=external` 时必填 |
| `JWT_SECRET` | 自动生成 | 登录令牌密钥。**换机迁移时请一并带走**，否则所有设备需重新登录 |
| `BIND_HOST` | 空 | 留空=监听全部网卡（0.0.0.0，LAN 收银兼容）；只允许本机访问时设 `127.0.0.1`，或有公网 IP 时设为内网网卡地址 |
| `AI_UPLOADS_DIR` | 空 | 可选：把图片/AI 样本目录外置到数据盘或 NAS |

> 🔒 **网络暴露面说明（务必阅读）**：默认监听 `0.0.0.0` 时，以下端点**无需登录**即可被同网段任意主机访问——
> ① **客显副屏 `/display/`**（SSE 实时订单推送与门店配置，供双屏收银机第二屏使用，设计上信任内网）；
> ② **会员 H5 `/member/` 自助端点**（会员本人手机号+密码登录，公开注册入口）。
> 这是「内网信任」的部署口径：请确保服务器只在**可信局域网**内可达——若有公网可达 IP，务必设 `BIND_HOST` 为内网网卡地址，
> 并在防火墙只放行 `3100/3443` 给收银机所在网段（Windows 防火墙 → 入站规则 → 作用域 → 远程 IP 地址）。

内置数据库工作目录固定为 **`C:\ProgramData\pos-cashier`**（可用 `POS_DATA_DIR` 覆盖）。
> ⚠️ 该路径**必须是纯 ASCII**（不能含中文）——这是 PostgreSQL 在 Windows 上的硬性限制，脚本已自动规避。
> 备份数据 = 备份这个目录（停库后整目录复制即可）。

---

## 四、让收银机 / 平板连上

1. **查服务器 IP**：在服务器上按 `Win+R` → `cmd` → 输入 `ipconfig`，记下 IPv4 地址（如 `192.168.0.6`）。
2. **放行防火墙**：首次启动若弹出 Windows 防火墙提示，勾选「专用网络」并允许。
   手工放行命令（管理员 CMD）：
   ```
   netsh advfirewall firewall add rule name="POS-HTTP" dir=in action=allow protocol=TCP localport=3100
   netsh advfirewall firewall add rule name="POS-HTTPS" dir=in action=allow protocol=TCP localport=3443
   ```
3. **收银机浏览器**打开 `http://192.168.0.6:3100/pwa/`。
4. **手机 / 平板**请用 HTTPS：`https://192.168.0.6:3443/pwa/`
   （首次访问浏览器会提示证书不受信任 → 选择「高级 / 继续访问」。这是自签证书，仅内部使用。）

> 如需更省事，服务端会广播 `pos-server.local` 域名，设备可用
> `https://pos-server.local:3443/pwa/` 访问，服务器换 IP 也不用改配置。

**收银机授权**（可选，防未授权设备接入）：管理后台 → 设置 → 设备管理 → 打开「收银机授权」，
新设备首次登录会自动登记到待授权列表，管理员点「通过」后即可使用。

---

## 五、开机自启（可选）

默认 `start-server.bat` 是**前台窗口**运行。需要开机自动运行，二选一：

**方案 A：计划任务（简单）**
1. `Win+R` → `taskschd.msc` → 创建任务
2. 常规：勾选「不管用户是否登录都要运行」+「使用最高权限运行」
3. 触发器：启动时
4. 操作：程序填 `cmd.exe`，参数填 `/c "cd /d D:\release\server && node scripts\server-up.mjs up"`
5. 设置：勾选「如果任务失败，按以下频率重新启动」

**方案 B：注册为 Windows 服务（NSSM，推荐生产）**
1. 下载 NSSM → https://nssm.cc/download
2. 管理员 CMD：
   ```
   nssm install POSServer "C:\Program Files\nodejs\node.exe" "D:\release\server\scripts\server-up.mjs" up
   nssm set POSServer AppDirectory "D:\release\server"
   nssm set POSServer AppStdout "D:\release\server\logs\service.log"
   nssm set POSServer AppStderr "D:\release\server\logs\service.err.log"
   nssm set POSServer Start SERVICE_AUTO_START
   nssm start POSServer
   ```
   （`AppDirectory` 与路径请按实际部署位置修改；内置数据库不用单独做服务，主服务退出时它仍驻留。）

---

## 六、升级

1. 停掉服务（`Ctrl+C` + `stop-server.bat`）。
2. **备份**：`C:\ProgramData\pos-cashier`（数据）+ 本目录 `.env`（配置与密钥）。
3. 用新版覆盖本目录（**保留 `.env` 与 `public\uploads`**）。
4. 重新运行 `start-server.bat` —— 会自动执行**幂等迁移**（`db\*.sql` 按序重放，不会丢数据）。

---

## 七、常见问题

| 现象 | 处理 |
|---|---|
| 提示 `Node.js not found` | 装 Node.js 20 LTS+ 后重开命令行 |
| 首次启动很慢（1~3 分钟） | 正常：在释放数据库 + 建表，只需一次 |
| `EADDRINUSE` 端口被占 | 上次进程没退干净：任务管理器结束多余 `node.exe`，或改 `.env` 的 `PORT` |
| 手机打不开、提示不安全 | 换 `https://IP:3443` 并信任自签证书；HTTP 不支持摄像头 |
| 局域网其它机器访问不了 | 查防火墙放行 3100/3443；确认两台机器同一网段 |
| PostgreSQL 启动失败 | 确认 `C:\ProgramData` 可写；确认 `POS_DATA_DIR` 是**纯 ASCII 路径** |
| 需要重置内置数据库 | 停库后删除 `C:\ProgramData\pos-cashier\pgdata`，再启动会重新初始化（**数据会清空**） |

---

## 八、目录说明

```
server/
├─ dist/            后端编译产物（勿改）
├─ public/          静态站
│  ├─ admin/        管理后台（24 屏）
│  ├─ pwa/          收银台
│  ├─ boss/ member/ display/ signatures/   老板端 / 会员H5 / 客显 / 签名
│  ├─ uploads/      用户上传（升级请保留）
│  └─ index.html    运维入口页
├─ db/              数据库迁移脚本（幂等）
├─ pg/              内置便携 PostgreSQL 二进制
├─ node_modules/    生产依赖（离线自带）
├─ scripts/         server-up.mjs（启动编排）· rawprint.ps1（USB 小票机直发）等
├─ .env.example     配置模板
├─ start-server.bat / stop-server.bat
└─ README-SERVER.md 本文件
```

> 证书（`certs/`）、运行密钥（`.runtime/`）、日志（`logs/`）会在首次启动后自动生成。

## 九、连锁升级（V5.0.0 · §7.1 十步迁移）

> 适用于：已有单机部署，要升级为「总部 + 门店」连锁模式。
> **铁律：停业窗口执行；执行前必备份；对数报告不通过绝不上线。**

### 9.1 升级步骤（幂等，可重复执行）

```
【步骤 0】冻结与备份（人工）
  ① 通知停业/停止收银 → stop-server.bat 停后端
  ② 备份 PG 数据目录：
     robocopy /MIR C:\ProgramData\pos-cashier D:\backup\pos-cashier-YYYYMMDD
  ③ 基线对数：node dist\scripts\recon-report.js --label 升级前 --out 对数-升级前.md

【步骤 1】迁移（只加列/建表，不改数据）
  set DATABASE_URL=postgres://postgres:密码@localhost:5432/数据库名
  node dist\scripts\init-db.js

【步骤 2~7】组织与业务升格（一条命令，幂等）
  node dist\scripts\upgrade-v5.js --dry-run    # 先预演看动作清单
  node dist\scripts\upgrade-v5.js              # 正式执行
  自动完成：建总部行 / 门店编码+节点码 / 商品升格总部主档(原店保留下发台账)
            / 会员补来源店 / 超管角色置 hq/all

【步骤 8】新门店开站
  ① 总部后台「门店管理」→ 新建门店（自动生成节点编码+密钥）
  ② 新店机器部署本系统 → 登录后台 →「数据同步」页填三要素（节点码/密钥/总部地址）
  ③ 连上后自动全量引导（商品/价格/设置），收银台可扫码即开通

【步骤 9】对数（不通过不上线）
  node dist\scripts\recon-report.js --label 升级后 --out 对数-升级后.md
  与「对数-升级前.md」逐项 diff：销售单量/金额/毛利、库存 SKU/金额、
  会员数/余额/积分、商品数 —— 差异必须为 0

【步骤 10】灰度
  D1：总部只读观察同步（门店照常收银）
  D2：开启总部报表与商品下发
  一周稳定后正式切换
```

### 9.2 回滚预案

| 阶段 | 回滚动作 |
|---|---|
| 步骤 1~3 后异常 | 迁移只加列/建表 → 停用新代码、回退旧版程序即可继续营业 |
| 步骤 4 后异常 | `UPDATE products SET store_id=(原店id) WHERE store_id=(总部id)`；或直接还原备份 |
| 步骤 8 后异常 | 总部「门店管理」停用该节点（`sync_enabled=false`）→ 门店独立运行不受影响 |
| 任何阶段严重异常 | 还原 PG 数据目录整目录备份 → 回到升级前状态 |

### 9.3 日常运维

- **同步监控**：总部后台「数据同步」页看各店在线/落后/死信；连续失败自动退避重试（8 次转死信），修复网络后自动补传。
- **每日对账**：总部「数据同步 → 对数校验」自动比对昨日单量/金额，差异 ≠ 0 先查该店死信。
- **断网营业**：门店断外网照常收现金；恢复后队列自动清空，总部报表补齐。
