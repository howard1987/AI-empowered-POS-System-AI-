# ============================================================================
# 超市收银系统 · 服务端管理器（任务栏托盘）V2
#   - 托盘图标实时显示服务状态（运行中/已停止）
#   - 快捷打开：管理后台 / 收银台 PWA / 老板端 / 会员 H5 / 客显副屏
#   - 网络与端口设置：修改服务端口（HTTPS）、查看本机局域网地址、一键防火墙放行
#   - 服务：启动 / 停止 / 重启（自动提权）
#   - 由 server-tray.vbs 无窗口启动（不出现 PowerShell 黑窗）
# ============================================================================
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── 单实例锁（V5.0.1）：防止用户多次启动服务端管理器，导致多个托盘图标冲突 ──
$script:SingleInstanceMutex = $null
try {
  $createdNew = $false
  $script:SingleInstanceMutex = New-Object System.Threading.Mutex($false, 'Global\POS_Server_Tray_SingleInstance', [ref]$createdNew)
  if (-not $createdNew) {
    [System.Windows.Forms.MessageBox]::Show(
      "服务端管理器已在运行。`n请右键系统托盘中的图标操作，不要重复启动。",
      '服务端管理器', 'OK', 'Information') | Out-Null
    exit
  }
} catch { }

$SvcName  = 'pos-server'
$RootDir  = Split-Path -Parent $PSScriptRoot          # {app}
$BackendDir = Join-Path $RootDir 'backend'
$EnvFile  = Join-Path $BackendDir '.env'
$LogDir   = Join-Path $RootDir 'logs'

# ── .env 读写 ──
function Get-EnvVal([string]$k, [string]$def) {
  if (-not (Test-Path $EnvFile)) { return $def }
  foreach ($line in Get-Content $EnvFile -ErrorAction SilentlyContinue) {
    if ($line -match "^\s*$k\s*=\s*(.+?)\s*$" -and $line -notmatch '^\s*#') { return $Matches[1].Trim('"') }
  }
  return $def
}
function Set-EnvVal([string]$k, [string]$v) {
  $lines = @()
  if (Test-Path $EnvFile) { $lines = @(Get-Content $EnvFile -ErrorAction SilentlyContinue) }
  $hit = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$k\s*=") { $lines[$i] = "$k=$v"; $hit = $true; break }
  }
  if (-not $hit) { $lines += "$k=$v" }
  [IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Port { try { return [int](Get-EnvVal 'PORT' '3100') } catch { return 3100 } }
function Get-HsPort { try { return [int](Get-EnvVal 'HTTPS_PORT' '3443') } catch { return 3443 } }

function Get-LanIPs {
  $ips = @()
  try {
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -ExpandProperty IPAddress)
  } catch { $ips = @() }
  if (-not $ips -or -not $ips.Count) { $ips = @('127.0.0.1') }
  return $ips
}

function Get-SvcStatus {
  $s = Get-Service -Name $SvcName -ErrorAction SilentlyContinue
  if (-not $s) { return '未安装' }
  return [string]$s.Status
}

