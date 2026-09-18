-- =====================================================================
-- 042 · V4.11 Chinese-CLIP 换模型 + 文本 rerank
-- ---------------------------------------------------------------------
--   1) 商品名文本嵌入缓存表 ai_name_embs：rerank 第二信号（识别帧图像 × 中文商品名 图文对齐）
--      - 图片向量仍在 ai_samples.embedding（模型换为 Chinese-CLIP ViT-B/16 量化，
--        emb_model='clipcn-vit-b16-quant'，与旧 'clip-vit-b32-quant' 共存，强制重建后统一）
--      - 商品名嵌入按 (store_id, product_id, name) 唯一缓存；改名后按 name 不匹配自动重算
--   幂等：可重复执行
-- =====================================================================

CREATE TABLE IF NOT EXISTS ai_name_embs (
  id          SERIAL PRIMARY KEY,
  store_id    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        VARCHAR(200) NOT NULL,
  embedding   JSONB NOT NULL,
  emb_model   VARCHAR(50) NOT NULL DEFAULT 'clipcn-vit-b16-quant',
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_name_embs ON ai_name_embs (store_id, product_id, name);
CREATE INDEX IF NOT EXISTS idx_name_embs_store ON ai_name_embs (store_id);
