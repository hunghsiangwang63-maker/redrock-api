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
const { GYMS, big5, buildInvoiceLines: buildInvoiceLinesRaw, encodeLinesToBig5 } = require('./lib/invoiceFormat');
const { renderTestPage } = require('./lib/testPage');

// ── 設定（.env 覆寫，見 .env.example）──────────────────────────
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3399', 10);
const SERIAL_PORT = process.env.SERIAL_PORT || '/dev/cu.usbserial-DU0ERYQM'; // Windows 上會是 COMx，裝置管理員可查
const BAUD = parseInt(process.env.BAUD || '9600', 10);
const DEFAULT_GYM = process.env.DEFAULT_GYM || 'hsinchu'; // 這台櫃檯電腦預設所屬館別（gymId 未帶時的 fallback）
// 允許呼叫本代理的來源（正式員工端網域 + 本機開發網址）；Private Network Access 需求見下方 cors 設定。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://staff.redrocktaiwan.com,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
// 發票內容排版（GYMS 抬頭/LINE_SPACING 行距等）已抽到 lib/invoiceFormat.js，與 win7/server.js 共用，
// 修改排版時改那一份即可、這裡不再重複維護。
const buildInvoiceLines = (args) => buildInvoiceLinesRaw(args, DEFAULT_GYM);

// ── ESC/POS 底層（2026-07-31 PoC 已驗證，見 invoice-integration-plan.md §5.5）──
// - 初始化只送 ESC @（0x1B 0x40）
// - 中文/英數混合一律先轉 Big5 編碼再送位元組（勿用預設 UTF-8，會亂碼）
// - 不支援 ESC G/ESC E（雙重列印/加粗）、FS &/FS .（Kanji 模式切換）——送出會變成亂碼文字，勿使用
// - ESC 3 n（設定行距為 n/180 吋）：2026-08-12 實測不會亂碼，但也完全沒有視覺效果（機器不理會此
//   指令）——行距改用 LINE_SPACING（見 lib/invoiceFormat.js，純內容插空行）達成，勿再嘗試這個 ESC 指令。
// - 如需加強視覺效果用 GS !（字體放大）；本檔預設不放大，維持一般字級
// - 每張內容印完送 0x0C（Form Feed）→ 印表機自動對位＋裁切，不需自己算行數校正
const ESC_INIT = Buffer.from([0x1B, 0x40]);
const FORM_FEED = Buffer.from([0x0C]);
// ESC p m t1 t2：開錢櫃脈衝訊號（m=接腳編號 0，t1/t2=通電/斷電時間，單位約 2ms）。
// 標準值 m=0, t1=25(=50ms), t2=250(=500ms) 為業界常見的可靠開櫃脈衝長度。✅ 已實機測試通過，見檔頭。
const ESC_OPEN_DRAWER = Buffer.from([0x1B, 0x70, 0x00, 25, 250]);

// ── 即時狀態查詢（2026-08-11 新增，2026-08-12 實機驗證＋校正極性後恢復紙張定位偵測）─────
// DLE EOT n（0x10 0x04 n）＝ESC/POS 家族的「即時狀態回傳」指令。
//
// ✅ n=1（印表機基本狀態）已於 2026-08-12 在真實 WP-560 上實機驗證通過：印表機關電時無回應
// （connected:false）、開電時正確回應（connected:true）。
//
// ✅ n=4（紙張感應器狀態）也已於 2026-08-12 實機驗證通過，但**極性跟同廠牌同系列機型 WP-520
// 操作手冊附錄 B-2 記載的相反**——手冊寫 bit5(存根聯)/bit6(收執聯) 是「0=偵測到黑點(正常)、
// 1=未偵測到(異常)」，但這台實機測出來是反過來的「1=偵測到黑點(正常)、0=未偵測到(異常)」。
// 依據：連續四輪實機讀數完全自洽——兩聯皆定位成功→bit5=1,bit6=1；兩聯皆未定位（重複驗證兩次，
// 結果一致）→bit5=0,bit6=0；只有收執聯刻意抽出→bit5=1(存根聯仍正常),bit6=0(僅收執聯異常)，
// 精準對應到「哪一聯出問題哪一個位元才變」，非巧合。故沿用手冊的 bit 位置（bit5=存根聯／
// bit6=收執聯），但解讀極性改成「1=正常」。
const STATUS_TIMEOUT_MS = 800;

