/* V4.13.3 支付设置 + 真通道适配器回归（设计文档 14.22）
 * 覆盖：secret 加密落库/脱敏返回/掩码与空值不覆盖/留痕无明文 ·
 *       mode=real 渠道未启用 40905 / 配置缺失 40904 / 不可达网关 FAIL 落库 ·
 *       支付宝同构验证 · 恢复 mock 正常
 * 运行：node tests/verify-v4133-paycfg.mjs   （需后端 :3100 + 联调库 54329）
 */
import { Client } from 'pg';
import { generateKeyPairSync } from 'crypto';

const BASE = 'http://localhost:3100';
const PG = { host: 'localhost', port: 54329, user: 'postgres', password: 'password', database: 'postgres' };
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '✓' : '✗'), name, extra); };
const unwrap = d => (d && typeof d === 'object' && 'code' in d && 'data' in d) ? d.data : d;

const pg = new Client(PG);
await pg.connect();

const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ empNo: 'ADMIN', password: 'admin123' }) }).then(r => r.json());
const tk = unwrap(login)?.token;
if (!tk) { console.error('登录失败', JSON.stringify(login).slice(0, 200)); process.exit(1); }
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tk };

const put = (key, value) => fetch(BASE + '/settings/' + key, { method: 'PUT', headers: H,
  body: JSON.stringify({ value, reason: 'V4133回归' }) }).then(r => r.json());
const getGroup = () => fetch(BASE + '/settings?group=' + encodeURIComponent('支付'), { headers: H }).then(r => r.json());

/* ── ⓪ 重置可清空配置项（secret 设计上不可清空，用 string 项判缺配置）── */
for (const k of ['pay.wechat.enabled', 'pay.alipay.enabled']) await put(k, false);
for (const k of ['pay.wechat.mchid', 'pay.wechat.appid', 'pay.wechat.cert_serial', 'pay.alipay.app_id']) await put(k, '');

/* 测试 RSA 密钥（PEM 全文合法，私钥格式校验可过；网关指向不可达端口测失败路径） */
const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/* ── ① 支付分组设置项就绪 ── */
let rows = unwrap(await getGroup());
t('① 支付分组 ≥13 项设置（V4.13.4 起新增查单轮询 2 项）', rows?.length >= 13, `n=${rows?.length}`);
const secRow = rows.find(r => r.setting_key === 'pay.wechat.apiv3_key');
t('①b secret 项脱敏返回（未配置或 •••• 尾号）', secRow?.value === '未配置' || String(secRow?.value).startsWith('••••'), JSON.stringify(secRow?.value));

/* ── ② secret 写入：加密落库，接口只回脱敏 ── */
const SEC1 = 'test-apiv3-key-1234567890abcd';
const r1 = unwrap(await put('pay.wechat.apiv3_key', SEC1));
const db1 = (await pg.query(`SELECT value FROM system_settings WHERE setting_key='pay.wechat.apiv3_key'`)).rows[0].value;
t('② 写入后返回脱敏（••••尾号）', typeof r1?.value === 'string' && r1.value.startsWith('••••') && r1.value.endsWith(SEC1.slice(-4)),
  `${r1?.value}`);
t('②b 落库为 enc:v1: 密文（无明文）', String(db1).startsWith('enc:v1:'), String(db1).slice(0, 24) + '…');
rows = unwrap(await getGroup());
t('②c 列表不含明文密钥', !JSON.stringify(rows).includes(SEC1));

/* ── ③ 掩码回显/空值 = 不修改 ── */
const rMask = unwrap(await put('pay.wechat.apiv3_key', r1.value));           // 把脱敏值原样传回
const dbMask = (await pg.query(`SELECT value FROM system_settings WHERE setting_key='pay.wechat.apiv3_key'`)).rows[0].value;
t('③ 掩码回传 = unchanged 且密文不变', rMask?.unchanged === true && dbMask === db1, JSON.stringify(rMask));
const rEmpty = unwrap(await put('pay.wechat.apiv3_key', ''));
const dbEmpty = (await pg.query(`SELECT value FROM system_settings WHERE setting_key='pay.wechat.apiv3_key'`)).rows[0].value;
t('③b 空值 = unchanged 且密文不变', rEmpty?.unchanged === true && dbEmpty === db1);

/* ── ④ 覆盖更新：新密文 + 脱敏同步 ── */
const SEC2 = 'test-apiv3-key-FFFFFFFF9999zzzz';
unwrap(await put('pay.wechat.apiv3_key', SEC2));
const db2 = (await pg.query(`SELECT value FROM system_settings WHERE setting_key='pay.wechat.apiv3_key'`)).rows[0].value;
t('④ 覆盖后新密文 ≠ 旧密文', db2 !== db1 && String(db2).startsWith('enc:v1:'));

