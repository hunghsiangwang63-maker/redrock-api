// 紅石攀岩館 WinPOS WP-560 發票機本地列印代理
// 跑在櫃檯電腦（Windows），開一個 http://localhost:<PORT> 給員工端網頁（staff.redrocktaiwan.com）呼叫，
// 翻譯成 ESC/POS 指令送到 RS-232（經 USB 轉接線）驅動實體發票機。
//
// 設計背景 / 決策紀錄見 redrock-api/docs/invoice-integration-plan.md 第 3、5.1、5.5 節。
// 本檔取代 scratchpad/printer-test/ 的 throwaway 原型，正式進版控、供部署到櫃檯電腦長駐執行。
//
// ⚠️ 號碼管理不在這裡——本代理是「純列印工具」，發票號碼由 RedRock 後端的 invoiceState 權威管理
// （P2，已完成，見 invoiceNumberService.js）；代理只負責「把指定內容印到當前那張紙上」，不做任何金額/號碼邏輯判斷。
//
// ✅ 開錢櫃（/open-drawer、/print 的 openDrawer 參數）已於 2026-08-06 實機測試通過：
// RJ11 錢櫃接上 WP-560 後，單獨開櫃與「現金付款列印發票同時開櫃」皆一次測試成功。

// path 明確指到本檔所在資料夾的 .env——用 npm start/雙擊 start.bat 時 cwd 本來就是這裡不受影響，
// 但裝成 Windows 服務（node-windows）背景執行時 cwd 不保證等於這個資料夾，沒指定 path 會讀不到設定。
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { SerialPort } = require('serialport');
const iconv = require('iconv-lite');

// ── 設定（.env 覆寫，見 .env.example）──────────────────────────
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3399', 10);
const SERIAL_PORT = process.env.SERIAL_PORT || '/dev/cu.usbserial-DU0ERYQM'; // Windows 上會是 COMx，裝置管理員可查
const BAUD = parseInt(process.env.BAUD || '9600', 10);
const DEFAULT_GYM = process.env.DEFAULT_GYM || 'hsinchu'; // 這台櫃檯電腦預設所屬館別（gymId 未帶時的 fallback）
// 允許呼叫本代理的來源（正式員工端網域 + 本機開發網址）；Private Network Access 需求見下方 cors 設定。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://staff.redrocktaiwan.com,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── ESC/POS 底層（2026-07-31 PoC 已驗證，見 invoice-integration-plan.md §5.5）──
// - 初始化只送 ESC @（0x1B 0x40）
// - 中文/英數混合一律先轉 Big5 編碼再送位元組（勿用預設 UTF-8，會亂碼）
// - 不支援 ESC G/ESC E（雙重列印/加粗）、FS &/FS .（Kanji 模式切換）——送出會變成亂碼文字，勿使用
// - 如需加強視覺效果用 GS !（字體放大）；本檔預設不放大，維持一般字級
// - 每張內容印完送 0x0C（Form Feed）→ 印表機自動對位＋裁切，不需自己算行數校正
const ESC_INIT = Buffer.from([0x1B, 0x40]);
const FORM_FEED = Buffer.from([0x0C]);
// ESC p m t1 t2：開錢櫃脈衝訊號（m=接腳編號 0，t1/t2=通電/斷電時間，單位約 2ms）。
// 標準值 m=0, t1=25(=50ms), t2=250(=500ms) 為業界常見的可靠開櫃脈衝長度。✅ 已實機測試通過，見檔頭。
const ESC_OPEN_DRAWER = Buffer.from([0x1B, 0x70, 0x00, 25, 250]);

const big5 = (s) => iconv.encode(s, 'big5');
const LINE_WIDTH = 24; // 已實測：24 半形字元（12 個中文全形字）＝一行寬度

function displayWidth(str) {
  let w = 0;
  for (const ch of str) w += (ch.codePointAt(0) > 0x7F) ? 2 : 1;
  return w;
}
function center(str) {
  const pad = Math.max(0, Math.floor((LINE_WIDTH - displayWidth(str)) / 2));
  return ' '.repeat(pad) + str;
}
function money(n) { return 'NT$' + Number(n || 0).toLocaleString(); }

