-- ═══ 157: 供应商资质/合同/证照表（T3 · 连锁总部统一议价依据 + 食安合规证照有效期预警） ═══
-- 执行方式：init-db.js 顺序执行；必须在 migrations.manifest.json 登记 sha256 才会执行
-- 对应需求：供应商档案缺失资质/合同/证照载体（suppliers 表无相应字段）

CREATE TABLE IF NOT EXISTS supplier_qualifications (
  id             BIGSERIAL PRIMARY KEY,
  supplier_id    BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  store_id       BIGINT NOT NULL REFERENCES stores(id),
  cert_type      VARCHAR(32) NOT NULL,   -- 证照类型：营业执照/食品经营许可证/开户许可证/质检报告/供货合同/其他
  cert_no        VARCHAR(64),            -- 编号
  title          VARCHAR(128),           -- 名称/标题（如「2026 年度供货合同」）
  issuer         VARCHAR(128),           -- 发证机构
  issue_date     DATE,                   -- 发证日期
  expire_date    DATE,                   -- 有效期（NULL=长期）；食安预警依据
  attachment_url VARCHAR(256),           -- 附件图片/PDF（先占位，后续接上传服务）
  remark         VARCHAR(255),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sup_qual_supplier ON supplier_qualifications (supplier_id);
CREATE INDEX IF NOT EXISTS idx_sup_qual_expire  ON supplier_qualifications (expire_date) WHERE expire_date IS NOT NULL;

COMMENT ON TABLE supplier_qualifications IS '供应商资质/合同/证照：连锁总部统一议价依据 + 食安合规证照有效期预警载体';
COMMENT ON COLUMN supplier_qualifications.expire_date IS 'NULL 视为长期有效；非 NULL 且 <= CURRENT_DATE+预警天数 视为临期/过期';
