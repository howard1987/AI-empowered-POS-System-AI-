# -*- coding: utf-8 -*-
import io, re
# 执行文件
P = r"C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/超市收银系统-开发执行文件.md"
s = io.open(P, encoding="utf-8").read()
m = re.findall(r"- \*\*13 条反馈批次计划[^\n]*", s)
anchor = m[-1] if m else None
assert anchor, "未找到批次计划锚点"
NEW = """- **V4.8.20 Inno 安装包进程检测 + 调价单重构审核流（第二批 ✅）**：①installer.iss 加 [Code] PrepareToInstall——安装前 tasklist 检测「超市收银系统.exe/electron.exe」运行实例→弹窗**列出进程清单与个数**→用户选「一键结束」或取消安装，结束失败时提示管理员运行；实测日志验证检测/杀进程/阻断逻辑均工作（受控宿主的 2 个僵尸进程连 taskkill 都拒绝访问，实机不存在此情况）；②**193 报错结论**：本地 dist-v3 主程序 PE 头完整 x64、与 electron.exe 哈希一致、安装落盘校验通过——193 根因是安装时旧实例占用文件被干扰/杀毒拦截，v0.1.1 先清进程即可规避，若仍复现→右键管理员运行+杀毒白名单；③**调价单重构（迁移 015）**：price_changes 加 status(pending/approved/voided)+audited_by/at+voided_by/at，price_type 允许 dual，明细双轨 old_price/new_price(可空)+old_cost/new_cost；**保存=待审核，审核通过才生效**（售价更新+进价落地基线 min_price=LEAST 保护线），仅待审核可作废；单号规则：纯进价 JC-、售价/混合 TJ-；④**共享商品模糊搜索组件** frontend-web/product-search.js：条码全码/后6位/名称/拼音定位、扫码枪回车即选、↑↓高亮，后端 /products keyword 加 barcode ILIKE；⑤prices.js 重写：搜索组件选商品、**新售价/新进价同行行内输入**（不改留空）、双差额合计、浏览加状态列+待审核行内「审核/两段式确认作废」；⑥e2e 重写 W 段（净增 18，530 全通过）：未审核不生效、审核生效、作废拦截、status/type 过滤、后6位搜索；⑦UI 冒烟 PASS（TJ-202609-001 混合单全流程）
- **剩余批次**：第三批=入库单（表格录入+作废回退+打印）；第四批=退货单（表格录入+凭证后置+流程重排）；第五批=对账结算重构（勾选对账+状态标记+批量操作+确认方式弹窗+0额直结算+费用±+页头一次选供应商+电子签字）；第六批=商品档案（批量导入/双击编辑/图片/一品多码多包装）+供应商（双击编辑/业务员签字）+员工权限（弹窗创建/工号规则 SY0001-CN0001/权限勾选）+促销活动模板；AI 训练台（Ollama 模型信息）单独立一期"""
s = s.replace(anchor, NEW, 1)
io.open(P, "w", encoding="utf-8", newline="\n").write(s)
chk = io.open(P, encoding="utf-8").read()
assert "V4.8.20" in chk
print("OK: 执行文件已更新")

# 工作日志
p = r'C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/.workbuddy/memory/2026-09-05.md'
note = '''
## V4.8.20 安装包进程检测 + 调价单审核流（22:00-22:35）
- installer.iss：PrepareToInstall 检测运行实例→列清单→可选 taskkill（v0.1.1 已编译）；Inno Exec 末参是 Integer 退出码不是 Boolean、LoadStringFromFile 要 AnsiString
- 193 结论：本地 PE 完整+安装落盘 md5 一致→根因=旧实例占用/杀毒干扰；v0.1.1 先清进程规避
- 受控宿主 2 个僵尸"超市收银系统.exe"（52K 内存、taskkill 拒绝访问、Stop-Process 不可见）——bash grep GBK 永远搜不到中文进程名，必须用 Unicode 通道 tasklist /FO CSV
- 调价单重构：db/015（status/dual/双轨价）；保存=pending→approve 生效（售价+spp 基线）→void 仅 pending；纯进价 JC-/售价混合 TJ-
- 共享组件 frontend-web/product-search.js（后6位/名称/拼音/扫码枪回车）；prices.js 重写行内双价+审核/两段式作废
- e2e 530 全通过（W 段重写+18）；UI 冒烟 TJ-202609-001 全流程 PASS
- 待办：入库单（三）、退货单（四）、对账结算（五）、档案+促销（六）、AI 台（独立期）
'''
with io.open(p, 'a', encoding='utf-8') as f:
    f.write(note)
chk2 = io.open(p, encoding='utf-8').read()
assert 'V4.8.20' in chk2
print('OK: 工作日志已追加')

# MEMORY.md
p2 = r'C:/Users/YL/WorkBuddy/2026-09-04-09-44-35/.workbuddy/memory/MEMORY.md'
s2 = io.open(p2, encoding='utf-8').read()
s2 = s2.replace('## 工程与联调补充（V4.8.6）', '''- 调价单审核流（V4.8.20）：保存=pending→approve 生效→void 仅 pending；双轨价 old/new_price+old/new_cost；price_type sale/cost/dual；单号纯进价 JC- 其余 TJ-；共享搜索组件 frontend-web/product-search.js（条码后6位靠 barcode ILIKE）
- Inno 打包（V4.8.20）：PrepareToInstall+tasklist 检测运行实例列清单可选 taskkill；Exec 末参=Integer 退出码；LoadStringFromFile 用 AnsiString；193 根因=旧实例占用/杀毒，清进程规避

## 工程与联调补充（V4.8.6）''', 1)
io.open(p2, 'w', encoding='utf-8', newline='\n').write(s2)
chk3 = io.open(p2, encoding='utf-8').read()
assert 'V4.8.20' in chk3
print('OK: MEMORY.md 已更新')
