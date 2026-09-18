# -*- coding: utf-8 -*-
"""V4.8.15 修复：调价端点挪顶层前缀 price-changes（避开 products @Get(':id') 路由吞没）"""
import io

p = 'backend/src/modules/products.module.ts'
s = io.open(p, encoding='utf-8').read()
OLD = "@Controller('products')\nclass PriceChangeController {"
assert s.count(OLD) == 1, s.count(OLD)
s = s.replace(OLD, "@Controller('price-changes')\nclass PriceChangeController {")
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)

p2 = 'frontend-web/screens/prices.js'
s2 = io.open(p2, encoding='utf-8').read()
n = s2.count('/products/price-changes')
assert n == 5, n
s2 = s2.replace('/products/price-changes', '/price-changes')
io.open(p2, 'w', encoding='utf-8', newline='\n').write(s2)
print('ROUTE MOVED')