/* ── ⑤ 留痕与审计无明文 ── */
const logs = (await pg.query(`SELECT old_value::text AS o, new_value::text AS n FROM setting_change_logs WHERE setting_key='pay.wechat.apiv3_key' ORDER BY id DESC LIMIT 5`)).rows;
const logTxt = JSON.stringify(logs);
t('⑤ 留痕只含脱敏值（无明文）', !logTxt.includes(SEC1) && !logTxt.includes(SEC2) && logTxt.includes('••••'), logTxt.slice(0, 120));
const audits = (await pg.query(`SELECT detail::text AS c FROM audit_logs WHERE action='settings.change' AND detail::text LIKE '%apiv3_key%' ORDER BY id DESC LIMIT 5`)).rows;
t('⑤b 审计无明文', !JSON.stringify(audits).includes(SEC1) && !JSON.stringify(audits).includes(SEC2));

/* ── ⑥ mode=real：渠道未启用 → 40905 ── */
await put('pay.gateway.mode', 'real');
const code16 = () => '13' + String(Date.now()) + Math.floor(Math.random() * 10);
const mp1 = await fetch(BASE + '/pay/micropay', { method: 'POST', headers: H,
  body: JSON.stringify({ authCode: code16(), amount: 1 }) }).then(r => r.json());
t('⑥ real + 微信渠道未启用 → 40905', mp1?.code === 40905, JSON.stringify(mp1).slice(0, 110));

/* ── ⑦ 启用但配置缺失 → 40904 ── */
await put('pay.wechat.enabled', true);
const mp2 = await fetch(BASE + '/pay/micropay', { method: 'POST', headers: H,
  body: JSON.stringify({ authCode: code16(), amount: 1 }) }).then(r => r.json());
t('⑦ real + 微信配置缺失 → 40904', mp2?.code === 40904, JSON.stringify(mp2).slice(0, 130));
/* ── ⑧ 配置齐 + 不可达网关 → FAIL 落库（不抛 500）── */
await put('pay.wechat.mchid', '1900000001');
await put('pay.wechat.appid', 'wx8888888888888888');
await put('pay.wechat.cert_serial', 'TESTSERIAL0001');
await put('pay.wechat.private_key', privPem);
await put('pay.wechat.gateway', 'http://127.0.0.1:9');
const mp3 = unwrap(await fetch(BASE + '/pay/micropay', { method: 'POST', headers: H,
  body: JSON.stringify({ authCode: code16(), amount: 1 }) }).then(r => r.json()));
t('⑧ 真通道不可达 → success=false（非 500）', mp3?.code === undefined && mp3?.success === false && !!mp3?.failMsg,
  JSON.stringify(mp3).slice(0, 140));
const gwRow = (await pg.query(`SELECT status, fail_code FROM pay_gateway_txns WHERE out_trade_no=$1`, [mp3?.outTradeNo])).rows[0];
t('⑧b 失败落 FAIL 流水', gwRow?.status === 'FAIL', JSON.stringify(gwRow || {}));

/* ── ⑨ 支付宝同构：启用 + 配置缺失 → 40904 ── */
const aliCode = () => '28' + String(Date.now()) + Math.floor(Math.random() * 10);
await put('pay.alipay.enabled', true);
const mp4 = await fetch(BASE + '/pay/micropay', { method: 'POST', headers: H,
  body: JSON.stringify({ authCode: aliCode(), amount: 1 }) }).then(r => r.json());
t('⑨ 支付宝配置缺失 → 40904', mp4?.code === 40904, JSON.stringify(mp4).slice(0, 120));
await put('pay.alipay.app_id', '2021000000000000');
await put('pay.alipay.private_key', privPem);
await put('pay.alipay.public_key', pubPem);
await put('pay.alipay.gateway', 'http://127.0.0.1:9');
const mp5 = unwrap(await fetch(BASE + '/pay/micropay', { method: 'POST', headers: H,
  body: JSON.stringify({ authCode: aliCode(), amount: 1 }) }).then(r => r.json()));
t('⑨b 支付宝不可达 → FAIL 非异常', mp5?.code === undefined && mp5?.success === false, JSON.stringify(mp5).slice(0, 120));

/* ── ⑩ 恢复 mock：一切如常；渠道 enabled 复位 ── */
await put('pay.gateway.mode', 'mock');
await put('pay.wechat.enabled', false);
await put('pay.alipay.enabled', false);
const mp6 = unwrap(await fetch(BASE + '/pay/micropay', { method: 'POST', headers: H,
  body: JSON.stringify({ authCode: code16(), amount: 1 }) }).then(r => r.json()));
t('⑩ 恢复 mock 扣款正常', mp6?.success === true && mp6?.channel === '微信', `txn=${mp6?.transactionId ?? '—'}`);

console.log(`\n──── V4.13.3 支付设置+真适配器回归：${pass} 通过 / ${fail} 失败 ────`);
await pg.end();
process.exit(fail ? 1 : 0);
