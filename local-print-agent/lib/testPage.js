// 簡易測試頁（不經過 RedRock 系統，供裝機當下手動驗證用）——由 server.js（Mac/Win10+）與
// win7/server.js（Win7）共用；頁面本身只是打相對路徑的 /print、/status、/open-drawer，
// 兩邊底層傳輸方式不同，但這三個路由的行為/回應格式一致，故頁面可以直接共用不用複製。
//
// ⚠️ 2026-08-13：改用 XMLHttpRequest + 一般 function（不用 fetch/async/await）——Windows 7 上
// 常見預設瀏覽器是 Internet Explorer 11，完全不支援 fetch/async/await，原本的寫法在 IE11 下
// <script> 直接語法錯誤、整段都不會執行，按鈕看起來完全沒反應。XMLHttpRequest 從 IE5 就有，
// 保證任何瀏覽器都能用。
function renderTestPage() {
  return `<!doctype html>
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
function doPrint(){
  var status = document.getElementById('status');
  status.textContent = '列印中...';
  var body = {
    gymId: document.getElementById('gym').value,
    items: [{ name: document.getElementById('itemName').value, price: Number(document.getElementById('itemPrice').value), qty: 1 }],
    buyerTaxId: document.getElementById('buyerTaxId').value,
    openDrawer: document.getElementById('openDrawer').checked
  };
  xhrJson('POST', '/print', body, function (err, data) {
    if (err) { status.textContent = '❌ 連線失敗：' + err.message; return; }
    status.textContent = data.ok ? '✅ 已送出列印' : ('❌ 失敗：' + data.error);
  });
}
function doOpenDrawer(){
  var status = document.getElementById('status');
  status.textContent = '開櫃中...';
  xhrJson('POST', '/open-drawer', null, function (err, data) {
    if (err) { status.textContent = '❌ 連線失敗：' + err.message; return; }
    status.textContent = data.ok ? '✅ 已送出開櫃指令' : ('❌ 失敗：' + data.error);
  });
}
function doStatus(){
  var status = document.getElementById('status');
  status.textContent = '查詢中...';
  xhrJson('GET', '/status', null, function (err, data) {
    if (err) { status.textContent = '❌ 連線失敗：' + err.message; return; }
    status.textContent = JSON.stringify(data, null, 2);
  });
}
</script>
</body></html>`;
}

module.exports = { renderTestPage };
