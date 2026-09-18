# -*- coding: utf-8 -*-
"""V4.8.15 显示修复：差额列双¥ + 生效日期 DATE 偏移一天"""
import io

p = 'frontend-web/screens/prices.js'
s = io.open(p, encoding='utf-8').read()

# 1. 差额列：money() 已含 ¥，去掉手写 ¥
o1 = "${Number(c.diff_total) >= 0 ? '+' : ''}¥${money(c.diff_total)}"
n = s.count(o1)
assert n == 1, n
s = s.replace(o1, "${(Number(c.diff_total) >= 0 ? '+' : '−')}${money(c.diff_total)}")

# 2. 生效日期：dt() 已做本地时区转换（DATE 串原样返回、带Z的ISO转本地），再取前 10 位
o2 = '<td>${String(c.effective_date).slice(0, 10)}</td>'
n2 = s.count(o2)
assert n2 == 1, n2
s = s.replace(o2, '<td>${dt(c.effective_date).slice(0, 10)}</td>')

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('DISPLAY FIXED')
