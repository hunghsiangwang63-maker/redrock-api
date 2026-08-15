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
# 用法（由 win7/server.js 呼叫，見該檔）：
#   一次性模式（單次查詢/列印/開櫃，開一次埠、做一件事、關埠、結束行程）：
#     powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'serial-bridge.ps1' -Port COM3 -Mode status"
#     powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'serial-bridge.ps1' -Port COM3 -Mode print -PrintFile C:\path\payload.bin [-OpenDrawer]"
#     powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'serial-bridge.ps1' -Port COM3 -Mode drawer"
#   常駐模式（2026-08-15 新增，見下方「常駐模式」說明）：
#     powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'serial-bridge.ps1' -Port COM3 -Mode daemon"
#
# 輸出（單行 stdout，供 Node.js 解析；常駐模式下每收到一個命令就吐一行對應的回應）：
#   status 查詢：CONNECTED=<0|1> POSITION=<0|1|NULL> JOURNAL=<0|1|NULL> RECEIPT=<0|1|NULL>
#   print  動作：OK 或 NOT_POSITIONED 或 ERROR:<訊息>
#   drawer 動作：OK 或 ERROR:<訊息>
#
# ── 常駐模式（-Mode daemon）───────────────────────────────────────────────
# 背景：一次性模式每次呼叫都要重新 SerialPort.Open()，這台機器（USB 轉序列埠硬體/驅動較慢）光是
# Open() 就要約 6 秒——櫃檯每開一次「開立發票」面板要查一次狀態、按一次列印又要再開一次埠，兩次
# 疊加起來單張發票要等 10 幾秒，尖峰時段很有感（2026-08-15 使用者實際回報）。
# 常駐模式把 Open() 從「每次呼叫都要付一次」改成「這個常駐行程活著的期間只付一次」：啟動時開一次
# 埠、進入迴圈持續存活，透過 stdin 一行一行收命令（STATUS / PRINT|<檔案路徑>|<0或1> / DRAWER /
# EXIT）、處理完立刻在 stdout 吐一行對應回應，直到收到 EXIT 或 stdin 被關閉（父行程結束）才真正
# 關埠退出。由 win7/server.js 在啟動時 spawn 一次、之後所有 HTTP 請求都透過這一個常駐行程的
# stdin/stdout 溝通（見該檔 startDaemon/sendDaemonCommand）。
# 進入迴圈前會先吐一行 DAEMON_READY（此時埠已確定開好），Node 端以此判斷常駐行程真的準備好可以
#收命令，而不是單純「行程啟動成功」就假設可用（行程啟動成功不代表 Open() 已經跑完/沒有丟例外）。
# PRINT 命令的檔案路徑用 | 分隔——Windows 檔名合法字元本來就不允許 |，用它當分隔符不會誤切到路徑本身。
# ⚠️ 常駐模式下的除錯記錄檔（見下方 $LogFile）會記錄整個常駐行程存活期間處理過的所有命令（不是
# 只有最近一次），跟一次性模式「每次執行覆蓋重寫」的原始設計意圖不同——這是刻意的（累積歷史記錄
# 對事後排查更有用），單日印表機使用量不會讓這個檔案長到有感的大小，不用另外做輪替清理。
#
# ⚠️ 2026-08-14 踩雷：debug log 訊息原本用中文字串，這台 Windows 7 讀取 .ps1 檔案時（透過 server.js
# 呼叫、非互動輸入）疑似用錯 codepage 解析多位元組中文字，導致字串裡的位元組被誤判成別的符號（例如
# 誤判成引號 "），字串提早結束、後面內容被當成程式碼解析失敗（ParserError: ExpectedExpression）。
# 互動輸入沒事是因為根本沒有「讀取檔案」這個動作，不會踩到這個問題。改成全部用英文/ASCII 字串，
# 徹底避開這個編碼風險——註解仍可用中文（註解只找行尾，不會被當程式碼解析、不受影響）。

param(
  [Parameter(Mandatory=$true)][string]$Port,
  [int]$Baud = 9600,
  [Parameter(Mandatory=$true)][ValidateSet('status','print','drawer','daemon')][string]$Mode,
  [string]$PrintFile = $null,
  [switch]$OpenDrawer,
  [int]$ReadTimeoutMs = 800
)