// ⚠️ 2026-08-12 二次修正：第一版修法（等 port.close() 的 callback 真的觸發才繼續）只縮小了
// 「access denied」發生機率、沒有根除——實機回報「一直按最後印得出來，後面又卡住」，代表 Windows
// 就算已觸發 close 的 callback，OS 底層真正把 COM 埠交還可用的時間點可能還要再晚一點點，緊接著
// 開下一次埠的空窗期依然存在。真正的解法：**一次 /print 請求只開關序列埠一次**（查紙張定位→
// 列印→開錢櫃三個動作都在同一個已開啟的 port 上依序做完），而不是像原本各自獨立開關三次——
// 這樣同一次請求內完全沒有「關了又立刻開」的動作，只剩跨越不同次 HTTP 請求之間的間隔（間隔通常
// 有幾百毫秒以上，足夠讓 OS 完成釋放，不會撞到）。/status 同理（原本查 n=1、n=4 各自開關一次）。

// 在「已經開啟」的 port 上送出 DLE EOT n 並等待單次回應，本身不開關埠
// （開關埠交由外層 withSerialPort 統一管理，供 /status、/print 在同一個 session 內共用）。
function queryOnOpenPort(port, n) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ responded: false }), STATUS_TIMEOUT_MS);
    const onData = (buf) => finish({ responded: true, statusByte: buf[0] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.removeListener('data', onData);
      resolve(result);
    };
    port.on('data', onData);
    port.write(Buffer.from([0x10, 0x04, n]));
  });
}

// 解析 DLE EOT 4 回應位元組（見上方說明，極性已依實機驗證校正）：
// bit5=1／bit6=1 才是「偵測到黑點、定位正常」；任一為 0 代表該聯未偵測到黑點。
function parsePaperSensorByte(byte) {
  const journalMarkOk = ((byte >> 5) & 1) === 1; // 存根聯
  const receiptMarkOk = ((byte >> 6) & 1) === 1; // 收執聯
  return { journalMarkOk, receiptMarkOk, positionOk: journalMarkOk && receiptMarkOk };
}

// 查詢「是否定位正常」（於已開啟的 port 上）——查無回應（可能斷線/沒開電，或這次剛好沒回應）
// 一律回 positionOk:null（未知，不擋列印，交由 connected 那道檢查把關），只有真的收到
// 「未偵測到黑點」的回應才回 false。
async function checkPositionOnPort(port) {
  const r = await queryOnOpenPort(port, 4);
  if (!r.responded) return { positionOk: null, journalMarkOk: null, receiptMarkOk: null };
  return parsePaperSensorByte(r.statusByte);
}

// ── 序列埠操作：整個 fn 執行期間只開關埠一次，fn 內可依序做多個讀寫動作 ──
// （量小、單次 HTTP 請求開一次埠即可；drain+1200ms 延遲是給印表機機構動作完成的緩衝時間，
// 僅在真的送過列印/開櫃指令時需要，見 withSerialPort 呼叫端各自決定）。
function withSerialPort(fn, { settleMs = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1 }, (err) => {
      if (err) return reject(err);
    });
    port.on('open', async () => {
      try {
        const result = await fn(port);
        const closeAndResolve = () => port.close(() => resolve(result));
        // port.close() 的 callback 觸發後才視為完成（見上方說明二次修正）；settleMs 為
        // 額外緩衝（真正列印/開櫃過才需要，狀態查詢傳 settleMs:0 跳過，避免拖慢輪詢速度）。
        port.drain(() => { settleMs > 0 ? setTimeout(closeAndResolve, settleMs) : closeAndResolve(); });
      } catch (e) {
        port.close(() => reject(e));
      }
    });
    port.on('error', reject);
  });
}

