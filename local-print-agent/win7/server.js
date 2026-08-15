// 紅石攀岩館 WinPOS WP-560 發票機本地列印代理 —— Windows 7 專用版
//
// 為什麼跟 ../server.js 分開一份：serialport npm 套件（../server.js 用的）需要 Node.js >=20 才能
// 編譯原生模組，但 Node.js 從 v14 起就不再支援 Windows 7（v13.14.0 是最後一個官方支援 Win7 的版
// 本，而且該版本本身也太舊、跟現有 express/serialport 版本都對不上）。這份改成：
//   - HTTP 層用 Express 4（相容非常舊的 Node，不像 Express 5 要求 Node>=18）
//   - 序列埠 I/O 完全不用 serialport 套件，改呼叫 ../win7/serial-bridge.ps1（PowerShell 內建
//     System.IO.Ports.SerialPort，Win7 本機自帶 .NET Framework 就有，不用另外裝任何東西/不用編譯）
// 兩份檔案的「發票內容排版」「測試頁」共用 ../lib/ 底下的模組，只有序列埠傳輸層不同——行為應與
// Mac/Win10+ 版本一致，發票版面/欄位需要調整時改 ../lib/invoiceFormat.js 即可、不用兩邊各改一次。
//
// 安裝方式見同資料夾 README.md（Node.js 版本、npm install、.env 設定）。
//
// ── 常駐序列埠連線（2026-08-15 新增）─────────────────────────────────────────
// 背景：這台機器（USB 轉序列埠硬體/驅動較慢）每次開埠（SerialPort.Open()）約要 6 秒。原本每個
// HTTP 請求（/status、/print）都各自 spawn 一個全新的 PowerShell 行程、各自重新開一次埠——櫃檯
// 開一次「開立發票」面板要查一次狀態、按一次列印又要再開一次埠，兩次疊加單張發票要等 10 幾秒，
// 尖峰時段很有感（2026-08-15 使用者實際回報）。
// 改法：開機時只 spawn 一個「常駐」PowerShell 行程（serial-bridge.ps1 -Mode daemon），它只在啟動
// 時開一次埠、之後透過 stdin/stdout 持續存活收發命令——所有 HTTP 請求都透過同一個常駐行程的
// stdin/stdout 溝通（見下方 startDaemon/sendDaemonCommand），不再重新開埠。Open() 的 ~6 秒代價
// 從「每次呼叫都要付一次」降到「這個常駐行程活著的期間（通常是整個營業日）只付一次」。
// 因為只有一條 stdin/stdout 通道、同一時間只能有一個命令在跑，用一個先進先出佇列（pendingQueue）
// 自然把並發的 HTTP 請求序列化——這本來就對，實體印表機本來就只能一次做一件事。
// 保留舊的「每次呼叫都重新 spawn」邏輯（runBridge，完全不動、已知可行只是慢）當作 .env
// PERSISTENT_MODE=false 時的備援——這是全新、還沒在真實 Win7 機器上測過的架構，萬一常駐行程在
// 這台機器上有我沒預料到的問題，隨時可以改這一個設定值退回舊的（慢但已驗證過）行為，不用等重新
// 除錯才能繼續營業。

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const { buildInvoiceLines: buildInvoiceLinesRaw, encodeLinesToBig5 } = require('../lib/invoiceFormat');
const { renderTestPage } = require('../lib/testPage');

