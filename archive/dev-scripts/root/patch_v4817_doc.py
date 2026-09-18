# -*- coding: utf-8 -*-
"""V4.8.17 执行文件进度段补丁"""
import io

P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-开发执行文件.md"
src = io.open(P, encoding="utf-8").read()

assert "V4.8.17" not in src, "补丁已应用，勿重复执行"

OLD = "- **待办（下轮候选）**：组合拆分（组合商品）评估、Electron 打包与实机外设验证、小程序端规划"
NEW = """- **组合拆分·组合商品（V4.8.17）**：✅ 完成。①迁移 db/014：product_bundles（组合定义，bundle_product_id 唯一）+ product_bundle_items（BOM：子商品×数量，支持散货小数）+ bundle_ops/bundle_op_items（组装 ZZ- / 拆分 CF- 单据留痕）；②后端 BundleController（挂在 products.module，权限 stock.transfer=库存形态转移）：组装=按 BOM FIFO 消费子商品批次→生成组合商品批次（单位成本=Σ子批次成本/份数，**严格守恒**）；拆分=FIFO 消费组合批次→子商品建新批次（成本均摊口径 **u=U/Σ(BOM数量)**，Σ子成本=U 守恒）；不记库存子件按最近进价（与销售同口径）；③**组合商品可直接销售**——组合批次生成后现有收银 FIFO 零改动支持（X8 实测：卖 2 套成本=2×批次单价）；评估结论：「无组装库存虚拟拆扣子商品」留作后续设置开关，本轮交付『组装→销售→拆分』最小闭环
- **前端 bundles.js 新屏**：组合档案卡（BOM 明细带子商品即时库存 + 新建弹窗：组合商品下拉+BOM 行添加）+ 组装/拆分开单（类型切换联动提示/单号前缀、组合下拉带 BOM 摘要、份数、BOM 预览表=子商品×BOM 数量×本单消耗×现有库存不足标红）+ 单据浏览（类型筛选/日期区间/单位成本/总成本 mono）；app.js 菜单注册「🧩组合拆分」（商品与库存组）
- **测试与冒烟**：`backend && npm test` = **502 项断言全通过**（X 段新增 29 项：建档校验 40003/40404、组装成本守恒 27.5、批次单价 5.5、库存三方联动、卖组合 FIFO 成本 11、拆分守恒 11 与子批次回加、跨批次二次组装、类型过滤）；playwright UI 冒烟 PASS（造数→组合档案 BOM 库存联动→UI 开组装单 ZZ-202609-001 成本 ¥39.00 生效→浏览列表），截图 shot-v4817-*.png
- **本轮修复的真 bug**：①GET /bundles 明细 SQL 引用了不存在的表别名 b（漏 JOIN product_bundles）→ 50000 missing FROM-clause entry——**新写 JOIN 子查询后先在真库跑一遍含数据场景再进 e2e**；②冒烟脚本断言成本值手算错（19 vs 39）——断言值应从 BOM×份数推导而非拍脑袋
- **待办（下轮候选）**：Electron 打包与实机外设验证、小程序端规划、组合「虚拟拆扣」开关"""

assert OLD in src, "锚点未命中：待办行不匹配"
src = src.replace(OLD, NEW, 1)
io.open(P, "w", encoding="utf-8", newline="\n").write(src)

chk = io.open(P, encoding="utf-8").read()
assert "V4.8.17" in chk and "502" in chk and "虚拟拆扣" in chk
print("OK: 执行文件已更新至 V4.8.17")
