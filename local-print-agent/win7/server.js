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

const buildInvoiceLines = (args) => buildInvoiceLinesRaw(args, DEFAULT_GYM);

// ── 呼叫 serial-bridge.ps1、回傳其 stdout（trim 過的單行文字）─────────────
function runBridge(args) {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL_EXE,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE_SCRIPT, '-Port', SERIAL_PORT, '-Baud', String(BAUD), ...args],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // 完整回報 exit code + stdout + stderr，避免只顯示 Node 產生的通用「Command failed」
          // 摘要看不到真正原因（2026-08-13 踩雷：PowerShell 有時非零結束碼卻沒有任何 stderr，
          // 原本 `stderr || err.message` 這種寫法在這種情況下就完全看不出問題出在哪）。
          const detail = [
            // ⚠️ 這台機器的 Node.js 太舊（見檔頭說明），不支援 ?? / ?. 語法（2026-08-13 踩雷過），
            // 這個檔案全程只能用最基本、ES5 相容的寫法（三元運算子、!= null），不要再用新語法。
            `exitCode=${err.code != null ? err.code : '未知'}`,
            stdout ? `stdout=${String(stdout).trim()}` : 'stdout=(空)',
            stderr ? `stderr=${String(stderr).trim()}` : 'stderr=(空)',
          ].join(' | ');
          return reject(new Error(detail));
        }
        resolve(String(stdout || '').trim());
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
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)) }));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Private-Network', 'true'); next(); });

app.get('/status', async (req, res) => {
  try {
    const line = await runBridge(['-Mode', 'status']);
    const result = parseStatusLine(line);
    res.json({ ...result, port: SERIAL_PORT, baud: BAUD });
  } catch (e) {
    // 連 PowerShell 都叫不動/COM 埠開不起來（USB 轉接線沒插上/驅動未裝/被其他程式佔用等）
    res.json({ connected: false, positionOk: null, port: SERIAL_PORT, error: e.message });
  }
});

app.post('/print', async (req, res) => {
  let tempFile = null;
  try {
    const { gymId, items, total, date, buyerTaxId, openDrawer } = req.body || {};
    const lines = buildInvoiceLines({ gymId, items, total, date, buyerTaxId });
    const payload = Buffer.concat([ESC_INIT, ...encodeLinesToBig5(lines), FORM_FEED]);
    tempFile = writeTempPayload(payload);

    const args = ['-Mode', 'print', '-PrintFile', tempFile];
    if (openDrawer) args.push('-OpenDrawer');
    const line = await runBridge(args);

    if (line === 'OK') {
      res.json({ ok: true });
    } else if (line === 'NOT_POSITIONED') {
      res.json({ ok: false, error: '發票紙未正確定位（存根聯/收執聯黑點感應異常），請確認紙張是否裝妥後再試一次' });
    } else if (line.startsWith('ERROR:')) {
      res.json({ ok: false, error: line.slice(6) });
    } else {
      res.json({ ok: false, error: `未預期的回應：${line}` });
    }
  } catch (e) {
    console.error('❌ 列印失敗:', e.message);
    res.json({ ok: false, error: e.message });
  } finally {
    if (tempFile) cleanupTempFile(tempFile);
  }
});

app.post('/open-drawer', async (req, res) => {
  try {
    const line = await runBridge(['-Mode', 'drawer']);
    if (line === 'OK') res.json({ ok: true });
    else res.json({ ok: false, error: line.startsWith('ERROR:') ? line.slice(6) : line });
  } catch (e) {
    console.error('❌ 開錢櫃失敗:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// 簡易測試頁（不經過 RedRock 系統，供裝機當下手動驗證用；HTML 共用 ../lib/testPage.js）
app.get('/', (req, res) => {
  res.type('html').send(renderTestPage());
});

app.listen(HTTP_PORT, () => {
  console.log(`✅ 發票列印代理已啟動（Windows 7 版）：http://localhost:${HTTP_PORT}`);
  console.log(`   序列埠：${SERIAL_PORT} @ ${BAUD} baud　預設館別：${DEFAULT_GYM}`);
  console.log(`   允許來源：${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`   序列埠橋接：${POWERSHELL_EXE} -File ${BRIDGE_SCRIPT}`);
});
