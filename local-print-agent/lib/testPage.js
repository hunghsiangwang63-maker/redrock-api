// 簡易測試頁（不經過 RedRock 系統，供裝機當下手動驗證用）——由 server.js（Mac/Win10+）與
// win7/server.js（Win7）共用；頁面本身只是打相對路徑的 /print、/status、/open-drawer，
// 兩邊底層傳輸方式不同，但這三個路由的行為/回應格式一致，故頁面可以直接共用不用複製。
//
// ⚠️ 2026-08-13：改用 XMLHttpRequest + 一般 function（不用 fetch/async/await）——Windows 7 上
// 常見預設瀏覽器是 Internet Explorer 11，完全不支援 fetch/async/await，原本的寫法在 IE11 下
// <script> 直接語法錯誤、整段都不會執行，按鈕看起來完全沒反應。XMLHttpRequest 從 IE5 就有，
// 保證任何瀏覽器都能用。
//
// ⚠️ 2026-08-14：改版成跟正式員工端「開立發票」畫面（redrock-web/src/components/InvoiceIssuer.jsx
// 的 RealPrintPanel）同樣的視覺風格（配色、卡片、連線狀態顯示方式），方便裝機測試時就先熟悉正式
// 畫面長什麼樣子。維持這個測試頁原有、正式頁面沒有的三項：場館選單（正式頁面走真實交易的館別，
// 這裡沒有交易可依附，需要手動選）、單獨開錢櫃（正式頁面只有列印成功時才會開櫃，這裡另外留一個
// 純測試硬體用的按鈕）、檢查連線狀態（正式頁面開啟時會自動檢查一次＋一個「重新檢查」小連結，這裡
// 沿用同樣的自動檢查＋手動重新檢查兩者並存的做法）。
//
// ⚠️ CSS 全程避開 IE11 不支援的寫法：不用 CSS Grid、不用 CSS 變數（--foo）、不用 8 碼帶透明度的
// hex 顏色（IE11 只認 6 碼）、flexbox 一律用 margin 排間距（不用 gap，IE11 的 flex container 不
// 支援 gap）。JS 全程 var/function，不用 let/const/箭頭函式/樣板字串（樣板字串只用在 Node.js 端
// 產生這段 HTML 字串本身，那是安全的；瀏覽器實際執行的 <script> 內容一律 ES5）。
function renderTestPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>發票列印代理・測試頁</title>
<style>
  body{font-family:-apple-system,"Microsoft JhengHei",sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1a1a1a;}
  h1{font-size:18px;margin-bottom:4px;}
  .hint{font-size:12px;color:#999;margin-bottom:16px;}
  label{display:block;font-size:12px;color:#666;margin-bottom:5px;}
  .field{margin-bottom:12px;}
  input[type=text],input[type=number],select{
    width:100%;height:36px;border-radius:8px;border:1px solid #E8D5D5;padding:0 12px;
    font-size:13px;background:#FBF5F5;color:#1a1a1a;box-sizing:border-box;
  }
  .box{background:#FBF5F5;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#666;}
  .statusRow{margin-top:0;}
  .link{color:#185FA5;background:none;border:none;cursor:pointer;text-decoration:underline;font-size:11px;padding:0;margin-left:8px;}
  .checkboxRow{font-size:13px;color:#444;margin-bottom:14px;}
  .checkboxRow input{width:auto;display:inline-block;vertical-align:middle;margin-right:6px;}
  .btnPrimary{width:100%;height:44px;font-size:14px;font-weight:600;background:#8B1A1A;color:#fff;
    border:none;border-radius:9px;cursor:pointer;margin-bottom:8px;}
  .btnPrimary[disabled]{background:#ccc;cursor:not-allowed;}
  .btnSecondary{width:100%;height:40px;font-size:13px;background:#fff;color:#444;
    border:1px solid #E8D5D5;border-radius:9px;cursor:pointer;margin-bottom:8px;}
  .resultBox{border-radius:8px;padding:12px;margin-top:14px;font-size:13px;line-height:1.6;display:none;}
  .resultOk{background:#E6F4EB;border:1px solid #B3DEC0;color:#2D7D46;}
  .resultErr{background:#FCEBEB;border:1px solid #E3B3B3;color:#A32D2D;}
  .resultInfo{background:#F0F0F0;border:1px solid #DDD;color:#444;white-space:pre-wrap;font-family:monospace;font-size:11px;}
</style></head>
<body>
  <h1>🧾 發票列印代理・測試頁</h1>
  <p class="hint">此頁僅供裝機/除錯手動測試，正式使用由員工端網頁自動呼叫（畫面配色比照正式「開立發票」頁面）。</p>

  <div class="box">
    <span id="connText">檢查印表機連線中...</span><button class="link" onclick="doStatus()">重新檢查</button>
    <div id="connDetail" class="resultBox resultInfo"></div>
  </div>

  <div class="field">
    <label>場館</label>
    <select id="gym"><option value="hsinchu">新竹館</option><option value="shilin">士林館</option></select>
  </div>
  <div class="field">
    <label>品項名稱</label>
    <input type="text" id="itemName" value="入場費">
  </div>
  <div class="field">
    <label>金額</label>
    <input type="number" id="itemPrice" value="300">
  </div>
  <div class="field">
    <label>買受人統編（選填）</label>
    <input type="text" id="buyerTaxId" placeholder="留空不印該行">
  </div>
  <div class="checkboxRow">
    <input type="checkbox" id="openDrawer">同時開錢櫃（僅現金情境使用）
  </div>

  <button class="btnPrimary" id="printBtn" onclick="doPrint()">🖨️ 測試列印</button>
  <button class="btnSecondary" onclick="doOpenDrawer()">💰 單獨開錢櫃</button>

  <div id="printResult" class="resultBox"></div>

<script>
function xhrJson(method, url, bodyObj, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, url, true);
  if (bodyObj) xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status < 200 || xhr.status >= 300) { cb(new Error('HTTP ' + xhr.status)); return; }
    try { cb(null, JSON.parse(xhr.responseText)); }
    catch (e) { cb(e); }
  };
  xhr.onerror = function () { cb(new Error('連線失敗（代理沒有回應，確認代理是否還在執行）')); };
  xhr.send(bodyObj ? JSON.stringify(bodyObj) : null);
}
function showResult(el, ok, text) {
  el.className = 'resultBox ' + (ok ? 'resultOk' : 'resultErr');
  el.style.display = 'block';
  el.textContent = text;
}
function doPrint(){
  var btn = document.getElementById('printBtn');
  var result = document.getElementById('printResult');
  btn.disabled = true;
  btn.textContent = '列印中...';
  result.style.display = 'none';
  var body = {
    gymId: document.getElementById('gym').value,
    items: [{ name: document.getElementById('itemName').value, price: Number(document.getElementById('itemPrice').value), qty: 1 }],
    buyerTaxId: document.getElementById('buyerTaxId').value,
    openDrawer: document.getElementById('openDrawer').checked
  };
  xhrJson('POST', '/print', body, function (err, data) {
    btn.disabled = false;
    btn.textContent = '🖨️ 測試列印';
    if (err) { showResult(result, false, '❌ 連線失敗：' + err.message); return; }
    if (data.ok) { showResult(result, true, '✅ 已送出列印'); }
    else { showResult(result, false, '❌ 失敗：' + data.error); }
  });
}
function doOpenDrawer(){
  var result = document.getElementById('printResult');
  result.style.display = 'none';
  xhrJson('POST', '/open-drawer', null, function (err, data) {
    if (err) { showResult(result, false, '❌ 連線失敗：' + err.message); return; }
    if (data.ok) { showResult(result, true, '✅ 已送出開櫃指令'); }
    else { showResult(result, false, '❌ 失敗：' + data.error); }
  });
}
function doStatus(){
  var connText = document.getElementById('connText');
  var connDetail = document.getElementById('connDetail');
  connText.textContent = '檢查印表機連線中...';
  connText.style.color = '#999';
  connText.style.fontWeight = 'normal';
  xhrJson('GET', '/status', null, function (err, data) {
    if (err) {
      connText.textContent = '⚠️ 無法連線到本機列印代理';
      connText.style.color = '#A32D2D';
      connText.style.fontWeight = '600';
      connDetail.style.display = 'block';
      connDetail.className = 'resultBox resultErr';
      connDetail.textContent = err.message;
      return;
    }
    if (data.connected) {
      var posOk = data.positionOk;
      if (posOk === false) {
        connText.textContent = '🖨️ 印表機已連線／⚠️ 紙張未正確定位';
        connText.style.color = '#A32D2D';
      } else {
        connText.textContent = '🖨️ 印表機已連線';
        connText.style.color = '#2D7D46';
      }
      connText.style.fontWeight = '600';
    } else {
      connText.textContent = '⚠️ 無法連線到本機列印代理';
      connText.style.color = '#A32D2D';
      connText.style.fontWeight = '600';
    }
    connDetail.style.display = 'block';
    connDetail.className = 'resultBox resultInfo';
    connDetail.textContent = JSON.stringify(data, null, 2);
  });
}
doStatus();
</script>
</body></html>`;
}

module.exports = { renderTestPage };
