-- ═══ V5.0.11d 设备名称/类型自动识别：回填历史设备 ═══
--
-- 【问题】pos_devices.device_name 此前从不由系统填写（只能管理员手工点「命名」），
--   device_type 则完全相信前端自报 —— 而管理后台把 type 硬编码成 'pc'。
--   结果：手机浏览器登录后，设备列表显示「— / 电脑」，管理员认不出哪台是自己的手机。
--
-- 【修复】新增 backend/src/common/device-name.ts 从 User-Agent 推断名称与类型，
--   在设备登记/授权/登录三处写入（仅当名称为空时覆盖，保留管理员手工命名）。
--   本迁移负责把**已存在**的设备补齐。
--
-- 【为什么放后端做】所有端都已把 UA 发过来，后端是唯一收口点；
--   前端可伪造 device_type，UA 至少骗起来成本高得多；
--   且浏览器拿不到「设备友好名称」（隐私保护 API），UA 是唯一可用信号。

-- 名称：按 UA 判定。UA 为空的按已有 device_type 给中性措辞（总比空着强）。
UPDATE pos_devices d
   SET device_name = CASE
         WHEN d.ua ~* 'iPhone'            THEN 'iPhone'
         WHEN d.ua ~* 'iPad'              THEN 'iPad'
         WHEN d.ua ~* 'iPod'              THEN 'iPod'
         WHEN d.ua ~* 'Mac OS X|Macintosh' THEN 'Mac 电脑'
         WHEN d.ua ~* 'Windows Phone'     THEN 'Windows 手机'
         WHEN d.ua ~* 'Windows NT 10\.0'  THEN 'Windows 10/11 电脑'
         WHEN d.ua ~* 'Windows NT'        THEN 'Windows 电脑'
         WHEN d.ua ~* 'Android'           THEN 'Android 设备'
         WHEN d.ua IS NOT NULL AND d.ua <> '' THEN '未知设备'
         ELSE CASE d.device_type
                WHEN 'pc' THEN '电脑' WHEN 'mobile' THEN '手机' WHEN 'pad' THEN '平板'
                ELSE '未知设备' END
       END
 WHERE d.device_name IS NULL OR d.device_name = '';

-- 类型：以 UA 为准纠正前端自报值（管理后台曾在手机浏览器上硬编码 'pc'）。
-- UA 缺失的保持原值，不猜。
UPDATE pos_devices d
   SET device_type = CASE
         WHEN d.ua ~* 'iPad|Tablet|PlayBook|Silk'                  THEN 'pad'
         WHEN d.ua ~* 'Android' AND d.ua !~* 'Mobile'              THEN 'pad'
         WHEN d.ua ~* 'Mobi|iPhone|iPod|Android|Windows Phone'    THEN 'mobile'
         WHEN d.ua ~* 'Windows NT|Macintosh|Mac OS X'             THEN 'pc'
         ELSE d.device_type
       END
 WHERE d.ua IS NOT NULL AND d.ua <> '';
