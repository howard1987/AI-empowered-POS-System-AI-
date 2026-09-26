# AI/业务数据灾备 · V4.27.1（Q9）
#
# 备份内容 = 三件套：
#   ① PG 数据库（ai_samples / ai_recognition_logs / ai_models 元数据 / 业务全量）→ pg_dump
#   ② 图片目录（样本图/识别帧，AI_UPLOADS_DIR，默认 backend/public/uploads）→ 打包
#   ③ 已训练模型（backend/models/*.onnx）→ 打包
#
# 手动执行：
#   PowerShell：powershell -File deploy/backup/backup-pos.ps1
#   Linux/macOS：bash deploy/backup/backup-pos.sh
# 建议用系统计划任务/ cron 每日凌晨执行；备份保留 N 天（脚本内 RETAIN_DAYS 可调）。
#
# 恢复（数据丢失/损坏/迁移）：
#   ① 全量恢复：psql 恢复 dump + 解包图片目录回 AI_UPLOADS_DIR + 解包 models 回 backend/models
#      → 恢复后到训练台「重建向量索引」（CLIP 向量可全量重算，不必备份 embedding）
#   ② 选择性恢复/跨店迁移：备份包 backup/manifest.json 里有全部样本元数据，
#      按 POST /ai/samples/import {items:[{productId, imageBase64, filename, source, status, annotation}]}
#      分批回传（每批 ≤200），后端自动落盘挂样本。
#   ③ 模型恢复后如文件名变化，在训练台重新导入/激活即可（session 缓存会自动失效重建）。