// 兩館發票抬頭資訊（統一發票明細，已隨 2026-07-31 PoC 實機試印驗證過版面）。
// 只有兩館、變動機率低，故直接寫死於代理設定，不做動態查詢（代理刻意保持單純、不依賴任何外部服務）。
const GYMS = {
  hsinchu: {
    header: '紅石攀岩有限公司新竹館',
    taxId: '87549069',
    addr1: '新竹市東區',
    addr2: '光復路一段75號B1',
  },
  shilin: {
    header: '紅石攀岩有限公司士林館',
    taxId: '24966621',
    addr1: '台北市士林區',
    addr2: '承德路四段261號B1',
  },
};

// ── 發票內容排版（比照 scratchpad/printer-test/test-invoice-final.js 已驗證版面）──
function buildInvoiceLines({ gymId, items, total, date, buyerTaxId }) {
  const g = GYMS[gymId] || GYMS[DEFAULT_GYM];
  const dateStr = date || (() => {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  })();
  const sep = '------------------------';

  const itemList = Array.isArray(items) && items.length ? items : [];
  const itemLines = itemList.map((it) => {
    const name = String(it.name || '');
    const qty = Number(it.qty || 1);
    const price = Number(it.price || 0);
    const subtotal = qty * price;
    const right = `${price}*${qty}=${subtotal}`;
    const padCount = Math.max(1, LINE_WIDTH - displayWidth(name) - displayWidth(right));
    return name + ' '.repeat(padCount) + right;
  });
  // total 由呼叫端（RedRock 後端/前端）權威提供；缺省才用品項合計備援（代理不做金額判斷）
  const totalAmount = total != null ? Number(total) : itemList.reduce((s, it) => s + Number(it.qty || 1) * Number(it.price || 0), 0);

  const lines = [
    g.header,
    center(`統編：${g.taxId}`),
    center(g.addr1),
    center(g.addr2),
    sep,
    dateStr,
    sep,
    ...itemLines,
    sep,
    `合計：      ${money(totalAmount)}`,
  ];
  if (buyerTaxId) {
    lines.push(sep, `買受人統編：${buyerTaxId}`);
  }
  lines.push(sep, center('以下空白'));
  return lines;
}

// ── 序列埠操作（每次開關，不維持長連線——量小、印一張開一次埠即可，避免長連線佔用埠導致其他程式衝突）──
function withSerialPort(fn) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1 }, (err) => {
      if (err) return reject(err);
    });
    port.on('open', async () => {
      try {
        await fn(port);
        port.drain(() => { setTimeout(() => { port.close(); resolve(); }, 1200); });
      } catch (e) {
        port.close(() => reject(e));
      }
    });
    port.on('error', reject);
  });
}

function printInvoice(lines) {
  return withSerialPort((port) => new Promise((resolve, reject) => {
    const parts = [ESC_INIT];
    lines.forEach((l) => parts.push(big5(l + '\n')));
    parts.push(FORM_FEED);
    port.write(Buffer.concat(parts), (err) => (err ? reject(err) : resolve()));
  }));
}

function pulseDrawer() {
  return withSerialPort((port) => new Promise((resolve, reject) => {
    port.write(ESC_OPEN_DRAWER, (err) => (err ? reject(err) : resolve()));
  }));
}

// ── HTTP 服務 ────────────────────────────────────────────────
const app = express();
app.use(express.json());
// CORS + Private Network Access：staff.redrocktaiwan.com 是 HTTPS，呼叫 http://localhost 屬合法的
// mixed-content 例外，但 Chrome 的 Private Network Access 規範會先發 preflight 檢查這兩個 header。
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
}));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});

app.get('/status', async (req, res) => {
  try {
    await withSerialPort(() => Promise.resolve()); // 開得起來就當作連線正常（無法直接讀缺紙感應器，見下方註記）
    res.json({ connected: true, port: SERIAL_PORT, baud: BAUD, paperOk: null /* 未實作缺紙偵測，見 README */ });
  } catch (e) {
    res.json({ connected: false, port: SERIAL_PORT, error: e.message });
  }
});

