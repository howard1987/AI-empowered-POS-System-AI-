# 社区超市收银系统（Cashier POS）

> 云边协同・本地主库・会员驱动型超市收银系统
> 当前版本：
>
> **V5.0.0（连锁版）**
>
> ・由单机版 V4.26.5 改造升级

一套面向**社区超市 / 连锁便利店**的完整收银与进销存系统。核心差异化是 **“会员即股东”—— 每日按储值余额占比分配利润分红**，并内置本地 AI 识别、智能定价、购销 / 寄售对账、多门店连锁等能力。

**定位：店内电脑本地部署为默认**（数据主库在店内、断网照常营业），轻量云服务器仅作可选接入层。



***

## 一、项目简介



| 维度    | 结论                                                                 |
| ----- | ------------------------------------------------------------------ |
| 部署形态  | 店内本地部署为默认（断网可用）+ 轻量云服务器可选接入层                                       |
| 门店规模  | 单店 2–5 台收银机；数据模型与权限天然支持多店（V5.0 连锁版）                                |
| 技术栈   | Electron 收银端 + Web 管理后台 + H5 会员端 / PWA + NestJS 后端 + PostgreSQL 15 |
| 库存成本  | 先进先出 **FIFO 批次法**，采购退货按原入库批次原价                                     |
| 核心差异化 | **会员即股东 —— 每日按储值余额占比分配利润分红**（档位封顶・终身硬封顶・有效消费前置）                    |
| 连锁能力  | 总部 - 门店两级组织、跨店会员（唯一账本）、调拨总部审核、进价 L1 管控、购销 / 寄售对账、增量同步              |

> 数据主库在门店本地，图片 / 模型推理均本地完成（数据不出店），断网照常收银，是本系统的第一设计原则。



***

## 二、功能特性

### 🖥️ 多端形态（前端 8 端，职责与登录体系相互隔离）

| 端 | 载体 | 登录体系 | 职责 |
| --- | --- | --- | --- |
| **EXE 收银端** | Electron 桌面（Win7 / Win10-11 双版安装包） | 员工工号 + 密码/PIN | 主收银台：双屏（主屏收银 + 副屏顾客信任屏）、外设（扫码枪 / 电子秤 / 小票机）、打印调度 |
| **员工移动端工作台（PWA）** | 浏览器 / PWA（HTTPS 3443，手机/平板免安装） | 员工工号 + 密码/PIN（与会员体系隔离） | **一级收银台**（cashier.js，登录后直落全屏收银）、**作业**（work.js：移动收货 / 采购退货 / 移动盘点 / 拍照报损）、单据（docs）、消息（msg）、我的（me）；另有 AI 扫码、批量采集、打印机、签名板、电子秤、语音模块 |
| **Web 管理后台** | 浏览器（原生 ESM 零构建，46 屏） | 员工账号 + 权限矩阵（店长 / 总部角色） | 经营看板 / 报表 / 商品 / 供应商 / 采购 / 调价 / 生鲜 / 组合拆分 / 库存（盘点/报损/调拨）/ 对账结算 / 销售 / 交接班 / 大客户团购 / 智能防损 / 会员 / 分红 / 营销 / 画像 / 促销 / 券 / 智能决策 / AI 训练台 / 模型 / 定价 / 连锁总部（hqOnly）/ 数据同步 / 员工权限 / 打印 / 授权 / 设置 |
| **会员中心（H5）** | 浏览器 / H5（frontend-h5，或后端托管 member「绿源会员 · 掌上会员」） | 会员账号注册 / 登录（**与店员端完全隔离**） | 余额 / 积分 / 分红查询、消费流水、充值计划与充值单、自助结账、线上商城（下单 / 自提 / 配送核销）、收货地址、密码自助 |
| **老板看板** | 浏览器（backend/public/boss） | 独立入口 | 老板 / 经营者视角经营看板（营收 / 毛利 / 会员 / 门店） |
| **顾客副屏（客显）** | 浏览器 / 副屏（backend/public/display） | 无登录（受控显示） | 店招 + 欢迎语、购物明细 / 会员卡、支付引导大字、空闲轮播；EventSource 断线自动重连，不影响主屏交易 |
| **后端托管页** | 浏览器（backend/public/index.html） | 员工 | 极简管理页（健康检查 / 设置 / 登录演示） |
| **签名存储** | backend/public/signatures | — | 电子签名图片存储目录 |

