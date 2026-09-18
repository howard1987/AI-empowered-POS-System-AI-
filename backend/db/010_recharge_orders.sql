-- ═══ 010: 会员充值闭环（H5 发起 → 收银台代收 → 入账，5.7.2 储值） ═══
-- 执行方式：init-db.ts 顺序执行 db/0*.sql；幂等

-- 1) 充值档位（充 X 送 Y；后台可配，H5 只读启用档）
CREATE TABLE IF NOT EXISTS recharge_plans (
  id          BIGSERIAL PRIMARY KEY,
  store_id    BIGINT NOT NULL DEFAULT 1,
  name        VARCHAR(50) NOT NULL,
  principal   NUMERIC(12,2) NOT NULL CHECK (principal > 0),
  gift        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gift >= 0),
  status      VARCHAR(10) NOT NULL DEFAULT '启用',
  sort_no     INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ
);
COMMENT ON TABLE recharge_plans IS '充值档位：principal 入账本金，gift 赠送金额（赠送计入 gift_balance，不计分红权重）';

-- 2) 充值单（会员 H5 发起，收银台代收确认后入账；创建时即锁定赠送金额=服务端按档计算，客户端不可传）
CREATE TABLE IF NOT EXISTS recharge_orders (
  id              BIGSERIAL PRIMARY KEY,
  order_no        VARCHAR(30) NOT NULL UNIQUE,
  store_id        BIGINT NOT NULL DEFAULT 1,
  member_id       BIGINT NOT NULL REFERENCES members(id),
  plan_id         BIGINT REFERENCES recharge_plans(id),
  principal       NUMERIC(12,2) NOT NULL CHECK (principal > 0),
  gift            NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          VARCHAR(10) NOT NULL DEFAULT '待支付',
  pay_channel     VARCHAR(10),
  balance_flow_id BIGINT,
  collected_by    BIGINT,
  collected_at    TIMESTAMPTZ,
  shift_id        BIGINT,
  remark          VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_member ON recharge_orders(member_id, status);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_status ON recharge_orders(status, created_at);
COMMENT ON COLUMN recharge_orders.status IS '待支付/已入账/已取消/已过期';
COMMENT ON COLUMN recharge_orders.pay_channel IS '代收通道：现金/扫码';

-- 3) 设置项
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
 ('会员', 'member.recharge.max_single', '单笔充值上限(元)', '5000', '5000', 'num', '会员 H5 发起充值单的单笔本金上限，超出拒绝（42017）'),
 ('会员', 'member.recharge.orders_expire_hours', '充值单待支付有效期(小时)', '24', '24', 'num', '超过有效期未支付的充值单，代收时拦截（50075），会员可取消重发')
ON CONFLICT (setting_key) DO NOTHING;
