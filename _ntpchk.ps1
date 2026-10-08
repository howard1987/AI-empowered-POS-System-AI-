# 与 NTP 服务器对时，核对服务器时钟准确性
$udp = New-Object System.Net.Sockets.UdpClient
$udp.Connect('ntp.aliyun.com', 123)
$pkt = New-Object byte[] 48
$pkt[0] = 0x1B
[void]$udp.Send($pkt, 48)
$recv = $udp.Receive([ref]$null)
$udp.Close()

# NTP 64位时间戳：从第40字节起（ Transmit Timestamp ）
$i = 40
$sec  = [uint32]($recv[$i]   * 16777216 + $recv[$i+1] * 65536 + $recv[$i+2] * 256 + $recv[$i+3])
$frac = [uint32]($recv[$i+4] * 16777216 + $recv[$i+5] * 65536 + $recv[$i+6] * 256 + $recv[$i+7])
$ms = [int64]$sec * 1000 + ([int64]$frac * 1000 / [math]::Pow(2, 32)) - 2208988800000
$ntp = [DateTimeOffset]::FromUnixTimeMilliseconds($ms).ToLocalTime()

$local = Get-Date
Write-Host ('NTP  北京时间 : ' + $ntp.ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ('本机 北京时间 : ' + $local.ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ('时钟偏差(毫秒) : ' + [math]::Round(($local - $ntp.LocalDateTime).TotalMilliseconds))
Write-Host ('W32Time 服务   : ' + (Get-Service W32Time).Status)