> **隔离设计**：店员端（EXE / 员工 PWA / Web 后台）与会员中心（H5）的**登录体系、入口、数据权限完全隔离**——员工走 `auth`（工号 + JWT + 权限点），会员走 `m`（会员注册 / 登录），互不可见；顾客副屏为无登录的受控显示端。

### 🛒 收银能力（EXE 端与 PWA 一级收银台共用同一套后端接口）

* **双屏收银**：主屏收银台 + 副屏顾客信任屏（金额大字 / 件数 / 分红话术），无第二屏自动降级为可拖拽小窗

* **外设适配层**：影像式扫码枪（键盘 + 串口）、电子秤（串口连续读重）、小票机（网口 9100 / USB 虚拟串口 / 蓝牙 SPP），未连接时自动降级模拟 / 文本预览

* **收银台（PWA cashier）**：登录后直落全屏收银台（横屏双栏 / 手机单栏响应式）；离线价目表 Pricebook、组合支付 + clientRef 幂等 + 服务端计价、`/pay/micropay` 轮询、挂单、会员券、离线补传队列、打印 / 收据 / 电子秤 / TTS；`pos.cashier.new_ui=0` 可一键回退旧收银界面

* **打印体系**：58/80mm 小票（列宽自适应、中文按 2 列）、A5 单据静默打印、标签 / 价签打印、多联重打、可视化排版编辑器、打印模板库（字段可配）

* **收银业务**：结账（多支付组合、FIFO 批次扣减、事务 + 行锁）、挂单、赊账、交接班（钱箱 / 开抽屉）、退款、台位占用

* **语音播报**：本地 TTS（多音色、拟人化），不依赖云服务

### 🧮 进销存



* 采购：供应商 / 费用协议 → 采购订单（审批流）→ 入库验收（FIFO 批次、审核 / 驳回 / 作废）→ 采购退货（影像必填、按原批次原价）→ **购销对账**（费用 / 结算 / 账龄）→ **寄售（联营）对账**

* 库存：即时库存、批次溯源（供应商 × 入库单）、临期预警 / 临期处置、**盘点任务**、**报损**、**调拨**（总部审核、拆批、保质期照抄）

* 商品：分类树、条码 / 拼音码即输即查、多码 / 别名、导入 / 建档、捆绑包（组装 / 拆分）、**调价审核流**、门店售价覆盖、条码池

### 👥 会员体系



* 储值（本金 / 赠送拆分记账）、积分、等级、优惠券（发券 / 核销 / 失效扫描）、促销活动、营销规则触达

* **每日分红引擎**：净利 × 配置比例 → 按 “有效储值余额 × 等级系数” 加权；双门槛过滤、档位流速上限 Q + 终身累计硬封顶 R（≤净充值 ×30%）、有效消费前置、分红独立账户（仅消费抵扣、不可提现）

* **H5 会员中心**：注册 / 登录 / 密码自助、余额 / 积分 / 分红查询、消费流水、充值计划与充值单、**自助结账**、**线上商城**（下单 / 自提 / 配送核销）、收货地址

### 🏬 连锁版（V5.0）



* 总部 - 门店两级组织与权限、门店建档自动同步总部、商品发布 / 召回 / 一致性核查

* **跨店会员唯一账本**（总部在线扣款 / 计分 / 离线赊账）、门店间调拨**总部审核**

