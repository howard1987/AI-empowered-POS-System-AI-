-- S-08：店长授权票据一次性消费登记。票据为 120s JWT，签发时带 jti；
-- 结账消费时 INSERT ... ON CONFLICT DO NOTHING 抢占，抢不到 = 已被使用（防 120s 窗口内重放二次改价）。
-- 消费点顺手清理超 1 天的旧记录（票据有效期远小于此，清理仅控表大小）。
CREATE TABLE IF NOT EXISTS auth_ticket_used (
  jti     VARCHAR(64) PRIMARY KEY,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
