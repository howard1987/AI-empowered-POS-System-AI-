# Web 管理后台（frontend-web）

零构建链：原生 HTML/CSS + ES Modules，浏览器直接访问或 `node server.mjs`，无需 npm install。

## 启动

```bash
# 方式一：独立静态服务
node server.mjs          → http://localhost:8088

# 方式二：由后端托管（同源免 CORS 配置）
# 将本目录全部文件拷贝到 backend/public/ 覆盖 index.html
```

后端 API 默认 `http://localhost:3100`（登录页可改），NestJS 已 enableCors。
联调环境一键起停（含真实 PG）：在 backend 目录执行 `node tests/dev-up.mjs`（常驻）/ `node tests/dev-down.mjs`（停止）。
默认账号：ADMIN / admin123（首次登录后请改密）。

## 屏幕（12 个，全部对接真实 API，冒烟已验证）

| 屏幕 | 路由 | 主要 API |
|---|---|---|
| 经营看板 | #/dashboard | GET /reports/dashboard?period=day/week/month/quarter |
| 商品档案 | #/products | GET/POST /products、GET /products/categories |
| 库存批次 | #/stock | GET /inventory/summary、/batches、/expiry-alerts |
| 采购入库 | #/purchase | GET/POST /purchase/inbounds、POST /purchase/inbounds/:id/audit、GET/POST /purchase/suppliers |
| 销售流水 | #/sales | GET /sales?from=&to=、GET /sales/:id（明细+批次溯源+支付） |
| 挂单/价目表 | #/counter | GET /pos/held、POST /pos/held/:id/checkout、DELETE /pos/held/:id、GET /pos/pricebook/freshness |
| 交接班 | #/shifts | POST /shifts/open、GET /shifts/current、POST /shifts/:id/close、GET /shifts |
| 会员管理 | #/members | GET/POST /members、GET /members/:id、POST /members/:id/recharges |
| 分红引擎 | #/dividend | GET /dividend/preview、/periods、/records、POST /dividend/periods/run |
| 促销活动 | #/promotions | GET /promotions、GET /promotions/:id、POST …/:id/start、/:id/stop |
| 优惠券 | #/coupons | POST/GET /coupons、POST /coupons/:id/issue、/expire-scan、/:id/status |
| 系统设置 | #/settings | GET /settings?group=、PUT /settings/:key（留痕）、GET /settings/changes |

## 结构

```
index.html      壳（侧栏 + 顶栏 + 视图容器）
styles.css      全量样式（浅色主题）
api.js          fetch 封装（token/401 跳登录/toast/money/esc）
app.js          hash 路由 + 菜单 + 登录视图
server.mjs      零依赖静态服务（:8088）
screens/*.js    每屏一个模块，导出 render(view)
```

## 约定

- 响应统一 `{code, msg, data}`；`must()` 封装「非 0 弹错、成功可提示」。
- 金额展示 `money()`，用户输入一律服务端权威计价（前端不做金额权威计算）。
- 新增屏幕：在 `screens/` 加模块 → 在 `app.js` MENU 注册即可。
