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

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
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
// PowerShell 子行程逾時保護。⚠️ 2026-08-13 踩雷：這台機器直接測試約需 6 秒才有回應（USB
// 轉接序列埠的硬體/驅動本身較慢，非程式問題），原本設 5 秒導致還沒跑完就被強制中止（無任何
// stdout/stderr，只回報 exitCode=未知）——拉長到 15 秒給足夠餘裕，避免誤殺實際上會成功的請求。
const TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '15000', 10);
// ⚠️ 純診斷用版本標記，跟修 bug 無關——2026-08-14 兩輪修復後使用者仍回報一模一樣的舊錯誤，
// 為了在下一次回報時能立刻分辨「到底有沒有真的換到新檔案」，把這個字串直接放進 /status、
// /print 的 JSON 回應與開機訊息裡。每次真的動到 runBridge 邏輯就把這個字串換掉。
const AGENT_VERSION = 'pna-preflight-fix-2026-08-15';

const buildInvoiceLines = (args) => buildInvoiceLinesRaw(args, DEFAULT_GYM);

// ── 呼叫 serial-bridge.ps1、回傳其 stdout（trim 過的單行文字）─────────────
// ⚠️ 2026-08-13 重大改法：原本用「陣列多個獨立參數」（-Port ... -Mode ... 分開傳給 execFile）
// 呼叫時完全卡住逾時（連 serial-bridge.ps1 第一行程式碼都沒執行到，記錄檔案從未被建立過），
// 但直接在互動式 PowerShell 視窗打同一行指令完全正常——懷疑是這台機器的舊版 Node.js 在把
// 陣列參數組成 Windows 命令列字串時有跳脫符號拼接的已知舊版問題，導致 PowerShell 實際收到
// 的指令被拼錯，-Port/-Mode 這類必填參數綁不到值，PowerShell 因此卡在互動式提示「請輸入
// 缺少的參數值」等待輸入——但這裡背後沒有人可以輸入，於是卡到逾時被強制關掉。改成自己組
// 一整段單一字串（-Command "& '...' -Port '...' ..."）傳給 execFile，避開陣列逐一拼接。
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
    let cmd = "& '" + BRIDGE_SCRIPT + "' -Port '" + SERIAL_PORT + "' -Baud " + BAUD + " -Mode '" + mode + "'";
    if (printFile) cmd += " -PrintFile '" + printFile + "'";
    if (openDrawer) cmd += " -OpenDrawer";
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
          // execFile 認為失敗（很可能是收尾逾時被強制關閉），但 stdout 內容完整合法——
          // 相信已經拿到的真實結果，不要把使用者導向錯誤的「失敗」畫面。
          console.log('⚠️ execFile 回報錯誤，但 stdout 內容完整合法，視為成功：' + trimmedOut);
          return resolve(trimmedOut);
        }
        if (err) {
          // 完整回報 exit code + stdout + stderr，避免只顯示 Node 產生的通用「Command failed」
          // 摘要看不到真正原因（2026-08-13 踩雷：PowerShell 有時非零結束碼卻沒有任何 stderr，
          // 原本 `stderr || err.message` 這種寫法在這種情況下就完全看不出問題出在哪）。
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
    const line = await runBridge({ mode: 'status' });
    const result = parseStatusLine(line);
    res.json({ ...result, port: SERIAL_PORT, baud: BAUD, agentVersion: AGENT_VERSION });
  } catch (e) {
    // 連 PowerShell 都叫不動/COM 埠開不起來（USB 轉接線沒插上/驅動未裝/被其他程式佔用等）
    res.json({ connected: false, positionOk: null, port: SERIAL_PORT, error: e.message, agentVersion: AGENT_VERSION });
  }
});

app.post('/print', async (req, res) => {
  let tempFile = null;
  try {
    const { gymId, items, total, date, buyerTaxId, openDrawer } = req.body || {};
    const lines = buildInvoiceLines({ gymId, items, total, date, buyerTaxId });
    const payload = Buffer.concat([ESC_INIT, ...encodeLinesToBig5(lines), FORM_FEED]);
    tempFile = writeTempPayload(payload);

    const line = await runBridge({ mode: 'print', printFile: tempFile, openDrawer });

    if (line === 'OK') {
      res.json({ ok: true, agentVersion: AGENT_VERSION });
    } else if (line === 'NOT_POSITIONED') {
      res.json({ ok: false, error: '發票紙未正確定位（存根聯/收執聯黑點感應異常），請確認紙張是否裝妥後再試一次', agentVersion: AGENT_VERSION });
    } else if (line.startsWith('ERROR:')) {
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
    const line = await runBridge({ mode: 'drawer' });
    if (line === 'OK') res.json({ ok: true, agentVersion: AGENT_VERSION });
    else res.json({ ok: false, error: line.startsWith('ERROR:') ? line.slice(6) : line, agentVersion: AGENT_VERSION });
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
  console.log(`   允許來源：${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`   序列埠橋接：${POWERSHELL_EXE} -File ${BRIDGE_SCRIPT}`);
});
