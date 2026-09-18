-- ═══ V4.18.4 P15 批3：交接班/钱箱过程管理/日结/跨零点（085）═══
--  ① shifts.close_reason：交班差异超容差强制填写的原因（留档追责）
--  ② 权限点 pos.cashbox.open：无交易开钱箱（对钱/放零，权限+留痕 §13 B3/E1）
-- 幂等防线：IF NOT EXISTS / NOT EXISTS

-- ── ① 交班差异原因 ──
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS close_reason VARCHAR(200);
COMMENT ON COLUMN shifts.close_reason IS '交班现金差异原因（V4.18.4 批3）：|diff|>pos.shift.diff_tolerance 时强制填写';

-- ── ② 无交易开钱箱权限点（module 沿用 shift.manage 所在模块） ──
INSERT INTO permission_points (code, module, name, risk_level, remark)
SELECT 'pos.cashbox.open',
       (SELECT module FROM permission_points WHERE code='shift.manage'),
       '无交易开钱箱', 1, '对钱/放零等无交易场景打开钱箱，权限+留痕（§13 B3）；弹箱失败自动留痕（E1）'
WHERE NOT EXISTS (SELECT 1 FROM permission_points WHERE code='pos.cashbox.open');
