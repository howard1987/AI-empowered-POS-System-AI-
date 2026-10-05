-- ═══ V5.0.11b 设备配对码 + 设备与账号解绑（修正 V5.0.11 的 4A 决策）═══
--
-- 【为什么要改】4A「一台设备固定一个员工」与真实业务冲突：
--   收银台是**共用**的——一台收银机白天由张三开、李四午休顶班、店长临时顶一下。
--   按员工强绑定会导致「设备被第一个人占住，其余人全部登不进来」，直接阻塞营业。
--   业务真实诉求是两条，方向相反，必须分开处理：
--     ① 设备维度：未授权设备**任何账号都登不进**；已授权设备可登录**任意**账号（共用收银台）。
--     ② 账号维度：同一个账号同一时间只允许一台设备在线（防同账号多地同时收银/改价）。
--   本迁移实现 ①（配对码授权）与 ②（V5.0.11 已落地，此处仅记录），并把 4A 关闭。
--
-- 【配对码流程】取代「管理员按设备码手工审批」：
--   1. 员工在未授权设备上登录 → 40307「该设备未授权…（设备码 X）」
--   2. 管理员在「系统设置 → 设备管理」看到该待授权设备，点「生成配对码」→ 得到如 K7M2XP9A
--   3. 管理员把配对码告诉现场员工（当面/电话/微信）
--   4. 员工在登录框输入配对码 → 重试登录 → 码正确则「配对成功 → 授权成功 → 登录成功」
--   5. 码错误 → 提示「配对码不正确，请联系管理员重新获取」→ 可反复重试
--
-- 【配对码为什么不是安全窟窿】配对接口不接受匿名授权：
--   服务端在 checkDeviceAuth 之前**已校验工号密码**，且待授权设备记录本身
--   也只有凭据校验通过后才会被登记。配对码是凭证之上的第二道确认，
--   拿不到配对码的人本来也登不进来。

-- ── ① 配对码字段 ──
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS pair_code VARCHAR(16);
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS pair_expires_at TIMESTAMPTZ;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS pair_max_uses INT NOT NULL DEFAULT 1;  -- 0 = 不限次
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS pair_used INT NOT NULL DEFAULT 0;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS paired_at TIMESTAMPTZ;
COMMENT ON COLUMN pos_devices.pair_code IS '管理员为该待授权设备生成的配对码；为空表示无有效配对码。员工在登录框输入后完成配对授权';
COMMENT ON COLUMN pos_devices.pair_max_uses IS '该配对码最多可用几次；0 = 不限次（适合共用收银台一次性放行多台）';

-- ── ② 最近使用人（仅审计，不作为准入条件）──
-- 设备与账号解绑后，仍然需要能回答「这台收银机刚才是谁在用」，
-- 这对收银对账、差异追溯、串货调查都有价值。记录但不拦截。
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS last_emp_id BIGINT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS last_emp_no VARCHAR(32);
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS last_emp_name VARCHAR(64);
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS last_emp_at TIMESTAMPTZ;
COMMENT ON COLUMN pos_devices.last_emp_no IS '最近一次成功登录的使用人工号（仅审计留痕，不限制该账号或其他账号登录本设备）';

-- ── ③ 关闭 4A 设备↔员工强绑定（改默认值为关）──
UPDATE system_settings
   SET value = 'false'::jsonb,
       default_value = 'false'::jsonb,
       remark = '默认关。收银台为共用设备，一台设备需服务多个员工；开启后会变成「一台设备固定一个员工」，导致其他员工登不进。设备准入请用「配对码」'
 WHERE setting_key = 'pos.device.bind.employee';

-- ── ④ 门店设备总量上限：由「可选」升为「必选」──
-- 解耦后，原本「员工数」这个天然上限消失了：任何有凭证的员工都可能配对新设备。
-- 若不限量，门店设备表会随时间无限膨胀（离职员工留下的手机也会一直占额度）。
UPDATE system_settings
   SET value = '10'::jsonb,
       default_value = '10'::jsonb,
       remark = '单个门店最多可登记的授权设备数（含待授权）。按「收银台数 + 老板/店长手机 + 备用机」的 1.5 倍设定，随时可调。超出后新设备无法登记'
 WHERE setting_key = 'pos.device.store.cap';

-- ── ⑤ 配对码参数 ──
INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.pair.ttl.hours', '24'::jsonb, 'number', '设备管理', '配对码有效期（小时）', '24'::jsonb,
       '管理员生成的配对码在多少小时后失效。当天配对建议 24；跨天审批可设 72。过期后员工需重新找管理员要码'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.pair.ttl.hours');

INSERT INTO system_settings (setting_key, value, value_type, group_name, display_name, default_value, remark)
SELECT 'pos.device.pair.max.uses', '1'::jsonb, 'number', '设备管理', '单个配对码可用次数', '1'::jsonb,
       '1 = 只能用一次（最安全）。共用收银台要一次放行多台时生成「不限次」码，或给每台设备分别生成一个码'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='pos.device.pair.max.uses');