// ── 設定（.env 覆寫，見 .env.example）──────────────────────────
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3399', 10);
const SERIAL_PORT = process.env.SERIAL_PORT || 'COM3'; // 裝置管理員→連接埠(COM/LPT) 可查實際編號
const BAUD = parseInt(process.env.BAUD || '9600', 10);
const DEFAULT_GYM = process.env.DEFAULT_GYM || 'hsinchu';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://staff.redrocktaiwan.com,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
// 大部分 Win7 機器 PATH 裡就有 powershell.exe；極少數受限環境才需要在 .env 指定完整路徑，
// 例如 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
const POWERSHELL_EXE = process.env.POWERSHELL_EXE || 'powershell.exe';
const BRIDGE_SCRIPT = path.join(__dirname, 'serial-bridge.ps1');
// PowerShell 子行程逾時保護（一次性模式用）。⚠️ 2026-08-13 踩雷：這台機器直接測試約需 6 秒才有
// 回應（USB 轉接序列埠的硬體/驅動本身較慢，非程式問題），原本設 5 秒導致還沒跑完就被強制中止
// （無任何 stdout/stderr，只回報 exitCode=未知）——拉長到 15 秒給足夠餘裕，避免誤殺實際上會成功
// 的請求。常駐模式下不使用這個常數（見下方 DAEMON_CMD_TIMEOUT_MS/DAEMON_PRINT_TIMEOUT_MS）。
const TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '15000', 10);
// 常駐模式下單一命令的逾時：因為 Open() 的成本已經在啟動時付過，穩定狀態下 STATUS/DRAWER 應該是
// 幾百毫秒等級（一次序列埠讀寫），PRINT 多了 1.2 秒固定裁切等待——都給比預期寬鬆不少的餘裕，避免
// 正常的驅動抖動被誤判成逾時而觸發不必要的常駐行程重啟。
const DAEMON_CMD_TIMEOUT_MS = parseInt(process.env.DAEMON_CMD_TIMEOUT_MS || '5000', 10);
const DAEMON_PRINT_TIMEOUT_MS = parseInt(process.env.DAEMON_PRINT_TIMEOUT_MS || '10000', 10);
// 是否啟用常駐序列埠連線（見檔頭說明）。預設開啟；設為 'false' 退回舊的「每次呼叫都重新開埠」
// 行為（較慢但是已知可行的備援，遇到常駐模式在這台機器上有預料外問題時可立刻切換不用等修復）。
const PERSISTENT_MODE = (process.env.PERSISTENT_MODE || 'true') !== 'false';
// ⚠️ 純診斷用版本標記，跟修 bug 無關——2026-08-14 兩輪修復後使用者仍回報一模一樣的舊錯誤，
// 為了在下一次回報時能立刻分辨「到底有沒有真的換到新檔案」，把這個字串直接放進 /status、
// /print 的 JSON 回應與開機訊息裡。每次真的動到 runBridge/常駐邏輯就把這個字串換掉。
const AGENT_VERSION = 'persistent-serial-daemon-2026-08-15';

const buildInvoiceLines = (args) => buildInvoiceLinesRaw(args, DEFAULT_GYM);

// ── 一次性模式（.env PERSISTENT_MODE=false 時使用；完全沿用先前已驗證的行為，不動邏輯）──────

// ⚠️ 2026-08-13 重大改法：原本用「陣列多個獨立參數」（-Port ... -Mode ... 分開傳給 execFile）
// 呼叫時完全卡住逾時（連 serial-bridge.ps1 第一行程式碼都沒執行到，記錄檔案從未被建立過），
// 但直接在互動式 PowerShell 視窗打同一行指令完全正常——懷疑是這台機器的舊版 Node.js 在把
// 陣列參數組成 Windows 命令列字串時有跳脫符號拼接的已知舊版問題，導致 PowerShell 實際收到
// 的指令被拼錯，-Port/-Mode 這類必填參數綁不到值，PowerShell 因此卡在互動式提示「請輸入
// 缺少的參數值」等待輸入——但這裡背後沒有人可以輸入，於是卡到逾時被強制關掉。改成自己組
// 一整段單一字串（-Command "& '...' -Port '...' ..."）傳給 execFile，避開陣列逐一拼接。
// 常駐模式的 startDaemon() 也沿用同一個「組單一字串」手法呼叫 spawn，避免重蹈同一個雷。
function buildPowerShellCommand(mode, extra) {
  let cmd = "& '" + BRIDGE_SCRIPT + "' -Port '" + SERIAL_PORT + "' -Baud " + BAUD + " -Mode '" + mode + "'";
  if (extra) cmd += extra;
  return cmd;
}