* **进价 L1 统一管控**：最低价采纳、异常进价三道闸门（事前拦采购 / 事中软拦截 / 事后裁决）

* **差异单闭环**：补差（计入下期对账付给供应商）/ 冲差（落 “进货价差” 科目，议价成果）

* **连锁对账**：统一总部结算（按 L1、差额进差异单）、门店日报 / 排名 / 区域汇总、跨店退货、同步健康监控

* **增量同步**：push/pull/ 心跳 /bootstrap/ 一致性校验，门店离线可用优先

### 🤖 AI 智能能力



* **识别闭环**：收银识别（多件 / 分割 / 跟踪）→ 纠正回传 → 样本库（店长审核）→ 导出数据集 → YOLO 训练（GPU）→ 量化 ONNX → 模型管理 / 自动训练；称重核查、难例归集

* **OCR**：发票 / 单据识别入库（`ai/ocr-invoice`）、签名识别、拍单入库

* **经营智能**：AI 大脑（经营建议 / 天气联动 / 会员画像 / 营销方案生成 / 知识库 / QA）、智能定价建议、营销文案生成与效果追踪

* **风控合规**：AI 风控（异常折扣 / 退款 / 退货监测）、数据防泄漏验证与告警

* 模型推理全部本地（onnxruntime），数据不出店

### 💳 支付与财务



* **支付网关**：`/pay/micropay` 聚合支付、交易查询 / 挂起 / 放弃、多通道适配层（`pay_channels`）

* **财务对账**：账单导入（`finance/recon`）、财务通知中心

* **大客户赊销**：大客户档案 / 协议价、应收 / 回款 / 收款、赊销下单与电子签名

* **电子签名**：签名样本库、场景分类、远程签名（`sign-remote` 发起 / 提交 / 接受 / 退回）

### 🖨️ 设备与打印管理



* 设备注册 / 授权 / 心跳 / 自检（收银机授权、POS 设备审批）、打印模板库（`print-templates`）、打印任务（A5 / 标签 / 价签）、条码秤商品下发（TCP / 编码协议）、顾客显示端推送



***

## 三、系统架构



```
┌─────────────────────────────── 门店本地（断网可用） ───────────────────────────────┐

│                                                                                  │

│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐      │

│  │ Electron 收银端│  │ Web 管理后台   │  │ H5 会员中心   │  │ PWA 收银台        │      │

│  │ (双屏/外设/打印)│  │ (46 屏, ESM)  │  │ (商城/自助)   │  │ (HTTPS 3443 手机) │      │

│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘      │

│         └───────────┬─────┴──────┬──────────┴────────┬────────┘                 │

│                    ┌▼────────────▼─────────────▼───┐                             │

│                    │   NestJS 后端（单体 64 模块）    │ ──▶ 本地 TTS / onnxruntime AI │

│                    │  HTTP 3000 / HTTPS 3443 / mDNS  │                             │

│                    └──┬────────────────────────┬──┘                             │

│                       ▼                        ▼                                │

│            ┌────────────────────┐   ┌────────────────────┐                      │

│            │ PostgreSQL 15      │   │ Python AI 服务      │ YOLO 训练(离线)       │

│            │ (pgvector) 本地主库 │   │ ai-train/forecast   │ 销量预测 (LightGBM)   │

│            └────────────────────┘   └────────────────────┘                      │

│                        │  可选主动外连隧道（无公网 IP 亦可）                        │

└────────────────────────┼───────────────────────────────────────────────────────┘

&#x20;                        ▼

&#x20;             ┌──────────────────────┐

&#x20;             │  轻量云服务器（可选）    │   仅线上业务：远程查账 / 连锁总部汇总 / 线上商城

&#x20;             └──────────────────────┘
```

**技术路线要点（云边协同・本地优先）**