function Test-IsAdmin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}
function Show-Tip([string]$msg) {
  try { $icon.ShowBalloonTip(5000, '服务端管理器', $msg, [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
}

# ── 服务启停（V4.28.9f 修复）──
#  原实现：Start-Process -Verb RunAs 无 -Wait、无错误捕获，且全局 $ErrorActionPreference='SilentlyContinue'
#  → 点击「启动/停止/重启」后无论成功失败都毫无反馈（UAC 被拒/未提权时完全静默），表现为"点了没反应"。
#  现改为：① 管理器本身已提权 → 直接本地执行（不弹 UAC）；② 否则 UAC 提权并 -Wait 等待结果；
#          ③ 重启用 Stop→轮询 Stopped→Start（WinSW 停止耗时，Restart-Service 常卡在 30s 超时）；
#          ④ 无论成功失败都气泡反馈，失败给出可执行的处理建议；⑤ 服务未安装时明确提示。
function Invoke-SvcAction([string]$action) {
  $label = switch ($action) { 'Start' { '启动' } 'Stop' { '停止' } default { '重启' } }
  if ((Get-SvcStatus) -eq '未安装') { Show-Tip "服务 $SvcName 未安装：请重新运行安装包修复服务。"; return }
  Show-Tip "正在${label}服务，请稍候…"

  $script = "Set-Service -Name $SvcName -StartupType Automatic -ErrorAction SilentlyContinue; "
  if ($action -eq 'Restart') {
    # WinSW 停止含 30s 超时 + 数据库收尾，实测可达 1~2 分钟：轮询上限 150s 等到 Stopped 再启动；
    # 启动后再轮询 Running（启动期间 SCM 可能报"未能启动"，实际在队列中）
    $script += "Stop-Service -Name $SvcName -Force -ErrorAction SilentlyContinue; " +
               "for (`$i=0; `$i -lt 150; `$i++){ if ((Get-Service -Name $SvcName).Status -eq 'Stopped') { break }; Start-Sleep -Seconds 1 }; " +
               "Start-Service -Name $SvcName -ErrorAction SilentlyContinue; " +
               "for (`$i=0; `$i -lt 60; `$i++){ if ((Get-Service -Name $SvcName).Status -eq 'Running') { break }; Start-Sleep -Seconds 1 }"
  } elseif ($action -eq 'Stop') {
    $script += "Stop-Service -Name $SvcName -Force -ErrorAction SilentlyContinue; " +
               "for (`$i=0; `$i -lt 150; `$i++){ if ((Get-Service -Name $SvcName).Status -eq 'Stopped') { break }; Start-Sleep -Seconds 1 }"
  } else {
    $script += "Start-Service -Name $SvcName -ErrorAction SilentlyContinue; " +
               "for (`$i=0; `$i -lt 60; `$i++){ if ((Get-Service -Name $SvcName).Status -eq 'Running') { break }; Start-Sleep -Seconds 1 }"
  }

  $ok = $false; $err = ''
  try {
    if (Test-IsAdmin) {
      Invoke-Expression $script
      $ok = $true
    } else {
      $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru `
             -ArgumentList @('-NoProfile', '-Command', $script)
      $ok = ($p.ExitCode -eq 0)
    }
  } catch { $ok = $false; $err = $_.Exception.Message }

  Start-Sleep -Seconds 2
  $now = Get-SvcStatus
  $wantStopped = ($action -eq 'Stop')
  if ($ok -and (($wantStopped -and $now -eq 'Stopped') -or (-not $wantStopped -and $now -eq 'Running'))) {
    Show-Tip "✅ 服务已${label}（当前：$now，端口 $(Get-Port)）"
  } elseif ($err -or -not $ok) {
    Show-Tip "❌ 服务${label}失败：${err}。请允许 UAC 提权，或退出后右键「以管理员身份运行」服务端管理器。"
  } else {
    Show-Tip "⚠ 服务${label}命令已执行，但当前状态仍为「$now」。请查看 logs\\ 或服务管理器（services.msc）确认。"
  }
}

# ── 托盘与菜单 ──
$form = New-Object System.Windows.Forms.Form
$form.WindowState = 'Minimized'; $form.ShowInTaskbar = $false
$form.FormBorderStyle = 'None'; $form.Opacity = 0

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Visible = $true
$icon.Text = '超市收银系统 服务端'

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$mkItem = {
  param($sender, $e)
  $url = "http://localhost:$(Get-Port)$($sender.Tag)"
  Start-Process $url
}
foreach ($it in @(
  @('🌐 打开管理后台', '/admin/'),
  @('🛒 打开收银台（PWA）', '/pwa/'),
  @('📊 打开老板端', '/boss/'),
  @('📱 打开会员 H5', '/member/'),
  @('🖥 打开客显副屏', '/display/'))) {
  $mi = $menu.Items.Add($it[0]); $mi.Tag = $it[1]
  $mi.add_Click($mkItem)
}

$menu.Items.Add('-') | Out-Null

$itemNet = $menu.Items.Add('⚙ 网络与端口设置…')
$menu.Items.Add('-') | Out-Null

$itemStart = $menu.Items.Add('▶ 启动服务')
$itemStart.add_Click({ Invoke-SvcAction 'Start' })
$itemStop = $menu.Items.Add('⏹ 停止服务')
$itemStop.add_Click({ Invoke-SvcAction 'Stop' })
$itemRestart = $menu.Items.Add('🔄 重启服务')
$itemRestart.add_Click({ Invoke-SvcAction 'Restart' })

$menu.Items.Add('-') | Out-Null
$itemLog = $menu.Items.Add('📂 打开日志目录')
$itemLog.add_Click({ if (Test-Path $LogDir) { Start-Process explorer.exe $LogDir } else { Start-Process explorer.exe (Split-Path -Parent $LogDir) } })
$itemExit = $menu.Items.Add('✕ 退出管理器（不影响服务）')
$itemExit.add_Click({ $form.Close() })

$icon.ContextMenuStrip = $menu

# ── 网络与端口设置对话框 ──
$itemNet.add_Click({
  $port = Get-Port; $hs = Get-HsPort; $ips = Get-LanIPs

  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '网络与端口设置'
  $dlg.Size = New-Object System.Drawing.Size(560, 420)
  $dlg.FormBorderStyle = 'FixedDialog'; $dlg.StartPosition = 'CenterScreen'
  $dlg.MaximizeBox = $false

  $lbl1 = New-Object System.Windows.Forms.Label
  $lbl1.Text = '本机局域网地址（收银机/手机用这些地址连接）：'
  $lbl1.SetBounds(16, 12, 500, 20); $dlg.Controls.Add($lbl1)

  $ipBox = New-Object System.Windows.Forms.TextBox
  $ipBox.Multiline = $true; $ipBox.ReadOnly = $true
  $ipBox.SetBounds(16, 36, 510, ($ips.Count * 20 + 10))
  $ipBox.Text = (($ips | ForEach-Object { "http://$($_):$port/  （HTTPS: https://$($_):$hs/）" }) -join "`r`n")
  $dlg.Controls.Add($ipBox)

  $y0 = 36 + $ips.Count * 20 + 22

  $lbl2 = New-Object System.Windows.Forms.Label
  $lbl2.Text = '服务端口（HTTP）'; $lbl2.SetBounds(16, $y0, 130, 20); $dlg.Controls.Add($lbl2)
  $inPort = New-Object System.Windows.Forms.NumericUpDown
  $inPort.Minimum = 1; $inPort.Maximum = 65535; $inPort.Value = $port
  $inPort.SetBounds(150, $y0 - 3, 90, 24); $dlg.Controls.Add($inPort)

  $lbl3 = New-Object System.Windows.Forms.Label
  $lbl3.Text = 'HTTPS 端口（手机拍照/装 PWA）'; $lbl3.SetBounds(16, $y0 + 30, 220, 20); $dlg.Controls.Add($lbl3)
  $inHs = New-Object System.Windows.Forms.NumericUpDown
  $inHs.Minimum = 1; $inHs.Maximum = 65535; $inHs.Value = $hs
  $inHs.SetBounds(240, $y0 + 27, 90, 24); $dlg.Controls.Add($inHs)

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = '改端口后需重启服务生效；防火墙放行只需做一次（换端口后需重做）。'
  $hint.SetBounds(16, $y0 + 62, 510, 20); $hint.ForeColor = 'Gray'
  $dlg.Controls.Add($hint)

  $btnFw = New-Object System.Windows.Forms.Button
  $btnFw.Text = '🔥 防火墙放行所选端口'; $btnFw.SetBounds(16, $y0 + 95, 190, 30)
  $btnFw.add_Click({
    $p = [int]$inPort.Value; $h = [int]$inHs.Value
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-Command',
      "netsh advfirewall firewall delete-rule name='POS-Server' | Out-Null; " +
      "netsh advfirewall firewall add-rule name='POS-Server' dir=in action=allow protocol=TCP localport=$p | Out-Null; " +
      "netsh advfirewall firewall add-rule name='POS-Server-HS' dir=in action=allow protocol=TCP localport=$h | Out-Null")
    [System.Windows.Forms.MessageBox]::Show("已放行端口 $p 与 $h（如弹出 UAC 请点「是」）。", '防火墙', 'OK', 'Information')
  })
  $dlg.Controls.Add($btnFw)

  $btnSave = New-Object System.Windows.Forms.Button
  $btnSave.Text = '💾 保存端口'; $btnSave.SetBounds(230, $y0 + 95, 130, 30)
  $btnSave.add_Click({
    Set-EnvVal 'PORT' ([string][int]$inPort.Value)
    Set-EnvVal 'HTTPS_PORT' ([string][int]$inHs.Value)
    $ans = [System.Windows.Forms.MessageBox]::Show(
      "端口已保存：HTTP $([int]$inPort.Value) / HTTPS $([int]$inHs.Value)。`n`n立即重启服务使其生效？",
      '已保存', 'YesNo', 'Question')
    if ($ans -eq 'Yes') { Invoke-SvcAction 'Restart' }
    $dlg.Close()
  })
  $dlg.Controls.Add($btnSave)

  $dlg.ShowDialog() | Out-Null
})

# ── 状态刷新 ──
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  $st = Get-SvcStatus
  switch ($st) {
    'Running' { $icon.Icon = [System.Drawing.SystemIcons]::Shield; $icon.Text = "超市收银系统 服务端 · 运行中（端口 $(Get-Port)）" }
    'Stopped' { $icon.Icon = [System.Drawing.SystemIcons]::Warning; $icon.Text = "超市收银系统 服务端 · 已停止" }
    default   { $icon.Icon = [System.Drawing.SystemIcons]::Information; $icon.Text = "超市收银系统 服务端 · $st" }
  }
})
# ── 数据库升级待处理提示（PG 大版本变更时由 server-up.mjs 写入）──
$WorkDir = $env:ProgramData
if (Test-Path $EnvFile) {
  foreach ($line in Get-Content $EnvFile -ErrorAction SilentlyContinue) {
    if ($line -match '^\s*POS_DATA_DIR\s*=\s*(.+?)\s*$' -and $line -notmatch '^\s*#') { $WorkDir = $Matches[1].Trim('"') }
  }
}
$pending = Join-Path $WorkDir 'PG_UPGRADE_REQUIRED.txt'
if (Test-Path $pending) {
  $txt = Get-Content $pending -Raw -ErrorAction SilentlyContinue
  $ans = [System.Windows.Forms.MessageBox]::Show(
    "检测到数据库需要升级才能启动服务端：`n`n$txt`n`n是否立即升级？`n（升级前会自动备份，任何失败都会自动回滚，数据不丢失）",
    '数据库升级', 'YesNo', 'Question')
  if ($ans -eq 'Yes') {
    $node = Join-Path $RootDir 'runtime\node.exe'
    if (-not (Test-Path $node)) { $node = 'node.exe' }
    $up = Join-Path $BackendDir 'scripts\server-up.mjs'
    Show-Tip '正在升级数据库，请稍候…（视数据量可能需要几分钟）'
    try {
      $out = Join-Path $WorkDir 'pg-upgrade.out.log'
      $err = Join-Path $WorkDir 'pg-upgrade.err.log'
      $p = Start-Process -FilePath $node -ArgumentList @('"' + $up + '"', 'upgrade') -Wait -PassThru -NoNewWindow `
           -RedirectStandardOutput $out -RedirectStandardError $err
      if ($p.ExitCode -eq 0) {
        [System.Windows.Forms.MessageBox]::Show('✅ 数据库升级成功，正在启动服务端…', '数据库升级', 'OK', 'Information')
        Invoke-SvcAction 'Start'
      } else {
        $detail = Get-Content $err -Raw -ErrorAction SilentlyContinue
        [System.Windows.Forms.MessageBox]::Show("❌ 升级失败，已自动回滚，数据未丢失。`n详情：$WorkDir`n`n$detail", '数据库升级', 'OK', 'Error')
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show('升级过程出错：' + $_.Exception.Message, '数据库升级', 'OK', 'Error')
    }
  } else {
    [System.Windows.Forms.MessageBox]::Show('已暂缓升级。服务端将保持停止，直到您手动升级（重新打开「服务端管理器」将再次提示，或执行 node scripts/server-up.mjs upgrade）。', '数据库升级', 'OK', 'Information')
  }
}

$timer.Start()
$icon.ShowBalloonTip(3000, '服务端管理器已启动', '双击图标打开管理后台；右键可打开各端页面、修改端口、启停服务。', [System.Windows.Forms.ToolTipIcon]::Info)
$icon.add_DoubleClick({ Start-Process "http://localhost:$(Get-Port)/admin/" })

[System.Windows.Forms.Application]::Run($form)
$icon.Visible = $false
$icon.Dispose()

# 程序退出时释放单实例锁
if ($script:SingleInstanceMutex) {
  try { $script:SingleInstanceMutex.ReleaseMutex() } catch { }
  try { $script:SingleInstanceMutex.Dispose() } catch { }
  $script:SingleInstanceMutex = $null
}