// ⚠️ 2026-08-14 踩雷：serial-bridge.ps1 中文編碼問題修好後，print/status 兩種模式實測
// 「動作本身確實成功」（印表機真的印出來、CONNECTED/POSITION/JOURNAL/RECEIPT 四個欄位都
// 正確），但這裡卻仍回報失敗——關鍵線索是 exitCode=未知：Node 的 execFile 在子行程被「訊
// 號終止」（非正常 exit，而不是腳本自己 exit 1）時，err.code 會是 null/undefined（不是某
// 個實際的數字），這正是 execFile 的 timeout 選項把行程強制關閉時的特徵。也就是說
// serial-bridge.ps1 已經把正確的最終結果寫進 stdout，但行程本身在那之後遲遲沒有真正結
// 束（很可能卡在 finally 區塊呼叫 $sp.Close() 這一步——便宜 USB 轉序列埠晶片的驅動程式
// 收尾偶爾會卡住），直到撞到 TIMEOUT_MS 逾時被強制關閉。
// 修法：不要無條件把「execFile 回報 err」當成失敗，先看 stdout 是不是這個模式該有的合法
// 完整格式——是的話直接當成功處理（並印一行警告方便事後追查是否真的是收尾卡住），只有
// stdout 內容本身不合法（真的沒有任何有效輸出）才視為真正失敗。這樣即使子行程收尾卡住被
// 強制關閉，只要它已經把結果寫出來，使用者這邊看到的行為就會是正確的「成功」。
const VALID_STDOUT_PATTERNS = {
  status: /^CONNECTED=(0|1) POSITION=(0|1|NULL) JOURNAL=(0|1|NULL) RECEIPT=(0|1|NULL)$/,
  print: /^(OK|NOT_POSITIONED|ERROR:[\s\S]+)$/,
  drawer: /^(OK|ERROR:[\s\S]+)$/,
};

function runBridge({ mode, printFile, openDrawer }) {
  return new Promise((resolve, reject) => {
    let extra = '';
    if (printFile) extra += " -PrintFile '" + printFile + "'";
    if (openDrawer) extra += ' -OpenDrawer';
    const cmd = buildPowerShellCommand(mode, extra);
    // 診斷用：不管 PowerShell 那邊卡不卡住，Node 這裡一定會印出來——如果這次還是失敗，
    // 把這行印出的完整指令原封不動複製到互動式 PowerShell 視窗貼上手動跑一次，能直接判斷
    // 是「指令內容本身有問題」還是「透過這裡呼叫的啟動方式本身有問題」（2026-08-13）。
    console.log('[執行前] ' + POWERSHELL_EXE + ' -NoProfile -ExecutionPolicy Bypass -Command "' + cmd + '"');
    execFile(POWERSHELL_EXE,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { timeout: TIMEOUT_MS },
      (err, stdout, stderr) => {
        const trimmedOut = String(stdout || '').trim();
        console.log('[執行後] err=' + (err ? 'YES' : 'NO') + (err ? (' code=' + (err.code != null ? err.code : '未知') + ' killed=' + (err.killed ? 'YES' : 'NO') + ' signal=' + (err.signal || '無')) : '') + ' stdout=' + (trimmedOut || '(空)'));
        const pattern = VALID_STDOUT_PATTERNS[mode];
        const stdoutLooksValid = pattern && pattern.test(trimmedOut);
        if (err && stdoutLooksValid) {
          console.log('⚠️ execFile 回報錯誤，但 stdout 內容完整合法，視為成功：' + trimmedOut);
          return resolve(trimmedOut);
        }
        if (err) {
          const detail = [
            // ⚠️ 這台機器的 Node.js 太舊（見檔頭說明），不支援 ?? / ?. 語法（2026-08-13 踩雷過），
            // 這個檔案全程只能用最基本、ES5 相容的寫法（三元運算子、!= null），不要再用新語法。
            `exitCode=${err.code != null ? err.code : '未知'}`,
            stdout ? `stdout=${trimmedOut}` : 'stdout=(空)',
            stderr ? `stderr=${String(stderr).trim()}` : 'stderr=(空)',
          ].join(' | ');
          return reject(new Error(detail));
        }
        resolve(trimmedOut);
      });
  });
}

