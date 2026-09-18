/**
 * 打印模板冒烟测试（无 Electron 依赖，node src/print/smoke.js 直接跑）
 * 校验：58/80 小票渲染、A5 字段可配、列宽不溢出
 */
const { renderReceipt, renderA5Html, cols, twoCol, DEFAULT_A5_FIELDS } = require('./templates');

const order = {
  storeName: '社区超市（测试店）', orderNo: 'XS-20260905-0001', createdAt: '2026-09-05 07:20',
  cashierName: '店长', memberName: '张三', points: 15,
  items: [
    { name: '沁泉矿泉水550ml', qty: '2', unit: '瓶', unitPrice: 1.5, amount: 3 },
    { name: '红富士苹果', qty: '1', unit: 'kg', unitPrice: 5.98, amount: 5.98 },
  ],
  goodsAmount: 8.98, promoAmount: 0.5, memberDiscount: 0, payable: 8.48,
  payments: [{ channel: '现金', amount: 8.48 }],
};

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

for (const w of [58, 80]) {
  const text = renderReceipt(order, w);
  const W = cols(w);
  ok(text.includes('单号:XS-20260905-0001'), `${w}mm：含单号`);
  ok(text.includes('促销优惠'), `${w}mm：含促销优惠行`);
  ok(text.includes('8.48'), `${w}mm：含应收金额`);
  ok(text.split('\n').every(l => [...l].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) <= W), `${w}mm：所有行不超 ${W} 列`);
}

const a5 = renderA5Html({
  title: '销售小票存档', storeName: '社区超市', orderNo: 'XS-20260905-0001', createdAt: '2026-09-05 07:20',
  items: [{ productName: '沁泉矿泉水550ml', unit: '瓶', qty: 2, unitPrice: 1.5, amount: 3, promo: 0.5, cost: 3, profit: -0.5 }],
  totals: { amount: '8.48', profit: '2.10' },
});
ok(a5.includes('@page') && a5.includes('size: A5'), 'A5：A5 页面设置');
ok(a5.includes('<th style="width:12%;text-align:right">优惠</th>'), 'A5：默认 8 列字段渲染');
// 字段可配：换 4 列
const a5b = renderA5Html({ items: [{ productName: 'X', qty: 1 }] },
  [{ key: 'productName', label: '品名', width: '70%' }, { key: 'qty', label: '数量', width: '30%' }]);
ok(a5b.includes('>品名<') && !a5b.includes('>优惠<'), 'A5：自定义列配置生效');
ok(twoCol('合计', '8.48', 32).endsWith('8.48'), 'twoCol：右对齐金额');

console.log(`\n打印模板冒烟：通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
