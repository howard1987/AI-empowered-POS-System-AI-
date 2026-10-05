# 生成收银台 256x256 应用图标（圆角底 + 白色「收」+ ¥ 角标）→ build/icon.png
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角底（青绿渐变）
$rect = New-Object System.Drawing.Rectangle(8, 8, 240, 240)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255,21,125,94), [System.Drawing.Color]::FromArgb(255,14,87,66), 55)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 52
$path.AddArc(8, 8, $r, $r, 180, 90)
$path.AddArc(248 - $r, 8, $r, $r, 270, 90)
$path.AddArc(248 - $r, 248 - $r, $r, $r, 0, 90)
$path.AddArc(8, 248 - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath($brush, $path)

# 白色「收」
$f = New-Object System.Drawing.Font('Microsoft YaHei', 118, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$g.DrawString('收', $f, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 8, 256, 240)), $sf)

# 右下 ¥ 角标
$f2 = New-Object System.Drawing.Font('Arial', 46, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('¥', $f2, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(168, 150, 80, 80)), $sf)

New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'build') | Out-Null
$bmp.Save((Join-Path $PSScriptRoot 'build\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host ('icon.png 256px 生成 → ' + (Join-Path $PSScriptRoot 'build\icon.png'))
