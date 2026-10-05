<#
  sync-cert.ps1 - pin the LOCAL ROOT CA into the Android app (V5.0.10)

  Why the CA and not the leaf
    The server re-issues its leaf certificate whenever a LAN IP changes (DHCP / reboot).
    A re-issued leaf has different bytes, so pinning the leaf inside the APK breaks every
    time the IP changes, forcing a new APK build.

    Instead the backend keeps a long-lived local root CA (certs\ca.pem, 20 years, created
    once and never re-issued) and signs the leaf with it. Pinning the CA keeps the app
    working no matter how often the leaf is re-issued.

  Run this only when certs\ca.pem is (re)created - normally once, ever.
#>
param(
  [string]$CertPath = (Join-Path $PSScriptRoot '..\backend\certs\ca.pem'),
  [string]$Dest    = (Join-Path $PSScriptRoot 'android\app\src\main\res\raw\pos_server_cert.pem')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $CertPath)) {
  throw ("CA not found: $CertPath -- start the backend once so it creates certs\ca.pem, then re-run.")
}

$rawDir = Split-Path $Dest -Parent
if (-not (Test-Path $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }

# Binary-safe copy: PEM is ASCII, and reading/writing bytes avoids any encoding surprises.
$bytes = [System.IO.File]::ReadAllBytes($CertPath)
[System.IO.File]::WriteAllBytes($Dest, $bytes)

# Parse it back and report the essentials so SAN coverage can be eyeballed.
$pem  = [System.IO.File]::ReadAllText($Dest, [System.Text.Encoding]::ASCII)
$b64  = ($pem -replace '-----[A-Z ]+-----', '') -replace '\s', ''
$der  = [Convert]::FromBase64String($b64)
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(, $der)

Write-Host "[sync-cert] pinned -> $Dest"
Write-Host ("[sync-cert] subject   : " + ($cert.Subject -replace "`r?`n", ' | '))
Write-Host ("[sync-cert] valid     : " + $cert.NotBefore.ToString('yyyy-MM-dd') + " -> " + $cert.NotAfter.ToString('yyyy-MM-dd'))

# basicConstraints (2.5.29.19): a root CA has cA=TRUE and normally carries no SAN;
# the SANs (host / IPs) live on the leaf certificate that the CA signs.
$isCa = $false
foreach ($ext in $cert.Extensions) {
  if ($ext.Oid.Value -ne '2.5.29.19') { continue }
  $f = $ext.Format($false)
  # .NET renders this localized ("Subject Type=CA" on zh-CN) while OpenSSL uses "CA=TRUE"
  if ($f -match 'CA=True' -or $f -match 'Type=CA') { $isCa = $true }
}
Write-Host ("[sync-cert] isCA      : " + $isCa)

if (-not $isCa) {
  Write-Warning "[sync-cert] WARNING: pinned cert is NOT a CA. Pin the leaf and the app will break every time the server re-issues on an IP change. Expected source: backend\certs\ca.pem"
} elseif ($cert.NotAfter -lt (Get-Date).AddYears(1)) {
  Write-Warning "[sync-cert] WARNING: CA expires soon (" + $cert.NotAfter.ToString('yyyy-MM-dd') + "). Regenerate the CA and re-pin + rebuild before then."
} else {
  Write-Host "[sync-cert] OK: long-lived CA pinned. Leaf re-issues (IP changes) will keep working without rebuilding the APK."
}
