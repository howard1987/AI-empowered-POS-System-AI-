-- V5.0.3：通用「手机拍摄指令」请求表——PC 端发起拍摄指令（如报损照片），
-- 同账号店员端（PWA 消息页）拍摄上传回传，PC 轮询取回文件路径。
CREATE TABLE IF NOT EXISTS mobile_photo_requests (
  id          BIGSERIAL PRIMARY KEY,
  token       VARCHAR(48) UNIQUE NOT NULL,
  store_id    BIGINT NOT NULL DEFAULT 1,
  biz_type    VARCHAR(24) NOT NULL DEFAULT 'loss',
  label       VARCHAR(120),
  status      VARCHAR(12) NOT NULL DEFAULT '待拍摄',   -- 待拍摄 / 已上传
  file_path   VARCHAR(256),
  employee_id BIGINT,                                  -- 发起人（回传按同账号隔离）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mpr_pending ON mobile_photo_requests (store_id, employee_id, status);
