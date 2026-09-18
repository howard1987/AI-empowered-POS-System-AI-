const BASE = 'http://localhost:3100';
const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json());
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + login.data.token };
const call = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
const lst = await call('GET', '/purchase/orders');
const rows = lst.data?.items || lst.data || [];
console.log('n=', rows.length);
console.log(JSON.stringify(rows[0], null, 1).slice(0, 800));
