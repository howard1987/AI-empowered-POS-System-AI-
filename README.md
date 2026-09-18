# 社区超市收银系统 · 初版代码（配套开发执行文件 V1.0 / 设计方案 V4.7.0）

当前交付：**后端 NestJS 单体骨架 + 核心业务闭环**（auth / settings / products / inventory / purchase / members / dividend / sales 八个模块），数据库直接复用《建表 SQL v1.0》。

## 快速开始

```bash
# 1) 一键起本地 PostgreSQL 15（含 pgvector）
docker compose up -d

# 2) 安装依赖 → 编译 → 初始化数据库（建 74 表 + 种子数据 + 管理员账号）
cd backend
npm install
npm run build
npm run init:db

# 3) 启动
npm run start        # http://localhost:3000/health
```

默认管理员：工号 `ADMIN` / 密码 `admin123`（首次登录后请立即修改）。

## 登录与调用示例

```bash
# 登录
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"empNo":"ADMIN","password":"admin123"}'
# 后续请求带  Authorization: Bearer <token>
```

## 初版已实现接口一览

| 模块 | 接口 | 说明 |
|---|---|---|
| auth | POST /auth/login、GET /auth/me | 员工登录（bcrypt+JWT，含权限点集合） |
| settings | GET /settings、PUT /settings/:key、GET /settings/changes | 40 项系统设置读写 + **变更留痕**（敏感操作写审计） |
| products | GET/POST /products/categories、GET/POST/PUT /products、GET /products/barcode/:code | 分类树、商品档案、条码/拼音码即输即查 |
| inventory | GET /inventory/summary、/inventory/batches、/inventory/expiry-alerts | 即时库存、批次溯源（供应商×入库单）、临期预警 |
| purchase | GET/POST /suppliers、POST /purchase/inbounds、POST /purchase/inbounds/:id/audit、GET /purchase/inbounds、POST /purchase/returns | 供应商、**入库审核→自动生成 FIFO 批次**（生产日期→到期日、最低进价记录）、退货单骨架 |
| members | GET/POST /members、GET /members/:id、POST /members/:id/recharges、POST /members/:id/unlock | 快速查询、建档、**储值（本金/赠送拆分记账）**、锁定解锁 |
| dividend | GET /dividend/preview、POST /dividend/periods/run、GET /dividend/periods、/dividend/records | **分红引擎**：净利×5%→余额加权、双门槛过滤、R=30% 封顶降级、年化预警 |
| sales | POST /sales/checkout、GET /sales、GET /sales/:id | **收银结账**：多支付组合、FIFO 批次扣减（事务+行锁）、混合成本、积分、有效消费窗口 |

统一响应包与错误码段见《超市收银系统-开发执行文件.md》第 4 节。

## 目录结构

```
backend/
├── db/001_init.sql          # 建表 SQL v1.0 基线（禁改，演进走 002+ 迁移）
├── public/index.html        # 极简管理页（健康检查/设置查看/登录演示）
├── src/
│   ├── common/              # db 连接池 / 统一响应 / 鉴权守卫
│   ├── modules/             # 8 个业务模块（controller+service 同文件）
│   └── scripts/init-db.ts   # 数据库初始化脚本
├── package.json
└── tsconfig.json
```

## 后续里程碑

见《超市收银系统-开发执行文件.md》第 2 节（M1~M6）与第 3 节任务卡总表。
