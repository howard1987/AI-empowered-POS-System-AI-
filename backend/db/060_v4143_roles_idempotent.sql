-- V4.14.3 遗留收口：roles 幂等防线（init-db 全量重放修复，V4.14.0 遗留#4）
-- 背景：001 的 roles 种子为裸 INSERT 且表无 (store_id,name) 唯一约束——
--       半初始化库重放会插出重复角色，进而使「超级管理员=全部权限点」绑定
--       子查询报 more than one row；全新库则因 058 同事务用新枚举值报
--       unsafe use of new value（init-db 已改语句级执行，本迁移补存量库约束）。
-- 幂等：可重复执行。

-- 1) 存量去重：同名同店角色保留最小 id（先合并权限与员工绑定，再删重复行）
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT store_id, name, min(id) AS keep_id
    FROM roles GROUP BY store_id, name HAVING count(*) > 1
  LOOP
    -- 权限点并入保留行（目标已有的忽略）
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.keep_id, p.permission_id
    FROM role_permissions p
    WHERE p.role_id IN (SELECT id FROM roles WHERE store_id = r.store_id AND name = r.name AND id <> r.keep_id)
    ON CONFLICT DO NOTHING;
    -- 员工绑定迁移：员工已绑保留行时先删重复绑定，防合并后主键冲突
    DELETE FROM employee_roles er
    USING roles d
    WHERE er.role_id = d.id AND d.store_id = r.store_id AND d.name = r.name AND d.id <> r.keep_id
      AND er.employee_id IN (SELECT employee_id FROM employee_roles WHERE role_id = r.keep_id);
    UPDATE employee_roles er SET role_id = r.keep_id
    FROM roles d
    WHERE er.role_id = d.id AND d.store_id = r.store_id AND d.name = r.name AND d.id <> r.keep_id;
    -- 删除重复角色（CASCADE 顺带清其 role_permissions）
    DELETE FROM roles WHERE store_id = r.store_id AND name = r.name AND id <> r.keep_id;
  END LOOP;
END $$;

-- 2) 唯一约束（不存在才加，防重放报错）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_store_name_uq') THEN
    ALTER TABLE roles ADD CONSTRAINT roles_store_name_uq UNIQUE (store_id, name);
  END IF;
END $$;
