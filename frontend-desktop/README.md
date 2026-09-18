# 超市收银系统 — Electron 收银端（T16 初版壳）

对应执行文件任务卡 **T16**（方案 9.9 双屏 / V4.6.4 打印 / V4.6.2 外设）。

## 运行

```bash
cd frontend-desktop
npm install          # electron（约 100MB）+ serialport（可选，失败不影响）
npm start            # 启动收银台 + 副屏（顾客信任屏）
npm run smoke        # 打印模板冒烟测试（无需 Electron，纯 Node）
```

## 已实现（初版）

| 能力 | 说明 |
|---|---|
| **双屏** | 主屏收银台；检测到第二显示器时副屏自动全屏附着（顾客信任屏：金额大字/件数/分红话术），无第二屏时降级为可拖拽小窗。主屏 IPC `pos:sync` 实时推送 |
| **扫码枪** | keyboard 模式（HID 键盘模拟，输入框回车即扫）+ 串口模式接口；`pos:scan-feed` → 主进程广播 `pos:scan` |
| **电子秤** | 串口连续读重（`kg` 正则解析，适配常见计价秤协议）；未装 serialport 时 mock 喂入 |
| **小票机** | **三种连接方式**：网口 TCP 9100 / USB 虚拟串口 / 蓝牙 SPP；ESC/POS 指令（GBK 编码 + 切刀）；未连接时返回文本版面预览 |
| **打印模板** | 58mm / 80mm 小票（列宽自适应、中文按 2 列）；A5 单据 silent print，**8 列精简默认、字段可配**（`DEFAULT_A5_FIELDS` JSON） |
| **测试页** | 外设测试台：连接三种方式切换、58/80 测试小票、A5 送打、模拟秤读重、扫码事件日志 |

## 结构

```
src/main.js            主进程：双屏/IPC/打印调度
src/preload.js         contextBridge 安全桥（window.cashier）
src/peripherals/       扫码枪/电子秤/小票机适配器（serialport 可选，自动降级模拟）
src/print/templates.js 纯函数模板（58/80 小票 + A5 可配字段），node 可跑冒烟
renderer/index.html    收银台 + 外设测试台
renderer/second.html   副屏顾客信任屏
```

## 与后端的衔接（下一步）

- 登录鉴权与 `GET /pos/pricebook` 全量价目表缓存（T14 已交付接口，含 72h 新鲜度硬闸）
- 结账调 `POST /sales/checkout`（促销/积分/分红引擎已内置）
- 恢复后补录：应急手输行（`line_remark = 手输:条码`）扫描补录到商品档案
