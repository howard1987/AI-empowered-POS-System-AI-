-- V5.0.19g · 剥夺应用账号的 TRUNCATE 权限（最小权限再收紧一步）
--
-- 背景：pos_app（应用运行账号）此前被授予 TRUNCATE，因为清库接口要用。
--       代价是：任何人只要拿到应用连接（代码漏洞、注入、被借用的终端），
--       就能整表清空 —— 与本次事故的破坏力等价，而应用层权限/二次确认挡不住这一层。
--
-- 整改：清库（admin.reset.ts）改为显式使用超户连接（RESTORE_DATABASE_URL）执行 TRUNCATE，
--       pos_app 因此不再需要 TRUNCATE。此处清理存量授权，并同步默认权限，
--       防止今后新建的表又自动带上 TRUNCATE。
--
-- ⚠ 必须与 scripts/server-up.mjs 的 ensureAppRole() 同步（那里每次启动会重新 GRANT），
--    否则服务一重启权限就被授回来，本迁移形同虚设。
--
-- 幂等：REVOKE 对"不存在的权限"不报错，但**角色本身不存在时会报
-- role "pos_app" does not exist**（2026-10-10 e2e 干净集群实证）。
-- 故仅当 pos_app 角色已存在（生产路径由 server-up.mjs ensureAppRole 先建）才执行。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_app') THEN
    REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM pos_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM pos_app;
  ELSE
    RAISE NOTICE '197: pos_app 角色不存在（全新集群/e2e），跳过 REVOKE——部署时 ensureAppRole 建角色后重启会按需生效';
  END IF;
END $$;
