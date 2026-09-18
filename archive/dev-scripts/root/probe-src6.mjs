const BASE = 'http://localhost:3100';
const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json());
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + login.data.token };
const call = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
const prods = await call('GET', '/products?size=5');
const p = (prods.data?.items || prods.data || [])[0];
const po = await call('POST', '/purchase/orders', { items: [{ productId: Number(p.id), orderQty: 1 }], source: '库存缺货' });
console.log('created', po.data?.id);
for (let i = 0; i < 3; i++) {
  await new Promise(r => setTimeout(r, 500));
  const lst = await call('GET', '/purchase/orders');
  const rows = lst.data?.items || lst.data || [];
  console.log('try', i, 'ids=', rows.map(o => o.id).join(','));
}
const lst = await call('GET', '/purchase/orders');
const rows = lst.data?.items || lst.data || [];
const hit = rows.find(o => Number(o.id) === Number(po.data.id));
console.log('hit=', hit ? JSON.stringify({ source: hit.source, label: hit.source_label }) : 'NONE');
await call('DELETE', '/purchase/orders/' + po.data.id);