// ── 常駐模式（PERSISTENT_MODE=true，預設）────────────────────────────────────
let daemonProc = null;
let daemonReady = false;
let daemonRestarting = false;
let daemonStartedAt = 0;
let pendingQueue = []; // { resolve, reject, timer }，先進先出——單一 stdin/stdout 通道天生序列化並發請求

function rejectAllPending(message) {
  while (pendingQueue.length) {
    const entry = pendingQueue.shift();
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
}

function startDaemon() {
  const cmd = buildPowerShellCommand('daemon', '');
  console.log('[daemon] starting: ' + POWERSHELL_EXE + ' -NoProfile -ExecutionPolicy Bypass -Command "' + cmd + '"');
  daemonStartedAt = Date.now();
  daemonReady = false;
  const proc = spawn(POWERSHELL_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  daemonProc = proc;

  proc.stdout.setEncoding('utf8');
  // crlfDelay: Infinity——PowerShell 的 WriteLine 送出 \r\n，沒有這個選項 readline 可能把 \r 跟
  // \n 當成兩個獨立的換行事件、多送出一個空白行事件，讓「一個命令對應一行回應」的配對邏輯錯位。
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    if (!daemonReady) {
      if (line === 'DAEMON_READY') {
        daemonReady = true;
        console.log(`[daemon] ready（開埠+啟動共花 ${Date.now() - daemonStartedAt}ms）`);
      } else {
        console.warn('[daemon] 就緒前收到非預期內容：' + line);
      }
      return;
    }
    const entry = pendingQueue.shift();
    if (!entry) {
      console.warn('[daemon] 收到回應但沒有對應的等待中請求（可能是上一次逾時後遲到的回應）：' + line);
      return;
    }
    clearTimeout(entry.timer);
    entry.resolve(line);
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => console.error('[daemon:stderr] ' + String(d).trim()));

  proc.on('exit', (code, signal) => {
    console.warn(`[daemon] 常駐行程結束（code=${code} signal=${signal}）`);
    if (daemonProc !== proc) return; // 避免舊行程延遲觸發的 exit 事件誤把「目前這個新行程」判斷成掛掉
    daemonReady = false;
    daemonProc = null;
    rejectAllPending('印表機常駐服務已中斷');
    if (!daemonRestarting) {
      daemonRestarting = true;
      // 留 3 秒緩衝再自動重啟——避免（例如序列埠真的被拔掉/被其他程式佔用）行程立刻又失敗，
      // 陷入無限快速重啟洗版記錄檔。
      setTimeout(() => { daemonRestarting = false; startDaemon(); }, 3000);
    }
  });
  proc.on('error', (err) => {
    console.error('[daemon] 常駐行程啟動失敗：' + err.message);
  });
}

// 供 Node 端每個 HTTP 請求呼叫：把一行命令送進常駐行程的 stdin，等它在 stdout 吐出對應的一行
// 回應。逾時或行程未就緒都直接 reject，不會無限期卡住呼叫端。
function sendDaemonCommand(cmdLine, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!daemonReady || !daemonProc || !daemonProc.stdin.writable) {
      return reject(new Error('印表機常駐服務尚未就緒，請稍候再試'));
    }
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const idx = pendingQueue.indexOf(entry);
      if (idx !== -1) pendingQueue.splice(idx, 1);
      reject(new Error('印表機常駐服務逾時無回應'));
      // 逾時代表常駐行程可能卡住（例如驅動收尾卡住，見一次性模式那段 2026-08-14 的相同現象）——
      // 與其讓它繼續半死不活擋住後續所有請求，直接重啟拿一個乾淨的常駐行程。
      console.warn('[daemon] 命令逾時（' + cmdLine.split('|')[0] + '），觸發重啟');
      restartDaemon();
    }, timeoutMs);
    pendingQueue.push(entry);
    try {
      daemonProc.stdin.write(cmdLine + '\n');
    } catch (e) {
      clearTimeout(entry.timer);
      const idx = pendingQueue.indexOf(entry);
      if (idx !== -1) pendingQueue.splice(idx, 1);
      reject(e);
    }
  });
}

