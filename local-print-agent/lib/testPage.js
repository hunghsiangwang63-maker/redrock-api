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
// ⚠️ 2026-08-14 續：加「付款方式」選單＋現金找零計算機，比照正式頁面的 PaymentMethodFixBox
// （InvoiceModal.jsx）。付款方式本身不會印在紙本上（買受人統編/品項/金額才會，見 invoiceFormat.js
// 的 buildInvoiceLines——這份代理刻意不做金額判斷/不記錄任何交易，付款方式純粹是「是否開錢櫃」
// 的判斷依據＋找零算給收銀的人看，不送進 /print 的 request body）。選「現金」時比照正式頁面邏輯
// 自動 openDrawer=true（列印成功同時開櫃），故拿掉原本那個手動勾選「同時開錢櫃」的 checkbox——
// 跟正式頁面完全一樣改成「選現金就會開櫃」，不用另外記得勾。找零計算純前端算術，不呼叫任何 API。
// 正式頁面的「更新為 XXX 並回寫系統」按鈕不重現——那是回寫某一筆真實訂單的付款方式，這個測試頁
// 沒有訂單可以回寫（沒有 sourceType/refId 概念），不適用。
//
// ⚠️ CSS 全程避開 IE11 不支援的寫法：不用 CSS Grid、不用 CSS 變數（--foo）、不用 8 碼帶透明度的
// hex 顏色（IE11 只認 6 碼）、flexbox 一律用 margin 排間距（不用 gap，IE11 的 flex container 不
// 支援 gap）。JS 全程 var/function，不用 let/const/箭頭函式/樣板字串（樣板字串只用在 Node.js 端
// 產生這段 HTML 字串本身，那是安全的；瀏覽器實際執行的 <script> 內容一律 ES5）。
//
// ⚠️ 2026-08-14 續：整個 <script> 內容是包在**這個檔案自己的**外層樣板字串（下面 return 的那個
// 反引號字串）裡——Node.js 解析這個檔案本身時，`\D`／`\d`／`\s`／`\w`／`\b` 這類「反斜線+字母」
// 在標準字串/樣板字串裡**不是合法跳脫序列**，會被靜默吃掉反斜線（`\D` 變成純字母 `D`），送到瀏覽器
// 的正規表示式因此整個跑掉（`/\D/g` 變成 `/D/g`，比對邏輯完全不同、不會報錯，只是結果不對，很難
// 用肉眼發現）。**這裡任何要給瀏覽器用的正規表示式，凡是含這類字母跳脫，原始碼要寫兩個反斜線
// （`\\D`）**——外層樣板字串吃掉一個之後，送到瀏覽器的字串才會正確含有單一 `\D`。已在
// isValidTaiwanTaxId／onTaxIdInput 踩過這個雷（原寫單一反斜線，統編防呆完全沒作用，數字沒過濾、
// 檢查碼也永遠比對失敗——已修正），之後加任何新的正規表示式務必比照兩個反斜線寫法。
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
  .payBtn{padding:6px 10px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:400;
    border:1px solid #E8D5D5;background:#fff;color:#444;margin:0 6px 0 0;}
  .payBtnActive{border:1.5px solid #8B1A1A;background:#FCEBEB;color:#8B1A1A;font-weight:700;}
  .cashRow{margin-top:10px;}
  .cashCol{width:48%;box-sizing:border-box;}
  .cashColLeft{float:left;}
  .cashColRight{float:right;text-align:right;}
  .clearfix:after{content:"";display:block;clear:both;}
  .dueLabel{font-size:11px;color:#999;}
  .changeAmount{font-size:20px;font-weight:700;color:#2D7D46;}
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

  <div class="box">
    <div style="font-size:12px;font-weight:600;color:#666;margin-bottom:8px;">付款方式</div>
    <div id="payMethodBtns"></div>
    <div id="cashRow" class="cashRow clearfix">
      <div class="cashCol cashColLeft">
        <label>收現</label>
        <input type="number" id="cashReceived" placeholder="輸入實收現金金額" oninput="updateChange()">
      </div>
      <div class="cashCol cashColRight">
        <div class="dueLabel">找零（應收 <span id="dueAmount">NT$0</span>）</div>
        <div class="changeAmount" id="changeAmount">—</div>
      </div>
    </div>
    <div class="hint" style="margin-top:8px;margin-bottom:0;">選「現金」時列印成功會自動開錢櫃（比照正式頁面行為）；其他付款方式不開櫃。</div>
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
    <input type="number" id="itemPrice" value="300" oninput="updateChange()">
  </div>
  <div class="field">
    <label>買受人統編（選填）</label>
    <input type="text" id="buyerTaxId" maxlength="8" inputmode="numeric" placeholder="8 碼統編（三聯式）" oninput="onTaxIdInput()">
    <div id="taxIdWarn" style="display:none;font-size:11px;color:#A32D2D;margin-top:4px;">⚠️ 檢查碼不符，請確認統一編號是否正確</div>
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

// 買受人統編防呆：只留數字、限8碼、8碼齊了才驗檢查碼——跟正式頁面（redrock-web
// src/utils/taiwanTaxId.js）同一套演算法，純前端即時提示，不擋送出（跟正式頁面一樣，
// 這個代理本身也不做金額/內容判斷，檢查碼不符只顯示提示，仍可照原輸入列印）。
var TAX_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];
function isValidTaiwanTaxId(id) {
  var s = String(id || '');
  if (!/^\\d{8}$/.test(s)) return false;
  var sum = 0;
  for (var i = 0; i < 8; i++) {
    var prod = Number(s.charAt(i)) * TAX_WEIGHTS[i];
    sum += Math.floor(prod / 10) + (prod % 10);
  }
  if (s.charAt(6) === '7') return (sum % 5 === 0) || ((sum + 1) % 5 === 0);
  return sum % 5 === 0;
}
function onTaxIdInput() {
  var input = document.getElementById('buyerTaxId');
  var digitsOnly = input.value.replace(/\\D/g, '').slice(0, 8);
  if (digitsOnly !== input.value) input.value = digitsOnly;
  var warn = document.getElementById('taxIdWarn');
  warn.style.display = (digitsOnly.length === 8 && !isValidTaiwanTaxId(digitsOnly)) ? 'block' : 'none';
}

// 付款方式選單＋現金找零計算機（純前端，不呼叫任何 API；付款方式只用來決定要不要開錢櫃）
var PM_METHODS = [
  { key: 'cash', label: '現金', icon: '💵' },
  { key: 'transfer', label: '轉帳', icon: '🏦' },
  { key: 'linepay', label: 'LinePay', icon: '💚' },
  { key: 'jkopay', label: '街口', icon: '🔵' },
  { key: 'taiwanpay', label: '台灣Pay', icon: '🇹🇼' }
];
var payMethod = 'cash';
function makePayClickHandler(key) {
  return function () { setPayMethod(key); };
}
function renderPayButtons() {
  var container = document.getElementById('payMethodBtns');
  var html = '';
  for (var i = 0; i < PM_METHODS.length; i++) {
    var active = (PM_METHODS[i].key === payMethod);
    html += '<button type="button" class="payBtn' + (active ? ' payBtnActive' : '') + '" id="payBtn_' + PM_METHODS[i].key + '">' + PM_METHODS[i].icon + ' ' + PM_METHODS[i].label + '</button>';
  }
  container.innerHTML = html;
  for (var j = 0; j < PM_METHODS.length; j++) {
    document.getElementById('payBtn_' + PM_METHODS[j].key).onclick = makePayClickHandler(PM_METHODS[j].key);
  }
}
function setPayMethod(key) {
  payMethod = key;
  renderPayButtons();
  document.getElementById('cashRow').style.display = (payMethod === 'cash') ? 'block' : 'none';
  updateChange();
}
function updateChange() {
  var due = Number(document.getElementById('itemPrice').value) || 0;
  document.getElementById('dueAmount').textContent = 'NT$' + due;
  var cashVal = document.getElementById('cashReceived').value;
  var changeEl = document.getElementById('changeAmount');
  if (payMethod === 'cash' && cashVal !== '' && !isNaN(Number(cashVal))) {
    var change = Number(cashVal) - due;
    changeEl.textContent = 'NT$' + change;
    changeEl.style.color = change < 0 ? '#A32D2D' : '#2D7D46';
  } else {
    changeEl.textContent = '—';
    changeEl.style.color = '#2D7D46';
  }
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
    openDrawer: (payMethod === 'cash')
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
renderPayButtons();
updateChange();
</script>
</body></html>`;
}

module.exports = { renderTestPage };
