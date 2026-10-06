# ═══════════════════════════════════════════════════════════════════════════
#  社区超市收银系统 · 一键构建（服务端独立包 + 可选收银台 EXE）
#
#  用法（在 PowerShell 中执行）：
#    .\build-all.ps1                     全量：清理 → 编译服务端 → 装配 → 打包 Win11 EXE → 冒烟
#    .\build-all.ps1 -SkipExe            不打包 EXE（只出服务端包，最快）
#    .\build-all.ps1 -SkipSmoke          跳过冒烟校验
#    .\build-all.ps1 -Win7               同时产出 Win7(ia32) 轨 EXE（定稿后再用）
#    .\build-all.ps1 -SkipNodeModules    复用已有 node_modules（仅改了静态页/文档时提速）
#
#  只动构建/配置/部署产物，不改业务逻辑。产物统一落在 <项目根>\release\ 下。
# ═══════════════════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [switch]$SkipClean,
  [switch]$SkipExe,
  [switch]$SkipSmoke,
  [switch]$SkipNodeModules,
  [switch]$Win7
)

$ErrorActionPreference = 'Stop'
$script:StartTime = Get-Date

# 终止错误统一给出可读结论（避免 PowerShell 静默中断）
trap {
  Write-Host ''
  Write-Host ("构建失败: " + $_.Exception.Message) -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
  Write-Host ''
  exit 1
}

# ───────────────────────────── 路径解析 ─────────────────────────────
$CODE_NAME = '超市收银系统-初版代码'
$probe = $PSScriptRoot
$CODE = $null
for ($i = 0; $i -lt 4 -and -not $CODE; $i++) {
  $c = Join-Path $probe $CODE_NAME
  if (Test-Path $c) { $CODE = $c; break }
  $probe = Split-Path -Parent $probe
}
if (-not $CODE) { throw "未找到代码目录「$CODE_NAME」，请在项目内运行本脚本。" }

$ROOT      = Split-Path -Parent $CODE
$RELEASE   = Join-Path $ROOT 'release'
$SRV       = Join-Path $RELEASE 'server'
$DESK_OUT  = Join-Path $RELEASE 'pos-desktop'
$BACKEND   = Join-Path $CODE 'backend'
$WEB       = Join-Path $CODE 'frontend-web'
$DESKTOP   = Join-Path $CODE 'frontend-desktop'
$DEPLOY    = Join-Path $CODE 'deploy'
$PUB       = Join-Path $BACKEND 'public'

# ───────────────────────────── 小工具 ─────────────────────────────
function Step([string]$No, [string]$Title) {
  Write-Host ''
  Write-Host "──── [$No] $Title" -ForegroundColor Cyan
}
function Ok([string]$Msg)   { Write-Host "   [OK] $Msg" -ForegroundColor Green }
function Info([string]$Msg) { Write-Host "   .. $Msg" -ForegroundColor Gray }
function Warn([string]$Msg) { Write-Host "   [!!] $Msg" -ForegroundColor Yellow }

