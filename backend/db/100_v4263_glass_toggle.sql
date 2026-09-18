-- 100_v4263_glass_toggle.sql
-- V4.26.3 · 界面外观：液态玻璃效果总开关
--   1) 新增通用设置 ui.glass.enabled（bool，默认开）
--      - 开：后台浮层（返回顶部按钮、通知面板）与收银端支付弹层使用半透明磨砂玻璃质感
--      - 关：全部回退为普通实底色（低配收银机 / Win7(ia32) 建议关，backdrop-filter 有性能开销）
--   2) 生效方式
--      - 后台：登录后读一次 → html.no-glass 类；设置页改完即时生效（不需重启）
--      - 收银端：收银台初始化随其它设置一起读；关掉时 .modal .sheet 走原实底样式
--   3) 说明：仅影响视觉，不涉及任何业务数据与打印
-- 幂等：可重复执行
-- =====================================================================

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
VALUES
  ('通用设置', 'ui.glass.enabled', '液态玻璃效果', 'true'::jsonb, 'true'::jsonb, 'bool',
   '开=浮层与支付弹层用半透明磨砂玻璃质感（更精致）；关=改用普通实底色（低配收银机 / Win7 推荐关）')
ON CONFLICT (setting_key) DO NOTHING;
