; ============================================================================
; 超市收银系统 · 服务端安装包（Inno Setup 6）V2
;  - 后端以 Windows 服务方式运行（WinSW 包装）：开机自启、崩溃 5 秒自动重启、全程无 cmd 窗口
;  - 附「服务端管理器」：任务栏托盘 UI（打开管理后台 / 启停服务 / 日志目录）
;  - 内置 Node.js（免装 Node 环境）+ 嵌入版 PostgreSQL + AI 模型 + TTS 引擎
; 默认安装路径：D:\Program Files\POS-Server
; 编译：ISCC.exe server-setup.iss
; ============================================================================

#define MyAppName "超市收银系统 服务端"
#define MyAppVer "5.0.0"
#define SrcRoot "d:\Software\POS_system\超市收银系统-初版代码"

[Languages]
; 安装向导全程简体中文（V4.28.9：此前未配置时向导为英文界面）
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Setup]
SetupIconFile=assets\pos.ico
AppId={{8E7B6C41-52A0-4B7E-9F3A-0000-SERVER001}
AppName={#MyAppName}
AppVersion={#MyAppVer}
DefaultDirName=D:\Program Files\POS-Server
DirExistsWarning=no
DisableProgramGroupPage=yes
OutputDir=D:\Software\POS_system\V5.0\installers
OutputBaseFilename=POS-Server-Setup-{#MyAppVer}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
; 注册 Windows 服务需要管理员权限
PrivilegesRequired=admin
UninstallDisplayName={#MyAppName}

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式（服务端管理器）"; \
  GroupDescription: "附加图标："
Name: "autostartservice"; Description: "开机自动启动服务端（Windows 服务，推荐）"; \
  GroupDescription: "附加任务："; Flags: checkedonce

[Files]
; ── 内置 Node.js 运行时（免装 Node）──
Source: "C:\Program Files\nodejs\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
; ── 后端编译产物 dist（运行必需：server-up 启动 dist/main.js）──
Source: "{#SrcRoot}\backend\dist\*"; DestDir: "{app}\backend\dist"; \
  Flags: ignoreversion recursesubdirs createallsubdirs sortfilesbyextension
; ── 后端运行资料（V4.28.0 F-10：不再随包分发 TS 源码/.env/tsconfig——运行只需 dist）──
Source: "{#SrcRoot}\backend\*"; DestDir: "{app}\backend"; \
  Excludes: "node_modules,dist,logs,.playwright-cli,.tmpcrawl,.runtime,_*,public\uploads\*,tests\*,*.log,src,src\*,.env,*.ts,tsconfig.json"; \
  Flags: ignoreversion recursesubdirs createallsubdirs
; ── 后端依赖（运行必需，压缩后显著变小）──
Source: "{#SrcRoot}\backend\node_modules\*"; DestDir: "{app}\backend\node_modules"; \
  Flags: ignoreversion recursesubdirs createallsubdirs sortfilesbyextension
; ── Windows 服务包装器（WinSW）与服务定义 ──
Source: "{#SrcRoot}\deploy\installer\bin\WinSW-x64.exe"; DestDir: "{app}\service"; DestName: "pos-server-service.exe"; Flags: ignoreversion
Source: "{#SrcRoot}\deploy\installer\pos-server-service.xml"; DestDir: "{app}\service"; Flags: ignoreversion
; ── 服务端管理器（托盘 UI）──
Source: "{#SrcRoot}\deploy\installer\server-tray.ps1"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#SrcRoot}\deploy\installer\server-tray.vbs"; DestDir: "{app}\service"; Flags: ignoreversion
; ── 后台管理端快捷打开（动态读 .env 端口，改端口后仍指向正确地址）──
Source: "{#SrcRoot}\deploy\installer\open-admin.vbs"; DestDir: "{app}\service"; Flags: ignoreversion
; V4.28.9 定制图标（安装器/快捷方式共用）
Source: "{#SrcRoot}\deploy\installer\assets\pos.ico"; DestDir: "{app}\service"; Flags: ignoreversion
; V4.28.9 Web 后台随包托管：后端静态托管 /admin/（同源免配置，open-admin.vbs 指向 3100/admin/）
Source: "{#SrcRoot}\frontend-web\*"; DestDir: "{app}\backend\public\admin"; Excludes: "node_modules,server.mjs,package.json"; \
  Flags: ignoreversion recursesubdirs createallsubdirs
; ── 部署工具 / 文档 ──
Source: "{#SrcRoot}\deploy\env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\deploy\backup\*"; DestDir: "{app}\deploy\backup"; Flags: ignoreversion recursesubdirs
Source: "{#SrcRoot}\deploy\README_DEPLOY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\deploy\README-SERVER.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\runtime-watchdog.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\backend\public\uploads"
Name: "{app}\logs"

[Icons]
Name: "{autoprograms}\{#MyAppName} 服务端管理器"; Filename: "{app}\service\server-tray.vbs"; \
  IconFilename: "{app}\service\pos.ico"
Name: "{autoprograms}\{#MyAppName} 后台管理"; Filename: "{app}\service\open-admin.vbs"; \
  IconFilename: "{app}\service\pos.ico"
Name: "{autodesktop}\{#MyAppName} 服务端管理器"; Filename: "{app}\service\server-tray.vbs"; Tasks: desktopicon; \
  IconFilename: "{app}\service\pos.ico"
Name: "{autodesktop}\{#MyAppName} 后台管理"; Filename: "{app}\service\open-admin.vbs"; \
  IconFilename: "{app}\service\pos.ico"; Tasks: desktopicon

[Run]
; 注册并启动 Windows 服务（runhidden：不闪窗口）
Filename: "{app}\service\pos-server-service.exe"; Parameters: "install"; Flags: runhidden
Filename: "{app}\service\pos-server-service.exe"; Parameters: "start"; Flags: runhidden; Tasks: autostartservice
; V4.28.9 修复：.vbs 不能被 CreateProcess 直接执行（错误 193"不是有效的 Win32 应用程序"），
; 必须经 wscript.exe 承载；路径含空格（D:\Program Files\...）需内嵌引号（Inno 用 "" 转义）
Filename: "wscript.exe"; Parameters: """{app}\service\server-tray.vbs"""; Description: "启动服务端管理器（任务栏托盘）"; \
  Flags: nowait postinstall skipifsilent runhidden

[UninstallRun]
Filename: "{app}\service\pos-server-service.exe"; Parameters: "stop"; Flags: runhidden; RunOnceId: "SvcStop"
Filename: "{app}\service\pos-server-service.exe"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "SvcUninstall"

[Code]
// ── V4.28.8 安装前自动收尾运行中的程序（必须能无人值守继续安装）──
//  顺序：停 Windows 服务(pos-server) → 杀服务包装进程 → 杀 {app} 下的 node(含应急启动)
//  → 杀 {app} 下的内置 PostgreSQL → 杀托盘管理器。全部"尽力而为"，失败不阻断安装。
procedure PrepareStopRunning;
var
  AppDir, Ps: String;
  PsFile: String;
  Rc: Integer;
begin
  AppDir := ExpandConstant('{app}');
  StringChangeEx(AppDir, '''', '''''', True);   // 单引号转义（防路径含撇号）
  Ps :=
    '$ErrorActionPreference = ''SilentlyContinue''' + #13#10 +
    '$app = ''' + AppDir + '''' + #13#10 +
    '// 1) 停 Windows 服务' + #13#10 +
    '$svc = Get-Service -Name ''pos-server'' -ErrorAction SilentlyContinue' + #13#10 +
    'if ($svc -and $svc.Status -ne ''Stopped'') { Stop-Service -Name ''pos-server'' -Force }' + #13#10 +
    'Start-Sleep -Milliseconds 1200' + #13#10 +
    '// 2) 服务包装器（WinSW）' + #13#10 +
    'Get-Process -Name ''pos-server-service'' | Stop-Process -Force' + #13#10 +
    '// 3) node：命令行含 server-up.mjs（服务/应急启动）或可执行文件位于安装目录' + #13#10 +
    'Get-WmiObject Win32_Process -Filter "Name=''node.exe''" | ' + #13#10 +
    '  Where-Object { $_.CommandLine -like ''*server-up.mjs*'' -or $_.ExecutablePath -like ($app + ''*'') } | ' + #13#10 +
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }' + #13#10 +
    '// 4) 内置 PostgreSQL（位于安装目录内的实例；不影响系统其它 PG）' + #13#10 +
    'Get-WmiObject Win32_Process -Filter "Name=''postgres.exe''" | ' + #13#10 +
    '  Where-Object { $_.ExecutablePath -like ($app + ''*'') } | ' + #13#10 +
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }' + #13#10 +
    '// 5) 服务端管理器托盘' + #13#10 +
    'Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like ''*server-tray*'' } | ' + #13#10 +
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }' + #13#10 +
    '// 6) 应急启动遗留的 cmd（命令行引用安装目录）' + #13#10 +
    'Get-WmiObject Win32_Process -Filter "Name=''cmd.exe''" | ' + #13#10 +
    '  Where-Object { $_.CommandLine -like (''*'' + $app + ''*'') } | ' + #13#10 +
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }' + #13#10 +
    'Start-Sleep -Milliseconds 800';
  PsFile := ExpandConstant('{tmp}\stop-pos.ps1');
  SaveStringToFile(PsFile, Ps, False);
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + PsFile + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Rc);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';   // '' = 继续安装
  try
    PrepareStopRunning;
  except
    // 收尾失败不阻断安装（后续文件覆盖失败才由 Inno 报错）
  end;
end;

// 生成手工/应急启动脚本（服务方式之外的兜底，使用内置 Node）
procedure CurStepChanged(CurStep: TSetupStep);
var
  Bat: String;
begin
  if CurStep = ssPostInstall then begin
    Bat := ExpandConstant('{app}\应急启动服务端.bat');
    SaveStringToFile(Bat,
      '@echo off' + #13#10 +
      'chcp 65001 >nul' + #13#10 +
      'cd /d "%~dp0backend"' + #13#10 +
      'set "PATH=%~dp0runtime;%PATH%"' + #13#10 +
      'if not exist ".env" copy /y "..\env.example" ".env" >nul' + #13#10 +
      'echo [INFO] 应急启动（正常情况请使用 Windows 服务 / 托盘管理器）...' + #13#10 +
      '"%~dp0runtime\node.exe" scripts\server-up.mjs up' + #13#10 +
      'pause' + #13#10,
      False);
  end;
end;