| 层面    | 选型                                                               | 说明                                                        |
| ----- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| 后端    | **NestJS 12 + TypeScript 5**                                     | 单体模块化，64 个模块文件 / 40+ 控制器，统一响应包 `{code,msg,data}`          |
| 数据库   | **PostgreSQL 15（pgvector）**                                      | 本地主库；`001_init.sql` 基线（75 表）+ 002\~ 演进迁移（db/ 共 142 个 SQL） |
| 收银端   | **Electron**（双轨：modern=Electron44/x64，win7=Electron22.3.27/ia32） | 外设串口 / 网络 / 蓝牙；electron-builder 打包 EXE（portable + NSIS）   |
| 管理后台  | **原生 HTML/CSS + ES Modules（零构建）**                                | 46 屏；`node server.mjs` 或由后端托管（backend/public/admin）       |
| 会员端   | **H5（原生 ESM 零构建）**                                              | 会员中心（frontend-h5 / backend/public/member「掌上会员」），登录与店员端隔离    |
| 员工端   | **PWA（原生 ESM 零构建，HTTPS 3443）**                                    | 员工移动端工作台（一级收银台 / 作业 / 单据 / 消息）；另有老板看板（boss）、顾客副屏（display） |
| AI 推理 | **onnxruntime-node 本地推理**                                        | 条码 / OCR / 商品检测 / 分割 / 跟踪 / 签名识别，数据不出店                    |
| AI 训练 | **Python：ultralytics(YOLO) + PaddleOCR**                         | GPU 训练 → 量化 ONNX → 模型管理（训练包含 AGPL-3.0 说明）                 |
| 销量预测  | **Python：FastAPI + LightGBM**                                    | `ai-forecast-svc`，天气 / 价格因素特征                             |
| 语音    | **本地 TTS（Piper 多音色）**                                            | `POST /tts/synthesize`，不依赖云服务                             |
| 支付    | **自研支付网关 + 多通道适配层**                                              | `pay.gateway` / `pay.adapters` / `pay_channels`，通道可插拔     |
| 打印    | **hiprint + 自研排版编辑器**                                            | 58/80 小票、A5 单据、标签 / 价签、模板库、多联重打                           |
| 测试    | **真实 PostgreSQL 集成测试**                                           | `tests/e2e.mjs`：156 个断言 / 38 个业务场景，全程无需 Docker            |



***

## 四、目录结构



```
超市收银系统-初版代码/

├── backend/                     # NestJS 后端（TypeScript）

│   ├── src/

│   │   ├── common/              # db 连接池 / 鉴权守卫 / 统一响应 / 限流 / 拼音等公共件

│   │   ├── modules/             # 64 个模块文件（auth/pos/sales/products/inventory/purchase/

│   │   │                        #   members/dividend/promotions/coupons/marketing/pay.gateway/

│   │   │                        #   chain/member-chain/return-chain/sync/reports/finance.recon/

│   │   │                        #   refund/shift/tables/bigcustomer/device/print/tts/ai/aibrain/

│   │   │                        #   fraud/antileak/sign/remote.sign/display/scale-transmission/...）

│   │   ├── scripts/init-db.ts   # 数据库初始化脚本

│   │   ├── app.module.ts / main.ts   # HTTP 3000 / HTTPS 3443 / mDNS 启动

│   ├── db/                      # 001\_init.sql 基线（75 表）+ 002\~ 演进迁移（142 个 SQL）

│   ├── public/                  # 后端托管前端：admin(46 屏后台)/pwa(员工移动端工作台，含一级收银台 cashier)/
│   │                            #   member(掌上会员)/boss(老板看板)/display(顾客副屏)/signatures(签名)

│   ├── ai-train/                # YOLO 商品检测训练包（Python, GPU 训练→ONNX）

│   ├── ai-forecast-svc/         # 销量预测服务（FastAPI + LightGBM）

│   ├── tts/                     # 本地语音合成（Piper 多音色）

│   ├── tests/                   # 真库集成测试（e2e.mjs, 156 断言/38 场景）

│   └── package.json / tsconfig.json

├── frontend-desktop/            # Electron 收银端（双屏/外设/打印，双轨构建）

│   ├── src/main.js              # 主进程：双屏/IPC/打印调度

│   ├── src/preload.js           # contextBridge 安全桥

│   ├── src/peripherals/         # 扫码枪/电子秤/小票机适配器（serialport 可选降级）

│   ├── src/print/               # 打印模板（58/80 小票 + A5 可配字段，node 冒烟）

│   └── renderer/                # 收银台 + 顾客信任副屏

├── frontend-web/                # Web 管理后台（原生 ESM 零构建，46 屏）

│   ├── screens/                 # dashboard/products/stock/purchase/sales/members/dividend/

│   │                            #   promotions/coupons/marketing/recon/returns/print/models/

│   │                            #   pricing/fraud/brain/hq-\*/scale-transmission/... 46 个屏

│   ├── api.js / app.js          # fetch 封装 / hash 路由

│   └── server.mjs               # 零依赖静态服务

├── frontend-h5/                 # H5 会员中心（原生 ESM 零构建，登录与店员端隔离，商城/自助结账/自提配送）

├── docs/                        # 设计与迭代文档（设计文档/测试与质量/数据库/迭代记录/打包部署）

├── deploy/                      # 部署脚本 / 安装包工程（installer/\*.iss）/ README\_DEPLOY

├── docker-compose.yml           # 一键起 PostgreSQL 15（pgvector）

├── runtime-watchdog.mjs         # 运行时守护（启动/探活/重启）

├── LICENSE                      # MIT License

└── 启动脚本（start-pos.bat / start-dev.bat / start-backend.ps1 / test-\*.bat）
```