function restartDaemon() {
  if (daemonRestarting) return;
  daemonRestarting = true;
  daemonReady = false;
  rejectAllPending('印表機常駐服務重啟中，請稍候再試一次');
  const old = daemonProc;
  daemonProc = null;
  if (old) { try { old.kill(); } catch (e) { /* 行程可能已經死了，忽略 */ } }
  setTimeout(() => { daemonRestarting = false; startDaemon(); }, 2000);
}

// 服務被關閉時（NSSM 停止服務會送 SIGTERM；Ctrl+C 手動執行時是 SIGINT）盡量讓常駐行程正常關埠，
// 不要留著沒關好的 COM 埠——下次啟動服務時 Open() 撞到「已被佔用」會失敗。
function shutdownDaemon() {
  if (daemonProc && daemonProc.stdin.writable) {
    try { daemonProc.stdin.write('EXIT\n'); } catch (e) { /* 忽略 */ }
  }
  setTimeout(() => { if (daemonProc) { try { daemonProc.kill(); } catch (e) { /* 忽略 */ } } }, 1000);
}
if (PERSISTENT_MODE) {
  process.on('SIGINT', () => { shutdownDaemon(); setTimeout(() => process.exit(0), 1200); });
  process.on('SIGTERM', () => { shutdownDaemon(); setTimeout(() => process.exit(0), 1200); });
}

// ── /status：解析 CONNECTED=.. POSITION=.. JOURNAL=.. RECEIPT=.. ─────────
function parseStatusLine(line) {
  const m = /CONNECTED=(\d) POSITION=(\d|NULL) JOURNAL=(\d|NULL) RECEIPT=(\d|NULL)/.exec(line || '');
  if (!m) return { connected: false, positionOk: null, journalMarkOk: null, receiptMarkOk: null };
  const toBoolOrNull = (v) => (v === 'NULL' ? null : v === '1');
  return {
    connected: m[1] === '1',
    positionOk: toBoolOrNull(m[2]),
    journalMarkOk: toBoolOrNull(m[3]),
    receiptMarkOk: toBoolOrNull(m[4]),
  };
}

// ── 把列印內容寫成暫存二進位檔，供 PowerShell 讀取寫入 COM 埠（避開字串編碼在
// Node↔PowerShell 之間傳遞可能被破壞的風險——Big5 是脆弱的多位元組編碼，一律走檔案）──
function writeTempPayload(buf) {
  // 純檔名防撞、非安全用途，不需要真正的 UUID——避免額外依賴 uuid 套件（Node 13.x 沒有
  // crypto.randomUUID()，是 14.17+ 才加入的），時戳+亂數已足夠避開同時間多筆請求互相覆蓋。
  const rand = Math.random().toString(36).slice(2);
  const file = path.join(os.tmpdir(), `redrock-print-${Date.now()}-${rand}.bin`);
  fs.writeFileSync(file, buf);
  return file;
}
function cleanupTempFile(file) {
  fs.unlink(file, () => {}); // 失敗也不影響本次列印結果，純清理、不阻斷
}

const ESC_INIT = Buffer.from([0x1B, 0x40]);
const FORM_FEED = Buffer.from([0x0C]);

const app = express();
app.use(express.json());
// ⚠️ 2026-08-15 修：PNA header 一定要在 cors() 之前設定——cors() 收到 OPTIONS 預檢請求會直接
// 結束回應（不呼叫 next()），原本寫在 cors() 之後的這個 middleware 對預檢請求根本沒機會執行，
// 導致預檢回應永遠缺這個 header。Chrome 的 Private Network Access 檢查看的正是「預檢回應」
// 有沒有這個 header，缺了就直接擋掉整個請求（連 fetch 都送不出去，前端顯示「無法連線」）——
// 士林 Win7 機器上這樣直接列印的第一次真實回報就是撞到這個。改到 cors() 之前即可讓預檢回應
// 也帶上這個 header（用 curl 送 OPTIONS 帶 Access-Control-Request-Private-Network 驗證過）。
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Private-Network', 'true'); next(); });
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)) }));

