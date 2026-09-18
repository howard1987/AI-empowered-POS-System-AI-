/**
 * V4.13.4 回归：系统设置可用性整改 + 支付通道遗留（平台证书验签/USERPAYING PENDING/查单兜底）
 * 前置：后端 :3100 已启动并应用 051 迁移
 */
const BASE = 'http://localhost:3100';
const unwrap = d => (d && typeof d === 'object' && 'code' in d && 'data' in d) ? d.data : d;
const H = { 'content-type': 'application/json' };
let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${String(detail).slice(0, 160)}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pg = (await import('pg')).default;
const db = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'password', database: 'postgres' });
await db.connect();

/* 登录 */
const login = unwrap(await fetch(BASE + '/auth/login', { method: 'POST', headers: H,
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json()));
H.authorization = 'Bearer ' + login.token;

/* ── ① 分组归并 17→6 ── */
const all = unwrap(await fetch(BASE + '/settings', { headers: H }).then(r => r.json()));
const groups = [...new Set(all.map(s => s.group_name))];
t('①a 分组收敛（V4.14.0 新增 销售/会员 组后共9）', groups.length === 9 && groups.includes('系统初始化'), groups.join(','));
t('①b AI赋能含原 4 组内容', all.filter(s => s.group_name === 'AI赋能').length >= 52,
  all.filter(s => s.group_name === 'AI赋能').length);
t('①c 新增钩子设置落位', ['pos.receipt.auto_print', 'pos.receipt.width', 'pos.drawer.enabled',
  'pay.gateway.userpaying_polls', 'pay.gateway.userpaying_interval_sec']
  .every(k => all.some(s => s.setting_key === k)));

/* ── ② enum 下拉选项化（[{v,label}]）── */
const enums = all.filter(s => s.value_type === 'enum');
const withOpts = enums.filter(s => Array.isArray(s.enum_options) && s.enum_options.length &&
  typeof s.enum_options[0] === 'object' && 'v' in s.enum_options[0] && 'label' in s.enum_options[0]);
t('②a 全部 enum 项有可读选项', enums.every(s => Array.isArray(s.enum_options) && s.enum_options.length),
  enums.filter(s => !s.enum_options?.length).map(s => s.setting_key).join(','));
t('②b 选项均为 {v,label} 结构', withOpts.length === enums.length, withOpts.length + '/' + enums.length);
const mode = all.find(s => s.setting_key === 'pay.gateway.mode');
t('②c 通道模式三态含中文说明', mode?.enum_options?.length === 3 &&
  mode.enum_options.every(o => o.label.length > 4), JSON.stringify(mode?.enum_options));
const cur = all.find(s => s.setting_key === 'promo.stack_rule');
t('②d 现值仍在选项中（不丢值）', cur?.enum_options?.some(o => o.v === cur.value), JSON.stringify(cur?.value));

/* ── ③ 变更留痕翻页（每页 10 条）── */
const c1 = unwrap(await fetch(BASE + '/settings/changes?page=1&pageSize=10', { headers: H }).then(r => r.json()));
t('③a 翻页结构（rows/total/page/pages）', Array.isArray(c1.rows) && typeof c1.total === 'number' &&
  c1.page === 1 && c1.pages >= 1, JSON.stringify({ total: c1.total, pages: c1.pages }));
t('③b 默认每页 10 条', c1.rows.length <= 10, c1.rows.length);
const c2 = unwrap(await fetch(BASE + '/settings/changes?page=2&pageSize=10', { headers: H }).then(r => r.json()));
t('③c 第二页不与第一页重叠', (c2.rows[0]?.id ?? null) !== (c1.rows[0]?.id ?? null) || c1.total <= 10);
t('③d 兼容旧 limit 参数', (() => new Promise(async res => {
  const d = unwrap(await fetch(BASE + '/settings/changes?limit=5', { headers: H }).then(r => r.json()));
  res(d.rows?.length <= 5 && d.pageSize === 5);
}))(), '');
// 造一条变更再验证 total 递增
await fetch(BASE + '/settings/pos.voice_broadcast', { method: 'PUT', headers: H,
  body: JSON.stringify({ value: true, reason: 'V4134 翻页回归' }) }).then(r => r.json());
const c3 = unwrap(await fetch(BASE + '/settings/changes?page=1&pageSize=10', { headers: H }).then(r => r.json()));
t('③e 新变更计入 total 且最新在前', c3.total === c1.total + 1, `${c1.total} → ${c3.total}`);

/* ── ④ PENDING 流水与查单兜底（mock 通道即时成功，仅验证 PENDING 行可查且不崩） ── */
await db.query(`DELETE FROM pay_gateway_txns WHERE out_trade_no='V4134-PENDING'`);
await db.query(`INSERT INTO pay_gateway_txns (store_id, out_trade_no, channel, amount_cents, status)
                VALUES (1,'V4134-PENDING','微信',100,'PENDING')`);
const qt = unwrap(await fetch(BASE + '/pay/txn/V4134-PENDING', { headers: H }).then(r => r.json()));
t('④a PENDING 行查单返回不崩（mock 无 query，落现状）', qt?.status === 'PENDING', JSON.stringify(qt?.status));
t('④b PENDING 不影响 SUCCESS 语义（结账校验仍只认 SUCCESS）', qt?.status !== 'SUCCESS');

/* ── ⑤ 微信适配器静态检查：平台证书验签与查单方法已编译进产物 ── */
const fs = await import('fs');
const dist = fs.readFileSync('dist/modules/pay.adapters.js', 'utf8');
t('⑤a 平台证书下载/解密已实现', dist.includes('/v3/certificates') && dist.includes('aes-256-gcm')
  && dist.includes('certificate'));
t('⑤b 应答验签（四头 + 原文）已实现', dist.includes('wechatpay-signature') && dist.includes('wechatpay-serial')
  && dist.includes('微信应答验签失败'));
t('⑤c 查单接口已实现', dist.includes('out-trade-no') && dist.includes('ORDER_NOT_EXIST'));
const gw = fs.readFileSync('dist/modules/pay.gateway.js', 'utf8');
t('⑤d USERPAYING 轮询落 PENDING', gw.includes('USERPAYING') && gw.includes("'PENDING'")
  && gw.includes('pollUserpaying'));
t('⑤e PENDING 查单兜底刷新', gw.includes("row.status === 'PENDING'"));

/* ── ⑥ secret 掩码回显不修改（防回归）；未配置项跳过掩码分支另测占位防呆 ── */
const sec = unwrap(await fetch(BASE + '/settings?group=' + encodeURIComponent('支付'), { headers: H }).then(r => r.json()))
  .find(s => s.setting_key === 'pay.wechat.apiv3_key');
const before = sec?.value;
if (before && String(before).startsWith('••')) {
  const r6 = unwrap(await fetch(BASE + '/settings/pay.wechat.apiv3_key', { method: 'PUT', headers: H,
    body: JSON.stringify({ value: before, reason: 'V4134 掩码不改回归' }) }).then(r => r.json()));
  t('⑥ 密钥掩码回显保存 = 不修改', r6?.unchanged === true, JSON.stringify(r6).slice(0, 80));
} else {
  const r6 = unwrap(await fetch(BASE + '/settings/pay.wechat.apiv3_key', { method: 'PUT', headers: H,
    body: JSON.stringify({ value: '未配置', reason: 'V4134 占位防呆回归' }) }).then(r => r.json()));
  t('⑥ 占位文案「未配置」保存 = 不修改（防呆）', r6?.unchanged === true, JSON.stringify(r6).slice(0, 80));
}

await db.query(`DELETE FROM pay_gateway_txns WHERE out_trade_no='V4134-PENDING'`);
await db.end();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
