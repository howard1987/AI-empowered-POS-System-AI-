-- V5.0.18：运营完整性批（销售状态同步 / 会员资产约束 / 分红与备份可配置）
--   注意：迁移执行器按分号拆句，本文件不使用 PL/pgSQL 块。

-- ① 销售单 status 与退款同步：此前退款只更新 pay_status（part_refunded/refunded），
--    status 永远停在「已完成」，而报表/连锁按 status IN ('已退款','部分退款') 统计 → 恒为 0。
--    存量回填（新代码在退款执行时同步写 status，见 refund.module）：
UPDATE sales_orders SET status = '已退款'
 WHERE pay_status = 'refunded' AND status = '已完成';
UPDATE sales_orders SET status = '部分退款'
 WHERE pay_status = 'part_refunded' AND status = '已完成';

-- ② 会员资产非负硬约束（NOT VALID：不回查存量，只拦新增写入；
--    正常业务路径——余额支付/积分抵扣/分红抵扣/退款回冲——均有防负封顶，写负即 bug，让约束把它暴露出来）
ALTER TABLE member_accounts DROP CONSTRAINT IF EXISTS ck_member_accounts_nonneg;
ALTER TABLE member_accounts ADD CONSTRAINT ck_member_accounts_nonneg
  CHECK (balance >= 0 AND points >= 0 AND dividend_balance >= 0) NOT VALID;

-- ③ 分红自动计提时间可配置（服务器 02:35 未开机则当天永不计提的根因之一；
--    配合代码改为「到点后首次巡检即补跑」语义，见 DividendAutoJob）
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('dividend.auto.time', '财务管理', '自动计提时间', '"02:35"', '"02:35"', 'string',
  '每日自动分红计提与到期失效回冲的触发时刻（HH:MM，服务器本地时间）。到点后服务在线即补跑（幂等），晚开机不会漏计提；建议设在日结（00:05）之后、备份时间之前')
ON CONFLICT (setting_key) DO NOTHING;

-- ④ 数据库备份保留策略：数量上限（循环覆盖最旧）+ 总大小上限（默认不限）
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('ops.backup.keep_count', '门店与运维', '备份保留份数', '14', '14', 'number',
  '最多保留最近 N 份备份，超出循环删除最旧的一份（0=不限，仅按天数过期）；与「每日备份时间」「保留天数」共同生效')
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO system_settings (setting_key, group_name, display_name, value, default_value, value_type, remark)
VALUES ('ops.backup.max_total_gb', '门店与运维', '备份总占用上限(GB)', '0', '0', 'number',
  '备份目录总占用超过该值时，从最旧的备份开始删除直到达标（0=不按大小限制，仅按份数/天数清理）')
ON CONFLICT (setting_key) DO NOTHING;