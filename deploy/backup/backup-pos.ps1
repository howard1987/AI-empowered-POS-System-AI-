# 数据灾备脚本（Windows）· V4.27.1 Q9：pg_dump + 图片目录 + 模型打包，保留 N 天
# 用法：powershell -File deploy/backup/backup-pos.ps1
# 建议计划任务每日执行；恢复方式见同目录 README.md
$ErrorActionPreference = 'Stop'

$Root     = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # 项目根（deploy/backup 的上两级）
$BackupDir = Join-Path $Root 'backups'
$Uploads  = if ($env:AI_UPLOADS_DIR) { $env:AI_UPLOADS_DIR } else { Join-Path $Root 'backend\public\uploads' }
$Models   = Join-Path $Root 'backend\models'
$DbUrl    = if ($env:DATABASE_URL) { $env:DATABASE_URL } else { 'postgres://cashier:cashier123@localhost:5432/cashier' }
$RetainDays = 14

$stamp  = Get-Date -Format 'yyyyMMdd_HHmmss'
$dest   = Join-Path $BackupDir $stamp
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Host "==> [1/3] 导出 PostgreSQL…"
# 从 URL 解析库名；pg_dump 支持 postgres:// 连接串
& pg_dump --no-owner --format=custom --file (Join-Path $dest 'database.dump') $DbUrl

Write-Host "==> [2/3] 打包图片目录（样本/识别帧）…"
if (Test-Path $Uploads) { Compress-Archive -Path (Join-Path $Uploads '*') -DestinationPath (Join-Path $dest 'uploads.zip') -Force }
else { Write-Host "    跳过：图片目录不存在 $Uploads" }

Write-Host "==> [3/3] 打包已训练模型…"
if (Test-Path $Models) { Compress-Archive -Path (Join-Path $Models '*') -DestinationPath (Join-Path $dest 'models.zip') -Force }

# 清理过期备份
Get-ChildItem $BackupDir -Directory | Where-Object { $_.CreationTime -lt (Get-Date).AddDays(-$RetainDays) } | Remove-Item -Recurse -Force

Write-Host "✅ 备份完成：$dest"
Write-Host "   恢复：见 deploy/backup/README.md（psql 恢复 + 图片解包，或 POST /ai/samples/import 选择性回传）"