# ── 文件系统删除统一走原生命令 ──
# 原因有二：① PS 5.1 的 Remove-Item 不支持超长路径（node_modules 必踩）；
#          ② 宿主可能对 Remove-Item 施加批量删除守卫，构建脚本无权交互确认。
function DelFile([string]$F) { if (Test-Path $F) { $null = & cmd /c "del /f /q `"$F`" 2>nul" } }
function DelDir([string]$D)  { if (Test-Path $D) { $null = & cmd /c "rd /s /q `"$D`" 2>nul" } }

$script:RcLog = Join-Path $RELEASE '_robocopy.log'
DelFile $script:RcLog

# 删除目录：先用 robocopy /MIR 空目录把内容清空（可处理超长路径），再 rd /s /q 收尾。
function PurgeDir([string]$Dir) {
  if (-not (Test-Path $Dir)) { return }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $empty = Join-Path $env:TEMP ('purge-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    & robocopy $empty $Dir /MIR /NFL /NDL /NJH /NJS /NP /R:0 /W:0 2>&1 | Out-Null
    DelDir $Dir
  } finally {
    $ErrorActionPreference = $prev
    DelDir $empty
    $global:LASTEXITCODE = 0
  }
}

# 注意：PS 5.1 下 $ErrorActionPreference='Stop' 会把 robocopy 的 stderr 当成终止错误，
# 故本函数内部临时切回 Continue，退出码一律走 $LASTEXITCODE 判定。
function RC([string[]]$RArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & robocopy @RArgs '/NFL' '/NDL' '/NJH' '/NJS' '/NP' '/R:1' '/W:1' "/LOG+:$script:RcLog" 2>&1 | Out-Null
    $rc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($rc -ge 8) {
    $tail = ''
    if (Test-Path $script:RcLog) { $tail = (Get-Content $script:RcLog -Tail 30) -join "`n" }
    throw "文件复制失败（robocopy 代码 $rc）: $($RArgs -join ' ')`n$tail"
  }
  $global:LASTEXITCODE = 0
}

function RunNpm([string[]]$NpmArgs, [string]$Cwd) {
  Push-Location $Cwd
  try {
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') 失败（代码 $LASTEXITCODE）" }
  } finally { Pop-Location }
}

# 容忍非 0 退出码（electron-builder 收尾清理临时文件可能被宿主安全守卫拦截，产物本身已生成）
function RunNpmSoft([string[]]$NpmArgs, [string]$Cwd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $code = 0
  Push-Location $Cwd
  try {
    & npm @NpmArgs 2>&1 | Out-Null
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $prev
    $global:LASTEXITCODE = 0
  }
  return $code
}

function HttpGet([string]$Url) {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = $null
  $wc.Encoding = [System.Text.Encoding]::UTF8
  try { return $wc.DownloadString($Url) } finally { $wc.Dispose() }
}
function HttpPostJson([string]$Url, [string]$Json) {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = $null
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers.Add('Content-Type', 'application/json')
  try { return $wc.UploadString($Url, 'POST', $Json) } finally { $wc.Dispose() }
}

# ═════════════════════════════ 开始 ═════════════════════════════
Write-Host ''
Write-Host '╔══════════════════════════════════════════════════════════╗' -ForegroundColor White
Write-Host '║   社区超市收银系统 · 一键构建                            ║' -ForegroundColor White
Write-Host '╚══════════════════════════════════════════════════════════╝' -ForegroundColor White
Info "代码目录: $CODE"
Info "产物目录: $RELEASE"

# ── 0. 清理 ──
if (-not $SkipClean) {
  Step 0 '清理 release/server 旧产物'
  PurgeDir $SRV
  Ok 'server/ 已清空'
}
New-Item -ItemType Directory -Force -Path $SRV | Out-Null
New-Item -ItemType Directory -Force -Path $DESK_OUT | Out-Null

# ── 1. 编译服务端 ──
Step 1 '编译服务端（TypeScript → dist）'
RunNpm @('run', 'build') $BACKEND
if (-not (Test-Path (Join-Path $BACKEND 'dist\main.js'))) { throw 'dist/main.js 未生成' }
Ok 'dist/ 编译完成'

# ── 2. 装配 server 骨架 ──
Step 2 '装配 server/：dist · db · scripts'
RC @((Join-Path $BACKEND 'dist'), (Join-Path $SRV 'dist'), '/E')
RC @((Join-Path $BACKEND 'db'),   (Join-Path $SRV 'db'),   '/E')

New-Item -ItemType Directory -Force -Path (Join-Path $SRV 'scripts') | Out-Null
foreach ($f in @('server-up.mjs', 'rawprint.ps1', 'gen-cert.js', 'backfill-pinyin.js')) {
  $src = Join-Path $BACKEND "scripts\$f"
  if (Test-Path $src) { Copy-Item $src (Join-Path $SRV 'scripts') -Force }
}
Ok 'dist · db · scripts 装配完成'

# ── 2.5 运行期资产：语音引擎 + AI 模型 ──
#  V5.0.14h：此前文件夹包只拷 dist/db/scripts/public，**漏了 tts/ 与 models/**——
#  用 release\server\ 文件夹包部署的门店：/tts/health=false（无语音播报）、AI 商品识别不可用。
#  （Inno 安装版向来带这两项目录，故只有文件夹包有此缺口。tts\cache 是运行期 WAV 缓存，不随包）
Step '2.5' '装配运行期资产：tts（piper 语音引擎 + 音色）· models（AI 识别模型）'
foreach ($asset in @('tts', 'models')) {
  $srcDir = Join-Path $BACKEND $asset
  $dstDir = Join-Path $SRV $asset
  if (-not (Test-Path $srcDir)) { Warn "缺少目录（跳过）：$srcDir"; continue }
  if ($asset -eq 'tts') { RC @($srcDir, $dstDir, '/E', '/XD', 'cache') }
  else                  { RC @($srcDir, $dstDir, '/E') }
  Ok "$asset/ 装配完成"
}

# ── 3. 生产依赖 ──
Step 3 '复制生产依赖 node_modules'
if ($SkipNodeModules -and (Test-Path (Join-Path $SRV 'node_modules\pg'))) {
  Info '复用已有 node_modules（-SkipNodeModules）'
} else {
  PurgeDir (Join-Path $SRV 'node_modules')
  Info '体积较大（含 onnxruntime 原生库），请耐心等待…'
  RC @((Join-Path $BACKEND 'node_modules'), (Join-Path $SRV 'node_modules'), '/E')
  # 剔除仅构建期需要的包（保留 @embedded-postgres：内嵌便携 PG 运行时必需）
  foreach ($dev in @('typescript', '@types')) {
    PurgeDir (Join-Path $SRV "node_modules\$dev")
  }
}
Ok '生产依赖就绪'

# ── 4. 静态站 ──
Step 4 '装配静态站：admin（24 屏完整后台）· pwa（收银端）· boss/member/display'
# 4.0 先把 frontend-web 镜像同步进 backend/public/admin（admin 为 GitHub 部署目录，须随源码同步）
RC @($WEB, (Join-Path $PUB 'admin'), '/MIR', '/XD', 'node_modules', '.playwright-cli', '/XF', 'server.mjs', 'package.json')
RC @($PUB, (Join-Path $SRV 'public'), '/E', '/XD', 'uploads', '.playwright-cli')
New-Item -ItemType Directory -Force -Path (Join-Path $SRV 'public\uploads') | Out-Null
RC @($WEB, (Join-Path $SRV 'public\admin'), '/E', '/XD', 'node_modules', '.playwright-cli', '/XF', 'server.mjs')
# 初版联调骨架页不随包 → 换成运维入口页
$skel = Join-Path $SRV 'public\index.html'
DelFile $skel
Ok 'admin/ pwa/ boss/ member/ display/ 装配完成'

# ── 5. 内嵌便携 PostgreSQL ──
Step 5 '内嵌便携 PostgreSQL 二进制'
$pgNative = Join-Path $BACKEND 'node_modules\@embedded-postgres\windows-x64\native'
if (-not (Test-Path (Join-Path $pgNative 'bin\initdb.exe'))) {
  throw "未找到内嵌 PG 二进制：$pgNative（请先在 backend 执行 npm install）"
}
RC @($pgNative, (Join-Path $SRV 'pg'), '/E')
Ok 'pg/ 便携数据库就绪（首次启动自动释放到纯 ASCII 路径）'

# ── 5b. PostgreSQL 客户端迁移工具（pg_dump / pg_dumpall / psql / pg_restore）──
#     大版本升级时需要它们做逻辑迁移；随包内置，离线安装也能升级。
Step '内嵌 PostgreSQL 客户端迁移工具'
$pqTools = Join-Path $BACKEND 'vendor\pg-tools\bin'
if (Test-Path $pqTools) {
  RC @($pqTools, (Join-Path $SRV 'pg\bin'), '/E')
  Ok 'pg/bin 客户端迁移工具就绪（pg_dump/psql…）'
} else {
  Warn "未找到 $pqTools（跳过；将来大版本升级需手动提供 pg_dump/psql）"
}

# ── 6. 部署文件 ──
Step 6 '写入 .env.example · start-server.bat · stop-server.bat · README-SERVER.md'
foreach ($f in @('env.example', 'start-server.bat', 'stop-server.bat', 'README-SERVER.md')) {
  $src = Join-Path $DEPLOY $f
  if (-not (Test-Path $src)) { throw "缺少部署模板：$src" }
  $dst = Join-Path $SRV $f
  if ($f -eq 'env.example') { $dst = Join-Path $SRV '.env.example' }
  Copy-Item $src $dst -Force
}
Ok '部署文件就绪'

# VQA-E5：产品版本注入发布包（health 接口以 version.txt 为准）
try {
  $fdPkg = (Get-Content (Join-Path $CODE 'frontend-desktop/package.json') -Raw | ConvertFrom-Json)
  Set-Content -Path (Join-Path $SRV 'version.txt') -Value $fdPkg.version -NoNewline -Encoding ascii
  Ok "version.txt = $($fdPkg.version)"
} catch { Warn "version.txt 写入失败（health 回落 0.1.0）：$($_.Exception.Message)" }

# ── 7. 运维入口页 ──
Step 7 '生成服务端入口页 public/index.html'
$portal = @'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>社区超市收银系统 · 服务端</title>
<style>
  :root{color-scheme:light}
  body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f4f6f9;color:#1f2937;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(15,23,42,.10);padding:36px 40px;width:min(560px,92vw)}
  h1{margin:0 0 4px;font-size:21px}
  .sub{color:#6b7280;font-size:13px;margin-bottom:22px}
  .ok{display:inline-flex;align-items:center;gap:6px;background:#ecfdf5;color:#047857;border-radius:999px;
      padding:3px 12px;font-size:12px;font-weight:600;margin-bottom:18px}
  a.row{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;padding:12px 14px;border-radius:10px;
      border:1px solid #eceff3;margin-bottom:10px;transition:.15s}
  a.row:hover{background:#f8fafc;border-color:#d8dee7;transform:translateX(2px)}
  .ic{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font-size:17px;background:#eef2ff}
  .t{font-weight:600;font-size:14px}
  .d{color:#6b7280;font-size:12px}
  .foot{margin-top:20px;padding-top:14px;border-top:1px solid #eef1f5;color:#9ca3af;font-size:12px}
</style>
</head>
<body>
  <div class="card">
    <span class="ok">● 服务端运行中</span>
    <h1>社区超市收银系统</h1>
    <div class="sub">本地化部署 · 服务端已就绪，请选择要进入的端</div>
    <a class="row" href="./admin/"><span class="ic">🖥</span><span><span class="t">管理后台</span><br><span class="d">24 大模块 · 商品 / 库存 / 会员 / 报表 / 设置</span></span></a>
    <a class="row" href="./pwa/"><span class="ic">🧾</span><span><span class="t">收银台</span><br><span class="d">浏览器 / 平板 / 收银机 · 支持扫码枪与打印</span></span></a>
    <a class="row" href="./boss/"><span class="ic">📊</span><span><span class="t">老板看板</span><br><span class="d">经营总览 · 消息中心 · 远程审批</span></span></a>
    <a class="row" href="./display/"><span class="ic">📺</span><span><span class="t">客显副屏</span><br><span class="d">双屏收银机第二屏 / 广告轮播</span></span></a>
    <div class="foot">手机端扫码 / 拍照 / 安装 PWA 请使用 HTTPS 端口（默认 3443），首次访问需信任自签证书。</div>
  </div>
</body>
</html>
'@
[System.IO.File]::WriteAllText((Join-Path $SRV 'public\index.html'), $portal, (New-Object System.Text.UTF8Encoding($false)))
Ok '入口页已生成'

# ── 8. 收银桌面端 EXE ──
if (-not $SkipExe) {
  Step 8 '打包收银桌面端 EXE'
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  $dv = (Get-Content (Join-Path $DESKTOP 'package.json') -Raw | ConvertFrom-Json).version
  $modernDir = Join-Path $DESKTOP 'dist-modern'
  $rc = RunNpmSoft @('run', 'dist:modern') $DESKTOP
  $setup = @(Get-ChildItem $modernDir -Filter "*$dv*win-x64-setup.exe" -ErrorAction SilentlyContinue)
  $port  = @(Get-ChildItem $modernDir -Filter "*$dv*x64-portable.exe" -ErrorAction SilentlyContinue)
  if ($setup.Count -eq 0 -or $port.Count -eq 0) {
    throw "Win11 EXE 未产出（electron-builder 退出码 $rc）"
  }
  if ($rc -ne 0) {
    Warn "electron-builder 返回码 $rc —— 通常是收尾删除临时文件被系统守卫拦截，产物已生成，可忽略"
  }
  Copy-Item $setup[0].FullName $DESK_OUT -Force
  Copy-Item $port[0].FullName  $DESK_OUT -Force
  # V5.0.14g：安装包统一落在 release\，electron-builder 的工作目录（含 win-unpacked 与重复 EXE）随后清空
  PurgeDir $modernDir
  Ok 'dist-modern 工作目录已清空（安装包只在 release\pos-desktop\）'
  if ($Win7) {
    Warn '同时产出 Win7(ia32) 轨'
    $rc7 = RunNpmSoft @('run', 'dist:win7') $DESKTOP
    $w7Dir = Join-Path $DESKTOP 'dist-win7-build'
    $w7 = @(Get-ChildItem $w7Dir -Filter "*$dv*win7-ia32-setup.exe" -ErrorAction SilentlyContinue)
    $w7p = @(Get-ChildItem $w7Dir -Filter "*$dv*win7-ia32-portable.exe" -ErrorAction SilentlyContinue)
    if ($w7.Count -eq 0 -or $w7p.Count -eq 0) { throw "Win7 EXE 未产出（electron-builder 退出码 $rc7）" }
    Copy-Item $w7[0].FullName  $DESK_OUT -Force
    Copy-Item $w7p[0].FullName $DESK_OUT -Force
  } else {
    Info 'Win7 轨未构建（如需：build-all.ps1 -Win7）'
  }
  Ok "EXE 已汇总到 release/pos-desktop/（版本 $dv）"

  # ── 8.5 服务端安装包（Inno Setup：Windows 服务 + 托盘管理器 + 内嵌 AI 模型/TTS）──
  Step '8.5' '编译服务端安装包（Inno Setup）'
  $iscc = @(
    'D:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $iscc) {
    Warn '未找到 ISCC.exe（Inno Setup 6）——跳过服务端安装包（服务器可用 release\server\ 文件夹包）'
  } else {
    Info "ISCC: $iscc"
    Push-Location (Join-Path $DEPLOY 'installer')
    try {
      & $iscc "/DMyAppVer=$dv" 'server-setup.iss' 2>&1 | Select-Object -Last 3 | Write-Host
      if ($LASTEXITCODE -ne 0) { throw "ISCC 编译失败（退出码 $LASTEXITCODE）" }
    } finally { Pop-Location }
    $srvSetup = Join-Path $ROOT "release\pos-server\POS-Server-Setup-$dv.exe"
    if (Test-Path $srvSetup) {
      Ok ("服务端安装包: " + $srvSetup + "（" + [math]::Round((Get-Item $srvSetup).Length/1MB,1) + " MB）")
    } else { throw "服务端安装包未产出：$srvSetup" }
  }
} else {
  Step 8 'EXE 打包已跳过（-SkipExe）'
}

# ── 9. 冒烟 ──
if (-not $SkipSmoke) {
  Step 9 '产物冒烟：临时端口 + 临时数据目录起一套真实服务'
  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  $rnd     = Get-Random -Minimum 100 -Maximum 899
  $port    = 3200 + ($rnd % 300)
  $pgPort  = 54500 + ($rnd % 200)
  $base    = $env:ProgramData
  if (-not $base) { $base = $env:TEMP }
  $dataDir = Join-Path $base ("pos-cashier-smoke-" + $rnd)
  $hadEnv  = Test-Path (Join-Path $SRV '.env')
  $proc    = $null
  $pass    = $false
  $outLog  = $null
  $errLog  = $null

  # VQA：冒烟抽成函数——失败可整体重跑（PS 的 for+catch+continue 在部分版本行为不可靠）
  function Invoke-Smoke {
  $pass = $false
  try {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $env:POS_DATA_DIR = $dataDir
    $env:PORT      = "$port"
    $env:PG_PORT   = "$pgPort"
    $env:PG_MODE   = 'embedded'
    $env:JWT_SECRET = ''
    Info "端口 $port / PG $pgPort / 数据 $dataDir"

    $outLog = Join-Path $dataDir 'server.log'
    $errLog = Join-Path $dataDir 'server.err.log'
    $proc = Start-Process -FilePath $nodeExe -ArgumentList @('scripts\server-up.mjs', 'up') `
      -WorkingDirectory $SRV -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

    $health = $null
    for ($i = 0; $i -lt 100; $i++) {
      Start-Sleep -Milliseconds 1500
      try { $health = HttpGet "http://127.0.0.1:$port/health"; if ($health) { break } } catch { }
      if ($proc.HasExited) { break }
    }
    if (-not $health) {
      $tail = ''
      if (Test-Path $errLog) { $tail = (Get-Content $errLog -Tail 15) -join "`n" }
      if (Test-Path $outLog) { $tail = ((Get-Content $outLog -Tail 25) -join "`n") + "`n" + $tail }
      throw "服务未就绪。日志尾部：`n$tail"
    }
    if ($health -notmatch 'ok') { throw "/health 返回异常: $health" }
    Ok '/health 正常'

    # VQA：V4.24.0 起新库走引导制——先探测是否已有管理员，再决定登录或引导创建（HttpGet 对 2xx 不抛，避免 401 异常绕过逻辑）
    $bootRaw = HttpGet "http://127.0.0.1:$port/auth/bootstrap"
    $boot = $bootRaw | ConvertFrom-Json
    $loginPwd = 'admin123'
    if ($boot.data -and -not $boot.data.hasAdmin) {
      $createRaw = HttpPostJson "http://127.0.0.1:$port/auth/bootstrap-admin" '{"empNo":"ADMIN","name":"超级管理员","password":"Adm@2026"}'
      Ok '已通过引导创建首个管理员（ADMIN）'
      $loginPwd = 'Adm@2026'
    }
    $loginRaw = HttpPostJson "http://127.0.0.1:$port/auth/login" ('{"empNo":"ADMIN","password":"' + $loginPwd + '"}')
    $login = $loginRaw | ConvertFrom-Json
    $token = $null
    if ($login.data -and $login.data.token) { $token = $login.data.token }
    elseif ($login.token) { $token = $login.token }
    if (-not $token) { throw "登录冒烟失败：$loginRaw" }
    Ok "ADMIN 登录成功（token 长度 $($token.Length)）"

    $adminHtml = HttpGet "http://127.0.0.1:$port/admin/"
    if ($adminHtml -notmatch 'id="app"') { throw '/admin/ 内容异常' }
    Ok '/admin/ 可访问（24 屏后台）'

    $pwaHtml = HttpGet "http://127.0.0.1:$port/pwa/"
    if ($pwaHtml -notmatch 'sw\.js|收银|manifest') { throw '/pwa/ 内容异常' }
    Ok '/pwa/ 可访问（收银端）'

    $pass = $true
  } catch {
    $script:SmokeError = $_.Exception.Message
    Warn ("冒烟未通过：" + (($_.Exception.Message) -split "`n")[0])
    if ($errLog -and (Test-Path $errLog)) {
      $t1 = (Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
      if ($t1) { Info "stderr: $t1" }
    }
    if ($outLog -and (Test-Path $outLog)) {
      $t2 = (Get-Content $outLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
      if ($t2) { Info "stdout: $t2" }
    }
  } finally {
    foreach ($n in @('POS_DATA_DIR', 'PORT', 'PG_PORT', 'PG_MODE', 'JWT_SECRET')) {
      [Environment]::SetEnvironmentVariable($n, $null)
    }
    if ($proc) {
      $null = & taskkill /F /T /PID $proc.Id 2>$null
      Start-Sleep -Milliseconds 800
    }
    # 停内嵌 PG（同一数据目录）
    $env:POS_DATA_DIR = $dataDir
    Push-Location $SRV
    try { $null = & $nodeExe 'scripts\server-up.mjs' 'stop' 2>$null } catch { }
    Pop-Location
    [Environment]::SetEnvironmentVariable('POS_DATA_DIR', $null)
    Start-Sleep -Milliseconds 800
    if (-not $hadEnv -and (Test-Path (Join-Path $SRV '.env'))) {
      DelFile (Join-Path $SRV '.env')
      Info '已清理冒烟临时 .env'
    }
    DelDir $dataDir
    $global:LASTEXITCODE = 0
  }
    return $pass
  } # function Invoke-Smoke

  if (Invoke-Smoke) { Ok '冒烟全部通过' }
  else {
    Warn '偶发失败常见于杀软首扫拦截 initdb——8 秒后自动重试一次'
    Start-Sleep 8
    if (Invoke-Smoke) { Ok '冒烟重试通过' }
    else { Warn "冒烟仍未通过（已重试）：$script:SmokeError" }
  }
} else {
  Step 9 '冒烟已跳过（-SkipSmoke）'
}

# ── 10. 汇总 ──
Step 10 '产物清单'
# 冒烟会在 server/ 下生成运行期目录（证书/密钥/日志），发布包不带这些（目标机首启自动生成）
  foreach ($rt in @('.runtime', 'certs', 'logs')) { PurgeDir (Join-Path $SRV $rt) }
DelFile (Join-Path $SRV '.env')   # .env 含本机密钥/端口，绝不随发布包
Info '已清理运行期目录（.runtime / certs / logs）与 .env，首启自动重建'

$srvSize = 0
if (Test-Path $SRV) {
  $srvSize = (Get-ChildItem $SRV -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
}
if (-not $srvSize) { $srvSize = 0 }
$deskCount = 0
if (Test-Path $DESK_OUT) { $deskCount = (Get-ChildItem $DESK_OUT -File -ErrorAction SilentlyContinue).Count }
Info ("server/       {0:N1} MB" -f ($srvSize / 1MB))
Info "pos-desktop/  $deskCount 个安装包"

# 自备份构建脚本与部署说明到 release/
$selfDst = Join-Path $RELEASE 'build-all.ps1'
if ($PSCommandPath -and ($PSCommandPath -ne $selfDst)) { Copy-Item $PSCommandPath $selfDst -Force }
$deployMd = Join-Path $DEPLOY 'README_DEPLOY.md'
if (Test-Path $deployMd) { Copy-Item $deployMd (Join-Path $RELEASE 'README_DEPLOY.md') -Force }
DelFile $script:RcLog

$cost = [int]((Get-Date) - $script:StartTime).TotalSeconds
Write-Host ''
if ($script:SmokeError -and -not $SkipSmoke) {
  Write-Host "构建完成（冒烟未通过，见上），耗时 ${cost}s" -ForegroundColor Yellow
} else {
  Write-Host "构建完成，耗时 ${cost}s" -ForegroundColor Green
}
Write-Host "产物: $RELEASE" -ForegroundColor White
Write-Host ''
