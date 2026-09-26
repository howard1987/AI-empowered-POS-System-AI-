' 打开后台管理端（动态端口）：读取 backend\.env 的 PORT，打开 http://localhost:<端口>/admin/
' 这样即使在托盘「网络与端口设置」里改过端口，快捷方式依然指向正确地址
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)          ' {app}\service
envFile = fso.BuildPath(fso.GetParentFolderName(base), "backend\.env")
port = 3100

If fso.FileExists(envFile) Then
  For Each line In Split(fso.OpenTextFile(envFile, 1).ReadAll, vbLf)
    t = Trim(Replace(line, vbCr, ""))
    If Left(t, 5) = "PORT=" And Not Left(t, 1) = "#" Then
      p = Trim(Mid(t, 6))
      If IsNumeric(p) Then port = CLng(p)
      Exit For
    End If
  Next
End If

sh.Run "http://localhost:" & port & "/admin/"