***

## 五、快速开始



```
\# 1) 一键起本地 PostgreSQL 15（含 pgvector）

docker compose up -d

\# 2) 安装依赖 → 编译 → 初始化数据库（建 75 表基线 + 种子数据 + 管理员账号）

cd backend

npm install

npm run build

npm run init:db

\# 3) 启动后端（HTTP 3000 / HTTPS 3443，mDNS 局域网域名）

npm run start
```



* 默认管理员：工号 `ADMIN` / 密码 `admin123`（**首次登录后请立即修改**）

* 健康检查：`http://localhost:3000/health`

* 管理页：`http://localhost:3000/index.html`（backend/public 托管）

* 员工移动端工作台（PWA，含一级收银台）：`https://<本机IP>:3443/pwa/`（手机 / 浏览器，首次访问需信任自签名证书）

### 登录与调用示例



```
curl -X POST http://localhost:3000/auth/login \\

&#x20; -H "Content-Type: application/json" \\

&#x20; -d '{"empNo":"ADMIN","password":"admin123"}'

\# 后续请求带  Authorization: Bearer \<token>
```

### 各端启动



```
# Web 管理后台（零依赖，或由后端托管）
cd frontend-web && node server.mjs        # http://localhost:8088

# EXE 收银端
cd frontend-desktop && npm install && npm start

# H5 会员中心（与店员端隔离）
cd frontend-h5 && node server.mjs          # http://localhost:8089

# 员工移动端工作台 / 老板看板 / 顾客副屏（由后端托管，启动后端后访问）
#   https://<本机IP>:3443/pwa/     员工移动端工作台（含一级收银台 cashier）
#   http://localhost:3000/boss/    老板看板
#   http://localhost:3000/display/ 顾客副屏
```



***

## 六、核心模块一览（后端 NestJS，64 个模块文件）



