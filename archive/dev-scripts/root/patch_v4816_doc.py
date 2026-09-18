# -*- coding: utf-8 -*-
"""V4.8.16 执行文件进度段补丁"""
import io

P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-开发执行文件.md"
src = io.open(P, encoding="utf-8").read()

assert "V4.8.16" not in src, "补丁已应用，勿重复执行"

OLD = "- **待办（下轮候选）**：组合拆分（组合商品）评估、Electron 打包与实机外设验证、小程序端规划"
NEW = """- **调价单支持进价调价（V4.8.16）**：✅ 完成。①迁移 db/013：price_changes.price_type（'sale' 售价默认/'cost' 进价，历史单兼容）+ price_change_items.supplier_id + ck_pc_type 校验（幂等 DO 块防重复执行报错）；②后端 PriceChangeController 双类型：sale 单号 TJ- 照旧 UPDATE sell_price；cost 单号 **JC-**，明细 {productId, newPrice, supplierId?}（supplierId 缺省取 products.supplier_default_id，均无 → 40003），落地方式 = 写 supplier_product_prices（price=新进价、min_price=LEAST(新价,历史最低)——**进价调价即「调价通知」，进价下调同步刷新历史最低价保护线 V4.3.6**，source_doc 关联 JC 单号）；新增 GET /price-changes/cost-base?productIds=（逐商品现进价基线 = 默认供应商最近一次进价，无历史记 0）；重复校验改为 product@supplier 组合粒度（sale 单不受影响）；列表支持 ?type= 过滤，详情明细 LEFT JOIN suppliers 出供应商名
- **前端 prices.js 双类型界面**：单头新增「调价类型」下拉（💰售价调价/📥进价调价），切换联动——表头 现售价/新售价 ↔ 现进价/新进价、占位符、工具栏单号前缀提示、底部提示条（进价模式展示最低价保护线联动说明）；进价模式 loadProds 先批量拉 cost-base 填充下拉「现进 ¥X.XX（无进价历史）」；旧价 0 时涨幅列显示「—」（无基线不算涨跌）；浏览列表新增「类型」列（📥进价/💰售价 tag）+ 类型筛选下拉
- **测试与冒烟**：`backend && npm test` = **473 项断言全通过**（W 段新增 20 项：JC 单号格式/priceType 返回/进价不改售价/基线与 min_price 落地/source_doc 关联/二次下调刷新保护线/同价 40003/未设供应商 40003/详情留痕与供应商名/type 过滤）；playwright UI 冒烟 PASS（页面上下文造数→售价/进价模式切换→下拉带现进价→UI 开单 JC-202609-001 生效→浏览表 📥 进价 tag→同价拦截），截图 shot-v4816-*.png
- **本轮修复的真 bug**：①prices.js 全文 8 处 `¥${money(...)}` 双货币符（V4.8.15 遗留，money() 自带 ¥）——教训：**金额列一律只写 money()，不要再拼 ¥**；②幂等造数：供应商/商品先查后建，防冒烟重跑撞条码唯一约束
- **待办（下轮候选）**：组合拆分（组合商品）评估、Electron 打包与实机外设验证、小程序端规划"""

assert OLD in src, "锚点未命中：待办行不匹配"
src = src.replace(OLD, NEW, 1)
io.open(P, "w", encoding="utf-8", newline="\n").write(src)

chk = io.open(P, encoding="utf-8").read()
assert "V4.8.16" in chk and "JC-" in chk and "473" in chk
print("OK: 执行文件已更新至 V4.8.16")
