-- ═══════════════════════════════════════════════════════════════
-- 026_ai_extra.sql（M4-M5 增量）：
--   1) 防损看板阈值（异常折扣/退货率/收银差异）
--   2) 动态定价参数（临期/滞销/成本底线）
--   3) 员工助手知识库种子（排班/绩效/流程，source_type=系统摘要）
-- ═══════════════════════════════════════════════════════════════

-- 1) 智能防损阈值
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('AI与设备', 'ai.fraud.return_floor',    '异常退货率阈值',     '0.1',  '0.1',  'number', '近30天 退货单量/销售单量 超该值记异常（0-1）'),
  ('AI与设备', 'ai.fraud.cash_gap',        '收银差异阈值(元)',   '10',   '10',   'number', '交班现金差异绝对值超该值记异常'),
  ('AI与设备', 'ai.fraud.discount_n',      '异常折扣最小样本数', '3',    '3',    'number', '单班异常折扣单数 ≥ 该值才告警（防误报）')
ON CONFLICT (setting_key) DO NOTHING;

-- 2) 动态定价参数（M5a：临期/滞销合并调价建议，成本底线 = 进价 × (1+min_margin)）
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
  ('AI与设备', 'ai.pricing.expiry_days',   '临期预警天数',      '30',   '30',   'number', '在库批次剩余保质期 ≤ 该值进入调价建议'),
  ('AI与设备', 'ai.pricing.stale_days',    '滞销判定天数',      '60',   '60',   'number', '近 N 天无销售 且 库存 ≥ stale_qty 记滞销'),
  ('AI与设备', 'ai.pricing.stale_qty',     '滞销库存阈值(件)',  '30',   '30',   'number', '滞销判定最低在库量'),
  ('AI与设备', 'ai.pricing.min_margin',    '成本底线毛利率',    '0.05', '0.05', 'number', '建议价不得低于 进价×(1+该值)（0-1）')
ON CONFLICT (setting_key) DO NOTHING;

-- 3) 员工助手知识库种子（M5b：排班/绩效/流程问答，供 /brain/qa 全文检索）
-- 无 title 唯一约束，用 NOT EXISTS 保证幂等（同名文档不重复种）
INSERT INTO ai_kb_documents (store_id, title, source_type, content_text, status)
SELECT 1, v.title, '系统摘要', v.content_text, '已收录'
FROM (VALUES
  ('排班规则',
   '排班按自然周（周一至周日）编制，每班 8 小时；早班 08:00-16:00、中班 12:00-20:00、晚班 15:00-23:00；节假日提前一周排班并公示；换班需双方同意并经店长审批，交班时完成收银交接。'),
  ('绩效与工分',
   '员工绩效由工分制考核：任务预设工分按「任务类型」计分，完成时限内完成得满分，逾期按比例扣减；实际完成任务统计排除总计行；月报周报以历史记录后缀日期判定归属周期。'),
  ('进货入库流程',
   '入库流程：手机端扫码/票据OCR录入明细（生产日期必填）→ 提交收货单（自动关联操作员与业务员电子签名）→ 店长审核 → 按 FIFO 生成批次；低于历史最低进价会触发低价保护，需店长强推。'),
  ('退货报损流程',
   '退货：选择供应商后添加商品，批次自动归属该供应商最早剩余批次，提交后整单拍照加水印作为凭证，店长审核前必须补传。报损：选择原因、整单拍照、添加商品（自动归属单一批次），提交后店长审核。两者均自动关联操作员并提取业务员电子签名。'),
  ('收银交接规范',
   '交班时必须打印交班小票核对现金：现金应收 vs 实盘差异超过阈值（默认 10 元）会记入防损看板；系统支持应急收银（离线暂存，恢复后自动上传），应急单标注"应急"。'),
  ('会员与分红',
   '门店主打"会员即股东"：会员消费累积分红；分红按周期结算；会员画像按生命周期（新客/活跃/沉睡/流失）、偏好品类、贡献度分档，用于定向促销（AI 营销）。')
) AS v(title, content_text)
WHERE NOT EXISTS (SELECT 1 FROM ai_kb_documents d WHERE d.store_id=1 AND d.title=v.title);
