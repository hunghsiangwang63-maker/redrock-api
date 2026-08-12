# serial-bridge.ps1 — Windows 7 用序列埠橋接
#
# 為什麼需要這個：serialport npm 套件（win7 之外的 server.js 用的）需要 Node.js >=20 才能編譯原生模組，
# 而 Node.js 從 v14 起就不支援 Windows 7（v13.14.0 是最後一個官方支援 Win7 的版本）。這個版本改用
# PowerShell 內建的 System.IO.Ports.SerialPort（.NET，Win7 本機就有，不用另外裝任何東西）直接讀寫
# COM 埠，Node.js 端（win7/server.js）只負責 HTTP 層 + 呼叫這支 PowerShell 腳本做實際的序列埠 I/O。
#
# 對應 ../server.js 的通訊協定（DLE EOT n 查詢、ESC/POS 列印、ESC p 開錢櫃）——同一套位元組序列，
# 只是傳輸層從 Node 原生 serialport 換成這支腳本，行為應與 Mac/Win10+ 版本一致。
#
# 用法（由 win7/server.js 呼叫，見該檔 callBridge()）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File serial-bridge.ps1 -Port COM3 -Mode status
#   powershell -NoProfile -ExecutionPolicy Bypass -File serial-bridge.ps1 -Port COM3 -Mode print -PrintFile C:\path\payload.bin [-OpenDrawer]
#   powershell -NoProfile -ExecutionPolicy Bypass -File serial-bridge.ps1 -Port COM3 -Mode drawer
#
# 輸出（單行 stdout，供 Node.js 解析）：
#   status 模式：CONNECTED=<0|1> POSITION=<0|1|NULL> JOURNAL=<0|1|NULL> RECEIPT=<0|1|NULL>
#   print  模式：OK 或 NOT_POSITIONED 或 ERROR:<訊息>
#   drawer 模式：OK 或 ERROR:<訊息>

param(
  [Parameter(Mandatory=$true)][string]$Port,
  [int]$Baud = 9600,
  [Parameter(Mandatory=$true)][ValidateSet('status','print','drawer')][string]$Mode,
  [string]$PrintFile = $null,
  [switch]$OpenDrawer,
  [int]$ReadTimeoutMs = 800
)

# ESC p m t1 t2：開錢櫃脈衝（與 server.js 的 ESC_OPEN_DRAWER 相同，已於 2026-08-06 實機驗證通過）
$DrawerBytes = [byte[]](0x1B, 0x70, 0x00, 25, 250)

function Read-OneByteOrNull($sp) {
  try { return $sp.ReadByte() }
  catch [System.TimeoutException] { return $null }
}

$sp = New-Object System.IO.Ports.SerialPort($Port, $Baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$sp.ReadTimeout = $ReadTimeoutMs

try {
  $sp.Open()

  if ($Mode -eq 'status') {
    # n=1：印表機基本狀態（有無回應＝真的開電連線，不只是 COM 埠開得起來）
    $sp.Write([byte[]](0x10, 0x04, 1), 0, 3)
    $basic = Read-OneByteOrNull $sp
    if ($null -eq $basic) {
      Write-Output 'CONNECTED=0 POSITION=NULL JOURNAL=NULL RECEIPT=NULL'
    } else {
      # n=4：紙張黑點感應（極性依 2026-08-12 實機驗證校正：1=偵測到黑點/正常）
      $sp.Write([byte[]](0x10, 0x04, 4), 0, 3)
      $pos = Read-OneByteOrNull $sp
      if ($null -eq $pos) {
        Write-Output 'CONNECTED=1 POSITION=NULL JOURNAL=NULL RECEIPT=NULL'
      } else {
        $journal = ($pos -shr 5) -band 1
        $receipt = ($pos -shr 6) -band 1
        $posOk = if ($journal -eq 1 -and $receipt -eq 1) { 1 } else { 0 }
        Write-Output "CONNECTED=1 POSITION=$posOk JOURNAL=$journal RECEIPT=$receipt"
      }
    }
  }
  elseif ($Mode -eq 'print') {
    # 先查紙張定位——真的偵測到「未定位」才擋下；查無回應一律放行（交由印表機自己走 0x0C 自動對位）。
    $sp.Write([byte[]](0x10, 0x04, 4), 0, 3)
    $pos = Read-OneByteOrNull $sp
    $blocked = $false
    if ($null -ne $pos) {
      $journal = ($pos -shr 5) -band 1
      $receipt = ($pos -shr 6) -band 1
      if (-not ($journal -eq 1 -and $receipt -eq 1)) { $blocked = $true }
    }
    if ($blocked) {
      Write-Output 'NOT_POSITIONED'
    } else {
      if ($PrintFile -and (Test-Path $PrintFile)) {
        $bytes = [System.IO.File]::ReadAllBytes($PrintFile)
        $sp.Write($bytes, 0, $bytes.Length)
      }
      if ($OpenDrawer) {
        $sp.Write($DrawerBytes, 0, $DrawerBytes.Length)
      }
      # 對齊 server.js 的 settleMs：給機構動作（裁切等）完成時間，太快關埠可能撞到下一次開埠。
      Start-Sleep -Milliseconds 1200
      Write-Output 'OK'
    }
  }
  elseif ($Mode -eq 'drawer') {
    $sp.Write($DrawerBytes, 0, $DrawerBytes.Length)
    Write-Output 'OK'
  }
}
catch {
  Write-Output "ERROR:$($_.Exception.Message)"
  exit 1
}
finally {
  if ($sp.IsOpen) { $sp.Close() }
}
