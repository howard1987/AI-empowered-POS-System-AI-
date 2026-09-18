# -*- coding: utf-8 -*-
"""V4.8.15 修复2：PriceChangeController 方法装饰器去掉重复的 price-changes 前缀"""
import io, re

p = 'backend/src/modules/products.module.ts'
s = io.open(p, encoding='utf-8').read()

# 只在 PriceChangeController 类块内替换（从其 @Controller 到 @Module 之间）
start = s.index("@Controller('price-changes')")
end = s.index('@Module(', start)
block = s[start:end]
n1 = block.count("@Get('price-changes')"); n2 = block.count("@Get('price-changes/:id')"); n3 = block.count("@Post('price-changes')")
assert (n1, n2, n3) == (1, 1, 1), (n1, n2, n3)
block = block.replace("@Get('price-changes')", "@Get()")
block = block.replace("@Get('price-changes/:id')", "@Get(':id')")
block = block.replace("@Post('price-changes')", "@Post()")
s = s[:start] + block + s[end:]
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('METHOD PATHS FIXED')