| 领域   | 控制器（前缀）                                                                                                                    | 核心能力                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 认证权限 | `auth`                                                                                                                     | 登录 / PIN / 二维码登录、员工 / 角色 / 权限矩阵、密码找回、授权码                         |
| 收银   | `pos` / `sales` / `shifts` / `tables`                                                                                      | 价目表 (72h 新鲜度)、挂单 / 赊账、结账（FIFO + 多支付）、欠款、拣货、自提 / 配送核销、交接班 / 钱箱、台位 |
| 商品   | `products` / `price-changes` / `bundles`                                                                                   | 分类树、档案 / 条码 / 多码、导入、调价审核流、捆绑包、门店售价                               |
| 进销存  | `purchase` / `inventory`                                                                                                   | 采购订单 / 入库 / 退货 / 购销对账 / 结算 / 寄售对账；批次 / 临期 / 盘点 / 报损 / 调拨         |
| 会员   | `members` / `m`（会员端）                                                                                                       | 储值 / 积分 / 等级 / 计划、H5 注册登录 / 商城 / 订单 / 自助结账                       |
| 分红   | `dividend`                                                                                                                 | 分红引擎：净利 × 比例→余额加权、双门槛、R=30% 封顶、日结 / 调整                           |
| 营销   | `promotions` / `coupons` / `marketing`                                                                                     | 促销活动、优惠券、营销规则触达、赠品                                               |
| 连锁   | `hq/*`、`store/products`、`sync`、`member-chain`、`return-chain`                                                               | 组织 / 商品发布 / 进价 L1 / 成本与差异单 / 对账 / 跨店会员 / 跨店退货 / 增量同步             |
| 报表   | `reports` / `hq/reports`                                                                                                   | 经营总览 / 日结 / ABC / 分红 / 门店排名 / 区域汇总 / 同步健康                        |
| 支付财务 | `pay` / `finance/recon` / `finance/notices`                                                                                | 聚合支付、财务对账、通知中心                                                   |
| 大客户  | `big-customers`                                                                                                            | 赊销档案 / 协议价 / 应收回款 / 下单 / 签名                                      |
| 设备打印 | `devices` / `printers` / `print-templates` / `print-jobs` / `pos-devices`                                                  | 设备授权、打印模板库、A5 / 标签 / 价签任务、测试页                                    |
| 客显秤  | `display` / `scale-transmission`                                                                                           | 顾客屏推送、条码秤商品下发                                                    |
| AI   | `ai` / `ai/models` / `brain` / `ai/fraud` / `antileak` / `ai/pricing` / `ai/marketing` / `ai/ocr-invoice` / `ai/signature` | 识别 / 训练闭环 / 模型管理 / 经营大脑 / 风控 / 防泄漏 / 定价 / 营销 / OCR               |
| 语音   | `tts`                                                                                                                      | 本地语音合成（多音色）                                                      |
| 签名   | `sign-remote` / `signatures`                                                                                               | 远程电子签名、签名样本库                                                     |
| 基础   | `basic` / `settings` / `upload` / `admin/reset`                                                                            | 门店 / 员工 / 分类、40+ 系统设置（留痕）、上传、重置                                  |

统一响应包 `{code,msg,data}`；接口全量清单可参照各模块 controller 路由定义。



***

## 七、测试



```
cd backend && npm install && npm run build && npm test
```



* `tests/e2e.mjs`：自动启动**真实 PostgreSQL**（embedded-postgres 二进制，纯 ASCII 路径规避 initdb 崩溃）→ 建表基线 → 启动服务 → **156 项断言 / 38 个业务场景**（登录鉴权 / 设置留痕 / 入库批次 / 收银 FIFO / 会员储值 / 分红引擎 / 退货归属 / 对账结算等）

* 全程无需 Docker；Windows 下自动用 `robocopy` 拷贝 PG 二进制，测试用端口 54329、数据目录 `%TEMP%\pgdata-cashier-test`，结束自动停库



***

## 八、部署与打包



* **单机部署**：`docker compose up -d` 起 PG → `npm run build && npm run init:db && npm run start`（HTTP 3000 / HTTPS 3443）

* **连锁版**：总部 + 门店两级部署，门店离线可用优先；对账统一总部，增量同步

