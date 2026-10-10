import { Module, Controller, Post, Get, Put, Delete, Body, HttpCode, Param, ParseIntPipe, Query, Req } from '@nestjs/common';
import { RequirePerms } from '../common/auth';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { q, q1, tx, cx, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, JWT_SECRET, Public, clearAuthStateCache } from '../common/auth';
import { lanIPv4, MDNS_HOST } from '../common/cert';
import { q as qSetting } from '../common/db';
import { allow, failAndLock, lockedFor, clearFailures, clientIp } from '../common/ratelimit';
import { detectDeviceType, resolveDeviceName, DEVICE_TYPE_CN } from '../common/device-name';  // V5.0.11d 设备名/类型自动识别
import { notifyStaff } from '../common/notices';
import { checkPasswordPolicy } from '../common/password-policy';

async function getSetting(key: string, fb: any = null): Promise<any> {
  const r = await qSetting(`SELECT value FROM system_settings WHERE setting_key=$1`, [key]);
  return r.length ? r[0].value : fb;
}

/** V4.14.6 R8：密码强度策略实现已抽到 common/password-policy.ts，员工端与会员端共用同一策略 */

// ─── V4.24.0：超管判定角色化（不再写死工号 ADMIN）───
//  背景：老板要求「管理员账号不写死，安装后由用户自定义工号」。
//  规则：绑定系统角色「超级管理员」即为超管 → JWT 打 '*' 通配、设备授权豁免。
//  兼容：历史 ADMIN 账号本就绑定了该角色，因此行为不变；`emp_no==='ADMIN'` 不再参与判定。
async function isSuperAdmin(empId: number | string): Promise<boolean> {
  const r = await q1(
    `SELECT 1 AS ok FROM employee_roles er JOIN roles ro ON ro.id = er.role_id
      WHERE er.employee_id = $1 AND ro.name = '超级管理员' LIMIT 1`, [Number(empId)]);
  return !!r;
}
/** V5.0.18g：员工是否持有某权限点 = (角色权限 ∪ 本机 allow) − deny（表缺失回退纯角色查询） */
async function hasPermCode(empId: number | string, code: string): Promise<boolean> {
  try {
    const r = await q1(
      `SELECT 1 AS ok FROM permission_points pp
        WHERE pp.code=$2
          AND ((pp.id IN (SELECT rp.permission_id FROM employee_roles er
                           JOIN role_permissions rp ON rp.role_id = er.role_id
                          WHERE er.employee_id=$1)
             OR pp.id IN (SELECT permission_id FROM employee_perm_overrides
                           WHERE employee_id=$1 AND mode='allow'))
          AND pp.id NOT IN (SELECT permission_id FROM employee_perm_overrides
                             WHERE employee_id=$1 AND mode='deny')) LIMIT 1`, [Number(empId), code]);
    return !!r;
  } catch (e: any) {
    if (String(e?.code) !== '42P01') throw e;   // 表未建（未迁移）→ 回退纯角色
    const r = await q1(
      `SELECT 1 AS ok FROM employee_roles er
         JOIN role_permissions rp ON rp.role_id = er.role_id
         JOIN permission_points pp ON pp.id = rp.permission_id
        WHERE er.employee_id=$1 AND pp.code=$2 LIMIT 1`, [Number(empId), code]);
    return !!r;
  }
}
/**
 * V5.0.0 连锁（方案 §2.6.1）：解析员工「数据范围」，登录时一次、打入 JWT（与 perms 同策略）
 *   · 多角色取最宽：任一角色 all → all；否则任一 region → region；否则 self
 *   · employees.data_scope_override 优先（区域经理等个例覆盖）
 *   · region 预解析出该区域全部门店 id 集合（ss），使请求内零查库
 *   ⚠️ 迁移 104 已把「超级管理员」角色置为 hq+all → 老板账号改造后仍全权（零回归）
 */
async function resolveScope(emp: any): Promise<{ ds: 'self' | 'region' | 'all'; ss: number[] | null; hq: boolean }> {
  let rows: any[] = [];
  try {
    rows = await q<any>(
      `SELECT r.scope_type, r.data_scope, r.region
         FROM employee_roles er JOIN roles r ON r.id = er.role_id
        WHERE er.employee_id = $1`, [Number(emp.id)]);
  } catch { rows = []; }   // 未迁移（缺列）→ 回落全权，绝不阻塞登录
  let ds: 'self' | 'region' | 'all' =
    rows.some(r => r.data_scope === 'all') ? 'all'
      : rows.some(r => r.data_scope === 'region') ? 'region' : 'self';
  const ov = emp.data_scope_override;
  if (ov === 'all' || ov === 'region' || ov === 'self') ds = ov;
  const hq = rows.some(r => r.scope_type === 'hq') || ds === 'all';

  let ss: number[] | null = null;
  if (ds === 'region') {
    const regions = [...new Set(rows.filter(r => r.data_scope === 'region' && r.region).map(r => r.region))];
    try {
      const srows = regions.length
        ? await q<any>(`SELECT id FROM stores WHERE region = ANY($1) AND COALESCE(status,1) <> 2`, [regions])
        : [];
      ss = srows.map(r => Number(r.id));
    } catch { ss = []; }
  } else if (ds === 'self') {
    ss = [Number(emp.store_id)];
  }
  return { ds, ss, hq };
}

/** 首个管理员线索（bootstrap 检测用；只回工号+姓名，不外传任何凭证） */
async function findAdminHint(): Promise<{ empNo: string; name: string } | null> {
  const r = await q1<any>(
    `SELECT e.emp_no, e.name FROM employees e
       JOIN employee_roles er ON er.employee_id = e.id
       JOIN roles ro ON ro.id = er.role_id
      WHERE ro.name = '超级管理员' AND e.status = '在职'
      ORDER BY e.id LIMIT 1`);
  return r ? { empNo: String(r.emp_no), name: String(r.name) } : null;
}

// ─── 扫码登录票据（内存态：5 分钟一次性，重启即失效）───
const qrTickets = new Map<string, { empId: number; storeId: number; exp: number }>();

/* ══════════════ V5.0.11 设备授权辅助（P0 配额 + P1 硬件身份）══════════════ */

/** 客户端上报的设备凭据 */
type DeviceCtx = {
  code?: string;        // 设备码（PC-/MB- 前缀或旧随机码）
  type?: string;        // pc / mobile / pad
  pubkey?: string;      // P1：base64 SPKI 公钥
  sig?: string;         // P1：base64 签名
  ts?: number;          // P1：签名时的毫秒时间戳（防重放）
  nonce?: string;       // P1：一次性随机串（防重放）
  recovery?: string;    // 应急恢复码（仅当设备被挡时前端才带）
  pair?: string;        // 配对码（V5.0.11b：仅当设备「待授权」且用户输入了配对码时才带）
  name?: string;        // 设备显示名（V5.0.11e：APK 可自报 Android 设备名，如「vivo X100」）
};

/** 角色 → 设备配额档位（决策 1-C，可在后台「设备管理」调整） */
const ROLE_LIMIT_TIER: Array<{ re: RegExp; key: 'pos.device.limit.cashier' | 'pos.device.limit.manager'; dflt: number }> = [
  { re: /收银员|库管|仓管/, key: 'pos.device.limit.cashier', dflt: 1 },
  { re: /店长|财务|经理|管理员|总经理|老板/, key: 'pos.device.limit.manager', dflt: 2 },
];

/** 员工的角色名列表 */
async function roleNamesOf(empId: number | string): Promise<string[]> {
  const r = await q<{ name: string }>(
    `SELECT r.name FROM roles r JOIN employee_roles er ON er.role_id=r.id WHERE er.employee_id=$1`, [Number(empId)]);
  return r.map(x => String(x.name));
}

/** 该员工的设备配额（多角色取最宽松档；无匹配角色按收银员档，但至少 1 台） */
async function deviceQuotaOf(empId: number | string, roles: string[]): Promise<number> {
  let quota = 0;
  for (const r of roles) {
    for (const t of ROLE_LIMIT_TIER) {
      if (t.re.test(r)) { quota = Math.max(quota, Number(await getSetting(t.key, t.dflt)) || t.dflt); }
    }
  }
  if (quota === 0) quota = Math.max(1, Number(await getSetting('pos.device.limit.cashier', 1)) || 1);
  return quota;
}

/** 设备签名载荷：客户端与服务端必须逐字节一致（改动任一侧都会导致验签失败） */
function deviceSignPayload(d: DeviceCtx, empNo: string): string {
  return `${empNo}|${String(d.code || '')}|${Number(d.ts) || 0}|${String(d.nonce || '')}`;
}

/** 验签：base64(SPKI 公钥) + base64(签名)，RSA-SHA256（PKCS#1 v1.5）
 *  Android Keystore 的 SHA256withRSA 与 WebCrypto RSASSA-PKCS1-v1_5 产出的格式 Node 可直接验。 */
