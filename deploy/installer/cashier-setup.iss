; ============================================================================
; 超市收银系统 · 收银端安装包（Inno Setup 6）
; 内容：Electron 收银端（dist-modern/win-unpacked，Electron 44 x64）
; 默认安装路径：D:\Program Files\超市收银系统
; 编译：ISCC.exe cashier-setup.iss
; ============================================================================

#define MyAppName "超市收银系统"
#define MyAppVer "5.0.5"
#define UnpackDir "d:\Software\POS_system\超市收银系统-初版代码\frontend-desktop\dist-modern\win-unpacked"

[Languages]
; 安装向导全程简体中文（V4.28.9：此前未配置时向导为英文界面）
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Setup]
SetupIconFile=assets\pos.ico
AppId={{8E7B6C41-52A0-4B7E-9F3A-CASHIER-0000001}
AppName={#MyAppName}
AppVersion={#MyAppVer}
; V4.28.9：安装目录改英文（避免中文路径不可预料问题，如 vbs/服务/命令行边界）；快捷方式仍为中文名
DefaultDirName=D:\Program Files\POS-Cashier
DirExistsWarning=no
DisableProgramGroupPage=yes
OutputDir=D:\Software\POS_system\V5.0\installers
OutputBaseFilename=POS-Cashier-Setup-{#MyAppVer}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标："; Flags: unchecked
Name: "autostart"; Description: "开机自动启动收银台"; GroupDescription: "附加图标："; Flags: unchecked

[Files]
Source: "{#UnpackDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; V4.28.9 定制图标（快捷方式用；EXE 本体图标需重打 Electron 包时在 electron-builder 配 win.icon）
Source: "assets\pos.ico"; DestDir: "{app}"; DestName: "pos.ico"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\超市收银系统.exe"; IconFilename: "{app}\pos.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\超市收银系统.exe"; Tasks: desktopicon; IconFilename: "{app}\pos.ico"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\超市收银系统.exe"; Tasks: autostart; IconFilename: "{app}\pos.ico"

[Run]
Filename: "{app}\超市收银系统.exe"; Description: "立即启动收银台"; \
  Flags: nowait postinstall skipifsilent

[Code]
// ── V4.28.8 安装前自动结束运行中的收银端（无人值守：不弹窗、不强求重启）──
//  CloseApplications=yes 依赖系统重启管理器可能弹窗；这里直接 taskkill 保证继续下一步。
procedure TaskKillCashier;
var
  Rc: Integer;
begin
  // /T 连带结束 Electron 子进程树（GPU/渲染进程）；重复执行无害
  Exec(ExpandConstant('{cmd}'),
    '/C taskkill /F /IM "超市收银系统.exe" /T >nul 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, Rc);
  Sleep(600);   // 留出文件句柄释放时间
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';   // '' = 继续安装
  TaskKillCashier;
end;

// 覆盖安装/卸载前后再兜底一次（防止安装中途用户又打开了收银台）
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then TaskKillCashier;
end;
