# V4.18.7b USB receipt printer RAW direct print via Windows driver (winspool RAW)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File rawprint.ps1 -Printer "POS-80" -File <bin>
param(
  [Parameter(Mandatory=$true)][string]$Printer,
  [Parameter(Mandatory=$true)][string]$File
)
$src = @'
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public struct DOCINFOA { [MarshalAs(UnmanagedType.LPStr)] public string docName;
    [MarshalAs(UnmanagedType.LPStr)] public string outputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string dataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
  public static int SendBytes(string szPrinterName, byte[] data) {
    IntPtr hPrinter;
    if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) return -1;
    DOCINFOA di = new DOCINFOA();
    di.docName = "POS Direct Print"; di.dataType = "RAW";
    if (!StartDocPrinter(hPrinter, 1, ref di)) { ClosePrinter(hPrinter); return -2; }
    if (!StartPagePrinter(hPrinter)) { EndDocPrinter(hPrinter); ClosePrinter(hPrinter); return -3; }
    int written; bool ok = WritePrinter(hPrinter, data, data.Length, out written);
    EndPagePrinter(hPrinter); EndDocPrinter(hPrinter); ClosePrinter(hPrinter);
    return ok ? written : -4;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($File)
$r = [RawPrinterHelper]::SendBytes($Printer, $bytes)
if ($r -lt 0) {
  $why = @{ -1='OpenPrinter failed: printer name not found or offline'; -2='StartDocPrinter failed'; -3='StartPagePrinter failed'; -4='WritePrinter failed' }[[int]$r]
  Write-Output ("ERR|" + $why); exit 1
}
Write-Output ("OK|" + $r)
