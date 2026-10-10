-- V5.0.19f · 高危数据操作「独立权限点」（2026-10-09 清库事故整改 · 权限边界）
--
-- 🔴 原设计缺陷（严重）：清库 POST /admin/reset/execute 与恢复 POST /admin/backup/restore
--    都挂在 sys.data.backup（"数据库备份"）这一个权限点上 —— 也就是说，任何一个被授予
--    「备份数据库」这种日常只读型运维权限的账号，都能顺手清空整个经营库。权限边界严重过宽，
--    与"最小权限原则"背道而驰；事故中更是没有任何一道防线能拦住。
--
-- 整改：
--   ① 拆出两个独立高危权限点，risk_level=3（最高），与备份权限彻底分离；
--   ② 默认**只授予「超级管理员」**（店长/财务/库管等一律没有），需要下放时必须显式勾选；
--   ③ 代码侧再加两道闸：登录密码复核 + 影响行数确认（见 admin.reset.ts / admin.backup.ts）。
--
-- 幂等：ON CONFLICT DO NOTHING + NOT EXISTS，可重复执行。

INSERT INTO permission_points (code, module, name, risk_level, remark) VALUES
 ('sys.data.reset',   '系统', '系统初始化（开业前清库）', 3,
  '清空全部经营数据，不可逆；执行前强制全量备份 + 登录密码复核 + 影响行数确认'),
 ('sys.data.restore', '系统', '数据库恢复（覆盖当前库）', 3,
  '从备份整体还原并覆盖当前库；执行前自动拍保险快照 + 登录密码复核 + 备份名二次确认')
ON CONFLICT (code) DO NOTHING;

-- 只授予超级管理员（其余角色必须显式授权才可用）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, pp.id
  FROM roles r
  JOIN permission_points pp ON pp.code IN ('sys.data.reset', 'sys.data.restore')
 WHERE r.name = '超级管理员'
   AND NOT EXISTS (SELECT 1 FROM role_permissions x
                    WHERE x.role_id = r.id AND x.permission_id = pp.id);