# 除錯記錄檔：直接互動式執行都正常，但透過 server.js/Node 呼叫時卡住逾時，目前還不知道確切卡在
# 哪一步——每一行用 Add-Content 立即寫入磁碟（不是等程式結束才寫），就算這次執行被 Node 強制中止，
# 記錄檔裡也會留下「執行到哪一步」的完整軌跡可以事後查看。固定存在腳本同一個資料夾，每次執行開頭
# 覆蓋重寫（一次性模式只保留最近一次的記錄；常駐模式見上方說明，會累積整個存活期間的記錄）。
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

# ── 共用邏輯（一次性模式與常駐模式都呼叫這兩個函式，避免同一段 ESC/POS 位元組序列在兩處各寫一份、
# 之後改動時容易漏改其中一邊而不同步）────────────────────────────────────────────
function Get-StatusLine($sp) {
  Log "status: about to write basic-status query (n=1)"
  # n=1：印表機基本狀態（有無回應＝真的開電連線，不只是 COM 埠開得起來）
  $sp.Write([byte[]](0x10, 0x04, 1), 0, 3)
  Log "status: n=1 query written, about to read response"
  $basic = Read-OneByteOrNull $sp
  Log "status: read done, basic=$basic"
  if ($null -eq $basic) {
    return 'CONNECTED=0 POSITION=NULL JOURNAL=NULL RECEIPT=NULL'
  }
  Log "status: about to write paper-sensor query (n=4)"
  # n=4：紙張黑點感應（極性依 2026-08-12 實機驗證校正：1=偵測到黑點/正常）
  $sp.Write([byte[]](0x10, 0x04, 4), 0, 3)
  Log "status: n=4 query written, about to read response"
  $pos = Read-OneByteOrNull $sp
  Log "status: read done, pos=$pos"
  if ($null -eq $pos) {
    return 'CONNECTED=1 POSITION=NULL JOURNAL=NULL RECEIPT=NULL'
  }
  # -shr/-shl（位元位移）PowerShell 3.0+ 才支援，Win7 內建預設是 PowerShell 2.0 沒有這兩個運算子
  # （2026-08-13 實機踩雷：真正原因不是語法錯字，是這台機器的 PowerShell 版本太舊）。
  # 改用「位元遮罩比對」達到同樣效果（-band 從 v1 就有）：0x20=bit5、0x40=bit6。
  $journal = if (($pos -band 0x20) -ne 0) { 1 } else { 0 }
  $receipt = if (($pos -band 0x40) -ne 0) { 1 } else { 0 }
  $posOk = if ($journal -eq 1 -and $receipt -eq 1) { 1 } else { 0 }
  return "CONNECTED=1 POSITION=$posOk JOURNAL=$journal RECEIPT=$receipt"
}

function Do-Print($sp, $printFile, $openDrawer) {
  Log "print: about to write paper-sensor query (n=4)"
  # 先查紙張定位——真的偵測到「未定位」才擋下；查無回應一律放行（交由印表機自己走 0x0C 自動對位）。
  $sp.Write([byte[]](0x10, 0x04, 4), 0, 3)
  Log "print: n=4 query written, about to read response"
  $pos = Read-OneByteOrNull $sp
  Log "print: read done, pos=$pos"
  $blocked = $false
  if ($null -ne $pos) {
    $journal = if (($pos -band 0x20) -ne 0) { 1 } else { 0 }
    $receipt = if (($pos -band 0x40) -ne 0) { 1 } else { 0 }
    if (-not ($journal -eq 1 -and $receipt -eq 1)) { $blocked = $true }
  }
  if ($blocked) {
    return 'NOT_POSITIONED'
  }
  # 2026-08-14：開櫃指令改到列印內容「之前」送出——開櫃是電氣脈衝幾乎即時，列印+裁切是機構
  # 動作要幾秒；原本順序（先印完整張才開櫃）等於收銀員要等紙印完才能開始收現/找零。位置檢查
  # 通過後先送開櫃指令、緊接著才送列印內容，讓錢櫃盡早彈開，列印本身耗時不變、只是先後對調。
  if ($openDrawer) {
    $sp.Write($DrawerBytes, 0, $DrawerBytes.Length)
    Log "print: drawer command written (before print payload)"
  }
  if ($printFile -and (Test-Path $printFile)) {
    Log "print: about to write print payload ($((Get-Item $printFile).Length) bytes)"
    $bytes = [System.IO.File]::ReadAllBytes($printFile)
    $sp.Write($bytes, 0, $bytes.Length)
    Log "print: payload written"
  }
  # 對齊 server.js 的 settleMs：給機構動作（裁切等）完成時間，太快關埠可能撞到下一次開埠。
  Start-Sleep -Milliseconds 1200
  return 'OK'
}

