import { Module, Controller, Post, Get, Delete, Body, HttpCode, Param, ParseIntPipe, Req } from '@nestjs/common';
import { RequirePerms } from '../common/auth';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { q, q1, tx, audit } from '../common/db';
import { BizException } from '../common/http';
import { AuthUser, CurrentUser, JWT_SECRET, Public, clearAuthStateCache } from '../common/auth';
import { lanIPv4, MDNS_HOST } from '../common/cert';
import { q as qSetting } from '../common/db';
import { allow, failAndLock, lockedFor, clearFailures, clientIp } from '../common/ratelimit';
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

// ─── Service ───
class AuthService {
  /** V4.21.1 收银机设备校验：pos.device.auth 开启后，员工登录须使用已授权设备。
   *  首次见到设备码自动登记为「待授权」（40307 带设备码提示管理员审批）；
   *  ADMIN 超管豁免（保证老板永远能登录审批，防锁死）。MAC 浏览器不可得，采用设备码+UA 白名单。 */
  private async checkDeviceAuth(emp: any, deviceCode: string, ua: string, ip: string) {
    const on = await getSetting('pos.device.auth', false);
    if (!on || on === 'false' || on === '0' || on === 0) return;
    if (await isSuperAdmin(emp.id)) return;   // 超管豁免：老板端永远可登录（审批入口不被锁）；V4.24.0 改按角色判定
    const code = String(deviceCode || '').trim().toUpperCase();
    if (!code) throw new BizException(40306, '设备授权已开启：本机尚未登记设备码，请刷新页面后重试', 403);
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) throw new BizException(40003, '设备码格式非法', 403);
    const row = await q1<any>(
      `SELECT * FROM pos_devices WHERE store_id=$1 AND device_code=$2`, [emp.store_id, code]);
    if (!row) {
      await q(`INSERT INTO pos_devices (store_id, device_code, ua, status, last_ip)
               VALUES ($1,$2,$3,'待授权',$4) ON CONFLICT (store_id, device_code) DO NOTHING`,
        [emp.store_id, code, String(ua || '').slice(0, 400), ip]);
      throw new BizException(40307, `本机设备待授权（设备码 ${code}）：请管理员在后台「系统设置→收银机授权」审批通过后再登录`, 403);
    }
    if (row.status === '待授权') {
      await q(`UPDATE pos_devices SET last_seen_at=now(), last_ip=$2, ua=COALESCE(NULLIF($3,''),ua) WHERE id=$1`,
        [row.id, ip, String(ua || '').slice(0, 400)]);
      throw new BizException(40307, `本机设备待授权（设备码 ${code}）：请管理员在后台「系统设置→收银机授权」审批通过后再登录`, 403);
    }
    if (row.status === '已停用') {
      throw new BizException(40308, '本机授权已被停用，请联系管理员（设备码 ' + code + '）', 403);
    }
    await q(`UPDATE pos_devices SET last_seen_at=now(), last_ip=$2 WHERE id=$1`, [row.id, ip]);
  }

  /** V4.24.0：签发 token（登录 / 扫码登录 / PIN 登录三路共用，权限点与安全标记口径一致） */
  private async issue(emp: any, auditAction: string) {
    const perms = await q<{ code: string }>(
      `SELECT DISTINCT pp.code
         FROM employee_roles er
         JOIN role_permissions rp ON rp.role_id = er.role_id
         JOIN permission_points pp ON pp.id = rp.permission_id
        WHERE er.employee_id = $1`, [emp.id],
    );
    // 超管通配：绑定「超级管理员」角色 → 持有 '*'（后端守卫豁免 + 前端权限位全通过）
    const permCodes = (await isSuperAdmin(emp.id)) ? ['*', ...perms.map(p => p.code)] : perms.map(p => p.code);
    // V5.0.0 连锁：登录时解析一次数据范围打入 JWT（与 perms 同策略，请求内零查库）
    const { ds, ss, hq } = await resolveScope(emp);
    // P0-F3：仍在使用出厂默认密码 → token 打 pwd=default 标记，守卫端强制先改密
    const usingDefault = bcrypt.compareSync('admin123', emp.password_hash || '');
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
  async login(empNo: string, password: string, deviceCode?: string, ua?: string, ip?: string) {
    if (!empNo || !password) throw new BizException(40001, '工号与密码必填');
    const emp = await q1<any>(
      `SELECT * FROM employees WHERE emp_no=$1 AND status='在职'`, [empNo],
    );
    if (!emp || !emp.password_hash) throw new BizException(41001, '工号或密码错误', 401);
    if (!bcrypt.compareSync(password, emp.password_hash)) throw new BizException(41002, '工号或密码错误', 401);
    // V4.21.1：凭证通过后校验设备授权（先验凭证防未授权设备探测账号/刷待授权记录）
    await this.checkDeviceAuth(emp, deviceCode || '', ua || '', ip || '');
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
  async qrLogin(ticket: string, deviceCode?: string, ua?: string, ip?: string) {
    const t = ticket ? qrTickets.get(ticket) : null;
    if (!t) throw new BizException(41003, '登录二维码无效或已被使用', 401);
    qrTickets.delete(ticket);                               // 先消费：保证一次性
    if (t.exp < Date.now()) throw new BizException(41004, '登录二维码已过期，请在后台重新生成', 401);
    const emp = await q1<any>(`SELECT * FROM employees WHERE id=$1 AND status='在职'`, [t.empId]);
    if (!emp) throw new BizException(41001, '员工不存在或已离职', 401);
    // V4.21.1：扫码登录同样校验设备授权（手机/PAD 也是收银设备）
    await this.checkDeviceAuth(emp, deviceCode || '', ua || '', ip || '');
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
  async pinLogin(empNo: string, pin: string, deviceCode?: string, ua?: string, ip?: string) {
    const no = String(empNo || '').trim();
    if (!no || !pin) throw new BizException(40001, '工号与 PIN 必填');
    const emp = await q1<any>(`SELECT * FROM employees WHERE emp_no=$1 AND status='在职'`, [no]);
    if (!emp || !emp.pin_hash) throw new BizException(41011, '该工号未设置 PIN，请改用密码登录', 401);
    if (!bcrypt.compareSync(String(pin), emp.pin_hash)) throw new BizException(41012, 'PIN 不正确', 401);
    await this.checkDeviceAuth(emp, deviceCode || '', ua || '', ip || '');
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
    // 资格校验：须持「改价/折扣授权」权限点（超管等价）
    const superAdmin = await isSuperAdmin(emp.id);
    const hasPerm = superAdmin || !!(await q1(
      `SELECT 1 AS ok FROM employee_roles er
         JOIN role_permissions rp ON rp.role_id = er.role_id
         JOIN permission_points pp ON pp.id = rp.permission_id
        WHERE er.employee_id=$1 AND pp.code='pos.price.authorize' LIMIT 1`, [Number(emp.id)]));
    if (!hasPerm) throw new BizException(41022, '该工号无改价/折扣授权资格（需店长级权限）', 403);
    if (!bcrypt.compareSync(String(authCode), emp.auth_code_hash)) throw new BizException(41023, '授权码不正确', 401);
    const ticket = jwt.sign(
      { sub: Number(emp.id), empNo: emp.emp_no, name: emp.name, scope: 'price' },
      JWT_SECRET, { expiresIn: 120 });
    await audit(Number(emp.store_id), Number(emp.id), '收银', 'auth.price_authorize', 'employee', Number(emp.id),
      { by: `${emp.emp_no}(${emp.name})` });
    return { ticket, expiresIn: 120, authorizer: { empNo: emp.emp_no, name: emp.name } };
  }

  /** V4.25.7 本人静默自授权（后台 pos.price.auth_self=on 时由收银台调用）：
   *  须持 pos.price.authorize；用登录态证明身份、免输授权码；票据口径与 /auth/authorize 完全一致，仍写审计留痕 */
  async authorizeSelf(user: AuthUser) {
    const superAdmin = await isSuperAdmin(user.sub);
    const hasPerm = superAdmin || !!(await q1(
      `SELECT 1 AS ok FROM employee_roles er
         JOIN role_permissions rp ON rp.role_id = er.role_id
         JOIN permission_points pp ON pp.id = rp.permission_id
        WHERE er.employee_id=$1 AND pp.code='pos.price.authorize' LIMIT 1`, [Number(user.sub)]));
    if (!hasPerm) throw new BizException(41022, '当前账号无改价/折扣授权资格（需店长级权限）', 403);
    const ticket = jwt.sign(
      { sub: Number(user.sub), empNo: user.empNo, name: user.name, scope: 'price' },
      JWT_SECRET, { expiresIn: 120 });
    await audit(user.storeId, Number(user.sub), '收银', 'auth.price_authorize_self', 'employee', Number(user.sub),
      { by: `${user.empNo}(${user.name})`, via: 'self' });
    return { ticket, expiresIn: 120, authorizer: { empNo: user.empNo, name: user.name } };
  }
}

// ─── Controller ───
@Controller('auth')
class AuthController {
  private svc = new AuthService();

  /** VQA（需求3）：已停用员工允许删除——仅限「停用」且无任何业务记录的账号；有记录一律拒绝并建议保留停用 */
  @RequirePerms('staff.manage')
  @Delete('employees/:id')
  async deleteEmployee(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const eid = Number(id);
    if (user && Number(user.sub) === eid) throw new BizException(40003, '不能删除当前登录账号');
    const emp = await q1<any>(`SELECT id, emp_no, name, status FROM employees WHERE id=$1`, [eid]);
    if (!emp) throw new BizException(40404, '员工不存在', 404);
    if (String(emp.emp_no).toUpperCase() === 'ADMIN') throw new BizException(40003, '超级管理员账号不可删除');
    if (emp.status !== '停用') throw new BizException(40003, '仅「停用」状态员工可删除，请先停用');
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
    if (refs.length) throw new BizException(40003, `该员工存在业务记录（${refs.slice(0, 3).join('、')}${refs.length > 3 ? ' 等' : ''}），禁止物理删除；建议保留「停用」状态以满足审计追溯`, 400);
    await tx(async c => {
      await c.query(`DELETE FROM employee_roles WHERE employee_id=$1`, [eid]);
      await c.query(`DELETE FROM employees WHERE id=$1`, [eid]);
    });
    await audit(user.storeId, user.sub, '员工', 'employee.delete', 'employee', eid, { empNo: emp.emp_no, name: emp.name });
    return { deleted: true, empNo: emp.emp_no, name: emp.name };
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(@Body() body: { empNo?: string; password?: string; deviceCode?: string }, @Req() req: any) {
    // V4.14.4 安全加固：登录爆破防护——账号维连错 5 次锁 15 分钟 + IP 维 100 次/5 分钟
    const empNo = String(body.empNo || '');
    const ipKey = 'ip:' + clientIp(req);
    const lockKey = 'login:' + empNo.trim().toLowerCase();
    const lockSec = lockedFor(lockKey);
    if (lockSec > 0) throw new BizException(42901, `密码连续错误已锁定，请 ${Math.ceil(lockSec / 60)} 分钟后再试`, 429);
    if (!allow(ipKey, 100, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    try {
      const r = await this.svc.login(empNo, body.password || '',
        String(body.deviceCode || ''), String(req.headers['user-agent'] || ''), clientIp(req));
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
  async pinLogin(@Body() b: { empNo?: string; pin?: string; deviceCode?: string }, @Req() req: any) {
    const empNo = String(b.empNo || '');
    const lockKey = 'pin:' + empNo.trim().toLowerCase();
    const lockSec = lockedFor(lockKey);
    if (lockSec > 0) throw new BizException(42901, `PIN 连续错误已锁定，请 ${Math.ceil(lockSec / 60)} 分钟后再试`, 429);
    if (!allow('ip:' + clientIp(req), 200, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    try {
      const r = await this.svc.pinLogin(empNo, String(b.pin || ''),
        String(b.deviceCode || ''), String(req.headers['user-agent'] || ''), clientIp(req));
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
  async qrLogin(@Body() body: { ticket?: string; deviceCode?: string }, @Req() req: any) {
    // V4.14.4：票据本身 128bit 随机无爆破面，IP 维频控兜底
    if (!allow('qrl:' + clientIp(req), 30, 5 * 60_000)) throw new BizException(42902, '尝试过于频繁，请稍后再试', 429);
    return this.svc.qrLogin(String(body.ticket || ''), String(body.deviceCode || ''),
      String(req.headers['user-agent'] || ''), clientIp(req));
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const st = await q1<any>(`SELECT name FROM stores WHERE id=$1`, [user.storeId || 1]);
    return { staffId: user.sub, empNo: user.empNo, name: user.name, storeId: user.storeId, perms: user.perms,
             storeName: String(st?.name || ''),
             // V5.0.0 连锁：前端据此裁剪菜单（hqOnly）与显示门店选择器
             dataScope: user.ds ?? 'all', scopeStores: user.ss ?? null, hq: !!user.hq };
  }

  /** 员工列表（含角色） */
  @Get('employees')
  async employees(@CurrentUser() user: AuthUser) {
    const emps = await q(
      `SELECT e.id, e.emp_no, e.name, e.phone, e.status, e.last_login_at,
              e.auth_code_hash IS NOT NULL AS auth_code_set,
              COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name))
                       FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM employees e
         LEFT JOIN employee_roles er ON er.employee_id = e.id
         LEFT JOIN roles r ON r.id = er.role_id
        WHERE e.store_id=$1 GROUP BY e.id ORDER BY e.id`, [user.storeId]);
    // P2-M2：无人事/排班/对账类权限的查看者，收敛手机号与登录时间（下拉仍可用）
    const full = ['sys.user.manage', 'staff.manage', 'shift.manage', 'recon.confirm']
      .some(p => user.perms.includes(p)) || user.perms.includes('*');
    return emps.map(e => ({ id: Number(e.id), empNo: e.emp_no, name: e.name,
                            phone: full ? e.phone : undefined,
                            status: e.status, lastLoginAt: full ? e.last_login_at : undefined, roles: e.roles || [],
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
    const r = await q1(`UPDATE employees SET status=$2, updated_at=now() WHERE id=$1 AND store_id=$3 RETURNING id`,
      [id, body.status, user.storeId]);
    if (!r) throw new BizException(41004, '员工不存在', 404);
    clearAuthStateCache(id); // P1-H5：停用/复职即时反映到守卫（免等 60s 缓存）
    if (body.status === '停用') {
      await q(`UPDATE signature_templates SET status=0 WHERE ref_employee_id=$1 AND status=1`, [id]);
    }
    await audit(user.storeId, user.sub, '系统', 'staff.status', 'employee', id,
      { status: body.status, invalidatedTemplates: body.status === '停用' });
    return { id, status: body.status };
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
