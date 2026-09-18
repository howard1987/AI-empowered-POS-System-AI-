-- 055：语音播报拟人化（用户需求：语音不要机械，应拟真人/自然，并提供多音色选择）
--   涉及场景：收款提示 / 商品语音 / 智能客服语音 / 语音查价（统一走 PwaTTS 引擎）
--   引擎分层（对齐系统 auto 探测惯例）：auto=拟真人声优先（浏览器在线神经音色，如 Edge
--   「晓晓/云希 Online (Natural)」，接近真人），不可用自动回落本地音色；local=纯离线本地音色
--   幂等：全部语句可重放

-- ── ① 新增设置项（通用设置组）──
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT * FROM (VALUES
  ('通用设置', 'voice.tts.mode', '播报音色风格', '"auto"'::jsonb, '"auto"'::jsonb, 'enum',
   '自动=拟真人声优先、不可用回落本地；拟真人声更自然但需联网；本地音色离线可用、相对机械'),
  ('通用设置', 'voice.tts.voice', '播报音色', '""'::jsonb, '""'::jsonb, 'string',
   '空=自动选最佳中文声（女声优先）；设置页可下拉试听本机全部音色，带 ⭐ 为拟真人声'),
  ('通用设置', 'voice.tts.rate', '播报语速', '1'::jsonb, '1'::jsonb, 'number',
   '0.5~2 倍，1 为正常语速；收款播报建议 1~1.2'),
  ('通用设置', 'voice.tts.pitch', '播报音调', '1'::jsonb, '1'::jsonb, 'number',
   '0.5~2，1 为正常音调；偏低显沉稳、偏高显清亮'),
  ('通用设置', 'voice.assistant.enabled', '智能客服语音朗读', 'true'::jsonb, 'true'::jsonb, 'bool',
   '老板端「经营问答」出答案后自动朗读；点喇叭可重听'),
  ('通用设置', 'voice.product.enabled', '商品到货播报', 'true'::jsonb, 'true'::jsonb, 'bool',
   '收银端扫码/录入商品时播报商品名，双眼不离小票也能听清扫了什么')
) AS v(group_name, setting_key, display_name, value, default_value, value_type, remark)
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = v.setting_key);

-- ── ② 音色风格枚举选项 ──
UPDATE system_settings SET enum_options='[
  {"v":"auto","label":"自动（拟真人声优先，推荐）"},
  {"v":"natural","label":"拟真人声（在线神经音色，需联网）"},
  {"v":"local","label":"本地音色（离线可用，较机械）"}
]'::jsonb
 WHERE setting_key='voice.tts.mode' AND value_type='enum' AND enum_options IS NULL;

-- ── ②-1 语速单位后置（V4.13.7 unit 列约定：单位拼在当前值后，说明列放说明）──
UPDATE system_settings SET unit='倍' WHERE setting_key='voice.tts.rate' AND (unit IS NULL OR unit='');

-- ── ③ 原「语音播报」说明升级（语义不变：收款播报总开关）──
UPDATE system_settings SET remark='收银完成后的收款金额语音提示（「收款 X 元，谢谢惠顾」）；音色在「语音播报」小节选择'
 WHERE setting_key='pos.voice_broadcast';
UPDATE system_settings SET remark='语音提问查价的回答播报；音色/语速在「语音播报」小节统一配置'
 WHERE setting_key='voice.price.enabled';
