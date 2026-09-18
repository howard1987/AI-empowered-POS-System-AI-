
## 测试（真库集成测试）

```bash
cd backend && npm install && npm run build && npm test
```

- `tests/e2e.mjs`：自动启动**真实 PostgreSQL**（从 `@embedded-postgres/windows-x64/native` 拷贝二进制）→ 建表基线 → 启动服务 → 85 项断言（登录鉴权/设置留痕/入库批次/收银 FIFO/会员储值/分红引擎/退货自动归属 T7/对账结算 T8），全程无需 Docker。
- 环境注意（Windows）：
  1. PG 二进制必须位于**纯 ASCII 路径**（PostgreSQL BUG #16926：非 ASCII 路径 + `--encoding=UTF8` 会导致 initdb 崩溃），测试脚本已自动拷贝到 `%TEMP%\pgbin-ascii`；
  2. 本机 Node 的 `fs.cpSync` 拷贝该目录会 fail-fast 崩溃，已改用 `robocopy`；
  3. 测试用端口 54329 / 数据目录 `%TEMP%\pgdata-cashier-test`，运行结束自动停库。
