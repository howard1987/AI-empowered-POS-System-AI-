# 隐藏启动 dev-launch.mjs（后端/Web/H5 看护，不管理 PG）
# 由 start-dev.bat 通过 -File 调用，避免 bat 内联 powershell 的引号解析问题。
$node = 'C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Start-Process -FilePath $node -ArgumentList 'dev-launch.mjs' -WorkingDirectory $root -WindowStyle Hidden
Write-Host 'dev-launch launched (hidden)'