* **桌面端打包**：`frontend-desktop` 双轨构建


  * `npm run dist:modern` → Electron44 / x64（Win10/11 portable EXE）

  * `npm run dist:win7` → Electron22.3.27 /ia32（Win7 兼容）

* **安装工程**：`deploy/installer/*.iss`（Inno Setup 中文安装界面）

* 运行时守护：`runtime-watchdog.mjs`（进程探活 / 自动重启），详细部署见 `deploy/README_DEPLOY.md` 与 `release/README_DEPLOY.md`



***

## 九、配套文档（docs）

设计、测试、迭代等文档已整理并入仓库 `docs/` 目录，按 5 类组织：



| 文档（docs/）                                                                                                               | 说明                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [超市收银系统设计方案](docs/设计文档/超市收银系统设计方案.md)                                                                                   | 完整设计方案 V4.8.22（564 项断言实现实录、第十五章实现进度）     |
| [超市收银系统 - 连锁版改造方案](docs/设计文档/超市收银系统-连锁版改造方案.md)                                                                         | 连锁版全链路改造（业务规则拍板五轮、进价 L1 管控、差异单闭环）        |
| [超市收银系统 - 收银端专项设计方案](docs/设计文档/超市收银系统-收银端专项设计方案.md)                                                                     | 收银端专项设计（含 HTML 原型）                       |
| [超市收银系统 - 智能能力规划对比分析报告](docs/设计文档/超市收银系统-智能能力规划对比分析报告.md)                                                               | 智能能力规划对比分析                               |
| [超市收银系统 - 打印模版模块 - 细化设计方案](docs/设计文档/超市收银系统-打印模版模块-细化设计方案.md)                                                           | 打印模版模块细化设计                               |
| [超市收银系统 - 支付设计对比分析报告](docs/设计文档/超市收银系统-支付设计对比分析报告.md)                                                                   | 支付设计对比分析                                 |
| [超市收银系统 - 界面原型](docs/设计文档/超市收银系统-界面原型.html) · [P14 收银台高保真原型](docs/设计文档/超市收银系统-P14收银台高保真原型.html)                         | 界面原型（HTML）                               |
| [超市收银系统 - 全链路梳理与漏洞测试报告](docs/测试与质量/超市收银系统-全链路梳理与漏洞测试报告.md)                                                              | 全链路梳理与漏洞测试                               |
| [超市收银系统 - 差距分析与改进方案](docs/测试与质量/超市收银系统-差距分析与改进方案.md)                                                                    | 差距分析与改进                                  |
| [连锁便利店 POS - 全量测试用例表 - V1.0](docs/测试与质量/连锁便利店POS-全量测试用例表-V1.0.md) · [模拟走查报告 - V1.0](docs/测试与质量/连锁便利店POS-模拟走查报告-V1.0.md) | 测试用例与走查                                  |
| [数据库建表 SQL v1.1](docs/数据库/超市收银系统-数据库建表SQL-v1.1.sql)                                                                     | 建表 SQL v1.1                              |
| [docs / 迭代记录](docs/迭代记录/)                                                                                               | 73 篇 V4.9.x \~ V5.0.0 版本迭代 / 整改 / 安全加固记录 |
| [docs / 打包部署](docs/打包部署/)                                                                                               | 项目打包勘察报告与独立打包方案                          |



***

## 十、版本演进



* **V4.x（单机版）**：核心收银闭环（进销存 / 会员分红 / 对账 / 打印）→ AI 智能能力逐步落地（识别 / OCR / 定价 / 语音）→ 桌面端体验与安全加固

* **V5.0（连锁版，当前）**：总部 - 门店两级组织、跨店会员唯一账本、调拨总部审核、进价 L1 统一管控、差异单补差 / 冲差闭环、购销 / 寄售对账、增量同步（迁移 `104_v500_*` 系列）



***

## 十一、许可（License）



* 本仓库采用 **MIT License**（见 [LICENSE](LICENSE)），版权人：**杨联 (YangLian)**。