app.post('/print', async (req, res) => {
  try {
    const { gymId, items, total, date, buyerTaxId, openDrawer } = req.body || {};
    const lines = buildInvoiceLines({ gymId, items, total, date, buyerTaxId });
    await printInvoice(lines);
    if (openDrawer) {
      try { await pulseDrawer(); } catch (e) { console.error('⚠️ 開錢櫃失敗（列印已成功、不影響發票）:', e.message); }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ 列印失敗:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.post('/open-drawer', async (req, res) => {
  try {
    await pulseDrawer();
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ 開錢櫃失敗:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// 簡易測試頁（不經過 RedRock 系統，供裝機當下手動驗證用；沿用 printer-test 原型）
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>發票列印代理・測試頁</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;}
  h1{font-size:18px;} label{display:block;margin-top:12px;font-size:13px;color:#555;}
  input,select{width:100%;padding:8px;font-size:14px;box-sizing:border-box;margin-top:4px;}
  button{width:100%;margin-top:16px;padding:14px;font-size:16px;font-weight:600;
    background:#8B1A1A;color:#fff;border:none;border-radius:8px;cursor:pointer;}
  button.secondary{background:#666;}
  #status{margin-top:14px;font-size:13px;white-space:pre-wrap;}
</style></head>
<body>
  <h1>🧾 發票列印代理・測試頁</h1>
  <p style="font-size:12px;color:#999">此頁僅供裝機/除錯手動測試，正式使用由員工端網頁自動呼叫。</p>
  <label>場館
    <select id="gym"><option value="hsinchu">新竹館</option><option value="shilin">士林館</option></select>
  </label>
  <label>品項名稱 <input id="itemName" value="入場費"></label>
  <label>金額 <input id="itemPrice" type="number" value="300"></label>
  <label>買受人統編（選填） <input id="buyerTaxId" placeholder="留空不印該行"></label>
  <label><input type="checkbox" id="openDrawer" style="width:auto;display:inline-block"> 同時開錢櫃（僅現金情境使用）</label>
  <button onclick="doPrint()">🖨️ 測試列印</button>
  <button class="secondary" onclick="doOpenDrawer()">💰 單獨開錢櫃</button>
  <button class="secondary" onclick="doStatus()">🔌 檢查連線狀態</button>
  <div id="status"></div>
<script>
async function doPrint(){
  const status = document.getElementById('status');
  status.textContent = '列印中...';
  try {
    const res = await fetch('/print', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      gymId: document.getElementById('gym').value,
      items: [{ name: document.getElementById('itemName').value, price: Number(document.getElementById('itemPrice').value), qty: 1 }],
      buyerTaxId: document.getElementById('buyerTaxId').value.trim(),
      openDrawer: document.getElementById('openDrawer').checked,
    })});
    const data = await res.json();
    status.textContent = data.ok ? '✅ 已送出列印' : ('❌ 失敗：' + data.error);
  } catch (e) { status.textContent = '❌ 連線失敗：' + e.message; }
}
async function doOpenDrawer(){
  const status = document.getElementById('status');
  status.textContent = '開櫃中...';
  try {
    const res = await fetch('/open-drawer', { method:'POST' });
    const data = await res.json();
    status.textContent = data.ok ? '✅ 已送出開櫃指令' : ('❌ 失敗：' + data.error);
  } catch (e) { status.textContent = '❌ 連線失敗：' + e.message; }
}
async function doStatus(){
  const status = document.getElementById('status');
  const res = await fetch('/status');
  status.textContent = JSON.stringify(await res.json(), null, 2);
}
</script>
</body></html>`);
});

app.listen(HTTP_PORT, () => {
  console.log(`✅ 發票列印代理已啟動：http://localhost:${HTTP_PORT}`);
  console.log(`   序列埠：${SERIAL_PORT} @ ${BAUD} baud　預設館別：${DEFAULT_GYM}`);
  console.log(`   允許來源：${ALLOWED_ORIGINS.join(', ')}`);
});
