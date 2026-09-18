const BASE = 'http://localhost:3100';
const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json());
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + login.data.token };
const call = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
const prods = await call('GET', '/products?size=5');
const p = (prods.data?.items || prods.data || [])[0];
const po = await call('POST', '/purchase/orders', { items: [{ productId: Number(p.id), orderQty: 1 }], source: '库存缺货' });
console.log('created id=', JSON.stringify(po.data?.id), po.data?.poNo);
const lst = await call('GET', '/purchase/orders');
const rows = lst.data?.items || lst.data || [];
console.log('list ids=', rows.map(o => o.id + ':' + o.po_no + ':' + o.source_label).join(' | '));
const hit = rows.find(o => Number(o.id) === Number(po.data.id));
if (hit) console.log('HIT label=', hit.source_label); else console.log('NOT IN LIST');
await call('DELETE', '/purchase/orders/' + po.data.id);
