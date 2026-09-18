-- ═══════════════════════════════════════════════════════════════════
-- 058 · V4.14.1 批量整改（员工移动工作台 / 设置合并 / 供应商变更单 / 促销新类型 / AI 按商品采集 / 密码策略）
-- 幂等：可重复执行；ALTER TYPE ADD VALUE 需在事务外（本文件由 init-db.js / node 直跑逐条执行）
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 促销类型枚举扩展：定时打折 / 捆绑销售 / 消费后奖励 / 满件折扣 ──
ALTER TYPE promo_kind_t ADD VALUE IF NOT EXISTS '定时打折';
ALTER TYPE promo_kind_t ADD VALUE IF NOT EXISTS '捆绑销售';
ALTER TYPE promo_kind_t ADD VALUE IF NOT EXISTS '消费后奖励';
ALTER TYPE promo_kind_t ADD VALUE IF NOT EXISTS '满件折扣';

-- ── 2. 供应商变更单（参照供货资格变更单：调进价/售价/主供应商切换，落单留痕+即时生效） ──
CREATE TABLE IF NOT EXISTS supplier_changes (
  id               BIGSERIAL PRIMARY KEY,
  store_id         BIGINT NOT NULL DEFAULT 1,
  change_no        VARCHAR(32) NOT NULL,                     -- GYSBG-YYYYMMDD-NNN
  old_supplier_id  BIGINT,
  new_supplier_id  BIGINT NOT NULL,
  items            JSONB NOT NULL,                           -- [{productId,productName,barcode,unit,spec,oldCost,newCost,oldPrice,newPrice,isPrimary,oldPrimarySupplierId}]
  reason           VARCHAR(200),
  status           VARCHAR(16) NOT NULL DEFAULT '已完成',
  created_by       BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_changes_sup ON supplier_changes (store_id, old_supplier_id, new_supplier_id);

-- ── 3. 促销模板去重 + 清理无引擎实现的类型 + 新增四类模板 ──
-- 3.1 去重：同名同类型只保留最小 id（历史 e2e 重放种子导致的重复卡）
DELETE FROM promotion_templates a
 USING promotion_templates b
 WHERE a.kind = b.kind AND a.name = b.name AND a.id > b.id;
-- 3.2 清理名义存在但引擎不支持的类型模板（临期自动/会员日）
DELETE FROM promotion_templates WHERE kind IN ('临期自动', '会员日');
-- 3.3 新增四类模板（按名称防重；ON CONFLICT DO NOTHING 兜底重放）
INSERT INTO promotion_templates (name, kind, rules_template, remark)
SELECT '晚间定时打折（20点后7折）', '定时打折', '{"startTime":"20:00","endTime":"22:00","rate":0.7}', '每日时间窗内指定商品/分类打折（如晚8点后生鲜7折）'
WHERE NOT EXISTS (SELECT 1 FROM promotion_templates WHERE name='晚间定时打折（20点后7折）');
INSERT INTO promotion_templates (name, kind, rules_template, remark)
SELECT 'A+B捆绑组合价', '捆绑销售', '{"items":[{"productId":0,"qty":1},{"productId":0,"qty":1}],"bundlePrice":12}', '购物车同时含 A+B（各1件）时按组合价计（如 A10元+B5元 → 12元）；创建后编辑商品与组合价'
WHERE NOT EXISTS (SELECT 1 FROM promotion_templates WHERE name='A+B捆绑组合价');
INSERT INTO promotion_templates (name, kind, rules_template, remark)
SELECT '消费满额发券', '消费后奖励', '{"threshold":100,"rewardType":"coupon","couponTemplateId":0}', '单笔消费满阈值自动发购物券（受券模板总量池/每人限领约束）；需先在优惠券建券模板'
WHERE NOT EXISTS (SELECT 1 FROM promotion_templates WHERE name='消费满额发券');
INSERT INTO promotion_templates (name, kind, rules_template, remark)
SELECT '消费满额赠商品', '消费后奖励', '{"threshold":88,"rewardType":"gift","giftName":"赠品一份"}', '单笔消费满阈值赠商品（订单备注留痕，店员现场赠送）'
WHERE NOT EXISTS (SELECT 1 FROM promotion_templates WHERE name='消费满额赠商品');
INSERT INTO promotion_templates (name, kind, rules_template, remark)
SELECT '满件多折（满5件8折）', '满件折扣', '{"minQty":5,"rate":0.8}', '同分类/多商品合计满 N 件总价打折（夏天雪糕、冬天火锅类）'
WHERE NOT EXISTS (SELECT 1 FROM promotion_templates WHERE name='满件多折（满5件8折）');

-- ── 4. 设置分组合并：销售→通用设置；会员→营销与线上 ──
UPDATE system_settings SET group_name='通用设置'   WHERE group_name='销售';
UPDATE system_settings SET group_name='营销与线上' WHERE group_name='会员';

-- ── 5. 密码强度策略：改为枚举下拉（前后端/后端校验同口径） ──
UPDATE system_settings
   SET value_type='enum',
       enum_options='[{"v":"6位以上","label":"6 位以上（宽松）"},{"v":"8位字母数字","label":"8 位及以上，须含字母和数字（推荐）"},{"v":"8位字母数字符号","label":"8 位及以上，须含字母、数字和特殊符号"},{"v":"10位强密码","label":"10 位及以上，须含大小写字母和数字（强）"}]'::jsonb,
       remark='员工/会员密码强度策略：创建员工、修改密码、忘记密码重置、管理员重置均按此校验（前端提示与后端拦截同口径）'
 WHERE setting_key='auth.password_policy';
