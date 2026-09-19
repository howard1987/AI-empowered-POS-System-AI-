-- VQA-D5（2026-09-19）：下线三张建而未用表（实测均 0 行；引用已从 admin.reset 清单摘除）
-- 放在 001/105 之后重放：每轮迁移最终态收敛为「已删除」。若未来要启用对应功能，另建新迁移重建。
DROP TABLE IF EXISTS sync_conflicts;      -- 连锁冲突实际走 sync_changes，此表设计后未接入
DROP TABLE IF EXISTS member_pref_stats;   -- 会员偏好统计：零读写（画像走 member_profiles）
DROP TABLE IF EXISTS product_photos;      -- 商品图：上传实际走 uploads/products + mall-image 字段