app.get('/status', async (req, res) => {
  try {
    const line = PERSISTENT_MODE
      ? await sendDaemonCommand('STATUS', DAEMON_CMD_TIMEOUT_MS)
      : await runBridge({ mode: 'status' });
    const result = parseStatusLine(line);
    res.json({ ...result, port: SERIAL_PORT, baud: BAUD, agentVersion: AGENT_VERSION, persistentMode: PERSISTENT_MODE });
  } catch (e) {
    // 連 PowerShell 都叫不動/COM 埠開不起來（USB 轉接線沒插上/驅動未裝/被其他程式佔用等），
    // 或常駐行程尚未就緒/逾時
    res.json({ connected: false, positionOk: null, port: SERIAL_PORT, error: e.message, agentVersion: AGENT_VERSION, persistentMode: PERSISTENT_MODE });
  }
});

app.post('/print', async (req, res) => {
  let tempFile = null;
  try {
    const { gymId, items, total, date, buyerTaxId, openDrawer } = req.body || {};
    const lines = buildInvoiceLines({ gymId, items, total, date, buyerTaxId });
    const payload = Buffer.concat([ESC_INIT, ...encodeLinesToBig5(lines), FORM_FEED]);
    tempFile = writeTempPayload(payload);

    const line = PERSISTENT_MODE
      ? await sendDaemonCommand('PRINT|' + tempFile + '|' + (openDrawer ? '1' : '0'), DAEMON_PRINT_TIMEOUT_MS)
      : await runBridge({ mode: 'print', printFile: tempFile, openDrawer });

    if (line === 'OK') {
      res.json({ ok: true, agentVersion: AGENT_VERSION });
    } else if (line === 'NOT_POSITIONED') {
      res.json({ ok: false, error: '發票紙未正確定位（存根聯/收執聯黑點感應異常），請確認紙張是否裝妥後再試一次', agentVersion: AGENT_VERSION });
    } else if (line.indexOf('ERROR:') === 0) {
      res.json({ ok: false, error: line.slice(6), agentVersion: AGENT_VERSION });
    } else {
      res.json({ ok: false, error: `未預期的回應：${line}`, agentVersion: AGENT_VERSION });
    }
  } catch (e) {
    console.error('❌ 列印失敗:', e.message);
    res.json({ ok: false, error: e.message, agentVersion: AGENT_VERSION });
  } finally {
    if (tempFile) cleanupTempFile(tempFile);
  }
});

app.post('/open-drawer', async (req, res) => {
  try {
    const line = PERSISTENT_MODE
      ? await sendDaemonCommand('DRAWER', DAEMON_CMD_TIMEOUT_MS)
      : await runBridge({ mode: 'drawer' });
    if (line === 'OK') res.json({ ok: true, agentVersion: AGENT_VERSION });
    else res.json({ ok: false, error: line.indexOf('ERROR:') === 0 ? line.slice(6) : line, agentVersion: AGENT_VERSION });
  } catch (e) {
    console.error('❌ 開錢櫃失敗:', e.message);
    res.json({ ok: false, error: e.message, agentVersion: AGENT_VERSION });
  }
});

// 簡易測試頁（不經過 RedRock 系統，供裝機當下手動驗證用；HTML 共用 ../lib/testPage.js）
app.get('/', (req, res) => {
  res.type('html').send(renderTestPage());
});

app.listen(HTTP_PORT, () => {
  console.log(`✅ 發票列印代理已啟動（Windows 7 版）：http://localhost:${HTTP_PORT}`);
  console.log(`   版本標記：${AGENT_VERSION}　←（若這行跟預期的版本字串不同，代表這台機器還在跑舊檔案，還沒真的換到新版）`);
  console.log(`   序列埠：${SERIAL_PORT} @ ${BAUD} baud　預設館別：${DEFAULT_GYM}`);
  console.log(`   常駐序列埠連線：${PERSISTENT_MODE ? '開啟（每次請求不用重開埠，較快）' : '關閉（.env PERSISTENT_MODE=false，退回每次重開埠的舊行為，較慢但已知可行）'}`);
  console.log(`   允許來源：${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`   序列埠橋接：${POWERSHELL_EXE} -File ${BRIDGE_SCRIPT}`);
  if (PERSISTENT_MODE) startDaemon();
});
