-- VQA 走查修复批次（2026-09-18）：①秤码校验位验算开关登记；②退款离线补传幂等唯一索引（DEF-06）
-- 幂等：可随启动重放

INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark)
SELECT '智能与打印', 'ai.scale.check_verify', '秤码校验位验算', to_jsonb('on'::text), to_jsonb('on'::text), 'string',
       'on=按 EAN mod10 验算秤码校验位（结构正确的假码拒收）；off=兼容非标算法的旧秤（跳过后置「未配置」提示重打）。改后需真机验证本店秤签算法'
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key='ai.scale.check_verify');

-- 退款补传幂等兜底：client_ref 部分唯一索引（有历史重复时跳过并提示，不删数据）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ux_srefund_client_ref') THEN
    IF EXISTS (SELECT 1 FROM (SELECT client_ref FROM sale_refunds WHERE client_ref IS NOT NULL GROUP BY client_ref HAVING COUNT(*)>1) d) THEN
      RAISE NOTICE 'sale_refunds.client_ref 存在重复历史数据，跳过唯一索引创建（需人工并单后重放）';
    ELSE
      EXECUTE 'CREATE UNIQUE INDEX ux_srefund_client_ref ON sale_refunds (client_ref) WHERE client_ref IS NOT NULL';
    END IF;
  END IF;
END $$;