* 如需改用 Apache-2.0 / GPL-3.0 或保留所有权利（All rights reserved），替换 LICENSE 文件即可。

* **第三方依赖声明**：


  * AI 训练包（`backend/ai-train`）基于 **ultralytics（AGPL-3.0）**：非商用场景不受影响；若未来商用需购买企业授权，详见该目录 README。

  * `vue-plugin-hiprint-main/` 为引入的第三方打印模板组件（自带 LICENSE）。



***

## 十二、安全提示



* 首次登录后请立即修改默认管理员密码 `admin123`

* 生产环境请启用密码策略、支付安全加固、店长授权改价 / 折扣红线、设备授权审批

* HTTPS 自签名证书仅用于局域网 PWA 访问，勿用于公网；公网部署请替换正式证书

* 模型与上传数据（`backend/models`、`backend/public/uploads`）已加入 `.gitignore`，不随仓库上传



***

## 十三、界面展示

（47 张截图，按模块分组）

#### Web 管理后台（01–41）

![01 后台首页](docs/images/01-admin-home.png)

![02 经营看板](docs/images/02-dashboard.png)

![03 报表中心](docs/images/03-reports.png)

![04 商品档案](docs/images/04-products.png)

![05 供应商管理](docs/images/05-suppliers.png)

![06 供应商档案-签字采集](docs/images/06-supplier-signature.png)

![07 采购订单](docs/images/07-purchase-orders.png)

![08 采购入库](docs/images/08-purchase-inbound.png)

![09 采购退货](docs/images/09-purchase-return.png)

![10 采购退货-新建退货单](docs/images/10-return-create.png)

![11 调价管理](docs/images/11-price-adjust.png)

![12 生鲜管理](docs/images/12-fresh-produce.png)

![13 组合拆分](docs/images/13-bundles.png)

![14 库存批次](docs/images/14-stock-batches.png)

![15 盘点](docs/images/15-stocktake.png)

![16 报损](docs/images/16-loss.png)

![17 调拨](docs/images/17-transfer.png)

![18 对账结算](docs/images/18-reconciliation.png)

![19 销售单据](docs/images/19-sales-orders.png)

![20 销售明细](docs/images/20-sales-items.png)

![21 交接班](docs/images/21-shifts.png)

![22 大客户与团购](docs/images/22-big-customer.png)

![23 智能防损](docs/images/23-fraud-guard.png)

![24 会员管理](docs/images/24-members.png)

![25 分红引擎](docs/images/25-dividend.png)

![26 营销引擎](docs/images/26-marketing.png)

![27 会员画像](docs/images/27-member-profile.png)

![28 促销活动](docs/images/28-promotions.png)

![29 优惠券](docs/images/29-coupons.png)

![30 智能决策中心](docs/images/30-ai-brain.png)

![31 AI 训练台](docs/images/31-ai-training.png)

![32 AI 动态定价](docs/images/32-ai-pricing.png)

![33 门店管理](docs/images/33-store-management.png)

![34 员工与权限](docs/images/34-staff-perms.png)

![35 打印中心](docs/images/35-print-center.png)

![36 打印模板](docs/images/36-print-templates.png)

![37 授权管理](docs/images/37-authorization.png)

![38 系统设置](docs/images/38-settings.png)

![39 AI 识别](docs/images/39-ai-recognition.png)

![40 AI 经营](docs/images/40-ai-business.png)

![41 收银台设置](docs/images/41-cashier-settings.png)

#### 收银端（42–47）

![42 收银端-登录](docs/images/42-cashier-login.png)

![43 收银端-开班](docs/images/43-cashier-open-shift.png)

![44 收银端-收银界面](docs/images/44-cashier-checkout-ui.png)

![45 收银端-设置](docs/images/45-cashier-settings-ui.png)

![46 收银端-结算界面](docs/images/46-cashier-settle.png)

![47 收银端-交接班](docs/images/47-cashier-close-shift.png)