-- 064 · V4.15.3 远程电子签名：电脑端无手写板时发起签名请求 → 手机端「我的-电子签名」充当手写板采集回传
-- 幂等：CREATE TABLE IF NOT EXISTS + 唯一索引防取件码重复

CREATE TABLE IF NOT EXISTS remote_sign_requests (
  id                BIGSERIAL PRIMARY KEY,
  store_id          BIGINT NOT NULL DEFAULT 1,
  req_no            VARCHAR(16) NOT NULL,                  -- 6 位取件码（手机端与电脑端核对同一次请求）
  title             VARCHAR(128) NOT NULL,                 -- 签名用途（如：入库单 DH20260910 业务员签字）
  person_hint       VARCHAR(64),                           -- 应签人提示（手机端预填签字人姓名）
  biz_ref           VARCHAR(64),                           -- 业务单号/来源展示
  status            VARCHAR(16) NOT NULL DEFAULT '待签字',  -- 待签字/已签字/已取消/已过期
  result_image_path VARCHAR(256),                          -- 签字图（backend/public/signatures 落盘，与现场补签同目录同证据链）
  result_person     VARCHAR(32),                           -- 手机端实际签字人姓名
  created_by        BIGINT,                                -- 发起人（电脑端操作员 employee_id）
  created_by_name   VARCHAR(32),
  signed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_remote_sign_req_no ON remote_sign_requests (req_no);
CREATE INDEX IF NOT EXISTS idx_remote_sign_status ON remote_sign_requests (store_id, status, created_at DESC);
