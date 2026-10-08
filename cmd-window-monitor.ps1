# ═══════════════════════════════════════════════════════════════
#  CMD 弹窗取证监控（V5.0.18g）
#  抓「秒弹秒关」控制台窗口背后的真实进程：路径 + 完整命令行 + 启动时间。
#  日志：本脚本同目录 cmd-window-monitor.log（持续追加）
#  建议：右键 → 使用管理员身份运行（可用 WMI 事件精准捕获，含 200ms 内生死的进程）；
#        非管理员也可运行（自动降级为 150ms 轮询，绝大多数弹窗仍能抓到）。
#  停止：任务管理器结束 powershell 进程，或运行 stop-proc-monitor.ps1
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'cmd-window-monitor.log'
Add-Content -Path $log -Value ("==== 监控启动 " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " 管理员=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) + " ====")

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$known = @{}

function Log-Line([string]$s) { Add-Content -Path $log -Value $s }

if ($isAdmin) {
  # ── 管理员：WMI 进程创建事件（毫秒级精准，含命令行）──
  try {
    Register-CimIndicationEvent -Query "SELECT * FROM Win32_ProcessStartTrace" -SourceIdentifier ProcStartWatcher | Out-Null
    Log-Line "模式: WMI 事件订阅（精准）"
    while ($true) {
      $e = Wait-Event -SourceIdentifier ProcStartWatcher -Timeout 3600
      if (-not $e) { continue }
      $p = $e.SourceEventArgs.NewEvent
      $ln = ("[" + (Get-Date -Format 'HH:mm:ss.fff') + "] PID=" + $p.ProcessID + "  " + $p.ProcessName)
      try {
        $d = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ProcessID) -ErrorAction Stop
        if ($d.CommandLine) { $ln += "  CMDLINE: " + $d.CommandLine }
        if ($d.ExecutablePath) { $ln += "  PATH: " + $d.ExecutablePath }
      } catch { /* 瞬时进程可能已退出，只有名称 */ }
      Log-Line $ln
      Remove-Event -EventIdentifier $e.EventIdentifier
    }
  } catch { Log-Line ("WMI 事件失败，降级轮询: " + $_.Exception.Message) }
}
# ── 轮询模式（非管理员降级 / 或 WMI 失败）──
Log-Line "模式: 150ms 轮询快照"
while ($true) {
  try {
    $now = Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { $_.CreationDate -and $_.Name -match '^(cmd|conhost|powershell|pwsh|node|python|cscript|wscript|mshta)\.exe$' }
    foreach ($p in $now) {
      $key = "$($p.ProcessId)_$($p.CreationDate)"
      if (-not $known.ContainsKey($key)) {
        $known[$key] = 1
        if ($known.Count -gt 4000) { $known.Clear() }
        $cd = $p.CreationDate
        $ts = if ($cd) { $cd.ToString('yyyy-MM-dd HH:mm:ss') } else { '?' }
        $ln = "[" + (Get-Date -Format 'HH:mm:ss.fff') + "] 新进程 PID=" + $p.ProcessId + " " + $p.Name + "  启动于 " + $ts
        if ($p.CommandLine) { $ln += "  CMDLINE: " + $p.CommandLine }
        Log-Line $ln
      }
    }
  } catch { Log-Line ("轮询异常: " + $_.Exception.Message) }
  Start-Sleep -Milliseconds 150
}
