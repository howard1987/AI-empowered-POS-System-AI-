#!/usr/bin/env bash
# 数据灾备脚本（Linux/macOS）· V4.27.1 Q9：pg_dump + 图片目录 + 模型打包，保留 N 天
# 用法：bash deploy/backup/backup-pos.sh；建议 cron 每日执行；恢复见同目录 README.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP_DIR="$ROOT/backups"
UPLOADS="${AI_UPLOADS_DIR:-$ROOT/backend/public/uploads}"
MODELS="$ROOT/backend/models"
DB_URL="${DATABASE_URL:-postgres://cashier:cashier123@localhost:5432/cashier}"
RETAIN_DAYS=14

STAMP="$(date +%Y%m%d_%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

echo "==> [1/3] 导出 PostgreSQL…"
pg_dump --no-owner --format=custom --file "$DEST/database.dump" "$DB_URL"

echo "==> [2/3] 打包图片目录（样本/识别帧）…"
if [ -d "$UPLOADS" ]; then tar -C "$(dirname "$UPLOADS")" -czf "$DEST/uploads.tar.gz" "$(basename "$UPLOADS")";
else echo "    跳过：图片目录不存在 $UPLOADS"; fi

echo "==> [3/3] 打包已训练模型…"
if [ -d "$MODELS" ]; then tar -C "$(dirname "$MODELS")" -czf "$DEST/models.tar.gz" "$(basename "$MODELS")"; fi

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETAIN_DAYS" -exec rm -rf {} +

echo "✅ 备份完成：$DEST"
echo "   恢复：见 deploy/backup/README.md"