function writeAndDrain(port, buf) {
  return new Promise((resolve, reject) => {
    port.write(buf, (err) => (err ? reject(err) : resolve()));
  });
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
    // 整個查詢（n=1 基本狀態 + n=4 紙張定位）只開關埠一次；settleMs:0＝純查詢無實際列印動作，
    // 不需要機構動作緩衝，避免拖慢前端輪詢。
    const result = await withSerialPort(async (port) => {
      const basic = await queryOnOpenPort(port, 1);
      // connected＝印表機真的有回應（DLE EOT 1，已於 2026-08-12 實機驗證通過），不再只是「COM 埠開得起來」
      // ——USB 轉接線即使印表機沒開電通常也照樣開得起來，這道檢查才是員工端「開立發票」按鈕是否可按的判斷依據。
      if (!basic.responded) {
        return { connected: false, positionOk: null, journalMarkOk: null, receiptMarkOk: null };
      }
      const pos = await checkPositionOnPort(port);
      return { connected: true, positionOk: pos.positionOk, journalMarkOk: pos.journalMarkOk, receiptMarkOk: pos.receiptMarkOk };
    }, { settleMs: 0 });
    res.json({ ...result, port: SERIAL_PORT, baud: BAUD });
  } catch (e) {
    // 連 COM 埠本身都開不起來（USB 轉接線沒插上/驅動未裝/被其他程式佔用等）——比「印表機沒回應」更基礎的連線問題
    res.json({ connected: false, positionOk: null, port: SERIAL_PORT, error: e.message });
  }
});

app.post('/print', async (req, res) => {
  try {
    const { gymId, items, total, date, buyerTaxId, openDrawer } = req.body || {};
    // 查紙張定位→列印→（選）開錢櫃，整個流程只開關埠一次（見上方 withSerialPort 註解，
    // 這是這次修正的核心：避免同一次請求內連續開關埠三次造成的 access denied）。
    const result = await withSerialPort(async (port) => {
      // 先查紙張定位狀態——真的偵測到「未定位」（黑點感應器讀不到，極性已依實機驗證校正）才擋下；
      // 查詢無回應一律放行，交由印表機自己走既有的 0x0C 自動對位流程。
      const pos = await checkPositionOnPort(port);
      if (pos.positionOk === false) {
        return { ok: false, error: '發票紙未正確定位（存根聯/收執聯黑點感應異常），請確認紙張是否裝妥後再試一次' };
      }
      const lines = buildInvoiceLines({ gymId, items, total, date, buyerTaxId });
      const parts = [ESC_INIT, ...encodeLinesToBig5(lines)];
      parts.push(FORM_FEED);
      await writeAndDrain(port, Buffer.concat(parts));
      if (openDrawer) {
        try { await writeAndDrain(port, ESC_OPEN_DRAWER); }
        catch (e) { console.error('⚠️ 開錢櫃失敗（列印已成功、不影響發票）:', e.message); }
      }
      return { ok: true };
    });
    res.json(result);
  } catch (e) {
    console.error('❌ 列印失敗:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.post('/open-drawer', async (req, res) => {
  try {
    await withSerialPort((port) => writeAndDrain(port, ESC_OPEN_DRAWER));
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ 開錢櫃失敗:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// 簡易測試頁（不經過 RedRock 系統，供裝機當下手動驗證用；HTML 已抽到 lib/testPage.js 與
// win7/server.js 共用）
app.get('/', (req, res) => {
  res.type('html').send(renderTestPage());
});

app.listen(HTTP_PORT, () => {
  console.log(`✅ 發票列印代理已啟動：http://localhost:${HTTP_PORT}`);
  console.log(`   序列埠：${SERIAL_PORT} @ ${BAUD} baud　預設館別：${DEFAULT_GYM}`);
  console.log(`   允許來源：${ALLOWED_ORIGINS.join(', ')}`);
});