$sp = $null
Log "before creating SerialPort object"
$sp = New-Object System.IO.Ports.SerialPort($Port, $Baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$sp.ReadTimeout = $ReadTimeoutMs
Log "SerialPort object created, about to call Open()"

try {
  $sp.Open()
  Log "Open() done"

  if ($Mode -eq 'status') {
    Write-Output (Get-StatusLine $sp)
  }
  elseif ($Mode -eq 'print') {
    Write-Output (Do-Print $sp $PrintFile $OpenDrawer.IsPresent)
  }
  elseif ($Mode -eq 'drawer') {
    $sp.Write($DrawerBytes, 0, $DrawerBytes.Length)
    Log "drawer command written"
    Write-Output 'OK'
  }
  elseif ($Mode -eq 'daemon') {
    # 明確指定編碼，避免這台機器系統預設 codepage 造成的字元轉換問題（同檔頭 2026-08-14 踩雷同一類風險）。
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    Log "daemon: entering command loop, emitting DAEMON_READY"
    [Console]::Out.WriteLine('DAEMON_READY')
    [Console]::Out.Flush()
    while ($true) {
      $cmdLine = [Console]::In.ReadLine()
      if ($null -eq $cmdLine) {
        Log "daemon: stdin closed (parent process gone), exiting loop"
        break
      }
      $cmdLine = $cmdLine.Trim()
      if ($cmdLine -eq '') { continue }
      if ($cmdLine -eq 'EXIT') {
        Log "daemon: EXIT command received"
        break
      }
      Log "daemon: received command: $cmdLine"
      $response = $null
      try {
        if ($cmdLine -eq 'STATUS') {
          $response = Get-StatusLine $sp
        }
        elseif ($cmdLine.StartsWith('PRINT|')) {
          # PRINT|<檔案路徑>|<0或1>——Windows 檔名不可用 | ，用它分隔不會誤切到路徑本身
          $parts = $cmdLine.Split('|')
          $pFile = if ($parts.Length -gt 1) { $parts[1] } else { $null }
          $pDrawer = ($parts.Length -gt 2 -and $parts[2] -eq '1')
          $response = Do-Print $sp $pFile $pDrawer
        }
        elseif ($cmdLine -eq 'DRAWER') {
          $sp.Write($DrawerBytes, 0, $DrawerBytes.Length)
          $response = 'OK'
        }
        else {
          $response = "ERROR:unknown command: $cmdLine"
        }
      }
      catch {
        Log "daemon: exception handling command: $($_.Exception.Message)"
        $response = "ERROR:$($_.Exception.Message)"
      }
      # 保險：把回應裡任何換行都攤平成空白——常駐模式的協定是「一個命令對應一行回應」，萬一例外訊息
      # 本身帶了換行，多吐出來的那幾行會被 Node 誤當成下一個命令的回應，導致後續所有請求的配對全部
      # 錯位（一次性模式沒有這個風險，因為 Node 是整批讀 stdout、不是逐行配對）。
      $response = $response -replace "`r`n", ' ' -replace "`n", ' ' -replace "`r", ' '
      Log "daemon: responding: $response"
      [Console]::Out.WriteLine($response)
      [Console]::Out.Flush()
    }
    Log "daemon: loop ended, falling through to finally block to close port"
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
