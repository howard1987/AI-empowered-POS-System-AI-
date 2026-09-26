-- 127 · V4.27.8 设置作用域治理：默认"通用（总部统一）"，仅明确标记的门店级设置才分店覆盖/下发
-- 原则（老板定版）：后台绝大多数设置是通用设置，连锁端直接读取统一值即可；
--   只有"各店可能不一样"的设置（本店硬件等）才需要门店级覆盖/下发。
-- 现状：104 迁移把 scope 默认定为 'store'，仅 17 个键标了 'hq' —— 分类方向反了，本迁移纠正。
-- 幂等 + 不吞配置：只改作用域分类，不改任何值；门店覆盖值保留（翻回 store 级即恢复生效）。

-- ① 新种子默认值翻转：设置键默认=总部级（通用）；确属门店级的键必须在种子里显式 scope='store'
ALTER TABLE system_settings ALTER COLUMN scope SET DEFAULT 'hq';

-- ② 存量收归：除"门店级白名单"外全部改为总部级（通用）
--    白名单口径 = 依赖本店硬件/本地环境的键：
--      scale.tx.*   电子秤通信参数（串口/网口/IP，本店秤硬件）
UPDATE system_settings SET scope = 'hq'
 WHERE scope = 'store' AND setting_key NOT LIKE 'scale.tx.%';

COMMENT ON COLUMN system_settings.scope IS 'hq=通用（总部统一维护，连锁端直接读取统一值，门店不可改）；store=门店级（各店可覆盖/总部可下发）。V4.27.8 起默认 hq，门店级须显式声明';