function verifyDeviceSig(pubkeyB64: string, sigB64: string, payload: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(pubkeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.from(payload, 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

/** 防重放：nonce 5 分钟内不可复用（登录请求量级小，内存表足够；多实例部署需换 Redis） */
const usedNonces = new Map<string, number>();
function nonceFresh(nonce: string): boolean {
  const now = Date.now();
  for (const [k, t] of usedNonces) if (now - t > 5 * 60_000) usedNonces.delete(k);
  if (!nonce) return false;
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, now);
  return true;
}

/** 本机回环地址判定：127.0.0.0/8、::1、IPv4-mapped 的 127.x。
 *  来自这里面的请求＝进程就跑在这台服务器上，具备本机管理员权限，
 *  设备授权（防的是「拿别人设备码/在别人手机上登录」）对它没有意义。 */
function isLoopbackIp(ip: string): boolean {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return false;
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = m ? m[1] : s;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** 应急恢复码：环境变量 DEVICE_RECOVERY_CODE 优先，其次后台「设备管理」里的设置项。
 *  定长哈希比较，避免按字符提前返回而泄露前缀。 */
async function recoveryCodeOk(input: string): Promise<boolean> {
  const code = String(input || '').trim();
  if (!code) return false;
  const fromEnv = String(process.env.DEVICE_RECOVERY_CODE || '').trim();
  const stored = fromEnv ? fromEnv : String(await getSetting('pos.device.recovery.hint', '') || '').trim();
  if (!stored) return false;
  const a = crypto.createHash('sha256').update(stored).digest();
  const b = crypto.createHash('sha256').update(code).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ─────────── 配对码（V5.0.11b）───────────
 * 取代「管理员按设备码手工审批」：管理员为某台待授权设备生成一个短码，
 * 员工在登录框输入该码 → 配对成功 → 该设备转为已授权 → 登录放行。
 * 安全前提：配对请求走的是正常登录接口，工号密码在此之前已校验通过；
 * 且设备记录本身也只有凭据校验通过后才会被登记为「待授权」。
 * 故配对码是凭证之上的第二道确认，而不是一个可匿名换取授权的独立通道。 */

/** 配对码字母表：去掉 0/O/1/I/L 等易混淆字符，减少电话/微信转抄出错 */
const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAIR_CODE_LEN = 8;

/** 生成随机配对码（无外部依赖，crypto.randomInt 均匀取值） */
export function genPairCode(len = PAIR_CODE_LEN): string {
  let s = '';
  for (let i = 0; i < len; i++) s += PAIR_ALPHABET[crypto.randomInt(0, PAIR_ALPHABET.length)];
  return s;
}

/** 定长不比较（与 recoveryCodeOk 同理，避免按字符提前返回泄露前缀） */
function pairCodeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(String(a || '').trim().toUpperCase()).digest();
  const hb = crypto.createHash('sha256').update(String(b || '').trim().toUpperCase()).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 配对码是否仍可使用：未过期且未用尽。返回失败原因（成功时为 ''）。 */
export function pairCodeUsable(row: any, now = Date.now()): string {
  if (!row || !row.pair_code) return '该设备没有待用的配对码，请联系管理员生成';
  if (row.pair_expires_at && new Date(row.pair_expires_at).getTime() < now) return '配对码已过期，请联系管理员重新生成';
  const max = Number(row.pair_max_uses) || 0;
  if (max > 0 && Number(row.pair_used || 0) >= max) return '配对码使用次数已用尽，请联系管理员重新生成';
  return '';
}

/** 从登录请求体提取设备凭据。
 *  兼容两种形态：① 旧客户端只传扁平的 deviceCode；② 新客户端传 device:{code,type,pubkey,sig,ts,nonce}。
 *  应急恢复码 recovery 允许放在顶层——前端仅在收到 40307（设备未授权）后才带它重试。 */
function devCtxOf(body: any): DeviceCtx {
  const d = (body && body.device) || {};
  const pick = (k: string) => d[k] ?? (body ? body[k] : undefined);
  return {
    code: String(pick('code') ?? pick('deviceCode') ?? '').trim(),
    type: String(pick('type') ?? '').trim(),
    pubkey: String(pick('pubkey') ?? '').trim(),
    sig: String(pick('sig') ?? '').trim(),
    ts: Number(pick('ts') ?? 0) || 0,
    nonce: String(pick('nonce') ?? '').trim(),
    recovery: String(pick('recovery') ?? '').trim(),
    pair: String(pick('pair') ?? pick('pairCode') ?? '').trim(),
    name: String(pick('name') ?? pick('deviceName') ?? '').trim().slice(0, 60),
  };
}

// ─── Service ───
class AuthService {
  /* V5.0.11 设备授权加固。修复的真实缺陷：此前 pos.device.auth 默认关 + 超管无条件豁免
   * + 设备码由前端自生成（可任意伪造） ⇒ 任何人知道账密即可在任意设备登录。
   * 现在：开关默认开、超管不豁免（改由应急恢复码兜底）、设备码须通过公钥验签（P1）。
   * dev: { code, type, pubkey, sig, ts, nonce, recovery } */
  private async checkDeviceAuth(emp: any, dev: DeviceCtx, ua: string, ip: string) {
    const on = await getSetting('pos.device.auth', true);
    if (on === false || on === 'false' || on === '0' || on === 0) return;   // 开关关闭才跳过

    // ── V5.0.11c 防引导死锁：回环地址豁免 ──
    // 设备授权会形成死锁：要授权设备得先登录，要登录得先被授权。
    // 唯一能无条件打开后台的，是「人就在服务器这台机器上」——那本来就已有本机管理员权限，
    // 再要求它先注册设备码没有意义，反而把管理员锁在门外。
    // 仅对 127.0.0.0/8 与 ::1 生效；局域网里其它机器（手机、同事电脑）依然必须走授权。
    if (isLoopbackIp(ip) && (await getSetting('pos.device.auth.loopback.bypass', true)) !== false) {
      const c = String(dev.code || '').trim().toUpperCase();
      // 回环 = 就在服务器这台机器上，直接取本机计算机名（Windows 上就是「计算机名」，如 YL）。
      // 这是浏览器永远拿不到的信息，只有服务端读得到，对「哪台是自己的电脑」很关键。
      let hostName = '';
      try { hostName = String(require('os').hostname() || '').slice(0, 60); } catch { /* 取不到就算了 */ }
      if (c) {
        const d = await q1<any>(`SELECT id, status FROM pos_devices WHERE store_id=$1 AND device_code=$2`,
          [emp.store_id, c]);
        if (d) {
          // V5.0.15 修复：此前回环分支在「已停用」判断之前就 return，
          // 导致本机（127.x/::1）登录时即使该设备已被管理员停用也能登进去 —— 停用形同虚设。
          // 「已停用」是管理员显式收回权限的意图，任何来源（含回环）都必须拒绝。
          if (String(d.status) === '已停用') {
            await audit(emp.store_id, emp.id, '系统', 'pos_device.loopback_denied', 'pos_device', Number(d.id),
              { code: c, ip, reason: '已停用' });
            throw new BizException(40308, '本机授权已被停用，请联系管理员（设备码 ' + c + '）', 403);
          }
          // 「待授权」直接转正（这正是本条豁免要解决的死锁）
          await q(`UPDATE pos_devices SET last_seen_at=now(), last_ip=$2,
                       status = CASE WHEN status='待授权' THEN '已授权' ELSE status END,
                       device_name=COALESCE(NULLIF(device_name,''), $3)
                    WHERE id=$1`, [d.id, ip, hostName]);
        }
        /* V5.0.14d：回环登录**不再自动登记新设备**。本机请求本来就永久豁免授权（上面直接 return），
         * 登记纯粹是为了列表展示；但每个新浏览器配置（含自动化测试的临时配置）都会生成新设备码，
         * 自动登记会让「授权设备」列表被同名「YL」快速刷屏（真机截图实测堆了 5+ 条）。
         * 只更新已有行（老设备保留计算机名标注），新码不再入库。 */
      }
      await audit(emp.store_id, emp.id, '系统', 'pos_device.loopback_bypass', 'pos_device', 0, { code: c, ip });
      return;
    }

    const deviceCode = dev.code;
    const code = String(deviceCode || '').trim().toUpperCase();
    if (!code) throw new BizException(40306, '设备授权已开启：本机尚未生成设备码，请刷新页面后重试', 403);
    if (!/^[A-Z0-9-]{4,40}$/.test(code)) throw new BizException(40003, '设备码格式非法', 403);
    const dType = ['pc', 'mobile', 'pad'].includes(String(dev.type)) ? String(dev.type) : null;
    const uaShort = String(ua || '').slice(0, 400);
    let row = await q1<any>(
      `SELECT * FROM pos_devices WHERE store_id=$1 AND device_code=$2`, [emp.store_id, code]);

    // 应急恢复码（决策 2-A：超管不豁免，靠恢复码防锁死）。
    // 必须放在「未登记」分支之前：否则全新设备会先被登记成待授权并直接抛错，
    // 恢复码根本没机会生效 → 管理员换新设备后永远登不上（实测踩到）。
    if (dev.recovery) {
      // V5.0.15 修复：恢复码此前不校验使用者身份 —— 任何员工只要知道恢复码，
      // 就能把自己手上的设备"洗"成已授权，等于把设备授权体系整体绕过。
      // 恢复码是最高危的应急通道（可绕过设备授权），必须限定超级管理员本人使用。
      if (!(await isSuperAdmin(Number(emp.id)))) {
        throw new BizException(40318,
          '应急恢复码仅限超级管理员使用，请联系超管在本机登录（员工：' + String(emp.emp_no) + '）', 403);
      }
    }
    if (dev.recovery && await recoveryCodeOk(dev.recovery)) {
      if (!row) {
        row = await q1<any>(
          `INSERT INTO pos_devices (store_id, device_code, device_type, device_name, ua, status, last_ip)
           VALUES ($1,$2,$3,$4,$5,'已授权',$6) RETURNING *`,
          [emp.store_id, code, detectDeviceType(ua, dev.type), resolveDeviceName({ reported: dev.name, ua, type: dev.type }), uaShort, ip]);
      } else if (row.status !== '已授权') {
        row = await q1<any>(
          `UPDATE pos_devices SET status='已授权', approved_at=now(), last_seen_at=now(), last_ip=$2,
                           device_type=COALESCE($3,device_type),
                           device_name=COALESCE(NULLIF(device_name,''), $5),
                           ua=COALESCE(NULLIF($4,''),ua)
            WHERE id=$1 RETURNING *`, [row.id, ip, detectDeviceType(ua, dev.type), uaShort, resolveDeviceName({ reported: dev.name, ua, type: dev.type })]);
      }
      await audit(emp.store_id, emp.id, '系统', 'pos_device.recover', 'pos_device', Number(row.id),
        { code, by: 'recovery-code' });
    }

    if (!row) {
      // 门店授权设备总量上限（0=不限；超限则连「待授权」都不登记）
      const cap = Number(await getSetting('pos.device.store.cap', 0)) || 0;
      if (cap > 0) {
        const n = await q1<any>(`SELECT count(*)::int AS n FROM pos_devices WHERE store_id=$1 AND status<>'已停用'`, [emp.store_id]);
        if (Number(n?.n || 0) >= cap) {
          throw new BizException(40311,
            `本门店授权设备已达上限（${cap} 台），无法登记新设备。请联系管理员在「系统设置 → 设备管理」调整上限或停用闲置设备`, 403);
        }
      }
      // 决策 5：首次见到即登记为「待授权」，并把设备码自动上报管理后台（老板端消息中心可见）
      await q(`INSERT INTO pos_devices (store_id, device_code, device_type, device_name, ua, status, last_ip)
               VALUES ($1,$2,$3,$4,$5,'待授权',$6) ON CONFLICT (store_id, device_code) DO NOTHING`,
        [emp.store_id, code, detectDeviceType(ua, dev.type), resolveDeviceName({ reported: dev.name, ua, type: dev.type }), uaShort, ip]);
      try {
        await notifyStaff(Number(emp.store_id), 'device_pending',
          `新设备待授权：${code}（${DEVICE_TYPE_CN[detectDeviceType(ua, dev.type) || ''] || '未知设备'} ${resolveDeviceName({ reported: dev.name, ua, type: dev.type })}，来自 ${emp.emp_no} ${emp.name}）`,
          { deviceCode: code, deviceType: detectDeviceType(ua, dev.type), deviceName: resolveDeviceName({ reported: dev.name, ua, type: dev.type }),
            empNo: emp.emp_no, name: emp.name, ip },
          'sys.settings', `devreq:${code}`);
      } catch { /* 上报失败不阻断登录 */ }
      throw new BizException(40307, `该设备未授权，暂无法登录，请联系管理员进行授权（设备码 ${code}）`, 403);
    }
    if (row.status === '待授权') {
      // ── 配对码流程（V5.0.11b）：码正确 → 配对成功 → 授权成功 → 继续走下面的正常登录 ──
      if (dev.pair) {
        const why = pairCodeUsable(row);
        if (!why && pairCodeEquals(row.pair_code, dev.pair)) {
          // 消费一次：达到上限则立即作废，避免同码被重复转发使用
          const max = Number(row.pair_max_uses) || 0;
          const used = Number(row.pair_used || 0) + 1;
          /* V5.0.14f：配对成功即**换绑公钥**（TOFU 经人肉确认刷新）。旧版只解锁状态不动公钥——
           * 若设备端密钥曾重生成（WebView 回收 IndexedDB 等），登记的旧公钥与本次签名不再匹配，
           * 下次登录验签必失败 → 自动翻回「待授权」→ 又要配对……无限循环（真机投诉根因）。
           * 配对码本身就是管理员的人工确认，凭它换绑新公钥安全等价于重新审批。 */
          await q(`UPDATE pos_devices
                      SET status='已授权', approved_at=now(), paired_at=now(),
                          pair_used=$2,
                          pair_code = CASE WHEN $3 > 0 AND $2 >= $3 THEN NULL ELSE pair_code END,
                          pubkey = COALESCE(NULLIF($10,''), pubkey),
                          last_emp_id=$4, last_emp_no=$5, last_emp_name=$6, last_emp_at=now(),
                          last_seen_at=now(), last_ip=$7, device_type=COALESCE($8,device_type),
                          device_name=COALESCE(NULLIF(device_name,''), $9)
                    WHERE id=$1`,
            [row.id, used, max, emp.id, emp.emp_no, emp.name, ip, detectDeviceType(ua, dev.type),
              resolveDeviceName({ reported: dev.name, ua, type: dev.type }), String(dev.pubkey || '')]);
          await audit(emp.store_id, emp.id, '系统', 'pos_device.pair', 'pos_device', Number(row.id),
            { code, used, max: max || 'unlimited', pubkeyRebound: !!dev.pubkey });
          row.status = '已授权';
        } else {
          // 码错误/过期/用尽：给出明确原因，员工可反复重试
          await q(`UPDATE pos_devices SET last_seen_at=now(), last_ip=$2 WHERE id=$1`, [row.id, ip]);
          throw new BizException(40317,
            (why || '配对码不正确') + `。请核对后重试，或联系管理员重新获取（设备码 ${code}）`, 403);
        }
      } else {
        // 恢复码已在上方统一处理；走到这里说明既没配对码也没恢复码
        await q(`UPDATE pos_devices SET last_seen_at=now(), last_ip=$2, device_type=COALESCE($3,device_type),
                         ua=COALESCE(NULLIF($4,''),ua) WHERE id=$1`,
          [row.id, ip, dType, uaShort]);
        throw new BizException(40307, `该设备未授权，暂无法登录，请联系管理员进行授权（设备码 ${code}）`, 403);
      }
    }
    if (row.status === '已停用') {
      throw new BizException(40308, '本机授权已被停用，请联系管理员（设备码 ' + code + '）', 403);
    }
    // ── P1 硬件级设备身份验签 ──
    // 已登记公钥的设备，每次登录都必须用不可导出的私钥对「工号|设备码|时间戳|随机串」签名。
    // 攻击者即使把设备码抄到另一台电脑/手机，也拿不到私钥 → 登不进去。
    if (row.pubkey) {
      const requireSig = await getSetting('pos.device.require.signature', false) === true;
      if (!dev.sig) {
        if (requireSig) throw new BizException(40312, `设备签名缺失（设备码 ${code}），请升级收银端/APP 后重试`, 403);
      } else {
        const ts = Number(dev.ts) || 0;
        if (!ts || Math.abs(Date.now() - ts) > 5 * 60_000) {
          throw new BizException(40313, '设备签名已过期，请重新登录', 403);
        }
        if (!nonceFresh(String(dev.nonce || ''))) {
          throw new BizException(40313, '设备签名重复（疑似重放攻击），请重新登录', 403);
        }
        if (!verifyDeviceSig(row.pubkey, dev.sig, deviceSignPayload(dev, emp.emp_no))) {
          /* V5.0.18g 重装自动换绑：设备码为硬件派生（Android ANDROID_ID，卸载重装不变）的收银机，
           * 卸载重装会把 WebView 存储连同签名私钥一起清空——重新登录时必然"新钥验签失败"。
           * 若该设备近 30 天内活跃（last_seen_at），且登录工号密码已验证通过，判定为「同机重装」
           * 而非设备码复制：自动换绑登记公钥为本机新公钥并留痕，硬件不变则授权不变。
           * 30 天窗口防陈旧设备码被盗用（30 天未活跃的设备码重装/被复制仍走人工审批）。
           * 非 APK 场景（浏览器/EXE，软标识）不自动换绑——软码可被复制，保持人工审批。 */
          const isNativeCode = /^HW-[0-9A-F]{8}$/.test(String(code));   // 硬件派生码（APK ANDROID_ID / EXE MachineGuid）
          const lastSeenAge = row.last_seen_at ? (Date.now() - new Date(row.last_seen_at).getTime()) / 86400_000 : Infinity;
          const rebindable = isNativeCode && row.status === '已授权' && !!row.pubkey && lastSeenAge <= 30
            && String(dev.pubkey || '').length > 100;   // 新公钥有效（重装后新生成的密钥对）
          if (rebindable) {
            await q(`UPDATE pos_devices SET pubkey=$2, status='已授权', last_seen_at=now(), last_ip=$3,
                        device_type=COALESCE($4,device_type)
                      WHERE id=$1`, [row.id, String(dev.pubkey), ip, detectDeviceType(ua, dev.type)]);
            await audit(emp.store_id, emp.id, '系统', 'pos_device.reinstall_rebind', 'pos_device', Number(row.id),
              { code, daysSinceLastSeen: Math.round(lastSeenAge * 10) / 10 });
            // 换绑成功 → 继续正常登录流程（不抛 40314）
          } else {
            await q(`UPDATE pos_devices SET status='待授权' WHERE id=$1`, [row.id]);
            throw new BizException(40314,
              `设备签名校验失败（设备码 ${code}）：该设备码可能已被复制到其他设备，已转待授权，请管理员重新审批`, 403);
          }
        }
      }
    }

    // ── 设备↔员工绑定（4A）—— V5.0.11b 起**默认关闭** ──
    // 业务实况：收银台共用，一台设备要服务多个员工。开启后设备会被第一个人占住，
    // 其余员工登不进来（40315），属于阻塞营业的误伤。仅在「专用设备/专用机」场景才值得开。
    if (await getSetting('pos.device.bind.employee', false) === true) {
      if (row.employee_id && Number(row.employee_id) !== Number(emp.id)) {
        const other = await q1<any>(`SELECT emp_no, name FROM employees WHERE id=$1`, [row.employee_id]);
        throw new BizException(40315,
          `该设备已绑定其他员工（${other?.emp_no || '?'} ${other?.name || ''}），无法登录本账号。`
          + '如需换人使用，请联系管理员在「系统设置 → 设备管理」解绑或停用该设备', 403);
      }
      if (!row.employee_id) {
        const roles = await roleNamesOf(emp.id);
        const quota = await deviceQuotaOf(emp.id, roles);
        const used = await q1<any>(
          `SELECT count(*)::int AS n FROM pos_devices
            WHERE store_id=$1 AND employee_id=$2 AND status='已授权' AND id<>$3`,
          [emp.store_id, emp.id, row.id]);
        if (Number(used?.n || 0) >= quota) {
          const tier = roles.some(r => ROLE_LIMIT_TIER[1].re.test(r)) ? '店长/财务/管理员' : '收银员/库管';
          throw new BizException(40316,
            `已达到${tier}的设备数上限（${quota} 台）。请先在「系统设置 → 设备管理」停用闲置设备，或调高该配额`, 403);
        }
        await q(`UPDATE pos_devices SET employee_id=$2, bound_at=now() WHERE id=$1`, [row.id, emp.id]);
        row.employee_id = emp.id;
      }
    }

    // ── P1 TOFU：首次见到公钥即登记（此后每次登录都必须验签通过）──
    if (!row.pubkey && dev.pubkey) {
      await q(`UPDATE pos_devices SET pubkey=$2, sig_algo='RSA-SHA256' WHERE id=$1`,
        [row.id, String(dev.pubkey).slice(0, 800)]);
      if (await getSetting('pos.device.require.signature', false) === true) {
        throw new BizException(40312, `设备公钥已登记，请重新登录一次以完成签名校验（设备码 ${code}）`, 403);
      }
    }
    // V5.0.11d：登录时顺手补齐 device_name / device_type（仅当为空时），
    // 这样历史上已登记但名称为空的设备，下次登录就自动显示友好名称
    await q(`UPDATE pos_devices SET last_seen_at=now(), last_ip=$2, last_login_at=now(),
                     last_emp_id=$3, last_emp_no=$4, last_emp_name=$5, last_emp_at=now(),
                     device_type=COALESCE($6,device_type),
                     device_name=COALESCE(NULLIF(device_name,''), $7),
                     ua=COALESCE(NULLIF($8,''),ua) WHERE id=$1`,
      [row.id, ip, emp.id, emp.emp_no, emp.name, detectDeviceType(ua, dev.type),
        resolveDeviceName({ reported: dev.name, ua, type: dev.type }), uaShort]);
  }

  /** 单会话（决策 1：同一时间一个账号只允许一台设备在线）
   *  复用「改密/停用」的吊销机制：登录时 token_version+1，旧设备的 JWT 里 tv 落后即被守卫拒绝（60 秒内）。 */
  private async enforceSingleSession(emp: any) {
    if (await getSetting('pos.device.single.session', true) !== true) return;
    await q(`UPDATE employees SET token_version=COALESCE(token_version,0)+1 WHERE id=$1`, [emp.id]);
    clearAuthStateCache(Number(emp.id));
    emp.token_version = Number(emp.token_version || 0) + 1;   // 同步内存态，本次签发即带新 tv
  }

  /** V4.24.0：签发 token（登录 / 扫码登录 / PIN 登录三路共用，权限点与安全标记口径一致） */
  private async issue(emp: any, auditAction: string) {
    // V5.0.18g 员工级权限覆盖：有效权限 = (角色权限 ∪ allow) − deny（employee_perm_overrides）
    // 表不存在（旧库未跑迁移 184）→ 回落纯角色权限，绝不阻断登录
    let perms: { code: string }[];
    try {
      perms = await q<{ code: string }>(
        `SELECT DISTINCT pp.code
           FROM permission_points pp
          WHERE (pp.id IN (SELECT rp.permission_id FROM employee_roles er
                            JOIN role_permissions rp ON rp.role_id = er.role_id
                           WHERE er.employee_id = $1)
              OR pp.id IN (SELECT permission_id FROM employee_perm_overrides
                            WHERE employee_id = $1 AND mode = 'allow'))
            AND pp.id NOT IN (SELECT permission_id FROM employee_perm_overrides
                               WHERE employee_id = $1 AND mode = 'deny')`, [emp.id],
      );
    } catch (e: any) {
      if (String(e?.code) !== '42P01') throw e;
      perms = await q<{ code: string }>(
        `SELECT DISTINCT pp.code
           FROM employee_roles er
           JOIN role_permissions rp ON rp.role_id = er.role_id
           JOIN permission_points pp ON pp.id = rp.permission_id
          WHERE er.employee_id = $1`, [emp.id],
      );
    }
    // 超管通配：绑定「超级管理员」角色 → 持有 '*'（后端守卫豁免 + 前端权限位全通过）
    const permCodes = (await isSuperAdmin(emp.id)) ? ['*', ...perms.map(p => p.code)] : perms.map(p => p.code);
    // V5.0.0 连锁：登录时解析一次数据范围打入 JWT（与 perms 同策略，请求内零查库）
    const { ds, ss, hq } = await resolveScope(emp);
    // P4：遗留出厂默认口令检测——明文常量移出源码，仅由 env LEGACY_DEFAULT_PW 提供（空=不检测，新装安全）。
    // 历史库恢复场景：运维在迁移期临时设 LEGACY_DEFAULT_PW=旧默认口令，触发强制改密闸门；平时留空。
    const legacyDefaultPw = process.env.LEGACY_DEFAULT_PW || '';
    const usingDefault = !!legacyDefaultPw && bcrypt.compareSync(legacyDefaultPw, emp.password_hash || '');
    const payload: AuthUser = {
      sub: Number(emp.id), storeId: Number(emp.store_id), empNo: emp.emp_no, name: emp.name, perms: permCodes,
      tv: Number(emp.token_version ?? 0),
      ds, ss: ss ?? undefined, hq,          // V5.0.0 数据范围
      ...(usingDefault ? { pwd: 'default' as const } : {}),
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
    await q(`UPDATE employees SET last_login_at = now() WHERE id=$1`, [emp.id]);
    await audit(emp.store_id, emp.id, '系统', auditAction);
    return { token, name: emp.name, empNo: emp.emp_no, perms: permCodes,
             storeId: Number(emp.store_id), dataScope: ds, scopeStores: ss, hq,   // V5.0.0 前端据此裁剪菜单
             ...(usingDefault ? { mustChangePassword: true, msg: '安全提醒：正在使用出厂默认密码，请立即修改（本次会话仅可改密）' } : {}) };
  }

  /** 员工登录：bcrypt 校验 + 权限点打入 JWT（方案 十 权限与数据安全） */
  async login(empNo: string, password: string, dev?: DeviceCtx, ua?: string, ip?: string) {
    if (!empNo || !password) throw new BizException(40001, '工号与密码必填');
    const emp = await q1<any>(
      `SELECT * FROM employees WHERE emp_no=$1 AND status='在职'`, [empNo],
    );
    if (!emp || !emp.password_hash) throw new BizException(41001, '工号或密码错误', 401);
    if (!bcrypt.compareSync(password, emp.password_hash)) throw new BizException(41002, '工号或密码错误', 401);
    // 凭证通过后校验设备授权（先验凭证防未授权设备探测账号/刷待授权记录）
    await this.checkDeviceAuth(emp, dev || {}, ua || '', ip || '');
    await this.enforceSingleSession(emp);   // 决策 1：同一时间一个账号只允许一台设备在线
    return this.issue(emp, 'auth.login');
  }

  /** 创建扫码登录二维码（target: pwa=店员端 | boss=老板端）：一次性票据 + 免密链接 + SVG 二维码 */
  async createQrTicket(user: AuthUser, target: 'pwa' | 'boss' = 'pwa') {
    for (const [k, v] of qrTickets) if (v.exp < Date.now()) qrTickets.delete(k); // 清过期
    const ticket = crypto.randomBytes(16).toString('hex');
    const ttlSec = 300;                                     // 5 分钟一次性
    qrTickets.set(ticket, { empId: user.sub, storeId: user.storeId, exp: Date.now() + ttlSec * 1000 });
    const ip = lanIPv4();
    const httpsPort = Number(process.env.HTTPS_PORT || 3443);
    // 手机端摄像头（扫码/AI智拍）要求 HTTPS 安全上下文，二维码一律指向 HTTPS。
    // 二维码用 IP 直连（任何浏览器可扫，后端实时取当前 IP，换 IP 重新生成即可）；
    // mDNS 域名 pos-server.local 供浏览器收藏/手输长期使用（国产浏览器云端加速会劫持 DNS，.local 解析不了）。
    const page = target === 'boss' ? '/boss/index.html' : '/pwa/index.html';
    const url = `https://${ip}:${httpsPort}${page}#qr=${ticket}`;
    const qrgen = require('qrcode-generator');
    const qr = qrgen(0, 'M');
    qr.addData(url);
    qr.make();
    return { url, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }),
             expiresInSec: ttlSec, lanIp: ip, mdnsHost: MDNS_HOST, port: httpsPort, https: true };
  }

  /** 手机端扫码换 token（PWA 打开链接 #qr=<ticket> 自动调用）：一次性、过期拒绝 */
  async qrLogin(ticket: string, dev?: DeviceCtx, ua?: string, ip?: string) {
    const t = ticket ? qrTickets.get(ticket) : null;
    if (!t) throw new BizException(41003, '登录二维码无效或已被使用', 401);
    qrTickets.delete(ticket);                               // 先消费：保证一次性
    if (t.exp < Date.now()) throw new BizException(41004, '登录二维码已过期，请在后台重新生成', 401);
    const emp = await q1<any>(`SELECT * FROM employees WHERE id=$1 AND status='在职'`, [t.empId]);
    if (!emp) throw new BizException(41001, '员工不存在或已离职', 401);
    // 扫码登录同样校验设备授权（手机/PAD 也是收银设备）
    await this.checkDeviceAuth(emp, dev || {}, ua || '', ip || '');
    await this.enforceSingleSession(emp);
    return this.issue(emp, 'auth.qr_login');
  }

  // ═══ V4.24.0 首次运行引导（不再写死 ADMIN/admin123）═══

  /** 启动自检：是否已有管理员（绑「超级管理员」角色）。公开接口，只回线索供登录页提示 */
  async bootstrapState() {
    const adm = await findAdminHint();
    const st = await q1<any>(`SELECT name FROM stores ORDER BY id LIMIT 1`);
    return {
      hasAdmin: !!adm,
      adminEmpNo: adm?.empNo || '',
      adminName: adm?.name || '',
      storeName: String(st?.name || ''),
    };
  }

  /** 创建首个管理员：仅当系统内尚无管理员时允许；自动绑定「超级管理员」角色（获得 * 通配） */
  async createFirstAdmin(b: { empNo?: string; name?: string; password?: string; storeName?: string; deviceCode?: string }, ua?: string, ip?: string) {
    const adm = await findAdminHint();
    if (adm) throw new BizException(40305, `系统已存在管理员（${adm.empNo}），请直接登录；如需新增管理员请在后台「员工与角色」操作`, 403);
    const empNo = String(b.empNo || '').trim().toUpperCase();
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    if (!empNo || !name || !password) throw new BizException(40003, '工号、姓名、密码均为必填');
    if (!/^[A-Z0-9_-]{2,32}$/.test(empNo)) throw new BizException(40003, '工号仅支持 2~32 位字母/数字/下划线/中划线');
    await checkPasswordPolicy(password);
    const store = await q1<any>(`SELECT id FROM stores ORDER BY id LIMIT 1`);
    const storeId = Number(store?.id || 1);
    // 可选：顺手把门店名写成用户输入（首次初始化时门店档案还是默认值）
    const sn = String(b.storeName || '').trim();
    if (sn) await q(`UPDATE stores SET name=$2 WHERE id=$1`, [storeId, sn.slice(0, 60)]);
    const emp = await q1<any>(
      `INSERT INTO employees (store_id, emp_no, name, password_hash) VALUES ($1,$2,$3,$4)
       RETURNING id, emp_no, name`,
      [storeId, empNo, name, bcrypt.hashSync(password, 10)]);
    const role = await q1<any>(`SELECT id FROM roles WHERE name='超级管理员' ORDER BY id LIMIT 1`);
    if (role) {
      await q(`INSERT INTO employee_roles (employee_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [Number(emp.id), Number(role.id)]);
    }
    await audit(storeId, Number(emp.id), '系统', 'auth.bootstrap_admin', 'employee', Number(emp.id), { empNo });
    // 首次创建即自动完成一次登录（省去用户再输一遍）
    return { ...(await this.issue(emp, 'auth.bootstrap_login')), created: true, bootEmpNo: emp.emp_no, bootName: emp.name };
  }

  // ═══ V4.24.0 PIN 快速登录（只记工号 + 记住 PIN）═══

  /** 设置/更新本机 PIN（需登录 + 验证登录密码；PIN 4~8 位数字，bcrypt 存储） */
  async setPin(user: AuthUser, password: string, pin: string) {
    const p = String(pin || '');
    if (!/^\d{4,8}$/.test(p)) throw new BizException(40003, 'PIN 须为 4~8 位数字');
    const emp = await q1<any>(`SELECT password_hash FROM employees WHERE id=$1`, [user.sub]);
    if (!emp || !bcrypt.compareSync(String(password || ''), emp.password_hash)) {
      throw new BizException(41002, '登录密码不正确，无法设置 PIN', 401);
    }
    await q(`UPDATE employees SET pin_hash=$2, pin_set_at=now() WHERE id=$1`, [user.sub, bcrypt.hashSync(p, 10)]);
    await audit(user.storeId, user.sub, '系统', 'auth.pin_set', 'employee', user.sub, {});
    return { ok: true, pinSetAt: new Date().toISOString() };
  }

  /** 清除 PIN（需登录 + 验证登录密码） */
  async clearPin(user: AuthUser, password: string) {
    const emp = await q1<any>(`SELECT password_hash FROM employees WHERE id=$1`, [user.sub]);
    if (!emp || !bcrypt.compareSync(String(password || ''), emp.password_hash)) {
      throw new BizException(41002, '登录密码不正确', 401);
    }
    await q(`UPDATE employees SET pin_hash=NULL, pin_set_at=NULL WHERE id=$1`, [user.sub]);
    await audit(user.storeId, user.sub, '系统', 'auth.pin_clear', 'employee', user.sub, {});
    return { ok: true };
  }

  /** 工号 + PIN 免密登录（PIN 未设置 → 41001 提示改用密码） */
  async pinLogin(empNo: string, pin: string, dev?: DeviceCtx, ua?: string, ip?: string) {
    const no = String(empNo || '').trim();
    if (!no || !pin) throw new BizException(40001, '工号与 PIN 必填');
    const emp = await q1<any>(`SELECT * FROM employees WHERE emp_no=$1 AND status='在职'`, [no]);
    if (!emp || !emp.pin_hash) throw new BizException(41011, '该工号未设置 PIN，请改用密码登录', 401);
    if (!bcrypt.compareSync(String(pin), emp.pin_hash)) throw new BizException(41012, 'PIN 不正确', 401);
    await this.checkDeviceAuth(emp, dev || {}, ua || '', ip || '');
    await this.enforceSingleSession(emp);
    return this.issue(emp, 'auth.pin_login');
  }

  // ═══ V4.25.5 店长授权改价/打折（授权码独立于登录密码，仅授权单次价格操作）═══

  /** 设置/更新本人授权码（需登录 + 登录密码确认；4~8 位数字，且不得与登录 PIN 相同） */
  async setAuthCode(user: AuthUser, password: string, authCode: string) {
    const code = String(authCode || '');
    if (!/^\d{4,8}$/.test(code)) throw new BizException(40003, '授权码须为 4~8 位数字');
    const emp = await q1<any>(`SELECT password_hash, pin_hash FROM employees WHERE id=$1`, [user.sub]);
    if (!emp || !bcrypt.compareSync(String(password || ''), emp.password_hash)) {
      throw new BizException(41002, '登录密码不正确，无法设置授权码', 401);
    }
    if (emp.pin_hash && bcrypt.compareSync(code, emp.pin_hash)) {
      throw new BizException(40003, '授权码不能与登录 PIN 相同，请另设一个');
    }
    await q(`UPDATE employees SET auth_code_hash=$2, auth_code_set_at=now() WHERE id=$1`,
      [user.sub, bcrypt.hashSync(code, 10)]);
    await audit(user.storeId, user.sub, '系统', 'auth.auth_code_set', 'employee', user.sub, {});
    return { ok: true, authCodeSetAt: new Date().toISOString() };
  }

  /** 清除本人授权码（需登录 + 登录密码确认） */
  async clearAuthCode(user: AuthUser, password: string) {
    const emp = await q1<any>(`SELECT password_hash FROM employees WHERE id=$1`, [user.sub]);
    if (!emp || !bcrypt.compareSync(String(password || ''), emp.password_hash)) {
      throw new BizException(41002, '登录密码不正确', 401);
    }
    await q(`UPDATE employees SET auth_code_hash=NULL, auth_code_set_at=NULL WHERE id=$1`, [user.sub]);
    await audit(user.storeId, user.sub, '系统', 'auth.auth_code_clear', 'employee', user.sub, {});
    return { ok: true };
  }

  /** 本人授权码状态（收银端设置页回显，不外传任何凭证） */
  async authCodeStatus(user: AuthUser) {
    const emp = await q1<any>(`SELECT auth_code_hash IS NOT NULL AS is_set, auth_code_set_at FROM employees WHERE id=$1`, [user.sub]);
    return { isSet: !!emp?.is_set, setAt: emp?.auth_code_set_at ?? null };
  }

  /** 店长现场授权：工号 + 授权码 → 签发 120 秒短时票据（scope=price），仅覆盖本次价格操作，不切换登录身份 */
  async authorize(empNo: string, authCode: string) {
    const no = String(empNo || '').trim().toUpperCase();
    if (!no || !authCode) throw new BizException(40001, '店长工号与授权码必填');
    const emp = await q1<any>(`SELECT * FROM employees WHERE emp_no=$1 AND status='在职'`, [no]);
    if (!emp) throw new BizException(41020, '工号不存在或已离职', 401);
    if (!emp.auth_code_hash) throw new BizException(41021, '该工号未设置授权码，请店长先在「设置 → 店长授权码」中设置', 401);
    // 资格校验：须持「改价/折扣授权」权限点（超管等价；V5.0.18g 起员工级覆盖同样生效）
    const superAdmin = await isSuperAdmin(emp.id);
    const hasPerm = superAdmin || (await hasPermCode(emp.id, 'pos.price.authorize'));
    if (!hasPerm) throw new BizException(41022, '该工号无改价/折扣授权资格（需店长级权限）', 403);
    if (!bcrypt.compareSync(String(authCode), emp.auth_code_hash)) throw new BizException(41023, '授权码不正确', 401);
    // S-08：票据带 jti（一次性消费标记），结账时落 auth_ticket_used 防窗口内重放
    const ticket = jwt.sign(
      { sub: Number(emp.id), empNo: emp.emp_no, name: emp.name, scope: 'price', jti: crypto.randomUUID() },
      JWT_SECRET, { expiresIn: 120 });
    await audit(Number(emp.store_id), Number(emp.id), '收银', 'auth.price_authorize', 'employee', Number(emp.id),
      { by: `${emp.emp_no}(${emp.name})` });
    return { ticket, expiresIn: 120, authorizer: { empNo: emp.emp_no, name: emp.name } };
  }

  /** V4.25.7 本人静默自授权（后台 pos.price.auth_self=on 时由收银台调用）：
   *  须持 pos.price.authorize；用登录态证明身份、免输授权码；票据口径与 /auth/authorize 完全一致，仍写审计留痕 */
  async authorizeSelf(user: AuthUser) {
    const superAdmin = await isSuperAdmin(user.sub);
    const hasPerm = superAdmin || (await hasPermCode(user.sub, 'pos.price.authorize'));
    if (!hasPerm) throw new BizException(41022, '当前账号无改价/折扣授权资格（需店长级权限）', 403);
    const ticket = jwt.sign(
      { sub: Number(user.sub), empNo: user.empNo, name: user.name, scope: 'price', jti: crypto.randomUUID() },
      JWT_SECRET, { expiresIn: 120 });
    await audit(user.storeId, Number(user.sub), '收银', 'auth.price_authorize_self', 'employee', Number(user.sub),
      { by: `${user.empNo}(${user.name})`, via: 'self' });
    return { ticket, expiresIn: 120, authorizer: { empNo: user.empNo, name: user.name } };
  }
}

// ─── Controller ───
/** V5.0.18g：员工删除冷静期（停用满该天数方可删除） */
const EMP_DELETE_GRACE_DAYS = 90;

@Controller('auth')
class AuthController {
  private svc = new AuthService();

  /** V5.0.19h（F-05）：签发短时图片访问票据（60s，scope:img）。
   *  背景：<img src="/uploads/..."> 无法带 Authorization 头，旧实现把长效 12h 员工 JWT 拼进 ?token=，
   *  一旦被 access log/Referer/历史记录捕获即可长期冒用。改用 60s 短时票据：
   *  ①泄露窗口 12h→60s；②scope:img 仅图片中间件接受，不能调业务接口。
   *  前端 imgUrl 改为取本票据拼 ?token=，登录后预取 + 定时刷新（见 admin/api.js）。 */
  @Post('img-ticket')
  async imgTicket(@CurrentUser() user: AuthUser) {
    const ticket = jwt.sign(
      { sub: Number(user.sub), empNo: user.empNo, name: user.name, kind: 'employee', scope: 'img' },
      JWT_SECRET, { expiresIn: 60 });
    return { ticket, expiresIn: 60 };
  }

  /** V5.0.18g：删除员工——停用满 90 天冷静期后方可。
   *  无任何业务记录 → 物理删除；有业务记录 → 「注销归档」：全量快照入 employee_delete_archive，
   *  员工行转「已注销」（密码/手机/授权码作废，登录守卫自动拦截），业务单据外键与操作人姓名完整保留。 */
  @RequirePerms('staff.manage')
  @Delete('employees/:id')
  async deleteEmployee(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const eid = Number(id);
    if (user && Number(user.sub) === eid) throw new BizException(40003, '不能删除当前登录账号');
    const emp = await q1<any>(`SELECT id, store_id, emp_no, name, status, disabled_at FROM employees WHERE id=$1`, [eid]);
    if (!emp) throw new BizException(40404, '员工不存在', 404);
    if (String(emp.emp_no).toUpperCase() === 'ADMIN') throw new BizException(40003, '超级管理员账号不可删除');
    if (emp.status !== '停用') throw new BizException(40003, '仅「停用」状态员工可删除，请先停用');
    // V5.0.18g：90 天冷静期（从停用时刻起算）
    if (!emp.disabled_at) throw new BizException(40003, '缺少停用时间记录，请重新执行一次「停用」以开始 90 天冷静期');
    const days = Math.floor((Date.now() - new Date(emp.disabled_at).getTime()) / 86400000);
    if (days < EMP_DELETE_GRACE_DAYS) {
      throw new BizException(40003, `停用未满 ${EMP_DELETE_GRACE_DAYS} 天（已停 ${days} 天，还需 ${EMP_DELETE_GRACE_DAYS - days} 天）后方可删除`);
    }
    const refs: string[] = [];
    const seen = new Set<string>();
    const fks = await q<any>(`SELECT tc.table_name AS t, kcu.column_name AS c
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='employees'`);
    const probes = [...fks.map((x: any) => ({ t: x.t, c: x.c })),
      { t: 'sales_orders', c: 'cashier_id' }, { t: 'shifts', c: 'cashier_id' }, { t: 'audit_logs', c: 'emp_id' },
      { t: 'held_orders', c: 'employee_id' }, { t: 'price_changes', c: 'created_by' }];
    for (const p of probes) {
      const k = `${p.t}.${p.c}`;
      if (seen.has(k) || p.t === 'employees' || p.t === 'employee_roles' || !/^[a-z_]+$/.test(p.t) || !/^[a-z_]+$/.test(p.c)) continue;
      seen.add(k);
      try {
        const n: any = await q1(`SELECT count(*)::int AS n FROM ${p.t} WHERE ${p.c}=$1`, [eid]);
        if (n && Number(n.n) > 0) refs.push(`${p.t}(${n.n})`);
      } catch { /* 列不存在等非致命 */ }
    }
    if (!refs.length) {
      // 无业务记录：物理删除（干净移除，工号不复用由注销工号占位规则无关——此处删除后工号可被重建）
      await tx(async c => {
        await c.query(`DELETE FROM employee_roles WHERE employee_id=$1`, [eid]);
        await c.query(`DELETE FROM employees WHERE id=$1`, [eid]);
      });
    } else {
      // 有业务记录：注销归档——快照入档，员工行转「已注销」并作废敏感字段；FK 完整保留，单据仍显示操作人
      const roles = (await q(`SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=$1`, [eid])).map((x: any) => x.name);
      const full = await q1<any>(`SELECT row_to_json(e.*) AS snap FROM employees e WHERE e.id=$1`, [eid]);
      const snapshot = { ...full?.snap, roles, refs } as Record<string, unknown>;
      delete snapshot.password_hash;
      await tx(async c => {
        await c.query(
          `INSERT INTO employee_delete_archive (store_id, emp_no, name, snapshot, archived_by) VALUES ($1,$2,$3,$4,$5)`,
          [emp.store_id, emp.emp_no, emp.name, JSON.stringify(snapshot), user?.sub ?? null]);
        await c.query(
          `UPDATE employees SET status='已注销', token_version=COALESCE(token_version,0)+1, password_hash=NULL, phone=NULL, auth_code_hash=NULL, updated_at=now() WHERE id=$1`, [eid]);
      });
    }
    clearAuthStateCache(eid); // 注销/删除后 60s 守卫缓存立即失效
    await audit(user.storeId, user.sub, '员工', 'employee.delete', 'employee', eid,
      { empNo: emp.emp_no, name: emp.name, mode: refs.length ? 'archived' : 'purged', refs });
    return { deleted: true, mode: refs.length ? 'archived' : 'purged', empNo: emp.emp_no, name: emp.name, refs };
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(@Body() body: any, @Req() req: any) {
    // V4.14.4 安全加固：登录爆破防护——账号维连错 5 次锁 15 分钟 + IP 维 100 次/5 分钟
    const empNo = String(body.empNo || '');
    const ipKey = 'ip:' + clientIp(req);
    const lockKey = 'login:' + empNo.trim().toLowerCase();
    const lockSec = lockedFor(lockKey);
    if (lockSec > 0) throw new BizException(42901, `密码连续错误已锁定，请 ${Math.ceil(lockSec / 60)} 分钟后再试`, 429);
    if (!allow(ipKey, 100, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    try {
      const r = await this.svc.login(empNo, body.password || '', devCtxOf(body),
        String(req.headers['user-agent'] || ''), clientIp(req));
      clearFailures(lockKey);   // 登录成功清零失败计数
      return r;
    } catch (e: any) {
      const code = e instanceof BizException ? e.bizCode : 0;
      if (code === 41001 || code === 41002) {   // 仅凭证错误计失败（工号不存在同样计数，兼防枚举）
        const min = failAndLock(lockKey, 5, 15 * 60_000);
        if (min > 0) throw new BizException(42901, `密码连续错误已锁定，请 ${min} 分钟后再试`, 429);
      }
      throw e;
    }
  }

  /** 创建扫码登录二维码（后台首页/设置页）：body.target=boss 时指向老板端，默认店员端 PWA */
  @Post('qr-tickets')
  createQrTicket(@Body() b: { target?: string }, @CurrentUser() user: AuthUser) {
    return this.svc.createQrTicket(user, b?.target === 'boss' ? 'boss' : 'pwa');
  }

  // ─── V4.24.0：首次运行引导（登录页启动时自检；管理员不再写死 ADMIN/admin123）───
  /** 是否已有管理员 + 门店名（公开；只回线索，供登录页提示与账号行展示） */
  @Public()
  @HttpCode(200)
  @Get('bootstrap')
  bootstrap() { return this.svc.bootstrapState(); }

  /** 创建首个管理员（仅当无管理员时可用；建完直接返回 token 完成一次登录） */
  @Public()
  @HttpCode(200)
  @Post('bootstrap-admin')
  async bootstrapAdmin(
    @Body() b: { empNo?: string; name?: string; password?: string; storeName?: string; deviceCode?: string },
    @Req() req: any,
  ) {
    if (!allow('boot:' + clientIp(req), 20, 10 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    return this.svc.createFirstAdmin(b, String(req.headers['user-agent'] || ''), clientIp(req));
  }

  // ─── V4.24.0：PIN 快速登录（登录页「记住 PIN」用；与登录密码相互独立）───
  /** 设置/更新 PIN（需登录 + 验证登录密码） */
  @HttpCode(200)
  @Post('pin')
  setPin(@Body() b: { password?: string; pin?: string }, @CurrentUser() user: AuthUser) {
    return this.svc.setPin(user, String(b.password || ''), String(b.pin || ''));
  }

  /** 清除 PIN（需登录 + 验证登录密码） */
  @HttpCode(200)
  @Post('pin/clear')
  clearPin(@Body() b: { password?: string }, @CurrentUser() user: AuthUser) {
    return this.svc.clearPin(user, String(b.password || ''));
  }

  /** 工号 + PIN 免密登录（公开；连错 5 次锁 15 分钟） */
  @Public()
  @HttpCode(200)
  @Post('pin-login')
  async pinLogin(@Body() b: any, @Req() req: any) {
    const empNo = String(b.empNo || '');
    const lockKey = 'pin:' + empNo.trim().toLowerCase();
    const lockSec = lockedFor(lockKey);
    if (lockSec > 0) throw new BizException(42901, `PIN 连续错误已锁定，请 ${Math.ceil(lockSec / 60)} 分钟后再试`, 429);
    if (!allow('ip:' + clientIp(req), 200, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    try {
      const r = await this.svc.pinLogin(empNo, String(b.pin || ''), devCtxOf(b),
        String(req.headers['user-agent'] || ''), clientIp(req));
      clearFailures(lockKey);
      return r;
    } catch (e: any) {
      if (e instanceof BizException && e.bizCode === 41012) {
        const min = failAndLock(lockKey, 5, 15 * 60_000);
        if (min > 0) throw new BizException(42901, `PIN 连续错误已锁定，请 ${min} 分钟后再试`, 429);
      }
      throw e;
    }
  }

  // ─── V4.25.5 店长授权（改价/折扣现场授权；授权码独立于登录密码）───

  /** 设置/更新本人授权码（需登录 + 登录密码确认） */
  @HttpCode(200)
  @Post('set-auth-code')
  setAuthCode(@Body() b: { password?: string; authCode?: string }, @CurrentUser() user: AuthUser) {
    return this.svc.setAuthCode(user, String(b?.password || ''), String(b?.authCode || ''));
  }

  /** 清除本人授权码（需登录 + 登录密码确认） */
  @HttpCode(200)
  @Post('clear-auth-code')
  clearAuthCode(@Body() b: { password?: string }, @CurrentUser() user: AuthUser) {
    return this.svc.clearAuthCode(user, String(b?.password || ''));
  }

  /** 本人授权码状态（收银端设置页回显） */
  @Get('auth-code-status')
  authCodeStatus(@CurrentUser() user: AuthUser) {
    return this.svc.authCodeStatus(user);
  }

  /** 店长现场授权：工号 + 授权码 → 120 秒短时票据（收银员已登录；仅授权本次价格操作，不切换登录身份） */
  @HttpCode(200)
  @Post('authorize')
  async authorize(@Body() b: { empNo?: string; authCode?: string }, @Req() req: any) {
    const empNo = String(b?.empNo || '');
    const lockKey = 'authz:' + empNo.trim().toLowerCase();
    const lockSec = lockedFor(lockKey);
    if (lockSec > 0) throw new BizException(42901, `授权码连续错误已锁定，请 ${Math.ceil(lockSec / 60)} 分钟后再试`, 429);
    if (!allow('ip:authz:' + clientIp(req), 60, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    try {
      const r = await this.svc.authorize(empNo, String(b?.authCode || ''));
      clearFailures(lockKey);
      return r;
    } catch (e: any) {
      if (e instanceof BizException && e.bizCode === 41023) {   // 仅授权码错误计失败（防爆破）
        const min = failAndLock(lockKey, 5, 5 * 60_000);
        if (min > 0) throw new BizException(42901, `授权码连续错误已锁定，请 ${min} 分钟后再试`, 429);
      }
      throw e;
    }
  }

  /** V4.25.7 本人静默自授权（后台「店长本人免输授权码」=开 时由收银台调用）：持授权资格即可，免授权码，仍留痕 */
  @HttpCode(200)
  @Post('authorize-self')
  authorizeSelf(@CurrentUser() user: AuthUser) {
    return this.svc.authorizeSelf(user);
  }

  /** 手机端扫码登录：PWA 打开 #qr=<ticket> 链接后自动调用换取 token（免密） */
  @Public()
  @HttpCode(200)
  @Post('qr-login')
  async qrLogin(@Body() body: any, @Req() req: any) {
    // V4.14.4：票据本身 128bit 随机无爆破面，IP 维频控兜底
    if (!allow('qrl:' + clientIp(req), 30, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    return this.svc.qrLogin(String(body.ticket || ''), devCtxOf(body),
      String(req.headers['user-agent'] || ''), clientIp(req));
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const st = await q1<any>(`SELECT name FROM stores WHERE id=$1`, [user.storeId || 1]);
    // V5.0.11：返回角色名列表。手机端据此分流「老板端 / 员工移动端」——
    //   此前 /auth/me 只有 perms，前端无法区分管理者与普通员工，导致管理员登录后
    //   也被直接丢进收银台。角色是权限的来源（perms 由角色推导），用它做分流最准确。
    const roles = await q<{ name: string }>(
      `SELECT r.name FROM roles r
         JOIN employee_roles er ON er.role_id = r.id
        WHERE er.employee_id = $1 ORDER BY r.name`, [user.sub]);
    return { staffId: user.sub, empNo: user.empNo, name: user.name, storeId: user.storeId, perms: user.perms,
             storeName: String(st?.name || ''),
             roles: roles.map(r => r.name),
             // V5.0.0 连锁：前端据此裁剪菜单（hqOnly）与显示门店选择器
             dataScope: user.ds ?? 'all', scopeStores: user.ss ?? null, hq: !!user.hq };
  }

  /** 员工列表（含角色）；?archived=1 时包含「已注销」（供恢复入职） */
  @Get('employees')
  async employees(@Query() qs: any, @CurrentUser() user: AuthUser) {
    const showArchived = String(qs?.archived || '') === '1';
    const emps = await q(
      `SELECT e.id, e.emp_no, e.name, e.phone, e.status, e.disabled_at, e.last_login_at, e.created_at,
              e.auth_code_hash IS NOT NULL AS auth_code_set,
              COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name))
                       FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM employees e
         LEFT JOIN employee_roles er ON er.employee_id = e.id
         LEFT JOIN roles r ON r.id = er.role_id
        WHERE e.store_id=$1 ${showArchived ? '' : `AND e.status <> '已注销'`}
        GROUP BY e.id ORDER BY e.id`, [user.storeId]);
    // P2-M2：无人事/排班/对账类权限的查看者，收敛手机号与登录时间（下拉仍可用）
    const full = ['sys.user.manage', 'staff.manage', 'shift.manage', 'recon.confirm']
      .some(p => user.perms.includes(p)) || user.perms.includes('*');
    // V5.0.2：规范工号展示——按主角色前缀（收银员SYY/店长DZ/管理员GLY/库管KG/财务CW/其他EM）
    //          + 4 位序号（同前缀按员工 id 顺序稳定编号）；原工号作为「账户名」列展示
    const PFX = (names: string[]) => {
      const j = names.join(',');
      if (/收银/.test(j)) return 'SYY';
      if (/店长/.test(j)) return 'DZ';
      if (/管理员/.test(j)) return 'GLY';
      if (/库/.test(j)) return 'KG';
      if (/财务/.test(j)) return 'CW';
      return 'EM';
    };
    const counters = new Map<string, number>();
    const withNo = emps.map((e: any) => {
      const pfx = PFX((e.roles || []).map((r: any) => r.name));
      const seq = (counters.get(pfx) || 0) + 1;
      counters.set(pfx, seq);
      return { ...e, empNoOfficial: pfx + String(seq).padStart(4, '0') };
    });
    return withNo.map(e => ({ id: Number(e.id), empNo: e.emp_no, empNoOfficial: e.empNoOfficial, name: e.name,
                            phone: full ? e.phone : undefined,
                            status: e.status, lastLoginAt: full ? e.last_login_at : undefined,
                            createdAt: e.created_at || null, roles: e.roles || [],
                            authCodeSet: !!e.auth_code_set }));
  }

  /** 创建员工（工号唯一；bcrypt 存哈希；可绑角色） */
  @RequirePerms('staff.manage')
  @Post('employees')
  async createEmployee(
    @Body() body: { empNo?: string; name?: string; phone?: string; password?: string; roleIds?: number[] },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body.name || !body.password) throw new BizException(40003, '姓名/密码必填');
    await checkPasswordPolicy(String(body.password));
    // 工号规则（V4.8.21）：留空则按角色前缀自动生成 SY0001/CN0001/DZ0001/EM0001
    let empNo = (body.empNo || '').trim();
    if (!empNo) {
      const firstRole = body.roleIds?.length
        ? await q1(`SELECT name FROM roles WHERE id=$1`, [Number(body.roleIds[0])]) : null;
      const rn = firstRole?.name || '';
      const prefix = rn.includes('收银') ? 'SY' : rn.includes('仓') ? 'CN'
                   : rn.includes('店长') ? 'DZ' : 'EM';
      const seq = await q1(
        `SELECT count(*)+1 AS n FROM employees WHERE emp_no LIKE $1`, [prefix + '%']);
      let i = Number(seq.n);
      let candidate = '';
      do {
        candidate = `${prefix}${String(i).padStart(4, '0')}`;
        const dupChk = await q1(`SELECT 1 FROM employees WHERE emp_no=$1`, [candidate]);
        if (!dupChk) break;
        i += 1;
      } while (true);
      empNo = candidate;
    }
    const dup = await q1(`SELECT id FROM employees WHERE emp_no=$1`, [empNo]);
    if (dup) throw new BizException(41003, `工号已存在：${empNo}`);
    const hash = bcrypt.hashSync(body.password, 10);
    const emp = await q1<any>(
      `INSERT INTO employees (store_id, emp_no, name, phone, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, emp_no, name`,
      [user.storeId, empNo, body.name, body.phone ?? null, hash]);
    // V4.28.0 安全修复（F-07）：禁止经员工创建绑定「超级管理员」角色（防店长自我提权）；
    // 绑定超管必须由持 * 通配权限者操作
    const isSuperUser = user.perms.includes('*');
    const wantedRoles = body.roleIds ?? [];
    if (!isSuperUser && wantedRoles.length) {
      const bad = await q(
        `SELECT r.name FROM roles r WHERE r.id = ANY($1::bigint[]) AND r.name = '超级管理员'`, [wantedRoles]);
      if (bad.length) throw new BizException(40301, '不能绑定「超级管理员」角色（需系统最高权限）', 403);
    }
    for (const rid of (body.roleIds ?? [])) {
      await q(`INSERT INTO employee_roles (employee_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [emp.id, rid]);
    }
    await audit(user.storeId, user.sub, '系统', 'staff.create', 'employee', Number(emp.id), { empNo });
    return { id: Number(emp.id), empNo: emp.emp_no, name: emp.name };
  }

  /** 员工停用/复职；停用（离职）联动作废其签字模板（P3-1：ref_employee_id 绑定，防离职员工签名继续被调用） */
  @RequirePerms('staff.manage')
  @Post('employees/:id/status')
  async setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!['在职', '停用'].includes(body.status)) throw new BizException(40003, '状态仅支持 在职/停用');
    // V5.0.18g：停用写 disabled_at（90 天删除冷静期起点）；复职清空
        // R-NEW-5：$2 双用途需显式类型对齐（SET 侧 varchar / CASE 侧 ::text）
    const r = await q1(`UPDATE employees SET status=$2, token_version=COALESCE(token_version,0)+1,
        disabled_at = CASE WHEN status='停用' THEN now() ELSE NULL END, updated_at=now()
      WHERE id=$1 AND store_id=$3 RETURNING id`, [id, body.status, user.storeId]);
    if (!r) throw new BizException(41004, '员工不存在', 404);
    clearAuthStateCache(id); // P1-H5：停用/复职即时反映到守卫（免等 60s 缓存）
    if (body.status === '停用') {
      await q(`UPDATE signature_templates SET status=0 WHERE ref_employee_id=$1 AND status=1`, [id]);
    }
    await audit(user.storeId, user.sub, '系统', 'staff.status', 'employee', id,
      { status: body.status, invalidatedTemplates: body.status === '停用' });
    return { id, status: body.status };
  }

  /** V5.0.18g：已注销员工恢复入职——恢复为「停用」态（disabled_at 保留，冷静期已满），
   *  再走正常复职流程；原工号原档案复用，历史单据与操作人关联连续。归档快照保留作历史痕迹。 */
  @RequirePerms('staff.manage')
  @Post('employees/:id/restore')
  async restoreEmployee(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const r = await q1<any>(
      `UPDATE employees SET status='停用', updated_at=now()
        WHERE id=$1 AND store_id=$2 AND status='已注销' RETURNING id, emp_no, name`, [id, user.storeId]);
    if (!r) throw new BizException(40003, '仅「已注销」员工可恢复入职（或该员工不在本店）');
    clearAuthStateCache(id);
    await audit(user.storeId, user.sub, '员工', 'employee.restore', 'employee', id, { empNo: r.emp_no, name: r.name });
    return { id, status: '停用', empNo: r.emp_no, name: r.name, note: '已恢复为「停用」状态，请重置密码并复职' };
  }

  /** V4.25.7 店长授权码管理（移到后台员工管理）：设置/修改/清除；authCode 传 null/空串 = 清除 */
  @RequirePerms('staff.manage')
  @Post('employees/:id/auth-code')
  async setAuthCodeAdmin(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { authCode?: string | null },
    @CurrentUser() user: AuthUser,
  ) {
    const code = body.authCode == null ? '' : String(body.authCode).trim();
    const r = await q1<any>(`SELECT id, emp_no, name FROM employees WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!r) throw new BizException(41004, '员工不存在', 404);
    let hash: string | null = null;
    if (code) {
      if (!/^\d{4,8}$/.test(code)) throw new BizException(40003, '授权码须为 4~8 位数字');
      hash = bcrypt.hashSync(code, 10);
    }
    await q(`UPDATE employees SET auth_code_hash=$2, auth_code_set_at=${hash ? 'now()' : 'NULL'} WHERE id=$1`, [id, hash]);
    await audit(user.storeId, user.sub, '系统', hash ? 'staff.auth_code_set' : 'staff.auth_code_clear', 'employee', id,
      { empNo: r.emp_no, name: r.name, by: `${user.empNo}(${user.name})` });
    return { id, empNo: r.emp_no, name: r.name, authCodeSet: !!hash };
  }

  // ═══ V4.13.9 密码自助 / 密保找回 / 管理员重置 ═══

  /** 修改本人密码（我的页面）：验证旧密码 → 更新 */
  @Post('change-password')
  async changePassword(
    @Body() b: { oldPassword?: string; newPassword?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.oldPassword || !b.newPassword) throw new BizException(40003, '旧密码与新密码必填');
    await checkPasswordPolicy(String(b.newPassword));
    const emp = await q1<any>(`SELECT * FROM employees WHERE id=$1`, [user.sub]);
    if (!emp || !bcrypt.compareSync(String(b.oldPassword), emp.password_hash)) {
      throw new BizException(41002, '旧密码错误', 401);
    }
    await q(`UPDATE employees SET password_hash=$2, token_version=COALESCE(token_version,0)+1, updated_at=now() WHERE id=$1`,
      [user.sub, bcrypt.hashSync(String(b.newPassword), 10)]);
    clearAuthStateCache(user.sub); // P1-H5：改密即吊销全部旧会话
    await audit(user.storeId, user.sub, '系统', 'auth.change_password', 'employee', user.sub, {});
    return { ok: true };
  }

  /** 设置/更新密保问题（3 问 3 答；答案 bcrypt 哈希存储，明文不落库）：需验证当前密码 */
  @Post('security-questions')
  async setSecQuestions(
    @Body() b: { currentPassword?: string; questions?: { question: string; answer: string }[] },
    @CurrentUser() user: AuthUser,
  ) {
    const emp = await q1<any>(`SELECT * FROM employees WHERE id=$1`, [user.sub]);
    if (!emp) throw new BizException(41001, '员工不存在', 404);
    if (!bcrypt.compareSync(String(b.currentPassword || ''), emp.password_hash)) {
      throw new BizException(41002, '当前密码错误', 401);
    }
    const qs = (b.questions || []).map(x => ({ q: String(x.question || '').trim(), a: String(x.answer || '').trim() }));
    if (qs.length !== 3 || qs.some(x => !x.q || !x.a)) {
      throw new BizException(40003, '需设置 3 个密保问题且每个答案必填');
    }
    for (let i = 0; i < 3; i++) {
      await q(`UPDATE employees SET sec_question${i + 1}=$2, sec_answer${i + 1}_hash=$3, updated_at=now() WHERE id=$1`,
        [user.sub, qs[i].q, bcrypt.hashSync(qs[i].a, 10)]);
    }
    await audit(user.storeId, user.sub, '系统', 'auth.sec_questions.set', 'employee', user.sub, {});
    return { ok: true };
  }

  /** 忘记密码第一步：按工号取密保问题（公开接口；只返回问题文本，答案永不外传） */
  @Public()
  @Get('security-questions/:empNo')
  async getSecQuestions(@Param('empNo') empNo: string, @Req() req: any) {
    // V4.14.4：IP 维频控，防工号/姓名批量枚举
    if (!allow('sq:' + clientIp(req), 30, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    const emp = await q1<any>(`SELECT emp_no, name, sec_question1, sec_question2, sec_question3 FROM employees WHERE emp_no=$1 AND status='在职'`, [empNo]);
    if (!emp) throw new BizException(41001, '工号不存在或已停用', 404);
    const questions = [emp.sec_question1, emp.sec_question2, emp.sec_question3]
      .map((q2, i) => ({ idx: i + 1, question: q2 })).filter(x => x.question);
    if (!questions.length) {
      throw new BizException(40003, '该账号未设置密保问题，请联系管理员/店长在后台「员工与权限」重置密码');
    }
    return { empNo: emp.emp_no, name: emp.name, questions };
  }

  /** 忘记密码第二步：密保答案全对 → 自助重置密码（公开接口；按工号而非 token） */
  @Public()
  @HttpCode(200)
  @Post('forgot-password')
  async forgotPassword(@Body() b: { empNo?: string; answers?: string[]; newPassword?: string }, @Req() req: any) {
    if (!b.empNo || !b.newPassword) throw new BizException(40003, '工号与新密码必填');
    // V4.14.4：密保答案爆破防护——同工号连错 5 次锁 30 分钟
    const lockKey = 'fp:' + String(b.empNo).trim().toLowerCase();
    const lockSec = lockedFor(lockKey);
    if (lockSec > 0) throw new BizException(42901, `密保答案错误次数过多已锁定，请 ${Math.ceil(lockSec / 60)} 分钟后再试`, 429);
    if (!allow('ip:' + clientIp(req), 100, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    await checkPasswordPolicy(String(b.newPassword));
    const emp = await q1<any>(`SELECT * FROM employees WHERE emp_no=$1 AND status='在职'`, [b.empNo]);
    if (!emp) throw new BizException(41001, '工号不存在或已停用', 404);
    const hashes = [emp.sec_answer1_hash, emp.sec_answer2_hash, emp.sec_answer3_hash].filter(Boolean);
    if (!hashes.length) throw new BizException(40003, '该账号未设置密保问题，请联系管理员/店长重置密码');
    const answers = (b.answers || []).map(a => String(a || '').trim());
    if (answers.length !== hashes.length) throw new BizException(40003, '请回答全部密保问题');
    for (let i = 0; i < hashes.length; i++) {
      if (!bcrypt.compareSync(answers[i], hashes[i])) {
        const min = failAndLock(lockKey, 5, 30 * 60_000);
        if (min > 0) throw new BizException(42901, `密保答案错误次数过多已锁定，请 ${min} 分钟后再试`, 429);
        throw new BizException(41002, '密保答案不正确，请重新核对', 401);
      }
    }
    clearFailures(lockKey);
    await q(`UPDATE employees SET password_hash=$2, token_version=COALESCE(token_version,0)+1, updated_at=now() WHERE id=$1`,
      [emp.id, bcrypt.hashSync(String(b.newPassword), 10)]);
    clearAuthStateCache(Number(emp.id)); // P1-H5
    await audit(emp.store_id, emp.id, '系统', 'auth.forgot_password', 'employee', emp.id, {});
    return { ok: true };
  }

  /** 管理员/店长重置员工密码（员工与权限页）：重置为临时密码，员工登录后可自行修改 */
  @RequirePerms('staff.manage')
  @Post('employees/:id/reset-password')
  async resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { newPassword?: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!b.newPassword) throw new BizException(40003, '新密码必填');
    await checkPasswordPolicy(String(b.newPassword));
    const emp = await q1<any>(`SELECT id, store_id, emp_no FROM employees WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!emp) throw new BizException(41001, '员工不存在', 404);
    await q(`UPDATE employees SET password_hash=$2, token_version=COALESCE(token_version,0)+1, updated_at=now() WHERE id=$1`,
      [id, bcrypt.hashSync(String(b.newPassword), 10)]);
    clearAuthStateCache(id); // P1-H5
    await audit(user.storeId, user.sub, '系统', 'auth.reset_password', 'employee', id, { empNo: emp.emp_no });
    return { ok: true };
  }

  /** V5.0.18g 员工级权限配置（读）：角色基础权限 + 员工覆盖（allow/deny）+ 全量权限目录（按模块分组供勾选） */
  @RequirePerms('staff.manage')
  @Get('employees/:id/perms')
  async getEmployeePerms(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const emp = await q1<any>(`SELECT id, emp_no, name FROM employees WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!emp) throw new BizException(40404, '员工不存在', 404);
    const base = (await q(
      `SELECT DISTINCT pp.code FROM employee_roles er
         JOIN role_permissions rp ON rp.role_id = er.role_id
         JOIN permission_points pp ON pp.id = rp.permission_id
        WHERE er.employee_id=$1`, [id])).map(r => r.code);
    const ov = await q(
      `SELECT pp.code, o.mode FROM employee_perm_overrides o
         JOIN permission_points pp ON pp.id = o.permission_id WHERE o.employee_id=$1`, [id]).catch(() => [] as any[]);
    const catalog = await q(
      `SELECT code, name, module, risk_level FROM permission_points ORDER BY module, id`);
    return { emp: { id: Number(emp.id), empNo: emp.emp_no, name: emp.name }, base,
             allow: ov.filter(x => x.mode === 'allow').map(x => x.code),
             deny: ov.filter(x => x.mode === 'deny').map(x => x.code),
             catalog: catalog.map(r => ({ code: r.code, name: r.name, module: r.module, risk: r.risk_level })) };
  }

  /** V5.0.18g 员工级权限配置（写）：allow/deny 覆盖集全量替换；有效权限 = (角色 ∪ allow) − deny。
   *  生效时机：员工下次登录（perms 打入 JWT）。 */
  @RequirePerms('staff.manage')
  @Put('employees/:id/perms')
  async setEmployeePerms(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { allow?: string[]; deny?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    const emp = await q1<any>(`SELECT id, store_id, emp_no, name FROM employees WHERE id=$1 AND store_id=$2`, [id, user.storeId]);
    if (!emp) throw new BizException(40404, '员工不存在', 404);
    if (emp.emp_no === 'ADMIN') throw new BizException(40003, '超级管理员账号权限固定为全部，不可配置');
    const allow = [...new Set((Array.isArray(b.allow) ? b.allow : []).map(String).filter(Boolean))];
    const deny = [...new Set((Array.isArray(b.deny) ? b.deny : []).map(String).filter(Boolean))];
    const dup = allow.filter(x => deny.includes(x));
    if (dup.length) throw new BizException(40003, `同一权限不能同时出现在增与减中：${dup.join('、')}`);
    await tx(async c => {
      await cx(c, `DELETE FROM employee_perm_overrides WHERE employee_id=$1`, [id]);
      for (const code of allow) {
        await cx(c, `INSERT INTO employee_perm_overrides (employee_id, permission_id, mode)
                      SELECT $1, id, 'allow' FROM permission_points WHERE code=$2
                      ON CONFLICT (employee_id, permission_id) DO UPDATE SET mode='allow', updated_at=now()`, [id, code]);
      }
      for (const code of deny) {
        await cx(c, `INSERT INTO employee_perm_overrides (employee_id, permission_id, mode)
                      SELECT $1, id, 'deny' FROM permission_points WHERE code=$2
                      ON CONFLICT (employee_id, permission_id) DO UPDATE SET mode='deny', updated_at=now()`, [id, code]);
      }
    });
    await audit(user.storeId, user.sub, '员工', 'employee.perms.set', 'employee', id,
      { empNo: emp.emp_no, name: emp.name, allow, deny });
    return { ok: true, allow, deny };
  }

  /** 角色列表 */
  @Get('roles')
  async roles(@CurrentUser() user: AuthUser) {    const rows = await q(
      `SELECT r.*, COALESCE(json_agg(pp.code) FILTER (WHERE pp.code IS NOT NULL), '[]') AS perms
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permission_points pp ON pp.id = rp.permission_id
        WHERE r.store_id=$1 OR r.is_system GROUP BY r.id ORDER BY r.id`, [user.storeId]);
    return rows.map(r => ({ ...r, id: Number(r.id), perms: r.perms || [] }));
  }

  /** 创建自定义角色（V4.8.21 权限点勾选矩阵：perms=权限点 code 数组） */
  @RequirePerms('staff.manage')
  @Post('roles')
  async createRole(
    @Body() body: { name?: string; remark?: string; perms?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body.name || !body.name.trim()) throw new BizException(40003, '角色名称必填');
    const name = body.name.trim();
    const dup = await q1(`SELECT id FROM roles WHERE name=$1 AND (store_id=$2 OR is_system)`, [name, user.storeId]);
    if (dup) throw new BizException(41003, `角色已存在：${name}`);
    const role = await q1(
      `INSERT INTO roles (store_id, name, is_system, remark) VALUES ($1,$2,false,$3) RETURNING *`,
      [user.storeId, name, body.remark ?? null]);
    const codes = [...new Set((body.perms || []).map(x => String(x).trim()).filter(Boolean))];
    for (const code of codes) {
      await q(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permission_points WHERE code=$2 ON CONFLICT DO NOTHING`, [role.id, code]);
    }
    await audit(user.storeId, user.sub, '系统', 'role.create', 'role', Number(role.id), { name, perms: codes });
    return { ...role, perms: codes };
  }

  /** 权限点全量（按模块分组，角色配置用） */
  @Get('permissions')
  permissions() {
    return q(`SELECT id, code, module, name, risk_level FROM permission_points ORDER BY module, code`);
  }
}

@Module({ controllers: [AuthController] })
export class AuthModule {
  /** V4.24.0：超管仍用出厂默认密码时启动告警（管理员账号已可由用户自定义工号） */
  async onModuleInit() {
    try {
      const rows = await q<any>(
        `SELECT e.emp_no, e.password_hash FROM employees e
           JOIN employee_roles er ON er.employee_id = e.id
           JOIN roles ro ON ro.id = er.role_id
          WHERE ro.name = '超级管理员' AND e.status = '在职'`);
      for (const r of rows) {
        if (r.password_hash && bcrypt.compareSync('admin123', r.password_hash)) {
          console.warn(`[安全] ⚠️ 管理员 ${r.emp_no} 仍在使用默认密码 admin123，请尽快登录后台「我的 → 修改密码」修改！`);
          try { notifyStaff(Number((r as any).store_id || 1), 'sec_default_pwd', `⚠️ 管理员 ${r.emp_no} 仍在使用出厂默认密码，请立即修改`, {}, 'sys.settings', 'sec:defaultpwd:' + r.emp_no).catch(() => { }); } catch { /* 告警失败不阻断 */ }
        }
      }
    } catch { /* 基线未就绪（首次 init-db 前）忽略 */ }
  }
}
