' 无窗口启动服务端管理器（托盘）：避免 PowerShell 黑窗一闪
Set sh = CreateObject("Wscript.Shell")
psDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = psDir
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psDir & "\server-tray.ps1""", 0, False
