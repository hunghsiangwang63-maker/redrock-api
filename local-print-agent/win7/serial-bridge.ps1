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
#
# ⚠️ 2026-08-14 踩雷：debug log 訊息原本用中文字串，這台 Windows 7 讀取 .ps1 檔案時（透過 server.js
# 呼叫、非互動輸入）疑似用錯 codepage 解析多位元組中文字，導致字串裡的位元組被誤判成別的符號（例如
# 誤判成引號 "），字串提早結束、後面內容被當成程式碼解析失敗（ParserError: ExpectedExpression）。
# 互動輸入沒事是因為根本沒有「讀取檔案」這個動作，不會踩到這個問題。改成全部用英文/ASCII 字串，
# 徹底避開這個編碼風險——註解仍可用中文（註解只找行尾，不會被當程式碼解析、不受影響）。

param(
  [Parameter(Mandatory=$true)][string]$Port,
  [int]$Baud = 9600,
  [Parameter(Mandatory=$true)][ValidateSet('status','print','drawer')][string]$Mode,
  [string]$PrintFile = $null,
  [switch]$OpenDrawer,
  [int]$ReadTimeoutMs = 800
)

# 除錯記錄檔：直接互動式執行都正常，但透過 server.js/Node 呼叫時卡住逾時，目前還不知道確切卡在
# 哪一步——每一行用 Add-Content 立即寫入磁碟（不是等程式結束才寫），就算這次執行被 Node 強制中止，
# 記錄檔裡也會留下「執行到哪一步」的完整軌跡可以事後查看。固定存在腳本同一個資料夾，每次執行開頭
# 覆蓋重寫（只保留最近一次的記錄，避免無限長大）。
# ⚠️ 不能用 $PSScriptRoot——這個自動變數 PowerShell 3.0+ 才有，這台機器是 2.0（同一類版本
# 相容性踩雷，跟 -shr 那次一樣），改用 PS 2.0 就有的 $MyInvocation.MyCommand.Path 取得腳本路徑。
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile = Join-Path $ScriptDir 'bridge-debug.log'
function Log($msg) {
  $line = "[$(Get-Date -Format 'HH:mm:ss.fff')] $msg"
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}
Set-Content -Path $LogFile -Value "[$(Get-Date -Format 'HH:mm:ss.fff')] ===== START Mode=$Mode Port=$Port Baud=$Baud =====" -Encoding UTF8

# ESC p m t1 t2：開錢櫃脈衝（與 server.js 的 ESC_OPEN_DRAWER 相同，已於 2026-08-06 實機驗證通過）
$DrawerBytes = [byte[]](0x1B, 0x70, 0x00, 25, 250)

function Read-OneByteOrNull($sp) {
  try { return $sp.ReadByte() }
  catch [System.TimeoutException] { return $null }
}

Log "before creating SerialPort object"
$sp = New-Object System.IO.Ports.SerialPort($Port, $Baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$sp.ReadTimeout = $ReadTimeoutMs
Log "SerialPort object created, about to call Open()"

try {
  $sp.Open()
  Log "Open() done"

  if ($Mode -eq 'status') {
    Log "status mode: about to write basic-status query (n=1)"
    # n=1：印表機基本狀態（有無回應＝真的開電連線，不只是 COM 埠開得起來）
    $sp.Write([byte[]](0x10, 0x04, 1), 0, 3)
    Log "n=1 query written, about to read response"
    $basic = Read-OneByteOrNull $sp
    Log "read done, basic=$basic"
    if ($null -eq $basic) {
      Write-Output 'CONNECTED=0 POSITION=NULL JOURNAL=NULL RECEIPT=NULL'
    } else {
      Log "about to write paper-sensor query (n=4)"
      # n=4：紙張黑點感應（極性依 2026-08-12 實機驗證校正：1=偵測到黑點/正常）
      $sp.Write([byte[]](0x10, 0x04, 4), 0, 3)
      Log "n=4 query written, about to read response"
      $pos = Read-OneByteOrNull $sp
      Log "read done, pos=$pos"
      if ($null -eq $pos) {
        Write-Output 'CONNECTED=1 POSITION=NULL JOURNAL=NULL RECEIPT=NULL'
      } else {
        # -shr/-shl（位元位移）PowerShell 3.0+ 才支援，Win7 內建預設是 PowerShell 2.0 沒有這兩個運算子
        # （2026-08-13 實機踩雷：真正原因不是語法錯字，是這台機器的 PowerShell 版本太舊）。
        # 改用「位元遮罩比對」達到同樣效果（-band 從 v1 就有）：0x20=bit5、0x40=bit6。
        $journal = if (($pos -band 0x20) -ne 0) { 1 } else { 0 }
        $receipt = if (($pos -band 0x40) -ne 0) { 1 } else { 0 }
        $posOk = if ($journal -eq 1 -and $receipt -eq 1) { 1 } else { 0 }
        Write-Output "CONNECTED=1 POSITION=$posOk JOURNAL=$journal RECEIPT=$receipt"
      }
    }
  }
  elseif ($Mode -eq 'print') {
    Log "print mode: about to write paper-sensor query (n=4)"
    # 先查紙張定位——真的偵測到「未定位」才擋下；查無回應一律放行（交由印表機自己走 0x0C 自動對位）。
    $sp.Write([byte[]](0x10, 0x04, 4), 0, 3)
    Log "n=4 query written, about to read response"
    $pos = Read-OneByteOrNull $sp
    Log "read done, pos=$pos"
    $blocked = $false
    if ($null -ne $pos) {
      $journal = if (($pos -band 0x20) -ne 0) { 1 } else { 0 }
      $receipt = if (($pos -band 0x40) -ne 0) { 1 } else { 0 }
      if (-not ($journal -eq 1 -and $receipt -eq 1)) { $blocked = $true }
    }
    if ($blocked) {
      Write-Output 'NOT_POSITIONED'
    } else {
      if ($PrintFile -and (Test-Path $PrintFile)) {
        Log "about to write print payload ($((Get-Item $PrintFile).Length) bytes)"
        $bytes = [System.IO.File]::ReadAllBytes($PrintFile)
        $sp.Write($bytes, 0, $bytes.Length)
        Log "print payload written"
      }
      if ($OpenDrawer) {
        $sp.Write($DrawerBytes, 0, $DrawerBytes.Length)
        Log "drawer command written"
      }
      # 對齊 server.js 的 settleMs：給機構動作（裁切等）完成時間，太快關埠可能撞到下一次開埠。
      Start-Sleep -Milliseconds 1200
      Write-Output 'OK'
    }
  }
  elseif ($Mode -eq 'drawer') {
    $sp.Write($DrawerBytes, 0, $DrawerBytes.Length)
    Log "drawer command written"
    Write-Output 'OK'
  }
  Log "main flow done, about to enter finally block to close port"
}
catch {
  Log "exception: $($_.Exception.Message)"
  Write-Output "ERROR:$($_.Exception.Message)"
  exit 1
}
finally {
  if ($sp.IsOpen) { $sp.Close() }
  Log "===== END ====="
}
